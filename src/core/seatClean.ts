/**
 * The seat-scale rule, on the seats themselves.
 *
 * A styled picture is cleaned at seat scale on its own grid (portraitStyles.ts:
 * nothing in a run under three, across or down), and its grid has one cell
 * per seat. But a stand is not a grid: a bowl's front rows hold fewer seats
 * than its back rows over the same width, and rows are offset from each other,
 * so a run of three cells can land on two seats. This settles it where it
 * counts: a stamped seat in a run of fewer than three of its own card along
 * its row or up the rake (map.neighbors, exactly as core/analysis.ts
 * findFragileSeats walks them) takes a neighbouring seat's card, the one that
 * gives it the longest runs; a seat at the picture's edge with no card that
 * helps is left to the seats beneath. Pure, deterministic, in place on the
 * stamp's values, a few passes over the stamp's seats.
 */
import type { SeatMap } from './types';
import { MIN_LEGIBLE_RUN } from './analysis';

/** Values: a palette index, or -1 for "leave the seat to what is beneath". */
export function cleanStampAtSeats(map: SeatMap, seats: Uint32Array, vals: Int16Array): { seats: Uint32Array; vals: Int16Array } {
  const at = new Map<number, number>();
  for (let j = 0; j < seats.length; j++) at.set(seats[j], vals[j]);
  const nb = map.neighbors;
  const run = (i: number, v: number, a: number, b: number): number => {
    let n = 1;
    for (const slot of [a, b]) {
      let j = nb[i * 4 + slot];
      while (n < MIN_LEGIBLE_RUN && j >= 0 && at.get(j) === v) {
        n++;
        j = nb[j * 4 + slot];
      }
    }
    return n;
  };
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0;
    for (const i of seats) {
      const own = at.get(i)!;
      if (own < 0) continue;
      if (run(i, own, 0, 1) >= MIN_LEGIBLE_RUN && run(i, own, 2, 3) >= MIN_LEGIBLE_RUN) continue;
      let best = own;
      let bestScore = Math.min(run(i, own, 0, 1), run(i, own, 2, 3));
      let edge = false;
      for (let s = 0; s < 4; s++) {
        const j = nb[i * 4 + s];
        if (j < 0) continue;
        const v = at.get(j);
        if (v === undefined || v < 0) {
          edge = true;
          continue;
        }
        if (v === own) continue;
        at.set(i, v);
        const score = Math.min(run(i, v, 0, 1), run(i, v, 2, 3));
        at.set(i, own);
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      // Nothing helps and the seat is on the picture's edge: a sliver, left to the seats beneath.
      if (best === own && edge) best = -1;
      if (best !== own) {
        at.set(i, best);
        changed++;
      }
    }
    if (!changed) break;
  }
  const outSeats: number[] = [];
  const outVals: number[] = [];
  for (const i of seats) {
    const v = at.get(i)!;
    if (v < 0) continue;
    outSeats.push(i);
    outVals.push(v);
  }
  return { seats: Uint32Array.from(outSeats), vals: Int16Array.from(outVals) };
}
