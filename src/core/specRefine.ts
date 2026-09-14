/**
 * Spec refinement — the deterministic "art director" critique/repair pass.
 *
 * Phase 4 of the AI rebuild. After a spec is produced (by the model OR the
 * offline designer) and validated, it runs through refineSpec() before delivery.
 * The compiler is browser-side (canvas), so this pass works at the SPEC level —
 * it can't count fragile seats, but it fixes the mistakes that most often make
 * AI tifos illegible or generic, with simple, reliable, deterministic rules:
 *
 *   1. Guarantee a field — pure text/symbol designs on empty seats get a dark
 *      background so the art reads against something.
 *   2. Enforce minimum readable sizes — stadium text/symbols below a floor are
 *      bumped up (thin strokes die under a ~10% no-show rate).
 *   3. Fix contrast — any text/symbol below a 3:1 WCAG ratio against the field
 *      it sits on is recoloured to the most-contrasting card in the palette.
 *      The backing half of an outlined or shadowed headline is exempt: it is
 *      *supposed* to sit close to the field, and repairing it erases the effect.
 *
 * Pure and DOM-free, so it runs in the server endpoint and in the test harness.
 */

import type { TifoSpec, SpecLayer, Region } from './tifoSpec';

// Boldness floors — stadium tifos are seen from 100m+ and on TV, so timid sizing
// reads as thin/scattered. Keep these high: it's better to be too big than too small.
const MIN_TEXT_HEIGHT = 0.22; // a headline below ~22% of its stand's height looks weak
const MIN_SYMBOL_SCALE = 0.45; // a crest/symbol should dominate its stand
/**
 * Minimum contrast between a layer and the field behind it, as a WCAG ratio.
 * 3:1 is the large-text threshold, and it is also where the outdoor-advertising
 * rule of thumb lands: below it two colours stop separating at distance, however
 * different their hues look in a swatch row.
 */
const MIN_CONTRAST = 3;

function lum(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
}

/** WCAG relative luminance (0..1). */
function relLum(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const ch = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((v >> 16) & 255) + 0.7152 * ch((v >> 8) & 255) + 0.0722 * ch(v & 255);
}

/** WCAG contrast ratio between two hex colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when two palette entries are far enough apart to read as different. */
function separates(palette: string[], a: number, b: number): boolean {
  return contrastRatio(palette[a] ?? '#262a33', palette[b] ?? '#262a33') >= MIN_CONTRAST;
}

/** Darkest non-empty palette index — the natural "field" for an ultras display. */
function darkestIndex(palette: string[]): number {
  let best = 1;
  let bestL = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const l = lum(palette[i]);
    if (l < bestL) { bestL = l; best = i; }
  }
  return best;
}

/** The real-card index (1..n) whose colour contrasts most with `field`. */
function mostContrasting(palette: string[], field: number): number {
  const fc = palette[field] ?? '#262a33';
  let best = field;
  let bestR = -1;
  for (let i = 1; i < palette.length; i++) {
    const r = contrastRatio(palette[i], fc);
    if (r > bestR) { bestR = r; best = i; }
  }
  return best;
}

/**
 * True when `i` is the backing half of an outlined or shadowed headline: the
 * layer immediately after it draws the same words in the same place, so this one
 * is the fattened/offset copy underneath.
 *
 * Backing layers are exempt from contrast repair. Their job is to separate the
 * top copy from the field, which usually means deliberately sharing the field's
 * value — repairing them to "most contrasting" would recolour them to match the
 * copy on top and erase the effect entirely.
 */
function isBacking(layers: SpecLayer[], i: number): boolean {
  const a = layers[i];
  const b = layers[i + 1];
  if (!b || a.kind !== 'text' || b.kind !== 'text') return false;
  if (a.text !== b.text || JSON.stringify(a.region) !== JSON.stringify(b.region)) return false;
  return (a.outline ?? 0) > 0 || (a.dx ?? 0) !== 0 || (a.dy ?? 0) !== 0;
}

function sameStand(a: Region, b: Region): boolean {
  return a.stand === 'all' || b.stand === 'all' || a.stand === b.stand;
}

/**
 * The palette index of the field a layer sits on: the last fill/gradient/pattern/
 * stripes layer below it that covers the same stand, else the background, else
 * empty (0). Approximate, but enough to catch "same colour on same colour".
 */
function fieldUnder(layers: SpecLayer[], idx: number, background: number | undefined): number {
  let field = background ?? 0;
  const here = layers[idx].region;
  for (let j = 0; j < idx; j++) {
    const L = layers[j];
    if (L.kind === 'fill' || L.kind === 'gradient' || L.kind === 'pattern' || L.kind === 'stripes') {
      if (sameStand(L.region, here)) field = L.kind === 'fill' ? L.colorIndex : L.colors[0];
    }
  }
  return field;
}

/** Deterministically improve a validated spec's legibility before rendering. */
export function refineSpec(spec: TifoSpec): TifoSpec {
  const palette = spec.palette;
  const layers = spec.layers.map((l) => ({ ...l })) as SpecLayer[];
  let background = spec.background;

  // 1) Guarantee a field for art-only designs.
  const hasField = layers.some(
    (l) => l.kind === 'fill' || l.kind === 'gradient' || l.kind === 'pattern' || l.kind === 'stripes',
  );
  if (background === undefined && !hasField && layers.length > 0 && palette.length > 1) {
    background = darkestIndex(palette);
  }

  // 2 + 3) Per-layer minimum size + contrast repair.
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.kind === 'text') {
      if (l.heightFrac < MIN_TEXT_HEIGHT) l.heightFrac = MIN_TEXT_HEIGHT;
      if (isBacking(layers, i)) continue;
      const field = fieldUnder(layers, i, background);
      if (!separates(palette, l.colorIndex, field)) l.colorIndex = mostContrasting(palette, field);
    } else if (l.kind === 'symbol') {
      if (l.scaleFrac < MIN_SYMBOL_SCALE) l.scaleFrac = MIN_SYMBOL_SCALE;
      const field = fieldUnder(layers, i, background);
      if (!separates(palette, l.colorIndex, field)) l.colorIndex = mostContrasting(palette, field);
    }
  }

  return { ...spec, background, layers };
}
