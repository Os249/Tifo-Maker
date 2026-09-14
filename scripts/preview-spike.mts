/** Dev-only spike: reference-grade attempts with the width-fill + webfont patch. */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.env.OUT_DIR ?? 'preview-out/spike');
const CAM = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };

type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: Array<Record<string, unknown>> };
const prep = (r: Raw): TifoSpec => {
  const v = validateSpec(r);
  if (!v.valid || !v.spec) throw new Error(`${r.title}: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
};

const SET: Array<{ key: string; stadium: string; raw: Raw }> = [
  {
    key: 'r1-sweep', stadium: 'community-grand-national-80k',
    raw: {
      title: 'Feuer', summary: 'Flag sweep wrapping the bowl, wordmark filling the far stand.',
      palette: ['#262a33', '#b4141c', '#e8531f', '#f2b705', '#ffffff', '#111318'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [1, 2, 3], direction: 'horizontal' },
        { kind: 'fill', region: 'south', colorIndex: 5 },
        { kind: 'text', region: 'south', text: 'BERLIN', colorIndex: 4, fontId: 'impact', arcDeg: 0, heightFrac: 0.8, align: 'center' },
      ],
    },
  },
  {
    key: 'r2-kufi', stadium: 'community-jewel-jeddah-62k',
    raw: {
      title: 'العميد', summary: 'Black and gold field, Kufi slogan filling the lower band.',
      palette: ['#262a33', '#0d0d0f', '#f2b705', '#ffffff', '#7a5c02'],
      layers: [
        { kind: 'gradient', region: 'upper', colors: [1, 4, 2], direction: 'vertical' },
        { kind: 'fill', region: 'lower', colorIndex: 1 },
        { kind: 'text', region: 'lower', text: 'العميد', colorIndex: 2, fontId: 'black', arcDeg: 0, heightFrac: 0.82, align: 'center' },
      ],
    },
  },
  {
    key: 'r3-green', stadium: 'community-jewel-jeddah-62k',
    raw: {
      title: 'Ahli', summary: 'Diagonal green sweep, full-width crest, white wordmark.',
      palette: ['#262a33', '#0a7d3e', '#ffffff', '#04341c', '#f2b705'],
      layers: [
        { kind: 'stripes', region: 'all', colors: [1, 3], orientation: 'diagonal', bands: 10 },
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'symbol', region: 'north', symbol: 'shield', colorIndex: 2, scaleFrac: 0.95, align: 'center' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        { kind: 'text', region: 'south', text: 'AHLI', colorIndex: 1, fontId: 'impact', arcDeg: 0, heightFrac: 0.85, align: 'center' },
      ],
    },
  },
  {
    key: 'r4-eagle', stadium: 'community-grand-national-80k',
    raw: {
      title: 'Tigers', summary: 'Full-width eagle crest on a black stand, gold chevrons wrapping.',
      palette: ['#262a33', '#0d0d0f', '#f2b705', '#ffffff', '#3a2f08'],
      background: 1,
      layers: [
        { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
        { kind: 'fill', region: 'north', colorIndex: 1 },
        { kind: 'symbol', region: 'north', symbol: 'eagle', colorIndex: 2, scaleFrac: 0.95, align: 'center' },
        { kind: 'fill', region: 'south', colorIndex: 2 },
        { kind: 'text', region: 'south', text: 'ITTIHAD', colorIndex: 1, fontId: 'impact', arcDeg: 0, heightFrac: 0.8, align: 'center' },
      ],
    },
  },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5204 }, logLevel: 'error' });
await vite.listen(5204);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5204/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
for (const e of SET) {
  const spec = prep(e.raw);
  const res = (await page.evaluate(
    ([s, id, c]) => (window as never as { __shot: (a: unknown, b: unknown, c: unknown) => Promise<unknown> }).__shot(s, id, c),
    [spec, e.stadium, CAM] as [TifoSpec, string, typeof CAM],
  )) as { ok: boolean; shot?: string; flat?: string; errors?: unknown };
  if (!res.ok) { console.error(`FAIL ${e.key}`, res.errors); continue; }
  writeFileSync(`${OUT}/${e.key}-bowl.png`, Buffer.from(res.shot!.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${e.key}-flat.png`, Buffer.from(res.flat!.split(',')[1], 'base64'));
  console.log(`OK  ${e.key}`);
}
await browser.close();
await vite.close();
