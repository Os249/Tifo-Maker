/**
 * A small top-down picture of a submitted stadium, for the admin review queue.
 *
 * A pending submission used to be reviewed from its name, its country and a
 * tier count — nothing that shows whether the thing is a stadium at all. The
 * seat map is already generated server-side (routes.ts validates .tifo files
 * against it), so the plan is the real geometry: every seat's world position
 * seen from above, one colour per tier.
 *
 * Seats are binned into a coarse grid and each row of the grid is drawn as
 * horizontal runs, so a 60,000-seat bowl comes out as a few kilobytes of SVG
 * rather than 60,000 elements. Only numbers go into the markup — no name or
 * any other submitted text — so it is safe to insert as HTML.
 */

import { generateSeatMap } from '../../src/core/seatmap';
import type { StadiumTemplate } from '../../src/core/types';

const TIER_COLOURS = ['#58a6ff', '#3fb950', '#d29922', '#a371f7', '#39c5cf'];

export interface StadiumPlan {
  svg: string;
  seats: number;
  tiers: number;
}

export function stadiumPlan(template: StadiumTemplate, cols = 120): StadiumPlan | null {
  let map;
  try {
    map = generateSeatMap(template);
  } catch {
    return null;
  }
  if (!map.count) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < map.count; i++) {
    const x = map.pos3[i * 3], z = map.pos3[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const w = Math.max(1e-6, maxX - minX), h = Math.max(1e-6, maxZ - minZ);
  const cell = w / cols;
  const rows = Math.max(1, Math.ceil(h / cell));
  // Highest tier wins a cell, so upper tiers read as rings around lower ones.
  const grid = new Int8Array(cols * rows).fill(-1);
  let tiers = 0;
  for (let i = 0; i < map.count; i++) {
    const cx = Math.min(cols - 1, Math.floor((map.pos3[i * 3] - minX) / cell));
    const cz = Math.min(rows - 1, Math.floor((map.pos3[i * 3 + 2] - minZ) / cell));
    const t = map.tierOf[i];
    if (t + 1 > tiers) tiers = t + 1;
    const k = cz * cols + cx;
    if (grid[k] < t) grid[k] = t;
  }
  let body = '';
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const t = grid[r * cols + c];
      if (t < 0) { c++; continue; }
      let e = c + 1;
      while (e < cols && grid[r * cols + e] === t) e++;
      body += `<rect x="${c}" y="${r}" width="${e - c}" height="1" fill="${TIER_COLOURS[t % TIER_COLOURS.length]}"/>`;
      c = e;
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${cols + 4} ${rows + 4}" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="Top-down seat plan" shape-rendering="crispEdges">${body}</svg>`;
  return { svg, seats: map.count, tiers };
}
