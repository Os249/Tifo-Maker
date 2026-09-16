/**
 * The whole estimator, end to end, on a real ground.
 *   npx tsx scripts/stadium-from-pictures.mts
 *
 * Amman International: its OpenStreetMap footprint, its seating ring measured
 * off overhead imagery, and its stated capacity, through src/core/stadiumFit.
 * Prints the template and — the part that matters — where every number came
 * from and how much of it is a guess.
 *
 * Both inputs are committed under scripts/data/ so this reruns without network
 * access and without the imagery, which is not ours to redistribute.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStadium, fitSuperellipse, measureRing, type Pt, type RadialProbe } from '../src/core/stadiumFit';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')) as Record<string, unknown>;

const osm = read('scripts/data/amman-osm.json');
const ringData = read('scripts/data/amman-ring.json');
const footprint = (osm.stadium as { geom: Pt[] }).geom;
const probes = ringData.probes as RadialProbe[];

/** Amman International, per OSM and the usual references. */
const CAPACITY = 17_619;

console.log('Amman International Stadium');
console.log('='.repeat(72));

const outer = fitSuperellipse(footprint);
console.log(`\nOSM footprint      ${footprint.length} nodes -> outer ${(outer.a * 2).toFixed(0)} x ${(outer.b * 2).toFixed(0)} m, p=${outer.exponent}, ${outer.angleDeg}deg`);

const ring = measureRing(probes, { minHits: 25 });
console.log(`Imagery ring       ${ring.used} of ${ring.offered} bearings usable`);
console.log(`Seating band       ${ring.depth.median.toFixed(1)} m median (p25 ${ring.depth.p25.toFixed(1)}, p75 ${ring.depth.p75.toFixed(1)}) ~= ${Math.round(ring.depth.median / 0.8)} rows`);

const fit = buildStadium({
  id: 'amman-international-18k',
  name: 'Amman International Stadium',
  innerRing: ring.points,
  bandDepth: ring.depth.median,
  capacity: CAPACITY,
  // What a person can see in one glance at the aerial and nothing else can tell
  // us: there is a 400 m track, one roofed main stand on the west, and the bowl
  // is a single continuous tier.
  known: { tiers: 1, roof: 'west', aisles: 32, hasTrack: true },
});

const t = fit.template;
console.log(`\nplan               a=${t.plan.a} b=${t.plan.b} p=${t.plan.exponent}  (${(t.plan.a * 2).toFixed(0)} x ${(t.plan.b * 2).toFixed(0)} m)`);
console.log(`tiers              ${t.tiers.map((x) => `${x.rows} rows @ ${x.rakeDeg}deg`).join(' | ')}`);
console.log(`seats              ${fit.built.toLocaleString()} built vs ${CAPACITY.toLocaleString()} stated  (${((Math.abs(fit.built - CAPACITY) / CAPACITY) * 100).toFixed(1)}%)`);

console.log('\nwhere each number came from');
console.log('-'.repeat(72));
for (const [field, p] of Object.entries(fit.provenance)) {
  console.log(`  ${field.padEnd(18)} ${p.confidence.padEnd(10)} ${p.source.padEnd(22)} ${p.note ?? ''}`);
}

if (fit.confirm.length) {
  console.log(`\nask the user to confirm: ${fit.confirm.join(', ')}`);
}
for (const w of fit.warnings) console.log(`  warning: ${w}`);

console.log('\ntemplate\n' + JSON.stringify(t, null, 2));
