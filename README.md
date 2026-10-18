# Rostom · Wealth Dashboard

Personal finance dashboard on GitHub Pages.

Live: https://rostom-baccar.github.io/wealth-dashboard/

## Security model (public site, private numbers)

The HTML is public. **Your numbers are not** — they ship as an AES-256-GCM encrypted blob:

| File | Public? |
|------|---------|
| `index.html` | Yes (shell only) |
| `data/wallet-snapshot.enc` | Yes (ciphertext only) |
| `data/wallet-snapshot.json` | **No** — gitignored, local only |
| `.dashboard-pass` | **No** — gitignored passphrase |

**Unlock:** enter your passphrase once. Optionally **Remember this device** stores the decryption key in that browser’s `localStorage` only (not the passphrase string in transit after unlock). **Lock** clears it.

Other people opening the site see the unlock screen. Fetching `.enc` without the passphrase yields unreadable data.

### Re-encrypt after syncing new data

```bash
# plaintext lives locally only
# edit/sync → data/wallet-snapshot.json
DASHBOARD_PASS="$(cat .dashboard-pass)" node tools/encrypt-snapshot.mjs
git add data/wallet-snapshot.enc && git commit -m "Refresh encrypted snapshot" && git push
```

### Caveats

- **Git history** may still contain older plaintext commits from before encryption — treat the passphrase as rotating privacy going forward; rewrite history only if you need to scrub the past.
- An Apps Script `/exec` URL that returns plaintext is also a secret — don’t publish it.
- Anon mode only blurs the UI; encryption is what protects the network download.

## Architecture

```
wallet app → Drive sqlite
  → Apps Script → local wallet-snapshot.json (+ Finary merge)
  → tools/encrypt-snapshot.mjs → wallet-snapshot.enc (GitHub Pages)
  → browser unlock → decrypt → dashboard
```

## Setup

1. Install `WalletExport.gs`, run `runNow`.
2. Keep a local `data/wallet-snapshot.json` (or ask Cursor to sync).
3. Encrypt with `.dashboard-pass` / `tools/encrypt-snapshot.mjs`.
4. Open the site → unlock with the passphrase → optional Remember this device.

## Features

- Encrypted vault unlock (per-device remember)
- Net worth hero, Anon blur, EN/FR
- Savings from wallet income − expenses; PEA monthly from Finary cost basis
- Gemini AI brief (API key in Settings / localStorage only)
