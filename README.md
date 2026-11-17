# Rostom · Wealth Dashboard

Personal finance dashboard on GitHub Pages.

Live: https://rostom-baccar.github.io/wealth-dashboard/

## Security model (public site, private numbers)

Same soft-protection pattern as [network-graph](https://github.com/rostom-baccar/network-graph): public repo + Pages, but numbers are not readable in plaintext. Soft protection only (client-side crypto; determined attackers can still try to crack a weak passphrase).

| File | Public? |
|------|---------|
| `index.html` | Yes (shell + unlock UI) |
| `data/wallet-snapshot.enc` | Yes (ciphertext only) |
| `data/wallet-snapshot.json` | **No** — gitignored, local source of truth |

**What GitHub cannot do:** public repos have no native passphrase; private repos can’t use free public Pages. So protection is in the page itself (fetch `.enc` → unlock → decrypt).

**Unlock:** enter your passphrase once. Optionally **Remember this device** stores the passphrase in that browser’s `localStorage` only. **Lock** clears it.

### Crypto

- PBKDF2-SHA256, 250k iterations → AES-256-GCM key
- Random salt (16) + IV (12)
- Same params in `scripts/seal_vault.py` and browser Web Crypto

### How to seal (passphrase never in Cursor chat)

```bash
cd ~/PycharmProjects/wealth-dashboard   # your clone
python3 -m pip install cryptography
python3 scripts/seal_vault.py
```

1. Generate / copy a passphrase in the **Bitwarden app** (no Bitwarden CLI).
2. Run the script; paste twice into the **hidden** terminal prompts (Cmd+V).
3. Script encrypts `data/wallet-snapshot.json` → `data/wallet-snapshot.enc`.
4. Passphrase is **not** printed, **not** saved to disk, **not** committed.
5. Tell Cursor **«sealed»** (do not paste the passphrase).

```bash
git add data/wallet-snapshot.enc && git commit -m "Seal vault" && git push
```

Repo must stay **public** + GitHub Pages from `main` for the live URL.

### Editing data later

1. Sync/export → update local `data/wallet-snapshot.json`
2. Re-run `python3 scripts/seal_vault.py` with the **same** Bitwarden passphrase
3. Commit/push sealed `data/wallet-snapshot.enc`

### Caveats

- Stops casual snooping (view-source / raw GitHub). Not strong secrecy: ciphertext + JS are public, so offline brute-force is possible if the passphrase is weak.
- **Git history** may still contain older plaintext commits from before encryption — rotate passphrase going forward; rewrite history only if you need to scrub the past.
- An Apps Script `/exec` URL that returns plaintext is also a secret — don’t publish it.
- Anon mode only blurs the UI; encryption protects the network download.
- Live **Refresh** (Apps Script) bypasses the sealed vault once the web app URL is set; the `.enc` is for cold start after unlock.

## Architecture

```
wallet app → Drive sqlite (+ finary-balances.json)
  → Apps Script web app (Refresh) → live snapshot to browser
  → also: seal_vault.py → wallet-snapshot.enc (GitHub Pages cold start)
  → browser unlock (passphrase) → dashboard mounts
```

While locked, the dashboard DOM is **not mounted** — only the unlock screen exists.

## Setup

1. Install `WalletExport.gs`, deploy as Web app (Anyone), paste `/exec` URL in Settings.
2. Seal a cold-start vault: `python3 scripts/seal_vault.py` (see above).
3. Open the site → unlock with the Bitwarden passphrase → optional Remember this device.
4. **Refresh** requires the Apps Script URL (rebuilds wallet + merges Finary file).

## Features

- Hard lock + encrypted vault unlock (per-device remember)
- Live **Refresh** via Apps Script web app (wallet export + Finary balances merge)
- Net worth hero, Surplus, allocation mix bar, Anon blur
- Spend tab + AI spend note; PEA / Livret / Staging tabs
- Rostom-only wallet ledger; Savings → Bourso LDDS staging
