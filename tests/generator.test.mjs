import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDemo,
  DAYS,
  DEAD_SKU,
  TREND_SKU,
  ERROR_TYPES,
  BATCH_DAYS,
} from '../sample-data/generate.mjs';

const demo = generateDemo();
const allRows = demo.batches.flatMap((b) => b.rows);

test('same seed gives identical output', () => {
  assert.deepEqual(generateDemo(), demo);
});

test('catalog has 25 SKUs with unique codes', () => {
  assert.equal(demo.products.length, 25);
  assert.equal(new Set(demo.products.map((p) => p.sku)).size, 25);
});

test('demo label is on the output', () => {
  assert.match(demo.label, /DEMO DATA/);
});

test('inventory has one snapshot per day, location and SKU', () => {
  assert.equal(demo.inventory.length, DAYS * 3 * 25);
  assert.ok(demo.inventory.every((r) => r.on_hand >= 0));
});

test('weekly batches cover all days', () => {
  assert.equal(demo.batches.length, Math.ceil(DAYS / BATCH_DAYS));
});

test('every batch has one planted error of each type', () => {
  assert.equal(demo.planted.length, demo.batches.length * ERROR_TYPES.length);
  for (const b of demo.batches) {
    const types = demo.planted.filter((p) => p.batch === b.index).map((p) => p.type).sort();
    assert.deepEqual(types, [...ERROR_TYPES].sort());
  }
});

test('planted errors are really in the rows they point at', () => {
  for (const p of demo.planted) {
    const batch = demo.batches.find((b) => b.index === p.batch);
    const row = batch.rows[p.line - 2];
    switch (p.type) {
      case 'duplicate_order_id':
        assert.equal(row.order_id, batch.rows[p.source_line - 2].order_id);
        break;
      case 'unknown_sku':
        assert.equal(row.sku, 'KN-XXX-000');
        break;
      case 'negative_quantity':
        assert.ok(row.quantity < 0);
        break;
      case 'bad_date':
        assert.equal(row.order_date, '2026-02-31');
        break;
      case 'price_as_text':
        assert.match(row.unit_price, /^₱\d{1,3}(,\d{3})*$/);
        break;
      case 'missing_channel':
        assert.equal(row.channel, '');
        break;
      default:
        assert.fail(`unknown type ${p.type}`);
    }
  }
});

test('dead stock sells nothing', () => {
  assert.equal(allRows.filter((r) => r.sku === DEAD_SKU).length, 0);
});

test('trending SKU sells more in the second half than the first', () => {
  const half = (d) => allRows.filter((r) => r.sku === TREND_SKU && r.quantity > 0);
  const rows = half();
  // batch index 1..13 maps to days; first 6 batches = first ~half of the period
  const firstHalf = demo.batches.slice(0, 6).flatMap((b) => b.rows).filter((r) => r.sku === TREND_SKU && r.quantity > 0);
  const secondHalf = demo.batches.slice(6).flatMap((b) => b.rows).filter((r) => r.sku === TREND_SKU && r.quantity > 0);
  const sum = (xs) => xs.reduce((n, r) => n + r.quantity, 0);
  assert.ok(sum(secondHalf) > sum(firstHalf), `first ${sum(firstHalf)} vs second ${sum(secondHalf)}`);
  assert.ok(rows.length > 0);
});

test('about 20% of clean rows use the tolerated US date format', () => {
  const us = allRows.filter((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r.order_date)).length;
  const ratio = us / allRows.length;
  assert.ok(ratio > 0.1 && ratio < 0.3, `ratio ${ratio}`);
});
