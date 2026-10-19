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

## Finary

Apps Script cannot log into Finary. It merges whatever is in Drive `finary-balances.json`.

To refresh PEA / Livret A: ask Cursor to **sync Finary balances**, then click **Refresh** (or wait until that file was updated, then Refresh).

## Encrypted vault (GitHub Pages)

`data/wallet-snapshot.enc` is only for cold start after unlock. Live Refresh bypasses it once the web app URL is set.
