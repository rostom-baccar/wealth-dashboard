# Live Refresh (required)

The **Refresh** button rebuilds data from Drive via Apps Script. It does **not** use the static encrypted vault for live updates.

## One-time setup

1. Open the Google Sheet → **Extensions → Apps Script**.
2. Paste the latest [`WalletExport.gs`](./WalletExport.gs) → Save.
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the `/exec` URL.
5. Unlock the dashboard → **⚙️ Settings** → paste into **Apps Script web app URL** → Save.

## What Refresh does

1. Calls the web app with `full=1` (JSONP).
2. Apps Script reads Drive `wallet-database` (SQLite), rebuilds transactions, merges `finary-balances.json`, writes `wallet-snapshot.json`.
3. Returns the full snapshot to the browser → dashboard updates.

## Cursor sync path (Phase 1 alternative)

When Apps Script is missing or you want a full rebuild without the browser:

```bash
# 1) Cursor writes live Finary → /tmp/finary-balances.raw.json (and updates Drive)
# 2) Wallet sqlite at /tmp/wallet-database-live.sqlite (from Drive)
# 3) PDF history (optional)
python3 tools/parse_history.py          # → data/history.json (gitignored)
FINARY_JSON=/tmp/finary-balances.raw.json python3 tools/sync_dashboard.py
# → data/wallet-snapshot.json + encrypted .enc
git add data/wallet-snapshot.enc && git commit && git push   # Pages cold-start vault
```

Ask Cursor: **“sync Finary / rebuild vault”**.

## Finary

Apps Script cannot log into Finary. It merges whatever is in Drive `finary-balances.json`.

To refresh PEA / Livret A: ask Cursor to **sync Finary balances**, then click **Refresh** (or wait until that file was updated, then Refresh).

PDF history (Livret / PEA versements / PEE) is merged into balances by `sync_dashboard.py` and written into Drive `finary-balances.json` so Refresh picks it up too.

## Encrypted vault (GitHub Pages)

`data/wallet-snapshot.enc` is for cold start after unlock. Live Refresh bypasses it once the web app URL is set. After a Cursor sync + push, hard-refresh the site and unlock to load the new vault without Apps Script.
