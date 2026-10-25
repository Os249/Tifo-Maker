import type { SeatMap } from '../../core/types';
import { drumCallPlan, drumCallVisibility, type DrumCallPlan } from '../../core/drumCall';

/**
 * Match Day Simulator — choreography reveal (Phase 7).
 *
 * Pure functions that turn a 0..1 progress into a per-seat visibility (0 = card
 * down/dark, 1 = up/full) for a chosen reveal pattern. The simulator animates
 * progress over time and feeds the result to its applyReveal(), so a reveal plays
 * the same way it would in the editor preview and in an exported clip.
 */

export type RevealMode = 'wipe-lr' | 'wipe-up' | 'center-out' | 'sparkle' | 'drum-call';

/**
 * `label` is the English name; the panel shows `labelKey` from its own
 * dictionary, so the list reads in Arabic too — it was English-only before.
 */
export const REVEAL_MODES: { id: RevealMode; label: string; labelKey: string }[] = [
  { id: 'wipe-lr', label: 'Wipe across', labelKey: 'rm.wipe-lr' },
  { id: 'wipe-up', label: 'Wipe upward', labelKey: 'rm.wipe-up' },
  { id: 'center-out', label: 'Center out', labelKey: 'rm.center-out' },
  { id: 'sparkle', label: 'Sparkle in', labelKey: 'rm.sparkle' },
  { id: 'drum-call', label: 'Drum call (Saudi style)', labelKey: 'rm.drum-call' },
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

/**
 * The number of each seat a wipe compares with its threshold — the `value`
 * revealVisibility ramps below — for the GPU to do the rest (performance plan
 * P3.2). Made once per mode. Null for the drum call, which has none.
 */
export function revealKeys(map: SeatMap, mode: RevealMode): Float32Array | null {
  if (mode === 'drum-call') return null;
  const out = new Float32Array(map.count);
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    const v = map.uv[i * 2 + 1];
    switch (mode) {
      case 'wipe-lr':
        out[i] = u;
        break;
      case 'wipe-up':
        out[i] = 1 - v;
        break;
      case 'center-out':
        out[i] = 1 - Math.abs(u - 0.5) * 2;
        break;
      case 'sparkle':
        out[i] = hash(i);
        break;
      default:
        out[i] = 0;
    }
  }
  return out;
}

/**
 * revealVisibility's instant, for the GPU: what each mode compares a seat's
 * key with at `progress`. `ramp` is ramp(threshold, key) (inverted: 1 minus
 * it); `step` is key < progress; `drum` is the call at `t` seconds; `all` is
 * one value for every seat (a mode this file does not know).
 */
export type RevealInstant =
  | { kind: 'ramp'; threshold: number; edge: number; inverted: boolean }
  | { kind: 'step'; progress: number }
  | { kind: 'drum'; plan: DrumCallPlan; t: number }
  | { kind: 'all'; value: number };

export function revealInstant(mode: RevealMode, progress: number, drum?: DrumCallPlan): RevealInstant {
  const p = Math.max(0, Math.min(1, progress));
  if (mode === 'drum-call') {
    const plan = drum ?? drumCallPlan();
    return { kind: 'drum', plan, t: p * plan.duration };
  }
  switch (mode) {
    case 'wipe-lr':
    case 'wipe-up':
      return { kind: 'ramp', threshold: p * (1 + EDGE), edge: EDGE, inverted: false };
    case 'center-out':
      return { kind: 'ramp', threshold: p * (1 + EDGE), edge: EDGE, inverted: true };
    case 'sparkle':
      return { kind: 'step', progress: p };
    default:
      return { kind: 'all', value: 1 };
  }
}

/**
 * Build a visibility function for `mode` at `progress` (0..1).
 *
 * The drum call is a show, not a wipe: its progress is a position in time
 * across the whole call (both counts, the hold, the drop), and `drum` is the
 * call being played — the default one-cycle call when none is given.
 */
export function revealVisibility(
  map: SeatMap,
  mode: RevealMode,
  progress: number,
  drum?: DrumCallPlan,
): (seat: number) => number {
  const p = Math.max(0, Math.min(1, progress));
  if (mode === 'drum-call') {
    const plan = drum ?? drumCallPlan();
    const t = p * plan.duration;
    return (i: number): number => drumCallVisibility(plan, i, t);
  }
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
