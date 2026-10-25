/**
 * The Content Security Policy, in a real browser (performance plan P3.1).
 *
 * script-src is exactly 'self': no page and no worker may evaluate a string
 * as code. 'unsafe-eval' was allowed for Pixi, which built its shader,
 * uniform and particle code with `new Function`; the editor now draws its
 * seats as one mesh and loads Pixi's eval-free code. This suite
 * loads every page, and drives the parts that run the most code — the 2D
 * editor, the Stadium view, Split, the banner studio, Match Day, the AI panel,
 * the landing hero in 3D, a /community card in 3D, the share page — and the
 * exports (PDF, CSV, flat GIF, the Stadium video and GIF), listening from the
 * first script on for `securitypolicyviolation` events and for page errors.
 * Every step must have none.
 *
 * A control comes first: an inline script injected on purpose must be caught,
 * or the listener is not listening. (The suite's own page.evaluate calls are
 * exempt from the policy by design; only the page's own code is tested.)
 *
 * Workers: a violation inside a worker fires in the worker, not the page, so
 * each worker gets a listener as it starts and is asked at the end of a step;
 * the build's worker scripts are also checked for any string evaluation.
 *
 *   node e2e-csp.mjs        (server on :8911 with a built dist; BASE= to point elsewhere)
 */
import { chromium } from 'playwright';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const B = process.env.BASE ?? 'http://127.0.0.1:8911';
const GROUND = process.env.CSP_GROUND ?? 'kingdom-arena-26k-rb';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }).catch(() => chromium.launch());
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const PW = 'harbor-kite-moss-31-csp';

const LS = (lang, token) => [
  { name: 'tifo_lang_v1', value: lang }, { name: 'tifo_consent_v1', value: 'essential' },
  { name: 'tifo_onboarded_v1', value: '1' }, { name: 'tifo_news_banners_v1', value: '1' },
  { name: 'tifo_news_leagues_v1', value: '1' }, { name: 'tifo_news_leagues_v2', value: '1' },
  { name: 'tifo_banner_tour_v1', value: '1' }, { name: 'tifo_draw_hint_v1', value: '1' },
  { name: 'tifo_tour_v1', value: '1' }, { name: 'tifo_post_nudge_v1', value: '1' }, { name: 'tifo_post_offered_v1', value: '1' },
  { name: 'mds_seen_intro', value: '1' }, { name: 'mds_sound_v2', value: JSON.stringify({ on: false }) },
  ...(token ? [{ name: 'tifo_token_v1', value: token }] : []),
];

/** A page whose violations and errors are recorded from its first script on. */
async function open({ lang = 'en', token = null, w = 1440, h = 900 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, acceptDownloads: true,
    storageState: { cookies: [], origins: [{ origin: B, localStorage: LS(lang, token) }] },
  });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked=${e.blockedURI || '-'} at ${String(e.sourceFile || '').replace(location.origin, '')}:${e.lineNumber}`);
    }, true);
  });
  const p = await ctx.newPage();
  const errs = [];
  const workers = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
  p.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|unsafe-eval|Refused to/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 200)); });
  p.on('worker', (wk) => {
    workers.push(wk);
    wk.evaluate(() => { self.__csp = []; self.addEventListener('securitypolicyviolation', (e) => self.__csp.push(`${e.violatedDirective} (worker)`)); }).catch(() => {});
  });
  return { ctx, p, errs, workers };
}

/** Everything recorded so far on this page, in it and in its workers. */
async function violations(t) {
  const v = await t.p.evaluate(() => window.__csp.slice()).catch(() => ['(page gone)']);
  for (const wk of t.workers) v.push(...(await wk.evaluate(() => self.__csp || []).catch(() => [])));
  return v;
}
async function clean(t, label) {
  const v = await violations(t);
  check(`${label}: no policy violation`, v.length === 0, v.slice(0, 4).join(' | '));
  check(`${label}: no page error`, t.errs.length === 0, t.errs.slice(0, 4).join(' | '));
  t.errs.length = 0;
  await t.p.evaluate(() => { window.__csp.length = 0; }).catch(() => {});
}
const settle = (p, ms = 1500) => p.waitForTimeout(ms);
const until = (p, fn, arg = null, ms = 120000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

// ---- the header the pages are served with ----
console.log('\n— the policy —');
{
  const r = await fetch(B + '/');
  const csp = r.headers.get('content-security-policy') ?? '';
  const scriptSrc = (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) ?? '').split(/\s+/).slice(1);
  check("script-src is exactly 'self'", scriptSrc.length === 1 && scriptSrc[0] === "'self'", scriptSrc.join(' '));
  check("and 'unsafe-eval' appears nowhere in the policy", !/unsafe-eval/.test(csp));
}

// ---- the listener catches what it should ----
console.log('\n— the control: a violation is seen —');
{
  const t = await open();
  await t.p.goto(B + '/legal', { waitUntil: 'load' });
  await t.p.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.head.appendChild(s); });
  await settle(t.p, 300);
  const v = await violations(t);
  check('an injected inline script is refused and reported', v.length === 1 && /^script-src/.test(v[0]) && !(await t.p.evaluate(() => window.__ran)), v.join(' | '));
  await t.ctx.close();
}

// ---- something to look at ----
async function account() {
  const u = 'csp' + Math.random().toString(36).slice(2, 9);
  const reg = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PW, email: u + '@example.test', acceptedVersion: '2025-01-01' }) });
  if (!reg.ok) throw new Error(`could not register: ${reg.status} ${await reg.text()}`);
  return (await reg.json()).token;
}
const token = await account();
const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
const tpl = (await (await fetch(B + '/api/templates')).json()).find((x) => x.id === GROUND);
const cells = Buffer.alloc(tpl.seatCount, 1);
for (let i = 0; i < cells.length; i += 3) cells[i] = 2;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const made = await (await fetch(B + '/api/designs', { method: 'POST', headers: H, body: JSON.stringify({ title: 'CSP sweep', templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1f8a2e', '#ffffff'], cellsGzB64: gzipSync(cells).toString('base64'), thumbnailPngB64: png.toString('base64') }) })).json();
await fetch(B + `/api/designs/${made.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ isPublic: true }) });
const pub = made.id;

// ---- every page ----
console.log('\n— every page, signed out, English and Arabic —');
const PAGES = ['/', '/community', '/clubs', '/legal', '/tifo-spec', '/reset', '/account', '/projects', `/t/${pub}`, `/d/${pub}`, `/s/${pub}`, '/admin', '/no-such-page'];
for (const lang of ['en', 'ar']) {
  const t = await open({ lang });
  for (const path of lang === 'en' ? PAGES : ['/', '/community', '/clubs', `/t/${pub}`, '/projects']) {
    await t.p.goto(B + path, { waitUntil: 'load', timeout: 120000 });
    await settle(t.p, path.startsWith('/t/') || path.startsWith('/d/') ? 5000 : 1500);
    await clean(t, `${path} (${lang})`);
  }
  await t.ctx.close();
}
console.log('\n— signed in —');
{
  const t = await open({ token });
  for (const path of ['/projects', '/account', '/community', `/t/${pub}`]) {
    await t.p.goto(B + path, { waitUntil: 'load', timeout: 120000 });
    await settle(t.p, 2000);
    await clean(t, `${path} (signed in)`);
  }
  await t.ctx.close();
}

// ---- three.js on the public pages ----
console.log('\n— the landing hero and a /community card in 3D —');
{
  const t = await open();
  await t.p.goto(B + '/', { waitUntil: 'load' });
  await t.p.click('#hero-play').catch(() => {});
  await settle(t.p, 6000);
  check('the landing hero runs in 3D', await t.p.evaluate(() => !!document.querySelector('.hero canvas, #hero canvas, canvas')));
  await clean(t, 'the landing hero in 3D');
  await t.p.goto(B + '/community', { waitUntil: 'load' });
  const card = '#gallery-grid .tifo-card';
  if (await until(t.p, (s) => !!document.querySelector(s), card, 30000)) {
    await t.p.hover(card);
    await settle(t.p, 2500);
    await t.p.click(`${card} .card-title`).catch(() => {});
    await settle(t.p, 6000);
    check('a /community card opens in 3D', await t.p.evaluate(() => document.querySelectorAll('canvas').length > 0));
  } else check('a /community card opens in 3D', false, 'no card in the grid');
  await clean(t, 'a /community card in 3D');
  await t.ctx.close();
}

// ---- the editor and everything in it ----
console.log(`\n— the editor (${GROUND}) —`);
{
  const t = await open();
  const { p } = t;
  await p.goto(`${B}/app?new=1&template=${GROUND}&e2e=1`, { waitUntil: 'load', timeout: 120000 });
  const ready = await until(p, () => !!window.__tifo?.editor && /seats/.test(document.getElementById('stat')?.textContent || ''), null, 180000);
  check('the editor starts (Pixi under the strict policy)', ready);
  await settle(p, 2000);
  check('…and draws', await p.evaluate(() => window.__tifo.editor.rendersDrawn > 0));
  await clean(t, 'the editor opens');
  // Paint, fill, select, undo: the seats' shader and uploads.
  const m = await p.evaluate(() => { const b = window.__tifo.map.bounds; return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; });
  const at = (wx, wy) => p.evaluate(([x, y]) => window.__tifo.editor.worldToClient(x, y), [wx, wy]);
  {
    const [ax, ay] = await at(m.x - 400, m.y);
    const [bx, by] = await at(m.x + 400, m.y + 20);
    await p.mouse.move(ax, ay); await p.mouse.down();
    for (let k = 1; k <= 10; k++) await p.mouse.move(ax + ((bx - ax) * k) / 10, ay + ((by - ay) * k) / 10);
    await p.mouse.up();
  }
  await p.click('.tool-rail [data-tool="fill"]');
  { const [x, y] = await at(m.x + 900, m.y - 20); await p.mouse.click(x, y); }
  await p.click('.tool-rail [data-tool="select"]');
  { const [x, y] = await at(m.x - 100, m.y); await p.mouse.click(x, y); }
  await p.keyboard.press('Escape');
  await p.keyboard.press('Control+z');
  await settle(p, 800);
  await clean(t, 'painting, filling, selecting, undoing');
  // A reveal, and the flat GIF (the seat-map worker encodes it).
  await p.evaluate(() => document.getElementById('reveal-play')?.click());
  await settle(p, 1500);
  await p.evaluate(() => document.getElementById('reveal-reset')?.click());
  {
    const dl = p.waitForEvent('download', { timeout: 180000 }).catch(() => null);
    await p.evaluate(() => document.getElementById('reveal-gif')?.click());
    const d = await dl;
    check('the flat GIF exports', /\.gif$/.test(d?.suggestedFilename() ?? ''), d?.suggestedFilename());
  }
  await clean(t, 'a reveal and the flat GIF');
  // The print PDF and the CSV.
  for (const [id, re] of [['export-pdf', /\.pdf$/], ['export-csv', /\.csv$/]]) {
    const dl = p.waitForEvent('download', { timeout: 120000 }).catch(() => null);
    await p.evaluate((i) => document.getElementById(i)?.click(), id);
    const d = await dl;
    check(`${id} downloads`, re.test(d?.suggestedFilename() ?? ''), d?.suggestedFilename());
  }
  await clean(t, 'the PDF and the CSV');
  // The AI panel: its offline shuffle, and a generation (signed out, it asks
  // for an account first: the sign-in dialog opens and is closed again).
  await p.click('#rail-ai').catch(() => {});
  await settle(p, 800);
  await p.evaluate(() => document.getElementById('ai-shuffle')?.click());
  await settle(p, 3000);
  await p.fill('#ai-prompt', 'A green and white wall across the north stand').catch(() => {});
  await p.evaluate(() => document.getElementById('ai-generate')?.click());
  await settle(p, 5000);
  await p.evaluate(() => document.querySelector('.auth-close')?.click());
  await settle(p, 500);
  await p.evaluate(() => document.getElementById('ai-cancel')?.click());
  await clean(t, 'the AI panel');
  // The Stadium view, Split, and the Stadium animation (video, then GIF).
  await p.click('#view-3d');
  check('the Stadium view starts', await until(p, () => !!window.__tifoPreview, null, 180000));
  await settle(p, 2000);
  await clean(t, 'the Stadium view');
  await p.click('#view-split').catch(() => {});
  await settle(p, 2000);
  await clean(t, 'Split');
  await p.click('#view-3d');
  await p.evaluate(() => { const s = document.getElementById('reveal-dur'); if (s) { s.value = s.min || '2'; s.dispatchEvent(new Event('input', { bubbles: true })); } });
  for (const fmt of ['video', 'gif']) {
    await p.evaluate((f) => { const s = document.getElementById('sx-format'); s.value = f; s.dispatchEvent(new Event('change', { bubbles: true })); }, fmt);
    const dl = p.waitForEvent('download', { timeout: 240000 }).catch(() => null);
    await p.evaluate(() => document.getElementById('sx-export')?.click());
    const d = await dl;
    check(`the Stadium ${fmt} exports`, fmt === 'gif' ? /\.gif$/.test(d?.suggestedFilename() ?? '') : /\.(webm|mp4)$/.test(d?.suggestedFilename() ?? ''), d?.suggestedFilename() ?? (await p.evaluate(() => document.getElementById('sx-status')?.textContent)));
    await settle(p, 1000);
  }
  await clean(t, 'the Stadium video and GIF');
  // Match Day.
  await p.click('#match-day');
  check('Match Day starts', await until(p, () => !!document.querySelector('.mds-overlay canvas'), null, 180000));
  await settle(p, 6000);
  await clean(t, 'Match Day');
  await p.keyboard.press('Escape');
  await settle(p, 1000);
  // The banner studio.
  await p.click('#view-banner');
  await settle(p, 1200);
  await p.click('#bn-empty button[data-kind="stand"]').catch(() => {});
  await settle(p, 2000);
  await clean(t, 'the banner studio');
  await p.click('#view-2d');
  await settle(p, 1000);
  // A lost WebGL context comes back and draws, still without eval.
  const r0 = await p.evaluate(() => window.__tifo.editor.rendersDrawn);
  await p.evaluate(() => {
    const c = document.querySelector('#canvas-host canvas');
    const x = (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context');
    x.loseContext();
    setTimeout(() => x.restoreContext(), 300);
  });
  await settle(p, 2000);
  check('a lost context is restored and drawn', (await p.evaluate(() => window.__tifo.editor.rendersDrawn)) > r0);
  await clean(t, 'a lost and restored context');
  await t.ctx.close();
}

// ---- the build's workers evaluate nothing ----
console.log('\n— the built worker scripts —');
{
  const dir = 'dist/assets';
  if (existsSync(dir)) {
    const workers = readdirSync(dir).filter((f) => /worker.*\.js$/.test(f));
    const evaling = workers.filter((f) => /\bnew\s+Function\s*\(|\beval\s*\(|\bFunction\s*\(\s*['"`]|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/.test(readFileSync(`${dir}/${f}`, 'utf8')));
    check(`no worker script evaluates a string (${workers.length} checked)`, workers.length > 0 && evaling.length === 0, evaling.join(', '));
  } else console.log('  (no dist/ here: the worker scripts were not read)');
}

// Leave the server as it was found: the design made here would otherwise be
// the newest public one, first in the feeds other suites read.
await fetch(B + `/api/designs/${pub}`, { method: 'DELETE', headers: H }).catch(() => {});
await fetch(B + `/api/designs/${pub}?permanent=1`, { method: 'DELETE', headers: H }).catch(() => {});

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
