# Rostom · Wealth Dashboard

Personal finance dashboard on GitHub Pages. **No balances or Drive file IDs are stored in this repo.**

Live (after Pages enable): https://rostom-baccar.github.io/wealth-dashboard/

## Security model

| Secret | Where it lives |
|--------|----------------|
| PEA / Livret A / PEE amounts | Your browser `localStorage` only |
| Drive `wallet-snapshot.json` file ID | Your browser `localStorage` only (⚙️ Data) |
| Transaction history | Google Drive file you control |

The public GitHub repo contains **only** the HTML/JS shell (allocation *percentages* as structure, zeroed money defaults).

### Important about “anyone with the link”

If your Drive snapshot is shared as **anyone with the link**, then **anyone who learns the file ID can read it**. Hiding the URL is not encryption.

- Do **not** paste the file ID into issues, commits, or screenshots.
- Prefer keeping the snapshot link private to you; enter it once in the dashboard (stored locally).
- For stronger security later: stop public sharing and put a tiny authenticated proxy in front of Drive.

## Architecture

```
wallet app → Drive (wallet-database)
     → Apps Script (hourly) → wallet-snapshot.json
     → dashboard Refresh → fetch JSON (file ID from localStorage)
Balances modal → localStorage (PEA / Livret A / PEE / net income)
```

## Setup

1. Install `WalletExport.gs` in your Google Sheet, run `installHourlyTrigger`, then `runNow`.
2. Copy the snapshot file ID from `_meta!A1`.
3. Open the dashboard → **⚙️ Data** → paste file ID → Save.
4. **💰 Balances** → enter PEA / Livret A / PEE / monthly net income / PEA contribution.

## Features

- Net worth hero, EN default, strong anon blur
- Savings chart derived from wallet spend + your net-income setting (vertical bars + PEA contribution)
- Draggable sections (order saved in localStorage)
- Refresh pulls the latest Drive snapshot

## Files

| File | Purpose |
|------|---------|
| `index.html` | Dashboard UI |
| `WalletExport.gs` | Apps Script → Sheet + JSON snapshot |
