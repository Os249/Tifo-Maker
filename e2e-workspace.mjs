/**
 * The editor's workspace, after the 26 Oct 2026 pass (Direction A).
 *
 *   npm run test:workspace      (needs `npm run build` first: it serves dist/)
 *
 *   1. A new project lands in Split: the 3D on top, the stands docked under
 *      it, the stand buttons and the AI bar showing.
 *   2. The dock between them moves by drag and by keyboard, is remembered,
 *      and a double-click puts it back.
 *   3. The view you pick is remembered: someone who works in Design gets
 *      Design on their next new project.
 *   4. The stand buttons carry a picture of the stand and its seat count, the
 *      picture follows the paint, and the count stays in Western digits in
 *      Arabic.
 *   5. The side panel's sections fold, stay folded, and a tool opens its own.
 *   6. The AI bar writes the brief (and the stand) into the AI tab, presses
 *      its Generate, and follows the run to the end.
 *   7. The AI limit card: one blue button, the Quick Designer, and the bar
 *      sends you to the card.
 *   8. Phones: the stand buttons get the pictures and stay 44px; no dock, no
 *      AI bar, no Split.
 *   9. The Banner view's empty screen: three drawn cards, said once.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8923;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'e2e workspace admin password 2026';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', AI_ADMIN_PASSWORD: PW, ADMIN_USERNAMES: '', GEMINI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up on ' + B + '\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const unlock = (await fetch(`${B}/api/ai/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) }).then((r) => r.json())).token;
check('the admin unlock works (the AI runs without a sign-in)', typeof unlock === 'string' && unlock.length > 10);

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WIDE = { viewport: { width: 1440, height: 900 }, userAgent: DESKTOP };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: IPHONE };
const BASE_LS = [
  ['tifo_consent_v1', 'all'], ['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v2', '1'], ['tifo_guide_v1', 'done'],
  ['tifo_banner_tour_v1', '1'], ['tifo_draw_hint_v1', '1'], ['mds_seen_intro', '1'], ['mds_sound_v2', JSON.stringify({ on: false })],
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const open = async (opts, ls = [], lang = 'en') => {
  const ctx = await browser.newContext({ locale: lang === 'ar' ? 'ar-SA' : 'en-US', ...opts });
  await ctx.addInitScript((pairs) => {
    // Only on the first load of this context: a reload must see what the page itself stored.
    try { if (sessionStorage.getItem('e2e_ws_seeded')) return; sessionStorage.setItem('e2e_ws_seeded', '1'); for (const [k, v] of pairs) localStorage.setItem(k, v); } catch { /* */ }
  }, [...BASE_LS, ['tifo_lang_v1', lang], ...ls]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return p;
};
const until = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

/** The start flow: a club tifo (the bowl drawn in the club's colours). */
async function startFromClub(p, club = 'hilal') {
  await p.goto(`${B}/projects?new=1&e2e`, { waitUntil: 'domcontentloaded' });
  await until(p, () => document.querySelectorAll('.st-club').length >= 8, null, 90000);
  await p.evaluate((c) => document.querySelector(`.st-club[data-club="${c}"]`)?.click(), club);
  await until(p, () => document.querySelector('.st-opt.on')?.dataset.start === 'club', null, 10000);
  await p.evaluate(() => document.getElementById('st-go')?.click());
  return until(p, () => /[?&](project|local)=/.test(location.search) && !!document.getElementById('doc-title'), null, 120000);
}
/** The same page again, with the test hooks on (window.__tifo): a plain page load of the project. */
async function reloadWithHooks(p) {
  const u = new URL(p.url());
  u.searchParams.set('e2e', '1');
  await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
  return until(p, () => !!window.__tifo && !!document.getElementById('dock-handle')?.hasAttribute('aria-valuenow'), null, 90000);
}
const activeView = (p) => p.evaluate(() => ['view-2d', 'view-3d', 'view-split', 'view-banner'].find((id) => document.getElementById(id)?.classList.contains('active')) ?? '');

// ---------------------------------------------------------------------------
console.log('\n— 1. a new project lands in Split —');
const p1 = await open(WIDE);
check('the club start opens the editor', await startFromClub(p1));
check('and settles in Split once the reveal is over', await until(p1, () => document.getElementById('view-split')?.classList.contains('active'), null, 60000), await activeView(p1));
// The one-time "Your tifo is in the stadium" card comes up where the AI bar
// sits; the bar waits until it is gone.
const nudge = await until(p1, () => !!document.querySelector('.pm-nudge'), null, 20000);
const waits = await p1.evaluate(() => getComputedStyle(document.getElementById('ai-bar')).display === 'none');
check('the "Your tifo is in the stadium" card has the bottom to itself: the AI bar waits', nudge && waits, JSON.stringify({ nudge, waits }));
await p1.click('.pm-nudge .pm-x').catch(() => p1.evaluate(() => document.querySelector('.pm-nudge')?.remove()));
await p1.waitForTimeout(1000);
const split = await p1.evaluate(() => {
  const shown = (sel) => { const el = document.querySelector(sel); if (!el) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const host = document.getElementById('canvas-host');
  const wrap = host?.parentElement;
  const h = document.getElementById('dock-handle');
  const bar = document.getElementById('ai-bar');
  const hr = host.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), br = bar.getBoundingClientRect();
  return {
    dock: Math.round(hr.height / wr.height * 100),
    preview: shown('#preview-host') && !!document.querySelector('#preview-host canvas'),
    handle: shown('#dock-handle'), role: h.getAttribute('role'), now: h.getAttribute('aria-valuenow'), label: h.getAttribute('aria-label') ?? '',
    chips: shown('#stand-chips'),
    bar: shown('#ai-bar'), barAbove: br.bottom <= hr.top + 2,
    stored: localStorage.getItem('tifo_view_v1'),
  };
});
check('the stands are docked under the 3D, at about 42% of the height', split.preview && split.dock >= 36 && split.dock <= 48, JSON.stringify(split));
check('the dock has a handle: a labelled separator at 42', split.handle && split.role === 'separator' && split.now === '42' && split.label.length > 5, JSON.stringify({ role: split.role, now: split.now, label: split.label }));
check('the stand buttons show in Split', split.chips);
check('the AI bar shows, above the dock', split.bar && split.barAbove);
check('landing in Split by default is not a choice the browser keeps', split.stored === null, String(split.stored));

// ---------------------------------------------------------------------------
console.log('\n— 2. the dock moves, and is remembered —');
{
  await p1.focus('#dock-handle');
  await p1.keyboard.press('ArrowUp');
  await p1.keyboard.press('ArrowUp');
  const k = await p1.evaluate(() => ({ now: document.getElementById('dock-handle').getAttribute('aria-valuenow'), kept: localStorage.getItem('tifo_dock_v1'), h: document.getElementById('canvas-host').getBoundingClientRect().height }));
  check('two presses of the up arrow make the stands 8 bigger, and the browser keeps it', k.now === '50' && k.kept === '50', JSON.stringify(k));
  await p1.keyboard.press('Home');
  const lo = await p1.evaluate(() => document.getElementById('dock-handle').getAttribute('aria-valuenow'));
  await p1.keyboard.press('End');
  const hi = await p1.evaluate(() => document.getElementById('dock-handle').getAttribute('aria-valuenow'));
  check('Home and End go to the ends, and no further', lo === '22' && hi === '78', `${lo} .. ${hi}`);
  await p1.dblclick('#dock-handle');
  await p1.waitForTimeout(400);
  const reset = await p1.evaluate(() => ({ now: document.getElementById('dock-handle').getAttribute('aria-valuenow'), kept: localStorage.getItem('tifo_dock_v1') }));
  check('a double-click puts it back to 42', reset.now === '42' && reset.kept === '42', JSON.stringify(reset));
  const hb = await p1.locator('#dock-handle').boundingBox();
  const before = await p1.evaluate(() => document.getElementById('canvas-host').getBoundingClientRect().height);
  await p1.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p1.mouse.down();
  await p1.mouse.move(hb.x + hb.width / 2, hb.y - 140, { steps: 8 });
  await p1.mouse.up();
  await p1.waitForTimeout(800);
  const drag = await p1.evaluate(() => ({ now: Number(document.getElementById('dock-handle').getAttribute('aria-valuenow')), kept: Number(localStorage.getItem('tifo_dock_v1')), h: document.getElementById('canvas-host').getBoundingClientRect().height, dragging: document.querySelector('.docking') !== null }));
  check('dragging the handle up gives the stands more room', drag.h > before + 80 && drag.now > 50 && drag.kept === drag.now && !drag.dragging, JSON.stringify({ before: Math.round(before), ...drag }));
  check('the project opens again with the test hooks', await reloadWithHooks(p1));
  const again = await p1.evaluate(() => Number(document.getElementById('dock-handle').getAttribute('aria-valuenow')));
  check('and the next page load keeps it', again === drag.now, `${again} vs ${drag.now}`);
}

// ---------------------------------------------------------------------------
console.log('\n— 3. the view you pick is remembered —');
{
  await until(p1, () => !!document.getElementById('view-2d'), null, 30000);
  await p1.click('#view-banner');
  await p1.waitForTimeout(600);
  const afterBanner = await p1.evaluate(() => localStorage.getItem('tifo_view_v1'));
  await p1.click('#view-2d');
  await p1.waitForTimeout(600);
  const kept = await p1.evaluate(() => localStorage.getItem('tifo_view_v1'));
  check('Banner is a place you visit, not a view the editor opens in', afterBanner === null || afterBanner !== 'banner', String(afterBanner));
  check('picking Design is kept', kept === '2d', String(kept));
  const p3 = await open(WIDE, [['tifo_view_v1', '2d']]);
  await startFromClub(p3, 'nassr');
  await p3.waitForTimeout(9000);
  const v = await activeView(p3);
  check('someone who works in Design gets Design on their next new project', v === 'view-2d', v);
  await p3.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— 4. the stand buttons: a picture and a seat count —');
{
  await p1.click('#view-split');
  await p1.waitForTimeout(800);
  const read = () => p1.evaluate(() => [...document.querySelectorAll('#stand-chips .stand-chip[data-stand]')].map((b) => {
    const c = b.querySelector('canvas.st-thumb');
    let colours = 0, sum = 0, painted = 0;
    if (c && c.width) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { painted++; seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); sum += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7; }
      colours = seen.size;
    }
    return { stand: b.dataset.stand, w: c ? Math.round(c.getBoundingClientRect().width) : 0, colours, sum, painted, name: b.querySelector('.st-name')?.textContent ?? '', count: b.querySelector('.st-count')?.textContent ?? '', label: b.getAttribute('aria-label') ?? '', h: Math.round(b.getBoundingClientRect().height) };
  }));
  await until(p1, () => [...document.querySelectorAll('#stand-chips canvas.st-thumb')].length === 5, null, 10000);
  await p1.waitForTimeout(1500);
  const a = await read();
  const n = (s) => Number(String(s).replace(/,/g, ''));
  const stands = a.filter((x) => x.stand !== 'all');
  const all = a.find((x) => x.stand === 'all');
  check('all five buttons have a picture and a count', a.length === 5 && a.every((x) => x.w >= 40 && /^\d{1,3}(,\d{3})*$/.test(x.count)), JSON.stringify(a.map((x) => [x.stand, x.w, x.count])));
  check('the pictures show the stands as painted (the club tifo: more than one colour on the bowl)', a.every((x) => x.painted >= 30) && all.colours >= 2, JSON.stringify(a.map((x) => [x.stand, x.painted, x.colours])));
  check('every stand has seats, and All has at least their sum', stands.every((x) => n(x.count) > 0) && n(all.count) >= stands.reduce((s, x) => s + n(x.count), 0), `${stands.map((x) => x.count).join(' + ')} vs ${all.count}`);
  check('each button says its name and seats to a screen reader', a.every((x) => x.label === `${x.name}, ${x.count} seats`), a.map((x) => x.label).join(' | '));
  await p1.evaluate(() => window.__tifo.store.fillAll(0));
  await p1.waitForTimeout(1800);
  const empty = await read();
  await p1.evaluate(() => window.__tifo.store.fillAll(2));
  await p1.waitForTimeout(1800);
  const full = await read();
  const north = (r) => r.find((x) => x.stand === 'north');
  check('the picture follows the paint, a moment after it', north(empty).sum !== north(full).sum && north(empty).colours === 1 && north(full).colours === 1, JSON.stringify({ empty: north(empty), full: north(full) }));
  await p1.evaluate(() => { window.__tifo.store.undo?.(); window.__tifo.store.undo?.(); });

  // Arabic: the names change, the digits do not.
  await p1.evaluate(() => document.getElementById('lang-toggle').click());
  await p1.waitForTimeout(1200);
  const ar = await read();
  check('in Arabic the names are Arabic and the counts stay in Western digits', ar.every((x) => /[؀-ۿ]/.test(x.name) && /^\d{1,3}(,\d{3})*$/.test(x.count)) && ar.every((x) => x.label.endsWith('مقعد')), ar.map((x) => x.label).join(' | '));
  await p1.evaluate(() => document.getElementById('lang-toggle').click());
  await p1.waitForTimeout(800);
}

// ---------------------------------------------------------------------------
console.log('\n— 5. the panel sections fold —');
{
  await p1.click('#view-2d');
  await p1.evaluate(() => document.querySelector('.tool[data-tool="brush"]')?.click());
  await p1.waitForTimeout(500);
  const heads = await p1.evaluate(() => [...document.querySelectorAll('.panel-section > h4.fold-head > button.fold-btn')].map((b) => ({ id: b.closest('.panel-section').id, exp: b.getAttribute('aria-expanded'), ctl: b.getAttribute('aria-controls') })));
  check('each section title is a button that says whether it is open', heads.length >= 6 && heads.every((h) => h.exp === 'true' && h.ctl === `fold-${h.id}`), JSON.stringify(heads.map((h) => h.id)));
  await p1.click('#ctx-brush .fold-btn');
  await p1.waitForTimeout(500);
  const f = await p1.evaluate(() => {
    const sec = document.getElementById('ctx-brush'), body = sec.querySelector(':scope > .fold-body'), panel = sec.parentElement;
    return { folded: sec.classList.contains('folded'), exp: sec.querySelector('.fold-btn').getAttribute('aria-expanded'), inert: body.inert, h: Math.round(body.getBoundingClientRect().height), kept: localStorage.getItem('tifo_folds_v1'), wide: panel.scrollWidth - panel.clientWidth };
  });
  check('a click folds Brush to its title, out of the tab order', f.folded && f.exp === 'false' && f.inert && f.h <= 2, JSON.stringify(f));
  check('the browser keeps it', JSON.parse(f.kept || '[]').includes('ctx-brush'), f.kept);
  check('folding never widens the panel', f.wide <= 0, `${f.wide}px`);
  await p1.reload({ waitUntil: 'domcontentloaded' });
  await until(p1, () => !!window.__tifo && !!document.querySelector('#ctx-brush .fold-btn'), null, 90000);
  await p1.click('#view-2d').catch(() => {});
  await p1.waitForTimeout(600);
  const r = await p1.evaluate(() => ({ folded: document.getElementById('ctx-brush').classList.contains('folded'), exp: document.querySelector('#ctx-brush .fold-btn').getAttribute('aria-expanded') }));
  check('and the next load opens it folded', r.folded && r.exp === 'false', JSON.stringify(r));
  await p1.evaluate(() => document.querySelector('.tool[data-tool="eraser"]')?.click());
  await p1.waitForTimeout(600);
  const t = await p1.evaluate(() => ({ brush: document.getElementById('ctx-brush').classList.contains('folded'), colours: document.getElementById('ctx-colors').classList.contains('folded'), kept: localStorage.getItem('tifo_folds_v1') }));
  check('picking the eraser opens Brush, the section about it', !t.brush && !t.colours && !JSON.parse(t.kept || '[]').includes('ctx-brush'), JSON.stringify(t));
  await p1.click('#ctx-layers .fold-btn');
  await p1.evaluate(() => document.getElementById('lang-toggle').click());
  await p1.waitForTimeout(1000);
  const arTitle = await p1.evaluate(() => ({ text: document.querySelector('#ctx-layers .fold-btn')?.textContent.trim() ?? '', title: document.querySelector('#ctx-layers .fold-btn')?.title ?? '', still: document.getElementById('ctx-layers').classList.contains('folded') }));
  check('in Arabic the titles and their hints are Arabic, and the fold stays', /[؀-ۿ]/.test(arTitle.text) && /[؀-ۿ]/.test(arTitle.title) && arTitle.still, JSON.stringify(arTitle));
  await p1.evaluate(() => document.getElementById('lang-toggle').click());
  await p1.click('#ctx-layers .fold-btn');
  await p1.waitForTimeout(500);
}
await p1.context().close();

// ---------------------------------------------------------------------------
console.log('\n— 6. the AI bar runs the AI tab —');
{
  const p = await open(WIDE, [['tifo_ai_unlock_v1', unlock], ['tifo_post_nudge_v1', '1']]);
  await startFromClub(p, 'ittihad');
  await until(p, () => document.getElementById('view-split')?.classList.contains('active'), null, 60000);
  await p.waitForTimeout(1200);
  // No AI key here: the bar's run goes to the Quick Designer, which needs none.
  await p.route('**/api/ai/generate', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* */ }
    await route.continue({ postData: JSON.stringify({ ...body, engine: 'offline' }) });
  });
  const before = await p.evaluate(() => document.getElementById('ai-prompt').value);
  await p.click('#ai-bar-go');
  await p.waitForTimeout(300);
  const empty = await p.evaluate(() => ({ shake: document.getElementById('ai-bar').classList.contains('ai-bar-shake'), prompt: document.getElementById('ai-prompt').value, focus: document.activeElement?.id }));
  check('Go with nothing typed asks for a brief (a shake) and runs nothing', empty.shake && empty.prompt === before && empty.focus === 'ai-bar-input', JSON.stringify(empty));
  await p.click('#stand-chips .stand-chip[data-stand="north"]');
  await p.waitForTimeout(500);
  const where = await p.evaluate(() => document.getElementById('ai-bar-target').value);
  check('picking the North stand on the strip points the bar at it', where === 'north', where);
  await p.fill('#ai-bar-input', 'green and white stripes');
  const phases = [];
  await p.exposeFunction('__phase', (v) => phases.push(v));
  await p.evaluate(() => new MutationObserver(() => window.__phase(document.getElementById('ai-bar').dataset.phase)).observe(document.getElementById('ai-bar'), { attributes: true, attributeFilter: ['data-phase'] }));
  await p.press('#ai-bar-input', 'Enter');
  await p.waitForTimeout(200);
  const sent = await p.evaluate(() => document.getElementById('ai-prompt').value);
  check('the brief goes into the AI tab with the stand said in words', sent === 'green and white stripes in the north stand', sent);
  const done = await until(p, () => document.getElementById('ai-bar').dataset.phase === 'done', null, 90000);
  const end = await p.evaluate(() => ({ phase: document.getElementById('ai-bar').dataset.phase, state: document.getElementById('ai-bar-state').textContent, input: document.getElementById('ai-bar-input').value, open: !document.getElementById('ai-bar-open').hidden, result: !document.getElementById('ai-result')?.hidden }));
  check('the bar shows the run while it works, then says it is done', done && phases.includes('busy') && /Done/.test(end.state) && end.result, JSON.stringify({ phases, ...end }));
  check('the brief clears, and "Open the AI tab" is offered', end.input === '' && end.open, JSON.stringify(end));
  await p.click('#ai-bar-open');
  await p.waitForTimeout(600);
  check('which opens the AI tab, where the result can be kept or undone', await p.evaluate(() => getComputedStyle(document.getElementById('ctx-ai')).display !== 'none'));
  await p.unroute('**/api/ai/generate');
  await p.click('#ai-bar-state');
  await p.waitForTimeout(300);
  const back = await p.evaluate(() => ({ phase: document.getElementById('ai-bar').dataset.phase, focus: document.activeElement?.id, shown: getComputedStyle(document.getElementById('ai-bar-input')).display !== 'none' }));
  check('a click on that line brings the input back, ready to type', back.phase === 'idle' && back.focus === 'ai-bar-input' && back.shown, JSON.stringify(back));

  // -------------------------------------------------------------------------
  console.log('\n— 7. the AI limit card —');
  await p.click('#view-split');
  await p.waitForTimeout(600);
  await p.route('**/api/ai/generate', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ needsChoice: true, reason: 'quota', retryAfterSec: 1800, quota: { used: 10, limit: 10, remaining: 0 } }) }));
  await p.fill('#ai-bar-input', 'a crescent on the whole bowl');
  await p.press('#ai-bar-input', 'Enter');
  const card = await until(p, () => document.getElementById('ai-bar').dataset.phase === 'card', null, 30000);
  const c = await p.evaluate(() => ({
    tab: getComputedStyle(document.getElementById('ctx-ai')).display !== 'none',
    title: document.querySelector('#ai-state .ai-state-title span')?.textContent ?? '',
    primary: [...document.querySelectorAll('#ai-state .ai-state-actions button.primary')].map((b) => b.textContent.trim()),
    all: [...document.querySelectorAll('#ai-state .ai-state-actions button')].map((b) => b.textContent.trim()),
    bar: document.getElementById('ai-bar-state').textContent,
  }));
  check('at the limit the bar says the AI tab has a message, and opens it', card && c.tab && /message/.test(c.bar), JSON.stringify(c));
  check('the card has one blue button: the Quick Designer', c.primary.length === 1 && c.primary[0] === 'Use the Quick Designer', JSON.stringify(c.all));
  await p.unroute('**/api/ai/generate');
  const idle = await until(p, () => document.getElementById('ai-bar').dataset.phase === 'idle', null, 12000);
  check('and the bar goes back to its input by itself', idle);

  // Arabic: the bar's words.
  await p.evaluate(() => document.getElementById('lang-toggle').click());
  await p.waitForTimeout(900);
  const ar = await p.evaluate(() => ({ ph: document.getElementById('ai-bar-input').placeholder, opts: [...document.getElementById('ai-bar-target').options].map((o) => o.textContent), go: document.getElementById('ai-bar-go').textContent.trim() }));
  check('the bar is Arabic in Arabic', /[؀-ۿ]/.test(ar.ph) && ar.opts.length === 5 && ar.opts.every((o) => /[؀-ۿ]/.test(o)) && /[؀-ۿ]/.test(ar.go), JSON.stringify(ar));
  await p.evaluate(() => document.getElementById('lang-toggle').click());

  // -------------------------------------------------------------------------
  console.log('\n— 9. the Banner view with no banner —');
  await p.click('#view-banner');
  await until(p, () => document.body.classList.contains('bn-none'), null, 20000);
  await p.waitForTimeout(800);
  const bn = await p.evaluate(() => ({
    cards: [...document.querySelectorAll('#bn-empty .bn-kind')].map((b) => ({ kind: b.dataset.kind, art: !!b.querySelector('svg.bn-kind-art path, svg.bn-kind-art circle'), name: b.querySelector('.bn-kind-name')?.textContent ?? '', what: b.querySelector('.bn-kind-what')?.textContent ?? '', h: Math.round(b.getBoundingClientRect().height) })),
    adders: [...document.querySelectorAll('#bn-add-stand, #bn-add-hanging, #bn-add-sign')].filter((b) => b.getClientRects().length > 0).length,
    bar: getComputedStyle(document.getElementById('ai-bar')).display,
  }));
  check('three cards, each with a drawing, a name and what it is', bn.cards.length === 3 && bn.cards.every((x) => x.art && x.name && x.what.length > 10 && x.h >= 44), JSON.stringify(bn.cards));
  check('said once: no second row of add buttons while there is no banner', bn.adders === 0, String(bn.adders));
  check('and no AI bar over the banner', bn.bar === 'none', bn.bar);
  await p.click('#bn-empty .bn-kind[data-kind="hanging"]');
  await p.waitForTimeout(900);
  const made = await p.evaluate(() => ({ none: document.body.classList.contains('bn-none'), rows: document.querySelectorAll('#bn-list .bn-li').length, adders: [...document.querySelectorAll('#bn-add-stand, #bn-add-hanging, #bn-add-sign')].filter((b) => b.getClientRects().length > 0).length }));
  check('a card makes that banner, and then the add row shows', !made.none && made.rows === 1 && made.adders === 3, JSON.stringify(made));
  await p.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— 8. phones —');
for (const lang of ['en', 'ar']) {
  const p = await open(PHONE, [], lang);
  await startFromClub(p, 'ahli');
  await until(p, () => document.body.classList.contains('m-shell') && document.querySelectorAll('.m-stand canvas.st-thumb').length >= 5, null, 60000);
  await p.waitForTimeout(6000);
  // A club start shows the phone its stadium first; the stand buttons are Design's.
  await p.evaluate(() => document.querySelector('.m-view .m-view-b')?.click());
  await p.waitForTimeout(1500);
  const m = await p.evaluate(() => ({
    shell: document.body.classList.contains('m-shell'),
    stands: [...document.querySelectorAll('.m-stand[data-stand]')].map((b) => ({ s: b.dataset.stand, h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width), thumb: !!b.querySelector('canvas.st-thumb'), name: b.querySelector('.st-name')?.textContent ?? '', count: b.querySelector('.st-count')?.textContent ?? '' })),
    bar: getComputedStyle(document.getElementById('ai-bar')).display,
    handle: getComputedStyle(document.getElementById('dock-handle')).display,
    split: document.getElementById('view-split')?.classList.contains('active') ?? false,
    wide: document.documentElement.scrollWidth - innerWidth,
  }));
  check(`${lang} phone: the stand buttons have a picture, a name and a count`, m.shell && m.stands.length === 5 && m.stands.every((x) => x.thumb && x.name && /^\d{1,3}(,\d{3})*$/.test(x.count)), JSON.stringify(m.stands));
  check(`${lang} phone: and stay 44px tall`, m.stands.every((x) => x.h >= 44), m.stands.map((x) => x.h).join(' '));
  check(`${lang} phone: no dock, no AI bar, no Split`, m.bar === 'none' && m.handle === 'none' && !m.split, JSON.stringify({ bar: m.bar, handle: m.handle, split: m.split }));
  check(`${lang} phone: nothing wider than the screen`, m.wide <= 0, `${m.wide}px`);
  if (lang === 'ar') check('Arabic phone: Arabic names', m.stands.every((x) => /[؀-ۿ]/.test(x.name)), m.stands.map((x) => x.name).join(' '));
  await p.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— the funnel —');
await new Promise((r) => setTimeout(r, 1500));
const funnel = await fetch(`${B}/api/funnel?days=7`, { headers: { 'x-ai-unlock': unlock } }).then((r) => r.json()).catch(() => ({}));
const bars = (funnel.steps ?? []).find((s) => s.name === 'ai_bar')?.sessions ?? 0;
check('the AI bar is counted ("ai_bar")', bars >= 1, JSON.stringify((funnel.steps ?? []).filter((s) => /^ai_/.test(s.name))));
const admin = await fetch(`${B}/admin.js`, { headers: { 'x-ai-unlock': unlock } }).then((r) => r.text()).catch(() => '');
check('and the admin page has a label for it', /ai_bar/.test(admin), '');

check('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
await browser.close();
stop();
console.log(`\nworkspace: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
