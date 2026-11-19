# Live Refresh (required)

The **Refresh** button rebuilds **spend + staging + Finary** from Drive via Apps Script. It does **not** use the static encrypted vault for live updates.

## One-time setup

1. Open the Google Sheet → **Extensions → Apps Script**.
2. Paste the latest [`WalletExport.gs`](./WalletExport.gs) → Save.
3. **Deploy → New deployment → Web app** (or **Manage deployments → Edit → New version** after each `.gs` change)
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the `/exec` URL.
5. Unlock the dashboard → **⚙️ Settings** → paste into **Apps Script web app URL** → Save.

## What Refresh does (one click)

1. Calls the web app with `full=1&fresh=1` (JSONP, cache-busted).
2. Apps Script picks the **newest** Drive `wallet-database` (trashes older duplicates), rebuilds **Spend** transactions + budgets.
3. Extracts **Staging** (Savings → Bourso LDDS) from that same SQLite.
4. Merges Drive `finary-balances.json` for **PEA / Livret / allocation**, then overlays staging so Finary cannot wipe LDDS.
5. Returns the full snapshot → dashboard replaces live state (no stale localStorage leftover).

Status pills after Refresh show ages for Spend / Staging / Finary.

## Finary freshness

The browser **cannot** log into Finary. Refresh uses Drive’s `finary-balances.json`.

To refresh PEA / Livret numbers: ask Cursor to **sync Finary**, then click **Refresh**.

If the Finary pill says **stale** (>36h), balances are still shown but need a Cursor sync.

## Cursor sync path (vault / full rebuild)

```bash
# 1) Cursor writes live Finary → Drive finary-balances.json (+ /tmp)
# 2) Newest wallet sqlite at /tmp/wallet-database-live.sqlite
python3 tools/parse_history.py          # optional PDFs → data/history.json
FINARY_JSON=/tmp/finary-balances.json python3 tools/sync_dashboard.py
python3 scripts/seal_vault.py           # Bitwarden passphrase (hidden)
git add data/wallet-snapshot.enc && git commit && git push
```

Ask Cursor: **“sync Finary / rebuild vault”**.

## Encrypted vault (GitHub Pages)

`data/wallet-snapshot.enc` is cold start after unlock. Live Refresh bypasses it once the web app URL is set.
