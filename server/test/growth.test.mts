/**
 * Tagged links and honest visitor counts (29 Sep 2026 review).
 *
 *   npm run test:growth-server            (memory only)
 *   DATABASE_URL=... npm run test:growth-server   (and the Postgres rollup)
 *
 * The browser half (share buttons, Post it, phones) is e2e-growth.mjs.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildVisit, classifySource, isSocialReferrer, MemoryTrafficRepository, PgTrafficRepository } from '../src/trafficRepo';
import { tagShareUrl } from '../../src/core/utm';
import { preferredLang } from '../../src/ui/i18n';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let n = 0;
const ok = (name: string): void => { n++; console.log(`  ok  ${name}`); };

// ---- classification ----
assert.deepEqual(classifySource(null, 'whatsapp', 'share', false), { kind: 'shared', label: 'whatsapp' });
ok('utm_medium=share is "shared", labelled by platform');
assert.equal(classifySource('t.co', 'x', 'share', true).kind, 'shared');
ok('even when the referrer is X: the tag says a visitor passed it on');
assert.equal(classifySource(null, 'x', 'post', false).kind, 'campaign');
ok('a link from the builder (utm_medium=post) is still your campaign');
assert.equal(classifySource(null, 'tiktok', 'bio', false).label, 'tiktok');
ok('and it keeps its platform name');
const fromX = buildVisit({ ip: '203.0.113.9', ua: UA, referer: 'https://t.co/abc', host: 'tifomaker.org', path: '/t/x', query: { utm_source: 'x', utm_medium: 'share', utm_campaign: 'post' } });
assert.equal(fromX.source, 'shared');
assert.equal(fromX.referrerHost, 'X / Twitter', 'the referrer column keeps where it was opened from');
assert.equal(fromX.utmSource, 'x');
ok('a shared visit keeps both: the platform tag and where it was opened');

// ---- the shares panel's social row ----
assert.equal(isSocialReferrer('X / Twitter'), true);
assert.equal(isSocialReferrer('WhatsApp'), true);
assert.equal(isSocialReferrer('instagram.com'), true);
assert.equal(isSocialReferrer('Google'), false);
assert.equal(isSocialReferrer('example.org'), false);
ok('stored social labels are recognised (the row was always empty before)');

// ---- memory store ----
{
  const t = new MemoryTrafficRepository();
  await t.record(buildVisit({ ip: '203.0.113.1', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'whatsapp', utm_medium: 'share', utm_campaign: 'tifo' } }));
  await t.record(buildVisit({ ip: '203.0.113.2', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'whatsapp', utm_medium: 'share', utm_campaign: 'post' } }));
  await t.record(buildVisit({ ip: '203.0.113.3', ua: UA, host: 'tifomaker.org', path: '/', query: { utm_source: 'x', utm_medium: 'post', utm_campaign: 'reveal-1' } }));
  const s = await t.summary(30);
  assert.deepEqual(s.shared.map((b) => [b.key, b.visits]), [['whatsapp', 2]]);
  assert.deepEqual(s.campaigns.map((b) => b.key), ['x / reveal-1'], 'shared links are not mixed into your campaigns');
  ok('memory store: shared visits by platform, kept apart from campaigns');
}

// ---- client helpers ----
assert.equal(tagShareUrl('https://tifomaker.org/t/abc', 'whatsapp'), 'https://tifomaker.org/t/abc?utm_source=whatsapp&utm_medium=share&utm_campaign=tifo');
assert.equal(tagShareUrl('https://tifomaker.org/?utm_source=x&a=1', 'copy', 'post'), 'https://tifomaker.org/?utm_source=copy&a=1&utm_medium=share&utm_campaign=post');
ok('tagShareUrl sets the tags, replacing any a link already had');
assert.equal(preferredLang(['ar-SA', 'en-US']), 'ar');
assert.equal(preferredLang(['ar']), 'ar');
assert.equal(preferredLang(['en-US', 'ar-SA']), 'en', 'only the FIRST language decides');
assert.equal(preferredLang(['arn-CL']), 'en', 'Mapudungun is not Arabic');
assert.equal(preferredLang([]), 'en');
assert.equal(preferredLang(undefined), 'en');
ok('preferredLang: Arabic only when it is the browser\'s first language');

// ---- Postgres: the daily count survives the key being stripped ----
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const repo = new PgTrafficRepository(pool);
    await repo.init();
    await pool.query('DELETE FROM visits');
    await pool.query('DELETE FROM visits_daily');
    const at = async (key: string | null, when: string): Promise<void> => {
      await pool.query(
        `INSERT INTO visits (visitor_key, source, path, is_bot, created_at) VALUES ($1, 'direct', '/', false, ${when})`,
        [key],
      );
    };
    // Yesterday: three people, four views.
    for (const k of ['a', 'b', 'c', 'a']) await at(k, "date_trunc('day', now()) - interval '1 day' + interval '3 hours'");
    // Today: two people.
    for (const k of ['d', 'e']) await at(k, 'now()');
    await repo.purge();
    const kept = await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, visitors FROM visits_daily`);
    assert.equal(kept.rows.length, 1, 'yesterday is kept (today is not finished)');
    assert.equal(Number(kept.rows[0].visitors), 3);
    ok('postgres: purge keeps yesterday\'s distinct visitors as one number');

    // Now strip every key, as the purge would two days on.
    await pool.query('UPDATE visits SET visitor_key = NULL');
    const s = await repo.summary(7);
    const y = s.daily.find((d) => d.day === kept.rows[0].day);
    assert.equal(y?.visitors, 3, 'the daily chart still has its people after the keys are gone');
    assert.equal(s.totals.visitors, 3, 'and the total is the sum of days (today\'s keys were stripped too here)');
    ok('postgres: the dashboard reads people from the kept count once the keys are gone');

    // Running purge again never lowers a day that was already kept.
    await repo.purge();
    const again = await pool.query('SELECT visitors FROM visits_daily');
    assert.equal(Number(again.rows[0].visitors), 3);
    ok('postgres: a second purge does not overwrite the kept count with zero');
  } finally {
    await pool.query('DELETE FROM visits').catch(() => {});
    await pool.query('DELETE FROM visits_daily').catch(() => {});
    await pool.end();
  }
} else {
  console.log('  (postgres rollup skipped: set DATABASE_URL to run it)');
}

console.log(`\ngrowth (server): ${n} checks passed`);
