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
 * And phase 2:
 *   every page  P2.6   strings arrive with the code that shows them: a page
 *                      holds at start only a fraction of the table and no
 *                      other page's strings, never asks for the full table,
 *                      switches language without a download, and a key that
 *                      slipped through shows nothing raw and comes right.
 *               P2.8   one variable Inter file (preloaded, fetched once)
 *                      instead of a file per weight; English pages draw the
 *                      "العربية" toggle with a 5 KB subset, not Almarai.
 *               P2.19  three.js is a chunk of its own, loaded only where it
 *                      was (/t, the Stadium view, Match Day), and once.
 *   /community  P2.16  the bell's poll asks for the unread count alone, and
 *                      the list only when it is opened (falling back to the
 *                      list on a server without the route).
 *   /projects   P2.4   the owner's private pictures are fetched no-store.
 *   build       P2.3   every text file has a .br and a .gz that decompress
 *                      to it exactly, and nothing else is compressed.
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

// ===========================================================================
// Phase 2
// ---------------------------------------------------------------------------
const TITLE = 'Sky & navy chevrons, with a four-block stand banner';
const design = (await (await fetch(B + '/api/gallery?templates=1&limit=100')).json()).find((it) => it.title === TITLE)?.id;
const me = async (token) => (await (await fetch(B + '/api/me', { headers: { authorization: 'Bearer ' + token } })).json());

/** Loads a page cold and keeps every response body that is JavaScript, and the i18n warnings. */
async function visit(path, { lang = 'en', token = null, w = 1440, h = 900, settle = 2500, routes = [], before } = {}) {
  const o = await open({ lang, token, w, h, routes });
  const bodies = new Map();
  const warns = [];
  o.p.on('console', (m) => { if (m.type() === 'warning' && m.text().startsWith('[i18n]')) warns.push(m.text()); });
  o.p.on('response', async (r) => { if (/\.js$/.test(new URL(r.url()).pathname)) bodies.set(r.url(), await r.text().catch(() => '')); });
  if (before) await before(o);
  await o.p.goto(B + path, { waitUntil: 'load', timeout: 120000 });
  await o.p.waitForTimeout(settle);
  return { ...o, bodies, warns };
}
/** The keys every string table in these scripts carries (the old one-chunk table counts too). */
const keysIn = (bodies) => {
  const keys = new Set();
  for (const js of bodies.values()) for (const m of js.matchAll(/"([A-Za-z][\w-]*(?:\.[\w-]+)+)":(?:\["|\{en:)/g)) keys.add(m[1]);
  return keys;
};
const fontFiles = (asked) => asked.map((r) => new URL(r.url).pathname).filter((u) => /\.woff2?$/.test(u)).map((u) => u.split('/').pop());

console.log('\n— P2.6: each page holds its own strings, not every page\'s —');
const ALL_KEYS = (await (await import('node:fs')).promises.readFile(new URL('./src/ui/i18n/strings.ts', 'file://' + process.cwd() + '/'), 'utf8').catch(() => ''))
  .match(/^\s*'[\w.-]+':\s*\{/gm)?.length ?? 1852;
const signed = await account(1);
for (const [path, name, budget, foreign] of [
  ['/legal', 'legal', 30, /^(ed|cm|pj|ac|bn|ai|st|np|clubs|sh|seat)\./],
  ['/reset?token=x', 'reset', 60, /^(ed|cm|pj|bn|ai|st|np|lg|clubs|sh|seat)\./],
  ['/clubs', 'clubs', 100, /^(ed|cm|pj|ac|bn|ai|lg|rs|ly|seat)\./],
  ['/', 'landing', 200, /^(ed|pj|ac|bn|ai|lg|rs|ly|mb|seat)\./],
  ['/community', 'community', 250, /^(ed\.ai|ac|bn|ai|lg|rs|ly|mb|st|np)\./],
  [`/s/${design}`, 'seat', 80, /^(ed|cm|pj|ac|bn|ai|lg|rs|clubs)\./],
  [`/t/${design}`, 'share', 350, /^(ed\.ai|pj|ac|bn|lg|rs|ly)\./],
  ['/account', 'account', 300, /^(cm|pj|bn|ai|lg|clubs|st|np|ly|sh|seat)\./],
  ['/projects', 'projects', 400, /^(cm|bn|ai|lg|rs|ly|sh|seat)\./],
  // The editor loads most of its panels within its first seconds: still well under the whole table.
  [`/d/${design}`, 'editor', 1100, /^(lg|rs|clubs)\./],
]) {
  const v = await visit(path, { token: ['account', 'projects'].includes(name) ? signed : null });
  const keys = keysIn(v.bodies);
  const odd = [...keys].filter((k) => foreign.test(k));
  check(`${name}: ${keys.size} strings at start (of ${ALL_KEYS}), within ${budget}`, keys.size > 0 && keys.size <= budget, `${keys.size}`);
  check(`${name}: none of another page's strings`, odd.length === 0, odd.slice(0, 6).join(' '));
  check(`${name}: never asks for the full table, no key missing`, !paths(v.asked, /^\/assets\/strings-/).length && v.warns.length === 0, v.warns.join(' | ').slice(0, 200));
  check(`${name}: no page errors`, v.errs.length === 0, v.errs.join(' | '));
  await v.ctx.close();
}
for (const [path, name] of [['/', 'landing'], ['/community', 'community'], [`/t/${design}`, 'share'], [`/d/${design}`, 'editor']]) {
  const v = await visit(path, { lang: 'ar' });
  check(`${name} in Arabic: never asks for the full table, no key missing`, !paths(v.asked, /^\/assets\/strings-/).length && v.warns.length === 0, v.warns.join(' | ').slice(0, 200));
  await v.ctx.close();
}
{
  // The toggle switches language with what the page already holds.
  const v = await visit('/');
  const n = v.asked.length;
  await v.p.click('#lang-toggle');
  const ar = await until(v.p, () => document.documentElement.lang === 'ar' && document.querySelector('[data-i18n="nav.how"]')?.textContent === 'كيف يشتغل', null, 10000);
  await v.p.waitForTimeout(800);
  const later = v.asked.slice(n).filter((r) => /\.js$/.test(new URL(r.url).pathname));
  check('landing: the language toggle switches to Arabic at once', ar);
  check('without downloading any strings', !later.some((r) => /strings-|i18n-/.test(r.url)) && v.warns.length === 0, later.map((r) => new URL(r.url).pathname).join(' '));
  await v.ctx.close();
}
{
  // A key a page's table lacks (one taken out of the landing's own table on
  // the way in): it is never shown raw, the full table is fetched, and the
  // label comes right.
  const seen = [];
  const v = await visit('/', {
    routes: [[(u) => /^\/assets\/landing-[\w-]+\.js$/.test(u.pathname), async (route) => {
      const r = await route.fetch();
      await route.fulfill({ response: r, body: (await r.text()).replace(/"nav\.how":\["[^"]*","[^"]*"\],?/, '') });
    }]],
    before: async (o) => o.ctx.addInitScript(() => {
      new MutationObserver(() => {
        const el = document.querySelector('[data-i18n="nav.how"]');
        if (el) (window.__seen ??= []).push(el.textContent);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    }),
  });
  const right = await until(v.p, () => document.querySelector('[data-i18n="nav.how"]')?.textContent === 'How it works', null, 15000);
  seen.push(...(await v.p.evaluate(() => window.__seen ?? [])));
  check('a key missing from its table is never shown raw', right && !seen.includes('nav.how'), [...new Set(seen)].join(' / ').slice(0, 120));
  check('the page warns and fetches the full table once', v.warns.length >= 1 && paths(v.asked, /^\/assets\/strings-/).length === 1, `${v.warns.length} warnings, ${paths(v.asked, /^\/assets\/strings-/).length} fetches`);
  check('and no page errors', v.errs.length === 0, v.errs.join(' | '));
  await v.ctx.close();
}

console.log('\n— P2.8: one variable Inter file, preloaded; no Arabic font for the toggle —');
for (const [path, name, token] of [['/', 'landing'], ['/clubs', 'clubs'], ['/legal', 'legal'], ['/reset?token=x', 'reset'], ['/tifo-spec', 'spec'], ['/account', 'account', signed], ['/projects', 'projects', signed]]) {
  // /tifo-spec has no script and is English only.
  for (const lang of name === 'spec' ? ['en'] : ['en', 'ar']) {
    const v = await visit(path, { lang, token });
    const files = fontFiles(v.asked);
    const html = await (await fetch(B + path)).text();
    const pre = /<link rel="preload" href="(\/assets\/inter-latin-wght-normal-[\w-]+\.woff2)" as="font" type="font\/woff2" crossorigin>/.exec(html)?.[1];
    const inter = files.filter((f) => /^inter-/.test(f));
    const bytes = (await v.p.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\.woff2?$/.test(e.name)).reduce((t, e) => t + e.encodedBodySize, 0)));
    check(`${name} ${lang}: preloads the variable Inter Latin file`, !!pre);
    check(`${name} ${lang}: Inter is that one file, fetched once`, inter.length === 1 && !!pre && pre.endsWith(inter[0]), inter.join(' '));
    if (lang === 'en') {
      check(`${name} en: no Arabic font file, the toggle's 5 KB subset at most`, !files.some((f) => /^almarai-arabic-/.test(f)) && files.filter((f) => /^almarai-toggle-/.test(f)).length <= 1, files.join(' '));
      check(`${name} en: at most 5 font files and 100 KB (${files.length}, ${Math.round(bytes / 1024)} KB)`, files.length <= 5 && bytes <= 100 * 1024, files.join(' '));
    } else {
      check(`${name} ar: Arabic still drawn in Almarai`, files.some((f) => /^almarai-arabic-/.test(f)) && !files.some((f) => /^almarai-toggle-/.test(f)), files.join(' '));
    }
    await v.ctx.close();
  }
}

console.log('\n— P2.19: three.js on its own, only where it was, and once —');
for (const [path, name] of [['/', 'landing'], ['/community', 'community'], ['/clubs', 'clubs'], ['/legal', 'legal'], [`/s/${design}`, 'seat'], [`/d/${design}`, 'editor']]) {
  const v = await visit(path);
  check(`${name}: no three.js at load`, !chunk(v.asked, 'three') && !chunk(v.asked, 'preview3d'));
  if (name === 'seat') check('seat: the match-day seat page still works', await until(v.p, () => !!document.querySelector('.seat-title')?.textContent.trim(), null, 20000) && v.errs.length === 0, v.errs.join(' | '));
  await v.ctx.close();
}
{
  const v = await visit(`/t/${design}`, { settle: 4000 });
  const three = paths(v.asked, /^\/assets\/three-[\w-]+\.js$/);
  const p3 = [...v.bodies.entries()].find(([u]) => /\/assets\/preview3d-/.test(u))?.[1] ?? '';
  check('/t: three.js is its own chunk, fetched once', three.length === 1, `${three.length}`);
  check('/t: and preview3d no longer carries it', p3.length > 0 && p3.length < 200 * 1024, `${Math.round(p3.length / 1024)} KB`);
  check('/t: the stadium is drawn', await until(v.p, () => !!document.querySelector('canvas'), null, 60000));
  check('/t: no page errors', v.errs.length === 0, v.errs.join(' | '));
  await v.ctx.close();
}
for (const [path, name, ready] of [
  ['/app?new=1&template=anfield-61k&quality=low&e2e=1', 'Stadium view', () => !!window.__tifoPreview],
  ['/app?new=1&template=jewel-jeddah-60k-rb&sim=1', 'Match Day', () => !!document.querySelector('.mds-overlay canvas')],
]) {
  const v = await visit(path, { settle: 500 });
  if (name === 'Stadium view') {
    await until(v.p, () => /\d/.test(document.getElementById('stat')?.textContent || ''), null, 120000);
    if (!(await v.p.evaluate(() => document.getElementById('view-3d')?.classList.contains('active')))) await v.p.click('#view-3d').catch(() => {});
  }
  check(`editor: ${name} opens`, await until(v.p, ready, null, 120000));
  check(`editor: ${name} fetched three.js once`, paths(v.asked, /^\/assets\/three-[\w-]+\.js$/).length === 1, `${paths(v.asked, /^\/assets\/three-[\w-]+\.js$/).length}`);
  check(`editor: ${name} without page errors`, v.errs.length === 0, v.errs.join(' | '));
  await v.ctx.close();
}

console.log('\n— P2.16: the bell asks for the count, and for the list only when opened —');
{
  const token = await account();
  const id = (await me(token)).id;
  for (const mode of ['route', 'old server']) {
    // A new follower each time: one unread notification (opening the bell
    // in the round before marked the last one read).
    const fan = await account();
    const f = await fetch(`${B}/api/users/${id}/follow`, { method: 'POST', headers: { authorization: 'Bearer ' + fan, 'content-type': 'application/json' }, body: '{}' });
    if (!f.ok) console.log(`  (follow answered ${f.status})`);
    // 'route' asks the server's own GET /api/notifications/unread; 'old server'
    // answers it 404 the way a server from before the route does (a deploy
    // where the pages arrive first), so the fallback to the list is tested.
    const routes = mode === 'route'
      ? []
      : [[(u) => u.pathname === '/api/notifications/unread', async (route) => {
          try {
            await route.fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'not found' }) });
          } catch { /* the page closed while this was in flight */ }
        }]];
    const v = await visit('/community', { token, routes, before: (o) => o.ctx.clock.install() });
    check(`${mode}: the unread dot shows`, await until(v.p, () => document.getElementById('notif-dot') && !document.getElementById('notif-dot').hidden, null, 30000));
    await v.p.clock.fastForward(61_000);
    await v.p.waitForTimeout(1500);
    const counts = paths(v.asked, /^\/api\/notifications\/unread$/).length;
    const lists = () => paths(v.asked, /^\/api\/notifications$/).length;
    if (mode === 'route') {
      check('route: the first check and the 60 s poll ask for the count', counts >= 2, `${counts} count requests`);
      check('route: and never for the list', lists() === 0, `${lists()} list requests`);
    } else {
      check('old server: the count route 404s once, then the list answers', counts === 1 && lists() >= 2, `${counts} count, ${lists()} list requests`);
    }
    const before = lists();
    await v.p.click('#notif-btn');
    check(`${mode}: opening the bell fetches the list`, await until(v.p, () => !!document.querySelector('#notif-panel .notif-item, #notif-panel .notif-empty'), null, 15000) && lists() > before);
    await v.ctx.close();
  }
}

console.log('\n— P2.4: the owner\'s private pictures are fetched no-store —');
{
  const token = await account(2);
  const { projects } = await (await fetch(B + '/api/projects', { headers: { authorization: 'Bearer ' + token } })).json();
  const pub = projects[0];
  const r = await fetch(`${B}/api/designs/${pub.id}`, { method: 'PATCH', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ isPublic: true }) });
  const priv = projects[1];
  // The cache mode the page asks fetch() for, per picture. (A no-store fetch
  // carries no request header that says so; Chrome adds Pragma and
  // Cache-Control only to a reload.)
  const v = await visit('/projects', { token, w: 1366, h: 860, before: (o) => o.ctx.addInitScript(() => {
    const real = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/thumbnail\.png$/.test(url)) (window.__thumbs ??= []).push({ url, cache: init?.cache ?? (input instanceof Request ? input.cache : 'default') });
      return real.apply(this, arguments);
    };
  }) });
  await until(v.p, () => document.querySelectorAll('#pj-grid img[data-bowl]').length >= 2, null, 30000);
  const got = await v.p.evaluate(() => window.__thumbs ?? []);
  const of = (id) => got.find((q) => q.url.includes(id));
  check('a private picture is fetched with cache: no-store', of(priv.id)?.cache === 'no-store', JSON.stringify(of(priv.id) ?? null));
  check('a public one keeps the normal cache', r.ok && of(pub.id)?.cache === 'default', r.ok ? JSON.stringify(of(pub.id) ?? null) : `publish ${r.status}`);
  await v.ctx.close();
}

console.log('\n— P2.3: pre-compressed copies (needs DIST= to read the build) —');
if (process.env.DIST) {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, extname } = await import('node:path');
  const { brotliDecompressSync, gunzipSync } = await import('node:zlib');
  const walk = (d, o = []) => { for (const n of readdirSync(d)) { const q = join(d, n); statSync(q).isDirectory() ? walk(q, o) : o.push(q); } return o; };
  const all = walk(process.env.DIST);
  const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.wasm']);
  const text = all.filter((f) => TEXT.has(extname(f)));
  let bad = 0, pairs = 0;
  for (const f of all.filter((x) => /\.(br|gz)$/.test(x))) {
    const orig = f.replace(/\.(br|gz)$/, '');
    if (!TEXT.has(extname(orig))) { bad++; continue; }
    const back = f.endsWith('.br') ? brotliDecompressSync(readFileSync(f)) : gunzipSync(readFileSync(f));
    if (!back.equals(readFileSync(orig))) bad++;
    pairs++;
  }
  const withBr = text.filter((f) => all.includes(f + '.br')).length;
  check(`every text file has its brotli copy (${withBr} of ${text.length})`, withBr >= text.length * 0.95, `${text.length - withBr} without`);
  check(`all ${pairs} pairs decompress to their original, and only text is compressed`, pairs > 0 && bad === 0, `${bad} bad`);
} else console.log('  (skipped: set DIST=<path to dist>)');

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
