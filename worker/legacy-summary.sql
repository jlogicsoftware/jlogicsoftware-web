-- OWNER-RUN ONLY on an EXISTING legacy database, AFTER applying schema.sql.
-- This preserves daily counts only, without hashes, paths, source text or targets.
-- Do not run against a fresh v2-only database: there is no `events` table there.
INSERT OR REPLACE INTO analytics_legacy_daily
  (day,daily_visitor_estimates,pageviews,legacy_cta_clicks,outbound_clicks)
SELECT day,
  COUNT(DISTINCT CASE WHEN name='pageview' THEN visitor_hash END),
  SUM(name='pageview'),SUM(name='cta_book_call'),SUM(name='outbound')
FROM events WHERE day >= date('now','-399 days') GROUP BY day;
