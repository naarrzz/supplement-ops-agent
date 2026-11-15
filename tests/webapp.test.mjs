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
  for (const f of ['Sheets.js', 'Gemini.js', 'Code.js']) vm.runInContext(readFileSync(join(ROOT, 'apps-script', f), 'utf8'), ctx, { filename: f });
  return ctx;
}

const post = (ctx, body, query = {}) =>
  JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: query }).text);

test('all Apps Script files parse and define the entry points', () => {
  const ctx = makeAppsScript({ OPS_TOKEN: TOKEN });
  for (const fn of ['doGet', 'doPost', 'onOpen', 'setup', 'processInbox', 'runSteward', 'runWeekly', 'installTriggers', 'onEdit', 'callGemini_']) {
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
