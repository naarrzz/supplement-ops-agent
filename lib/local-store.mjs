// Local stand-in for the Google Sheet: runs every demo CSV in sample-data/out through the
// real validator (same code as Apps Script) and keeps the result in memory.
// Used by the tests and by the MCP server's "local" backend. DEMO DATA only.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './load-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATA_DIR = join(ROOT, 'sample-data', 'out');

function readCsvObjects(OpsCore, path) {
  const [header, ...rows] = OpsCore.parseCsv(readFileSync(path, 'utf8'));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export function buildLocalStore({ dataDir = DEFAULT_DATA_DIR, approvalsFile, now } = {}) {
  const { OpsCore, OpsTools } = loadCore();
  const products = readCsvObjects(OpsCore, join(dataDir, 'demo_products.csv')).map((p) => ({
    ...p,
    price: Number(p.price),
    unit_cost: Number(p.unit_cost),
    reorder_point: Number(p.reorder_point),
    lead_time_days: Number(p.lead_time_days),
  }));
  const data = { products, orders: [], inventory: [], rejected: [], approvals: [], runLog: [] };
  const keys = { orders: {}, inventory: {} };
  const files = readdirSync(dataDir)
    .filter((f) => f.endsWith('.csv') && f !== 'demo_products.csv')
    .sort();
  for (const file of files) {
    const table = OpsCore.parseCsv(readFileSync(join(dataDir, file), 'utf8'));
    const kind = OpsCore.detectKind(table[0]);
    const r = OpsCore.validateBatch({
      fileName: file,
      table,
      products,
      existingKeys: kind ? keys[kind] : {},
      now,
    });
    if (r.kind) Object.assign(keys[r.kind], r.newKeys);
    if (r.kind === 'orders') data.orders.push(...r.clean);
    if (r.kind === 'inventory') data.inventory.push(...r.clean);
    data.rejected.push(...r.rejected);
    data.runLog.push(r.log);
  }
  if (approvalsFile && existsSync(approvalsFile)) {
    data.approvals = JSON.parse(readFileSync(approvalsFile, 'utf8'));
  }
  const saveApprovals = () => {
    if (!approvalsFile) return;
    mkdirSync(dirname(approvalsFile), { recursive: true });
    writeFileSync(approvalsFile, JSON.stringify(data.approvals, null, 2) + '\n');
  };
  return {
    data,
    // Results cross the vm boundary as JSON so callers get plain objects.
    run(name, args) {
      const out = JSON.parse(JSON.stringify(OpsTools.run(name, args, data)));
      if (name === 'save_approval' && out.saved) saveApprovals();
      return out;
    },
  };
}
