// Loads the Apps Script entry files in a vm with small fakes for the Google services they touch,
// to check the Web App's token gate and routing. Sheets, Drive, Docs, Gmail and Gemini calls are
// NOT exercised here; they run only after deploying to Google (see docs/setup.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildLocalStore } from '../lib/local-store.mjs';
import { CORE_FILES } from '../lib/load-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'demo-token-0123456789abcdef-xyz';

function makeAppsScript(props) {
  const ctx = vm.createContext({
    console,
    JSON,
    Math,
    Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v) }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  });
  for (const f of CORE_FILES) vm.runInContext(readFileSync(join(ROOT, 'apps-script', 'core', f), 'utf8'), ctx, { filename: f });
  for (const f of ['Sheets.js', 'Gemini.js', 'BigQueryLoad.js', 'Code.js']) vm.runInContext(readFileSync(join(ROOT, 'apps-script', f), 'utf8'), ctx, { filename: f });
  return ctx;
}

const post = (ctx, body, query = {}) =>
  JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: query }).text);

test('all Apps Script files parse and define the entry points', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN });
  for (const fn of ['doGet', 'doPost', 'onOpen', 'setup', 'processInbox', 'runSteward', 'runWeekly', 'installTriggers', 'onEdit', 'callGemini_', 'exportToBigQuery', 'menuSteward', 'menuWeekly', 'menuBigQuery', 'pickGeminiModel_', 'menuTestGemini']) {
    assert.equal(typeof ctx[fn], 'function', fn);
  }
});

test('Web App refuses requests without the right token, and fails closed if none is set', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN });
  assert.deepEqual(post(ctx, { action: 'tool', name: 'get_stock' }), { error: 'unauthorized' });
  assert.deepEqual(post(ctx, { token: TOKEN.slice(0, -1) + 'Q', action: 'tool' }), { error: 'unauthorized' });
  const noToken = makeAppsScript({});
  assert.deepEqual(post(noToken, { token: '', action: 'tool' }), { error: 'unauthorized' });
  const weak = makeAppsScript({ OPS_TOKEN: 'short' });
  assert.deepEqual(post(weak, { token: 'short', action: 'tool' }), { error: 'unauthorized' });
});

test('with the token (body or ?token=), tool calls return real numbers', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN });
  const store = buildLocalStore();
  ctx.loadData_ = () => store.data; // stand-in for reading the Sheet
  const a = post(ctx, { token: TOKEN, action: 'tool', name: 'list_low_cover', args: { days: 21 } });
  assert.equal(a.items[0].sku, 'KN-CRE-MON-500');
  const b = post(ctx, { action: 'tool', name: 'get_stock', args: { sku: 'KN-EL-LMN-20' } }, { token: TOKEN });
  assert.equal(b.sku, 'KN-EL-LMN-20');
  assert.match(post(ctx, { token: TOKEN, action: 'tool', name: 'rm_rf' }).error, /Unknown tool/);
  assert.match(post(ctx, { token: TOKEN, action: 'launch_rockets' }).error, /Unknown action/);
});

test('Web App does not crash on bad JSON', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN });
  const r = JSON.parse(ctx.doPost({ postData: { contents: '{not json' }, parameter: {} }).text);
  assert.match(r.error, /JSON/);
});

test('processInbox loads the product list first and holds orders until products exist', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN, OPS_INBOX_FOLDER_ID: 'inbox' });
  const file = (name, text) => ({ getName: () => name, getBlob: () => ({ getDataAsString: () => text }) });
  const files = [
    file('demo_orders_batch_01.csv', 'order_id,order_date,channel,sku,quantity,unit_price\nA1,2026-11-01,website,KN-1,1,100\n'),
    file('demo_products.csv', 'sku,name,category,price,unit_cost,reorder_point,lead_time_days\nKN-1,Test,whey,100,40,5,14\n'),
  ];
  let products = [];
  const calls = [];
  ctx.Utilities = { parseCsv: (t) => t.trim().split('\n').map((l) => l.split(',')) };
  ctx.inboxFolder_ = () => {
    let i = 0;
    return { getId: () => 'inbox', getFiles: () => ({ hasNext: () => i < files.length, next: () => files[i++] }) };
  };
  ctx.readObjects_ = () => [];
  ctx.loadProducts_ = () => products;
  ctx.replaceObjects_ = (k, rows) => { calls.push('replace:' + k); if (k === 'products') products = rows.map((r) => ({ ...r, unit_cost: Number(r.unit_cost) })); };
  ctx.appendObjects_ = (k, rows) => calls.push('append:' + k + ':' + rows.length);
  ctx.existingKeys_ = () => ({});
  ctx.refreshCover_ = () => calls.push('refresh');
  ctx.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ({ toast() {} }) };
  const out = JSON.parse(JSON.stringify(ctx.processInbox()));
  assert.deepEqual(out.map((r) => r.file), ['demo_products.csv', 'demo_orders_batch_01.csv']);
  assert.equal(out[1].log.rows_kept, 1);
  assert.equal(calls.filter((c) => c === 'refresh').length, 1, 'cover refreshed once at the end');

  products = [];
  const held = JSON.parse(JSON.stringify(ctx.processFile_(files[0])));
  assert.equal(held.skipped, true);
  assert.match(held.error, /product list/);
});

test('runSteward works in batches, saves each batch, and stops when nothing is left', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN });
  const store = buildLocalStore();
  ctx.loadData_ = () => store.data;
  const writes = [];
  ctx.appendObjects_ = () => 0;
  ctx.sheet_ = () => ({
    getDataRange: () => ({ getValues: () => [['file', 'line', 'explanation', 'likely_cause', 'suggested_fix', 'auto_fixable'], ...store.data.rejected.map((r) => [r.file, r.line, '', '', '', ''])] }),
    getRange: () => ({ setValues: (v) => writes.push(v) }),
  });
  let calls = 0;
  ctx.callGemini_ = (req) => {
    calls++;
    const results = req.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse);
    if (req.generationConfig.responseMimeType) {
      const rows = results.at(-1).functionResponse.response.result.rows;
      const items = rows.map((r) => ({ file: r.file, line: r.line, reason_code: r.reason_code, explanation: 'x', suggested_fix: 'fix', auto_fixable: false }));
      return { candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'batch', items }) }] } }] };
    }
    const part = results.length ? { text: 'ok' } : { functionCall: { name: 'list_rejected', args: { only_unexplained: true, limit: 15 } } };
    return { candidates: [{ content: { parts: [part] } }] };
  };
  const r = JSON.parse(JSON.stringify(ctx.runSteward()));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.explained, 65);
  assert.equal(r.remaining, 0);
  assert.equal(r.batches, 5); // 15+15+15+15+5
  assert.equal(writes.length, 65);
  assert.equal(calls, 15); // per batch: tool call, then text, then final JSON
  assert.equal(typeof r.usage.model_seconds, 'number');
});
