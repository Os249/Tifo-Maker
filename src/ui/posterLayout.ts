/**
 * The Pro poster, drawn: a match-day poster made of the tifo's Match Day
 * picture and type, in three layouts and two shapes. Canvas only, so the
 * sheet's live preview (ui/proPoster.ts) and the 4K file are the same
 * drawing at two sizes, and the shot script can draw it without the sheet.
 *
 *   matchday  the conventions of a club's match-day graphic: the crest and
 *             "MATCHDAY" at the top, the club huge, "VS" and the opponent
 *             under it, and the date, kick-off and ground on a band of the
 *             club's colour;
 *   chant     the chant or headline set big over the pitch below the tifo,
 *             the club small under it;
 *   minimal   the tifo, and the club's name small in a corner.
 *
 * Landscape lines the type up on the reading side (left in English, right in
 * Arabic); portrait centres it, the crest at the top over the sky and the
 * words at the bottom over the pitch, so neither covers the tifo. Every line
 * is fitted to its room (never below a size it can be read at), and each
 * field is set in its own direction: an Arabic club name on an English
 * poster is shaped and set right to left, and the other way round.
 */

export type PosterLayout = 'matchday' | 'chant' | 'minimal';
export type PosterShape = 'landscape' | 'portrait';

export const POSTER_SIZES: Record<PosterShape, { width: number; height: number }> = {
  landscape: { width: 3840, height: 2160 },
  portrait: { width: 2160, height: 3840 },
};

export interface PosterSpec {
  layout: PosterLayout;
  club: string;
  opponent: string;
  /** Already formatted for the poster's language ("SAT 8 NOV", "السبت 8 نوفمبر"). */
  date: string;
  time: string;
  venue: string;
  headline: string;
  /** The poster's own words, in its language. */
  labels: { matchday: string; vs: string };
  /** The poster's language reads right to left: the type lines up on the right. */
  rtl: boolean;
  /** The club's colours (the kit's, or the design's palette without the empty seat). */
  colours: readonly string[];
  logo: (CanvasImageSource & { width: number; height: number }) | null;
  /** CSS font families: the big type, and the information's. */
  display: string;
  text: string;
  creditLine?: string;
}

// ---------------------------------------------------------------- colour ---

interface Rgb { r: number; g: number; b: number }

function rgbOf(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const hexOf = (c: Rgb): string => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** WCAG relative luminance, 0..1. */
function luminance(c: Rgb): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
const chroma = (c: Rgb): number => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => ({ r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k });
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

export interface PosterColours {
  /** A band's fill: the club's strongest colour. */
  band: string;
  /** The words on that band. */
  onBand: string;
  /** A colour that reads on the dark scrims: "VS", the rules. */
  ink: string;
}

/**
 * The club's colours as the poster uses them: its strongest colour for the
 * band, and for the accents on the dark scrims the strongest colour light
 * enough to read there, lightened when none is. A black-and-white club
 * keeps black and white.
 */
export function posterColours(list: readonly string[]): PosterColours {
  const cs = list.map(rgbOf).filter((c): c is Rgb => !!c);
  const vivid = [...cs].filter((c) => chroma(c) > 0.18).sort((a, b) => chroma(b) - chroma(a));
  if (!vivid.length) {
    const dark = cs.find((c) => luminance(c) < 0.2);
    return { band: dark ? hexOf(dark) : '#11151e', onBand: '#ffffff', ink: '#ffffff' };
  }
  const band = vivid[0];
  const light = vivid.find((c) => luminance(c) >= 0.18);
  const ink = light ?? mixRgb(vivid[0], WHITE, 0.45);
  return { band: hexOf(band), onBand: luminance(band) > 0.45 ? '#0b0f17' : '#ffffff', ink: hexOf(ink) };
}

// ------------------------------------------------------------------ type ---

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
export const isArabic = (s: string): boolean => ARABIC.test(s);
/** Latin display type is set in capitals, as on every match-day poster; Arabic has none. */
const caps = (s: string): string => s.toLocaleUpperCase('en');

interface TextStyle {
  family: string;
  /** Pixels. */
  size: number;
  colour: string;
  /** Extra space between letters, as a share of the size (Latin only: Arabic letters join). */
  tracking?: number;
  shadow?: number;
}

function font(g: CanvasRenderingContext2D, st: TextStyle, text: string): void {
  g.font = `${Math.round(st.size)}px ${st.family}`;
  g.direction = isArabic(text) ? 'rtl' : 'ltr';
  // Canvas spacing between letters (Chromium, Safari 17+): never on Arabic, whose letters join.
  const ls = st.tracking && !isArabic(text) ? `${(st.size * st.tracking).toFixed(1)}px` : '0px';
  (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = ls;
}

function measure(g: CanvasRenderingContext2D, text: string, st: TextStyle): number {
  font(g, st, text);
  return g.measureText(text).width;
}

/**
 * How far a line's ink reaches above and below its baseline. Lines are
 * stacked on their ink, not on the font size: an Arabic line's tails reach
 * well below the baseline, and Latin capitals not at all.
 */
function ink(g: CanvasRenderingContext2D, text: string, st: TextStyle): { up: number; down: number } {
  font(g, st, text);
  const m = g.measureText(text);
  return { up: m.actualBoundingBoxAscent, down: Math.max(0, m.actualBoundingBoxDescent) };
}

/** The largest size, from `max` down to `min`, at which `text` fits `width`. */
function fit(g: CanvasRenderingContext2D, text: string, st: Omit<TextStyle, 'size'>, width: number, max: number, min: number): number {
  const at = measure(g, text, { ...st, size: 100 });
  if (at <= 0) return max;
  return Math.max(min, Math.min(max, (100 * width) / at));
}

type Align = 'start' | 'center' | 'end';

/**
 * One centred line whose ink ends just above `bottom`, stacked upwards: the
 * bottom for the line above it, `gap` over this one's ink, is returned.
 */
function stack(g: CanvasRenderingContext2D, text: string, cx: number, bottom: number, st: TextStyle, rtl: boolean, gap: number): number {
  const k = ink(g, text, st);
  const base = bottom - k.down;
  line(g, text, cx, base, st, 'center', rtl);
  return base - k.up - gap;
}

/**
 * Set one line with its baseline at `y`. `x` is the line's start on the
 * poster's reading side for 'start', its middle for 'center'. Returns the
 * line's width.
 */
function line(g: CanvasRenderingContext2D, text: string, x: number, y: number, st: TextStyle, align: Align, rtl: boolean): number {
  font(g, st, text);
  g.textAlign = align === 'center' ? 'center' : (align === 'start') !== rtl ? 'left' : 'right';
  g.textBaseline = 'alphabetic';
  if (st.shadow) {
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = st.shadow;
    g.shadowOffsetY = st.shadow * 0.25;
  }
  g.fillStyle = st.colour;
  g.fillText(text, x, y);
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  return g.measureText(text).width;
}

/**
 * Words into at most `lines` lines that fit `width` at the largest size
 * between `max` and `min`: one line if it can be read at `oneLineMin`,
 * otherwise split where the lines come out most even.
 */
function wrapFit(g: CanvasRenderingContext2D, text: string, st: Omit<TextStyle, 'size'>, width: number, max: number, min: number, lines: number, oneLineMin: number): { lines: string[]; size: number } {
  const one = fit(g, text, st, width, max, min);
  const words = text.split(/\s+/).filter(Boolean);
  if (one >= oneLineMin || words.length < 2 || lines < 2) return { lines: [text], size: one };
  // Each line more has to buy real size: a word left alone on a line reads as a mistake.
  const score = (size: number, n: number): number => size * 0.87 ** (n - 1);
  let best = { lines: [text], size: one };
  const tryLines = (parts: string[]): void => {
    const size = Math.min(...parts.map((p) => fit(g, p, st, width, max, min)));
    if (score(size, parts.length) > score(best.size, best.lines.length)) best = { lines: parts, size };
  };
  for (let i = 1; i < words.length; i++) {
    tryLines([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
    if (lines >= 3) for (let j = i + 1; j < words.length; j++) tryLines([words.slice(0, i).join(' '), words.slice(i, j).join(' '), words.slice(j).join(' ')]);
  }
  return best;
}

// ---------------------------------------------------------------- pieces ---

/** The picture, cropped to cover the poster (it is drawn at the poster's shape, so normally it already does). */
function background(g: CanvasRenderingContext2D, W: number, H: number, bg: CanvasImageSource & { width: number; height: number }): void {
  const k = Math.max(W / bg.width, H / bg.height);
  const w = bg.width * k;
  const h = bg.height * k;
  g.drawImage(bg, (W - w) / 2, (H - h) / 2, w, h);
}

/** A dark wash from `from` to `to` (fractions of the height), `alpha` at its dark end. */
function scrim(g: CanvasRenderingContext2D, W: number, H: number, from: number, to: number, alpha: number): void {
  const grad = g.createLinearGradient(0, H * from, 0, H * to);
  const col = (a: number): string => `rgba(4,6,12,${a.toFixed(3)})`;
  // Eased, so the wash has no visible edge where it starts.
  for (let i = 0; i <= 8; i++) {
    const k = i / 8;
    grad.addColorStop(k, col(alpha * k * k * (3 - 2 * k)));
  }
  g.fillStyle = grad;
  const y0 = Math.min(from, to) * H;
  g.fillRect(0, y0, W, Math.abs(to - from) * H);
  if (to > from) g.fillRect(0, to * H, W, H - to * H);
  else g.fillRect(0, 0, W, to * H);
}

/**
 * Where the poster's type goes in landscape: a column on the reading side,
 * this share of the width. The tifo has the rest (simulator/film.ts
 * posterHold frames it there).
 */
export const TYPE_COLUMN = 0.35;

/** A dark wash in from the reading side, `alpha` at the edge, gone by `to` of the width. */
function sideScrim(g: CanvasRenderingContext2D, W: number, H: number, rtl: boolean, to: number, alpha: number): void {
  const x0 = rtl ? W : 0;
  const x1 = rtl ? W * (1 - to) : W * to;
  const grad = g.createLinearGradient(x0, 0, x1, 0);
  for (let i = 0; i <= 8; i++) {
    const k = i / 8;
    const e = 1 - k;
    grad.addColorStop(k, `rgba(4,6,12,${(alpha * e * e * (3 - 2 * e)).toFixed(3)})`);
  }
  g.fillStyle = grad;
  g.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H);
}

/** Lines set from the reading side, the last one's ink ending just above `bottom`; returns the top of the first's ink, less `gap`. */
function stackStart(g: CanvasRenderingContext2D, lines: string[], x: number, bottom: number, st: TextStyle, rtl: boolean, gap: number): number {
  let y = bottom;
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = ink(g, lines[i], st);
    const base = y - k.down;
    line(g, lines[i], x, base, st, 'start', rtl);
    y = base - k.up - gap;
  }
  return y;
}

/** The crest, `h` tall, its middle-top at (cx, y) or its start edge at x for 'start'. Returns its width. */
function crest(g: CanvasRenderingContext2D, logo: PosterSpec['logo'], x: number, y: number, h: number, align: Align, rtl: boolean): number {
  if (!logo || !logo.width || !logo.height) return 0;
  const w = (logo.width / logo.height) * h;
  const left = align === 'center' ? x - w / 2 : (align === 'start') !== rtl ? x : x - w;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = h * 0.08;
  g.shadowOffsetY = h * 0.02;
  g.drawImage(logo, left, y, w, h);
  g.restore();
  return w;
}

/** The information line: what is filled in of the date, the kick-off and the ground. */
function infoOf(spec: PosterSpec): string[] {
  return [spec.date, spec.time, spec.venue].map((s) => s.trim()).filter(Boolean);
}

/** The fan's credit line, small, in the corner the type is not in. */
function credit(g: CanvasRenderingContext2D, W: number, spec: PosterSpec, u: number): void {
  if (!spec.creditLine) return;
  // At the top, on the side the poster's own type does not start from.
  line(g, spec.creditLine, spec.rtl ? u * 4 : W - u * 4, u * 6, { family: spec.text, size: u * 2.2, colour: 'rgba(255,255,255,0.86)', shadow: u * 0.6 }, 'start', !spec.rtl);
}

// --------------------------------------------------------------- layouts ---

function matchdayLandscape(g: CanvasRenderingContext2D, W: number, H: number, spec: PosterSpec, c: PosterColours): void {
  const u = H / 100;
  const m = u * 5.5;
  const rtl = spec.rtl;
  const sx = rtl ? W - m : m;
  // The type's column on the reading side; the tifo fills the rest.
  const col = W * TYPE_COLUMN - m;
  sideScrim(g, W, H, rtl, TYPE_COLUMN + 0.16, 0.9);
  // The crest and "MATCHDAY", top and on the reading side.
  const ch = u * 11;
  const cw = crest(g, spec.logo, sx, m, ch, 'start', rtl);
  const ex = sx + (rtl ? -1 : 1) * (cw ? cw + u * 2.4 : 0);
  const eyebrow = caps(spec.labels.matchday);
  const es = Math.min(u * 4.4, fit(g, eyebrow, { family: spec.display, colour: '#fff', tracking: 0.14 }, col - (cw ? cw + u * 2.4 : 0), u * 4.4, u * 2.6));
  const eyeW = line(g, eyebrow, ex, m + ch / 2 + es * 0.36, { family: spec.display, size: es, colour: '#ffffff', tracking: 0.14, shadow: u }, 'start', rtl);
  g.fillStyle = c.ink;
  g.fillRect(rtl ? ex - Math.min(eyeW, u * 12) : ex, m + ch / 2 + es * 0.36 + u * 1.6, Math.min(eyeW, u * 12), u * 0.6);

  // From the bottom up: the band (the date and kick-off over the ground), "VS" and the opponent, the club.
  let y = H - m;
  const rows = [[spec.date, spec.time].map((x) => x.trim()).filter(Boolean).join('   ·   '), spec.venue.trim()].filter(Boolean);
  if (rows.length) {
    const st = { family: spec.text, colour: c.onBand };
    const size = Math.min(...rows.map((r) => fit(g, r, st, col, u * 4.2, u * 2.4)));
    const lh = size * 1.45;
    const bh = lh * rows.length + size * 0.9;
    const tw = Math.max(...rows.map((r) => measure(g, r, { ...st, size })));
    const bw = m + tw + m * 0.8;
    g.fillStyle = c.band;
    g.fillRect(rtl ? W - bw : 0, y - bh, bw, bh);
    // A thin light edge on top: the band reads as a strip of kit, not a hole, on a dark club colour.
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(rtl ? W - bw : 0, y - bh, bw, Math.max(2, u * 0.18));
    rows.forEach((r, i) => line(g, r, sx, y - bh + size * 0.45 + lh * i + size * 0.95, { ...st, size }, 'start', rtl));
    y -= bh + u * 3.2;
  }
  const opp = spec.opponent.trim();
  const club = spec.club.trim();
  if (opp) {
    const vs = caps(spec.labels.vs);
    const vsSize = u * 5.2;
    const vsStyle = { family: spec.display, size: vsSize, colour: c.ink, tracking: 0.06, shadow: u };
    const vsW = measure(g, vs, vsStyle);
    const ow = wrapFit(g, caps(opp), { family: spec.display, colour: '#fff' }, col - vsW - u * 2.5, u * 9, u * 4.2, 2, u * 6);
    const oppStyle = { family: spec.display, size: ow.size, colour: '#ffffff', shadow: u * 1.2 };
    const a = ink(g, vs, vsStyle);
    const last = ow.lines[ow.lines.length - 1];
    const b = ink(g, last, oppStyle);
    const base = y - Math.max(a.down, b.down);
    line(g, vs, sx, base, vsStyle, 'start', rtl);
    const ox = sx + (rtl ? -1 : 1) * (vsW + u * 2.5);
    y = stackStart(g, ow.lines, ox, base + b.down, oppStyle, rtl, ow.size * 0.12) - u * 1.4;
    y = Math.min(y, base - a.up - u * 2);
  }
  if (club) {
    const cw2 = wrapFit(g, caps(club), { family: spec.display, colour: '#fff' }, col, opp ? u * 15 : u * 18, u * 6.5, 2, u * 10);
    stackStart(g, cw2.lines, sx, y, { family: spec.display, size: cw2.size, colour: '#ffffff', shadow: u * 1.6 }, rtl, cw2.size * 0.1);
  }
}

function matchdayPortrait(g: CanvasRenderingContext2D, W: number, H: number, spec: PosterSpec, c: PosterColours): void {
  const u = W / 100;
  const m = u * 7;
  const cx = W / 2;
  scrim(g, W, H, 0.24, 0, 0.7);
  scrim(g, W, H, 0.6, 1, 0.92);
  let top = m;
  const ch = u * 17;
  if (crest(g, spec.logo, cx, top, ch, 'center', spec.rtl)) top += ch + u * 4.5;
  const eyebrow = caps(spec.labels.matchday);
  const es = u * 7;
  const eyeW = line(g, eyebrow, cx, top + es * 0.8, { family: spec.display, size: es, colour: '#ffffff', tracking: 0.16, shadow: u }, 'center', spec.rtl);
  g.fillStyle = c.ink;
  g.fillRect(cx - Math.min(eyeW, u * 18) / 2, top + es * 0.8 + u * 2.4, Math.min(eyeW, u * 18), u * 0.8);

  // From the bottom up.
  let y = H - m;
  const info = infoOf(spec);
  if (info.length) {
    // The band across the whole width, the information on it in one or two lines.
    const first = [spec.date, spec.time].map((s) => s.trim()).filter(Boolean).join('   ·   ');
    const venue = spec.venue.trim();
    const rows = [first, venue].filter(Boolean);
    const sizes = rows.map((r) => fit(g, r, { family: spec.text, colour: c.onBand }, W - m * 2, u * 6, u * 3.6));
    const size = Math.min(...sizes);
    const bh = size * (rows.length === 2 ? 3.3 : 2) + u * 1.5;
    g.fillStyle = c.band;
    g.fillRect(0, H - bh, W, bh);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, H - bh, W, Math.max(2, u * 0.25));
    rows.forEach((r, i) => {
      const yy = H - bh + (rows.length === 2 ? size * (1.3 + i * 1.35) : size * 1.33) + u * 0.75;
      line(g, r, cx, yy, { family: spec.text, size, colour: c.onBand }, 'center', spec.rtl);
    });
    y = H - bh - u * 6;
  }
  const opp = spec.opponent.trim();
  const club = spec.club.trim();
  if (opp) {
    const os = fit(g, caps(opp), { family: spec.display, colour: '#fff' }, W - m * 2, u * 13, u * 7);
    y = stack(g, caps(opp), cx, y, { family: spec.display, size: os, colour: '#ffffff', shadow: u * 1.4 }, spec.rtl, u * 2.2);
    y = stack(g, caps(spec.labels.vs), cx, y, { family: spec.display, size: u * 6.5, colour: c.ink, tracking: 0.08, shadow: u }, spec.rtl, u * 2.2);
  }
  if (club) {
    const cs = fit(g, caps(club), { family: spec.display, colour: '#fff' }, W - m * 2, opp ? u * 16 : u * 19, u * 8);
    stack(g, caps(club), cx, y, { family: spec.display, size: cs, colour: '#ffffff', shadow: u * 1.8 }, spec.rtl, 0);
  }
}

function chant(g: CanvasRenderingContext2D, W: number, H: number, spec: PosterSpec, c: PosterColours, portrait: boolean): void {
  const u = Math.min(W, H) / 100;
  const m = u * (portrait ? 7 : 5.5);
  const text = caps(spec.headline.trim() || spec.club.trim());
  // Portrait: the pitch under the tifo, a deeper wash, the words over it.
  // Landscape: the words in the column on the reading side, the tifo beside them.
  const cx = portrait ? W / 2 : spec.rtl ? W - (W * TYPE_COLUMN) / 2 - m / 2 : (W * TYPE_COLUMN) / 2 + m / 2;
  const colW = portrait ? W - m * 2 : W * TYPE_COLUMN - m;
  if (portrait) {
    scrim(g, W, H, 0.55, 1, 0.9);
    scrim(g, W, H, 0.2, 0, 0.6);
  } else sideScrim(g, W, H, spec.rtl, TYPE_COLUMN + 0.16, 0.9);
  // The club, small, with its crest, at the foot.
  const foot = [spec.club.trim() && caps(spec.club.trim()), spec.date.trim()].filter(Boolean).join('   ·   ');
  let y = H - m;
  if (foot || spec.logo) {
    const fs = fit(g, foot || ' ', { family: spec.text, colour: '#fff', tracking: 0.06 }, portrait ? W * 0.7 : colW, u * (portrait ? 4.4 : 3.6), u * 2.2);
    const lh = fs * 1.6;
    const fw = foot ? measure(g, foot, { family: spec.text, size: fs, colour: '#fff', tracking: 0.06 }) : 0;
    const crestW = spec.logo ? (spec.logo.width / spec.logo.height) * lh : 0;
    const gap = crestW && fw ? u * 1.6 : 0;
    const total = crestW + gap + fw;
    // The crest leads on the reading side, then the words.
    const left = cx - total / 2;
    if (crestW) crest(g, spec.logo, spec.rtl ? left + fw + gap : left, y - lh * 0.86, lh, 'start', false);
    if (foot) line(g, foot, spec.rtl ? left + fw : left + crestW + gap, y - lh * 0.86 + lh / 2 + fs * 0.36, { family: spec.text, size: fs, colour: 'rgba(255,255,255,0.92)', tracking: 0.06 }, 'start', spec.rtl);
    y -= lh + u * 3.4;
    g.fillStyle = c.ink;
    g.fillRect(cx - u * 6, y, u * 12, u * (portrait ? 0.7 : 0.55));
    y -= u * 3.6;
  }
  if (!text) return;
  const { lines, size } = wrapFit(g, text, { family: spec.display, colour: '#fff' }, colW, u * (portrait ? 17 : 16), u * 6, portrait ? 3 : 4, u * (portrait ? 11 : 10));
  for (let i = lines.length - 1; i >= 0; i--) {
    y = stack(g, lines[i], cx, y, { family: spec.display, size, colour: '#ffffff', shadow: u * 2 }, spec.rtl, size * 0.14);
  }
}

function minimal(g: CanvasRenderingContext2D, W: number, H: number, spec: PosterSpec, c: PosterColours, portrait: boolean): void {
  const u = Math.min(W, H) / 100;
  const m = u * (portrait ? 7 : 5);
  const club = caps(spec.club.trim());
  scrim(g, W, H, portrait ? 0.8 : 0.72, 1, 0.66);
  if (!portrait) sideScrim(g, W, H, spec.rtl, TYPE_COLUMN, 0.45);
  const size = fit(g, club || ' ', { family: spec.display, colour: '#fff', tracking: 0.04 }, W * 0.5, u * (portrait ? 5.2 : 4.4), u * 2.8);
  const ch = size * 1.5;
  const align: Align = portrait ? 'center' : 'start';
  const x = portrait ? W / 2 : spec.rtl ? W - m : m;
  const y = H - m;
  if (portrait) {
    const cw = spec.logo ? (spec.logo.width / spec.logo.height) * ch : 0;
    const tw = club ? measure(g, club, { family: spec.display, size, colour: '#fff', tracking: 0.04 }) : 0;
    const gap = cw && tw ? u * 2 : 0;
    const left = W / 2 - (cw + gap + tw) / 2;
    if (cw) crest(g, spec.logo, spec.rtl ? left + tw + gap : left, y - ch, ch, 'start', false);
    if (club) line(g, club, spec.rtl ? left + tw : left + cw + gap, y - ch / 2 + size * 0.36, { family: spec.display, size, colour: '#ffffff', tracking: 0.04, shadow: u }, 'start', spec.rtl);
  } else {
    const cw = crest(g, spec.logo, x, y - ch, ch, align, spec.rtl);
    const tx = x + (spec.rtl ? -1 : 1) * (cw ? cw + u * 1.8 : 0);
    if (club) {
      const w = line(g, club, tx, y - ch / 2 + size * 0.36, { family: spec.display, size, colour: '#ffffff', tracking: 0.04, shadow: u }, 'start', spec.rtl);
      // A hairline of the club's colour under the name.
      g.fillStyle = c.ink;
      g.fillRect(spec.rtl ? tx - w : tx, y - ch / 2 + size * 0.36 + u * 1.1, Math.min(w, u * 10), Math.max(2, u * 0.35));
    }
  }
}

/** Draw the poster at W × H onto `g`, over `bg` (the tifo's Match Day picture). */
export function drawPoster(g: CanvasRenderingContext2D, W: number, H: number, bg: CanvasImageSource & { width: number; height: number }, spec: PosterSpec): void {
  g.save();
  g.clearRect(0, 0, W, H);
  background(g, W, H, bg);
  const c = posterColours(spec.colours);
  const portrait = H > W;
  if (spec.layout === 'matchday') (portrait ? matchdayPortrait : matchdayLandscape)(g, W, H, spec, c);
  else if (spec.layout === 'chant') chant(g, W, H, spec, c, portrait);
  else minimal(g, W, H, spec, c, portrait);
  credit(g, W, spec, Math.min(W, H) / 100);
  g.restore();
}
