/**
 * OpsTools: the ops tools the agents and the MCP server call. DEMO DATA project (fictional brand).
 *
 * Every tool is a pure function over a data object:
 *   { products, orders, inventory, rejected, approvals, asOf? }
 * (clean rows from OpsCore.validateBatch). All arithmetic happens here, never in the model:
 * the agents only read these numbers, explain them and decide what to suggest.
 *
 * Same file runs in Apps Script and in Node (see lib/load-core.mjs).
 */
var OpsTools = (function () {
  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function round1(x) {
    return Math.round(x * 10) / 10;
  }
  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  function productMap(data) {
    var m = {};
    data.products.forEach(function (p) {
      m[p.sku] = p;
    });
    return m;
  }

  function asOf(data) {
    if (data.asOf) return data.asOf;
    var max = '';
    data.orders.forEach(function (o) {
      if (o.order_date > max) max = o.order_date;
    });
    data.inventory.forEach(function (r) {
      if (r.snapshot_date > max) max = r.snapshot_date;
    });
    return max;
  }

  function needSku(data, args) {
    var sku = String((args && args.sku) || '').trim().toUpperCase();
    var p = productMap(data)[sku];
    if (!p) return { error: 'Unknown SKU "' + sku + '". Call list_low_cover or ask for the product list to see valid SKUs.' };
    return { sku: sku, product: p };
  }

  function latestStock(data, sku) {
    var latest = '';
    data.inventory.forEach(function (r) {
      if (r.sku === sku && r.snapshot_date > latest) latest = r.snapshot_date;
    });
    var byLoc = {};
    var total = 0;
    data.inventory.forEach(function (r) {
      if (r.sku === sku && r.snapshot_date === latest) {
        byLoc[r.location] = r.on_hand;
        total += r.on_hand;
      }
    });
    return { as_of: latest || null, by_location: byLoc, total: total };
  }

  function salesBetween(data, from, to, sku) {
    var out = { units: 0, revenue: 0, cost: 0, orders: 0, by_channel: {} };
    var ids = {};
    data.orders.forEach(function (o) {
      if (o.order_date < from || o.order_date > to) return;
      if (sku && o.sku !== sku) return;
      out.units += o.quantity;
      out.revenue += o.revenue;
      out.cost += o.cost;
      ids[o.order_id] = true;
      var c = out.by_channel[o.channel] || (out.by_channel[o.channel] = { units: 0, revenue: 0 });
      c.units += o.quantity;
      c.revenue = round2(c.revenue + o.revenue);
    });
    out.orders = Object.keys(ids).length;
    out.revenue = round2(out.revenue);
    out.cost = round2(out.cost);
    out.gross_margin_pct = out.revenue ? round1(((out.revenue - out.cost) / out.revenue) * 100) : null;
    return out;
  }

  // ---- tools ----

  function get_stock(data, args) {
    var s = needSku(data, args);
    if (s.error) return s;
    var st = latestStock(data, s.sku);
    return { sku: s.sku, name: s.product.name, as_of: st.as_of, on_hand_total: st.total, by_location: st.by_location, reorder_point: s.product.reorder_point };
  }

  function get_sales(data, args) {
    var s = needSku(data, args);
    if (s.error) return s;
    var days = Math.max(1, Math.min(90, parseInt((args && args.days) || 28, 10)));
    var end = asOf(data);
    var start = addDays(end, -(days - 1));
    var agg = salesBetween(data, start, end, s.sku);
    return {
      sku: s.sku,
      name: s.product.name,
      from: start,
      to: end,
      days: days,
      units: agg.units,
      avg_daily_units: round2(agg.units / days),
      revenue: agg.revenue,
      gross_margin_pct: agg.gross_margin_pct,
      by_channel: agg.by_channel,
    };
  }

  function get_lead_time(data, args) {
    var s = needSku(data, args);
    if (s.error) return s;
    return { sku: s.sku, name: s.product.name, lead_time_days: s.product.lead_time_days, reorder_point: s.product.reorder_point, unit_cost: s.product.unit_cost };
  }

  function coverRow(data, p, lookback, end) {
    var stock = latestStock(data, p.sku);
    var sales = salesBetween(data, addDays(end, -(lookback - 1)), end, p.sku);
    var avg = sales.units / lookback;
    var cover = avg > 0 ? round1(stock.total / avg) : null;
    return { p: p, stock: stock, avg: avg, cover: cover };
  }

  function list_low_cover(data, args) {
    var days = parseInt((args && args.days) || 21, 10);
    var lookback = parseInt((args && args.lookback_days) || 28, 10);
    var end = asOf(data);
    var items = [];
    data.products.forEach(function (p) {
      var c = coverRow(data, p, lookback, end);
      var low = (c.cover !== null && c.cover < days) || c.stock.total <= p.reorder_point;
      if (!low || c.avg === 0) return; // no recent sales = dead stock question, not a reorder
      var target = c.avg * (p.lead_time_days + days);
      var suggested = Math.max(0, Math.ceil((target - c.stock.total) / 5) * 5);
      items.push({
        sku: p.sku,
        name: p.name,
        on_hand: c.stock.total,
        avg_daily_units: round2(c.avg),
        days_of_cover: c.cover,
        lead_time_days: p.lead_time_days,
        reorder_point: p.reorder_point,
        runs_out_before_restock: c.cover !== null && c.cover < p.lead_time_days,
        baseline_order_qty: suggested,
        baseline_formula: 'ceil5(avg_daily_units x (lead_time_days + ' + days + ') - on_hand)',
      });
    });
    items.sort(function (a, b) {
      return a.days_of_cover - b.days_of_cover;
    });
    return { as_of: end, threshold_days: days, lookback_days: lookback, count: items.length, items: items };
  }

  function list_dead_stock(data, args) {
    var lookback = parseInt((args && args.lookback_days) || 60, 10);
    var end = asOf(data);
    var items = [];
    data.products.forEach(function (p) {
      var c = coverRow(data, p, lookback, end);
      if (c.stock.total > 0 && c.avg === 0) {
        items.push({ sku: p.sku, name: p.name, on_hand: c.stock.total, stock_value_at_cost: round2(c.stock.total * p.unit_cost), days_without_sales: lookback + '+' });
      }
    });
    return { as_of: end, lookback_days: lookback, count: items.length, items: items };
  }

  function list_rejected(data, args) {
    var limit = Math.max(1, Math.min(200, parseInt((args && args.limit) || 20, 10)));
    var file = args && args.file;
    var rows = data.rejected.filter(function (r) {
      return !file || r.file === file;
    });
    var byReason = {};
    rows.forEach(function (r) {
      byReason[r.reason_code] = (byReason[r.reason_code] || 0) + 1;
    });
    return { total: rows.length, by_reason: byReason, rows: rows.slice(-limit) };
  }

  function get_week_summary(data, args) {
    var end = (args && args.end_date) || asOf(data);
    var start = addDays(end, -6);
    var cur = salesBetween(data, start, end);
    var prev = salesBetween(data, addDays(end, -13), addDays(end, -7));
    var bySku = {};
    var pm = productMap(data);
    data.orders.forEach(function (o) {
      if (o.order_date < start || o.order_date > end) return;
      var x = bySku[o.sku] || (bySku[o.sku] = { sku: o.sku, name: pm[o.sku].name, units: 0, revenue: 0 });
      x.units += o.quantity;
      x.revenue = round2(x.revenue + o.revenue);
    });
    var top = Object.keys(bySku)
      .map(function (k) {
        return bySku[k];
      })
      .sort(function (a, b) {
        return b.revenue - a.revenue;
      })
      .slice(0, 5);
    var low = list_low_cover(data, { days: 21 });
    var dead = list_dead_stock(data, { lookback_days: 60 });
    var rej = list_rejected(data, { limit: 1 });
    return {
      label: 'DEMO DATA',
      period: { from: start, to: end },
      revenue: cur.revenue,
      revenue_prev_week: prev.revenue,
      revenue_change_pct: prev.revenue ? round1(((cur.revenue - prev.revenue) / prev.revenue) * 100) : null,
      units: cur.units,
      orders: cur.orders,
      gross_margin_pct: cur.gross_margin_pct,
      by_channel: cur.by_channel,
      top_skus: top,
      low_cover: low.items.map(function (i) {
        return { sku: i.sku, name: i.name, days_of_cover: i.days_of_cover, lead_time_days: i.lead_time_days };
      }),
      dead_stock: dead.items,
      data_quality: { rejected_rows_total: rej.total, by_reason: rej.by_reason },
    };
  }

  function save_approval(data, args) {
    var s = needSku(data, args);
    if (s.error) return s;
    var qty = parseInt(args.qty, 10);
    if (!(qty > 0)) return { error: 'qty must be a whole number above zero.' };
    var conf = Number(args.confidence);
    if (!(conf >= 0 && conf <= 1)) return { error: 'confidence must be between 0 and 1.' };
    var reason = String(args.reason || '').trim();
    if (!reason) return { error: 'reason is required.' };
    data.approvals = data.approvals || [];
    var pending = data.approvals.filter(function (a) {
      return a.sku === s.sku && a.status === 'Pending';
    })[0];
    if (pending) return { duplicate: true, note: 'A pending suggestion for this SKU already exists; not adding another.', approval: pending };
    var now = (args && args.now) || new Date().toISOString();
    var row = {
      approval_id: 'APR-' + now.replace(/[^0-9]/g, '').slice(0, 14) + '-' + s.sku,
      created_at: now,
      sku: s.sku,
      name: s.product.name,
      qty: qty,
      est_cost: round2(qty * s.product.unit_cost),
      reason: reason,
      confidence: conf,
      requested_by: String(args.requested_by || 'inventory-analyst'),
      status: 'Pending',
      decided_by: '',
      decided_at: '',
    };
    data.approvals.push(row);
    return { saved: true, approval: row, note: 'Saved as Pending. A human approves or rejects it in the Approvals sheet. Nothing is sent to a supplier.' };
  }

  var TOOLS = {
    get_stock: get_stock,
    get_sales: get_sales,
    get_lead_time: get_lead_time,
    list_low_cover: list_low_cover,
    list_dead_stock: list_dead_stock,
    list_rejected: list_rejected,
    get_week_summary: get_week_summary,
    save_approval: save_approval,
  };

  /** Run a tool by name. Unknown tools and thrown errors come back as { error } so an agent can recover. */
  function run(name, args, data) {
    var fn = TOOLS[name];
    if (!fn) return { error: 'Unknown tool "' + name + '". Available: ' + Object.keys(TOOLS).join(', ') };
    try {
      return fn(data, args || {});
    } catch (e) {
      return { error: 'Tool ' + name + ' failed: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  return { run: run, names: Object.keys(TOOLS), addDays: addDays, asOf: asOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OpsTools;
