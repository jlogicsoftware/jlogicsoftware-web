-- Analytics events. No IP addresses, no cookies, no cross-day identifiers.
--
-- visitor_hash = SHA-256(daily_salt + ip + user-agent), truncated to 128 bits.
-- The salt rotates every UTC midnight, so the same person on two different days
-- produces two unrelated hashes. The raw IP is never written anywhere.

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,  -- unix millis
  day           TEXT    NOT NULL,  -- YYYY-MM-DD, UTC
  visitor_hash  TEXT    NOT NULL,
  name          TEXT    NOT NULL,  -- pageview | cta_book_call | outbound
  path          TEXT,
  source        TEXT,              -- utm_source, else referrer host, else 'direct'
  referrer_host TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  country       TEXT,              -- two-letter, from Cloudflare edge
  device        TEXT,              -- desktop | mobile | tablet
  target        TEXT               -- outbound destination host
);

CREATE INDEX IF NOT EXISTS idx_events_day       ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_day_name  ON events (day, name);
CREATE INDEX IF NOT EXISTS idx_events_source    ON events (day, source);
