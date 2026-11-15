// Starts the real MCP server over stdio with the official client, lists tools and calls each one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, '..', 'server.ts')],
  env: { ...process.env, OPS_BACKEND: 'local' },
  stderr: 'pipe',
});
const client = new Client({ name: 'smoke-test', version: '0.0.1' });
await client.connect(transport);
after(() => client.close());

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError, body: JSON.parse(r.content[0].text) };
};

test('lists all 8 tools with schemas and read-only hints', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'get_lead_time', 'get_sales', 'get_stock', 'get_week_summary',
    'list_dead_stock', 'list_low_cover', 'list_rejected', 'save_approval',
  ]);
  const save = tools.find((t) => t.name === 'save_approval');
  assert.equal(save.annotations.readOnlyHint, false);
  assert.deepEqual(save.inputSchema.required, ['sku', 'qty', 'reason', 'confidence']);
});

test('"Ano ang mauubos in 2 weeks?" path: list_low_cover with 14 days', async () => {
  const { isError, body } = await call('list_low_cover', { days: 14 });
  assert.equal(isError, false);
  assert.match(body.source, /demo data/);
  assert.ok(body.count >= 1);
  assert.equal(body.items[0].sku, 'KN-CRE-MON-500');
});

test('every read tool answers', async () => {
  for (const [name, args] of [
    ['get_stock', { sku: 'KN-EL-LMN-20' }],
    ['get_sales', { sku: 'KN-EL-LMN-20', days: 7 }],
    ['get_lead_time', { sku: 'KN-EL-LMN-20' }],
    ['list_dead_stock', {}],
    ['list_rejected', { limit: 3 }],
    ['get_week_summary', {}],
  ]) {
    const r = await call(name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.body)}`);
  }
});

test('errors come back as isError with a readable message', async () => {
  const r = await call('get_stock', { sku: 'NOPE' });
  assert.equal(r.isError, true);
  assert.match(r.body.error, /Unknown SKU/);
});
