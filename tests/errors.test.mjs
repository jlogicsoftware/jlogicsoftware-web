import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {errorPage} from '../worker/errors.js';
import {createWorker} from '../worker/index.js';
import {accessEnv, fixture, sign} from './access-fixture.mjs';

const assetCalls = [];
const ASSETS = {async fetch(input) {
  const url = new URL(input);
  assetCalls.push(url);
  return new Response(readFileSync(new URL(`../${url.pathname.slice(1)}.html`, import.meta.url)), {
    headers: {'content-type': 'text/html; charset=utf-8'},
  });
}};
const DB = {prepare() {assert.fail('error pages must not read or write analytics');}};

test('real stats denials use public branded templates while preserving authentication and rate limits', async () => {
  const {worker, key} = await fixture();
  const request = (token) => new Request('https://jlogicsoftware.com/stats?untrusted=PRIVATE', {
    headers: token ? {'cf-access-jwt-assertion': token} : {},
  });
  const env = {...accessEnv, ASSETS, DB};
  const wrongAccount = await sign(key, {email: 'other@example.com'});
  for (const [response, status] of [
    [await worker.fetch(request(), env, {}), 401],
    [await worker.fetch(request(wrongAccount), env, {}), 403],
    [await worker.fetch(request(), {...env,STATS_LIMITER:{async limit(){return {success:false};}}}, {}), 429],
  ]) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('www-authenticate'), null);
    if (status === 429) assert.equal(response.headers.get('retry-after'), '60');
    const body = await response.text();
    assert.match(body, /class="site-header page-width"/);
    assert.match(body, /class="site-footer"/);
    assert.ok(body.includes(`${status}`));
    assert.ok(!body.includes('PRIVATE') && !body.includes('other@example.com'));
  }
  assert.deepEqual(assetCalls.splice(0).map(url=>url.pathname), ['/401','/403','/429']);
});

test('public error URLs retain the correct HTTP status, HEAD semantics and fixed template location', async () => {
  const worker = createWorker();
  for (const status of [401,403,404,429]) {
    for (const path of [`/${status}`,`/${status}.html`,`/${status}/`]) {
      const request = new Request('https://jlogicsoftware.com'+path+'?secret=PRIVATE');
      const response = await worker.fetch(request, {ASSETS,DB}, {});
      assert.equal(response.status, status);
      assert.ok(!(await response.text()).includes('PRIVATE'));
    }
    const head = await worker.fetch(new Request(`https://jlogicsoftware.com/${status}`,{method:'HEAD'}),{ASSETS,DB},{});
    assert.equal(head.status,status);
    assert.equal(await head.text(),'');
  }
  assert.ok(assetCalls.splice(0).every(url=>url.search==='' && /^\/(401|403|404|429)$/.test(url.pathname)));
});

test('template failure never changes the original denial, Retry-After or cache isolation', async () => {
  for (const fetch of [async()=>{throw new Error('unavailable');},async()=>new Response(null,{status:302,headers:{location:'https://other.example'}}),async()=>new Response('missing',{status:404})]) {
    const response = await errorPage(new Request('https://jlogicsoftware.com/stats'),{ASSETS:{fetch}},new Response('Too many requests',{status:429,headers:{'retry-after':'60'}}));
    assert.equal(response.status,429);
    assert.equal(response.headers.get('retry-after'),'60');
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(await response.text(),'Too many requests');
  }
});
