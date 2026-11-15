import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDemo, toCsv } from '../sample-data/generate.mjs';
import { loadCore } from '../lib/load-core.mjs';

const { OpsCore } = loadCore();
// Objects from the vm context come from another realm; copy them before deepEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));
const demo = generateDemo();
const ORDER_COLS = ['order_id', 'order_date', 'channel', 'sku', 'quantity', 'unit_price'];
const NOW = '2026-11-15T09:00:00.000Z';

// Run every batch through CSV text -> parseCsv -> validateBatch, the same path as a real upload.
const results = [];
let existing = {};
for (const b of demo.batches) {
  const table = OpsCore.parseCsv(toCsv(ORDER_COLS, b.rows));
  const r = OpsCore.validateBatch({ fileName: b.file, table, products: demo.products, existingKeys: existing, now: NOW });
  existing = { ...existing, ...r.newKeys };
  results.push({ batch: b, r });
}

test('every batch is detected as orders and logged', () => {
  for (const { batch, r } of results) {
    assert.equal(r.kind, 'orders');
    assert.equal(r.log.status, 'ok');
    assert.equal(r.log.rows_in, batch.rows.length);
    assert.equal(r.log.rows_kept + r.log.rows_rejected, r.log.rows_in);
  }
});

test('every planted error is caught with the right reason', () => {
  for (const p of demo.planted) {
    const { r } = results[p.batch - 1];
    if (p.expected === 'rejected') {
      const hit = r.rejected.find((x) => x.line === p.line);
      assert.ok(hit, `batch ${p.batch} line ${p.line} (${p.type}) was not rejected`);
      assert.equal(hit.reason_code, p.reason);
      assert.ok(hit.reason.length > 10);
    } else {
      const kept = r.clean.find((x) => x.source_line === p.line);
      assert.ok(kept, `batch ${p.batch} line ${p.line} (${p.type}) should be kept`);
      assert.equal(kept.unit_price, p.expected_unit_price);
      assert.match(kept.notes, /PRICE_NORMALIZED/);
    }
  }
});

test('no clean row is rejected (rejections equal planted rejections)', () => {
  const plantedRejects = demo.planted.filter((p) => p.expected === 'rejected').length;
  const totalRejected = results.reduce((n, x) => n + x.r.rejected.length, 0);
  assert.equal(totalRejected, plantedRejects);
});

test('kept rows have ISO dates, positive quantities and numeric prices', () => {
  for (const { r } of results) {
    for (const row of r.clean) {
      assert.match(row.order_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isInteger(row.quantity) && row.quantity > 0);
      assert.equal(typeof row.unit_price, 'number');
      assert.equal(row.revenue, row.quantity * row.unit_price);
    }
  }
});

test('re-uploading the same file rejects every row as duplicate', () => {
  const b = demo.batches[0];
  const table = OpsCore.parseCsv(toCsv(ORDER_COLS, b.rows));
  const r = OpsCore.validateBatch({ fileName: 'again.csv', table, products: demo.products, existingKeys: existing, now: NOW });
  assert.equal(r.clean.length, 0);
  assert.equal(r.rejected.length, b.rows.length);
  // every row that was kept the first time, plus the planted duplicate, is now a duplicate
  const dupes = r.rejected.filter((x) => x.reason_code === 'DUPLICATE_ORDER_ID').length;
  assert.equal(dupes, results[0].r.clean.length + 1);
});

test('a file with the wrong columns fails as a whole', () => {
  const table = OpsCore.parseCsv('id,when,what\n1,2026-11-01,x\n');
  const r = OpsCore.validateBatch({ fileName: 'bad.csv', table, products: demo.products, now: NOW });
  assert.equal(r.kind, null);
  assert.equal(r.log.status, 'failed');
  assert.equal(r.rejected[0].reason_code, 'BAD_SCHEMA');
});

test('inventory snapshots validate, and bad ones are caught', () => {
  const rows = demo.inventory.slice(0, 75).map((x) => ({ ...x }));
  rows[3].on_hand = -4;
  rows[7].location = 'store_z';
  rows[9].snapshot_date = 'Aug 17, 2026'; // tolerated format
  rows.push({ ...rows[0] }); // duplicate snapshot
  const table = OpsCore.parseCsv(toCsv(['snapshot_date', 'location', 'sku', 'on_hand'], rows));
  const r = OpsCore.validateBatch({ fileName: 'inv.csv', table, products: demo.products, now: NOW });
  assert.equal(r.kind, 'inventory');
  const codes = plain(r.rejected.map((x) => x.reason_code)).sort();
  assert.deepEqual(codes, ['BAD_STOCK', 'DUPLICATE_SNAPSHOT', 'UNKNOWN_LOCATION']);
  assert.equal(r.clean.find((x) => x.notes.includes('DATE_NORMALIZED')).snapshot_date, '2026-08-17');
});

test('normalizers handle the formats people actually type', () => {
  assert.deepEqual(plain(OpsCore.normalizeMoney('₱1,299')),{ value: 1299, changed: true });
  assert.deepEqual(plain(OpsCore.normalizeMoney('PHP 1,299.50')), { value: 1299.5, changed: true });
  assert.equal(OpsCore.normalizeMoney('free'), null);
  assert.equal(OpsCore.normalizeDate('2026-02-31'), null);
  assert.equal(OpsCore.normalizeDate('11/14/2026').value, '2026-11-14');
  assert.equal(OpsCore.normalizeDate('Nov 14, 2026').value, '2026-11-14');
  assert.equal(OpsCore.normalizeDate('14/11/2026'), null); // ambiguous day-first is not guessed
});
