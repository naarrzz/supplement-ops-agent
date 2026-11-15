/**
 * Sheets I/O for the ops workbook. DEMO DATA project (fictional brand).
 * The Google Sheet is the database: one tab per table, header in row 1.
 */
var SHEETS = {
  products: { name: 'Products', headers: ['sku', 'name', 'category', 'price', 'unit_cost', 'reorder_point', 'lead_time_days'] },
  orders: {
    name: 'Orders',
    headers: ['order_id', 'order_date', 'channel', 'sku', 'quantity', 'unit_price', 'revenue', 'cost', 'source_file', 'source_line', 'notes'],
    text: ['order_id', 'order_date'],
  },
  inventory: { name: 'Inventory', headers: ['snapshot_date', 'location', 'sku', 'on_hand', 'source_file', 'notes'], text: ['snapshot_date'] },
  rejected: {
    name: 'Rejected rows',
    headers: ['run_id', 'file', 'line', 'reason_code', 'reason', 'all_codes', 'raw', 'explanation', 'likely_cause', 'suggested_fix', 'auto_fixable'],
  },
  runLog: {
    name: 'Run log',
    headers: ['run_id', 'step', 'file', 'kind', 'rows_in', 'rows_kept', 'rows_fixed', 'rows_rejected', 'started_at', 'finished_at', 'status', 'tokens', 'detail'],
  },
  approvals: {
    name: 'Approvals',
    headers: ['approval_id', 'created_at', 'sku', 'name', 'qty', 'est_cost', 'reason', 'confidence', 'requested_by', 'status', 'decided_by', 'decided_at'],
  },
  reports: { name: 'Reports', headers: ['created_at', 'period', 'title', 'doc_url', 'emailed_to'] },
};

function props_() {
  return PropertiesService.getScriptProperties();
}

function spreadsheet_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(key) {
  var def = SHEETS[key];
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Keep IDs and dates as plain text so Sheets doesn't turn them into Date objects.
    (def.text || []).forEach(function (h) {
      sh.getRange(1, def.headers.indexOf(h) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
}

function isoDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return v;
}

function readObjects_(key) {
  var sh = sheet_(key);
  var values = sh.getDataRange().getValues();
  var header = values.shift() || [];
  return values
    .filter(function (r) {
      return r.join('') !== '';
    })
    .map(function (r) {
      var o = {};
      header.forEach(function (h, i) {
        o[h] = isoDate_(r[i]);
      });
      return o;
    });
}

function appendObjects_(key, rows) {
  if (!rows || !rows.length) return 0;
  var headers = SHEETS[key].headers;
  var sh = sheet_(key);
  var values = rows.map(function (r) {
    return headers.map(function (h) {
      var v = r[h];
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : v;
    });
  });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
  return values.length;
}

function replaceObjects_(key, rows) {
  var sh = sheet_(key);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  return appendObjects_(key, rows);
}

function num_(v) {
  return typeof v === 'number' ? v : Number(v);
}

/** Everything the tools need, as plain objects (same shape as lib/local-store.mjs). */
function loadData_() {
  return {
    products: readObjects_('products').map(function (p) {
      return {
        sku: String(p.sku),
        name: p.name,
        category: p.category,
        price: num_(p.price),
        unit_cost: num_(p.unit_cost),
        reorder_point: num_(p.reorder_point),
        lead_time_days: num_(p.lead_time_days),
      };
    }),
    orders: readObjects_('orders').map(function (o) {
      o.order_id = String(o.order_id);
      o.quantity = num_(o.quantity);
      o.unit_price = num_(o.unit_price);
      o.revenue = num_(o.revenue);
      o.cost = num_(o.cost);
      return o;
    }),
    inventory: readObjects_('inventory').map(function (r) {
      r.on_hand = num_(r.on_hand);
      return r;
    }),
    rejected: readObjects_('rejected'),
    approvals: readObjects_('approvals'),
  };
}

function existingKeys_(kind) {
  var keys = {};
  if (kind === 'orders') {
    readObjects_('orders').forEach(function (o) {
      keys[String(o.order_id)] = true;
    });
  } else if (kind === 'inventory') {
    readObjects_('inventory').forEach(function (r) {
      keys[r.snapshot_date + '|' + r.location + '|' + r.sku] = true;
    });
  }
  return keys;
}
