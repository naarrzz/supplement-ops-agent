import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from '../lib/load-core.mjs';
import { buildLocalStore } from '../lib/local-store.mjs';
import { buildGenerated, GENERATED_PATH } from '../lib/build-generated.mjs';

const { OpsAgents } = loadCore();
const plain = (x) => JSON.parse(JSON.stringify(x));
const NOW = '2026-11-15T09:00:00.000Z';

// A scripted stand-in for Gemini. Each call gets the real request; the script decides the reply.
function fakeModel(script) {
  const requests = [];
  const call = (req) => {
    requests.push(plain(req));
    const reply = script(plain(req), requests.length);
    return {
      candidates: [{ content: { role: 'model', parts: reply } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    };
  };
  return { call, requests };
}
const isFinal = (req) => req.generationConfig.responseMimeType === 'application/json';
const toolResults = (req) =>
  req.contents.flatMap((c) => c.parts).filter((p) => p.functionResponse).map((p) => p.functionResponse);

test('Generated.js is up to date with tools/ and prompts/', () => {
  assert.equal(readFileSync(GENERATED_PATH, 'utf8'), buildGenerated(), 'run npm run build');
});

test('JSON Schema is converted to Gemini schema (uppercase types, unsupported keys dropped)', () => {
  const g = plain(OpsAgents.toGeminiSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'integer', minimum: 1 } }, required: ['a'] }));
  assert.deepEqual(g, { type: 'OBJECT', properties: { a: { type: 'INTEGER', minimum: 1 } }, required: ['a'] });
});

test('analyst: tool calls hit real data, output is checked, guardrails flag a bad quantity', () => {
  const store = buildLocalStore({ now: NOW });
  const m = fakeModel((req, n) => {
    if (isFinal(req)) {
      const low = toolResults(req).find((r) => r.name === 'list_low_cover').response.result;
      const first = low.items[0];
      return [{ text: JSON.stringify({
        as_of: low.as_of,
        suggestions: [
          { sku: first.sku, qty: first.baseline_order_qty, reason: `Only ${first.days_of_cover} days of cover`, confidence: 0.85 },
          { sku: low.items[1].sku, qty: low.items[1].baseline_order_qty * 10, reason: 'overshoot', confidence: 0.4 },
          { sku: 'KN-EL-SACH-OLD', qty: 50, reason: 'should never be suggested', confidence: 0.3 },
        ],
        notes: 'demo',
      }) }];
    }
    if (n === 1) return [{ functionCall: { name: 'list_low_cover', args: { days: 21 } } }];
    if (n === 2) return [
      { functionCall: { name: 'get_sales', args: { sku: 'KN-CRE-MON-500', days: 7 } } },
      { functionCall: { name: 'get_sales', args: { sku: 'KN-CRE-MON-500', days: 28 } } },
    ];
    if (n === 3) return [{ functionCall: { name: 'save_approval', args: { sku: 'KN-CRE-MON-500', qty: 9999, reason: 'x', confidence: 1 } } }];
    return [{ text: 'Done checking.' }];
  });

  const r = plain(OpsAgents.runAgent({ agent: 'analyst', input: 'Weekly reorder check', data: store.data, callModel: m.call }));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.trace.map((t) => t.tool), ['list_low_cover', 'get_sales', 'get_sales', 'save_approval']);
  // The analyst may not write: save_approval is refused and nothing is saved.
  assert.equal(r.trace[3].ok, false);
  assert.equal(store.data.approvals.length, 0);
  // Tool declarations sent to the model are the analyst's read-only set.
  const declared = m.requests[0].tools[0].functionDeclarations.map((d) => d.name).sort();
  assert.deepEqual(declared, ['get_lead_time', 'get_sales', 'get_stock', 'list_dead_stock', 'list_low_cover']);
  assert.equal(m.requests.at(-1).generationConfig.responseSchema.type, 'OBJECT');
  assert.equal(r.usage.model_calls, 5);
  assert.equal(r.usage.total_tokens, 600);

  const flags = Object.fromEntries(r.checked.map((c) => [c.sku, c.flags]));
  assert.deepEqual(flags[r.checked[0].sku], []);
  assert.ok(flags[r.checked[1].sku].includes('outside_baseline_range'));
  assert.ok(flags['KN-EL-SACH-OLD'].includes('dead_stock'));

  // Code (not the model) saves Pending approvals, with the flags visible in the reason.
  const saved = plain(OpsAgents.saveSuggestions(r.checked, store.data, NOW));
  assert.equal(saved.filter((s) => s.saved).length, 3);
  assert.equal(store.data.approvals.every((a) => a.status === 'Pending'), true);
  assert.match(store.data.approvals[1].reason, /\[check: outside_baseline_range\]/);
});

test('steward only sees list_rejected and gets real rejected rows', () => {
  const store = buildLocalStore({ now: NOW });
  const m = fakeModel((req, n) => {
    if (isFinal(req)) {
      const rows = toolResults(req)[0].response.result.rows;
      return [{ text: JSON.stringify({
        summary: `${rows.length} rows`,
        items: rows.map((x) => ({ file: x.file, line: x.line, reason_code: x.reason_code, explanation: x.reason, suggested_fix: 'fix', auto_fixable: false })),
      }) }];
    }
    return n === 1 ? [{ functionCall: { name: 'list_rejected', args: { limit: 5 } } }] : [{ text: 'ok' }];
  });
  const r = plain(OpsAgents.runAgent({ agent: 'steward', input: 'Explain new rejected rows', data: store.data, callModel: m.call }));
  assert.equal(r.ok, true);
  assert.equal(r.output.items.length, 5);
  assert.deepEqual(m.requests[0].tools[0].functionDeclarations.map((d) => d.name), ['list_rejected']);
  assert.match(m.requests[0].systemInstruction.parts[0].text, /data steward/);
});

test('writer output renders to a report with the demo label', () => {
  const text = OpsAgents.renderReport({
    title: 'Weekly ops report (DEMO DATA)',
    headline: 'Creatine 500g runs out in 1.3 days.',
    sections: [{ heading: 'Sales', bullets: ['Revenue ₱539,560 (+18.2%)'] }],
    actions: ['Approve the creatine reorder'],
  });
  assert.match(text, /DEMO DATA/);
  assert.match(text, /- Revenue ₱539,560/);
  assert.match(text, /1\. Approve the creatine reorder/);
  assert.match(text, /suggestions until a person approves/);
});

test('bad model output is reported, not trusted', () => {
  const store = buildLocalStore({ now: NOW });
  const notJson = fakeModel(() => [{ text: 'Sure! Here are my thoughts...' }]);
  const r1 = plain(OpsAgents.runAgent({ agent: 'writer', input: 'x', data: store.data, callModel: notJson.call }));
  assert.equal(r1.ok, false);
  assert.match(r1.error, /valid JSON/);

  const wrongShape = fakeModel((req) => (isFinal(req) ? [{ text: JSON.stringify({ as_of: '2026-11-14', suggestions: [{ sku: 'X', qty: 0, reason: 'r', confidence: 3 }] }) }] : [{ text: 'ok' }]));
  const r2 = plain(OpsAgents.runAgent({ agent: 'analyst', input: 'x', data: store.data, callModel: wrongShape.call }));
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.includes('notes is missing')));
  assert.ok(r2.problems.some((p) => p.includes('qty below 1')));
  assert.ok(r2.problems.some((p) => p.includes('confidence above 1')));
});

test('tool loop stops at maxSteps even if the model keeps calling tools', () => {
  const store = buildLocalStore({ now: NOW });
  const m = fakeModel((req) => (isFinal(req) ? [{ text: '{"summary":"s","items":[]}' }] : [{ functionCall: { name: 'list_rejected', args: {} } }]));
  const r = plain(OpsAgents.runAgent({ agent: 'steward', input: 'x', data: store.data, callModel: m.call, maxSteps: 3 }));
  assert.equal(r.steps, 3);
  assert.equal(r.ok, true);
});
