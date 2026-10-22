/**
 * What the public pages load, and when (performance plan, phase 1).
 *
 *   /community  P1.10  three.js, the stadium catalogue and the share and sign-in
 *                      dialogs arrive only when a card is pointed at or opened,
 *                      and the crawler list is never painted for a visitor
 *                      whose script runs, so nothing jumps when the grid lands.
 *               P1.11  a card shows the feed's own commentCount (no request per
 *                      card) and falls back to counting the thread when a server
 *                      does not send it; the facets are asked for once; the feed
 *                      does not wait for /api/me.
 *   /projects   P1.13  the catalogue only for a .tifo import; pictures as cards
 *                      come near the screen.
 *   every page  P1.15  the translation chunk holds no password blocklist and no
 *                      stadium geometry.
 *               P1.17  an English page fetches Almarai only for Arabic letters.
 *
 *   node e2e-pages-load.mjs        (server on :8911 with a built dist; BASE= to point elsewhere)
 */
import { chromium } from 'playwright';
import { gzipSync } from 'node:zlib';

const B = process.env.BASE ?? 'http://127.0.0.1:8911';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const until = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const PW = 'harbor-kite-moss-31-load';

async function open({ lang = 'en', token = null, w = 1440, h = 900, routes = [] } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [
      { name: 'tifo_lang_v1', value: lang }, { name: 'tifo_consent_v1', value: 'essential' },
      ...(token ? [{ name: 'tifo_token_v1', value: token }] : [])] }] },
  });
  await ctx.addInitScript(() => {
    window.__cls = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls.push(e.value); }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* */ }
  });
  for (const [match, fn] of routes) await ctx.route(match, fn);
  const p = await ctx.newPage();
  const errs = [];
  const asked = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  p.on('request', (r) => asked.push({ url: r.url(), at: Date.now() }));
  return { ctx, p, errs, asked };
}
const chunk = (asked, name) => asked.some((r) => new RegExp(`/assets/${name}-[\\w-]+\\.js$`).test(r.url));
const paths = (asked, re) => asked.filter((r) => re.test(new URL(r.url).pathname));

async function account(n = 0) {
  const u = 'load' + Math.random().toString(36).slice(2, 9);
  const reg = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PW, email: u + '@example.test', acceptedVersion: '2025-01-01' }) });
  if (!reg.ok) throw new Error(`could not register: ${reg.status} ${await reg.text()}`);
  const { token } = await reg.json();
  if (n) {
    const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const tpl = (await (await fetch(B + '/api/templates')).json())[0];
    // A real card picture to give every project: a starter template's.
    const g = (await (await fetch(B + '/api/gallery?templates=1&limit=20')).json()).find((it) => it.hasThumbnail);
    const pic = await fetch(`${B}/api/designs/${g.id}/thumbnail.png`);
    if (!pic.ok) throw new Error(`no picture to copy: ${pic.status}`);
    const png = Buffer.from(await pic.arrayBuffer()).toString('base64');
    const cells = new Uint8Array(tpl.seatCount); for (let i = 0; i < cells.length; i++) cells[i] = i % 3;
    const cellsGzB64 = gzipSync(Buffer.from(cells)).toString('base64');
    for (let i = 0; i < n; i++) {
      const r = await fetch(B + '/api/designs', { method: 'POST', headers: H, body: JSON.stringify({ title: `Load ${i}`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec'], cellsGzB64, thumbnailPngB64: png }) });
      if (!r.ok) throw new Error(`could not create a design: ${r.status} ${await r.text()}`);
    }
  }
  return token;
}

// ---------------------------------------------------------------------------
console.log('\n— /community: what the first view loads —');
{
  const html = await (await fetch(B + '/community')).text();
  check('crawlers and no-JS visitors still get the list of links', /<nav id="seo-feed"[^>]*>[\s\S]*href="\/t\//.test(html));
  check('no inline script, no CSP change needed', !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html));

  // The feed is held back a moment, so the first paint is taken with the
  // list in the page and no cards yet: the moment the old page jumped.
  let release;
  const held = new Promise((r) => { release = r; });
  const { ctx, p, errs, asked } = await open({ routes: [[(u) => u.pathname === '/api/gallery', async (route) => { await held; await route.continue(); }]] });
  await p.goto(B + '/community', { waitUntil: 'domcontentloaded' });
  const early = await p.evaluate(() => ({
    js: document.documentElement.classList.contains('js'),
    seo: document.getElementById('seo-feed') ? getComputedStyle(document.getElementById('seo-feed')).display : 'gone',
    more: getComputedStyle(document.getElementById('grid-more')).display,
  }));
  check('theme-boot marks the page as scripted before it paints', early.js);
  check('so the crawler list is never painted', early.seo === 'none' || early.seo === 'gone', early.seo);
  check('and "Load more" stays hidden while the feed loads', early.more === 'none', early.more);
  release();
  check('the grid renders', await until(p, () => document.querySelectorAll('#gallery-grid .tifo-card').length > 0));
  await p.waitForTimeout(2500);
  check('no layout shift worth the name when it lands', await p.evaluate(() => window.__cls.reduce((a, b) => a + b, 0) < 0.05),
    String(await p.evaluate(() => window.__cls.reduce((a, b) => a + b, 0).toFixed(3))));
  check('the list\'s own thumbnails were never fetched (the cards fetch theirs near the screen)',
    paths(asked, /\/thumbnail\.png$/).length <= 16, `${paths(asked, /\/thumbnail\.png$/).length} thumbnails`);
  for (const name of ['preview3d', 'stadiumCatalog', 'client', 'community3d', 'authModal', 'shareModal']) {
    check(`${name} is not loaded with the feed`, !chunk(asked, name));
  }
  check('the facets are asked for once', paths(asked, /^\/api\/gallery\/facets$/).length === 1, `${paths(asked, /^\/api\/gallery\/facets$/).length}`);

  // Pointing at a card starts the 3D code; opening it shows the stadium.
  await p.hover('#gallery-grid .tifo-card');
  check('pointing at a card fetches the 3D preview', await until(p, () => performance.getEntriesByType('resource').some((e) => /\/assets\/preview3d-/.test(e.name)), null, 30000));
  await p.click('#gallery-grid .tifo-card .card-title');
  check('opening it draws the stadium in 3D', await until(p, () => !!document.querySelector('#modal-3d-host canvas'), null, 120000));
  await p.keyboard.press('Escape');
  await p.click('#gallery-grid .tifo-card .card-share');
  check('a card\'s share button opens the share dialog', await until(p, () => !!document.querySelector('.sm-overlay'), null, 30000));
  await p.keyboard.press('Escape');
  await p.evaluate(() => document.querySelector('.sm-overlay')?.remove());
  await p.click('#auth-btn');
  check('Sign in opens the sign-in dialog', await until(p, () => !!document.querySelector('.auth-modal'), null, 30000));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— /community: comment counts come with the feed —');
{
  // The server half of P1.11 adds commentCount to every gallery row; until it
  // lands the card falls back to counting each thread. Both paths are checked.
  const { ctx, p, asked } = await open({ routes: [[(u) => u.pathname === '/api/gallery', async (route) => {
    const r = await route.fetch();
    const rows = await r.json();
    rows.forEach((it, i) => { it.commentCount = i === 0 ? 7 : 0; });
    await route.fulfill({ response: r, json: rows });
  }]] });
  await p.goto(B + '/community', { waitUntil: 'domcontentloaded' });
  await until(p, () => document.querySelectorAll('#gallery-grid .tifo-card').length > 0);
  await p.waitForTimeout(2500);
  check('a card shows the count the feed sent', (await p.evaluate(() => document.querySelector('#gallery-grid .cmt-count')?.textContent)) === '7');
  check('and no thread is downloaded just to count it', paths(asked, /\/comments$/).length === 0, `${paths(asked, /\/comments$/).length} thread requests`);
  check('the whole first view is a handful of API calls', paths(asked, /^\/api\//).filter((r) => !/thumbnail\.png$/.test(r.url)).length <= 6,
    paths(asked, /^\/api\//).filter((r) => !/thumbnail\.png$/.test(r.url)).map((r) => new URL(r.url).pathname).join(' ').slice(0, 200));
  await ctx.close();
}
{
  const { ctx, p, asked } = await open({ routes: [[(u) => u.pathname === '/api/gallery', async (route) => {
    const r = await route.fetch();
    const rows = await r.json();
    rows.forEach((it) => { delete it.commentCount; });
    await route.fulfill({ response: r, json: rows });
  }]] });
  await p.goto(B + '/community', { waitUntil: 'domcontentloaded' });
  const counted = await until(p, () => { const c = [...document.querySelectorAll('#gallery-grid .cmt-count')]; return c.length > 0 && c.every((e) => /^\d+$/.test(e.textContent)); }, null, 60000);
  check('without the field (an older server), every card still gets its count', counted);
  check('by counting its thread, as before', paths(asked, /\/comments$/).length > 0);
  await ctx.close();
}

console.log('\n— /community: the feed does not wait for /api/me —');
{
  const token = await account();
  // /api/me is held for two seconds; the feed must be asked for meanwhile.
  let meDone = 0;
  const { ctx, p, asked } = await open({ token, routes: [[(u) => u.pathname === '/api/me', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
    meDone = Date.now();
  }]] });
  await p.goto(B + '/community', { waitUntil: 'domcontentloaded' });
  await until(p, () => document.querySelectorAll('#gallery-grid .tifo-card').length > 0);
  await until(p, () => /^@/.test(document.getElementById('auth-btn')?.textContent ?? ''), null, 30000);
  const feed = paths(asked, /^\/api\/gallery$/)[0];
  check('the feed is requested while /api/me is still out', !!feed && meDone > 0 && feed.at < meDone, feed ? `${meDone - feed.at} ms before` : 'no feed request');
  check('and the signed-in state still arrives', /^@/.test(await p.evaluate(() => document.getElementById('auth-btn').textContent)));
  await ctx.close();
}

console.log('\n— /projects —');
{
  const token = await account(40);
  const { ctx, p, errs, asked } = await open({ token, w: 1366, h: 860 });
  await p.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
  check('the list renders', await until(p, () => document.querySelectorAll('#pj-grid .pj-card').length >= 40, null, 60000));
  await p.waitForTimeout(2500);
  const first = paths(asked, /\/thumbnail\.png$/).length;
  check('only the pictures near the screen are fetched', first > 0 && first < 40, `${first} of 40`);
  check('the stadium catalogue is not loaded', !chunk(asked, 'stadiumCatalog'));
  // Scrolled the way a person does, a screen at a time, so every card passes by.
  for (let y = 0; y <= (await p.evaluate(() => document.body.scrollHeight)); y += 500) {
    await p.evaluate((top) => window.scrollTo(0, top), y);
    await p.waitForTimeout(200);
  }
  check('scrolling down fetches the rest', await until(p, () => performance.getEntriesByType('resource').filter((e) => /\/thumbnail\.png$/.test(e.name)).length >= 40, null, 60000),
    `${paths(asked, /\/thumbnail\.png$/).length} of 40`);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— every page: the shared translation chunk —');
{
  const html = await (await fetch(B + '/legal')).text();
  const i18n = (html.match(/\/assets\/i18n-[\w-]+\.js/) ?? [])[0];
  const src = i18n ? await (await fetch(B + i18n)).text() : '';
  check('/legal loads the translation chunk', !!src, String(i18n));
  check('it carries no password blocklist', !src.includes('qazwsxedcrfvtgbyhnujmikolp'));
  check('and no stadium geometry builders', !src.includes('blocks need evenRows') && !src.includes('a straight tier needs its stands'));
  check('/legal does not load the password field at all', !/passwordField-/.test(html));
}

console.log('\n— fonts: Almarai only for Arabic letters —');
for (const [lang, path] of [['en', '/clubs'], ['en', '/tifo-spec'], ['ar', '/clubs']]) {
  const { ctx, p, asked } = await open({ lang });
  await p.goto(B + path, { waitUntil: 'load' });
  await p.waitForTimeout(2000);
  const almarai = paths(asked, /almarai-arabic-\d+/).map((r) => r.url.match(/almarai-arabic-(\d+)/)[1]).sort();
  if (lang === 'en') {
    // The one Arabic word on an English page is the language toggle, in 700.
    check(`${lang} ${path}: no Almarai beyond the language toggle's weight`, almarai.every((w) => w === '700'), almarai.join(',') || 'none');
  } else {
    check(`${lang} ${path}: Arabic still gets Almarai`, almarai.length >= 2, almarai.join(','));
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
