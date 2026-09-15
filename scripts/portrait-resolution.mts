/**
 * Dev-only: why AI portraits arrive as blobs, and what fixes it.
 *   npx tsx scripts/portrait-resolution.mts   → preview-out/portrait/*.png
 *
 * A hero picture on one stand is redrawn with ~333 x 52 cards. Halftone averages
 * BxB cells into one tone, so a fixed cell of 3 left EIGHTEEN rows for a whole
 * face. This drives the REAL quantizer (core/importImage) over a synthetic
 * portrait — a stand-in with a face's tonal structure, since no image generator
 * is reachable from here — and writes what the seats would actually show.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { quantizePixels, halftoneCellFor } from '../src/core/importImage';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../preview-out/portrait');

// A black / white / yellow palette, as the brief asked for. Index 0 = empty seat.
const PALETTE = ['#262a33', '#0a0a0a', '#3a3320', '#8a7300', '#ffd400', '#fff3b0', '#ffffff'];

// ---- a synthetic portrait: the tonal landmarks a face is actually read from ----
const SW = 1536, SH = 640; // what the generator now returns for a stand
function source(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SW * SH * 4);
  const cx = SW / 2, cy = SH * 0.52, rx = SH * 0.40, ry = SH * 0.50;
  const put = (i: number, v: number): void => { px[i] = v; px[i + 1] = v * 0.94; px[i + 2] = v * 0.55; px[i + 3] = 255; };
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      if (d > 1) { put(i, 18); continue; }          // flat background
      let v = 205 - nx * 70;                         // head, lit from the left
      if (ny < -0.62) v = 30;                        // hair mass
      if (ny > -0.66 && ny < -0.44 && Math.abs(nx) < 0.75) v -= 70;   // brow shadow
      for (const ex of [-0.34, 0.34]) {              // eye sockets
        const ed = ((nx - ex) / 0.15) ** 2 + ((ny + 0.30) / 0.10) ** 2;
        if (ed < 1) v = 25;
      }
      if (Math.abs(nx - 0.06) < 0.07 && ny > -0.28 && ny < 0.16) v -= 55; // nose shadow
      if (Math.abs(nx) < 0.30 && ny > 0.30 && ny < 0.42) v = 35;         // mouth
      if (ny > 0.50 && Math.abs(nx) < 0.62) v -= 45;                     // jaw shadow
      if (nx > 0.55) v -= 40;                                            // shadow side
      put(i, Math.max(0, Math.min(255, v)));
    }
  }
  return px;
}

/** Box-resample to the bake grid — what rasterize() does in the browser. */
function resample(src: Uint8ClampedArray, cols: number, rows: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const x0 = Math.floor((x * SW) / cols), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * SW) / cols));
      const y0 = Math.floor((y * SH) / rows), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * SH) / rows));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const p = (yy * SW + xx) * 4; r += src[p]; g += src[p + 1]; b += src[p + 2]; n++;
      }
      const o = (y * cols + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

// ---- minimal PNG writer (no dependency, nearest-neighbour magnified) ----
function png(grid: Int16Array, cols: number, rows: number, zoom: number): Buffer {
  const W = cols * zoom, H = rows * zoom * 3; // x3 vertically: rows are 8px apart, columns 3.2px
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const rgb = PALETTE.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  for (let y = 0; y < H; y++) {
    const off = y * (W * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < W; x++) {
      const idx = grid[Math.floor(y / (zoom * 3)) * cols + Math.floor(x / zoom)];
      const c = rgb[idx < 0 ? 0 : idx];
      raw[off + 1 + x * 3] = c[0]; raw[off + 2 + x * 3] = c[1]; raw[off + 3 + x * 3] = c[2];
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
let TABLE: number[] | null = null;
function crc(buf: Buffer): number {
  if (!TABLE) {
    TABLE = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c; }
  }
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ---- render the same portrait the old way and the new way ----
const COLS = 333, ROWS = 52;
const px = resample(source(), COLS, ROWS);
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const CASES: Array<[string, { dither: boolean; halftone: boolean; halftoneCell?: number }]> = [
  ['1-before-halftone3', { dither: true, halftone: true, halftoneCell: 3 }],
  ['2-after-flat', { dither: false, halftone: false }],
  ['3-dither-only', { dither: true, halftone: false }],
];
console.log(`grid ${COLS} x ${ROWS} cells — one stand, both tiers`);
console.log(`halftoneCellFor(${ROWS}) = ${halftoneCellFor(ROWS)}  (was a hard-coded 3)\n`);
for (const [name, opts] of CASES) {
  const grid = quantizePixels(px, COLS, ROWS, PALETTE, { ...opts, alphaThreshold: 8 });
  // How much of it is detail too fine to hold up: cells whose horizontal run is < 3.
  let fragile = 0;
  for (let y = 0; y < ROWS; y++) {
    let run = 1;
    for (let x = 1; x <= COLS; x++) {
      const same = x < COLS && grid[y * COLS + x] === grid[y * COLS + x - 1];
      if (same) run++;
      else { if (run < 3) fragile += run; run = 1; }
    }
  }
  const tones = new Set(Array.from(grid).filter((v) => v >= 0)).size;
  const effRows = Math.ceil(ROWS / (opts.halftone ? (opts.halftoneCell ?? 3) : 1));
  console.log(`${name.padEnd(20)} tone rows ${String(effRows).padStart(3)}  distinct tones ${tones}  fragile cells ${((fragile / (COLS * ROWS)) * 100).toFixed(1)}%`);
  writeFileSync(`${OUT}/${name}.png`, png(grid, COLS, ROWS, 4));
}
console.log(`\nwrote ${OUT}`);
