import assert from 'node:assert/strict';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import {createWorker} from '../worker/index.js';

export const accessEnv = {
  ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
  ACCESS_AUD: 'test-analytics-audience',
  STATS_ALLOWED_EMAIL: 'admin@example.com',
};
export const issuer = `https://${accessEnv.ACCESS_TEAM_DOMAIN}`;
export async function signingKey(kid = 'fixture-key') {
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  return {privateKey, jwk: {...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig'}};
}
export async function sign(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({sub: 'test-user', email: accessEnv.STATS_ALLOWED_EMAIL,
    iss: issuer, aud: accessEnv.ACCESS_AUD, iat: now, exp: now + 3600, ...claims})
    .setProtectedHeader({alg: 'RS256', kid: key.jwk.kid, ...header}).sign(key.privateKey);
}
export async function fixture() {
  const key = await signingKey();
  const token = await sign(key);
  const worker = createWorker({fetchJWKS: async (url, options) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({keys: [key.jwk]});
  }});
  return {worker, key, token, headers: {'cf-access-jwt-assertion': token}};
}
