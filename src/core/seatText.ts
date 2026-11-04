/**
 * Seat-aware lettering for the Pro voices (core/proVoices).
 *
 * A seat is a pixel, and a stand has the rows it has. A display face drawn at
 * 128 px is a promise the seat grid cannot always keep: a hairline a twentieth
 * of the letter's height is under a seat at 18 rows, and the thin half of a
 * stroke is the first to go when one card in ten is not held up
 * (core/analysis). So a Pro voice is drawn onto seats with every stroke at
 * least MIN_STROKE_ACROSS seats across and MIN_STROKE_UP rows up:
 *
 *   - the words are drawn on a fine grid, 4 pixels a seat across and 6 a row
 *     up, on which 3 seats across and 2 rows up are both 12 pixels;
 *   - every stroke thinner than that is drawn again along its own spine at
 *     that width (never more than MAX_GROW_ROWS wider a side), and
 *     strokes that already read are left exactly as the face drew them
 *     (`thickenThin`). A uniform outline would bloat the heavy strokes, and
 *     those are the face's character;
 *   - every opening the face had at seat scale is kept open: a counter, the
 *     gap between two letters, the space under an Arabic dot (`keepOpenings`).
 *     Thickening welds counters long before it rescues hairlines; this is the
 *     half that stops it.
 *
 * Each voice also carries the letter height it was measured to need on real
 * stands of 12 to 62 rows (scripts/pro-font-seats.mts; docs/pro-quality/fonts.md
 * has the tables): `reads`, from which it reads as drawn, and `min`, from
 * which it reads seat-aware. `seatVerdict` is what the font picker's seat
 * preview says with them: the face reads, reads because it was thickened,
 * needs taller letters, or cannot read on a stand this shallow at any size,
 * and which face to try instead.
 *
 * DOM-free, except `seatTextAlpha` and `drawSeatAlpha` (they draw with a
 * canvas). Node imports the rest (tests, the measuring script).
 */
import { renderTextCanvas } from './text';

export type SeatScript = 'ar' | 'lat';

export interface SeatFloor {
  /** Rows of letter height from which the face reads as it is drawn. */
  reads: number;
  /** Rows of letter height from which it reads drawn seat-aware; below it, it does not. */
  min: number;
}

/**
 * Measured on seats, per voice and script (scripts/pro-font-seats.mts, three
 * words a script, letters 6 to 44 rows): the smallest letter height from
 * which it reads, with the next two heights up. Reads: no dot or mark lost,
 * no letter broken in two, no more than a third of its pieces welded to
 * another, and at most a tenth of its seats in strokes thinner than the
 * minimum. `reads` is as the face is drawn, `min` drawn seat-aware. Never
 * under 8 rows for Latin or 12 for Arabic, the floors the AI designer was
 * measured to need by eye (core/specFit). Gothic's Arabic welds its dots at
 * every size, so its floors are where it read by eye on the specimen sheets;
 * the banners-only voices (Classic, Ruqaa) passed the numbers at lower
 * heights than they read by eye, and their floors are the eye's.
 */
export const SEAT_FLOORS: Readonly<Record<string, Readonly<Record<SeatScript, SeatFloor>>>> = {
  block: { ar: { reads: 15, min: 15 }, lat: { reads: 8, min: 8 } },
  stencil: { ar: { reads: 20, min: 18 }, lat: { reads: 11, min: 10 } },
  rounded: { ar: { reads: 15, min: 15 }, lat: { reads: 9, min: 8 } },
  pixel: { ar: { reads: 12, min: 12 }, lat: { reads: 8, min: 8 } },
  gothic: { ar: { reads: 26, min: 24 }, lat: { reads: 15, min: 12 } },
  heritage: { ar: { reads: 18, min: 16 }, lat: { reads: 20, min: 12 } },
  marker: { ar: { reads: 15, min: 15 }, lat: { reads: 9, min: 8 } },
  classic: { ar: { reads: 44, min: 30 }, lat: { reads: 44, min: 11 } },
  ruqaa: { ar: { reads: 44, min: 28 }, lat: { reads: 20, min: 12 } },
};

/**
 * The thinnest a stroke may be on seats: 3 seats across, 2 rows up. A seat is
 * 3.2 units wide and a row 8 deep, so the two are about the same width on the
 * stand; one card in ten not held up never cuts a stroke that thick.
 */
export const MIN_STROKE_ACROSS = 3;
export const MIN_STROKE_UP = 2;
/** At most this much is added to a side of a thin stroke, in rows (and the same width across). */
export const MAX_GROW_ROWS = 0.75;
/**
 * Pixels a seat across and a row up while strokes are measured: chosen so the
 * minimum stroke is as many pixels both ways (3 x 4 = 2 x 6), and a round
 * pen on these pixels draws the stroke the seats need.
 */
const SSX = 4;
const SSY = 6;
/** The pen's width in pixels: MIN_STROKE_ACROSS * SSX, which is MIN_STROKE_UP * SSY. */
const PEN = MIN_STROKE_ACROSS * SSX;

/** The smallest opening kept open across (seats) and up (rows). */
export const OPEN_ACROSS = 2;
export const OPEN_UP = 1;
/** A seat under this coverage (of 255) was background in the face as drawn, not a thin stroke. */
const CLEAR = 40;

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-z0-9À-ɏ]/;

/** The scripts a string is written in (digits count as Latin). */
export function scriptsOf(text: string): SeatScript[] {
  const out: SeatScript[] = [];
  if (ARABIC.test(text)) out.push('ar');
  if (LATIN.test(text) || !out.length) out.push('lat');
  return out;
}

/** The floor a voice's words must clear: the stricter script's, for mixed words. Null for a face nobody measured. */
export function seatFloor(fontId: string, text: string): SeatFloor | null {
  const f = SEAT_FLOORS[fontId];
  if (!f) return null;
  let out: SeatFloor | null = null;
  for (const s of scriptsOf(text)) {
    const x = f[s];
    out = out ? { reads: Math.max(out.reads, x.reads), min: Math.max(out.min, x.min) } : { ...x };
  }
  return out;
}

/**
 * The 3-4 chamfer distance (in thirds of a pixel) from every pixel where
 * `inside` is 1 to the nearest pixel where it is 0; 0 outside. The edge of
 * the picture counts as outside.
 */
function chamfer(inside: Uint8Array, w: number, h: number): Int32Array {
  const BIG = 1 << 20;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? BIG : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      v = Math.min(v, x > 0 ? d[i - 1] + 3 : 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      } else v = Math.min(v, 3);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      v = Math.min(v, x < w - 1 ? d[i + 1] + 3 : 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      } else v = Math.min(v, 3);
      d[i] = v;
    }
  }
  return d;
}

/**
 * Strokes under `target` pixels drawn again along their spine at `target`
 * wide, at most `cap` pixels wider a side (DOM-free). `ink` is 0/1 over w x h
 * pixels.
 *
 * The thick strokes are the ink a disc `target` wide can roll through (an
 * opening); the rest are thin. A spine pixel of a thin stroke (where its
 * distance to the edge peaks) stamps a disc as wide as the stroke should be.
 * Spine pixels next to a thick stroke are left out: there the "thin" ink is
 * only the corner of a thick one the disc could not reach, and stamping it
 * would round every corner outwards. The thin stroke's own discs still reach
 * back over that margin, so a hairline stays joined to its stem.
 */
export function thickenThin(ink: Uint8Array, w: number, h: number, target: number, cap: number): Uint8Array {
  const n = w * h;
  const half = target / 2;
  const d = chamfer(ink, w, h);
  // The opening: the pixels deeper than half the target, grown back by as much.
  const notCore = new Uint8Array(n);
  for (let i = 0; i < n; i++) notCore[i] = d[i] / 3 > half ? 0 : 1;
  const toCore = chamfer(notCore, w, h);
  const thick = new Uint8Array(n);
  for (let i = 0; i < n; i++) thick[i] = ink[i] && toCore[i] / 3 <= half ? 1 : 0;
  const notThick = new Uint8Array(n);
  for (let i = 0; i < n; i++) notThick[i] = thick[i] ? 0 : 1;
  const toThick = chamfer(notThick, w, h);
  const margin = Math.max(1.5, half * 0.45);
  const out = Uint8Array.from(ink);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const di = d[i];
      if (!di || thick[i] || toThick[i] / 3 <= margin) continue;
      // A spine pixel: no 4-neighbour is further from the edge.
      if ((x > 0 && d[i - 1] > di) || (x < w - 1 && d[i + 1] > di) || (y > 0 && d[i - w] > di) || (y < h - 1 && d[i + w] > di)) continue;
      const r = Math.min(half, di / 3 + cap);
      const rr = r * r;
      const ri = Math.ceil(r);
      for (let dy = -ri; dy <= ri; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -ri; dx <= ri; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || dx * dx + dy * dy > rr) continue;
          out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * Keep the openings a face had at seat scale (DOM-free).
 *
 * `base` and `fat` are coverage (0..255) over the same `cols` x `rows` seats:
 * the words as drawn and as thickened. A run of seats that were clear in
 * `base`, with letter on both ends of it (across, or up), is an opening: a
 * counter, the gap between two letters, the space between a dot and its
 * letter. The thickened strokes may eat into it from both ends, but its
 * middle `open` seats stay clear (all of it, when it was narrower than that
 * to begin with). Returns 1 for a seat in the letters, 0 for none.
 */
export function keepOpenings(
  base: ArrayLike<number>,
  fat: ArrayLike<number>,
  cols: number,
  rows: number,
  openAcross = OPEN_ACROSS,
  openUp = OPEN_UP,
): Uint8Array {
  const n = cols * rows;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = fat[i] >= 128 || base[i] >= 128 ? 1 : 0;
  const keep = (start: number, len: number, step: number, open: number): void => {
    const eat = Math.max(0, Math.floor((len - open) / 2));
    for (let k = eat; k < len - eat; k++) out[start + k * step] = 0;
  };
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      if (base[y * cols + x] >= CLEAR) { x++; continue; }
      const x0 = x;
      while (x < cols && base[y * cols + x] < CLEAR) x++;
      // Bounded on both sides: letter to the left and to the right of it.
      if (x0 > 0 && x < cols) keep(y * cols + x0, x - x0, 1, openAcross);
    }
  }
  for (let x = 0; x < cols; x++) {
    let y = 0;
    while (y < rows) {
      if (base[y * cols + x] >= CLEAR) { y++; continue; }
      const y0 = y;
      while (y < rows && base[y * cols + x] < CLEAR) y++;
      if (y0 > 0 && y < rows) keep(y0 * cols + x, y - y0, cols, openUp);
    }
  }
  return out;
}

/** Each seat's share of its SSX x SSY block of pixels that are 1, as 0..255. */
function seatCoverage(px: Uint8Array, cols: number, rows: number): Uint8Array {
  const w = cols * SSX;
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let y = 0; y < SSY; y++) {
        const o = (r * SSY + y) * w + c * SSX;
        for (let x = 0; x < SSX; x++) s += px[o + x];
      }
      out[r * cols + c] = Math.round((s * 255) / (SSX * SSY));
    }
  }
  return out;
}

/**
 * A Pro voice's words as seats: 1 for a seat in the letters, over `cols` x
 * `rows` seats laid on the canvas `renderTextCanvas` draws (the layer's own
 * frame), every stroke at least the minimum thick and every opening kept.
 * Null for no words. Browser only.
 */
export function seatTextAlpha(text: string, fontCss: string, arcDeg: number, cols: number, rows: number): Uint8Array | null {
  return drawSeatAlpha(text, fontCss, arcDeg, cols, rows, MAX_GROW_ROWS);
}

/** seatTextAlpha with the growth cap given (rows a side; 0 draws the face as it is): the measuring script's way in. */
export function drawSeatAlpha(text: string, fontCss: string, arcDeg: number, cols: number, rows: number, grow: number): Uint8Array | null {
  const base = renderTextCanvas(text, fontCss, arcDeg, 0);
  if (!base || cols < 1 || rows < 1) return null;
  const w = cols * SSX;
  const h = rows * SSY;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(base.canvas, 0, 0, w, h);
  const a = g.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = a[i * 4 + 3] >= 128 ? 1 : 0;
  const plain = seatCoverage(ink, cols, rows);
  if (!(grow > 0)) {
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < out.length; i++) out[i] = plain[i] >= 128 ? 1 : 0;
    return out;
  }
  const fat = seatCoverage(thickenThin(ink, w, h, PEN, grow * SSY), cols, rows);
  return keepOpenings(plain, fat, cols, rows);
}

export type SeatVerdictState = 'reads' | 'thickened' | 'small' | 'shallow' | 'banner';

export interface SeatVerdict {
  state: SeatVerdictState;
  /** The letter height the words need, in rows (their floor's `min`). */
  needRows: number;
  /** The voice to try instead ('small', 'shallow', 'banner'): the one that reads smallest. */
  tryFont: string | null;
}

/**
 * What the seat preview says about words `glyphRows` tall in `fontId`, on a
 * stand `standRows` deep (0 when not known): they read as drawn; they read
 * because they were drawn seat-aware; they need to be taller (`needRows`);
 * the stand is too shallow for this face at any size; or the face is for
 * banners only (`seats` false). `tryFont` is the candidate that reads
 * smallest, when it reads smaller than this one. Null for a face with no
 * measured floor (the free voices).
 */
export function seatVerdict(
  fontId: string,
  text: string,
  glyphRows: number,
  standRows = 0,
  candidates: readonly string[] = Object.keys(SEAT_FLOORS),
  seats = true,
): SeatVerdict | null {
  const f = seatFloor(fontId, text);
  if (!f) return null;
  const needRows = f.min;
  const best = (): string | null => {
    let id: string | null = null;
    let low = Infinity;
    for (const c of candidates) {
      if (c === fontId) continue;
      const cf = seatFloor(c, text);
      if (cf && cf.min < low) { low = cf.min; id = c; }
    }
    return id !== null && (!seats || low < needRows) ? id : null;
  };
  if (!seats) return { state: 'banner', needRows, tryFont: best() };
  if (glyphRows >= f.reads) return { state: 'reads', needRows, tryFont: null };
  if (glyphRows >= f.min) return { state: 'thickened', needRows, tryFont: null };
  if (standRows > 0 && standRows < needRows + 1) return { state: 'shallow', needRows, tryFont: best() };
  return { state: 'small', needRows, tryFont: best() };
}
