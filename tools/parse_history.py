#!/usr/bin/env python3
"""Parse Livret A / PEA / PEE PDFs into structured history JSON (gitignored inputs)."""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pypdf", "-q"])
    from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
PRIV = ROOT / "data" / "private"
OUT = ROOT / "data" / "history.json"

ISIN_MAP = {
    "IE0002XZSHO1": "WPEA",
    "FR001400ZGR7": "PNAS",
    "FR0013412012": "PAASI",
}


def pdf_text(path: Path) -> str:
    return "\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)


def parse_amt(s: str) -> float:
    s = s.strip().replace("\xa0", " ").replace(" ", "")
    # French: 3.400,00 or 3400,00
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    return float(s)


def parse_livret_a(path: Path) -> dict:
    text = pdf_text(path)
    movements = []
    # Lines like: 03.05    VIREMENT BACCAR ... 3 000,00  OR debit column
    # Statement periods
    periods = re.findall(
        r"du\s+(\d{2}\.\d{2}\.\d{4})\s+au\s+(\d{2}\.\d{2}\.\d{4})",
        text,
        re.I,
    )
    soldes = []
    for m in re.finditer(r"SOLDE EN EUROS\s+([\d\s]+,\d{2})", text):
        soldes.append(parse_amt(m.group(1)))

    # Movement rows: DD.MM then libelle then optional debit/credit
    # Keep it simple: capture dated VIR/VERSEMENT/INTERETS with trailing amount
    for m in re.finditer(
        r"(\d{2}\.\d{2})\s+([A-Z][^\n]{5,80}?)\s+([\d\s]+,\d{2})\s*$",
        text,
        re.M,
    ):
        day_mo, label, amt_s = m.group(1), m.group(2).strip(), m.group(3)
        label_u = label.upper()
        if "ANCIEN SOLDE" in label_u or "TOTAUX" in label_u or "SOLDE" in label_u:
            continue
        amt = parse_amt(amt_s)
        # Heuristic: INTERESTS / VERSEMENT / VIREMENT credit vs debit
        # Debit lines often have amount in debit column — hard without layout.
        # Prefer credits for VIR/VERSEMENT; INTERETS as credit; some VIR are outflows.
        kind = "transfer"
        if "INTERET" in label_u or "INTÉRÊT" in label_u:
            kind = "interest"
            direction = "in"
        elif "VERSEMENT" in label_u:
            direction = "in"
        elif "VIREMENT" in label_u or "VIR SEPA" in label_u or "VIR " in label_u:
            # Can't reliably know debit vs credit from single amount — store raw
            direction = "unknown"
        else:
            direction = "unknown"
        movements.append(
            {
                "datePartial": day_mo.replace(".", "-"),  # DD-MM; year from nearby period
                "label": re.sub(r"\s+", " ", label)[:80],
                "amount": amt,
                "kind": kind,
                "direction": direction,
            }
        )

    # Month-end balances from SOLDE EN EUROS paired with periods (best effort)
    balances = []
    for i, (start, end) in enumerate(periods):
        bal = soldes[i] if i < len(soldes) else None
        balances.append(
            {
                "from": start.replace(".", "-"),
                "to": end.replace(".", "-"),
                "balance": bal,
            }
        )

    return {
        "account": "livretA",
        "source": path.name,
        "periods": balances,
        "movementsRaw": movements[:500],
        "latestBalanceFromPdf": soldes[-1] if soldes else None,
        "firstPeriod": periods[0] if periods else None,
        "lastPeriod": periods[-1] if periods else None,
    }


def parse_pea_especes(path: Path) -> dict:
    """Extract PEA cash credits from Relevés espèces (glued-text patterns only)."""
    text = pdf_text(path)
    glued = re.sub(r"\s+", "", text)
    rows = []

    def ok(amt: float) -> bool:
        return 0 < amt <= 50_000

    for pat, label in [
        (r"(\d{2}/\d{2}/\d{4})VIRVIREMENTCREATIONCOMPTE([\d.]+,\d{2})", "CREATION COMPTE"),
        (r"(\d{2}/\d{2}/\d{4})VIRPEA(?:\d{2}/\d{2}/\d{4})?([\d.]+,\d{2})", "VIRPEA"),
        (r"(\d{2}/\d{2}/\d{4})VIRVirementdepuisBoursoBank(?:\d{2}/\d{2}/\d{4})?([\d.]+,\d{2})", "VIR BoursoBank"),
    ]:
        for m in re.finditer(pat, glued):
            amt = parse_amt(m.group(2))
            if ok(amt):
                rows.append({"date": m.group(1), "amount": amt, "label": label})

    rows.sort(key=lambda c: datetime.strptime(c["date"], "%d/%m/%Y"))
    funded = sum(c["amount"] for c in rows if c["amount"] >= 30)
    opened = next((c["date"] for c in rows if "CREATION" in c["label"].upper()), None)
    if not opened and rows:
        opened = rows[0]["date"]

    return {
        "account": "pea",
        "source": path.name,
        "openedAt": opened,
        "contributions": rows,
        "totalFundedExSmall": round(funded, 2),
        "totalAllCredits": round(sum(c["amount"] for c in rows), 2),
    }


def parse_avis_operes(path: Path) -> dict:
    trades = []
    for page in PdfReader(str(path)).pages:
        t = page.extract_text() or ""
        mdate = re.search(r"le\s+(\d{2}/\d{2}/\d{4})", t)
        if not mdate:
            continue
        if re.search(r"\bACHAT\b", t):
            side = "buy"
        elif re.search(r"\bVENTE\b", t):
            side = "sell"
        else:
            continue
        isin_m = re.search(r"Code ISIN\s*:\s*([A-Z0-9]+)", t)
        cours_m = re.search(r"Cours exécuté\s*:\s*([\d,]+)\s*EUR", t)
        qty_m = re.search(r"(\d{1,5})\s+((?:IS\.|AM\.)[^\n]{5,60})", t)
        isin = isin_m.group(1) if isin_m else None
        trades.append(
            {
                "date": mdate.group(1),
                "side": side,
                "isin": isin,
                "symbol": ISIN_MAP.get(isin or "", isin),
                "qty": int(qty_m.group(1)) if qty_m else None,
                "name": (qty_m.group(2).strip()[:60] if qty_m else None),
                "price": float(cours_m.group(1).replace(",", ".")) if cours_m else None,
            }
        )

    # Deduplicate identical page parses
    seen = set()
    uniq = []
    for tr in trades:
        k = (tr["date"], tr["side"], tr["isin"], tr["qty"], tr["price"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(tr)
    uniq.sort(key=lambda t: datetime.strptime(t["date"], "%d/%m/%Y"))
    return {"account": "pea", "source": path.name, "trades": uniq}


def parse_pee(paths: list[Path]) -> dict:
    """Extract employer PEE totals. PDFs often bundle several employers."""
    employers = {}
    for path in paths:
        if not path.exists():
            continue
        text = pdf_text(path)
        ents = [(m.start(), m.group(1).strip()) for m in re.finditer(r"Votre Entreprise\s*:\s*([^\n]+)", text)]
        bruts = [
            (m.start(), parse_amt(m.group(1)))
            for m in re.finditer(r"MONTANT TOTAL BRUT\s*([\d\s\xa0]+,\d{2})", text)
        ]
        # In Epsor PDFs the gross total often appears *before* "Votre Entreprise"
        # → pair each enterprise with the nearest preceding brut.
        for i, (pos, name) in enumerate(ents):
            preceding = [(bp, b) for (bp, b) in bruts if bp < pos]
            gross = preceding[-1][1] if preceding else None
            end = ents[i + 1][0] if i + 1 < len(ents) else len(text)
            chunk = text[max(0, pos - 400) : end]
            disp = re.findall(r"(\d{2}/\d{2}/20[2-3]\d)", chunk)
            disp_dates = []
            for d in disp:
                if d not in disp_dates:
                    disp_dates.append(d)
            prev = employers.get(name)
            if prev and (prev.get("gross") or 0) >= (gross or 0):
                continue
            employers[name] = {
                "name": name,
                "gross": gross,
                "availabilityDates": disp_dates[:12],
                "source": path.name,
            }
    total = round(sum(e["gross"] or 0 for e in employers.values()), 2)
    return {"account": "pee", "employers": list(employers.values()), "totalGross": total}


def main() -> None:
    PRIV.mkdir(parents=True, exist_ok=True)
    history = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "livretA": None,
        "pea": {"cash": None, "trades": None},
        "pee": None,
    }
    liv = PRIV / "livret_A.pdf"
    if liv.exists():
        history["livretA"] = parse_livret_a(liv)
        print("Livret A:", history["livretA"]["firstPeriod"], "→", history["livretA"]["lastPeriod"],
              "latestPdfBal", history["livretA"]["latestBalanceFromPdf"])

    pea_cash = PRIV / "pea_releves_espece.pdf"
    if pea_cash.exists():
        history["pea"]["cash"] = parse_pea_especes(pea_cash)
        c = history["pea"]["cash"]
        print("PEA opened", c["openedAt"], "funded≥30€", c["totalFundedExSmall"],
              "n contrib", len(c["contributions"]))

    avis = PRIV / "avis_d_operes.pdf"
    if avis.exists():
        history["pea"]["trades"] = parse_avis_operes(avis)
        print("PEA trades", len(history["pea"]["trades"]["trades"]))

    pee_paths = [PRIV / "pee_epsor_amob.pdf", PRIV / "pee_epsor_veepee.pdf"]
    history["pee"] = parse_pee(pee_paths)
    print("PEE total", history["pee"]["totalGross"], "employers",
          [e["name"] for e in history["pee"]["employers"]])

    OUT.write_text(json.dumps(history, indent=2, ensure_ascii=False))
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
