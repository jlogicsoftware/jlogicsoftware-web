import {createRemoteJWKSet, customFetch, jwtVerify} from 'jose';

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const denied = (status, message) => new Response(message, {
  status,
  headers: {'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8'},
});

// The fetch override is a code-only test seam, never a request or env binding.
export function createStatsAuthorizer({fetchJWKS} = {}) {
  // Only public signing keys are cached. No token, email or request is retained.
  let cachedIssuer;
  let cachedKeys;
  return async (request, env) => {
    const domain = env.ACCESS_TEAM_DOMAIN;
    const audience = env.ACCESS_AUD;
    const email = env.STATS_ALLOWED_EMAIL;
    if (typeof domain !== 'string' || !TEAM_DOMAIN.test(domain) ||
        typeof audience !== 'string' || !audience.trim() ||
        typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return denied(503, 'Analytics sign-in is not configured');
    }

    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token || token.length > 16384) return denied(401, 'Authentication required');
    const issuer = `https://${domain}`;
    if (cachedIssuer !== issuer) {
      // Both issuer and JWKS location come exclusively from trusted deployment config.
      cachedKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
        cacheMaxAge: 600000,
        ...(fetchJWKS ? {[customFetch]: fetchJWKS} : {}),
      });
      cachedIssuer = issuer;
    }
    try {
      const {payload} = await jwtVerify(token, cachedKeys, {
        issuer,
        audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email'],
      });
      // Plain identity headers and Basic credentials never participate in authorization.
      if (payload.email !== email) return denied(403, 'Access denied');
      return null;
    } catch {
      // Invalid tokens and unavailable signing keys both fail closed, without logging identity.
      return denied(401, 'Authentication required');
    }
  };
}
