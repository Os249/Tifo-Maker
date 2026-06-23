/**
 * Stadium orientation — re-orient the DESIGN around the bowl.
 *
 * Orientation acts on the painted cells (not the geometry), so both the 2D editor
 * and the 3D preview update from the same buffer, and the change is one undoable
 * step. Mapping is by normalized UV (u = around the bowl 0..1, v = up the stand):
 *
 *   - flip-ew : mirror left↔right (swap East/West). Reuses the seat map's exact
 *               `mirrorOf` involution (u → 0.5 − u).
 *   - flip-ns : mirror the other axis (swap North/South), u → (1 − u).
 *   - rotate  : quarter-turn around the bowl, u → (u − 0.25); 4 clicks = full turn.
 *
 * flip-ns / rotate sample the nearest seat at the transformed UV (rows differ in
 * seat count, so an exact partner rarely exists) — the same principle as the
 * cross-stadium remap. Pure and DOM-free.
 */

import type { SeatMap } from './types';

export type OrientOp = 'flip-ew' | 'flip-ns' | 'rotate';

/** Nearest-seat-by-UV lookup over a single map (coarse grid + ring search). */
function buildUvIndex(map: SeatMap): (u: number, v: number) => number {
  const GRID = 80;
  const buckets: number[][] = Array.from({ length: GRID * GRID }, () => []);
  const cell = (u: number, v: number): number => {
    const gu = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)));
    const gv = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
    return gv * GRID + gu;
  };
  for (let i = 0; i < map.count; i++) buckets[cell(map.uv[i * 2], map.uv[i * 2 + 1])].push(i);

  return (u: number, v: number): number => {
    const gu = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)));
    const gv = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
    let best = -1;
    let bestD = Infinity;
    for (let radius = 0; radius < GRID; radius++) {
      const loU = Math.max(0, gu - radius);
      const hiU = Math.min(GRID - 1, gu + radius);
      const loV = Math.max(0, gv - radius);
      const hiV = Math.min(GRID - 1, gv + radius);
      for (let cv = loV; cv <= hiV; cv++) {
        for (let cu = loU; cu <= hiU; cu++) {
          if (radius > 0 && cu > loU && cu < hiU && cv > loV && cv < hiV) continue; // ring edge only
          for (const oi of buckets[cv * GRID + cu]) {
            let du = map.uv[oi * 2] - u;
            du -= Math.round(du); // wrap around the u=0/1 seam
            const dv = map.uv[oi * 2 + 1] - v;
            const d = du * du + dv * dv;
            if (d < bestD) {
              bestD = d;
              best = oi;
            }
          }
        }
      }
      if (best >= 0 && radius >= 1) break;
    }
    return best;
  };
}

const wrap01 = (u: number): number => ((u % 1) + 1) % 1;

/** Return a NEW cells buffer with the design re-oriented. Length = map.count. */
export function orientCells(cells: Uint8Array, map: SeatMap, op: OrientOp): Uint8Array {
  const out = new Uint8Array(map.count);

  if (op === 'flip-ew') {
    // Exact mirror via the precomputed involution.
    for (let i = 0; i < map.count; i++) {
      const m = map.mirrorOf[i];
      out[i] = cells[m >= 0 ? m : i];
    }
    return out;
  }

  const nearest = buildUvIndex(map);
  const srcU = op === 'rotate' ? (u: number) => wrap01(u - 0.25) : (u: number) => wrap01(1 - u);
  for (let j = 0; j < map.count; j++) {
    const u = map.uv[j * 2];
    const v = map.uv[j * 2 + 1];
    const s = nearest(srcU(u), v);
    out[j] = s >= 0 ? cells[s] : 0;
  }
  return out;
}
