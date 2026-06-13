import type { SeatMap } from './types';

/**
 * Reveal animation.
 *
 * A reveal assigns every seat a normalized delay in [0,1] — WHEN its card goes
 * up during the show. Playback walks a clock from 0..1 and a seat is "revealed"
 * once the clock passes its delay (with a short per-seat fade ramp). This is a
 * pure ordering over the seat map; the renderer reads it to dim un-revealed
 * seats, and the exporter samples it frame by frame. Orderings are computed
 * from seat coordinates — no per-frame allocation.
 */

export type RevealId =
  | 'sweep-lr'
  | 'sweep-rl'
  | 'sweep-up'
  | 'wipe-center'
  | 'sections'
  | 'rows'
  | 'random'
  | 'instant';

export interface RevealPreset {
  id: RevealId;
  name: string;
}

export const REVEAL_PRESETS: RevealPreset[] = [
  { id: 'sweep-lr', name: 'Sweep left → right' },
  { id: 'sweep-rl', name: 'Sweep right → left' },
  { id: 'sweep-up', name: 'Rise from pitch' },
  { id: 'wipe-center', name: 'Open from center' },
  { id: 'sections', name: 'Section by section' },
  { id: 'rows', name: 'Row by row' },
  { id: 'random', name: 'Sparkle (random)' },
  { id: 'instant', name: 'Instant' },
];

/** Deterministic hash → [0,1) for the sparkle ordering. */
function hash01(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Build the per-seat delay array (length = map.count) for a reveal preset. */
export function buildReveal(map: SeatMap, id: RevealId): Float32Array {
  const delay = new Float32Array(map.count);
  if (id === 'instant') return delay; // all zero

  const sectionCount = (Math.max(...Array.from(map.sectionOf)) || 0) + 1;
  let maxRow = 0;
  for (let i = 0; i < map.count; i++) if (map.rowOf[i] > maxRow) maxRow = map.rowOf[i];

  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2]; // 0..1 around the bowl
    const v = map.uv[i * 2 + 1]; // 0 = front row, 1 = top
    switch (id) {
      case 'sweep-lr':
        delay[i] = u;
        break;
      case 'sweep-rl':
        delay[i] = 1 - u;
        break;
      case 'sweep-up':
        delay[i] = 1 - v; // front rows (low v) reveal last → looks like rising
        break;
      case 'wipe-center': {
        // Distance from the halfway line (u = 0.25 north / 0.75 south reference);
        // simplest: fold u around 0.5 so both ends open outward from center.
        const d = Math.abs(u - 0.5) * 2;
        delay[i] = 1 - d;
        break;
      }
      case 'sections':
        delay[i] = sectionCount > 1 ? map.sectionOf[i] / (sectionCount - 1) : 0;
        break;
      case 'rows':
        delay[i] = maxRow > 0 ? map.rowOf[i] / maxRow : 0;
        break;
      case 'random':
        delay[i] = hash01(i);
        break;
    }
  }
  return delay;
}

export interface PlaybackState {
  /** Clock in [0,1]; >= a seat's delay means it has begun revealing. */
  clock: number;
  playing: boolean;
}

/**
 * Drives a reveal clock with requestAnimationFrame and notifies a callback each
 * frame with the current clock. The renderer maps clock→visibility per seat.
 */
export class RevealPlayer {
  private delay: Float32Array;
  private clock = 0;
  private raf = 0;
  private last = 0;

  /** Total show length in seconds (the reveal spans most of it; fade is the tail). */
  durationSec = 4;
  /** Per-seat fade-in as a fraction of the clock (soft edge on the wave). */
  readonly fade = 0.08;

  constructor(
    map: SeatMap,
    id: RevealId,
    private readonly onFrame: (clock: number, playing: boolean) => void,
  ) {
    this.delay = buildReveal(map, id);
  }

  setReveal(map: SeatMap, id: RevealId): void {
    this.delay = buildReveal(map, id);
  }

  /** Per-seat visibility 0..1 at the current clock (1 = fully up). */
  visibilityAt(seat: number): number {
    const t = (this.clock - this.delay[seat]) / this.fade;
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  }

  get delays(): Float32Array {
    return this.delay;
  }
  get currentClock(): number {
    return this.clock;
  }

  play(): void {
    if (this.raf) return;
    if (this.clock >= 1) this.clock = 0;
    this.last = performance.now();
    const tick = (now: number): void => {
      const dt = (now - this.last) / 1000;
      this.last = now;
      // Reveal occupies the first (1 - fade) of the clock so the last seats finish at 1.
      this.clock = Math.min(1, this.clock + dt / this.durationSec);
      this.onFrame(this.clock, this.clock < 1);
      if (this.clock < 1) this.raf = requestAnimationFrame(tick);
      else this.raf = 0;
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onFrame(this.clock, false);
  }

  seek(clock: number): void {
    this.clock = Math.max(0, Math.min(1, clock));
    this.onFrame(this.clock, false);
  }

  reset(): void {
    this.pause();
    this.clock = 0;
    this.onFrame(0, false);
  }

  get isPlaying(): boolean {
    return this.raf !== 0;
  }
}
