import type { SeatMap } from './types';
import type { DesignStore } from './design';
import { buildReveal, type RevealId } from './reveal';
import { EMPTY_SEAT_COLOR } from './template';

/**
 * Animated GIF export of a reveal.
 *
 * Tifos use <=8 card colors, so a GIF with a tiny global palette is a perfect,
 * dependency-free fit. We rasterize the unrolled design to a small grid, then
 * emit N frames stepping the reveal clock 0..1; each pixel is the seat's card
 * color once revealed, else the stand-gray. Encoder writes GIF89a with LZW
 * compression and per-frame graphic-control (delay + transparency disabled).
 *
 * Pure (no DOM): operates on the cells buffer and seat map directly, so it can
 * later move into a Web Worker unchanged.
 */

export interface GifOptions {
  reveal: RevealId;
  width: number; // output pixel width; height derives from bowl aspect
  frames: number;
  fps: number;
  fade: number; // per-seat fade as a fraction of the clock
}

const DEFAULTS: GifOptions = { reveal: 'sweep-lr', width: 480, frames: 36, fps: 18, fade: 0.08 };

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Build the GIF global color table from the palette + stand-gray (index 0). */
function buildPalette(store: DesignStore): { table: number[]; index: (cell: number, vis: number) => number } {
  const grayRgb: [number, number, number] = [
    (EMPTY_SEAT_COLOR >> 16) & 0xff,
    (EMPTY_SEAT_COLOR >> 8) & 0xff,
    EMPTY_SEAT_COLOR & 0xff,
  ];
  const colors: [number, number, number][] = [grayRgb];
  for (let c = 1; c < store.palette.length; c++) colors.push(hexToRgb(store.palette[c]));
  // Flatten to a GIF color table padded to a power of two.
  let size = 2;
  while (size < colors.length) size *= 2;
  const table: number[] = [];
  for (let i = 0; i < size; i++) {
    const c = colors[i] ?? grayRgb;
    table.push(c[0], c[1], c[2]);
  }
  // A revealed seat maps to its palette index; an un/partly-revealed seat (vis<0.5)
  // shows stand-gray (index 0). GIF has no alpha blend, so the fade is a threshold.
  const index = (cell: number, vis: number): number => (vis >= 0.5 && cell > 0 ? cell : 0);
  return { table, index };
}

/**
 * Render reveal frames as palette-index bitmaps.
 * Returns { indices: Uint8Array[], w, h, palette }.
 */
export function renderRevealFrames(
  map: SeatMap,
  store: DesignStore,
  opts: GifOptions,
): { frames: Uint8Array[]; w: number; h: number; table: number[] } {
  const bw = map.bounds.maxX - map.bounds.minX;
  const bh = map.bounds.maxY - map.bounds.minY;
  const w = opts.width;
  const h = Math.max(1, Math.round((w * bh) / bw));
  const delays = buildReveal(map, opts.reveal);
  const { table, index } = buildPalette(store);

  // Precompute each seat's pixel cell (nearest) so frames are cheap.
  const px = new Int32Array(map.count);
  for (let i = 0; i < map.count; i++) {
    const x = Math.min(w - 1, Math.floor(((map.xy[i * 2] - map.bounds.minX) / bw) * w));
    const y = Math.min(h - 1, Math.floor(((map.xy[i * 2 + 1] - map.bounds.minY) / bh) * h));
    px[i] = y * w + x;
  }

  const frames: Uint8Array[] = [];
  for (let f = 0; f < opts.frames; f++) {
    const clock = opts.frames === 1 ? 1 : f / (opts.frames - 1);
    const buf = new Uint8Array(w * h); // defaults to 0 = stand-gray
    for (let i = 0; i < map.count; i++) {
      const t = (clock - delays[i]) / opts.fade;
      const vis = t <= 0 ? 0 : t >= 1 ? 1 : t;
      buf[px[i]] = index(store.cells[i], vis);
    }
    frames.push(buf);
  }
  return { frames, w, h, table };
}

// ---- GIF89a encoder with LZW (variable-width codes) ----

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;
  write(code: number, len: number): void {
    this.cur |= code << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur >>= 8;
      this.nbits -= 8;
    }
  }
  flush(): number[] {
    if (this.nbits > 0) {
      this.bytes.push(this.cur & 0xff);
      this.cur = 0;
      this.nbits = 0;
    }
    return this.bytes;
  }
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let dict = new Map<string, number>();
  const reset = (): void => {
    dict = new Map();
    for (let i = 0; i < clear; i++) dict.set(String(i), i);
  };
  reset();
  let next = eoi + 1;
  let codeSize = minCodeSize + 1;
  const bw = new BitWriter();
  bw.write(clear, codeSize);

  let prev = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = prev + ',' + k;
    if (dict.has(combined)) {
      prev = combined;
    } else {
      bw.write(dict.get(prev)!, codeSize);
      dict.set(combined, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
      if (next >= 4096) {
        bw.write(clear, codeSize);
        reset();
        next = eoi + 1;
        codeSize = minCodeSize + 1;
      }
      prev = String(k);
    }
  }
  bw.write(dict.get(prev)!, codeSize);
  bw.write(eoi, codeSize);
  return bw.flush();
}

function pushU16(arr: number[], n: number): void {
  arr.push(n & 0xff, (n >> 8) & 0xff);
}

/** Encode frames into a GIF89a byte array. */
export function encodeGif(
  frames: Uint8Array[],
  w: number,
  h: number,
  table: number[],
  delayCs: number,
): Uint8Array {
  const colorCount = table.length / 3;
  let gctSize = 0;
  while (1 << (gctSize + 1) < colorCount) gctSize++;
  const out: number[] = [];
  // Header + logical screen descriptor.
  for (const ch of 'GIF89a') out.push(ch.charCodeAt(0));
  pushU16(out, w);
  pushU16(out, h);
  out.push(0x80 | (gctSize << 4) | gctSize, 0, 0);
  for (const b of table) out.push(b);
  // Netscape loop extension (infinite).
  out.push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0));
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  const minCodeSize = Math.max(2, gctSize + 1);
  for (const frame of frames) {
    // Graphic control extension (delay, no transparency).
    out.push(0x21, 0xf9, 0x04, 0x00);
    pushU16(out, delayCs);
    out.push(0x00, 0x00);
    // Image descriptor.
    out.push(0x2c);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, w);
    pushU16(out, h);
    out.push(0x00);
    out.push(minCodeSize);
    const data = lzwEncode(frame, minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0x00); // block terminator
  }
  out.push(0x3b); // trailer
  return new Uint8Array(out);
}

/** One-call export: design + reveal → GIF blob. */
export function exportRevealGif(
  map: SeatMap,
  store: DesignStore,
  options: Partial<GifOptions> = {},
): Blob {
  const opts = { ...DEFAULTS, ...options };
  const { frames, w, h, table } = renderRevealFrames(map, store, opts);
  const delayCs = Math.max(2, Math.round(100 / opts.fps));
  const bytes = encodeGif(frames, w, h, table, delayCs);
  return new Blob([bytes as BlobPart], { type: 'image/gif' });
}
