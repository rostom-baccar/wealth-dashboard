#!/usr/bin/env bash
# Pull the dashboard vault passphrase from Bitwarden into .dashboard-pass
# WITHOUT printing the secret. Safe to run from Cursor / CI helpers.
#
# Prerequisites:
#   brew install bitwarden-cli
#   bw login   (once)
#   Create a Bitwarden Login/Secure Note whose password field is the vault passphrase.
#
# Usage:
#   ./tools/bitwarden-pass.sh                  # item name: "Rostom Dashboard Vault"
#   ./tools/bitwarden-pass.sh "My Item Name"
#   BW_SESSION=… ./tools/bitwarden-pass.sh     # if already unlocked in this shell
#
# Then encrypt:
#   node tools/encrypt-snapshot.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS_FILE="$ROOT/.dashboard-pass"
ITEM_NAME="${1:-${BITWARDEN_ITEM:-Rostom Dashboard Vault}}"

if ! command -v bw >/dev/null 2>&1; then
  echo "bitwarden-cli (bw) not found. Install: brew install bitwarden-cli" >&2
  exit 1
fi

# Unlock only if needed; never echo the master password here — bw prompts TTY.
if [[ -z "${BW_SESSION:-}" ]]; then
  if ! bw unlock --check >/dev/null 2>&1; then
    echo "Unlocking Bitwarden (interactive)…" >&2
    export BW_SESSION="$(bw unlock --raw)"
  fi
fi

# Prefer password field; fall back to notes for Secure Notes.
PASS="$(bw get password "$ITEM_NAME" 2>/dev/null || true)"
if [[ -z "$PASS" ]]; then
  PASS="$(bw get notes "$ITEM_NAME" 2>/dev/null || true)"
fi
if [[ -z "$PASS" ]]; then
  echo "Could not read a password/notes for Bitwarden item: $ITEM_NAME" >&2
  echo "Create a Login named \"$ITEM_NAME\" and put the passphrase in the Password field." >&2
  exit 1
fi

# Trim trailing newlines only (passphrases may contain spaces).
PASS="${PASS%"${PASS##*[![:space:]]}"}"

umask 077
printf '%s\n' "$PASS" > "$PASS_FILE"
chmod 600 "$PASS_FILE"

# Verify without printing.
if [[ ! -s "$PASS_FILE" ]]; then
  echo "Failed to write $PASS_FILE" >&2
  exit 1
fi

echo "OK — wrote .dashboard-pass from Bitwarden item \"$ITEM_NAME\" (contents not shown)."
echo "Encrypt with: node tools/encrypt-snapshot.mjs"
echo "Unlock the public site with the same passphrase from Bitwarden (copy in the BW app)."
