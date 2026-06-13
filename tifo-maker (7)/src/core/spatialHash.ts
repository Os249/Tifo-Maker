import type { SeatMap } from './types';

/**
 * Uniform-grid spatial hash over editor-space seat positions.
 * Built once per seat map; queries check only the cells a disc overlaps.
 */
export class SpatialHash {
  private readonly cell: number;
  private readonly cols: number;
  private readonly buckets: Map<number, number[]> = new Map();
  private readonly xy: Float32Array;

  constructor(map: SeatMap, cellSize = 32) {
    this.cell = cellSize;
    this.xy = map.xy;
    this.cols = Math.ceil((map.bounds.maxX - map.bounds.minX) / cellSize) + 2;
    for (let i = 0; i < map.count; i++) {
      const key = this.keyFor(map.xy[i * 2], map.xy[i * 2 + 1]);
      let b = this.buckets.get(key);
      if (!b) {
        b = [];
        this.buckets.set(key, b);
      }
      b.push(i);
    }
  }

  private keyFor(x: number, y: number): number {
    return Math.floor(y / this.cell) * this.cols + Math.floor(x / this.cell);
  }

  /** All seat indices within `radius` of (x, y), appended to `out`. */
  queryDisc(x: number, y: number, radius: number, out: number[]): void {
    const r2 = radius * radius;
    const c0 = Math.floor((x - radius) / this.cell);
    const c1 = Math.floor((x + radius) / this.cell);
    const r0 = Math.floor((y - radius) / this.cell);
    const r1 = Math.floor((y + radius) / this.cell);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const b = this.buckets.get(row * this.cols + col);
        if (!b) continue;
        for (const i of b) {
          const dx = this.xy[i * 2] - x;
          const dy = this.xy[i * 2 + 1] - y;
          if (dx * dx + dy * dy <= r2) out.push(i);
        }
      }
    }
  }

  /** Nearest seat within `maxDist` of (x, y), or -1. */
  nearest(x: number, y: number, maxDist = 24): number {
    const cands: number[] = [];
    this.queryDisc(x, y, maxDist, cands);
    let best = -1;
    let bd = Infinity;
    for (const i of cands) {
      const dx = this.xy[i * 2] - x;
      const dy = this.xy[i * 2 + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}
