/**
 * Dev-only: what a finished one-prompt design could look like with the whole
 * plan in — shipped display faces, outlined headlines, wide crests, bowl-wide
 * sweeps, 7-colour palettes, and a copywriter stage choosing the words.
 *   npx tsx scripts/preview-vision.mts
 * Runs against the shipped engine.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.env.OUT_DIR ?? 'preview-out/vision');
const TV = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };
type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: Array<Record<string, unknown>> };
const prep = (r: Raw): TifoSpec => {
  const v = validateSpec(r);
  if (!v.valid || !v.spec) throw new Error(`${r.title}: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
};
/** An outlined headline = a fattened copy underneath a plain one. */
const headline = (region: string, text: string, fill: number, edge: number, opts: { font?: string; h?: number; stretch?: number } = {}) => ([
  { kind: 'text', region, text, colorIndex: edge, fontId: opts.font ?? 'impact', arcDeg: 0,
    heightFrac: opts.h ?? 0.82, align: 'center', outline: 7, stretch: opts.stretch ?? 1 },
  { kind: 'text', region, text, colorIndex: fill, fontId: opts.font ?? 'impact', arcDeg: 0,
    heightFrac: opts.h ?? 0.82, align: 'center', stretch: opts.stretch ?? 1 },
]);

interface Item { key: string; stadium: string; prompt: string; phrase: string; raw: Raw }
const SET: Item[] = [
  { key: 'v1-hilal', stadium: 'community-jewel-jeddah-62k',
    prompt: 'الهلال بطل آسيا — تيفو يملأ الملعب كله',
    phrase: 'زعيم آسيا  ·  "Leader of Asia" — the club’s own nickname, not its name',
    raw: { title: 'زعيم آسيا', summary: 'Blue sweep wrapping the bowl; gold-edged Kufi headline; crescent spanning the far end.',
      palette: ['#262a33', '#0033a0', '#ffffff', '#d4af37', '#001d5c', '#2f7bee', '#0a1f4d'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [6, 1, 5, 1], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        ...headline('south', 'زعيم آسيا', 1, 3, { font: 'black', h: 0.8 }),
        { kind: 'fill', region: 'north', colorIndex: 4 },
        { kind: 'symbol', region: 'north', symbol: 'crescent', colorIndex: 3, scaleFrac: 0.92, align: 'center', wide: 3 },
        { kind: 'stripes', region: 'sides', colors: [1, 3], orientation: 'horizontal', bands: 13 },
      ] } },

  { key: 'v2-capitano', stadium: 'community-grand-national-80k',
    prompt: "Derby night, our captain's last game — number 10 and his name, black and gold",
    phrase: 'GRAZIE CAPITANO  ·  a farewell, not a squad number',
    raw: { title: 'Grazie Capitano', summary: 'Gold end carrying the farewell in outlined black; the number opposite; chevrons between.',
      palette: ['#262a33', '#0d0d0f', '#e8b923', '#ffffff', '#3a2f08', '#8a6a02'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [1, 4, 5, 1], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        ...headline('south', 'GRAZIE CAPITANO', 1, 3, { h: 0.8 }),
        { kind: 'fill', region: 'north', colorIndex: 1 },
        ...headline('north', 'NUMERO 10', 2, 3, { h: 0.82, stretch: 1.6 }),
        { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
      ] } },

  { key: 'v3-ittihad', stadium: 'community-grand-national-80k',
    prompt: 'اتحاد جدة ليلة الديربي — نريد شيء يرعب الخصم',
    phrase: 'عميد الأندية  ·  "Dean of the clubs" — the terrace chant, not the fixture',
    raw: { title: 'عميد الأندية', summary: 'Black and gold ramp, wide eagle on one end, Kufi headline on the other.',
      palette: ['#262a33', '#0d0d0f', '#f2b705', '#ffffff', '#7a5c02', '#3a2f08'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [5, 4, 2, 4], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        ...headline('south', 'عميد الأندية', 1, 3, { font: 'black', h: 0.78 }),
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'symbol', region: 'north', symbol: 'eagle', colorIndex: 2, scaleFrac: 0.95, align: 'center', wide: 3.4 },
        { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 14 },
      ] } },

  { key: 'v4-city', stadium: 'community-jewel-jeddah-62k',
    prompt: 'derby against our rivals, we want the whole ground to feel like a threat, red and white',
    phrase: 'THIS IS OUR CITY  ·  a claim, not a club name',
    raw: { title: 'This Is Our City', summary: 'Crimson ramp wrapping the bowl, white outlined claim, shield spanning the opposite end.',
      palette: ['#262a33', '#c8102e', '#ffffff', '#5c0713', '#111318', '#8c0c20'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [3, 1, 5, 3], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 4 },
        ...headline('south', 'THIS IS OUR CITY', 2, 1, { h: 0.8 }),
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'symbol', region: 'north', symbol: 'shield', colorIndex: 2, scaleFrac: 0.9, align: 'center', wide: 2.8 },
        { kind: 'stripes', region: 'sides', colors: [1, 3], orientation: 'diagonal', bands: 9 },
      ] } },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5206 }, logLevel: 'error' });
await vite.listen(5206);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5206/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });
console.log('fonts:', await page.evaluate(() => (window as never as { __fonts?: string }).__fonts));

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
  manifest.push({ key: e.key, prompt: e.prompt, phrase: e.phrase, title: spec.title, summary: spec.summary, palette: spec.palette });
  console.log('OK ', e.key);
}
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
await browser.close(); await vite.close();
