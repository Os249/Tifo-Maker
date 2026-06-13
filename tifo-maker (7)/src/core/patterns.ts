import type { SeatMap } from './types';

/**
 * Pattern presets: pure, deterministic functions from seat index → palette
 * index, computed off the seat map's (u, row, tier, section) coordinates.
 * Conventions: slot 1 = primary, slot 2 = secondary, slot 3 = accent.
 * Applied via DesignStore.transform(), so every preset is one undo step.
 */

export interface PatternPreset {
  id: string;
  name: string;
  /** Returns the per-seat color function for a given seat map. */
  cellAt(map: SeatMap): (i: number) => number;
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export const PATTERN_PRESETS: PatternPreset[] = [
  {
    id: 'solid',
    name: 'Solid',
    cellAt: () => () => 1,
  },
  {
    id: 'hoops',
    name: 'Hoops (row bands)',
    cellAt: (map) => (i) => (Math.floor(map.rowOf[i] / 4) % 2 === 0 ? 1 : 2),
  },
  {
    id: 'columns',
    name: 'Columns (section bands)',
    cellAt: (map) => (i) => (Math.floor(map.uv[i * 2] * 28) % 2 === 0 ? 1 : 2),
  },
  {
    id: 'checker',
    name: 'Checkerboard',
    cellAt: (map) => (i) =>
      (Math.floor(map.uv[i * 2] * 28) + Math.floor(map.rowOf[i] / 6)) % 2 === 0 ? 1 : 2,
  },
  {
    id: 'sash',
    name: 'Diagonal sash',
    // ~45° in editor space: one row (8u) ≈ 2.5 seat columns (3.2u each).
    cellAt: (map) => (i) =>
      Math.floor((map.uv[i * 2] * 1250 + map.rowOf[i] * 2.5) / 14) % 2 === 0 ? 1 : 2,
  },
  {
    id: 'split',
    name: 'Opposite stands',
    cellAt: (map) => (i) => {
      const stand = Math.floor(((map.uv[i * 2] + 0.125) % 1) * 4); // E,N,W,S
      return stand % 2 === 0 ? 1 : 2;
    },
  },
  {
    id: 'tiers',
    name: 'Tier split',
    cellAt: (map) => (i) => (map.tierOf[i] === 0 ? 1 : 2),
  },
  {
    id: 'gradient',
    name: 'Vertical gradient (dithered)',
    cellAt: (map) => (i) => {
      const v = map.uv[i * 2 + 1]; // 0 = front row, 1 = top
      const col = Math.floor(map.uv[i * 2] * 1250);
      const threshold = (BAYER4[map.rowOf[i] % 4][col % 4] + 0.5) / 16;
      return v > threshold ? 2 : 1;
    },
  },
  {
    id: 'border',
    name: 'Base + accent borders',
    cellAt: (map) => {
      // Accent the first/last two rows of each tier.
      const rows = new Set<number>();
      let maxRow = 0;
      for (let i = 0; i < map.count; i++) if (map.rowOf[i] > maxRow) maxRow = map.rowOf[i];
      const tierTop = new Map<number, number>();
      const tierBottom = new Map<number, number>();
      for (let i = 0; i < map.count; i++) {
        const t = map.tierOf[i];
        const r = map.rowOf[i];
        if (!tierBottom.has(t) || r < tierBottom.get(t)!) tierBottom.set(t, r);
        if (!tierTop.has(t) || r > tierTop.get(t)!) tierTop.set(t, r);
      }
      for (const [, b] of tierBottom) rows.add(b).add(b + 1);
      for (const [, t] of tierTop) rows.add(t).add(t - 1);
      return (i: number) => (rows.has(map.rowOf[i]) ? 3 : 1);
    },
  },
];
