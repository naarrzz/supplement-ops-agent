/**
 * Supplement ops agent: Apps Script entry points. DEMO DATA project (fictional brand "Kalye Nutrition").
 *
 *   - Sheet menu (Ops (demo)) for running each step by hand
 *   - processInbox / processFileById_: CSV in Drive "Ops Inbox" -> validate -> Orders/Inventory, Rejected rows, Run log
 *   - runSteward / runAnalyst / runWeekly: Gemini agents with the ops tools
 *   - doPost: the tools Web App that n8n and the MCP server call (secret token required)
 *   - installTriggers: fallback time triggers for when n8n (on the Mac) is off
 *
 * Script Properties (Project Settings): OPS_TOKEN, GEMINI_API_KEY, OPS_INBOX_FOLDER_ID,
 * optional GEMINI_MODEL and BQ_PROJECT_ID (BigQuery export). SPREADSHEET_ID is set by setup().
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Ops (demo)')
    .addItem('1. Set up sheets', 'setup')
    .addItem('Process Ops Inbox now', 'processInbox')
    .addItem('Explain rejected rows (steward)', 'menuSteward')
    .addItem('Run weekly agents now', 'menuWeekly')
    .addItem('Export to BigQuery', 'menuBigQuery')
    .addSeparator()
    .addItem('Install fallback triggers', 'installTriggers')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  props_().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SHEETS).forEach(sheet_);
  var approvals = sheet_('approvals');
  var statusCol = SHEETS.approvals.headers.indexOf('status') + 1;
  approvals
    .getRange(2, statusCol, approvals.getMaxRows() - 1, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Pending', 'Approved', 'Rejected'], true).build());
  var missing = ['OPS_TOKEN', 'GEMINI_API_KEY', 'OPS_INBOX_FOLDER_ID'].filter(function (k) {
    return !props_().getProperty(k);
  });
  var msg = 'Sheets are ready (demo data).' + (missing.length ? ' Still missing in Script Properties: ' + missing.join(', ') : '');
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg);
  }
  return msg;
}

// ---------- ETL ----------

function inboxFolder_() {
  var id = props_().getProperty('OPS_INBOX_FOLDER_ID');
  if (!id) throw new Error('Set OPS_INBOX_FOLDER_ID in Script Properties.');
  return DriveApp.getFolderById(id);
}

function isProductHeader_(header) {
  return header.indexOf('lead_time_days') !== -1 && header.indexOf('reorder_point') !== -1;
}

function csvHeader_(file) {
  var firstLine = file.getBlob().getDataAsString('UTF-8').split(/\r?\n/)[0] || '';
  return (Utilities.parseCsv(firstLine)[0] || []).map(function (h) {
    return String(h).trim().toLowerCase();
  });
}

/** Processes every CSV in Ops Inbox: the product list first, then the rest by file name. */
function processInbox() {
  var it = inboxFolder_().getFiles();
  var files = [];
  while (it.hasNext()) {
    var f = it.next();
    if (/\.csv$/i.test(f.getName())) files.push({ file: f, products: isProductHeader_(csvHeader_(f)) });
  }
  files.sort(function (a, b) {
    if (a.products !== b.products) return a.products ? -1 : 1;
    return a.file.getName() < b.file.getName() ? -1 : 1;
  });
  var out = files.map(function (x) {
    return processFile_(x.file, { skipRefresh: true });
  });
  refreshCover_();
  var done = out.filter(function (r) {
    return r.log;
  });
  var rejected = done.reduce(function (n, r) {
    return n + (r.log.rows_rejected || 0);
  }, 0);
  var msg = 'Processed ' + done.length + ' file(s), ' + rejected + ' row(s) rejected, ' + (out.length - done.length) + ' skipped. Demo data.';
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Ops Inbox', 10);
  } catch (e) {
    Logger.log(msg);
  }
  return out;
}

/** Called by n8n with the Drive file ID. Only files inside Ops Inbox are accepted. */
function processFileById_(fileId) {
  var file = DriveApp.getFileById(fileId);
  var inboxId = inboxFolder_().getId();
  var parents = file.getParents();
  var inInbox = false;
  while (parents.hasNext()) if (parents.next().getId() === inboxId) inInbox = true;
  if (!inInbox) return { error: 'File is not in the Ops Inbox folder.' };
  return processFile_(file);
}

function processFile_(file, opts) {
  opts = opts || {};
  var name = file.getName();
  var done = readObjects_('runLog').some(function (r) {
    return r.file === name && r.step === 'validate' && r.status === 'ok';
  });
  if (done) return { file: name, skipped: true, note: 'Already processed (see Run log).' };

  var table = Utilities.parseCsv(file.getBlob().getDataAsString('UTF-8'));
  var header = (table[0] || []).map(function (h) {
    return String(h).trim().toLowerCase();
  });

  // The product list is a master file: it replaces the Products tab.
  if (isProductHeader_(header)) {
    var products = table.slice(1).map(function (r) {
      var o = {};
      header.forEach(function (h, i) {
        o[h] = r[i];
      });
      return o;
    });
    replaceObjects_('products', products);
    if (!opts.skipRefresh) refreshCover_();
    var plog = { run_id: 'run-' + Date.now(), step: 'validate', file: name, kind: 'products', rows_in: products.length, rows_kept: products.length, rows_fixed: 0, rows_rejected: 0, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: 'ok' };
    appendObjects_('runLog', [plog]);
    return { file: name, kind: 'products', log: plog };
  }

  var kind = OpsCore.detectKind(table[0]);
  var products = loadProducts_();
  // Without a product list every SKU would be "unknown". Don't reject anything yet and don't
  // mark the file as processed, so it is picked up again once the product list is loaded.
  if (kind && !products.length) {
    return { file: name, skipped: true, error: 'Load the product list (demo_products.csv) first.' };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = OpsCore.validateBatch({
      fileName: name,
      table: table,
      products: products,
      existingKeys: existingKeys_(kind),
    });
    if (r.kind === 'orders') appendObjects_('orders', r.clean);
    if (r.kind === 'inventory') appendObjects_('inventory', r.clean);
    appendObjects_('rejected', r.rejected);
    appendObjects_('runLog', [r.log]);
    if (!opts.skipRefresh) refreshCover_();
    return { file: name, kind: r.kind, log: r.log };
  } finally {
    lock.releaseLock();
  }
}

/** Rebuilds the "SKU cover" tab that Looker Studio reads (days of cover, status per SKU). */
function refreshCover_() {
  return replaceObjects_('cover', OpsTools.coverTable(loadData_()));
}

// ---------- Agents ----------

function runAgent_(agent, input, data, opts) {
  data = data || loadData_();
  opts = opts || {};
  var started = new Date().toISOString();
  var res;
  try {
    res = OpsAgents.runAgent({ agent: agent, input: input, data: data, callModel: callGemini_, maxSteps: opts.maxSteps });
  } catch (e) {
    res = { ok: false, agent: agent, error: String(e && e.message ? e.message : e), trace: [], usage: { total_tokens: 0 } };
  }
  appendObjects_('runLog', [
    {
      run_id: 'agent-' + Date.now(),
      step: 'agent:' + agent,
      started_at: started,
      finished_at: new Date().toISOString(),
      status: res.ok ? 'ok' : 'error',
      tokens: res.usage ? res.usage.total_tokens : '',
      detail: JSON.stringify({
        model: props_().getProperty('GEMINI_MODEL'),
        input: String(input).slice(0, 300),
        tools: (res.trace || []).map(function (t) {
          return t.tool + ' ' + JSON.stringify(t.args);
        }),
        model_calls: res.usage ? res.usage.model_calls : 0,
        model_seconds: res.usage ? res.usage.model_seconds : '',
        problems: res.problems,
        error: res.error,
        output: JSON.stringify(res.output || res.raw || '').slice(0, 2000),
      }).slice(0, 45000),
    },
  ]);
  return res;
}

var STEWARD_BATCH = 15;
var STEWARD_TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes

/** Writes steward explanations next to their rejected rows. Returns how many rows were updated. */
function writeStewardItems_(items, data) {
  var sh = sheet_('rejected');
  var values = sh.getDataRange().getValues();
  var h = values[0];
  var col = function (name) {
    return h.indexOf(name);
  };
  var updated = 0;
  items.forEach(function (it) {
    for (var i = 1; i < values.length; i++) {
      if (values[i][col('file')] === it.file && Number(values[i][col('line')]) === Number(it.line)) {
        sh.getRange(i + 1, col('explanation') + 1, 1, 4).setValues([[it.explanation, it.likely_cause || '', it.suggested_fix, it.auto_fixable]]);
        updated++;
      }
    }
    // keep the in-memory copy in step, so the next batch's only_unexplained skips these rows
    data.rejected.forEach(function (r) {
      if (r.file === it.file && Number(r.line) === Number(it.line)) r.suggested_fix = it.suggested_fix;
    });
  });
  return updated;
}

/**
 * Steward: explains rejected rows in batches of 15 and writes each batch to the sheet right away.
 * Stops before the Apps Script time limit; running it again continues with the rows left.
 */
function runSteward(fileName) {
  fileName = typeof fileName === 'string' ? fileName : '';
  var deadline = Date.now() + STEWARD_TIME_BUDGET_MS;
  var data = loadData_();
  var pending = function () {
    return data.rejected.filter(function (r) {
      return (!fileName || r.file === fileName) && !r.suggested_fix;
    }).length;
  };
  var out = { ok: true, explained: 0, batches: 0, summaries: [], usage: { model_calls: 0, total_tokens: 0, model_seconds: 0 } };
  while (pending() && Date.now() < deadline - 75000) {
    var input =
      (fileName ? 'Explain the rejected rows from file ' + fileName + '. ' : 'Explain rejected rows that have no explanation yet. ') +
      'Call list_rejected once with only_unexplained true' + (fileName ? ', file "' + fileName + '"' : '') + ' and limit ' + STEWARD_BATCH + '.';
    var res = runAgent_('steward', input, data, { maxSteps: 2 });
    out.usage.model_calls += res.usage.model_calls || 0;
    out.usage.total_tokens += res.usage.total_tokens || 0;
    out.usage.model_seconds += res.usage.model_seconds || 0;
    if (!res.ok) {
      out.ok = false;
      out.error = res.error;
      out.problems = res.problems;
      break;
    }
    var n = writeStewardItems_(res.output.items, data);
    out.explained += n;
    out.batches++;
    out.summaries.push(res.output.summary);
    if (!n) break; // model answered about rows we could not match; don't loop on it
  }
  out.remaining = pending();
  return out;
}

function runAnalyst() {
  return runAgent_('analyst', 'Weekly reorder check. Use a 21-day threshold.');
}

/** Code (not the model) saves Pending approvals after the guardrail check. */
function saveSuggestions_(checked) {
  var data = loadData_();
  var before = data.approvals.length;
  var results = OpsAgents.saveSuggestions(checked, data, new Date().toISOString());
  appendObjects_('approvals', data.approvals.slice(before));
  return results;
}

function publishReport_(report, period) {
  var text = OpsAgents.renderReport(report);
  var doc = DocumentApp.create(report.title);
  var body = doc.getBody();
  body.appendParagraph(report.title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(report.headline).setBold(true);
  report.sections.forEach(function (s) {
    body.appendParagraph(s.heading).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    s.bullets.forEach(function (b) {
      body.appendListItem(b).setBold(false);
    });
  });
  if (report.actions.length) {
    body.appendParagraph('Next actions').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    report.actions.forEach(function (a) {
      body.appendListItem(a).setGlyphType(DocumentApp.GlyphType.NUMBER);
    });
  }
  body.appendParagraph('Demo data: fictional brand, synthetic numbers.').setItalic(true);
  doc.saveAndClose();
  var me = Session.getEffectiveUser().getEmail(); // the owner's own inbox only
  MailApp.sendEmail(me, report.title, text + '\n\nGoogle Doc: ' + doc.getUrl());
  appendObjects_('reports', [{ created_at: new Date().toISOString(), period: period || '', title: report.title, doc_url: doc.getUrl(), emailed_to: me }]);
  return { doc_url: doc.getUrl(), emailed_to: me };
}

/** Weekly chain: analyst -> save approvals -> writer -> Doc + email. Used by the fallback trigger. */
function runWeekly() {
  if (props_().getProperty('BQ_PROJECT_ID')) {
    try {
      exportToBigQuery(); // keep the BigQuery copy and views fresh for the dashboard
    } catch (e) {
      appendObjects_('runLog', [{ run_id: 'bq-' + Date.now(), step: 'bigquery', status: 'error', detail: String(e.message || e) }]);
    }
  }
  var analyst = runAnalyst();
  if (!analyst.ok) return { step: 'analyst', error: analyst.error || (analyst.problems || []).join('; ') };
  var saved = saveSuggestions_(analyst.checked);
  return writeReport_(analyst.output, saved);
}

function writeReport_(analystOutput, saved) {
  var stewardNote = readObjects_('runLog')
    .filter(function (r) {
      return r.step === 'agent:steward' && r.status === 'ok';
    })
    .pop();
  var input =
    'Write this week\'s report.\nInventory analyst output (JSON): ' + JSON.stringify(analystOutput) +
    '\nSaved to Approvals: ' + JSON.stringify(saved || []) +
    '\nLatest data steward run: ' + (stewardNote ? stewardNote.detail : 'none this week');
  var writer = runAgent_('writer', input);
  if (!writer.ok) return { step: 'writer', error: writer.error || (writer.problems || []).join('; ') };
  return publishReport_(writer.output, analystOutput.as_of);
}

// ---------- Menu wrappers: run, then tell the person what happened ----------

function alert_(title, msg) {
  try {
    SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(title + ': ' + msg);
  }
}

function failText_(res) {
  if (!res) return 'No result.';
  if (res.error) return String(res.error).slice(0, 600);
  if (res.problems && res.problems.length) return 'Output failed checks: ' + res.problems.slice(0, 5).join('; ');
  return '';
}

function menuSteward() {
  var res = runSteward();
  var fail = failText_(res);
  var progress = 'Explained ' + res.explained + ' row(s) in ' + res.batches + ' batch(es); ' + res.remaining + ' left' +
    (res.remaining ? ' (run it again to continue).' : '.');
  alert_('Data steward (demo data)', (fail ? 'Stopped: ' + fail + '\n\n' : '') + progress +
    (res.summaries.length ? '\n\n' + res.summaries[0] : '') +
    '\n\nModel calls: ' + res.usage.model_calls + ', tokens: ' + res.usage.total_tokens + ', model time: ' + Math.round(res.usage.model_seconds) + ' s' +
    '\nDetails are in the Run log tab.');
}

function menuWeekly() {
  var res = runWeekly();
  alert_('Weekly agents (demo data)', res.doc_url
    ? 'Done. Reorder suggestions are in Approvals (Pending), the report is in Reports and was emailed to ' + res.emailed_to + '.\n\n' + res.doc_url
    : 'Stopped at the ' + (res.step || 'unknown') + ' step: ' + failText_(res) + '\n\nDetails are in the Run log tab.');
}

function menuBigQuery() {
  try {
    var r = exportToBigQuery();
    alert_('BigQuery (demo data)', 'Loaded ' + r.loaded.map(function (x) { return x.table + ' (' + x.rows + ')'; }).join(', ') + ' into dataset ' + r.dataset + ' and created ' + r.views + ' views.');
  } catch (e) {
    alert_('BigQuery (demo data)', 'Failed: ' + String(e.message || e).slice(0, 600));
  }
}

// ---------- Web App (tools API for n8n and the MCP server) ----------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(given) {
  var expected = props_().getProperty('OPS_TOKEN');
  if (!expected || expected.length < 24 || typeof given !== 'string' || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function doGet() {
  return json_({ ok: true, service: 'supplement-ops (demo data)', usage: 'POST JSON {token, action, ...}' });
}

/**
 * POST body (JSON): { token, action, ... }. The token can also be a ?token= query parameter
 * (n8n sends it that way from a Query Auth credential, so it never sits in the workflow JSON).
 * Actions: tool, process_file, process_inbox, run_agent, save_suggestions, write_report, run_weekly.
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: 'Body must be JSON.' });
  }
  var token = body.token || (e && e.parameter && e.parameter.token);
  if (!checkToken_(token)) return json_({ error: 'unauthorized' });
  try {
    return json_(route_(body));
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

function route_(body) {
  switch (body.action) {
    case 'tool': {
      if (OpsTools.names.indexOf(body.name) === -1) return { error: 'Unknown tool ' + body.name };
      var data = loadData_();
      var before = data.approvals.length;
      var result = OpsTools.run(body.name, body.args || {}, data);
      if (body.name === 'save_approval' && result.saved) appendObjects_('approvals', data.approvals.slice(before));
      return result;
    }
    case 'process_file':
      return processFileById_(String(body.file_id || ''));
    case 'process_inbox':
      return { results: processInbox() };
    case 'run_agent':
      if (body.agent === 'steward') return runSteward(body.file_name);
      if (body.agent === 'analyst') return runAnalyst();
      return { error: 'run_agent supports steward and analyst; use write_report for the writer.' };
    case 'save_suggestions':
      return { results: saveSuggestions_(body.checked || []) };
    case 'write_report':
      return writeReport_(body.analyst_output || {}, body.saved || []);
    case 'run_weekly':
      return runWeekly();
    case 'export_bigquery':
      return exportToBigQuery();
    default:
      return { error: 'Unknown action ' + body.action };
  }
}

// ---------- Triggers and the Approvals sheet ----------

/** Fallback when n8n is off: inbox every 15 minutes, weekly agents Monday 8 AM Manila time. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['processInbox', 'runWeekly'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('runWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  return 'Fallback triggers installed.';
}

/** Stamp who/when when someone changes an approval's status in the sheet. */
function onEdit(e) {
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEETS.approvals.name || e.range.getRow() < 2) return;
  var h = SHEETS.approvals.headers;
  if (e.range.getColumn() !== h.indexOf('status') + 1) return;
  sh.getRange(e.range.getRow(), h.indexOf('decided_by') + 1, 1, 2).setValues([['owner (sheet edit)', new Date().toISOString()]]);
}
