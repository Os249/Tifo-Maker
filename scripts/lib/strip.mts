/**
 * The gallery card image for a template, and the on-disk shape of a template.
 *
 * Why the strip and not the stadium: the gallery card is `aspect-ratio: 5/1`
 * with `object-fit: contain`, built for the unrolled bowl, and every design a
 * person saves is a strip too (see makeThumbnailB64). A 1.6:1 stadium render
 * dropped into that card contains down to a ~90px sliver, and giving templates
 * their own card shape would make the grid ragged. Clicking a card opens the
 * modal, which renders the real bowl in live 3D — nothing is lost.
 */
import { gzipSync } from 'node:zlib';
import { encodeIndexedPng } from './png.mjs';
import type { SeatMap } from '../../src/core/types';

/** Card column is 280-400 CSS px; 800 keeps it crisp at DPR 2. */
const W = 800;
/**
 * Every strip is emitted at this height, whatever the stadium.
 *
 * The three bowls unroll to different shapes — 9.4:1, 9.8:1 and, for the
 * 40k single-kop ground, 13.1:1 — and a grid cannot fit all three. Letting each
 * keep its own shape meant a third of the cards sat in a box half full of black
 * and read as half-finished designs. Scaling each bowl to the same card is what
 * the 3D preview already does with its camera: frame the ground you are given.
 */
const H_OUT = 84;
const BG: [number, number, number] = [0x14, 0x17, 0x1f];
const EMPTY: [number, number, number] = [0x26, 0x2a, 0x33];
/** Row pitch in editor units — every stadium template lays rows out on it. */
const ROW = 8;

export const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Paint the unrolled bowl into an indexed PNG.
 *
 * The bowl is ~3992 units across, so one pixel of an 800px strip covers about
 * 1.6 seats and this has to be a real downscale, not a point sample.
 *
 * It averages. The first version took the most common colour in each pixel,
 * which kept edges razor sharp but turned every dithered region into static:
 * the gradient layer is a 4x4 Bayer between two palette entries, and picking a
 * winner per pixel is picking noise. Averaging is also the honest answer —
 * a dither seen from the far side of a stadium IS its average — and it gives
 * text a pixel of antialiasing for free.
 *
 * Averaging invents colours, so the result is refitted to at most 16 entries:
 * the design's own palette, kept exact so flat areas never drift, plus the
 * blend tones the picture actually contains, taken most-frequent-first and
 * only when far enough from what is already in. Sixteen entries is not a
 * budget decision — it is where PNG packs two pixels to a byte, which is how
 * these come out around 2 KB.
 */
export function stripPng(map: SeatMap, cells: Uint8Array, palette: string[]): Buffer {
  const bw = map.bounds.maxX - map.bounds.minX;
  const bh = map.bounds.maxY - map.bounds.minY;
  const scale = W / bw;
  const rows = Math.max(1, Math.round(bh / ROW) + 1);

  const base: [number, number, number][] = [BG, EMPTY, ...palette.slice(1).map(rgb)];
  const cellRgb = (c: number): [number, number, number] =>
    base[c === 0 ? 1 : Math.min(base.length - 1, c + 1)];

  // Accumulate seat colour per (row, pixel).
  const n = rows * W;
  const sum = new Float64Array(n * 3);
  const hits = new Uint32Array(n);
  for (let i = 0; i < map.count; i++) {
    const r = Math.round((map.xy[i * 2 + 1] - map.bounds.minY) / ROW);
    if (r < 0 || r >= rows) continue;
    let px = Math.floor((map.xy[i * 2] - map.bounds.minX) * scale);
    if (px < 0) px = 0; else if (px >= W) px = W - 1;
    const k = r * W + px;
    const c = cellRgb(cells[i]);
    sum[k * 3] += c[0]; sum[k * 3 + 1] += c[1]; sum[k * 3 + 2] += c[2];
    hits[k]++;
  }

  // Average each cell, then soften across neighbours.
  //
  // The softening is what makes the gradient layer readable here. It is a 4x4
  // Bayer between two palette entries, so a cell only ever holds one of the two
  // colours and averaging 1.6 seats cannot mix them: the strip came out as
  // speckle even though the same design reads as a clean fade in the stand,
  // where thousands of cards blend at distance. A [1,2,1] pass in each axis is
  // that distance. Composition edges are eight pixels or more apart, so they
  // survive it; a 4-cell dither does not.
  const mean = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    if (!hits[k]) continue;
    mean[k * 3] = sum[k * 3] / hits[k];
    mean[k * 3 + 1] = sum[k * 3 + 1] / hits[k];
    mean[k * 3 + 2] = sum[k * 3 + 2] / hits[k];
  }
  const soft = blur121(mean, hits, rows, W);

  const avg = new Uint8Array(n * 3);
  const freq = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    if (!hits[k]) continue;
    const r = Math.round(soft[k * 3]);
    const g = Math.round(soft[k * 3 + 1]);
    const b = Math.round(soft[k * 3 + 2]);
    avg[k * 3] = r; avg[k * 3 + 1] = g; avg[k * 3 + 2] = b;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }

  // Palette: the design's colours first (never approximated), then the blend
  // tones the picture actually uses, most common first and far enough apart to
  // be worth a slot.
  const pal = base.slice(0, 16);
  const far = (c: [number, number, number], min: number): boolean =>
    pal.every((p) => dist2(p, c) >= min);
  for (const [key] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    if (pal.length >= 16) break;
    const c: [number, number, number] = [
      ((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4,
    ];
    if (far(c, 24 * 24)) pal.push(c);
  }

  // Crop to the rows that actually hold seats. The bounds round up to a whole
  // number of row pitches, so the last row or two of the grid are empty, and
  // leaving them in put a band of backdrop under every design — which read as
  // part of the tifo, not as padding.
  let first = rows, last = -1;
  for (let r = 0; r < rows; r++) {
    for (let px = 0; px < W; px++) {
      if (hits[r * W + px]) { if (r < first) first = r; if (r > last) last = r; break; }
    }
  }
  if (last < first) { first = 0; last = rows - 1; }
  const span = last - first + 1;
  const H = H_OUT;

  const idx = new Uint8Array(W * H);
  for (let r = first; r <= last; r++) {
    const y0 = Math.round(((r - first) / span) * H);
    const y1 = Math.min(H, Math.max(y0 + 1, Math.round(((r - first + 1) / span) * H)));
    for (let px = 0; px < W; px++) {
      const k = r * W + px;
      if (!hits[k]) continue; // concourse gap or aisle — leave the backdrop
      const c: [number, number, number] = [avg[k * 3], avg[k * 3 + 1], avg[k * 3 + 2]];
      let bestI = 1, bestD = Infinity;
      for (let p = 1; p < pal.length; p++) {
        const d = dist2(pal[p], c);
        if (d < bestD) { bestD = d; bestI = p; }
      }
      for (let y = y0; y < y1; y++) idx[y * W + px] = bestI;
    }
  }
  return encodeIndexedPng(idx, W, H, pal);
}

/** Separable [1,2,1] over the cell grid, skipping cells with no seats so a
 *  concourse gap never bleeds backdrop into the design beside it. */
function blur121(src: Float32Array, hits: Uint32Array, rows: number, w: number): Float32Array {
  const pass = (input: Float32Array, stride: number, len: number, outer: number): Float32Array => {
    const out = new Float32Array(input.length);
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < len; i++) {
        const k = stride === 1 ? o * w + i : i * w + o;
        if (!hits[k]) continue;
        for (let c = 0; c < 3; c++) {
          let acc = 2 * input[k * 3 + c], wt = 2;
          if (i > 0) { const j = k - stride; if (hits[j]) { acc += input[j * 3 + c]; wt++; } }
          if (i < len - 1) { const j = k + stride; if (hits[j]) { acc += input[j * 3 + c]; wt++; } }
          out[k * 3 + c] = acc / wt;
        }
      }
    }
    return out;
  };
  return pass(pass(src, 1, w, rows), w, rows, w);
}

/** Weighted squared RGB distance — close enough to perceptual for 16 slots. */
function dist2(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/** On-disk template record. Cells ship gzipped because that is what the repo
 *  stores anyway, and because RLE-as-JSON costs 8x more for the same bytes. */
export interface TemplateRecord {
  id: string;
  titleEn: string;
  titleAr: string;
  stadiumId: string;
  templateVersion: number;
  palette: string[];
  cellsGzB64: string;
  tags: string[];
  archetype: string;
  family: string;
  club: string | null;
  thumbnailPng: string;
  /** Stands carrying text or a symbol. Never "east": that stand straddles the
   *  seam where the bowl unrolls, so a word placed there is cut in half. */
  inkStands: string[];
  coverage: number;
  contrast: number;
}

export const packCells = (cells: Uint8Array): string =>
  gzipSync(Buffer.from(cells), { level: 9 }).toString('base64');

/**
 * One template per line, compact.
 *
 * The library is written as a single JSONL file rather than 619 little JSON
 * files. It is generated data — always rebuilt as a whole, never hand-edited —
 * so a directory bought nothing, while one line per template keeps a diff
 * readable (you see exactly which designs changed) and makes the thing one
 * file to ship, read and copy instead of six hundred.
 */
export const serialize = (rec: TemplateRecord): string => JSON.stringify(rec);

/** Where the library lives, relative to the repo root. */
export const LIBRARY_FILE = 'server/data/templates.jsonl';
