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

import type { TifoSpec, SpecLayer, Region, Stand } from './tifoSpec';
import { STAND_ORDER } from './tifoSpec';

// Boldness floors — stadium tifos are seen from 100m+ and on TV, so timid sizing
// reads as thin/scattered. Keep these high: it's better to be too big than too small.
const MIN_TEXT_HEIGHT = 0.22; // a headline below ~22% of its stand's height looks weak
/**
 * Arabic needs far more height than Latin, and this is measured, not guessed:
 * scripts/arabic-legibility.mts renders a headline on the real seat map and
 * counts how much of it lands in strokes too fine to hold up.
 *
 *                        h=0.22   h=0.40   h=0.55   h=0.85
 *   "CHAMPIONS"              2%       1%       1%       1%
 *   "هدفنا أفريقيا"         45%      26%      13%      13%
 *   ...on ONE tier:
 *   "CHAMPIONS"             10%       4%       2%       1%
 *   "نادي القرن"           100%      70%      32%      19%
 *
 * At the Latin floor an Arabic headline is 20x more fragile, and on a single
 * tier it is 100% fragile — not "small", nothing in it resolves at all. Arabic
 * carries dots and thin connecting strokes that Latin capitals do not.
 *
 * Raising the floor is safe: heightFrac is a CEILING, and the renderer shrinks
 * text to fit its stand, so a bigger number can never overflow — it only stops
 * the design asking for something smaller than the seats can draw.
 *
 * Past ~0.55 height stops buying anything (13%, 13%, 13%): the text is
 * aspect-locked and width becomes binding. The only lever left there is fewer
 * words, which is why the prompts push the phrase length so hard.
 */
const MIN_TEXT_HEIGHT_ARABIC = 0.55;
/** One tier is half the rows, so Arabic there needs everything it can get. */
const MIN_TEXT_HEIGHT_ARABIC_ONE_TIER = 0.8;
const MIN_SYMBOL_SCALE = 0.45; // a crest/symbol should dominate its stand

/** Arabic, Persian and Urdu ranges, plus the presentation forms. */
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** The smallest height this headline can be drawn at and still read. */
function minHeightFor(text: string, region: Region): number {
  if (!ARABIC_RE.test(text)) return MIN_TEXT_HEIGHT;
  return region.tier === 'all' ? MIN_TEXT_HEIGHT_ARABIC : MIN_TEXT_HEIGHT_ARABIC_ONE_TIER;
}
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

/** The stands a region covers (all four for a whole-bowl region). */
function standsOf(r: Region): Stand[] {
  if (r.stands && r.stands.length > 0) return r.stands;
  return r.stand === 'all' ? [...STAND_ORDER] : [r.stand as Stand];
}

function sameStand(a: Region, b: Region): boolean {
  const sa = standsOf(a);
  return standsOf(b).some((s) => sa.includes(s));
}

/**
 * The palette indices of the field a layer sits on: the colours of the last
 * fill/gradient/pattern/stripes layer below it that covers the same stand, else
 * the background, else empty (0).
 *
 * ALL the colours, not the first. Text over a red-to-white gradient sits on red
 * at one end and white at the other, and over red-and-black stripes it sits on
 * both: checking only colors[0] passed white text on a gradient that ends in
 * white, and red text on stripes that are half red — words that vanish into
 * their own field, on the biggest stadium as much as the smallest.
 */
function fieldColorsUnder(layers: SpecLayer[], idx: number, background: number | undefined): number[] {
  let field = [background ?? 0];
  const here = layers[idx].region;
  const want = here.rows ?? [0, 1];
  for (let j = 0; j < idx; j++) {
    const L = layers[j];
    if (L.kind === 'fill' || L.kind === 'gradient' || L.kind === 'pattern' || L.kind === 'stripes') {
      if (!sameStand(L.region, here)) continue;
      const colours = L.kind === 'fill' ? [L.colorIndex] : [...new Set(L.colors)];
      const has = L.region.rows ?? [0, 1];
      if (has[1] < want[0] || has[0] > want[1]) continue; // a band elsewhere in the stand
      // A band covering only part of the art's rows adds to what is under it.
      const covers = has[0] <= want[0] + 1e-6 && has[1] >= want[1] - 1e-6;
      field = covers ? colours : [...new Set([...field, ...colours])];
    }
  }
  return field;
}

/** Worst contrast of one colour against every colour of a field. */
function worstAgainst(palette: string[], c: number, field: number[]): number {
  let worst = Infinity;
  for (const f of field) worst = Math.min(worst, contrastRatio(palette[c] ?? '#262a33', palette[f] ?? '#262a33'));
  return worst;
}

/**
 * Make a text or symbol layer separate from everything under it: recolour it to
 * the card that reads against every colour of its field, and when no card does
 * (two-colour palettes over a two-colour gradient), lay a solid panel of the
 * field colour that reads best behind it. Returns the panel to insert, if any.
 */
function separate(palette: string[], l: SpecLayer & { colorIndex: number }, field: number[]): SpecLayer | null {
  if (worstAgainst(palette, l.colorIndex, field) >= MIN_CONTRAST) return null;
  let best = l.colorIndex;
  let bestR = -1;
  for (let i = 1; i < palette.length; i++) {
    const r = worstAgainst(palette, i, field);
    if (r > bestR) { bestR = r; best = i; }
  }
  if (bestR >= MIN_CONTRAST) { l.colorIndex = best; return null; }
  // (The panel's id is the art's id + "-panel": fitting to a stadium strips
  // these and lays them again under wherever the art ends up.)
  // No card reads against the whole field: give it a ground of its own. The
  // panel is the field colour the art reads best on, so the stand keeps its
  // colours; the art takes the card that reads best on the panel.
  let panel = field[0];
  let panelR = -1;
  for (const f of field) {
    if (f === 0) continue;
    const r = contrastRatio(palette[f], palette[mostContrasting(palette, f)]);
    if (r > panelR) { panelR = r; panel = f; }
  }
  l.colorIndex = mostContrasting(palette, panel);
  return { kind: 'fill', id: `${l.id}-panel`, region: { ...l.region }, colorIndex: panel } as SpecLayer;
}

/**
 * The contrast half of the refiner, on its own: also run after a design is
 * fitted to a stadium, because fitting moves art onto other fields and drops
 * outlines that were doing the separating.
 */
export function repairContrast(spec: TifoSpec): TifoSpec {
  const palette = spec.palette;
  const layers = spec.layers.map((l) => ({ ...l })) as SpecLayer[];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.kind !== 'text' && l.kind !== 'symbol') continue;
    if (l.kind === 'text' && isBacking(layers, i)) continue;
    // An outlined headline is separated by its own edge, as long as the edge
    // reads against the letters.
    // On a flat field only: over a gradient or stripes the edge is a seat or two
    // of colour in a field that already changes colour under it, and it is lost.
    const prev = layers[i - 1];
    const field = fieldColorsUnder(layers, i, spec.background);
    if (l.kind === 'text' && field.length === 1 && prev && isBacking(layers, i - 1) && prev.kind === 'text' &&
      contrastRatio(palette[prev.colorIndex] ?? '#262a33', palette[l.colorIndex] ?? '#262a33') >= MIN_CONTRAST) continue;
    const panel = separate(palette, l, field);
    if (panel) {
      // Below the art and below its outline copy, if it has one.
      const at = l.kind === 'text' && prev && isBacking(layers, i - 1) ? i - 1 : i;
      layers.splice(at, 0, panel);
      i++;
    }
  }
  return { ...spec, layers };
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

  // 2) Per-layer minimum size.
  for (const l of layers) {
    if (l.kind === 'text') {
      const floor = minHeightFor(l.text, l.region);
      if (l.heightFrac < floor) l.heightFrac = floor;
    } else if (l.kind === 'symbol') {
      if (l.scaleFrac < MIN_SYMBOL_SCALE) l.scaleFrac = MIN_SYMBOL_SCALE;
    }
  }

  unletterbox(layers);

  // 3) Contrast against every colour of the field underneath.
  return repairContrast({ ...spec, background, layers });
}

const FIELD_KINDS = new Set(['fill', 'stripes', 'gradient', 'pattern']);

/** Which stands a region's field covers, as STAND_ORDER indices. */
function standsCovered(region: Region): number[] {
  if (region.stands && region.stands.length > 0) {
    return region.stands.map((x) => STAND_ORDER.indexOf(x)).filter((i) => i >= 0);
  }
  if (region.stand === 'all') return [0, 1, 2, 3];
  const i = STAND_ORDER.indexOf(region.stand as Stand);
  return i >= 0 ? [i] : [];
}

/**
 * Undo an accidental letterbox: a field band that leaves the same unpainted gap
 * along the top and bottom of most of the bowl.
 *
 * Leaving index 0 showing is a real device — bare concrete around the art, and
 * free, since an unpainted seat is a card nobody has to print. On ONE stand it
 * reads as a margin under a hero. Repeated across the bowl it stops being a
 * frame: a stand has no left or right edge of its own (its neighbours are right
 * there), so the only band it can make is horizontal, and four stands wearing
 * the same one is a single dark stripe across the top of the stadium and
 * another across the bottom. That reads as the design being cut off, which is
 * exactly what it looks like from the stands.
 *
 * Only near-full bands count. A field covering 80%+ of the height but not all
 * of it is a margin; a genuine horizontal stripe at [0.4,0.6] is a design and is
 * left alone.
 */
function unletterbox(layers: SpecLayer[]): void {
  const banded: SpecLayer[] = [];
  const stands = new Set<number>();
  for (const l of layers) {
    if (!FIELD_KINDS.has(l.kind)) continue;
    const rows = l.region.rows;
    if (!rows) continue;
    const covers = Math.abs(rows[1] - rows[0]);
    if (covers < 0.8 || covers >= 1) continue;
    banded.push(l);
    for (const i of standsCovered(l.region)) stands.add(i);
  }
  if (stands.size < 3) return; // a margin on one or two stands is a choice
  for (const l of banded) l.region = { ...l.region, rows: [0, 1] };
}
