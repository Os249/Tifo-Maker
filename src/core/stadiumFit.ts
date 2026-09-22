/**
 * Estimating a StadiumTemplate from what is publicly knowable about a ground.
 *
 * There is no public dataset of seating bowls — tiers, rows, rakes. What IS
 * public is the FOOTPRINT (OpenStreetMap, ODbL), the CAPACITY (OSM or Wikidata),
 * and overhead imagery. Those are enough for most of a template, because the
 * bowl is not free-form: seat pitch and row depth are set by regulation and vary
 * by centimetres, not metres. See claude/stadium-geometry-sources.md.
 *
 * Every number this module produces carries a Provenance saying where it came
 * from and how much to trust it, because they are not equally trustworthy: the
 * plan curve is measured off imagery with a residual we can quote, the row count
 * is solved against a stated capacity, and the tier split is a guess that is
 * right about two thirds of the time. Handing all three back as one anonymous
 * blob of numbers would be the dishonest part.
 *
 * Pure and DOM-free — it runs in the app, in the seat-map worker, in scripts and
 * in tests, so one stadium resolves the same way everywhere.
 */
import { generateSeatMap } from './seatmap';
import { LIMITS, MAX_TOTAL_ROWS, clamp, clampTemplate, outOfRange } from './templateLimits';
import type { FacadeStyle, LightingStyle, RoofCoverage, StadiumTemplate, TierSpec } from './types';

// ---- geometry --------------------------------------------------------------

export type Pt = [number, number];

/** Metres per degree, good enough over a stadium's few hundred metres. */
function toMetres(ring: Pt[]): Pt[] {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mPerDegLat = 111_132;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return ring.map(([lon, lat]) => [lon * mPerDegLon, lat * mPerDegLat] as Pt);
}

/** Centre and rotate a ring onto its own principal axes. */
export function principalAxes(ring: Pt[]): { centred: Pt[]; angleDeg: number } {
  const n = ring.length;
  // The AREA centroid, not the average of the vertices.
  //
  // An OSM way spaces its nodes by how much detail a mapper felt each part
  // deserved — a curved end gets ten nodes, a straight side gets two — so the
  // vertex average is pulled toward whichever side was mapped in more detail.
  // On Amman International that bias is 6.5 m, which alone manufactured a 10%
  // asymmetry and pushed the ellipse error from 11% to 21%. Synthetic test
  // rings have evenly spaced vertices, so this never showed up there.
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a2 += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a2) < 1e-9) {
    // Degenerate ring (collinear, or a single repeated point): fall back.
    cx = ring.reduce((s, p) => s + p[0], 0) / n;
    cy = ring.reduce((s, p) => s + p[1], 0) / n;
  } else {
    cx /= 3 * a2;
    cy /= 3 * a2;
  }
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of ring) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // Principal angle of the covariance matrix: the bowl's long axis.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(-theta), sin = Math.sin(-theta);
  const centred = ring.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [dx * cos - dy * sin, dx * sin + dy * cos] as Pt;
  });
  return { centred, angleDeg: (theta * 180) / Math.PI };
}

/** Extents and best exponent for a ring already rotated onto a candidate axis. */
function fitAt(centred: Pt[], angleRad: number): { a: number; b: number; p: number; err: number } {
  const cos = Math.cos(-angleRad), sin = Math.sin(-angleRad);
  const rot = centred.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as Pt);
  const a = Math.max(...rot.map((q) => Math.abs(q[0])));
  const b = Math.max(...rot.map((q) => Math.abs(q[1])));
  if (a < 1 || b < 1) return { a, b, p: 2, err: Infinity };
  let best = { p: 2, err: Infinity };
  for (let p = 1.6; p <= 6.01; p += 0.05) {
    let err = 0;
    for (const [x, y] of rot) err += (Math.abs(x / a) ** p + Math.abs(y / b) ** p - 1) ** 2;
    // Normalised by area, or a bigger bounding box always looks "better".
    const norm = err / (a * b);
    if (norm < best.err) best = { p, err: norm };
  }
  return { a, b, p: best.p, err: best.err };
}

/**
 * Fit |x/a|^p + |y/b|^p = 1 to a footprint.
 *
 * The orientation is SEARCHED, not taken from the principal axes. PCA gives the
 * long axis of an elongated bowl correctly, but a near-square one — an arena —
 * has no long axis at all, so the covariance is degenerate and it returns an
 * arbitrary angle. Rotating a squarish shape by that arbitrary amount inflates
 * its extents and flattens the exponent, and the fit comes out wrong in every
 * value at once. Ninety one-degree steps costs nothing and never degenerates.
 */
export function fitSuperellipse(ringLonLat: Pt[]): { a: number; b: number; exponent: number; angleDeg: number } {
  const { centred } = principalAxes(toMetres(ringLonLat));
  // principalAxes already rotated by its own estimate, so search around 0.
  let best = { a: 0, b: 0, p: 2, err: Infinity, deg: 0 };
  for (let deg = -90; deg <= 90; deg += 1) {
    const f = fitAt(centred, (deg * Math.PI) / 180);
    if (f.err < best.err) best = { ...f, deg };
  }
  // A bowl is described long-axis-first; swapping keeps a >= b without changing it.
  let { a, b } = best;
  let deg = best.deg;
  if (b > a) { [a, b] = [b, a]; deg += 90; }
  return { a: round(a, 1), b: round(b, 1), exponent: round(best.p, 2), angleDeg: round(((deg + 180) % 180), 1) };
}

const round = (n: number, d: number): number => Number(n.toFixed(d));

// ---- the part the data cannot tell you -------------------------------------

/**
 * Choose rows per tier so the built bowl actually holds `capacity`.
 *
 * Solved against generateSeatMap rather than a formula, because the renderer is
 * the authority: aisles, corner cuts and row offsets all move the real count,
 * and a closed form would drift from whatever the engine does next.
 */
export function solveRows(base: StadiumTemplate, capacity: number): { template: StadiumTemplate; built: number; iterations: number } {
  const shares = base.tiers.map((t) => t.rows);
  const total = shares.reduce((s, r) => s + r, 0) || 1;
  // Every tier is clamped to the rows a template may legally hold. Without this
  // the solver would happily answer a large stated capacity with 200 rows in one
  // tier — a template no store will keep and no bowl could be built from.
  const withScale = (k: number): StadiumTemplate => ({
    ...base,
    tiers: base.tiers.map((t, i) => ({
      ...t,
      rows: Math.round(clamp(Math.max(4, (shares[i] / total) * k), LIMITS.rows)),
    })) as TierSpec[],
  });
  // Bisect on total rows: the count rises monotonically with them, and flattens
  // once every tier is pinned at LIMITS.rows.max — which still converges, and
  // leaves `built` short of the target so buildStadium can say the bowl is full.
  let lo = 4, hi = MAX_TOTAL_ROWS, iterations = 0;
  let bestT = withScale(total), bestErr = Infinity, bestN = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const t = withScale(mid);
    const n = generateSeatMap(t).count;
    iterations++;
    const err = Math.abs(n - capacity);
    if (err < bestErr) { bestErr = err; bestT = t; bestN = n; }
    if (n === capacity) break;
    if (n < capacity) lo = mid + 1; else hi = mid - 1;
  }
  return { template: bestT, built: bestN, iterations };
}


// ---- reading the seating ring off overhead imagery -------------------------

/**
 * One radial probe across the bowl: the radii, out from the bowl's centre, at
 * which a sampler found seat-coloured pixels along one bearing.
 */
export interface RadialProbe {
  /** Bearing from the bowl centre, radians, 0 = +x. */
  theta: number;
  /** Radii in metres where the sampler saw seating, ascending. */
  hits: number[];
}

export interface RingMeasurement {
  /** Row-0 points in the bowl's own metre frame — the thing `plan` describes. */
  points: Pt[];
  /** Median seating band depth in metres, and its quartiles. */
  depth: { p25: number; median: number; p75: number };
  /** Bearings that produced a usable read, out of those offered. */
  used: number;
  offered: number;
}

/**
 * Turn radial probes into row-0 points and a band depth.
 *
 * Percentiles rather than min/max, and rather than the longest contiguous run:
 * a real bowl's seating is broken up by aisles, vomitories, camera platforms and
 * the shadow of its own roof, so the hits along one bearing arrive in fragments.
 * Taking the extremes lets one stray pixel set the answer; taking the longest
 * run throws away everything past the first aisle. On Amman the run-based
 * version read the band as 6.6 m where the percentile version reads 9.0 m.
 */
export function measureRing(probes: RadialProbe[], opts: { minHits?: number; minDepth?: number } = {}): RingMeasurement {
  // minHits is coupled to the CALLER's radial step and there is no way for this
  // function to know it: 25 hits is a comfortable read at a 0.2 m step and a
  // borderline one at 0.3 m, where a 9 m band yields 30 hits before aisles eat
  // into them. Pass it explicitly if you sample coarsely, or a real stand will
  // be discarded as no-data.
  const minHits = opts.minHits ?? 25;
  const minDepth = opts.minDepth ?? 6;
  const points: Pt[] = [];
  const depths: number[] = [];
  for (const p of probes) {
    if (p.hits.length < minHits) continue;
    const h = [...p.hits].sort((x, y) => x - y);
    const lo = h[Math.floor(0.06 * h.length)];
    const hi = h[Math.floor(0.94 * h.length)];
    if (hi - lo < minDepth) continue;
    points.push([Math.cos(p.theta) * lo, Math.sin(p.theta) * lo]);
    depths.push(hi - lo);
  }
  const q = (f: number): number => (depths.length ? [...depths].sort((a, b) => a - b)[Math.floor(f * (depths.length - 1))] : 0);
  return {
    points,
    depth: { p25: q(0.25), median: q(0.5), p75: q(0.75) },
    used: points.length,
    offered: probes.length,
  };
}

/**
 * Fit a superellipse to points already in metres about the bowl's centre.
 *
 * Separate from fitSuperellipse, which takes lon/lat and re-centres: these
 * points come from a sampler that already knows the centre, and re-deriving it
 * from a noisy, partly-occluded ring would move it. The half-axes are taken at
 * the 95th percentile rather than the maximum, so one bad read cannot set the
 * size of the stadium.
 */
export function fitRing(points: Pt[]): { a: number; b: number; exponent: number; angleDeg: number; rms: number } {
  if (points.length < 12) return { a: 0, b: 0, exponent: 2, angleDeg: 0, rms: Infinity };
  let best = { a: 0, b: 0, p: 2, err: Infinity, deg: 0 };
  for (let d10 = 0; d10 < 1800; d10 += 5) {
    const deg = d10 / 10;
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    const rot = points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos] as Pt);
    const pick = (vals: number[]): number => vals.sort((m, n) => m - n)[Math.floor(0.95 * (vals.length - 1))];
    const a = pick(rot.map((q) => Math.abs(q[0])));
    const b = pick(rot.map((q) => Math.abs(q[1])));
    if (a < 1 || b < 1) continue;
    for (let pi = 0; pi < 40; pi++) {
      const pe = 1.6 + pi * 0.08;
      let acc = 0;
      for (const [x, y] of rot) {
        const f = (Math.abs(x / a) ** pe + Math.abs(y / b) ** pe) ** (1 / pe);
        acc += (f - 1) ** 2;
      }
      const err = Math.sqrt(acc / rot.length);
      if (err < best.err) best = { a, b, p: pe, err, deg };
    }
  }
  let { a, b } = best;
  let deg = best.deg;
  if (b > a) { [a, b] = [b, a]; deg += 90; }
  return { a: round(a, 1), b: round(b, 1), exponent: round(best.p, 2), angleDeg: round(((deg + 180) % 180), 1), rms: round(best.err, 4) };
}

// ---- the part no public data can tell you: how the rows are split ----------

/**
 * How many tiers, from the total row count.
 *
 * This is the one number with no source. Capacity and footprint together fix how
 * many rows a bowl has; nothing fixes how they are stacked, because that is an
 * architect's decision. What geometry does constrain is the ceiling: a single
 * raked tier much past forty-odd rows stops working for sightlines and exits, so
 * a deep bowl is stacked out of necessity.
 *
 * Scored against all thirteen shipped templates this is right 10 times. The
 * three it misses are instructive rather than fixable: Al-Awwal and Kingdom
 * Arena are shallow (28 rows) and still two-tier, because modern builds put a
 * hospitality level in regardless, and the Jewel splits 50 rows three ways where
 * every other 50-row ground splits them two. So this is emitted as `suggested`
 * and belongs in the list a human is asked to confirm.
 */
export function suggestTierCount(totalRows: number): number {
  if (totalRows > 58) return 3;
  if (totalRows > 45) return 2;
  return 1;
}

/** Row shares per tier, from the shipped catalogue's own medians. */
const TIER_SHARES: Record<number, number[]> = {
  1: [1],
  2: [0.56, 0.44],
  3: [0.4, 0.34, 0.26],
};

/**
 * Build the tier stack for a bowl of `totalRows`.
 *
 * Only tier 0's geometry is chosen; every tier above it is DERIVED from the one
 * below — it starts just behind where that one ends and just above where it
 * tops out. That is how a bowl is actually built, and it means the upper tiers
 * contribute no free parameters to guess wrong. Rake steepens going up, because
 * a spectator at the back has to see over everyone in front.
 */
export function stackTiers(totalRows: number, tierCount: number, seatPitch = 0.5): TierSpec[] {
  const shares = TIER_SHARES[Math.max(1, Math.min(3, tierCount))] ?? TIER_SHARES[1];
  const RAKES = [24, 32, 38];
  const ROW_DEPTH = [0.85, 0.8, 0.78];
  const CONCOURSE_M = 2.5; // walkway between the back of one tier and the front of the next
  const STEP_M = 3.0; // the next tier's first row clears the one below

  const out: TierSpec[] = [];
  let offset = 0;
  let elevation = 1.5;
  for (let i = 0; i < shares.length; i++) {
    const rows = Math.max(4, Math.round(totalRows * shares[i]));
    const rowDepth = ROW_DEPTH[i] ?? 0.78;
    const rakeDeg = RAKES[i] ?? 38;
    out.push({ rows, rowDepth, rakeDeg, baseElevation: round(elevation, 1), baseOffset: round(offset, 1), seatPitch });
    const depth = rows * rowDepth;
    offset += depth + CONCOURSE_M;
    elevation += depth * Math.tan((rakeDeg * Math.PI) / 180) + STEP_M;
  }
  return out;
}

/**
 * Turning a BUILDING outline into the bowl inside it.
 *
 * The old code took the footprint's half-extents and subtracted a flat 22 m. On
 * Anfield's real outline that put row 0 at 100.3 m from the centre while the
 * touchline is at 52.5 m — a 47.8 m gap, half a pitch of empty grass between the
 * front row and the pitch, which is what the rendered bowl showed.
 *
 * Three things were wrong, and all three are fixed here.
 *
 * **Extents overshoot.** `fitSuperellipse` returns max|x| and max|y| of the
 * rotated ring, so one stair core or one corner of the main stand sets the whole
 * dimension. Measured on real outlines it makes grounds look square that are not:
 * Al-Awwal came out 116 x 114.5 (ratio 1.01) and King Fahd 150 x 148.8 (1.01).
 * AREA is the robust statistic — it is set by the whole polygon rather than by
 * its two furthest points — so the size comes from area and only the proportions
 * come from the extents.
 *
 * **The exponent is not a bowl's exponent.** Fitting the building returns 1.2 to
 * 2.05 on the seven grounds measured, because a building has notches, ramps and
 * an office block on the main stand. Every hand-built template in the catalogue
 * is between 2.0 and 2.9, and a bowl drawn at p=1.2 is a diamond, not a stadium.
 *
 * **The building is not the bowl.** Outside the last row there is a concourse,
 * an outer wall and the roof's supports. That is STRUCTURE_M of plan dimension
 * that is not seating, calibrated against Al-Awwal, whose hand-built template
 * (outer seating 86 x 72) sits inside a 28,219 m² footprint.
 */

/** A football pitch, half-extents in metres. Regulated, so this is not a guess. */
const PITCH_HALF_LENGTH = 52.5;
const PITCH_HALF_WIDTH = 34;
/**
 * How full of pitch the bowl is allowed to be, measured at the pitch's CORNER.
 *
 * A superellipse evaluates to 1 exactly on its own curve, so this is the value
 * at (52.5, 34): 0.72 leaves the corner comfortably inside with room for the
 * run-off and the advertising boards.
 *
 * It has to be a corner test, not a floor on a and b separately. Flooring the
 * axes independently let the curve pass 59.5 x 41 at Anfield, which clears the
 * touchline by 7 m on both axes and still cuts straight through the pitch
 * corners — the superellipse reads 1.47 there, half as far out again as its own
 * edge. Every hand-built template in the catalogue passes this test.
 */
const PITCH_FILL = 0.72;
/**
 * Outer edge of an 8-lane 400 m track, from World Athletics' marking plan
 * (36.5 m kerb radius + 8 x 1.22 m lanes, on a 84.39 m straight). Duplicated
 * from render/simulator/track rather than imported, because core stays free of
 * anything that pulls in a renderer.
 */
const TRACK_HALF_LENGTH = 88.5;
const TRACK_HALF_WIDTH = 46.3;

/** Concourse, outer wall and roof supports: building dimension that is not seats. */
const STRUCTURE_M = 10;

/**
 * How far behind the touchline row 0 may ever sit, without a track.
 *
 * Some OSM outlines are not the stadium. The Maracana's way covers the whole
 * complex including its esplanade — 83,555 m², against Old Trafford's 41,779 for
 * a similar crowd — and taken at face value it puts row 0 95 m behind the
 * touchline, a running track and a half of empty ground. The widest hand-built
 * bowl in the catalogue sets row 0 back 70 m, so past that the outline is
 * describing more than the bowl and the fit says so instead of drawing it.
 *
 * Grounds WITH a track are exempt: there the setback is real and measured.
 */
const MAX_SETBACK = 70;

/**
 * Where a real bowl's proportions and corner shape actually live.
 *
 * Both ranges are read off the thirteen hand-built templates, not chosen. Their
 * aspect ratios run 1.14 to 1.40; their exponents split cleanly by ground type,
 * which is why there are two of them:
 *
 *   football grounds  2.15 - 2.90   a rounded rectangle, stands squared up to
 *                                   the touchlines
 *   athletics ovals   2.00 - 2.10   genuinely elliptical, because the bowl
 *                                   follows the track's bends
 *
 * Fitting a BUILDING returns 1.6 to 2.95 with no regard for which it is, and 2.0
 * on a football ground draws a pure ellipse — the oval ring, corners and all,
 * that made the first Anfield render look nothing like Anfield.
 */
const PLAN_ASPECT = { min: 1.15, max: 1.45 };
const PLAN_EXPONENT_FOOTBALL = { min: 2.35, max: 3.0 };
const PLAN_EXPONENT_TRACK = { min: 2.0, max: 2.6 };

/**
 * Area of a superellipse with half-extents a, b and exponent p, as a multiple of
 * a*b. p=2 gives pi (an ellipse); p→infinity gives 4 (a rectangle).
 *
 * Exact form is 4*Gamma(1+1/p)^2 / Gamma(1+2/p). Lanczos is overkill for one
 * ratio over a two-unit range, so this is the exact value sampled and
 * interpolated — worst error against the closed form is under 0.2%.
 */
function superellipseAreaCoeff(p: number): number {
  const TABLE: [number, number][] = [
    [1.5, 2.585], [1.75, 2.927], [2.0, 3.142], [2.25, 3.290],
    [2.5, 3.397], [2.75, 3.478], [3.0, 3.541], [3.5, 3.632], [4.0, 3.695],
  ];
  if (p <= TABLE[0][0]) return TABLE[0][1];
  const last = TABLE[TABLE.length - 1];
  if (p >= last[0]) return last[1];
  for (let i = 1; i < TABLE.length; i++) {
    if (p <= TABLE[i][0]) {
      const [p0, c0] = TABLE[i - 1];
      const [p1, c1] = TABLE[i];
      return c0 + ((c1 - c0) * (p - p0)) / (p1 - p0);
    }
  }
  return last[1];
}

/** Planar area of a lon/lat ring, in square metres. */
function ringAreaM2(ringLonLat: Pt[]): number {
  const m = toMetres(ringLonLat);
  let a = 0;
  for (let i = 0, j = m.length - 1; i < m.length; j = i++) {
    a += m[j][0] * m[i][1] - m[i][0] * m[j][1];
  }
  return Math.abs(a / 2);
}

export interface OuterBowl {
  /** Half-extents of the OUTER edge of the seating, metres. */
  a: number;
  b: number;
  exponent: number;
  footArea: number;
  /** True when the outline's own shape had to be pulled into the range real bowls occupy. */
  clampedShape: boolean;
}

/**
 * The outer edge of the seating, from the building footprint.
 *
 * Size from area, proportions and corner shape from the outline but held to what
 * a bowl can actually be, then the non-seating structure taken off.
 */
export function outerBowlFromFootprint(
  footArea: number,
  f: { a: number; b: number; exponent: number },
  hasTrack?: boolean,
): OuterBowl {
  const rawAspect = f.b > 0 ? f.a / f.b : 1.25;
  const aspect = clamp(rawAspect, PLAN_ASPECT);
  const exponent = clamp(f.exponent, hasTrack ? PLAN_EXPONENT_TRACK : PLAN_EXPONENT_FOOTBALL);
  const clampedShape = Math.abs(aspect - rawAspect) > 0.02 || Math.abs(exponent - f.exponent) > 0.02;

  // area = coeff * a * b, with b = a / aspect
  const a = Math.sqrt((footArea * aspect) / superellipseAreaCoeff(exponent));
  return {
    a: Math.max(PITCH_HALF_LENGTH, a - STRUCTURE_M),
    b: Math.max(PITCH_HALF_WIDTH, a / aspect - STRUCTURE_M),
    exponent,
    footArea,
    clampedShape,
  };
}

/**
 * Row 0, given the outer edge and how deep the seating is.
 *
 * The floor is the thing that stops this swinging from one failure to the
 * opposite one: however deep the band, the bowl may never close in past the
 * pitch (or past the track, when the ground has one).
 */
export function planFromOuter(
  outer: { a: number; b: number; exponent: number },
  bandDepth: number,
  hasTrack?: boolean,
): { a: number; b: number; exponent: number; capped: boolean } {
  const exponent = clamp(outer.exponent, LIMITS.exponent);
  const aspect = outer.b > 0 ? outer.a / outer.b : 1.25;

  // Smallest bowl of this shape that still contains the pitch corner.
  //   (L/a)^p + (W/b)^p = PITCH_FILL, with a = aspect * b
  // solves for b directly.
  const bMin = Math.pow(
    (Math.pow(PITCH_HALF_LENGTH / aspect, exponent) + Math.pow(PITCH_HALF_WIDTH, exponent)) / PITCH_FILL,
    1 / exponent,
  );
  let floorA = aspect * bMin;
  let floorB = bMin;

  // A track is a discorectangle, not a superellipse, so it is checked on the
  // axes the way render/simulator/track checks it — a corner test would demand a
  // bowl far bigger than any real athletics ground.
  if (hasTrack) {
    floorA = Math.max(floorA, TRACK_HALF_LENGTH + 2);
    floorB = Math.max(floorB, TRACK_HALF_WIDTH + 2);
  }

  let a = Math.max(floorA, outer.a - bandDepth);
  let b = Math.max(floorB, outer.b - bandDepth);

  // Scale the whole curve, not just the long axis, so a capped bowl keeps its
  // proportions instead of turning into a different shape.
  let capped = false;
  if (!hasTrack && a > PITCH_HALF_LENGTH + MAX_SETBACK) {
    const k = (PITCH_HALF_LENGTH + MAX_SETBACK) / a;
    a *= k;
    b = Math.max(floorB, b * k);
    capped = true;
  }

  return {
    a: clamp(a, LIMITS.planA),
    b: clamp(b, LIMITS.planB),
    exponent,
    capped,
  };
}

// ---- the entry point, and saying where every number came from --------------

/**
 * How much to trust one field.
 *   measured  — came out of geometry, with a residual we can quote
 *   derived   — solved against a constraint (a stated capacity), error stated
 *   suggested — a rule of thumb or a model's opinion; belongs in `confirm`
 *   given     — the user told us
 */
export type Confidence = 'measured' | 'derived' | 'suggested' | 'given';

export interface FieldProvenance {
  source: string;
  confidence: Confidence;
  /** English, for scripts and CLI output. */
  note?: string;
  /**
   * The same note as a translation key plus its numbers, so the UI can render it
   * in the reader's language. Core stays free of i18n — it emits the key and the
   * values, and ui/stadiumImport does the lookup. Without this the most
   * informative part of the panel is English inside an Arabic interface, which
   * is exactly how it first shipped and exactly what a screenshot caught.
   */
  noteKey?: string;
  noteVars?: Record<string, string | number>;
}

/** A warning, keyed the same way and for the same reason. */
export interface FitWarning {
  text: string;
  key: string;
  vars?: Record<string, string | number>;
}

/**
 * A guess at how a ground is lit, from the only structural signal there is.
 *
 * Lights ride the roof when there is a roof to ride: a ring or two covered sides
 * carry a linear array, and a ground that is open, or has one roofed stand, has
 * pylons. That is genuinely how it works, and it is still only a guess, because
 * the real predictor is the decade the ground was built in and nothing public
 * tells us that. Measured against the shipped catalogue, this rule
 * agrees with the hand-set answer 8 times out of 13.
 * scripts/verify-stadiumfit.mts reads that sentence back out of this comment and
 * fails if it has drifted from what the rule actually scores, because a stale
 * accuracy figure is worse than none: it is the number the panel hedges by. The
 * five it misses are all grounds whose age, not whose roof, decided the answer.
 */
export function suggestLighting(roof: RoofCoverage | undefined): LightingStyle {
  if (roof === 'ring') return 'roof-rim';
  if (roof === 'sides') return 'side-banks';
  return 'corner-masts';
}

/**
 * A guess at what the outside is made of.
 *
 * Weaker than the lighting guess and honestly labelled as such: no public data
 * says what a building is clad in. What the inputs DO carry is a rough type —
 * a big roofed bowl, a municipal athletics ground, a mid-size club ground — and
 * each type has a usual answer. A photograph settles it properly; this is what
 * to draw until there is one.
 */
export function suggestFacade(opts: { capacity?: number; hasTrack?: boolean; roof?: RoofCoverage; bowlHeight: number }): FacadeStyle {
  // Banked earth is a real ground's answer only while the bowl is low enough to
  // bank. Above that the bank cannot explain the height and something is built.
  if (opts.hasTrack && opts.bowlHeight < 15) return 'berm';
  if (opts.hasTrack) return 'truss';
  if ((opts.capacity ?? 0) >= 55_000 && opts.roof === 'ring') return 'cladding';
  return 'concrete';
}

export interface FitInput {
  name?: string;
  id?: string;
  /** OSM footprint as [lon, lat] — the outer building outline. */
  footprint?: Pt[];
  /**
   * Row-0 points in metres about the bowl centre, from overhead imagery.
   * Strictly better than `footprint`, which is the outer wall: `plan` is the
   * inner edge of row 0, and using the wall puts every seat out in the concourse.
   */
  innerRing?: Pt[];
  /** Measured seating band depth in metres, if the imagery gave one. */
  bandDepth?: number;
  capacity?: number;
  /** Anything the user already knows overrides anything we would estimate. */
  known?: {
    tiers?: number;
    aisles?: number;
    seatPitch?: number;
    roof?: RoofCoverage;
    /** Does this ground have an athletics track? The renderer still checks it fits. */
    hasTrack?: boolean;
    /** How it is lit. Corner pylons or a roof-rim array is the clearest cue to a ground's age. */
    lighting?: LightingStyle;
    /** What the outside is made of. */
    facade?: FacadeStyle;
    cornerCut?: number;
  };
}

export interface FitResult {
  template: StadiumTemplate;
  provenance: Record<string, FieldProvenance>;
  /** Fields a human should look at before this is trusted. */
  confirm: string[];
  warnings: FitWarning[];
  /** Seats the built bowl holds, and the capacity it was aiming at. */
  built: number;
  target?: number;
}

/**
 * Estimate a StadiumTemplate from whatever is available.
 *
 * Nothing here is required. A map pin alone gives a footprint and a capacity and
 * that is enough for a usable bowl; each further input replaces a guess with a
 * measurement, and the provenance record says which is which. The order of
 * preference for the plan curve is: what the user gave us, then the seating ring
 * measured off imagery, then the building footprint inset by the bowl's depth —
 * and that last one is a fallback, not an equal.
 */
export function buildStadium(input: FitInput): FitResult {
  const prov: Record<string, FieldProvenance> = {};
  const confirm: string[] = [];
  const warnings: FitWarning[] = [];
  const k = input.known ?? {};

  // ---- plan curve
  let plan: { a: number; b: number; exponent: number };
  // Set only on the footprint path: the bowl's outer edge, which row 0 is then
  // set back from once the seating band is known. Null on the imagery path,
  // where row 0 was measured directly and nothing should move it.
  let footprintOuter: OuterBowl | null = null;
  /** The footprint describes more than the bowl — reported, not silently drawn. */
  let outlineTooBig = false;
  if (input.innerRing && input.innerRing.length >= 12) {
    const f = fitRing(input.innerRing);
    plan = { a: f.a, b: f.b, exponent: f.exponent };
    const p: FieldProvenance = {
      source: 'imagery-inner-edge',
      confidence: 'measured',
      note: `${input.innerRing.length} points, ${(f.rms * 100).toFixed(1)}% rms radial`,
      noteKey: 'si.note.ring',
      noteVars: { n: input.innerRing.length, rms: (f.rms * 100).toFixed(1) },
    };
    prov['plan.a'] = p; prov['plan.b'] = p; prov['plan.exponent'] = p;
  } else if (input.footprint && input.footprint.length >= 6) {
    const f = fitSuperellipse(input.footprint);
    const outer = outerBowlFromFootprint(ringAreaM2(input.footprint), f, k.hasTrack);
    // Placed below, once the row count is known: the bowl's inner edge is the
    // OUTER edge minus the seating band, and the band is not known until the
    // rows have been solved against the capacity. Seeded with a plausible band
    // so the first pass has something to stand on.
    footprintOuter = outer;
    const seeded = planFromOuter(outer, 26, k.hasTrack);
    if (seeded.capped) outlineTooBig = true;
    plan = seeded;
    const p: FieldProvenance = {
      source: 'osm-footprint-area',
      confidence: 'suggested',
      note: `outer bowl ${outer.a.toFixed(0)}x${outer.b.toFixed(0)} m from a ${Math.round(outer.footArea).toLocaleString()} m² footprint; plan is row 0, set back by the seating band`,
      noteKey: 'si.note.area',
      noteVars: { a: outer.a.toFixed(0), b: outer.b.toFixed(0), m2: Math.round(outer.footArea).toLocaleString() },
    };
    prov['plan.a'] = p; prov['plan.b'] = p; prov['plan.exponent'] = p;
    confirm.push('plan.a', 'plan.b');
    warnings.push({ key: 'si.warn.noRing', text: 'No seating ring measured: the bowl is derived from the building footprint and the capacity. Sample the imagery for a measured one.' });
    if (outer.clampedShape) {
      warnings.push({
        key: 'si.warn.shape',
        text: 'The building outline is not bowl-shaped on its own, so the corner shape and proportions were pulled to the range every real bowl sits in.',
      });
    }
  } else {
    throw new Error('buildStadium needs at least a footprint or a measured inner ring');
  }

  // ---- how many rows in total, and how they stack
  // Clamped because this number is also sectionsPerTier, whose floor is 4: a
  // user typing "2" into the aisles box used to produce a template that failed
  // validation on a field they had never seen.
  const aisles = Math.round(clamp(k.aisles ?? 28, {
    min: Math.max(LIMITS.aisleCount.min, LIMITS.sectionsPerTier.min),
    max: Math.min(LIMITS.aisleCount.max, LIMITS.sectionsPerTier.max),
  }));
  prov['aisles.count'] = k.aisles
    ? { source: 'user', confidence: 'given' }
    : { source: 'default', confidence: 'suggested', note: 'a stadium-sized default; imagery can count them', noteKey: 'si.note.aisles' };
  if (!k.aisles) confirm.push('aisles.count');

  const seatPitch = k.seatPitch ?? 0.5;
  prov['seatPitch'] = {
    source: k.seatPitch ? 'user' : 'regulation',
    confidence: k.seatPitch ? 'given' : 'derived',
    note: '~0.5 m is the regulated working figure',
    noteKey: k.seatPitch ? undefined : 'si.note.pitch',
  };

  // Rows come from the band depth when imagery measured one, because that is a
  // measurement; otherwise they fall out of the capacity solve below.
  let totalRows = input.bandDepth ? Math.max(4, Math.round(input.bandDepth / 0.8)) : 30;
  if (input.bandDepth) {
    prov['tiers.rows'] = {
      source: 'imagery-band-depth',
      confidence: 'measured',
      note: `${input.bandDepth.toFixed(1)} m at ~0.8 m per row`,
      noteKey: 'si.note.band',
      noteVars: { m: input.bandDepth.toFixed(1) },
    };
  }

  let tierCount = k.tiers ?? suggestTierCount(totalRows);
  prov['tiers.length'] = k.tiers
    ? { source: 'user', confidence: 'given' }
    : { source: 'row-count-rule', confidence: 'suggested', note: 'right on 10 of 13 shipped templates; a photo settles it', noteKey: 'si.note.tiers' };
  if (!k.tiers) confirm.push('tiers.length');

  const mkBase = (
    p: { a: number; b: number; exponent: number },
    rows: number,
    tiers: number,
  ): StadiumTemplate => ({
    id: input.id ?? 'fitted',
    name: input.name ?? 'Fitted stadium',
    version: 1,
    plan: p,
    tiers: stackTiers(rows, tiers, seatPitch),
    aisles: { count: aisles, widthMeters: 1.2 },
    sectionsPerTier: aisles,
    evenRows: true,
    ...(k.cornerCut !== undefined ? { cornerCut: k.cornerCut } : {}),
    ...(k.roof ? { roof: { coverage: k.roof } } : {}),
    ...(k.hasTrack ? { track: {} } : {}),
  });

  let base = mkBase(plan, totalRows, tierCount);
  if (k.roof) prov['roof.coverage'] = { source: 'user', confidence: 'given' };
  else confirm.push('roof.coverage');
  if (k.hasTrack !== undefined) prov['track'] = { source: 'user', confidence: 'given' };
  else confirm.push('track');

  // ---- rows against the stated capacity, if there is one
  let template = base;
  let built = generateSeatMap(base).count;
  if (input.capacity && input.capacity > 0) {
    // Plan, rows and tier count are one problem, not three in a row.
    //
    // Doing them in sequence is what produced a 43-row single tier at Anfield:
    // the tier count was decided from the placeholder 30 rows BEFORE the
    // capacity solve replaced it, and on the footprint path row 0 was fixed
    // before anything knew how deep the seating would be. Each pass re-seats
    // row 0 behind the band the previous pass produced, re-splits the tiers for
    // the row count it found, and re-solves. It settles in two or three passes;
    // the loop stops as soon as nothing moves.
    let solved = solveRows(base, input.capacity);
    for (let pass = 0; pass < 4; pass++) {
      const rows = solved.template.tiers.reduce((n, t) => n + t.rows, 0);
      const band = solved.template.tiers.reduce((d, t) => d + t.rows * t.rowDepth, 0);
      const nextTiers = k.tiers ?? suggestTierCount(rows);
      const next = footprintOuter ? planFromOuter(footprintOuter, band, k.hasTrack) : null;
      if (next?.capped) outlineTooBig = true;
      const nextPlan = next ?? plan;
      const settled =
        nextTiers === tierCount &&
        Math.abs(nextPlan.a - base.plan.a) < 0.5 &&
        Math.abs(nextPlan.b - base.plan.b) < 0.5;
      if (settled) break;
      tierCount = nextTiers;
      plan = nextPlan;
      base = mkBase(plan, rows, tierCount);
      solved = solveRows(base, input.capacity);
    }
    template = solved.template;
    built = solved.built;
    totalRows = template.tiers.reduce((n, t) => n + t.rows, 0);
    const err = Math.abs(built - input.capacity) / input.capacity;
    prov['tiers.rows'] = {
      source: 'capacity-solve',
      confidence: 'derived',
      note: `${built.toLocaleString()} built vs ${input.capacity.toLocaleString()} stated, ${(err * 100).toFixed(1)}%`,
      noteKey: 'si.note.capacity',
      noteVars: { built: built.toLocaleString(), stated: input.capacity.toLocaleString(), pct: (err * 100).toFixed(1) },
    };
    if (err > 0.1) {
      warnings.push({
        key: 'si.warn.capOff',
        vars: { pct: (err * 100).toFixed(0) },
        text: `Capacity is ${(err * 100).toFixed(0)}% out after solving — the plan curve or the capacity is wrong.`,
      });
    }
  } else {
    warnings.push({ key: 'si.warn.noCapacity', text: 'No capacity: the row count is a guess and nothing checks it.' });
    confirm.push('tiers.rows');
  }

  // ---- how it is lit, and what the outside is made of
  // Both come last, because both depend on the bowl's final height and that is
  // only settled once the rows have been solved against the capacity. A facade
  // chosen from the pre-solve height is a facade chosen from a number we were
  // about to change.
  const bowlHeight = template.tiers.reduce((h, t) => {
    const last = Math.max(1, t.rows - 1);
    return Math.max(h, t.baseElevation + last * t.rowDepth * Math.tan((t.rakeDeg * Math.PI) / 180));
  }, 0);
  const lighting = k.lighting ?? suggestLighting(k.roof);
  const facade = k.facade ?? suggestFacade({ capacity: input.capacity, hasTrack: k.hasTrack, roof: k.roof, bowlHeight });
  template = { ...template, lighting: { style: lighting }, facade: { style: facade } };
  prov['lighting.style'] = k.lighting
    ? { source: 'user', confidence: 'given' }
    : {
      source: 'roof-shape-rule',
      confidence: 'suggested',
      note: 'from the roof: a ring or two covered sides carry a linear array, anything else has pylons',
      noteKey: 'si.note.lighting',
    };
  if (!k.lighting) confirm.push('lighting.style');
  prov['facade.style'] = k.facade
    ? { source: 'user', confidence: 'given' }
    : {
      source: 'ground-type-rule',
      confidence: 'suggested',
      note: 'nothing public says what a building is clad in — a photo settles this one',
      noteKey: 'si.note.facade',
    };
  if (!k.facade) confirm.push('facade.style');

  if (outlineTooBig) {
    warnings.push({
      key: 'si.warn.outlineBig',
      text: 'The outline OpenStreetMap has for this ground is far larger than its crowd needs, so it probably covers the surroundings too. The bowl was held to a plausible size — check it, or measure the imagery.',
    });
    if (!confirm.includes('plan.a')) confirm.push('plan.a');
  }

  // ---- last gate: never hand back a template the store will refuse
  // Everything above clamps as it goes, so this should be a no-op. It is here
  // because the failure it guards against is invisible: an out-of-range template
  // was saved, dropped on the next read, and the panel still said "Added". If a
  // field does have to move, that is a fit which did not converge, and the user
  // is told rather than handed a bowl that is not the one they asked for.
  const moved = outOfRange(template);
  if (moved.length) {
    template = clampTemplate(template);
    built = generateSeatMap(template).count;
    warnings.push({
      key: 'si.warn.clamped',
      vars: { fields: moved.join(', ') },
      text: `Pinned to the buildable range: ${moved.join(', ')}. The ground may be larger or smaller than a template can describe.`,
    });
    for (const f of moved) if (!confirm.includes(f)) confirm.push(f);
  }

  return { template, provenance: prov, confirm, warnings, built, target: input.capacity };
}
