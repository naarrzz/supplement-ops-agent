# n8n workflows (demo data)

| File | Trigger | Steps |
|---|---|---|
| `ops-inbox-validate-and-explain.json` | New file in the Drive "Ops Inbox" folder | Web App `process_file` → if rows were rejected, Web App `run_agent steward` |
| `weekly-ops-agents.json` | Every Monday 8 AM (Asia/Manila) | `run_agent analyst` → if the output passed schema checks, `save_suggestions` → `write_report` (Doc + email); otherwise stop with an error |

The agent loop and Gemini calls run inside Apps Script, so the same chain also works from the Apps Script fallback trigger when n8n is off. n8n is the orchestrator: scheduling, branching, retries and an execution history.

**Status:** hand-written in n8n's export format and checked by tests (valid JSON, connections, no credentials, placeholder URL, every action exists in the Web App). **Not yet imported into a running n8n.** After importing, re-export, run `npm run scan`, and replace these files.

Placeholders to fill after import: `REPLACE_WITH_WEBAPP_URL`, `REPLACE_WITH_OPS_INBOX_FOLDER_ID`. Credentials (never exported): Google Drive OAuth2, and a Query Auth credential with name `token`.
