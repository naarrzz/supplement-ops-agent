-- Do paydays (15th and 30th) really move sales? Average daily revenue by day type. DEMO DATA.
WITH daily AS (
  SELECT order_date, SUM(revenue) AS revenue
  FROM ops_demo.orders
  GROUP BY order_date
),
typed AS (
  SELECT
    revenue,
    CASE
      WHEN EXTRACT(DAY FROM order_date) IN (15, 30) THEN 'Payday (15th, 30th)'
      WHEN EXTRACT(DAY FROM order_date) IN (1, 16) THEN 'Day after payday'
      ELSE 'Other days'
    END AS day_type
  FROM daily
),
s AS (
  SELECT day_type, COUNT(*) AS days, ROUND(AVG(revenue), 2) AS avg_daily_revenue
  FROM typed
  GROUP BY day_type
)
SELECT
  day_type,
  days,
  avg_daily_revenue,
  ROUND(SAFE_DIVIDE(avg_daily_revenue, (SELECT avg_daily_revenue FROM s WHERE day_type = 'Other days')) * 100 - 100, 1)
    AS uplift_vs_other_days_pct
FROM s
ORDER BY avg_daily_revenue DESC;
