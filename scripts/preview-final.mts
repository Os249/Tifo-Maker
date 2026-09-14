/** Dev-only: the two original briefs, redesigned properly, on the UNMODIFIED engine. */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/final');
const CAM = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };
type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: Array<Record<string, unknown>> };
const prep = (r: Raw): TifoSpec => {
  const v = validateSpec(r);
  if (!v.valid || !v.spec) throw new Error(`${r.title}: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
};

const SET: Array<{ key: string; stadium: string; raw: Raw }> = [
  { key: 'a5-hilal', stadium: 'community-jewel-jeddah-62k', raw: {
      title: 'زعيم آسيا', summary: 'Blue sweep wrapping the bowl, the phrase filling one end, crest medallion opposite.',
      palette: ['#262a33', '#0033a0', '#ffffff', '#d4af37', '#001d5c', '#1f6de0', '#0a1f4d'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [4, 1, 5], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        { kind: 'text', region: 'south', text: 'زعيم آسيا', colorIndex: 1, fontId: 'black', arcDeg: 0, heightFrac: 0.85, align: 'center' },
        { kind: 'fill', region: 'north', colorIndex: 4 },
        { kind: 'symbol', region: 'north', symbol: 'crescent', colorIndex: 3, scaleFrac: 0.95, align: 'center' },
        { kind: 'stripes', region: 'sides', colors: [1, 3], orientation: 'horizontal', bands: 11 },
      ] } },
  { key: 'b5-capitano', stadium: 'community-grand-national-80k', raw: {
      title: 'Il Capitano', summary: 'Gold end carrying the name in black, black end carrying the number, chevrons driving between.',
      palette: ['#262a33', '#0d0d0f', '#e8b923', '#ffffff', '#3a2f08', '#8a6a02'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [1, 4, 5], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        { kind: 'text', region: 'south', text: 'IL CAPITANO', colorIndex: 1, fontId: 'impact', arcDeg: 0, heightFrac: 0.85, align: 'center' },
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'text', region: 'north', text: 'GRAZIE 10', colorIndex: 2, fontId: 'impact', arcDeg: 0, heightFrac: 0.85, align: 'center' },
        { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
      ] } },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5205 }, logLevel: 'error' });
await vite.listen(5205);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5205/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
for (const e of SET) {
  const spec = prep(e.raw);
  const res = (await page.evaluate(([s, id, c]) => (window as never as { __shot:(a:unknown,b:unknown,c:unknown)=>Promise<unknown> }).__shot(s, id, c),
    [spec, e.stadium, CAM] as [TifoSpec, string, typeof CAM])) as { ok: boolean; shot?: string; flat?: string; errors?: unknown };
  if (!res.ok) { console.error(`FAIL ${e.key}`, res.errors); continue; }
  writeFileSync(`${OUT}/${e.key}-bowl.png`, Buffer.from(res.shot!.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${e.key}-flat.png`, Buffer.from(res.flat!.split(',')[1], 'base64'));
  console.log('OK ', e.key);
}
await browser.close(); await vite.close();
