import type { SeatMap, StadiumTemplate, StandSide, TierBlocks, TierSpec } from './types';
import { CURVE_SAMPLES, buildOffsetCurve, samplePlanCurve, type Curve, type OffsetCurve } from './planCurve';

/**
 * Real block layouts (TierSpec.blocks): a real ground's stairways, lateral
 * walkways and openings, compiled once per tier into lines the seat-map
 * generator tests every seat against.
 *
 * Why this exists: until it did, every ground's stairs sat at perfectly even
 * perimeter fractions (`aisles.count`), the same in every tier, and its
 * blocks were the bowl cut into `sectionsPerTier` equal slices. No real
 * ground is built like that. At Prince Abdullah Al-Faisal the stand opposite
 * the main stand has a front band whose blocks are 28, 20 and 29 seats wide,
 * a band behind it with a stairway on the centre line where the front band
 * has the players' tunnel, and an upper tier whose stairs are on a third,
 * regular rhythm — none of them lining up.
 *
 * A stairway is a line square to the plan curve from a point on it, out
 * through every row — which is what a radial stairway is. Because a row's
 * seats sit on the plan curve pushed out along the same normals
 * (planCurve.buildOffsetCurve), a line from sample index i meets every row at
 * that row's own sample i: so "is this seat in the stairway" is a distance
 * along the row's arc, measured in metres, the way the old aisles were in u.
 *
 * Pure and DOM-free: the generator, the server's seat count and the renderer
 * all compile the same lines here.
 */

const N = CURVE_SAMPLES;

/** Plan-curve sample index of each side's centre: t = 0, π/2, π, 3π/2. */
export const SIDE_INDEX: Record<StandSide, number> = { east: 0, north: N / 4, west: N / 2, south: (3 * N) / 4 };

/**
 * Which way a positive station runs round the curve. The curve runs
 * anticlockwise (east → north → west → south); a station's sign follows the
 * side's along-axis, x for north and south and z for the ends, as every other
 * along-a-side coordinate in the templates does (StandGap.from/to).
 */
const SIDE_SIGN: Record<StandSide, 1 | -1> = { east: 1, north: -1, west: -1, south: 1 };

/** Bounds a template's blocks must stay inside — they come from users too (customStadiums). */
export const BLOCK_LIMITS = { linesPerTier: 400, walkwaysPerTier: 20, maxStation: 2000, maxWidth: 30 } as const;

/** One stairway or opening, compiled. */
export interface BlockLine {
  /** Unique within the tier; stairways are numbered in perimeter order. */
  id: number;
  /** Fractional plan-curve sample index of its foot, 0 ≤ idx < CURVE_SAMPLES. */
  idx: number;
  halfW: number;
  /** Rows of the tier it runs through, inclusive. */
  r0: number;
  r1: number;
  kind?: string;
}

/** A walkway row, optionally only between two sample indices (wrap-aware). */
export interface WalkLine {
  row: number;
  i0?: number;
  i1?: number;
}

export interface CompiledBlocks {
  /** Sorted by idx. */
  aisles: BlockLine[];
  openings: BlockLine[];
  walkways: WalkLine[];
}

/** Arc position (metres from sample 0) of a fractional sample index on an offset curve. */
export function arcAtIndex(oc: OffsetCurve, idx: number): number {
  const i = Math.floor(idx) % N;
  const f = idx - Math.floor(idx);
  const s0 = oc.s[i];
  const s1 = i + 1 === N ? oc.total : oc.s[i + 1];
  return s0 + (s1 - s0) * f;
}

/** Fractional sample index of an arc position on an offset curve (inverse of arcAtIndex). */
export function indexAtArc(oc: OffsetCurve, arc: number): number {
  const target = ((arc % oc.total) + oc.total) % oc.total;
  let lo = 0;
  let hi = N - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (oc.s[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const s1 = lo + 1 === N ? oc.total : oc.s[lo + 1];
  const seg = s1 - oc.s[lo] || 1e-9;
  return lo + Math.min(1, Math.max(0, (target - oc.s[lo]) / seg));
}

/** The sample index of a station on a curve (the tier's front row). */
export function stationIndex(front: OffsetCurve, side: StandSide, station: number): number {
  return indexAtArc(front, front.s[SIDE_INDEX[side]] + SIDE_SIGN[side] * station);
}

/** Does a walkway cover this sample index? */
export function walkCovers(w: WalkLine, idx: number): boolean {
  if (w.i0 === undefined || w.i1 === undefined) return true;
  return w.i0 <= w.i1 ? idx >= w.i0 && idx <= w.i1 : idx >= w.i0 || idx <= w.i1;
}

function expand(at: number[], mirror?: boolean): number[] {
  const out: number[] = [];
  for (const s of at) {
    out.push(s);
    if (mirror && s !== 0) out.push(-s);
  }
  return out;
}

/** Is this a usable block layout? Bounded, because user-submitted templates reach the server's generator. */
export function validBlocks(b: unknown, tierRows: number): b is TierBlocks {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const side = (x: unknown): boolean => x === 'north' || x === 'south' || x === 'east' || x === 'west';
  const rows = (x: unknown): boolean =>
    Array.isArray(x) && x.length === 2 && fin(x[0]) && fin(x[1]) && x[0] >= 0 && x[0] <= x[1] && x[1] < tierRows;
  const stations = (x: unknown): boolean =>
    Array.isArray(x) && x.length > 0 && x.length <= BLOCK_LIMITS.linesPerTier && x.every((s) => fin(s) && Math.abs(s) <= BLOCK_LIMITS.maxStation);
  const width = (x: unknown, min: number): boolean => fin(x) && x >= min && x <= BLOCK_LIMITS.maxWidth;
  if (!Array.isArray(o.aisles) || o.aisles.length > BLOCK_LIMITS.linesPerTier) return false;
  if (o.width !== undefined && !width(o.width, 0.3)) return false;
  let lines = 0;
  for (const a of o.aisles as Record<string, unknown>[]) {
    if (!a || !side(a.side) || !stations(a.at)) return false;
    if (a.rows !== undefined && !rows(a.rows)) return false;
    if (a.width !== undefined && !width(a.width, 0.3)) return false;
    lines += (a.at as number[]).length * (a.mirror ? 2 : 1);
  }
  if (o.openings !== undefined) {
    if (!Array.isArray(o.openings) || o.openings.length > BLOCK_LIMITS.linesPerTier) return false;
    for (const p of o.openings as Record<string, unknown>[]) {
      if (!p || !side(p.side) || !stations(p.at) || !rows(p.rows) || !width(p.width, 0.3)) return false;
      lines += (p.at as number[]).length * (p.mirror ? 2 : 1);
    }
  }
  if (lines > BLOCK_LIMITS.linesPerTier) return false;
  if (o.walkways !== undefined) {
    if (!Array.isArray(o.walkways) || o.walkways.length > BLOCK_LIMITS.walkwaysPerTier) return false;
    for (const w of o.walkways as Record<string, unknown>[]) {
      if (!w || !fin(w.row) || w.row < 0 || w.row >= tierRows) return false;
      if (w.side !== undefined && !side(w.side)) return false;
      if ((w.from !== undefined || w.to !== undefined) && (w.side === undefined || !fin(w.from) || !fin(w.to) || (w.from as number) > (w.to as number))) return false;
    }
  }
  return true;
}

/**
 * Compile one tier's blocks against the plan curve. Stations are measured on
 * the tier's own front row; each becomes the sample index its square line
 * starts from. Two stairways at the same place are one stairway.
 */
export function compileTierBlocks(curve: Curve, tier: TierSpec, defaultWidth: number): CompiledBlocks {
  const b = tier.blocks!;
  const front = buildOffsetCurve(curve, tier.baseOffset);
  const last = tier.rows - 1;
  const w0 = b.width ?? defaultWidth;
  const raw: Omit<BlockLine, 'id'>[] = [];
  for (const a of b.aisles) {
    const [r0, r1] = a.rows ?? [0, last];
    for (const s of expand(a.at, a.mirror)) raw.push({ idx: stationIndex(front, a.side, s), halfW: (a.width ?? w0) / 2, r0, r1 });
  }
  raw.sort((p, q) => p.idx - q.idx || p.r0 - q.r0);
  const aisles: BlockLine[] = [];
  for (const l of raw) {
    const prev = aisles[aisles.length - 1];
    if (prev && Math.abs(prev.idx - l.idx) < 1e-3 && prev.r0 === l.r0 && prev.r1 === l.r1) continue;
    aisles.push({ ...l, id: aisles.length });
  }
  const openings: BlockLine[] = [];
  for (const o of b.openings ?? []) {
    for (const s of expand(o.at, o.mirror)) {
      openings.push({ id: openings.length, idx: stationIndex(front, o.side, s), halfW: o.width / 2, r0: o.rows[0], r1: o.rows[1], kind: o.kind });
    }
  }
  // The players' tunnel and a gate run the full depth of their band, so the
  // seats either side of one are two blocks, as either side of a stairway.
  // A vomitory is a hole in the front of a block, not the end of it.
  for (const o of openings) {
    if (o.kind === 'tunnel' || o.kind === 'gate') aisles.push({ ...o, id: aisles.length });
  }
  aisles.sort((p, q) => p.idx - q.idx || p.id - q.id);
  const walkways: WalkLine[] = (b.walkways ?? []).map((w) => {
    if (!w.side || w.from === undefined || w.to === undefined) return { row: w.row };
    // A walkway along part of one side: from ≤ to along the side's axis, which
    // is the reverse of the curve's direction on north and west.
    let i0 = stationIndex(front, w.side, w.from);
    let i1 = stationIndex(front, w.side, w.to);
    if (SIDE_SIGN[w.side] < 0) [i0, i1] = [i1, i0];
    return { row: w.row, i0, i1 };
  });
  return { aisles, openings, walkways };
}

/** Every tier's compiled blocks (null for a tier without), for a template. */
export function compileBlocks(template: StadiumTemplate, curve?: Curve): (CompiledBlocks | null)[] {
  if (!template.tiers.some((t) => t.blocks)) return template.tiers.map(() => null);
  const c = curve ?? samplePlanCurve(template.plan.a, template.plan.b, template.plan.exponent);
  return template.tiers.map((t) => {
    if (!t.blocks) return null;
    if (t.straight) throw new Error(`${template.id}: blocks need a ring tier, not a straight one`);
    if (!template.evenRows) throw new Error(`${template.id}: blocks need evenRows`);
    return compileTierBlocks(c, t, template.aisles.widthMeters);
  });
}

/**
 * Stairway stations from a seat plan: the blocks along a stand as a ticketing
 * plan gives them, seats per row on the front row ("block 101: 24, 102: 18,
 * …"). From the stairway at `from`, each block takes its seats at `pitch`
 * metres and then the next stairway, `width` wide; `dir` is which way along
 * the side's axis the blocks run. Returns the station of every stairway after
 * a block — so `[from, ...stationsFromSeats(from, seats)]` is the whole run.
 */
export function stationsFromSeats(from: number, seats: number[], pitch = 0.5, width = 1.2, dir: 1 | -1 = 1): number[] {
  const out: number[] = [];
  let at = from;
  for (const n of seats) {
    at += dir * (width + n * pitch);
    out.push(Math.round(at * 100) / 100);
  }
  return out;
}

/** Does this template lay any tier out in real blocks? */
export function hasBlocks(template: StadiumTemplate): boolean {
  return template.tiers.some((t) => !!t.blocks);
}

/** The widest stairway in a template, metres: what a colour fill may bridge. */
export function widestAisle(template: StadiumTemplate): number {
  let w = template.aisles.widthMeters;
  for (const t of template.tiers) {
    if (!t.blocks) continue;
    const d = t.blocks.width ?? template.aisles.widthMeters;
    w = Math.max(w, d);
    for (const a of t.blocks.aisles) w = Math.max(w, a.width ?? d);
  }
  return w;
}

/**
 * Where each of a tier's openings is, as a quad on the stand: its four
 * corners at the front edge of its first row and the back edge of its last,
 * in plan metres, with the heights of those two edges. For the renderer, which
 * draws the dark mouth of a vomitory or the tunnel where the seats stop.
 */
export interface OpeningQuad {
  tier: number;
  kind?: string;
  /** Front-left, front-right, back-right, back-left: [x, z]. */
  corners: [number, number][];
  frontY: number;
  backY: number;
  /** Outward normal at the opening's centre line. */
  normal: [number, number];
}

export function openingQuads(template: StadiumTemplate): OpeningQuad[] {
  if (!hasBlocks(template)) return [];
  const curve = samplePlanCurve(template.plan.a, template.plan.b, template.plan.exponent);
  const compiled = compileBlocks(template, curve);
  const out: OpeningQuad[] = [];
  template.tiers.forEach((tier, ti) => {
    const cb = compiled[ti];
    if (!cb) return;
    const rake = Math.tan((tier.rakeDeg * Math.PI) / 180);
    for (const o of cb.openings) {
      const rFront = tier.baseOffset + (o.r0 - 0.5) * tier.rowDepth;
      const rBack = tier.baseOffset + (o.r1 + 0.5) * tier.rowDepth;
      const at = (radial: number, side: -1 | 1): [number, number] => {
        const oc = buildOffsetCurve(curve, radial);
        const idx = indexAtArc(oc, arcAtIndex(oc, o.idx) + side * o.halfW);
        const i = Math.floor(idx) % N;
        const j = (i + 1) % N;
        const f = idx - Math.floor(idx);
        return [oc.x[i] + (oc.x[j] - oc.x[i]) * f, oc.z[i] + (oc.z[j] - oc.z[i]) * f];
      };
      const i = Math.floor(o.idx) % N;
      out.push({
        tier: ti,
        kind: o.kind,
        corners: [at(rFront, -1), at(rFront, 1), at(rBack, 1), at(rBack, -1)],
        frontY: tier.baseElevation + (o.r0 - 0.5) * tier.rowDepth * rake,
        backY: tier.baseElevation + (o.r1 + 0.5) * tier.rowDepth * rake,
        normal: [curve.nx[i], curve.ny[i]],
      });
    }
  });
  return out;
}

/**
 * What a planner calls each block: its stand, its tier and its number along
 * that stand. The stand is the side of the bowl the block's middle seat is
 * on; blocks are numbered along each stand from its left-hand end as you
 * face it from the pitch. Works for every template — an even layout's
 * sections come out numbered the same way.
 */
export interface SectionInfo {
  stand: StandSide;
  tier: number;
  /** 1-based, along the stand and tier, left to right from the pitch. */
  number: number;
  seats: number;
}

export function sectionInfo(map: SeatMap): Map<number, SectionInfo> {
  const acc = new Map<number, { tier: number; c: number; s: number; n: number }>();
  for (let i = 0; i < map.count; i++) {
    const id = map.sectionOf[i];
    let e = acc.get(id);
    if (!e) {
      e = { tier: map.tierOf[i], c: 0, s: 0, n: 0 };
      acc.set(id, e);
    }
    // Circular mean of u, so a block straddling the seam at u = 0 is not put on the far side.
    const a = map.uv[i * 2] * Math.PI * 2;
    e.c += Math.cos(a);
    e.s += Math.sin(a);
    e.n++;
  }
  const rows: { id: number; stand: StandSide; tier: number; u: number; n: number }[] = [];
  for (const [id, e] of acc) {
    const u = (((Math.atan2(e.s, e.c) / (Math.PI * 2)) % 1) + 1) % 1;
    const k = Math.round(u * 4) % 4;
    const stand = (['east', 'north', 'west', 'south'] as const)[k];
    // Face the stand from the pitch: left to right is decreasing u on every
    // side (the curve runs anticlockwise seen from above). Measure from the
    // stand's centre so the east end's blocks either side of u = 0 order right.
    let d = u - k / 4;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    rows.push({ id, stand, tier: e.tier, u: -d, n: e.n });
  }
  rows.sort((p, q) => p.tier - q.tier || p.u - q.u);
  const counter = new Map<string, number>();
  const out = new Map<number, SectionInfo>();
  for (const r of rows) {
    const key = `${r.stand}:${r.tier}`;
    const n = (counter.get(key) ?? 0) + 1;
    counter.set(key, n);
    out.set(r.id, { stand: r.stand, tier: r.tier, number: n, seats: r.n });
  }
  return out;
}
