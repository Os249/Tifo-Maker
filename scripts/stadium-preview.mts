/**
 * Dev-only: look at a derived stadium template before trusting it.
 *   npx tsx scripts/stadium-preview.mts   → preview-out/stadium/*.png
 *
 * Paints one colour per stand so the STAND DISTRIBUTION is what you see, and
 * renders the derived bowl beside a hand-built one at the same scale, because
 * the only useful question about a fitted template is whether it looks like the
 * ground it came from.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { solveRows } from './stadium-import.mjs';
import type { StadiumTemplate } from '../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/stadium');

/**
 * Two readings of the SAME ground, plus a hand-built reference.
 *
 * `raw` is what scripts/stadium-import.mts produces today: fit a superellipse to
 * the OSM footprint (way 151158210) and use it as `plan`. The fit itself is good
 * - 2.1% rms radial error against the real outline - but `plan` is the INNER edge
 * of row 0, not the building outline, so every seat lands out where the outer
 * wall is and the bowl comes out as a thin ring far from the pitch.
 *
 * `measured` takes `plan` from what the seating actually does. Sampling Esri
 * World Imagery radially for seat-coloured pixels puts row 0 at r = 72 m down the
 * sides and r = 100 m at the ends; a superellipse through those 175 points is
 * a = 100.0, b = 71.3, p = 2.00. Measured band depth is 9.0 m median (p25 7.8,
 * p75 9.6), i.e. a near-uniform ring of roughly 11 rows - so a constant-depth
 * ring, which is all a StadiumTemplate can express, is a fair model here.
 *
 * Rows are then solved against the stated 17,619 rather than against the 9 m we
 * measured, which lands ~16 rows. The measured depth would give ~11,000 seats;
 * the difference is mostly the roofed west main stand, which the colour sampler
 * cannot read at all, plus seat pitch tighter than our 0.5 m default.
 */
const AMMAN_RAW: StadiumTemplate = {
  id: 'amman-raw',
  name: 'Amman International (footprint as plan)',
  version: 1,
  plan: { a: 112.6, b: 90.8, exponent: 2.05 },
  tiers: [{ rows: 15, rowDepth: 0.8, rakeDeg: 18, baseElevation: 2, baseOffset: 0, seatPitch: 0.5 }],
  aisles: { count: 32, widthMeters: 1.2 },
  sectionsPerTier: 32,
  evenRows: true,
};

const AMMAN_MEASURED: StadiumTemplate = {
  ...AMMAN_RAW,
  id: 'amman-measured',
  name: 'Amman International (plan measured off the imagery)',
  plan: { a: 100.0, b: 71.3, exponent: 2.0 },
  tiers: [{ rows: 16, rowDepth: 0.8, rakeDeg: 20, baseElevation: 3, baseOffset: 0, seatPitch: 0.5 }],
};

const alAwwal = STADIUM_CATALOG.find((s) => s.id.includes('alawwal'))?.template;
const SET: Array<[string, StadiumTemplate, number]> = [
  ['amman-raw', solveRows(AMMAN_RAW, 17619).template, 1],
  ['amman-measured', solveRows(AMMAN_MEASURED, 17619).template, 1],
  ...(alAwwal ? ([['alawwal-handbuilt', alAwwal, 1.0]] as Array<[string, StadiumTemplate, number]>) : []),
];

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5225 }, logLevel: 'error' });
await vite.listen(5225);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5225/scripts/stadium-preview.html', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

for (const [label, template, cam] of SET) {
  const r = (await page.evaluate(
    ([t, c]) => (window as never as { __render: (a: unknown, b: unknown) => Promise<unknown> }).__render(t, c),
    [template, cam] as [StadiumTemplate, number],
  )) as { bowl: string | null; flat: string; seats: number; error?: unknown };
  if (r.error) { console.error(label, r.error); continue; }
  if (r.bowl) writeFileSync(`${OUT}/${label}-bowl.png`, Buffer.from(r.bowl.split(',')[1], 'base64'));
  writeFileSync(`${OUT}/${label}-flat.png`, Buffer.from(r.flat.split(',')[1], 'base64'));
  const t = template;
  const rows = t.tiers.map((x) => x.rows).join('+');
  console.log(
    `${label.padEnd(20)} ${String(r.seats).padStart(6)} seats   ` +
    `${(t.plan.a * 2).toFixed(0)}x${(t.plan.b * 2).toFixed(0)}m  p=${t.plan.exponent}  rows ${rows}`,
  );
}
await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}`);
