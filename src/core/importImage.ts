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
