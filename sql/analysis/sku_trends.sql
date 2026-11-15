-- Which SKUs are trending up or down? Least-squares slope of weekly units over the last 12 full
-- weeks (slope = COVAR_POP(week, units) / VAR_POP(week)), as % of the average week. DEMO DATA.
WITH a AS (
  SELECT as_of FROM ops_demo.v_as_of
),
w AS (
  SELECT
    o.sku,
    CAST(FLOOR(DATE_DIFF(a.as_of, o.order_date, DAY) / 7) AS INT64) AS weeks_ago,
    o.quantity
  FROM ops_demo.orders o
  CROSS JOIN a
),
weeks AS (
  SELECT DISTINCT weeks_ago FROM w WHERE weeks_ago <= 11
),
-- every SKU x every week, so weeks with zero sales count as zero
grid AS (
  SELECT p.sku, p.name, k.weeks_ago
  FROM ops_demo.products p
  CROSS JOIN weeks k
),
weekly AS (
  SELECT
    g.sku,
    g.name,
    11 - g.weeks_ago AS week_num,
    COALESCE(SUM(w.quantity), 0) AS units
  FROM grid g
  LEFT JOIN w ON w.sku = g.sku AND w.weeks_ago = g.weeks_ago
  GROUP BY g.sku, g.name, g.weeks_ago
)
SELECT
  sku,
  name,
  SUM(units) AS units_12w,
  ROUND(AVG(units), 1) AS avg_weekly_units,
  ROUND(SAFE_DIVIDE(COVAR_POP(week_num, units), VAR_POP(week_num)), 2) AS slope_units_per_week,
  ROUND(SAFE_DIVIDE(SAFE_DIVIDE(COVAR_POP(week_num, units), VAR_POP(week_num)), AVG(units)) * 100, 1)
    AS trend_pct_per_week
FROM weekly
GROUP BY sku, name
ORDER BY trend_pct_per_week DESC NULLS LAST;
