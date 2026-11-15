#!/usr/bin/env node
// DEMO DATA ONLY. "Kalye Nutrition" is a fictional brand. Every number here is synthetic.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRAND = 'Kalye Nutrition';
export const DEMO_LABEL = 'DEMO DATA. Fictional brand "Kalye Nutrition", synthetic numbers, not real sales.';
export const START_UTC = Date.UTC(2026, 7, 17); // 2026-08-17
export const DAYS = 90;
export const BATCH_DAYS = 7;
export const DEAD_SKU = 'KN-EL-SACH-OLD';
export const TREND_SKU = 'KN-CRE-MON-500';
export const LOCATIONS = ['warehouse', 'store_a', 'store_b'];
export const ERROR_TYPES = [
  'duplicate_order_id',
  'unknown_sku',
  'negative_quantity',
  'bad_date',
  'price_as_text',
  'missing_channel',
];

const CHANNELS = [
  ['website', 0.25],
  ['shopee', 0.35],
  ['lazada', 0.2],
  ['store_a', 0.1],
  ['store_b', 0.1],
];
const STORE_CHANNELS = new Set(['store_a', 'store_b']);
const PROMO_FROM = 40; // day index, promo week = days 40..46
const PROMO_TO = 46;

// [sku, name, category, price (PHP), reorder point, supplier lead time (days), popularity weight]
const CATALOG = [
  ['KN-WHY-ISO-CHO-2LB', 'Whey Isolate Chocolate 2lb', 'whey', 3490, 60, 21, 1.6],
  ['KN-WHY-ISO-VAN-2LB', 'Whey Isolate Vanilla 2lb', 'whey', 3490, 50, 21, 1.2],
  ['KN-WHY-CON-CHO-5LB', 'Whey Concentrate Chocolate 5lb', 'whey', 3290, 40, 28, 1.1],
  ['KN-WHY-CON-CKE-2LB', 'Whey Concentrate Cookies 2lb', 'whey', 2190, 45, 28, 1.0],
  ['KN-WHY-ISO-BNA-1LB', 'Whey Isolate Banana 1lb', 'whey', 1890, 35, 21, 0.7],
  ['KN-CRE-MON-300', 'Creatine Monohydrate 300g', 'creatine', 990, 80, 14, 1.5],
  ['KN-CRE-MON-500', 'Creatine Monohydrate 500g', 'creatine', 1390, 60, 14, 1.0],
  ['KN-CRE-HCL-120', 'Creatine HCl 120 capsules', 'creatine', 1290, 30, 21, 0.6],
  ['KN-CRE-MAL-250', 'Creatine Malate 250g', 'creatine', 1190, 25, 21, 0.5],
  ['KN-PRE-BLZ-30', 'Pre-Workout Blaze 30 servings', 'preworkout', 1290, 50, 14, 1.0],
  ['KN-PRE-BLZ-60', 'Pre-Workout Blaze 60 servings', 'preworkout', 2190, 30, 14, 0.6],
  ['KN-PRE-CLM-30', 'Pre-Workout Calm 30 servings', 'preworkout', 1290, 30, 21, 0.5],
  ['KN-PRE-ZRO-30', 'Pre-Workout Zero Stim 30 servings', 'preworkout', 1390, 25, 21, 0.4],
  ['KN-VIT-D3-60', 'Vitamin D3 60 softgels', 'vitamins', 490, 70, 28, 0.9],
  ['KN-VIT-C1K-90', 'Vitamin C 1000mg 90 tablets', 'vitamins', 590, 60, 28, 0.8],
  ['KN-VIT-MLT-60', 'Multivitamin Daily 60 tablets', 'vitamins', 690, 50, 28, 0.7],
  ['KN-VIT-ZNC-60', 'Zinc 25mg 60 tablets', 'vitamins', 390, 40, 28, 0.5],
  ['KN-VIT-OMG-60', 'Omega-3 Fish Oil 60 softgels', 'vitamins', 890, 50, 35, 0.8],
  ['KN-VIT-MG-90', 'Magnesium Glycinate 90 capsules', 'vitamins', 790, 40, 35, 0.6],
  ['KN-EL-LMN-20', 'Electrolyte Lemon 20 sachets', 'electrolytes', 790, 90, 14, 1.4],
  ['KN-EL-ORG-20', 'Electrolyte Orange 20 sachets', 'electrolytes', 790, 70, 14, 0.9],
  ['KN-EL-MNG-20', 'Electrolyte Mango 20 sachets', 'electrolytes', 790, 60, 14, 0.8],
  ['KN-EL-CCN-20', 'Electrolyte Coconut 20 sachets', 'electrolytes', 890, 40, 21, 0.5],
  ['KN-EL-SACH-OLD', 'Electrolyte Berry (old formula) 20 sachets', 'electrolytes', 690, 40, 21, 0],
  ['KN-EL-TBL-30', 'Electrolyte Tablets 30s', 'electrolytes', 790, 35, 21, 0.4],
];

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, weighted) => {
  let r = rand();
  for (const [value, weight] of weighted) {
    r -= weight;
    if (r < 0) return value;
  }
  return weighted[weighted.length - 1][0];
};
const addCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function generateDemo({ seed = 20261115 } = {}) {
  const rand = makeRng(seed);
  const products = CATALOG.map(([sku, name, category, price, reorder_point, lead_time_days, popularity]) => ({
    sku, name, category, price,
    unit_cost: Math.round(price * 0.42),
    reorder_point,
    lead_time_days,
    _popularity: popularity,
  }));

  // 1. Orders: one row per line item, with daily patterns.
  const orders = []; // { day, row }
  const soldUnits = new Map(); // `${day}|${location}|${sku}` -> units
  let seq = 0;
  for (let d = 0; d < DAYS; d++) {
    const date = new Date(START_UTC + d * 86400000);
    const iso = date.toISOString().slice(0, 10);
    const dom = date.getUTCDate();
    const dow = date.getUTCDay();
    const promo = d >= PROMO_FROM && d <= PROMO_TO;
    let mult = 1;
    if (dom === 15 || dom === 30) mult *= 1.8; // payday spikes
    else if (dom === 1 || dom === 16) mult *= 1.4;
    if (dow === 0 || dow === 6) mult *= 1.15;
    if (promo) mult *= 1.6;

    for (const p of products) {
      const trend = p.sku === TREND_SKU ? 1 + (1.5 * d) / (DAYS - 1) : 1;
      const expected = p._popularity * mult * trend;
      if (expected <= 0) continue;
      const events = Math.round(expected * (0.5 + rand()));
      for (let e = 0; e < events; e++) {
        const quantity = 1 + Math.floor(rand() * 3);
        const channel = pick(rand, CHANNELS);
        const unit_price = promo ? Math.round(p.price * 0.9) : p.price;
        const useUsFormat = rand() < 0.2; // tolerated format, validator normalizes it
        const order_date = useUsFormat
          ? `${pad(date.getUTCMonth() + 1)}/${pad(dom)}/${date.getUTCFullYear()}`
          : iso;
        seq++;
        orders.push({
          day: d,
          row: { order_id: `KN-${pad(seq, 6)}`, order_date, channel, sku: p.sku, quantity, unit_price },
        });
        const loc = STORE_CHANNELS.has(channel) ? channel : 'warehouse';
        const key = `${d}|${loc}|${p.sku}`;
        soldUnits.set(key, (soldUnits.get(key) || 0) + quantity);
      }
    }
  }

  // 2. Inventory: daily snapshot per location per SKU.
  const onHand = new Map();
  for (const [i, p] of products.entries()) {
    const upd = p._popularity * 2; // units per day across channels
    if (p.sku === DEAD_SKU) {
      onHand.set(`warehouse|${p.sku}`, 260); // dead stock: sits there, never sells or restocks
      onHand.set(`store_a|${p.sku}`, 0);
      onHand.set(`store_b|${p.sku}`, 0);
      continue;
    }
    onHand.set(`warehouse|${p.sku}`, Math.round(upd * 35) + 5);
    onHand.set(`store_a|${p.sku}`, Math.round(upd * 0.2 * 14) + 2);
    onHand.set(`store_b|${p.sku}`, Math.round(upd * 0.2 * 14) + 2);
  }
  const inventory = [];
  for (let d = 0; d < DAYS; d++) {
    const snapshot_date = new Date(START_UTC + d * 86400000).toISOString().slice(0, 10);
    for (const loc of LOCATIONS) {
      for (const [i, p] of products.entries()) {
        const key = `${loc}|${p.sku}`;
        let v = onHand.get(key) - (soldUnits.get(`${d}|${loc}|${p.sku}`) || 0);
        if (p.sku !== DEAD_SKU) {
          const upd = p._popularity * 2;
          if (loc === 'warehouse' && d % 28 === i % 28) v += Math.round(upd * 28) + 5;
          if (loc !== 'warehouse' && d % 14 === i % 14) v += Math.round(upd * 0.2 * 14) + 2;
        }
        v = Math.max(0, v);
        onHand.set(key, v);
        inventory.push({ snapshot_date, location: loc, sku: p.sku, on_hand: v });
      }
    }
  }

  // 3. Weekly upload batches, with planted errors for the validator.
  const batches = [];
  for (let b = 0; b * BATCH_DAYS < DAYS; b++) {
    const index = b + 1;
    batches.push({
      index,
      file: `demo_orders_batch_${pad(index)}.csv`,
      rows: orders.filter((o) => Math.floor(o.day / BATCH_DAYS) === b).map((o) => ({ ...o.row })),
    });
  }

  const planted = [];
  for (const batch of batches) {
    const rows = batch.rows;
    const taken = new Set();
    for (const type of ERROR_TYPES) {
      let idx = Math.floor(rand() * rows.length);
      if (type === 'duplicate_order_id' && idx === 0) idx = 1;
      while (taken.has(idx)) idx = (idx + 1) % rows.length;
      taken.add(idx);
      const row = rows[idx];
      const rec = { batch: batch.index, file: batch.file, line: idx + 2, type };
      switch (type) {
        case 'duplicate_order_id': {
          const src = Math.floor(rand() * idx); // earlier row, not touched by other errors
          taken.add(src);
          row.order_id = rows[src].order_id;
          Object.assign(rec, { expected: 'rejected', reason: 'DUPLICATE_ORDER_ID', source_line: src + 2 });
          break;
        }
        case 'unknown_sku':
          row.sku = 'KN-XXX-000';
          Object.assign(rec, { expected: 'rejected', reason: 'UNKNOWN_SKU' });
          break;
        case 'negative_quantity':
          row.quantity = -row.quantity;
          Object.assign(rec, { expected: 'rejected', reason: 'BAD_QUANTITY' });
          break;
        case 'bad_date':
          row.order_date = '2026-02-31'; // impossible date
          Object.assign(rec, { expected: 'rejected', reason: 'BAD_DATE' });
          break;
        case 'price_as_text':
          Object.assign(rec, {
            expected: 'kept_normalized',
            reason: 'PRICE_NORMALIZED',
            expected_unit_price: row.unit_price,
          });
          row.unit_price = `₱${addCommas(row.unit_price)}`;
          break;
        case 'missing_channel':
          row.channel = '';
          Object.assign(rec, { expected: 'rejected', reason: 'MISSING_CHANNEL' });
          break;
      }
      planted.push(rec);
    }
  }

  const cleanProducts = products.map(({ _popularity, ...rest }) => rest);
  return { label: DEMO_LABEL, brand: BRAND, products: cleanProducts, batches, inventory, planted };
}

export function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

export function writeDemo(outDir, opts) {
  const demo = generateDemo(opts);
  mkdirSync(outDir, { recursive: true });
  const write = (name, text) => writeFileSync(join(outDir, name), text);
  write(
    'demo_products.csv',
    toCsv(['sku', 'name', 'category', 'price', 'unit_cost', 'reorder_point', 'lead_time_days'], demo.products),
  );
  for (const b of demo.batches) {
    write(b.file, toCsv(['order_id', 'order_date', 'channel', 'sku', 'quantity', 'unit_price'], b.rows));
  }
  write(
    'demo_inventory_snapshots.csv',
    toCsv(['snapshot_date', 'location', 'sku', 'on_hand'], demo.inventory),
  );
  write('demo_planted_errors.json', JSON.stringify({ label: DEMO_LABEL, planted: demo.planted }, null, 2) + '\n');
  return demo;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
  const demo = writeDemo(outDir);
  console.log(`${DEMO_LABEL}`);
  console.log(
    `Wrote ${demo.batches.length} order batches, ${demo.inventory.length} inventory rows, ${demo.planted.length} planted errors to ${outDir}`,
  );
}
