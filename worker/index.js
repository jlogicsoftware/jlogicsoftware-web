import {collect,countablePath,defer,record,rollup,utcDay} from './analytics.js';
import {createStatsAuthorizer} from './access.js';
import {errorPage} from './errors.js';

const esc = (s) =>
  String(s ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const bar = (value, max) => `${max > 0 ? Math.round((value / max) * 100) : 0}%`;

const table = (title, rows, valueLabel = 'views') => {
  if (!rows.length) return `<section class="panel"><h2>${esc(title)}</h2><p class="empty">No data yet.</p></section>`;
  const max = Math.max(...rows.map((r) => r.value));
  const items = rows
    .map(
      (r) => `<li>
        <div class="row"><span class="label">${esc(r.label)}</span><span class="value">${esc(r.value)}</span></div>
        <div class="track"><div class="fill" style="width:${bar(r.value, max)}"></div></div>
      </li>`
    )
    .join('');
  return `<section class="panel"><h2>${esc(title)}<span class="unit">${esc(valueLabel)}</span></h2><ul class="bars">${items}</ul></section>`;
};

const detailTable = (title, headings, rows) => `<section class="panel"><h2>${esc(title)}</h2>${rows.length
  ? `<table class="funnel"><thead><tr>${headings.map((label) => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((value) => `<td>${esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="empty">No data yet.</p>'}</section>`;

const dashboard = async (env, days) => {
  const since = utcDay(Date.now() - (days - 1) * 86400000);
  const [pageResult, dailyResult, dayPageResult, sourceResult, campaignResult, coverageResult, navigationResult, dailySourceResult, visitorResult] = await Promise.all([
    env.DB.prepare(`SELECT path label,SUM(pageviews) value FROM analytics_page_counts
      WHERE day >= ? GROUP BY path ORDER BY value DESC,path LIMIT 100`).bind(since).all(),
    env.DB.prepare(`SELECT day,SUM(pageviews) pageviews FROM analytics_page_counts
      WHERE day >= ? GROUP BY day ORDER BY day DESC LIMIT 90`).bind(since).all(),
    env.DB.prepare(`SELECT day,path,SUM(pageviews) pageviews FROM analytics_page_counts
      WHERE day >= ? GROUP BY day,path ORDER BY day DESC,pageviews DESC,path LIMIT 1000`).bind(since).all(),
    env.DB.prepare(`SELECT source label,SUM(pageviews) value FROM analytics_request_counts
      WHERE day >= ? GROUP BY source ORDER BY value DESC,source LIMIT 100`).bind(since).all(),
    env.DB.prepare(`SELECT day,source,medium,campaign,path,SUM(pageviews) pageviews FROM analytics_request_counts
      WHERE day >= ? AND (medium <> '' OR campaign <> '') GROUP BY day,source,medium,campaign,path
      ORDER BY pageviews DESC,day DESC,source,medium,campaign,path LIMIT 100`).bind(since).all(),
    env.DB.prepare(`SELECT MIN(day) first_day,COALESCE(SUM(pageviews),0) pageviews FROM analytics_request_counts
      WHERE day >= ?`).bind(since).all(),
    env.DB.prepare(`SELECT day,from_path,to_path,SUM(navigations) navigations FROM analytics_navigation_counts
      WHERE day >= ? GROUP BY day,from_path,to_path ORDER BY navigations DESC,day DESC,from_path,to_path LIMIT 100`).bind(since).all(),
    env.DB.prepare(`SELECT day,source,SUM(pageviews) pageviews FROM analytics_request_counts
      WHERE day >= ? GROUP BY day,source ORDER BY day DESC,pageviews DESC,source LIMIT 2000`).bind(since).all(),
    env.DB.prepare(`SELECT day,visitors FROM analytics_visitor_counts
      WHERE day >= ? ORDER BY day DESC LIMIT 90`).bind(since).all(),
  ]);
  const pages = pageResult.results;
  const daily = dailyResult.results;
  const coverage = coverageResult.results[0];
  const total = daily.reduce((sum, day) => sum + day.pageviews, 0);
  const visitorTotal = visitorResult.results.reduce((sum, row) => sum + row.visitors, 0);
  const visitorDays = new Map(visitorResult.results.map(row => [row.day, row.visitors]));
  const visitorTable = detailTable('Daily visitor estimates (UTC)', ['Day', 'Estimated visitors'], daily.map(row => [row.day, visitorDays.get(row.day) ?? 'Not measured']));
  const dailyTable = detailTable('UTC daily totals', ['Day', 'Page views'], daily.map((r) => [r.day, r.pageviews]));
  const dayPageTable = detailTable('Pages by UTC day', ['Day', 'Page', 'Page views'], dayPageResult.results.map((r) => [r.day, r.path, r.pageviews]));
  const campaignTable = detailTable('Campaign-tagged page views by UTC day · top 100', ['Day', 'Source', 'Medium', 'Campaign', 'Landing page', 'Page views'], campaignResult.results.map((r) => [r.day, r.source, r.medium || 'No approved medium', r.campaign || 'No approved campaign', r.path, r.pageviews]));
  const navigationTable = detailTable('Internal page transitions by UTC day · top 100', ['Day', 'From page', 'To page', 'Transitions'], navigationResult.results.map((r) => [r.day, r.from_path, r.to_path, r.navigations]));
  const dailySourceTable = detailTable('Sources by UTC day', ['Day', 'Source', 'Page views'], dailySourceResult.results.map((r) => [r.day, r.source, r.pageviews]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Analytics | jLogic Software</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/stats.css"></head><body><main class="stats container">
  <header class="stats__head"><h1>Analytics</h1><nav class="stats__range">${[7,30,90].map((d) => `<a href="/stats?days=${d}" class="${d===days?'is-active':''}">${d}d</a>`).join('')}</nav></header>
  <div class="kpis"><div class="kpi"><p class="kpi__value">${esc(total)}</p><p class="kpi__label">Page views</p></div><div class="kpi"><p class="kpi__value">${esc(coverage.pageviews)}</p><p class="kpi__label">Page views with source details</p></div><div class="kpi"><p class="kpi__value">${esc(visitorTotal)}</p><p class="kpi__label">Sum of daily visitor estimates</p></div></div>
  <p class="stats__intro">Successful page deliveries in the last ${days} UTC calendar days, including today. These are request counts: reloads count again, so they do not measure unique people.</p>
  ${visitorTable}<p class="stats__intro">The sum covers ${visitorResult.results.length} measured UTC days in this range; days without an estimate show Not measured. It adds each measured UTC day's estimate; it is not a count of unique visitors across the selected period. A daily estimate deduplicates the same edge IP address and User-Agent using a fresh random daily secret. Shared addresses and browser settings can merge people; changed addresses or browsers can split one person. Requests without an edge IP are omitted from this estimate. Older page totals have no retroactive visitor estimate. No sessions, returning people or individual journeys are measured.</p>
  ${dailyTable}${table('Pages', pages)}${dayPageTable}
  <section class="panel"><h2>Source and campaign coverage</h2><p>${coverage.first_day ? `Source details in this range begin on ${esc(coverage.first_day)}.` : 'No source details have been recorded in this range yet.'} Older page-only totals remain in the daily and page reports; they are not assigned a source or campaign.</p><p>Source uses an approved campaign source tag when available, otherwise a broad referring-site category. Direct means no usable external referring site was available; it does not prove someone typed the address. Source-only tags appear in Sources. Campaign rows below require an approved medium or campaign tag and count deliveries to the listed landing page, including reloads.</p></section>
  ${table('Sources', sourceResult.results)}${dailySourceTable}${campaignTable}
  ${navigationTable}<p class="stats__intro">Internal transitions count page requests that name a different public page on this site as their referring page. They are not literal click counts or a journey traced to one person. Missing referrer information is not counted; email and outbound-link actions are not measured.</p>
  <section class="panel"><h2>Make a campaign link</h2><p>Choose the page you want to promote, then append these approved tags. For example, copy this link for a Facebook mentoring campaign:</p><p><code class="campaign-link">https://jlogicsoftware.com/?utm_source=facebook&amp;utm_medium=paid_social&amp;utm_campaign=mentoring</code></p><p>Use the same tags consistently across each campaign. New tag values must first be added to the approved registry in <code>worker/campaigns.js</code>; other values are discarded. This example appears in the report only after someone requests the page.</p></section>
  <p class="stats__note">GPC/DNT requests, recognized bots and prefetches are excluded. Aggregates are retained for 400 days. Daily pseudonymous codes are held only in an isolated day-and-code membership set, never attached to pages, sources, campaigns or transitions. Prior-day secrets and membership are deleted by request cleanup and the daily cron; provider backups have separate retention. No raw IP addresses, User-Agents, referrer URLs or arbitrary campaign values are saved. Clicks and conversions are not collected, and source counts cannot be used to calculate source-to-click conversion rates. Retired visitor-based analytics are excluded.</p></main></body></html>`;
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

  const index = await env.ASSETS.fetch(new URL('/articles/index.json', origin));
  const articles = index.ok ? await index.json() : [];
  const article = articles.find((entry) => entry.slug === slug);
  const canonical = `https://jlogicsoftware.com/articles/${slug}`;
  const description = article?.description || `An engineering article by Anatolii Merezhanyi: ${title}`;
  const image = new URL(article?.image || '/images/social-portrait.jpg', 'https://jlogicsoftware.com').href;
  const imageAlt = article?.imageAlt || 'Anatolii Merezhanyi, software engineer and developer mentor';
  const set = (attr, value) => ({
    element: (el) => el.setAttribute(attr, value),
  });

  return new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(`${title} | jLogic Software`) })
    .on('link[rel="canonical"]', set('href', canonical))
    .on('meta[name="description"]', set('content', description))
    .on('meta[property="og:title"], meta[name="twitter:title"]', set('content', title))
    .on('meta[property="og:description"], meta[name="twitter:description"]', set('content', description))
    .on('meta[property="og:url"]', set('content', canonical))
    .on('meta[property="og:image"], meta[name="twitter:image"]', set('content', image))
    .on('meta[property="og:image:alt"], meta[name="twitter:image:alt"]', set('content', imageAlt))
    .on('meta[property="og:image:width"]', set('content', String(article?.imageWidth || 960)))
    .on('meta[property="og:image:height"]', set('content', String(article?.imageHeight || 1280)))
    .on('meta[name="twitter:card"]', set('content', article?.image ? 'summary_large_image' : 'summary'))
    .transform(shell);
};

export function createWorker(options) {
  const authorizeStats = createStatsAuthorizer(options);
  return {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const error = url.pathname.match(/^\/(401|403|404|429)(?:\.html)?\/?$/);
    if (error && (request.method === 'GET' || request.method === 'HEAD')) {
      const status = Number(error[1]);
      return errorPage(request, env, new Response('Request could not be completed', {
        status,
        headers: {'content-type': 'text/plain; charset=utf-8', ...(status === 429 ? {'retry-after': '60'} : {})},
      }));
    }

    if (url.pathname === '/api/collect') {
      return collect();
    }

    if (/^\/stats(?:$|[/.])/i.test(decodeURIComponent(url.pathname))) {
      // Keep request throttling separate from identity verification.
      const limiter = env.STATS_LIMITER;
      if (limiter) {
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const { success } = await limiter.limit({ key: ip });
        if (!success) {
          return errorPage(request, env, new Response('Too many requests', {
            status: 429,
            headers: { 'retry-after': '60' },
          }));
        }
      }

      const denial = await authorizeStats(request, env);
      if (denial) return errorPage(request, env, denial);
      if (url.pathname !== '/stats') {
        return new Response(null, {status: 308, headers: {location: '/stats' + url.search, 'cache-control': 'no-store'}});
      }
      const days = [7, 30, 90].includes(Number(url.searchParams.get('days')))
        ? Number(url.searchParams.get('days'))
        : 30;
      return new Response(await dashboard(env, days), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const article = url.pathname.match(ARTICLE_SLUG_RE);
    const response = article && request.method === 'GET'
      ? await articlePage(request, env, article[1])
      : await env.ASSETS.fetch(request);
    if (countablePath(request, response)) {
      defer(ctx, record(request, env, response));
    }
    return response;
  },

  async scheduled(event, env) {
    await rollup(env);
  },
  };
}

export default createWorker();
