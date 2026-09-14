/**
 * Dev-only: one design per shipped VOICE, alternating Arabic and English, so a
 * font set can be judged on the bowl rather than on a specimen sheet.
 *   npx tsx scripts/preview-voices.mts
 * Runs against the shipped engine — no patch needed.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.env.OUT_DIR ?? 'preview-out/voices');
const TV = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };
type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: Array<Record<string, unknown>> };
const prep = (r: Raw): TifoSpec => {
  const v = validateSpec(r);
  if (!v.valid || !v.spec) throw new Error(`${r.title}: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
};
// Outline must scale with how fat the glyphs already are: a short word at full
// stand height has thick strokes, and a fixed stroke merges the letters shut.
const headline = (region: string, text: string, fill: number, edge: number, font: string, h = 0.8) => ([
  { kind: 'text', region, text, colorIndex: edge, fontId: font, arcDeg: 0, heightFrac: h, align: 'center',
    outline: Math.max(2, Math.min(7, Math.round(text.replace(/\s/g, '').length * 0.6))) },
  { kind: 'text', region, text, colorIndex: fill, fontId: font, arcDeg: 0, heightFrac: h, align: 'center' },
]);

const JEDDAH = 'community-jewel-jeddah-62k', GRAND = 'community-grand-national-80k';
interface Item { key: string; voice: string; pair: string; stadium: string; script: string; raw: Raw }

const SET: Item[] = [
  { key: 'w1-impact', voice: 'Impact', pair: 'Passion One + Cairo 900', stadium: JEDDAH, script: 'Arabic',
    raw: { title: 'زعيم آسيا', summary: 'Impact voice.', palette: ['#262a33','#0033a0','#ffffff','#d4af37','#001d5c','#2f7bee'],
      layers: [ { kind:'gradient', region:'all', colors:[5,1,4,1], direction:'horizontal' },
        { kind:'fill', region:'south', colorIndex:2 }, ...headline('south','زعيم آسيا',1,3,'poster'),
        { kind:'fill', region:'north', colorIndex:4 },
        { kind:'symbol', region:'north', symbol:'crescent', colorIndex:3, scaleFrac:0.92, align:'center', wide:3 },
        { kind:'stripes', region:'sides', colors:[1,3], orientation:'horizontal', bands:13 } ] } },

  { key: 'w2-kufi', voice: 'Kufi', pair: 'Kufam 900 — one family, both scripts', stadium: GRAND, script: 'Arabic',
    raw: { title: 'عميد الأندية', summary: 'Kufi voice.', palette: ['#262a33','#0d0d0f','#f2b705','#ffffff','#7a5c02'],
      layers: [ { kind:'gradient', region:'all', colors:[4,1,2,1], direction:'horizontal' },
        { kind:'fill', region:'south', colorIndex:2 }, ...headline('south','عميد الأندية',1,3,'kufi',0.78),
        { kind:'fill', region:'north', colorIndex:1 },
        { kind:'symbol', region:'north', symbol:'eagle', colorIndex:2, scaleFrac:0.95, align:'center', wide:3.4 },
        { kind:'pattern', region:'sides', pattern:'chevron', colors:[1,2], scale:14 } ] } },

  { key: 'w3-condensed', voice: 'Condensed', pair: 'Anton + Noto Kufi Arabic 900', stadium: GRAND, script: 'English',
    raw: { title: 'Grazie Capitano', summary: 'Condensed voice.', palette: ['#262a33','#0d0d0f','#e8b923','#ffffff','#3a2f08','#8a6a02'],
      layers: [ { kind:'gradient', region:'all', colors:[1,4,5,1], direction:'horizontal' },
        { kind:'fill', region:'south', colorIndex:2 }, ...headline('south','GRAZIE CAPITANO',1,3,'condensed'),
        { kind:'fill', region:'north', colorIndex:1 }, ...headline('north','NUMERO 10',2,3,'condensed',0.82),
        { kind:'pattern', region:'sides', pattern:'chevron', colors:[1,2], scale:12 } ] } },

  { key: 'w4-slab', voice: 'Slab', pair: 'Alfa Slab One + Almarai 800', stadium: JEDDAH, script: 'English',
    raw: { title: 'One Hundred Years', summary: 'Slab voice.', palette: ['#262a33','#00843d','#ffffff','#ffd200','#013d1d'],
      layers: [ { kind:'gradient', region:'all', colors:[4,1,4,1], direction:'horizontal' },
        { kind:'fill', region:'south', colorIndex:3 }, ...headline('south','100 YEARS',4,2,'slab'),
        { kind:'fill', region:'north', colorIndex:4 },
        { kind:'symbol', region:'north', symbol:'shield', colorIndex:3, scaleFrac:0.9, align:'center', wide:2.8 },
        { kind:'stripes', region:'sides', colors:[1,2], orientation:'horizontal', bands:11 } ] } },

  { key: 'w5-signage', voice: 'Signage', pair: 'Bungee + Changa 800', stadium: GRAND, script: 'English',
    raw: { title: 'This Is Our City', summary: 'Signage voice.', palette: ['#262a33','#c8102e','#ffffff','#5c0713','#111318'],
      layers: [ { kind:'gradient', region:'all', colors:[3,1,4,1], direction:'horizontal' },
        { kind:'fill', region:'south', colorIndex:1 }, ...headline('south','OUR CITY',2,4,'sign'),
        { kind:'fill', region:'north', colorIndex:4 },
        { kind:'symbol', region:'north', symbol:'fist', colorIndex:2, scaleFrac:0.9, align:'center', wide:2.6 },
        { kind:'stripes', region:'sides', colors:[1,3], orientation:'diagonal', bands:9 } ] } },

  { key: 'w6-grotesk', voice: 'Grotesk', pair: 'Archivo Black + Tajawal 900', stadium: JEDDAH, script: 'Arabic',
    raw: { title: 'الراقي', summary: 'Grotesk voice.', palette: ['#262a33','#0a7d3e','#ffffff','#04341c','#13a457','#062a13'],
      layers: [ { kind:'gradient', region:'all', colors:[3,1,5,1], direction:'horizontal' },
        { kind:'fill', region:'south', colorIndex:2 }, ...headline('south','الراقي',1,3,'poster'),
        { kind:'fill', region:'north', colorIndex:3 }, ...headline('north','AHLI',2,1,'poster'),
        { kind:'stripes', region:'sides', colors:[1,2], orientation:'horizontal', bands:12 } ] } },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5208 }, logLevel: 'error' });
await vite.listen(5208);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5208/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
const manifest: unknown[] = [];
for (const e of SET) {
  const spec = prep(e.raw);
  const res = (await page.evaluate(([s, id, c]) => (window as never as { __shot:(a:unknown,b:unknown,c:unknown)=>Promise<unknown> }).__shot(s, id, c),
    [spec, e.stadium, TV] as [TifoSpec, string, typeof TV])) as { ok: boolean; shot?: string; flat?: string; errors?: unknown };
  if (!res.ok) { console.error(`FAIL ${e.key}`, res.errors); continue; }
  writeFileSync(`${OUT}/${e.key}-bowl.png`, Buffer.from(res.shot!.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${e.key}-flat.png`, Buffer.from(res.flat!.split(',')[1], 'base64'));
  manifest.push({ key: e.key, voice: e.voice, pair: e.pair, script: e.script, title: spec.title, palette: spec.palette });
  console.log(`OK  ${e.voice.padEnd(10)} ${e.pair}`);
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
await browser.close(); await vite.close();
