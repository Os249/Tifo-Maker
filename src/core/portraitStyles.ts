/**
 * Portrait styles (Pro): a face or a player photo as stencil, halftone, pop art
 * or a 2- or 3-colour poster, in the design's own colours.
 *
 * Pure and DOM-free, like quantizePixels: RGBA pixels at the picture's grid
 * resolution (about one cell per seat) and the palette in, palette indices out
 * (-1 where the picture is transparent). ensureGrid (core/objects.ts) calls it
 * for a picture whose layer carries a style; scripts/verify-portrait.mts checks
 * it in Node.
 *
 * What it is built for is the stand, not the screen. A portrait is often 40 to
 * 80 rows tall, every seat is one card held up by one fan, and about one seat in
 * ten is empty on the day. So every style:
 *  - works on TONE, stretched to the picture's own range, with the face's
 *    landmarks (brows, eyes, the shadow under the nose, the mouth, the hair
 *    line) lifted by a local-contrast pass, because those are what a face is
 *    read by from the far side of a ground, and at 48 rows an eye is a single
 *    row of cards that a plain threshold puts on the same side as the cheek;
 *  - draws big flat areas: anything left smaller than a few seats is folded
 *    into what surrounds it, and the light and middle tones lose their one-row
 *    slivers (the ink keeps them: an eye IS a one-row line), so there is no
 *    card on its own for an empty seat to swallow;
 *  - picks its colours from the palette by lightness, so the tones keep their
 *    order whatever the club's colours are, and degrades to fewer tones (never
 *    to colours a stand cannot tell apart) when the palette is short.
 * It never changes the palette, and slot 0 (the empty seat) is never a target.
 *
 *   stencil   two tones, ink and paper: the darkest and the lightest card, cut
 *             at a threshold chosen from the picture's own histogram (Otsu);
 *   halftone  a 45-degree dot screen in the same two cards, each dot several
 *             seats across (dark dots in the light, light dots in the dark),
 *             with the landmarks laid down as solid ink so the face survives
 *             a screen this coarse;
 *   pop       bold flat bands: the darkest card as the ink (shadows and the
 *             dark side of every strong edge, which outlines the features), a
 *             saturated middle colour, and a light saturated top (gold rather
 *             than white, if the club has it);
 *   poster2   two (poster3: three) tone bands in the club's colours: the cards
 *             with the most colour in them that still step clearly apart in
 *             lightness, in order of lightness.
 *
 * A cell's shape matters: a grid cell is about 3 editor units wide and 8 tall
 * (gridSize), so `aspect` (a cell's width over its height) keeps blurs round,
 * the clean-up windows fair, and halftone dots circles rather than tall ellipses.
 */

export const PORTRAIT_STYLES = ['stencil', 'halftone', 'pop', 'poster2', 'poster3'] as const;
export type PortraitStyle = (typeof PORTRAIT_STYLES)[number];

export function isPortraitStyle(v: unknown): v is PortraitStyle {
  return typeof v === 'string' && (PORTRAIT_STYLES as readonly string[]).includes(v);
}

export interface PortraitOptions {
  /** Pixels with alpha below this are transparent (-1): the layers beneath keep their cards. */
  alphaThreshold: number;
  /** A cell's width over its height in the picture's own frame (1 = square cells). */
  aspect?: number;
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

/** The values at quantiles `qs` of the opaque cells (values in 0..1). */
function quantiles(v: Float32Array, f: Field, qs: number[]): number[] {
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  for (let p = 0; p < v.length; p++) {
    if (!f.mask[p]) continue;
    hist[Math.max(0, Math.min(BINS - 1, Math.floor(v[p] * BINS)))]++;
  }
  return qs.map((q) => {
    const want = q * f.n;
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      acc += hist[i];
      if (acc >= want) return (i + 0.5) / BINS;
    }
    return 1;
  });
}

/** Stretch the picture's tone to its own range (1st to 99th percentile), so a grey photo still has a black and a white. */
function stretch(v: Float32Array, f: Field): Float32Array {
  const [lo, hi] = quantiles(v, f, [0.01, 0.99]);
  const out = new Float32Array(v.length);
  const k = hi - lo > 0.02 ? 1 / (hi - lo) : 1;
  for (let p = 0; p < v.length; p++) if (f.mask[p]) out[p] = Math.max(0, Math.min(1, (v[p] - lo) * k));
  return out;
}

/**
 * The tone a style starts from: stretched, then each cell pushed away from the
 * tone around it (a radius of about a fourteenth of the picture, the scale of
 * an eye socket in a head-and-shoulders portrait). This is what keeps a face's
 * landmarks when the picture is cut to two or three tones: an eye is only a
 * little darker than the skin around it.
 */
function liftedTone(f: Field, amount: number, divisor: number): Float32Array {
  const t = stretch(f.L, f);
  const around = blur(t, f, f.span / divisor);
  const out = new Float32Array(t.length);
  for (let p = 0; p < t.length; p++) if (f.mask[p]) out[p] = Math.max(0, Math.min(1, t[p] + amount * (t[p] - around[p])));
  return out;
}

/** A histogram of the opaque cells' values (0..1) in `bins` bins. */
function histogram(v: Float32Array, f: Field, bins: number): Float64Array {
  const h = new Float64Array(bins);
  for (let p = 0; p < v.length; p++) if (f.mask[p]) h[Math.max(0, Math.min(bins - 1, Math.floor(v[p] * bins)))]++;
  return h;
}

/**
 * Thresholds that split the picture's tone into `k` classes (2 or 3), chosen
 * from its own histogram (Otsu: the split with the most variance between the
 * classes), among the splits that leave every class at least `minShare` of
 * the picture: a band that covers a few percent of a face is specks, not a tone.
 */
function toneThresholds(v: Float32Array, f: Field, k: 2 | 3, minShare: number): number[] {
  const BINS = 64;
  const h = histogram(v, f, BINS);
  const total = f.n || 1;
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
    const m = (c1[b] - c1[a]) / w;
    return w * m * m;
  };
  const ok = (a: number, b: number): boolean => (c0[b] - c0[a]) / total >= minShare;
  let best: number[] = [];
  let bestScore = -1;
  if (k === 2) {
    for (let t = 1; t < BINS; t++) {
      if (!ok(0, t) || !ok(t, BINS)) continue;
      const s = between(0, t) + between(t, BINS);
      if (s > bestScore) {
        bestScore = s;
        best = [t];
      }
    }
  } else {
    for (let t1 = 1; t1 < BINS - 1; t1++) {
      if (!ok(0, t1)) continue;
      for (let t2 = t1 + 1; t2 < BINS; t2++) {
        if (!ok(t1, t2) || !ok(t2, BINS)) continue;
        const s = between(0, t1) + between(t1, t2) + between(t2, BINS);
        if (s > bestScore) {
          bestScore = s;
          best = [t1, t2];
        }
      }
    }
  }
  // No split leaves every class its share (a nearly flat picture): equal shares instead.
  if (bestScore < 0) return quantiles(v, f, k === 2 ? [0.5] : [1 / 3, 2 / 3]);
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

// -------------------------------------------------------------- clean-up ---

/** Bands are small numbers; the clean-up counts them in fixed tables of this size. */
const MAX_BANDS = 64;

/**
 * Fold every patch (4-connected cells of one band) smaller than its band's
 * minimum into the band it touches most along its border. What is left is
 * areas a crowd can hold: no card on its own for an empty seat to erase.
 * Transparent cells are never written and never written into. Deterministic:
 * the scan order is fixed and a tie goes to the lower band.
 */
function cleanUp(lab: Int16Array, f: Field, minAreas: number[]): void {
  const { cols } = f;
  const N = lab.length;
  const comp = new Uint8Array(N);
  const stack = new Int32Array(N);
  const areaOf = (t: number): number => minAreas[Math.min(t, minAreas.length - 1)];
  const small = new Int32Array(Math.max(1, ...minAreas));
  const votes = new Int32Array(MAX_BANDS);
  for (let pass = 0; pass < 4; pass++) {
    comp.fill(0);
    let changed = false;
    for (let s = 0; s < N; s++) {
      if (lab[s] < 0 || comp[s]) continue;
      // Flood one patch; remember its cells only while it is small.
      const tone = lab[s];
      const minArea = areaOf(tone);
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

/**
 * Thin out the bands that should be areas, not lines. Banding a smooth
 * gradient leaves the middle tones as one-row rings around every shadow
 * (contour lines, not flat colour), and lit hair as streaks: a cell of such a
 * band with few of its own kind around it takes the band most of its window
 * is. The window is one row up and down and as far across as the cell's shape
 * makes the same distance. The ink is never thinned: at 48 rows an eye is a
 * one-row line of ink.
 */
function dethin(lab: Int16Array, f: Field, thin: (band: number) => boolean, keep: number): void {
  const { cols, rows } = f;
  const rx = Math.max(1, Math.min(4, Math.round(1 / f.aspect)));
  const prev = lab.slice();
  const counts = new Int32Array(MAX_BANDS);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = y * cols + x;
      const own = prev[p];
      if (own < 0 || own >= MAX_BANDS || !thin(own)) continue;
      counts.fill(0);
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -rx; dx <= rx; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols) continue;
          const t = prev[yy * cols + xx];
          if (t < 0 || t >= MAX_BANDS) continue;
          counts[t]++;
          n++;
        }
      }
      if (counts[own] >= n * keep) continue;
      let to = -1;
      let most = 0;
      for (let t = 0; t < MAX_BANDS; t++) if (t !== own && counts[t] > most) { to = t; most = counts[t]; }
      if (to >= 0) lab[p] = to;
    }
  }
}

/** The smallest patch a style keeps, in cells: a few seats at least, more on a big picture. */
const minPatch = (f: Field): number => Math.max(3, Math.min(400, Math.round(f.n * 0.0006)));

// ------------------------------------------------------------ the styles ---

function stencil(f: Field, sw: Swatch[]): Int16Array {
  const tone = liftedTone(f, 2, 14);
  // Two tones, cut where the picture's own histogram splits best, but with
  // the ink between 30% and 60% of the picture: a stencil that is nearly all
  // one colour reads as a block, not a face.
  const [otsu] = toneThresholds(tone, f, 2, 0.25);
  const [lo, hi] = quantiles(tone, f, [0.3, 0.6]);
  const band = bands(tone, f, [Math.max(lo, Math.min(hi, otsu))]);
  dethin(band, f, (b) => b === 1, 0.3);
  const m = minPatch(f);
  cleanUp(band, f, [m, 4 * m]);
  return paint(band, toneColours(2, inkAndPaper(sw)));
}

/** The ink-dot centre nearest a cell (shift = a: the paper-dot lattice, half a step along). */
function nearestCentre(x: number, y: number, a: number, b: number, shift: number, aspect: number, out: Float64Array): void {
  // Centres: rows b*j + b/2, columns 2a*i + (j odd ? a : 0) + a/2 + shift (in cells).
  const j0 = Math.floor((y - b / 2) / b);
  let bd = Infinity;
  for (let j = j0; j <= j0 + 1; j++) {
    const cy = b * j + b / 2;
    const off = (((j % 2) + 2) % 2) * a + a / 2 + shift;
    const i = Math.round((x - off) / (2 * a));
    for (let di = -1; di <= 1; di++) {
      const cx = 2 * a * (i + di) + off;
      const dx = (x - cx) * aspect;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        out[0] = cx;
        out[1] = cy;
      }
    }
  }
}

/**
 * The halftone screen: dots on a lattice of whole cells, at 45 degrees in the
 * picture's own frame. Neighbouring dots are `b` rows and `a` cells apart
 * diagonally, with a * aspect close to b, so a row of dots always falls on the
 * same seats and every dot of one size has the same shape; a screen that
 * ignored the seats would alias into ragged dots of every shape.
 */
function halftone(f: Field, sw: Swatch[]): Int16Array {
  const { cols, rows, aspect } = f;
  // The step, in rows: tied to the seats more than to the picture, so a dot
  // always spans several of them (a mid-grey dot is about 3 rows by 7 seats),
  // and coarser on a big picture, which can afford it.
  const b = Math.max(3, Math.min(8, Math.round(f.span / 18)));
  const a = Math.max(1, Math.round(b / aspect));
  // Two readings of the picture: its shading, lifted a little like every
  // style's (so the hair is a cap of dots and the face clean paper, rather than
  // the same grey all over) and smoothed to the dots' scale (it sets their
  // sizes); and its landmarks (brows, eyes, nostrils, the mouth), the cells
  // clearly darker than what is around them, which go down as solid ink: a
  // screen this coarse would lose them between two dots.
  const base = stretch(f.L, f);
  const shade = blur(liftedTone(f, 0.9, 10), f, b * 0.35);
  const around = blur(base, f, f.span / 14);
  const darkAt = (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(cols - 1, Math.round(x - 0.5)));
    const cy = Math.max(0, Math.min(rows - 1, Math.round(y - 0.5)));
    // A little more contrast than the photo: paper stays paper, ink stays ink.
    return Math.max(0, Math.min(1, (1 - shade[cy * cols + cx] ** 1.15 - 0.1) / 0.8));
  };
  // A dot's radius (in rows) for its darkness: its share of its lattice cell.
  const cellArea = 2 * a * b * aspect;
  // Below this radius a dot would be a card or two: left out (the same for paper dots in the dark).
  const minR = 0.75;
  const centre = new Float64Array(2);
  const out = new Int16Array(cols * rows).fill(-1);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = y * cols + x;
      if (!f.mask[p]) continue;
      if (base[p] - around[p] < -0.08 && base[p] < 0.6) {
        out[p] = 0;
        continue;
      }
      const px = x + 0.5;
      const py = y + 0.5;
      // Up to half, ink dots on paper; past half, paper dots in the gaps of the screen.
      const paperDots = darkAt(px, py) > 0.5;
      nearestCentre(px, py, a, b, paperDots ? a : 0, aspect, centre);
      const d = darkAt(centre[0], centre[1]);
      const r = Math.sqrt(((paperDots ? 1 - d : d) * cellArea) / Math.PI);
      const dx = (px - centre[0]) * aspect;
      const dy = py - centre[1];
      const inDot = r >= minR && dx * dx + dy * dy < r * r;
      out[p] = inDot !== paperDots ? 0 : 1;
    }
  }
  // Dots are shapes on purpose: only crumbs go.
  cleanUp(out, f, [3]);
  return paint(out, toneColours(2, inkAndPaper(sw)));
}

function pop(f: Field, sw: Swatch[]): Int16Array {
  const colours = popColours(sw);
  const k = Math.max(2, colours.length);
  const tone = liftedTone(f, 1.6, 14);
  const { cols, rows } = f;
  const N = cols * rows;
  // The ink: the deepest shadows (at most a third of the picture) and the dark
  // side of every strong edge, which is what outlines the features.
  const [otsu] = toneThresholds(tone, f, 2, 0.18);
  const inkCut = Math.min(otsu, quantiles(tone, f, [0.34])[0]);
  const around = blur(tone, f, Math.max(0.8, f.span / 40));
  const edge = new Float32Array(N);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = y * cols + x;
      if (!f.mask[p]) continue;
      const l = x > 0 && f.mask[p - 1] ? tone[p - 1] : tone[p];
      const r = x < cols - 1 && f.mask[p + 1] ? tone[p + 1] : tone[p];
      const u = y > 0 && f.mask[p - cols] ? tone[p - cols] : tone[p];
      const d = y < rows - 1 && f.mask[p + cols] ? tone[p + cols] : tone[p];
      // Per row of height: a step across is over a narrower cell.
      edge[p] = Math.hypot(((r - l) * 0.5) / f.aspect, (d - u) * 0.5);
    }
  }
  const [edgeCut] = quantiles(edge, f, [0.88]);
  const isInk = new Uint8Array(N);
  const lit: Field = { ...f, mask: new Uint8Array(N), n: 0 };
  for (let p = 0; p < N; p++) {
    if (!f.mask[p]) continue;
    if (tone[p] < inkCut || (edge[p] > edgeCut && edge[p] > 0.06 && tone[p] < around[p] - 0.02)) isInk[p] = 1;
    else {
      lit.mask[p] = 1;
      lit.n++;
    }
  }
  // The rest, lit side up, into the other colours.
  const cuts = k === 3 && lit.n > 0 ? toneThresholds(tone, lit, 2, 0.2) : [];
  const band = new Int16Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    if (!f.mask[p]) continue;
    if (isInk[p]) {
      band[p] = 0;
      continue;
    }
    let b = 0;
    while (b < cuts.length && tone[p] >= cuts[b]) b++;
    band[p] = 1 + b;
  }
  dethin(band, f, (b) => b > 0, 0.34);
  const m = minPatch(f);
  cleanUp(band, f, [m, 3 * m]);
  return paint(band, toneColours(k, colours));
}

function poster(f: Field, sw: Swatch[], k: 2 | 3): Int16Array {
  const tone = liftedTone(f, 1, 10);
  const band = bands(tone, f, toneThresholds(tone, f, k, k === 2 ? 0.22 : 0.15));
  dethin(band, f, (b) => b > 0, 0.34);
  const m = minPatch(f);
  cleanUp(band, f, [m, 3 * m, 4 * m]);
  return paint(band, toneColours(k, posterColours(sw, k)));
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
  if (f.n === 0 || sw.length === 0) return new Int16Array(cols * rows).fill(-1);
  switch (style) {
    case 'stencil':
      return stencil(f, sw);
    case 'halftone':
      return halftone(f, sw);
    case 'pop':
      return pop(f, sw);
    case 'poster2':
      return poster(f, sw, 2);
    case 'poster3':
      return poster(f, sw, 3);
    default:
      return new Int16Array(cols * rows).fill(-1);
  }
}
