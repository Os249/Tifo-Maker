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
 *   3. Fix contrast — any text/symbol whose colour is too close to the field it
 *      sits on is recoloured to the most-contrasting card in the palette.
 *
 * Pure and DOM-free, so it runs in the server endpoint and in the test harness.
 */

import type { TifoSpec, SpecLayer, Region } from './tifoSpec';

const MIN_TEXT_HEIGHT = 0.1;
const MIN_SYMBOL_SCALE = 0.15;
const CONTRAST_FLOOR = 55; // luminance gap (0–255) below which a layer is hard to read

function lum(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
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
  const fl = lum(palette[field] ?? '#262a33');
  let best = field;
  let bestD = -1;
  for (let i = 1; i < palette.length; i++) {
    const d = Math.abs(lum(palette[i]) - fl);
    if (d > bestD) { bestD = d; best = i; }
  }
  return best;
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
      const field = fieldUnder(layers, i, background);
      if (Math.abs(lum(palette[l.colorIndex] ?? '#262a33') - lum(palette[field] ?? '#262a33')) < CONTRAST_FLOOR) {
        l.colorIndex = mostContrasting(palette, field);
      }
    } else if (l.kind === 'symbol') {
      if (l.scaleFrac < MIN_SYMBOL_SCALE) l.scaleFrac = MIN_SYMBOL_SCALE;
      const field = fieldUnder(layers, i, background);
      if (Math.abs(lum(palette[l.colorIndex] ?? '#262a33') - lum(palette[field] ?? '#262a33')) < CONTRAST_FLOOR) {
        l.colorIndex = mostContrasting(palette, field);
      }
    }
  }

  return { ...spec, background, layers };
}
