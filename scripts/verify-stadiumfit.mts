/**
 * Can the estimator rebuild the stadiums it was never shown?
 *   npx tsx scripts/verify-stadiumfit.mts
 *
 * There is no scanned stadium to check against, so the only honest accuracy
 * figure available is a round trip: take a template we shipped, synthesise the
 * evidence a real ground would have left — a seating ring visible from above, a
 * stated capacity — hand that back to the estimator, and see what comes out.
 *
 * This cannot prove the estimator is right about a real stadium. It proves it is
 * self-consistent, which is the necessary half, and it is the same test that
 * caught the vertex-centroid bug in the footprint fitter.
 */
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { generateSeatMap } from '../src/core/seatmap';
import {
  buildStadium,
  fitRing,
  measureRing,
  stackTiers,
  suggestTierCount,
  type Pt,
  type RadialProbe,
} from '../src/core/stadiumFit';
import type { StadiumTemplate } from '../src/core/types';

let failures = 0;
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

const se = (a: number, b: number, p: number, t: number): Pt => {
  const e = 2 / p;
  const c = Math.cos(t), s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
};

/** The row-0 ring a perfect overhead sampler would return for this template. */
function trueRing(t: StadiumTemplate, n = 160): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push(se(t.plan.a, t.plan.b, t.plan.exponent, (i / n) * Math.PI * 2));
  return out;
}

console.log('--- ring fitting -------------------------------------------------');
{
  // Clean rings first: if this cannot recover geometry it generated itself,
  // nothing downstream is worth reading.
  let worst = 0;
  for (const s of STADIUM_CATALOG) {
    const { a, b, exponent } = s.template.plan;
    const f = fitRing(trueRing(s.template));
    const e = Math.max(Math.abs(f.a - a) / a, Math.abs(f.b - b) / b, Math.abs(f.exponent - exponent) / exponent);
    worst = Math.max(worst, e);
  }
  check(worst < 0.05, 'clean rings refit to their own geometry', `worst ${(worst * 100).toFixed(1)}%`);

  // Now with the noise a real sampler has: the imagery read of Amman used 175 of
  // 360 bearings, so drop half of them, and jitter each radius by a metre.
  let worstNoisy = 0;
  let rng = 12345;
  const rand = (): number => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const s of STADIUM_CATALOG) {
    const { a, b } = s.template.plan;
    const noisy = trueRing(s.template, 360)
      .filter(() => rand() > 0.5)
      .map(([x, y]) => {
        const r = Math.hypot(x, y) || 1;
        const j = 1 + (rand() - 0.5) * 2 * (1 / r);
        return [x * j, y * j] as Pt;
      });
    const f = fitRing(noisy);
    worstNoisy = Math.max(worstNoisy, Math.max(Math.abs(f.a - a) / a, Math.abs(f.b - b) / b));
  }
  check(worstNoisy < 0.08, 'half the bearings missing and +/-1 m jitter', `worst half-axis ${(worstNoisy * 100).toFixed(1)}%`);
}

console.log('\n--- radial probes -> ring ----------------------------------------');
{
  // A probe set with aisle gaps in it, which is what broke the first, run-based
  // version of this measurement on Amman.
  const probes: RadialProbe[] = [];
  for (let i = 0; i < 360; i++) {
    const theta = (i / 360) * Math.PI * 2;
    const hits: number[] = [];
    // Seating from 72 m to 81 m at a 0.2 m step, with a 2 m aisle gap punched
    // through the middle. The step matters: at 0.3 m this band yields 23 hits
    // after the gap, under the 25-hit floor, and every bearing is discarded.
    for (let r = 72; r < 81; r += 0.2) {
      if (r > 75.5 && r < 77.5) continue;
      hits.push(r);
    }
    probes.push({ theta, hits });
  }
  const m = measureRing(probes);
  const gotDepth = m.depth.median;
  check(m.used === 360, 'every clean bearing used', `${m.used}/${m.offered}`);
  check(Math.abs(gotDepth - 9) < 1.5, 'band depth survives an aisle gap', `${gotDepth.toFixed(1)} m of a true 9 m`);
  const fitted = fitRing(m.points);
  check(Math.abs(fitted.a - 72) < 2 && Math.abs(fitted.b - 72) < 2, 'circular probe set fits a circle', `a=${fitted.a} b=${fitted.b}`);

  // A bearing with almost nothing on it — a roofed main stand reads as no-data —
  // must be dropped, not averaged in as a seat at radius zero.
  const sparse: RadialProbe[] = [{ theta: 0.001, hits: [70, 70.3, 70.6] }, ...probes.slice(0, 10)];
  const ms = measureRing(sparse);
  check(ms.used === 10, 'a bearing with too few hits is dropped, not guessed', `${ms.used} used of ${ms.offered}`);
}

console.log('\n--- tier split ---------------------------------------------------');
{
  let right = 0;
  const misses: string[] = [];
  for (const s of STADIUM_CATALOG) {
    const rows = s.template.tiers.reduce((n, t) => n + t.rows, 0);
    const got = suggestTierCount(rows);
    if (got === s.template.tiers.length) right++;
    else misses.push(`${s.meta?.name ?? s.id} (${rows} rows: said ${got}, is ${s.template.tiers.length})`);
  }
  // Locked at 10, not ">= 8": this number is quoted in the provenance note the
  // user reads, so it must not drift without someone noticing.
  check(right === 10, 'tier-count rule scores 10 of 13', `misses: ${misses.join('; ')}`);

  const st = stackTiers(50, 2);
  const stacked = st[1].baseOffset > st[0].baseOffset + st[0].rows * st[0].rowDepth
    && st[1].baseElevation > st[0].baseElevation;
  check(stacked, 'upper tier starts behind and above the one below');
  check(st[1].rakeDeg > st[0].rakeDeg, 'rake steepens going up');
  check(stackTiers(40, 1).length === 1 && stackTiers(60, 3).length === 3, 'tier count is honoured');
}

console.log('\n--- the whole estimator, round-tripped ---------------------------');
{
  console.log('\nstadium'.padEnd(25) + 'seats'.padStart(8) + 'rebuilt'.padStart(9) + 'err'.padStart(7) +
    '   plan a/b err   tiers');
  let worstCap = 0;
  let worstPlan = 0;
  let tiersRight = 0;
  for (const s of STADIUM_CATALOG) {
    const truth = s.template;
    const cap = generateSeatMap(truth).count;
    const r = buildStadium({
      id: 'rt-' + s.id,
      name: s.meta?.name,
      innerRing: trueRing(truth),
      capacity: cap,
      known: { aisles: truth.aisles.count, seatPitch: truth.tiers[0].seatPitch, tiers: truth.tiers.length },
    });
    const capErr = Math.abs(r.built - cap) / cap;
    const planErr = Math.max(
      Math.abs(r.template.plan.a - truth.plan.a) / truth.plan.a,
      Math.abs(r.template.plan.b - truth.plan.b) / truth.plan.b,
    );
    worstCap = Math.max(worstCap, capErr);
    worstPlan = Math.max(worstPlan, planErr);
    if (r.template.tiers.length === truth.tiers.length) tiersRight++;
    console.log(
      String(s.meta?.name ?? s.id).slice(0, 24).padEnd(25) +
      String(cap).padStart(8) + String(r.built).padStart(9) +
      `${(capErr * 100).toFixed(1)}%`.padStart(7) +
      `${(planErr * 100).toFixed(1)}%`.padStart(14) +
      String(r.template.tiers.length).padStart(8),
    );
  }
  console.log();
  check(worstPlan < 0.05, 'plan curve recovered', `worst ${(worstPlan * 100).toFixed(1)}%`);
  check(worstCap < 0.05, 'capacity recovered', `worst ${(worstCap * 100).toFixed(1)}%`);
  check(tiersRight === STADIUM_CATALOG.length, 'a told tier count is honoured', `${tiersRight}/${STADIUM_CATALOG.length}`);
}

console.log('\n--- provenance ---------------------------------------------------');
{
  const truth = STADIUM_CATALOG[0].template;
  const measured = buildStadium({ innerRing: trueRing(truth), capacity: 60000 });
  check(measured.provenance['plan.a'].confidence === 'measured', 'a measured ring is reported as measured');
  check(measured.provenance['tiers.rows'].confidence === 'derived', 'rows from a capacity are derived, not measured');
  check(measured.confirm.includes('tiers.length'), 'an unconfirmed tier guess is flagged for a human');
  check(measured.confirm.includes('roof.coverage'), 'roof coverage is flagged when nobody said');

  // The footprint path must never quietly pass itself off as a measurement: it
  // is the outer wall, and using it as the plan curve is the bug that rendered
  // Amman as a velodrome.
  const ring = trueRing(truth);
  const lonlat = ring.map(([x, y]) => [35.9 + x / 94000, 32 + y / 111132] as Pt);
  const guessed = buildStadium({ footprint: lonlat, capacity: 60000 });
  check(guessed.provenance['plan.a'].confidence === 'suggested', 'a footprint is reported as suggested, not measured');
  check(guessed.warnings.some((w) => w.includes('outline')), 'and it warns that the outline is not row 0');
  check(guessed.confirm.includes('plan.a'), 'and asks a human to check the plan');

  const nocap = buildStadium({ innerRing: trueRing(truth) });
  check(nocap.warnings.some((w) => w.includes('capacity')), 'no capacity is reported as a guess');

  let threw = false;
  try { buildStadium({}); } catch { threw = true; }
  check(threw, 'nothing in, nothing out — it refuses rather than inventing a stadium');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
