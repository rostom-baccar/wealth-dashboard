#!/usr/bin/env python3
"""Seal data/wallet-snapshot.json → data/wallet-snapshot.enc with a passphrase.

Same soft-protection model as network-graph: public repo + Pages, ciphertext only.
The passphrase is read only in YOUR terminal (hidden getpass). It is never
printed, never written to disk, and never sent to chat.

Crypto (matches browser Web Crypto in index.html):
  PBKDF2-SHA256, 250k iterations → AES-256-GCM
  Random salt (16) + IV (12); auth tag stored separately as `tag`

Usage:
  cd ~/PycharmProjects/wealth-dashboard   # or your clone
  python3 -m pip install cryptography
  python3 scripts/seal_vault.py

Bitwarden (no CLI login):
  1. Generate / copy a passphrase in the Bitwarden app
  2. Run this script
  3. Paste into the hidden prompt (Cmd+V), Enter
  4. Confirm by pasting again
  5. Tell Cursor «sealed» — do NOT paste the passphrase in chat
"""

from __future__ import annotations

import base64
import getpass
import json
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "wallet-snapshot.json"
ENC_PATH = ROOT / "data" / "wallet-snapshot.enc"
ITERATIONS = 250_000


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=ITERATIONS,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt(passphrase: str, plaintext: bytes) -> dict:
    salt = secrets.token_bytes(16)
    iv = secrets.token_bytes(12)
    key = derive_key(passphrase, salt)
    # AESGCM.encrypt returns ciphertext || tag (16 bytes)
    packed = AESGCM(key).encrypt(iv, plaintext, None)
    ct, tag = packed[:-16], packed[-16:]
    return {
        "v": 1,
        "kdf": "PBKDF2",
        "hash": "SHA-256",
        "iter": ITERATIONS,
        "salt": b64(salt),
        "iv": b64(iv),
        "tag": b64(tag),
        "ct": b64(ct),
    }


def decrypt_bundle(bundle: dict, passphrase: str) -> bytes:
    salt = base64.b64decode(bundle["salt"])
    iv = base64.b64decode(bundle["iv"])
    tag = base64.b64decode(bundle["tag"])
    ct = base64.b64decode(bundle["ct"])
    key = derive_key(passphrase, salt)
    return AESGCM(key).decrypt(iv, ct + tag, None)


def main() -> int:
    verify = "--verify" in sys.argv

    if verify:
        if not ENC_PATH.exists():
            print(f"Missing {ENC_PATH}", file=sys.stderr)
            return 1
        print("Verify sealed vault (input hidden; not saved).\n")
        p = getpass.getpass("Passphrase: ")
        if not p:
            print("Empty passphrase — aborting.", file=sys.stderr)
            return 1
        try:
            bundle = json.loads(ENC_PATH.read_text())
            text = decrypt_bundle(bundle, p)
            del p
            data = json.loads(text.decode("utf-8"))
        except Exception:
            print("FAIL — wrong passphrase or corrupted vault file.", file=sys.stderr)
            return 1
        print(
            "OK — decrypted",
            len(data.get("transactions") or []),
            "txs · livretA=",
            (data.get("balances") or {}).get("livretA"),
        )
        return 0

    if not DATA_PATH.exists():
        print(f"Missing {DATA_PATH}", file=sys.stderr)
        print("Sync/export plaintext locally first (tools/sync_dashboard.py).", file=sys.stderr)
        return 1

    plain = DATA_PATH.read_bytes()
    # Validate JSON before sealing
    try:
        data = json.loads(plain.decode("utf-8"))
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in {DATA_PATH}: {e}", file=sys.stderr)
        return 1

    print("Paste your Bitwarden passphrase below (input is hidden).")
    print("It will NOT be shown, saved, or printed.\n")
    p1 = getpass.getpass("Passphrase: ")
    p2 = getpass.getpass("Confirm passphrase: ")
    if not p1:
        print("Empty passphrase — aborting.", file=sys.stderr)
        return 1
    if p1 != p2:
        print("Passphrases do not match — aborting.", file=sys.stderr)
        return 1

    payload = encrypt(p1, plain)
    # Local verify before writing
    try:
        decrypt_bundle(payload, p1)
    except Exception as e:
        print(f"Internal seal verify failed: {e}", file=sys.stderr)
        return 1
    del p1, p2

    ENC_PATH.parent.mkdir(parents=True, exist_ok=True)
    ENC_PATH.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

    n_tx = len(data.get("transactions") or [])
    print("\nSealed.")
    print(f"  transactions: {n_tx}")
    print(f"  wrote: {ENC_PATH}")
    print("\nNext: tell Cursor «sealed» (do NOT paste the passphrase).")
    print("Then hard-refresh the live site and unlock with that Bitwarden passphrase.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        raise SystemExit(130)
