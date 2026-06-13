/**
 * Text tool: render a string with a real font to an offscreen canvas, then the
 * importer pipeline (rasterize → alpha mask → applyGridToSeats) maps it onto
 * seats. "Pixel" size in the UI = seats of height: the canvas is contain-fit so
 * that the GLYPH height equals heightSeats × ROW_PX editor units — arc bow adds
 * extent without shrinking the letters.
 *
 * `arcLayout` is pure (per-character positions/rotations along a circular arc)
 * and unit-tested in Node; `renderTextCanvas` is the browser-only painter.
 */

export interface TifoFont {
  id: string;
  name: string;
  css: string;
}

export const TIFO_FONTS: TifoFont[] = [
  { id: 'impact', name: 'Impact', css: 'Impact, "Arial Black", sans-serif' },
  { id: 'black', name: 'Arial Black', css: '"Arial Black", Arial, sans-serif' },
  { id: 'verdana', name: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
  { id: 'georgia', name: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { id: 'courier', name: 'Courier', css: '"Courier New", Courier, monospace' },
];

export interface ArcGlyph {
  /** Glyph center in canvas coordinates. */
  x: number;
  y: number;
  /** Rotation in radians (canvas clockwise-positive). */
  rotation: number;
}

export interface ArcLayoutResult {
  glyphs: ArcGlyph[];
  width: number;
  height: number;
}

/**
 * Lay character centers along a circular arc whose LENGTH equals the summed
 * advance widths, so letter spacing is preserved at any bend.
 * theta > 0 arches up (ends lower in canvas-down coordinates, middle highest);
 * theta < 0 bows down. |theta| is the total angular sweep in radians.
 */
export function arcLayout(widths: number[], glyphH: number, theta: number): ArcLayoutResult {
  const total = widths.reduce((a, b) => a + b, 0);
  const margin = glyphH * 0.75;
  const radius = total / Math.abs(theta);
  const dir = Math.sign(theta);
  const half = Math.abs(theta) / 2;
  const bow = radius * (1 - Math.cos(half));
  const chord = 2 * radius * Math.sin(half);
  const width = chord + 2 * margin;
  const height = bow + 2 * margin;
  // Canvas-space y of the arc's extreme: arch-up keeps the middle at the top.
  const yShift = dir > 0 ? margin : margin + bow;

  const glyphs: ArcGlyph[] = [];
  let advance = 0;
  for (const w of widths) {
    const s = advance + w / 2;
    advance += w;
    const phi = (s / total - 0.5) * theta;
    glyphs.push({
      x: width / 2 + radius * Math.sin(phi),
      y: yShift + dir * radius * (1 - Math.cos(phi)),
      rotation: phi,
    });
  }
  return { glyphs, width, height };
}

export interface RenderedText {
  canvas: HTMLCanvasElement;
  /** Pixel height of the letterforms (ascent + descent) — the sizing anchor. */
  glyphHeight: number;
}

/** White-on-transparent text; straight or arched by arcDeg (±170°). */
export function renderTextCanvas(text: string, fontCss: string, arcDeg = 0): RenderedText | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const px = 128;
  const font = `bold ${px}px ${fontCss}`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const m = probe.measureText(trimmed);
  const ascent = m.actualBoundingBoxAscent || px * 0.8;
  const descent = m.actualBoundingBoxDescent || px * 0.24;
  const glyphHeight = ascent + descent;
  const clamped = Math.max(-170, Math.min(170, arcDeg));

  if (Math.abs(clamped) < 2) {
    const pad = 6;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.ceil(m.width) + pad * 2);
    canvas.height = Math.max(2, Math.ceil(glyphHeight) + pad * 2);
    const ctx = canvas.getContext('2d')!;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(trimmed, pad, pad + ascent);
    return { canvas, glyphHeight };
  }

  // Per-glyph arcing only works for scripts where characters are independent
  // (Latin, etc.). Cursive/connected and right-to-left scripts — Arabic, Hebrew,
  // Indic — lose their shaping and direction if split into code points and drawn
  // one at a time. For those we shape the WHOLE string once (letting the browser's
  // text engine do joining + bidi), then bend the resulting pixels along the arc
  // as vertical slices. This preserves correct text for any script.
  if (needsWholeStringShaping(trimmed)) {
    return arcByWarp(trimmed, font, ascent, glyphHeight, (clamped * Math.PI) / 180);
  }

  const chars = [...trimmed];
  const widths = chars.map((ch) => Math.max(1, probe.measureText(ch).width));
  const layout = arcLayout(widths, glyphHeight, (clamped * Math.PI) / 180);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.ceil(layout.width));
  canvas.height = Math.max(2, Math.ceil(layout.height));
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < chars.length; i++) {
    const g = layout.glyphs[i];
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rotation);
    // Baseline sits (ascent − descent)/2 below the glyph's vertical center.
    ctx.fillText(chars[i], -widths[i] / 2, (ascent - descent) / 2);
    ctx.restore();
  }
  return { canvas, glyphHeight };
}

/** True for scripts that must be shaped as a whole string (RTL or cursive-joining). */
export function needsWholeStringShaping(text: string): boolean {
  // Arabic (incl. supplements/presentation forms), Hebrew, Syriac, Thaana,
  // and the major Indic blocks where per-glyph splitting breaks conjuncts.
  return /[\u0590-\u085F\u0700-\u074F\u0900-\u0DFF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/**
 * Bend an already-shaped text run along a circular arc by slicing the flat
 * rendering into thin vertical columns and rotating each to its arc position.
 * Shaping and bidi are handled by the single fillText of the whole string, so
 * Arabic/Hebrew/Indic come out correct; we only move pixels, never re-order them.
 */
function arcByWarp(
  text: string,
  font: string,
  ascent: number,
  glyphH: number,
  theta: number,
): RenderedText {
  const pad = 4;
  const flat = document.createElement('canvas');
  const fctx = flat.getContext('2d')!;
  fctx.font = font;
  const flatW = Math.ceil(fctx.measureText(text).width) + pad * 2;
  const flatH = Math.ceil(glyphH) + pad * 2;
  flat.width = flatW;
  flat.height = flatH;
  fctx.font = font;
  fctx.textBaseline = 'alphabetic';
  fctx.fillStyle = '#ffffff';
  fctx.fillText(text, pad, pad + ascent);

  const total = flatW;
  const radius = total / Math.abs(theta);
  const dir = Math.sign(theta);
  const half = Math.abs(theta) / 2;
  const bow = radius * (1 - Math.cos(half));
  const chord = 2 * radius * Math.sin(half);
  const margin = glyphH * 0.75;
  const outW = Math.ceil(chord + 2 * margin);
  const outH = Math.ceil(bow + glyphH + 2 * margin);
  const out = document.createElement('canvas');
  out.width = Math.max(2, outW);
  out.height = Math.max(2, outH);
  const octx = out.getContext('2d')!;
  const cx = out.width / 2;
  const yShift = dir > 0 ? margin + glyphH / 2 : margin + bow + glyphH / 2;

  // Slice width in source px; 2px keeps seams invisible at seat density.
  const step = 2;
  for (let sx = 0; sx < flatW; sx += step) {
    const s = sx + step / 2;
    const phi = (s / total - 0.5) * theta;
    octx.save();
    octx.translate(cx + radius * Math.sin(phi), yShift + dir * radius * (1 - Math.cos(phi)));
    octx.rotate(phi);
    octx.drawImage(flat, sx, 0, step, flatH, -step / 2, -flatH / 2, step + 0.5, flatH);
    octx.restore();
  }
  return { canvas: out, glyphHeight: glyphH };
}
