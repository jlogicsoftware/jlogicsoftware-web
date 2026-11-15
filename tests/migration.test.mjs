import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

// The 2026-11-15 migration widens the path allow-lists of the three counter tables (SQLite cannot alter a CHECK
// in place, so the tables are rebuilt). It runs on production D1 *before* the Worker that records the new path
// is deployed; this test rehearses it on a database built from the schema as it was before the article.
const file = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const DIR = 'worker/migrations/2026-11-15-register-article/';
const NEW = '/articles/2026-11-15-how-i-made-my-game-3x-faster-by-moving-from-dart-to-java';
const OLD_LAST = '/articles/2026-09-18-how-i-made-bugeater-3x-faster';
const newSchema = file('worker/schema.sql');
// The schema before this article: the same file without the new slug in its four allow-lists.
const oldSchema = newSchema.split(`,\n    '${NEW}'`).join('');
const TABLES = ['analytics_page_counts', 'analytics_request_counts', 'analytics_navigation_counts'];
const norm = (sql) => sql.replace(/"/g, '').replace(/\s+/g, ' ').replace(/IF NOT EXISTS /g, '').trim();
const totals = (db) => ({
  page: {...db.prepare('SELECT COUNT(*) n, SUM(pageviews) s FROM analytics_page_counts').get()},
  req: {...db.prepare('SELECT COUNT(*) n, SUM(pageviews) s FROM analytics_request_counts').get()},
  nav: {...db.prepare('SELECT COUNT(*) n, SUM(navigations) s FROM analytics_navigation_counts').get()},
});
function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(oldSchema);
  const pages = ['/', '/about', '/development', '/privacy', '/articles', OLD_LAST];
  for (let d = 1; d <= 20; d++) {
    const day = '2026-10-' + String(d).padStart(2, '0');
    pages.forEach((path, i) => {
      db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,?)').run(day, path, d + i);
      for (const source of ['direct', 'linkedin', 'google'])
        db.prepare('INSERT INTO analytics_request_counts VALUES(?,?,?,?,?,?)').run(day, path, source, '', '', d + i);
    });
    db.prepare('INSERT INTO analytics_navigation_counts VALUES(?,?,?,?)').run(day, '/articles', OLD_LAST, d);
    db.prepare('INSERT INTO analytics_navigation_counts VALUES(?,?,?,?)').run(day, '/', '/about', d);
  }
  return db;
}

test('the schema before the article rejects the new path, which is why the database is migrated first', () => {
  assert.notEqual(oldSchema, newSchema);
  const db = seeded();
  assert.throws(() => db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,1)').run('2026-11-15', NEW), /CHECK constraint failed/);
});

test('prepare is repeatable and leaves the live tables untouched', () => {
  const db = seeded();
  const before = totals(db);
  db.exec(file(DIR + '01-prepare.sql')); db.exec(file(DIR + '01-prepare.sql'));
  assert.deepEqual(totals(db), before);
  for (const [table, key] of [['page_counts', 'page'], ['request_counts', 'req'], ['navigation_counts', 'nav']])
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM analytics_${table}_v2`).get().n, before[key].n);
});

test('swap keeps every row, including writes made after prepare, and accepts the new path', () => {
  const db = seeded();
  db.exec(file(DIR + '01-prepare.sql'));
  db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,?)').run('2026-10-21', '/', 7);
  db.prepare('UPDATE analytics_page_counts SET pageviews = pageviews + 1 WHERE day = ? AND path = ?').run('2026-10-02', '/about');
  const expected = totals(db);
  db.exec(file(DIR + '02-swap.sql'));
  assert.deepEqual(totals(db), expected);

  db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,1)').run('2026-11-15', NEW);
  db.prepare('INSERT INTO analytics_request_counts VALUES(?,?,?,?,?,1)').run('2026-11-15', NEW, 'linkedin', '', '');
  db.prepare('INSERT INTO analytics_navigation_counts VALUES(?,?,?,1)').run('2026-11-15', '/articles', NEW);
  db.prepare(`INSERT INTO analytics_page_counts(day,path,pageviews) VALUES(?,?,1)
    ON CONFLICT(day,path) DO UPDATE SET pageviews = pageviews + 1`).run('2026-11-15', NEW);
  assert.equal(db.prepare('SELECT pageviews FROM analytics_page_counts WHERE day = ? AND path = ?').get('2026-11-15', NEW).pageviews, 2);
});

test('the swapped tables still reject unknown paths, bad counts, self-transitions and duplicate keys', () => {
  const db = seeded();
  db.exec(file(DIR + '01-prepare.sql')); db.exec(file(DIR + '02-swap.sql'));
  assert.throws(() => db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,1)').run('2026-11-15', '/secret'), /CHECK constraint failed/);
  assert.throws(() => db.prepare('INSERT INTO analytics_request_counts VALUES(?,?,?,?,?,1)').run('2026-11-15', '/a@b.c', 'direct', '', ''), /CHECK constraint failed/);
  assert.throws(() => db.prepare('INSERT INTO analytics_navigation_counts VALUES(?,?,?,1)').run('2026-11-15', '/', '/'), /CHECK constraint failed/);
  assert.throws(() => db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,-1)').run('2026-11-16', '/'), /CHECK constraint failed/);
  assert.throws(() => db.prepare('INSERT INTO analytics_page_counts VALUES(?,?,1)').run('2026-10-02', '/about'), /UNIQUE|PRIMARY/);
});

test('cleanup leaves only the production tables, defined exactly as in schema.sql', () => {
  const db = seeded();
  for (const step of ['01-prepare.sql', '02-swap.sql', '03-cleanup.sql']) db.exec(file(DIR + step));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'analytics_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, ['analytics_daily_membership', 'analytics_daily_secrets', 'analytics_navigation_counts',
    'analytics_page_counts', 'analytics_request_counts', 'analytics_visitor_counts']);
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(newSchema);
  for (const table of TABLES)
    assert.equal(norm(db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table).sql),
      norm(fresh.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table).sql), table);
});

test('schema.sql stays repeatable on top of a migrated database', () => {
  const db = seeded();
  for (const step of ['01-prepare.sql', '02-swap.sql', '03-cleanup.sql']) db.exec(file(DIR + step));
  const before = totals(db);
  db.exec(newSchema);
  assert.deepEqual(totals(db), before);
});
