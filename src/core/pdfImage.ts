/**
 * A one-page PDF that is one JPEG, edge to edge.
 *
 * The proposal sheet (ui/proProposal.ts) is drawn on a canvas, so that an
 * Arabic line, a club's own font and the pictures all come out exactly as
 * the preview shows them; this wraps that picture in the smallest valid PDF
 * (1.4: a catalog, one page, the image as a DCTDecode XObject, a content
 * stream that draws it over the whole page). No library: the server's PDF
 * writer is not in the browser, and one image needs forty lines.
 */

/** `jpeg` (wPx × hPx) on a page wPt × hPt points (A4 is 595.28 × 841.89). */
export function pdfFromJpeg(jpeg: Uint8Array, wPx: number, hPx: number, wPt: number, hPt: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (b: Uint8Array | string): void => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(bytes);
    at += bytes.length;
  };
  const obj = (n: number, body: string): void => {
    offsets[n] = at;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const w = wPt.toFixed(2);
  const h = hPt.toFixed(2);
  // The second line's high bytes tell a mail filter this is a binary file.
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = at;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  const xref = at;
  let table = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(at);
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}
