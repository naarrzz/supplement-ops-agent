-- Reporting views for Looker Studio and ad-hoc SQL. DEMO DATA: fictional brand, synthetic numbers.
-- The Apps Script loader re-runs this file after every export, so the views always exist.
-- Business rules match apps-script/core/OpsTools.js (a test runs both on the same data and compares).

-- Latest data date. Every "last N days" window ends here, so the views work on any reload.
CREATE OR REPLACE VIEW ops_demo.v_as_of AS
SELECT GREATEST(
  (SELECT MAX(order_date) FROM ops_demo.orders),
  (SELECT MAX(snapshot_date) FROM ops_demo.inventory)
) AS as_of;

-- Sales per day and channel.
CREATE OR REPLACE VIEW ops_demo.v_sales_daily AS
SELECT
  order_date,
  channel,
  COUNT(DISTINCT order_id) AS orders,
  SUM(quantity) AS units,
  ROUND(SUM(revenue), 2) AS revenue,
  ROUND(SUM(cost), 2) AS cost,
  ROUND(SAFE_DIVIDE(SUM(revenue) - SUM(cost), SUM(revenue)) * 100, 1) AS gross_margin_pct
FROM ops_demo.orders
GROUP BY order_date, channel;

-- Days of cover per SKU: stock on the latest snapshot / average daily units over 28 days.
CREATE OR REPLACE VIEW ops_demo.v_sku_cover AS
WITH a AS (
  SELECT as_of FROM ops_demo.v_as_of
),
stock AS (
  SELECT sku, SUM(on_hand) AS on_hand
  FROM (
    SELECT sku, on_hand, snapshot_date,
      MAX(snapshot_date) OVER (PARTITION BY sku) AS last_date
    FROM ops_demo.inventory
  )
  WHERE snapshot_date = last_date
  GROUP BY sku
),
sales AS (
  SELECT
    o.sku,
    SUM(IF(o.order_date >= DATE_SUB(a.as_of, INTERVAL 27 DAY), o.quantity, 0)) AS units_28d,
    SUM(IF(o.order_date >= DATE_SUB(a.as_of, INTERVAL 59 DAY), o.quantity, 0)) AS units_60d
  FROM ops_demo.orders o
  CROSS JOIN a
  WHERE o.order_date <= a.as_of
  GROUP BY o.sku
),
base AS (
  SELECT
    a.as_of,
    p.sku,
    p.name,
    p.category,
    COALESCE(s.on_hand, 0) AS on_hand,
    COALESCE(x.units_28d, 0) AS units_28d,
    COALESCE(x.units_60d, 0) AS units_60d,
    ROUND(SAFE_DIVIDE(COALESCE(s.on_hand, 0), COALESCE(x.units_28d, 0) / 28), 1) AS days_of_cover,
    p.lead_time_days,
    p.reorder_point,
    p.unit_cost
  FROM ops_demo.products p
  CROSS JOIN a
  LEFT JOIN stock s ON s.sku = p.sku
  LEFT JOIN sales x ON x.sku = p.sku
)
SELECT
  as_of,
  sku,
  name,
  category,
  on_hand,
  units_28d,
  ROUND(units_28d / 28, 2) AS avg_daily_units_28d,
  days_of_cover,
  lead_time_days,
  reorder_point,
  ROUND(on_hand * unit_cost, 2) AS stock_value_at_cost,
  CASE
    WHEN on_hand > 0 AND units_60d = 0 THEN 'Dead stock'
    WHEN days_of_cover < lead_time_days THEN 'Runs out before restock'
    WHEN days_of_cover < 21 OR on_hand <= reorder_point THEN 'Low'
    ELSE 'OK'
  END AS status
FROM base;

-- Weekly KPIs in 7-day blocks ending on the latest data date, with week-over-week change.
CREATE OR REPLACE VIEW ops_demo.v_weekly_kpis AS
WITH a AS (
  SELECT as_of FROM ops_demo.v_as_of
),
w AS (
  SELECT
    CAST(FLOOR(DATE_DIFF(a.as_of, o.order_date, DAY) / 7) AS INT64) AS weeks_ago,
    o.order_id, o.quantity, o.revenue, o.cost
  FROM ops_demo.orders o
  CROSS JOIN a
  WHERE o.order_date <= a.as_of
),
agg AS (
  SELECT
    weeks_ago,
    COUNT(DISTINCT order_id) AS orders,
    SUM(quantity) AS units,
    ROUND(SUM(revenue), 2) AS revenue,
    ROUND(SUM(cost), 2) AS cost
  FROM w
  GROUP BY weeks_ago
)
SELECT
  DATE_SUB(a.as_of, INTERVAL weeks_ago * 7 + 6 DAY) AS week_start,
  DATE_SUB(a.as_of, INTERVAL weeks_ago * 7 DAY) AS week_end,
  weeks_ago,
  orders,
  units,
  revenue,
  ROUND(SAFE_DIVIDE(revenue - cost, revenue) * 100, 1) AS gross_margin_pct,
  ROUND(SAFE_DIVIDE(
    revenue - LAG(revenue) OVER (ORDER BY weeks_ago DESC),
    LAG(revenue) OVER (ORDER BY weeks_ago DESC)
  ) * 100, 1) AS revenue_wow_pct
FROM agg
CROSS JOIN a;

-- Margin and revenue share by category.
CREATE OR REPLACE VIEW ops_demo.v_margin_by_category AS
SELECT
  p.category,
  SUM(o.quantity) AS units,
  ROUND(SUM(o.revenue), 2) AS revenue,
  ROUND(SUM(o.revenue) - SUM(o.cost), 2) AS gross_profit,
  ROUND(SAFE_DIVIDE(SUM(o.revenue) - SUM(o.cost), SUM(o.revenue)) * 100, 1) AS gross_margin_pct,
  ROUND(SAFE_DIVIDE(SUM(o.revenue), SUM(SUM(o.revenue)) OVER ()) * 100, 1) AS revenue_share_pct
FROM ops_demo.orders o
JOIN ops_demo.products p ON p.sku = o.sku
GROUP BY p.category;

-- Data quality: rejected rows per reason, and how many the steward has explained.
CREATE OR REPLACE VIEW ops_demo.v_data_quality AS
SELECT
  reason_code,
  COUNT(*) AS rows_rejected,
  COUNT(DISTINCT file) AS files,
  COUNTIF(suggested_fix IS NOT NULL AND suggested_fix != '') AS explained_by_steward
FROM ops_demo.rejected_rows
GROUP BY reason_code;
