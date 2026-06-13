import type { SeatMap } from './types';

/**
 * Legibility check (blueprint §1.2): in every reference tifo, 1–2-seat-thin
 * detail dies under the real-world ~10% no-show rate, while 3+ seat strokes
 * survive. A seat is FRAGILE when the same-color run through it is shorter
 * than `minRun` both horizontally and vertically — i.e. it sits in a stroke
 * with no thick dimension. Pure and DOM-free; runs in the verify harness and
 * can move to a worker untouched.
 */

export const MIN_LEGIBLE_RUN = 3;

/** Length of the same-color run through seat `i` along a neighbor axis, capped at `cap`. */
function runThrough(
  cells: Uint8Array,
  neighbors: Int32Array,
  i: number,
  negSlot: number,
  posSlot: number,
  cap: number,
): number {
  const color = cells[i];
  let run = 1;
  let j = neighbors[i * 4 + negSlot];
  while (j >= 0 && cells[j] === color && run < cap) {
    run++;
    j = neighbors[j * 4 + negSlot];
  }
  j = neighbors[i * 4 + posSlot];
  while (j >= 0 && cells[j] === color && run < cap) {
    run++;
    j = neighbors[j * 4 + posSlot];
  }
  return run;
}

/**
 * Indices of all painted (non-empty) seats sitting in sub-threshold strokes.
 * Stroke thickness is the MINIMUM run dimension: a 1-seat-tall band is thin no
 * matter how long it is, so a seat is fragile when EITHER axis run < minRun.
 * (Dithered regions will flag heavily — honest, since dither softens further
 * under no-shows.) Walks ≤ minRun links per axis per seat: O(count) overall.
 */
export function findFragileSeats(
  cells: Uint8Array,
  map: SeatMap,
  minRun = MIN_LEGIBLE_RUN,
): number[] {
  const fragile: number[] = [];
  for (let i = 0; i < map.count; i++) {
    if (cells[i] === 0) continue;
    if (
      runThrough(cells, map.neighbors, i, 0, 1, minRun) < minRun ||
      runThrough(cells, map.neighbors, i, 2, 3, minRun) < minRun
    ) {
      fragile.push(i);
    }
  }
  return fragile;
}
