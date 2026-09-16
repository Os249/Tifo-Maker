import type { SeatMap } from './types';
import type { DesignStore } from './design';

/**
 * Image import pipeline (Phase 3 feature, blueprint §1.2):
 *
 *   image → rasterize at seat density → quantize to the card palette
 *         → (optional) Floyd–Steinberg dithering → stamp onto seats.
 *
 * Dithering needs a REGULAR grid to propagate error, and the bowl is not one —
 * so we dither on an intermediate grid whose cells approximate one seat each
 * (cols ≈ region width / seat spacing, rows = region height / row height),
 * then each real seat samples its nearest grid cell. `quantizePixels` and
 * `applyGridToSeats` are pure and DOM-free, so they run in the Node verify
 * harness today and can move into a Web Worker untouched.
 */

export interface ImportOptions {
  dither: boolean;
  /** Pixels with alpha below this are skipped (existing seats keep their color). */
  alphaThreshold: number;
  /** Clustered "halftone" quantization: average BxB cells into one tone. Chunkier
   *  and far more legible at seat scale than fine dithering (no fragile specks). */
  halftone?: boolean;
  /** Halftone block size in grid cells (default 3 → blocks clear the legibility check). */
  halftoneCell?: number;
}

/**
 * The tone rows a subject needs before clustering is affordable.
 *
 * A face is read from a handful of tonal landmarks — brow, eye sockets, the
 * shadow down one cheek, the line of the jaw. Below roughly 40 rows those
 * landmarks merge and it stops being a face.
 */
const MIN_TONE_ROWS = 40;

/**
 * Halftone block size for a grid of this many rows.
 *
 * A fixed cell of 3 was the single biggest reason AI portraits arrived as
 * blobs. Halftone averages BxB cells into one tone, so it divides the tonal
 * resolution by B — and a hero portrait on one stand is only ~52 rows tall to
 * begin with:
 *
 *   B=1  333 x 52 cells      a face reads
 *   B=2  167 x 26 cells      marginal
 *   B=3  111 x 18 cells      eighteen rows for a whole face — a blob
 *
 * Clustering is worth it on a big grid, where it trades detail nobody could see
 * for tones that survive a ~10% no-show rate. On a small one it spends
 * resolution the design cannot afford. So the cell is whatever the row budget
 * can pay for, never more.
 */
export function halftoneCellFor(rows: number, requested?: number): number {
  const want = Math.max(1, Math.round(requested ?? 3));
  return Math.max(1, Math.min(want, Math.floor(rows / MIN_TONE_ROWS)));
}

/**
 * Make a picture's flat backdrop transparent, so the design underneath shows
 * through instead of a rectangular block of card.
 *
 * Flood-filled INWARD FROM THE FRAME EDGES, never matched globally. A global
 * "remove everything near white" eats the white of a shirt, the highlight in an
 * eye, the teeth — and the figure falls apart. Only backdrop actually connected
 * to the border is background; an enclosed region of the same colour is part of
 * the subject and survives.
 *
 * Operates on the already-downsampled bake grid (~333x52 for one stand), so the
 * whole fill is a few thousand cells. Alpha 0 is all it has to write:
 * quantizePixels skips those cells and applyGridToSeats leaves those seats
 * alone, so the layers beneath keep their cards.
 *
 * Refuses rather than guesses. If the border is not mostly ONE colour there is
 * no clean backdrop to cut; if the fill would swallow nearly everything the
 * subject matched the background. Either way the picture is returned untouched,
 * because a rectangle of photo beats a hole where the hero was.
 *
 * The tolerance is deliberately tight — enough for JPEG noise on a flat fill,
 * not enough to wander. What it CANNOT survive is a subject whose edge is
 * genuinely the backdrop's colour: a white-lit cheek against white cuts away
 * with the background, because at that point the two are the same pixels. That
 * is why the image prompt demands a backdrop clearly different from the subject;
 * this function cannot recover a distinction the picture never had.
 */
export function cutoutBackground(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  tolerance = 900,
): boolean {
  if (cols < 3 || rows < 3) return false;
  const at = (x: number, y: number): number => (y * cols + x) * 4;

  // 1) The dominant border colour — the mode, not the mean. Averaging a white
  //    backdrop with dark hair gives grey, which matches neither.
  const border: number[] = [];
  for (let x = 0; x < cols; x++) { border.push(at(x, 0), at(x, rows - 1)); }
  for (let y = 1; y < rows - 1; y++) { border.push(at(0, y), at(cols - 1, y)); }
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (const p of border) {
    if (pixels[p + 3] === 0) continue;
    const key = ((pixels[p] >> 4) << 8) | ((pixels[p + 1] >> 4) << 4) | (pixels[p + 2] >> 4);
    const e = buckets.get(key);
    if (e) { e.r += pixels[p]; e.g += pixels[p + 1]; e.b += pixels[p + 2]; e.n++; }
    else buckets.set(key, { r: pixels[p], g: pixels[p + 1], b: pixels[p + 2], n: 1 });
  }
  let top: { r: number; g: number; b: number; n: number } | null = null;
  for (const e of buckets.values()) if (!top || e.n > top.n) top = e;
  if (!top || top.n < border.length * 0.4) return false; // no single clean backdrop
  const bg: [number, number, number] = [top.r / top.n, top.g / top.n, top.b / top.n];

  // 2) Flood inward from every border cell that matches it.
  const near = (p: number): boolean => {
    const dr = pixels[p] - bg[0];
    const dg = pixels[p + 1] - bg[1];
    const db = pixels[p + 2] - bg[2];
    return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114 <= tolerance;
  };
  const seen = new Uint8Array(cols * rows);
  const queue: number[] = [];
  for (const p of border) {
    const cell = p >> 2;
    if (!seen[cell] && near(p)) { seen[cell] = 1; queue.push(cell); }
  }
  let removed = queue.length;
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const x = cell % cols;
    const y = (cell / cols) | 0;
    const push = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;
      const nc = ny * cols + nx;
      if (seen[nc] || !near(nc * 4)) return;
      seen[nc] = 1;
      queue.push(nc);
      removed++;
    };
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }

  // 3) Sanity. Nothing worth cutting, or so much that the subject went with it.
  const frac = removed / (cols * rows);
  if (frac < 0.02 || frac > 0.92) return false;
  for (let cell = 0; cell < cols * rows; cell++) if (seen[cell]) pixels[cell * 4 + 3] = 0;
  return true;
}

export interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Contain-fit an image's aspect ratio inside a viewport rect, centered. */
export function fitRect(imgW: number, imgH: number, viewport: TargetRect): TargetRect {
  const scale = Math.min(viewport.width / imgW, viewport.height / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y + (viewport.height - height) / 2,
    width,
    height,
  };
}

/**
 * The long edge an imported picture is decoded down to.
 *
 * 2048 is not a taste call, it is the floor of what every WebGL device can hold:
 * MAX_TEXTURE_SIZE is guaranteed >= 2048 on WebGL1 hardware and is 4096 on a
 * great many phones still in use. A modern phone camera hands you 4000-8000px
 * on the long edge, and a 48MP shot at 8160px silently fails to upload on
 * anything with a 4096 limit — the picture is simply not there, which is a much
 * worse bug than a soft one, because nothing reports it.
 *
 * Nothing downstream wants the pixels either, and the margin is not close. The
 * widest an import can be placed is the slider's 1250 seats; a seat is 3.2
 * editor units and `bake` samples one cell per 3, so the biggest grid any
 * picture is ever rasterised onto is 1250*3.2/3 = 1333 cells across. 2048
 * feeds that with room to spare, so the cap costs nothing at any size the
 * editor can produce. What the full-size bitmap costs is real: a 4032x3024
 * photo is a 47MB GPU texture and 47MB of bitmap, held for as long as the
 * object exists; at 2048 it is 12MB.
 *
 * Raising the width slider past ~1900 seats would start to matter. verify.mts
 * checks that pairing so it cannot drift silently.
 */
export const IMPORT_MAX_EDGE = 2048;

/**
 * Browser-only: decode a picked file to an ImageBitmap no larger than
 * `maxEdge` on its long side, preserving aspect.
 *
 * Three paths, because `createImageBitmap`'s resize options are not universal:
 * a browser that honours them does a filtered downscale itself, one that
 * ignores them hands back a full-size bitmap (checked, not assumed), and one
 * that rejects them throws — the canvas fallback covers both of the last two.
 * Whatever happens, the full-size bitmap is closed rather than left to the GC.
 */
export async function decodeImportBitmap(file: Blob, maxEdge = IMPORT_MAX_EDGE): Promise<ImageBitmap> {
  const full = await createImageBitmap(file);
  const long = Math.max(full.width, full.height);
  if (long <= maxEdge) return full;
  const scale = maxEdge / long;
  const w = Math.max(1, Math.round(full.width * scale));
  const h = Math.max(1, Math.round(full.height * scale));
  try {
    const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    if (small.width <= maxEdge && small.height <= maxEdge) {
      full.close();
      return small;
    }
    small.close(); // options ignored — fall through to the canvas
  } catch {
    /* options rejected — fall through to the canvas */
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  full.close();
  return await createImageBitmap(canvas);
}

/** Browser-only: resample a drawable source down to cols×rows RGBA pixels. */
export function rasterize(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  cols: number,
  rows: number,
): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, cols, rows);
  return ctx.getImageData(0, 0, cols, rows).data;
}

function hexToRGB(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

/**
 * Extract the image's own dominant colors (for "import with real colours").
 * Buckets opaque pixels into a coarse RGB grid, takes the most populated
 * buckets, and refines each to the mean of its members. Returns up to `count`
 * hex colors (slot 0 is reserved for the empty seat, so this fills slots 1..N).
 * Pure aside from rasterize; runs on the same downsampled pixel grid.
 */
export function extractPalette(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  count = 6,
  alphaThreshold = 128,
): string[] {
  const SHIFT = 4; // 16 levels per channel → 4096 buckets
  const sums = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let p = 0; p < cols * rows; p++) {
    if (pixels[p * 4 + 3] < alphaThreshold) continue;
    const r = pixels[p * 4];
    const g = pixels[p * 4 + 1];
    const b = pixels[p * 4 + 2];
    const key = ((r >> SHIFT) << 8) | ((g >> SHIFT) << 4) | (b >> SHIFT);
    const e = sums.get(key);
    if (e) {
      e.r += r;
      e.g += g;
      e.b += b;
      e.n++;
    } else {
      sums.set(key, { r, g, b, n: 1 });
    }
  }
  const buckets = [...sums.values()].sort((a, b) => b.n - a.n);
  const chosen: string[] = [];
  for (const bkt of buckets) {
    const hex = rgbToHex(bkt.r / bkt.n, bkt.g / bkt.n, bkt.b / bkt.n);
    // Skip near-duplicate colors so the palette stays varied.
    if (chosen.some((c) => colorDist(hexToRGB(c), hexToRGB(hex)) < 900)) continue;
    chosen.push(hex);
    if (chosen.length >= count) break;
  }
  return chosen;
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/**
 * Quantize RGBA pixels to palette indices with optional Floyd–Steinberg dithering.
 * Index 0 (empty seat) is never a quantization target — imported art always maps
 * to real cards. Returns Int16Array of palette indices; -1 = transparent, skip.
 */
export function quantizePixels(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  palette: string[],
  opts: ImportOptions,
): Int16Array {
  const targets: { idx: number; rgb: [number, number, number] }[] = [];
  for (let i = 1; i < palette.length; i++) targets.push({ idx: i, rgb: hexToRGB(palette[i]) });
  if (targets.length === 0) return new Int16Array(cols * rows).fill(-1);

  // Float working copy so diffusion error can accumulate.
  const work = new Float32Array(cols * rows * 3);
  const skip = new Uint8Array(cols * rows);
  for (let p = 0; p < cols * rows; p++) {
    if (pixels[p * 4 + 3] < opts.alphaThreshold) {
      skip[p] = 1;
      continue;
    }
    work[p * 3] = pixels[p * 4];
    work[p * 3 + 1] = pixels[p * 4 + 1];
    work[p * 3 + 2] = pixels[p * 4 + 2];
  }

  const nearest = (r: number, g: number, b: number): number => {
    let best = targets[0];
    let bd = Infinity;
    for (const t of targets) {
      const dr = r - t.rgb[0];
      const dg = g - t.rgb[1];
      const db = b - t.rgb[2];
      const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best.idx;
  };

  // Halftone: one tone per BxB block → chunky, contiguous tones that survive the
  // ~10% no-show rate, instead of fragile single-seat dither specks. Trades fine
  // detail for stadium legibility — ideal for portraits.
  if (opts.halftone) {
    const B = Math.max(2, Math.round(opts.halftoneCell ?? 3));
    const ht = new Int16Array(cols * rows).fill(-1);
    for (let by = 0; by < rows; by += B) {
      for (let bx = 0; bx < cols; bx += B) {
        const yEnd = Math.min(rows, by + B);
        const xEnd = Math.min(cols, bx + B);
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = by; yy < yEnd; yy++)
          for (let xx = bx; xx < xEnd; xx++) {
            const p = yy * cols + xx;
            if (skip[p]) continue;
            r += work[p * 3];
            g += work[p * 3 + 1];
            b += work[p * 3 + 2];
            n++;
          }
        if (n === 0) continue; // wholly transparent block stays skipped
        const idx = nearest(r / n, g / n, b / n);
        for (let yy = by; yy < yEnd; yy++)
          for (let xx = bx; xx < xEnd; xx++) {
            const p = yy * cols + xx;
            if (!skip[p]) ht[p] = idx;
          }
      }
    }
    return ht;
  }

  const out = new Int16Array(cols * rows).fill(-1);
  const diffuse = (p: number, er: number, eg: number, eb: number, w: number): void => {
    if (skip[p]) return;
    work[p * 3] += er * w;
    work[p * 3 + 1] += eg * w;
    work[p * 3 + 2] += eb * w;
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = y * cols + x;
      if (skip[p]) continue;
      const r = work[p * 3];
      const g = work[p * 3 + 1];
      const b = work[p * 3 + 2];
      let best = targets[0];
      let bd = Infinity;
      for (const t of targets) {
        const dr = r - t.rgb[0];
        const dg = g - t.rgb[1];
        const db = b - t.rgb[2];
        // Perceptual-ish weighting: eyes resolve green best, blue worst.
        const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      out[p] = best.idx;
      if (!opts.dither) continue;
      const er = r - best.rgb[0];
      const eg = g - best.rgb[1];
      const eb = b - best.rgb[2];
      if (x + 1 < cols) diffuse(p + 1, er, eg, eb, 7 / 16);
      if (y + 1 < rows) {
        if (x > 0) diffuse(p + cols - 1, er, eg, eb, 3 / 16);
        diffuse(p + cols, er, eg, eb, 5 / 16);
        if (x + 1 < cols) diffuse(p + cols + 1, er, eg, eb, 1 / 16);
      }
    }
  }
  return out;
}

/** Single-color alpha mask: opaque pixels become `value`, the rest skip. */
export function maskFromAlpha(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  value: number,
  threshold = 128,
): Int16Array {
  const out = new Int16Array(cols * rows).fill(-1);
  for (let p = 0; p < cols * rows; p++) {
    if (pixels[p * 4 + 3] >= threshold) out[p] = value;
  }
  return out;
}

/**
 * Stamp a quantized grid onto every seat inside the target rect.
 * Call inside an active stroke; returns dirty indices for the renderer.
 * `wrapWidth` (the unrolled perimeter width) lets the rect cross the bowl
 * seam at u=0/1: seats are also tested at x ± wrapWidth. `accept` optionally
 * limits which seats may be painted (e.g. a single tier).
 */
export function applyGridToSeats(
  store: DesignStore,
  map: SeatMap,
  grid: Int16Array,
  cols: number,
  rows: number,
  target: TargetRect,
  wrapWidth?: number,
  accept?: (i: number) => boolean,
): number[] {
  const dirty: number[] = [];
  const x0 = target.x;
  const x1 = target.x + target.width;
  for (let i = 0; i < map.count; i++) {
    if (accept && !accept(i)) continue;
    let x = map.xy[i * 2];
    const y = map.xy[i * 2 + 1];
    if (y < target.y || y >= target.y + target.height) continue;
    if (x < x0 || x >= x1) {
      if (wrapWidth === undefined) continue;
      if (x + wrapWidth >= x0 && x + wrapWidth < x1) x += wrapWidth;
      else if (x - wrapWidth >= x0 && x - wrapWidth < x1) x -= wrapWidth;
      else continue;
    }
    const ix = Math.min(cols - 1, Math.floor(((x - x0) / target.width) * cols));
    const iy = Math.min(rows - 1, Math.floor(((y - target.y) / target.height) * rows));
    const idx = grid[iy * cols + ix];
    if (idx >= 0 && store.paint(i, idx)) dirty.push(i);
  }
  return dirty;
}

/** Relative luminance (Rec. 601) of an 8-bit RGB triple. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Photo/portrait palette: like extractPalette but tuned for faces — finer tonal
 * buckets, more colours, AND guaranteed luminance ANCHORS (a near-white for
 * teeth/eye-highlights and a near-black for pupils/eye-sockets). Population-only
 * palettes drop these tiny high-contrast features, which is exactly what makes
 * imported faces look expressionless. Anchors are the mean colour of the
 * brightest/darkest ~2% of opaque pixels (robust to single hot pixels). Fills
 * slots 1..N (slot 0 stays the empty seat).
 */
export function extractPhotoPalette(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  count = 14,
  alphaThreshold = 128,
): string[] {
  const SHIFT = 3; // 32 levels/channel → finer tones than extractPalette's 16
  const sums = new Map<number, { r: number; g: number; b: number; n: number }>();
  const lumas: number[] = [];
  for (let p = 0; p < cols * rows; p++) {
    if (pixels[p * 4 + 3] < alphaThreshold) continue;
    const r = pixels[p * 4];
    const g = pixels[p * 4 + 1];
    const b = pixels[p * 4 + 2];
    lumas.push(luma(r, g, b));
    const key = ((r >> SHIFT) << 10) | ((g >> SHIFT) << 5) | (b >> SHIFT);
    const e = sums.get(key);
    if (e) {
      e.r += r;
      e.g += g;
      e.b += b;
      e.n++;
    } else {
      sums.set(key, { r, g, b, n: 1 });
    }
  }
  if (lumas.length === 0) return [];

  // Luminance anchors: mean colour of the brightest/darkest ~2% of pixels.
  const sorted = [...lumas].sort((a, b) => a - b);
  const loCut = sorted[Math.floor(sorted.length * 0.02)];
  const hiCut = sorted[Math.floor(sorted.length * 0.98)];
  let dR = 0, dG = 0, dB = 0, dN = 0, bR = 0, bG = 0, bB = 0, bN = 0;
  for (let p = 0; p < cols * rows; p++) {
    if (pixels[p * 4 + 3] < alphaThreshold) continue;
    const r = pixels[p * 4];
    const g = pixels[p * 4 + 1];
    const b = pixels[p * 4 + 2];
    const L = luma(r, g, b);
    if (L <= loCut) { dR += r; dG += g; dB += b; dN++; }
    if (L >= hiCut) { bR += r; bG += g; bB += b; bN++; }
  }

  const chosen: string[] = [];
  const push = (hex: string, minDist: number): void => {
    if (chosen.some((c) => colorDist(hexToRGB(c), hexToRGB(hex)) < minDist)) return;
    chosen.push(hex);
  };
  // Anchors first so they always survive the count cap.
  if (bN) push(rgbToHex(bR / bN, bG / bN, bB / bN), 0);
  if (dN) push(rgbToHex(dR / dN, dG / dN, dB / dN), 0);
  // Then the most-populous distinct tones (a looser dedup than extractPalette so
  // skin ramps read as a gradient rather than one flat block).
  for (const bkt of [...sums.values()].sort((a, b) => b.n - a.n)) {
    if (chosen.length >= count) break;
    push(rgbToHex(bkt.r / bkt.n, bkt.g / bkt.n, bkt.b / bkt.n), 500);
  }
  return chosen.slice(0, count);
}

/**
 * Detail-preserving pre-pass for photo bakes: a light unsharp mask (local
 * contrast) plus a gentle S-curve, so tiny bright/dark features (teeth, eyes)
 * push toward the palette's white/black anchors and survive quantization at seat
 * scale instead of averaging into the surrounding skin. Pure; returns a NEW RGBA
 * buffer, alpha untouched.
 */
export function enhanceForBake(
  pixels: Uint8ClampedArray,
  cols: number,
  rows: number,
  contrast = 1.28,
  sharpen = 0.55,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  const at = (x: number, y: number, c: number): number =>
    pixels[(Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))) * 4 + c];
  const curve = (v: number): number => 128 + (v - 128) * contrast;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = (y * cols + x) * 4;
      out[p + 3] = pixels[p + 3];
      if (pixels[p + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        let blur = 0; // 3×3 box blur = the unsharp reference
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) blur += at(x + dx, y + dy, c);
        blur /= 9;
        const v = pixels[p + c];
        out[p + c] = Math.max(0, Math.min(255, Math.round(curve(v + (v - blur) * sharpen))));
      }
    }
  }
  return out;
}
