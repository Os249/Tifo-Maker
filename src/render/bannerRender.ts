import type { BannerDoc, BannerItem, ImageItem, PatchItem, ShapeItem, StrokeItem, TextItem } from '../core/banner';
import { aspectOf, isPlaced } from '../core/banner';
import { TIFO_FONTS, renderTextCanvas } from '../core/text';
import { drawSymbol } from '../core/symbols';

/**
 * The one banner renderer.
 *
 * Every surface that shows a banner calls `drawBanner` — the artboard on
 * screen, the 2048 px texture the bowl hangs, the A4 print panels, the gallery
 * thumbnail. There is deliberately no second implementation, because the whole
 * promise of the Banner view is that what you draw is what hangs in the
 * stadium, and two renderers are two chances for that to stop being true. It is
 * the same argument `renderObjectCanvas` makes for the seat editor's objects.
 *
 * Coordinates are banner units: x in [0,1] across the width, y in [0,aspect]
 * down. One `scale` multiply puts them in pixels.
 */

// ---------------------------------------------------------------------------
// Async resources
// ---------------------------------------------------------------------------

/**
 * Images are the one thing the display list cannot draw synchronously, and the
 * renderer must stay synchronous (a THREE texture update and a canvas repaint
 * both happen inside a frame). So bitmaps are decoded once into a cache, and a
 * draw that finds one missing kicks off the decode and skips that item; when it
 * lands, `onReady` asks whoever is showing the banner to draw again.
 */
const imgCache = new Map<string, HTMLImageElement | null>();
const readyListeners = new Set<() => void>();

/** Called whenever a bitmap finishes decoding, so the view can repaint. */
export function onBannerImageReady(fn: () => void): () => void {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

function image(src: string): HTMLImageElement | null {
  const hit = imgCache.get(src);
  if (hit !== undefined) return hit;
  imgCache.set(src, null); // in flight — one decode per src, not one per frame
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    imgCache.set(src, img);
    for (const fn of readyListeners) fn();
  };
  img.onerror = () => {
    // Stays null forever: a broken data URL should not retry on every frame.
    for (const fn of readyListeners) fn();
  };
  img.src = src;
  return null;
}

// ---------------------------------------------------------------------------
// Tinted text cache
// ---------------------------------------------------------------------------

/**
 * `renderTextCanvas` paints white on transparent, because on the seat grid
 * colour is a palette index applied at bake time. A banner has real colour, so
 * the white glyphs are tinted through `source-in` and cached — text layout is
 * by far the most expensive thing in a display list and a banner redraws on
 * every pointer move.
 */
const textCache = new Map<string, HTMLCanvasElement>();

function fontCss(fontId: string): string {
  return TIFO_FONTS.find((f) => f.id === fontId)?.css ?? TIFO_FONTS[0].css;
}

function textCanvas(it: TextItem): HTMLCanvasElement | null {
  const key = `${it.text}|${it.fontId}|${it.arcDeg}|${it.color}|${it.outline ?? 0}|${it.outlineColor ?? ''}`;
  const hit = textCache.get(key);
  if (hit) return hit;
  const r = renderTextCanvas(it.text, fontCss(it.fontId), it.arcDeg, 0);
  if (!r) return null;

  const out = document.createElement('canvas');
  const pad = it.outline && it.outline > 0 ? Math.ceil(r.glyphHeight * it.outline * 3) : 0;
  out.width = r.canvas.width + pad * 2;
  out.height = r.canvas.height + pad * 2;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  // The outline is the same glyphs, fattened, painted underneath. Stroking the
  // tinted result would trace the canvas's rectangle, not the letterforms.
  if (pad > 0) {
    const fat = renderTextCanvas(it.text, fontCss(it.fontId), it.arcDeg, pad);
    if (fat) {
      const ox = (out.width - fat.canvas.width) / 2;
      const oy = (out.height - fat.canvas.height) / 2;
      ctx.drawImage(fat.canvas, ox, oy);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = it.outlineColor ?? '#000000';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  const solid = document.createElement('canvas');
  solid.width = r.canvas.width;
  solid.height = r.canvas.height;
  const sctx = solid.getContext('2d');
  if (!sctx) return null;
  sctx.drawImage(r.canvas, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = it.color;
  sctx.fillRect(0, 0, solid.width, solid.height);
  ctx.drawImage(solid, pad, pad);

  if (textCache.size > 240) textCache.clear();
  textCache.set(key, out);
  return out;
}

/** Drop cached glyph bitmaps — call when the display faces finish loading. */
export function invalidateBannerText(): void {
  textCache.clear();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export interface DrawOptions {
  /** Pixels per banner unit (i.e. the banner's on-screen width in px). */
  scale: number;
  /** Skip the background, so the stand shows through in the bowl. */
  noBackground?: boolean;
  /** Draw only up to this item index — used by the "replay my drawing" preview. */
  upTo?: number;
}

/**
 * Replay a banner's display list into a 2D context.
 *
 * The context's origin must already be the banner's top-left corner; nothing
 * here translates. Clipping to the banner's rectangle is the caller's job too,
 * because the artboard wants to show a stroke that runs off the edge (so you
 * can see what you did) while the texture must not.
 */
export function drawBanner(ctx: CanvasRenderingContext2D, doc: BannerDoc, opts: DrawOptions): void {
  const s = opts.scale;
  const aspect = aspectOf(doc);

  if (!opts.noBackground && doc.bg) {
    ctx.fillStyle = doc.bg;
    ctx.fillRect(0, 0, s, s * aspect);
  }

  const end = opts.upTo === undefined ? doc.items.length : Math.min(doc.items.length, opts.upTo);
  for (let i = 0; i < end; i++) {
    const it = doc.items[i];
    if (it.hidden) continue;
    drawItem(ctx, it, s, aspect);
  }
}

function drawItem(ctx: CanvasRenderingContext2D, it: BannerItem, s: number, aspect: number): void {
  switch (it.kind) {
    case 'fill':
      ctx.save();
      ctx.fillStyle = it.color;
      ctx.fillRect(0, 0, s, s * aspect);
      ctx.restore();
      return;
    case 'stroke':
      drawStroke(ctx, it, s);
      return;
    case 'patch':
      drawPatch(ctx, it, s);
      return;
    case 'text':
    case 'shape':
    case 'image':
      drawPlaced(ctx, it, s);
      return;
  }
}

/**
 * A stroke, smoothed.
 *
 * Pointer samples are a ragged polyline: drawing them with `lineTo` gives you
 * visible corners at every sample, which is exactly the "it looks like pixel
 * art" complaint. Each segment is therefore a quadratic through the midpoints
 * of consecutive samples, with the sample itself as the control point — the
 * standard freehand curve. It is C1-continuous, needs no lookahead (so it can
 * be drawn live while the finger is still moving) and costs one curve per
 * sample.
 */
export function strokePath(ctx: CanvasRenderingContext2D, pts: number[], s: number): void {
  const n = pts.length / 2;
  if (n === 0) return;
  ctx.beginPath();
  if (n === 1) {
    ctx.moveTo(pts[0] * s, pts[1] * s);
    ctx.lineTo(pts[0] * s + 0.01, pts[1] * s);
    return;
  }
  ctx.moveTo(pts[0] * s, pts[1] * s);
  if (n === 2) {
    ctx.lineTo(pts[2] * s, pts[3] * s);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i * 2] * s;
    const cy = pts[i * 2 + 1] * s;
    const mx = ((pts[i * 2] + pts[i * 2 + 2]) / 2) * s;
    const my = ((pts[i * 2 + 1] + pts[i * 2 + 3]) / 2) * s;
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  ctx.lineTo(pts[(n - 1) * 2] * s, pts[(n - 1) * 2 + 1] * s);
}

function drawStroke(ctx: CanvasRenderingContext2D, it: StrokeItem, s: number): void {
  if (it.pts.length < 2) return;
  ctx.save();
  if (it.erase) ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = it.color;
  ctx.lineWidth = Math.max(0.6, it.width * s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokePath(ctx, it.pts, s);
  ctx.stroke();
  ctx.restore();
}

function drawPatch(ctx: CanvasRenderingContext2D, it: PatchItem, s: number): void {
  const img = image(it.src);
  if (!img) return;
  ctx.drawImage(img, it.x * s, it.y * s, it.w * s, it.h * s);
}

function drawPlaced(ctx: CanvasRenderingContext2D, it: TextItem | ShapeItem | ImageItem, s: number): void {
  const w = it.w * s;
  const h = it.h * s;
  if (w < 0.5 || h < 0.5) return;
  ctx.save();
  ctx.translate(it.cx * s, it.cy * s);
  if (it.rot) ctx.rotate((it.rot * Math.PI) / 180);

  if (it.kind === 'image') {
    const img = image(it.src);
    if (img) {
      ctx.globalAlpha = it.opacity ?? 1;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
  } else if (it.kind === 'text') {
    const c = textCanvas(it);
    if (c) ctx.drawImage(c, -w / 2, -h / 2, w, h);
  } else {
    // Shapes are drawn into their own box in the current fill style — the same
    // `drawSymbol` catalogue the seat editor stamps, so the two views offer one
    // set of shapes rather than two that drift.
    if (it.outline && it.outline > 0) {
      const g = it.outline * s * 2;
      ctx.fillStyle = it.outlineColor ?? '#000000';
      ctx.save();
      ctx.translate(-w / 2 - g / 2, -h / 2 - g / 2);
      drawSymbol(ctx, it.shape, w + g, h + g);
      ctx.restore();
    }
    ctx.fillStyle = it.color;
    ctx.translate(-w / 2, -h / 2);
    drawSymbol(ctx, it.shape, w, h);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Offscreen renders
// ---------------------------------------------------------------------------

/**
 * The perforation of a mesh banner, as a real hole pattern.
 *
 * Mesh is specified at a 70/30 or 60/40 print-to-hole ratio, and 25-40% open
 * area is the whole reason a large banner can be flown at all. Rendering it as
 * "slightly transparent" would be a lie in the direction that matters: you are
 * supposed to be able to SEE the stand through it, and thin type is supposed to
 * visibly suffer. So the holes are punched out of the texture's alpha and the
 * material alpha-tests them.
 */
function punchMesh(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // ~1.6 mm holes on a ~2.6 mm pitch is far below texture resolution, so the
  // pattern is scaled to something a texel can hold while keeping the open-area
  // fraction (~34%) honest.
  const pitch = Math.max(3, Math.round(Math.min(w, h) / 320));
  const r = pitch * 0.33;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (let y = 0; y < h; y += pitch) {
    for (let x = (y / pitch) % 2 === 0 ? 0 : pitch / 2; x < w; x += pitch) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export interface OffscreenOptions {
  /** Longest edge in pixels. 2048 is the bowl's texture budget. */
  maxEdge?: number;
  /** Punch the perforation for a mesh banner. Off for the flat artboard. */
  perforate?: boolean;
  /** Force a background even on a transparent banner (thumbnails want one). */
  background?: string | null;
  /** Grow the long edge until the short one has at least this many pixels. */
  minShortEdge?: number;
}

/**
 * Render a banner to its own canvas.
 *
 * Resolution follows the research rather than a guess: large printed flags need
 * only ~15 px per inch at final size, so a 24 m banner is honestly served by a
 * couple of thousand pixels. 2048 on the long edge is both the texture budget
 * and comfortably above what the fabric can hold.
 */
export function bannerToCanvas(doc: BannerDoc, opts: OffscreenOptions = {}): HTMLCanvasElement {
  const aspect = aspectOf(doc);
  // A strip needs pixels across its SHORT side too. A fascia banner is fifteen
  // or twenty times wider than it is deep, and at a fixed long edge its
  // lettering came out forty pixels tall — a smear from anywhere in the
  // ground. The long edge grows until the short one has enough, up to the
  // largest texture every GPU takes.
  const ratio = aspect >= 1 ? aspect : 1 / aspect;
  const maxEdge = Math.min(4096, Math.max(opts.maxEdge ?? 2048, (opts.minShortEdge ?? 0) * ratio));
  const w = aspect >= 1 ? Math.round(maxEdge / aspect) : maxEdge;
  const h = aspect >= 1 ? maxEdge : Math.round(maxEdge * aspect);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, w);
  canvas.height = Math.max(2, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawBanner(ctx, doc, { scale: canvas.width });
  if (opts.perforate && doc.material === 'mesh') punchMesh(ctx, canvas.width, canvas.height);
  return canvas;
}

/** A banner as a data URL, for thumbnails and for the print-panel path. */
export function bannerToDataUrl(doc: BannerDoc, maxEdge = 1024): string {
  return bannerToCanvas(doc, { maxEdge }).toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** Axis-aligned bounds of an item in banner units, or null for a full-bleed fill. */
export function itemBounds(it: BannerItem): { x: number; y: number; w: number; h: number } | null {
  if (it.kind === 'fill') return null;
  if (it.kind === 'patch') return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.kind === 'stroke') {
    if (it.pts.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < it.pts.length; i += 2) {
      if (it.pts[i] < minX) minX = it.pts[i];
      if (it.pts[i] > maxX) maxX = it.pts[i];
      if (it.pts[i + 1] < minY) minY = it.pts[i + 1];
      if (it.pts[i + 1] > maxY) maxY = it.pts[i + 1];
    }
    const r = it.width / 2;
    return { x: minX - r, y: minY - r, w: maxX - minX + it.width, h: maxY - minY + it.width };
  }
  // A rotated box's bounds are the rotated corners' extent.
  const rad = ((it.rot ?? 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const w = it.w * c + it.h * s;
  const h = it.w * s + it.h * c;
  return { x: it.cx - w / 2, y: it.cy - h / 2, w, h };
}

/** Squared distance from a point to a segment, in banner units. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

/**
 * The topmost item under a point, or null.
 *
 * Strokes are hit by distance to the polyline rather than by their bounding
 * box: a long diagonal stroke has a huge box that is almost entirely empty, and
 * selecting it by clicking a metre away from the ink is maddening. `slop` is
 * the pointer's forgiveness in banner units — the caller converts pixels, so a
 * touch gets a fatter target than a mouse without this function knowing why.
 */
export function hitTest(doc: BannerDoc, x: number, y: number, slop: number): BannerItem | null {
  for (let i = doc.items.length - 1; i >= 0; i--) {
    const it = doc.items[i];
    if (it.hidden || it.kind === 'fill') continue;
    if (it.kind === 'stroke') {
      const r = it.width / 2 + slop;
      const r2 = r * r;
      for (let k = 0; k + 3 < it.pts.length; k += 2) {
        if (segDist2(x, y, it.pts[k], it.pts[k + 1], it.pts[k + 2], it.pts[k + 3]) <= r2) return it;
      }
      if (it.pts.length === 2 && (x - it.pts[0]) ** 2 + (y - it.pts[1]) ** 2 <= r2) return it;
      continue;
    }
    if (isPlaced(it)) {
      // Test in the item's own frame so a rotated box is not over-generous.
      const rad = (-(it.rot ?? 0) * Math.PI) / 180;
      const dx = x - it.cx;
      const dy = y - it.cy;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(lx) <= it.w / 2 + slop && Math.abs(ly) <= it.h / 2 + slop) return it;
      continue;
    }
    const b = itemBounds(it);
    if (b && x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop) return it;
  }
  return null;
}
