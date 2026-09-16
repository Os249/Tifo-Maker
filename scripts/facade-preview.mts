/**
 * Dev-only: look at what every catalogue ground looks like from OUTSIDE, at
 * night, with its floodlights on.
 *   npx tsx scripts/facade-preview.mts            → preview-out/facade/*.png
 *   npx tsx scripts/facade-preview.mts <id-part>  → just the ones matching
 *
 * Three shots: the plaza approach, a high three-quarter, and one from the pitch
 * looking up at the lamps. Plus the numbers that decide whether the lighting is
 * legal rather than merely pretty — the minimum elevation above the pitch
 * centre must be at least 25 degrees, which is what both UEFA and FIFA require
 * and what sets every mast height in the renderer.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { buildStadium, measureRing, type Pt, type RadialProbe } from '../src/core/stadiumFit';
import type { FacadeStyle, StadiumTemplate } from '../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/facade');
const filter = process.argv[2] ?? '';
const SHOTS = ['approach', 'aerial', 'lamps'] as const;

interface Shot {
  shots: Record<string, string>;
  stats: Record<string, { meanL: number; sdL: number; darkPct: number }>;
  style: string;
  footprintOut: number;
  facadeTris: number;
  lighting: { style: string; requested: string; kelvin: number; count: number; angleRef: string; minAngleDeg: number; note: string; maxY: number; spots: number };
  bowl: { backRadial: number; backY: number; top: number };
  error?: unknown;
}

const wanted = STADIUM_CATALOG.filter((s) => !filter || s.id.includes(filter));
if (wanted.length === 0) throw new Error(`no catalogue stadium matches "${filter}"`);

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5229 }, logLevel: 'error' });
await vite.listen(5229);
const browser = await chromium
  .launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
const page: Page = await browser.newPage({ viewport: { width: 1100, height: 660 } });
page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5229/scripts/facade-preview.html', { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 180000 });

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

let bad = 0;

const shoot = async (label: string, spec: string | StadiumTemplate, name: string): Promise<void> => {
  const r = (await page.evaluate(
    ([sp, shots]) => (window as never as { __render: (a: unknown, b: unknown) => Promise<unknown> }).__render(sp, shots),
    [spec, SHOTS as unknown as string[]] as [string | StadiumTemplate, string[]],
  )) as Shot;
  if (r.error) { console.error(label, r.error); bad++; return; }
  for (const [k, data] of Object.entries(r.shots)) {
    writeFileSync(`${OUT}/${name}-${k}.png`, Buffer.from(data.split(',')[1], 'base64'));
  }
  const L = r.stats.approach;
  const elev = r.lighting.count ? `${r.lighting.minAngleDeg.toFixed(0)}${r.lighting.angleRef === 'centre' ? 'c' : 'p'}` : '-';
  const flags: string[] = [];
  // The rule that applies depends on the system: corner towers are measured to
  // the pitch centre and must clear 25 degrees; a rim array is measured to the
  // pitch edge and must clear 20.
  const floor = r.lighting.angleRef === 'centre' ? 24.9 : 19.9;
  if (r.lighting.count && r.lighting.minAngleDeg < floor) flags.push('ANGLE-FAIL');
  if (r.lighting.style !== r.lighting.requested) flags.push(`FELL-BACK(${r.lighting.requested})`);
  if (r.style !== 'plain' && r.style !== 'berm' && r.facadeTris < 500) flags.push('FACADE-EMPTY');
  // Not "is it dark" — a night shot is dark. "Is anything there": a facade
  // nobody can make out is the failure, and that is mean AND spread.
  if (L.meanL < 14) flags.push('INVISIBLE');
  if (r.style !== 'plain' && L.sdL < 9) flags.push('FEATURELESS');
  if (flags.length) bad++;
  console.log(
    label.slice(0, 24).padEnd(25) +
    r.style.padEnd(10) + String(r.facadeTris).padStart(6) + '  ' +
    r.lighting.style.padEnd(13) + String(r.lighting.count).padStart(3) + elev.padStart(6) +
    r.lighting.maxY.toFixed(0).padStart(7) + '   ' +
    `${L.meanL.toFixed(0)} / ${L.sdL.toFixed(0)}`.padStart(12) +
    (flags.length ? '  <- ' + flags.join(' ') : ''),
  );
};

console.log(
  'stadium'.padEnd(25) + 'facade'.padEnd(10) + 'tris'.padStart(6) +
  '  ' + 'lighting'.padEnd(13) + 'n'.padStart(3) + 'elev'.padStart(6) + 'topY'.padStart(7) + '   approach L / sd',
);
for (const s of wanted) {
  await shoot(String(s.meta?.name ?? s.id), s.id, s.id);
}

// The estimator's own output, rendered. Everything above is a template someone
// authored by hand; this is the one that came out of OpenStreetMap and a
// photograph, and it is the only shot here that tests the whole chain.
if (!filter) {
  const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as Record<string, unknown>;
  const osm = read('scripts/data/amman-osm.json');
  const ringData = read('scripts/data/amman-ring.json');
  const ring = measureRing(ringData.probes as RadialProbe[], { minHits: 25 });
  void (osm.stadium as { geom: Pt[] }).geom;
  const fit = buildStadium({
    id: 'amman-international-18k',
    name: 'Amman International Stadium',
    innerRing: ring.points,
    bandDepth: ring.depth.median,
    capacity: 17_619,
    known: { tiers: 1, roof: 'west', aisles: 32, hasTrack: true },
  });
  console.log('\n--- estimated from OSM + imagery ---');
  await shoot('Amman International', fit.template, 'fit-amman');
}

// Every style in the vocabulary, on one bowl, so the four the catalogue happens
// to use are not the only four anyone ever looks at.
if (!filter) {
  const base = STADIUM_CATALOG.find((s) => s.id === 'community-grand-national-80k')!.template;
  const STYLES: FacadeStyle[] = ['plain', 'berm', 'truss', 'concrete', 'brick', 'cladding', 'membrane', 'lattice'];
  console.log('\n--- one bowl, every facade style ---');
  for (const style of STYLES) {
    await shoot(`swatch: ${style}`, { ...base, facade: { style } }, `swatch-${style}`);
  }
}

await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}${bad ? `  (${bad} with flags)` : ''}`);
