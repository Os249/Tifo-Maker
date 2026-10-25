/**
 * Arabic coverage guard.
 *
 * The site drifted back into English because nothing failed when a string
 * shipped without a translation: the editor's whole runtime UI layer had no
 * t() call in it, and index.html's tooltips and dropdowns had no data-i18n.
 * Nobody notices until an Arabic-speaking user files a bug.
 *
 * So this loads every page and opens every modal with tifo_lang_v1=ar and
 * fails on any text that is still English. "Still English" means the string is
 * predominantly Latin script — a translated string that happens to contain
 * "PDF" or "tifomaker.org" is fine, a string that is entirely Latin words is
 * not — minus an explicit allow-list of things that stay in English on purpose.
 *
 * Each chunk carries the strings of its own code (performance plan P2.6), so
 * every page and dialog opened here is also watched for a key its tables
 * lacked: ui/i18n.ts warns "[i18n] ..." and fetches the full table when that
 * happens, and either one fails the run. A pass in English then checks every
 * page shows its strings, never a raw key and never an empty label.
 */
import { chromium } from 'playwright';
const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());

const AR_LS = [
  { name: 'tifo_lang_v1', value: 'ar' },
  { name: 'tifo_consent_v1', value: 'all' },
  { name: 'tifo_onboarded_v1', value: '1' },
  { name: 'tifo_news_banners_v1', value: '1' }, { name: 'tifo_news_leagues_v2', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' },
];
const state = (extra = []) => ({ cookies: [], origins: [{ origin: B, localStorage: [...AR_LS, ...extra] }] });

// Every page the suite opens is watched for a string its tables lacked.
const misses = [];
const newContext = browser.newContext.bind(browser);
browser.newContext = async (...args) => {
  const ctx = await newContext(...args);
  ctx.on('page', (p) => {
    p.on('console', (m) => { if (m.type() === 'warning' && m.text().startsWith('[i18n]')) misses.push(`${p.url()}: ${m.text()}`); });
    p.on('request', (r) => { if (/\/assets\/strings-[\w-]+\.js$/.test(r.url())) misses.push(`${p.url()}: fetched the full string table`); });
  });
  return ctx;
};

/**
 * Kept in English deliberately: the brand, file formats, units, hex colours,
 * the language toggle (it names the OTHER language), single-letter keyboard
 * hints and avatar initials, and the social handles.
 */
const ALLOW = new Set([
  'TIFO', 'MAKER', 'TIFOMAKER', 'TifoMaker', 'tifomaker.org', 'English', 'العربية',
  'PNG', 'JPG', 'SVG', 'PDF', 'CSV', 'GIF', 'WebM', 'MP4', 'QR', 'AI', 'RTL',
  'CSV + PDF', 'PDF + CSV', '@OS99GameDev', '@OSNGameDev', 'Zaunfahne', 'tifomaker', '@tifomaker',
  'Ctrl', // a key's own label, which an Arabic keyboard prints too
]);
const ALLOW_RE = [
  /^[^\p{L}]*$/u,                         // digits, punctuation, symbols only
  /^[A-Za-z]$/,                            // single letters: kbd hints, avatar initial
  /^\.?[a-z0-9]{2,5}$/,                    // file extensions and short codes
  /^\d[\d.,]*\s*(k\+?|px|ms|s|MB|KB)?$/i,  // measurements
  /^#[0-9a-fA-F]{3,8}$/,                   // hex colours
  /^[\w.+-]+@[\w.-]+$/,                    // emails
  /^https?:\/\//,
];
const AR_SCRIPT = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/g;

function suspect(s) {
  const t = s.trim();
  if (!t || ALLOW.has(t)) return false;
  if (ALLOW_RE.some((r) => r.test(t))) return false;
  if (AR_SCRIPT.test(t)) return false;                  // translated; Latin tokens inside are fine
  const words = t.match(LATIN_WORD);
  return !!words && words.length >= 1;
}

function scrapePage() {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const s = (n.textContent || '').trim();
    if (!s) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE)$/.test(el.tagName)) continue;
    if (el.closest('[hidden],[inert],[lang="en"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    out.push({ text: s.slice(0, 120), where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
    if (el.closest('[hidden],[inert],[lang="en"]') || el.hasAttribute('hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && v.trim()) out.push({ text: v.trim().slice(0, 120), where: `@${a} ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` });
    }
  }
  for (const sel of document.querySelectorAll('select')) {
    if (sel.closest('[hidden]')) continue;
    const r = sel.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    for (const o of sel.options) if (o.textContent.trim()) out.push({ text: o.textContent.trim().slice(0, 120), where: `option ${sel.id ? '#' + sel.id : ''}` });
  }
  return out;
}

let pass = 0, fail = 0;
const report = (surface, rows) => {
  const bad = [];
  const seen = new Set();
  for (const r of rows) {
    if (!suspect(r.text)) continue;
    const k = r.text + r.where;
    if (seen.has(k)) continue;
    seen.add(k);
    bad.push(r);
  }
  if (bad.length === 0) { pass++; console.log(`  PASS  ${surface}`); return; }
  fail++;
  console.log(`  FAIL  ${surface} — ${bad.length} untranslated`);
  for (const b of bad.slice(0, 12)) console.log(`          [${b.where}] ${b.text}`);
  if (bad.length > 12) console.log(`          … and ${bad.length - 12} more`);
};

async function page(path, { width = 1440, height = 960, wait = 2500, extraLs = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, storageState: state(extraLs) });
  const p = await ctx.newPage();
  p.on('pageerror', () => {});
  await p.goto(B + path, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(wait);
  return [ctx, p];
}

console.log('\n— pages in Arabic —');
for (const [path, name] of [['/', 'landing'], ['/community', 'community'], ['/clubs', 'clubs'],
                            ['/legal', 'legal'], ['/reset', 'reset'], ['/d/nope', 'shared viewer (phone)']]) {
  const [ctx, p] = await page(path, path === '/d/nope' ? { width: 390, height: 844, wait: 4000 } : {});
  report(name, await p.evaluate(scrapePage));
  await ctx.close();
}

console.log('\n— projects in Arabic —');
{
  const [ctx, p] = await page('/projects');
  report('projects page (empty)', await p.evaluate(scrapePage));
  await p.click('#pj-empty-new');
  await p.waitForTimeout(700);
  report('start flow: who do you support', await p.evaluate(scrapePage));
  await p.fill('#st-search', 'الوحدة');
  await p.waitForTimeout(300);
  report('start flow: a club that is not listed', await p.evaluate(scrapePage));
  await p.click('#st-custom');
  await p.waitForTimeout(500);
  report('start flow: where does it play', await p.evaluate(scrapePage));
  await p.click('.st-ground[data-id="alfaisal-jeddah-27k"]');
  await p.waitForTimeout(500);
  report('start flow: how to start, with colours to pick', await p.evaluate(scrapePage));
  await p.click('.st-opt[data-start="pattern"]');
  await p.waitForTimeout(300);
  report('start flow: stripes', await p.evaluate(scrapePage));
  await p.click('.st-opt[data-start="ai"]');
  await p.waitForTimeout(1500);
  report('start flow: the AI side, signed out', await p.evaluate(scrapePage));
  await ctx.close();
}
{
  const now = Date.now();
  const one = [{ id: 'la1b2c3d4e5f6a7b', title: 'تيفو الديربي', templateId: 'jewel-jeddah-60k-rb', templateVersion: 1, createdAt: now, updatedAt: now, pinned: true, deletedAt: null, origin: 'ai' },
               { id: 'lb1b2c3d4e5f6a7b', title: 'قديم', templateId: 'generic-bowl-60k', templateVersion: 1, createdAt: now, updatedAt: now, pinned: false, deletedAt: now, origin: null }];
  const [ctx, p] = await page('/projects', { extraLs: [{ name: 'tifo_projects_v1', value: JSON.stringify(one) }] });
  report('projects page (a project, a pin, the trash button)', await p.evaluate(scrapePage));
  await p.click('.pj-card .pj-more');
  await p.waitForTimeout(400);
  report('project menu', await p.evaluate(scrapePage));
  await p.keyboard.press('Escape');
  await p.click('#pj-trash-btn');
  await p.waitForTimeout(400);
  report('the trash', await p.evaluate(scrapePage));
  await ctx.close();
}

console.log('\n— the phone gate —');
{
  const [ctx, p] = await page('/app?new=1', { width: 360, height: 680, wait: 1500 });
  report('phone gate', await p.evaluate(scrapePage));
  await ctx.close();
}

console.log('\n— the editor and its panels —');
{
  const [ctx, p] = await page('/app?new=1', { wait: 6000 });
  await p.waitForTimeout(1200);
  report('editor', await p.evaluate(scrapePage));
  const sections = await p.evaluate(() => [...document.querySelectorAll('#panel .panel-section')].map((s) => s.id).filter(Boolean));
  for (const id of sections) {
    await p.evaluate((i) => { const el = document.getElementById(i); if (el) { el.classList.remove('ctx-hidden'); el.hidden = false; } }, id);
  }
  await p.waitForTimeout(600);
  report('editor panels', await p.evaluate(scrapePage));
  for (const [sel, name] of [['#rail-stadium', 'stadium panel'], ['#rail-ai', 'AI panel'],
                             ['#rail-anim', 'animation panel'], ['#banner-studio-btn', 'Banner Studio'],
                             ['#gallery', 'gallery modal'], ['#signin', 'auth modal']]) {
    await p.click(sel, { timeout: 4000, force: true }).catch(() => {});
    await p.waitForTimeout(1500);
    report(name, await p.evaluate(scrapePage));
    await p.keyboard.press('Escape').catch(() => {});
    await p.evaluate(() => document.querySelectorAll('.auth-backdrop,.feed-backdrop,.bstudio-overlay').forEach((e) => e.remove()));
    await p.waitForTimeout(400);
  }
  await ctx.close();
}

// A ground built from a real venue. Its name in the status bar, its details and
// its non-affiliation notice only appear once one is loaded, and ten of the
// thirteen built-in grounds are like that — so the default ground above, which
// is not, left all three unchecked. The status bar printed the template's raw
// id and the notice was English.
// The rebuilt Jewel adds its ramps, platforms, boxes and screens to the panel;
// the earlier Jewel adds the "a newer version exists" note and its button.
for (const [id, label] of [
  ['jewel-jeddah-60k-rb', 'stadium panel, a real-venue ground with details'],
  ['community-jewel-jeddah-62k', 'stadium panel, a ground that has been rebuilt'],
  // The Jewel before its real blocks: the "earlier layout" name and its note.
  ['jewel-jeddah-60k', 'stadium panel, a ground re-laid in its real blocks'],
]) {
  const [ctx, p] = await page(`/app?new=1&template=${id}`, { wait: 6000 });
  await p.waitForTimeout(800);
  await p.click('#rail-stadium', { timeout: 4000, force: true }).catch(() => {});
  await p.waitForTimeout(1500);
  report(label, await p.evaluate(scrapePage));
  await ctx.close();
}

console.log('\n— first run (the start flow + cookie banner) —');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [{ name: 'tifo_lang_v1', value: 'ar' }] }] } });
  const p = await ctx.newPage();
  p.on('pageerror', () => {});
  await p.goto(B + '/projects?new=1', { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(2500);
  report('start flow + consent', await p.evaluate(scrapePage));
  await ctx.close();
}

// The banners news and the Banner view's tour: both are what an Arabic
// reader sees first of banners, and both are built in code, not in the HTML
// the rest of this suite reads.
console.log('\n— the banners news and the banner tour —');
{
  const ls = AR_LS.filter((x) => !/news_banners|banner_tour/.test(x.name));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 },
    storageState: { cookies: [], origins: [{ origin: B, localStorage: ls }] } });
  const p = await ctx.newPage();
  p.on('pageerror', () => {});
  await p.goto(B + '/app?new=1', { waitUntil: 'networkidle', timeout: 60000 });
  // News comes to someone reopening a tifo, never on top of one being started.
  await p.waitForFunction(() => /[?&]local=/.test(location.search), null, { timeout: 60000 }).catch(() => {});
  await p.goto(p.url(), { waitUntil: 'networkidle', timeout: 60000 });
  const card = await p.waitForSelector('#news-card', { timeout: 20000 }).catch(() => null);
  if (!card) { fail++; console.log('  FAIL  banners news — it never appeared'); }
  else {
    report('banners news', await p.evaluate(scrapePage));
    await p.click('#news-try');
    await p.waitForSelector('.tour-overlay', { timeout: 10000 }).catch(() => null);
    let steps = 0;
    for (let i = 0; i < 10 && (await p.$('.tour-overlay')); i++) {
      await p.waitForTimeout(400);
      steps++;
      report(`banner tour, step ${steps}`, await p.evaluate(scrapePage));
      await p.click('#tour-next');
    }
    if (steps === 0) { fail++; console.log('  FAIL  banner tour — it never started'); }
  }
  await ctx.close();
}

console.log('\n— pages in English: every string there, no raw key, no empty label —');
{
  // The keys, read from the one source of truth (the way scripts/verify-superai.mts does).
  const src = (await import('node:fs')).readFileSync(new URL('./src/ui/i18n/strings.ts', 'file://' + process.cwd() + '/'), 'utf8');
  const KEYS = [...src.matchAll(/^\s*'([\w.-]+)':\s*\{/gm)].map((m) => m[1]);
  const g = await (await fetch(B + '/api/gallery?templates=1&limit=5')).json();
  const id = g[0]?.id ?? 'nope';
  const EN_LS = AR_LS.map((x) => (x.name === 'tifo_lang_v1' ? { ...x, value: 'en' } : x));
  for (const [path, name, w, h] of [['/', 'landing', 1440, 960], ['/', 'landing (phone)', 390, 844], ['/community', 'community', 1440, 960],
                                    ['/clubs', 'clubs', 1440, 960], ['/legal', 'legal', 1440, 960], ['/reset', 'reset', 1440, 960],
                                    ['/projects', 'projects', 1440, 960], ['/account', 'account', 1440, 960], [`/t/${id}`, 'share', 1440, 960],
                                    [`/s/${id}`, 'seat (phone)', 390, 844], [`/d/${id}`, 'editor', 1440, 960]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: { cookies: [], origins: [{ origin: B, localStorage: EN_LS }] } });
    const p = await ctx.newPage();
    p.on('pageerror', () => {});
    await p.goto(B + path, { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(2500);
    const bad = await p.evaluate((keys) => {
      const K = new Set(keys);
      const out = [];
      for (const el of document.querySelectorAll('[data-i18n]')) {
        const k = el.getAttribute('data-i18n');
        // A status line (aria-live) is emptied on purpose once its news is old.
        if (el.closest('[aria-live],[role="status"],[hidden]')) continue;
        if (K.has(k) && !el.textContent.trim() && !el.children.length) out.push(`empty [data-i18n=${k}]`);
      }
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (K.has(n.textContent.trim())) out.push(`raw key "${n.textContent.trim()}"`);
      for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
        for (const a of ['placeholder', 'title', 'aria-label']) if (K.has((el.getAttribute(a) ?? '').trim())) out.push(`raw key in @${a}: ${el.getAttribute(a)}`);
      }
      return out;
    }, KEYS);
    if (bad.length) { fail++; console.log(`  FAIL  ${name} (en) — ${bad.slice(0, 8).join('; ')}`); }
    else { pass++; console.log(`  PASS  ${name} (en)`); }
    await ctx.close();
  }
}

// The Arabic pages under /ar/ (performance plan P3.3) carry their Arabic in
// the HTML, so the first frame must already be Arabic and right to left. What
// the first frame shows is what the HTML paints before any module script has
// run, so the page is loaded here with every script but theme-boot.js refused,
// in a fresh browser with no saved language (an English one: nothing but the
// address may make the page Arabic). Then once more with its scripts, to see
// the page stays where it is and stays Arabic.
console.log('\n— the Arabic pages at their first paint (/ar/, no saved language, English browser) —');
{
  const g = await (await fetch(B + '/api/gallery?templates=1&limit=5')).json();
  const id = g[0]?.id ?? 'nope';
  for (const [path, name, w, h] of [['/ar/', 'landing', 1440, 960], ['/ar/', 'landing (phone)', 390, 844], ['/ar/community', 'community', 1440, 960],
                                    ['/ar/community', 'community (phone)', 390, 844], ['/ar/clubs', 'clubs', 1440, 960], ['/ar/legal', 'legal', 1440, 960],
                                    ['/ar/reset', 'reset', 1440, 960], ['/ar/projects', 'projects', 1440, 960], ['/ar/account', 'account', 1440, 960],
                                    [`/ar/t/${id}`, 'share', 1440, 960], [`/ar/t/${id}`, 'share (phone)', 390, 844], [`/ar/s/${id}`, 'seat (phone)', 390, 844],
                                    [`/ar/d/${id}`, 'editor', 1440, 960], ['/ar/app?new=1', 'new project', 1440, 960]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'en-US' });
    const p = await ctx.newPage();
    p.on('pageerror', () => {});
    await p.route(/\/assets\/(?!theme-boot-)[^/]+\.js(\?|$)/, (r) => r.abort());
    await p.goto(B + path, { waitUntil: 'load', timeout: 60000 });
    const root = await p.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, flow: getComputedStyle(document.body).direction, title: document.title, at: location.pathname,
      toggle: document.getElementById('lang-toggle')?.textContent?.trim() ?? 'English' }));
    // The toggle names the other language: English, on an Arabic page.
    const rtl = root.lang === 'ar' && root.dir === 'rtl' && root.flow === 'rtl' && /[؀-ۿ]/.test(root.title) && root.at === path.split('?')[0] && root.toggle === 'English';
    if (!rtl) { fail++; console.log(`  FAIL  ${name} first paint — ${JSON.stringify(root)}`); }
    else report(`${name}, first paint (Arabic, right to left, before any page script)`, await p.evaluate(scrapePage));
    await ctx.close();
  }
  for (const [path, name] of [['/ar/', 'landing'], ['/ar/community', 'community'], ['/ar/clubs', 'clubs'], [`/ar/t/${id}`, 'share']]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' });
    const p = await ctx.newPage();
    p.on('pageerror', () => {});
    await p.goto(B + path, { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(1500);
    const at = await p.evaluate(() => location.pathname);
    if (at !== path) { fail++; console.log(`  FAIL  ${name}: a fresh English browser was moved from ${path} to ${at}`); }
    else report(`${name}, once its scripts ran (still ${path})`, await p.evaluate(scrapePage));
    await ctx.close();
  }
}

// The toggle and the address (performance plan P3.3). An /ar/ address is
// always the Arabic page; the toggle takes the address to the twin, in place,
// and saves the choice; an English address showing Arabic because Arabic was
// saved takes its Arabic twin's address, in place. Nothing ever navigates on
// its own, so a page is fetched once, and a browser that chose nothing (a
// crawler, say) is never moved from the address it asked for.
console.log('\n— the toggle and the address —');
{
  const flow = (n, ok, x = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
  const at = (p) => { const u = new URL(p.url()); return u.pathname + u.search; };
  const docs = (p) => { const list = []; p.on('request', (r) => { if (r.resourceType() === 'document') list.push(new URL(r.url()).pathname); }); return list; };
  {
    const ctx = await browser.newContext({ locale: 'en-US' });
    const p = await ctx.newPage();
    await p.goto(B + '/ar/community', { waitUntil: 'networkidle' });
    flow('a fresh English browser stays on the Arabic page, in Arabic', at(p) === '/ar/community' && (await p.evaluate(() => document.documentElement.lang === 'ar' && document.documentElement.dir === 'rtl')), at(p));
    await p.click('#lang-toggle');
    await p.waitForTimeout(300);
    flow('the toggle takes the address to the English twin, in English', at(p) === '/community' && (await p.evaluate(() => document.documentElement.lang === 'en')), at(p));
    flow('saves the choice', (await p.evaluate(() => localStorage.getItem('tifo_lang_v1'))) === 'en');
    flow('and the links on the page are the English pages', await p.evaluate(() => [...document.querySelectorAll('a[href^="/"]')].every((a) => !a.getAttribute('href').startsWith('/ar/'))));
    const seen = docs(p);
    await p.goto(B + '/ar/clubs', { waitUntil: 'networkidle' });
    flow('with English saved, an Arabic address is still the Arabic page', at(p) === '/ar/clubs' && (await p.evaluate(() => document.documentElement.lang === 'ar')) && seen.length === 1, `${at(p)} ${seen.join(' -> ')}`);
    await p.click('#lang-toggle');
    await p.waitForTimeout(300);
    flow('the toggle there goes to /clubs', at(p) === '/clubs', at(p));
    await p.click('#lang-toggle');
    await p.waitForTimeout(300);
    flow('and back to /ar/clubs, its links Arabic', at(p) === '/ar/clubs' && (await p.evaluate(() => document.querySelector('a.brand')?.getAttribute('href') === '/ar/')), at(p));
    const seen2 = docs(p);
    await p.goto(B + '/legal#privacy', { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    flow('with Arabic saved, an English address takes its Arabic twin\'s address, fetched once', at(p) === '/ar/legal' && seen2.length === 1 && (await p.evaluate(() => document.documentElement.lang === 'ar' && /-ar$/.test(location.hash))), `${at(p)}${await p.evaluate(() => location.hash)} ${seen2.join(' -> ')}`);
    await p.goto(B + '/reset?token=abc', { waitUntil: 'networkidle' });
    flow('a reset link keeps its token for the page to read, then drops it', at(p) === '/ar/reset' && (await p.evaluate(() => document.documentElement.lang === 'ar')), at(p));
    await p.goto(B + '/tifo-spec', { waitUntil: 'networkidle' });
    flow('the English-only spec keeps its address', at(p) === '/tifo-spec', at(p));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ locale: 'ar-SA' });
    const p = await ctx.newPage();
    await p.goto(B + '/clubs', { waitUntil: 'networkidle' });
    flow('a fresh Arabic browser keeps the English address, translated in place as before', at(p) === '/clubs' && (await p.evaluate(() => document.documentElement.lang === 'ar')), at(p));
    flow('with links to the Arabic pages', await p.evaluate(() => document.querySelector('a.brand')?.getAttribute('href') === '/ar/'));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ storageState: state() });
    const p = await ctx.newPage();
    const seen = docs(p);
    await p.goto(B + '/app?new=1', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForFunction(() => /[?&]local=/.test(location.search), null, { timeout: 60000 }).catch(() => {});
    const n = await p.evaluate(() => (JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]')).length);
    flow('a new project from an English address, Arabic saved: one project, at /ar/app', n === 1 && /^\/ar\/app\?local=/.test(at(p)) && seen.length === 1, `${n} project(s), ${at(p)}, ${seen.join(' -> ')}`);
    await ctx.close();
  }
}

console.log('\n— every page and dialog above: strings came with the code —');
if (misses.length) { fail++; console.log(`  FAIL  ${misses.length} string(s) missing from a page's tables`); for (const m of [...new Set(misses)].slice(0, 12)) console.log(`          ${m}`); }
else { pass++; console.log('  PASS  no key was missing from any table, no page fetched the full table'); }

console.log(`\n  ${pass} surfaces clean, ${fail} with untranslated text`);
await browser.close();
process.exit(fail ? 1 : 0);
