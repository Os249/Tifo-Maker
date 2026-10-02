import type { StadiumTemplate, StandGap, StandSide, StandSpan, TierSpec } from './types';
import { curveSampler } from './venueDetails';

/**
 * Stands that are not a ring (TierSpec.stands): which side of the bowl a point
 * is on, whether a seat is in one of its tier's stands, and where each stand
 * is, for the renderer to build its concrete under exactly those seats.
 *
 * Pure and DOM-free, like the rest of core: the seat generator, the server's
 * seat count and the 3D shell all ask the same question here.
 */

type Plan = StadiumTemplate['plan'];

/**
 * The side of the bowl a point at `radial` metres out from the plan curve is
 * on. The same normalisation as the box-arena corner cut: whichever of
 * |x|/(a+r) and |z|/(b+r) is larger wins, so on a near-rectangular plan the
 * line between two sides is the diagonal through the corner.
 */
export function sideAt(plan: Plan, radial: number, x: number, z: number): StandSide {
  const nx = Math.abs(x) / (plan.a + radial);
  const nz = Math.abs(z) / (plan.b + radial);
  if (nz >= nx) return z >= 0 ? 'north' : 'south';
  return x >= 0 ? 'east' : 'west';
}

/** Distance along a stand from its centre line: x for the sides, z for the ends. */
export function alongOf(side: StandSide, x: number, z: number): number {
  return side === 'north' || side === 'south' ? x : z;
}

/** The stand of this tier a point is in, or null. */
export function spanAt(tier: TierSpec, plan: Plan, radial: number, x: number, z: number): StandSpan | null {
  if (!tier.stands) return null;
  const side = sideAt(plan, radial, x, z);
  for (const s of tier.stands) {
    if (s.side === side && Math.abs(alongOf(side, x, z)) <= s.halfLength) return s;
  }
  return null;
}

/** Is a seat in row `row` of this tier, at (x, z), in one of its stands? Always true for a ring tier. */
export function inStands(tier: TierSpec, plan: Plan, row: number, radial: number, x: number, z: number): boolean {
  if (!tier.stands) return true;
  const s = spanAt(tier, plan, radial, x, z);
  return !!s && row < (s.rows ?? tier.rows);
}

/**
 * Is a seat of this ring tier, at (x, z) and `radial` metres out, in one of
 * the tier's gaps (TierSpec.omit)? Always false for a tier without gaps.
 */
export function inGap(tier: TierSpec, plan: Plan, row: number, radial: number, x: number, z: number): boolean {
  if (!tier.omit) return false;
  const side = sideAt(plan, radial, x, z);
  const along = alongOf(side, x, z);
  for (const g of tier.omit) if (g.side === side && along >= g.from && along <= g.to && row >= (g.fromRow ?? 0)) return true;
  return false;
}

/**
 * A gap as a convex region of the ground plane: the half-planes
 * nx*x + nz*z + d >= 0 that are all true inside it. The side's sector is the
 * wedge between the two diagonals |x|/(a+r) = |z|/(b+r), taken at `radial`;
 * the renderer cuts the concrete of a gapped tier with exactly this.
 */
export function gapHalfPlanes(g: StandGap, plan: Plan, radial: number, cutAt?: number): [number, number, number][] {
  const k = (plan.b + radial) / (plan.a + radial);
  // A gap that starts some rows back is also behind the line `cutAt` metres
  // out from the plan curve (on a straight side, a line parallel to it).
  const c = cutAt ?? 0;
  switch (g.side) {
    case 'north':
      return [[-k, 1, 0], [k, 1, 0], [1, 0, -g.from], [-1, 0, g.to], ...(cutAt !== undefined ? [[0, 1, -(plan.b + c)] as [number, number, number]] : [])];
    case 'south':
      return [[-k, -1, 0], [k, -1, 0], [1, 0, -g.from], [-1, 0, g.to], ...(cutAt !== undefined ? [[0, -1, -(plan.b + c)] as [number, number, number]] : [])];
    case 'east':
      return [[1, -1 / k, 0], [1, 1 / k, 0], [0, 1, -g.from], [0, -1, g.to], ...(cutAt !== undefined ? [[1, 0, -(plan.a + c)] as [number, number, number]] : [])];
    default:
      return [[-1, -1 / k, 0], [-1, 1 / k, 0], [0, 1, -g.from], [0, -1, g.to], ...(cutAt !== undefined ? [[-1, 0, -(plan.a + c)] as [number, number, number]] : [])];
  }
}

/** Where a gap that starts some rows back cuts the tier (metres out from the plan curve), or undefined. */
export function gapCut(tier: TierSpec, g: StandGap): number | undefined {
  if (!g.fromRow) return undefined;
  return tier.baseOffset + (g.fromRow - 0.5) * tier.rowDepth;
}

/**
 * A tier's front and back edges on one side, for whatever stands behind it
 * (boxes, the tier above): a stand's own edges on a ground of stands, the
 * cut where a gap opens the back of a ring tier, the ring's edges otherwise.
 */
export function edgesOn(template: StadiumTemplate, tierIdx: number, side: StandSide): { front: number; back: number; frontY: number; backY: number } {
  const t = template.tiers[tierIdx];
  const rake = Math.tan((t.rakeDeg * Math.PI) / 180);
  if (t.stands) {
    const sg = spanOn(template, tierIdx, side);
    if (sg) return sg;
  }
  const lastRow = Math.max(1, t.rows - 1);
  const front = t.baseOffset - t.rowDepth * 0.5;
  const frontY = t.baseElevation - t.rowDepth * rake * 0.5;
  const gap = t.omit?.find((g) => g.side === side && g.fromRow && g.from <= 0 && g.to >= 0);
  const back = gap ? gapCut(t, gap)! : t.baseOffset + lastRow * t.rowDepth + t.rowDepth * 0.5;
  return { front, back, frontY, backY: frontY + (back - front) * rake };
}

/** One stand of one tier, laid out for the renderer. */
export interface SpanGeometry {
  side: StandSide;
  halfLength: number;
  rows: number;
  /**
   * Its extent in plan-curve u (curveSampler's arc-length parameter), padded
   * by half a seat so the concrete runs past the last seat. u0 may be negative
   * for the east end, which straddles the seam at u = 0.
   */
  u0: number;
  u1: number;
  /** Front and back edge (metres out from the plan curve) and their heights. */
  front: number;
  back: number;
  frontY: number;
  backY: number;
  /** A straight stand (TierSpec.straight): front and back are out from the plan's side line, not its curve. */
  straight?: boolean;
}

/** Centre u of each side on the plan curve. */
export const SIDE_U: Record<StandSide, number> = { east: 0, north: 0.25, west: 0.5, south: 0.75 };

/** The side whose centre is nearest a perimeter position. */
export function sideOfU(u: number): StandSide {
  const k = Math.round((((u % 1) + 1) % 1) * 4) % 4;
  return (['east', 'north', 'west', 'south'] as const)[k];
}

const cache = new WeakMap<StadiumTemplate, SpanGeometry[][]>();

/**
 * Every stand of every tier, with its u extent and its front and back edges.
 * Empty lists for ring tiers.
 */
export function spanGeometry(template: StadiumTemplate): SpanGeometry[][] {
  const hit = cache.get(template);
  if (hit) return hit;
  const at = curveSampler(template);
  const N = 8192;
  const pts: { u: number; x: number; z: number }[] = [];
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const p = at(u, 0);
    pts.push({ u, x: p.x, z: p.z });
  }
  const out = template.tiers.map((tier) => {
    if (!tier.stands) return [];
    const rake = Math.tan((tier.rakeDeg * Math.PI) / 180);
    return tier.stands.map((s): SpanGeometry => {
      const rows = Math.min(tier.rows, s.rows ?? tier.rows);
      const lastRow = Math.max(1, rows - 1);
      const pad = tier.seatPitch * 0.6;
      if (tier.straight) {
        // Its ends, as perimeter positions: where each end projects onto the plan curve.
        const off = tier.baseOffset + (s.offset ?? 0);
        const end = (along: number): number => {
          const { a, b } = template.plan;
          const x = s.side === 'north' || s.side === 'south' ? along : s.side === 'east' ? a + off : -(a + off);
          const z = s.side === 'north' ? b + off : s.side === 'south' ? -(b + off) : along;
          let best = 0;
          let bd = Infinity;
          for (const q of pts) {
            const d = (q.x - x) ** 2 + (q.z - z) ** 2;
            if (d < bd) {
              bd = d;
              best = q.u;
            }
          }
          return best;
        };
        let u0 = end(-s.halfLength - pad);
        let u1 = end(s.halfLength + pad);
        if (u0 > u1) [u0, u1] = [u1, u0];
        if (s.side === 'east' && u1 - u0 > 0.5) [u0, u1] = [u1 - 1, u0];
        const e = s.elevation ?? 0;
        return {
          side: s.side,
          halfLength: s.halfLength,
          rows,
          u0,
          u1,
          front: off - tier.rowDepth * 0.5,
          back: off + lastRow * tier.rowDepth + tier.rowDepth * 0.5,
          frontY: tier.baseElevation + e - tier.rowDepth * rake * 0.5,
          backY: tier.baseElevation + e + lastRow * tier.rowDepth * rake + tier.rowDepth * rake * 0.5,
          straight: true,
        };
      }
      let u0 = Infinity;
      let u1 = -Infinity;
      for (const q of pts) {
        if (sideAt(template.plan, 0, q.x, q.z) !== s.side) continue;
        if (Math.abs(alongOf(s.side, q.x, q.z)) > s.halfLength + pad) continue;
        // The east end straddles u = 0: count its far half as negative u.
        const u = s.side === 'east' && q.u > 0.5 ? q.u - 1 : q.u;
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
      }
      const front = tier.baseOffset - tier.rowDepth * 0.5;
      const back = tier.baseOffset + lastRow * tier.rowDepth + tier.rowDepth * 0.5;
      return {
        side: s.side,
        halfLength: s.halfLength,
        rows,
        u0,
        u1,
        front,
        back,
        frontY: tier.baseElevation - tier.rowDepth * rake * 0.5,
        backY: tier.baseElevation + lastRow * tier.rowDepth * rake + tier.rowDepth * rake * 0.5,
      };
    });
  });
  cache.set(template, out);
  return out;
}

/** The stand of `tier` on `side`, if it has one. */
export function spanOn(template: StadiumTemplate, tier: number, side: StandSide): SpanGeometry | null {
  return spanGeometry(template)[tier]?.find((g) => g.side === side) ?? null;
}

/** Does any tier of this template use stands? */
export function hasStands(template: StadiumTemplate): boolean {
  return template.tiers.some((t) => !!t.stands);
}

/**
 * Which side of the bowl a seat is on. For a straight tier (TierSpec.straight)
 * that is the stand it belongs to — a long side stand runs on past the end of
 * an end stand, where the diagonal rule would get it wrong; for anything else
 * it is sideAt.
 */
export function seatSide(template: StadiumTemplate, tierIdx: number, radial: number, x: number, z: number): StandSide {
  const t = template.tiers[tierIdx];
  if (t?.straight && t.stands) {
    const { a, b } = template.plan;
    for (const s of t.stands) {
      const ns = s.side === 'north' || s.side === 'south';
      const along = ns ? x : z;
      const cross = s.side === 'north' ? z - b : s.side === 'south' ? -z - b : s.side === 'east' ? x - a : -x - a;
      if (Math.abs(along) <= s.halfLength + 0.5 && cross >= t.baseOffset + (s.offset ?? 0) - 1) return s.side;
    }
  }
  return sideAt(template.plan, radial, x, z);
}
