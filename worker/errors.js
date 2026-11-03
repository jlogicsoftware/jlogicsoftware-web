const PAGES = new Set([401, 403, 404, 429]);

// Fetch only our fixed public templates. Never forward identity, query strings,
// or an attacker-controlled pathname into the error page or its asset request.
export async function errorPage(request, env, response) {
  if (!PAGES.has(response.status)) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex, nofollow');
  if (request.method === 'HEAD') {
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(null, {status: response.status, headers});
  }
  try {
    const page = await env.ASSETS.fetch(new URL(`/${response.status}`, request.url));
    if (page.ok && page.headers.get('content-type')?.includes('text/html')) {
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(page.body, {status: response.status, headers});
    }
    await page.body?.cancel();
  } catch {
    // A missing template must never turn an authentication denial into success.
  }
  return new Response(response.body, {status: response.status, headers});
}
