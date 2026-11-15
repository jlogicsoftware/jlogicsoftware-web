-- 03-cleanup.sql  (run after the post-swap checks pass; leaves no orphan tables behind)
DROP TABLE IF EXISTS analytics_page_counts_pre;
DROP TABLE IF EXISTS analytics_request_counts_pre;
DROP TABLE IF EXISTS analytics_navigation_counts_pre;
