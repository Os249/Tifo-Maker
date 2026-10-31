/**
 * Portrait styles (Pro, src/ui/proStyles.ts and src/core/portraitStyles.ts) in
 * a real browser against real servers:
 *
 *   not on the list   no Style picker anywhere, and no Pro words or code for it;
 *   on the list       the picker in the picture import bar, crowned (the gold
 *                     chip; quiet once Pro is running); placing a picture with
 *                     Stencil gives the layer that style and other seats than
 *                     Original, without growing the palette; the same picker
 *                     in the layer's properties, where a change is one undo
 *                     step; the style survives Save and opening the project
 *                     again; an export names "Portrait style" on the export
 *                     sheet and can go without it (the seats come back after);
 *                     the words in Arabic;
 *   PRO_MODE off      no picker, and a picture that already has a style is
 *                     still drawn with it (it is the design's, not Pro's).
 *
 * Self-contained: it boots its own servers (ports 8943 and 8944) on memory
 * repos. Needs a build:  npm run build && node e2e-pro-styles.mjs
 */
import { spawn } from 'node:child_process';
import { deflateSync, gunzipSync, gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8943;
const PORT_OFF = 8944;
const B = `http://127.0.0.1:${PORT}`;
const OFF = `http://127.0.0.1:${PORT_OFF}`;
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
const server = boot(PORT, { PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'pstyle_fan' });
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
/** A verified account with one saved design. */
const account = async (username, base = B) => {
  const [tpl] = (await api('/api/templates', null, {}, base)).json;
  const cellsGzB64 = gzipSync(new Uint8Array(tpl.seatCount)).toString('base64');
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) }, base);
  const token = r.json?.token;
  const code = await codeFor(email);
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) }, base);
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: `${username} wall`, templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#c8242c', '#f2f1ec', '#16161a', '#7c1218'], cellsGzB64 }) }, base);
  return { token, design: d.json?.id };
};

// ---------------------------------------------------- a face, as a PNG ---
/** A head-and-shoulders portrait drawn in Node and written as a PNG (no image library needed). */
function facePng(w = 240, h = 240) {
  const px = Buffer.alloc(w * h * 4);
  const set = (x, y, c) => { const p = (y * w + x) * 4; px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255; };
  const ell = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = [206 - y * 0.2, 210 - y * 0.2, 214 - y * 0.2];
      if (y > h * 0.84) c = [36, 40, 54];
      if (ell(x, y, w / 2, h * 0.42, w * 0.3, h * 0.3) && y < h * 0.36) c = [60, 42, 30];
      if (ell(x, y, w / 2, h * 0.52, w * 0.25, h * 0.31) && y >= h * 0.36) { const k = 160 + (w / 2 - x) * 0.5; c = [k + 30, k + 5, k - 20]; }
      for (const s of [-1, 1]) {
        if (ell(x, y, w / 2 + s * w * 0.09, h * 0.47, w * 0.045, h * 0.022)) c = [48, 36, 30];
        if (ell(x, y, w / 2 + s * w * 0.09, h * 0.41, w * 0.06, h * 0.014)) c = [66, 50, 38];
      }
      if (ell(x, y, w / 2 + w * 0.015, h * 0.58, w * 0.018, h * 0.03)) c = [120, 86, 64];
      if (ell(x, y, w / 2, h * 0.67, w * 0.08, h * 0.018)) c = [100, 40, 44];
      set(x, y, c.map((v) => Math.max(0, Math.min(255, Math.round(v)))));
    }
  }
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const FACE = facePng();

const fan = await account('pstyle_fan');
const other = await account('pstyle_other');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const editor = async (token, design, { lang = 'en', base = B, w = 1440, h = 900 } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([tok, lang]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_banner_tour_v1: '1', tifo_view_v1: '2d', tifo_lang_v1: lang })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (tok) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  await p.goto(`${base}${lang === 'ar' ? '/ar' : ''}/app?project=${design}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!window.__tifo, null, 90000);
  // The project arrives after the editor: let it settle before arming a picture.
  await waitFor(p, () => /wall$/.test(document.getElementById('doc-title')?.value || ''), null, 30000);
  await p.waitForTimeout(800);
  return { ctx, p };
};
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const visible = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, sel);
/** The seats, as one short fingerprint. */
const seats = (p) => p.evaluate(() => { const c = window.__tifo.store.cells; let h = 2166136261; for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c[i], 16777619); return (h >>> 0).toString(16); });
const arm = async (p) => {
  for (let i = 0; i < 3; i++) {
    await p.setInputFiles('#import-file', { name: 'captain.png', mimeType: 'image/png', buffer: FACE });
    if (await waitFor(p, () => !document.getElementById('import-bar').hidden && !document.getElementById('import-apply').disabled, null, 10000)) return true;
  }
  return false;
};
const place = async (p) => {
  const n = await p.evaluate(() => window.__tifo.objects.list().length);
  await p.click('#import-apply');
  await waitFor(p, (n0) => window.__tifo.objects.list().length > n0, n);
  await p.waitForTimeout(300);
  return p.evaluate(() => { const o = window.__tifo.objects.selected; return o ? { id: o.id, kind: o.kind, style: o.style ?? null } : null; });
};

// =====================================================================
console.log('\n— an account Pro is not on for —');
{
  const { ctx, p } = await editor(other.token, other.design);
  await arm(p);
  await p.waitForTimeout(1200);
  const seen = await p.evaluate(() => ({
    picker: !!document.getElementById('import-pstyle'),
    layer: !!document.getElementById('obj-pstyle'),
    hook: '__tifoProStyles' in window,
    crowns: [...document.querySelectorAll('.pro-crown')].filter((c) => c.getClientRects().length > 0).length,
    proStyles: performance.getEntriesByType('resource').some((e) => /proStyles-/.test(e.name)),
  }));
  check('no Style picker, no crown, and the module never loads', !seen.picker && !seen.layer && !seen.hook && seen.crowns === 0 && !seen.proStyles, JSON.stringify(seen));
  const placed = await place(p);
  check('…and a picture placed here has no style', placed?.kind === 'image' && placed.style === null, JSON.stringify(placed));
  await ctx.close();
}

// =====================================================================
console.log('\n— an account on the preview list —');
let styledSeats = '';
{
  const { ctx, p } = await editor(fan.token, fan.design);
  await arm(p);
  check('the import bar has the Style picker', await waitFor(p, () => { const s = document.getElementById('import-pstyle'); return !!s && s.getClientRects().length > 0; }));
  const bar = await p.evaluate(() => {
    const s = document.getElementById('import-pstyle');
    const field = s.closest('.pstyle-field');
    return {
      label: document.querySelector('label[for="import-pstyle"]')?.textContent,
      options: [...s.options].map((o) => [o.value, o.textContent]),
      chip: field?.querySelector('.pro-chip')?.textContent ?? null,
      quiet: !!field?.querySelector('.pro-chip.quiet'),
      crown: !!field?.querySelector('.pro-chip .pro-crown'),
      blue: [...field.querySelectorAll('button.primary, .pro-primary')].length,
      afterDither: !!document.getElementById('dither')?.closest('.tb-field')?.nextElementSibling?.classList.contains('pstyle-field'),
    };
  });
  check('…labelled "Style", with Original and the five styles', bar.label === 'Style' && JSON.stringify(bar.options) === JSON.stringify([['', 'Original'], ['stencil', 'Stencil'], ['halftone', 'Halftone'], ['pop', 'Pop art'], ['poster2', 'Posterize 2 colours'], ['poster3', 'Posterize 3 colours']]), JSON.stringify(bar.options));
  check('…crowned beside it (gold "Pro", not quiet: Pro is not running), and no blue of its own', bar.chip === 'Pro' && bar.crown && !bar.quiet && bar.blue === 0, JSON.stringify(bar));
  check('…sitting beside Real colours and Dither', bar.afterDither);

  // Original first, for the seats to compare with.
  const original = await place(p);
  check('placing with Original: a picture without a style', original?.style === null, JSON.stringify(original));
  const originalSeats = await seats(p);
  await p.evaluate((id) => window.__tifo.objects.remove(id), original.id);
  const paletteBefore = await p.evaluate(() => window.__tifo.store.palette.length);

  await arm(p);
  await p.selectOption('#import-pstyle', 'stencil');
  const greyed = await p.evaluate(() => {
    const r = document.getElementById('real-colors');
    const d = document.getElementById('dither');
    return { real: [r.checked, r.disabled], dither: [d.checked, d.disabled], data: document.getElementById('import-bar').dataset.proStyle };
  });
  check('picking Stencil greys out Real colours and Dither (a style draws in the design\'s colours)', !greyed.real[0] && greyed.real[1] && !greyed.dither[0] && greyed.dither[1] && greyed.data === 'stencil', JSON.stringify(greyed));
  const stencil = await place(p);
  check('placing with Stencil gives the layer that style', stencil?.style === 'stencil', JSON.stringify(stencil));
  styledSeats = await seats(p);
  check('…and other seats than Original', styledSeats !== originalSeats, `${originalSeats} / ${styledSeats}`);
  const used = await p.evaluate((id) => { const g = window.__tifo.objects.get(id).grid.data; return [...new Set(g)].filter((v) => v >= 0).sort(); }, stencil.id);
  check('…in two of the design\'s cards, and the palette did not grow', used.length === 2 && (await p.evaluate(() => window.__tifo.store.palette.length)) === paletteBefore, JSON.stringify(used));
  // The next picture: back to Original in the bar.
  await arm(p);
  await p.selectOption('#import-pstyle', '');
  const back = await p.evaluate(() => { const r = document.getElementById('real-colors'); return [r.checked, r.disabled, 'proStyle' in document.getElementById('import-bar').dataset]; });
  check('Original gives Real colours back as it was', back[0] === true && back[1] === false && back[2] === false, JSON.stringify(back));
  await p.click('#import-cancel');
  await p.click('[data-tool="select"]');
  await p.evaluate((id) => window.__tifo.objects.select(id), stencil.id);

  // The layer's properties.
  check('the selected picture\'s properties show its style, crowned', await waitFor(p, () => {
    const s = document.getElementById('obj-pstyle');
    return !!s && s.getClientRects().length > 0 && s.value === 'stencil' && !!s.closest('.pstyle-row')?.querySelector('.pro-chip .pro-crown');
  }));
  check('…and Dither is greyed for a styled picture', await p.evaluate(() => document.getElementById('obj-dither').disabled));
  await p.selectOption('#obj-pstyle', 'pop');
  const popSeats = await seats(p);
  const now = await p.evaluate((id) => window.__tifo.objects.get(id).style, stencil.id);
  check('changing it to Pop art re-draws the seats', now === 'pop' && popSeats !== styledSeats, now);
  check('…and says so', /Pop art/.test(await p.textContent('#message')), await p.textContent('#message'));
  await p.click('#undo');
  const undone = await p.evaluate((id) => ({ style: window.__tifo.objects.get(id)?.style ?? null, value: document.getElementById('obj-pstyle').value }), stencil.id);
  check('one undo puts Stencil back, seats and picker too', undone.style === 'stencil' && undone.value === 'stencil' && (await seats(p)) === styledSeats, JSON.stringify(undone));
  await p.click('#redo');
  check('…and redo brings Pop art again', (await p.evaluate((id) => window.__tifo.objects.get(id).style, stencil.id)) === 'pop' && (await seats(p)) === popSeats);
  styledSeats = popSeats;

  // Export: the sheet names the item; without it, the seats are the picture's, and they come back.
  const items = await p.evaluate(() => window.__tifoProStyles.items());
  check('the design\'s Pro items name "Portrait style"', JSON.stringify(items) === JSON.stringify(['Portrait style']), JSON.stringify(items));
  const gate = p.evaluate(() => window.__tifoProStyles.gate());
  check('an export asks first: the sheet names "Portrait style"', await waitFor(p, () => [...document.querySelectorAll('.pro-sheet .pro-items li')].some((l) => l.textContent === 'Portrait style')));
  await p.click('.pro-sheet [data-act="free"]');
  check('…and "Export without Pro items" goes on without it', (await gate) === 'free');
  const lifted = await p.evaluate(() => window.__tifoProStyles.lifted());
  check('…the export sees the plain picture, and the style is back after', lifted.during !== popSeats && lifted.after === popSeats && (await p.evaluate((id) => window.__tifo.objects.get(id).style, stencil.id)) === 'pop', JSON.stringify(lifted));
  await p.click('#undo');
  check('…without an undo step of its own (undo still takes Pop art back)', (await p.evaluate((id) => window.__tifo.objects.get(id)?.style ?? null, stencil.id)) === 'stencil');
  await p.click('#redo');
  await waitFor(p, (id) => window.__tifo.objects.get(id)?.style === 'pop', stencil.id);

  // Save, and open it again somewhere else.
  await p.click('#save-top');
  await p.waitForFunction(() => { const b = document.getElementById('save-top'); return !!b && !b.disabled; }, null, { timeout: 60000 }).catch(() => {});
  await p.waitForFunction(() => /Saved to your account|Saved in your account/i.test(document.getElementById('save-state-top')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1500);
  await ctx.close();
  const scene = await api(`/api/designs/${fan.design}/scene`, fan.token);
  const doc = scene.json?.sceneGzB64 ? JSON.parse(gunzipSync(Buffer.from(scene.json.sceneGzB64, 'base64')).toString('utf8')) : null;
  const savedPic = doc?.layers?.objects?.find((o) => o.kind === 'image');
  check('Save puts the style in the account with the layer', savedPic?.style === 'pop', JSON.stringify(savedPic && { style: savedPic.style, gridKey: savedPic.gridKey }));
  const two = await editor(fan.token, fan.design);
  await waitFor(two.p, () => (window.__tifo?.objects?.list().length ?? 0) >= 1, null, 20000);
  await two.p.waitForTimeout(1500);
  const reopened = await two.p.evaluate(() => { const o = window.__tifo.objects.list().find((x) => x.kind === 'image'); return { style: o?.style ?? null }; });
  check('opened again, the picture still has its style', reopened.style === 'pop', JSON.stringify(reopened));
  check('…and exactly its seats', (await seats(two.p)) === popSeats);
  await two.ctx.close();
}
{
  // Arabic, and a phone.
  const { ctx, p } = await editor(fan.token, fan.design, { lang: 'ar' });
  await arm(p);
  check('in Arabic: "الستايل", "ستنسل" and "بوستر بلونين", and the chip says مميّز', await waitFor(p, () => {
    const s = document.getElementById('import-pstyle');
    return !!s && document.querySelector('label[for="import-pstyle"]')?.textContent === 'الستايل' &&
      s.options[1].textContent === 'ستنسل' && s.options[4].textContent === 'بوستر بلونين' &&
      /مميّز/.test(s.closest('.pstyle-field')?.querySelector('.pro-chip')?.textContent || '');
  }));
  const label = await p.evaluate(() => window.__tifoProStyles.items());
  check('…and the export sheet\'s name for it is Arabic too', JSON.stringify(label) === JSON.stringify(['ستايل البورتريه']), JSON.stringify(label));
  await ctx.close();
}
{
  const { ctx, p } = await editor(fan.token, fan.design, { w: 390, h: 844 });
  await p.setInputFiles('#import-file', { name: 'captain.png', mimeType: 'image/png', buffer: FACE });
  check('on a phone, the picker is in the import sheet, 44px tall', await waitFor(p, () => {
    const s = document.getElementById('import-pstyle');
    return !!s && s.getClientRects().length > 0 && s.getBoundingClientRect().height >= 44;
  }));
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('…with nothing scrolling sideways', over <= 0, String(over));
  await ctx.close();
}
{
  // Pro running (the gift): the crown stays, quietly.
  const g = await api('/api/pro/gift/accept', fan.token, { method: 'POST', body: '{}' });
  check('(the gift starts)', g.status === 200, String(g.status));
  const { ctx, p } = await editor(fan.token, fan.design);
  await arm(p);
  check('with Pro running the crown is quiet', await waitFor(p, () => !!document.querySelector('.pstyle-field .pro-chip.quiet')));
  check('…and an export does not ask', (await p.evaluate(() => window.__tifoProStyles.gate())) === 'pro');
  await ctx.close();
}

// =====================================================================
console.log('\n— PRO_MODE off —');
{
  const u = await account('pstyle_fan', OFF);
  const { ctx, p } = await editor(u.token, u.design, { base: OFF });
  await arm(p);
  await p.waitForTimeout(1200);
  check('no picker, even for a name that would be on the list', !(await p.evaluate(() => !!document.getElementById('import-pstyle'))));
  await p.click('#import-cancel');
  // A picture that already carries a style (made where Pro was on) is drawn with it.
  const drawn = await p.evaluate(async (bytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const { objects, store } = window.__tifo;
    const sum = () => { let h = 2166136261; for (const v of store.cells) h = Math.imul(h ^ v, 16777619); return (h >>> 0).toString(16); };
    const add = (style) => objects.addImage({ cx: 2000, cy: 300, width: 384, height: 384, colorIndex: 0, tier: null, bitmap: bmp, name: 'captain.png', dither: false, alphaThreshold: 128, ...(style ? { style } : {}) });
    const a = add(null);
    const plain = sum();
    objects.remove(a.id);
    const b = add('stencil');
    const styled = sum();
    return { plain, styled, cards: [...new Set(b.grid.data)].filter((v) => v >= 0).length };
  }, [...FACE]);
  check('a styled picture is still drawn in its style with Pro off', drawn.plain !== drawn.styled && drawn.cards === 2, JSON.stringify(drawn));
  await ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
