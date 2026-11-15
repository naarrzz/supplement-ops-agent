/**
 * Copies the cleaned Sheet tabs into BigQuery (dataset ops_demo) and recreates the views.
 * Uses the BigQuery advanced service (enabled in appsscript.json). Load jobs and view DDL are
 * free in the BigQuery Sandbox (no billing). DEMO DATA project (fictional brand).
 *
 * Script Property: BQ_PROJECT_ID (the Google Cloud project ID, e.g. ops-agent-demo-123456).
 * Column names and types must match sql/00_tables.sql (a test checks this).
 */
var BQ_DATASET = 'ops_demo';

var BQ_TABLES = {
  products: {
    sheet: 'products',
    fields: [
      ['sku', 'STRING', 'REQUIRED'], ['name', 'STRING'], ['category', 'STRING'], ['price', 'NUMERIC'],
      ['unit_cost', 'NUMERIC'], ['reorder_point', 'INT64'], ['lead_time_days', 'INT64'],
    ],
  },
  orders: {
    sheet: 'orders',
    fields: [
      ['order_id', 'STRING', 'REQUIRED'], ['order_date', 'DATE', 'REQUIRED'], ['channel', 'STRING'], ['sku', 'STRING'],
      ['quantity', 'INT64'], ['unit_price', 'NUMERIC'], ['revenue', 'NUMERIC'], ['cost', 'NUMERIC'],
      ['source_file', 'STRING'], ['source_line', 'INT64'], ['notes', 'STRING'],
    ],
  },
  inventory: {
    sheet: 'inventory',
    fields: [
      ['snapshot_date', 'DATE', 'REQUIRED'], ['location', 'STRING'], ['sku', 'STRING'], ['on_hand', 'INT64'],
      ['source_file', 'STRING'], ['notes', 'STRING'],
    ],
  },
  rejected_rows: {
    sheet: 'rejected',
    fields: [
      ['run_id', 'STRING'], ['file', 'STRING'], ['line', 'INT64'], ['reason_code', 'STRING'], ['reason', 'STRING'],
      ['all_codes', 'STRING'], ['raw', 'STRING'], ['explanation', 'STRING'], ['likely_cause', 'STRING'],
      ['suggested_fix', 'STRING'], ['auto_fixable', 'STRING'],
    ],
  },
};

function bqCsv_(names, rows) {
  var esc = function (v) {
    var s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [names.join(',')]
    .concat(
      rows.map(function (r) {
        return names.map(function (n) {
          return esc(r[n]);
        }).join(',');
      }),
    )
    .join('\n');
}

function bqWait_(project, job) {
  var ref = job.jobReference;
  for (var i = 0; i < 60; i++) {
    var j = BigQuery.Jobs.get(project, ref.jobId, { location: ref.location });
    if (j.status.state === 'DONE') {
      if (j.status.errorResult) throw new Error('BigQuery job failed: ' + JSON.stringify(j.status.errors || j.status.errorResult).slice(0, 800));
      return j;
    }
    Utilities.sleep(1000);
  }
  throw new Error('BigQuery job ' + ref.jobId + ' did not finish in 60 s.');
}

function bqEnsureDataset_(project) {
  try {
    BigQuery.Datasets.get(project, BQ_DATASET);
  } catch (e) {
    BigQuery.Datasets.insert({ datasetReference: { projectId: project, datasetId: BQ_DATASET }, location: 'US' }, project);
  }
}

function bqLoadTable_(project, table) {
  var def = BQ_TABLES[table];
  var names = def.fields.map(function (f) {
    return f[0];
  });
  var rows = readObjects_(def.sheet);
  var blob = Utilities.newBlob(bqCsv_(names, rows), 'application/octet-stream');
  var job = BigQuery.Jobs.insert(
    {
      configuration: {
        load: {
          destinationTable: { projectId: project, datasetId: BQ_DATASET, tableId: table },
          schema: {
            fields: def.fields.map(function (f) {
              return { name: f[0], type: f[1], mode: f[2] || 'NULLABLE' };
            }),
          },
          sourceFormat: 'CSV',
          skipLeadingRows: 1,
          allowQuotedNewlines: true,
          writeDisposition: 'WRITE_TRUNCATE',
        },
      },
    },
    project,
    blob,
  );
  bqWait_(project, job);
  return { table: table, rows: rows.length };
}

/** Menu / weekly: Sheet tabs -> BigQuery tables, then (re)create the views from sql/01_views.sql. */
function exportToBigQuery() {
  var project = props_().getProperty('BQ_PROJECT_ID');
  if (!project) throw new Error('Set BQ_PROJECT_ID in Script Properties to use BigQuery.');
  var started = new Date().toISOString();
  bqEnsureDataset_(project);
  var loaded = Object.keys(BQ_TABLES).map(function (t) {
    return bqLoadTable_(project, t);
  });
  var views = OPS_BQ_VIEWS_SQL.split(/;\s*\n/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.replace(/--[^\n]*/g, '').trim();
    });
  views.forEach(function (sql) {
    bqWait_(project, BigQuery.Jobs.insert({ configuration: { query: { query: sql, useLegacySql: false } } }, project));
  });
  var total = loaded.reduce(function (n, x) {
    return n + x.rows;
  }, 0);
  appendObjects_('runLog', [
    {
      run_id: 'bq-' + Date.now(),
      step: 'bigquery',
      rows_in: total,
      rows_kept: total,
      started_at: started,
      finished_at: new Date().toISOString(),
      status: 'ok',
      detail: JSON.stringify({ dataset: BQ_DATASET, loaded: loaded, views: views.length }),
    },
  ]);
  return { dataset: BQ_DATASET, loaded: loaded, views: views.length };
}
