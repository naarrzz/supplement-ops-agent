-- BigQuery tables for the supplement ops agent. DEMO DATA: fictional brand, synthetic numbers.
-- The Apps Script loader (apps-script/BigQueryLoad.js) creates the dataset and replaces these
-- tables from the Google Sheet with WRITE_TRUNCATE load jobs (free in the BigQuery Sandbox).
-- Kept here as the schema reference; a test checks the loader uses the same columns and types.

CREATE SCHEMA IF NOT EXISTS ops_demo;

CREATE TABLE IF NOT EXISTS ops_demo.products (
  sku STRING NOT NULL,
  name STRING,
  category STRING,
  price NUMERIC,
  unit_cost NUMERIC,
  reorder_point INT64,
  lead_time_days INT64
);

CREATE TABLE IF NOT EXISTS ops_demo.orders (
  order_id STRING NOT NULL,
  order_date DATE NOT NULL,
  channel STRING,
  sku STRING,
  quantity INT64,
  unit_price NUMERIC,
  revenue NUMERIC,
  cost NUMERIC,
  source_file STRING,
  source_line INT64,
  notes STRING
);

CREATE TABLE IF NOT EXISTS ops_demo.inventory (
  snapshot_date DATE NOT NULL,
  location STRING,
  sku STRING,
  on_hand INT64,
  source_file STRING,
  notes STRING
);

CREATE TABLE IF NOT EXISTS ops_demo.rejected_rows (
  run_id STRING,
  file STRING,
  line INT64,
  reason_code STRING,
  reason STRING,
  all_codes STRING,
  raw STRING,
  explanation STRING,
  likely_cause STRING,
  suggested_fix STRING,
  auto_fixable STRING
);
