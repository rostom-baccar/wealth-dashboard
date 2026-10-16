# Step-by-step: make Refresh rebuild the wallet snapshot

The dashboard **Refresh** button always re-downloads `wallet-snapshot.json` from Drive.
To also **rebuild** that file from the live `wallet-database` SQLite (same as hourly export), deploy Apps Script as a Web App once.

## A. Update the script

1. Open your Google Sheet that already has the wallet export.
2. **Extensions → Apps Script**.
3. Delete the old code and paste the latest `WalletExport.gs` from this repo.
4. Save (disk icon).

## B. Deploy as Web App (one-time)

1. In Apps Script: **Deploy → New deployment**.
2. Click the gear ⚙️ next to “Select type” → choose **Web app**.
3. Settings:
   - **Description:** `wallet refresh`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**
4. Click **Deploy**.
5. Authorize Google permissions if asked.
6. Copy the **Web app URL** (ends with `/exec`).

## C. Paste URL in the dashboard

1. Open https://rostom-baccar.github.io/wealth-dashboard/
2. Click **⚙️ Settings**.
3. Paste the `/exec` URL into **Apps Script web app URL**.
4. Save.

## D. Test

1. Click **Refresh** on the dashboard.
2. Wait a couple of seconds.
3. Status pills should show **Drive ✓** and transaction count updating.
4. In the Sheet, `_meta!A1` still holds the snapshot file ID (stable).

---

# Finary — how it works (simple)

The public dashboard **cannot** call Finary directly (no browser login to Finary).

Pipeline:

```
Finary (Cursor MCP)
   → writes finary-balances.json on Drive
   → Apps Script merges it into wallet-snapshot.json (hourly or Refresh web app)
   → dashboard Refresh reads the snapshot
```

### What you do day-to-day

1. **Wallet expenses/income:** phone app → Drive `wallet-database` → Apps Script (hourly or Refresh web app) → snapshot → dashboard.
2. **PEA / Livret A:** ask Cursor “sync Finary balances to Drive”, then click **Refresh** (or wait for hourly export).
3. **PEE:** still manual in Settings (no Epsor connector).

### Fix red Finary pill

1. ⚙️ **Data** → snapshot ID from `_meta!A1` (e.g. `1UDN5c6JoKWzCpiwSMZcbVKipFnwzR-az`).
2. Ask Cursor to sync Finary (or wait until `finary-balances.json` exists).
3. Run **runNow** in Apps Script (or Refresh with web app URL set) so balances merge into the snapshot.
4. Refresh the dashboard → pill turns green.

---

# Income bug (fixed in WalletExport.gs)

Salary was logged under an income category with a **blank name**. The old export skipped blank names, so only 3 reimbursements appeared as Income. The new script keeps them and labels blank income as **Salary** / **Income**.
