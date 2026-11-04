/**
 * Portrait styles (Pro): a face or a player photo as a stencil, a duotone in
 * the club's colour, a 2- or 3-colour poster, or pop art, in the design's own
 * colours. And the same machinery for every AI picture (posterizeByRank).
 *
 * Pure and DOM-free, like quantizePixels: RGBA pixels at the picture's grid
 * resolution (one cell per seat, see objects.ts gridSize) and the palette in,
 * palette indices out (-1 where the picture is transparent). ensureGrid
 * (core/objects.ts) calls it for a picture whose layer carries a style;
 * scripts/verify-portrait.mts checks it in Node and draws the contact sheets.
 *
 * What it is built for is the stand, not the screen. A portrait is 20 to 60
 * rows tall, every seat is one card held up by one fan, and about one seat in
 * ten is empty on the day. So every style runs the same pipeline:
 *
 *  1. TONE: the picture's lightness, stretched to its own range, smoothed
 *     with an edge-preserving filter (finely over the face, coarsely over the
 *     hair and the clothes, so texture goes and the planes of light stay),
 *     balanced so the face sits a little on the light side, and given local
 *     contrast at the face's scale. (CLAHE, tried first, amplified wrinkles
 *     and a shirt's print into blobs at seat scale; see docs/pro-quality/images.md.)
 *  2. FEATURES: with the face's landmarks (portraitPipeline.ts), the eye
 *     sockets and brows, the shadow under the nose, the mouth and the line
 *     under the jaw are pushed dark, each drawn at least three seats by three
 *     rows: they are what a face is read by from the far side of a ground, and
 *     at seat scale they are a few cards each;
 *  3. BANDS: two to four tones, cut where the picture's own histogram splits
 *     best (Otsu);
 *  4. CLEAN-UP at seat scale: every tone's area is opened and closed with a
 *     three-by-three window, so no blob, line or speck under three seats is
 *     left, then any card still in a run of fewer than three, across or down,
 *     takes its neighbours' card (the rule core/analysis.ts checks the bowl
 *     by), and patches too small for a crowd go into what surrounds them;
 *  5. COLOUR: the tones are given palette cards ordered by lightness, so they
 *     keep their order whatever the club's colours are, and degrade to fewer
 *     tones (never to colours a stand cannot tell apart) when the palette is
 *     short. It never changes the palette, and slot 0 (the empty seat) is
 *     never a target.
 *
 *   stencil   two tones, ink and paper: the darkest and the lightest card;
 *   duotone   the club's colour as the middle tone, its darker shade (or the
 *             ink) under it and the paper over it: a face in one colour;
 *   poster2   two (poster3: three) tone bands in the club's colours: the cards
 *             with the most colour in them that still step clearly apart in
 *             lightness, in order of lightness (the "Hope" poster);
 *   pop       the subject posterised into ink and two bright colours, on a
 *             flat field of another bold colour from the palette (the cut-out
 *             is what tells the subject from the field).
 *
 * Halftone was a style until 1 Nov 2026. A dot screen cannot read at seat
 * scale (the seats are already the dots: a dot of three seats leaves a face
 * about ten dots tall), so it is gone; a design saved with it is drawn as a
 * stencil (portraitStyleOf).
 *
 * A cell's shape matters: `aspect` is a cell's width over its height as the
 * stand shows it, so blurs are round and the clean-up fair.
 */
import type { FaceInfo } from './portraitPipeline';
import { guidedFilter } from './matte';

export const PORTRAIT_STYLES = ['stencil', 'duotone', 'poster2', 'poster3', 'pop', 'painted'] as const;
export type PortraitStyle = (typeof PORTRAIT_STYLES)[number];

/**
 * The styles offered for seats, each a different LOOK rather than the same
 * look in other colours: a two-tone stencil with a hard dark outline, a
 * three-tone "Hope" poster on a split field with its darkest tone as the
 * outline, a soft duotone in two club colours, and pop art on a flat field.
 * Poster 2 was a stencil in other colours; it still draws for designs that
 * saved it, but is not offered. Painted has more tones than seats can hold,
 * so it is offered on banners only.
 */
export const SEAT_STYLES: readonly PortraitStyle[] = ['stencil', 'poster3', 'duotone', 'pop'];
export const BANNER_STYLES: readonly PortraitStyle[] = ['stencil', 'poster3', 'duotone', 'pop', 'painted'];

export function isPortraitStyle(v: unknown): v is PortraitStyle {
  return typeof v === 'string' && (PORTRAIT_STYLES as readonly string[]).includes(v);
}

/** A style as saved, read by this version: a known one, a retired one's successor, or nothing. */
export function portraitStyleOf(v: unknown): PortraitStyle | undefined {
  if (isPortraitStyle(v)) return v;
  return v === 'halftone' ? 'stencil' : undefined;
}

export interface PortraitOptions {
  /** Pixels with alpha below this are transparent (-1): the layers beneath keep their cards. */
  alphaThreshold: number;
  /** A cell's width over its height as the stand shows it (1 = square cells). */
  aspect?: number;
  /** The face in the picture (0..1 of its width and height), when one was found. */
  face?: FaceInfo | null;
  /**
   * The card the picture lands on (the design beneath it), left out of its
   * tones when the palette has others to give, so no tone melts into the
   * ground around it. -1 or absent: nothing to avoid.
   */
  under?: number;
}

/** The swatches without the card beneath, when that leaves at least `need` of them. */
function avoiding(sw: Swatch[], under: number | undefined, need: number): Swatch[] {
  if (under === undefined || under < 0) return sw;
  const rest = sw.filter((s) => s.idx !== under);
  return rest.length >= need ? rest : sw;
}

// ---------------------------------------------------------------- colour ---

interface Swatch {
  idx: number;
  /** CIE L*, 0..100. */
  L: number;
  a: number;
  b: number;
  /** CIE chroma: how far from grey. */
  C: number;
}

/** sRGB 0..255 to linear light, once per level. */
const LINEAR = Float64Array.from({ length: 256 }, (_, c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LINEAR[r & 255];
  const G = LINEAR[g & 255];
  const B = LINEAR[b & 255];
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The palette's cards (slot 0, the empty seat, is never one), each colour once. */
function swatchesOf(palette: readonly string[]): Swatch[] {
  const out: Swatch[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < palette.length; i++) {
    let hex = String(palette[i] ?? '').trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(hex)) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    if (!/^#[0-9a-f]{6}$/.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    const v = parseInt(hex.slice(1), 16);
    const [L, a, b] = srgbToLab((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    out.push({ idx: i, L, a, b, C: Math.hypot(a, b) });
  }
  return out;
}

/** Two cards a stand can tell apart: different enough in lightness, or clearly different in hue. */
function distinct(p: Swatch, q: Swatch): boolean {
  return Math.abs(p.L - q.L) >= 12 || Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b) >= 45;
}

/** Saturated enough to count as a colour rather than a black, a white or a grey. */
const SATURATED = 25;

/** Every way of choosing k of n, in order (n is kept small by the callers). */
function* combos(n: number, k: number): Generator<number[]> {
  if (k <= 0 || k > n) return;
  const c = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield c.slice();
    let i = k - 1;
    while (i >= 0 && c[i] === n - k + i) i--;
    if (i < 0) return;
    c[i]++;
    for (let j = i + 1; j < k; j++) c[j] = c[j - 1] + 1;
  }
}

/** At most `max` swatches: the extremes of lightness first, then the most colourful. Keeps the searches small. */
function shortlist(sw: Swatch[], max: number): Swatch[] {
  if (sw.length <= max) return sw.slice();
  const byL = [...sw].sort((p, q) => p.L - q.L);
  const keep = new Set<Swatch>([byL[0], byL[byL.length - 1]]);
  for (const s of [...sw].sort((p, q) => q.C - p.C || p.idx - q.idx)) {
    if (keep.size >= max) break;
    keep.add(s);
  }
  return [...keep];
}

const byLightness = (p: Swatch, q: Swatch): number => p.L - q.L || p.idx - q.idx;

/** The ink and the paper: the darkest and the lightest card. */
function inkAndPaper(sw: Swatch[]): Swatch[] {
  if (sw.length <= 1) return sw.slice();
  const byL = [...sw].sort(byLightness);
  return [byL[0], byL[byL.length - 1]];
}

/**
 * Pop art's colours, darkest first: the darkest card as the ink; on top, a
 * light saturated colour if the palette has one (the lit side of a face in
 * gold rather than white, the way pop art paints skin), else the lightest
 * card; between them, the most saturated card that stands apart from both.
 */
function popColours(sw: Swatch[]): Swatch[] {
  const byL = [...sw].sort(byLightness);
  if (byL.length <= 2) return byL;
  const ink = byL[0];
  const lightSat = byL.filter((s) => s !== ink && s.L >= 60 && s.C >= SATURATED && distinct(s, ink));
  const top = lightSat.length ? lightSat.reduce((p, q) => (q.C > p.C ? q : p)) : byL[byL.length - 1];
  if (!distinct(top, ink)) return [ink];
  let mid: Swatch | null = null;
  for (const s of byL) {
    if (s === ink || s === top || s.C < SATURATED || s.L <= ink.L || s.L >= top.L) continue;
    if (!distinct(s, ink) || !distinct(s, top)) continue;
    if (!mid || s.C > mid.C) mid = s;
  }
  return mid ? [ink, mid, top] : [ink, top];
}

/**
 * Pop art's field: the boldest card the subject does not use that a stand
 * can tell from every tone of the subject. Null when the palette has none,
 * and then the subject's middle tone gives up its place in the subject to be
 * the field (popLayout).
 */
function popField(sw: Swatch[], used: Swatch[]): Swatch | null {
  let best: Swatch | null = null;
  for (const s of sw) {
    if (used.includes(s) || !used.every((u) => distinct(s, u))) continue;
    if (!best || s.C > best.C || (s.C === best.C && s.idx < best.idx)) best = s;
  }
  return best;
}

/** Pop art: the subject's tones (darkest first) and the field's card. */
function popLayout(sw: Swatch[]): { tones: Swatch[]; field: Swatch | null } {
  const tones = popColours(sw);
  const field = popField(sw, tones);
  if (field || tones.length < 3) return { tones, field };
  // Three tones and nothing left for the field: the middle colour becomes it.
  return { tones: [tones[0], tones[2]], field: tones[1] };
}

/**
 * A poster's colours, darkest first: the club's colours rather than the ink
 * and paper of a stencil. The k cards (fewer when the palette cannot give k
 * that a stand can tell apart) with the most colour in them and the most
 * lightness between neighbours, so the bands keep their order and still read.
 */
function posterColours(sw: Swatch[], k: number): Swatch[] {
  if (sw.length <= 1) return sw.slice();
  const pool = shortlist(sw, 14).sort(byLightness);
  for (let take = Math.min(k, pool.length); take >= 2; take--) {
    let best: Swatch[] | null = null;
    let bestScore = -Infinity;
    for (const c of combos(pool.length, take)) {
      const pick = c.map((i) => pool[i]);
      let score = 0;
      let ok = true;
      for (let i = 0; i < take; i++) {
        score += 0.5 * pick[i].C;
        if (i === 0) continue;
        if (!distinct(pick[i], pick[i - 1])) {
          ok = false;
          break;
        }
        const step = pick[i].L - pick[i - 1].L;
        score += Math.min(step, 40) - 2 * Math.max(0, 25 - step);
      }
      if (ok && score > bestScore) {
        bestScore = score;
        best = pick;
      }
    }
    if (best) return best;
  }
  return inkAndPaper(sw);
}

/**
 * The duotone's colours, darkest first: the face in ONE club colour, between
 * the ink and the paper. The club's colour is the most saturated card of
 * middle lightness (a dark green, a royal blue, a red); under it the darkest
 * card, over it the lightest, each a clear step away. With only two cards,
 * those two.
 */
function duotoneColours(sw: Swatch[]): Swatch[] {
  const byL = [...sw].sort(byLightness);
  if (byL.length <= 2) return byL;
  // Two club colours, not black and white: the most colourful card, and the
  // colourful card furthest from it in lightness; ink or paper only when the
  // club has one colour, or two of the same lightness.
  const colourful = byL.filter((s) => s.C >= SATURATED);
  const main = colourful.length ? colourful.reduce((p, q) => (q.C > p.C ? q : p)) : byL[Math.floor(byL.length / 2)];
  const far = (pool: Swatch[]): Swatch | undefined =>
    pool.filter((s) => s !== main && Math.abs(s.L - main.L) >= 25).sort((p, q) => Math.abs(q.L - main.L) - Math.abs(p.L - main.L))[0];
  const other = far(colourful) ?? far(byL);
  if (!other) return [byL[0], byL[byL.length - 1]];
  const [lo, hi] = main.L < other.L ? [main, other] : [other, main];
  // A card between them, near the line from one to the other, is a step of the ramp.
  const step = byL.find((s) => {
    if (s === lo || s === hi) return false;
    const t = (s.L - lo.L) / Math.max(1, hi.L - lo.L);
    if (t < 0.25 || t > 0.75) return false;
    const da = s.a - (lo.a + t * (hi.a - lo.a));
    const db = s.b - (lo.b + t * (hi.b - lo.b));
    return Math.hypot(da, db) < 25;
  });
  return step ? [lo, step, hi] : [lo, hi];
}

/**
 * Up to `k` cards for a picture's tone levels, darkest first, spread over
 * the palette's lightness: the darkest and the lightest, and between them the
 * cards that leave the largest steps (the more colourful on a near tie).
 */
function rankColours(sw: Swatch[], k: number): Swatch[] {
  // One card for each lightness a stand can tell apart: the most colourful of near-twins.
  const byL = [...sw].sort(byLightness);
  const levels: Swatch[] = [];
  for (const s of byL) {
    const last = levels[levels.length - 1];
    if (last && Math.abs(s.L - last.L) < 12) {
      if (s.C > last.C) levels[levels.length - 1] = s;
      continue;
    }
    levels.push(s);
  }
  if (levels.length <= k) return levels;
  let best: Swatch[] = [];
  let bestScore = -Infinity;
  const pool = shortlist(levels, 12).sort(byLightness);
  for (const c of combos(pool.length, k)) {
    const pick = c.map((i) => pool[i]);
    let minStep = Infinity;
    let colour = 0;
    for (let i = 0; i < pick.length; i++) {
      colour += pick[i].C;
      if (i) minStep = Math.min(minStep, pick[i].L - pick[i - 1].L);
    }
    const span = pick[pick.length - 1].L - pick[0].L;
    const score = 2 * minStep + span + 0.1 * colour;
    if (score > bestScore) {
      bestScore = score;
      best = pick;
    }
  }
  return best;
}

/**
 * Colours for tones 0..k-1 (darkest first) from an ordered list of cards
 * (darkest first). Fewer cards than tones: neighbouring tones share one. One
 * card only: it takes the tones on its own side of the middle, and the others
 * are left to the layers beneath (-1), so a one-colour stencil is still a
 * stencil rather than a solid block.
 */
function toneColours(k: number, chosen: Swatch[]): number[] {
  if (chosen.length === 0) return new Array<number>(k).fill(-1);
  if (chosen.length === 1) {
    const dark = chosen[0].L < 50;
    return Array.from({ length: k }, (_, t) => ((dark ? t < k / 2 : t >= k / 2) ? chosen[0].idx : -1));
  }
  if (chosen.length >= k) return chosen.slice(0, k).map((s) => s.idx);
  return Array.from({ length: k }, (_, t) => chosen[Math.round((t * (chosen.length - 1)) / (k - 1))].idx);
}

function paint(band: Int16Array, colours: number[]): Int16Array {
  const out = new Int16Array(band.length).fill(-1);
  for (let p = 0; p < band.length; p++) if (band[p] >= 0) out[p] = colours[band[p]] ?? -1;
  return out;
}

// ----------------------------------------------------------------- tone ---

/** The picture as tone: L* in 0..1 for each opaque cell, and which cells are opaque. */
interface Field {
  cols: number;
  rows: number;
  aspect: number;
  /** 1 = opaque (part of the picture), 0 = transparent. */
  mask: Uint8Array;
  /** How many cells are opaque. */
  n: number;
  /** L* / 100 per cell (0 where transparent). */
  L: Float32Array;
  /** The picture's short side, in rows: the yardstick for every size below. */
  span: number;
}

function fieldOf(pixels: Uint8ClampedArray, cols: number, rows: number, opts: PortraitOptions): Field {
  const N = cols * rows;
  const mask = new Uint8Array(N);
  const L = new Float32Array(N);
  let n = 0;
  const thr = Math.max(1, Math.min(255, Math.round(Number(opts.alphaThreshold) || 128)));
  for (let p = 0; p < N; p++) {
    if (pixels[p * 4 + 3] < thr) continue;
    mask[p] = 1;
    L[p] = srgbToLab(pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2])[0] / 100;
    n++;
  }
  const raw = Number(opts.aspect);
  const aspect = Number.isFinite(raw) && raw > 0 ? Math.min(8, Math.max(0.125, raw)) : 1;
  return { cols, rows, aspect, mask, n, L, span: Math.max(2, Math.min(rows, cols * aspect)) };
}

/** Box radius for one of three passes approximating a Gaussian of this sigma (in cells). */
const boxRadius = (sigma: number): number => Math.max(0, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));

/** One box pass along the rows (horizontal) or the columns, of `v` in place; `tmp` is scratch. */
function boxPass(v: Float32Array, tmp: Float32Array, cols: number, rows: number, r: number, horizontal: boolean): void {
  if (r <= 0) return;
  const len = horizontal ? cols : rows;
  const lines = horizontal ? rows : cols;
  const stride = horizontal ? 1 : cols;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * cols : line;
    let sum = 0;
    // Window [i - r, i + r]; cells outside the grid count as 0 (normalised away by the mask).
    for (let i = 0; i <= Math.min(r, len - 1); i++) sum += v[base + i * stride];
    for (let i = 0; i < len; i++) {
      tmp[i] = sum;
      const add = i + r + 1;
      const sub = i - r;
      if (add < len) sum += v[base + add * stride];
      if (sub >= 0) sum -= v[base + sub * stride];
    }
    for (let i = 0; i < len; i++) v[base + i * stride] = tmp[i];
  }
}

/**
 * A Gaussian-like blur of `src` over the opaque cells only (normalised by the
 * mask, so the picture's edge does not darken towards a transparent outside).
 * `sigma` is in rows; across, it is stretched by the cell's shape.
 */
function blur(src: Float32Array, f: Field, sigma: number): Float32Array {
  const { cols, rows, mask } = f;
  const N = cols * rows;
  const ry = boxRadius(sigma);
  const rx = boxRadius(sigma / f.aspect);
  const out = new Float32Array(N);
  if (rx === 0 && ry === 0) {
    out.set(src);
    return out;
  }
  const v = new Float32Array(N);
  const w = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    if (!mask[p]) continue;
    v[p] = src[p];
    w[p] = 1;
  }
  const tmp = new Float32Array(Math.max(cols, rows));
  for (let k = 0; k < 3; k++) {
    boxPass(v, tmp, cols, rows, rx, true);
    boxPass(w, tmp, cols, rows, rx, true);
    boxPass(v, tmp, cols, rows, ry, false);
    boxPass(w, tmp, cols, rows, ry, false);
  }
  for (let p = 0; p < N; p++) out[p] = w[p] > 1e-6 ? v[p] / w[p] : 0.5;
  return out;
}

/** The values at quantiles `qs` of the cells in `m` (values in 0..1). */
function quantilesIn(v: Float32Array, m: Uint8Array, qs: number[]): number[] {
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  let n = 0;
  for (let p = 0; p < v.length; p++) {
    if (!m[p]) continue;
    hist[Math.max(0, Math.min(BINS - 1, Math.floor(v[p] * BINS)))]++;
    n++;
  }
  return qs.map((q) => {
    const want = q * n;
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      acc += hist[i];
      if (acc >= want) return (i + 0.5) / BINS;
    }
    return 1;
  });
}

const quantiles = (v: Float32Array, f: Field, qs: number[]): number[] => quantilesIn(v, f.mask, qs);

/** Stretch the picture's tone to its own range (1st to 99th percentile), so a grey photo still has a black and a white. */
function stretch(v: Float32Array, f: Field): Float32Array {
  const [lo, hi] = quantiles(v, f, [0.01, 0.99]);
  const out = new Float32Array(v.length);
  const k = hi - lo > 0.02 ? 1 / (hi - lo) : 1;
  for (let p = 0; p < v.length; p++) if (f.mask[p]) out[p] = Math.max(0, Math.min(1, (v[p] - lo) * k));
  return out;
}

/**
 * The tone a style starts from, simplified the way a poster artist would:
 *  - stretched to the picture's own range;
 *  - smoothed with an edge-preserving filter (a self-guided filter: flat
 *    areas are averaged, edges kept), finely over the face and coarsely
 *    everywhere else, so wrinkles, stubble and a shirt's print go and the big
 *    planes of light and shadow stay; the face gets the detail, the body is
 *    drawn in a few big shapes;
 *  - balanced so the face's own middle tone sits a little on the light side
 *    (lit skin as paper, shadow as ink, whatever the photo's exposure);
 *  - given a little local contrast at the face's scale, which sets the head
 *    off the hair and the hair off what is behind it.
 * `region` is where the face is (1) and is not (0), soft at its edge: the
 * thresholds are read there, so the face, not the shirt, decides the bands.
 */
function simplifiedTone(f: Field, g: FaceGeo | null, flat = false): { tone: Float32Array; region: Uint8Array } {
  const { cols, rows, mask } = f;
  const N = cols * rows;
  const s = stretch(f.L, f);
  let mean = 0;
  for (let p = 0; p < N; p++) if (mask[p]) mean += s[p];
  mean /= Math.max(1, f.n);
  // Transparent cells take the subject's mean: no filter sees an edge that is not in the picture.
  const filled = new Float32Array(N);
  for (let p = 0; p < N; p++) filled[p] = mask[p] ? s[p] : mean;
  // `flat` (an AI picture): smoothed harder at seat scale (a looser edge
  // test), so the generator's texture and grain go before the cut and only
  // the big shapes are left; the guided filter keeps their edges. A wider
  // window was tried and took the eyes with it.
  const fineR = g ? Math.max(1, Math.round(g.F / 10)) : Math.max(1, Math.round(f.span / 30));
  const coarseR = g ? Math.max(2, Math.round(g.F / 4)) : fineR;
  const fine = guidedFilter(filled, filled, cols, rows, fineR, flat ? 0.01 : 0.004);
  const coarse = coarseR === fineR ? fine : guidedFilter(filled, filled, cols, rows, coarseR, 0.012);
  const faceW = g ? faceWeight(g, f) : null;
  const t = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    if (!mask[p]) continue;
    const w = faceW ? faceW[p] : 1;
    t[p] = w * fine[p] + (1 - w) * coarse[p];
  }
  const region = new Uint8Array(N);
  let inRegion = 0;
  for (let p = 0; p < N; p++) if (mask[p] && (!faceW || faceW[p] >= 0.5)) { region[p] = 1; inRegion++; }
  if (inRegion < 9) region.set(mask);
  // The face's middle tone a little on the light side.
  const [med] = quantilesIn(t, region, [0.5]);
  const gamma = Math.log(0.6) / Math.log(Math.max(0.05, Math.min(0.95, med)));
  for (let p = 0; p < N; p++) if (mask[p]) t[p] = t[p] ** gamma;
  const around = blur(t, f, g ? g.F * 0.6 : f.span / 6);
  for (let p = 0; p < N; p++) if (mask[p]) t[p] = Math.max(0, Math.min(1, t[p] + 0.6 * (t[p] - around[p])));
  return { tone: t, region };
}

/** Where the face is, as a weight per cell: 1 inside an ellipse from the hairline to the chin, 0 a third of a face away. */
function faceWeight(g: FaceGeo, f: Field): Float32Array {
  const P = g.pts;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let i = 0; i <= 16; i++) {
    x0 = Math.min(x0, P[i * 2]);
    x1 = Math.max(x1, P[i * 2]);
  }
  let brow = 0;
  for (let i = 17; i <= 26; i++) brow += P[i * 2 + 1];
  brow /= 10;
  const chin = P[8 * 2 + 1];
  const cx = (x0 + x1) / 2;
  const cy = (brow - 0.35 * g.F + chin) / 2;
  const rx = Math.max(2, ((x1 - x0) / 2) * 1.05);
  const ry = Math.max(2, (chin - (brow - 0.35 * g.F)) / 2);
  const W = new Float32Array(f.cols * f.rows);
  for (let y = 0; y < f.rows; y++) {
    for (let x = 0; x < f.cols; x++) {
      const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      W[y * f.cols + x] = d <= 1 ? 1 : d >= 1.35 ? 0 : (1.35 - d) / 0.35;
    }
  }
  return W;
}

/** A histogram of the cells' values (0..1) in `bins` bins, over the cells in `m`. */
function histogramIn(v: Float32Array, m: Uint8Array, bins: number): { h: Float64Array; n: number } {
  const h = new Float64Array(bins);
  let n = 0;
  for (let p = 0; p < v.length; p++) if (m[p]) { h[Math.max(0, Math.min(bins - 1, Math.floor(v[p] * bins)))]++; n++; }
  return { h, n };
}

/**
 * Thresholds that split the tone into `k` classes (2 to 4), chosen from the
 * picture's own histogram (Otsu: the split with the most variance between the
 * classes), among the splits that leave every class at least `minShare` of
 * the picture: a band that covers a few percent of a face is specks, not a tone.
 */
function toneThresholds(v: Float32Array, m: Uint8Array, k: number, minShare: number): number[] {
  const BINS = 64;
  const { h, n } = histogramIn(v, m, BINS);
  const total = n || 1;
  // Cumulative counts and first moments, for each class's share and mean in O(1).
  const c0 = new Float64Array(BINS + 1);
  const c1 = new Float64Array(BINS + 1);
  for (let i = 0; i < BINS; i++) {
    c0[i + 1] = c0[i] + h[i];
    c1[i + 1] = c1[i] + h[i] * ((i + 0.5) / BINS);
  }
  const between = (a: number, b: number): number => {
    const w = c0[b] - c0[a];
    if (w <= 0) return 0;
    const mu = (c1[b] - c1[a]) / w;
    return w * mu * mu;
  };
  const ok = (a: number, b: number): boolean => (c0[b] - c0[a]) / total >= minShare;
  let best: number[] = [];
  let bestScore = -1;
  const cuts = Math.max(1, Math.min(3, k - 1));
  // Exhaustive over 64 bins: 63, 1,953 or 39,711 splits, each O(k).
  const walk = (from: number, chosen: number[]): void => {
    if (chosen.length === cuts) {
      const edges = [0, ...chosen, BINS];
      let s = 0;
      for (let i = 0; i + 1 < edges.length; i++) {
        if (!ok(edges[i], edges[i + 1])) return;
        s += between(edges[i], edges[i + 1]);
      }
      if (s > bestScore) {
        bestScore = s;
        best = chosen.slice();
      }
      return;
    }
    for (let t = from; t < BINS; t++) {
      if (!ok(chosen.length ? chosen[chosen.length - 1] : 0, t)) continue;
      chosen.push(t);
      walk(t + 1, chosen);
      chosen.pop();
    }
  };
  walk(1, []);
  // No split leaves every class its share (a nearly flat picture): equal shares instead.
  if (bestScore < 0) return quantilesIn(v, m, Array.from({ length: cuts }, (_, i) => (i + 1) / (cuts + 1)));
  return best.map((t) => t / BINS);
}

/** Which band each opaque cell falls in (0 = darkest), -1 where transparent. */
function bands(v: Float32Array, f: Field, thresholds: number[]): Int16Array {
  const out = new Int16Array(v.length).fill(-1);
  for (let p = 0; p < v.length; p++) {
    if (!f.mask[p]) continue;
    let b = 0;
    while (b < thresholds.length && v[p] >= thresholds[b]) b++;
    out[p] = b;
  }
  return out;
}

// -------------------------------------------------------------- the face ---

/** The face's landmarks in cells, and its size in rows. */
interface FaceGeo {
  /** x, y in cells. */
  pts: Float32Array;
  /** Brows to chin, in rows. */
  F: number;
}

function faceGeo(face: FaceInfo | null | undefined, f: Field): FaceGeo | null {
  if (!face || face.pts.length !== 136) return null;
  const pts = new Float32Array(136);
  for (let i = 0; i < 68; i++) {
    pts[i * 2] = face.pts[i * 2] * f.cols;
    pts[i * 2 + 1] = face.pts[i * 2 + 1] * f.rows;
  }
  let brow = 0;
  for (let i = 17; i <= 26; i++) brow += pts[i * 2 + 1];
  brow /= 10;
  const F = pts[8 * 2 + 1] - brow;
  // A face of a row or two, or one turned upside down, has nothing to strengthen.
  return F >= 3 ? { pts, F } : null;
}

/**
 * Where the face's features are, as a weight per cell (0..1): the eye
 * sockets with the brows, the shadow under the nose, the mouth, and the line
 * under the jaw. Each is at least three seats by three rows where it is
 * strongest, so it survives the clean-up and the empty seats; a big face gets
 * them lighter (it has the rows to model them itself).
 */
function featureWeights(g: FaceGeo, f: Field): Float32Array {
  const { cols, rows, aspect } = f;
  const P = g.pts;
  const W = new Float32Array(cols * rows);
  const X = (i: number): number => P[i * 2];
  const Y = (i: number): number => P[i * 2 + 1];
  const meanOf = (from: number, to: number, axis: 0 | 1): number => {
    let s = 0;
    for (let i = from; i <= to; i++) s += P[i * 2 + axis];
    return s / (to - from + 1);
  };
  // Half a seat's run past three: the smallest feature that keeps a 3 x 3 core.
  const minRy = 1.6;
  const minRx = 1.6;
  /** An ellipse (centre in cells, half-axes in rows) laid into W at `weight`, soft at its rim. */
  const ellipse = (cx: number, cy: number, ryRows: number, rxRows: number, weight: number): void => {
    const ry = Math.max(minRy, ryRows);
    const rx = Math.max(minRx, rxRows / aspect);
    const xa = Math.max(0, Math.floor(cx - rx * 1.3));
    const xb = Math.min(cols - 1, Math.ceil(cx + rx * 1.3));
    const ya = Math.max(0, Math.floor(cy - ry * 1.3));
    const yb = Math.min(rows - 1, Math.ceil(cy + ry * 1.3));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        const w = d <= 0.85 ? 1 : d >= 1.25 ? 0 : (1.25 - d) / 0.4;
        const p = y * cols + x;
        if (w * weight > W[p]) W[p] = w * weight;
      }
    }
  };
  /** A thick line through points, as a run of small ellipses. */
  const stroke = (idx: number[], dy: number, half: number, weight: number): void => {
    for (let k = 0; k + 1 < idx.length; k++) {
      const ax = X(idx[k]);
      const ay = Y(idx[k]) + dy;
      const bx = X(idx[k + 1]);
      const by = Y(idx[k + 1]) + dy;
      const len = Math.hypot((bx - ax) * aspect, by - ay);
      const n = Math.max(1, Math.ceil(len / Math.max(0.5, half)));
      for (let s = 0; s <= n; s++) ellipse(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n, half, half, weight);
    }
  };
  // A small face needs its features drawn in full; a big one only needs them
  // helped, but still into the darkest tone: a two-tone poster has no other.
  const scale = Math.max(0.65, Math.min(1, (30 - g.F) / 14));
  const F = g.F;
  for (const [eyeA, eyeB, browA, browB] of [[36, 41, 17, 21], [42, 47, 22, 26]] as const) {
    const ex = meanOf(eyeA, eyeB, 0);
    const ey = meanOf(eyeA, eyeB, 1);
    const by = meanOf(browA, browB, 1);
    const eyeW = Math.abs(X(eyeA + 3) - X(eyeA)) * aspect;
    if (ey - by < 4) {
      // Too few rows between brow and eye for both to be three rows with a
      // gap between: one socket, from the brow to just under the eye, the way
      // a stencil cuts a small face.
      const bottom = ey + 0.08 * F;
      ellipse(ex, (by + bottom) / 2, (bottom - by) / 2, eyeW * 0.58, scale);
    } else {
      // Room for both: the eye (its dark iris and lashes) and the brow apart.
      ellipse(ex, ey, Math.max(1.6, 0.07 * F), eyeW * 0.55, scale);
    }
    stroke([browA, browA + 2, browB], 0, Math.max(0.8, 0.05 * F), Math.min(1, scale + 0.15));
  }
  if (F >= 12) {
    // Under the nose: the nostrils' shadow, narrower than the nose.
    const nx = meanOf(31, 35, 0);
    const ny = meanOf(31, 35, 1) + 0.03 * F;
    ellipse(nx, ny, 0.05 * F, (Math.abs(X(35) - X(31)) * aspect) / 2, 0.8 * scale);
  }
  // The mouth: the lips' line, or the whole mouth when it is small.
  {
    const mx = meanOf(48, 59, 0);
    const my = (Y(62) + Y(66)) / 2;
    const half = (Math.abs(X(54) - X(48)) * aspect) / 2;
    const open = Math.abs(Y(57) - Y(51));
    ellipse(mx, my, Math.max(0.06 * F, open * 0.35), half * 0.92, scale);
  }
  // Under the jaw: the shadow that sets the head off the neck.
  stroke([4, 5, 6, 7, 8, 9, 10, 11, 12], 0.05 * F, Math.max(0.8, 0.045 * F), 0.65 * scale);
  return W;
}

/**
 * Push the features dark: each cell towards the face's own dark tone (its
 * 8th percentile, a little darker) by its feature weight, never lighter than it was.
 */
function strengthen(tone: Float32Array, f: Field, g: FaceGeo): void {
  const W = featureWeights(g, f);
  const [dark] = quantiles(tone, f, [0.08]);
  const target = Math.max(0, dark * 0.75);
  for (let p = 0; p < tone.length; p++) {
    if (!f.mask[p] || W[p] <= 0) continue;
    const v = tone[p] + (target - tone[p]) * W[p];
    if (v < tone[p]) tone[p] = v;
  }
}

// -------------------------------------------------------------- clean-up ---

/** The seat-scale window: three seats by three rows. */
const SEAT_RUN = 3;

/**
 * A binary area opened then closed with a (2r+1)-square window, in place:
 * the open drops every part of it thinner than the window, the close fills
 * every gap in it thinner than the window. Only cells in `within` change.
 */
function openClose(on: Uint8Array, within: Uint8Array, cols: number, rows: number, r: number): void {
  const N = cols * rows;
  const tmp = new Uint8Array(N);
  // Erode (min) or dilate (max) with a (2r+1) square, separably; outside the grid counts as `edge`.
  const morph = (src: Uint8Array, dst: Uint8Array, dilate: boolean): void => {
    const edge = dilate ? 0 : 1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let v = dilate ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const xx = x + d;
          const s = xx < 0 || xx >= cols ? edge : src[y * cols + xx];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        tmp[y * cols + x] = v;
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let v = dilate ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const yy = y + d;
          const s = yy < 0 || yy >= rows ? edge : tmp[yy * cols + x];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        dst[y * cols + x] = v;
      }
    }
  };
  // Cells outside `within` count as off for the open and on for nothing: the
  // area cannot grow into the transparent margin.
  const a = new Uint8Array(N);
  for (let p = 0; p < N; p++) a[p] = on[p] & within[p];
  const b = new Uint8Array(N);
  morph(a, b, false);
  morph(b, a, true); // opened
  morph(a, b, true);
  morph(b, a, false); // closed
  for (let p = 0; p < N; p++) if (within[p]) on[p] = a[p];
}

/**
 * Small dark features, given back thicker. The open drops every dark part
 * thinner than three seats, which is right for grain and wrong for an eye
 * drawn one row tall: a stencil cutter does not leave out a thin eye, he cuts
 * it three seats wide. So a small shape darker than what is around it, at
 * any level, that the open dropped (three cells or more, standing on its own
 * rather than fringing a larger dark area) comes back grown by one cell all
 * round: three rows at least, where it was.
 */
function thicken(before: Uint8Array, after: Uint8Array, within: Uint8Array, f: Field): void {
  const { cols, rows } = f;
  const N = cols * rows;
  const maxSize = Math.max(40, Math.round(f.n * 0.004));
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (seen[s0] || !before[s0] || after[s0]) continue;
    comp.length = 0;
    stack.push(s0);
    seen[s0] = 1;
    let touches = false;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % cols;
      const y = (p - x) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const q = yy * cols + xx;
        if (after[q]) touches = true;
        if (!seen[q] && before[q] && !after[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (touches || comp.length < SEAT_RUN || comp.length > maxSize) continue;
    for (const p of comp) {
      const x = p % cols;
      const y = (p - x) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && within[yy * cols + xx]) after[yy * cols + xx] = 1;
      }
    }
  }
}

/**
 * Seat-scale clean-up of a banded picture, in place. Each tone's area at or
 * below each level (darkest first) is opened and closed with a three-by-three
 * window, and the levels are nested again, so the bands keep their order: a
 * light speck in a shadow and a dark speck on a cheek go the same way, and
 * the ink's small features come back three seats thick (thicken). The
 * picture's own outline gets the same treatment, so no sliver of it is left
 * for the seats beneath to swallow. `k` is the number of bands.
 */
function seatScaleClean(band: Int16Array, f: Field, k: number): void {
  const { cols, rows } = f;
  const N = cols * rows;
  const r = (SEAT_RUN - 1) / 2;
  // The outline: opened and closed like a tone; a cell it gains takes the band of an opaque neighbour.
  const inside = new Uint8Array(N);
  const all = new Uint8Array(N).fill(1);
  for (let p = 0; p < N; p++) inside[p] = band[p] >= 0 ? 1 : 0;
  openClose(inside, all, cols, rows, r);
  for (let p = 0; p < N; p++) {
    if (!inside[p]) band[p] = -1;
    else if (band[p] < 0) {
      const x = p % cols;
      const near = [x > 0 ? p - 1 : -1, x < cols - 1 ? p + 1 : -1, p - cols, p + cols].find((q) => q >= 0 && q < N && band[q] >= 0);
      band[p] = near !== undefined ? band[near] : 0;
    }
  }
  if (k < 2) return;
  const sets: Uint8Array[] = [];
  for (let t = 0; t < k - 1; t++) {
    const s = new Uint8Array(N);
    for (let p = 0; p < N; p++) s[p] = band[p] >= 0 && band[p] <= t ? 1 : 0;
    const before = s.slice();
    openClose(s, inside, cols, rows, r);
    thicken(before, s, inside, f);
    if (t > 0) for (let p = 0; p < N; p++) s[p] |= sets[t - 1][p];
    sets.push(s);
  }
  for (let p = 0; p < N; p++) {
    if (!inside[p]) continue;
    let b = k - 1;
    for (let t = 0; t < k - 1; t++) if (sets[t][p]) { b = t; break; }
    band[p] = b;
  }
}

/** Bands are small numbers; the clean-up counts them in fixed tables of this size. */
const MAX_BANDS = 64;

/**
 * What the open and close cannot see: a card in a run of fewer than three
 * across or down (a diagonal step, a corner where three areas meet) takes
 * the card of a neighbour that gives it runs of three both ways, or failing
 * that the longest runs it can get, the most common card around it on a
 * tie; until none is left or nothing changes. The same rule core/analysis.ts
 * uses to call a seat fragile. A transparent cell counts as a card of its
 * own, so a sliver of picture between the outside and another tone goes too.
 * Cells are settled one after another in a fixed order (each sees the ones
 * before it), which is what lets a corner of three areas settle at all.
 */
function enforceRuns(band: Int16Array, f: Field): void {
  const { cols, rows } = f;
  const N = cols * rows;
  /** The run of card `v` through (x, y) along (dx, dy), as if (x, y) held it, capped at three. */
  const runAs = (x: number, y: number, dx: number, dy: number, v: number): number => {
    let n = 1;
    for (const sgn of [1, -1]) {
      let xx = x + sgn * dx;
      let yy = y + sgn * dy;
      while (n < SEAT_RUN && xx >= 0 && yy >= 0 && xx < cols && yy < rows && band[yy * cols + xx] === v) {
        n++;
        xx += sgn * dx;
        yy += sgn * dy;
      }
    }
    return n;
  };
  const votes = new Int32Array(MAX_BANDS + 1);
  for (let pass = 0; pass < 12; pass++) {
    let changed = 0;
    for (let p = 0; p < N; p++) {
      const own = band[p];
      if (own < 0) continue;
      const x = p % cols;
      const y = (p - x) / cols;
      if (runAs(x, y, 1, 0, own) >= SEAT_RUN && runAs(x, y, 0, 1, own) >= SEAT_RUN) continue;
      votes.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const v = band[yy * cols + xx];
        if (v !== own) votes[v < 0 ? MAX_BANDS : Math.min(v, MAX_BANDS - 1)]++;
      }
      let to = -2;
      let bestScore = -1;
      for (let t = 0; t <= MAX_BANDS; t++) {
        if (!votes[t]) continue;
        const v = t === MAX_BANDS ? -1 : t;
        const h = runAs(x, y, 1, 0, v);
        const w = runAs(x, y, 0, 1, v);
        // Both runs whole first, then the shorter run as long as it gets, then the most neighbours.
        const score = (h >= SEAT_RUN && w >= SEAT_RUN ? 1000 : 0) + 100 * Math.min(h, w) + votes[t];
        if (score > bestScore) { bestScore = score; to = v; }
      }
      if (to === -2 || to === own) continue;
      if (bestScore < 1000 && widenGap(x, y)) {
        changed++;
        continue;
      }
      band[p] = to;
      changed++;
    }
    if (!changed) break;
  }

  /**
   * A sliver one or two cells thick between two areas of one card (a strip
   * of paper between an eye and a brow) cannot be fixed a cell at a time:
   * every single cell of it is thin whatever it becomes. So the whole short
   * run across the sliver takes the card at one of its ends, the one that
   * leaves the cell in runs of three both ways. True when it did.
   */
  function widenGap(x: number, y: number): boolean {
    const own = band[y * cols + x];
    for (const [dx, dy] of [[0, 1], [1, 0]] as const) {
      if (runAs(x, y, dx, dy, own) >= SEAT_RUN) continue;
      // The run's cells, and the cards just past each end.
      let a = 0;
      while (a < SEAT_RUN && inGrid(x - (a + 1) * dx, y - (a + 1) * dy) && band[(y - (a + 1) * dy) * cols + x - (a + 1) * dx] === own) a++;
      let b = 0;
      while (b < SEAT_RUN && inGrid(x + (b + 1) * dx, y + (b + 1) * dy) && band[(y + (b + 1) * dy) * cols + x + (b + 1) * dx] === own) b++;
      const ends = [[x - (a + 1) * dx, y - (a + 1) * dy], [x + (b + 1) * dx, y + (b + 1) * dy]].filter(([ex, ey]) => inGrid(ex, ey)).map(([ex, ey]) => band[ey * cols + ex]);
      for (const v of ends) {
        if (v === own) continue;
        const cells: number[] = [];
        for (let k = -a; k <= b; k++) cells.push((y + k * dy) * cols + x + k * dx);
        for (const q of cells) band[q] = v;
        if (runAs(x, y, 1, 0, v) >= SEAT_RUN && runAs(x, y, 0, 1, v) >= SEAT_RUN) return true;
        for (const q of cells) band[q] = own;
      }
    }
    return false;
  }
  function inGrid(xx: number, yy: number): boolean {
    return xx >= 0 && yy >= 0 && xx < cols && yy < rows;
  }
}

/**
 * Fold every patch (4-connected cells of one band) smaller than `minArea`
 * into the band it touches most along its border. What is left is areas a
 * crowd can hold. Transparent cells are never written and never written
 * into. Deterministic: the scan order is fixed and a tie goes to the lower band.
 */
function foldSmall(lab: Int16Array, f: Field, minArea: number): void {
  const { cols } = f;
  const N = lab.length;
  const comp = new Uint8Array(N);
  const stack = new Int32Array(N);
  const small = new Int32Array(Math.max(1, minArea));
  const votes = new Int32Array(MAX_BANDS);
  for (let pass = 0; pass < 4; pass++) {
    comp.fill(0);
    let changed = false;
    for (let s = 0; s < N; s++) {
      if (lab[s] < 0 || comp[s]) continue;
      const tone = lab[s];
      let top = 0;
      let size = 0;
      stack[top++] = s;
      comp[s] = 1;
      while (top > 0) {
        const p = stack[--top];
        if (size < minArea) small[size] = p;
        size++;
        const x = p % cols;
        if (x > 0 && !comp[p - 1] && lab[p - 1] === tone) { comp[p - 1] = 1; stack[top++] = p - 1; }
        if (x < cols - 1 && !comp[p + 1] && lab[p + 1] === tone) { comp[p + 1] = 1; stack[top++] = p + 1; }
        if (p >= cols && !comp[p - cols] && lab[p - cols] === tone) { comp[p - cols] = 1; stack[top++] = p - cols; }
        if (p + cols < N && !comp[p + cols] && lab[p + cols] === tone) { comp[p + cols] = 1; stack[top++] = p + cols; }
      }
      if (size >= minArea) continue;
      votes.fill(0);
      for (let k = 0; k < size; k++) {
        const p = small[k];
        const x = p % cols;
        let t: number;
        if (x > 0 && (t = lab[p - 1]) >= 0 && t !== tone && t < MAX_BANDS) votes[t]++;
        if (x < cols - 1 && (t = lab[p + 1]) >= 0 && t !== tone && t < MAX_BANDS) votes[t]++;
        if (p >= cols && (t = lab[p - cols]) >= 0 && t !== tone && t < MAX_BANDS) votes[t]++;
        if (p + cols < N && (t = lab[p + cols]) >= 0 && t !== tone && t < MAX_BANDS) votes[t]++;
      }
      let to = -1;
      let most = 0;
      for (let t = 0; t < MAX_BANDS; t++) if (votes[t] > most) { to = t; most = votes[t]; }
      if (to >= 0) {
        for (let k = 0; k < size; k++) lab[small[k]] = to;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** The smallest patch a style keeps, in cells: three by three at least, more on a big picture. */
const minPatch = (f: Field): number => Math.max(SEAT_RUN * SEAT_RUN, Math.min(400, Math.round(f.n * 0.0015)));

/** The whole seat-scale clean-up: open and close, runs, then patches too small for a crowd. */
function cleanAll(band: Int16Array, f: Field, k: number): void {
  seatScaleClean(band, f, k);
  enforceRuns(band, f);
  foldSmall(band, f, minPatch(f));
  // Folding can leave a fresh corner; one more pass of the run rule settles it.
  enforceRuns(band, f);
}

// ------------------------------------------------------------ the styles ---

/** The tone every style starts from, with the face's features pushed dark when there is a face. */
function portraitTone(f: Field, opts: PortraitOptions): { tone: Float32Array; region: Uint8Array } {
  const g = faceGeo(opts.face, f);
  const r = simplifiedTone(f, g);
  if (g) strengthen(r.tone, f, g);
  return r;
}

/** How thick an outline is: three seats on a stand, more on a picture drawn at print size. */
const rimWidth = (f: Field): number => Math.max(SEAT_RUN, Math.round(f.span / 36));

/**
 * The subject's outline: its cells within `t` of the outside, as a mask. The
 * frame's own edge is not the outside (a picture cropped at the shoulders has
 * no outline along the crop). Null when it would swallow the subject (a
 * silhouette a few seats across has no room for one).
 */
function rimOf(f: Field, t: number): Uint8Array | null {
  const { cols, rows, mask } = f;
  const N = cols * rows;
  const out = new Uint8Array(N);
  // Cells of the outside within t across, then within t down: within t both ways.
  const across = new Uint16Array(N);
  for (let y = 0; y < rows; y++) {
    let run = 0;
    const row = y * cols;
    const pre = new Int32Array(cols + 1);
    for (let x = 0; x < cols; x++) pre[x + 1] = pre[x] + (mask[row + x] ? 0 : 1);
    for (let x = 0; x < cols; x++) {
      run = pre[Math.min(cols, x + t + 1)] - pre[Math.max(0, x - t)];
      across[row + x] = run;
    }
  }
  let n = 0;
  const pre = new Int32Array(rows + 1);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) pre[y + 1] = pre[y] + (across[y * cols + x] > 0 ? 1 : 0);
    for (let y = 0; y < rows; y++) {
      const p = y * cols + x;
      if (!mask[p]) continue;
      if (pre[Math.min(rows, y + t + 1)] - pre[Math.max(0, y - t)] > 0) {
        out[p] = 1;
        n++;
      }
    }
  }
  return n > 0 && n <= f.n * 0.45 ? out : null;
}

/** Draw the outline last, in tone 0, then settle the run rule around it again. */
function outlined(band: Int16Array, f: Field, rim: Uint8Array | null): void {
  if (!rim) return;
  for (let p = 0; p < band.length; p++) if (rim[p]) band[p] = 0;
  enforceRuns(band, f);
  for (let p = 0; p < band.length; p++) if (rim[p]) band[p] = 0;
}

function stencil(f: Field, sw: Swatch[], opts: PortraitOptions): Int16Array {
  const { tone, region } = portraitTone(f, opts);
  // Two tones, cut where the face's own histogram splits best, with the ink
  // between 12% and 50% of the face: a stencil that is nearly all one colour
  // reads as a block, not a face, and a face lit flat has little shadow to give.
  const [otsu] = toneThresholds(tone, region, 2, 0.12);
  const [lo, hi] = quantilesIn(tone, region, [0.12, 0.5]);
  const band = bands(tone, f, [Math.max(lo, Math.min(hi, otsu))]);
  // A hard dark outline round the subject, drawn last: the stencil look, and
  // the edge that keeps a pale face off a pale stand.
  const rim = rimOf(f, rimWidth(f));
  if (rim) for (let p = 0; p < band.length; p++) if (rim[p]) band[p] = 0;
  cleanAll(band, f, 2);
  outlined(band, f, rim);
  return paint(band, toneColours(2, inkAndPaper(sw)));
}

function banded(f: Field, opts: PortraitOptions, k: number, minShare: number): Int16Array {
  const { tone, region } = portraitTone(f, opts);
  const band = bands(tone, f, toneThresholds(tone, region, k, minShare));
  cleanAll(band, f, k);
  return band;
}

/**
 * The "Hope" poster: three tones, the darkest of them also the outline, on a
 * field split down the middle into the two lighter tones. Poster 2 (retired
 * from the picker) is the same two-tone cut without outline or field.
 */
function poster(f: Field, sw: Swatch[], opts: PortraitOptions, k: 2 | 3): Int16Array {
  const colours = posterColours(avoiding(sw, opts.under, 2), k);
  const kk = Math.max(2, Math.min(k, colours.length));
  if (k === 2) return paint(banded(f, opts, kk, 0.15), toneColours(kk, colours));
  const { tone, region } = portraitTone(f, opts);
  const band = bands(tone, f, toneThresholds(tone, region, kk, 0.1));
  const rim = rimOf(f, rimWidth(f));
  if (rim) for (let p = 0; p < band.length; p++) if (rim[p]) band[p] = 0;
  cleanAll(band, f, kk);
  outlined(band, f, rim);
  const tones = toneColours(kk, colours);
  const out = paint(band, tones);
  if (rim) {
    // The field: the lighter tones, split down the middle as the poster's is.
    // With only two cards the darkest is the outline, so the field is the light one alone.
    const right = tones[kk - 1];
    const left = kk >= 3 ? tones[kk - 2] : right;
    for (let p = 0; p < out.length; p++) if (band[p] < 0) out[p] = (p % f.cols) < f.cols / 2 ? left : right;
  }
  return out;
}

/**
 * Duotone: the face in two club colours (a third when the palette has one
 * between them), soft rather than graphic: no outline, no field, the tone
 * split at the face's middle so both colours carry it. On a banner the same
 * ramp is drawn smooth (`duotoneRamp`).
 */
function duotone(f: Field, sw: Swatch[], opts: PortraitOptions): Int16Array {
  const colours = duotoneColours(avoiding(sw, opts.under, 2));
  const k = Math.max(2, colours.length);
  return paint(banded(f, opts, k, k === 2 ? 0.25 : 0.15), toneColours(k, colours));
}

/** Painted (banners): five tones and the darkest as an outline, at print size. */
function painted(f: Field, sw: Swatch[], opts: PortraitOptions): Int16Array {
  const colours = rankColours(avoiding(sw, opts.under, 2), 5);
  const k = Math.max(2, Math.min(5, colours.length));
  const { tone, region } = portraitTone(f, opts);
  const band = bands(tone, f, toneThresholds(tone, region, k, 0.06));
  const rim = rimOf(f, rimWidth(f));
  if (rim) for (let p = 0; p < band.length; p++) if (rim[p]) band[p] = 0;
  cleanAll(band, f, k);
  outlined(band, f, rim);
  return paint(band, toneColours(k, colours));
}

/**
 * Pop art: the subject in two or three tones (ink and bright colours), and
 * every transparent cell of the picture's frame a flat field of another bold
 * colour, so the panel is one poster: a cut-out face on colour.
 */
function pop(f: Field, sw: Swatch[], opts: PortraitOptions): Int16Array {
  const { tones, field } = popLayout(sw);
  const k = Math.max(2, tones.length);
  const band = banded(f, opts, k, 0.12);
  const out = paint(band, toneColours(k, tones));
  if (field) for (let p = 0; p < out.length; p++) if (band[p] < 0) out[p] = field.idx;
  return out;
}

/**
 * The duotone as a banner prints it: a smooth ramp between the two club
 * colours (RGBA, transparent where the picture is), not cut into cards.
 */
export function duotoneRamp(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  palette: readonly string[],
  opts: PortraitOptions,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cols * rows * 4);
  const f = fieldOf(pixels, cols, rows, opts);
  const sw = swatchesOf(palette);
  if (f.n === 0 || sw.length === 0) return out;
  const ends = duotoneColours(avoiding(sw, opts.under, 2));
  const rgb = (s: Swatch): number[] => {
    const v = parseInt(String(palette[s.idx]).replace('#', '').slice(0, 6), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const lo = rgb(ends[0]);
  const hi = rgb(ends[ends.length - 1]);
  const { tone, region } = portraitTone(f, opts);
  // Stretched over the face, so its darkest is the dark colour and its lightest the light.
  const [q0, q1] = quantilesIn(tone, region, [0.03, 0.97]);
  for (let p = 0; p < f.mask.length; p++) {
    if (!f.mask[p]) continue;
    const t = Math.max(0, Math.min(1, (tone[p] - q0) / Math.max(1e-3, q1 - q0)));
    for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.round(lo[c] + t * (hi[c] - lo[c]));
    out[p * 4 + 3] = 255;
  }
  return out;
}

/**
 * A picture in a portrait style, as palette indices (-1 = transparent: leave
 * the seats beneath alone). Deterministic: the same pixels and palette always
 * give the same cards.
 */
export function stylePortrait(
  style: PortraitStyle,
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  palette: readonly string[],
  opts: PortraitOptions,
): Int16Array {
  const f = fieldOf(pixels, cols, rows, opts);
  const sw = swatchesOf(palette);
  if (sw.length === 0) return new Int16Array(cols * rows).fill(-1);
  if (f.n === 0) {
    // Nothing of the subject: pop art is still its field; the rest leave the seats.
    if (style !== 'pop') return new Int16Array(cols * rows).fill(-1);
    const field = popLayout(sw).field;
    return new Int16Array(cols * rows).fill(field ? field.idx : -1);
  }
  switch (style) {
    case 'stencil':
      return stencil(f, sw, opts);
    case 'duotone':
      return duotone(f, sw, opts);
    case 'pop':
      return pop(f, sw, opts);
    case 'poster2':
      return poster(f, sw, opts, 2);
    case 'poster3':
      return poster(f, sw, opts, 3);
    case 'painted':
      return painted(f, sw, opts);
    default:
      return new Int16Array(cols * rows).fill(-1);
  }
}

/** The most tone levels an AI picture is cut into (four flat tones is what reads at seat scale). */
export const RANK_TONES = 4;

/**
 * How many tones a picture this many rows tall can carry: each tone needs
 * shapes three seats across, so a small stand gets two, a middling one
 * three, and four only from 30 rows.
 */
export function rankTonesFor(rows: number): number {
  return rows < 16 ? 2 : rows < 30 ? 3 : RANK_TONES;
}

/**
 * An AI picture (or any picture) posterised by brightness RANK rather than
 * by nearest colour: its tone levels come from its own lightness histogram
 * (Otsu, up to four), and level i is painted with the i-th card in order of
 * lightness, the palette's cards spread over its range. Hue no longer
 * decides anything, so a grey or wrongly coloured generator output still
 * lands on the club's palette as a clean picture rather than as mush; then
 * the same seat-scale clean-up as the portrait styles.
 */
export function posterizeByRank(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  palette: readonly string[],
  opts: PortraitOptions,
): Int16Array {
  const f = fieldOf(pixels, cols, rows, opts);
  const sw = swatchesOf(palette);
  if (f.n === 0 || sw.length === 0) return new Int16Array(cols * rows).fill(-1);
  const want = rankTonesFor(rows);
  const colours = rankColours(avoiding(sw, opts.under, 2), want);
  const k = Math.max(2, Math.min(want, colours.length));
  // The same simplification as a portrait's, without a face: texture
  // smoothed away, edges kept, a little local contrast.
  const { tone } = simplifiedTone(f, null, true);
  const band = bands(tone, f, toneThresholds(tone, f.mask, k, 0.08));
  cleanAll(band, f, k);
  return paint(band, toneColours(k, colours));
}
