/**
 * Pro exports (src/ui/proExport.ts): the stadium video's Full HD and vertical
 * 9:16 sizes, the 4K poster picture, and no mark on any export, in a real
 * browser against real servers with PRO_MODE=preview.
 *
 *   not on the list  no size choice, no poster, no mark options anywhere, and
 *                    every export carries the mark (the stadium video, the
 *                    Post it picture);
 *   on the list      the size choice (♛ Pro sizes, the crown beside a Pro
 *                    one), the gold poster button and both mark options,
 *                    crowned; Preview plays at the Pro size; exporting at a
 *                    Pro size opens the export sheet naming it, and "Export
 *                    without Pro items" gives a video the size of the screen;
 *                    the free poster is a screen-size PNG with the mark; Post
 *                    it without the mark asks first, and its free picture
 *                    still has the mark;
 *   the gift on      the crowns go quiet; a Full HD video is 1920 × 1080 and
 *                    a vertical one 1080 × 1920 (read by a <video> element);
 *                    the poster is 3840 × 2160 (2160 × 3840 vertical), decoded;
 *                    Post it without the mark asks nothing and has no mark;
 *                    a device that cannot draw a size says so and falls back;
 *   in Arabic        on a 390px phone: the words, 44px targets, nothing
 *                    scrolling sideways;
 *   PRO_MODE off     none of it.
 *
 * Self-contained: it boots its own servers (ports 8961 and 8962) on memory
 * repos. Needs a build:  npm run build && node e2e-pro-export.mjs
 * SHOTS=<dir> saves screenshots and a frame of each video there.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8961;
const PORT_OFF = 8962;
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
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pexp_fan' });
const serverOff = boot(PORT_OFF, { PRO_MODE: 'off' });
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
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
/** A verified account with one saved design, painted in three bands so the stadium has a tifo. */
const account = async (username, base = B) => {
  const [tpl] = (await api('/api/templates', null, {}, base)).json;
  const cells = new Uint8Array(tpl.seatCount);
  for (let i = 0; i < cells.length; i++) cells[i] = 1 + Math.floor((i / cells.length) * 3);
  const cellsGzB64 = gzipSync(cells).toString('base64');
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'], cellsGzB64 }) }, base);
  return { token, design: d.json?.id };
};
const fan = await account('pexp_fan');
const other = await account('pexp_other');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const editor = async (token, design, { lang = 'en', base = B, w = 1440, h = 900, phone = false } = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    acceptDownloads: true,
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_post_nudge_v1: '1', tifo_view_v1: '2d', tifo_lang_v1: lang })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
    // Every "tifomaker.org" a canvas draws: the mark burned into an export.
    window.__marks = 0;
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (text === 'tifomaker.org') window.__marks++;
      return fill.call(this, text, ...rest);
    };
  }, [token, lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${base}${lang === 'ar' ? '/ar' : ''}/app?project=${design}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!window.__tifo, null, 90000);
  await waitFor(p, () => /wall$/.test(document.getElementById('doc-title')?.value || ''), null, 30000);
  await p.waitForTimeout(600);
  return { ctx, p };
};
const shot = async (p, name, opts = {}) => { if (SHOTS) { await p.waitForTimeout(450); await p.screenshot({ path: join(SHOTS, `${name}.png`), ...opts }); } };
/** The stadium export's panel on its own. */
const panelShot = async (p, name) => { if (SHOTS) { await p.waitForTimeout(300); await p.locator('#ctx-stadium-export').screenshot({ path: join(SHOTS, `${name}.png`) }); } };
/** The Stadium view, with its building in, so a video or a poster shows the stadium. */
const stadiumReady = async (p) => {
  await p.click('#view-3d');
  await waitFor(p, () => !!window.__tifoProExport?.preview(), null, 60000);
  await p.evaluate(() => Promise.race([window.__tifoProExport.preview().ready, new Promise((r) => setTimeout(r, 20000))]));
  await p.waitForTimeout(500);
};
/** The Animation panel, with the reveal at its shortest so recordings are quick. */
const animPanel = async (p) => {
  await p.click('#rail-anim');
  await waitFor(p, () => !!document.getElementById('sx-export')?.getClientRects().length);
  await p.evaluate(() => { const s = document.getElementById('reveal-dur'); s.value = '2'; s.dispatchEvent(new Event('input', { bubbles: true })); });
};
const bytesOf = async (dl) => Buffer.concat(await (await dl.createReadStream()).toArray());
/** Click and catch the file it downloads. */
const downloadFrom = async (p, click, ms = 240000) => {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: ms }), click()]);
  return { name: dl.suggestedFilename(), buf: await bytesOf(dl) };
};

// A blank page for reading files the way a browser does.
const reader = await (await browser.newContext()).newPage();
await reader.setContent('<!doctype html><title>reader</title>');
/** A video's real size, from a <video> element. */
const videoSize = (buf) => reader.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(new Blob([bytes]));
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error(String(v.error?.message || 'error'))); setTimeout(() => rej(new Error('timeout')), 20000); });
    return { w: v.videoWidth, h: v.videoHeight };
  } catch (e) {
    return { w: 0, h: 0, err: String(e.message) };
  }
}, buf.toString('base64'));
/**
 * A PNG, decoded: its size, and for a Post it picture (1080 × 1350) how many
 * pixels of the band are the blue of "tifomaker.org" and the corner's mean.
 */
const pngInfo = (buf) => reader.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const out = { w: bmp.width, h: bmp.height, blue: -1, corner: -1, title: -1 };
  if (bmp.width === 1080 && bmp.height === 1350) {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const band = g.getImageData(0, 1080, 1080, 270).data;
    let blue = 0, title = 0;
    for (let i = 0; i < band.length; i += 4) {
      const [r, gg, b] = [band[i], band[i + 1], band[i + 2]];
      if (b > 180 && r < 150 && b - r > 70) blue++;
      if (r > 200 && gg > 200 && b > 200) title++;
    }
    const corner = g.getImageData(820, 28, 236, 44).data;
    let sum = 0;
    for (let i = 0; i < corner.length; i += 4) sum += corner[i] + corner[i + 1] + corner[i + 2];
    Object.assign(out, { blue, title, corner: Math.round(sum / (corner.length / 4) / 3) });
  }
  return out;
}, buf.toString('base64'));
/** A frame from the end of a video, for a look (ffmpeg; skipped where there is none). */
const frameShot = (buf, name) => {
  if (!SHOTS) return;
  try {
    const src = join(SHOTS, `${name}.video`);
    writeFileSync(src, buf);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-sseof', '-0.6', '-i', src, '-frames:v', '1', join(SHOTS, `${name}.png`)]);
  } catch { /* no ffmpeg: the size checks stand */ }
};
const savePng = (buf, name) => { if (SHOTS) writeFileSync(join(SHOTS, `${name}.png`), buf); };
const sheetItems = (p) => p.evaluate(() => [...document.querySelectorAll('.pro-sheet .pro-items li')].map((l) => l.textContent));
const openSheet = (p) => waitFor(p, () => !!document.querySelector('.pro-sheet [data-act="free"]'), null, 60000);
/** The stadium view's own size, in pixels: what a free export is drawn at. */
const screenSize = (p) => p.evaluate(() => { const c = window.__tifoProExport?.preview()?.canvas ?? document.querySelector('#preview-host > canvas'); return c ? { w: c.width, h: c.height } : null; });

// =====================================================================
console.log('\n— an account Pro is not on for —');
{
  const { ctx, p } = await editor(other.token, other.design);
  await animPanel(p);
  await p.waitForTimeout(1500);
  const ui = await p.evaluate(() => ({
    size: !!document.getElementById('sx-size-row'),
    poster: !!document.getElementById('sx-poster'),
    mark: !document.querySelector('#sx-nomark')?.closest('label')?.hidden,
    crowns: [...document.querySelectorAll('.pro-crown')].filter((c) => c.getClientRects().length > 0).length,
  }));
  check('no size choice, no poster, no mark option, no crowns', !ui.size && !ui.poster && !ui.mark && ui.crowns === 0, JSON.stringify(ui));
  await p.evaluate(() => { window.__marks = 0; });
  const v = await downloadFrom(p, () => p.click('#sx-export'));
  const screen = await screenSize(p);
  const vs = await videoSize(v.buf);
  check('its stadium video is the screen\'s size, with no sheet on the way', !!screen && vs.w > 0 && Math.abs(vs.w - screen.w) <= 2 && Math.abs(vs.h - screen.h) <= 2, JSON.stringify({ vs, screen }));
  check('…and carries the mark', await p.evaluate(() => window.__marks > 0));
  await p.click('#post-tifo');
  check('Post it: the picture, and no mark option', await waitFor(p, () => !!document.querySelector('.pm-pic'), null, 60000) && await p.evaluate(() => !document.querySelector('.pexp-post-mark')));
  const pic = await downloadFrom(p, () => p.click('.pm-row .pm-b:has(.ti-download)'));
  const pi = await pngInfo(pic.buf);
  check('…and its picture has the mark', pi.w === 1080 && pi.h === 1350 && pi.blue > 200, JSON.stringify(pi));
  await p.click('.pm-x');
  const gif = await downloadFrom(p, () => p.click('#reveal-gif'), 60000);
  check('the flat reveal GIF exports as it always did, with no sheet', gif.buf.slice(0, 3).toString() === 'GIF' && await p.evaluate(() => !document.querySelector('.pro-sheet-backdrop')), `${gif.buf.length} bytes`);
  await ctx.close();
}

// =====================================================================
console.log('\n— an account on the preview list, Pro not running —');
let screenFree = null;
/** The free Post it picture (with the mark), to compare the clean one with. */
let freePost = null;
{
  const { ctx, p } = await editor(fan.token, fan.design);
  await animPanel(p);
  check('the size choice is there, beside Format', await waitFor(p, () => !document.getElementById('sx-size-row')?.hidden));
  const ui = await p.evaluate(() => {
    const sel = document.getElementById('sx-size');
    return {
      label: document.querySelector('label[for="sx-size"]')?.textContent,
      options: [...sel.options].map((o) => [o.value, o.textContent]),
      group: sel.querySelector('optgroup')?.label,
      crown: !!document.querySelector('#sx-size-row .pro-chip'),
      poster: (() => { const b = document.getElementById('sx-poster'); return b && !b.hidden && b.classList.contains('pro-btn') && !!b.querySelector('.pro-crown') ? b.textContent : null; })(),
      mark: (() => { const l = document.getElementById('sx-nomark')?.closest('label'); return !!l && !l.hidden && !!l.querySelector('.pro-chip:not(.quiet)'); })(),
    };
  });
  check('…"Size": your screen, then ♛ Pro sizes Full HD and vertical 9:16', ui.label === 'Size' && JSON.stringify(ui.options) === JSON.stringify([['screen', 'Your screen'], ['hd', 'Full HD'], ['vertical', 'Vertical 9:16']]) && ui.group === '♛ Pro sizes', JSON.stringify(ui));
  check('…no crown while the screen\'s size is picked', !ui.crown);
  check('the poster: a gold button with the crown', ui.poster === 'Poster picture (4K)', String(ui.poster));
  check('the stadium\'s mark option, crowned', ui.mark);
  await p.selectOption('#sx-size', 'hd');
  check('picking Full HD crowns it, and says what it is for and how big', await waitFor(p, () => !!document.querySelector('#sx-size-row .pro-chip:not(.quiet)') && /big screen.*\(1920\s×\s1080\)/.test(document.getElementById('sx-size-note')?.textContent || '')));
  check('…and says it is free to try', /free to try/.test(await p.textContent('#message')));
  await panelShot(p, 'pexp-panel-1440-en');

  // Preview plays at the Pro size (free to try).
  await p.click('#sx-preview');
  check('Preview plays at Full HD', await waitFor(p, () => { const c = document.querySelector('.sx-canvas'); return !!c && c.width === 1920 && c.height === 1080; }, null, 60000));
  await p.waitForTimeout(3200);
  await shot(p, 'pexp-preview-hd-1440');
  await p.click('.sx-close');
  await waitFor(p, () => !document.querySelector('.sx-backdrop'));
  screenFree = await screenSize(p);
  check('…and the view is its own size again after', !!screenFree && screenFree.w !== 1920 && await p.evaluate(() => !window.__tifoProExport.preview().canvas.dataset.exportSize), JSON.stringify(screenFree));

  // Export at Full HD: the sheet names it; the free way is the screen's size.
  await p.click('#sx-export');
  check('exporting at Full HD opens the export sheet', await openSheet(p));
  const items = await sheetItems(p);
  check('…naming "Full HD video"', JSON.stringify(items) === JSON.stringify(['Full HD video']), JSON.stringify(items));
  await shot(p, 'pexp-sheet-1440-en');
  await p.evaluate(() => { window.__marks = 0; });
  const v = await downloadFrom(p, () => p.click('.pro-sheet [data-act="free"]'));
  const vs = await videoSize(v.buf);
  const scr = await screenSize(p);
  check('"Export without Pro items" gives a video the screen\'s size', vs.w > 0 && Math.abs(vs.w - scr.w) <= 2 && Math.abs(vs.h - scr.h) <= 2 && vs.w !== 1920, JSON.stringify({ vs, scr }));
  check('…with the mark', await p.evaluate(() => window.__marks > 0));
  frameShot(v.buf, 'pexp-frame-free-screen');

  // The mark option and the size, asked about together.
  await p.check('#sx-nomark');
  await p.click('#sx-export');
  await openSheet(p);
  const both = await sheetItems(p);
  check('the mark and the size are one question', JSON.stringify(both) === JSON.stringify(['Without the tifomaker.org mark', 'Full HD video']), JSON.stringify(both));
  await p.keyboard.press('Escape');
  check('closing the sheet exports nothing', await waitFor(p, () => !document.querySelector('.pro-sheet-backdrop')));
  await p.uncheck('#sx-nomark');

  // The poster, free: the sheet, then a screen-size PNG with the mark.
  await p.click('#sx-poster');
  await openSheet(p);
  const pItems = await sheetItems(p);
  check('the poster asks first, naming "4K poster picture"', JSON.stringify(pItems) === JSON.stringify(['4K poster picture']), JSON.stringify(pItems));
  await p.evaluate(() => { window.__marks = 0; });
  const fp = await downloadFrom(p, () => p.click('.pro-sheet [data-act="free"]'));
  const fpi = await pngInfo(fp.buf);
  const scr2 = await screenSize(p);
  check('…and the free one is a screen-size PNG with the mark', fpi.w === scr2.w && fpi.h === scr2.h && await p.evaluate(() => window.__marks === 1), JSON.stringify({ fpi, scr2 }));
  check('…and says so', /screen’s size/.test(await p.textContent('#sx-status')));
  savePng(fp.buf, 'pexp-poster-free');

  // Post it without the mark: free to try, the sheet at the picture's way out.
  await p.click('#post-tifo');
  check('Post it shows the mark option under the picture, crowned', await waitFor(p, () => !!document.querySelector('.pm-card .pexp-post-mark .pro-chip:not(.quiet)'), null, 60000));
  const before = await p.getAttribute('.pm-pic', 'src');
  await p.check('.pexp-post-mark input');
  check('ticking it redraws the picture (free to try)', await waitFor(p, (b) => document.querySelector('.pm-pic')?.getAttribute('src') !== b, before));
  await shot(p, 'pexp-post-1440-en');
  await p.click('.pm-row .pm-b:has(.ti-download)');
  check('Download opens the export sheet over Post it', await openSheet(p) && await p.evaluate(() => { const s = document.querySelector('.pro-sheet'); const r = s.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + 20)?.closest('.pro-sheet') === s; }));
  const postItems = await sheetItems(p);
  check('…naming the mark', JSON.stringify(postItems) === JSON.stringify(['Without the tifomaker.org mark']), JSON.stringify(postItems));
  await shot(p, 'pexp-post-sheet-1440-en');
  const free = await downloadFrom(p, () => p.click('.pro-sheet [data-act="free"]'));
  const freeInfo = await pngInfo(free.buf);
  check('the free picture still has the mark', freeInfo.w === 1080 && freeInfo.blue > 200, JSON.stringify(freeInfo));
  check('…and the option is unticked to match', await p.evaluate(() => !document.querySelector('.pexp-post-mark input').checked));
  savePng(free.buf, 'pexp-post-free');
  freePost = freeInfo;
  await p.click('.pm-x');
  await ctx.close();
}

// =====================================================================
console.log('\n— the gift accepted: Pro running —');
{
  const g = await api('/api/pro/gift/accept', fan.token, { method: 'POST', body: '{}' });
  check('the gift starts', g.status === 200, String(g.status));
  const { ctx, p } = await editor(fan.token, fan.design);
  await animPanel(p);
  await waitFor(p, () => !document.getElementById('sx-size-row')?.hidden);
  await stadiumReady(p);
  await p.selectOption('#sx-size', 'hd');
  check('the crowns go quiet', await waitFor(p, () => !!document.querySelector('#sx-size-row .pro-chip.quiet') && document.getElementById('sx-poster').classList.contains('quiet')));

  const hd = await downloadFrom(p, () => p.click('#sx-export'));
  const hs = await videoSize(hd.buf);
  check('a Full HD export asks nothing and is 1920 × 1080', hs.w === 1920 && hs.h === 1080, JSON.stringify(hs));
  frameShot(hd.buf, 'pexp-frame-hd');
  const back = await screenSize(p);
  check('…and the view is put back after', !!back && back.w === screenFree?.w && back.h === screenFree?.h, JSON.stringify({ back, screenFree }));

  await p.selectOption('#sx-size', 'vertical');
  check('vertical says who it is for', await waitFor(p, () => /TikTok, Reels, Snapchat and WhatsApp Status/.test(document.getElementById('sx-size-note')?.textContent || '')));
  const vt = await downloadFrom(p, () => p.click('#sx-export'));
  const vts = await videoSize(vt.buf);
  check('a vertical export is 1080 × 1920', vts.w === 1080 && vts.h === 1920, JSON.stringify(vts));
  frameShot(vt.buf, 'pexp-frame-vertical');
  try {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: vt.buf, encoding: 'utf8' }).trim();
    check('…and ffprobe agrees', probe === '1080,1920', probe);
  } catch { /* no ffprobe here: the <video> check stands */ }

  // The poster: 2160 × 3840 with the vertical size, 3840 × 2160 otherwise.
  check('the poster follows the vertical size', /2160\s×\s3840/.test(await p.getAttribute('#sx-poster', 'title')));
  const pv = await downloadFrom(p, () => p.click('#sx-poster'));
  const pvi = await pngInfo(pv.buf);
  check('…and is a 2160 × 3840 PNG', pvi.w === 2160 && pvi.h === 3840, JSON.stringify(pvi));
  savePng(pv.buf, 'pexp-poster-vertical');
  await p.selectOption('#sx-size', 'hd');
  await p.check('#sx-nomark');
  await p.evaluate(() => { window.__marks = 0; });
  const ph = await downloadFrom(p, () => p.click('#sx-poster'));
  const phi = await pngInfo(ph.buf);
  check('the 4K poster is 3840 × 2160, with no sheet', phi.w === 3840 && phi.h === 2160, JSON.stringify(phi));
  check('…and without the mark when it is ticked', await p.evaluate(() => window.__marks === 0));
  check('…and says what it saved', /Poster saved: 3840\s×\s2160/.test(await p.textContent('#sx-status')));
  savePng(ph.buf, 'pexp-poster-4k');
  await p.uncheck('#sx-nomark');

  // A device that cannot draw it: said, and the screen's size instead.
  await p.evaluate(() => { const pv = window.__tifoProExport.preview(); pv.canDraw = () => false; pv.maxDrawSize = () => 1024; });
  const fb = await p.evaluate(() => ({ size: window.__tifoProExport.size(), items: window.__tifoProExport.items() }));
  check('a device that cannot draw Full HD falls back to the screen\'s size, and asks nothing', fb.size === null && fb.items.length === 0, JSON.stringify(fb));
  check('…and says so under the picker', /up to 1024\spx/.test(await p.textContent('#sx-size-note')));
  await p.evaluate(() => { const pv = window.__tifoProExport.preview(); delete pv.canDraw; delete pv.maxDrawSize; });

  // Post it without the mark, Pro running: no sheet, and no mark.
  await p.click('#post-tifo');
  await waitFor(p, () => !!document.querySelector('.pm-card .pexp-post-mark .pro-chip.quiet'), null, 60000);
  await p.check('.pexp-post-mark input');
  await p.waitForTimeout(600);
  const clean = await downloadFrom(p, () => p.click('.pm-row .pm-b:has(.ti-download)'));
  const sheetShown = await p.evaluate(() => !!document.querySelector('.pro-sheet-backdrop'));
  const ci = await pngInfo(clean.buf);
  const fi = freePost;
  check('Post it without the mark asks nothing', !sheetShown);
  check('…and its picture has no mark: not in the band, not in the corner', ci.w === 1080 && ci.blue === 0 && ci.title > 200 && fi && Math.abs(ci.corner - fi.corner) > 6, JSON.stringify({ ci, fi }));
  savePng(clean.buf, 'pexp-post-clean');
  await ctx.close();
}

// =====================================================================
console.log('\n— in Arabic, on a 390px phone —');
{
  const { ctx, p } = await editor(fan.token, fan.design, { lang: 'ar', w: 390, h: 844, phone: true });
  await p.click('.m-tab[data-tab="more"]');
  await waitFor(p, () => !!document.querySelector('.m-tool .ti-movie'));
  await p.click('.m-tool:has(.ti-movie)');
  check('the size choice and the poster are in the Animation sheet', await waitFor(p, () => !!document.getElementById('sx-size-row')?.getClientRects().length && !!document.getElementById('sx-poster')?.getClientRects().length));
  await p.selectOption('#sx-size', 'vertical');
  await p.evaluate(() => document.getElementById('sx-poster').scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(400);
  const ar = await p.evaluate(() => {
    const h = (el) => Math.round(el.getBoundingClientRect().height);
    return {
      label: document.querySelector('label[for="sx-size"]').textContent,
      opts: [...document.getElementById('sx-size').options].map((o) => o.textContent),
      group: document.querySelector('#sx-size optgroup').label,
      note: document.getElementById('sx-size-note').textContent,
      poster: document.getElementById('sx-poster').textContent,
      chip: document.querySelector('#sx-size-row .pro-chip')?.getAttribute('aria-label'),
      select: h(document.getElementById('sx-size')),
      posterH: h(document.getElementById('sx-poster')),
      over: document.documentElement.scrollWidth - innerWidth,
    };
  });
  check('…in Arabic', ar.label === 'المقاس' && ar.opts[0] === 'مقاس شاشتك' && ar.group === '♛ مقاسات مميّزة' && /تيك توك/.test(ar.note) && /صورة بوستر/.test(ar.poster) && ar.chip === 'مميّز', JSON.stringify(ar));
  check('…with 44px targets', ar.select >= 44 && ar.posterH >= 44, JSON.stringify({ select: ar.select, poster: ar.posterH }));
  check('…and nothing scrolling sideways', ar.over <= 0, String(ar.over));
  await shot(p, 'pexp-panel-390-ar');
  await ctx.close();

  const d = await editor(fan.token, fan.design, { lang: 'ar' });
  await animPanel(d.p);
  await waitFor(d.p, () => !document.getElementById('sx-size-row')?.hidden);
  await d.p.selectOption('#sx-size', 'hd');
  await d.p.waitForTimeout(300);
  // The whole window: an element shot of a right-to-left panel comes out shifted.
  await shot(d.p, 'pexp-editor-1440-ar');
  await d.p.waitForTimeout(300);
  await d.p.click('#post-tifo');
  check('Post it in Arabic: the option\'s words', await waitFor(d.p, () => document.querySelector('.pexp-post-mark span')?.textContent === 'بدون علامة tifomaker.org', null, 60000));
  await shot(d.p, 'pexp-post-1440-ar');
  await d.ctx.close();

  const m = await editor(fan.token, fan.design, { lang: 'en', w: 390, h: 844, phone: true });
  // The phone's Post it: the option a whole 44px row (once Pro's tools are in).
  await waitFor(m.p, () => !!window.__tifoProExport);
  await m.p.waitForTimeout(500);
  await m.p.evaluate(() => document.getElementById('post-tifo')?.click());
  check('Post it on a phone: the option is a 44px target', await waitFor(m.p, () => (document.querySelector('.pexp-post-mark')?.getBoundingClientRect().height || 0) >= 44, null, 60000));
  const pover = await m.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('…and nothing scrolls sideways', pover <= 0, String(pover));
  await shot(m.p, 'pexp-post-390-en');
  await m.ctx.close();
}

// =====================================================================
console.log('\n— PRO_MODE off —');
{
  const u = await account('pexp_fan', OFF);
  const { ctx, p } = await editor(u.token, u.design, { base: OFF });
  await animPanel(p);
  await p.waitForTimeout(1500);
  const ui = await p.evaluate(() => ({ size: !!document.getElementById('sx-size-row'), poster: !!document.getElementById('sx-poster'), mark: !document.querySelector('#sx-nomark')?.closest('label')?.hidden }));
  check('no size choice, no poster, no mark option, even for a name on the list', !ui.size && !ui.poster && !ui.mark, JSON.stringify(ui));
  await p.click('#post-tifo');
  check('…and Post it has no mark option', await waitFor(p, () => !!document.querySelector('.pm-pic'), null, 60000) && await p.evaluate(() => !document.querySelector('.pexp-post-mark')));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
