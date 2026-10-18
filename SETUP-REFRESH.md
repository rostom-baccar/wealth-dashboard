# Manual export only (no hourly / daily triggers)

## Clear old schedules (once)

1. Sheet → **Extensions → Apps Script**
2. Paste latest `WalletExport.gs` → Save
3. Select function **`removeAutoTriggers`** → Run (authorize if asked)
4. Reload the Sheet — menu **Wallet → Export now (manual)** appears

## When you want fresh wallet data on Drive

- **Wallet → Export now** in the Sheet, or run `runNow` in Apps Script  
- Then ask Cursor to sync Finary + re-encrypt `data/wallet-snapshot.enc` for Pages

## Dashboard Refresh button

Only reloads + decrypts the encrypted vault already on GitHub Pages.  
It does **not** call Apps Script (that path was slow and often failed).

### Why the old Refresh felt stuck

1. **Apps Script full export** parses the whole SQLite file + writes Sheet + JSON → often **30–90s**
2. **Response too large** (~350KB snapshot) — ContentService / timeouts → request “never comes through”
3. **Cold start + redirects** on `script.google.com` web apps are flaky from the browser
4. Even when it worked, it **didn’t update** the encrypted Pages file — so the UI often looked unchanged

Manual export on the Sheet + encrypt/push to Pages is the reliable path.
