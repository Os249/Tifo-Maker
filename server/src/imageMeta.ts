/**
 * What a match-day photo is, and a copy of it without the metadata.
 *
 * Phones write the place a picture was taken into the file (EXIF GPS), along
 * with the device, the time and sometimes the owner's name. The browser client
 * re-encodes photos through a canvas, which drops all of that, but the server
 * stored whatever bytes arrived. An upload made straight to the API kept its
 * GPS position, and anyone viewing the public design could download it: where
 * a supporter was, or lives. The server now removes metadata itself, and it
 * refuses anything that is not a JPEG, PNG or WebP, so the photo store cannot
 * be used to host arbitrary files on this domain either.
 *
 * Pure byte surgery, no image decoding and no dependencies: metadata lives in
 * clearly delimited segments or chunks in all three formats, so dropping them
 * leaves the pixels untouched. Anything that does not parse is refused rather
 * than stored unstripped.
 */

export type ImageKind = 'jpeg' | 'png' | 'webp';

export function sniffImage(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/** The same image with metadata removed, or null when it is not one we accept. */
export function stripImageMetadata(input: Uint8Array): Buffer | null {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  switch (sniffImage(buf)) {
    case 'jpeg': return stripJpeg(buf);
    case 'png': return stripPng(buf);
    case 'webp': return stripWebp(buf);
    default: return null;
  }
}

function ascii(buf: Uint8Array, at: number, len: number): string {
  let out = '';
  for (let i = at; i < at + len && i < buf.length; i++) out += String.fromCharCode(buf[i]);
  return out;
}

/**
 * JPEG: keep APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe, needed to
 * decode CMYK files correctly); drop APP1 (EXIF and XMP), APP3–APP13 (IPTC,
 * Photoshop, camera maker blocks), APP15 and comments. Scan data is copied as is,
 * and segments between progressive scans are filtered the same way.
 */
function stripJpeg(buf: Buffer): Buffer | null {
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  const len = buf.length;
  while (i < len) {
    if (buf[i] !== 0xff) return null;
    while (i + 1 < len && buf[i + 1] === 0xff) i++; // fill bytes
    if (i + 1 >= len) return null;
    const marker = buf[i + 1];
    if (marker === 0xd9) { // EOI
      out.push(buf.subarray(i, i + 2));
      return Buffer.concat(out);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { // standalone markers
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > len) return null;
    const segLen = buf.readUInt16BE(i + 2);
    const end = i + 2 + segLen;
    if (segLen < 2 || end > len) return null;
    if (marker === 0xda) { // SOS: header, then entropy-coded data up to the next real marker
      let j = end;
      while (j + 1 < len) {
        if (buf[j] === 0xff) {
          const next = buf[j + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        j++;
      }
      if (j + 1 >= len) {
        // A file that stops in the middle of its scan data. Browsers show what
        // is there; keep it, with metadata already gone from before the scan.
        out.push(buf.subarray(i));
        return Buffer.concat(out);
      }
      out.push(buf.subarray(i, j));
      i = j;
      continue;
    }
    const isMetadata =
      marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!isMetadata) out.push(buf.subarray(i, end));
    i = end;
  }
  return null; // no EOI
}

/** PNG: drop text, EXIF and timestamp chunks; everything that draws is kept. */
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
function stripPng(buf: Buffer): Buffer | null {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = ascii(buf, i + 4, 4);
    const end = i + 12 + length;
    if (end > buf.length) return null;
    if (!PNG_METADATA.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return null; // no IEND
}

/** WebP: drop the EXIF and XMP chunks, and clear their flags in VP8X. */
function stripWebp(buf: Buffer): Buffer | null {
  const chunks: Buffer[] = [];
  let i = 12;
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  while (i + 8 <= riffEnd) {
    const fourcc = ascii(buf, i, 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > riffEnd) return null;
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = Buffer.from(buf.subarray(i, Math.min(end, riffEnd)));
      if (fourcc === 'VP8X' && size >= 1) chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
      chunks.push(chunk);
    }
    i = end;
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}
