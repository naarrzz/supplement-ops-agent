// Runs the BigQuery SQL in sql/ on DuckDB (via lib/bq-to-duckdb.mjs) against the same demo data,
// and checks the answers match the tested JavaScript tools. Two independent implementations
// agreeing is the check. This does NOT run on BigQuery itself; that happens during setup.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bqToDuckdb, statements } from '../lib/bq-to-duckdb.mjs';
import { buildLocalStore } from '../lib/local-store.mjs';
import { loadCore } from '../lib/load-core.mjs';
import { DEAD_SKU, TREND_SKU } from '../sample-data/generate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL = join(ROOT, 'sql');
const read = (p) => readFileSync(join(SQL, p), 'utf8');

let duck;
try {
  duck = await import('@duckdb/node-api');
} catch {
  duck = null;
}

const store = buildLocalStore();
const { OpsTools } = loadCore();
let conn;

const q = async (sql) => {
  const r = await conn.runAndReadAll(bqToDuckdb(sql));
  return r.getRowObjectsJson().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])),
  );
};

const lit = (v) => (v === null || v === undefined || v === '' ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

async function insert(table, cols, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500).map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(',\n');
    await conn.run(`INSERT INTO ops_demo.${table} (${cols.join(', ')}) VALUES ${values}`);
  }
}

before(async () => {
  if (!duck) return;
  const db = await duck.DuckDBInstance.create(':memory:');
  conn = await db.connect();
  for (const s of statements(read('00_tables.sql'))) await conn.run(bqToDuckdb(s));
  const d = store.data;
  await insert('products', ['sku', 'name', 'category', 'price', 'unit_cost', 'reorder_point', 'lead_time_days'], d.products);
  await insert('orders', ['order_id', 'order_date', 'channel', 'sku', 'quantity', 'unit_price', 'revenue', 'cost', 'source_file', 'source_line', 'notes'], d.orders);
  await insert('inventory', ['snapshot_date', 'location', 'sku', 'on_hand', 'source_file', 'notes'], d.inventory);
  await insert('rejected_rows', ['run_id', 'file', 'line', 'reason_code', 'reason', 'all_codes', 'raw'], d.rejected);
  for (const s of statements(read('01_views.sql'))) await conn.run(bqToDuckdb(s));
});

const t = (name, fn) => test(name, { skip: duck ? false : 'npm install (dev) to get @duckdb/node-api' }, fn);

t('row counts loaded', async () => {
  const [r] = await q('SELECT (SELECT COUNT(*) FROM ops_demo.orders) AS o, (SELECT COUNT(*) FROM ops_demo.inventory) AS i');
  assert.equal(r.o, store.data.orders.length);
  assert.equal(r.i, store.data.inventory.length);
});

t('v_sku_cover matches the JavaScript cover table SKU by SKU', async () => {
  const sql = await q('SELECT * FROM ops_demo.v_sku_cover ORDER BY sku');
  const js = JSON.parse(JSON.stringify(OpsTools.coverTable(store.data)));
  const bySku = Object.fromEntries(js.map((r) => [r.sku, r]));
  assert.equal(sql.length, 25);
  for (const r of sql) {
    const j = bySku[r.sku];
    assert.equal(r.as_of, j.as_of);
    assert.equal(r.on_hand, j.on_hand, r.sku);
    assert.equal(r.avg_daily_units_28d, j.avg_daily_units_28d, r.sku);
    assert.equal(r.days_of_cover ?? '', j.days_of_cover, r.sku);
    assert.equal(r.status, j.status, r.sku);
    assert.equal(r.stock_value_at_cost, j.stock_value_at_cost, r.sku);
  }
});

t('reorder_shortlist.sql gives the same SKUs and baseline quantities as list_low_cover', async () => {
  const sql = await q(read('analysis/reorder_shortlist.sql'));
  const tool = store.run('list_low_cover', { days: 21 }).items;
  assert.deepEqual(
    sql.map((r) => [r.sku, r.baseline_order_qty]),
    tool.map((i) => [i.sku, i.baseline_order_qty]),
  );
});

t('v_weekly_kpis this week and last week match get_week_summary', async () => {
  const rows = await q('SELECT * FROM ops_demo.v_weekly_kpis ORDER BY weeks_ago');
  const s = store.run('get_week_summary', {});
  assert.equal(rows[0].week_start, s.period.from);
  assert.equal(rows[0].week_end, s.period.to);
  assert.equal(rows[0].revenue, s.revenue);
  assert.equal(rows[1].revenue, s.revenue_prev_week);
  assert.equal(rows[0].revenue_wow_pct, s.revenue_change_pct);
  assert.equal(rows[0].gross_margin_pct, s.gross_margin_pct);
  assert.equal(rows[0].orders, s.orders);
});

t('v_data_quality matches list_rejected', async () => {
  const rows = await q('SELECT * FROM ops_demo.v_data_quality');
  const js = store.run('list_rejected', {}).by_reason;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.reason_code, r.rows_rejected])), js);
});

t('v_margin_by_category shares add up to 100%', async () => {
  const rows = await q('SELECT * FROM ops_demo.v_margin_by_category');
  assert.equal(rows.length, 5);
  const share = rows.reduce((a, r) => a + r.revenue_share_pct, 0);
  assert.ok(Math.abs(share - 100) < 0.3, share);
});

t('sku_trends.sql finds the trending SKU on top and no trend for dead stock', async () => {
  const rows = await q(read('analysis/sku_trends.sql'));
  assert.equal(rows[0].sku, TREND_SKU);
  assert.ok(rows[0].trend_pct_per_week > 0);
  const dead = rows.find((r) => r.sku === DEAD_SKU);
  assert.equal(dead.trend_pct_per_week, null);
  assert.equal(rows.at(-1).sku, DEAD_SKU); // NULLS LAST
});

t('payday_effect.sql shows paydays above other days', async () => {
  const rows = await q(read('analysis/payday_effect.sql'));
  const pay = rows.find((r) => r.day_type.startsWith('Payday'));
  assert.ok(pay.uplift_vs_other_days_pct > 20, JSON.stringify(rows));
});

t('channel_mix.sql shares add up to 100% in both periods', async () => {
  const rows = await q(read('analysis/channel_mix.sql'));
  assert.equal(rows.length, 5);
  for (const k of ['share_first_4w_pct', 'share_last_4w_pct']) {
    const sum = rows.reduce((a, r) => a + r[k], 0);
    assert.ok(Math.abs(sum - 100) < 0.3, `${k} ${sum}`);
  }
});

test('every .sql file is covered by a test above', () => {
  const files = ['00_tables.sql', '01_views.sql', ...readdirSync(join(SQL, 'analysis')).map((f) => `analysis/${f}`)];
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const f of files) assert.ok(self.includes(f), `${f} has no test`);
});
