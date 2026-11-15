// Static checks on the exported n8n workflows plus the secret scan.
// These do NOT prove the workflows import or run in n8n; that is checked by hand after install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../lib/secret-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N8N = join(ROOT, 'n8n');
const workflows = readdirSync(N8N)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, wf: JSON.parse(readFileSync(join(N8N, f), 'utf8')) }));

test('two workflows exported', () => {
  assert.equal(workflows.length, 2);
});

for (const { f, wf } of workflows) {
  test(`${f}: connections point at real nodes, one trigger, no credentials, inactive`, () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.equal(names.size, wf.nodes.length, 'node names must be unique');
    for (const [from, out] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `unknown source ${from}`);
      for (const branch of out.main) for (const c of branch) assert.ok(names.has(c.node), `unknown target ${c.node}`);
    }
    assert.equal(wf.nodes.filter((n) => /Trigger$/i.test(n.type)).length, 1);
    assert.ok(wf.nodes.every((n) => !n.credentials), 'credentials must not be exported');
    assert.equal(wf.active, false);
    assert.match(wf.name, /demo data/);
  });

  test(`${f}: every Web App call uses the query-auth credential and a placeholder URL`, () => {
    for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest')) {
      assert.equal(n.parameters.url, 'REPLACE_WITH_WEBAPP_URL');
      assert.equal(n.parameters.genericAuthType, 'httpQueryAuth');
      assert.doesNotMatch(n.parameters.jsonBody, /token/i, 'token must come from the credential, not the body');
    }
  });

  test(`${f}: every action called exists in the Web App router`, () => {
    const code = readFileSync(join(ROOT, 'apps-script', 'Code.js'), 'utf8');
    for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest')) {
      const action = n.parameters.jsonBody.match(/action: '(\w+)'/)[1];
      assert.match(code, new RegExp(`case '${action}':`), action);
    }
  });
}

test('secret scan finds nothing in files that would be committed', () => {
  const r = scan();
  assert.deepEqual(r.findings, []);
});

test('secret scan catches a planted key and a real-looking deployment URL', () => {
  const fake = 'AIza' + 'x'.repeat(35);
  const re = /AIza[0-9A-Za-z_-]{35}/;
  assert.ok(re.test(fake));
  const url = 'https://script.google.com/macros/s/' + 'A'.repeat(40) + '/exec';
  assert.ok(/script\.google\.com\/macros\/s\/(?!YOUR_DEPLOYMENT_ID)[A-Za-z0-9_-]{20,}/.test(url));
});
