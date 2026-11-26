/**
 * Film a public TifoMaker design in Match Day with the app's own film maker.
 *
 * It copies the design (palette, every seat's colour, the ground) from
 * tifomaker.org into a local server with no database, signs a local studio
 * account into Pro preview, opens the design in the built app and exports
 * the Match Day film: drawn frame by frame and encoded to H.264, so it plays
 * smoothly however slowly this machine draws.
 *
 *   npm run build   (once)
 *   node marketing/video-studio/capture/film-design.mjs <design-id> [options]
 *
 *   --shape vertical|hd     1080×1920 (default) or 1920×1080
 *   --frames N              stop after N frames (a quick test); default: the whole film
 *   --mark                  keep the tifomaker.org mark (default: none)
 *   --credit "text"         the credit line drawn on the film, e.g. "تصميم @handle"
 *   --out file.mp4          default: marketing/video-studio/footage/<id>-<shape>.mp4
 *   --still file.png        also save a screenshot of Match Day before filming
 *
 * Only public designs whose owner has agreed to be featured should be filmed
 * for posting (see marketing/social/VIDEO-PRODUCTION.md).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const id = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));
if (!id) { console.error('usage: film-design.mjs <design-id> [--shape vertical|hd] [--frames N] [--mark] [--credit text] [--out file] [--still file]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const shape = opt('shape', 'vertical');
const frames = opt('frames') ? Number(opt('frames')) : undefined;
const mark = args.includes('--mark');
const credit = opt('credit');
const out = resolve(opt('out', `marketing/video-studio/footage/${id}-${shape}.mp4`));
const still = opt('still');
const debug = opt('debug');
const PROD = 'https://tifomaker.org';
const PORT = 8981;
const B = `http://127.0.0.1:${PORT}`;
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

// 1. The design, as tifomaker.org serves it publicly.
const src = await (await fetch(`${PROD}/api/designs/${id}`)).json();
if (!src?.cellsGzB64 || !src.templateId) { console.error('design not found or not public'); process.exit(1); }
log(`design "${src.title}" by ${src.ownerName} on ${src.templateId}`);

// 2. A local server with no database and Pro in preview for the studio account.
const logs = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'tm_studio' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => logs.push(String(d)));
server.stderr.on('data', (d) => logs.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 120; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const email = 'tm_studio@tifomaker-studio.local';
const reg = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username: 'tm_studio', password: 'harbor-kite-moss-31', email, acceptedVersion: 'studio' }) });
const token = reg.json?.token;
let code = null;
for (let i = 0; i < 40 && !code; i++) {
  const m = [...logs.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
  code = m?.[2] ?? null;
  if (!code) await new Promise((r) => setTimeout(r, 250));
}
await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) });
await api('/api/pro/gift/accept', token, { method: 'POST', body: '{}' });
const made = await api('/api/designs', token, { method: 'POST', body: JSON.stringify({ title: src.title, templateId: src.templateId, templateVersion: src.templateVersion, palette: src.palette, cellsGzB64: src.cellsGzB64 }) });
const local = made.json?.id;
if (!local) { console.error('could not copy the design', made.status, JSON.stringify(made.json)); console.error(logs.join('').slice(-1500)); process.exit(1); }
log('copied locally as', local);

// 3. The app, on software graphics, with the design open in Match Day's film maker.
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const LS = { tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1', tifo_price_ask_v1: '{"n":2,"until":0}', tifo_banner_tour_v1: '1', tifo_post_nudge_v1: '1', tifo_view_v1: '2d', mds_seen_intro: '1', mds_help_seen_v1: '1', mds_sound_v2: JSON.stringify({ on: false }), tifo_lang_v1: 'ar' };
await ctx.addInitScript(([tok, ls, frames]) => {
  try { for (const [k, v] of Object.entries(ls)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); localStorage.setItem('tifo_token_v1', tok); } catch { /* */ }
  if (typeof frames === 'number') window.__tifoFilmFrames = frames;
}, [token, LS, frames]);
const p = await ctx.newPage();
p.on('pageerror', (e) => log('page error:', String(e.message).slice(0, 160)));
await p.goto(`${B}/app?project=${local}&e2e=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => !!window.__tifo, null, { timeout: 180000 });
await p.waitForTimeout(1500);
if (still) { await p.screenshot({ path: still, timeout: 300000 }); log('still saved', still); }
log('app ready; opening the Animation panel');
await p.click('#rail-anim');
await p.waitForFunction(() => !document.getElementById('sx-size-row')?.hidden, null, { timeout: 60000 });
log('export size row shown');
await p.selectOption('#sx-size', shape === 'hd' ? 'hd' : 'vertical');
if (mark) await p.uncheck('#sx-nomark'); else await p.check('#sx-nomark');
if (credit) {
  const has = await p.$('#credit-line, [data-k="credit"]');
  if (has) await has.fill(credit); else log('no credit field found; the credit goes on in the edit instead');
}
log('filming… (software graphics: expect a few seconds a frame)');
let tick = 0;
const ticker = setInterval(async () => {
  tick++;
  const t = await p.textContent('.qv-count', { timeout: 5000 }).catch(() => null);
  const sheet = await p.evaluate(() => [...document.querySelectorAll('.pro-sheet, [role=dialog]')].filter((e) => e.offsetParent).map((e) => (e.textContent || '').trim().slice(0, 120))).catch(() => []);
  log(t ? t.trim() : 'no film card yet', sheet.length ? 'dialogs: ' + JSON.stringify(sheet) : '');
  if (debug) await p.screenshot({ path: `${debug}/tick-${String(tick).padStart(3, '0')}.png`, timeout: 120000 }).catch(() => {});
}, 60000);
const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 4 * 3600 * 1000 }), p.click('#sx-export')]);
clearInterval(ticker);
const buf = Buffer.concat(await (await dl.createReadStream()).toArray());
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
log(`saved ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
await browser.close();
stop();
process.exit(0);
