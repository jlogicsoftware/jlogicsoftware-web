import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import worker from '../worker/index.js';
import {accessEnv, fixture} from './access-fixture.mjs';
const signedAccess = await fixture();
const statsWorker = signedAccess.worker;
import {attribution, canonicalPath, collect, record, referralSource, rollup, utcDay} from '../worker/analytics.js';

const file = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
function database(legacy = false) {
  const db = new DatabaseSync(':memory:');
  let clock = Date.now();
  db.function('date', (value) => {assert.equal(value,'now');return utcDay(clock);});
  if (legacy) db.exec(`CREATE TABLE events (visitor_hash TEXT); INSERT INTO events VALUES('PRIVATE');
    CREATE TABLE analytics_salts (salt TEXT); INSERT INTO analytics_salts VALUES('PRIVATE');
    CREATE TABLE analytics_events (visitor_hash TEXT); INSERT INTO analytics_events VALUES('PRIVATE');
    CREATE TABLE analytics_daily (visitors INTEGER); INSERT INTO analytics_daily VALUES(999);
    CREATE TABLE analytics_legacy_daily (visitors INTEGER); INSERT INTO analytics_legacy_daily VALUES(999);
    CREATE VIEW analytics_daily_live AS SELECT * FROM analytics_daily;
    CREATE VIEW analytics_report AS SELECT * FROM analytics_daily_live;`);
  db.exec(file('worker/schema.sql')); db.exec(file('worker/schema.sql'));
  const env = {DB:{async batch(statements) {
    db.exec('BEGIN');
    try {const results=statements.map(statement=>statement.execute());db.exec('COMMIT');return results;}
    catch (error) {db.exec('ROLLBACK');throw error;}
  }, prepare(sql) {
    let args = [];
    return {bind(...values) {args = values;return this;},
      execute() {return /^SELECT\b/i.test(sql.trim()) ? {results:db.prepare(sql).all(...args)} : db.prepare(sql).run(...args);},
      async run() {return this.execute();},
      async all() {return {results:db.prepare(sql).all(...args)};},
    };
  }}};
  return {db,env,setClock(ms) {clock=ms;}};
}
const req = (path='/', extra={}, method='GET') => new Request('https://jlogicsoftware.com'+path, {
  method, headers:{'user-agent':'Test browser', ...extra},
});
const html = () => new Response('page',{headers:{'content-type':'text/html; charset=utf-8'}});
const count = (db) => db.prepare('SELECT COALESCE(SUM(pageviews),0) n FROM analytics_page_counts').get().n;
const insert = (db,day,path='/',n=1) => db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,?)').run(day,path,n);
const context = () => {const pending=[];return {pending,waitUntil(p) {pending.push(p);}};};

test('schema is repeatable and additive; pseudonyms stay isolated from aggregate fields', () => {
  for (const legacy of [false,true]) {
    const {db}=database(legacy);
    assert.equal(count(db),0);
    assert.deepEqual(db.prepare('PRAGMA table_info(analytics_page_counts)').all().map(r=>r.name), ['day','path','pageviews']);
    assert.deepEqual(db.prepare('PRAGMA table_info(analytics_request_counts)').all().map(r=>r.name), ['day','path','source','medium','campaign','pageviews']);
    if (legacy) assert.equal(db.prepare('SELECT visitor_hash FROM events').get().visitor_hash,'PRIVATE');
    else assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['analytics_page_counts','analytics_request_counts','analytics_navigation_counts','analytics_daily_secrets','analytics_daily_membership','analytics_visitor_counts']);
    assert.throws(()=>insert(db,'2026-01-01','/someone@example.com'));
    assert.throws(()=>insert(db,'2026-01-01','/',-1));
  }
});

test('page allowlist canonicalizes public aliases and rejects private/arbitrary paths', () => {
  for (const [path,canonical] of [['/index.html','/'],['/development.html','/development'],['/about/','/about'],['/articles/2026-09-18-how-i-made-bugeater-3x-faster','/articles/2026-09-18-how-i-made-bugeater-3x-faster']]) assert.equal(canonicalPath(path),canonical);
  for (const path of ['/article','/people/email@example.com','/?email=alice','/articles/unknown','/stats']) assert.equal(canonicalPath(path),null);
});

test('concurrent page deliveries preserve aggregate counters without raw events', async () => {
  const {db,env}=database();const now=Date.UTC(2026,10,2,23,59,59);
  const request=req('/about.html?utm_source=PRIVATE&email=PRIVATE', {'cf-connecting-ip':'192.0.2.1',referer:'https://PRIVATE.example/person'});
  await Promise.all(Array.from({length:50},()=>record(request,env,html(),now)));
  await record(req('/about/'),env,html(),now);
  await record(req('/about'),env,html(),now+1000);
  assert.deepEqual(db.prepare('SELECT * FROM analytics_page_counts ORDER BY day').all().map(r=>({...r})),[
    {day:'2026-11-02',path:'/about',pageviews:51},{day:'2026-11-03',path:'/about',pageviews:1},
  ]);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM analytics_page_counts').all()).includes('PRIVATE'));
});

test('GPC, DNT, automated requests and both prefetch headers create no aggregate state', async () => {
  const {db,env}=database();
  for (const extra of [{'dnt':'1'},{'sec-gpc':'1'},{'user-agent':'SomeBot'},{'user-agent':''},{'sec-purpose':'prefetch;prerender'},{'purpose':'prefetch'},{'sec-purpose':'navigate','purpose':'prefetch'},{'sec-purpose':'prerender'}]) await record(req('/',extra),env,html());
  assert.equal(count(db),0);
  // Missing edge IP still counts aggregates; no cookie or forwarded-IP fallback.
  const request=req();const original=request.headers.get.bind(request.headers);
  request.headers.get=(name)=>{assert.notEqual(name.toLowerCase(),'x-forwarded-for');assert.notEqual(name.toLowerCase(),'cookie');return original(name);};
  await record(request,env,html());assert.equal(count(db),1);
});

test('only successful allowlisted HTML GET deliveries count', async () => {
  const {db,env}=database();
  const excluded=[
    [req('/images/avatar.webp'),html()], [req('/unknown'),html()], [req('/'),new Response('missing',{status:404,headers:{'content-type':'text/html'}})],
    [req('/'),new Response(null,{status:304})], [req('/'),Response.redirect('https://jlogicsoftware.com/about')],
    [req('/'),new Response('{}',{headers:{'content-type':'application/json'}})],
    [req('/'),new Response('bad type',{headers:{'content-type':'text/html-malformed'}})],
    [req('/',{},'HEAD'),html()], [req('/',{},'POST'),html()],
  ];
  for (const [request,response] of excluded) await record(request,env,response);
  assert.equal(count(db),0);
  await record(req('/'),env,html());assert.equal(count(db),1);
});

test('retired collector returns 410 for any method/body and never accesses data or schedules writes', async () => {
  const forbidden=new Proxy({}, {get(){throw new Error('unexpected access');}});
  assert.equal(collect(forbidden,forbidden,forbidden).status,410);
  for (const method of ['GET','POST','OPTIONS','HEAD']) {
    const response=await worker.fetch(req('/api/collect',{},method),forbidden,forbidden);
    assert.equal(response.status,410);assert.equal(response.headers.get('cache-control'),'no-store');
  }
});

test('retention keeps exactly today plus 399 UTC days, is repeatable and never reads legacy data', async () => {
  const {db,env}=database(true);const now=Date.UTC(2026,10,2,12);
  for (const age of [0,1,399,400,401]) {
    const day=utcDay(now-age*86400000);insert(db,day);
    db.prepare('INSERT INTO analytics_request_counts VALUES(?,?,?,?,?,?)').run(day,'/','direct','','',1);
    db.prepare('INSERT INTO analytics_navigation_counts VALUES(?,?,?,?)').run(day,'/','/about',1);
  }
  await rollup(env,now);await rollup(env,now);
  assert.deepEqual(db.prepare('SELECT day FROM analytics_page_counts ORDER BY day').all().map(r=>r.day),[399,1,0].map(age=>utcDay(now-age*86400000)));
  assert.deepEqual(db.prepare('SELECT day FROM analytics_request_counts ORDER BY day').all().map(r=>r.day),[399,1,0].map(age=>utcDay(now-age*86400000)));
  assert.deepEqual(db.prepare('SELECT day FROM analytics_navigation_counts ORDER BY day').all().map(r=>r.day),[399,1,0].map(age=>utcDay(now-age*86400000)));
  assert.equal(db.prepare('SELECT visitor_hash FROM analytics_events').get().visitor_hash,'PRIVATE');
});

test('Worker counts a served page and preserves successful response on counter failure', async () => {
  const {db,env}=database();env.ASSETS={async fetch(){return html();}};
  let ctx=context();assert.equal((await worker.fetch(req('/'),env,ctx)).status,200);await Promise.all(ctx.pending);assert.equal(count(db),1);
  ctx=context();const messages=[];const original=console.error;console.error=(message)=>messages.push(message);
  try {
    const failedEnv={...env,DB:{prepare(){throw new Error('PRIVATE DB error');}}};
    assert.equal((await worker.fetch(req('/'),failedEnv,ctx)).status,200);await Promise.all(ctx.pending);
    assert.deepEqual(messages,['analytics_write_failed']);
  } finally {console.error=original;}
  ctx=context();await worker.fetch(req('/images/example.png'),env,ctx);assert.equal(ctx.pending.length,0);
});

test('protected stats fail closed and throttle before auth; dashboard shows only fresh page totals', async () => {
  const {db,env}=database(true);const today=utcDay(Date.now());insert(db,today,'/',3);insert(db,today,'/about',2);insert(db,utcDay(Date.now()-100*86400000),'/',9);
  const auth=signedAccess.headers;
  for (const config of [{},{ACCESS_TEAM_DOMAIN:accessEnv.ACCESS_TEAM_DOMAIN},{ACCESS_AUD:accessEnv.ACCESS_AUD}]) assert.equal((await statsWorker.fetch(req('/stats',auth),{...env,...config},{})).status,503);
  Object.assign(env,accessEnv);
  assert.equal((await statsWorker.fetch(req('/stats',{authorization:'Basic !!!'}),env,{})).status,401);
  assert.equal((await statsWorker.fetch(req('/stats',{authorization:'Basic '+btoa('admin:wrong')}),env,{})).status,401);
  let limited=false;env.STATS_LIMITER={async limit({key}){limited=true;assert.equal(key,'192.0.2.1');return {success:false};}};
  assert.equal((await statsWorker.fetch(req('/stats',{'cf-connecting-ip':'192.0.2.1'}),env,{})).status,429);assert.ok(limited);
  env.STATS_LIMITER={async limit(){return {success:true};}};
  const response=await statsWorker.fetch(req('/stats?days=7',auth),env,{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.text();assert.ok(body.includes('UTC daily totals'));assert.ok(body.includes('kpi__value">5<'));assert.ok(!body.includes('PRIVATE'));assert.ok(!body.includes('999'));
  assert.ok(!body.includes('Summed daily visitors'));assert.ok(!body.includes('<th>Email clicks'));
  assert.ok(body.includes('Pages<span class="unit">views</span>'));assert.ok(!body.includes('class="unit">visitors'));
});

test('retired browser asset has no side effects and all six page scripts are removed', () => {
  vm.runInNewContext(file('js/analytics.js'),{});
  for (const name of ['index','about','development','privacy','articles','article']) assert.ok(!file(name+'.html').includes('/js/analytics.js'));
});

test('explicit owner-run retirement removes all v1/v2 data and preserves new aggregate counters', () => {
  const {db}=database(true);insert(db,'2026-11-02','/',7);
  db.exec(file('worker/legacy-retire.sql'));db.exec(file('worker/legacy-retire.sql'));
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r=>r.name),['analytics_page_counts','analytics_request_counts','analytics_navigation_counts','analytics_daily_secrets','analytics_daily_membership','analytics_visitor_counts']);
  assert.equal(count(db),7);
});


test('a common campaign link produces one daily bucket for all deliveries', async () => {
  const {db,env}=database();const now=Date.UTC(2026,10,2);
  const link='/about?utm_source=facebook&utm_medium=social&utm_campaign=mentoring';
  await Promise.all(Array.from({length:30},(_,i)=>record(req(link,{
    'cf-connecting-ip':`192.0.2.${i}`, 'user-agent':`Browser ${i}`,
    referer:`https://www.facebook.com/private-path-${i}?id=PRIVATE`,
  }),env,html(),now)));
  assert.equal(count(db),30);
  assert.deepEqual(db.prepare('SELECT * FROM analytics_request_counts').all().map(r=>({...r})),[
    {day:'2026-11-02',path:'/about',source:'facebook',medium:'social',campaign:'mentoring',pageviews:30},
  ]);
});

test('ordinary incoming referrers map to coarse classes, never raw URLs or hosts', async () => {
  const {db,env}=database();
  const cases=[
    ['https://www.google.com/search?q=PRIVATE','google'],['https://m.facebook.com/PRIVATE','facebook'],
    ['https://www.linkedin.com/in/PRIVATE','linkedin'],['https://github.com/PRIVATE','github'],
    ['https://youtu.be/PRIVATE','youtube'],['https://www.bing.com/search?q=PRIVATE','bing'],
    ['https://duckduckgo.com/?q=PRIVATE','duckduckgo'],['https://jlogicsoftware.com/about?person=PRIVATE','internal'],
    ['https://www.jlogicsoftware.com/PRIVATE','internal'],['https://person-PRIVATE.example/PRIVATE','otherexternal'],
    ['https://google.com.attacker.example/PRIVATE','otherexternal'],['not a valid URL PRIVATE','otherexternal'],
    ['mailto:PRIVATE@example.com','otherexternal'],['','direct'],
  ];
  for (const [referer,source] of cases) {
    const request=req('/',{referer});assert.equal(referralSource(request),source);await record(request,env,html());
  }
  const rows=db.prepare('SELECT * FROM analytics_request_counts').all();
  assert.equal(rows.reduce((n,r)=>n+r.pageviews,0),cases.length);
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});

test('unknown identifying tags and click IDs are discarded; approved labels stay useful', async () => {
  const {db,env}=database();
  const request=req('/?utm_source=alice%40example.com&utm_medium=recipient-PRIVATE&utm_campaign=person-PRIVATE&utm_content=PRIVATE&utm_term=PRIVATE&fbclid=PRIVATE&gclid=PRIVATE&msclkid=PRIVATE',{
    referer:'https://www.linkedin.com/person/PRIVATE',cookie:'visitor=PRIVATE',authorization:'Bearer PRIVATE',
    'cf-connecting-ip':'192.0.2.1','x-forwarded-for':'192.0.2.1',
  });
  const get=request.headers.get.bind(request.headers);
  request.headers.get=(name)=>{assert.ok(!['cookie','authorization','x-forwarded-for'].includes(name.toLowerCase()));return get(name);};
  await record(request,env,html());
  assert.deepEqual(db.prepare('SELECT source,medium,campaign,pageviews FROM analytics_request_counts').all().map(r=>({...r})),[
    {source:'linkedin',medium:'',campaign:'',pageviews:1},
  ]);
  assert.deepEqual(attribution(req('/about',{referer:'https://jlogicsoftware.com/?utm_source=facebook&utm_medium=social&utm_campaign=mentoring'})),
    {source:'internal',medium:'',campaign:''});
  assert.deepEqual(attribution(req('/?utm_source=newsletter&utm_medium=email&utm_campaign=middle-to-senior')),
    {source:'newsletter',medium:'email',campaign:'middle-to-senior'});
  assert.deepEqual(attribution(req('/?utm_source=facebook&utm_source=PRIVATE&utm_medium=EMAIL&utm_campaign=mentoring-PRIVATE')),
    {source:'direct',medium:'',campaign:''});
});

test('totals and category increments roll back together when the detail write fails', async () => {
  const {db,env}=database();
  await record(req('/'),env,html());
  db.exec("CREATE TRIGGER reject_detail BEFORE INSERT ON analytics_request_counts BEGIN SELECT RAISE(ABORT,'test detail failure'); END");
  await assert.rejects(record(req('/?utm_campaign=mentoring'),env,html()),/test detail failure/);
  assert.equal(count(db),1);
  assert.equal(db.prepare('SELECT SUM(pageviews) n FROM analytics_request_counts').get().n,1);
});


test('ordinary same-origin page transitions count without saving a referrer query or visitor history', async () => {
  const {db,env}=database();const now=Date.UTC(2026,10,2);
  for (let i=0;i<5;i++) await record(req('/about?utm_campaign=mentoring',{
    referer:'https://jlogicsoftware.com/index.html?email=PRIVATE#PRIVATE',
  }),env,html(),now);
  for (const referer of [
    'https://attacker.example/index.html', 'https://jlogicsoftware.com.attacker.example/',
    'http://jlogicsoftware.com/', 'https://jlogicsoftware.com:444/',
    'https://jlogicsoftware.com/about.html?PRIVATE', 'https://jlogicsoftware.com/PRIVATE',
    'not a valid URL', '',
  ]) await record(req('/about',{referer}),env,html(),now);
  assert.deepEqual(db.prepare('SELECT * FROM analytics_navigation_counts').all().map(r=>({...r})),[
    {day:'2026-11-02',from_path:'/',to_path:'/about',navigations:5},
  ]);
  assert.equal(count(db),13);
});

test('navigation failure rolls back all aggregate increments', async () => {
  const {db,env}=database();
  db.exec("CREATE TRIGGER reject_navigation BEFORE INSERT ON analytics_navigation_counts BEGIN SELECT RAISE(ABORT,'test navigation failure'); END");
  await assert.rejects(record(req('/about',{referer:'https://jlogicsoftware.com/'}),env,html()),/test navigation failure/);
  assert.equal(count(db),0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_request_counts').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_navigation_counts').get().n,0);
});


test('protected dashboard renders aggregate campaign, source and internal transition details', async () => {
  const {db,env}=database();const now=Date.now();
  await record(req('/about?utm_source=facebook&utm_medium=paid_social&utm_campaign=mentoring',{
    referer:'https://jlogicsoftware.com/?PRIVATE',
  }),env,html(),now);
  await record(req('/about?utm_source=facebook&utm_medium=paid_social&utm_campaign=mentoring'),env,html(),now);
  await record(req('/development',{referer:'https://github.com/PRIVATE'}),env,html(),now);
  await record(req('/about?utm_source=facebook&utm_medium=paid_social&utm_campaign=mentoring',{referer:'https://jlogicsoftware.com/'}),env,html(),now-86400000);
  // Preexisting page-only totals must not be attributed retroactively.
  insert(db,utcDay(now),'/articles',4);
  Object.assign(env,accessEnv);
  const response=await statsWorker.fetch(req('/stats?days=7',signedAccess.headers),env,{});
  const body=await response.text();
  assert.equal(response.status,200);
  assert.ok(body.includes('kpi__value">8<'));
  assert.ok(body.includes('kpi__value">4<'));
  for (const text of ['Sources','facebook','github','Campaign-tagged page views','paid_social','mentoring',
    'Internal page transitions by UTC day','<td>/</td><td>/about</td><td>1</td>',
    'Older page-only totals','utm_source=facebook&amp;utm_medium=paid_social&amp;utm_campaign=mentoring']) assert.ok(body.includes(text),text);
  for (const [day,views] of [[utcDay(now),2],[utcDay(now-86400000),1]]) {
    assert.ok(body.includes(`<td>${day}</td><td>facebook</td><td>${views}</td>`),'daily source');
    assert.ok(body.includes(`<td>${day}</td><td>facebook</td><td>paid_social</td><td>mentoring</td><td>/about</td><td>${views}</td>`),'daily campaign');
    assert.ok(body.includes(`<td>${day}</td><td>/</td><td>/about</td><td>1</td>`),'daily transition');
  }
  assert.ok(body.includes('Sources by UTC day'));
  assert.ok(!body.includes('PRIVATE'));
  assert.ok(!body.includes('conversion rate</th>'));
});

const membership = (db) => db.prepare('SELECT day,code FROM analytics_daily_membership ORDER BY day,code').all();
const estimates = (db) => db.prepare('SELECT day,visitors FROM analytics_visitor_counts ORDER BY day').all().map(row=>({...row}));
const visitor = (ip='192.0.2.1', ua='Example browser') => req('/about?utm_source=facebook&utm_campaign=mentoring', {
  'cf-connecting-ip':ip, 'user-agent':ua, referer:'https://jlogicsoftware.com/',
});

test('isolated site-wide daily estimate deduplicates concurrent deliveries, independent of page or campaign', async () => {
  const {db,env,setClock}=database();const now=Date.UTC(2026,10,2,12);setClock(now);
  await Promise.all(Array.from({length:80},(_,i)=>record(i%2 ? visitor() : req('/development',{'cf-connecting-ip':'192.0.2.1','user-agent':'Example browser'}),env,html(),now)));
  assert.deepEqual(estimates(db),[{day:'2026-11-02',visitors:1}]);
  assert.equal(membership(db).length,1);assert.equal(count(db),80);
  assert.equal(db.prepare('SELECT SUM(pageviews) n FROM analytics_request_counts').get().n,80);
  assert.equal(db.prepare('SELECT SUM(navigations) n FROM analytics_navigation_counts').get().n,40);
  await record(visitor('192.0.2.2'),env,html(),now);
  await record(visitor('192.0.2.1','Other browser'),env,html(),now);
  assert.equal(estimates(db)[0].visitors,3);
  await record(visitor('192.0.2.9','A'.repeat(1024)+'suffix-one'),env,html(),now);
  await record(visitor('192.0.2.9','A'.repeat(1024)+'suffix-two'),env,html(),now);
  assert.equal(estimates(db)[0].visitors,4);
  for (const [table, columns] of [
    ['analytics_daily_membership',['day','code']],['analytics_daily_secrets',['day','secret']],['analytics_visitor_counts',['day','visitors']],
  ]) assert.deepEqual(db.prepare('PRAGMA table_info('+table+')').all().map(row=>row.name),columns);
  assert.throws(()=>db.prepare('SELECT rowid FROM analytics_daily_membership').all());
  const snapshot=JSON.stringify(['analytics_page_counts','analytics_request_counts','analytics_navigation_counts','analytics_daily_membership','analytics_daily_secrets','analytics_visitor_counts'].map(table=>db.prepare('SELECT * FROM '+table).all()));
  assert.ok(!snapshot.includes('192.0.2.'));assert.ok(!snapshot.includes('Example browser'));
  const code=membership(db)[0].code;
  assert.match(code,/^[0-9a-f]{64}$/);
  for (const table of ['analytics_page_counts','analytics_request_counts','analytics_navigation_counts']) assert.ok(!JSON.stringify(db.prepare('SELECT * FROM '+table).all()).includes(code));
});

test('day rollover generates a fresh random key and code and removes old membership without losing totals', async () => {
  const {db,env,setClock}=database();let now=Date.UTC(2026,10,2,23,59,59);setClock(now);
  await record(visitor(),env,html(),now);
  const first=membership(db)[0];const key=db.prepare('SELECT secret FROM analytics_daily_secrets').get().secret;
  now+=1000;setClock(now);await record(visitor(),env,html(),now);
  assert.deepEqual(estimates(db),[{day:'2026-11-02',visitors:1},{day:'2026-11-03',visitors:1}]);
  assert.equal(membership(db).length,1);assert.equal(membership(db)[0].day,'2026-11-03');assert.notEqual(membership(db)[0].code,first.code);
  assert.notEqual(db.prepare('SELECT secret FROM analytics_daily_secrets').get().secret,key);
  assert.equal(count(db),2);
  // Cron expiry removes keys and membership even without another page delivery.
  now+=86400000;setClock(now);await rollup(env,now);await rollup(env,now);
  assert.equal(membership(db).length,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_daily_secrets').get().n,0);
  assert.equal(estimates(db).length,2);
});

test('missing edge IP never uses forwarded IP or cookies, creates no key, and still expires yesterday on traffic', async () => {
  const {db,env,setClock}=database();let now=Date.UTC(2026,10,2);setClock(now);
  await record(req('/',{'x-forwarded-for':'192.0.2.1',cookie:'PRIVATE'}),env,html(),now);
  assert.equal(count(db),1);assert.equal(membership(db).length,0);assert.equal(estimates(db).length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_daily_secrets').get().n,0);
  await record(visitor(),env,html(),now);now+=86400000;setClock(now);
  await record(req('/'),env,html(),now);
  assert.equal(membership(db).length,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_daily_secrets').get().n,0);
  assert.equal(count(db),3);
});

test('GPC/DNT and excluded deliveries never read IP or create secret or membership', async () => {
  const {db,env}=database();
  for (const headers of [{'dnt':'1'},{'sec-gpc':'1'},{'user-agent':'SomeBot'},{purpose:'prefetch'}]) {
    const request=req('/',headers);const get=request.headers.get.bind(request.headers);
    request.headers.get=name=>{assert.notEqual(name.toLowerCase(),'cf-connecting-ip');return get(name);};
    await record(request,env,html());
  }
  assert.equal(count(db),0);assert.equal(membership(db).length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_daily_secrets').get().n,0);
});

test('SQL clock blocks yesterday key recreation and delayed writes across midnight', async () => {
  for (const rolloverBeforeKey of [true,false]) {
    const {db,env,setClock}=database();const yesterday=Date.UTC(2026,10,2,23,59,59);setClock(yesterday);
    const batch=env.DB.batch.bind(env.DB);let batches=0;
    env.DB.batch=async statements=>{
      if (++batches===(rolloverBeforeKey?1:2)) setClock(yesterday+1000);
      return batch(statements);
    };
    await record(visitor(),env,html(),yesterday);
    assert.equal(membership(db).length,0);assert.equal(estimates(db).length,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_daily_secrets').get().n,0);
    assert.equal(count(db),1);
    await record(visitor(),env,html(),yesterday+1000);
    assert.deepEqual(estimates(db),[{day:'2026-11-03',visitors:1}]);
    // A late old-day request must not delete today's key or membership.
    await record(visitor(),env,html(),yesterday);
    assert.equal(membership(db).length,1);assert.equal(estimates(db)[0].visitors,1);
  }
});

test('membership or estimate write failures roll back all delivery aggregates and dedup changes', async () => {
  for (const table of ['analytics_daily_membership','analytics_visitor_counts']) {
    const {db,env,setClock}=database();const now=Date.UTC(2026,10,2);setClock(now);
    db.exec(`CREATE TRIGGER reject_estimate BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'estimate failure'); END`);
    await assert.rejects(record(visitor(),env,html(),now),/estimate failure/);
    assert.equal(count(db),0);assert.equal(membership(db).length,0);assert.equal(estimates(db).length,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_request_counts').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_navigation_counts').get().n,0);
  }
});

test('visitor aggregates retain 400 days and dashboard exposes only daily estimates, never codes or keys', async () => {
  const {db,env,setClock}=database();const now=Date.now();setClock(now);
  await record(visitor(),env,html(),now);const code=membership(db)[0].code;
  const secret=db.prepare('SELECT secret FROM analytics_daily_secrets').get().secret;
  for (const age of [1,399,400]) db.prepare('INSERT INTO analytics_visitor_counts VALUES(?,?)').run(utcDay(now-age*86400000),age);
  await rollup(env,now);
  assert.deepEqual(estimates(db).map(row=>row.visitors),[399,1,1]);
  insert(db,utcDay(now-2*86400000),'/',8);
  Object.assign(env,accessEnv);
  const body=await (await statsWorker.fetch(req('/stats?days=7',signedAccess.headers),env,{})).text();
  for (const label of ['Daily visitor estimates (UTC)','Sum of daily visitor estimates','not a count of unique visitors across the selected period','provider backups have separate retention']) assert.ok(body.includes(label),label);
  assert.ok(body.includes(`<td>${utcDay(now-2*86400000)}</td><td>Not measured</td>`));
  assert.ok(!body.includes(code));assert.ok(!body.includes(secret));
  // This checks live tables only; it makes no claim about provider snapshots.
});
