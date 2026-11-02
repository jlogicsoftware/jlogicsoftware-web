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
              analytics.js (inert compatibility asset), article.js (markdown renderer),
              vendor/ (marked, MIT — vendored, no package manager)
worker/       Cloudflare Worker: server page counters and protected /stats dashboard
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

Local runs need `.dev.vars` (gitignored), using the actual Access application values
and permitted Google account. The values below are illustrative:

```
ACCESS_TEAM_DOMAIN="your-team.cloudflareaccess.com"
ACCESS_AUD="your-application-audience"
STATS_ALLOWED_EMAIL="admin@example.com"
```

## Analytics

The server records aggregate successful HTML page-request counts directly in
`analytics_page_counts(day, path, pageviews)` and
`analytics_request_counts(day, path, source, medium, campaign, pageviews)`. Eligible
requests atomically increment a total and a source/campaign bucket.
`analytics_navigation_counts(day, from_path, to_path, navigations)` also counts
ordinary same-origin referral transitions between distinct allowlisted pages, with
queries/fragments discarded. Page-request totals count repeats and refreshes. Page-pair counts describe the current
request’s referral, not exact clicks or individual journeys. There are no raw events,
contact-link clicks, conversions or visitor histories.

A separate daily visitor estimator uses Web Crypto HMAC-SHA-256 over the transient
Cloudflare-provided IP address and user-agent, with a fresh random 256-bit secret for
each UTC day. D1 stores the key in `analytics_daily_secrets(day, secret)` separately from
`analytics_daily_membership(day, code)`. The final daily total is stored in
`analytics_visitor_counts(day, visitors)`. New memberships increment one site-wide daily estimated-visitor
aggregate atomically. Membership contains no page/source/campaign/navigation/action
columns or individual event rows; it cannot reconstruct browsing histories. No code
is returned to the device or joined across days. Requests without a Cloudflare IP
still increment request counters but skip visitor estimation. This is an estimate:
shared IP/browser combinations can merge visitors and changes can split them.

Ordinary HTTP referral headers are reduced to fixed broad categories: google, facebook,
linkedin, github, youtube, bing, duckduckgo, internal, direct or otherexternal. Raw
referral URLs/hosts are not stored. Campaign parameters are accepted only through the
fixed shared campaign registry in `worker/campaigns.js`; unknown values are discarded.
Use the same registered link for everyone in a campaign, never per-recipient labels.
Do not add names, emails, account/session identifiers or advertising click IDs such as
`gclid`/`fbclid`. A shared campaign label identifies a campaign, not a person.

No analytics cookies, browser storage, pixels, scripts or extra browser requests are
used. The old `js/analytics.js` is an inert compatibility asset and is not embedded in
pages; `/api/collect` returns 410. Headers are inspected transiently to exclude GPC/DNT,
known bots and prefetches. Raw IP/user-agent values are not stored for analytics; daily codes only deduplicate
membership within the current day.
Delivery/security handling is separate, including legitimate IP-based abuse controls.
A private assessment maintained outside the public source covers GDPR balancing,
the separate PKE/ePrivacy question and production checks. Shared labels and aggregate output do not alone establish an
exemption from consent requirements for collecting information from a device.

All aggregate counter tables, including daily estimated visitors, retain 400 days,
expired by the 03:17 UTC daily cleanup. Old daily secrets and memberships are removed
during UTC day rotation and scheduled cleanup. There is no raw-event rollup. D1 recovery copies and Cloudflare infrastructure have separate
retention controls. Do not log visitor requests, bodies, headers or URLs for statistics;
Worker observability is disabled in this configuration.

Dashboard: `/stats` (Google sign-in through Cloudflare Access), with `?days=7|30|90`, showing page-request totals
and the sum of daily visitor estimates alongside aggregate day/page/source/campaign
and internal page-transition breakdowns. The sum is not a period-wide unique-visitor
count. Visitor estimates have no page or campaign attribution. Rate
limited to 10 requests/minute per IP before authentication; failed logins never reach D1. This protection does not
feed analytics.

When adding an article or page, update both `PAGE_PATHS` in `worker/analytics.js` and
`assets.run_worker_first` in `wrangler.jsonc`. Article markdown, index JSON, styles,
fonts, scripts and images remain on static asset routing. Only successful GET HTML
responses count; redirects, errors, HEAD and ordinary static assets do not.

### Fresh database setup

Run deployment operations only after the privacy assessment and deployment gate have
been reviewed. Creating/applying a schema does not deploy the new Worker.

```
npx wrangler d1 create jlogicsoftware-analytics  # copy its database_id into wrangler.jsonc
npx wrangler d1 execute jlogicsoftware-analytics --remote --file worker/schema.sql
```

### Existing legacy database migration

`worker/schema.sql` is additive and repeatable: it creates the separate
`analytics_page_counts`, `analytics_request_counts` and `analytics_navigation_counts`
tables plus the separate daily estimator tables, without reading, rewriting or deleting
prior analytics. The dashboard reads aggregate totals only, never daily membership or secrets. Applying it alone does **not** remove old personal data or make production match the new disclosure. Old data is not imported:
its visitor/click/attribution semantics differ from the new page-delivery counters.

1. Stop old collection so writes cannot race migration. Inspect existing database
   objects, exports, provider logs and recovery retention. Do not create another
   long-lived raw backup by default; record any retained copy and its deletion date.
2. Apply `worker/schema.sql` after review. Do not run the historical
   `worker/legacy-summary.sql`; its unique/click summaries are outside the chosen scope.
3. With explicit production authorization to discard old data, run
   `worker/legacy-retire.sql`. It removes old raw events, salts, detailed report objects
   and legacy summaries, while preserving the new counters. Confirm the retired
   objects are absent in `sqlite_master`. Review exports and D1 recovery copies
   separately; live-table deletion does not remove provider recovery history.
4. Remove the obsolete Worker `SALT` secret once the old Worker is no longer running.
   Remove manually embedded Cloudflare Web Analytics and dashboard-configured automatic
   injection. Verify actual production browser requests/storage after rollout.
5. Deploy the new Worker and matching disclosure together after migration and the
   operational checks in the private assessment maintained outside the public source. Verify opt-outs, protected reports,
   eligible routing and scheduled expiry. A restore must repeat old-data cleanup and
   current retention before collection/report access resumes.

Local development does not apply remote migrations, change production secrets or deploy.
Production operations require separate authorization.

### Local verification

Node 22.15+ includes the SQLite module used here (it may print an experimental notice):

```
npm ci
npm test
```

Tests execute the actual schema and Worker SQL on SQLite, covering fresh and legacy
schemas, aggregate counters, privacy headers, retired ingestion, bounded page dimensions,
retention and response isolation. Access tests cover signed identity, exact email
matching, token rejection, key rotation and protection of dashboard path variants.
Wrangler integration also needs an isolated local
D1 state; never point test fixtures at an existing production database.

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

Public-by-design identifiers (the D1 `database_id`)
are allowlisted in `.gitleaks.toml`. Bypass once with `SKIP_GITLEAKS=1 git commit`.

Real secrets belong in `wrangler secret put`, never in a file.

## Google sign-in for the dashboard

The Worker validates Cloudflare Access JWT signatures, issuer, application audience,
expiry and the exact permitted email before serving `/stats`. Basic credentials and
plain identity headers cannot authorize requests. Missing configuration keeps the
dashboard closed; this source change alone does not configure production Access.

1. In Cloudflare Zero Trust, configure the Google identity provider using its OAuth
   client credentials and the callback URL shown by Cloudflare.
2. Create a self-hosted Access application for `jlogicsoftware.com/stats` and its
   subpaths. Select Google as its only identity provider. Add an Allow policy for
   the exact permitted Google email, requiring the Google login method; do not add
   broad domain, public, bypass or alternative login policies.
3. Copy the account's actual team domain and the application's AUD into the Worker's
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` deployment variables. The team domain is the
   hostname only (for example, `your-team.cloudflareaccess.com`), without `https://`
   or a path. These values must come from the created application.
4. Set the permitted account privately with `npx wrangler secret put STATS_ALLOWED_EMAIL`.
   Keep its value out of public configuration, examples and test fixtures. For local
   development, put it in the ignored `.dev.vars` file.
5. After deployment, verify Google sign-in succeeds for the permitted account and
   another account is denied. Verify direct Worker URLs and dashboard path variants
   cannot bypass signature verification. Remove obsolete `STATS_USER` and
   `STATS_PASS` secrets after the new deployment is verified.

The Worker keeps the dashboard rate limit separate from authentication and verifies
Access tokens even when a request reaches it through an alternate hostname. Local
verification uses generated signing keys and synthetic email addresses; a local
browser visit without a valid Access token remains denied.
