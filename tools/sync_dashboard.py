#!/usr/bin/env python3
"""
Rebuild data/wallet-snapshot.json from:
  - wallet SQLite (path via WALLET_DB or /tmp/wallet-database-live.sqlite)
  - Finary balances (FINARY_JSON or /tmp/finary-balances.json)
  - PDF history (data/history.json from parse_history.py)

Then seal the vault interactively: python3 scripts/seal_vault.py (getpass; no pass on disk).
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAP = ROOT / "data" / "wallet-snapshot.json"
HIST = ROOT / "data" / "history.json"


def load_json(path: Path):
    if path.exists():
        return json.loads(path.read_text())
    return None


def resolve_spend_account_id(cur) -> int | None:
    rows = cur.execute("SELECT id, name FROM account ORDER BY id").fetchall()
    for r in rows:
        if (r["name"] or "").strip().lower() == "rostom":
            return int(r["id"])
    return int(rows[0]["id"]) if rows else None


def export_savings_staging(db_path: Path) -> dict | None:
    """Savings → Bourso LDDS staging.

    Preferred habit (like other wallets):
      - payday: income on Boursobank LDDS (trans.type 0)
      - PEA / Livret top-up: expense on that wallet (trans.type 1)
    Available = income − expenses, or live wallet balance when LDDS is active.

    Legacy: net transfers (type 2) only when no income/expense rows exist yet.
    If both exist, income/expense wins (do not double-count transfers).
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    savings = cur.execute(
        "SELECT id FROM account WHERE lower(trim(name)) = 'savings' LIMIT 1"
    ).fetchone()
    if not savings:
        conn.close()
        return None
    sid = int(savings["id"])
    wallets = {
        r["id"]: r["name"]
        for r in cur.execute("SELECT id, name FROM wallet")
    }
    ldds_ids: set[int] = set()
    live_ldds = None
    live_active = False
    for r in cur.execute(
        "SELECT id, name, amount, active FROM wallet WHERE account_id = ?", (sid,)
    ):
        if "ldds" in (r["name"] or "").lower():
            ldds_ids.add(int(r["id"]))
            live_ldds = (r["amount"] or 0) / 100.0
            live_active = int(r["active"] or 0) == 1

    income_total = 0.0
    expense_total = 0.0
    income_count = 0
    expense_count = 0
    into = 0.0
    out = 0.0
    transfer_count = 0
    for t in cur.execute(
        "SELECT type, amount, wallet_id, transfer_wallet_id FROM trans WHERE account_id = ?",
        (sid,),
    ):
        typ = int(t["type"] or -1)
        amt = abs(t["amount"] or 0) / 100.0
        wid = t["wallet_id"]
        try:
            wid_i = int(wid) if wid is not None else None
        except (TypeError, ValueError):
            wid_i = None

        if typ in (0, 1):
            if wid_i not in ldds_ids:
                continue
            if typ == 0:
                income_total += amt
                income_count += 1
            else:
                expense_total += amt
                expense_count += 1
            continue

        if typ != 2:
            continue
        from_name = wallets.get(wid) or wallets.get(wid_i) or ""
        to_id = t["transfer_wallet_id"]
        try:
            to_i = int(to_id) if to_id is not None else None
        except (TypeError, ValueError):
            to_i = None
        to_name = wallets.get(to_id) or wallets.get(to_i) or ""
        if "ldds" in str(to_name).lower():
            into += amt
            transfer_count += 1
        if "ldds" in str(from_name).lower():
            out += amt
            transfer_count += 1

    conn.close()
    income_total = round(income_total, 2)
    expense_total = round(expense_total, 2)
    from_ie = round(income_total - expense_total, 2)
    from_transfers = round(into - out, 2)
    has_ie = income_count > 0 or expense_count > 0
    ledger = from_ie if has_ie else from_transfers
    if live_ldds is not None and live_active:
        mode = "live"
        bourso = round(live_ldds, 2)
    elif has_ie:
        mode = "income-expense"
        bourso = from_ie
    else:
        mode = "transfers"
        bourso = from_transfers

    return {
        "profile": "Savings",
        "accountId": sid,
        "boursoLdds": bourso,
        "mode": mode,
        "incomeTotal": income_total,
        "expenseTotal": expense_total,
        "incomeCount": income_count,
        "expenseCount": expense_count,
        "transferNet": from_transfers,
        "transferCount": transfer_count,
        "liveActive": live_active,
        "liveLdds": live_ldds,
    }


def export_wallet_txs(db_path: Path) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cats = {
        r["id"]: {"name": r["name"] or "", "type": r["type"]}
        for r in cur.execute("SELECT id, name, type FROM category")
    }
    wallets = {r["id"]: r["name"] for r in cur.execute("SELECT id, name FROM wallet")}
    spend_id = resolve_spend_account_id(cur)
    rows = cur.execute(
        "SELECT category_id, wallet_id, amount, date_time, note, type, account_id "
        "FROM trans ORDER BY date_time DESC"
    ).fetchall()
    skip = {"Month progress bar", "Month progress bar compensation"}
    txs = []
    for t in rows:
        if spend_id is not None and t["account_id"] != spend_id:
            continue
        if t["type"] == 2:  # transfer — not income/spend
            continue
        cat = cats.get(t["category_id"]) or {}
        name = cat.get("name") or ""
        if name in skip:
            continue
        amount = (t["amount"] or 0) / 100.0
        typ = "Income" if amount > 0 or cat.get("type") == 1 else "Expense"
        category = name
        if not category:
            note = (t["note"] or "").lower()
            category = (
                "Salary"
                if ("salary" in note or "salaire" in note)
                else ("Income" if typ == "Income" else "Expense")
            )
        dt = datetime.fromtimestamp((t["date_time"] or 0) / 1000, tz=timezone.utc).astimezone()
        txs.append(
            {
                "date": dt.strftime("%m/%d/%Y, %H:%M"),
                "type": typ,
                "category": category,
                "amount": amount,
                "currency": "EUR",
                "memo": t["note"] or "",
                "wallet": wallets.get(t["wallet_id"]) or "",
            }
        )
    conn.close()
    return txs


def export_wallet_budgets(db_path: Path) -> list[dict]:
    """Wallet Manager budget + budgetCategory → dashboard-friendly list."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cats = {r["id"]: (r["name"] or "") for r in cur.execute("SELECT id, name FROM category")}
    spend_id = resolve_spend_account_id(cur)
    skip = {"Month progress bar", "Month progress bar compensation"}
    out = []
    try:
        budgets = cur.execute(
            "SELECT id, name, amount, spent, status, period, repeat, start_date, end_date, category_id, account_id "
            "FROM budget ORDER BY id"
        ).fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return []
    for b in budgets:
        if spend_id is not None and b["account_id"] is not None and b["account_id"] != spend_id:
            continue
        name = (b["name"] or "").strip()
        if name in skip or name.lower().startswith("month progress"):
            continue
        links = cur.execute(
            "SELECT category_id FROM budgetCategory WHERE budget_id = ?", (b["id"],)
        ).fetchall()
        cat_names = []
        seen = set()
        for link in links:
            cn = cats.get(link["category_id"]) or ""
            if cn and cn not in skip and cn not in seen:
                seen.add(cn)
                cat_names.append(cn)
        out.append(
            {
                "id": b["id"],
                "name": name or f"Budget {b['id']}",
                "amount": (b["amount"] or 0) / 100.0,
                "period": b["period"],
                "categories": cat_names,
            }
        )
    conn.close()
    return out


def dmy_to_iso(d: str) -> str | None:
    """DD/MM/YYYY → YYYY-MM-DD"""
    try:
        return datetime.strptime(d, "%d/%m/%Y").date().isoformat()
    except Exception:
        return None


def enrich_balances(balances: dict, history: dict | None) -> dict:
    b = dict(balances or {})
    b.setdefault("source", "finary")
    if not history:
        return b

    pea_cash = (history.get("pea") or {}).get("cash") or {}
    if pea_cash.get("openedAt"):
        iso = dmy_to_iso(pea_cash["openedAt"])
        if iso:
            b["peaStartedAt"] = iso
    if pea_cash.get("totalFundedExSmall"):
        # PDF versements = capital paid in (best tax cost basis)
        b["costBasisFromPdf"] = pea_cash["totalFundedExSmall"]
        b["costBasisFinaryShares"] = b.get("costBasis")
        b["costBasis"] = pea_cash["totalFundedExSmall"]
    if pea_cash.get("contributions"):
        b["peaContributions"] = [
            {"date": dmy_to_iso(c["date"]), "amount": c["amount"], "label": c.get("label")}
            for c in pea_cash["contributions"]
            if dmy_to_iso(c["date"])
        ]
        # Months active from open → now
        if b.get("peaStartedAt"):
            start = datetime.fromisoformat(b["peaStartedAt"])
            now = datetime.now(timezone.utc)
            months = (now.year - start.year) * 12 + (now.month - start.month) + 1
            b["peaMonthsActive"] = max(1, months)

    pee = history.get("pee") or {}
    if pee.get("totalGross"):
        b["pee"] = pee["totalGross"]
        b["peeDetail"] = pee.get("employers")

    liv = history.get("livretA") or {}
    if liv.get("periods"):
        b["livretHistory"] = [
            {"from": p["from"], "to": p["to"], "balance": p["balance"]}
            for p in liv["periods"]
            if p.get("balance") is not None
        ]

    trades = ((history.get("pea") or {}).get("trades") or {}).get("trades")
    if trades:
        b["peaTrades"] = trades

    return b


def main() -> None:
    db = Path(os.environ.get("WALLET_DB", "/tmp/wallet-database-live.sqlite"))
    finary_path = Path(os.environ.get("FINARY_JSON", "/tmp/finary-balances.json"))

    if not db.exists():
        sys.exit(f"Missing wallet DB at {db}")

    txs = export_wallet_txs(db)
    budgets = export_wallet_budgets(db)
    savings = export_savings_staging(db)
    print(f"Wallet txs: {len(txs)} (income {sum(1 for t in txs if t['type']=='Income')})")
    print(f"Wallet budgets: {len(budgets)}")
    if savings:
        print(
            f"Savings staging LDDS: €{savings.get('boursoLdds')} "
            f"(mode={savings.get('mode')}, funded €{savings.get('incomeTotal')}, "
            f"withdrawn €{savings.get('expenseTotal')}, transfers {savings.get('transferCount')})"
        )

    balances = load_json(finary_path) or {}
    # Fall back to balances already in the previous snapshot / Drive merge
    if not balances.get("pea"):
        prev = load_json(SNAP) or {}
        if isinstance(prev.get("balances"), dict):
            balances = {**prev["balances"], **balances}
    history = load_json(HIST)
    balances = enrich_balances(balances, history)
    balances["budgets"] = budgets
    if savings and savings.get("boursoLdds") is not None:
        balances["boursoLdds"] = savings["boursoLdds"]
        balances["boursoLddsSource"] = "money-manager:Savings"

    snap = {
        "lastSync": datetime.now(timezone.utc).isoformat(),
        "transactions": txs,
        "balances": balances,
        "budgets": budgets,
        "savingsProfile": savings,
        "historyMeta": {
            "hasLivretA": bool(history and history.get("livretA")),
            "hasPeaCash": bool(history and (history.get("pea") or {}).get("cash")),
            "hasPeaTrades": bool(history and (history.get("pea") or {}).get("trades")),
            "hasPee": bool(history and history.get("pee")),
            "generatedAt": (history or {}).get("generatedAt"),
        },
    }
    SNAP.parent.mkdir(parents=True, exist_ok=True)
    SNAP.write_text(json.dumps(snap))
    print(
        "Wrote",
        SNAP,
        "pea",
        balances.get("pea"),
        "livret",
        balances.get("livretA"),
        "pee",
        balances.get("pee"),
        "costBasis",
        balances.get("costBasis"),
        "pdfFunded",
        balances.get("costBasisFromPdf"),
    )

    seal = ROOT / "scripts" / "seal_vault.py"
    if seal.exists():
        print("Plaintext snapshot ready. Seal with a Bitwarden passphrase (hidden prompt):")
        print(f"  python3 {seal}")
    else:
        print("Skip seal (scripts/seal_vault.py missing)")


if __name__ == "__main__":
    main()
