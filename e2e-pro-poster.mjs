/**
 * Pro's match-day poster (src/ui/proPoster.ts, src/ui/posterLayout.ts), in a
 * real browser against a real server with PRO_MODE=preview:
 *
 *   Pro running    the poster button opens the sheet; the preview is Match
 *                  Day's picture of the tifo with the type over it, and
 *                  follows the fields as they are typed; three layouts (each
 *                  shows its own fields), two shapes; the download is a PNG
 *                  of exactly 3840 × 2160 or 2160 × 3840, with no mark; the
 *                  fields are remembered; the club kit gives the club's
 *                  name, colours and lettering;
 *   in Arabic      the sheet right to left in Arabic, and the poster's own
 *                  words ("يوم المباراة", "ضد") on it; on a 390px phone,
 *                  nothing sideways and 44px targets;
 *   not running    the download asks first, naming "4K poster picture", and
 *                  "Export without Pro items" is today's picture: the
 *                  screen's size, with the mark.
 *
 * Self-contained: it boots its own server (port 8977) on memory repos.
 * Needs a build:   npm run build && node e2e-pro-poster.mjs
 * SHOTS=<dir> saves the sheet and the posters.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8977;
const B = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '', AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'qp_fan,qp_gift' },
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
const account = async (username) => {
  const cells = new Uint8Array(tpl.seatCount);
  const from = Math.floor(tpl.seatCount * 0.08), to = Math.floor(tpl.seatCount * 0.2);
  for (let i = from; i < to; i++) cells[i] = 1 + (Math.floor(i / 97) % 3);
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) });
  const token = r.json?.token;
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64: gzipSync(cells).toString('base64') }) });
  return { token, design: d.json?.id };
};
const fan = await account('qp_fan');
const gift = await account('qp_gift');
check('the gift starts for qp_gift', (await api('/api/pro/gift/accept', gift.token, { method: 'POST', body: '{}' })).status === 200);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const LS = { tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_post_nudge_v1: '1', tifo_view_v1: '2d' };
const open = async (token, design, { lang = 'en', w = 1440, h = 900, phone = false, kit = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([tok, lang, ls]) => {
    try {
      for (const [k, v] of Object.entries({ ...ls, tifo_lang_v1: lang })) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
    // Every word a canvas sets: the mark, and the poster's own words.
    window.__marks = 0;
    window.__texts = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (text === 'tifomaker.org') window.__marks++;
      if (window.__texts.length < 4000) window.__texts.push(String(text));
      return fill.call(this, text, ...rest);
    };
  }, [token, lang, LS]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/app?project=${design}&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitFor(p, () => !!window.__tifo, null, 120000);
  await waitFor(p, () => /wall$/.test(document.getElementById('doc-title')?.value || ''), null, 30000);
  if (kit) {
    // A club kit, kept as the club kit keeps one (ui/clubKitStore.ts).
    await p.evaluate(async () => {
      const c = new OffscreenCanvas(240, 280);
      const g = c.getContext('2d');
      g.fillStyle = '#0b4ea2'; g.fillRect(0, 0, 240, 280);
      g.fillStyle = '#ffffff'; g.fillRect(40, 40, 160, 200);
      const logo = await c.convertToBlob({ type: 'image/png' });
      await new Promise((res, rej) => {
        const req = indexedDB.open('tifo_club_kits', 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kits')) req.result.createObjectStore('kits'); };
        req.onsuccess = () => {
          const tx = req.result.transaction('kits', 'readwrite');
          tx.objectStore('kits').put({ v: 1, name: 'Al Hilal', colors: ['#0b4ea2', '#ffffff'], logos: [logo], font: 'stencil', at: Date.now() }, 'kqvposter01');
          tx.oncomplete = () => { req.result.close(); res(); };
          tx.onerror = () => rej(tx.error);
        };
        req.onerror = () => rej(req.error);
      });
    });
  }
  await p.waitForTimeout(600);
  return { ctx, p };
};
const animPanel = async (p) => {
  await p.click('#rail-anim');
  await waitFor(p, () => !!document.getElementById('sx-poster') && !document.getElementById('sx-poster').hidden, null, 30000);
};
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const bytesOf = async (dl) => Buffer.concat(await (await dl.createReadStream()).toArray());
const downloadFrom = async (p, click, ms = 300000) => {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: ms }), click()]);
  return { name: dl.suggestedFilename(), buf: await bytesOf(dl) };
};
const reader = await (await browser.newContext()).newPage();
await reader.goto(`${B}/health`);
const pngSize = (buf) => reader.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  return { w: bmp.width, h: bmp.height };
}, buf.toString('base64'));
/** A small fingerprint of the preview. */
const previewSig = (p) => p.evaluate(() => {
  const c = document.querySelector('.qv-preview canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4 * 97) h = (Math.imul(h, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
  return `${c.width}x${c.height}:${h}`;
});
const openPoster = async (p) => {
  await p.click('#sx-poster');
  return waitFor(p, () => document.querySelector('.qv-preview canvas')?.dataset.ready === '1', null, 240000);
};

// =====================================================================
console.log('\n— Pro running, with a club kit —');
{
  const { ctx, p } = await open(gift.token, gift.design, { kit: true });
  await animPanel(p);
  check('the button says what it is', (await p.textContent('#sx-poster'))?.trim() === 'Match-day poster (4K)', await p.textContent('#sx-poster'));
  check('the sheet opens and draws the preview', await openPoster(p));
  const ui = await p.evaluate(() => ({
    title: document.querySelector('#qv-p-title')?.textContent,
    lead: document.querySelector('.qv-lead')?.textContent,
    layouts: [...document.querySelectorAll('input[name="qv-layout"]')].map((i) => i.value),
    shapes: [...document.querySelectorAll('input[name="qv-shape"]')].map((i) => i.value),
    club: document.querySelector('input[name="qv-club"]').value,
    venue: document.querySelector('input[name="qv-venue"]').value,
    colours: document.querySelector('select[name="qv-kit"]')?.selectedOptions[0]?.textContent,
    font: document.querySelector('select[name="qv-font"]').selectedOptions[0]?.textContent,
    shown: [...document.querySelectorAll('.qv-field[data-f]')].filter((f) => !f.hidden).map((f) => f.dataset.f),
    canvas: (() => { const c = document.querySelector('.qv-preview canvas'); return [c.width, c.height]; })(),
    gold: document.querySelector('.qv-download').classList.contains('pro-btn'),
  }));
  check('"Match-day poster", 3840 × 2160', ui.title === 'Match-day poster' && /3840\s×\s2160/.test(ui.lead), JSON.stringify(ui));
  check('three layouts and two shapes', ui.layouts.join() === 'matchday,chant,minimal' && ui.shapes.join() === 'landscape,portrait');
  check('the kit gives the club, its colours and its lettering', ui.club === 'Al Hilal' && ui.colours === 'Club kit: Al Hilal' && ui.font === 'The kit’s lettering', JSON.stringify(ui));
  check('the ground is filled in', ui.venue.length > 3, ui.venue);
  check('match day shows its five fields', ui.shown.join() === 'club,opponent,date,time,venue', ui.shown.join());
  check('the preview is the poster\'s shape', ui.canvas[0] === 1280 && ui.canvas[1] === 720, ui.canvas.join());
  check('the download is a gold Pro action, not the blue', ui.gold);
  const before = await previewSig(p);
  await p.fill('input[name="qv-opponent"]', 'Al Nassr');
  await p.fill('input[name="qv-date"]', '2026-11-08');
  await p.fill('input[name="qv-time"]', '20:30');
  check('typing redraws the preview', await waitFor(p, (b) => {
    const c = document.querySelector('.qv-preview canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4 * 97) h = (Math.imul(h, 31) + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
    return `${c.width}x${c.height}:${h}` !== b;
  }, before, 30000));
  check('…setting the words a match-day poster carries', await waitFor(p, () => ['MATCHDAY', 'AL HILAL', 'AL NASSR', 'VS'].every((w) => window.__texts.includes(w)) && window.__texts.some((x) => /SUN 8 NOV {3}·/.test(x)), null, 20000), JSON.stringify((await p.evaluate(() => window.__texts.slice(-12)))));
  await shot(p, 'qp-sheet-1440-en');

  await p.evaluate(() => { window.__marks = 0; });
  const land = await downloadFrom(p, () => p.click('.qv-download'));
  const ls = await pngSize(land.buf);
  check('the download is a 3840 × 2160 PNG, with no sheet', ls.w === 3840 && ls.h === 2160 && /-poster\.png$/.test(land.name), JSON.stringify({ ...ls, name: land.name }));
  check('…with no mark', await p.evaluate(() => window.__marks === 0));
  check('…and says what it saved', /Poster saved: 3840\s×\s2160/.test(await p.textContent('.qv-status')), await p.textContent('.qv-status'));
  if (SHOTS) writeFileSync(join(SHOTS, 'qp-poster-matchday-landscape.png'), land.buf);

  await p.click('.qv-seg-item:has(input[value="chant"])');
  check('chant shows the club, the date and the chant', await waitFor(p, () => [...document.querySelectorAll('.qv-field[data-f]')].filter((f) => !f.hidden).map((f) => f.dataset.f).join() === 'club,date,headline'));
  await p.fill('input[name="qv-headline"]', 'One heart. One voice.');
  await p.click('.qv-seg-item:has(input[value="portrait"])');
  check('portrait redraws the preview standing up', await waitFor(p, () => { const c = document.querySelector('.qv-preview canvas'); return c.dataset.shape === 'portrait' && c.width === 720 && c.height === 1280; }, null, 240000));
  check('…the chant set on it', await waitFor(p, () => window.__texts.includes('ONE HEART.') || window.__texts.includes('ONE HEART. ONE VOICE.'), null, 20000));
  await shot(p, 'qp-sheet-portrait-1440-en');
  const port = await downloadFrom(p, () => p.click('.qv-download'));
  const ps = await pngSize(port.buf);
  check('portrait downloads 2160 × 3840', ps.w === 2160 && ps.h === 3840, JSON.stringify(ps));
  if (SHOTS) writeFileSync(join(SHOTS, 'qp-poster-chant-portrait.png'), port.buf);
  const keptF = await p.evaluate(() => JSON.parse(localStorage.getItem('tifo_poster_v1') || '{}'));
  check('the fields are remembered in this browser', keptF.opponent === 'Al Nassr' && keptF.layout === 'chant' && keptF.headline === 'One heart. One voice.', JSON.stringify(keptF));
  await p.keyboard.press('Escape');
  check('Escape closes it, and its Match Day is freed', await waitFor(p, () => !document.querySelector('.qv-poster') && !document.querySelector('.qv-offscreen'), null, 60000));
  await ctx.close();
}

// =====================================================================
console.log('\n— in Arabic —');
{
  const { ctx, p } = await open(gift.token, gift.design, { lang: 'ar' });
  await animPanel(p);
  await p.evaluate(() => localStorage.setItem('tifo_poster_v1', JSON.stringify({ layout: 'matchday', opponent: 'النصر' })));
  await openPoster(p);
  const ar = await p.evaluate(() => ({
    dir: document.querySelector('.qv-poster-backdrop')?.dir,
    title: document.querySelector('#qv-p-title')?.textContent,
    layouts: [...document.querySelectorAll('.qv-seg-item span')].map((s) => s.textContent),
    dl: document.querySelector('.qv-download span')?.textContent,
  }));
  check('the sheet is right to left, in Arabic', ar.dir === 'rtl' && ar.title === 'بوستر يوم المباراة' && ar.layouts.slice(0, 3).join() === 'يوم المباراة,هتاف,بسيط' && ar.dl === 'نزّل البوستر', JSON.stringify(ar));
  check('the poster carries its Arabic words', await waitFor(p, () => window.__texts.includes('يوم المباراة') && window.__texts.includes('ضد') && window.__texts.includes('النصر'), null, 20000));
  await shot(p, 'qp-sheet-1440-ar');
  await p.keyboard.press('Escape');
  await ctx.close();

  const m = await open(gift.token, gift.design, { lang: 'ar', w: 390, h: 844, phone: true });
  await m.p.click('.m-tab[data-tab="more"]');
  await waitFor(m.p, () => !!document.querySelector('.m-tool .ti-movie'));
  await m.p.click('.m-tool:has(.ti-movie)');
  await waitFor(m.p, () => !!document.getElementById('sx-poster')?.getClientRects().length, null, 30000);
  check('on a phone, the sheet opens', await openPoster(m.p));
  const ph = await m.p.evaluate(() => {
    const hs = [...document.querySelectorAll('.qv-seg-item span, .qv-field input:not([type="hidden"]), .qv-field select, .qv-download')].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().height));
    const s = document.querySelector('.qv-poster');
    return { min: Math.min(...hs), over: document.documentElement.scrollWidth - innerWidth, sheetOver: s.scrollWidth - s.clientWidth };
  });
  check('…44px targets, and nothing sideways', ph.min >= 44 && ph.over <= 0 && ph.sheetOver <= 0, JSON.stringify(ph));
  await shot(m.p, 'qp-sheet-390-ar');
  await m.ctx.close();
}

// =====================================================================
console.log('\n— on the preview list, Pro not running —');
{
  const { ctx, p } = await open(fan.token, fan.design);
  await animPanel(p);
  await openPoster(p);
  await p.click('.qv-download');
  check('the download asks first, naming "4K poster picture"', await waitFor(p, () => [...document.querySelectorAll('.pro-sheet .pro-items li')].map((l) => l.textContent).join() === '4K poster picture', null, 30000));
  await p.evaluate(() => { window.__marks = 0; });
  const free = await downloadFrom(p, () => p.click('.pro-sheet [data-act="free"]'));
  const fs = await pngSize(free.buf);
  const scr = await p.evaluate(() => { const c = window.__tifoProExport?.preview()?.canvas; return c ? { w: c.width, h: c.height } : null; });
  check('"Export without Pro items" is today\'s picture: the screen\'s size, with the mark', !!scr && fs.w === scr.w && fs.h === scr.h && await p.evaluate(() => window.__marks === 1), JSON.stringify({ fs, scr }));
  check('…and the sheet has closed, saying so', await waitFor(p, () => !document.querySelector('.qv-poster') && /screen’s size/.test(document.getElementById('sx-status')?.textContent || ''), null, 20000));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
