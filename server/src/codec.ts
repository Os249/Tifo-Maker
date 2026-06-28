import { gunzipSync, gzipSync } from 'node:zlib';

/** Wire/storage codecs. Typed arrays travel as base64; cells travel gzipped. */

export function gzipBytes(data: Uint8Array): Buffer {
  return gzipSync(data);
}

// Bound decompression so a tiny malicious payload can't balloon to gigabytes
// (zip-bomb DoS). 4 MB ≫ any real stadium's seat bytes; over it, gunzip throws
// (RangeError) and the route returns an error instead of allocating.
const MAX_GUNZIP_BYTES = 4 * 1024 * 1024;
export function gunzipBytes(data: Uint8Array): Buffer {
  return gunzipSync(data, { maxOutputLength: MAX_GUNZIP_BYTES });
}

export function toB64(view: ArrayBufferView): string {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
}

export function u8FromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Copy before viewing as Uint32Array: pooled Buffers are not 4-byte aligned. */
export function u32FromB64(s: string): Uint32Array {
  const raw = Buffer.from(s, 'base64');
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return new Uint32Array(copy.buffer);
}
