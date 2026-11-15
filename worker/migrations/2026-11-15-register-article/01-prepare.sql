-- 01-prepare.sql  (safe to run repeatedly; the live tables are only read)
-- Builds replacement tables whose path allow-lists also contain the new article, and copies the data.
CREATE TABLE IF NOT EXISTS analytics_page_counts_v2 (
  day TEXT NOT NULL,
  path TEXT NOT NULL CHECK(path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster',
    '/articles/2026-11-15-how-i-made-my-game-3x-faster-by-moving-from-dart-to-java'
  )),
  pageviews INTEGER NOT NULL CHECK(pageviews >= 0),
  PRIMARY KEY(day,path)
);
CREATE TABLE IF NOT EXISTS analytics_request_counts_v2 (
  day TEXT NOT NULL,
  path TEXT NOT NULL CHECK(path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster',
    '/articles/2026-11-15-how-i-made-my-game-3x-faster-by-moving-from-dart-to-java'
  )),
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  campaign TEXT NOT NULL,
  pageviews INTEGER NOT NULL CHECK(pageviews >= 0),
  PRIMARY KEY(day,path,source,medium,campaign)
);
CREATE TABLE IF NOT EXISTS analytics_navigation_counts_v2 (
  day TEXT NOT NULL,
  from_path TEXT NOT NULL CHECK(from_path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster',
    '/articles/2026-11-15-how-i-made-my-game-3x-faster-by-moving-from-dart-to-java'
  )),
  to_path TEXT NOT NULL CHECK(to_path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster',
    '/articles/2026-11-15-how-i-made-my-game-3x-faster-by-moving-from-dart-to-java'
  )),
  navigations INTEGER NOT NULL CHECK(navigations >= 0),
  CHECK(from_path != to_path),
  PRIMARY KEY(day,from_path,to_path)
);
INSERT OR REPLACE INTO analytics_page_counts_v2(day,path,pageviews)
  SELECT day,path,pageviews FROM analytics_page_counts;
INSERT OR REPLACE INTO analytics_request_counts_v2(day,path,source,medium,campaign,pageviews)
  SELECT day,path,source,medium,campaign,pageviews FROM analytics_request_counts;
INSERT OR REPLACE INTO analytics_navigation_counts_v2(day,from_path,to_path,navigations)
  SELECT day,from_path,to_path,navigations FROM analytics_navigation_counts;
