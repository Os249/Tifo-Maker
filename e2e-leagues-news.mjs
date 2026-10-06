/**
 * "Your club's real stadium is here": the league stadiums news, end to end.
 *
 *   - a fresh editor shows it once, after the onboarding, with one tile per
 *     league (its picture, its name, how many grounds); nothing is remembered
 *     until it is answered
 *   - a tile opens the stadium list on that league and nothing else; "See all"
 *     opens it on every league; the answer is remembered, and the Banners news
 *     waits for the next visit rather than stacking on top
 *   - in Arabic, and on a phone, where the tile opens the Stadium sheet
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 * Screenshots land in preview-out/e2e-leagues-news/.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const B = 'http://127.0.0.1:8911';
const OUT = 'preview-out/e2e-leagues-news';
mkdirSync(OUT, { recursive: true });

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const LS = (lang, extra = []) => [
  { name: 'tifo_lang_v1', value: lang },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_banner_tour_v1', value: '1' },
  { name: 'tifo_draw_hint_v1', value: '1' },
  ...extra.map(([name, value]) => ({ name, value })),
];
async function open({ lang = 'en', w = 1400, h = 880, extra = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang, extra) }] } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  await page.goto(B + '/app?new=1', { waitUntil: 'networkidle', timeout: 120000 });
  return { ctx, page, errs };
}
const flag = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
const cardState = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('#news-card.news-leagues');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const tiles = [...card.querySelectorAll('.news-league')].map((t) => {
      const img = t.querySelector('img');
      return {
        league: t.dataset.league,
        name: t.querySelector('.news-league-name')?.textContent ?? '',
        count: t.querySelector('.news-league-count')?.textContent ?? '',
        loaded: !!img && img.complete && img.naturalWidth > 0,
      };
    });
    const targets = [...card.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((b) => b.width > 0);
    return {
      title: card.querySelector('.news-title')?.textContent ?? '',
      body: card.querySelector('.news-body')?.textContent ?? '',
      tiles,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      smallest: Math.min(...targets.map((b) => Math.min(b.width, b.height))),
      focusInside: card.contains(document.activeElement),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
const listed = (page) => page.$$eval('#stadium-list > *', (rows) => rows.map((r) => r.textContent || ''));

// ---------------------------------------------------------------------------
console.log('\n— on a computer, in English —');
{
  const { ctx, page, errs } = await open();
  await page.waitForSelector('#news-card.news-leagues', { timeout: 20000 }).catch(() => null);
  await page.waitForFunction(() => [...document.querySelectorAll('.news-league img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  const s = await cardState(page);
  check('a fresh editor shows the league stadiums news', !!s);
  check('it says your club’s real stadium is here', !!s && /real stadium is here/.test(s.title), s?.title);
  check('one tile per league, in order', !!s && s.tiles.map((t) => t.league).join() === 'saudi-pro-league,premier-league,laliga', JSON.stringify(s?.tiles.map((t) => t.league)));
  check('each tile names its league and counts its grounds',
    !!s && s.tiles[0].name === 'Roshn Saudi League' && s.tiles[0].count === '14 stadiums' && s.tiles[1].name === 'Premier League' && s.tiles[1].count === '20 stadiums' && s.tiles[2].name === 'LaLiga' && s.tiles[2].count === '20 stadiums',
    JSON.stringify(s?.tiles.map((t) => [t.name, t.count])));
  check('every picture loads', !!s && s.tiles.every((t) => t.loaded));
  check('it is on screen, with 24 px targets and no sideways scroll', !!s && s.inView && s.smallest >= 24 && !s.overflow, `${s?.smallest}`);
  check('it does not take focus from the page', !!s && !s.focusInside);
  check('it is not remembered before it is answered', (await flag(page, 'tifo_news_leagues_v1')) === null);
  await page.screenshot({ path: `${OUT}/desktop-en.png` });

  await page.click('.news-league[data-league="laliga"]');
  check('a tile puts the news away', await page.waitForSelector('#news-card', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
  check('and it is remembered', (await flag(page, 'tifo_news_leagues_v1')) === '1');
  await page.waitForTimeout(800);
  const league = await page.$eval('#stadium-league', (e) => e.value).catch(() => null);
  const rows = await listed(page);
  check('the LaLiga tile opens the stadium list on LaLiga', league === 'laliga', String(league));
  check('listing its twenty grounds and nothing else', rows.length === 20 && rows.some((r) => r.includes('Bernabéu (Madrid)')) && !rows.some((r) => r.includes('Anfield')), `${rows.length} rows`);
  await page.screenshot({ path: `${OUT}/desktop-laliga-list.png` });
  await page.selectOption('#stadium-league', '');
  check('"Any league" lists them all again', (await listed(page)).length > 54);

  // The next visit: no league news, and the Banners news gets its turn.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#news-card', { timeout: 15000 }).catch(() => null);
  const next = await page.evaluate(() => { const c = document.querySelector('#news-card'); return c ? { leagues: c.classList.contains('news-leagues'), text: c.textContent } : null; });
  check('it does not come back', !next?.leagues);
  check('and the Banners news shows on the next visit instead', !!next && /Banners are here/.test(next.text ?? ''), next?.text?.slice(0, 60));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— "See all stadiums" —');
{
  const { ctx, page, errs } = await open({ extra: [['tifo_news_banners_v1', '1']] });
  await page.waitForSelector('#news-card.news-leagues', { timeout: 20000 });
  await page.click('#news-try');
  await page.waitForTimeout(800);
  check('opens the stadium list on every league', (await page.$eval('#stadium-league', (e) => e.value).catch(() => null)) === '' && (await listed(page)).length > 54);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— in Arabic —');
{
  const { ctx, page, errs } = await open({ lang: 'ar', extra: [['tifo_news_banners_v1', '1']] });
  await page.waitForSelector('#news-card.news-leagues', { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.news-league img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  const s = await cardState(page);
  check('the title is Arabic', !!s && s.title === 'ملعب ناديك الحقيقي صار هنا', s?.title);
  check('so are the league names and counts', !!s && s.tiles[0].name === 'دوري روشن السعودي' && s.tiles[2].name === 'الدوري الإسباني' && s.tiles[1].count === '20 ملعب', JSON.stringify(s?.tiles.map((t) => [t.name, t.count])));
  check('on screen, no sideways scroll', !!s && s.inView && !s.overflow);
  await page.screenshot({ path: `${OUT}/desktop-ar.png` });
  await page.click('.news-league[data-league="saudi-pro-league"]');
  await page.waitForTimeout(800);
  const rows = await listed(page);
  check('the Saudi tile lists the fourteen Saudi league grounds', rows.length === 14 && rows.some((r) => r.includes('جوهرة') || r.includes('Jewel')), `${rows.length} rows`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n— on a phone —');
{
  const { ctx, page, errs } = await open({ w: 390, h: 844, extra: [['tifo_news_banners_v1', '1']] });
  await page.waitForSelector('#news-card.news-leagues', { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.news-league img')].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});
  const s = await cardState(page);
  check('the card fits the phone screen', !!s && s.inView && !s.overflow);
  check('with 24 px targets', !!s && s.smallest >= 24, `${s?.smallest}`);
  await page.screenshot({ path: `${OUT}/phone-en.png` });
  await page.click('.news-league[data-league="premier-league"]');
  await page.waitForTimeout(1200);
  const sheet = await page.evaluate(() => {
    const sh = document.querySelector('.m-sheet');
    return { open: !!sh && sh.classList.contains('open'), hasList: !!sh?.querySelector('#stadium-list'), league: document.querySelector('#stadium-league')?.value ?? null };
  });
  check('the tile opens the Stadium sheet', sheet.open && sheet.hasList, JSON.stringify(sheet));
  check('on the Premier League', sheet.league === 'premier-league' && (await listed(page)).length === 20, String(sheet.league));
  await page.screenshot({ path: `${OUT}/phone-premier-sheet.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\nleagues news: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
