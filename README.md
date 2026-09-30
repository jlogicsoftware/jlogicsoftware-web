# jLogic Software — website

Static site plus a small analytics Worker. No build step, no framework — plain HTML, CSS, and JS.

## Structure

```
index.html    single page, all sections
privacy.html  privacy policy
article.html  shell for article pages; served by the Worker at /articles/<slug>
articles.html article index at /articles, built from articles/index.json (add an entry per article)
articles/     long-form articles as markdown, rendered client-side by js/article.js;
              the file name's YYYY-MM-DD prefix is the publication date
css/          one stylesheet per section, plus tokens.css (design tokens) and base.css (reset/typography)
js/           navbar.js (scroll/menu behavior), github-stats.js (live GitHub stats),
              analytics.js (cookieless analytics beacon), article.js (markdown renderer),
              vendor/ (marked, MIT — vendored, no package manager)
worker/       Cloudflare Worker: /api/collect endpoint and /stats dashboard
assets/       icon sprite (SVG)
fonts/        self-hosted Geist / Geist Mono
images/       page images
```

The assets directory is the repo root, so anything not meant to be served publicly
must be listed in `.assetsignore`.

## Run locally

Static pages only:

```
python3 -m http.server 8080
```

With the Worker and a local D1 database:

```
npx wrangler d1 execute jlogicsoftware-analytics --local --file worker/schema.sql
npx wrangler dev
```

Local runs need `.dev.vars` (gitignored):

```
SALT="any-random-string"
STATS_USER="admin"
STATS_PASS="local"
```

## Analytics

First-party, cookieless, aggregate-only — see `privacy.html` for what is recorded.
Visitor identifiers are `SHA-256(salt + ip + user-agent)`; the salt rotates every UTC
midnight and the IP is never stored. A nightly cron deletes events older than 400 days.

Dashboard: `/stats` (HTTP Basic auth), with `?days=7|30|90`. Rate limited to 10
requests/minute per IP, checked before authentication. Failed logins never reach D1.

### One-time setup

```
npx wrangler d1 create jlogicsoftware-analytics          # copy database_id into wrangler.jsonc
npx wrangler d1 execute jlogicsoftware-analytics --remote --file worker/schema.sql

npx wrangler secret put SALT                     # long random string, never rotate manually
npx wrangler secret put STATS_USER
npx wrangler secret put STATS_PASS
```

## Deploy

```
npx wrangler deploy
```

## Secret scanning

This repo is public, so a pushed secret is permanent. A pre-commit hook blocks
commits containing secrets, and fails closed if `gitleaks` is missing.

Enable it on each clone — `core.hooksPath` is local config and is not cloned:

```
brew install gitleaks
git config core.hooksPath .githooks
```

Public-by-design identifiers (the Cloudflare beacon token, the D1 `database_id`)
are allowlisted in `.gitleaks.toml`. Bypass once with `SKIP_GITLEAKS=1 git commit`.

Real secrets belong in `wrangler secret put`, never in a file.

## Follow-ups

Neither is urgent — notes for when the triggers below are hit.

### Move `/stats` behind Cloudflare Access

Replaces the shared Basic-auth password with email OTP or Google SSO. Free on the Zero
Trust plan (up to 50 users; this needs 1). Access blocks unauthenticated requests at the
edge, before the Worker runs.

Net effect is *less* code to own — `authorized()`, `timingSafeEqual()`, the `STATS_USER`
and `STATS_PASS` secrets, and probably the rate limiter can all be deleted. Also gains
revocation without redeploying, and a login audit trail (24h retention on the free plan).

Setup: Zero Trust dashboard → Access → Applications → self-hosted app on
`jlogicsoftware.com/stats`, policy allowing your email. Add a service token if
programmatic access is ever needed.

*Trigger: whenever there's a quiet 20 minutes. Do it as a standalone change, after
analytics is confirmed working end to end.*

### Add a daily rollup table

The dashboard runs 9 queries that each scan every event row in the selected range, so
D1 rows-read scales with traffic × range. At ~60 events/day this allows roughly 300
dashboard loads/day against the 5M rows/day free quota; at ~1,000 events/day on the
90-day view it drops to roughly 18.

Fix: have the existing nightly cron aggregate the previous day into a `daily_stats`
table and point the dashboard at that — around 100x fewer rows read. Deliberately not
done up front, since it would lock in today's set of dimensions.

*Trigger: D1 quota errors in `wrangler tail`, or sustained traffic above ~500
events/day.*
