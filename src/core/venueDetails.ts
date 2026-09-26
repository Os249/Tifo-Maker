import type { BowlCorner, SeatMap, SeatZoneKind, StadiumTemplate, VehicleLane } from './types';

/**
 * The details that make a real ground that ground: vehicle lanes, premium
 * seating, the box band and the screens (see VenueDetails in types.ts).
 *
 * Pure and DOM-free — the seat-map generator, the worker, the server and the
 * renderer all ask the same questions here, so a lane is the same lane in the
 * design view, in 3D and in the seat count the server validates against.
 */

/** Plan-curve parameter t of each corner: the diagonal |x/a| = |z/b|. */
const CORNER_T: Record<BowlCorner, number> = {
  'north-east': Math.PI / 4,
  'north-west': (3 * Math.PI) / 4,
  'south-west': (5 * Math.PI) / 4,
  'south-east': (7 * Math.PI) / 4,
};

/** Superellipse point |x/a|^p+|z/b|^p=1 at parameter t (x,z in the ground plane). */
function se(a: number, b: number, p: number, t: number): [number, number] {
  const e = 2 / p;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
}

/**
 * A lane as a line in the ground plane: where it meets the plan curve and the
 * direction it runs (outward, square to the curve — which is how a ramp is
 * built, straight through the stand rather than skewed across it).
 */
export interface LaneLine {
  lane: VehicleLane;
  /** Point on the plan curve. */
  x: number;
  z: number;
  /** Unit outward direction. */
  dx: number;
  dz: number;
}

export function laneLines(template: StadiumTemplate): LaneLine[] {
  const lanes = template.details?.lanes ?? [];
  if (lanes.length === 0) return [];
  const { a, b, exponent: p } = template.plan;
  return lanes.map((lane) => {
    const t = CORNER_T[lane.corner];
    const [x, z] = se(a, b, p, t);
    const dt = 1e-4;
    const [x0, z0] = se(a, b, p, t - dt);
    const [x1, z1] = se(a, b, p, t + dt);
    let nx = z1 - z0;
    let nz = -(x1 - x0);
    const L = Math.hypot(nx, nz) || 1;
    nx /= L;
    nz /= L;
    if (nx * x + nz * z < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { lane, x, z, dx: nx, dz: nz };
  });
}

/**
 * Is a seat at (x, z) in `tier` inside a vehicle lane? Measured square to the
 * lane's centre line, on the lane's own side of the bowl, so a lane at one
 * corner can never reach across the pitch to the opposite one.
 */
export function inLane(lines: LaneLine[], tier: number, x: number, z: number): boolean {
  for (const l of lines) {
    if (l.lane.tier !== tier) continue;
    const rx = x - l.x;
    const rz = z - l.z;
    const along = rx * l.dx + rz * l.dz;
    if (along < -2) continue; // pitch side of the curve: not in this stand
    const across = Math.abs(rx * -l.dz + rz * l.dx);
    if (across < l.lane.widthM / 2) return true;
  }
  return false;
}

/** Wrapped distance between two perimeter fractions. */
export function du(u: number, v: number): number {
  let d = Math.abs(u - v) % 1;
  if (d > 0.5) d = 1 - d;
  return d;
}

/** Zone codes in the per-seat array. 0 = ordinary seat. */
export const ZONE_CODE: Record<SeatZoneKind, number> = { gold: 1, silver: 2, vip: 3 };
export const ZONE_KINDS: SeatZoneKind[] = ['gold', 'silver', 'vip'];

/**
 * Which premium zone every seat is in (0 = none). The first zone in the list
 * that claims a seat wins, so a gold platform listed before the silver one that
 * surrounds it keeps its own seats.
 */
export function seatZones(map: SeatMap, template: StadiumTemplate): Uint8Array {
  const out = new Uint8Array(map.count);
  const zones = template.details?.zones ?? [];
  if (zones.length === 0) return out;
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    const tier = map.tierOf[i];
    for (const z of zones) {
      if (!z.tiers.includes(tier)) continue;
      if (du(u, z.centerU) <= z.halfU) {
        out[i] = ZONE_CODE[z.kind];
        break;
      }
    }
  }
  return out;
}

/** Seats that never take the tifo (their zone says so). */
export function noTifoMask(map: SeatMap, template: StadiumTemplate): Uint8Array | null {
  const zones = template.details?.zones ?? [];
  if (!zones.some((z) => z.noTifo)) return null;
  const codes = seatZones(map, template);
  const mask = new Uint8Array(map.count);
  for (let i = 0; i < map.count; i++) {
    const c = codes[i];
    if (c === 0) continue;
    const kind = ZONE_KINDS[c - 1];
    if (zones.some((z) => z.kind === kind && z.noTifo && z.tiers.includes(map.tierOf[i]))) mask[i] = 1;
  }
  return mask;
}

/** How many seats each zone holds — for the stadium panel and the checks. */
export function zoneCounts(map: SeatMap, template: StadiumTemplate): Record<SeatZoneKind, number> {
  const codes = seatZones(map, template);
  const out: Record<SeatZoneKind, number> = { gold: 0, silver: 0, vip: 0 };
  for (let i = 0; i < codes.length; i++) if (codes[i]) out[ZONE_KINDS[codes[i] - 1]]++;
  return out;
}

/** A point on the plan curve pushed out by an offset, with the outward normal. */
export interface CurvePoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

/**
 * Walk the plan curve by perimeter fraction u — the same u the seat map uses,
 * measured by arc length of the base curve — and push out by `offset` metres.
 * For placing things (screens, boxes, ramps) where the seats say they are.
 */
export function curveSampler(template: StadiumTemplate, samples = 2048): (u: number, offset: number) => CurvePoint {
  const { a, b, exponent: p } = template.plan;
  const n = samples;
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, z] = se(a, b, p, (i / n) * Math.PI * 2);
    px[i] = x;
    pz[i] = z;
  }
  const nxs = new Float64Array(n);
  const nzs = new Float64Array(n);
  const s = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n;
    const i1 = (i + 1) % n;
    let nx = pz[i1] - pz[i0];
    let nz = -(px[i1] - px[i0]);
    const L = Math.hypot(nx, nz) || 1;
    nx /= L;
    nz /= L;
    if (nx * px[i] + nz * pz[i] < 0) {
      nx = -nx;
      nz = -nz;
    }
    nxs[i] = nx;
    nzs[i] = nz;
    s[i + 1] = s[i] + Math.hypot(px[i1] - px[i], pz[i1] - pz[i]);
  }
  const total = s[n];
  return (u: number, offset: number): CurvePoint => {
    const target = ((((u % 1) + 1) % 1) * total);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const j = (i + 1) % n;
    const f = (target - s[i]) / (s[i + 1] - s[i] || 1e-9);
    let nx = nxs[i] + (nxs[j] - nxs[i]) * f;
    let nz = nzs[i] + (nzs[j] - nzs[i]) * f;
    const L = Math.hypot(nx, nz) || 1;
    nx /= L;
    nz /= L;
    const x = px[i] + (px[j] - px[i]) * f;
    const z = pz[i] + (pz[j] - pz[i]) * f;
    return { x: x + nx * offset, z: z + nz * offset, nx, nz };
  };
}

/** Radial offset and height of a tier's front and back edges (mirrors stands.ts). */
export function tierEdges(template: StadiumTemplate, tier: number): { front: number; back: number; frontY: number; backY: number } {
  const t = template.tiers[tier];
  const rakeTan = Math.tan((t.rakeDeg * Math.PI) / 180);
  const lastRow = Math.max(1, t.rows - 1);
  return {
    front: t.baseOffset - t.rowDepth * 0.5,
    back: t.baseOffset + lastRow * t.rowDepth + t.rowDepth * 0.5,
    frontY: t.baseElevation - t.rowDepth * rakeTan * 0.5,
    backY: t.baseElevation + lastRow * t.rowDepth * rakeTan + t.rowDepth * rakeTan * 0.5,
  };
}

/** Something to mark on the flat design view: a zone's box, or a lane's gap. */
export interface VenueMark {
  kind: SeatZoneKind | 'lane';
  /** Editor-space box (same units as SeatMap.xy). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the premium zones and the vehicle lanes are in the flat design view,
 * so a designer can see them before they paint across them. Zones are the box
 * round their seats; a lane is the gap its seats left, found from the seats
 * standing either side of it.
 */
export function venueMarks(map: SeatMap, template: StadiumTemplate): VenueMark[] {
  const out: VenueMark[] = [];
  const zones = template.details?.zones ?? [];
  if (zones.length) {
    const codes = seatZones(map, template);
    for (const kind of ZONE_KINDS) {
      const code = ZONE_CODE[kind];
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < map.count; i++) {
        if (codes[i] !== code) continue;
        const x = map.xy[i * 2];
        const y = map.xy[i * 2 + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (x0 <= x1) out.push({ kind, x0, y0, x1, y1 });
    }
  }
  for (const l of laneLines(template)) {
    const w = l.lane.widthM / 2;
    let sum = 0;
    let n = 0;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < map.count; i++) {
      if (map.tierOf[i] !== l.lane.tier) continue;
      const rx = map.pos3[i * 3] - l.x;
      const rz = map.pos3[i * 3 + 2] - l.z;
      if (rx * l.dx + rz * l.dz < -2) continue;
      const across = Math.abs(rx * -l.dz + rz * l.dx);
      if (across > w + 1.5) continue;
      sum += map.xy[i * 2];
      n++;
      const y = map.xy[i * 2 + 1];
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (n === 0) continue;
    // The seats either side are symmetric about the gap, so their mean is its middle.
    const cx = sum / n;
    out.push({ kind: 'lane', x0: cx, y0, x1: cx, y1 });
  }
  return out;
}
