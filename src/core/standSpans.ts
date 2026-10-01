import type { StadiumTemplate, StandSide, StandSpan, TierSpec } from './types';
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
