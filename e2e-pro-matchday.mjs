/**
 * Pro in Match Day: the LED boards' own words and exports without the mark,
 * in a real browser against real servers with PRO_MODE=preview and off.
 *
 *   not on the list   Match Day as it always was: no LED boards section, no
 *                     mark option, no crown, plain boards even with words
 *                     remembered in this browser, and Snapshot downloads at
 *                     once with no sheet;
 *   PRO_MODE off      the same, for a name that would be on the list;
 *   on the list       both controls, crowned; a message puts words on the
 *                     touchline ring (the frame changes; English and Arabic;
 *                     40 characters at most), a colour from the design's
 *                     palette, a quality change keeps them, the browser
 *                     remembers them; Snapshot with nothing Pro downloads
 *                     with no sheet; with a message the export sheet names
 *                     "LED board text" and "Export without Pro items"
 *                     downloads the free version (plain boards, the mark on)
 *                     and puts the boards back; closing the sheet exports
 *                     nothing; Record (Match Day's film by default, a Pro
 *                     item of its own) asks first, and its free version is
 *                     the recording, the boards plain
 *                     for the whole clip;
 *   the gift          after the 7-day gift: no sheet, the mark left off as
 *                     ticked, the boards in the picture, the crowns quiet;
 *   Arabic, a phone   the section's words, right to left, nothing sideways,
 *                     44px swatches on touch.
 *
 * Self-contained: it boots its own servers on memory repos (ports 8941 and
 * 8942). Needs a build:   npm run build && node e2e-pro-matchday.mjs
 * SHOTS=dir saves screenshots.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { PNG } from 'pngjs';

const PORT = 8941;
const PORT_OFF = 8942;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const out = [];
const boot = (port, env) => {
  const s = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', (d) => out.push(String(d)));
  s.stderr.on('data', (d) => out.push(String(d)));
  return s;
};
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'md_fan' });
// The same name on the list, so "off" is tested against someone it would show to.
const serverOff = boot(PORT_OFF, { PRO_MODE: 'off', PRO_PREVIEW_USERS: 'md_fan' });
const stop = () => { for (const s of [server, serverOff]) { try { s.kill(); } catch { /* gone */ } } };
process.on('exit', stop);
const up = async (base) => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up(B)) || !(await up(OFF))) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const api = async (path, token, init = {}, base = B) => {
  const r = await fetch(base + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
/** The code mailed to `email` after `from` (both servers log here, and one name signs up on both). */
const codeFor = async (email, from = 0) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').slice(from).matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const [tpl] = (await api('/api/templates')).json;
// Blue and white hoops, so the stands are a tifo and the palette has colours.
const cells = new Uint8Array(tpl.seatCount);
for (let i = 0; i < cells.length; i++) cells[i] = 1 + (Math.floor(i / 400) % 2);
const cellsGzB64 = gzipSync(cells).toString('base64');
const PALETTE = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
/** A verified account with one saved design (what the gift asks for). */
const account = async (username, base = B) => {
  const email = `${username}@tifomaker-e2e.org`;
  const from = out.join('').length;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email, from);
  const v = await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  if (v.status !== 200) console.log(`  (could not verify ${username}: ${v.status})`);
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: PALETTE, cellsGzB64 }) }, base);
  return { token, design: d.json?.id };
};
const fan = await account('md_fan');
const other = await account('md_other');
const offFan = await account('md_fan', OFF);

const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  .catch(() => chromium.launch());
const errs = [];
const LED_REMEMBERED = JSON.stringify({ messages: ['REMEMBERED', '', ''], colour: '#1c5fd9' });
/** Match Day, opened straight onto the account's saved design. */
const matchDay = async (token, design, { base = B, lang = 'en', w = 1440, h = 900, phone = false, ls = {}, init = null } = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    acceptDownloads: true,
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await ctx.addInitScript(([tok, lang, ls]) => {
    try {
      for (const [k, v] of Object.entries({
        tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1',
        tifo_banner_tour_v1: '1', tifo_lang_v1: lang, mds_seen_intro: '1', mds_sound_v2: JSON.stringify({ on: false }), ...ls,
      })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, ls]);
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${base}${lang === 'ar' ? '/ar' : ''}/app?project=${design}&sim=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await waitFor(p, () => !!window.__tifoMatchDay, null, 60000);
  // The scene's shaders are built (its first frame is on the way), and
  // /api/pro has answered (or there is nothing to answer).
  await waitFor(p, () => window.__tifoMatchDay?.compileDone === true, null, 120000);
  await p.waitForTimeout(1500);
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const openSec = (p, key) => p.evaluate((k) => {
  const s = document.querySelector(`.mds-section[data-sec="${k}"]`);
  if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click();
}, key);
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
/** What the overlay shows of Pro. */
const proUi = (p) => p.evaluate(() => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const sec = document.querySelector('.mds-section[data-sec="led"]');
  const mark = document.querySelector('[data-k="no-mark"]')?.closest('label');
  return {
    led: vis(sec),
    mark: vis(mark),
    crowns: [...document.querySelectorAll('.mds-overlay .pro-crown')].filter(vis).length,
    ledChip: !!sec?.querySelector('.mds-shead .pro-chip'),
    markChip: !!mark?.querySelector('.pro-chip'),
    quiet: [...document.querySelectorAll('.mds-overlay .pro-chip')].map((c) => c.classList.contains('quiet')),
    boards: window.__tifoMatchDay?.boardText() ?? null,
  };
});
/** Type into one of the board messages, as a person would. */
const typeMsg = async (p, n, text) => {
  const sel = `[data-k="led-text-${n}"]`;
  await p.fill(sel, '');
  await p.type(sel, text, { delay: 5 });
};
/** Record what the next snapshot / recording is asked for, and what the boards carry at that moment. */
const spy = (p) => p.evaluate(() => {
  const sim = window.__tifoMatchDay;
  window.__spy = { snaps: [], recs: [], shownDuringRec: [] };
  const snap = sim.snapshot.bind(sim);
  sim.snapshot = (o) => { window.__spy.snaps.push({ opts: o ?? null, boards: sim.boardText() }); return snap(o); };
  const rec = sim.recordReveal.bind(sim);
  sim.recordReveal = (o, tick) => {
    window.__spy.recs.push({ mark: o?.mark, boards: sim.boardText() });
    return rec(o, (s) => { window.__spy.shownDuringRec.push(sim.boardText()?.shown ?? null); tick?.(s); });
  };
});
/** Press Snapshot and wait for its file (software GL on a busy machine can take a while to draw it). */
const snapDownload = (p) => Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click('.mds-bar .mds-btn:has-text("Snapshot")', { timeout: 120000 })]);
const sheetTitle = (p) => p.evaluate(() => document.querySelector('.pro-sheet h2')?.textContent ?? null);
const noDownload = (p, ms = 2000) => p.waitForEvent('download', { timeout: ms }).then(() => false).catch(() => true);
const pngOf = async (dl) => Buffer.concat(await (await dl.createReadStream()).toArray());
const isPng = (buf) => buf.length > 1000 && buf.slice(1, 4).toString() === 'PNG';
/** How different two PNGs are in the bottom-right corner, where the mark goes (mean |delta| per channel). */
const cornerDiff = (a, b) => {
  const A = PNG.sync.read(a), C = PNG.sync.read(b);
  if (A.width !== C.width || A.height !== C.height) return -1;
  const x0 = Math.floor(A.width * 0.8), x1 = Math.floor(A.width * 0.995);
  const y0 = Math.floor(A.height * 0.92), y1 = Math.floor(A.height * 0.995);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * A.width + x) * 4;
      sum += Math.abs(A.data[i] - C.data[i]) + Math.abs(A.data[i + 1] - C.data[i + 1]) + Math.abs(A.data[i + 2] - C.data[i + 2]);
      n += 3;
    }
  }
  return sum / n;
};
/** A small fingerprint of the frame, straight off the canvas. */
const frameSig = (p) => p.evaluate(async () => {
  window.__tifoMatchDay.requestRender();
  await new Promise((r) => setTimeout(r, 1200));
  const c = document.querySelector('.mds-overlay canvas');
  const s = document.createElement('canvas');
  s.width = 160; s.height = 90;
  s.getContext('2d').drawImage(c, 0, 0, 160, 90);
  return Array.from(s.getContext('2d').getImageData(0, 0, 160, 90).data);
});
const frameDiff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
  return n;
};

// =====================================================================
console.log('\n— an account Pro is not on for —');
{
  const { ctx, p } = await matchDay(other.token, other.design, { ls: { mds_led_v1: LED_REMEMBERED } });
  const ui = await proUi(p);
  check('no LED boards section, no mark option, no crown', !ui.led && !ui.mark && ui.crowns === 0, JSON.stringify(ui));
  check('…and plain boards, even with words remembered in this browser', ui.boards === null, JSON.stringify(ui.boards));
  await spy(p);
  const [dl] = await snapDownload(p);
  const buf = await pngOf(dl);
  const s = await p.evaluate(() => window.__spy.snaps);
  check('Snapshot downloads a PNG at once, with no sheet', isPng(buf) && dl.suggestedFilename() === 'tifo-matchday.png' && !(await sheetTitle(p)), `${buf.length} bytes`);
  check('…with the mark, as it always had', s.length === 1 && s[0].opts === null, JSON.stringify(s));
  await shot(p, 'not-on-list');
  await ctx.close();
}

console.log('\n— PRO_MODE off —');
{
  const { ctx, p } = await matchDay(offFan.token, offFan.design, { base: OFF, ls: { mds_led_v1: LED_REMEMBERED } });
  const ui = await proUi(p);
  check('a name on the list sees nothing Pro either', !ui.led && !ui.mark && ui.crowns === 0 && ui.boards === null, JSON.stringify(ui));
  const [dl] = await snapDownload(p);
  check('…and Snapshot downloads at once', isPng(await pngOf(dl)) && !(await sheetTitle(p)));
  await ctx.close();
}

// =====================================================================
console.log('\n— an account on the preview list —');
{
  const { ctx, p } = await matchDay(fan.token, fan.design);
  const ui = await proUi(p);
  check('the LED boards section and the mark option, each crowned', ui.led && ui.mark && ui.ledChip && ui.markChip, JSON.stringify(ui));
  check('…the crowns not quiet (Pro is not running), the boards plain to start', ui.quiet.length >= 2 && ui.quiet.every((q) => !q) && ui.boards === null, JSON.stringify(ui));
  await openSec(p, 'led');
  await p.waitForTimeout(300);
  const sec = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="led"]');
    const inputs = [...s.querySelectorAll('input[type=text][data-k^="led-text-"]')];
    const sw = [...s.querySelectorAll('.mds-swatch')];
    return {
      head: s.querySelector('.mds-shead').textContent,
      inputs: inputs.map((i) => ({ max: i.maxLength, label: i.getAttribute('aria-label'), ph: i.placeholder, dir: getComputedStyle(i).direction, w: Math.round(i.getBoundingClientRect().width), list: Math.round(i.parentElement.getBoundingClientRect().width) })),
      swatches: sw.map((b) => ({ c: b.dataset.colour, on: b.getAttribute('aria-checked'), label: b.getAttribute('aria-label'), role: b.getAttribute('role') })),
      group: s.querySelector('[role=radiogroup]')?.getAttribute('aria-label'),
      tryHint: !s.querySelector('[data-k="led-try"]').hidden,
    };
  });
  check('three messages, 40 characters each, labelled, as wide as the panel', sec.inputs.length === 3 && sec.inputs.every((i) => i.max === 40 && /^Message \d$/.test(i.label) && /…$/.test(i.ph) && i.dir === 'ltr' && i.w === i.list), JSON.stringify(sec.inputs));
  check('the colours are the design\'s own (not its empty-seat colour), one picked', sec.swatches.map((s) => s.c).join() === '#1c5fd9,#f2f1ec,#e8b73a' && sec.swatches.filter((s) => s.on === 'true').length === 1 && sec.swatches.every((s) => s.role === 'radio' && s.label) && sec.group === 'Board colour', JSON.stringify(sec));
  check('…the boldest picked first, and "free to try" said once', sec.swatches.find((s) => s.on === 'true')?.c === '#1c5fd9' && sec.tryHint, JSON.stringify(sec.swatches));

  // The TV camera looks across at the far touchline's boards.
  const before = await frameSig(p);
  await typeMsg(p, 1, 'FOREVER TOGETHER');
  check('a message goes on the boards', await waitFor(p, () => window.__tifoMatchDay.boardText()?.messages[0] === 'FOREVER TOGETHER', null, 20000), JSON.stringify(await p.evaluate(() => window.__tifoMatchDay.boardText())));
  const after = await frameSig(p);
  const moved = frameDiff(before, after);
  check('…and the picture changes where they stand', moved > 20, `${moved} of ${before.length / 4} sample pixels`);
  await shot(p, 'led-english');
  await typeMsg(p, 2, 'يا هلال يا ذهب');
  check('Arabic too, written right to left in its box', await waitFor(p, () => window.__tifoMatchDay.boardText()?.messages[1] === 'يا هلال يا ذهب', null, 20000) && (await p.$eval('[data-k="led-text-2"]', (i) => getComputedStyle(i).direction)) === 'rtl');
  await p.evaluate(() => {
    const i = document.querySelector('[data-k="led-text-3"]');
    i.value = 'X'.repeat(60) + '\u202e\n';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('a message stops at 40 characters, with no controls in it', await waitFor(p, () => window.__tifoMatchDay.boardText()?.messages[2] === 'X'.repeat(40), null, 20000), JSON.stringify(await p.evaluate(() => window.__tifoMatchDay.boardText()?.messages)));
  await typeMsg(p, 3, 'GOLD');
  await p.click('.mds-swatch[data-colour="#e8b73a"]');
  check('a colour from the palette paints the boards', await waitFor(p, () => window.__tifoMatchDay.boardText()?.colour === '#e8b73a' && document.querySelector('.mds-swatch[data-colour="#e8b73a"]').getAttribute('aria-checked') === 'true', null, 20000));
  await p.focus('.mds-swatch[data-colour="#e8b73a"]');
  await p.keyboard.press('ArrowLeft');
  check('…and the arrows move along the colours', await waitFor(p, () => window.__tifoMatchDay.boardText()?.colour === '#f2f1ec' && document.activeElement?.dataset.colour === '#f2f1ec', null, 20000));
  const mem = await p.evaluate(() => JSON.parse(localStorage.getItem('mds_led_v1') || 'null'));
  check('the browser remembers them', mem?.messages?.[0] === 'FOREVER TOGETHER' && mem?.colour === '#f2f1ec', JSON.stringify(mem));
  await p.selectOption('.mds-bar .mds-bf select', 'low');
  check('a quality change builds a new ring with the same words', await waitFor(p, () => window.__tifoMatchDay?.boardText()?.messages.join('|') === 'FOREVER TOGETHER|يا هلال يا ذهب|GOLD', null, 60000));
  await p.waitForTimeout(1500);
  await shot(p, 'led-low');

  // Clear: the plain ring, and Snapshot is the free one it always was.
  await p.click('[data-k="led-clear"]');
  check('Clear the boards: the plain ring again', await waitFor(p, () => window.__tifoMatchDay.boardText() === null, null, 20000));
  await spy(p);
  {
    const [dl] = await snapDownload(p);
    check('Snapshot with nothing Pro: no sheet, a PNG downloads', isPng(await pngOf(dl)) && !(await sheetTitle(p)));
  }

  // A message on the boards: the export sheet, then the free version.
  await typeMsg(p, 1, 'FOREVER TOGETHER');
  await waitFor(p, () => !!window.__tifoMatchDay.boardText(), null, 20000);
  await p.click('.mds-bar .mds-btn:has-text("Snapshot")', { timeout: 120000 });
  check('Snapshot with a message opens the export sheet over Match Day', await waitFor(p, () => /This export uses a Pro item/.test(document.querySelector('.pro-sheet h2')?.textContent || ''), null, 10000));
  const sheet = await p.evaluate(() => {
    const b = document.querySelector('.pro-sheet-backdrop');
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.width / 2, r.height / 2);
    return { items: [...document.querySelectorAll('.pro-items li')].map((l) => l.textContent), free: document.querySelector('[data-act="free"]')?.textContent, onTop: !!top?.closest('.pro-sheet-backdrop') };
  });
  check('…naming "LED board text", with "Export without Pro items", on top', sheet.items.join() === 'LED board text' && sheet.free === 'Export without Pro items' && sheet.onTop, JSON.stringify(sheet));
  await shot(p, 'sheet');
  {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click('.pro-sheet [data-act="free"]', { timeout: 120000 })]);
    const s = await p.evaluate(() => window.__spy.snaps.at(-1));
    check('"Export without Pro items" downloads a PNG', isPng(await pngOf(dl)), dl.suggestedFilename());
    check('…the free version: plain boards, and the mark on', s?.boards?.shown === false && s?.opts?.mark !== false, JSON.stringify(s));
    check('…and the boards are back on screen afterwards', await waitFor(p, () => window.__tifoMatchDay.boardText()?.shown === true, null, 20000));
  }

  // The mark too: two items; closing the sheet exports nothing.
  await p.check('[data-k="no-mark"]');
  await p.click('.mds-bar .mds-btn:has-text("Snapshot")', { timeout: 120000 });
  check('with "No mark" ticked the sheet names both', await waitFor(p, () => [...document.querySelectorAll('.pro-items li')].map((l) => l.textContent).join() === 'Without the tifomaker.org mark,LED board text', null, 10000));
  const none = noDownload(p, 2500);
  await p.keyboard.press('Escape');
  check('closing the sheet exports nothing, and leaves Match Day open', (await none) && !!(await p.$('.mds-overlay canvas')) && !(await sheetTitle(p)));

  // Record's free version keeps the boards plain for the whole clip.
  await p.evaluate(() => {
    const s = document.querySelector('[data-k="rec-length"]');
    s.value = '6';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.click('.mds-bar .mds-btn:has-text("Record")');
  // Record makes Match Day's film for an account Pro is on for (ui/proFilm.ts): a Pro item of its own.
  check('Record with Pro items asks first, the film among them', await waitFor(p, () => [...document.querySelectorAll('.pro-items li')].map((l) => l.textContent).join() === 'Without the tifomaker.org mark,LED board text,Full HD video', null, 10000), JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.pro-items li')].map((l) => l.textContent))));
  {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), p.click('.pro-sheet [data-act="free"]')]);
    const r = await p.evaluate(() => ({ rec: window.__spy.recs.at(-1), during: window.__spy.shownDuringRec }));
    const failed = await dl.failure();
    const size = failed ? 0 : (await pngOf(dl)).length;
    // The clip's size is the recorder's business (software GL on a busy
    // machine can hand it few frames); the export going out is this one's.
    check('…the free clip downloads', /^tifo-matchday\.(mp4|webm)$/.test(dl.suggestedFilename()) && !failed, `${dl.suggestedFilename()} ${size} bytes${failed ? ' ' + failed : ''}`);
    check('…with the mark, and the boards plain the whole way through', r.rec?.mark === true && r.rec?.boards?.shown === false && r.during.length >= 3 && r.during.every((v) => v === false), JSON.stringify(r));
    check('…and back afterwards', await waitFor(p, () => window.__tifoMatchDay.boardText()?.shown === true, null, 10000));
  }
  await ctx.close();
}

// =====================================================================
console.log('\n— the LED boards\' clock, in Node (render/simulator/ledBoards.ts) —');
{
  const { LedShow, pagesFor, DEFAULT_STYLE } = await tsImport('./src/render/simulator/ledBoards.ts', import.meta.url);
  const MSGS = ['FOREVER TOGETHER', 'يا هلال يا ذهب', 'GOLD'];
  /** Run a show at 60 frames a second; `when(t)` says [moving, revealing]. */
  const run = (style, secs, when) => {
    const show = new LedShow();
    show.setPages(pagesFor(MSGS, { ...DEFAULT_STYLE, ...style }));
    const out = [];
    for (let i = 0; i < secs * 60; i++) {
      const [moving, revealing] = when(i / 60);
      out.push({ t: i / 60, ...show.step(1 / 60, moving, revealing) });
    }
    return out;
  };
  const still = run({}, 5, () => [false, false]);
  check('still: the three messages side by side, nothing moving, nothing asked for', still.every((f) => f.pages.slice(0, 3).join() === '0,1,2' && f.scroll === 0 && f.glow === 1 && !f.busy));
  const moving = run({}, 12, (t) => [t < 10, false]);
  const shown = [...new Set(moving.filter((f) => f.t < 10).map((f) => f.pages[0]))];
  check('while the scene moves they take turns, scrolling between them', shown.length === 3 && moving.some((f) => f.scroll !== 0), JSON.stringify(shown));
  const after = moving.filter((f) => f.t >= 10);
  const busyAfter = after.filter((f) => f.busy).length / 60;
  check('when it stops they finish the change they were in (under a second) and rest', busyAfter <= 0.75 && after.at(-1).pages.slice(0, 3).join() === '0,1,2' && !after.at(-1).busy, `${busyAfter.toFixed(2)} s`);
  const reveal = run({}, 5, (t) => [true, t < 4.5]);
  check('in the reveal they flash, three times, then hold steady', reveal.filter((f) => f.t < 1.5).some((f) => f.glow > 1) && reveal.filter((f) => f.t < 1.5).some((f) => f.glow < 1) && reveal.filter((f) => f.t > 1.6).every((f) => f.glow === 1));
  const cd = run({ template: 'countdown' }, 4, () => [true, true]);
  const order = cd.map((f) => f.pages[0]).filter((x, i, a) => i === 0 || x !== a[i - 1]);
  check('Countdown: 3, 2, 1 a beat apart as the reveal starts, then the first message', order.slice(0, 4).join() === '0,1,2,3' && cd.find((f) => f.pages[0] === 3).t > 2.3 && cd.find((f) => f.pages[0] === 3).t < 2.5, JSON.stringify(order));
  const tick = run({ template: 'chant' }, 6, (t) => [t < 3, false]);
  check('Chant: the ticker runs while the scene moves and stops where it is when it stops', tick[170].scroll > tick[10].scroll && tick[250].scroll === tick[359].scroll);
  check('Score: the score line first, then the messages', pagesFor(MSGS, { ...DEFAULT_STYLE, template: 'score', home: 'Hilal', away: 'Nassr', homeGoals: 2 }).map((p) => p.kind).join() === 'score,text,text,text');
}

// =====================================================================
console.log('\n— the LED boards move, styled: templates, the crest, the big screens —');
{
  /** Frames Match Day draws (a draw into its canvas), counted at the WebGL calls, as e2e-matchday-perf.mjs does. */
  const COUNT = () => {
    window.__mdFrames = 0;
    let drew = false;
    const P = WebGL2RenderingContext.prototype;
    for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const f = P[n];
      P[n] = function (...a) { if (this.canvas?.closest?.('.mds-overlay')) drew = true; return f.apply(this, a); };
    }
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => { drew = false; cb(t); if (drew) window.__mdFrames++; });
  };
  // Small, so the software renderer draws the reveal at a frame rate the boards can be timed by.
  const { ctx, p } = await matchDay(fan.token, fan.design, { init: COUNT, w: 720, h: 450, ls: { mds_led_v1: JSON.stringify({ messages: ['FOREVER TOGETHER', 'يا هلال يا ذهب', 'GOLD'], colour: '#1c5fd9' }) } });
  await openSec(p, 'led');
  const frames = () => p.evaluate(() => window.__mdFrames);
  const still = async (quiet = 3000, limit = 120000) => {
    const t0 = Date.now(); let last = await frames(); let since = Date.now();
    while (Date.now() - t0 < limit) { await p.waitForTimeout(400); const f = await frames(); if (f !== last) { last = f; since = Date.now(); } else if (Date.now() - since >= quiet) return true; }
    return false;
  };
  const board = () => p.evaluate(() => window.__tifoMatchDay.boardFrame());
  check('the words remembered are on the boards', await waitFor(p, () => window.__tifoMatchDay.boardFrame()?.count === 3, null, 30000), JSON.stringify(await board()));
  const ui = await p.evaluate(() => ({
    styles: [...document.querySelectorAll('[data-k="led-style"] option')].map((o) => o.value),
    kit: document.querySelector('[data-k="led-kit"]')?.disabled,
    kitHint: document.querySelector('[data-k="led-kit-hint"]')?.textContent,
    screen: !!document.querySelector('[data-k="screen-mode"] option[value="boards"]'),
  }));
  check('five styles: messages, sponsor, chant, score, countdown', ui.styles.join() === 'boards,sponsor,chant,score,countdown', JSON.stringify(ui));
  check('no club kit in this browser: the crest list says where to make one', ui.kit === true && /club kit/.test(ui.kitHint || ''), JSON.stringify(ui));
  // Read once the boards have laid out (under load the first frame can still
  // show one page on every board).
  await waitFor(p, () => { const b = window.__tifoMatchDay.boardFrame(); return !!b && b.pages.slice(0, 3).join() === '0,1,2'; }, null, 30000);
  const rest = await board();
  check('still, the ring shows the three messages side by side', rest.pages.slice(0, 3).join() === '0,1,2' && rest.glow === 1, JSON.stringify(rest));
  check('a still Match Day with words on the boards draws nothing', await still(3000) && (await (async () => { const a = await frames(); await p.waitForTimeout(4000); return (await frames()) - a; })()) === 0);
  // The reveal: the boards move with it.
  const seen = await p.evaluate(async () => {
    const sim = window.__tifoMatchDay;
    const out = new Set();
    let glows = 0;
    sim.playReveal('wave', 4500);
    const t0 = performance.now();
    while (performance.now() - t0 < 7000) {
      await new Promise((r) => requestAnimationFrame(r));
      const b = sim.boardFrame();
      if (b) { out.add(b.pages.join('') + '|' + b.scroll.toFixed(2)); if (b.glow !== 1) glows++; }
    }
    return { states: out.size, glows };
  });
  check('during the reveal the boards move with it (they take turns and flash)', seen.states >= 2 && seen.glows >= 1, JSON.stringify(seen));
  check('…and when it is over, Match Day stops drawing again (the boards finish their change and rest)', await still(3000, 60000));
  check('…at rest: the messages side by side again', (await board()).pages.slice(0, 3).join() === '0,1,2', JSON.stringify(await board()));
  await shot(p, 'led-after-reveal');
  // Score style.
  await p.selectOption('[data-k="led-style"]', 'score');
  await p.fill('[data-k="led-home"]', 'Hilal');
  await p.fill('[data-k="led-away"]', 'Nassr');
  await p.fill('[data-k="led-home-goals"]', '2');
  check('Score: CLUB 2–0 RIVAL first, then the messages', await waitFor(p, () => window.__tifoMatchDay.boardFrame()?.kinds.join() === 'score,text,text,text', null, 20000), JSON.stringify(await board()));
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('mds_led_style_v1') || 'null'));
  check('…remembered in this browser', saved?.template === 'score' && saved.home === 'Hilal' && saved.away === 'Nassr' && saved.homeGoals === 2, JSON.stringify(saved));
  await shot(p, 'led-score');
  // Countdown: 3, 2, 1 in the reveal, then the words.
  await p.selectOption('[data-k="led-style"]', 'countdown');
  await waitFor(p, () => window.__tifoMatchDay.boardFrame()?.kinds[0] === 'count', null, 20000);
  const count = await p.evaluate(async () => {
    const sim = window.__tifoMatchDay;
    const order = [];
    sim.playReveal('wave', 4500);
    const t0 = performance.now();
    while (performance.now() - t0 < 9000) {
      await new Promise((r) => requestAnimationFrame(r));
      const pg = sim.boardFrame()?.pages[0];
      if (order[order.length - 1] !== pg) order.push(pg);
    }
    return order;
  });
  // The software renderer draws about a frame a second here, so only the order is checked (the timing is, in Node, above).
  check('Countdown: the digits as the reveal starts, then the words', count.some((x) => x <= 2) && count[count.length - 1] >= 3 && count.every((x, i) => i === 0 || x >= count[i - 1]), JSON.stringify(count));
  await still(3000, 60000);
  // Chant ticker.
  await p.selectOption('[data-k="led-style"]', 'chant');
  check('Chant: one ticker of every message', await waitFor(p, () => window.__tifoMatchDay.boardFrame()?.kinds.join() === 'ticker', null, 20000));
  // The big screens, on a ground that has them.
  const screens = await p.evaluate(() => window.__tifoMatchDay.hasScreens());
  if (screens) {
    await openSec(p, 'screens');
    await p.selectOption('[data-k="screen-mode"]', 'boards');
    check('the big screens can show the boards', await waitFor(p, () => window.__tifoMatchDay.screenMode() === 'boards', null, 20000));
  } else {
    check('(this ground has no big screens: the option waits for one that does)', ui.screen);
  }
  await p.selectOption('[data-k="led-style"]', 'boards');
  await ctx.close();
}

// =====================================================================
console.log('\n— after the 7-day gift —');
{
  const g = await api('/api/pro/gift/accept', fan.token, { method: 'POST', body: '{}' });
  check('the gift starts', g.status === 200 && !!g.json?.endsAt, JSON.stringify(g.json));
  const { ctx, p } = await matchDay(fan.token, fan.design, { ls: { mds_led_v1: JSON.stringify({ messages: ['FOREVER TOGETHER', '', ''], colour: '#e8b73a' }) } });
  const ui = await proUi(p);
  check('words remembered in this browser are on the boards straight away', ui.boards?.messages?.join() === 'FOREVER TOGETHER' && ui.boards?.colour === '#e8b73a', JSON.stringify(ui.boards));
  check('the crowns are quiet now, and "free to try" is gone', ui.quiet.length >= 2 && ui.quiet.every(Boolean) && (await p.evaluate(() => document.querySelector('[data-k="led-try"]').hidden)), JSON.stringify(ui));
  await spy(p);
  await p.check('[data-k="no-mark"]');
  const [dl] = await snapDownload(p);
  const s = await p.evaluate(() => window.__spy.snaps.at(-1));
  const clean = await pngOf(dl);
  check('Snapshot: no sheet, a PNG', isPng(clean) && !(await sheetTitle(p)));
  check('…without the mark, with the boards in the picture', s?.opts?.mark === false && s?.boards?.shown === true, JSON.stringify(s));
  await p.uncheck('[data-k="no-mark"]');
  const [dl2] = await snapDownload(p);
  const marked = await pngOf(dl2);
  const d = cornerDiff(clean, marked);
  check('…and its corner really is bare: the same view with the mark differs there', d > 4, `mean corner difference ${d.toFixed(1)}`);
  await ctx.close();
}

// =====================================================================
console.log('\n— Arabic, and a phone —');
{
  const { ctx, p } = await matchDay(fan.token, fan.design, { lang: 'ar' });
  await openSec(p, 'led');
  await p.waitForTimeout(400);
  const ar = await p.evaluate(() => {
    const s = document.querySelector('.mds-section[data-sec="led"]');
    return {
      dir: document.querySelector('.mds-overlay').dir,
      head: s.querySelector('.mds-shead').textContent,
      label: document.querySelector('[data-k="led-text-1"]').getAttribute('aria-label'),
      mark: document.querySelector('[data-k="no-mark"]').closest('label').innerText,
      // Match Day's own boxes (the editor underneath has its own suites).
      over: Math.max(0, ...[...document.querySelectorAll('.mds-overlay *')].filter((e) => e.getClientRects().length && !e.closest('.mds-panel.collapsed')).map((e) => { const b = e.getBoundingClientRect(); return Math.max(b.right - innerWidth, -b.left); })),
    };
  });
  check('the section in Arabic, with the crown\'s word', ar.dir === 'rtl' && /اللوحات الإعلانية/.test(ar.head) && /مميّز/.test(ar.head) && ar.label === 'الرسالة 1', JSON.stringify(ar));
  check('…the mark option too, and nothing sticks out sideways', /بدون العلامة/.test(ar.mark) && ar.over <= 1, JSON.stringify(ar));
  await shot(p, 'led-arabic-desktop');
  // Too narrow a bar for one more control: the option heads Recording instead.
  const bar = async () => p.evaluate(() => {
    const lbl = document.querySelector('[data-k="no-mark"]').closest('label');
    const q = document.querySelector('.mds-bar .mds-bf select');
    return { inBar: !!lbl.closest('.mds-bar'), inRec: !!lbl.closest('[data-sec="record"]'), quality: Math.round(q.getBoundingClientRect().width), brand: Math.round(document.querySelector('.mds-brand').getBoundingClientRect().width) };
  });
  await p.setViewportSize({ width: 940, height: 800 });
  await waitFor(p, () => !!document.querySelector('[data-k="no-mark"]').closest('[data-sec="record"]'), null, 20000);
  await p.waitForTimeout(300);
  const narrow = await bar();
  await shot(p, 'arabic-940');
  check('at 940px the mark option heads Recording, and the bar keeps its quality picker', !narrow.inBar && narrow.inRec && narrow.quality >= 60, JSON.stringify(narrow));
  await p.setViewportSize({ width: 1100, height: 800 });
  await waitFor(p, () => !!document.querySelector('[data-k="no-mark"]').closest('.mds-bar'), null, 20000);
  await p.waitForTimeout(300);
  const wide = await bar();
  check('…and is back in the bar with room for it', wide.inBar && wide.quality >= 60 && wide.brand >= 60, JSON.stringify(wide));
  await ctx.close();
}
for (const lang of ['en', 'ar']) {
  const { ctx, p } = await matchDay(fan.token, fan.design, { lang, w: 390, h: 844, phone: true });
  // The panel starts tucked away on a phone.
  await p.click('.mds-bar .mds-icon');
  await p.waitForTimeout(500);
  await openSec(p, 'led');
  await p.waitForTimeout(500);
  const m = await p.evaluate(() => {
    const lbl = document.querySelector('[data-k="no-mark"]').closest('label');
    const r = lbl.getBoundingClientRect();
    const sw = [...document.querySelectorAll('.mds-swatch')].map((b) => b.getBoundingClientRect());
    const long = lbl.querySelector('.mds-long');
    return {
      inPanel: !!lbl.closest('.mds-panel-acts'),
      longShown: long.getClientRects().length > 0,
      h: Math.round(r.height),
      sw: sw.map((b) => Math.round(Math.min(b.width, b.height))),
      over: document.documentElement.scrollWidth - innerWidth,
      inputsIn: [...document.querySelectorAll('[data-sec="led"] input[type=text]')].every((i) => { const b = i.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }),
    };
  });
  check(`phone (${lang}): the mark option in full with Snapshot and Record, 44px tall`, m.inPanel && m.longShown && m.h >= 44, JSON.stringify(m));
  check(`phone (${lang}): 44px colours, everything on screen`, m.sw.length === 3 && m.sw.every((v) => v >= 44) && m.over <= 0 && m.inputsIn, JSON.stringify(m));
  await p.evaluate(() => { const s = document.querySelector('.mds-section[data-sec="led"]'); s.scrollIntoView({ block: 'start' }); });
  await p.waitForTimeout(300);
  await shot(p, `led-phone-${lang}`);
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
