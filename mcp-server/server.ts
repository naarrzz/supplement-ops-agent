// Ask ops: an MCP server that exposes the supplement ops tools to any MCP client
// (Claude Desktop, Claude Code). DEMO DATA only: fictional brand "Kalye Nutrition".
//
// Backends (env OPS_BACKEND):
//   local  (default) runs the demo CSVs through the same validator/tools code as Apps Script
//   webapp calls the deployed Apps Script Web App (OPS_WEBAPP_URL + OPS_TOKEN from .env)
//
// Runs with plain Node 23.6+ (built-in TypeScript type stripping), no build step.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildLocalStore } from '../lib/local-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

type ToolSchema = { name: string; description: string; read_only: boolean; parameters: Record<string, unknown> };
type Result = Record<string, unknown> & { error?: string };

const TOOLS: ToolSchema[] = JSON.parse(readFileSync(join(HERE, '..', 'tools', 'ops-tools.json'), 'utf8'));
const BACKEND = process.env.OPS_BACKEND ?? 'local';

function makeBackend(): (name: string, args: Record<string, unknown>) => Promise<Result> {
  if (BACKEND === 'webapp') {
    const url = process.env.OPS_WEBAPP_URL;
    const token = process.env.OPS_TOKEN;
    if (!url || !token) throw new Error('OPS_BACKEND=webapp needs OPS_WEBAPP_URL and OPS_TOKEN in mcp-server/.env');
    return async (name, args) => {
      // Apps Script Web Apps can't read request headers, so the token goes in the body.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token, action: 'tool', name, args }),
        redirect: 'follow',
      });
      if (!res.ok) return { error: `Web App returned HTTP ${res.status}` };
      return (await res.json()) as Result;
    };
  }
  const store = buildLocalStore({ approvalsFile: join(HERE, '.local', 'approvals.json') });
  return async (name, args) => store.run(name, args) as Result;
}

const callBackend = makeBackend();

const server = new Server(
  { name: 'supplement-ops', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Ask ops for Kalye Nutrition, a fictional supplement brand (DEMO DATA, synthetic numbers). ' +
      'Use the tools for every number; do not estimate. Days of cover = on hand / average daily units. ' +
      'save_approval only creates a Pending suggestion for a human to approve; it never orders anything.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: `${t.description} (Demo data.)`,
    inputSchema: { type: 'object', ...t.parameters },
    annotations: { readOnlyHint: t.read_only, destructiveHint: false, idempotentHint: t.read_only, openWorldHint: false },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (!TOOLS.some((t) => t.name === name)) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
  }
  try {
    const result = await callBackend(name, args as Record<string, unknown>);
    return {
      isError: Boolean(result.error),
      content: [{ type: 'text', text: JSON.stringify({ source: `${BACKEND} (demo data)`, ...result }, null, 2) }],
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Backend error: ${(e as Error).message}` }] };
  }
});

await server.connect(new StdioServerTransport());
console.error(`supplement-ops MCP server running (backend: ${BACKEND}, demo data)`);
