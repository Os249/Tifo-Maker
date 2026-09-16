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
import { readFileSync } from 'node:fs';
import { buildStadium, measureRing, solveRows, type RadialProbe } from '../src/core/stadiumFit';
import type { StadiumTemplate } from '../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/stadium');

/**
 * Two readings of the SAME ground, plus a hand-built reference.
 *
 * `raw` is the mistake worth keeping visible: fit a superellipse to the OSM
 * footprint and use it as `plan`. The fit is good — 2.1% rms radial against the
 * real outline — but `plan` is the INNER edge of row 0, not the building, so
 * every seat lands where the concourse is and the bowl renders as a velodrome.
 *
 * `fitted` is whatever src/core/stadiumFit currently produces from the committed
 * evidence: the OSM way, the seating ring measured off overhead imagery, and the
 * stated capacity. It is not a copy of those numbers — it is the estimator's
 * live output, so if the estimator regresses this picture changes.
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

const ringData = JSON.parse(readFileSync(resolve(ROOT, 'scripts/data/amman-ring.json'), 'utf8')) as { probes: RadialProbe[] };
const ammanRing = measureRing(ringData.probes, { minHits: 25 });
const AMMAN_FITTED = buildStadium({
  id: 'amman-fitted',
  name: 'Amman International (estimated)',
  innerRing: ammanRing.points,
  bandDepth: ammanRing.depth.median,
  capacity: 17_619,
  known: { tiers: 1, roof: 'west', aisles: 32, hasTrack: true },
}).template;

const alAwwal = STADIUM_CATALOG.find((s) => s.id.includes('alawwal'))?.template;
const SET: Array<[string, StadiumTemplate, number]> = [
  ['amman-raw', solveRows(AMMAN_RAW, 17619).template, 1],
  ['amman-fitted', AMMAN_FITTED, 1],
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
