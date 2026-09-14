/**
 * Dev-only: how far can the CURRENT engine actually be pushed?
 *   npx tsx scripts/preview-ceiling.mts
 * Every spec here is hand-authored to stress one capability (multi-stop
 * gradients, arced headlines, tier-split bands, 7-colour tonal ramps,
 * continuous cross-stand artwork) so the ceiling can be seen, not guessed.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/ceiling');
const CAM = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };
const STADIUM = 'community-jewel-jeddah-62k';

type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: Array<Record<string, unknown>> };
const prep = (r: Raw): TifoSpec => {
  const v = validateSpec(r);
  if (!v.valid || !v.spec) throw new Error(`${r.title}: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
};

const EXP: Array<{ key: string; why: string; raw: Raw }> = [
  {
    key: 'e1-sweep', why: 'whole-bowl multi-stop gradient (the Berlin flag sweep)',
    raw: {
      title: 'Sweep', summary: '5-stop horizontal gradient wrapping the entire bowl.',
      palette: ['#262a33', '#b4141c', '#e8531f', '#f2b705', '#111318', '#ffffff'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [1, 2, 3, 4], direction: 'horizontal' },
        { kind: 'text', region: 'lower', text: 'ITTIHAD', colorIndex: 5, fontId: 'impact', arcDeg: 0, heightFrac: 0.8, align: 'center' },
      ],
    },
  },
  {
    key: 'e2-arc', why: 'arced headline — does arcDeg follow the bowl?',
    raw: {
      title: 'Arc', summary: 'Same headline at a heavy arc.',
      palette: ['#262a33', '#0d0d0f', '#f2b705', '#ffffff'],
      background: 1,
      layers: [
        { kind: 'gradient', region: 'all', colors: [1, 2], direction: 'vertical' },
        { kind: 'text', region: 'lower', text: 'THE PRIDE OF JEDDAH', colorIndex: 3, fontId: 'impact', arcDeg: 120, heightFrac: 0.9, align: 'center' },
      ],
    },
  },
  {
    key: 'e3-tiers', why: 'tier-split: art above, continuous slogan band below',
    raw: {
      title: 'Tiers', summary: 'Upper tier carries the field, lower tier a continuous Arabic band.',
      palette: ['#262a33', '#f2b705', '#0d0d0f', '#ffffff', '#8a6a02', '#c4960a'],
      layers: [
        { kind: 'gradient', region: 'upper', colors: [2, 4, 5, 1], direction: 'vertical' },
        { kind: 'fill', region: 'lower', colorIndex: 2 },
        { kind: 'text', region: 'lower', text: 'عميد الأندية', colorIndex: 1, fontId: 'black', arcDeg: 0, heightFrac: 0.85, align: 'center' },
      ],
    },
  },
  {
    key: 'e4-ramp', why: '7-colour tonal ramp + giant symbol — can it shade?',
    raw: {
      title: 'Ramp', summary: 'Radial ramp through six greens behind a full-height crest.',
      palette: ['#262a33', '#04341c', '#06522c', '#0a7d3e', '#2fa862', '#9bd9b4', '#ffffff'],
      layers: [
        { kind: 'gradient', region: 'all', colors: [1, 2, 3, 4, 5], direction: 'vertical' },
        { kind: 'symbol', region: 'north', symbol: 'eagle', colorIndex: 6, scaleFrac: 1, align: 'center' },
        { kind: 'symbol', region: 'south', symbol: 'shield', colorIndex: 6, scaleFrac: 1, align: 'center' },
      ],
    },
  },
  {
    key: 'e5-diag', why: 'diagonal stripes across the whole bowl (organic sweep)',
    raw: {
      title: 'Diagonal', summary: 'Wide diagonal bands wrapping the bowl.',
      palette: ['#262a33', '#0a7d3e', '#ffffff', '#04341c', '#f2b705'],
      layers: [
        { kind: 'stripes', region: 'all', colors: [1, 2, 3, 1, 4], orientation: 'diagonal', bands: 14 },
        { kind: 'text', region: 'north', text: 'AHLI', colorIndex: 2, fontId: 'black', arcDeg: 0, heightFrac: 0.9, align: 'center' },
      ],
    },
  },
  {
    key: 'e6-max', why: 'everything at once — 7 colours, ramp, band, arc, crest',
    raw: {
      title: 'Max', summary: 'Vertical ramp, arced slogan on the lower band, crest hero.',
      palette: ['#262a33', '#0d0d0f', '#f2b705', '#ffffff', '#7a5c02', '#c4960a', '#3a2f08'],
      layers: [
        { kind: 'gradient', region: 'upper', colors: [1, 6, 4, 5, 2], direction: 'vertical' },
        { kind: 'gradient', region: 'lower', colors: [2, 5, 6, 1], direction: 'vertical' },
        { kind: 'symbol', region: 'north', symbol: 'eagle', colorIndex: 1, scaleFrac: 1, align: 'center' },
        { kind: 'text', region: 'south', text: 'IL CAPITANO', colorIndex: 3, fontId: 'impact', arcDeg: 35, heightFrac: 0.85, align: 'center' },
      ],
    },
  },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5203 }, logLevel: 'error' });
await vite.listen(5203);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
}).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5203/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

for (const e of EXP) {
  const spec = prep(e.raw);
  const res = (await page.evaluate(
    ([s, id, c]) => (window as never as { __shot: (a: unknown, b: unknown, c: unknown) => Promise<unknown> }).__shot(s, id, c),
    [spec, STADIUM, CAM] as [TifoSpec, string, typeof CAM],
  )) as { ok: boolean; shot?: string; flat?: string; warnings?: string[]; errors?: unknown };
  if (!res.ok) { console.error(`FAIL ${e.key}`, res.errors); continue; }
  writeFileSync(`${OUT}/${e.key}-bowl.png`, Buffer.from(res.shot!.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${e.key}-flat.png`, Buffer.from(res.flat!.split(',')[1], 'base64'));
  console.log(`OK  ${e.key.padEnd(10)} ${e.why}  (warn ${res.warnings?.length ?? 0})`);
}
await browser.close();
await vite.close();
