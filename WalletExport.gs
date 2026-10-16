// ================================================================
// WALLET EXPORT v2 — Pure Server-Side Apps Script
// - Hourly auto-trigger (unchanged from v1)
// - Manual trigger button in the sheet
// - NEW: also exports a JSON snapshot to Drive for the standalone
//   dashboard to read without needing MCP or Claude
// ================================================================

const SQLITE_FOLDER_ID = '1npXyzRNG1e41XoQ6v5wfTq78UT1hn-L_';
const SQLITE_FILE_NAME = 'wallet-database';
const SHEET_ID         = '16R36tG69nlTuF-Opb-YUep_HNzQg4wCa69jU7uWxXcY';
const TAB_GID          = 450720486;
const JSON_FILE_NAME     = 'wallet-snapshot.json'; // written alongside wallet-database
const BALANCES_FILE_NAME = 'finary-balances.json'; // optional; merged into snapshot if present

// ================================================================
// ENTRY POINT — hourly trigger + manual button both call this
// ================================================================
function exportWalletToSheet() {
  try {
    Logger.log('Starting wallet export...');
    const bytes = readSQLiteFromDrive();
    Logger.log('Read ' + bytes.length + ' bytes');
    const db = parseSQLite(bytes);
    Logger.log('Tables: ' + Object.keys(db).join(', '));

    // category.type: 1 = income, 2 = expense (Wallet Manager). Names can be blank!
    const categories = {};
    (db['category'] || []).forEach(c => {
      categories[c.id] = { name: c.name || '', type: c.type };
    });
    const wallets = buildLookup(db['wallet'] || [], 'id', 'name');

    const trans = (db['trans'] || [])
      .filter(t => {
        const cat = categories[t['category_id']];
        const name = (cat && cat.name) || '';
        // Keep blank-named categories (salary lives here). Only drop progress-bar noise.
        return name !== 'Month progress bar' && name !== 'Month progress bar compensation';
      })
      .sort((a, b) => (b['date_time'] || 0) - (a['date_time'] || 0))
      .map(t => {
        const epochMs  = t['date_time'] || 0;
        const date     = new Date(epochMs);
        const dateStr  = Utilities.formatDate(date, 'Europe/Paris', 'MM/dd/yyyy, HH:mm');
        const amount   = (t['amount'] || 0) / 100.0;
        const cat      = categories[t['category_id']] || {};
        // Prefer amount sign; fall back to category.type (1=income)
        const type     = amount > 0 || cat.type === 1 ? 'Income' : 'Expense';
        // Blank income category names are usually salary in this app
        let category   = cat.name || '';
        if (!category) {
          const note = (t['note'] || '').toLowerCase();
          category = note.includes('salary') || note.includes('salaire')
            ? 'Salary'
            : (type === 'Income' ? 'Income' : 'Expense');
        }
        const wallet   = wallets[t['wallet_id']] || '';
        const memo     = t['note'] || '';
        return [dateStr, type, category, amount, 'EUR', memo, wallet];
      });

    writeToSheet(trans);
    writeJsonSnapshot(trans); // <-- NEW: also write JSON for standalone dashboard
    Logger.log('Export complete: ' + trans.length + ' transactions');

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
function writeJsonSnapshot(rows) {
  const folder = DriveApp.getFolderById(SQLITE_FOLDER_ID);

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
    }))
  };

  // Merge Finary balances if Cursor (or another sync) wrote finary-balances.json
  const balances = readSiblingJson_(folder, BALANCES_FILE_NAME);
  if (balances) {
    snapshot.balances = balances;
    Logger.log('Merged balances from ' + BALANCES_FILE_NAME);
  } else {
    // Preserve previous snapshot.balances when rewriting in place
    const prev = readExistingSnapshot_(folder);
    if (prev && prev.balances) {
      snapshot.balances = prev.balances;
      Logger.log('Preserved previous snapshot.balances');
    }
  }

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
// TRIGGER INSTALLER — run ONCE manually, then never again
// Installs both: hourly auto-trigger + keeps manual button working
// ================================================================
function installHourlyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'exportWalletToSheet')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('exportWalletToSheet')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('Hourly trigger installed.');
  Logger.log('Manual trigger: draw a button in the sheet and assign it to manualRefresh()');
}

// ================================================================
// ADD MANUAL BUTTON TO SHEET — run once to insert the button
// ================================================================
function addManualButton() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheets()[0]; // first sheet

  // Insert a drawing (button) and assign manualRefresh to it
  // Note: Apps Script can't directly create styled buttons, but we
  // can create a simple text box that looks like one
  const drawing = sheet.newChart()
    .setChartType(Charts.ChartType.BAR) // placeholder; we use insertImage workaround
    .build();

  // Better: use a cell with background as button — users click via a menu item
  let metaSheet = ss.getSheetByName('_meta');
  if (!metaSheet) metaSheet = ss.insertSheet('_meta');

  metaSheet.getRange('D1').setValue('🔄 Manual Refresh')
    .setBackground('#4a9eff')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  metaSheet.setColumnWidth(4, 160);

  Logger.log('Button cell added at _meta!D1.');
  Logger.log('To make it clickable: Insert > Drawing, draw a button, assign script: manualRefresh');
}

// ================================================================
// TEST — run this any time to force a fresh export
// ================================================================
function runNow() { exportWalletToSheet(); }

// ================================================================
// SQLITE PARSER (unchanged from v1)
// ================================================================
function readSQLiteFromDrive() {
  const folder = DriveApp.getFolderById(SQLITE_FOLDER_ID);
  const files  = folder.getFilesByName(SQLITE_FILE_NAME);
  let newest = null, ts = -1;
  while (files.hasNext()) {
    const f = files.next();
    const t = f.getLastUpdated().getTime();
    if (t > ts) { newest = f; ts = t; }
  }
  if (!newest) throw new Error('wallet-database not found in ' + SQLITE_FOLDER_ID);
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
  ['trans', 'category', 'wallet'].forEach(tbl => {
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
  rows.forEach(r => { map[r[keyCol]] = r[valCol]; });
  return map;
}


// ================================================================
// WEB APP — deploy as "Execute as: Me", "Who has access: Anyone"
// Dashboard Refresh calls this URL to rebuild wallet-snapshot.json
// ================================================================
function doGet(e) {
  try {
    exportWalletToSheet();
    const out = { ok: true, at: new Date().toISOString() };
    return ContentService
      .createTextOutput(JSON.stringify(out))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
