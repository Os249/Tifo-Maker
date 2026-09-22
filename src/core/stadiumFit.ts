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
    // The footprint is the OUTER wall. plan is row 0. Inset by a plausible bowl
    // depth or every seat lands in the concourse — the exact mistake the first
    // Amman import made, which rendered a velodrome.
    const inset = input.bandDepth ?? 22;
    // Floors come from LIMITS, not from a number typed here. The old floor for b
    // was 15, four metres under what isValidTemplate accepts, so a small ground
    // produced a template the store silently threw away.
    plan = {
      a: clamp(f.a - inset, LIMITS.planA),
      b: clamp(f.b - inset, LIMITS.planB),
      exponent: clamp(f.exponent, LIMITS.exponent),
    };
    const p: FieldProvenance = {
      source: 'osm-footprint-inset',
      confidence: 'suggested',
      note: `outer ${f.a}x${f.b} m inset by ${inset} m; plan is row 0, not the wall`,
      noteKey: 'si.note.inset',
      noteVars: { a: f.a, b: f.b, inset: Math.round(inset) },
    };
    prov['plan.a'] = p; prov['plan.b'] = p; prov['plan.exponent'] = p;
    confirm.push('plan.a', 'plan.b');
    warnings.push({ key: 'si.warn.noRing', text: 'No seating ring measured: the plan curve is the building outline inset by a guess. Sample the imagery for a real one.' });
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

  const tierCount = k.tiers ?? suggestTierCount(totalRows);
  prov['tiers.length'] = k.tiers
    ? { source: 'user', confidence: 'given' }
    : { source: 'row-count-rule', confidence: 'suggested', note: 'right on 10 of 13 shipped templates; a photo settles it', noteKey: 'si.note.tiers' };
  if (!k.tiers) confirm.push('tiers.length');

  const base: StadiumTemplate = {
    id: input.id ?? 'fitted',
    name: input.name ?? 'Fitted stadium',
    version: 1,
    plan,
    tiers: stackTiers(totalRows, tierCount, seatPitch),
    aisles: { count: aisles, widthMeters: 1.2 },
    sectionsPerTier: aisles,
    evenRows: true,
    ...(k.cornerCut !== undefined ? { cornerCut: k.cornerCut } : {}),
    ...(k.roof ? { roof: { coverage: k.roof } } : {}),
    ...(k.hasTrack ? { track: {} } : {}),
  };
  if (k.roof) prov['roof.coverage'] = { source: 'user', confidence: 'given' };
  else confirm.push('roof.coverage');
  if (k.hasTrack !== undefined) prov['track'] = { source: 'user', confidence: 'given' };
  else confirm.push('track');

  // ---- rows against the stated capacity, if there is one
  let template = base;
  let built = generateSeatMap(base).count;
  if (input.capacity && input.capacity > 0) {
    const solved = solveRows(base, input.capacity);
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
