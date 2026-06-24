import type { SeatMap } from '../../core/types';

/**
 * Match Day Simulator — choreography reveal (Phase 7).
 *
 * Pure functions that turn a 0..1 progress into a per-seat visibility (0 = card
 * down/dark, 1 = up/full) for a chosen reveal pattern. The simulator animates
 * progress over time and feeds the result to its applyReveal(), so a reveal plays
 * the same way it would in the editor preview and in an exported clip.
 */

export type RevealMode = 'wipe-lr' | 'wipe-up' | 'center-out' | 'sparkle';

export const REVEAL_MODES: { id: RevealMode; label: string }[] = [
  { id: 'wipe-lr', label: 'Wipe across' },
  { id: 'wipe-up', label: 'Wipe upward' },
  { id: 'center-out', label: 'Center out' },
  { id: 'sparkle', label: 'Sparkle in' },
];

const EDGE = 0.12; // soft transition width

function hash(i: number): number {
  let x = (i * 374761393 + 668265263) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = (x * 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function ramp(threshold: number, value: number): number {
  // value below threshold -> 1, above threshold+EDGE -> 0, smooth between.
  const t = (value - threshold) / EDGE;
  return Math.max(0, Math.min(1, 1 - t));
}

/** Build a visibility function for `mode` at `progress` (0..1). */
export function revealVisibility(map: SeatMap, mode: RevealMode, progress: number): (seat: number) => number {
  const p = Math.max(0, Math.min(1, progress));
  return (i: number): number => {
    const u = map.uv[i * 2];
    const v = map.uv[i * 2 + 1];
    switch (mode) {
      case 'wipe-lr':
        return ramp(p * (1 + EDGE), u);
      case 'wipe-up':
        return ramp(p * (1 + EDGE), 1 - v);
      case 'center-out': {
        const d = Math.abs(u - 0.5) * 2; // 0 center .. 1 edge
        return 1 - ramp(p * (1 + EDGE), 1 - d);
      }
      case 'sparkle':
        return hash(i) < p ? 1 : 0;
      default:
        return 1;
    }
  };
}
