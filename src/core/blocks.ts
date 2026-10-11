import type { SeatMap, StadiumTemplate, StandSide, TierBlocks, TierSpec } from './types';
import { CURVE_SAMPLES, buildOffsetCurve, samplePlanCurve, straightPoint, type Curve, type OffsetCurve } from './planCurve';
import { alongOf, sideAt } from './standSpans';

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
 * A straight tier (TierSpec.straight) is simpler: its stands are lines, a
 * station is metres along one, and a stairway is the same `along` in every
 * row (CompiledStraightBlocks).
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
export const BLOCK_LIMITS = { linesPerTier: 400, walkwaysPerTier: 20, maxStation: 2000, maxWidth: 30, areasPerTier: 60, nameLength: 24 } as const;

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
  /** The side it runs along, if only one. */
  side?: StandSide;
}

/** A seat-free area of a ring tier, compiled: rows, and sample indices along them (wrap-aware). */
export interface AreaLine {
  r0: number;
  r1: number;
  i0: number;
  i1: number;
  kind: string;
}

export interface CompiledBlocks {
  straight?: undefined;
  /** Sorted by idx. */
  aisles: BlockLine[];
  openings: BlockLine[];
  walkways: WalkLine[];
  areas: AreaLine[];
}

/** One stairway or opening of a straight tier: `along` its side, square to the stand. */
export interface StraightLine {
  id: number;
  side: StandSide;
  along: number;
  halfW: number;
  r0: number;
  r1: number;
  kind?: string;
}

/** A straight tier's blocks, compiled. Every position is metres along a side (x for north and south, z for the ends). */
export interface CompiledStraightBlocks {
  straight: true;
  /** Sorted by side, then along. */
  aisles: StraightLine[];
  openings: StraightLine[];
  walkways: { row: number; side?: StandSide; from?: number; to?: number }[];
  areas: { side: StandSide; from: number; to: number; r0: number; r1: number; kind: string }[];
}

export type CompiledTier = CompiledBlocks | CompiledStraightBlocks;

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
  if (o.areas !== undefined) {
    if (!Array.isArray(o.areas) || o.areas.length > BLOCK_LIMITS.areasPerTier) return false;
    const kinds = ['press', 'platform', 'gantry', 'segregation'];
    for (const a of o.areas as Record<string, unknown>[]) {
      if (!a || !side(a.side) || !rows(a.rows) || !kinds.includes(a.kind as string)) return false;
      if (!fin(a.from) || !fin(a.to) || (a.from as number) > (a.to as number) || Math.abs(a.from as number) > BLOCK_LIMITS.maxStation || Math.abs(a.to as number) > BLOCK_LIMITS.maxStation) return false;
    }
  }
  if (o.names !== undefined) {
    if (!Array.isArray(o.names) || o.names.length > BLOCK_LIMITS.walkwaysPerTier * 4) return false;
    const label = (x: unknown): boolean => typeof x === 'string' && x.length > 0 && x.length <= BLOCK_LIMITS.nameLength;
    for (const n of o.names as Record<string, unknown>[]) {
      if (!n || !side(n.side)) return false;
      if (n.band !== undefined && (!fin(n.band) || n.band < 0 || n.band > BLOCK_LIMITS.walkwaysPerTier)) return false;
      if (n.names !== undefined) {
        if (!Array.isArray(n.names) || n.names.length > BLOCK_LIMITS.linesPerTier || !n.names.every(label)) return false;
      } else if (!fin(n.first) || Math.abs(n.first) > 1e6) return false;
      if (n.step !== undefined && (!fin(n.step) || Math.abs(n.step) > 1e4)) return false;
      for (const k of ['prefix', 'suffix']) if (n[k] !== undefined && (typeof n[k] !== 'string' || (n[k] as string).length > BLOCK_LIMITS.nameLength)) return false;
    }
  }
  return true;
}

/**
 * Compile one tier's blocks against the plan curve. Stations are measured on
 * the tier's own front row; each becomes the sample index its square line
 * starts from. Two stairways at the same place are one stairway.
 */
export function compileTierBlocks(curve: Curve, tier: TierSpec, defaultWidth: number, template?: StadiumTemplate): CompiledBlocks {
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
    if (!w.side) return { row: w.row };
    // A walkway along one side: the whole of it, corner to corner, unless it
    // says where it runs (from ≤ to along the side's axis, which is the
    // reverse of the curve's direction on north and west).
    const whole = w.from === undefined || w.to === undefined;
    const c = whole && template ? cornerStation(template, tier, w.side) : 0;
    if (whole && !template) return { row: w.row };
    let i0 = stationIndex(front, w.side, whole ? -c : w.from!);
    let i1 = stationIndex(front, w.side, whole ? c : w.to!);
    if (SIDE_SIGN[w.side] < 0) [i0, i1] = [i1, i0];
    return { row: w.row, i0, i1, side: w.side };
  });
  const areas: AreaLine[] = (b.areas ?? []).map((a) => {
    let i0 = stationIndex(front, a.side, a.from);
    let i1 = stationIndex(front, a.side, a.to);
    if (SIDE_SIGN[a.side] < 0) [i0, i1] = [i1, i0];
    return { r0: a.rows[0], r1: a.rows[1], i0, i1, kind: a.kind };
  });
  return { aisles, openings, walkways, areas };
}

/**
 * Compile a straight tier's blocks. Its stands are lines square to the pitch,
 * so a station is just metres along the side and a stairway is the same
 * `along` in every row; the tunnel and a gate end a block as a stairway does.
 */
export function compileStraightBlocks(tier: TierSpec, defaultWidth: number): CompiledStraightBlocks {
  const b = tier.blocks!;
  const last = tier.rows - 1;
  const w0 = b.width ?? defaultWidth;
  const raw: Omit<StraightLine, 'id'>[] = [];
  for (const a of b.aisles) {
    const [r0, r1] = a.rows ?? [0, last];
    for (const s of expand(a.at, a.mirror)) raw.push({ side: a.side, along: s, halfW: (a.width ?? w0) / 2, r0, r1 });
  }
  const openings: StraightLine[] = [];
  for (const o of b.openings ?? []) {
    for (const s of expand(o.at, o.mirror)) openings.push({ id: openings.length, side: o.side, along: s, halfW: o.width / 2, r0: o.rows[0], r1: o.rows[1], kind: o.kind });
  }
  for (const o of openings) if (o.kind === 'tunnel' || o.kind === 'gate') raw.push({ side: o.side, along: o.along, halfW: o.halfW, r0: o.r0, r1: o.r1, kind: o.kind });
  const order: Record<StandSide, number> = { east: 0, north: 1, west: 2, south: 3 };
  raw.sort((p, q) => order[p.side] - order[q.side] || p.along - q.along || p.r0 - q.r0);
  const aisles: StraightLine[] = [];
  for (const l of raw) {
    const prev = aisles[aisles.length - 1];
    if (prev && prev.side === l.side && Math.abs(prev.along - l.along) < 1e-6 && prev.r0 === l.r0 && prev.r1 === l.r1 && prev.kind === l.kind) continue;
    aisles.push({ ...l, id: aisles.length });
  }
  return {
    straight: true,
    aisles,
    openings,
    walkways: (b.walkways ?? []).map((w) => ({ row: w.row, side: w.side, from: w.from, to: w.to })),
    areas: (b.areas ?? []).map((a) => ({ side: a.side, from: a.from, to: a.to, r0: a.rows[0], r1: a.rows[1], kind: a.kind })),
  };
}

/** Every tier's compiled blocks (null for a tier without), for a template. */
export function compileBlocks(template: StadiumTemplate, curve?: Curve): (CompiledTier | null)[] {
  if (!template.tiers.some((t) => t.blocks)) return template.tiers.map(() => null);
  const c = curve ?? samplePlanCurve(template.plan.a, template.plan.b, template.plan.exponent);
  return template.tiers.map((t) => {
    if (!t.blocks) return null;
    if (!template.evenRows) throw new Error(`${template.id}: blocks need evenRows`);
    if (t.straight) {
      if (!t.stands) throw new Error(`${template.id}: a straight tier needs its stands`);
      return compileStraightBlocks(t, template.aisles.widthMeters);
    }
    return compileTierBlocks(c, t, template.aisles.widthMeters, template);
  });
}

/** Is a straight tier's seat, `along` side `side` in row `row`, in one of its seat-free areas? */
export function inStraightArea(cb: CompiledStraightBlocks, side: StandSide, along: number, row: number): boolean {
  for (const a of cb.areas) if (a.side === side && row >= a.r0 && row <= a.r1 && along >= a.from && along <= a.to) return true;
  return false;
}

/** Does a straight tier's walkway cover this spot? */
export function straightWalkCovers(w: { side?: StandSide; from?: number; to?: number }, side: StandSide, along: number): boolean {
  if (!w.side) return true;
  if (w.side !== side) return false;
  if (w.from === undefined || w.to === undefined) return true;
  return along >= w.from && along <= w.to;
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

/**
 * Stairway stations every `step` metres out from a side's centre line, up to
 * `upTo`, for an AisleRun with `mirror: true`: on the centre line itself and
 * every step out (`centred: false`), or half a step either side of it so a
 * block sits on the centre line (`centred: true`). The regular rhythm of a
 * modern stand; a stand built in pieces is measured stair by stair instead.
 */
export function rhythm(step: number, centred: boolean, upTo: number): number[] {
  const out: number[] = [];
  for (let s = centred ? step / 2 : 0; s <= upTo + 1e-9; s += step) out.push(Math.round(s * 100) / 100);
  return out;
}

/**
 * Where a tier's front row turns the corner from one side of the bowl to the
 * next: the station, on that side, of the diagonal through the corner (the
 * line standSpans.sideAt divides the sides by). A side's stairs run out to
 * here; the next side's take over beyond it.
 */
export function cornerStation(template: StadiumTemplate, tier: TierSpec, side: StandSide): number {
  const curve = samplePlanCurve(template.plan.a, template.plan.b, template.plan.exponent);
  const r = tier.baseOffset;
  const front = buildOffsetCurve(curve, r);
  const i0 = SIDE_INDEX[side];
  const s0 = front.s[i0];
  // Walk from the side's centre the way a positive station runs, until the point is on another side.
  for (let k = 1; k < N / 4; k++) {
    const i = (((i0 + (SIDE_SIGN[side] > 0 ? k : -k)) % N) + N) % N;
    const x = front.x[i];
    const z = front.z[i];
    if (sideAt(template.plan, r, x, z) !== side) {
      let d = Math.abs(front.s[i] - s0);
      if (d > front.total / 2) d = front.total - d;
      return d;
    }
  }
  return front.total / 8;
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
    if (cb.straight) {
      // On a straight stand the opening is a rectangle on its deck, in the
      // stand it falls in (a stand can sit further out and higher up).
      const out1: Record<StandSide, [number, number]> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
      for (const o of cb.openings) {
        const st = tier.stands!.find((x) => x.side === o.side && Math.abs(o.along - (x.center ?? 0)) <= x.halfLength);
        if (!st) continue;
        const r1 = Math.min(o.r1, (st.rows ?? tier.rows) - 1);
        if (r1 < o.r0) continue;
        const rFront = tier.baseOffset + (st.offset ?? 0) + (o.r0 - 0.5) * tier.rowDepth;
        const rBack = tier.baseOffset + (st.offset ?? 0) + (r1 + 0.5) * tier.rowDepth;
        const at = (radial: number, d: -1 | 1): [number, number] => straightPoint(template.plan, o.side, radial, o.along + d * o.halfW);
        const y0 = tier.baseElevation + (st.elevation ?? 0);
        out.push({
          tier: ti,
          kind: o.kind,
          corners: [at(rFront, -1), at(rFront, 1), at(rBack, 1), at(rBack, -1)],
          frontY: y0 + (o.r0 - 0.5) * tier.rowDepth * rake,
          backY: y0 + (r1 + 0.5) * tier.rowDepth * rake,
          normal: out1[o.side],
        });
      }
      return;
    }
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
 * What a planner calls each block: its stand, its tier, its band and its
 * number along that stand — or its real name, where the ground publishes one
 * (TierBlocks.names). Blocks are numbered along each stand and tier from its
 * left-hand end as you face it from the pitch, the front band first, then the
 * band behind it. Works for every template — an even layout's sections come
 * out numbered the same way.
 */
export interface SectionInfo {
  stand: StandSide;
  tier: number;
  /** 0 = in front of the tier's first walkway. */
  band: number;
  /** 1-based, along the stand and tier, band by band, left to right from the pitch. */
  number: number;
  seats: number;
  /** The block's real name (TierBlocks.names), when the template gives one. */
  name?: string;
  /** Its stand and tier in words: "North", "North upper", "East middle". */
  where: string;
  /** What every label calls it: the real name, or stand, tier and number ("North upper 5"). */
  label: string;
  /** The short form for a grid of blocks: the real name, or the number marked by tier ("5", "U5", "M5"). */
  short: string;
}

const STAND_WORD: Record<StandSide, string> = { north: 'North', east: 'East', south: 'South', west: 'West' };

/** How a label names a tier: nothing for the lowest, then upper (or middle and upper), then "tier n". */
export function tierWord(tier: number, tiers: number): string {
  if (tier <= 0) return '';
  if (tiers === 2) return 'upper';
  if (tiers === 3) return tier === 1 ? 'middle' : 'upper';
  return `tier ${tier + 1}`;
}

function tierMark(tier: number, tiers: number): string {
  if (tier <= 0) return '';
  if (tiers === 2) return 'U';
  if (tiers === 3) return tier === 1 ? 'M' : 'U';
  return `T${tier + 1}-`;
}

export function sectionInfo(map: SeatMap, template?: StadiumTemplate | null): Map<number, SectionInfo> {
  const acc = new Map<number, { tier: number; c: number; s: number; n: number; x: number; z: number; x0: number; x1: number; z0: number; z1: number; row: number; votes: Record<StandSide, number> }>();
  // With the template, a seat's stand is the side of the bowl it is on, the
  // way the generator decides it (standSpans.sideAt), not a quarter of the
  // perimeter: on a long, near-rectangular plan the long sides are far more
  // than a quarter of it, and their end blocks would be put in the ends.
  const tiersT = template?.tiers;
  const before: number[] = [];
  if (tiersT) {
    let a = 0;
    for (const t of tiersT) {
      before.push(a);
      a += t.rows;
    }
  }
  let tierCount = 1;
  for (let i = 0; i < map.count; i++) {
    const id = map.sectionOf[i];
    const tier = map.tierOf[i];
    if (tier + 1 > tierCount) tierCount = tier + 1;
    let e = acc.get(id);
    if (!e) {
      e = { tier, c: 0, s: 0, n: 0, x: 0, z: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, row: Infinity, votes: { north: 0, south: 0, east: 0, west: 0 } };
      acc.set(id, e);
    }
    // Circular mean of u, so a block straddling the seam at u = 0 is not put on the far side.
    const a = map.uv[i * 2] * Math.PI * 2;
    e.c += Math.cos(a);
    e.s += Math.sin(a);
    e.n++;
    const x = map.pos3[i * 3];
    const z = map.pos3[i * 3 + 2];
    e.x += x;
    e.z += z;
    if (x < e.x0) e.x0 = x;
    if (x > e.x1) e.x1 = x;
    if (z < e.z0) e.z0 = z;
    if (z > e.z1) e.z1 = z;
    if (tiersT && template) {
      const t = tiersT[tier];
      const rIn = map.rowOf[i] - before[tier];
      if (rIn < e.row) e.row = rIn;
      e.votes[sideAt(template.plan, t.baseOffset + rIn * t.rowDepth, x, z)]++;
    }
  }
  const rows: { id: number; stand: StandSide; tier: number; band: number; u: number; n: number; a0: number; a1: number }[] = [];
  for (const [id, e] of acc) {
    const u = (((Math.atan2(e.s, e.c) / (Math.PI * 2)) % 1) + 1) % 1;
    let stand: StandSide;
    let k: number;
    if (tiersT) {
      stand = (Object.keys(e.votes) as StandSide[]).reduce((p, q) => (e.votes[q] > e.votes[p] ? q : p));
      k = { east: 0, north: 1, west: 2, south: 3 }[stand];
    } else {
      k = Math.round(u * 4) % 4;
      stand = (['east', 'north', 'west', 'south'] as const)[k];
    }
    // Which band: the walkways of its tier in front of its first row, where they run.
    let band = 0;
    const wk = tiersT?.[e.tier]?.blocks?.walkways;
    if (wk) {
      const along = alongOf(stand, e.x / e.n, e.z / e.n);
      for (const w of wk) {
        if (w.row >= e.row) continue;
        if (w.side && (w.side !== stand || (w.from !== undefined && w.to !== undefined && (along < w.from || along > w.to)))) continue;
        band++;
      }
    }
    // Face the stand from the pitch: left to right is decreasing u on every
    // side (the curve runs anticlockwise seen from above). Measure from the
    // stand's centre so the east end's blocks either side of u = 0 order right.
    let d = u - k / 4;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    const ns = stand === 'north' || stand === 'south';
    rows.push({ id, stand, tier: e.tier, band, u: -d, n: e.n, a0: ns ? e.x0 : e.z0, a1: ns ? e.x1 : e.z1 });
  }
  rows.sort((p, q) => p.tier - q.tier || p.band - q.band || p.u - q.u);
  // How each tier is named on each stand: by how many tiers are stacked
  // there, not how many the ground has. A tier that is a stand of its own
  // beside another (Buraidah's main stand between the ends of the horseshoe)
  // is not an upper tier; one over another along any of its length is.
  const spans = new Map<string, [number, number][]>();
  for (const r of rows) {
    const k = `${r.stand}:${r.tier}`;
    (spans.get(k) ?? spans.set(k, []).get(k)!).push([r.a0, r.a1]);
  }
  const overlaps = (p: [number, number][], q: [number, number][]): boolean => p.some(([a0, a1]) => q.some(([b0, b1]) => b0 < a1 - 0.5 && a0 < b1 - 0.5));
  const level = new Map<string, number>();
  const levels = new Map<StandSide, number>();
  for (const [k, mine] of spans) {
    const [stand, t] = k.split(':') as [StandSide, string];
    let l = 1;
    for (const [k2, theirs] of spans) {
      const [stand2, t2] = k2.split(':');
      if (stand2 === stand && Number(t2) < Number(t) && overlaps(mine, theirs)) l++;
    }
    level.set(k, l);
    levels.set(stand, Math.max(levels.get(stand) ?? 1, l));
  }
  const counter = new Map<string, number>();
  const inBand = new Map<string, number>();
  const out = new Map<number, SectionInfo>();
  for (const r of rows) {
    const lv = level.get(`${r.stand}:${r.tier}`) ?? 1;
    const of = levels.get(r.stand) ?? 1;
    // Tiers side by side on a stand are numbered on from one another.
    const key = `${r.stand}:L${lv}`;
    const n = (counter.get(key) ?? 0) + 1;
    counter.set(key, n);
    const bkey = `${r.stand}:${r.tier}:${r.band}`;
    const nb = inBand.get(bkey) ?? 0;
    inBand.set(bkey, nb + 1);
    let name: string | undefined;
    for (const spec of tiersT?.[r.tier]?.blocks?.names ?? []) {
      if (spec.side !== r.stand || (spec.band ?? 0) !== r.band) continue;
      if (spec.names) name = spec.names[nb];
      else if (spec.first !== undefined) name = `${spec.prefix ?? ''}${spec.first + nb * (spec.step ?? 1)}${spec.suffix ?? ''}`;
    }
    const tw = tierWord(lv - 1, tiersT ? of : tierCount);
    out.set(r.id, {
      stand: r.stand,
      tier: r.tier,
      band: r.band,
      number: n,
      seats: r.n,
      name,
      where: `${STAND_WORD[r.stand]}${tw ? ` ${tw}` : ''}`,
      label: name ?? `${STAND_WORD[r.stand]}${tw ? ` ${tw}` : ''} ${n}`,
      short: name ?? `${tierMark(lv - 1, tiersT ? of : tierCount)}${n}`,
    });
  }
  return out;
}
