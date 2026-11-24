// ================================================================
// WALLET EXPORT v2 — Pure Server-Side Apps Script
// - Manual only (runNow / sheet menu) — no hourly/daily triggers
// - Exports Sheet + wallet-snapshot.json on Drive (for encrypt → Pages)
// ================================================================

const SQLITE_FOLDER_ID = '1npXyzRNG1e41XoQ6v5wfTq78UT1hn-L_';
const SQLITE_FILE_NAME = 'wallet-database';
const SHEET_ID         = '16R36tG69nlTuF-Opb-YUep_HNzQg4wCa69jU7uWxXcY';
const TAB_GID          = 450720486;
const JSON_FILE_NAME     = 'wallet-snapshot.json'; // written alongside wallet-database
const BALANCES_FILE_NAME = 'finary-balances.json'; // optional; merged into snapshot if present

/** Set by readSQLiteFromDrive — which Money Manager DB file was used. */
var LAST_WALLET_META_ = null;

// ================================================================
// ENTRY POINT — manual only (menu, runNow, or optional web app)
// ================================================================
function exportWalletToSheet() {
  try {
    Logger.log('Starting wallet export...');
    const bytes = readSQLiteFromDrive();
    Logger.log('Read ' + bytes.length + ' bytes'
      + (LAST_WALLET_META_ ? (' from ' + LAST_WALLET_META_.fileId + ' @ ' + LAST_WALLET_META_.updatedAt) : ''));
    const db = parseSQLite(bytes);
    Logger.log('Tables: ' + Object.keys(db).join(', '));

    // category.type: 1 = income, 2 = expense (Wallet Manager). Names can be blank!
    const categories = {};
    (db['category'] || []).forEach(c => {
      categories[c.id] = { name: c.name || '', type: c.type };
      categories[String(c.id)] = categories[c.id];
      if (!isNaN(+c.id)) categories[+c.id] = categories[c.id];
    });
    const wallets = buildLookup(db['wallet'] || [], 'id', 'name');
    const spendAccountId = resolveSpendAccountId_(db['account'] || []);

    // Spend ledger = Rostom profile only. Skip transfers (type 2) — they are not income/spend.
    // Savings profile (PEA/Livret staging) is read separately into balances.
    const trans = (db['trans'] || [])
      .filter(t => {
        // Coerce ids — Apps Script SQLite parser may yield strings.
        if (spendAccountId != null && +t['account_id'] !== +spendAccountId) return false;
        if (+t['type'] === 2) return false; // transfer
        const cat = categories[t['category_id']] || categories[+t['category_id']];
        const name = (cat && cat.name) || '';
        // Keep blank-named categories (salary lives here). Only drop progress-bar noise.
        return name !== 'Month progress bar' && name !== 'Month progress bar compensation';
      })
      .sort((a, b) => (+b['date_time'] || 0) - (+a['date_time'] || 0))
      .map(t => {
        const epochMs  = +t['date_time'] || 0;
        const date     = new Date(epochMs);
        const dateStr  = Utilities.formatDate(date, 'Europe/Paris', 'MM/dd/yyyy, HH:mm');
        const amount   = (+t['amount'] || 0) / 100.0;
        const cat      = categories[t['category_id']] || categories[+t['category_id']] || {};
        // Prefer amount sign; fall back to category.type (1=income)
        const type     = amount > 0 || +cat.type === 1 ? 'Income' : 'Expense';
        // Blank income category names are usually salary in this app
        let category   = cat.name || '';
        if (!category) {
          const note = (t['note'] || '').toLowerCase();
          category = note.includes('salary') || note.includes('salaire')
            ? 'Salary'
            : (type === 'Income' ? 'Income' : 'Expense');
        }
        const wallet   = wallets[t['wallet_id']] || wallets[+t['wallet_id']] || '';
        const memo     = t['note'] || '';
        return [dateStr, type, category, amount, 'EUR', memo, wallet];
      });

    const budgets = buildBudgetsFromDb_(db, categories, spendAccountId);
    const savings = extractSavingsStaging_(db, wallets);

    writeToSheet(trans);
    writeJsonSnapshot(trans, budgets, savings); // also write JSON for standalone dashboard
    Logger.log('Export complete: ' + trans.length + ' transactions (account ' + spendAccountId + '), ' + budgets.length + ' budgets'
      + (savings && savings.boursoLdds != null ? ', LDDS staging €' + savings.boursoLdds : ''));

  } catch(e) {
    Logger.log('ERROR: ' + e.message + '\n' + e.stack);
    // Show user-facing toast if running manually
    try { SpreadsheetApp.getActiveSpreadsheet().toast('Error: ' + e.message, 'Export failed', 5); } catch(_) {}
    throw e;
  }
}

// ================================================================
// WRITE JSON SNAPSHOT — standalone dashboard reads this directly
// Format: { lastSync, transactions: [{date,type,category,amount,memo}] }
// ================================================================
/** Spend profile = Money Manager account named Rostom (fallback: lowest id). */
function resolveSpendAccountId_(accounts) {
  const rows = accounts || [];
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].name || '').trim().toLowerCase() === 'rostom') return rows[i].id;
  }
  if (rows.length) return rows[0].id;
  return null;
}

/**
 * Savings profile → Bourso LDDS staging.
 * Prefer the live LDDS wallet balance when that wallet is active (0 = cleared after PEA).
 * Inactive LDDS shells often stay at amount=0 after transfers — then use net transfers in − out.
 */
function extractSavingsStaging_(db, wallets) {
  const accounts = db['account'] || [];
  let savingsId = null;
  for (let i = 0; i < accounts.length; i++) {
    if (String(accounts[i].name || '').trim().toLowerCase() === 'savings') {
      savingsId = accounts[i].id;
      break;
    }
  }
  if (savingsId == null) return null;
  const walletName = (id) => String(
    wallets[id] || wallets[+id] || wallets[String(id)] || ''
  );
  let into = 0;
  let out = 0;
  let n = 0;
  (db['trans'] || []).forEach(t => {
    // SQLite parser may yield string ids — coerce before comparing.
    if (+t['account_id'] !== +savingsId) return;
    if (+t['type'] !== 2) return; // transfers only
    const fromName = walletName(t['wallet_id']);
    const toName = walletName(t['transfer_wallet_id']);
    const amt = Math.abs(+t['amount'] || 0) / 100.0;
    if (/ldds/i.test(toName)) { into += amt; n++; }
    if (/ldds/i.test(fromName)) { out += amt; n++; }
  });
  const fromTransfers = Math.round((into - out) * 100) / 100;

  let liveLdds = null;
  let liveActive = false;
  (db['wallet'] || []).forEach(w => {
    if (+w['account_id'] !== +savingsId) return;
    if (!/ldds/i.test(String(w.name || ''))) return;
    liveLdds = (+w.amount || 0) / 100.0;
    liveActive = +w.active === 1;
  });

  const boursoLdds = (liveLdds != null && liveActive)
    ? Math.round(liveLdds * 100) / 100
    : fromTransfers;

  return {
    profile: 'Savings',
    accountId: savingsId,
    boursoLdds: boursoLdds,
    transferCount: n,
    liveActive: liveActive,
    liveLdds: liveLdds,
  };
}

/** Build dashboard budgets from Wallet Manager budget + budgetCategory tables. */
function buildBudgetsFromDb_(db, categories, spendAccountId) {
  const skip = { 'Month progress bar': 1, 'Month progress bar compensation': 1 };
  const linksByBudget = {};
  (db['budgetCategory'] || []).forEach(bc => {
    const bid = bc['budget_id'];
    if (!linksByBudget[bid]) linksByBudget[bid] = [];
    linksByBudget[bid].push(bc['category_id']);
  });
  const out = [];
  (db['budget'] || []).forEach(b => {
    if (spendAccountId != null && b['account_id'] != null && +b['account_id'] !== +spendAccountId) return;
    const name = String(b.name || '').trim();
    if (skip[name] || name.toLowerCase().indexOf('month progress') === 0) return;
    const catNames = [];
    const seen = {};
    (linksByBudget[b.id] || linksByBudget[String(b.id)] || []).forEach(cid => {
      const cn = (categories[cid] && categories[cid].name)
        || (categories[+cid] && categories[+cid].name)
        || '';
      if (cn && !skip[cn] && !seen[cn]) {
        seen[cn] = 1;
        catNames.push(cn);
      }
    });
    out.push({
      id: b.id,
      name: name || ('Budget ' + b.id),
      amount: (+b.amount || 0) / 100.0,
      period: b.period,
      categories: catNames,
    });
  });
  return out;
}

function writeJsonSnapshot(rows, budgets, savings) {
  const folder = DriveApp.getFolderById(SQLITE_FOLDER_ID);
  const prev = readExistingSnapshot_(folder);

  const snapshot = {
    lastSync: new Date().toISOString(),
    transactions: rows.map(r => ({
      date:     r[0],
      type:     r[1],
      category: r[2],
      amount:   r[3],
      currency: r[4],
      memo:     r[5],
      wallet:   r[6],
    })),
    budgets: budgets || [],
  };

  // Merge Finary balances if Cursor (or another sync) wrote finary-balances.json
  const balances = readSiblingJson_(folder, BALANCES_FILE_NAME);
  if (balances) {
    snapshot.balances = balances;
    Logger.log('Merged balances from ' + BALANCES_FILE_NAME);
  } else if (prev && prev.balances) {
    // Preserve previous snapshot.balances when rewriting in place
    snapshot.balances = prev.balances;
    Logger.log('Preserved previous snapshot.balances');
  }
  if (!snapshot.balances) snapshot.balances = {};

  // Keep manual / PDF-only fields if the Finary file omitted them
  if (prev && prev.balances) {
    ['pee', 'peeDetail', 'costBasisFromPdf', 'peaContributions', 'livretHistory', 'peaTrades'].forEach(function (k) {
      if (snapshot.balances[k] == null && prev.balances[k] != null) {
        snapshot.balances[k] = prev.balances[k];
      }
    });
  }

  snapshot.balances.budgets = budgets || [];

  // Staging is Money Manager only — drop any boursoLdds copied from finary-balances
  delete snapshot.balances.boursoLdds;
  delete snapshot.balances.boursoLddsSource;
  delete snapshot.savingsProfile;

  // Staging always comes from the live Money Manager SQLite (after Finary merge).
  // Always write the key (including 0) so the dashboard cannot keep a stale Settings value.
  if (savings && savings.boursoLdds != null && isFinite(+savings.boursoLdds)) {
    snapshot.balances.boursoLdds = +savings.boursoLdds;
    snapshot.balances.boursoLddsSource = 'money-manager:Savings';
    snapshot.savingsProfile = savings;
  } else if (prev && prev.savingsProfile && prev.savingsProfile.boursoLdds != null
      && isFinite(+prev.savingsProfile.boursoLdds)) {
    // Only keep prior staging when live extract failed entirely (not when cleared to 0)
    snapshot.savingsProfile = prev.savingsProfile;
    snapshot.balances.boursoLdds = +prev.savingsProfile.boursoLdds;
    snapshot.balances.boursoLddsSource = prev.balances && prev.balances.boursoLddsSource
      ? prev.balances.boursoLddsSource
      : 'money-manager:Savings';
  } else {
    snapshot.balances.boursoLdds = null;
    snapshot.balances.boursoLddsSource = null;
  }

  snapshot.refreshMeta = {
    walletFileId: LAST_WALLET_META_ && LAST_WALLET_META_.fileId || null,
    walletUpdatedAt: LAST_WALLET_META_ && LAST_WALLET_META_.updatedAt || null,
    finaryUpdatedAt: snapshot.balances.updatedAt || null,
    boursoLdds: snapshot.balances.boursoLdds != null ? snapshot.balances.boursoLdds : null,
    txCount: (snapshot.transactions || []).length,
    budgetCount: (budgets || []).length,
    exportedAt: snapshot.lastSync,
  };

  const json = JSON.stringify(snapshot);
  const file = upsertJsonFile_(folder, JSON_FILE_NAME, json);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  Logger.log('JSON snapshot written: ' + file.getId());
  Logger.log('Snapshot URL: https://drive.google.com/uc?export=download&id=' + file.getId());

  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let metaSheet = ss.getSheetByName('_meta');
    if (!metaSheet) metaSheet = ss.insertSheet('_meta');
    metaSheet.getRange('A1').setValue(file.getId());
    metaSheet.getRange('B1').setValue(new Date().toISOString());
    metaSheet.getRange('A1').setNote('wallet-snapshot.json Drive file ID — stable; dashboard stores this once');
  } catch(e) {
    Logger.log('Could not write meta sheet: ' + e.message);
  }
}

/** Update existing JSON file in place so the Drive file ID stays stable. */
function upsertJsonFile_(folder, name, json) {
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    const file = existing.next();
    // Trash any duplicates, keep the first
    while (existing.hasNext()) existing.next().setTrashed(true);
    file.setContent(json);
    return file;
  }
  return folder.createFile(name, json, 'application/json');
}

function readSiblingJson_(folder, name) {
  const files = folder.getFilesByName(name);
  if (!files.hasNext()) return null;
  try {
    return JSON.parse(files.next().getBlob().getDataAsString());
  } catch (e) {
    Logger.log('Could not parse ' + name + ': ' + e.message);
    return null;
  }
}

function readExistingSnapshot_(folder) {
  return readSiblingJson_(folder, JSON_FILE_NAME);
}

// ================================================================
// WRITE TO GOOGLE SHEET (unchanged from v1)
// ================================================================
function writeToSheet(rows) {
  const ss     = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  let sheet    = sheets.find(s => s.getSheetId() === TAB_GID);
  if (!sheet) sheet = ss.insertSheet('Transactions');

  sheet.clearContents();
  sheet.clearFormats();

  const header = ['Date', 'Type', 'Category', 'Amount', 'Currency', 'Memo', 'Wallet'];
  sheet.getRange(1, 1, 1, header.length)
    .setValues([header])
    .setFontWeight('bold')
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff');

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  }

  sheet.getRange(2, 4, rows.length || 1, 1).setNumberFormat('0.00');
  header.forEach((_, i) => sheet.autoResizeColumn(i + 1));
  sheet.getRange('H1').setValue('Last sync: ' +
    Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy HH:mm'));

  SpreadsheetApp.flush();
}

// ================================================================
// MANUAL TRIGGER — bound to a button in the sheet UI
// Shows a toast notification before and after
// ================================================================
function manualRefresh() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Syncing wallet data from SQLite…', '🔄 Refreshing', -1);
  try {
    exportWalletToSheet();
    ss.toast('✅ Done! ' + new Date().toLocaleTimeString(), 'Sync complete', 4);
  } catch(e) {
    ss.toast('❌ ' + e.message, 'Sync failed', 8);
  }
}

// ================================================================
// TRIGGERS — manual only. Run removeAutoTriggers() once to clear
// any old hourly/daily installs.
// ================================================================
function removeAutoTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let n = 0;
  triggers.forEach(t => {
    ScriptApp.deleteTrigger(t);
    n++;
  });
  Logger.log('Removed ' + n + ' trigger(s). Export is manual-only now (runNow / menu).');
}

/** @deprecated Use removeAutoTriggers — hourly schedule removed. */
function installHourlyTrigger() {
  removeAutoTriggers();
  Logger.log('No auto schedule installed. Use runNow() or the Wallet menu.');
}

/** Sheet menu: Wallet → Export now */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Wallet')
    .addItem('Export now (manual)', 'manualRefresh')
    .addItem('Remove auto triggers', 'removeAutoTriggers')
    .addToUi();
}

// ================================================================
// MANUAL — run this any time to force a fresh export
// ================================================================
function runNow() { exportWalletToSheet(); }

// ================================================================
// SQLITE PARSER (unchanged from v1)
// ================================================================
function readSQLiteFromDrive() {
  const folder = DriveApp.getFolderById(SQLITE_FOLDER_ID);
  const files  = folder.getFilesByName(SQLITE_FILE_NAME);
  const all = [];
  while (files.hasNext()) all.push(files.next());
  if (!all.length) throw new Error('wallet-database not found in ' + SQLITE_FOLDER_ID);

  all.sort(function (a, b) {
    return b.getLastUpdated().getTime() - a.getLastUpdated().getTime();
  });
  const newest = all[0];
  const newestTs = newest.getLastUpdated().getTime();

  // Money Manager sometimes leaves duplicate wallet-database files — keep newest only.
  for (var i = 1; i < all.length; i++) {
    var older = all[i];
    if (newestTs - older.getLastUpdated().getTime() > 60 * 1000) {
      try {
        Logger.log('Trashing older wallet-database ' + older.getId()
          + ' @ ' + older.getLastUpdated().toISOString());
        older.setTrashed(true);
      } catch (e) {
        Logger.log('Could not trash older wallet-database: ' + e.message);
      }
    }
  }

  LAST_WALLET_META_ = {
    fileId: newest.getId(),
    updatedAt: newest.getLastUpdated().toISOString(),
    name: newest.getName(),
    bytes: newest.getSize(),
  };
  return newest.getBlob().getBytes();
}

function parseSQLite(bytes) {
  const u8  = i => bytes[i] & 0xFF;
  const u16 = i => (u8(i) << 8) | u8(i+1);
  const u32 = i => ((u8(i) << 24) | (u8(i+1) << 16) | (u8(i+2) << 8) | u8(i+3)) >>> 0;

  function readInt(pos, len) {
    let v = u8(pos);
    const neg = v & 0x80;
    if (neg) v = v - 256;
    for (let i = 1; i < len; i++) v = v * 256 + u8(pos + i);
    return v;
  }

  function readVarint(pos) {
    let v = 0, i = 0;
    for (; i < 8; i++) {
      const b = u8(pos + i);
      v = v * 128 + (b & 0x7F);
      if (!(b & 0x80)) return { value: v, bytesRead: i + 1 };
    }
    v = v * 256 + u8(pos + 8);
    return { value: v, bytesRead: 9 };
  }

  function utf8(pos, len) {
    const arr = [];
    for (let i = 0; i < len; i++) arr.push(u8(pos + i));
    try { return decodeURIComponent(escape(String.fromCharCode.apply(null, arr))); }
    catch(e) { return String.fromCharCode.apply(null, arr); }
  }

  const magic = utf8(0, 15);
  if (!magic.startsWith('SQLite format 3')) throw new Error('Not a SQLite file');

  let pageSize = u16(16);
  if (pageSize === 1) pageSize = 65536;

  function parsePage(pgno) {
    const base   = (pgno - 1) * pageSize;
    const hdrOff = pgno === 1 ? 100 : 0;
    const pageType = u8(base + hdrOff);
    const isLeaf   = pageType === 0x0D;
    const isInner  = pageType === 0x05;
    if (!isLeaf && !isInner) return { type: pageType, cells: [], children: [] };

    const cellCount = u16(base + hdrOff + 3);
    const ptrStart  = hdrOff + (isInner ? 12 : 8);
    const children  = [];
    if (isInner) children.push(u32(base + hdrOff + 8));

    const cells = [];
    for (let i = 0; i < cellCount; i++) {
      const cellPtr = u16(base + ptrStart + i * 2);
      const absPtr  = base + cellPtr;
      if (isLeaf) {
        let pos = absPtr;
        const pl  = readVarint(pos); pos += pl.bytesRead;
        const rid = readVarint(pos); pos += rid.bytesRead;
        cells.push({ rowid: rid.value, payloadStart: pos, payloadSize: pl.value });
      } else {
        children.push(u32(absPtr));
      }
    }
    return { type: pageType, cells, children };
  }

  function decodeRecord(start) {
    let pos = start;
    const hl = readVarint(pos); pos += hl.bytesRead;
    const headerEnd = start + hl.value;
    const types = [];
    let hpos = pos;
    while (hpos < headerEnd) {
      const t = readVarint(hpos); hpos += t.bytesRead;
      types.push(t.value);
    }
    let vpos = headerEnd;
    return types.map(tc => {
      if (tc === 0) return null;
      if (tc === 8) return 0;
      if (tc === 9) return 1;
      if (tc >= 1 && tc <= 6) {
        const lens = [0,1,2,3,4,6,8];
        const len  = lens[tc];
        const v = readInt(vpos, len);
        vpos += len;
        return v;
      }
      if (tc === 7) {
        const dv = new DataView(new ArrayBuffer(8));
        for (let k = 0; k < 8; k++) dv.setUint8(k, u8(vpos + k));
        vpos += 8;
        return dv.getFloat64(0, false);
      }
      if (tc >= 12) {
        if (tc % 2 === 0) { const len = (tc - 12) / 2; vpos += len; return null; }
        else { const len = (tc - 13) / 2; const s = utf8(vpos, len); vpos += len; return s; }
      }
      return null;
    });
  }

  function scanTable(rootPage) {
    const rows = [], queue = [rootPage], visited = {};
    while (queue.length > 0) {
      const pgno = queue.shift();
      if (visited[pgno]) continue;
      visited[pgno] = true;
      const page = parsePage(pgno);
      if (page.type === 0x0D) {
        page.cells.forEach(cell => {
          try { rows.push({ _rowid: cell.rowid, _values: decodeRecord(cell.payloadStart) }); }
          catch(e) {}
        });
      }
      page.children.forEach(c => { if (c && !visited[c]) queue.push(c); });
    }
    return rows;
  }

  const masterRows = scanTable(1);
  const tableRoots = {}, tableColNames = {};

  masterRows.forEach(r => {
    const v = r._values;
    if (!v || v[0] !== 'table') return;
    tableRoots[v[1]]    = v[3];
    tableColNames[v[1]] = parseColumnNames(v[4] || '');
  });

  function parseColumnNames(sql) {
    const m = sql.match(/\((.+)\)/s);
    if (!m) return [];
    return m[1].split(',')
      .map(col => col.trim().split(/\s+/)[0].replace(/["`\[\]]/g, ''))
      .filter(n => n && !['PRIMARY','FOREIGN','UNIQUE','CHECK','CONSTRAINT'].includes(n.toUpperCase().split(' ')[0]));
  }

  const result = {};
  ['trans', 'category', 'wallet', 'budget', 'budgetCategory'].forEach(tbl => {
    const root = tableRoots[tbl];
    if (!root) return;
    const cols = tableColNames[tbl] || [];
    const rawRows = scanTable(root);
    result[tbl] = rawRows.map(r => {
      const obj = { _rowid: r._rowid };
      cols.forEach((col, i) => {
        obj[col] = (r._values[i] !== null && r._values[i] !== undefined) ? r._values[i] : (i === 0 ? r._rowid : null);
      });
      return obj;
    });
  });
  return result;
}

function buildLookup(rows, keyCol, valCol) {
  const map = {};
  rows.forEach(r => {
    const k = r[keyCol];
    const v = r[valCol];
    map[k] = v;
    map[String(k)] = v;
    if (k != null && !isNaN(+k)) map[+k] = v;
  });
  return map;
}


// ================================================================
// WEB APP — dashboard Refresh uses ?full=1&callback=… (JSONP)
// to export wallet SQLite → snapshot (merges finary-balances.json)
// and return the full JSON to the browser (bypasses CORS).
// ================================================================
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const readOnly = String(params.read || '') === '1';
    const wantFull = String(params.full || '') === '1';
    const callback = String(params.callback || '').replace(/[^\w.$]/g, '');

    if (!readOnly) exportWalletToSheet();

    const folder = DriveApp.getFolderById(SQLITE_FOLDER_ID);
    const snapshot = readExistingSnapshot_(folder);
    if (!snapshot) {
      return jsonpOrJson_({ ok: false, error: 'No wallet-snapshot.json found after export' }, callback);
    }

    if (wantFull) {
      // Live Refresh payload — txs + balances (Finary merge happens in writeJsonSnapshot)
      snapshot.ok = true;
      snapshot.servedAt = new Date().toISOString();
      return jsonpOrJson_(snapshot, callback);
    }

    return jsonpOrJson_({
      ok: true,
      servedAt: new Date().toISOString(),
      lastSync: snapshot.lastSync || null,
      txCount: (snapshot.transactions || []).length,
      hasBalances: !!snapshot.balances,
      note: 'Pass full=1 to receive the snapshot body (used by dashboard Refresh).',
    }, callback);
  } catch (err) {
    const params = (e && e.parameter) || {};
    const callback = String(params.callback || '').replace(/[^\w.$]/g, '');
    return jsonpOrJson_({ ok: false, error: String(err && err.message || err) }, callback);
  }
}

function jsonpOrJson_(obj, callback) {
  const body = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}
