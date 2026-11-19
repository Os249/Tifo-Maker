/**
 * Renders the showcase tifos (tifos.js) with the site's real film and poster
 * code. From the repo root:
 *   npx tsx marketing/video-src/harness/run.mts preview <design> <ground id> <stand> <size> <out.jpg> [frame] [w] [h]
 *   npx tsx marketing/video-src/harness/run.mts film    <design> <ground id> <stand> <size> <out.mp4> [w] [h]
 *   npx tsx marketing/video-src/harness/run.mts poster  <design> <ground id> <stand> <outdir>
 * The pages are the repo's own shot harnesses with the tifo painter swapped.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const [mode, design, ground, standArg, ...rest] = process.argv.slice(2);
const stand = Number(standArg);
const PORT = 5300 + Math.floor(Math.random() * 300);

const swap = (file: string, out: string) => {
  let s = readFileSync(join(ROOT, 'scripts', file), 'utf8');
  s = s.replace("import { paintTifo } from '/scripts/pro-shots-tifo.js';", "import { paintTifo, useDesign } from '/marketing/video-src/harness/tifos.js';\n  window.__useDesign = useDesign;");
  s = s.replace("['#1a1d24', '#0b3d91', '#f2f1ec', '#e8b73a', '#c8102e']", 'window.__tifoPalette');
  s = s.replace('window.__teardown = ', 'window.__sim = () => sim;\n  window.__teardown = ');
  writeFileSync(join(HERE, out), s);
};
swap('pro-film-shots.html', 'film.gen.html');
swap('pro-poster-shots.html', 'poster.gen.html');

const vite = await createServer({ root: ROOT, server: { port: PORT, hmr: false }, logLevel: 'error' });
await vite.listen(PORT);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 300)));
const open = async (file: string) => {
  await page.goto(`http://127.0.0.1:${PORT}/marketing/video-src/harness/${file}`, { waitUntil: 'networkidle', timeout: 240000 });
  await page.waitForFunction(() => (window as any).__ready === true, { timeout: 240000 });
  if (design.startsWith('community:')) {
    // A published tifo, saved from GET /api/designs/<id> as <COMMUNITY dir>/<id>.json.
    const d = JSON.parse(readFileSync(join(process.env.COMMUNITY!, design.slice(10) + '.json'), 'utf8'));
    const cells = gunzipSync(Buffer.from(d.cellsGzB64, 'base64'));
    console.log(`community: ${d.title} on ${d.templateId}, ${cells.length} seats, ${d.palette.length} colours`);
    await page.evaluate((c) => { (window as any).__community = c; }, { palette: d.palette, cellsB64: cells.toString('base64') });
  }
  return page.evaluate((d) => (window as any).__useDesign(d), design);
};
const jpg = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1], 'base64');

if (mode === 'preview' || mode === 'film') {
  const [size, out, a, b, c] = rest;
  const d = await open('film.gen.html');
  const info = await page.evaluate(([id, st, sz]) => (window as any).__boot(id, st, sz, 'high'), [ground, stand, size] as const);
  console.log(JSON.stringify(info));
  if (mode === 'preview') {
    if (d.png) writeFileSync(out.replace(/\.jpg$/, '-design.png'), jpg(d.png));
    const ns = String(a ?? 330).split(',').map(Number);
    const r = await page.evaluate(([w, h, n]) => (window as any).__frames(w, h, n), [Number(b ?? 1920), Number(c ?? 1080), ns] as const);
    r.frames.forEach((f: any, i: number) => writeFileSync(i === r.frames.length - 1 ? out : out.replace(/\.jpg$/, `-${f.n}.jpg`), jpg(f.jpg)));
    console.log(`${out}: ${r.ms} ms`);
  } else {
    const r = await page.evaluate(([w, h]) => (window as any).__encode(w, h), [Number(a ?? 1920), Number(b ?? 1080)] as const);
    writeFileSync(out, Buffer.from(r.b64, 'base64'));
    console.log(`${out}: ${r.frames} frames, ${r.w}x${r.h}, ${(r.ms / 1000).toFixed(0)} s`);
  }
} else if (mode === 'clip') {
  // A stretch of the film as numbered JPEGs: <outdir>/f0001.jpg ... (frames `from`..`to` of the 390).
  const [size, outDir, from, to] = rest;
  mkdirSync(outDir, { recursive: true });
  await open('film.gen.html');
  await page.evaluate(([id, st, sz]) => (window as any).__boot(id, st, sz, 'high'), [ground, stand, size] as const);
  const all = Array.from({ length: Number(to) - Number(from) + 1 }, (_, i) => Number(from) + i);
  let k = 0;
  for (let i = 0; i < all.length; i += 24) {
    const r = await page.evaluate((only) => (window as any).__frames(1920, 1080, only), all.slice(i, i + 24));
    for (const f of r.frames) writeFileSync(join(outDir, `f${String(++k).padStart(4, '0')}.jpg`), jpg(f.jpg));
    console.log(`${design}: ${k}/${all.length}`);
  }
} else if (mode === 'fly') {
  // My own camera over a tifo, drawn frame by frame by the simulator's film host:
  //   FLY='{"n":90,"az":[250,290],"r":[1.5,1.2],"h":[1.2,0.9],"target":[0,0,0],"fov":38,"clock":[5.4,8.9]}'
  // az in degrees round the pitch, r and h in units of the bowl's half-length; clock is the
  // film's own (the cards go up from 5.6 s for 2.6 s; 99 = all up). "only" renders a few frames.
  const [size, outDir] = rest;
  mkdirSync(outDir, { recursive: true });
  await open('film.gen.html');
  await page.evaluate(([id, st, sz]) => (window as any).__boot(id, st, sz, 'high'), [ground, stand, size] as const);
  const cfg = JSON.parse(process.env.FLY!);
  // As a string: tsx's helpers for named functions do not exist in the page.
  await page.evaluate(`(async (cfg) => {
    const { filmRevealKeys } = await import('/src/render/simulator/film.ts');
    const host = window.__sim().filmHost();
    const W = cfg.pw || 1920, H = cfg.ph || 1080;
    await host.begin(W, H, 30);
    if (cfg.screens === false && host.screens) host.screens(false);
    const r = filmRevealKeys(host.map, host.painted, { kind: 'order', id: cfg.order || 'sweep-rl' });
    host.revealKeys(r.keys);
    const b = host.bounds();
    const M = Math.max(b.ax, b.bz);
    const lerp = function (v, u) { return Array.isArray(v) ? v[0] + (v[1] - v[0]) * u : v; };
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    window.__flyFrame = function (i) {
      const u = cfg.n > 1 ? i / (cfg.n - 1) : 0;
      const e = u * u * (3 - 2 * u);
      const az = lerp(cfg.az, e) * Math.PI / 180;
      const tg = cfg.target || [0, 0, 0];
      const t1 = cfg.target1 || tg;
      host.revealAt(lerp(cfg.clock === undefined ? 99 : cfg.clock, u), r.fade);
      host.haze(cfg.haze === undefined ? 0.5 : cfg.haze);
      host.frame({
        name: 'fly',
        position: [Math.cos(az) * lerp(cfg.r, e) * M, lerp(cfg.h, e) * M, Math.sin(az) * lerp(cfg.r, e) * M],
        target: [(tg[0] + (t1[0] - tg[0]) * e) * M, (tg[1] + (t1[1] - tg[1]) * e) * M, (tg[2] + (t1[2] - tg[2]) * e) * M],
        fov: lerp(cfg.fov === undefined ? 38 : cfg.fov, e),
      });
      out.getContext('2d').drawImage(host.canvas, 0, 0, W, H);
      return out.toDataURL('image/jpeg', 0.9);
    };
    window.__flyEnd = function () { host.end(); };
  })(${JSON.stringify(cfg)})`);
  console.log('bounds', JSON.stringify(await page.evaluate(`(() => { const h = window.__sim().filmHost(); return { b: h.bounds(), reach: h.outerReach(), shots: h.shots().map((s) => [s.name, s.position.map(Math.round), s.target.map(Math.round), s.fov]) }; })()`)));
  const frames: number[] = cfg.only ?? Array.from({ length: cfg.n }, (_, i) => i);
  let k = 0;
  for (const i of frames) {
    const url = await page.evaluate((n) => (window as any).__flyFrame(n), i);
    writeFileSync(join(outDir, `f${String(cfg.only ? i : ++k).padStart(4, '0')}.jpg`), jpg(url));
    if (++k % 20 === 0) console.log(`${outDir}: ${k}/${frames.length}`);
  }
  await page.evaluate(() => (window as any).__flyEnd());
} else if (mode === 'poster') {
  const [outDir] = rest;
  mkdirSync(outDir, { recursive: true });
  const d = await open('poster.gen.html');
  await page.evaluate(([id, st, pal]) => (window as any).__boot(id, st, pal), [ground, stand, d.palette] as const);
  const club = JSON.parse(process.env.CLUB!);
  const WORDS: any = {
    en: { labels: { matchday: 'Matchday', vs: 'vs' }, date: 'SAT 21 NOV', time: '20:30', headline: 'One heart. One voice.', rtl: false },
    ar: { labels: { matchday: 'يوم المباراة', vs: 'ضد' }, date: 'السبت 21 نوفمبر', time: '8:30 م', headline: 'قلب واحد، صوت واحد', rtl: true },
  };
  for (const [shape, lang, layout] of [['landscape', 'ar', 'matchday'], ['landscape', 'ar', 'minimal'], ['portrait', 'en', 'matchday'], ['portrait', 'ar', 'chant']] as const) {
    await page.evaluate(([s, r]) => (window as any).__still(s, r), [shape, WORDS[lang].rtl] as const);
    const w = WORDS[lang];
    const names = club[lang];
    const spec = { layout, club: names.club, opponent: names.opp, venue: names.venue, date: w.date, time: w.time, headline: w.headline, labels: w.labels, rtl: w.rtl };
    const r = await page.evaluate(([s, sp, c]) => (window as any).__poster(s, sp, c), [shape, spec, club] as const);
    writeFileSync(join(outDir, `poster-${layout}-${lang}-${shape}.jpg`), jpg(r.jpg));
    console.log(`poster ${layout} ${lang} ${shape}: ${r.w}x${r.h}`);
  }
}
await page.evaluate(() => (window as any).__teardown?.());
await browser.close();
await vite.close();
