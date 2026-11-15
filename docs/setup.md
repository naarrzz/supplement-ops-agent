# Setup on Google (free tier) and n8n

Demo data only. Everything here is free: no billing account is needed. Steps marked **(you)** need the owner's own Google sign-in or a permission screen.

## 1. Sheet, folder and Apps Script

1. **(you)** Create a Google Sheet named "Kalye Nutrition ops (demo data)".
2. **(you)** Create a Drive folder "Ops Inbox". Copy its ID from the URL (`drive.google.com/drive/folders/<ID>`).
3. **(you)** In the Sheet: Extensions → Apps Script. In Project Settings copy the **Script ID**.
4. Push the code with clasp:
   ```bash
   npm install -g @google/clasp      # small, about 10 MB
   clasp login                        # (you) Google sign-in in the browser
   cp apps-script/.clasp.json.example apps-script/.clasp.json   # paste the Script ID
   cd apps-script && clasp push
   ```
   Apps Script also needs "Google Apps Script API" turned on at script.google.com/home/usersettings **(you)**.
5. **(you)** In Project Settings → Script Properties add:
   - `OPS_TOKEN`: a long random string. Make one with `openssl rand -hex 24`.
   - `GEMINI_API_KEY`: from Google AI Studio (free tier). Paste it here only.
   - `OPS_INBOX_FOLDER_ID`: the folder ID from step 2.
   - optional `GEMINI_MODEL` (default `gemini-2.5-flash`; check AI Studio for the current free model name).
6. **(you)** Reload the Sheet. Menu **Ops (demo) → 1. Set up sheets**, and accept the permission screen (it lists the scopes in `appsscript.json`).

## 2. Load the demo data

1. `npm run generate`, then upload from `sample-data/out/` into Ops Inbox: `demo_products.csv` first, then `demo_inventory_snapshots.csv`, then the 13 `demo_orders_batch_*.csv` files.
2. Menu **Process Ops Inbox now** (or let n8n do it). Expected: 65 rejected rows (5 per batch), 13 prices fixed, every row in Run log `ok`.
3. Menu **Explain rejected rows (steward)**: explanations appear next to the rejected rows.

## 3. Web App (tools API)

1. **(you)** Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. (The token protects it; nobody can read data without it.)
2. Copy the Web App URL. Test:
   ```bash
   curl -sL -X POST "$URL" -H 'Content-Type: text/plain' \
     -d "{\"token\":\"$OPS_TOKEN\",\"action\":\"tool\",\"name\":\"list_low_cover\",\"args\":{\"days\":21}}"
   ```
3. Optional: point the MCP server at it by filling `mcp-server/.env` from `.env.example`.

## 4. n8n (self-hosted on the Mac)

n8n needs a supported Node version (check docs.n8n.io for the current range; Node 26 may be too new). The install is large (roughly 1 GB), so check free disk space first.

1. Start n8n and open http://localhost:5678, create the local owner account **(you)**.
2. Workflows → Import from file: both files in `n8n/`.
3. **(you)** Credentials:
   - Google Drive OAuth2 for the trigger (needs a Google Cloud OAuth client; n8n's docs walk through it).
   - "Query Auth" named **Ops Web App token**: Name `token`, Value = your `OPS_TOKEN`. Select it on every HTTP Request node.
4. Replace `REPLACE_WITH_WEBAPP_URL` and `REPLACE_WITH_OPS_INBOX_FOLDER_ID` in the nodes.
5. Run each workflow once by hand, then activate. Before committing any re-export, run `npm run scan`.

If the Mac is off, menu **Install fallback triggers** keeps the inbox (every 15 min) and the weekly run (Monday 8 AM) going inside Apps Script.

## 5. Dashboard

See [dashboard.md](dashboard.md). **(you)** connect Looker Studio to the Sheet and share the report view-only.
