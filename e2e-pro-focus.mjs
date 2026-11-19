/**
 * The part of the tifo to show (src/ui/tifoFocus.ts), in a real browser
 * against a real server with PRO_MODE=preview:
 *
 *   round the ground   a tifo on every seat: the pack sheet says no one
 *                      picture holds it and asks for a part; a box dragged
 *                      over the flat tifo redraws the picture on that part,
 *                      and "Let the camera choose" puts it back;
 *   kept               the choice is the visit's: the poster and the
 *                      proposal open on it, and the proposal's second
 *                      picture is drawn (it was an empty frame for a tifo
 *                      round the ground);
 *   the film           under a Pro video size in the editor, the same
 *                      picker, and the choice made there is the one the sheets
 *                      open on;
 *   in Arabic, 390px   the picker in Arabic, nothing sideways.
 *
 * Self-contained: it boots its own server (port 8978) on memory repos.
 * Needs a build:   npm run build && node e2e-pro-focus.mjs
 * SHOTS=<dir> saves the sheets. PW_CHANNEL=chrome uses the installed Chrome.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8978;
const B = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'qf_round,qf_stand' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  up = await fetch(`${B}/health`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const [tpl] = (await api('/api/templates')).json;
/** An account with the gift running and one tifo: on every seat (`round`), or on a stretch of one side. */
const account = async (username, round) => {
  const cells = new Uint8Array(tpl.seatCount);
  const from = round ? 0 : Math.floor(tpl.seatCount * 0.08), to = round ? tpl.seatCount : Math.floor(tpl.seatCount * 0.2);
  for (let i = from; i < to; i++) cells[i] = 1 + (Math.floor(i / 97) % 3);
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) });
  const token = r.json?.token;
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#0f7a3d', '#f2f1ec', '#16161a'], cellsGzB64: gzipSync(cells).toString('base64') }) });
  await api('/api/pro/gift/accept', token, { method: 'POST', body: '{}' });
  return { token, design: d.json?.id };
};
const round = await account('qf_round', true);
const stand = await account('qf_stand', false);

const browser = process.env.PW_CHANNEL
  ? await chromium.launch({ channel: process.env.PW_CHANNEL, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] })
  : await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const LS = { tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}', tifo_banner_tour_v1: '1', tifo_post_nudge_v1: '1', tifo_view_v1: '2d' };
const open = async (token, design, { lang = 'en', w = 1440, h = 900, phone = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([tok, lang, ls]) => {
    try {
      for (const [k, v] of Object.entries({ ...ls, tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, LS]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/app?project=${design}&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitFor(p, () => !!window.__tifo, null, 120000);
  await waitFor(p, () => /wall$/.test(document.getElementById('doc-title')?.value || ''), null, 30000);
  await p.waitForTimeout(600);
  return { ctx, p };
};
const animPanel = async (p) => {
  await p.click('#rail-anim');
  await waitFor(p, () => !!document.getElementById('sx-pack') && !document.getElementById('sx-pack').hidden, null, 30000);
};
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const ready = (p, ms = 240000) => waitFor(p, () => document.querySelector('.qv-preview canvas')?.dataset.ready === '1' && !document.querySelector('.qv-wait')?.textContent, null, ms);
/** A small fingerprint of the sheet's preview. */
const SIG = () => {
  const c = document.querySelector('.qv-preview canvas');
  if (!c || c.dataset.ready !== '1') return '';
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4 * 97) h = (Math.imul(h, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
  return `${c.width}x${c.height}:${h}`;
};
const changed = (p, before, ms = 120000) => waitFor(p, (b) => {
  const c = document.querySelector('.qv-preview canvas');
  if (!c || c.dataset.ready !== '1' || document.querySelector('.qv-wait')?.textContent) return false;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4 * 97) h = (Math.imul(h, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
  return `${c.width}x${c.height}:${h}` !== b;
}, before, ms);
/** Drag a box over the flat tifo: from (x0, y0) to (x1, y1), as shares of the picker's picture. */
const dragBox = async (p, x0, y0, x1, y1, sel = '.pro-sheet .tf-art canvas') => {
  await p.locator(sel).scrollIntoViewIfNeeded();
  const r = await p.locator(sel).boundingBox();
  await p.mouse.move(r.x + r.width * x0, r.y + r.height * y0);
  await p.mouse.down();
  await p.mouse.move(r.x + r.width * ((x0 + x1) / 2), r.y + r.height * ((y0 + y1) / 2), { steps: 4 });
  await p.mouse.move(r.x + r.width * x1, r.y + r.height * y1, { steps: 4 });
  await p.mouse.up();
};
const picker = (p, scope = '.pro-sheet') => p.evaluate((scope) => {
  const tf = document.querySelector(`${scope} .tf`);
  if (!tf) return null;
  return { on: tf.dataset.on === '1', hint: tf.querySelector('.tf-hint').textContent, all: !tf.querySelector('.tf-all').hidden, label: tf.querySelector('.tf-label').textContent, shown: tf.getBoundingClientRect().height > 0 };
}, scope);

// =====================================================================
console.log('\n— a tifo round the whole ground —');
{
  const { ctx, p } = await open(round.token, round.design);
  await animPanel(p);
  await p.click('#sx-pack');
  check('the pack opens and draws', await ready(p));
  const a = await picker(p);
  check('it asks which part, and says why', !!a && !a.on && /goes round the ground/.test(a.hint) && !a.all && a.label === 'Part to show', JSON.stringify(a));
  const before = await p.evaluate(SIG);
  await shot(p, 'qf-pack-round-before');
  await dragBox(p, 0.3, 0.1, 0.45, 0.9);
  const b = await picker(p);
  check('a box dragged over it is the part to show', !!b && b.on && /stays on this part/.test(b.hint) && b.all, JSON.stringify(b));
  check('the picture is drawn again on that part', await changed(p, before));
  const onPart = await p.evaluate(SIG);
  await shot(p, 'qf-pack-round-part');
  await p.click('.pro-sheet-close');

  // Kept for the visit: the poster opens on it.
  await p.click('#sx-poster');
  check('the poster opens and draws', await ready(p));
  const c = await picker(p);
  check('the poster opens on the same part', !!c && c.on, JSON.stringify(c));
  await shot(p, 'qf-poster-round-part');
  const posterPart = await p.evaluate(SIG);
  await p.click('.pro-sheet .tf-all');
  const d = await picker(p);
  check('"Let the camera choose" clears it', !!d && !d.on && !d.all, JSON.stringify(d));
  check('and the poster is drawn again', await changed(p, posterPart));
  await p.click('.pro-sheet-close');

  // The pack again: back to what the camera chose.
  await p.click('#sx-pack');
  await ready(p);
  check('the pack is back to the camera’s own picture', (await p.evaluate(SIG)) !== onPart);
  // A tap is not a box; a box on bare seats has too few cards.
  await dragBox(p, 0.5, 0.5, 0.505, 0.5);
  const tap = await picker(p);
  check('a tap chooses nothing', !!tap && !tap.on, JSON.stringify(tap));
  await p.click('.pro-sheet-close');

  // The proposal: both pictures, and again on a part.
  await p.click('#rail-save').catch(() => {});
  const hasProp = await waitFor(p, () => !!document.getElementById('export-proposal') && !document.getElementById('export-proposal').hidden && document.getElementById('export-proposal').getBoundingClientRect().height > 0, null, 8000);
  if (hasProp) {
    await p.click('#export-proposal');
    check('the proposal opens and draws both pictures', await ready(p));
    const page0 = await p.evaluate(SIG);
    await shot(p, 'qf-proposal-round');
    await dragBox(p, 0.6, 0.1, 0.8, 0.9);
    check('a part chosen there redraws its pictures', await changed(p, page0));
    await shot(p, 'qf-proposal-round-part');
    await p.click('.pro-sheet .tf-all');
    await p.click('.pro-sheet-close');
  } else check('the proposal button is reachable', false, 'no #export-proposal on show');
  await ctx.close();
}

console.log('\n— a tifo on one side: the film —');
{
  const { ctx, p } = await open(stand.token, stand.design);
  await animPanel(p);
  check('no picker until a Pro video size is picked', !(await picker(p, '#app'))?.shown && !(await picker(p, 'body'))?.shown);
  await p.selectOption('#sx-size', 'vertical');
  const a = await picker(p, 'body');
  check('under the vertical size: the picker, asking for a part', !!a && a.shown && !a.on && /Drag a box/.test(a.hint), JSON.stringify(a));
  await shot(p, 'qf-editor-vertical');
  await dragBox(p, 0.35, 0.05, 0.65, 0.95, '.pexp-part .tf-art canvas');
  const b = await picker(p, 'body');
  check('a box there is kept', !!b && b.on, JSON.stringify(b));
  // The pack opens on it too: one choice for every export.
  await p.click('#sx-pack');
  await ready(p);
  check('the pack opens on the part chosen under the size', (await picker(p))?.on === true);
  await shot(p, 'qf-pack-stand-part');
  await p.click('.pro-sheet-close');
  await p.selectOption('#sx-size', 'screen');
  check('back at the screen’s size the picker goes', !(await picker(p, 'body'))?.shown);
  await ctx.close();
}

console.log('\n— Match Day: its own film —');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([tok, ls]) => {
    try {
      for (const [k, v] of Object.entries({ ...ls, tifo_lang_v1: 'en' })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [round.token, LS]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${B}/app?project=${round.design}&sim=1&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  check('Match Day opens with the film choice', await waitFor(p, () => !!document.querySelector('[data-sec="record"] [data-k="rec-film"]'), null, 120000));
  const rec = '[data-sec="record"]';
  // The section is folded until asked for: the picker is judged by its own state, not its place on the screen.
  const state = () => p.evaluate((rec) => {
    const tf = document.querySelector(`${rec} .tf`);
    return tf ? { off: tf.classList.contains('tf-off'), on: tf.dataset.on === '1', film: document.querySelector(`${rec} [data-k="rec-film"]`).value } : null;
  }, rec);
  const a = await state();
  check('a film is picked, and the picker is with it', !!a && !a.off && !a.on && a.film === 'landscape', JSON.stringify(a));
  const pick = (v) => p.evaluate(([rec, v]) => { const el = document.querySelector(`${rec} [data-k="rec-film"]`); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [rec, v]);
  await pick('vertical');
  check('still there for the vertical film', (await state())?.off === false);
  await pick('screen');
  check('gone for a recording of the view', (await state())?.off === true);
  await shot(p, 'qf-matchday');
  await ctx.close();
}

console.log('\n— in Arabic, on a phone —');
{
  const { ctx, p } = await open(round.token, round.design, { lang: 'ar', w: 390, h: 844, phone: true });
  const opened = await p.evaluate(async () => {
    // The phone shell keeps the export panel behind its own tabs: open the pack's sheet by its button wherever it is.
    for (let i = 0; i < 60; i++) {
      const b = document.getElementById('sx-pack');
      if (b && !b.hidden) { b.click(); return true; }
      document.getElementById('rail-anim')?.click();
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  });
  check('the pack opens on a phone', opened && (await ready(p)));
  const a = await picker(p);
  check('the picker is in Arabic', !!a && a.label === 'الجزء اللي يطلع' && /تيفوك يلف الملعب/.test(a.hint), JSON.stringify(a));
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const tf = await p.evaluate(() => { const r = document.querySelector('.pro-sheet .tf-art canvas').getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height }; });
  check('nothing sideways at 390px', wide <= 1 && tf.l >= 0 && tf.r <= 390 && tf.h >= 24, JSON.stringify({ wide, tf }));
  await shot(p, 'qf-pack-390-ar');
  await ctx.close();
}

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
