-- Additive analytics schema. Never reads/imports v1 or v2 analytics.
-- Existing identifier-bearing tables require explicit owner-approved retirement.
CREATE TABLE IF NOT EXISTS analytics_page_counts (
  day TEXT NOT NULL,
  path TEXT NOT NULL CHECK(path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster'
  )),
  pageviews INTEGER NOT NULL CHECK(pageviews >= 0),
  PRIMARY KEY(day,path)
);

-- New source/campaign dimensions start empty: existing page totals stay intact.
-- One daily aggregate per fixed page and shared category combination, not an
-- event log. No visitor/session IDs, IPs, raw referrers or request timestamps.
CREATE TABLE IF NOT EXISTS analytics_request_counts (
  day TEXT NOT NULL,
  path TEXT NOT NULL CHECK(path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster'
  )),
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  campaign TEXT NOT NULL,
  pageviews INTEGER NOT NULL CHECK(pageviews >= 0),
  PRIMARY KEY(day,path,source,medium,campaign)
);

-- Natural same-origin HTML transitions, not exact clicks or unique visitors.
CREATE TABLE IF NOT EXISTS analytics_navigation_counts (
  day TEXT NOT NULL,
  from_path TEXT NOT NULL CHECK(from_path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster'
  )),
  to_path TEXT NOT NULL CHECK(to_path IN (
    '/', '/about', '/development', '/privacy', '/articles',
    '/articles/2026-09-18-how-i-made-bugeater-3x-faster'
  )),
  navigations INTEGER NOT NULL CHECK(navigations >= 0),
  CHECK(from_path != to_path),
  PRIMARY KEY(day,from_path,to_path)
);

-- Isolated daily estimate: never attach these codes to pages, sources or actions.
-- Random 256-bit HMAC key, freshly generated per UTC day, not a permanent salt.
CREATE TABLE IF NOT EXISTS analytics_daily_secrets (
  day TEXT PRIMARY KEY NOT NULL,
  secret TEXT NOT NULL CHECK(length(secret) = 64)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS analytics_daily_membership (
  day TEXT NOT NULL,
  code TEXT NOT NULL CHECK(length(code) = 64),
  PRIMARY KEY(day,code)
) WITHOUT ROWID;
-- The only visitor result retained after daily secret/membership expiry.
CREATE TABLE IF NOT EXISTS analytics_visitor_counts (
  day TEXT PRIMARY KEY NOT NULL,
  visitors INTEGER NOT NULL CHECK(visitors >= 0)
) WITHOUT ROWID;
