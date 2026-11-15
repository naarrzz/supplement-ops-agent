import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalStore } from '../lib/local-store.mjs';
import { DEAD_SKU, TREND_SKU, DAYS } from '../sample-data/generate.mjs';

const NOW = '2026-11-15T09:00:00.000Z';
const store = buildLocalStore({ now: NOW });
const { data } = store;

test('local store loads every demo file through the validator', () => {
  assert.equal(data.products.length, 25);
  assert.equal(data.inventory.length, DAYS * 3 * 25);
  assert.equal(data.rejected.length, 13 * 5); // 5 rejected types per batch, price-as-text is fixed
  assert.equal(data.runLog.length, 14); // 13 order batches + 1 inventory file
  assert.ok(data.runLog.every((l) => l.status === 'ok'));
});

test('get_stock sums the latest snapshot across locations', () => {
  const r = store.run('get_stock', { sku: 'kn-why-iso-cho-2lb' });
  assert.equal(r.sku, 'KN-WHY-ISO-CHO-2LB');
  assert.equal(r.as_of, '2026-11-14');
  const sum = Object.values(r.by_location).reduce((a, b) => a + b, 0);
  assert.equal(r.on_hand_total, sum);
  const manual = data.inventory
    .filter((x) => x.sku === 'KN-WHY-ISO-CHO-2LB' && x.snapshot_date === '2026-11-14')
    .reduce((a, x) => a + x.on_hand, 0);
  assert.equal(r.on_hand_total, manual);
});

test('get_sales matches a manual count and splits by channel', () => {
  const r = store.run('get_sales', { sku: TREND_SKU, days: 14 });
  assert.equal(r.from, '2026-11-01');
  assert.equal(r.to, '2026-11-14');
  const manual = data.orders
    .filter((o) => o.sku === TREND_SKU && o.order_date >= '2026-11-01')
    .reduce((a, o) => a + o.quantity, 0);
  assert.equal(r.units, manual);
  assert.equal(Object.values(r.by_channel).reduce((a, c) => a + c.units, 0), manual);
});

test('trending SKU sells faster now than two months ago', () => {
  const recent = store.run('get_sales', { sku: TREND_SKU, days: 28 }).avg_daily_units;
  const all = store.run('get_sales', { sku: TREND_SKU, days: 90 }).avg_daily_units;
  assert.ok(recent > all, `recent ${recent} vs 90-day ${all}`);
});

test('dead stock shows up in list_dead_stock and never in list_low_cover', () => {
  const dead = store.run('list_dead_stock', {});
  assert.deepEqual(dead.items.map((i) => i.sku), [DEAD_SKU]);
  assert.equal(dead.items[0].on_hand, 260);
  const low = store.run('list_low_cover', { days: 365 });
  assert.ok(!low.items.some((i) => i.sku === DEAD_SKU));
});

test('list_low_cover is sorted, math is consistent, and the threshold filters', () => {
  const r = store.run('list_low_cover', { days: 21 });
  for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].days_of_cover <= r.items[i].days_of_cover);
  for (const it of r.items) {
    assert.ok(it.days_of_cover < 21 || it.on_hand <= it.reorder_point);
    const expectedCover = Math.round((it.on_hand / it.avg_daily_units) * 10) / 10;
    assert.ok(Math.abs(expectedCover - it.days_of_cover) <= 0.2);
    assert.equal(it.baseline_order_qty % 5, 0);
  }
  const wider = store.run('list_low_cover', { days: 60 });
  assert.ok(wider.count >= r.count);
});

test('list_rejected groups reasons', () => {
  const r = store.run('list_rejected', { limit: 5 });
  assert.equal(r.total, 65);
  assert.equal(r.rows.length, 5);
  for (const code of ['DUPLICATE_ORDER_ID', 'UNKNOWN_SKU', 'BAD_QUANTITY', 'BAD_DATE', 'MISSING_CHANNEL']) {
    assert.equal(r.by_reason[code], 13, code);
  }
  const one = store.run('list_rejected', { file: 'demo_orders_batch_13.csv' });
  assert.equal(one.total, 5);
});

test('get_week_summary compares this week with last week', () => {
  const r = store.run('get_week_summary', {});
  assert.deepEqual(r.period, { from: '2026-11-08', to: '2026-11-14' });
  assert.equal(r.label, 'DEMO DATA');
  assert.ok(r.revenue > 0 && r.revenue_prev_week > 0);
  assert.equal(r.top_skus.length, 5);
  assert.equal(r.dead_stock[0].sku, DEAD_SKU);
  assert.equal(r.data_quality.rejected_rows_total, 65);
});

test('save_approval stores a Pending row and refuses a second pending one for the same SKU', () => {
  const local = buildLocalStore({ now: NOW });
  const a = local.run('save_approval', { sku: TREND_SKU, qty: 40, reason: 'test', confidence: 0.8, now: NOW });
  assert.equal(a.saved, true);
  assert.equal(a.approval.status, 'Pending');
  const b = local.run('save_approval', { sku: TREND_SKU, qty: 10, reason: 'again', confidence: 0.5, now: NOW });
  assert.equal(b.duplicate, true);
  assert.equal(local.data.approvals.length, 1);
});

test('bad input comes back as an error the agent can read, not a crash', () => {
  assert.match(store.run('get_stock', { sku: 'NOPE' }).error, /Unknown SKU/);
  assert.match(store.run('drop_tables', {}).error, /Unknown tool/);
  assert.match(store.run('save_approval', { sku: TREND_SKU, qty: -1, reason: 'x', confidence: 0.5 }).error, /qty/);
});
