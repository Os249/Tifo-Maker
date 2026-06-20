/**
 * Spec compiler — renders a TifoSpec into the seat grid.
 *
 * This is the heart of the AI Designer: it walks a validated spec's layers and
 * paints them into the DesignStore using the engine's existing primitives —
 * region floods (store.paint), and for text/symbols the SAME rasterize →
 * maskFromAlpha → applyGridToSeats path the Text and Image tools use. The whole
 * spec is applied inside ONE store stroke, so a generated tifo is a single
 * undo/redo step and an ordinary, fully-editable design afterwards.
 *
 * Regions map to seats through the seat map's (u, v, tier): stands are quarters
 * of the perimeter `u` (STAND_GEOMETRY), tiers use `tierOf`, and `rows` clip by
 * the row fraction `v`. Text/symbol target rectangles are derived analytically
 * from the stand's u-centre (not from seat x-bounds) so the east stand, which
 * straddles the u=0 seam, places correctly via applyGridToSeats' wrapWidth.
 */

import type { SeatMap } from './types';
import type { DesignStore } from './design';
import type { TifoSpec, SpecLayer, Region, Stand } from './tifoSpec';
import { STAND_GEOMETRY } from './tifoSpec';
import { EDITOR_UNITS } from './seatmap';
import { rasterize, maskFromAlpha, applyGridToSeats } from './importImage';
import { renderTextCanvas, TIFO_FONTS } from './text';
import { drawSymbol } from './symbols';
import { findFragileSeats } from './analysis';

const W = EDITOR_UNITS.width; // 4000 — unrolled perimeter width

export interface CompileResult {
  layersApplied: number;
  seatsPainted: number;
  /** Seats sitting in sub-threshold (likely-illegible) strokes after compile. */
  fragileSeats: number;
  /** Non-fatal problems (e.g. a layer whose region matched no seats). */
  warnings: string[];
}

/** Smallest signed wrap distance between two perimeter fractions, in [-0.5,0.5]. */
function wrapDelta(u: number, c: number): number {
  let d = u - c;
  d -= Math.round(d);
  return d;
}

/**
 * Which quarter-stand a seat's u falls in — matches the engine's `split` pattern
 * convention exactly: floor(((u + 0.125) % 1) * 4) → 0=E, 1=N, 2=W, 3=S. Using
 * the same bucketing makes stands perfectly DISJOINT (every seat belongs to
 * exactly one), so painting "north" then "east" never double-claims the corner.
 */
const STAND_INDEX: Record<Stand, number> = { east: 0, north: 1, west: 2, south: 3 };
function standOf(u: number): number {
  return Math.floor(((u + 0.125) % 1) * 4);
}

/** Build an accept(i) predicate for a region (stand ∧ tier ∧ rows). */
export function regionPredicate(region: Region, map: SeatMap): (i: number) => boolean {
  const standIdx = region.stand === 'all' ? -1 : STAND_INDEX[region.stand as Stand];
  const tier = region.tier;
  const rows = region.rows;
  return (i: number): boolean => {
    if (standIdx >= 0 && standOf(map.uv[i * 2]) !== standIdx) return false;
    if (tier !== 'all' && map.tierOf[i] !== tier) return false;
    if (rows) {
      const v = map.uv[i * 2 + 1];
      if (v < rows[0] - 1e-6 || v > rows[1] + 1e-6) return false;
    }
    return true;
  };
}

/** Analytic horizontal extent (editor units) of a region's stand. */
function standExtent(region: Region): { centerX: number; width: number } {
  if (region.stand === 'all') return { centerX: W / 2, width: W };
  const g = STAND_GEOMETRY[region.stand as Stand];
  return { centerX: g.centerU * W, width: g.halfU * 2 * W };
}

/** Vertical bounds (editor y) of the seats a predicate accepts. */
function yBounds(accept: (i: number) => boolean, map: SeatMap): { minY: number; maxY: number; count: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let i = 0; i < map.count; i++) {
    if (!accept(i)) continue;
    const y = map.xy[i * 2 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    count++;
  }
  return { minY, maxY, count };
}

function fontCssFor(id: string): string {
  return TIFO_FONTS.find((f) => f.id === id)?.css ?? TIFO_FONTS[0].css;
}

/** Stamp a white-on-transparent source canvas as a single-colour mask into seats. */
function stampMask(
  store: DesignStore,
  map: SeatMap,
  source: HTMLCanvasElement,
  rect: { x: number; y: number; width: number; height: number },
  colorIndex: number,
  accept: (i: number) => boolean,
): number {
  const cols = Math.max(2, Math.min(2400, Math.round(rect.width / 3)));
  const rows = Math.max(2, Math.min(400, Math.round(rect.height / 8)));
  const pixels = rasterize(source, cols, rows);
  const grid = maskFromAlpha(pixels, cols, rows, colorIndex);
  return applyGridToSeats(store, map, grid, cols, rows, rect, W, accept).length;
}

/**
 * Apply a whole spec to the store as one undoable stroke. The caller is
 * responsible for repainting (editor.rebuildPalette/repaintAll) afterwards.
 *
 * `clear` (default true) wipes the bowl to empty first, so each generation is a
 * clean, self-contained design and a single undo step that fully replaces the
 * previous one — the basis of non-destructive "regenerate".
 */
export function compileSpec(
  spec: TifoSpec,
  map: SeatMap,
  store: DesignStore,
  opts: { clear?: boolean } = {},
): CompileResult {
  const warnings: string[] = [];
  let seatsPainted = 0;
  let layersApplied = 0;

  store.setPalette(spec.palette);
  store.beginStroke();

  // Start from a clean bowl so leftover seats never show through in the new palette.
  if (opts.clear !== false) {
    for (let i = 0; i < map.count; i++) store.paint(i, 0);
  }

  // Whole-bowl background base (optional).
  if (spec.background !== undefined && spec.background !== null) {
    for (let i = 0; i < map.count; i++) if (store.paint(i, spec.background)) seatsPainted++;
  }

  for (const layer of spec.layers) {
    try {
      const applied = applyLayer(layer, map, store);
      seatsPainted += applied;
      if (applied === 0) warnings.push(`layer "${layer.id}" (${layer.kind}) painted no seats — region may be empty`);
      else layersApplied++;
    } catch (e) {
      warnings.push(`layer "${layer.id}" failed: ${(e as Error).message}`);
    }
  }

  store.commitStroke();
  const fragileSeats = findFragileSeats(store.cells, map).length;
  return { layersApplied, seatsPainted, fragileSeats, warnings };
}

function applyLayer(layer: SpecLayer, map: SeatMap, store: DesignStore): number {
  const accept = regionPredicate(layer.region, map);
  let painted = 0;

  if (layer.kind === 'fill') {
    for (let i = 0; i < map.count; i++) if (accept(i) && store.paint(i, layer.colorIndex)) painted++;
    return painted;
  }

  if (layer.kind === 'stripes') {
    const { stand } = layer.region;
    const g = stand === 'all' ? null : STAND_GEOMETRY[stand as Stand];
    const bands = Math.max(2, layer.bands);
    const cols = layer.colors;
    for (let i = 0; i < map.count; i++) {
      if (!accept(i)) continue;
      const u = map.uv[i * 2];
      const v = map.uv[i * 2 + 1];
      const uLocal = g ? wrapDelta(u, g.centerU) / (2 * g.halfU) + 0.5 : u; // 0..1 across the stand
      let t: number;
      if (layer.orientation === 'horizontal') t = v;
      else if (layer.orientation === 'diagonal') t = (uLocal + v) / 2;
      else t = uLocal;
      const band = Math.min(bands - 1, Math.max(0, Math.floor(t * bands)));
      if (store.paint(i, cols[band % cols.length])) painted++;
    }
    return painted;
  }

  // text / symbol → build a target rect, then stamp a mask.
  const { centerX, width: standW } = standExtent(layer.region);
  const { minY, maxY, count } = yBounds(accept, map);
  if (count === 0 || !isFinite(minY)) return 0;
  const regionH = Math.max(EDITOR_UNITS.rowPx, maxY - minY);
  const centerY = (minY + maxY) / 2;

  if (layer.kind === 'text') {
    const rt = renderTextCanvas(layer.text, fontCssFor(layer.fontId), layer.arcDeg);
    if (!rt) return 0;
    const glyphEditor = layer.heightFrac * regionH;
    const scale = glyphEditor / rt.glyphHeight;
    let rectW = rt.canvas.width * scale;
    let rectH = rt.canvas.height * scale;
    // Keep the headline inside its stand: shrink to fit the available width.
    const maxW = standW * 0.96;
    if (rectW > maxW) {
      const k = maxW / rectW;
      rectW *= k;
      rectH *= k;
    }
    const cy = layer.align === 'top' ? minY + rectH / 2 + regionH * 0.03
      : layer.align === 'bottom' ? maxY - rectH / 2 - regionH * 0.03
      : centerY;
    const rect = { x: centerX - rectW / 2, y: cy - rectH / 2, width: rectW, height: rectH };
    return stampMask(store, map, rt.canvas, rect, layer.colorIndex, accept);
  }

  // symbol — square box sized to a fraction of the region's smaller side.
  const side = Math.max(EDITOR_UNITS.rowPx * 2, layer.scaleFrac * Math.min(standW, regionH));
  const cy = layer.align === 'top' ? minY + side / 2 + regionH * 0.03
    : layer.align === 'bottom' ? maxY - side / 2 - regionH * 0.03
    : centerY;
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  drawSymbol(ctx, layer.symbol, canvas.width, canvas.height);
  const rect = { x: centerX - side / 2, y: cy - side / 2, width: side, height: side };
  return stampMask(store, map, canvas, rect, layer.colorIndex, accept);
}
