/**
 * Renders the showcase tifos (tifos.js) with the site's real film and poster
 * code. From the repo root:
 *   npx tsx marketing/video-src/harness/run.mts preview <design> <ground id> <stand> <size> <out.jpg> [frame] [w] [h]
 *   npx tsx marketing/video-src/harness/run.mts film    <design> <ground id> <stand> <size> <out.mp4> [w] [h]
 *   npx tsx marketing/video-src/harness/run.mts poster  <design> <ground id> <stand> <outdir>
 * The pages are the repo's own shot harnesses with the tifo painter swapped.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
  return page.evaluate((d) => (window as any).__useDesign(d), design);
};
const jpg = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1], 'base64');

if (mode === 'preview' || mode === 'film') {
  const [size, out, a, b, c] = rest;
  const d = await open('film.gen.html');
  const info = await page.evaluate(([id, st, sz]) => (window as any).__boot(id, st, sz, 'high'), [ground, stand, size] as const);
  console.log(JSON.stringify(info));
  if (mode === 'preview') {
    writeFileSync(out.replace(/\.jpg$/, '-design.png'), jpg(d.png));
    const r = await page.evaluate(([w, h, n]) => (window as any).__frames(w, h, [n]), [Number(b ?? 1920), Number(c ?? 1080), Number(a ?? 330)] as const);
    writeFileSync(out, jpg(r.frames[0].jpg));
    console.log(`${out}: ${r.ms} ms`);
  } else {
    const r = await page.evaluate(([w, h]) => (window as any).__encode(w, h), [Number(a ?? 1920), Number(b ?? 1080)] as const);
    writeFileSync(out, Buffer.from(r.b64, 'base64'));
    console.log(`${out}: ${r.frames} frames, ${r.w}x${r.h}, ${(r.ms / 1000).toFixed(0)} s`);
  }
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
