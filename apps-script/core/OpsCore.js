/**
 * OpsCore: validation and ETL for the supplement ops agent. DEMO DATA project (fictional brand).
 *
 * Plain JavaScript with no imports, so the same file runs in two places:
 *   - Google Apps Script (clasp pushes it; OpsCore becomes a global)
 *   - Node (lib/load-core.mjs loads it in a vm context for tests and the local MCP server)
 */
var OpsCore = (function () {
  var ORDER_HEADERS = ['order_id', 'order_date', 'channel', 'sku', 'quantity', 'unit_price'];
  var INVENTORY_HEADERS = ['snapshot_date', 'location', 'sku', 'on_hand'];
  var CHANNELS = ['website', 'shopee', 'lazada', 'store_a', 'store_b'];
  var LOCATIONS = ['warehouse', 'store_a', 'store_b'];
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // Plain-words explanation for every reason code. The data steward agent builds on these.
  var REASONS = {
    BAD_SCHEMA: 'The file is missing required columns, so none of its rows were loaded.',
    MISSING_FIELD: 'A required value is blank.',
    DUPLICATE_ORDER_ID: 'This order ID was already loaded (earlier in this file or in a previous upload).',
    DUPLICATE_SNAPSHOT: 'This SKU already has a stock count for that date and location.',
    UNKNOWN_SKU: 'The SKU is not in the product list.',
    BAD_QUANTITY: 'Quantity must be a whole number above zero.',
    BAD_STOCK: 'Stock on hand must be a whole number, zero or more.',
    BAD_DATE: 'The date is not a real calendar date in a known format (YYYY-MM-DD, MM/DD/YYYY or "Nov 14, 2026").',
    BAD_PRICE: 'The price is not a peso amount.',
    MISSING_CHANNEL: 'The sales channel is blank.',
    UNKNOWN_CHANNEL: 'The sales channel is not one of: ' + CHANNELS.join(', ') + '.',
    UNKNOWN_LOCATION: 'The location is not one of: ' + LOCATIONS.join(', ') + '.',
    PRICE_NORMALIZED: 'Price was written as text (peso sign or commas) and was converted to a number.',
    DATE_NORMALIZED: 'Date was in another format and was converted to YYYY-MM-DD.',
  };

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function str(v) {
    return v == null ? '' : String(v).trim();
  }

  /** RFC 4180-style CSV parser. Returns an array of rows (arrays of strings). */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var s = String(text).replace(/^﻿/, '');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter(function (r) {
      return !(r.length === 1 && r[0] === '');
    });
  }

  function buildDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return null;
    var daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > daysInMonth) return null;
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  /** Returns { value: 'YYYY-MM-DD', changed } or null. */
  function normalizeDate(v) {
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return null;
      return { value: buildDate(v.getFullYear(), v.getMonth() + 1, v.getDate()), changed: false };
    }
    var s = str(v);
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    var out = null;
    if (m) out = buildDate(+m[1], +m[2], +m[3]);
    else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) out = buildDate(+m[3], +m[1], +m[2]);
    else if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})$/))) {
      var mo = MONTHS[m[1].toLowerCase()];
      out = mo ? buildDate(+m[3], mo, +m[2]) : null;
    }
    return out ? { value: out, changed: out !== s } : null;
  }

  /** Returns { value: number, changed } or null. Accepts 1299, "1299", "₱1,299", "PHP 1,299.50". */
  function normalizeMoney(v) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? { value: v, changed: false } : null;
    var s = str(v);
    if (!s) return null;
    var t = s.replace(/^(₱|PHP|Php|php|P)\s*/, '').replace(/,/g, '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return { value: Number(t), changed: t !== s };
  }

  function parseInteger(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? v : null;
    var s = str(v);
    return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
  }

  function detectKind(headerRow) {
    var h = (headerRow || []).map(function (x) {
      return str(x).toLowerCase();
    });
    var has = function (cols) {
      return cols.every(function (c) {
        return h.indexOf(c) !== -1;
      });
    };
    if (has(ORDER_HEADERS)) return 'orders';
    if (has(INVENTORY_HEADERS)) return 'inventory';
    return null;
  }

  function indexBy(list, key) {
    var out = {};
    (list || []).forEach(function (x) {
      out[x[key]] = x;
    });
    return out;
  }

  /**
   * Validate and clean one uploaded table.
   * @param {Object} opts
   *   fileName      name of the uploaded file (for the run log and rejected rows)
   *   table         2-D array, first row is the header (from parseCsv or Utilities.parseCsv)
   *   products      array of product objects (needs .sku)
   *   existingKeys  object: keys already loaded (order IDs, or date|location|sku); not mutated
   *   runId, now    optional; now is an ISO string
   * @returns {{kind, clean, rejected, newKeys, log}}
   */
  function validateBatch(opts) {
    var startedAt = opts.now || new Date().toISOString();
    var runId = opts.runId || 'run-' + startedAt.replace(/[^0-9]/g, '').slice(0, 14);
    var table = opts.table || [];
    var header = (table[0] || []).map(function (x) {
      return str(x).toLowerCase();
    });
    var kind = detectKind(header);
    var productsBySku = indexBy(opts.products, 'sku');
    var existing = opts.existingKeys || {};
    var seen = {};
    var clean = [];
    var rejected = [];
    var fixed = 0;
    var dataRows = table.slice(1);

    function reject(line, raw, codes) {
      rejected.push({
        run_id: runId,
        file: opts.fileName,
        line: line,
        reason_code: codes[0],
        reason: codes
          .map(function (c) {
            return REASONS[c];
          })
          .join(' '),
        all_codes: codes.join(','),
        raw: JSON.stringify(raw),
      });
    }

    if (!kind) {
      return {
        kind: null,
        clean: [],
        rejected: [
          {
            run_id: runId,
            file: opts.fileName,
            line: 1,
            reason_code: 'BAD_SCHEMA',
            reason: REASONS.BAD_SCHEMA + ' Expected orders columns (' + ORDER_HEADERS.join(', ') +
              ') or inventory columns (' + INVENTORY_HEADERS.join(', ') + ').',
            all_codes: 'BAD_SCHEMA',
            raw: JSON.stringify(table[0] || []),
          },
        ],
        newKeys: {},
        log: makeLog('failed'),
      };
    }

    var col = {};
    header.forEach(function (h, i) {
      col[h] = i;
    });

    dataRows.forEach(function (cells, i) {
      var line = i + 2;
      var raw = {};
      header.forEach(function (h, j) {
        raw[h] = cells[j];
      });
      if (cells.every(function (c) { return str(c) === ''; })) return; // skip blank lines
      var codes = [];
      var notes = [];
      var sku = str(raw.sku).toUpperCase();
      if (!sku) codes.push('MISSING_FIELD');
      else if (!productsBySku[sku]) codes.push('UNKNOWN_SKU');

      if (kind === 'orders') {
        var orderId = str(raw.order_id);
        var date = normalizeDate(raw.order_date);
        var channel = str(raw.channel).toLowerCase();
        var qty = parseInteger(raw.quantity);
        var price = normalizeMoney(raw.unit_price);
        if (!orderId) codes.push('MISSING_FIELD');
        if (!date) codes.push('BAD_DATE');
        if (!channel) codes.push('MISSING_CHANNEL');
        else if (CHANNELS.indexOf(channel) === -1) codes.push('UNKNOWN_CHANNEL');
        if (qty === null || qty <= 0) codes.push('BAD_QUANTITY');
        if (!price) codes.push('BAD_PRICE');
        if (!codes.length && (existing[orderId] || seen[orderId])) codes.push('DUPLICATE_ORDER_ID');
        if (codes.length) return reject(line, raw, codes);
        if (date.changed) notes.push('DATE_NORMALIZED');
        if (price.changed) notes.push('PRICE_NORMALIZED');
        seen[orderId] = true;
        clean.push({
          order_id: orderId,
          order_date: date.value,
          channel: channel,
          sku: sku,
          quantity: qty,
          unit_price: price.value,
          revenue: Math.round(qty * price.value * 100) / 100,
          cost: Math.round(qty * productsBySku[sku].unit_cost * 100) / 100,
          source_file: opts.fileName,
          source_line: line,
          notes: notes.join(','),
        });
      } else {
        var sdate = normalizeDate(raw.snapshot_date);
        var loc = str(raw.location).toLowerCase();
        var onHand = parseInteger(raw.on_hand);
        if (!sdate) codes.push('BAD_DATE');
        if (!loc) codes.push('MISSING_FIELD');
        else if (LOCATIONS.indexOf(loc) === -1) codes.push('UNKNOWN_LOCATION');
        if (onHand === null || onHand < 0) codes.push('BAD_STOCK');
        var key = codes.length ? null : sdate.value + '|' + loc + '|' + sku;
        if (key && (existing[key] || seen[key])) codes.push('DUPLICATE_SNAPSHOT');
        if (codes.length) return reject(line, raw, codes);
        if (sdate.changed) notes.push('DATE_NORMALIZED');
        seen[key] = true;
        clean.push({
          snapshot_date: sdate.value,
          location: loc,
          sku: sku,
          on_hand: onHand,
          source_file: opts.fileName,
          notes: notes.join(','),
        });
      }
      if (notes.length) fixed++;
    });

    return { kind: kind, clean: clean, rejected: rejected, newKeys: seen, log: makeLog('ok') };

    function makeLog(status) {
      return {
        run_id: runId,
        step: 'validate',
        file: opts.fileName,
        kind: kind || 'unknown',
        rows_in: dataRows.length,
        rows_kept: clean.length,
        rows_fixed: fixed,
        rows_rejected: status === 'failed' ? dataRows.length : rejected.length,
        started_at: startedAt,
        finished_at: opts.now || new Date().toISOString(),
        status: status,
        detail: '',
      };
    }
  }

  return {
    ORDER_HEADERS: ORDER_HEADERS,
    INVENTORY_HEADERS: INVENTORY_HEADERS,
    CHANNELS: CHANNELS,
    LOCATIONS: LOCATIONS,
    REASONS: REASONS,
    parseCsv: parseCsv,
    normalizeDate: normalizeDate,
    normalizeMoney: normalizeMoney,
    parseInteger: parseInteger,
    detectKind: detectKind,
    validateBatch: validateBatch,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OpsCore;
