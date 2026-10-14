# 🦄 Rostom · Wealth Dashboard

Personal finance dashboard — live on GitHub Pages, data from Google Drive.

## Live dashboard
👉 **https://rostom-baccar.github.io/wealth-dashboard/**

## Architecture

```
wallet app (Android)
    ↓ syncs SQLite to
Google Drive (wallet-database)
    ↓ Apps Script reads every hour + on-demand
Google Sheets + wallet-snapshot.json (public)
    ↓ dashboard fetches on load / refresh
index.html (GitHub Pages)
```

## Setup

### 1. Apps Script (Google Sheets)
1. Open your Google Sheet
2. Extensions → Apps Script
3. Replace all code with `WalletExport.gs`
4. Run `installHourlyTrigger` once
5. Run `runNow` to test — check Logs
6. Copy the **snapshot file ID** from the `_meta` sheet cell A1

### 2. Dashboard
1. Open `index.html`
2. Replace `1b6q8T5fN1V6XcRkIC7y6jsJgCTwEEmE0` with the file ID from step 1.6
3. Commit and push — GitHub Pages serves it automatically

### 3. First open
- Visit `https://rostom-baccar.github.io/wealth-dashboard/`
- The balance modal opens automatically on first visit
- Enter PEA, Livret A, PEE values from your apps
- Values are saved in your browser's localStorage — private, never sent anywhere

### 4. Daily use
- **Refresh button**: re-fetches the latest wallet-snapshot.json
- **Balances button**: update your PEA/Livret A manually when you check your apps
- The Apps Script syncs data hourly automatically — you just hit Refresh on the dashboard

## Files

| File | Purpose |
|------|---------|
| `index.html` | Standalone dashboard (HTML + CSS + JS, no server needed) |
| `WalletExport.gs` | Google Apps Script — reads SQLite, writes Sheet + JSON snapshot |

## Data privacy
- Transaction data lives in your Google Drive (private by default)
- `wallet-snapshot.json` is shared with "anyone with link" — it contains your expense categories and amounts
- Balance values (PEA, Livret A) are stored in your browser's localStorage only
- No server, no database, no analytics
