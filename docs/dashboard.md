# Looker Studio dashboard (demo data)

Data sources (Google Sheets connector, same spreadsheet): **Orders**, **SKU cover**, **Rejected rows**, **Run log**. In Orders, set `order_date` to type Date (YYYYMMDD) and `revenue`, `cost` to Currency (PHP).

Calculated field on Orders: `Gross margin % = (SUM(revenue) - SUM(cost)) / SUM(revenue)`.

## Page 1: Sales

| Chart | Source | Dimension | Metric |
|---|---|---|---|
| Scorecards | Orders | none | SUM(revenue), SUM(quantity), COUNT_DISTINCT(order_id), Gross margin % |
| Time series | Orders | order_date (day) | SUM(revenue), breakdown by channel |
| Bar | Orders | channel | SUM(revenue) |
| Table | Orders | sku | SUM(quantity), SUM(revenue), sorted by revenue |

The payday spikes (15th and 30th) and the promo week are visible in the time series.

## Page 2: Stock

| Chart | Source | Dimension | Metric |
|---|---|---|---|
| Table with conditional colors | SKU cover | sku, name, status | on_hand, avg_daily_units_28d, days_of_cover, lead_time_days |
| Scorecards | SKU cover | filter status | count of "Runs out before restock", "Low", "Dead stock" |
| Bar | SKU cover | category | SUM(stock_value_at_cost) |

Color rule on status: Runs out before restock = red, Low = amber, Dead stock = grey.

## Page 3: Data quality

| Chart | Source | Dimension | Metric |
|---|---|---|---|
| Scorecard | Run log (step = validate) | none | SUM(rows_rejected), SUM(rows_fixed) |
| Bar | Rejected rows | reason_code | Record count |
| Table | Rejected rows | file, line, reason, suggested_fix | none |

Add a text box on every page: "Demo data: fictional brand, synthetic numbers."
