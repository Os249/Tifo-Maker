/**
 * Dev-only: isolate the DESIGN levers, one at a time, on one brief.
 *   npx tsx scripts/preview-levers.mts
 * Same engine, same stadium, same words in every frame — only the design
 * decision changes, so each lever can be judged on its own.
 * Needs full-vision-spike.patch + dx/dy, and the @fontsource packages.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { validateSpec, type TifoSpec } from '../src/core/tifoSpec';
import { refineSpec } from '../src/core/specRefine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.env.OUT_DIR ?? 'preview-out/levers');
const TV = { position: [0, 95, 205] as [number, number, number], target: [0, 4, 0] as [number, number, number] };
const STAD = 'community-grand-national-80k';
type L = Record<string, unknown>;
type Raw = { title: string; summary: string; palette: string[]; background?: number; layers: L[] };
const prep = (r: Raw): TifoSpec => {
  const v = validateSpec(r);
  if (!v.valid || !v.spec) throw new Error(`${r.title}: ${JSON.stringify(v.errors)}`);
  return refineSpec(v.spec);
};
const TEXT = 'GRAZIE CAPITANO';
const OUTLINE = Math.max(2, Math.min(7, Math.round(TEXT.replace(/\s/g, '').length * 0.6)));
const say = (region: string, fill: number, edge: number | null, h = 0.8, extra: L = {}): L[] => [
  ...(edge === null ? [] : [{ kind: 'text', region, text: TEXT, colorIndex: edge, fontId: 'verdana', arcDeg: 0, heightFrac: h, align: 'center', outline: OUTLINE, ...extra }]),
  { kind: 'text', region, text: TEXT, colorIndex: fill, fontId: 'verdana', arcDeg: 0, heightFrac: h, align: 'center', ...extra },
];

interface Step { key: string; lever: string; why: string; raw: Raw }

// 0 — where the current designs sit: seven palette slots, four of them within
//     3:1 of each other, everything flat.
const BASE: Raw = {
  title: 'Baseline', summary: 'Seven colours, four of them indistinguishable at distance.',
  palette: ['#262a33', '#0d0d0f', '#e8b923', '#ffffff', '#3a2f08', '#8a6a02', '#141414'],
  layers: [
    { kind: 'gradient', region: 'all', colors: [1, 4, 5, 6], direction: 'horizontal' },
    { kind: 'fill', region: 'south', colorIndex: 2 },
    ...say('south', 1, 3),
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 5], scale: 12 },
  ],
};

// 1 — three dominant colours, every pair over 3:1. Same design otherwise.
const VALUE: Raw = {
  title: 'Value discipline', summary: 'Three dominant colours, every pair above 3:1.',
  palette: ['#262a33', '#0d0d0f', '#f5c518', '#ffffff'],
  layers: [
    { kind: 'gradient', region: 'all', colors: [1, 2, 1], direction: 'horizontal' },
    { kind: 'fill', region: 'south', colorIndex: 2 },
    ...say('south', 1, 3),
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
  ],
};

// 2 — the headline stamped twice: once offset in the dark tone, once on top.
const SHADOW: Raw = {
  ...VALUE, title: 'Drop shadow', summary: 'A second stamp offset down and right reads as depth.',
  layers: [
    { kind: 'gradient', region: 'all', colors: [1, 2, 1], direction: 'horizontal' },
    { kind: 'fill', region: 'south', colorIndex: 2 },
    { kind: 'text', region: 'south', text: TEXT, colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: OUTLINE, dx: 1.1, dy: 7 },
    ...say('south', 1, 3),
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
  ],
};

// 3 — unpainted seats (index 0, stadium grey) used deliberately as a frame.
const NEGATIVE: Raw = {
  ...VALUE, title: 'Negative space', summary: 'A band of unpainted seats frames the headline stand.',
  layers: [
    { kind: 'gradient', region: 'all', colors: [1, 2, 1], direction: 'horizontal' },
    { kind: 'fill', region: 'south', colorIndex: 0 },
    { kind: 'fill', region: { stand: 'south', tier: 'all', rows: [0.08, 0.92] } as unknown as L, colorIndex: 2 },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.08, 0.92] } as unknown as L, text: TEXT, colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: OUTLINE, dx: 1.1, dy: 7 },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.08, 0.92] } as unknown as L, text: TEXT, colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: OUTLINE },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.08, 0.92] } as unknown as L, text: TEXT, colorIndex: 3, fontId: 'verdana', arcDeg: 0, heightFrac: 0.8, align: 'center' },
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
  ],
};

// 4 — dramatic scale jump: hero enormous, the supporting line tiny.
const SCALE: Raw = {
  ...VALUE, title: 'Scale jump', summary: 'Hero fills the top 60% of the stand; the date line gets the bottom quarter.',
  layers: [
    { kind: 'gradient', region: 'all', colors: [1, 2, 1], direction: 'horizontal' },
    { kind: 'fill', region: 'south', colorIndex: 2 },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.06, 0.60] } as unknown as L, text: 'CAPITANO', colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.92, align: 'center', outline: 5, dx: 1, dy: 6 },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.06, 0.60] } as unknown as L, text: 'CAPITANO', colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.92, align: 'center' },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.68, 0.94] } as unknown as L, text: '2009 — 2026', colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.7, align: 'center' },
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
  ],
};

// 5 — everything at once.
const ALL: Raw = {
  title: 'All four', summary: 'Three colours, framed by empty seats, shadowed, with a scale jump.',
  palette: ['#262a33', '#0d0d0f', '#f5c518', '#ffffff'],
  layers: [
    { kind: 'gradient', region: 'all', colors: [1, 2, 1], direction: 'horizontal' },
    { kind: 'fill', region: 'south', colorIndex: 0 },
    { kind: 'fill', region: { stand: 'south', tier: 'all', rows: [0.07, 0.93] } as unknown as L, colorIndex: 2 },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.10, 0.62] } as unknown as L, text: 'CAPITANO', colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.92, align: 'center', outline: 5, dx: 1, dy: 7 },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.10, 0.62] } as unknown as L, text: 'CAPITANO', colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.92, align: 'center' },
    { kind: 'text', region: { stand: 'south', tier: 'all', rows: [0.70, 0.90] } as unknown as L, text: 'GRAZIE  ·  2009 — 2026', colorIndex: 1, fontId: 'verdana', arcDeg: 0, heightFrac: 0.66, align: 'center' },
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'pattern', region: 'sides', pattern: 'chevron', colors: [1, 2], scale: 12 },
  ],
};

const STEPS: Step[] = [
  { key: 'L0-baseline', lever: 'Baseline', why: 'seven colours, four within 3:1, everything flat', raw: BASE },
  { key: 'L1-value', lever: 'Value discipline', why: 'three dominant colours, every pair above 3:1', raw: VALUE },
  { key: 'L2-shadow', lever: 'Drop shadow', why: 'the headline stamped twice, offset', raw: SHADOW },
  { key: 'L3-negative', lever: 'Negative space', why: 'unpainted seats as a deliberate frame', raw: NEGATIVE },
  { key: 'L4-scale', lever: 'Scale jump', why: 'hero huge, supporting line tiny', raw: SCALE },
  { key: 'L5-all', lever: 'All four', why: 'combined', raw: ALL },
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5209 }, logLevel: 'error' });
await vite.listen(5209);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5209/scripts/preview-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
for (const st of STEPS) {
  const spec = prep(st.raw);
  const res = (await page.evaluate(([s, id, c]) => (window as never as { __shot:(a:unknown,b:unknown,c:unknown)=>Promise<unknown> }).__shot(s, id, c),
    [spec, STAD, TV] as [TifoSpec, string, typeof TV])) as { ok: boolean; shot?: string; flat?: string; errors?: unknown };
  if (!res.ok) { console.error(`FAIL ${st.key}`, res.errors); continue; }
  writeFileSync(`${OUT}/${st.key}-bowl.png`, Buffer.from(res.shot!.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${st.key}-flat.png`, Buffer.from(res.flat!.split(',')[1], 'base64'));
  console.log(`OK  ${st.lever.padEnd(18)} ${st.why}`);
}
await browser.close(); await vite.close();
