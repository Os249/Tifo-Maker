/**
 * The Reel: the Pro film cut for TikTok, Reels and Shorts.
 *
 * It is the vertical film (filmPlan.ts), made into a post:
 *
 *  - 15 or 30 seconds. The film's own shot runs as it always does up to the
 *    end of its pull-back (REEL.act); the 13 second film fades to black
 *    there, a Reel carries on. At 15 s the hold eases on a little longer. At
 *    30 s it cuts round the tifo first (from the grass, from one end of it,
 *    from high across the ground), each camera drifting, then comes back to
 *    the hold. Every cut is checked against the ground: a camera with a
 *    roof or a stand between it and the tifo is left out and the others
 *    share its seconds.
 *  - a line of the fan's own over the build-up, gone before the first card
 *    goes up, set in the column every app leaves clear (REEL.safe);
 *  - a last frame: a title and a line under it (the club, the date).
 *
 * film.ts asks this module where the film's clock, the camera and the words
 * are at each moment; the words are drawn on the composed frame, never in
 * the 3D scene. Holds no strings: what is written comes from the sheet
 * (ui/proReel.ts).
 */
import type { SimShot, TifoFootprint } from './cameras';
import type { FilmPlan, V3 } from './filmPlan';

export interface ReelCut {
  seconds: 15 | 30;
  /** The fan's line over the build-up. */
  hook?: string;
  /** The last frame. */
  end?: { title: string; line?: string };
  /** The CSS font family for the words (one of the site's voices, already loaded). */
  font: string;
}

export const REEL = {
  /** The film's own shot runs untouched up to here: the end of its pull-back. */
  act: 11.6,
  /** The film's clock never passes this: its fade to black starts just after. */
  holdUntil: 12.24,
  /** The line of the fan's own: in, out, and how long each takes. */
  hookIn: 0.35,
  hookOut: 4.85,
  hookFade: 0.4,
  /** The last frame: how long it takes to come up, and how long it stays, by the Reel's length. */
  endFade: 0.45,
  endFor: { 15: 1.8, 30: 2.6 } as Record<number, number>,
  /** One cut round the tifo, seconds (30 s only). */
  cut: 4,
  /**
   * What the apps cover, as shares of the picture: the top bar, the caption
   * and buttons along the bottom, and the column of buttons down the right
   * (from `rightFrom` of the height). Taken as the widest of TikTok, Reels
   * and Shorts; the words stay clear of all three.
   */
  safe: { top: 0.11, bottom: 0.22, right: 0.14, rightFrom: 0.42 },
} as const;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
const mix = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** A camera that moves a little while it is on: from `from` to `to` over its cut. */
export interface DriftShot {
  from: SimShot;
  to: SimShot;
}

/** What the ground tells the Reel about a camera (FilmHost has it). */
export interface ReelGround {
  sees(from: V3, to: V3): boolean;
}

/**
 * The cuts round the tifo for a 30 second Reel, in the order they play:
 * low on the grass tracking along the stand, off one end of the tifo
 * looking down its length, and high across the ground pushing in. `shots`
 * are the simulator's cameras for the film's shape. Only cameras that
 * really see the tifo are kept.
 */
export function reelCuts(fp: TifoFootprint | null, shots: readonly SimShot[], ground: ReelGround): DriftShot[] {
  if (!fp) return [];
  const [dx, dz] = fp.dir;
  // Along the stand: the tangent to "out from the pitch".
  const tx = -dz;
  const tz = dx;
  const centre: V3 = [fp.centre[0], (fp.y0 + fp.y1) / 2, fp.centre[2]];
  // A camera is kept when nothing the ground built stands between it and the
  // tifo: its middle and both its ends. (Not `overRoof`: that asks what is
  // under a lens up in the air, and the grass is under every camera down here.)
  const ends: V3[] = [-0.4, 0.4].map((k) => [centre[0] + tx * fp.width * k, centre[1], centre[2] + tz * fp.width * k]);
  const ok = (s: SimShot): boolean => ground.sees(s.position as V3, centre) && ends.every((e) => ground.sees(s.position as V3, e));
  const out: DriftShot[] = [];

  // 1. On the grass, looking up: tracking a tenth of the tifo's width along it.
  const low = shots.find((s) => s.name === 'Tifo Pitch Level');
  if (low) {
    const d = fp.width * 0.05;
    const a: SimShot = { ...low, position: [low.position[0] - tx * d, low.position[1], low.position[2] - tz * d] };
    const b: SimShot = { ...low, position: [low.position[0] + tx * d, low.position[1], low.position[2] + tz * d] };
    if (ok(a) && ok(b)) out.push({ from: a, to: b });
  }

  // 2. Off one end of the tifo, a third of the way up it, looking along its
  //    length: the cards in perspective. Whichever end has the clear view.
  const wide = shots.find((s) => s.name === 'Your Tifo');
  for (const side of [1, -1]) {
    const along = fp.width * 0.62 * side;
    const inward = Math.max(10, (fp.far - fp.near) * 0.5 + 14);
    const y = fp.y0 + (fp.y1 - fp.y0) * 0.35 + 3;
    const pos: V3 = [fp.centre[0] + tx * along - dx * inward, y, fp.centre[2] + tz * along - dz * inward];
    const target: V3 = [fp.centre[0] - tx * along * 0.25, centre[1], fp.centre[2] - tz * along * 0.25];
    const a: SimShot = { name: 'Reel Side', position: pos, target, fov: 58 };
    const b: SimShot = { name: 'Reel Side', position: mix(pos, target, 0.07), target, fov: 58 };
    if (ok(a) && ok(b)) {
      out.push({ from: a, to: b });
      break;
    }
  }

  // 3. High across the ground, pushing in a little.
  if (wide && ok(wide)) {
    const b: SimShot = { ...wide, position: mix(wide.position as V3, wide.target as V3, 0.08) };
    if (ok(b)) out.push({ from: wide, to: b });
  }
  return out;
}

/** Where a Reel is at `r` seconds. */
export interface ReelMoment {
  /** The film's own clock (the cards, the haze, the film's camera). */
  t: number;
  /** A cut round the tifo, when one is on: it replaces the film's camera. */
  shot: SimShot | null;
  /** The fan's line, 0..1. */
  hook: number;
  /** The last frame, 0..1. */
  end: number;
}

export interface ReelDirector {
  seconds: number;
  /** When the last frame starts to come up. */
  endAt: number;
  at(r: number): ReelMoment;
}

/** The Reel's clock: the film's shot, then the hold (15 s) or the cuts and the hold (30 s), then the last frame. */
export function reelDirector(reel: Pick<ReelCut, 'seconds' | 'hook' | 'end'>, cuts: readonly DriftShot[]): ReelDirector {
  const R = REEL;
  const seconds = reel.seconds;
  const endAt = reel.end?.title || reel.end?.line ? seconds - R.endFor[seconds] : seconds - 0.35;
  const use = seconds === 30 ? cuts : [];
  // The cuts share what a full set would take; with fewer, each is longer, never over 6 s.
  const each = use.length ? Math.min(6, (R.cut * 3) / use.length) : 0;
  const cutsEnd = R.act + each * use.length;
  const at = (r: number): ReelMoment => {
    const hook = reel.hook?.trim() ? smooth((r - R.hookIn) / R.hookFade) * (1 - smooth((r - R.hookOut) / R.hookFade)) : 0;
    const end = smooth((r - endAt) / R.endFade);
    if (r <= R.act) return { t: r, shot: null, hook, end };
    if (r < cutsEnd) {
      const i = Math.min(use.length - 1, Math.floor((r - R.act) / each));
      const u = (r - R.act - i * each) / each;
      const c = use[i];
      return {
        t: R.holdUntil,
        shot: { name: c.from.name, position: mix(c.from.position as V3, c.to.position as V3, u), target: mix(c.from.target as V3, c.to.target as V3, u), fov: c.from.fov + (c.to.fov - c.from.fov) * u },
        hook,
        end,
      };
    }
    // The hold, eased on from where the pull-back ended to just short of the film's fade.
    const left = Math.max(0.001, seconds - cutsEnd);
    return { t: R.act + (R.holdUntil - R.act) * smooth((r - cutsEnd) / left), shot: null, hook, end };
  };
  return { seconds, endAt, at };
}

/** The film's camera or the cut, at a Reel's moment. */
export function reelShot(plan: FilmPlan, m: ReelMoment): SimShot {
  return m.shot ?? plan.shotAt(m.t);
}

// ------------------------------------------------------------- the words ---

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** `text` in lines no wider than `max`, at `size` px. */
function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && g.measureText(next).width > max) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** The largest size from `big` down to `small` at which `text` fits `max` wide in at most `rows` lines. */
function fitLines(g: CanvasRenderingContext2D, text: string, font: string, max: number, big: number, small: number, rows: number): { size: number; lines: string[] } {
  let size = big;
  for (;;) {
    g.font = `${Math.round(size)}px ${font}`;
    const lines = wrap(g, text, max);
    const widest = Math.max(0, ...lines.map((l) => g.measureText(l).width));
    if ((lines.length <= rows && widest <= max) || size <= small) return { size, lines: lines.slice(0, rows) };
    size = Math.max(small, size * 0.94);
  }
}

function setDir(g: CanvasRenderingContext2D, text: string): void {
  g.direction = ARABIC.test(text) ? 'rtl' : 'ltr';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
}

/**
 * The fan's line over the build-up, `k` 0..1 there. Centred in the column
 * the apps leave clear, under their top bar, over a shade that comes and
 * goes with it so the words read on a floodlit sky as well as a night one.
 */
export function drawReelHook(g: CanvasRenderingContext2D, w: number, h: number, text: string, k: number, font: string): void {
  const words = text.trim();
  if (!words || k <= 0) return;
  const S = REEL.safe;
  g.save();
  const shade = g.createLinearGradient(0, 0, 0, h * 0.4);
  shade.addColorStop(0, `rgba(0,0,0,${(0.62 * k).toFixed(3)})`);
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h * 0.4);
  const max = w * 0.84;
  const { size, lines } = fitLines(g, words, font, max, w * 0.082, w * 0.05, 3);
  g.font = `${Math.round(size)}px ${font}`;
  setDir(g, words);
  g.globalAlpha = k;
  g.shadowColor = 'rgba(0,0,0,0.7)';
  g.shadowBlur = size * 0.28;
  g.shadowOffsetY = size * 0.05;
  g.fillStyle = '#ffffff';
  const lh = size * 1.22;
  // Rises a little as it comes in.
  let y = h * S.top + size * 1.25 + (1 - k) * size * 0.25;
  for (const l of lines) {
    g.fillText(l, w / 2, y);
    y += lh;
  }
  g.restore();
}

/**
 * The last frame, `k` 0..1 there: a title, a rule and a line under it, in
 * the upper part of the picture (over the sky or the roof, above the tifo,
 * which stays in view under a lighter shade), centred and inside the apps'
 * clear column.
 */
export function drawReelEnd(g: CanvasRenderingContext2D, w: number, h: number, end: NonNullable<ReelCut['end']>, k: number, font: string): void {
  const title = end.title.trim();
  const sub = end.line?.trim() ?? '';
  if ((!title && !sub) || k <= 0) return;
  const S = REEL.safe;
  g.save();
  g.fillStyle = `rgba(4,8,16,${(0.3 * k).toFixed(3)})`;
  g.fillRect(0, 0, w, h);
  const shade = g.createLinearGradient(0, 0, 0, h * 0.5);
  shade.addColorStop(0, `rgba(4,8,16,${(0.86 * k).toFixed(3)})`);
  shade.addColorStop(0.62, `rgba(4,8,16,${(0.7 * k).toFixed(3)})`);
  shade.addColorStop(1, 'rgba(4,8,16,0)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h * 0.5);
  g.globalAlpha = k;
  g.fillStyle = '#ffffff';
  // Between the buttons' column on the right and its mirror on the left.
  const max = w * (1 - S.right * 2);
  const t = title ? fitLines(g, title, font, max, w * 0.13, w * 0.07, 2) : { size: 0, lines: [] as string[] };
  const subSize = w * 0.046;
  const tl = t.size * 1.14;
  const rule = title && sub ? w * 0.05 : 0;
  const block = t.lines.length * tl + rule + (sub ? subSize * 1.3 : 0);
  // Its middle a quarter of the way down: under the apps' top bar, over the stand.
  let y = h * 0.245 - block / 2 + t.size * 0.86 + (1 - k) * h * 0.012;
  if (title) {
    g.font = `${Math.round(t.size)}px ${font}`;
    setDir(g, title);
    for (const l of t.lines) {
      g.fillText(l, w / 2, y);
      y += tl;
    }
    y -= tl - t.size * 0.3;
  }
  if (rule) {
    g.fillRect(w / 2 - w * 0.06, y + rule * 0.35, w * 0.12, Math.max(2, Math.round(w * 0.004)));
    y += rule;
  }
  if (sub) {
    const s = fitLines(g, sub, font, max, subSize, subSize * 0.7, 1);
    g.font = `${Math.round(s.size)}px ${font}`;
    setDir(g, sub);
    g.globalAlpha = k * 0.9;
    g.fillText(s.lines[0] ?? '', w / 2, y + s.size);
  }
  g.restore();
}

/** What the apps cover, shaded: the sheet's preview only, never the file. */
export function drawReelGuide(g: CanvasRenderingContext2D, w: number, h: number): void {
  const S = REEL.safe;
  g.save();
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(0, 0, w, h * S.top);
  g.fillRect(0, h * (1 - S.bottom), w, h * S.bottom);
  g.fillRect(w * (1 - S.right), h * S.rightFrom, w * S.right, h * (1 - S.bottom - S.rightFrom));
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = Math.max(1, w * 0.002);
  g.setLineDash([w * 0.012, w * 0.012]);
  g.strokeRect(w * 0.02, h * S.top, w * (1 - S.right) - w * 0.02, h * (1 - S.bottom - S.top));
  g.restore();
}
