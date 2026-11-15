#!/usr/bin/env python3
"""
Rebuild data/wallet-snapshot.json from:
  - wallet SQLite (path via WALLET_DB or /tmp/wallet-database-live.sqlite)
  - Finary balances (FINARY_JSON or /tmp/finary-balances.json)
  - PDF history (data/history.json from parse_history.py)

Then encrypt with tools/encrypt-snapshot.mjs if .dashboard-pass exists.
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


def export_wallet_txs(db_path: Path) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cats = {
        r["id"]: {"name": r["name"] or "", "type": r["type"]}
        for r in cur.execute("SELECT id, name, type FROM category")
    }
    wallets = {r["id"]: r["name"] for r in cur.execute("SELECT id, name FROM wallet")}
    rows = cur.execute(
        "SELECT category_id, wallet_id, amount, date_time, note FROM trans ORDER BY date_time DESC"
    ).fetchall()
    skip = {"Month progress bar", "Month progress bar compensation"}
    txs = []
    for t in rows:
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
    print(f"Wallet txs: {len(txs)} (income {sum(1 for t in txs if t['type']=='Income')})")

    balances = load_json(finary_path) or {}
    history = load_json(HIST)
    balances = enrich_balances(balances, history)

    snap = {
        "lastSync": datetime.now(timezone.utc).isoformat(),
        "transactions": txs,
        "balances": balances,
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

    # Encrypt if passphrase available
    enc = ROOT / "tools" / "encrypt-snapshot.mjs"
    if enc.exists() and (ROOT / ".dashboard-pass").exists():
        subprocess.check_call(["node", str(enc)], cwd=str(ROOT))
        print("Encrypted vault updated")
    else:
        print("Skip encrypt (no .dashboard-pass or encrypt script)")


if __name__ == "__main__":
    main()
