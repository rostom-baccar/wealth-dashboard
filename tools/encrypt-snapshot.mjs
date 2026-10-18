#!/usr/bin/env node
/**
 * Encrypt data/wallet-snapshot.json → data/wallet-snapshot.enc
 *
 * Usage:
 *   DASHBOARD_PASS='your-pass' node tools/encrypt-snapshot.mjs
 *   # or put the pass in .dashboard-pass (gitignored)
 *
 * Decrypt check:
 *   DASHBOARD_PASS='…' node tools/encrypt-snapshot.mjs --verify
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const plainPath = resolve(root, 'data/wallet-snapshot.json');
const encPath = resolve(root, 'data/wallet-snapshot.enc');
const passFile = resolve(root, '.dashboard-pass');

const ITER = 250_000;

function getPass() {
  if (process.env.DASHBOARD_PASS) return process.env.DASHBOARD_PASS.trim();
  if (existsSync(passFile)) return readFileSync(passFile, 'utf8').trim();
  throw new Error('Set DASHBOARD_PASS or create .dashboard-pass');
}

function encrypt(plainUtf8, pass) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(pass, salt, ITER, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plainUtf8, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iter: ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decrypt(bundle, pass) {
  const salt = Buffer.from(bundle.salt, 'base64');
  const iv = Buffer.from(bundle.iv, 'base64');
  const tag = Buffer.from(bundle.tag, 'base64');
  const ct = Buffer.from(bundle.ct, 'base64');
  const key = pbkdf2Sync(pass, salt, bundle.iter || ITER, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const pass = getPass();
const verify = process.argv.includes('--verify');

if (verify) {
  const bundle = JSON.parse(readFileSync(encPath, 'utf8'));
  const text = decrypt(bundle, pass);
  const data = JSON.parse(text);
  console.log('OK — decrypted', data.transactions?.length, 'txs, livretA=', data.balances?.livretA);
  process.exit(0);
}

if (!existsSync(plainPath)) {
  throw new Error('Missing ' + plainPath + ' — export/sync plaintext locally first');
}
const plain = readFileSync(plainPath, 'utf8');
const bundle = encrypt(plain, pass);
writeFileSync(encPath, JSON.stringify(bundle));
// round-trip check
const check = decrypt(bundle, pass);
if (check !== plain) throw new Error('Round-trip failed');
console.log('Wrote', encPath, '(' + Buffer.byteLength(JSON.stringify(bundle)) + ' bytes)');
