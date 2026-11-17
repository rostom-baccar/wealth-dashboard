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

### Passphrase via Bitwarden (never paste into Cursor chat)

Repo stays public; the passphrase never belongs in git or in chat.

1. In the **Bitwarden app**: Generator → long passphrase → save as a Login named **`Rostom Dashboard Vault`** (password field = vault passphrase).
2. Locally (Terminal, not chat):

```bash
brew install bitwarden-cli   # once
bw login                    # once
chmod +x tools/bitwarden-pass.sh
./tools/bitwarden-pass.sh   # writes gitignored .dashboard-pass (does not print the secret)
node tools/encrypt-snapshot.mjs
git add data/wallet-snapshot.enc && git commit -m "Refresh encrypted snapshot" && git push
```

3. On the site: unlock by copying the passphrase **from Bitwarden** into the unlock field (or use Remember this device).

Optional: `BITWARDEN_ITEM="Other name" ./tools/bitwarden-pass.sh`

### Re-encrypt after syncing new data

```bash
# plaintext lives locally only
./tools/bitwarden-pass.sh          # or reuse existing .dashboard-pass
node tools/encrypt-snapshot.mjs
git add data/wallet-snapshot.enc && git commit -m "Refresh encrypted snapshot" && git push
```

### Caveats

- **Git history** may still contain older plaintext commits from before encryption — treat the passphrase as rotating privacy going forward; rewrite history only if you need to scrub the past.
- An Apps Script `/exec` URL that returns plaintext is also a secret — don’t publish it.
- Anon mode only blurs the UI; encryption is what protects the network download.
- Never paste the vault passphrase into Cursor chat; agents can encrypt using `.dashboard-pass` without reading it aloud.

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
