/**
 * Cross-stadium design remapping.
 *
 * Stadiums differ in seat count AND bowl shape (40k single-kop, 60k bowl,
 * 76k oval). To carry a painted design from one to another while preserving the
 * LOOK, we map by relative position: every seat has normalized UV coordinates
 * (u = around the bowl 0..1, v = up the stand 0..1). For each seat in the NEW
 * map we copy the colour of the OLD seat with the nearest UV. A design that's
 * "a gold band two-thirds up, centred" stays exactly that in any bowl.
 *
 * Framework-free and DOM-free so it can run anywhere (and be unit-tested).
 */

import type { SeatMap } from './types';

/**
 * Remap `oldCells` (laid out for `oldMap`) onto `newMap` by nearest UV.
 * Uses a coarse UV grid over the old seats so lookup is ~O(newCount), not
 * O(oldCount × newCount).
 */
export function remapDesignAcrossStadiums(
  oldCells: Uint8Array,
  oldMap: SeatMap,
  newMap: SeatMap,
): Uint8Array {
  const out = new Uint8Array(newMap.count);

  // Bucket old seats into a GRID×GRID UV grid. ~80×80 keeps buckets small even
  // for 76k seats while staying cheap to scan.
  const GRID = 80;
  const buckets: number[][] = Array.from({ length: GRID * GRID }, () => []);
  const cell = (u: number, v: number): number => {
    const gu = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)));
    const gv = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));
    return gv * GRID + gu;
  };
  for (let i = 0; i < oldMap.count; i++) {
    buckets[cell(oldMap.uv[i * 2], oldMap.uv[i * 2 + 1])].push(i);
  }

  for (let j = 0; j < newMap.count; j++) {
    const u = newMap.uv[j * 2];
    const v = newMap.uv[j * 2 + 1];
    const gu = Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)));
    const gv = Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID)));

    // Search outward in rings of grid cells until we find candidates, then pick
    // the nearest by true UV distance. Most hits resolve at radius 0–1.
    let best = -1;
    let bestD = Infinity;
    for (let radius = 0; radius < GRID; radius++) {
      const lo_u = Math.max(0, gu - radius);
      const hi_u = Math.min(GRID - 1, gu + radius);
      const lo_v = Math.max(0, gv - radius);
      const hi_v = Math.min(GRID - 1, gv + radius);
      for (let cv = lo_v; cv <= hi_v; cv++) {
        for (let cu = lo_u; cu <= hi_u; cu++) {
          // Only scan the ring's edge (cells added at this radius).
          if (radius > 0 && cu > lo_u && cu < hi_u && cv > lo_v && cv < hi_v) continue;
          for (const oi of buckets[cv * GRID + cu]) {
            const du = oldMap.uv[oi * 2] - u;
            const dv = oldMap.uv[oi * 2 + 1] - v;
            const d = du * du + dv * dv;
            if (d < bestD) {
              bestD = d;
              best = oi;
            }
          }
        }
      }
      // Once we have a candidate and have searched one extra ring, stop — the
      // nearest can't be more than ~1 ring beyond the first non-empty cell.
      if (best >= 0 && radius >= 1) break;
    }
    out[j] = best >= 0 ? oldCells[best] : 0;
  }

  return out;
}
