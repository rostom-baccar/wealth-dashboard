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

**Unlock:** enter your passphrase once. Optionally **Remember this device** stores the passphrase in that browser’s `localStorage` only. **Lock** clears it and hides the entire dashboard shell (not just a dismissible modal).

Other people opening the site see only the unlock screen — the app UI is not rendered until unlock succeeds. Fetching `.enc` without the passphrase yields unreadable data.

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
wallet app → Drive sqlite (+ finary-balances.json from Cursor)
  → Apps Script web app (Refresh) → live snapshot to browser
  → also: encrypt → wallet-snapshot.enc (GitHub Pages cold start)
  → browser unlock (passphrase) → dashboard mounts
```

While locked, the dashboard DOM is **not mounted** — only the unlock screen exists.

## Setup

1. Install `WalletExport.gs`, deploy as Web app (Anyone), paste `/exec` URL in Settings.
2. Encrypt a cold-start vault: `node tools/encrypt-snapshot.mjs` (see below).
3. Open the site → unlock with the passphrase → optional Remember this device.
4. **Refresh** requires the Apps Script URL (rebuilds wallet + merges Finary file).

## Features

- Hard lock + encrypted vault unlock (per-device remember)
- Live **Refresh** via Apps Script web app (wallet export + Finary balances merge)
- Net worth hero, Anon blur, EN/FR
- Savings from wallet income − expenses; PEA monthly from Finary cost basis
- Gemini AI brief (API key in Settings / localStorage only)
