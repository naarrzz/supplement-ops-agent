-- Is the channel mix shifting? Revenue share per channel, first 4 weeks vs last 4 weeks. DEMO DATA.
WITH a AS (
  SELECT as_of, (SELECT MIN(order_date) FROM ops_demo.orders) AS first_day
  FROM ops_demo.v_as_of
),
w AS (
  SELECT
    o.channel,
    o.revenue,
    CASE
      WHEN o.order_date > DATE_SUB(a.as_of, INTERVAL 28 DAY) THEN 'last_4w'
      WHEN o.order_date <= DATE_ADD(a.first_day, INTERVAL 27 DAY) THEN 'first_4w'
    END AS period
  FROM ops_demo.orders o
  CROSS JOIN a
),
t AS (
  SELECT
    SUM(IF(period = 'first_4w', revenue, 0)) AS first_total,
    SUM(IF(period = 'last_4w', revenue, 0)) AS last_total
  FROM w
)
SELECT
  w.channel,
  ROUND(SAFE_DIVIDE(SUM(IF(w.period = 'first_4w', w.revenue, 0)), MAX(t.first_total)) * 100, 1) AS share_first_4w_pct,
  ROUND(SAFE_DIVIDE(SUM(IF(w.period = 'last_4w', w.revenue, 0)), MAX(t.last_total)) * 100, 1) AS share_last_4w_pct,
  ROUND(
    (SAFE_DIVIDE(SUM(IF(w.period = 'last_4w', w.revenue, 0)), MAX(t.last_total))
      - SAFE_DIVIDE(SUM(IF(w.period = 'first_4w', w.revenue, 0)), MAX(t.first_total))) * 100, 1
  ) AS change_pts
FROM w
CROSS JOIN t
GROUP BY w.channel
ORDER BY share_last_4w_pct DESC;
