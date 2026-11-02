-- DESTRUCTIVE, OWNER-RUN ONLY, after explicit approval of historical deletion.
-- Apply schema.sql first, verify the aggregate-only Worker, then decide backup
-- retention and approve deletion of ALL v1/v2 raw data and historical reports.
-- Do not import old data into analytics_page_counts: it has different semantics.
-- This file never drops or edits analytics_page_counts. Safe to repeat.
DROP VIEW IF EXISTS analytics_report;
DROP VIEW IF EXISTS analytics_daily_live;
DROP TABLE IF EXISTS analytics_events;
DROP TABLE IF EXISTS analytics_salts;
DROP TABLE IF EXISTS analytics_daily;
DROP TABLE IF EXISTS analytics_legacy_daily;
DROP TABLE IF EXISTS events;
