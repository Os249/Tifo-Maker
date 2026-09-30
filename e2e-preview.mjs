/**
 * The community preview: a design with many banners must not push the title,
 * the creator's note and the comments out of the window.
 *
 *   npm run test:preview      (needs `npm run build` first: it serves dist/)
 *
 * Reported 30 Sep 2026 on a design with seven signs: one camera button per
 * banner made the camera row 1044px wide, and a bare `fr` grid column cannot
 * shrink below its content, so the 3D side took the whole modal. In Arabic the
 * side panel sat off the left edge, in English off the right.
 */
import { spawn, execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8922;
const B = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '' },
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
const api = async (path, token, body, method = 'POST') => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

// ---- seed: a public design with seven signs, made out of order ----
const stamp = Date.now().toString(36).slice(-5);
const reg = await api('/api/auth/register', null, { username: `gate13${stamp}`, password: 'harbor-kite-moss-31', email: `gate13${stamp}@example.test`, acceptedVersion: 'test' });
const tpl = (await (await fetch(`${B}/api/templates`)).json())[0];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const design = await api('/api/designs', reg.token, {
  title: 'PANATHINAIKOS ULTRAS', templateId: tpl.id, templateVersion: tpl.version, palette: ['#262a33', '#1f8a2e', '#ffffff'],
  cellsGzB64: gzipSync(Buffer.alloc(tpl.seatCount, 1)).toString('base64'), thumbnailPngB64: png.toString('base64'),
});
await api(`/api/designs/${design.id}`, reg.token, { isPublic: true }, 'PATCH');
const scene = execFileSync(process.execPath, ['--import', 'tsx', '-e', `
  import('./src/core/banner.ts').then(({ BannerStore, newBanner }) => {
    const s = new BannerStore();
    for (const n of [4, 2, 7, 6, 5, 3, 1]) s.add(newBanner('sign', 'Sign ' + n));
    process.stdout.write(JSON.stringify({ banners: s.toJSON() }));
  });`], { encoding: 'utf8' });
const saved = await api(`/api/designs/${design.id}/scene`, reg.token, { sceneGzB64: gzipSync(Buffer.from(scene)).toString('base64') }, 'PUT');
check('seeded a public design with seven signs', !!design.id && !saved?.error, JSON.stringify(saved).slice(0, 120));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
for (const [label, viewport, lang] of [
  ['1192×688, Arabic', { width: 1192, height: 688 }, 'ar'],
  ['1192×688, English', { width: 1192, height: 688 }, 'en'],
  ['1440×900, Arabic', { width: 1440, height: 900 }, 'ar'],
  ['390×844 phone, Arabic', { width: 390, height: 844 }, 'ar'],
]) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((l) => { try { localStorage.setItem('tifo_consent_v1', 'essential'); localStorage.setItem('tifo_lang_v1', l); } catch { /* */ } }, lang);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  await p.goto(`${B}/community?t=${design.id}`, { waitUntil: 'domcontentloaded' });
  const signs = await p.waitForFunction(() => document.querySelectorAll('#cam-bar .cam-banner').length === 7, null, { timeout: 90000 }).then(() => true).catch(() => false);
  check(`${label}: a camera for each of the seven signs`, signs);
  await p.waitForTimeout(600);
  const m = await p.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, t: r.top, b: r.bottom }; };
    return {
      vw: innerWidth,
      modal: box('.modal'), side: box('.modal-side'), title: box('.side-title'), foot: box('#comment-foot'),
      bar: box('#cam-bar'), barScroll: (() => { const b = document.getElementById('cam-bar'); return b ? b.scrollWidth - b.clientWidth : 0; })(),
      order: [...document.querySelectorAll('#cam-bar .cam-banner')].map((b) => b.textContent.trim()),
      pageScroll: document.documentElement.scrollWidth - innerWidth,
    };
  });
  const inside = (x) => !!x && !!m.modal && x.l >= m.modal.l - 1 && x.r <= m.modal.r + 1 && x.l >= -1 && x.r <= m.vw + 1;
  check(`${label}: the modal fits the window`, !!m.modal && m.modal.l >= -1 && m.modal.r <= m.vw + 1, JSON.stringify(m.modal));
  check(`${label}: the title is on screen`, inside(m.title), JSON.stringify(m.title));
  check(`${label}: the comment area is on screen`, inside(m.foot), JSON.stringify(m.foot));
  if (viewport.width > 860) check(`${label}: the side panel keeps room to read (≥320px)`, (m.side?.w ?? 0) >= 320, String(m.side?.w));
  check(`${label}: the camera row stays inside the modal and scrolls instead`, inside(m.bar) && m.barScroll > 0, `overflow ${m.barScroll}px`);
  check(`${label}: no sideways page scroll`, m.pageScroll <= 1, String(m.pageScroll));
  check(`${label}: signs listed in order`, m.order.join(',') === 'Sign 1,Sign 2,Sign 3,Sign 4,Sign 5,Sign 6,Sign 7', m.order.join(','));
  await ctx.close();
}
await browser.close();
stop();
if (errs.length) console.log('page errors:\n  ' + [...new Set(errs)].join('\n  '));
check('no page errors', errs.length === 0);
console.log(`\npreview: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
