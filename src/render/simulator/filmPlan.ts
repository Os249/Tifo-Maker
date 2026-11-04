/**
 * The Pro film's direction: where the camera is at every instant of the shot,
 * and when the cards go up. Pure numbers (no Three.js, no DOM), so a test can
 * walk the whole shot frame by frame without a browser.
 *
 * One shot of 13 seconds, the way a broadcaster films a tifo:
 *
 *   0.0 to 3.0   establishing: the floodlit ground in its neighbourhood, from
 *                the air behind the stand across from the tifo, drifting;
 *   3.0          cut to the "Your tifo" stage camera (cameras.ts tifoShots),
 *                wide, and a slow push-in on the tifo's stand: a dolly
 *                towards it and a zoom, easing out;
 *   5.6 to 8.8   the reveal, in the design's own order (film.ts filmReveal);
 *   8.8 to 12.3  the hold on the finished tifo, the camera all but settled;
 *   12.3 to 13   a calm end: the last of the drift and a fade to black.
 *
 * Vertical (9:16) is framed tight on the tifo's stand: the hold fills about
 * nine tenths of the frame's width with the tifo (landscape about four
 * fifths, so the stand either side reads), and the establishing shot is
 * closer, so the bowl fills the width instead of floating in the middle of a
 * tall frame.
 */
import type { BowlBounds, SimShot, TifoFootprint } from './cameras';

/** The shot's clock, in seconds. */
export const FILM_TIMES = {
  seconds: 13,
  /** The cut from the establishing shot to the stage camera. */
  cut: 3,
  /** The first card goes up. */
  revealAt: 5.6,
  /** How long the cards take to go up across the tifo, first to last. */
  revealSpread: 2.6,
  /** How long one card takes to go up (the soft edge of the wave). */
  revealFade: 0.6,
  /** The fade to black starts. */
  fadeFrom: 12.3,
} as const;

/**
 * A vertical film's hold: the tifo's height fills TALL.fillH of the picture,
 * as long as at least TALL.shown of its width is in view (a long low stand
 * stops there); the rest runs off the sides, and the camera pans across it
 * from panFrom to panTo, ending in the middle. Then the calm end pulls back
 * from pullFrom to pullTo until every card is in the picture: back along the
 * way the push came in, as far as it takes for the whole tifo to fit a lens
 * of `wholeAcross` degrees across (wider still if even the push's start is
 * too close), and held there through the fade. The hold's lens
 * is no wider than `lens` degrees top to bottom where the camera can stand
 * back that far, and never more than six degrees over it. The camera
 * stands TALL.closer of the landscape hold's distance away, TALL.down degrees
 * above the tifo's middle; over a low ground (its top row under `lowTop`
 * metres) up to `lowDown`: from higher, a low stand's long rake stands up in
 * the picture, and over its back are the streets, not empty sky.
 */
export const TALL = { fillH: 0.56, shown: 0.28, closer: 0.6, down: 10, lowDown: 24, lowTop: 26, panFrom: 4.6, panTo: 9.2, pullFrom: 9.4, pullTo: 11.6, wholeAcross: 62, lens: 76 } as const;

export interface FilmPlanInput {
  /** The picture's width over its height. */
  aspect: number;
  /** The painted seats, or null for a design round the whole bowl (or none). */
  footprint: TifoFootprint | null;
  bounds: BowlBounds;
  /** The ground's plan curve (template.plan) and how far its building reaches past it. */
  plan: { a: number; b: number };
  reach: number;
  /** The stage camera at this aspect: "Your Tifo", or the gantry for a whole-bowl design. */
  stage: SimShot;
  /**
   * Some of the tifo's seats (a few hundred is plenty): the hold is framed on
   * where they really land in the picture, so a curved stand's near ends and
   * a raked stand's top rows are in it.
   */
  points?: readonly V3[];
  /**
   * How the hold frames the tifo, over the film's own (holdFill): how much
   * of the width and of the height it may fill, and where its middle sits
   * (-1 bottom edge, 1 top). A poster leaves room for its type.
   */
  hold?: { fillW: number; fillH: number; centreY: number; centreX?: number };
  /**
   * Whether the camera at `from` sees the card at `to` (nothing the ground
   * built in between). With it, the hold comes down until a roof's front
   * edge or the tier above no longer hides the tifo's top rows.
   */
  sees?: (from: V3, to: V3) => boolean;
  /**
   * Where the first cards go up (the middle of the earliest of them). A
   * vertical film's pan starts on that side, so the wave is seen starting.
   */
  revealFrom?: V3;
  /**
   * Whether the ground's structure is under a camera at `at`. The push starts
   * in front of the stand the stage camera stands on, over the bowl, so it
   * never starts looking across a roof or flies through one.
   */
  overRoof?: (at: V3) => boolean;
  /**
   * An indoor hall: its outside is a skin with the show inside it, so the
   * establishing shot is from high in a corner under the roof (`inside`).
   */
  indoor: boolean;
  inside?: SimShot;
}

export interface FilmPlan {
  seconds: number;
  /** Where the camera is at `t` seconds. */
  shotAt(t: number): SimShot;
  /** How dark the picture is at `t` (0 none, 1 black): the calm end. */
  fadeAt(t: number): number;
  /**
   * How much of the floodlight beams' haze shows at `t`: all of it over the
   * ground, a third of it by the time the cards go up. Down the stage
   * camera's line the beams are pale wedges across the tifo.
   */
  hazeAt(t: number): number;
  /** The camera as the hold frames it: the poster's picture. */
  hold: SimShot;
}

export type V3 = [number, number, number];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const mix = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const deg = (r: number): number => (r * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;

/** The vertical field of view (degrees) that holds `w` metres across at `fill` of the width, `d` metres away. */
export function fovForWidth(w: number, d: number, aspect: number, fill: number): number {
  const half = Math.atan(w / 2 / fill / Math.max(1, d));
  return deg(2 * Math.atan(Math.tan(half) / Math.max(0.1, aspect)));
}
/** The vertical field of view (degrees) that holds `h` metres up at `fill` of the height. */
export function fovForHeight(h: number, d: number, fill: number): number {
  return deg(2 * Math.atan(h / 2 / fill / Math.max(1, d)));
}

/**
 * How much of the frame's width the tifo fills at the hold. Landscape leaves
 * the stand either side in the picture; vertical is tight on the tifo.
 */
export function holdFill(aspect: number): number {
  return aspect < 1 ? 0.9 : 0.78;
}

/** A vertical field of view whose width (the field across) stays within lo..hi degrees. */
function clampAcross(fov: number, aspect: number, lo: number, hi: number): number {
  const across = deg(2 * Math.atan(Math.tan(rad(fov) / 2) * aspect));
  const want = Math.max(lo, Math.min(hi, across));
  return want === across ? fov : deg(2 * Math.atan(Math.tan(rad(want) / 2) / aspect));
}

/**
 * The hold's camera, lowered (3 m at a time, never under 6 m), and then
 * from up to 30 m further back along `back`, until it sees nineteen in
 * twenty of the tifo's cards, and of its top rows, or as many as it can:
 * from a gantry, a stand's roof hangs down in front of its top rows.
 */
function clearView(pos: V3, back: V3, points: readonly V3[], sees: (from: V3, to: V3) => boolean): V3 {
  const step = Math.max(1, Math.floor(points.length / 48));
  const sample = points.filter((_, i) => i % step === 0);
  // The top rows on their own as well: they are what a roof's edge takes,
  // and a few per cent of the cards can be the whole top of a word.
  let top = -Infinity;
  let bottom = Infinity;
  for (const p of points) {
    top = Math.max(top, p[1]);
    bottom = Math.min(bottom, p[1]);
  }
  const high = points.filter((p) => p[1] >= bottom + (top - bottom) * 0.8);
  const highStep = Math.max(1, Math.floor(high.length / 24));
  const highSample = high.filter((_, i) => i % highStep === 0);
  const shareOf = (at: V3, list: readonly V3[]): number => (list.length ? list.filter((p) => sees(at, p)).length / list.length : 1);
  const share = (at: V3): number => Math.min(shareOf(at, sample), shareOf(at, highSample));
  let best = pos;
  let bestShare = share(pos);
  // Lower first; then from further back, where a roof's edge hides less.
  for (const backBy of [0, 10, 20, 30]) {
    const from = add(pos, back, backBy);
    for (let y = from[1] - (backBy ? 0 : 3); bestShare < 0.95 && y >= 6; y -= 3) {
      const at: V3 = [from[0], y, from[2]];
      const k = share(at);
      if (k > bestShare + 0.01) {
        best = at;
        bestShare = k;
      }
    }
  }
  return best;
}

/** Ease out: quick off the cut, settling into the hold. */
const easeOut = (u: number): number => 1 - Math.pow(1 - clamp01(u), 3);

const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Aim from `pos` so that `points` sit in the middle of the picture, and the
 * vertical field of view that holds them at `fillW` of the width and `fillH`
 * of the height. Worked out on the picture plane, so it is exact for a curved
 * stand whose ends come towards the camera. `centreY` is where the middle of
 * them sits, from -1 (the bottom edge) to 1 (the top). A `fillW` over 1 lets
 * them run wider than the picture; `halfW` is how wide they are, half, on
 * the picture plane (a tangent).
 */
export function frameOn(points: readonly V3[], pos: V3, aim: V3, aspect: number, fillW: number, fillH: number, centreY = 0, centreX = 0): { target: V3; fov: number; halfW: number } {
  let forward = norm(sub(aim, pos));
  let x0 = 0;
  let x1 = 0;
  let y0 = 0;
  let y1 = 0;
  const tanOf = (): number => Math.max((x1 - x0) / 2 / fillW / Math.max(0.1, aspect), (y1 - y0) / 2 / fillH);
  for (let pass = 0; pass < 4; pass++) {
    const right = norm(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    x0 = y0 = Infinity;
    x1 = y1 = -Infinity;
    for (const p of points) {
      const d = sub(p, pos);
      const z = dot(d, forward);
      if (z <= 1) continue;
      const x = dot(d, right) / z;
      const y = dot(d, up) / z;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (x0 === Infinity) break;
    // Turn towards the middle of what was seen (or to where it is to sit), and look again.
    forward = norm(add(add(forward, right, (x0 + x1) / 2 - centreX * tanOf() * aspect), up, (y0 + y1) / 2 - centreY * tanOf()));
  }
  const dist = len(sub(aim, pos));
  const target = add(pos, forward, dist);
  if (x0 === Infinity) return { target: aim, fov: 50, halfW: 0 };
  return { target, fov: deg(2 * Math.atan(tanOf())), halfW: (x1 - x0) / 2 };
}

export function planFilm(input: FilmPlanInput): FilmPlan {
  const T = FILM_TIMES;
  const { aspect, footprint: fp, bounds, stage } = input;
  const portrait = aspect < 1;

  // ---- the stage camera: a push-in from the gantry towards the tifo ----
  const P = stage.position;
  const tgt = stage.target;
  const toward = sub(tgt, P);
  const dist = len(toward);
  const dir: V3 = [toward[0] / dist, toward[1] / dist, toward[2] / dist];
  // Across, for a little parallax as it pushes in (horizontal, to the right of the line).
  const side: V3 = (() => {
    const h = Math.hypot(dir[0], dir[2]) || 1;
    return [-dir[2] / h, 0, dir[0] / h];
  })();
  // From the stage camera, brought forward off the stand (and any roof) it stands on.
  // Never so close that the tifo's width needs a lens wider than 66° across
  // (the hold's lens is held to 72°: closer, the tifo would not fit).
  const fill = input.hold?.fillW ?? holdFill(aspect);
  // A vertical film is framed on the tifo's height, not its width: closer and
  // lower, the stand fills the frame top to bottom, the tifo runs wider than
  // the picture and the camera pans across it to the middle (TALL).
  const tall = portrait && !input.hold && !!fp && !!input.points?.length;
  // (A vertical film's hold shows a slice of the tifo, but from too close a
  // wide one wraps round the lens.)
  const near = tall
    ? Math.max(25, fp!.width * 0.45)
    : Math.max(30, fp ? fp.width / 2 / fill / Math.tan(rad(33)) : 30);
  let P0: V3 = P;
  for (let k = 0; k < 20 && input.overRoof?.(P0); k++) {
    const next = add(P0, dir, Math.max(2, dist * 0.02));
    if (len(sub(tgt, next)) < near) break;
    P0 = next;
  }
  const dist0 = len(sub(tgt, P0));
  // The dolly covers a fifth of the way, and stops short of `near`.
  const push = Math.min(dist0 * 0.2, Math.max(0, dist0 - near));
  let P1 = add(add(P0, dir, push), [0, -Math.min(3, P0[1] * 0.08), 0]);
  if (fp && tall) {
    // Closer, and lower: 10° down to the tifo's middle, from three fifths of
    // the way the landscape hold stands (never nearer than `near`).
    const c = fp.centre;
    const mid = (fp.y0 + fp.y1) / 2;
    const h0 = Math.hypot(c[0] - P1[0], c[2] - P1[2]);
    // Not so close that the stand's height needs a lens wider than TALL.lens
    // (top to bottom) to fill TALL.fillH: in a hall the stand is near and tall.
    const rise = (fp.y1 - fp.y0 + (fp.far - fp.near) * 0.35) * 1.3;
    const fit = rise / TALL.fillH / 2 / Math.tan(rad(TALL.lens) / 2);
    const hd = Math.min(h0, Math.max(near, h0 * TALL.closer, fit));
    const k = 1 - hd / h0;
    const down = TALL.down + (TALL.lowDown - TALL.down) * clamp01((TALL.lowTop - input.bounds.ty) / 12);
    const y = Math.max(8, mid + hd * Math.tan(rad(down)));
    P1 = [P1[0] + (c[0] - P1[0]) * k, input.indoor ? Math.min(y, Math.max(P1[1], P[1])) : y, P1[2] + (c[2] - P1[2]) * k];
  } else if (fp) {
    // Looking down on it by at least 14°: seen level from across a track, a
    // low stand's rake folds the tifo into a thin band. Over the bowl there
    // is room to rise; under a hall's roof, never above the stage camera.
    const c = fp.centre;
    const want = c[1] + Math.hypot(c[0] - P1[0], c[2] - P1[2]) * Math.tan(rad(14));
    const y = Math.min(want, input.indoor ? Math.max(P1[1], P[1]) : Infinity);
    if (y > P1[1]) P1 = [P1[0], y, P1[2]];
  }
  // A little to one side by the end: the push drifts across as it goes in,
  // for some parallax. Part of where the hold stands, so it is framed from there.
  P1 = add(P1, side, len(sub(tgt, P1)) * 0.05);
  if (input.sees && input.points?.length) P1 = clearView(P1, norm([-dir[0], 0, -dir[2]]), input.points, input.sees);
  // The whole way in, not only at its end: a screen hung under a roof (the
  // Bernabéu's ring) can sit across the line half way along the push.
  if (input.sees && fp) {
    const sees = input.sees;
    const aim: V3 = [fp.centre[0], (fp.y0 + fp.y1) / 2, fp.centre[2]];
    for (let k = 0; k < 12 && P1[1] > 6 && [0.25, 0.5, 0.75, 1].some((s) => !sees(mix(P0, P1, s), aim)); k++) P1 = [P1[0], Math.max(6, P1[1] - 3), P1[2]];
  }
  const d1 = len(sub(tgt, P1));
  let fov1: number;
  let tgt1 = tgt;
  /**
   * A vertical film's pan: how far to one side of the middle it starts, in
   * metres across the tifo (the same place on the stand from far and near),
   * and the direction.
   */
  let panBy = 0;
  let panDir: V3 = [0, 0, 0];
  /** Where a vertical film's pull-back ends: the whole tifo in view. */
  let pullTo: { pos: V3; fov: number; target: V3 } | null = null;
  if (tall) {
    // Where each card lands across the picture, in metres at the tifo's
    // middle (a curved stand's ends come nearer, and look wider), and the
    // middle slice the hold shows: as wide as the picture is there when the
    // tifo's height fills TALL.fillH of it, and never under TALL.shown of it.
    // Held to three times the distance either side: a wide stand's ends
    // wrap round a close camera, and their tangents run away.
    const pts = input.points!;
    const fwd = norm(sub(tgt, P1));
    const right = norm(cross(fwd, [0, 1, 0]));
    const dist = Math.max(10, dot(sub(fp!.centre, P1), fwd));
    const across = pts.map((p) => {
      const d = sub(p, P1);
      const z = dot(d, fwd);
      const x = dot(d, right);
      return z > 1 ? Math.max(-3, Math.min(3, x / z)) * dist : Math.sign(x) * 3 * dist;
    });
    const lo = Math.min(...across);
    const hi = Math.max(...across);
    const half = (hi - lo) / 2;
    const mid = (hi + lo) / 2;
    const shownHalf = (fov: number): number => Math.max(half * TALL.shown, Math.tan(rad(fov) / 2) * aspect * dist);
    let f = frameOn(pts, P1, tgt, aspect, 100, TALL.fillH, 0);
    let vw = shownHalf(f.fov);
    for (let pass = 0; pass < 2 && vw < half; pass++) {
      const slice = pts.filter((_, i) => Math.abs(across[i] - mid) <= vw);
      if (slice.length < 8) break;
      f = frameOn(slice, P1, tgt, aspect, 1, TALL.fillH, 0);
      vw = Math.min(half, shownHalf(f.fov));
    }
    if (vw >= half) f = frameOn(pts, P1, tgt, aspect, holdFill(aspect), TALL.fillH, 0);
    // Where the camera could not stand back far enough, the tifo fills more of the height instead.
    fov1 = Math.min(f.fov, TALL.lens + 6);
    tgt1 = f.target;
    // The calm end: back along the push until the whole tifo fits.
    const tanWhole = Math.tan(rad(TALL.wholeAcross) / 2);
    let whole = { pos: P0, fit: frameOn(pts, P0, tgt, aspect, 0.92, 0.9, 0) };
    for (const k of [0, 0.2, 0.4, 0.6, 0.8]) {
      const at = mix(P1, P0, k);
      const fit = frameOn(pts, at, tgt, aspect, 0.92, 0.9, 0);
      if (Math.tan(rad(fit.fov) / 2) * aspect <= tanWhole) {
        whole = { pos: at, fit };
        break;
      }
    }
    pullTo = { pos: whole.pos, fov: Math.min(118, Math.max(fov1, whole.fit.fov)), target: whole.fit.target };
    // The pan starts at the end the cards start from (the left, if the middle).
    const from = input.revealFrom ? dot(sub(input.revealFrom, P1), right) - mid : 0;
    panDir = from > 1 ? right : [-right[0], -right[1], -right[2]];
    panBy = Math.max(0, half - vw);
  } else if (fp && input.points?.length) {
    // Where the tifo really lands in the picture: a vertical frame is tight on
    // its width (and so shows twice that in height: the stand round it, the
    // lights and a strip of pitch), and a raked stand's height never takes
    // more than its share.
    const h = input.hold ?? { fillW: holdFill(aspect), fillH: portrait ? 0.42 : 0.8, centreY: portrait ? 0.02 : -0.04 };
    let f = frameOn(input.points, P1, tgt, aspect, h.fillW, h.fillH, h.centreY, h.centreX ?? 0);
    // A poster's tifo too wide for the lens from here (a hall's stand, near):
    // from further back along the way the push came in, until it fits.
    const fits = (fov: number): boolean => Math.tan(rad(fov) / 2) * aspect <= Math.tan(rad(36));
    if (input.hold && !fits(f.fov)) {
      const from = P1;
      for (const k of [0.25, 0.5, 0.75, 1]) {
        P1 = mix(from, P0, k);
        f = frameOn(input.points, P1, tgt, aspect, h.fillW, h.fillH, h.centreY, h.centreX ?? 0);
        if (fits(f.fov)) break;
      }
    }
    fov1 = f.fov;
    tgt1 = f.target;
  } else if (fp) {
    // Seen from across, a raked stand shows its rise and part of its depth.
    const tall = fp.y1 - fp.y0 + (fp.far - fp.near) * 0.35;
    fov1 = Math.max(fovForWidth(fp.width, d1, aspect, holdFill(aspect)), fovForHeight(tall, d1, portrait ? 0.5 : 0.82));
  } else {
    // No one tifo to fill the frame with: the stage camera's own framing, a step in.
    fov1 = stage.fov * (dist > 0 ? d1 / dist : 1);
  }
  // Limited across, not up: a vertical frame holding a wide tifo needs a tall
  // field of view, and it is the width that bends when a lens is too wide.
  fov1 = clampAcross(fov1, aspect, 6, 72);
  // An off-centre frame (a poster's) is offset in the lens it ends up with:
  // held to 72° across, the offset worked out for a wider one overshoots.
  if (input.hold && fp && input.points?.length && (input.hold.centreY || input.hold.centreX)) {
    const c = frameOn(input.points, P1, tgt, aspect, input.hold.fillW, input.hold.fillH, 0, 0);
    const fwd = norm(sub(c.target, P1));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const tv = Math.tan(rad(fov1) / 2);
    const dir = norm(add(add(fwd, up, -input.hold.centreY * tv), right, -(input.hold.centreX ?? 0) * tv * aspect));
    tgt1 = add(P1, dir, len(sub(c.target, P1)));
  }
  // Wide off the cut: the whole stand and its neighbours, then in. A
  // vertical frame is already wide up and down, so its push is more dolly
  // than zoom.
  const fov0 = clampAcross(deg(2 * Math.atan(Math.tan(rad(fov1) / 2) * (portrait && !tall ? 1.3 : 1.85))), aspect, 6, 80);
  const stageAt = (t: number): SimShot => {
    const u = (t - T.cut) / (T.seconds - T.cut);
    // Most of the push is over by the reveal's end; a tenth of it goes on
    // through the hold: a camera on a cable, alive to the end, not a still.
    const s = 0.9 * easeOut(u) + 0.1 * clamp01(u);
    let pos = mix(P0, P1, s);
    let target = mix(tgt, tgt1, s);
    if (panBy > 0) {
      // From the side the cards start on, across to the middle by the end of
      // the hold, easing in and out; turned, not moved, like a hand on a phone.
      const k = clamp01((t - TALL.panFrom) / (TALL.panTo - TALL.panFrom));
      target = add(target, panDir, panBy * (1 - k * k * (3 - 2 * k)));
    }
    // The frame's height in the picture, not its angle, moves evenly with a zoom.
    const tan0 = Math.tan(rad(fov0) / 2);
    const tan1 = Math.tan(rad(fov1) / 2);
    let tan = tan0 + (tan1 - tan0) * s;
    if (pullTo && t > TALL.pullFrom) {
      const k = clamp01((t - TALL.pullFrom) / (TALL.pullTo - TALL.pullFrom));
      const e = k * k * (3 - 2 * k);
      tan += (Math.tan(rad(pullTo.fov) / 2) - tan) * e;
      pos = mix(pos, pullTo.pos, e);
      target = mix(target, pullTo.target, e);
    }
    return { name: 'Film', position: pos, target, fov: deg(2 * Math.atan(tan)) };
  };

  // ---- the establishing shot ----
  const { a, b } = input.plan;
  const R = Math.max(a, b) + input.reach;
  // Behind the stand across from the tifo (or the main stand), looking over it into the bowl.
  const back: [number, number] = fp ? [-fp.dir[0], -fp.dir[1]] : [0, -1];
  const look: V3 = fp ? [fp.centre[0] * 0.35, bounds.ty * 0.25, fp.centre[2] * 0.35] : [0, bounds.ty * 0.2, 0];
  let estAt: (t: number) => SimShot;
  if (input.indoor && input.inside) {
    const inside = input.inside;
    estAt = (t: number): SimShot => {
      // A slow pan across the hall from its corner, a touch closer as it goes.
      const u = clamp01(t / T.cut);
      const pos = mix(inside.position, mix(inside.position, inside.target, 0.12), u);
      const off = mix([-6, 0, -6], [6, 0, 6], u);
      return { name: 'Film', position: pos, target: add(inside.target, off), fov: inside.fov * (portrait ? 1.25 : 1) };
    };
  } else {
    // Far enough out that the bowl and its streets are in, high enough to see into it.
    // Steep enough to see down into the bowl over a big roof (about 37°).
    const D = R * (portrait ? 1.6 : 1.85);
    const H = D * 0.75;
    // The bowl's width at that distance decides the lens: the building fills
    // most of a landscape frame with its streets round it, and all of a
    // vertical frame's width.
    const fovEst = Math.max(24, Math.min(portrait ? 80 : 58, fovForWidth(R * 2.15, Math.hypot(D, H), aspect, portrait ? 1.05 : 0.74)));
    const az0 = Math.atan2(back[1], back[0]);
    estAt = (t: number): SimShot => {
      const u = clamp01(t / T.cut);
      // Eight degrees round and a little lower over the three seconds: a drone, not a still.
      const az = az0 + rad(-4 + 8 * u);
      const r = D * (1 - 0.05 * u);
      return {
        name: 'Film',
        position: [Math.cos(az) * r, H * (1 - 0.06 * u), Math.sin(az) * r],
        target: look,
        fov: fovEst,
      };
    };
  }

  const shotAt = (t: number): SimShot => (t < T.cut ? estAt(t) : stageAt(t));
  const fadeAt = (t: number): number => {
    const k = clamp01((t - T.fadeFrom) / (T.seconds - T.fadeFrom));
    return k * k * (3 - 2 * k);
  };
  const hazeAt = (t: number): number => (t < T.cut ? 1 : 1 - 0.65 * clamp01((t - T.cut) / (T.revealAt - T.cut)));
  return { seconds: T.seconds, shotAt, fadeAt, hazeAt, hold: stageAt(T.fadeFrom - 0.5) };
}
