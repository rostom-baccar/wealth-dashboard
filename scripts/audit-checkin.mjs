#!/usr/bin/env node
/**
 * Self-audit for the wealth-dashboard AI check-in path.
 * Exit 0 = clean. Exit 1 = failures (printed as FAIL lines).
 *
 * Run: node scripts/audit-checkin.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
const gsPath = path.join(root, 'WalletExport.gs');
const snapPath = path.join(root, 'data', 'wallet-snapshot.json');

const fails = [];
const oks = [];
function ok(name) { oks.push(name); }
function fail(name, detail) { fails.push(detail ? `${name}: ${detail}` : name); }

const html = fs.readFileSync(htmlPath, 'utf8');
const gs = fs.existsSync(gsPath) ? fs.readFileSync(gsPath, 'utf8') : '';
const snap = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf8')) : null;

// --- Script parse ---
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!scriptMatch) fail('script-extract', 'no <script> before </body>');
else {
  try {
    // eslint-disable-next-line no-new-func
    new Function(scriptMatch[1]);
    ok('script-parses');
  } catch (e) {
    fail('script-parses', e.message);
  }
}

// --- Contract: required symbols / anti-regressions ---
const required = [
  ['parseWalletDate', /function parseWalletDate\(/],
  ['localDayStr', /function localDayStr\(/],
  ['checkinDataFingerprint', /function checkinDataFingerprint\(/],
  ['ledgerFingerprint', /function ledgerFingerprint\(/],
  ['clearAiCache', /function clearAiCache\(/],
  ['getAiCache fp gate', /cached\.fp !== checkinDataFingerprint\(\)/],
  ['setAiCache stores fp', /fp:\s*checkinDataFingerprint\(\)/],
  ['googleSearch camelCase', /googleSearch:\s*\{\s*\}/],
  ['no snake_case search tool', null], // special
  ['isGeminiFatalError', /function isGeminiFatalError\(/],
  ['fatal 401/403/429', /status === 401 \|\| status === 403 \|\| status === 429/],
  ['quota detector', /function isGeminiQuotaError\(/],
  ['quota cooldown', /LS_GEMINI_COOLDOWN|gemini_quota_cooldown_until/],
  ['thought filter', /p\.thought !== true/],
  ['thinkingBudget 2.5 only', /if \(\/2\\\.5\/\.test\(modelId\)\)/],
  ['unbudgetedCats', /unbudgetedCats/],
  ['labeledAnchors', /labeledAnchors/],
  ['regen on ledgerChanged', /if \(ledgerChanged\)[\s\S]{0,160}generateAiSummary/],
  ['balances save regen', /checkinDataFingerprint\(\) !== prevFp/],
  ['hero vs clears cache', /function onHeroVsChange\([\s\S]*?clearAiCache\(\)/],
  ['offline never cached', /meta\.source !== 'ai'/],
  ['asOf local day', /asOf:\s*ctx\.today/],
  ['cache key v11+', /dashboard_ai_checkin_v1[1-9]/],
  ['wealth perf split', /function computeWealthPerfSplit\(/],
  ['hero perf you/markets', /id="hero-perf-you"/],
  ['controllable in dossier', /controllablePerfEur/],
  ['goThisMonth scrolls', /function goThisMonth\(/],
  ['perf history bins', /function buildPerfHistoryBins\(/],
  ['perf hist bar chart', /type:\s*'bar'/],
  ['section folds', /function toggleFold\(/],
];

for (const [name, re] of required) {
  if (name === 'no snake_case search tool') {
    if (/google_search\s*:/.test(html)) fail(name, 'found google_search: — must be googleSearch');
    else ok(name);
    continue;
  }
  if (re.test(html)) ok(name);
  else fail(name, 'pattern missing');
}

// --- Export date format must match parser (MM/dd) ---
if (/formatDate\([^,]+,\s*'Europe\/Paris',\s*'MM\/dd\/yyyy/.test(gs)) ok('export-date-mmdd');
else fail('export-date-mmdd', 'WalletExport.gs should format MM/dd/yyyy for Paris');

if (/new Date\(\+m\[3\],\s*\+m\[1\]\s*-\s*1,\s*\+m\[2\]/.test(html)) ok('parser-mmdd');
else fail('parser-mmdd', 'parseWalletDate should treat first number as month');

// --- Pure helpers mirrored from index.html ---
function parseWalletDate(raw) {
  if (raw instanceof Date) return Number.isNaN(+raw) ? null : raw;
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  const isoDay = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ].*)?$/);
  if (isoDay) {
    const time = s.match(/[Tt ](\d{2}):(\d{2})(?::(\d{2}))?/);
    return new Date(
      +isoDay[1], +isoDay[2] - 1, +isoDay[3],
      time ? +time[1] : 0, time ? +time[2] : 0, time ? +(time[3] || 0) : 0,
    );
  }
  const iso = new Date(s);
  return Number.isNaN(+iso) ? null : iso;
}

function localDayStr(d) {
  const x = d instanceof Date ? d : parseWalletDate(d);
  if (!x || Number.isNaN(+x)) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.thought !== true && typeof p.text === 'string' && p.text.trim())
    .map((p) => p.text)
    .join('')
    .trim();
}

function isGeminiQuotaError(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || '');
  return status === 429 || /RESOURCE_EXHAUSTED|quota|rate.?limit|billing details/i.test(msg);
}

function isGeminiFatalError(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || '');
  if (status === 401 || status === 403 || status === 429) return true;
  if (isGeminiQuotaError(err)) return true;
  if (status === 400 && /api[_ ]?key|API_KEY|invalid|permission|CONSUMER|expired/i.test(msg)) return true;
  return false;
}

// Date parse unit tests
{
  const d = parseWalletDate('11/15/2026, 01:18');
  if (d && d.getFullYear() === 2026 && d.getMonth() === 10 && d.getDate() === 15) ok('parse-mmdd-sample');
  else fail('parse-mmdd-sample', String(d));

  const iso = parseWalletDate('2026-11-15');
  if (iso && localDayStr(iso) === '2026-11-15') ok('parse-iso-local-day');
  else fail('parse-iso-local-day', localDayStr(iso));

  // Must NOT shift calendar day via UTC for date-only
  const day = parseWalletDate('2026-01-01');
  if (day && day.getFullYear() === 2026 && day.getMonth() === 0 && day.getDate() === 1) ok('parse-no-utc-shift');
  else fail('parse-no-utc-shift', String(day));
}

// Thought filtering
{
  const text = extractGeminiText({
    candidates: [{
      content: {
        parts: [
          { text: 'thinking aloud', thought: true },
          { text: 'Final answer about wealth.' },
        ],
      },
    }],
  });
  if (text === 'Final answer about wealth.') ok('extract-skips-thoughts');
  else fail('extract-skips-thoughts', JSON.stringify(text));
}

// Fatal error classification
{
  const cases = [
    [{ status: 401, message: 'x' }, true],
    [{ status: 403, message: 'x' }, true],
    [{ status: 429, message: 'x' }, true],
    [{ status: 400, message: 'API key not valid' }, true],
    [{ status: 404, message: 'model not found' }, false],
    [{ status: 500, message: 'oops' }, false],
  ];
  for (const [err, want] of cases) {
    const got = isGeminiFatalError(err);
    if (got === want) ok(`fatal-${err.status}`);
    else fail(`fatal-${err.status}`, `got ${got} want ${want}`);
  }
  // Google's real wording — must match even when status is missing/odd.
  const quotaMsg = { status: 400, message: 'You exceeded your current quota, please check your plan and billing details.' };
  if (isGeminiQuotaError(quotaMsg) && isGeminiFatalError(quotaMsg)) ok('quota-exceeded-wording');
  else fail('quota-exceeded-wording');
}

// Snapshot life-event surface (dossier must be able to see these)
if (snap && Array.isArray(snap.transactions)) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const month = snap.transactions
    .map((t) => ({ ...t, date: parseWalletDate(t.date) }))
    .filter((t) => t.date && t.date.getFullYear() === y && t.date.getMonth() === m);

  const budgets = snap.budgets || [];
  const budgeted = new Set();
  budgets.forEach((b) => (b.categories || []).forEach((c) => budgeted.add(c)));

  const oob = month.filter((t) => !budgeted.has(t.category) || /out of budget/i.test(t.category || ''));
  const labeled = month.filter((t) => (t.memo || '').trim());

  if (month.length > 0) ok(`snapshot-month-tx(${month.length})`);
  else fail('snapshot-month-tx', 'no txs in current calendar month — check date parse');

  // Out of budget category should not be on a budget's category list
  const oobOnBudget = budgets.some((b) => (b.categories || []).some((c) => /out of budget/i.test(c)));
  if (!oobOnBudget) ok('oob-not-on-budget-list');
  else fail('oob-not-on-budget-list', 'Out of budget listed under a budget — catch-all logic may double-count');

  if (oob.length >= 0) ok(`oob-month-count(${oob.length})`);
  if (labeled.length >= 0) ok(`labeled-month-count(${labeled.length})`);

  // Luggage-style memos should remain visible to labeledAnchors path
  const luggage = month.find((t) => /luggage/i.test(t.memo || ''));
  if (luggage) {
    if (!budgeted.has(luggage.category) || /out of budget/i.test(luggage.category)) ok('luggage-unbudgeted-memo');
    else fail('luggage-unbudgeted-memo', `Luggage on budgeted cat ${luggage.category}`);
  } else {
    ok('luggage-absent-ok');
  }
} else {
  fail('snapshot-load', 'data/wallet-snapshot.json missing or invalid');
}

// Prompt must still push life events + markets
if (/labeledMoneyMovements/.test(html) && /portfolioMoveLikelyDominatesWealthChange/.test(html)) {
  ok('prompt-life-and-markets');
} else fail('prompt-life-and-markets');

if (/controllablePerfEur \(You\)|controllablePerfEur/.test(html) && /nonControllablePerfEur/.test(html)) {
  ok('prompt-you-vs-markets');
} else fail('prompt-you-vs-markets');

// Output
for (const name of oks) console.log(`OK  ${name}`);
for (const f of fails) console.log(`FAIL ${f}`);
console.log(`\n${oks.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
