-- Reorder shortlist in SQL, same rule and baseline quantity as the list_low_cover tool:
-- baseline = round up to a multiple of 5 of (avg daily units x (lead time + 21 days) - on hand). DEMO DATA.
SELECT
  sku,
  name,
  status,
  on_hand,
  avg_daily_units_28d,
  days_of_cover,
  lead_time_days,
  GREATEST(0, CAST(CEIL(((units_28d / 28) * (lead_time_days + 21) - on_hand) / 5) * 5 AS INT64)) AS baseline_order_qty
FROM ops_demo.v_sku_cover
WHERE status IN ('Runs out before restock', 'Low')
  AND units_28d > 0
ORDER BY days_of_cover;
