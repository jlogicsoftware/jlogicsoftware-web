// Aggregate deliveries plus an isolated, daily pseudonymous visitor estimate.
import {CAMPAIGN_LABELS} from './campaigns.js';
export const PAGE_PATHS = new Set([
  '/', '/about', '/development', '/privacy', '/articles',
  '/articles/2026-09-18-how-i-made-bugeater-3x-faster',
]);
const BOT_RE = /bot|crawl|spider|slurp|headless|monitor|preview|curl|wget|lighthouse|pingdom|gtmetrix/i;
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const canonicalPath = (path) => {
  const clean = path.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  const canonical = clean === '/index' ? '/' : clean;
  return PAGE_PATHS.has(canonical) ? canonical : null;
};
// User-Agent is inspected transiently only to exclude obvious automated delivery.
export const eligible = (request) => Boolean(request.headers.get('user-agent')?.trim()) &&
  !/prefetch|prerender/i.test(`${request.headers.get('sec-purpose') || ''} ${request.headers.get('purpose') || ''}`) &&
  request.headers.get('sec-gpc') !== '1' && request.headers.get('dnt') !== '1' &&
  !BOT_RE.test(request.headers.get('user-agent') || '');
export const countablePath = (request, response) => request.method === 'GET' &&
  response.status === 200 && /^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '') &&
  eligible(request) ? canonicalPath(new URL(request.url).pathname) : null;
const silentFailure = () => { console.error('analytics_write_failed'); };
export const defer = (ctx, operation) => ctx.waitUntil(operation.catch(silentFailure));

// Only these coarse classes survive classification; never persist a host or URL.
const REFERRER_HOSTS = Object.freeze({
  google: ['google.com', 'google.co.uk', 'google.pl', 'google.de', 'google.fr', 'google.com.ua'],
  facebook: ['facebook.com', 'fb.com'], linkedin: ['linkedin.com'],
  github: ['github.com'], youtube: ['youtube.com', 'youtu.be'],
  bing: ['bing.com'], duckduckgo: ['duckduckgo.com'],
});
export function referralSource(request) {
  const raw = request.headers.get('referer');
  if (!raw) return 'direct';
  try {
    const referral = new URL(raw);
    if (!['http:', 'https:'].includes(referral.protocol)) return 'otherexternal';
    const host = referral.hostname;
    if (referral.origin === new URL(request.url).origin ||
        host === 'jlogicsoftware.com' || host === 'www.jlogicsoftware.com') return 'internal';
    for (const [source, hosts] of Object.entries(REFERRER_HOSTS)) {
      if (hosts.some(known => host === known || host.endsWith('.' + known))) return source;
    }
  } catch { /* Malformed headers carry no useful source category. */ }
  return 'otherexternal';
}
export function attribution(request) {
  const params = new URL(request.url).searchParams;
  // Exact shared tokens only. Unknown values, duplicate labels and all click IDs
  // are discarded rather than normalized into an open-ended dimension.
  const label = (key) => {
    const values = params.getAll('utm_' + key);
    return values.length === 1 && CAMPAIGN_LABELS[key].includes(values[0]) ? values[0] : '';
  };
  return {source: label('source') || referralSource(request), medium: label('medium'), campaign: label('campaign')};
}

// An ordinary same-origin HTML transition, without a visitor history or beacon.
export function navigationFrom(request, toPath) {
  try {
    const referral = new URL(request.headers.get('referer'));
    if (referral.origin !== new URL(request.url).origin) return null;
    const fromPath = canonicalPath(referral.pathname);
    return fromPath && fromPath !== toPath ? fromPath : null;
  } catch { return null; }
}

const hex = (bytes) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const ephemeralCleanup = (db) => [
  db.prepare("DELETE FROM analytics_daily_membership WHERE day <> date('now')"),
  db.prepare("DELETE FROM analytics_daily_secrets WHERE day <> date('now')"),
];

async function dailyPseudonym(request, env, day) {
  // Only the edge-provided address is used; never trust X-Forwarded-For.
  const ip = request.headers.get('cf-connecting-ip')?.trim();
  if (!ip) return null;
  const candidate = hex(crypto.getRandomValues(new Uint8Array(32)));
  // Concurrent first requests use the same winning random key. SQL's clock
  // prevents an in-flight yesterday request recreating a retired secret.
  const results = await env.DB.batch([
    ...ephemeralCleanup(env.DB),
    env.DB.prepare(`INSERT INTO analytics_daily_secrets(day,secret)
      SELECT ?,? WHERE ? = date('now') ON CONFLICT(day) DO NOTHING`).bind(day, candidate, day),
    env.DB.prepare("SELECT secret FROM analytics_daily_secrets WHERE day = ? AND day = date('now')").bind(day),
  ]);
  const secret = results.at(-1).results[0]?.secret;
  if (!secret) return null;
  const bytes = Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', bytes, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const message = new TextEncoder().encode(JSON.stringify([ip, (request.headers.get('user-agent') || '').slice(0, 1024)]));
  const code = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
  return {code, secret};
}

export async function record(request, env, response, now = Date.now()) {
  const path = countablePath(request, response);
  if (!path) return;
  const day = utcDay(now);
  const {source, medium, campaign} = attribution(request);
  const pseudonym = await dailyPseudonym(request, env, day);
  // D1 serializes this transaction: membership is checked before incrementing
  // the isolated estimate, then inserted. No code enters any page/source table.
  const statements = [
    ...ephemeralCleanup(env.DB),
    env.DB.prepare(`INSERT INTO analytics_page_counts(day,path,pageviews) VALUES(?,?,1)
      ON CONFLICT(day,path) DO UPDATE SET pageviews=pageviews+1`).bind(day, path),
    env.DB.prepare(`INSERT INTO analytics_request_counts(day,path,source,medium,campaign,pageviews)
      VALUES(?,?,?,?,?,1) ON CONFLICT(day,path,source,medium,campaign)
      DO UPDATE SET pageviews=pageviews+1`).bind(day, path, source, medium, campaign),
  ];
  const fromPath = navigationFrom(request, path);
  if (fromPath) statements.push(env.DB.prepare(`INSERT INTO analytics_navigation_counts(day,from_path,to_path,navigations)
    VALUES(?,?,?,1) ON CONFLICT(day,from_path,to_path)
    DO UPDATE SET navigations=navigations+1`).bind(day, fromPath, path));
  if (pseudonym) {
    const {code, secret} = pseudonym;
    // Match the current key as well as SQL's day: a delayed request cannot
    // repopulate expired membership or increment yesterday after midnight.
    statements.push(
      env.DB.prepare(`INSERT INTO analytics_visitor_counts(day,visitors)
        SELECT ?,1 WHERE ? = date('now')
        AND EXISTS (SELECT 1 FROM analytics_daily_secrets WHERE day = ? AND secret = ?)
        AND NOT EXISTS (SELECT 1 FROM analytics_daily_membership WHERE day = ? AND code = ?)
        ON CONFLICT(day) DO UPDATE SET visitors=visitors+1`).bind(day, day, day, secret, day, code),
      env.DB.prepare(`INSERT INTO analytics_daily_membership(day,code)
        SELECT ?,? WHERE ? = date('now')
        AND EXISTS (SELECT 1 FROM analytics_daily_secrets WHERE day = ? AND secret = ?)
        ON CONFLICT(day,code) DO NOTHING`).bind(day, code, day, day, secret),
    );
  }
  await env.DB.batch(statements);
}

export const collect = () => new Response('Analytics collector retired', {
  status: 410, headers: {'cache-control': 'no-store'},
});

export async function rollup(env, now = Date.now()) {
  // SQL-clock expiry also runs on requests, so a missed cron cannot retain
  // yesterday's membership once new-day traffic arrives. Provider backups
  // have a separate retention lifecycle; live deletion is not backup erasure.
  const oldest = utcDay(now - 399 * 86400000);
  await env.DB.batch([
    ...ephemeralCleanup(env.DB),
    env.DB.prepare('DELETE FROM analytics_visitor_counts WHERE day < ?').bind(oldest),
    env.DB.prepare('DELETE FROM analytics_page_counts WHERE day < ?').bind(oldest),
    env.DB.prepare('DELETE FROM analytics_request_counts WHERE day < ?').bind(oldest),
    env.DB.prepare('DELETE FROM analytics_navigation_counts WHERE day < ?').bind(oldest),
  ]);
}
