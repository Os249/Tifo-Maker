/**
 * Minimal indexed-PNG encoder (no dependencies).
 *
 * The template strips are flat-coloured pictures of at most a dozen palette
 * entries, which is the one case where a hand-rolled encoder beats a general
 * image library: we already KNOW the palette, so there is no quantiser to
 * second-guess us, and at <=16 colours the pixels pack two to a byte.
 */
import { deflateSync } from 'node:zlib';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Pick the row filter with the smallest absolute-sum, as libpng does. */
function filterRows(raw: Buffer, height: number, stride: number, bpp: number): Buffer {
  const out = Buffer.alloc(height * (stride + 1));
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    let bestType = 0, bestScore = Infinity, best: Buffer = row;
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= bpp ? prev[x - bpp] : 0;
        let v: number;
        if (f === 0) v = row[x];
        else if (f === 1) v = row[x] - a;
        else if (f === 2) v = row[x] - b;
        else if (f === 3) v = row[x] - ((a + b) >> 1);
        else {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = row[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 255;
        cand[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestType = f; best = Buffer.from(cand); }
    }
    out[y * (stride + 1)] = bestType;
    best.copy(out, y * (stride + 1) + 1);
  }
  return out;
}

/**
 * Encode an indexed image. `indices` is one byte per pixel (row-major);
 * `palette` is a list of [r,g,b]. Uses 4-bit packing when it fits.
 */
export function encodeIndexedPng(
  indices: Uint8Array, width: number, height: number, palette: [number, number, number][],
): Buffer {
  const depth = palette.length <= 16 ? 4 : 8;
  const stride = depth === 4 ? (width + 1) >> 1 : width;
  const raw = Buffer.alloc(height * stride);
  if (depth === 4) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = indices[y * width + x] & 15;
        const p = y * stride + (x >> 1);
        raw[p] |= x & 1 ? v : v << 4;
      }
    }
  } else {
    for (let i = 0; i < width * height; i++) raw[i] = indices[i];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(([r, g, b], i) => { plte[i * 3] = r; plte[i * 3 + 1] = g; plte[i * 3 + 2] = b; });

  const idat = deflateSync(filterRows(raw, height, stride, Math.max(1, depth >> 3)), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
