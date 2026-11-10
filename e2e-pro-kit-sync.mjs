/**
 * Club kits on the account, the kit everywhere, the credit line and the
 * supporter badge (Pro), in real browsers against a real server:
 *
 *   two devices      a kit saved in one browser is in a second browser signed
 *                    in to the same account: its colours, its logo (drawn from
 *                    what the server kept) and its font, "On your account";
 *   this browser's   a kit made while the account had no kits on it (the
 *                    server says 404) is kept in this browser, and moves up to
 *                    the account at the next load, once, and is then gone here;
 *   offline          with the kit routes unreachable the sheet shows the kits
 *                    as this device last had them, says so, and a kit saved or
 *                    deleted then goes up when the server answers again; the
 *                    other device sees it;
 *   the AI designer  the kit in use goes with every design, as
 *                    { name, colours, font }, and the AI panel says "Using kit";
 *                    stopping it stops it;
 *   banners          "Dress this banner": the cloth, the letters, the font and
 *                    the crest, as one undo step; a sign keeps its words alone;
 *   Post it          the picture's band in the kit's colours, its crest, and the
 *                    credit line in the picture's corner;
 *   the credit line  typed once, on the account (the other device has it), and
 *                    in the corner of the stadium preview, the GIF, the video,
 *                    the 4K poster, Post it and the Match Day snapshot; an Arabic
 *                    credit sits bottom right; the free version goes without it;
 *   the badge        "Pro supporter" with the crown beside a supporter's name on
 *                    their tifo card, their public tifo page, their profile
 *                    header and their account page; in Arabic; light and dark; at
 *                    390px; never for a gift, nor for viewers outside the preview.
 *
 * Self-contained: it boots its own server (port 8977) on memory repos. Needs a
 * build:  npm run build && node e2e-pro-kit-sync.mjs
 * SHOTS=<dir> also saves screenshots and the exported pictures it checks.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8977;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'kit-sync-admin-password-1';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '',
    AI_CLOUDFLARE_ACCOUNT_ID: '', AI_CLOUDFLARE_API_TOKEN: '', AI_ADMIN_PASSWORD: PW, ADMIN_USERNAMES: '',
    PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'sync_fan,sync_sup,sync_viewer,sync_ar',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 120; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) break;
  if (i === 119) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}

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
/** A saved design, painted in bands of its palette's colours so the stadium has a tifo. */
const design = async (token, title, palette) => {
  const cells = new Uint8Array(tpl.seatCount);
  for (let i = 0; i < cells.length; i++) cells[i] = 1 + Math.floor((i / cells.length) * (palette.length - 1));
  const d = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title, templateId: tpl.id, templateVersion: tpl.version, palette, cellsGzB64: gzipSync(cells).toString('base64') }) });
  return d.json?.id;
};
const account = async (username) => {
  const email = `${username}@tifomaker-e2e.org`;
  const r = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username, password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) });
  const token = r.json?.token;
  await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });
  const id = (await api('/api/me', token)).json?.id;
  return { token, id, design: await design(token, `${username} wall`, ['#262a33', '#0f7a3a', '#f2f1ec', '#d4a017']) };
};

/** A round crest on a transparent ground, written as a PNG in Node: gold ring, green field, white star. */
function crestPng(w = 200, h = 200) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - w / 2, y - h / 2);
      const a = Math.atan2(y - h / 2, x - w / 2);
      const star = r < 48 + 22 * Math.cos(5 * a);
      let c = null;
      if (r < 96) c = [212, 160, 23];
      if (r < 84) c = [15, 122, 58];
      if (star && r < 70) c = [242, 241, 236];
      if (!c) continue;
      const p = (y * w + x) * 4;
      px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
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
const CREST = crestPng();

const fan = await account('sync_fan');
const sup = await account('sync_sup');
const viewer = await account('sync_viewer');
const outsider = await account('sync_outsider');
const away = await design(fan.token, 'sync_fan away', ['#262a33', '#1c5fd9', '#ffffff', '#d01f2f']);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const waitFor = (p, fn, arg = null, ms = 30000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
/** A browser of its own (its own IndexedDB, its own localStorage): one device. */
const device = async (token, { lang = 'en', w = 1440, h = 900, phone = false, theme = null } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([tok, lang, theme]) => {
    try {
      for (const [k, v] of Object.entries({ tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}', tifo_banner_tour_v1: '1', tifo_post_nudge_v1: '1', tifo_view_v1: '2d', tifo_lang_v1: lang, mds_seen_intro: '1', mds_sound_v2: JSON.stringify({ on: false }) })) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }
      if (theme) localStorage.setItem('tifo_theme_v1', theme);
      if (tok && localStorage.getItem('tifo_token_v1') === null) localStorage.setItem('tifo_token_v1', tok);
    } catch { /* */ }
  }, [token, lang, theme]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${p.url()}: ${String(e.message).slice(0, 200)}`));
  return { ctx, p };
};
const open = async (p, id, title, { lang = 'en' } = {}) => {
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/app?project=${id}&e2e=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!window.__tifo, null, 90000);
  await waitFor(p, (t) => document.getElementById('doc-title')?.value === t, title, 30000);
  await waitFor(p, () => !!window.__tifoClubKit && !!window.__tifoCredit, null, 30000);
  await p.waitForTimeout(600);
};
const entryShown = (p) => waitFor(p, () => { const b = document.querySelector('.kit-entry'); return !!b && !b.hidden && b.getClientRects().length > 0; }, null, 20000);
const openSheet = async (p) => {
  await p.click('[data-tool="brush"]');
  await entryShown(p);
  await p.click('.kit-entry');
  return waitFor(p, () => !!document.querySelector('.kit-sheet h2') && !/Opening|نفتح/.test(document.querySelector('.kit-sheet')?.textContent || ''));
};
const closeSheet = async (p) => {
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.kit-backdrop'));
};
const plain = (s) => (s || '').replace(/[⁨⁩]/g, '');
const sheetText = async (p) => plain(await p.evaluate(() => document.querySelector('.kit-sheet')?.textContent || ''));
const shot = async (p, name, opts = {}) => { if (SHOTS) { await p.waitForTimeout(450); await p.screenshot({ path: join(SHOTS, `${name}.png`), ...opts }); } };
const saveFile = (buf, name) => { if (SHOTS) writeFileSync(join(SHOTS, name), buf); };
const bytesOf = async (dl) => Buffer.concat(await (await dl.createReadStream()).toArray());
const downloadFrom = async (p, click, ms = 240000) => {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: ms }), click()]);
  return { name: dl.suggestedFilename(), buf: await bytesOf(dl) };
};
const accountKits = async (token) => (await api('/api/pro/kits', token)).json?.kits ?? [];

// A blank page for reading files the way a browser does.
const reader = await (await browser.newContext()).newPage();
await reader.setContent('<!doctype html><title>reader</title>');
/**
 * Where the credit line should be in a picture of this size (ui/creditLine.ts:
 * the font from the area, the pill's height and margin from the font), and
 * what is in that box: its light pixels (the credit's letters) and its mean.
 */
const creditBoxIn = (b64, type, corner, bottom = null, area = null) => reader.evaluate(async ([b64, type, corner, bottom, area]) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  const W = area ? area.w : bmp.width, H = area ? area.h : bmp.height;
  const fs = Math.round(Math.max(12, Math.min(72, Math.sqrt(W * H) * 0.021)));
  const margin = Math.round(fs * 0.7);
  const h = Math.round(fs + Math.round(fs * 0.36) * 2);
  const y = H - (bottom ?? margin) - h;
  const w = Math.round(Math.min(bmp.width * 0.4, fs * 7));
  const x = corner === 'left' ? margin : bmp.width - margin - w;
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(x, y, w, h).data;
  let light = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) light++;
    sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  }
  return { w: bmp.width, h: bmp.height, light, mean: Math.round(sum / (d.length / 4)), box: [x, y, w, h], fs };
}, [b64, type, corner, bottom, area]);
/** A video's last frame, as a PNG (ffmpeg). */
const lastFrame = (buf, name) => {
  const dir = SHOTS || '/tmp';
  const src = join(dir, `${name}.video`);
  writeFileSync(src, buf);
  const png = join(dir, `${name}.png`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-sseof', '-0.4', '-i', src, '-frames:v', '1', png]);
  return execFileSync('cat', [png]);
};

// =====================================================================
console.log('\n— one kit, two devices —');
const laptop = await device(fan.token);
let kitColours = null;
{
  const { p } = laptop;
  await open(p, fan.design, 'sync_fan wall');
  // The crest in the design, and a Pro voice for the Text tool, as a fan would.
  await p.setInputFiles('#import-file', { name: 'eagles-crest.png', mimeType: 'image/png', buffer: CREST });
  await waitFor(p, () => !document.getElementById('import-apply').disabled);
  await p.uncheck('#real-colors');
  await p.click('#import-apply');
  await waitFor(p, () => window.__tifo.objects.pictureCount() === 1);
  await waitFor(p, () => !!document.querySelector('#text-font option[value="block"]'));
  await p.evaluate(() => { const s = document.getElementById('text-font'); s.value = 'block'; s.dispatchEvent(new Event('change')); });
  check('the sheet opens', await openSheet(p));
  check('…and says the kits are on the account, on every device', /On your account: here on every device you sign in on/.test(await sheetText(p)), await sheetText(p));
  await p.click('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await p.fill('#kit-name', 'Green Eagles');
  await p.click('.kit-sheet [data-act="save"]');
  check('Save kit: saved on the account', await waitFor(p, () => /Saved “Green Eagles” on your account/.test((document.querySelector('.kit-note')?.textContent || '').replace(/[⁨⁩]/g, ''))), plain(await p.textContent('.kit-note')));
  await shot(p, 'sync-1440-laptop-saved');
  const onServer = await accountKits(fan.token);
  kitColours = onServer[0]?.colours;
  check('…the server has it: name, colours, the crest, the font', onServer.length === 1 && onServer[0].name === 'Green Eagles' && JSON.stringify(onServer[0].colours) === JSON.stringify(['#0f7a3a', '#f2f1ec', '#d4a017']) && onServer[0].logos.length === 1 && onServer[0].font === 'block', JSON.stringify(onServer));
  await closeSheet(p);
}
const phone = await device(fan.token, { w: 390, h: 844, phone: true });
{
  const { p } = phone;
  await open(p, away, 'sync_fan away');
  await p.tap('.m-tab[data-tab="colors"]');
  await entryShown(p);
  await p.tap('.kit-entry');
  await waitFor(p, () => !!document.querySelector('.kit-card .kit-name'), null, 30000);
  await p.waitForTimeout(400);
  const seen = await p.evaluate(() => {
    const c = document.querySelector('.kit-card');
    const cv = c?.querySelector('canvas.kit-logo');
    let drawn = 0;
    if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) drawn++; }
    return {
      name: c?.querySelector('.kit-name')?.textContent,
      strip: [...(c?.querySelectorAll('.kit-strip span') ?? [])].map((s) => getComputedStyle(s).backgroundColor),
      font: c?.querySelector('.kit-font')?.textContent, drawn,
      where: document.querySelector('.kit-where')?.textContent,
      over: document.documentElement.scrollWidth - innerWidth,
    };
  });
  check('a second device, signed in to the same account: the kit is there', seen.name === 'Green Eagles' && seen.font === 'Font: Block', JSON.stringify(seen));
  check('…its colours in order, and its crest drawn from what the server kept', JSON.stringify(seen.strip) === JSON.stringify(['rgb(15, 122, 58)', 'rgb(242, 241, 236)', 'rgb(212, 160, 23)']) && seen.drawn > 3000, JSON.stringify({ strip: seen.strip, drawn: seen.drawn }));
  check('…"On your account", and nothing scrolls sideways at 390px', /On your account/.test(seen.where || '') && seen.over <= 0, JSON.stringify(seen));
  await shot(p, 'sync-390-phone-sees-kit');
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.kit-backdrop'));
}

// =====================================================================
console.log('\n— a kit made while the account had none on it, then moved up —');
const desk = await device(fan.token);
{
  const { p } = desk;
  // The server says this account has no kits on it (as one Pro was not on for would hear): the browser keeps them.
  await p.route('**/api/pro/kits**', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }));
  await open(p, fan.design, 'sync_fan wall');
  await openSheet(p);
  check('with no kits on the account, the sheet is this browser\'s (empty here)', await p.evaluate(() => document.querySelectorAll('.kit-card').length === 0 && !document.querySelector('.kit-where')));
  await p.click('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await p.fill('#kit-name', 'Old browser kit');
  await p.click('.kit-sheet [data-act="save"]');
  check('…a kit saved there is kept in this browser', await waitFor(p, () => /Saved “Old browser kit”\. It’s here in every project/.test((document.querySelector('.kit-note')?.textContent || '').replace(/[⁨⁩]/g, ''))));
  check('…and not on the account', (await accountKits(fan.token)).length === 1);
  await closeSheet(p);
  await p.unroute('**/api/pro/kits**');
  await open(p, fan.design, 'sync_fan wall');
  await openSheet(p);
  // The sheet writes its status line a frame after it paints: wait for it, then read.
  await waitFor(p, () => document.querySelectorAll('.kit-card').length === 2 && /are on your account now/.test(document.querySelector('.kit-note')?.textContent || ''), null, 15000);
  const moved = await p.evaluate(() => ({ names: [...document.querySelectorAll('.kit-card .kit-name')].map((n) => n.textContent), note: document.querySelector('.kit-note')?.textContent }));
  check('at the next load it moves up: both kits, and the sheet says so', JSON.stringify(moved.names) === JSON.stringify(['Green Eagles', 'Old browser kit']) && /are on your account now/.test(moved.note || ''), JSON.stringify(moved));
  check('…the account has it', JSON.stringify((await accountKits(fan.token)).map((k) => k.name)) === JSON.stringify(['Green Eagles', 'Old browser kit']));
  const left = await p.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('tifo_club_kits'); r.onsuccess = () => res(r.result); });
    const keys = await new Promise((res) => { const q = db.transaction('kits').objectStore('kits').getAllKeys(); q.onsuccess = () => res(q.result); });
    db.close();
    return keys.length;
  });
  check('…and is gone from this browser: one copy, never two', left === 0, String(left));
  await closeSheet(p);
}

// =====================================================================
console.log('\n— offline —');
{
  const { p } = phone;
  await p.route('**/api/pro/kits**', (r) => r.abort('internetdisconnected'));
  // Opened again by its address (a reload would drop ?e2e, which main.ts tidies away).
  await open(p, away, 'sync_fan away');
  await p.tap('.m-tab[data-tab="colors"]');
  await entryShown(p);
  await p.tap('.kit-entry');
  await waitFor(p, () => !!document.querySelector('.kit-card .kit-name'), null, 30000);
  await waitFor(p, () => /You’re offline/.test(document.querySelector('.kit-where')?.textContent || ''), null, 15000);
  const off = await p.evaluate(() => ({ names: [...document.querySelectorAll('.kit-card .kit-name')].map((n) => n.textContent), where: document.querySelector('.kit-where')?.textContent, offClass: !!document.querySelector('.kit-where.off') }));
  check('offline: the kits as this device last had them, and the sheet says so', JSON.stringify(off.names) === JSON.stringify(['Green Eagles']) && off.offClass && /You’re offline/.test(off.where || ''), JSON.stringify(off));
  await shot(p, 'sync-390-offline');
  await p.tap('.kit-sheet [data-act="new"]');
  await waitFor(p, () => !!document.getElementById('kit-name'));
  await p.fill('#kit-name', 'Away kit');
  await p.tap('.kit-sheet [data-act="save"]');
  check('…a kit saved offline is kept on the device, and says when it goes up', await waitFor(p, () => /Saved “Away kit” on this device\. It goes up to your account when you’re back online/.test((document.querySelector('.kit-note')?.textContent || '').replace(/[⁨⁩]/g, ''))), plain(await p.textContent('.kit-note')));
  check('…the server does not have it yet', !(await accountKits(fan.token)).some((k) => k.name === 'Away kit'));
  await p.keyboard.press('Escape');
  await p.unroute('**/api/pro/kits**');
  // Opened again by its address (a reload would drop ?e2e, which main.ts tidies away).
  await open(p, away, 'sync_fan away');
  await p.tap('.m-tab[data-tab="colors"]');
  await entryShown(p);
  await p.tap('.kit-entry');
  await waitFor(p, () => document.querySelectorAll('.kit-card').length >= 2, null, 30000);
  const back = await accountKits(fan.token);
  check('back online: it goes up, and the account holds all three', JSON.stringify(back.map((k) => k.name)) === JSON.stringify(['Green Eagles', 'Old browser kit', 'Away kit']), JSON.stringify(back.map((k) => k.name)));
  // A delete made offline.
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.kit-backdrop'));
  await p.route('**/api/pro/kits**', (r) => r.abort('internetdisconnected'));
  await p.tap('.kit-entry');
  await waitFor(p, () => document.querySelectorAll('.kit-card').length === 3, null, 30000);
  await p.tap('.kit-card:nth-child(2) [data-act="delete"]');
  await waitFor(p, () => !!document.querySelector('.dlg .dlg-confirm'));
  check('deleting asks first, and says it goes from the account, on every device', /It goes from your account, on every device/.test(await p.textContent('.dlg')));
  await p.tap('.dlg .dlg-confirm');
  await waitFor(p, () => document.querySelectorAll('.kit-card').length === 2);
  check('…offline, the server still has it', (await accountKits(fan.token)).length === 3);
  await p.keyboard.press('Escape');
  await p.unroute('**/api/pro/kits**');
  // Opened again by its address (a reload would drop ?e2e, which main.ts tidies away).
  await open(p, away, 'sync_fan away');
  await p.evaluate(() => window.__tifoClubKit.reload());
  check('…and when the server answers, the delete goes up', JSON.stringify((await accountKits(fan.token)).map((k) => k.name)) === JSON.stringify(['Green Eagles', 'Away kit']));
}
{
  // The laptop sees what the phone did.
  const { p } = laptop;
  await openSheet(p);
  await waitFor(p, () => document.querySelectorAll('.kit-card').length === 2, null, 20000);
  const names = await p.evaluate(() => [...document.querySelectorAll('.kit-card .kit-name')].map((n) => n.textContent));
  check('the first device sees the kit saved offline on the second, and not the one deleted', JSON.stringify(names) === JSON.stringify(['Green Eagles', 'Away kit']), JSON.stringify(names));
  await shot(p, 'sync-1440-laptop-sees-phone');
  await closeSheet(p);
}

// =====================================================================
console.log('\n— the kit everywhere —');
const studio = await device(fan.token);
{
  const { p } = studio;
  await open(p, away, 'sync_fan away');
  await openSheet(p);
  await p.click('.kit-card:first-child [data-act="use"]');
  await waitFor(p, () => !document.querySelector('.kit-backdrop'));
  await p.click('#import-cancel').catch(() => {});
  check('Use in this project: the kit is in use', await waitFor(p, () => !!window.__tifoClubKit.active()));
  // The AI designer.
  let sent = null;
  await p.route('**/api/ai/generate', (r) => {
    sent = r.request().postDataJSON();
    const resetAt = new Date(Date.now() + 86400e3).toISOString();
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ needsChoice: true, reason: 'quota', kind: 'std', plan: 'free', retryAfterSec: 86400, quota: { admin: false, used: 10, limit: 10, remaining: 0, resetInSec: 86400, live: true, kind: 'std', period: 'day', resetAt, plan: 'free' } }) });
  });
  await p.click('#rail-ai');
  check('the AI panel says "Using kit: Green Eagles"', await waitFor(p, () => /Using kit: Green Eagles/.test((document.querySelector('.qk-ai-kit:not([hidden])')?.textContent || '').replace(/[⁨⁩]/g, ''))));
  await p.locator('#ctx-ai').screenshot({ path: SHOTS ? join(SHOTS, 'kit-ai-chip.png') : '/tmp/kit-ai-chip.png' });
  await p.fill('#ai-prompt', 'An eagle over the north stand');
  await p.click('#ai-generate');
  await waitFor(p, () => !!document.querySelector('#ai-state:not([hidden])'), null, 20000);
  check('…and every design request carries it: { name, colours, font }', JSON.stringify(sent?.kit) === JSON.stringify({ name: 'Green Eagles', colours: kitColours, font: 'block' }), JSON.stringify(sent?.kit));
  await p.click('.qk-ai-stop');
  check('stopping it takes the chip away', await waitFor(p, () => !document.querySelector('.qk-ai-kit:not([hidden])')));
  sent = null;
  await p.click('#ai-generate');
  for (let i = 0; i < 40 && sent === null; i++) await p.waitForTimeout(500);
  check('…and the next design goes without it', !!sent && !('kit' in sent), JSON.stringify(sent));
  await p.unroute('**/api/ai/generate');
  // The free try is spent here; from now on Pro runs (the gift), so the exports below are the Pro ones.
  check('(the gift starts)', (await api('/api/pro/gift/accept', fan.token, { method: 'POST', body: '{}' })).status === 200);
  // With Pro running, the kit goes back in (no limit), and stays with the project.
  await open(p, away, 'sync_fan away');
  await openSheet(p);
  await p.click('.kit-card:first-child [data-act="use"]');
  await waitFor(p, () => !document.querySelector('.kit-backdrop'));
  await p.click('#import-cancel').catch(() => {});
  await open(p, away, 'sync_fan away');
  check('the project opens again with its kit still in use', await waitFor(p, () => !!window.__tifoClubKit.active(), null, 20000));
  await p.click('#rail-ai');
  check('…the AI panel says so again', await waitFor(p, () => !!document.querySelector('.qk-ai-kit:not([hidden])')));

  // Banners.
  await p.click('#view-banner');
  await waitFor(p, () => !!document.querySelector('#bn-empty button[data-kind="sign"]'));
  await p.click('#bn-empty button[data-kind="sign"]');
  check('a sign: the banner panel offers "Dress this banner in “Green Eagles”"', await waitFor(p, () => /Dress this banner in “Green Eagles”/.test((document.querySelector('#qk-bn-kit:not([hidden]) .qk-bn-dress')?.textContent || '').replace(/[⁨⁩]/g, ''))));
  const signBefore = await p.evaluate(() => window.__tifoClubKit.banner());
  await p.click('.qk-bn-dress');
  check('…dressed: the kit\'s colour for the cloth, the one that stands out on it for the letters, its font', await waitFor(p, () => { const b = window.__tifoClubKit.banner(); const m = b?.items.find((i) => i.kind === 'text'); return b?.bg === '#0f7a3a' && m?.fontId === 'block' && m?.color === '#f2f1ec'; }), JSON.stringify(await p.evaluate(() => window.__tifoClubKit.banner())));
  check('…and a sign keeps its words alone: no crest', (await p.evaluate(() => window.__tifoClubKit.banner())).items.every((i) => i.kind !== 'image'));
  await shot(p, 'kit-banner-sign-dressed');
  await p.click('#undo');
  check('one undo takes it all back', await waitFor(p, (b) => JSON.stringify(window.__tifoClubKit.banner()) === b, JSON.stringify(signBefore)));
  await p.click('#bn-add-stand');
  await waitFor(p, () => window.__tifoClubKit.banner()?.kind === 'stand');
  await waitFor(p, () => !!document.querySelector('#qk-bn-kit:not([hidden]) .qk-bn-dress'));
  await p.click('.qk-bn-dress');
  check('a stand banner: the cloth in the kit, and its crest at the start end', await waitFor(p, () => { const b = window.__tifoClubKit.banner(); const img = b?.items.find((i) => i.kind === 'image'); return b?.bg === '#0f7a3a' && !!img && img.cx < 0.3 && img.name === 'Green Eagles'; }), JSON.stringify(await p.evaluate(() => window.__tifoClubKit.banner())));
  const words = (await p.evaluate(() => window.__tifoClubKit.banner())).items.find((i) => i.kind === 'text');
  check('…and, with no words on it yet, the club\'s name beside the crest in the kit\'s font and colour', !!words && words.fontId === 'block' && words.color === '#f2f1ec' && words.cx > 0.4, JSON.stringify(words));
  await shot(p, 'kit-banner-stand-dressed');
  await p.click('#view-2d');

  // The credit line, typed once.
  await p.click('#rail-anim');
  await waitFor(p, () => !!document.querySelector('#sx-credit:not([hidden]) input'));
  await p.evaluate(() => { const s = document.getElementById('reveal-dur'); s.value = '2'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.fill('#sx-credit input', '@green_eagles');
  await p.locator('#sx-credit input').press('Enter');
  check('the credit line: typed in the export panel, saved on the account', await waitFor(p, () => /Saved on your account/.test(document.querySelector('#sx-credit .qk-credit-note')?.textContent || '')) && (await api('/api/pro/credit', fan.token)).json?.credit === '@green_eagles');
  await p.locator('#ctx-stadium-export').screenshot({ path: SHOTS ? join(SHOTS, 'credit-export-panel.png') : '/tmp/credit-export-panel.png' });
  await p.click('#sx-credit input');
  await p.fill('#sx-credit input', '  @green‮_eagles   and much more than thirty-two characters  ');
  await p.locator('#sx-credit input').press('Enter');
  await waitFor(p, () => /Saved on your account/.test(document.querySelector('#sx-credit .qk-credit-note')?.textContent || ''));
  const cleaned = (await api('/api/pro/credit', fan.token)).json?.credit;
  // The field takes 32 characters (the override and the spaces among them); what is kept is cleaned.
  check('…cleaned as it is kept: one line, no override, at most 32 characters', cleaned === '@green_eagles and much more', JSON.stringify(cleaned));
  await p.fill('#sx-credit input', '@green_eagles');
  await p.locator('#sx-credit input').press('Enter');
  await waitFor(p, () => /Saved on your account/.test(document.querySelector('#sx-credit .qk-credit-note')?.textContent || ''));

  // The stadium preview, the GIF, the video and the poster.
  await p.click('#view-3d');
  await waitFor(p, () => !!window.__tifoProExport?.preview(), null, 60000);
  await p.evaluate(() => Promise.race([window.__tifoProExport.preview().ready, new Promise((r) => setTimeout(r, 20000))]));
  await p.click('#rail-anim');
  await p.click('#sx-preview');
  await waitFor(p, () => !!document.querySelector('.sx-canvas'), null, 60000);
  await p.waitForTimeout(3500);
  const prev = await p.evaluate(() => document.querySelector('.sx-canvas').toDataURL('image/png').split(',')[1]);
  const pv = await creditBoxIn(prev, 'image/png', 'left');
  check('the stadium preview carries the credit, bottom left (the mark is bottom right)', pv.light > 25 && pv.mean < 150, JSON.stringify(pv));
  saveFile(Buffer.from(prev, 'base64'), 'credit-stadium-preview.png');
  await p.click('.sx-close');
  await p.selectOption('#sx-format', 'gif');
  const gif = await downloadFrom(p, () => p.click('#sx-export'), 120000);
  const gi = await creditBoxIn(gif.buf.toString('base64'), 'image/gif', 'left');
  check('the GIF carries it', gif.buf.slice(0, 3).toString() === 'GIF' && gi.light > 6, JSON.stringify(gi));
  saveFile(gif.buf, 'credit-stadium.gif');
  await p.selectOption('#sx-format', { index: 0 });
  const vid = await downloadFrom(p, () => p.click('#sx-export'), 240000);
  const frame = lastFrame(vid.buf, 'credit-video-last-frame');
  const vi = await creditBoxIn(frame.toString('base64'), 'image/png', 'left');
  check('the video carries it, on its last frame', vi.light > 25, JSON.stringify(vi));
  await p.check('#sx-nomark');
  // The 4K poster is a designed poster in its own sheet since the merge with
  // the poster work (ui/proPoster.ts); its type sets the credit itself, at the
  // top, on the side its own words do not start from (ui/posterLayout.ts).
  await p.click('#sx-poster');
  await waitFor(p, () => !!document.querySelector('.qv-download'), null, 60000);
  const poster = await downloadFrom(p, () => p.click('.qv-download'), 600000);
  const po = await reader.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const u = Math.min(bmp.width, bmp.height) / 100;
    const size = u * 2.2;
    const box = [Math.round(bmp.width - u * 4 - size * 12), Math.round(u * 6 - size * 1.1), Math.round(size * 12), Math.round(size * 1.5)];
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(...box).data;
    let light = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) light++;
    return { w: bmp.width, h: bmp.height, light, box };
  }, poster.buf.toString('base64'));
  check('the 4K poster carries it, top right in English, sized for 4K', po.w === 3840 && po.h === 2160 && po.light > 300, JSON.stringify(po));
  await p.keyboard.press('Escape');
  await waitFor(p, () => !document.querySelector('.qv-poster-backdrop'), null, 30000);
  saveFile(poster.buf, 'credit-poster-4k.png');
  await p.uncheck('#sx-nomark');

  // Post it: the kit and the credit.
  await p.click('#post-tifo');
  await waitFor(p, () => !!document.querySelector('.pm-pic'), null, 60000);
  check('Post it shows the credit field, filled', await waitFor(p, () => document.querySelector('.pm-card .qk-credit input')?.value === '@green_eagles'));
  const pic = await downloadFrom(p, () => p.click('.pm-row .pm-b:has(.ti-download)'));
  saveFile(pic.buf, 'kit-post-it.png');
  const look = await reader.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    // The crest's box at the band's end: gold and green pixels.
    const d = g.getImageData(1080 - 64 - 150, 1094 + 8, 150, 240).data;
    let crest = 0;
    for (let i = 0; i < d.length; i += 4) if ((d[i] > 180 && d[i + 1] > 130 && d[i + 2] < 80) || (d[i] < 40 && d[i + 1] > 100 && d[i + 2] < 90)) crest++;
    return { w: bmp.width, h: bmp.height, stripe: [px(60, 1087), px(700, 1087), px(1000, 1087)], crest };
  }, pic.buf.toString('base64'));
  check('the Post it band wears the kit: its colours along the top, its crest at the end', look.w === 1080 && JSON.stringify(look.stripe[0]) === JSON.stringify([15, 122, 58]) && look.crest > 2000, JSON.stringify(look));
  const pc = await creditBoxIn(pic.buf.toString('base64'), 'image/png', 'left', 28, { w: 1080, h: 1080 });
  check('…and the credit sits in the picture\'s corner, above the band', pc.light > 25, JSON.stringify(pc));
  await shot(p, 'kit-post-it-sheet');
  await p.click('.pm-x');

  // Match Day: the field in Record, and the snapshot.
  await p.goto(`${B}/app?project=${away}&sim=1&e2e=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.mds-overlay canvas', { timeout: 120000 });
  await p.evaluate(() => { const s = document.querySelector('.mds-section[data-sec="record"]'); if (s && !s.classList.contains('open')) s.querySelector('.mds-shead').click(); });
  check('Match Day: the credit field in Record, filled from the account', await waitFor(p, () => document.querySelector('[data-k="credit"] .qk-credit:not([hidden]) input')?.value === '@green_eagles', null, 60000));
  await p.waitForTimeout(4000);
  const snap = await downloadFrom(p, () => p.click('.mds-bar .mds-btn:has-text("Snapshot")', { timeout: 120000 }));
  const si = await creditBoxIn(snap.buf.toString('base64'), 'image/png', 'left');
  check('…the snapshot carries the credit', si.light > 25, JSON.stringify(si));
  saveFile(snap.buf, 'credit-matchday-snapshot.png');
  await shot(p, 'credit-matchday-record');
  // A clip, at its shortest: the credit on its last frame. Pro's Record makes
  // Match Day's film by default (ui/proFilm.ts, e2e-pro-video); this is the
  // screen recording, which keeps its length field.
  await p.evaluate(() => { const f = document.querySelector('[data-k="rec-film"]'); if (f) { f.value = 'screen'; f.dispatchEvent(new Event('change', { bubbles: true })); } });
  await p.evaluate(() => { const s = document.querySelector('[data-k="rec-length"]'); s.value = '6'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  const clip = await downloadFrom(p, () => p.click('.mds-bar .mds-btn:has-text("Record")'), 180000);
  const clipFrame = lastFrame(clip.buf, 'credit-matchday-clip-last-frame');
  const ci = await creditBoxIn(clipFrame.toString('base64'), 'image/png', 'left');
  check('…and so does the recording, on its last frame', /^tifo-matchday\.(mp4|webm)$/.test(clip.name) && ci.light > 15, JSON.stringify({ name: clip.name, ...ci }));
}
{
  // The other device has the credit line too.
  const { p } = laptop;
  await open(p, fan.design, 'sync_fan wall');
  await p.click('#rail-anim');
  check('the laptop\'s export panel has the same credit line', await waitFor(p, () => document.querySelector('#sx-credit input')?.value === '@green_eagles', null, 20000));
}
{
  // An Arabic credit: right to left, bottom right.
  const { p } = studio;
  await open(p, away, 'sync_fan away');
  await p.evaluate(() => window.__tifoCredit.set('ألتراس النسور'));
  await p.evaluate(() => window.__tifoCredit.saved());
  await p.click('#post-tifo');
  await waitFor(p, () => !!document.querySelector('.pm-pic'), null, 60000);
  const pic = await downloadFrom(p, () => p.click('.pm-row .pm-b:has(.ti-download)'));
  saveFile(pic.buf, 'credit-post-it-arabic.png');
  const right = await creditBoxIn(pic.buf.toString('base64'), 'image/png', 'right', 28, { w: 1080, h: 1080 });
  const leftSide = await creditBoxIn(pic.buf.toString('base64'), 'image/png', 'left', 28, { w: 1080, h: 1080 });
  check('an Arabic credit reads right to left, in the bottom right corner', right.light > 25 && leftSide.light < right.light / 3, JSON.stringify({ right: right.light, left: leftSide.light }));
  await p.click('.pm-x');
  await p.evaluate(() => window.__tifoCredit.set('@green_eagles'));
  await p.evaluate(() => window.__tifoCredit.saved());
}
{
  // Not running Pro: the export sheet names the credit, and the free version goes without it.
  const ar = await account('sync_ar');
  const { ctx, p } = await device(ar.token);
  await open(p, ar.design, 'sync_ar wall');
  await p.evaluate(() => window.__tifoCredit.set('@ar_fan'));
  await p.evaluate(() => window.__tifoCredit.saved());
  await p.click('#post-tifo');
  await waitFor(p, () => !!document.querySelector('.pm-pic'), null, 60000);
  await p.click('.pm-row .pm-b:has(.ti-download)');
  await waitFor(p, () => !!document.querySelector('.pro-sheet [data-act="free"]'), null, 60000);
  const items = await p.evaluate(() => [...document.querySelectorAll('.pro-sheet .pro-items li')].map((l) => l.textContent));
  check('free to try, asked at export: "Your credit line" is one of the Pro items', items.includes('Your credit line'), JSON.stringify(items));
  const free = await downloadFrom(p, () => p.click('.pro-sheet [data-act="free"]'));
  const fc = await creditBoxIn(free.buf.toString('base64'), 'image/png', 'left', 28, { w: 1080, h: 1080 });
  check('…and "Export without Pro items" goes without it', fc.light < 10, JSON.stringify(fc));
  await ctx.close();
}

// =====================================================================
console.log('\n— the supporter badge —');
const unlock = (await api('/api/ai/unlock', null, { method: 'POST', body: JSON.stringify({ password: PW }) })).json?.token;
const granted = await api('/api/admin/pro/grant', null, { method: 'POST', body: JSON.stringify({ username: 'sync_sup', plan: 'monthly', days: 30 }), headers: { 'x-ai-unlock': unlock } });
check('(a month of Pro for sync_sup)', granted.status === 200, JSON.stringify(granted));
await api(`/api/designs/${sup.design}`, sup.token, { method: 'PATCH', body: JSON.stringify({ isPublic: true, title: 'Supporters wall' }) });
await api(`/api/designs/${fan.design}`, fan.token, { method: 'PATCH', body: JSON.stringify({ isPublic: true, title: 'Gift wall' }) });
{
  const item = (await api(`/api/gallery/${sup.design}`, viewer.token)).json;
  check('the server says so, and nothing more: no plan, no date', item?.ownerSupporter === true && !/monthly|endsAt|plan/.test(JSON.stringify(item)), JSON.stringify(item).slice(0, 200));
  check('…not for a gift', (await api(`/api/gallery/${fan.design}`, viewer.token)).json?.ownerSupporter === undefined);
  check('…and not to a viewer outside the preview', (await api(`/api/gallery/${sup.design}`, outsider.token)).json?.ownerSupporter === undefined);
  const prof = (await api(`/api/users/${sup.id}/profile`, viewer.token)).json;
  check('the profile says so too', prof?.supporter === true && !/monthly|endsAt/.test(JSON.stringify(prof)));
}
const badgeLook = (p, sel) => p.evaluate((sel) => {
  const b = document.querySelector(sel);
  if (!b) return null;
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return { text: b.textContent, crown: !!b.querySelector('.pro-crown'), color: cs.color, bg: cs.backgroundColor, h: Math.round(r.height), right: Math.round(r.right), vw: innerWidth };
}, sel);
const gold = (c) => { const m = /rgb\((\d+), (\d+), (\d+)/.exec(c || ''); return !!m && +m[1] > +m[3] + 60 && +m[1] >= 120; };
for (const [lang, theme, w] of [['en', 'dark', 1440], ['en', 'light', 1440], ['ar', 'light', 1440], ['ar', 'dark', 390], ['en', 'light', 390]]) {
  const word = lang === 'ar' ? 'داعم مميّز' : 'Pro supporter';
  const tag = `${lang}-${theme}-${w}`;
  const { ctx, p } = await device(viewer.token, { lang, theme, w, h: w < 500 ? 844 : 900, phone: w < 500 });
  // The tifo card.
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/community`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('.tifo-card .supporter-badge'), null, 60000);
  const card = await badgeLook(p, '.tifo-card .supporter-badge');
  const cardOwner = await p.evaluate(() => document.querySelector('.tifo-card .supporter-badge')?.closest('.tifo-card')?.querySelector('.card-creator')?.textContent);
  check(`${tag}: the tifo card shows "${word}" with the crown, in gold, beside the name`, !!card && card.text === word && card.crown && gold(card.color) && cardOwner === '@sync_sup' && card.right <= card.vw, JSON.stringify({ card, cardOwner }));
  const giftCard = await p.evaluate(() => [...document.querySelectorAll('.tifo-card')].find((c) => c.querySelector('.card-creator')?.textContent === '@sync_fan')?.querySelector('.supporter-badge') ?? null);
  check(`${tag}: …and none for a gift holder`, giftCard === null);
  await p.locator('.tifo-card:has(.supporter-badge)').first().screenshot({ path: SHOTS ? join(SHOTS, `badge-card-${tag}.png`) : '/tmp/badge-card.png' });
  // The profile header.
  await p.click('.tifo-card:has(.supporter-badge) .card-creator');
  await waitFor(p, () => !!document.querySelector('.profile-name .supporter-badge'), null, 30000);
  const head = await badgeLook(p, '.profile-name .supporter-badge');
  check(`${tag}: the profile header shows it`, !!head && head.text === word && gold(head.color), JSON.stringify(head));
  await shot(p, `badge-profile-${tag}`);
  // The public tifo page.
  await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/t/${sup.design}`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('#s-sub .supporter-badge'), null, 60000);
  const pg = await badgeLook(p, '#s-sub .supporter-badge');
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${tag}: the public tifo page shows it beside the creator, nothing scrolls sideways`, !!pg && pg.text === word && gold(pg.color) && over <= 0, JSON.stringify({ pg, over }));
  await p.locator('.s-info').screenshot({ path: SHOTS ? join(SHOTS, `badge-tifo-page-${tag}.png`) : '/tmp/badge-tifo.png' });
  await ctx.close();
}
{
  // Their account page.
  const { ctx, p } = await device(sup.token, { theme: 'light' });
  await p.goto(`${B}/account`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => !!document.querySelector('#pro .pro-ac-name .supporter-badge'), null, 30000);
  const acc = await p.evaluate(() => ({ text: document.querySelector('#pro .pro-ac-name')?.textContent, lead: document.querySelector('#pro .pro-ac-foot')?.textContent }));
  check('the account page shows them their name as the community does', /@sync_sup\s*Pro supporter/.test(acc.text || '') && /Your name shows this badge/.test(acc.lead || ''), JSON.stringify(acc));
  await p.locator('#pro').screenshot({ path: SHOTS ? join(SHOTS, 'badge-account-light.png') : '/tmp/badge-account.png' });
  await ctx.close();
}
{
  // Outside the preview, no badge at all.
  const { ctx, p } = await device(outsider.token);
  await p.goto(`${B}/t/${sup.design}`, { waitUntil: 'domcontentloaded' });
  await waitFor(p, () => /sync_sup/.test(document.getElementById('s-sub')?.textContent || ''), null, 60000);
  check('a viewer outside the preview sees no badge', await p.evaluate(() => !document.querySelector('.supporter-badge')));
  await ctx.close();
}

for (const d of [laptop, phone, desk, studio]) await d.ctx.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail || errs.length ? 1 : 0);
