import type { ScreenSpec, SeatMap, StadiumTemplate } from './types';
import { curveSampler, tierEdges } from './venueDetails';
import { sideOfU, spanOn } from './standSpans';

/**
 * Where a ground's big screens (VenueDetails.screens) stand: the one rule the
 * renderer draws them by (render/simulator/venue.ts) and the checks hold them
 * to (scripts/verify.mts), so the two cannot drift apart.
 *
 *   - `hang`: hung from the roof, `offset` out from the plan curve, facing the pitch
 *   - `post`: on its own frame on legs to the ground (an open corner, behind a
 *     stand), `offset` out from the plan curve, turned to the centre spot
 *   - neither: on the back of the top stand on that side, just over the last
 *     row's heads, facing the pitch
 */
export interface ScreenPlacement {
  spec: ScreenSpec;
  kind: 'hang' | 'post' | 'back';
  u: number;
  /** Centre of the picture, metres. */
  x: number;
  y: number;
  z: number;
  /** Turn about the vertical: the picture faces (sin ry, 0, cos ry). */
  ry: number;
  w: number;
  h: number;
}

/** The frame round the picture, each side (venue.ts: the back is 0.8 m wider and taller). */
export const SCREEN_FRAME = 0.4;
/** How far the frame and the legs reach behind the picture. */
export const SCREEN_DEPTH = 1.0;

export function screenPlacements(template: StadiumTemplate): ScreenPlacement[] {
  const screens = template.details?.screens ?? [];
  if (!screens.length) return [];
  const at = curveSampler(template);
  // Where a screen on the back of a stand stands: the highest tier with a
  // stand on that side, or the top tier of a ring bowl.
  const backOf = (u: number): ReturnType<typeof tierEdges> => {
    const side = sideOfU(u);
    for (let t = template.tiers.length - 1; t >= 0; t--) {
      if (!template.tiers[t].stands) return tierEdges(template, t);
      const sg = spanOn(template, t, side);
      if (sg) return sg;
    }
    return tierEdges(template, template.tiers.length - 1);
  };
  return screens.map((sc): ScreenPlacement => {
    const base = { spec: sc, u: sc.centerU, w: sc.widthM, h: sc.heightM };
    // A screen given a plan position stands there, turned to the centre spot.
    const fixed = sc.at && (sc.hang || sc.post) ? { x: sc.at[0], z: sc.at[1], ry: Math.atan2(-sc.at[0], -sc.at[1]) } : null;
    if (sc.hang) {
      if (fixed) return { ...base, kind: 'hang', ...fixed, y: sc.hang.y };
      const p = at(sc.centerU, sc.hang.offset ?? 0);
      return { ...base, kind: 'hang', x: p.x, y: sc.hang.y, z: p.z, ry: Math.atan2(-p.nx, -p.nz) };
    }
    if (sc.post) {
      if (fixed) return { ...base, kind: 'post', ...fixed, y: sc.post.y };
      const p = at(sc.centerU, sc.post.offset ?? 0);
      return { ...base, kind: 'post', x: p.x, y: sc.post.y, z: p.z, ry: Math.atan2(-p.x, -p.z) };
    }
    const te = backOf(sc.centerU);
    const p = at(sc.centerU, te.back + 0.2);
    return { ...base, kind: 'back', x: p.x, y: te.backY + 0.7 + sc.heightM / 2, z: p.z, ry: Math.atan2(-p.nx, -p.nz) };
  });
}

/** The share of the perimeter (u) of the point of the plan curve nearest (x, z). */
export function nearestU(template: StadiumTemplate, x: number, z: number): number {
  const at = curveSampler(template);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 4096; i++) {
    const p = at(i / 4096, 0);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i / 4096;
    }
  }
  return best;
}

export interface ScreenClearance {
  /** Seats whose fans (or the stand under them) the screen, its frame or its legs run into. */
  clash: number;
  /** Plan distance from the screen's footprint to the nearest seat, metres (0 inside it). */
  nearest: number;
  /** Share of the picture the stands hide from the centre spot, 0..1. */
  hidden: number;
}

/**
 * Is a screen clear of the seats, and can the pitch see it?
 *
 * A seat is a clash when it is under the screen's footprint (the picture, its
 * frame and the 1 m behind it) and the screen reaches down into the 1.5 m of
 * stand under the seat or the 1.2 m of fan above it. A screen on a frame
 * stands on legs, so it reaches down to the ground. A hung screen keeps 2 m
 * over the heads under it.
 *
 * Hidden: the picture is sampled on a grid, and a sample is hidden when a
 * seat's fan stands across the line from it to the centre spot at eye height.
 */
export function screenClearance(template: StadiumTemplate, map: SeatMap, p: ScreenPlacement): ScreenClearance {
  void template;
  const fx = Math.sin(p.ry);
  const fz = Math.cos(p.ry);
  const wx = Math.cos(p.ry);
  const wz = -Math.sin(p.ry);
  const halfW = p.w / 2 + SCREEN_FRAME;
  const top = p.y + p.h / 2 + SCREEN_FRAME;
  const bottom = p.kind === 'post' ? 0 : p.y - p.h / 2 - SCREEN_FRAME;
  const head = p.kind === 'hang' ? 2.0 : 1.2;
  let clash = 0;
  let nearest = Infinity;
  const pos = map.pos3;
  for (let i = 0; i < map.count; i++) {
    const dx = pos[i * 3] - p.x;
    const dz = pos[i * 3 + 2] - p.z;
    const along = dx * wx + dz * wz;
    const across = dx * fx + dz * fz;
    // Plan distance from the footprint: |along| <= halfW, across in [-DEPTH, 0.3].
    const ea = Math.max(0, Math.abs(along) - halfW);
    const ec = across > 0.3 ? across - 0.3 : across < -SCREEN_DEPTH ? -SCREEN_DEPTH - across : 0;
    const d = Math.hypot(ea, ec);
    if (d < nearest) nearest = d;
    if (d > 0) continue;
    const sy = pos[i * 3 + 1];
    if (bottom < sy + head && top > sy - 1.5) clash++;
  }
  // Hidden: 5 x 3 samples on the picture, seen from the centre spot at eye height.
  const eye = { x: 0, y: 1.7, z: 0 };
  let hiddenN = 0;
  let total = 0;
  for (let a = 0; a < 5; a++) {
    for (let b = 0; b < 3; b++) {
      const s = (a / 4 - 0.5) * p.w * 0.9;
      const sx = p.x + wx * s + fx * 0.05;
      const sz = p.z + wz * s + fz * 0.05;
      const syy = p.y + (b / 2 - 0.5) * p.h * 0.9;
      total++;
      const vx = sx - eye.x;
      const vz = sz - eye.z;
      const L2 = vx * vx + vz * vz || 1;
      let blocked = false;
      for (let i = 0; i < map.count && !blocked; i++) {
        const qx = pos[i * 3] - eye.x;
        const qz = pos[i * 3 + 2] - eye.z;
        const tpar = (qx * vx + qz * vz) / L2;
        if (tpar <= 0 || tpar >= 1) continue;
        const ox = qx - tpar * vx;
        const oz = qz - tpar * vz;
        if (ox * ox + oz * oz > 0.45 * 0.45) continue;
        // Within 1.5 m (plan) of the picture is the screen's own footing.
        if ((1 - tpar) * Math.sqrt(L2) < 1.5) continue;
        const rayY = eye.y + (syy - eye.y) * tpar;
        if (rayY < pos[i * 3 + 1] + 1.1) blocked = true;
      }
      if (blocked) hiddenN++;
    }
  }
  return { clash, nearest: Number.isFinite(nearest) ? nearest : 999, hidden: total ? hiddenN / total : 0 };
}
