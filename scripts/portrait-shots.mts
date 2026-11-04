/**
 * Dev-only: portrait styles on real stands, seat by seat, for the eye.
 *   PHOTOS=/path/to/portraits CUTS=/path/to/cutouts OUT=/path/to/tiles \
 *     npx tsx scripts/portrait-shots.mts [photo,photo...]
 *
 * Boots the REAL pipeline in Chromium (scripts/portrait-shots.html): the face
 * and the subject found in the browser, the crop and size for the stand, the
 * style drawn by ensureGrid and stamped on the stand's own seat map. Writes
 * one PNG per photo, stand and style (the free Original first) and a JSON of
 * what each did: the crop, where the subject came from, seats painted, and
 * seats in a run under three (core/analysis.ts findFragileSeats), which
 * should be none.
 *
 * The photos are not part of the repo and never go into it: PHOTOS points at
 * a folder of them, OUT at where the tiles go.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHOTOS = process.env.PHOTOS ?? '';
const CUTS = process.env.CUTS ?? '';
const OUT = process.env.OUT ?? resolve(ROOT, 'preview-out/portraits');
if (!PHOTOS) throw new Error('PHOTOS= a folder of portraits');

/** Five stand sizes: four Saudi grounds and one big European one. */
const STANDS = [
  { key: '10', ground: 'majmaah-stadium-7k-rb', stand: 'north', tier: 'all', name: 'Majmaah north, 10 rows' },
  { key: '12', ground: 'kingdom-arena-26k-rb', stand: 'south', tier: 'all', name: 'Kingdom Arena south, 12 rows' },
  { key: '22', ground: 'jewel-jeddah-60k-rb', stand: 'north', tier: 1, name: 'Jewel north upper, 22 rows' },
  { key: '31', ground: 'alawwal-park-26k-rb', stand: 'north', tier: 'all', name: 'Al-Awwal Park north, 31 rows' },
  { key: '42', ground: 'kingdom-arena-26k-rb', stand: 'west', tier: 'all', name: 'Kingdom Arena west, 42 rows' },
  { key: '60', ground: 'camp-nou-63k', stand: 'north', tier: 'all', name: 'Camp Nou north, 60 rows' },
];

/** Club palettes (slot 0 is the empty seat), turned through by photo; `base` is the stand's field. */
const PALETTES = [
  { name: 'blue/white', palette: ['#262a33', '#1252a3', '#ffffff', '#111111', '#e8b73a'], base: 1 },
  { name: 'yellow/black', palette: ['#262a33', '#f2c400', '#111111', '#ffffff'], base: 1 },
  { name: 'green/white', palette: ['#262a33', '#0b6b3a', '#ffffff', '#111111', '#7dc242'], base: 1 },
  { name: 'yellow/blue', palette: ['#262a33', '#ffd200', '#1b3c8c', '#ffffff', '#111111'], base: 2 },
  { name: 'red/white', palette: ['#262a33', '#c8102e', '#ffffff', '#111111'], base: 1 },
];

const DEFAULT = 'asia0,beard0,beard2,beard3,beard6,boy0,boy1,boy4,p0,p1,p10,p3,p5,p7,p8,smile3,w5,w6,x5,p6';
const photos = (process.argv[2] ?? DEFAULT).split(',').filter(Boolean);
const STYLES = ['', 'stencil', 'poster3', 'duotone', 'pop'];
const standKeys = (process.env.STANDS ?? '').split(',').filter(Boolean);

// No reload while it runs: an edit to src/ elsewhere must not pull the page out from under it.
const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5241, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await vite.listen(5241);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 300)); });
await page.route('**/__photos/**', (r) => r.fulfill({ body: readFileSync(join(PHOTOS, decodeURIComponent(r.request().url().split('/__photos/')[1]))), contentType: 'image/jpeg' }));
await page.route('**/__cuts/**', (r) => r.fulfill({ body: readFileSync(join(CUTS, decodeURIComponent(r.request().url().split('/__cuts/')[1]))), contentType: 'image/png' }));
await page.goto('http://127.0.0.1:5241/scripts/portrait-shots.html', { waitUntil: 'networkidle', timeout: 240000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 240000 });

mkdirSync(OUT, { recursive: true });
const save = (name: string, url: string): void => writeFileSync(join(OUT, name), Buffer.from(url.split(',')[1], 'base64'));
const MODE = process.env.MODE ?? 'portraits';
if (MODE === 'three') {
  // MODE=three: one photo per style on a stand, in the 3D view from across the pitch.
  const st = STANDS.find((x) => x.key === (process.env.STAND ?? '42'))!;
  for (const [n, photo] of photos.entries()) {
    const pal = PALETTES[(Number(process.env.PALETTE) || n) % PALETTES.length];
    const cut = CUTS && existsSync(join(CUTS, `${photo}.png`)) ? `/__cuts/${photo}.png` : '';
    for (const style of (process.env.STYLES ?? 'stencil,poster3').split(',')) {
      const r = (await page.evaluate((job) => (window as never as { __three: (j: unknown) => Promise<{ png: string }> }).__three(job),
        { photo: `/__photos/${photo}.jpg`, cut, stand: st, palette: pal.palette, base: pal.base, style, banner: process.env.BANNER ?? '', fov: Number(process.env.FOV) || undefined, tv: !!process.env.TV, words: process.env.WORDS ?? '' })) as { png: string; plan: unknown; fov: number | null };
      save(`three-${photo}-${st.key}-${style}${process.env.BANNER ? `-${process.env.BANNER}` : ''}.png`, r.png);
      console.log('3D', photo, st.key, style, JSON.stringify(r.plan), r.fov ? `tv fov ${r.fov.toFixed(1)}` : '');
    }
  }
  await browser.close();
  await vite.close();
  process.exit(0);
}
if (MODE === 'cutout' || MODE === 'ai') {
  // MODE=cutout: each photo's cut-out as the model gave it and cleaned, on a banner and on a stand.
  // MODE=ai: stand-in AI pictures before and after (CUTS gives the Pro cut-outs).
  const st = STANDS.find((x) => x.key === (process.env.STAND ?? '31'))!;
  const out: unknown[] = [];
  for (const [n, photo] of photos.entries()) {
    const pal = PALETTES[n % PALETTES.length];
    const cut = CUTS && existsSync(join(CUTS, `${photo}.png`)) ? `/__cuts/${photo}.png` : '';
    if (MODE === 'cutout' && !cut) continue;
    const fn = MODE === 'cutout' ? '__cutout' : '__ai';
    const r = (await page.evaluate(([f, job]) => (window as never as Record<string, (j: unknown) => Promise<unknown>>)[f as string](job),
      [fn, { photo: `/__photos/${photo}.jpg`, cut, stand: st, palette: pal.palette, base: pal.base, banner: pal.palette[pal.base] }] as const)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string') save(`${MODE}-${photo}-${k}.png`, v);
      else if (v && typeof v === 'object' && 'png' in v) save(`${MODE}-${photo}-${k}.png`, (v as { png: string }).png);
    }
    const stats = Object.fromEntries(Object.entries(r).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, 'png' in (v as object) ? { fragile: (v as { fragile: number }).fragile, seats: (v as { seats: number }).seats } : v]));
    out.push({ photo, ...stats });
    console.log(photo.padEnd(10), JSON.stringify(stats));
  }
  writeFileSync(join(OUT, `${MODE}-report.json`), JSON.stringify(out, null, 1));
  await browser.close();
  await vite.close();
  process.exit(0);
}
const report: unknown[] = [];
for (const [n, photo] of photos.entries()) {
  const pal = PALETTES[n % PALETTES.length];
  const cut = CUTS && existsSync(join(CUTS, `${photo}.png`)) && process.env.SUBJECT !== 'local' ? `/__cuts/${photo}.png` : '';
  for (const st of STANDS) {
    if (standKeys.length && !standKeys.includes(st.key)) continue;
    const r = (await page.evaluate(
      (job) => (window as never as { __render: (j: unknown) => Promise<unknown> }).__render(job),
      { photo: `/__photos/${photo}.jpg`, cut, stand: st, palette: pal.palette, base: pal.base, styles: STYLES, withPrep: true, cw: 4 },
    )) as { shape: unknown; kind: string; prep: unknown; prepPng: string | null; grid: unknown; tiles: { style: string; png: string; seats: number; fragile: number; grid: string }[] };
    if (r.grid) writeFileSync(join(OUT, `${photo}-${st.key}-grid.json`), JSON.stringify(r.grid));
    for (const t of r.tiles) writeFileSync(join(OUT, `${photo}-${st.key}-${t.style || 'original'}.png`), Buffer.from(t.png.split(',')[1], 'base64'));
    if (r.prepPng) writeFileSync(join(OUT, `${photo}-${st.key}-prep.png`), Buffer.from(r.prepPng.split(',')[1], 'base64'));
    report.push({ photo, stand: st.key, palette: pal.name, kind: r.kind, shape: r.shape, prep: r.prep, tiles: r.tiles.map((t) => ({ style: t.style || 'original', seats: t.seats, fragile: t.fragile, grid: t.grid })) });
    const frag = r.tiles.filter((t) => t.style).map((t) => `${t.style}:${t.fragile}`).join(' ');
    console.log(`${photo.padEnd(8)} ${st.key}r ${r.kind.padEnd(10)} ${JSON.stringify(r.prep)}  fragile ${frag}  (original ${r.tiles[0].fragile}/${r.tiles[0].seats})`);
  }
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
await browser.close();
await vite.close();
