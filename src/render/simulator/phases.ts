/**
 * Two-phase choreography: colours first, then every card turns and the
 * design appears. The way the biggest stands do it: one side of the card is
 * a club colour, the other its piece of the picture.
 *
 * Nothing is added to a design for this. The first phase is worked out from
 * the design itself (its own most-used colours, laid on the same seats as
 * one field, two bands or stripes), so every design ever saved can be
 * filmed in two phases and none has to change to open. It is a way of
 * FILMING a tifo: the Pro film and the Reel (film.ts) show it, and the
 * choice lives with the fan's export settings (ui/proPhases.ts), not in the
 * saved file.
 *
 * In the film the cards go up in the first phase's colours as the reveal
 * always plays, hold, and then turn in a wave that crosses the tifo the way
 * the reveal did: each card shows its dark edge for a moment as it turns.
 */
import type { SeatMap } from '../../core/types';
import { FILM_TIMES } from './filmPlan';

export type PhaseLook = 'one' | 'bands' | 'stripes';
export const PHASE_LOOKS: readonly PhaseLook[] = ['bands', 'stripes', 'one'];

/** A seat's override in the simulator: a palette index, or one of these. */
export const PHASE_DESIGN = 254;
export const PHASE_EDGE = 255;

export const PHASES = {
  /** The first card turns, on the film's clock: after the reveal has settled and been looked at. */
  flipAt: 9.0,
  /** How long the turn takes to cross the tifo. */
  flipSpread: 0.9,
  /** How long one card shows its edge, each side of its moment. */
  edge: 0.05,
  /** How many stripes cross the tifo. */
  stripes: 8,
} as const;

/**
 * The first phase: for every painted seat, the palette index it shows before
 * the turn (0 for a seat with no card). `cells` is the design, `palette` its
 * colours' count. With one colour in use, the field is that colour whatever
 * the look.
 */
export function phaseOneCells(map: Pick<SeatMap, 'count' | 'xy'>, cells: ArrayLike<number>, paletteSize: number, look: PhaseLook): Uint8Array {
  const out = new Uint8Array(map.count);
  const used = new Array<number>(Math.max(1, paletteSize)).fill(0);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < map.count; i++) {
    const c = cells[i];
    if (!c) continue;
    used[c] = (used[c] ?? 0) + 1;
    const x = map.xy[i * 2];
    const y = map.xy[i * 2 + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const order = used.map((n, c) => [n, c] as const).filter(([n, c]) => c > 0 && n > 0).sort((a, b) => b[0] - a[0]);
  if (!order.length) return out;
  const a = order[0][1];
  const b = order[1]?.[1] ?? a;
  const w = Math.max(1e-6, x1 - x0);
  const h = Math.max(1e-6, y1 - y0);
  for (let i = 0; i < map.count; i++) {
    if (!cells[i]) continue;
    if (look === 'one' || a === b) out[i] = a;
    else if (look === 'bands') out[i] = (map.xy[i * 2 + 1] - y0) / h < 0.5 ? a : b;
    else out[i] = Math.min(PHASES.stripes - 1, Math.floor(((map.xy[i * 2] - x0) / w) * PHASES.stripes)) % 2 ? b : a;
  }
  return out;
}

/**
 * Each painted seat's moment to turn, from the reveal's own keys (film.ts
 * filmRevealKeys): the turn crosses the tifo in the order the cards went up.
 * Seats with no card never turn (Infinity).
 */
export function flipKeys(revealKeys: Float32Array, painted: (i: number) => boolean): Float32Array {
  const T = FILM_TIMES;
  const keys = new Float32Array(revealKeys.length).fill(Infinity);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < revealKeys.length; i++) {
    if (!painted(i)) continue;
    const k = revealKeys[i];
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  const span = Math.max(1e-6, Math.min(hi - lo, T.revealSpread + 1));
  for (let i = 0; i < revealKeys.length; i++) {
    if (painted(i)) keys[i] = PHASES.flipAt + Math.min(1, Math.max(0, (revealKeys[i] - lo) / span)) * PHASES.flipSpread;
  }
  return keys;
}

/** What seat `i` shows at `t`: its first-phase colour, its edge mid-turn, or the design. */
export function phaseAt(t: number, key: number, first: number): number {
  if (key === Infinity) return PHASE_DESIGN;
  if (t < key - PHASES.edge) return first;
  return t < key + PHASES.edge ? PHASE_EDGE : PHASE_DESIGN;
}
