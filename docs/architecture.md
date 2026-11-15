# Architecture: trigger to output

Demo data only (fictional brand "Kalye Nutrition").

## 1. Upload flow (every new CSV)

1. **Trigger.** A CSV lands in the Drive folder "Ops Inbox". The n8n workflow [`ops-inbox-validate-and-explain`](../n8n/ops-inbox-validate-and-explain.json) polls the folder every minute. If n8n is off, the Apps Script time trigger runs `processInbox` every 15 minutes instead.
2. **Validate and load.** n8n POSTs `{action: "process_file", file_id}` to the Apps Script Web App. `processFileById_` checks the file is inside Ops Inbox, skips files already in the Run log, then `OpsCore.validateBatch`:
   - detects the file type from its header (orders, inventory, or the product list),
   - normalizes dates (`YYYY-MM-DD`, `MM/DD/YYYY`, `Nov 14, 2026`) and peso amounts (`₱1,299` → `1299`),
   - rejects impossible dates, blank or unknown channels and locations, unknown SKUs, zero or negative quantities, negative stock, and duplicates (within the file and against everything loaded before),
   - writes clean rows to **Orders** / **Inventory**, rejected rows to **Rejected rows** with a reason code and a plain-words reason, and one line to **Run log** (rows in, kept, fixed, rejected).
   - rebuilds **SKU cover** (on hand, 28-day average, days of cover, status) for the dashboard.
3. **Explain.** If any rows were rejected, n8n calls `{action: "run_agent", agent: "steward", file_name}`. The data steward calls `list_rejected` for that file and writes an explanation, likely cause, fix and "auto-fixable" flag next to each rejected row.

## 2. Weekly flow (Monday 8 AM, Manila time)

[`weekly-ops-agents`](../n8n/weekly-ops-agents.json) (fallback: Apps Script trigger running `runWeekly`).

1. **Inventory analyst** (`run_agent analyst`): calls `list_low_cover`, then `get_sales` for 7 and 28 days per flagged SKU, `get_lead_time`/`get_stock` as needed, and `list_dead_stock`. Returns reorder suggestions as JSON.
2. **Guardrail** (code): `OpsAgents.checkSuggestions` compares each suggestion with the tool numbers and flags unknown SKUs, dead stock, SKUs that are not actually low, and quantities outside half to double the baseline. If the JSON fails the schema, n8n stops with an error.
3. **Approvals** (`save_suggestions`): code saves each suggestion as a `Pending` row (with flags in the reason). A person sets Approved or Rejected in the sheet; `onEdit` stamps who and when.
4. **Report writer** (`write_report`): calls `get_week_summary`, reads the analyst output, saved approvals and the latest steward run, and returns the report as JSON. Apps Script renders it into a Google Doc and emails the owner.

## 2b. BigQuery copy

`exportToBigQuery` (menu, Web App action `export_bigquery`, and the start of every weekly run) loads the Products, Orders, Inventory and Rejected rows tabs into dataset `ops_demo` with explicit schemas (`WRITE_TRUNCATE`), then recreates the views from `sql/01_views.sql`. Looker Studio reads the views. The Sheet stays the place people look at and edit; BigQuery is the copy for SQL.

## 3. Ask ops (MCP)

`mcp-server/server.ts` exposes the same eight tools to any MCP client. Backend `local` runs the demo CSVs through the same validator in memory; backend `webapp` forwards each call to the Web App with the token. Every tool is marked read-only except `save_approval`, which can only create a Pending suggestion.

## Why the core is shared

`apps-script/core/*.js` is plain JavaScript with no imports. Apps Script loads it as globals; Node loads the same files into a `vm` context (`lib/load-core.mjs`). So the validator, tools and agent loop that the tests exercise are byte-for-byte what runs on Google. Tool schemas and prompts live in `tools/` and `prompts/` and are embedded into `apps-script/core/Generated.js` by `npm run build`; a test fails if that file is stale.

## Sheets (tabs)

| Tab | Written by | Read by |
|---|---|---|
| Products | product list upload | everything |
| Orders, Inventory | validator | tools, dashboard |
| Rejected rows | validator, steward | steward, dashboard |
| Run log | validator, every agent run | report writer, you |
| SKU cover | `refreshCover_` after each upload | dashboard |
| Approvals | analyst via code, you | report writer |
| Reports | report step | you |
