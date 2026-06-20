import type { FillScope, SeatMap } from './types';
import type { DesignStore } from './design';
import type { SpatialHash } from './spatialHash';

/**
 * Tool operations. All of them mutate the DesignStore via paint() inside an
 * active stroke and return the dirty indices for the renderer.
 */

const scratch: number[] = [];

/** Stamp a disc of seats. Returns indices actually changed. */
export function brushStamp(
  store: DesignStore,
  hash: SpatialHash,
  x: number,
  y: number,
  radius: number,
  value: number,
  snapDist = 0,
): number[] {
  scratch.length = 0;
  hash.queryDisc(x, y, radius, scratch);
  const dirty: number[] = [];
  for (const i of scratch) {
    if (store.paint(i, value)) dirty.push(i);
  }
  // A small brush (radius smaller than the seat spacing) only catches a seat
  // when the cursor is almost exactly on its centre, which feels finicky. When
  // the disc overlaps nothing, snap to the nearest seat within snapDist so that
  // touching a seat anywhere in its footprint paints it.
  if (scratch.length === 0 && snapDist > 0) {
    const n = hash.nearest(x, y, snapDist);
    if (n >= 0 && store.paint(n, value)) dirty.push(n);
  }
  return dirty;
}

/**
 * Stamp along the segment from (x0,y0) to (x1,y1). Pointer events arrive
 * sparsely during fast drags; without interpolation strokes come out dotted.
 */
export function brushSegment(
  store: DesignStore,
  hash: SpatialHash,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  value: number,
  snapDist = 0,
): number[] {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(1, radius * 0.5);
  const steps = Math.max(1, Math.ceil(dist / step));
  const dirty: number[] = [];
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    dirty.push(...brushStamp(store, hash, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, radius, value, snapDist));
  }
  return dirty;
}

/**
 * Flood fill over the precomputed neighbor graph — geometry never enters the loop.
 * Explicit stack (60k-deep recursion would overflow); section scope adds one compare.
 * Aisles and tier walkways stop the fill automatically because their neighbor
 * links are -1 by construction.
 */
export function floodFill(
  store: DesignStore,
  map: SeatMap,
  start: number,
  value: number,
  scope: FillScope,
): number[] {
  const target = store.cells[start];
  if (target === value) return [];
  const section = map.sectionOf[start];
  const stack: number[] = [start];
  const visited = new Uint8Array(map.count);
  visited[start] = 1;
  const dirty: number[] = [];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (store.paint(i, value)) dirty.push(i);
    const base = i * 4;
    for (let k = 0; k < 4; k++) {
      const j = map.neighbors[base + k];
      if (j < 0 || visited[j]) continue;
      if (store.cells[j] !== target) continue;
      if (scope === 'section' && map.sectionOf[j] !== section) continue;
      visited[j] = 1;
      stack.push(j);
    }
  }
  return dirty;
}

/**
 * Collect the contiguous region of same-coloured seats starting at `start`,
 * WITHOUT mutating anything. This powers the magic-wand select tool: click a
 * painted area (baked text, a filled stand, anything) and get every seat that
 * shares its colour and connects to it. `scope` limits to the section when set.
 * Empty seats (index 0) are selectable too — handy for selecting a gap.
 */
export function collectRegion(
  store: DesignStore,
  map: SeatMap,
  start: number,
  scope: FillScope,
): number[] {
  const target = store.cells[start];
  const section = map.sectionOf[start];
  const stack: number[] = [start];
  const visited = new Uint8Array(map.count);
  visited[start] = 1;
  const region: number[] = [start];
  while (stack.length > 0) {
    const i = stack.pop()!;
    const base = i * 4;
    for (let k = 0; k < 4; k++) {
      const j = map.neighbors[base + k];
      if (j < 0 || visited[j]) continue;
      if (store.cells[j] !== target) continue;
      if (scope === 'section' && map.sectionOf[j] !== section) continue;
      visited[j] = 1;
      region.push(j);
      stack.push(j);
    }
  }
  return region;
}
