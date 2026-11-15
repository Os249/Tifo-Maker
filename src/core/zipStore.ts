/**
 * A ZIP file of stored (uncompressed) entries: all a set of PNGs needs, since
 * a PNG is already compressed. Written here in sixty lines rather than taken
 * from a library: the designer pack (ui/proPack.ts) is its only user, and it
 * hands over five pictures.
 *
 * Plain ZIP 2.0: no ZIP64 (the whole file must stay under 4 GB and 65,535
 * entries, far beyond what a pack holds), names in UTF-8 (general purpose
 * bit 11), so an Arabic project name opens right on Windows, macOS and phones.
 */

let table: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3), as ZIP and PNG use it. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** The file's name inside the ZIP; "/" makes folders. */
  name: string;
  data: Uint8Array;
}

/** The ZIP's bytes. `at` is the entries' date (now by default). */
export function zipStore(files: readonly ZipEntry[], at: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = ((at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)) & 0xffff;
  const date = ((Math.max(0, at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: f.data, crc: crc32(f.data), offset: 0 }));
  const bodySize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const dirSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(bodySize + dirSize + 22);
  const v = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    e.offset = p;
    v.setUint32(p, 0x04034b50, true);
    v.setUint16(p + 4, 20, true); // version needed: 2.0
    v.setUint16(p + 6, 0x0800, true); // names are UTF-8
    v.setUint16(p + 8, 0, true); // stored
    v.setUint16(p + 10, time, true);
    v.setUint16(p + 12, date, true);
    v.setUint32(p + 14, e.crc, true);
    v.setUint32(p + 18, e.data.length, true);
    v.setUint32(p + 22, e.data.length, true);
    v.setUint16(p + 26, e.name.length, true);
    v.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }
  const dirAt = p;
  for (const e of entries) {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, 20, true); // made by
    v.setUint16(p + 6, 20, true); // needed
    v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, time, true);
    v.setUint16(p + 14, date, true);
    v.setUint32(p + 16, e.crc, true);
    v.setUint32(p + 20, e.data.length, true);
    v.setUint32(p + 24, e.data.length, true);
    v.setUint16(p + 28, e.name.length, true);
    // extra, comment, disk, internal and external attributes: none
    v.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, entries.length, true);
  v.setUint16(p + 10, entries.length, true);
  v.setUint32(p + 12, dirSize, true);
  v.setUint32(p + 16, dirAt, true);
  return out;
}
