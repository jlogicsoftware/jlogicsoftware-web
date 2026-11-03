import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatsAuthorizer} from '../worker/access.js';
import {createWorker} from '../worker/index.js';
import {accessEnv, fixture, issuer, sign, signingKey} from './access-fixture.mjs';

const request = (token, headers = {}, path = '/stats', host = 'jlogicsoftware.com') =>
  new Request(`https://${host}${path}`, {headers: {...headers, ...(token ? {'cf-access-jwt-assertion': token} : {})}});
const key = await signingKey();
const authorizer = (fetchJWKS = async () => Response.json({keys: [key.jwk]})) => createStatsAuthorizer({fetchJWKS});

test('signed Access identity must have the configured issuer, audience, expiry, and exact email', async () => {
  const authorize = authorizer();
  assert.equal(await authorize(request(await sign(key)), accessEnv), null);
  assert.equal(await authorize(request(await sign(key, {aud: ['other', accessEnv.ACCESS_AUD]})), accessEnv), null);
  for (const claims of [
    {iss: 'https://attacker.example'}, {aud: 'another-app'}, {exp: 1}, {nbf: Math.floor(Date.now()/1000)+3600},
    {exp: undefined}, {iat: undefined}, {sub: undefined}, {email: undefined},
  ]) {
    const denial = await authorize(request(await sign(key, claims)), accessEnv);
    assert.equal(denial.status, 401, JSON.stringify(claims));
    assert.equal(denial.headers.get('www-authenticate'), null);
    assert.equal(denial.headers.get('cache-control'), 'no-store');
  }
  for (const email of ['someone@example.com', 'Admin@example.com', 'admin@example.com.attacker.example']) {
    assert.equal((await authorize(request(await sign(key, {email})), accessEnv)).status, 403);
  }
});

test('Basic credentials, identity headers, unsigned, tampered and wrong-key tokens fail closed', async () => {
  const authorize = authorizer();
  const headers = {authorization: 'Basic '+btoa('admin:secret'), 'cf-access-authenticated-user-email': accessEnv.STATS_ALLOWED_EMAIL};
  assert.equal((await authorize(request(null, headers), {...accessEnv, STATS_USER:'admin', STATS_PASS:'secret'})).status, 401);
  const valid = await sign(key);
  const [head, payload] = valid.split('.');
  const fake = Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+payload+'.';
  const changed = Buffer.from(JSON.stringify({email:accessEnv.STATS_ALLOWED_EMAIL, iss:issuer, aud:accessEnv.ACCESS_AUD, exp:9999999999})).toString('base64url');
  const otherKey = await signingKey(key.jwk.kid);
  for (const token of [fake, head+'.'+changed+'.'+valid.split('.')[2], await sign(otherKey), 'garbage', 'x'.repeat(16385)]) {
    assert.equal((await authorize(request(token, headers), accessEnv)).status, 401);
  }
});

test('missing or unsafe config fails closed without fetching any keys', async () => {
  const authorize = authorizer(async () => {assert.fail('must not fetch');});
  for (const config of [{}, {...accessEnv, ACCESS_TEAM_DOMAIN:''}, {...accessEnv, ACCESS_AUD:''}, {...accessEnv, STATS_ALLOWED_EMAIL:''},
    {...accessEnv, ACCESS_TEAM_DOMAIN:'https://test-team.cloudflareaccess.com'},
    {...accessEnv, ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com.attacker.example'},
    {...accessEnv, ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com/path'},
  ]) assert.equal((await authorize(request(await sign(key)),config)).status, 503);
});

test('JWKS URL is fixed by config and failure, redirect or invalid key set never authorizes', async () => {
  for (const fetcher of [async () => {throw new Error('network unavailable');},
    async () => new Response(null,{status:302,headers:{location:'https://attacker.example'}}),
    async () => Response.json({keys:[]}), async () => Response.json({keys:'wrong'}),
  ]) assert.equal((await authorizer(fetcher)(request(await sign(key)),accessEnv)).status, 401);
  let fetched = '';
  const authorize = authorizer(async url => {fetched=String(url);return Response.json({keys:[key.jwk]});});
  assert.equal((await authorize(request(await sign(key,{iss:'https://attacker.example'})),accessEnv)).status,401);
  assert.equal(fetched,issuer+'/cdn-cgi/access/certs');
});

test('JWKS cache limits repeat fetches and reloads on key rotation after cooldown', async (t) => {
  const rotated = await signingKey('rotated-key');
  let keys=[key.jwk], calls=0;
  const authorize=authorizer(async () => {calls++;return Response.json({keys});});
  const first=await sign(key), second=await sign(rotated);
  assert.equal(await authorize(request(first),accessEnv),null);
  assert.equal(await authorize(request(first),accessEnv),null);
  keys=[rotated.jwk];
  assert.equal((await authorize(request(second),accessEnv)).status,401);
  assert.equal(calls,1);
  t.mock.timers.enable({apis:['Date'],now:Date.now()+31000});
  assert.equal(await authorize(request(second),accessEnv),null);
  assert.equal(calls,2);
  assert.equal((await authorize(request(first),accessEnv)).status,401);
  t.mock.timers.reset();
});

test('all stats path variants authenticate before assets, including workers.dev; throttling stays separate', async () => {
  const {worker, headers} = await fixture();
  const env={...accessEnv,ASSETS:{fetch(url){assert.ok(['/401','/403','/429'].includes(new URL(url).pathname));return new Response('<h1>Request denied</h1>',{headers:{'content-type':'text/html'}});}},DB:{prepare(){assert.fail('unauthorized must not query data');}}};
  for (const path of ['/stats','/stats/','/stats/subpath','/stats.html','/STATS','/stats%2f']) {
    const denial=await worker.fetch(request(null,{},path),env,{});
    assert.equal(denial.status,401,path);
    assert.equal(denial.headers.get('www-authenticate'),null);
    assert.equal((await worker.fetch(request(null,{},path,'preview.example.workers.dev'),env,{})).status,401);
    if (path!=='/stats') assert.equal((await worker.fetch(request(headers['cf-access-jwt-assertion'],{},path),env,{})).status,308);
  }
  const configuredWorker=createWorker();
  const limited=await configuredWorker.fetch(request(null),{...env,STATS_LIMITER:{async limit(){return {success:false};}}},{});
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get('retry-after'),'60');
});
