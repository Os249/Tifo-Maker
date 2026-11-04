/**
 * Dev-only: the Pro voices (and candidates for more) measured on seats.
 *   npx tsx scripts/pro-font-seats.mts measure OUT.json [faces]
 *   npx tsx scripts/pro-font-seats.mts sheets OUTDIR [faces]
 *
 * `measure`: each face, each test word, letter heights 6..44 rows, as drawn
 * and as the product thickens it (core/seatText growRows). For every one: how
 * many of its seats sit in strokes under 3 seats (core/analysis), whether its
 * counters stay open, whether a letter breaks in two or a dot is lost, and
 * its thinnest stroke in rows. That is what SEAT_FLOORS is set from.
 *
 * `sheets`: one specimen sheet per face: an Arabic and a Latin word on four
 * real stands (about 12, 20, 35 and 60 rows), each card drawn as itself, and
 * the smallest stand again with 10% of the cards not held up.
 *
 * Candidates are read from CAND (a folder holding @fontsource packages that
 * are not installed here), served to the page under /cand/.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAND = process.env.CAND ?? '';
const [mode = 'measure', outArg = 'preview-out/pro-font-seats', facesArg = ''] = process.argv.slice(2);

interface Face { id: string; name: string; voice?: string; family: string; ar?: string; lat?: string; tier: 'free' | 'pro' | 'cand' }

const FREE = ['poster', 'kufi', 'condensed', 'slab', 'sign', 'grotesk'];
const PRO = ['block', 'stencil', 'rounded', 'pixel', 'gothic', 'heritage', 'marker', 'classic', 'ruqaa'];
/** Candidates: package, Arabic weight, Latin weight. */
const CANDS: Array<[string, string, string]> = [
  ['jomhuria', '400', '400'], ['katibeh', '400', '400'], ['blaka', '400', '400'], ['badeen-display', '400', '400'],
  ['handjet', '900', '900'], ['el-messiri', '700', '700'], ['baloo-bhaijaan-2', '800', '800'], ['mada', '900', '900'],
  ['oi', '400', '400'], ['vibes', '400', '400'], ['qahiri', '400', '400'], ['ruwudu', '700', '700'],
  ['rubik', '900', '900'], ['alexandria', '900', '900'], ['zain', '900', '900'], ['mirza', '700', '700'],
  ['aref-ruqaa', '700', '700'], ['reem-kufi-fun', '700', '700'], ['playpen-sans-arabic', '800', '800'],
];

function faces(): Face[] {
  const out: Face[] = [];
  for (const v of FREE) out.push({ id: v, name: v, voice: v, family: '', tier: 'free' });
  for (const v of PRO) out.push({ id: v, name: v, voice: v, family: '', tier: 'pro' });
  if (CAND) {
    for (const [pkg, wa, wl] of CANDS) {
      const dir = resolve(CAND, 'node_modules/@fontsource', pkg, 'files');
      const ar = `${pkg}-arabic-${wa}-normal.woff2`;
      const lat = `${pkg}-latin-${wl}-normal.woff2`;
      if (!existsSync(resolve(dir, ar))) continue;
      out.push({ id: pkg, name: pkg, family: `Cand_${pkg.replace(/-/g, '_')}`, ar: `/cand/${pkg}/${ar}`, lat: existsSync(resolve(dir, lat)) ? `/cand/${pkg}/${lat}` : undefined, tier: 'cand' });
    }
  }
  const want = facesArg ? new Set(facesArg.split(',')) : null;
  return want ? out.filter((f) => want.has(f.id)) : out;
}

const WORDS = { ar: ['الزعيم', 'نادي القرن', 'زعيم آسيا'], lat: ['CHAMPIONS', 'FORZA', 'ULTRAS'] };
const HEIGHTS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 34, 38, 44];
/** Four stands, about 12, 20, 35 and 60 rows: [stadium, tier, stand]. */
const STANDS: Array<[string, number, number, string]> = [
  ['alfaisal-jeddah-27k', 1, 2, 'Prince Abdullah Al-Faisal, upper west (12 rows)'],
  ['pmbf-stadium-22k-rb', 0, 1, 'Prince Mohammed bin Fahd, north (22 rows)'],
  ['buraidah-stadium-25k-rb', 0, 1, 'Buraidah, north (34 rows)'],
  ['anfield-61k', 1, 2, 'Anfield, upper west (62 rows)'],
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5261 }, logLevel: 'error' });
await vite.listen(5261);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text().slice(0, 200)); });
if (CAND) {
  await page.route('**/cand/**', (route) => {
    const u = new URL(route.request().url());
    const [, , pkg, file] = u.pathname.split('/');
    const p = resolve(CAND, 'node_modules/@fontsource', pkg, 'files', file);
    if (!existsSync(p)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, body: readFileSync(p), headers: { 'content-type': 'font/woff2' } });
  });
}
await page.goto('http://127.0.0.1:5261/scripts/pro-font-seats.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });
const FACES = faces();
console.log(`${FACES.length} faces; ${await page.evaluate((l) => (window as never as { __faces: (x: unknown) => Promise<number> }).__faces(l), FACES as unknown)} faces loaded`);

type W = { __banner: (...a: unknown[]) => unknown; __measure: (...a: unknown[]) => unknown; __onStand: (...a: unknown[]) => { png: string; glyphRows: number; standRows: number; grow: number; seats: number }; __smooth: (...a: unknown[]) => string };
const call = <T,>(fn: keyof W, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => ((window as never as Record<string, (...x: unknown[]) => unknown>)[f as string])(...(a as unknown[])), [fn, args] as const) as Promise<T>;

if (mode === 'measure') {
  const rows: unknown[] = [];
  for (const f of FACES) {
    for (const script of ['ar', 'lat'] as const) {
      for (const w of WORDS[script]) {
        for (const h of HEIGHTS) {
          for (const grow of (process.env.GROWS ?? '0,0.2,0.4,0.6').split(',').map((g) => (g === 'auto' ? g : Number(g)))) {
            const r = await call<Record<string, unknown> | null>('__measure', f, w, h, grow);
            if (r) rows.push({ face: f.id, tier: f.tier, script, word: w, h, growArg: grow, ...r });
          }
        }
      }
    }
    console.log('measured', f.id);
  }
  mkdirSync(dirname(resolve(outArg)), { recursive: true });
  writeFileSync(outArg, JSON.stringify(rows));
  console.log(`${rows.length} rows -> ${outArg}`);
} else if (mode === 'banners') {
  // Every face on a stand banner, drawn as the Banner view draws one.
  const figs: string[] = [];
  const COLS: Array<[string, string]> = [['#0b6b3a', '#f6f3ea'], ['#123a8c', '#f2c230'], ['#a3121f', '#ffffff']];
  let n = 0;
  for (const f of FACES) {
    const [bg, ink] = COLS[n++ % COLS.length];
    const png = await call<string>('__banner', f, 'زعيم آسيا', 'ULTRAS 1957', bg, ink);
    figs.push(`<figure><img src="${png}"><figcaption>${f.name}${f.tier === 'pro' && ['classic', 'ruqaa'].includes(f.id) ? ' (banners only)' : ''}</figcaption></figure>`);
  }
  const sheet = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await sheet.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:14px;background:#14161b;color:#e8e6df;font:14px system-ui}.row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}figure{margin:0}img{width:100%;display:block;border-radius:4px}figcaption{margin-top:4px;opacity:.85}</style><h2 style="margin:0 0 10px;font-size:18px">The Pro voices on banners (the Banner view's renderer)</h2><div class="row">${figs.join('')}</div>`, { waitUntil: 'load' });
  await sheet.screenshot({ path: outArg, fullPage: true });
  console.log('banners ->', outArg);
} else if (mode === 'zoom') {
  // ZOOM="face|word|stand index|rows,rows|grow,grow": one strip of crops.
  const [fid, word, si, rowsS, growsS] = (process.env.ZOOM ?? '').split('|');
  const f = FACES.find((x) => x.id === fid)!;
  const [sid, tier, stand] = STANDS[Number(si)];
  const figs: string[] = [];
  for (const h of rowsS.split(',').map(Number)) {
    for (const g of growsS.split(',')) {
      const r = await call<{ png: string; glyphRows: number; grow: number }>('__onStand', f, word, sid, tier, stand, { k: 2, crop: true, glyphRows: h, grow: g === 'auto' ? 'auto' : Number(g), noShow: Number(process.env.NOSHOW ?? 0) });
      figs.push(`<figure><img src="${r.png}"><figcaption>${fid} ${h} rows, grow ${r.grow}</figcaption></figure>`);
    }
  }
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await sheet.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:10px;background:#14161b;color:#e8e6df;font:13px system-ui}.row{display:flex;flex-wrap:wrap;gap:10px}figure{margin:0}figcaption{opacity:.8}</style><div class="row">${figs.join('')}</div>`, { waitUntil: 'load' });
  await sheet.screenshot({ path: outArg, fullPage: true });
  console.log('zoom ->', outArg);
} else {
  mkdirSync(outArg, { recursive: true });
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  for (const f of FACES) {
    const cells: string[] = [];
    for (const script of ['ar', 'lat'] as const) {
      const word = WORDS[script][2];
      // Seat-aware for the Pro voices and the candidates; the free voices as they are drawn.
      const floor = f.tier === 'free' ? 0 : 'auto';
      const row: string[] = [];
      const fig = (png: string, cap: string): string => `<figure><img src="${png}"><figcaption>${cap}</figcaption></figure>`;
      const [s0, t0, st0] = STANDS[0];
      const plain = await call<{ png: string; glyphRows: number }>('__onStand', f, word, s0, t0, st0, { k: 1.5, crop: true, grow: 0 });
      row.push(fig(plain.png, `12 rows, as drawn: letters ${plain.glyphRows} rows`));
      for (const [sid, tier, stand, label] of STANDS) {
        const r = await call<{ png: string; glyphRows: number; standRows: number; grow: number }>('__onStand', f, word, sid, tier, stand, { k: 1.5, crop: true, grow: floor });
        row.push(fig(r.png, `${label}: letters ${r.glyphRows} rows${r.grow ? ', seat-aware' : ''}`));
        if (sid === s0 && tier === t0 && stand === st0) {
          const ns = await call<{ png: string }>('__onStand', f, word, sid, tier, stand, { k: 1.5, crop: true, grow: floor, noShow: 0.1 });
          row.push(fig(ns.png, '…and with 1 card in 10 not held up'));
        }
      }
      const smooth = await call<string>('__smooth', f, word, 64);
      cells.push(`<section><h2><img class="sm" src="${smooth}"> ${script === 'ar' ? 'Arabic' : 'Latin'}: ${word}</h2><div class="row">${row.join('')}</div></section>`);
    }
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:16px;background:#14161b;color:#e8e6df;font:13px system-ui}
      h1{font-size:20px;margin:0 0 8px} h2{font-size:14px;margin:12px 0 6px;display:flex;align-items:center;gap:10px}
      .sm{height:40px} .row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
      figure{margin:0} figure img{display:block;max-width:770px;max-height:420px;image-rendering:pixelated} figcaption{opacity:.8;margin-top:3px}
    </style><h1>${f.name} (${f.tier}) on seats</h1>${cells.join('')}`;
    await sheet.setContent(html, { waitUntil: 'load' });
    await sheet.screenshot({ path: resolve(outArg, `${f.id}.png`), fullPage: true });
    console.log('sheet', f.id);
  }
}
await browser.close();
await vite.close();
