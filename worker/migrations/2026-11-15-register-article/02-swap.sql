-- 02-swap.sql  (run ONCE, only after 01-prepare.sql was verified)
-- Refresh the copies from the live tables, then swap names back-to-back so the window without a live
-- table is as short as possible. The old tables are kept as *_pre until 03-cleanup.sql.
INSERT OR REPLACE INTO analytics_page_counts_v2(day,path,pageviews)
  SELECT day,path,pageviews FROM analytics_page_counts;
INSERT OR REPLACE INTO analytics_request_counts_v2(day,path,source,medium,campaign,pageviews)
  SELECT day,path,source,medium,campaign,pageviews FROM analytics_request_counts;
INSERT OR REPLACE INTO analytics_navigation_counts_v2(day,from_path,to_path,navigations)
  SELECT day,from_path,to_path,navigations FROM analytics_navigation_counts;
ALTER TABLE analytics_page_counts RENAME TO analytics_page_counts_pre;
ALTER TABLE analytics_page_counts_v2 RENAME TO analytics_page_counts;
ALTER TABLE analytics_request_counts RENAME TO analytics_request_counts_pre;
ALTER TABLE analytics_request_counts_v2 RENAME TO analytics_request_counts;
ALTER TABLE analytics_navigation_counts RENAME TO analytics_navigation_counts_pre;
ALTER TABLE analytics_navigation_counts_v2 RENAME TO analytics_navigation_counts;
