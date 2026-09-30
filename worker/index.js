/**
 * Analytics for jlogicsoftware.com — cookieless, aggregate-only.
 *
 * Routes handled here; everything else falls through to the static assets.
 *   POST /api/collect   beacon endpoint
 *   GET  /stats         dashboard (HTTP Basic auth)
 *   GET  /articles/:slug  article page; title and link-preview tags come from articles/:slug.md
 *
 * Secrets (wrangler secret put ...):
 *   SALT        random string, seeds the daily visitor hash
 *   STATS_USER  dashboard username
 *   STATS_PASS  dashboard password
 */

const EVENT_NAMES = new Set(['pageview', 'cta_book_call', 'outbound']);
const RETENTION_DAYS = 400;

const BOT_RE = /bot|crawl|spider|slurp|headless|monitor|preview|curl|wget|lighthouse|pingdom|gtmetrix/i;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const deviceOf = (ua = '') => {
  if (/ipad|tablet|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(ua)) return 'mobile';
  return 'desktop';
};

/** Daily-rotating, non-reversible visitor identifier. Never persists the IP. */
const visitorHash = async (salt, day, ip, ua) => {
  const data = new TextEncoder().encode(`${salt}|${day}|${ip}|${ua}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// --- collect -----------------------------------------------------------------

const collect = async (request, env) => {
  const ua = request.headers.get('user-agent') || '';
  // Silently accept bot traffic without recording it — a 204 keeps the client quiet.
  if (BOT_RE.test(ua)) return new Response(null, { status: 204 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const name = String(body.name || '');
  if (!EVENT_NAMES.has(name)) return new Response('bad request', { status: 400 });

  const now = Date.now();
  const day = utcDay(now);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const hash = await visitorHash(env.SALT, day, ip, ua);

  const params = new URLSearchParams(String(body.query || ''));
  const referrerHost = hostOf(body.referrer || '');
  const utmSource = params.get('utm_source');
  // Self-referrals are direct visits, not an acquisition source.
  const selfRef = referrerHost === hostOf(request.url);
  const source = utmSource || (selfRef ? null : referrerHost) || 'direct';

  await env.DB.prepare(
    `INSERT INTO events
       (ts, day, visitor_hash, name, path, source, referrer_host, utm_medium, utm_campaign, country, device, target)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      now,
      day,
      hash,
      name,
      String(body.path || '/').slice(0, 200),
      source.slice(0, 100),
      selfRef ? null : referrerHost,
      params.get('utm_medium'),
      params.get('utm_campaign'),
      request.cf?.country || null,
      deviceOf(ua),
      body.target ? hostOf(body.target) : null
    )
    .run();

  return new Response(null, { status: 204 });
};

// --- dashboard ---------------------------------------------------------------

const authorized = (request, env) => {
  // Fail closed: an unset secret must never authorize an empty credential.
  if (!env.STATS_USER || !env.STATS_PASS) return false;

  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }

  const [user, ...rest] = decoded.split(':');
  return (
    timingSafeEqual(user, env.STATS_USER) && timingSafeEqual(rest.join(':'), env.STATS_PASS)
  );
};

const esc = (s) =>
  String(s ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const bar = (value, max) => `${max > 0 ? Math.round((value / max) * 100) : 0}%`;

const table = (title, rows, valueLabel = 'visitors') => {
  if (!rows.length) return `<section class="panel"><h2>${title}</h2><p class="empty">No data yet.</p></section>`;
  const max = Math.max(...rows.map((r) => r.value));
  const items = rows
    .map(
      (r) => `<li>
        <div class="row"><span class="label">${esc(r.label)}</span><span class="value">${r.value}</span></div>
        <div class="track"><div class="fill" style="width:${bar(r.value, max)}"></div></div>
      </li>`
    )
    .join('');
  return `<section class="panel"><h2>${title}<span class="unit">${valueLabel}</span></h2><ul class="bars">${items}</ul></section>`;
};

const dashboard = async (env, days) => {
  const since = utcDay(Date.now() - days * 86400000);
  const q = (sql) => env.DB.prepare(sql).bind(since).all();

  const [daily, totals, sources, campaigns, countries, devices, paths, outbound, conversions] =
    await Promise.all([
      q(`SELECT day, COUNT(DISTINCT visitor_hash) v, COUNT(*) pv
          FROM events WHERE name='pageview' AND day >= ? GROUP BY day ORDER BY day`),
      q(`SELECT COUNT(DISTINCT visitor_hash) v, COUNT(*) pv
          FROM events WHERE name='pageview' AND day >= ?`),
      q(`SELECT source label, COUNT(DISTINCT visitor_hash) value
          FROM events WHERE name='pageview' AND day >= ?
          GROUP BY source ORDER BY value DESC LIMIT 12`),
      q(`SELECT utm_campaign label, COUNT(DISTINCT visitor_hash) value
          FROM events WHERE name='pageview' AND day >= ? AND utm_campaign IS NOT NULL
          GROUP BY utm_campaign ORDER BY value DESC LIMIT 12`),
      q(`SELECT country label, COUNT(DISTINCT visitor_hash) value
          FROM events WHERE name='pageview' AND day >= ?
          GROUP BY country ORDER BY value DESC LIMIT 12`),
      q(`SELECT device label, COUNT(DISTINCT visitor_hash) value
          FROM events WHERE name='pageview' AND day >= ?
          GROUP BY device ORDER BY value DESC`),
      q(`SELECT path label, COUNT(*) value
          FROM events WHERE name='pageview' AND day >= ?
          GROUP BY path ORDER BY value DESC LIMIT 12`),
      q(`SELECT target label, COUNT(*) value
          FROM events WHERE name='outbound' AND day >= ? AND target IS NOT NULL
          GROUP BY target ORDER BY value DESC LIMIT 12`),
      q(`SELECT source,
                COUNT(DISTINCT CASE WHEN name='pageview'      THEN visitor_hash END) visitors,
                COUNT(DISTINCT CASE WHEN name='cta_book_call' THEN visitor_hash END) converted
          FROM events WHERE day >= ? GROUP BY source
          HAVING visitors > 0 ORDER BY converted DESC, visitors DESC LIMIT 12`),
    ]);

  const total = totals.results[0] || { v: 0, pv: 0 };
  const ctaTotal = conversions.results.reduce((n, r) => n + r.converted, 0);
  const rate = total.v > 0 ? ((ctaTotal / total.v) * 100).toFixed(1) : '0.0';
  const peak = Math.max(1, ...daily.results.map((d) => d.v));

  const spark = daily.results
    .map(
      (d) =>
        `<div class="day" title="${d.day}: ${d.v} visitors, ${d.pv} views">
           <div class="day__fill" style="height:${Math.round((d.v / peak) * 100)}%"></div>
         </div>`
    )
    .join('');

  const funnel = conversions.results
    .map(
      (r) => `<tr>
        <td>${esc(r.source)}</td>
        <td class="num">${r.visitors}</td>
        <td class="num">${r.converted}</td>
        <td class="num accent">${r.visitors ? ((r.converted / r.visitors) * 100).toFixed(1) : '0.0'}%</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Analytics | jLogic Software</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/stats.css">
</head>
<body>
<main class="stats container">
  <header class="stats__head">
    <h1>Analytics</h1>
    <nav class="stats__range">
      ${[7, 30, 90].map((d) => `<a href="/stats?days=${d}" class="${d === days ? 'is-active' : ''}">${d}d</a>`).join('')}
    </nav>
  </header>

  <div class="kpis">
    <div class="kpi"><p class="kpi__value">${total.v}</p><p class="kpi__label">Unique visitors</p></div>
    <div class="kpi"><p class="kpi__value">${total.pv}</p><p class="kpi__label">Page views</p></div>
    <div class="kpi"><p class="kpi__value accent">${ctaTotal}</p><p class="kpi__label">Book-a-Call clicks</p></div>
    <div class="kpi"><p class="kpi__value accent">${rate}%</p><p class="kpi__label">Conversion rate</p></div>
  </div>

  <section class="panel">
    <h2>Visitors per day<span class="unit">last ${days} days</span></h2>
    ${daily.results.length ? `<div class="chart">${spark}</div>` : '<p class="empty">No data yet.</p>'}
  </section>

  <section class="panel">
    <h2>Conversion by source<span class="unit">Book-a-Call</span></h2>
    ${
      funnel
        ? `<table class="funnel">
             <thead><tr><th>Source</th><th class="num">Visitors</th><th class="num">Clicks</th><th class="num">Rate</th></tr></thead>
             <tbody>${funnel}</tbody>
           </table>`
        : '<p class="empty">No data yet.</p>'
    }
  </section>

  <div class="grid">
    ${table('Traffic sources', sources.results)}
    ${table('Campaigns', campaigns.results)}
    ${table('Countries', countries.results)}
    ${table('Devices', devices.results)}
    ${table('Pages', paths.results, 'views')}
    ${table('Outbound clicks', outbound.results, 'clicks')}
  </div>

  <p class="stats__note">
    Cookieless. Visitor identifiers are salted hashes that rotate every UTC midnight;
    no IP addresses are stored. Events older than ${RETENTION_DAYS} days are deleted nightly.
  </p>
</main>
</body>
</html>`;
};

// --- articles ----------------------------------------------------------------

const ARTICLE_SLUG_RE = /^\/articles\/([a-z0-9-]+)\/?$/;

/**
 * Serves the static article shell with per-article <title> and Open Graph tags, so link
 * previews (LinkedIn, Slack, ...) work without executing JS. Body rendering stays client-side.
 */
const articlePage = async (request, env, slug) => {
  const origin = new URL(request.url).origin;
  const markdown = await env.ASSETS.fetch(new URL(`/articles/${slug}.md`, origin));
  if (!markdown.ok) return env.ASSETS.fetch(request);

  const title = ((await markdown.text()).match(/^#\s+(.+)$/m) || [])[1]?.trim();
  const shell = await env.ASSETS.fetch(new URL('/article', origin));
  if (!title) return shell;

  const set = (attr, value) => ({
    element: (el) => el.setAttribute(attr, value),
  });

  return new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(`${title} | jLogic Software`) })
    .on('meta[property="og:title"]', set('content', title))
    .on('meta[property="og:url"]', set('content', `${origin}/articles/${slug}`))
    .transform(shell);
};

// --- entrypoint --------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/collect') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      return collect(request, env);
    }

    if (url.pathname === '/stats') {
      // Throttle before authenticating, so guesses are capped per IP.
      const limiter = env.STATS_LIMITER;
      if (limiter) {
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const { success } = await limiter.limit({ key: ip });
        if (!success) {
          return new Response('Too many requests', {
            status: 429,
            headers: { 'retry-after': '60' },
          });
        }
      }

      if (!authorized(request, env)) {
        return new Response('Authentication required', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Analytics", charset="UTF-8"' },
        });
      }
      const days = [7, 30, 90].includes(Number(url.searchParams.get('days')))
        ? Number(url.searchParams.get('days'))
        : 30;
      return new Response(await dashboard(env, days), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const article = url.pathname.match(ARTICLE_SLUG_RE);
    if (article && request.method === 'GET') return articlePage(request, env, article[1]);

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    const cutoff = utcDay(Date.now() - RETENTION_DAYS * 86400000);
    await env.DB.prepare('DELETE FROM events WHERE day < ?').bind(cutoff).run();
  },
};
