import type { RevealMode } from './choreo';

/**
 * Timeline / choreography engine (Wave F4).
 *
 * Generalizes the single reveal into a keyframed sequence of cues that the
 * simulator (and, later, the video export) plays on one clock. Phase-C builds the
 * authoring UI; this is the data model + evaluator the renderer reads each frame.
 *
 * Cue kinds:
 *  - reveal     : run a card reveal (mode) over [start, start+dur]
 *  - assetShow  : fade an asset's opacity from -> to over [start, start+dur]
 *  - effect     : fire a one-shot / toggle effect at `start` (confetti, pyro, ...)
 *  - camera     : switch to a named shot at `start`
 */

export type EffectName =
  | 'confetti'
  | 'pyro'
  | 'smoke-on'
  | 'smoke-off'
  | 'floods-on'
  | 'floods-off';

export interface RevealCue {
  kind: 'reveal';
  start: number;
  dur: number;
  mode: RevealMode;
}
export interface AssetShowCue {
  kind: 'assetShow';
  start: number;
  dur: number;
  assetId: string;
  from: number; // 0..1 opacity
  to: number; // 0..1 opacity
}
export interface EffectCue {
  kind: 'effect';
  start: number;
  effect: EffectName;
}
export interface CameraCue {
  kind: 'camera';
  start: number;
  shot: string;
}
export type Cue = RevealCue | AssetShowCue | EffectCue | CameraCue;

export interface Timeline {
  duration: number;
  cues: Cue[];
}

export function emptyTimeline(): Timeline {
  return { duration: 20, cues: [] };
}

export interface TimelineState {
  reveal: { mode: RevealMode; progress: number } | null;
  assetOpacity: Record<string, number>;
  /** Effect cues whose start was crossed in (prevT, t] — fire once. */
  firedEffects: EffectName[];
  camera: string | null;
}

/**
 * Evaluate the timeline at time `t` (seconds). `prevT` is the previous frame's
 * time so one-shot effect cues fire exactly once on crossing.
 */
export function evalTimeline(tl: Timeline, t: number, prevT: number): TimelineState {
  let reveal: TimelineState['reveal'] = null;
  const assetOpacity: Record<string, number> = {};
  const firedEffects: EffectName[] = [];
  let camera: string | null = null;

  for (const c of tl.cues) {
    if (c.kind === 'reveal') {
      if (t >= c.start && t <= c.start + c.dur) {
        reveal = { mode: c.mode, progress: c.dur > 0 ? (t - c.start) / c.dur : 1 };
      }
    } else if (c.kind === 'assetShow') {
      if (t <= c.start) assetOpacity[c.assetId] = c.from;
      else if (t >= c.start + c.dur) assetOpacity[c.assetId] = c.to;
      else assetOpacity[c.assetId] = c.from + (c.to - c.from) * (c.dur > 0 ? (t - c.start) / c.dur : 1);
    } else if (c.kind === 'effect') {
      if (c.start > prevT && c.start <= t) firedEffects.push(c.effect);
    } else if (c.kind === 'camera') {
      if (c.start <= t) camera = c.shot;
    }
  }

  return { reveal, assetOpacity, firedEffects, camera };
}
