/**
 * TifoSpec — the high-level, AI-authorable *design specification*.
 *
 * This is deliberately NOT the .tifo document (tifoFormat.ts): that encodes the
 * OUTPUT (a palette index for every seat, RLE-compressed). A TifoSpec instead
 * describes a tifo the way a choreography designer thinks about it — a palette,
 * a background, and an ordered stack of layers (fills, stripes, big text, and
 * symbols), each scoped to a region of the bowl (a stand and/or a tier). The
 * engine's existing renderer (specCompiler.ts) turns a TifoSpec into seats using
 * the SAME stamping pipeline the Text and Image tools already use, so generated
 * tifos are ordinary, fully-editable projects with undo/redo, save and export.
 *
 * Like tifoFormat.ts this module is framework-free and DOM-free: it runs in the
 * browser, in the server's /api/ai/generate endpoint, and in tests, so the
 * generator's "validate before deliver" loop and the client share one truth.
 */

export const SPEC_VERSION = 1 as const;

// ---- vocabulary the AI is allowed to use (kept here so the prompt, the
// validator, the offline designer and the compiler never drift apart) ----

/** The four sides of the bowl, plus the whole stadium. Stands are derived from
 * the seat map's `u` (perimeter fraction); see STAND_GEOMETRY below. */
export type Stand = 'north' | 'south' | 'east' | 'west';
export const STANDS: Stand[] = ['north', 'south', 'east', 'west'];

/**
 * Where each stand sits on the unrolled perimeter. Matches the existing `split`
 * pattern convention: ((u + 0.125) % 1) * 4 → E,N,W,S. Each stand owns a quarter
 * of the perimeter (halfU = 0.125), so the four together tile the whole bowl and
 * "east" straddles the u=0 seam (the compiler handles that via wrapWidth).
 */
export const STAND_GEOMETRY: Record<Stand, { centerU: number; halfU: number }> = {
  east: { centerU: 0.0, halfU: 0.125 },
  north: { centerU: 0.25, halfU: 0.125 },
  west: { centerU: 0.5, halfU: 0.125 },
  south: { centerU: 0.75, halfU: 0.125 },
};

/**
 * Perimeter order of the four stands by index — the single source of truth for
 * "which stand is this seat in", shared by the compiler and the stadium-context
 * serializer. Matches the `split` pattern: floor(((u + 0.125) % 1) * 4).
 */
export const STAND_ORDER: Stand[] = ['east', 'north', 'west', 'south'];

/** Quarter-stand index (0=east, 1=north, 2=west, 3=south) for a perimeter fraction u. */
export function standIndexOfU(u: number): number {
  return Math.floor(((u + 0.125) % 1) * 4);
}

/** The stand a perimeter fraction u falls in. */
export function standAtU(u: number): Stand {
  return STAND_ORDER[standIndexOfU(u)] ?? 'east';
}

/** Multi-stand group shorthands the planner can target in one region. */
export const STAND_GROUPS: Record<'sides' | 'ends', Stand[]> = {
  sides: ['east', 'west'], // the two long sides, facing each other across the pitch
  ends: ['north', 'south'], // the two ends, facing each other
};

/** Font ids the renderer can draw. Mirrors TIFO_FONTS in core/text.ts. */
export const SPEC_FONT_IDS = [
  // Shipped display voices — each one family covering Arabic and Latin.
  'poster', 'kufi', 'condensed', 'slab', 'sign', 'grotesk',
  // Legacy system stacks, kept so designs saved before the voices still render.
  'impact', 'black', 'verdana', 'georgia', 'courier',
] as const;
export type SpecFontId = (typeof SPEC_FONT_IDS)[number];

/**
 * Symbols the vector library (core/symbols.ts) can render as a single-colour
 * mask. Stadium-legible iconography only — bold silhouettes that survive a 10%
 * no-show rate, never photographic detail. Keep this list and the drawers in
 * symbols.ts in lockstep.
 */
export const SYMBOL_NAMES = [
  'star', 'star6', 'circle', 'ring', 'disc', 'diamond', 'triangle', 'square',
  'heart', 'crown', 'shield', 'cross', 'plus', 'bolt', 'flame', 'anchor',
  'ball', 'eagle', 'wings', 'fist', 'crescent', 'chevron',
] as const;
export type SymbolName = (typeof SYMBOL_NAMES)[number];

export type StripeOrientation = 'vertical' | 'horizontal' | 'diagonal';
export type TextAlign = 'center' | 'top' | 'bottom';

// ---- region ----

/**
 * A region of the bowl. Normalized form is always the object; the validator also
 * accepts string shorthands ('north', 'all', 'lower', 'upper', ...).
 * - stand: which side, or 'all' for the full ring.
 * - tier: a tier index, or 'all' for every tier.
 * - rows: optional [from, to] as row fractions (0 = front row, 1 = back) to clip
 *         vertically within the stand/tier (e.g. [0.5, 1] = back half only).
 */
export interface Region {
  stand: Stand | 'all';
  tier: number | 'all';
  rows?: [number, number];
  /**
   * Optional multi-stand coverage (cross-stand composition). When present the
   * region spans exactly these stands and `stand` is left as 'all', so per-stand
   * pattern maths fall back to whole-bowl coordinates. Absent for single-stand
   * regions, so every existing spec behaves identically.
   */
  stands?: Stand[];
}

export type RegionInput = Region | Stand | 'all' | 'lower' | 'upper' | 'sides' | 'ends';

// ---- layers ----

export interface BaseLayer {
  id: string;
  region: Region;
}

/** Flood a region with one colour. The usual first layer (the background). */
export interface FillLayer extends BaseLayer {
  kind: 'fill';
  colorIndex: number;
}

/** Bands of alternating colours across a region. */
export interface StripesLayer extends BaseLayer {
  kind: 'stripes';
  colors: number[];
  orientation: StripeOrientation;
  /** Number of bands across the region (2..40). */
  bands: number;
}

/** Stadium-scale text, optionally arched. Sized as a fraction of region height. */
export interface TextLayer extends BaseLayer {
  kind: 'text';
  text: string;
  colorIndex: number;
  fontId: SpecFontId;
  /** Arc bend in degrees, -170..170 (0 = straight). */
  arcDeg: number;
  /** Glyph height as a fraction of the region's height (0.02..1). */
  heightFrac: number;
  align: TextAlign;
  /**
   * Fatten the letterforms by this many source pixels (0..24). Stamp the layer
   * twice — once fattened in the edge colour, once plain on top in the fill
   * colour — and the pair reads as an outlined headline. Scale it with the word:
   * a fixed stroke welds a short one shut.
   */
  outline?: number;
  /**
   * Stretch the run horizontally by up to this factor (1..6) to fill the
   * region's width. A stand is roughly 6.6:1, so a short phrase set at its
   * natural aspect sits as an island in a wide empty band.
   */
  stretch?: number;
  /** Shift right by this % of the region's width (-20..20) — for drop shadows. */
  dx?: number;
  /** Shift down by this % of the region's height (-20..20). */
  dy?: number;
}

/** A single-colour symbol scaled to a fraction of the region's smaller side. */
export interface SymbolLayer extends BaseLayer {
  kind: 'symbol';
  symbol: SymbolName;
  colorIndex: number;
  /** Size as a fraction of min(regionWidth, regionHeight) (0.05..1). */
  scaleFrac: number;
  align: TextAlign;
  /**
   * Width multiplier (1..8). Symbols are sized off the region's HEIGHT, so on a
   * 6.6:1 stand a "full scale" crest covers about 15% of the width. Above 1 the
   * mask is stretched horizontally; past roughly 3 it starts to distort.
   */
  wide?: number;
}

export const PATTERN_NAMES = ['checker', 'chevron', 'grid', 'flag', 'hoops'] as const;
export type PatternName = (typeof PATTERN_NAMES)[number];

/** A dithered gradient blending 2+ palette colours across a region. */
export interface GradientLayer extends BaseLayer {
  kind: 'gradient';
  colors: number[];
  direction: 'vertical' | 'horizontal' | 'radial';
}

/** A repeating geometric pattern — mosaic backgrounds beyond plain stripes. */
export interface PatternLayer extends BaseLayer {
  kind: 'pattern';
  pattern: PatternName;
  colors: number[];
  /** Cells across the region (4..80). */
  scale: number;
}

/**
 * A generated picture — a portrait, player, figure, crest or detailed artwork —
 * rendered onto seats through the image-import quantizer (so it shades with the
 * palette's tones). The model only DESCRIBES the subject in `prompt`; the server
 * generates the image and fills `assetRef`. If generation is unavailable the
 * layer is simply skipped, so the rest of the design still renders.
 */
export interface ImageLayer extends BaseLayer {
  kind: 'image';
  prompt: string;
  /** Data URL filled server-side after generation; absent if it failed. */
  assetRef?: string;
  /** Size as a fraction of the FITTED size (0.2..1); 1 = exactly the fit. */
  scaleFrac: number;
  /**
   * How the picture meets its region.
   *
   * 'cover' scales until BOTH axes are covered and lets the region clip the
   * overflow — the full-bleed hero, the thing that makes a face read as huge
   * instead of floating in the middle of a wide band. 'contain' scales until the
   * whole picture fits inside, so nothing is cropped.
   *
   * Default 'cover'. The bake is clipped to the region either way, so cover can
   * never bleed into a neighbouring stand; and the generator is now asked for
   * the region's own aspect ratio, so in the normal case the two are identical
   * and the choice only matters for an asset that arrived the wrong shape.
   */
  fit?: 'contain' | 'cover';
  /**
   * Cut the picture's flat backdrop away so the design underneath shows through
   * (default true). A generated picture arrives as a rectangle with the subject
   * on a flat field; baked whole, that rectangle lands on the stand as a block
   * of card that reads as a photo pasted on. Cut out, the subject stands on the
   * stripes or pattern the design already painted — which is how a real tifo
   * looks. Set false to keep the backdrop, e.g. for artwork that IS a full scene.
   */
  cutout?: boolean;
  dither: boolean;
  /** Clustered halftone quantization — chunkier, more legible portraits at seat scale. */
  halftone?: boolean;
}

export type SpecLayer =
  | FillLayer
  | StripesLayer
  | TextLayer
  | SymbolLayer
  | GradientLayer
  | PatternLayer
  | ImageLayer;

export interface TifoSpec {
  version: typeof SPEC_VERSION;
  title: string;
  /** One-line designer's note explaining the composition (shown in the UI). */
  summary?: string;
  /** Index 0 is the empty seat (stadium grey). 2..8 entries. */
  palette: string[];
  /** Optional palette index flood-filled across the whole bowl before layers. */
  background?: number;
  layers: SpecLayer[];
}

// ---- limits ----

export const SPEC_LIMITS = {
  maxLayers: 24,
  /**
   * 24, not 8.
   *
   * The seat store holds one byte per seat, so 256 colours are renderable, and
   * the manual photo import already hands itself 14 extracted tones. The AI was
   * capped at 7 paintable colours FOR THE WHOLE BOWL — which is why its designs
   * could only ever be flat blocks: a portrait needs 5-6 tones for the face
   * alone, leaving one colour for the other three stands.
   *
   * Every colour is a card type somebody has to print, sort and distribute, so
   * this is not free — but that cost is linear and visible (production.ts
   * reports per-colour counts), whereas the old cap made shading impossible.
   * The prompts spend the headroom on TONES of a few hues, not on more hues.
   */
  maxPalette: 24,
  minPalette: 2,
  maxTitle: 120,
  maxText: 60,
  maxSummary: 240,
  maxBands: 40,
  minBands: 2,
  maxImagePrompt: 200,
} as const;

// ---- validation ----

export interface SpecValidationError {
  path: string;
  message: string;
}

export interface SpecValidationResult {
  valid: boolean;
  errors: SpecValidationError[];
  /** Present when valid: the normalized spec (defaults filled, regions expanded). */
  spec?: TifoSpec;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SYMBOL_SET = new Set<string>(SYMBOL_NAMES);
const FONT_SET = new Set<string>(SPEC_FONT_IDS);
const ORIENTATIONS = new Set<string>(['vertical', 'horizontal', 'diagonal']);
const ALIGNS = new Set<string>(['center', 'top', 'bottom']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Reduce a region to a SINGLE stand for placing a hero image/portrait. A picture
 * spanning multiple disjoint stands ('sides'/'ends'/stands[]) or the whole bowl
 * ('all') makes no sense, so pick one stand: the first of an explicit stands[],
 * or 'north' (the conventional hero end) for 'all'. Single-stand regions pass
 * through unchanged; tier and rows are preserved.
 */
export function narrowToSingleStand(region: Region): Region {
  if (region.stands && region.stands.length > 0) {
    // An unbroken run of stands is one continuous surface, so a picture can span
    // it — but only up to MAX_IMAGE_STANDS. A SPLIT set ('sides', 'ends') and an
    // over-long run both collapse.
    if (isContiguousRegion(region) && region.stands.length <= MAX_IMAGE_STANDS) return region;
    return region.rows
      ? { stand: region.stands[0], tier: region.tier, rows: region.rows }
      : { stand: region.stands[0], tier: region.tier };
  }
  if (region.stand === 'all') return { ...region, stand: 'north' };
  return region;
}

/**
 * How many stands one generated picture may span.
 *
 * Two, because of what is on the other end of the request. Three stands is a
 * 7.5:1 strip and four is 10:1; no diffusion model composes a subject at those
 * proportions, so the generator returns something nearer 4:1 and the renderer
 * has to crop 47% of it away to cover the strip — a face reduced to a band of
 * cheek. A picture that wide is a job for the pattern and lettering layers,
 * which are drawn analytically and do not care how wide the region is.
 */
const MAX_IMAGE_STANDS = 2;

/**
 * The unbroken run of stands a region covers, as a start index into STAND_ORDER
 * and a length, or null when the stands are split by a gap.
 *
 * The bowl is a ring, so a run may wrap the u=0 seam — {south, east} is as
 * continuous as {east, north} — and both the pattern compiler and the object
 * baker wrap at the editor width, so art laid across a wrapping run is
 * continuous too. 'sides' (east+west) and 'ends' (north+south) face each other
 * across the pitch and are NOT runs: one picture across them would show its left
 * half on one stand and its right half on the other, with the middle missing.
 */
export function standRun(region: Region): { start: number; len: number } | null {
  const list =
    region.stands && region.stands.length > 0
      ? region.stands
      : region.stand === 'all'
        ? STAND_ORDER
        : [region.stand as Stand];
  const want = new Set(list.map((s) => STAND_ORDER.indexOf(s)));
  if (want.size === 0 || want.has(-1)) return null;
  for (let start = 0; start < STAND_ORDER.length; start++) {
    let ok = true;
    for (let k = 0; k < want.size; k++) {
      if (!want.has((start + k) % STAND_ORDER.length)) { ok = false; break; }
    }
    if (ok) return { start, len: want.size };
  }
  return null;
}

/** True when one picture can span the region without a break in the middle. */
export function isContiguousRegion(region: Region): boolean {
  return standRun(region) !== null;
}

// A nominal bowl, used only to guess what SHAPE a generated picture should be.
// Mirrors EDITOR_UNITS (4000px around, 8px a row, a 24px walkway) for a typical
// two-tier stadium; seatmap.ts owns the real numbers, and it is browser-side.
const NOMINAL_STAND_PX = 1000; // EDITOR_UNITS.width / 4 stands
const NOMINAL_TIER_PX = 200; // ~25 rows x 8px
const NOMINAL_TIERS = 2;
const NOMINAL_GAP_PX = 24; // EDITOR_UNITS.tierGapPx

/**
 * Nominal editor-space aspect (width / height) of a region: what shape a picture
 * has to be to fill it without distortion.
 *
 * The exact answer is regionRect(), which needs the seat map and so lives in the
 * browser. This is the server's estimate, and it is only used to pick the
 * dimensions of the image it asks a generator for — a nominal bowl is close
 * enough for that, and the renderer's cover-fit absorbs the rest.
 *
 * Clamped to [0.5, 4]: past about 4:1 a diffusion model stops composing and
 * starts smearing the subject across the strip, which is worse than a crop.
 */
/**
 * Roughly how many ROWS OF SEATS a region has — the resolution the picture will
 * actually be redrawn at, and the number that decides whether it reads.
 *
 * The bake samples one grid cell per row (EDITOR_UNITS.rowPx), so a hero on one
 * stand across both tiers gets about 52. That is the whole budget: a full-length
 * figure spends most of it on a body and leaves a dozen rows for a face.
 */
export function regionRowsHint(region: Region): number {
  const tiers = region.tier === 'all' ? NOMINAL_TIERS : 1;
  const rows = region.rows ? Math.abs(region.rows[1] - region.rows[0]) : 1;
  const px = (tiers * NOMINAL_TIER_PX + (tiers - 1) * NOMINAL_GAP_PX) * Math.max(0.05, rows);
  return Math.max(4, Math.round(px / 8)); // EDITOR_UNITS.rowPx
}

export function regionAspectHint(region: Region): number {
  const run = standRun(region);
  const stands = run ? run.len : 1;
  const tiers = region.tier === 'all' ? NOMINAL_TIERS : 1;
  const rows = region.rows ? Math.abs(region.rows[1] - region.rows[0]) : 1;
  const height = Math.max(
    NOMINAL_TIER_PX * 0.1,
    (tiers * NOMINAL_TIER_PX + (tiers - 1) * NOMINAL_GAP_PX) * Math.max(0.05, rows),
  );
  return Math.max(0.5, Math.min(4, (stands * NOMINAL_STAND_PX) / height));
}

/** Validate a stands[] array → deduped Stand[], or null if any entry is invalid. */
function normalizeStands(raw: unknown): Stand[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Stand[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !(STANDS as string[]).includes(s)) return null;
    if (!out.includes(s as Stand)) out.push(s as Stand);
  }
  return out.length ? out : null;
}

/** Normalize a region shorthand/object to a full Region, or null if invalid. */
export function normalizeRegion(input: unknown): Region | null {
  if (input === undefined || input === null) return { stand: 'all', tier: 'all' };
  if (typeof input === 'string') {
    if (input === 'all') return { stand: 'all', tier: 'all' };
    if (input === 'lower') return { stand: 'all', tier: 0 };
    if (input === 'upper') return { stand: 'all', tier: 1 };
    if (input === 'sides' || input === 'ends') return { stand: 'all', tier: 'all', stands: [...STAND_GROUPS[input]] };
    if ((STANDS as string[]).includes(input)) return { stand: input as Stand, tier: 'all' };
    return null;
  }
  if (!isObj(input)) return null;
  const standRaw = input.stand ?? 'all';
  let stand = standRaw === 'all' || (STANDS as string[]).includes(standRaw as string) ? (standRaw as Stand | 'all') : null;
  if (stand === null) return null;
  const tierRaw = input.tier ?? 'all';
  const tier = tierRaw === 'all' ? 'all' : Number.isInteger(tierRaw) && (tierRaw as number) >= 0 ? (tierRaw as number) : null;
  if (tier === null) return null;
  let rows: [number, number] | undefined;
  if (Array.isArray(input.rows) && input.rows.length === 2) {
    const a = clampNum(input.rows[0], 0, 1, 0);
    const b = clampNum(input.rows[1], 0, 1, 1);
    rows = [Math.min(a, b), Math.max(a, b)];
  }
  // Optional multi-stand coverage (cross-stand composition). A present-but-invalid
  // stands[] rejects the whole region, like every other field (strict).
  let stands: Stand[] | undefined;
  if (input.stands !== undefined) {
    const ns = normalizeStands(input.stands);
    if (ns === null) return null;
    if (ns.length === 1) stand = ns[0]; // collapse to a single-stand region
    else if (ns.length < STANDS.length) { stands = ns; stand = 'all'; } // true multi-stand
    else stand = 'all'; // all four stands → whole bowl
  }
  const region: Region = { stand, tier };
  if (rows) region.rows = rows;
  if (stands) region.stands = stands;
  return region;
}

/**
 * Read a region a model wrote loosely — "North", "north stand", "lower north",
 * "both ends", { stand: "North", tier: "upper" }, { tier: [0, 1] },
 * { stands: "north, south" }, { rows: { from: 0, to: 0.5 } } — as the region it
 * plainly means. Returns something normalizeRegion accepts, or null when there
 * is no single reading (the caller then leaves the layer to the validator).
 */
export function coerceRegion(input: unknown): unknown {
  const looseRows = isObj(input) && input.rows !== undefined && input.rows !== null && !Array.isArray(input.rows);
  if (normalizeRegion(input) !== null && !looseRows) return input;
  type Parsed = { stands: Stand[]; tier: number | 'all' | null; whole: boolean };
  /** Stands and a tier named in free text. */
  const parseText = (raw: string): Parsed | null => {
    const s = raw.toLowerCase().replace(/[_\-+/&,|]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const words = s.split(' ');
    const stands: Stand[] = [];
    const add = (x: Stand): void => { if (!stands.includes(x)) stands.push(x); };
    for (const st of STANDS) if (words.some((w) => w === st || w === `${st}ern`)) add(st);
    // A single letter only when it is the whole name ("N", "S tier 1").
    const letter: Record<string, Stand> = { n: 'north', s: 'south', e: 'east', w: 'west' };
    if (!stands.length && letter[words[0]] && (words.length === 1 || /^(stand|end|side|tier|lower|upper)$/.test(words[1]))) add(letter[words[0]]);
    if (!stands.length && /\b(sides|both sides|long sides|touchlines?|main and opposite)\b/.test(s)) STAND_GROUPS.sides.forEach(add);
    if (!stands.length && /\b(ends|both ends|goal ends|behind (the )?goals?)\b/.test(s)) STAND_GROUPS.ends.forEach(add);
    let tier: number | 'all' | null = null;
    const tn = /\b(?:tier|level|deck|ring)\s*(\d)\b|\bt(\d)\b/.exec(s);
    if (tn) tier = Number(tn[1] ?? tn[2]);
    else if (/\b(lower|bottom|first|ground)\b/.test(s)) tier = 0;
    else if (/\b(upper|top|second)\b/.test(s)) tier = 1;
    else if (/\b(all|both|every) (tiers|levels|decks)\b/.test(s)) tier = 'all';
    const whole = /\b(all|whole|entire|everywhere|full|bowl|stadium|everything|around)\b/.test(s);
    if (!stands.length && tier === null && !whole) return null;
    return { stands, tier, whole };
  };
  const tierOf = (t: unknown): number | 'all' | null => {
    if (t === undefined || t === null) return 'all';
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0) return Math.round(t);
    if (typeof t === 'string') {
      if (/^\s*\d+\s*$/.test(t)) return Number(t);
      const p = parseText(t);
      return p ? (p.tier ?? 'all') : null;
    }
    if (Array.isArray(t)) {
      const ks = [...new Set(t.map(tierOf).filter((k): k is number | 'all' => k !== null))];
      if (ks.length === 1) return ks[0];
      return ks.length ? 'all' : null; // several tiers: the region cannot list them, so all
    }
    return null;
  };
  const build = (stands: Stand[], tier: number | 'all', rows?: unknown): Region | string => {
    const r: Region = { stand: 'all', tier };
    if (stands.length === 1) r.stand = stands[0];
    else if (stands.length > 1 && stands.length < STANDS.length) r.stands = [...stands];
    if (rows) r.rows = rows as [number, number];
    if (!rows && tier === 'all' && !r.stands) return r.stand; // keep it a shorthand
    if (!rows && r.stand === 'all' && !r.stands && tier === 0) return 'lower';
    if (!rows && r.stand === 'all' && !r.stands && tier === 1) return 'upper';
    return r;
  };

  if (typeof input === 'string') {
    const p = parseText(input);
    if (!p) return null;
    return build(p.stands, p.tier ?? 'all');
  }
  if (Array.isArray(input)) {
    // ["north", "south"]: several stands.
    const p = parseText(input.filter((x) => typeof x === 'string').join(' '));
    return p ? build(p.stands, p.tier ?? 'all') : null;
  }
  if (!isObj(input)) return null;

  const stands: Stand[] = [];
  let tier: number | 'all' | null = null;
  const standVal = input.stand ?? input.stands ?? input.area ?? input.side;
  const standList = Array.isArray(standVal) ? standVal : standVal === undefined ? [] : [standVal];
  for (const v of standList) {
    if (typeof v !== 'string') return null;
    const p = parseText(v);
    if (!p) return null;
    for (const st of p.stands) if (!stands.includes(st)) stands.push(st);
    if (p.tier !== null) tier = p.tier;
  }
  if (input.stand !== undefined && input.stands !== undefined && input.stand !== input.stands) {
    // Both given: { stand: "all", stands: [...] } or { stand: "north", stands: [] }.
    const extra = Array.isArray(input.stands) ? input.stands : [input.stands];
    for (const v of extra) {
      const p = typeof v === 'string' ? parseText(v) : null;
      if (p) for (const st of p.stands) if (!stands.includes(st)) stands.push(st);
    }
  }
  if (input.tier !== undefined && input.tier !== null) {
    const t = tierOf(input.tier);
    if (t === null) return null;
    tier = t;
  }
  let rows: [number, number] | undefined;
  const rr = input.rows ?? input.row;
  if (rr !== undefined && rr !== null) {
    const pair = Array.isArray(rr) ? rr
      : isObj(rr) ? [rr.from ?? rr.start ?? rr.min ?? rr[0], rr.to ?? rr.end ?? rr.max ?? rr[1]]
      : typeof rr === 'string' ? rr.split(/\s*(?:-|–|to|,)\s*/) : [];
    const nums = pair.slice(0, 2).map((x) => (typeof x === 'string' ? parseFloat(x.replace('%', '')) : x));
    if (nums.length === 2 && nums.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      let [a, b] = nums as [number, number];
      if (Math.max(a, b) > 1 && Math.max(a, b) <= 100) { a /= 100; b /= 100; } // percentages
      if (Math.max(a, b) <= 1) rows = [Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))];
    }
  }
  return build(stands, tier ?? 'all', rows);
}

/**
 * Validate (and normalize) an AI-authored spec against a palette-size ceiling.
 * Strict and all-or-nothing: returns every problem so a generator can fix them
 * in one pass, and on success a normalized TifoSpec with defaults filled in.
 */
export function validateSpec(input: unknown): SpecValidationResult {
  const errors: SpecValidationError[] = [];
  const err = (path: string, message: string): void => {
    errors.push({ path, message });
  };

  if (!isObj(input)) {
    return { valid: false, errors: [{ path: '', message: 'spec must be a JSON object' }] };
  }

  // palette
  const palette = input.palette;
  let paletteLen = 0;
  if (!Array.isArray(palette)) {
    err('palette', 'palette must be an array of hex colours');
  } else {
    paletteLen = palette.length;
    if (palette.length < SPEC_LIMITS.minPalette) err('palette', `palette needs at least ${SPEC_LIMITS.minPalette} colours (index 0 = empty seat)`);
    if (palette.length > SPEC_LIMITS.maxPalette) err('palette', `palette may have at most ${SPEC_LIMITS.maxPalette} colours`);
    palette.forEach((c, i) => {
      if (typeof c !== 'string' || !HEX.test(c)) err(`palette[${i}]`, `"${String(c)}" is not a hex colour`);
    });
  }
  const inRange = (idx: unknown): boolean => Number.isInteger(idx) && (idx as number) >= 0 && (idx as number) < paletteLen;

  // title
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, SPEC_LIMITS.maxTitle) : 'AI tifo';

  // background (optional)
  let background: number | undefined;
  if (input.background !== undefined && input.background !== null) {
    if (!inRange(input.background)) err('background', `background must be a palette index 0..${paletteLen - 1}`);
    else background = input.background as number;
  }

  // layers
  const layersIn = input.layers;
  const layers: SpecLayer[] = [];
  if (!Array.isArray(layersIn) || layersIn.length === 0) {
    err('layers', 'layers must be a non-empty array');
  } else if (layersIn.length > SPEC_LIMITS.maxLayers) {
    err('layers', `at most ${SPEC_LIMITS.maxLayers} layers`);
  } else {
    layersIn.forEach((raw, li) => {
      const p = `layers[${li}]`;
      if (!isObj(raw)) {
        err(p, 'layer must be an object');
        return;
      }
      const region = normalizeRegion(raw.region);
      if (region === null) {
        let got = '';
        try { got = JSON.stringify(raw.region) ?? ''; } catch { /* circular: leave it out */ }
        err(`${p}.region`, `region ${got.length > 70 ? got.slice(0, 67) + '...' : got} is not a stand ("north"/"south"/"east"/"west"), "all"/"lower"/"upper"/"sides"/"ends", or { stand, tier, rows, stands }`);
        return;
      }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : `L${li}`;
      switch (raw.kind) {
        case 'fill': {
          if (!inRange(raw.colorIndex)) { err(`${p}.colorIndex`, `colorIndex out of palette range 0..${paletteLen - 1}`); return; }
          layers.push({ kind: 'fill', id, region, colorIndex: raw.colorIndex as number });
          break;
        }
        case 'stripes': {
          const colors = Array.isArray(raw.colors) ? raw.colors : [];
          if (colors.length < 2 || !colors.every(inRange)) { err(`${p}.colors`, `colors must be 2+ palette indices in range 0..${paletteLen - 1}`); return; }
          if (typeof raw.orientation !== 'string' || !ORIENTATIONS.has(raw.orientation)) { err(`${p}.orientation`, 'orientation must be vertical|horizontal|diagonal'); return; }
          layers.push({
            kind: 'stripes', id, region,
            colors: colors as number[],
            orientation: raw.orientation as StripeOrientation,
            bands: Math.round(clampNum(raw.bands, SPEC_LIMITS.minBands, SPEC_LIMITS.maxBands, Math.max(2, (colors as number[]).length))),
          });
          break;
        }
        case 'text': {
          if (typeof raw.text !== 'string' || !raw.text.trim()) { err(`${p}.text`, 'text is required'); return; }
          if (raw.text.length > SPEC_LIMITS.maxText) { err(`${p}.text`, `text too long (max ${SPEC_LIMITS.maxText})`); return; }
          if (!inRange(raw.colorIndex)) { err(`${p}.colorIndex`, `colorIndex out of palette range 0..${paletteLen - 1}`); return; }
          const fontId = typeof raw.fontId === 'string' && FONT_SET.has(raw.fontId) ? (raw.fontId as SpecFontId) : 'impact';
          layers.push({
            kind: 'text', id, region,
            text: raw.text.trim().slice(0, SPEC_LIMITS.maxText),
            colorIndex: raw.colorIndex as number,
            fontId,
            arcDeg: clampNum(raw.arcDeg, -170, 170, 0),
            heightFrac: clampNum(raw.heightFrac, 0.02, 1, 0.6),
            align: typeof raw.align === 'string' && ALIGNS.has(raw.align) ? (raw.align as TextAlign) : 'center',
            ...(raw.outline !== undefined ? { outline: clampNum(raw.outline, 0, 24, 0) } : {}),
            ...(raw.stretch !== undefined ? { stretch: clampNum(raw.stretch, 1, 6, 1) } : {}),
            ...(raw.dx !== undefined ? { dx: clampNum(raw.dx, -20, 20, 0) } : {}),
            ...(raw.dy !== undefined ? { dy: clampNum(raw.dy, -20, 20, 0) } : {}),
          });
          break;
        }
        case 'symbol': {
          if (typeof raw.symbol !== 'string' || !SYMBOL_SET.has(raw.symbol)) { err(`${p}.symbol`, `symbol must be one of: ${SYMBOL_NAMES.join(', ')}`); return; }
          if (!inRange(raw.colorIndex)) { err(`${p}.colorIndex`, `colorIndex out of palette range 0..${paletteLen - 1}`); return; }
          layers.push({
            kind: 'symbol', id, region,
            symbol: raw.symbol as SymbolName,
            colorIndex: raw.colorIndex as number,
            ...(raw.wide !== undefined ? { wide: clampNum(raw.wide, 1, 8, 1) } : {}),
            scaleFrac: clampNum(raw.scaleFrac, 0.05, 1, 0.7),
            align: typeof raw.align === 'string' && ALIGNS.has(raw.align) ? (raw.align as TextAlign) : 'center',
          });
          break;
        }
        case 'gradient': {
          const colors = Array.isArray(raw.colors) ? raw.colors : [];
          if (colors.length < 2 || !colors.every(inRange)) { err(`${p}.colors`, `colors must be 2+ palette indices in range 0..${paletteLen - 1}`); return; }
          const dir = raw.direction;
          const direction = dir === 'horizontal' || dir === 'radial' ? dir : 'vertical';
          layers.push({ kind: 'gradient', id, region, colors: colors as number[], direction });
          break;
        }
        case 'pattern': {
          const colors = Array.isArray(raw.colors) ? raw.colors : [];
          if (colors.length < 2 || !colors.every(inRange)) { err(`${p}.colors`, `colors must be 2+ palette indices in range 0..${paletteLen - 1}`); return; }
          if (typeof raw.pattern !== 'string' || !(PATTERN_NAMES as readonly string[]).includes(raw.pattern)) {
            err(`${p}.pattern`, `pattern must be one of: ${PATTERN_NAMES.join(', ')}`);
            return;
          }
          layers.push({
            kind: 'pattern', id, region,
            pattern: raw.pattern as PatternName,
            colors: colors as number[],
            scale: Math.round(clampNum(raw.scale, 4, 80, 12)),
          });
          break;
        }
        case 'image': {
          if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) { err(`${p}.prompt`, 'image prompt is required'); return; }
          layers.push({
            kind: 'image', id, region,
            prompt: raw.prompt.trim().slice(0, SPEC_LIMITS.maxImagePrompt),
            assetRef: typeof raw.assetRef === 'string' ? raw.assetRef : undefined,
            scaleFrac: clampNum(raw.scaleFrac, 0.2, 1, 0.9),
            fit: raw.fit === 'contain' ? 'contain' : 'cover',
            cutout: raw.cutout !== false,
            dither: raw.dither !== false,
            halftone: raw.halftone === true,
          });
          break;
        }
        default:
          err(`${p}.kind`, 'kind must be fill|stripes|gradient|pattern|text|symbol|image');
      }
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  const spec: TifoSpec = {
    version: SPEC_VERSION,
    title,
    summary: typeof input.summary === 'string' ? input.summary.slice(0, SPEC_LIMITS.maxSummary) : undefined,
    palette: (palette as string[]).map(expandHex),
    background,
    layers,
  };
  return { valid: true, errors: [], spec };
}

/** #abc → #aabbcc; passes #rrggbb through. */
export function expandHex(hex: string): string {
  if (hex.length === 4) return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  return hex;
}

// ---- model output: repair before judging ----

/**
 * What a model writes is not always what the contract says, and the strict
 * validator rejects the WHOLE design for one field. Every failure in the admin
 * queue of October 2026 was one of these:
 *
 *   - `colors` given as hex strings, or as a single index, or one index past the
 *     palette (the critic recoloured a layer without touching the palette);
 *   - `orientation` missing on a stripes layer, or written as `direction` —
 *     the name a gradient uses for the same idea.
 *
 * Each costs the user the whole run ("premium is busy") over a detail with one
 * obvious reading. This repairs what has one reading, says what it did, and
 * leaves the rest to validateSpec. Pure; the input is not modified.
 */
export function coerceModelSpec(input: unknown): { spec: unknown; repairs: string[] } {
  const repairs: string[] = [];
  if (!isObj(input)) return { spec: input, repairs };
  const out: Record<string, unknown> = { ...input };

  // Palette: "#abc" and "aabbcc" are colours too.
  const palette: string[] = Array.isArray(input.palette)
    ? input.palette.map((c) => {
        if (typeof c !== 'string') return c as string;
        const t = c.trim();
        return /^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{3}$/.test(t) ? `#${t}` : t;
      })
    : [];
  if (Array.isArray(input.palette)) out.palette = palette;
  const n = palette.length;
  const rgb = (h: string): [number, number, number] | null => {
    if (typeof h !== 'string' || !HEX.test(h)) return null;
    const v = parseInt(expandHex(h).slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  /** A palette index from a number, a numeric string or a colour (nearest card). */
  const toIndex = (x: unknown): number | null => {
    if (typeof x === 'number' && Number.isInteger(x)) return x >= 0 && x < n ? x : null;
    if (typeof x !== 'string') return null;
    const s = x.trim();
    if (/^\d+$/.test(s)) { const k = Number(s); return k < n ? k : null; }
    const want = rgb(s.startsWith('#') ? s : `#${s}`);
    if (!want) return null;
    let best = -1;
    let bestD = Infinity;
    for (let i = 1; i < n; i++) {
      const c = rgb(palette[i]);
      if (!c) continue;
      const d = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? best : null;
  };

  if (input.background !== undefined && input.background !== null && !Number.isInteger(input.background)) {
    const b = toIndex(input.background);
    if (b !== null) { out.background = b; repairs.push(`background → ${b}`); }
  }

  if (!Array.isArray(input.layers)) return { spec: out, repairs };
  out.layers = input.layers.map((raw, li) => {
    if (!isObj(raw)) return raw;
    const l: Record<string, unknown> = { ...raw };
    const p = `layers[${li}]`;
    if (typeof l.kind === 'string') l.kind = l.kind.trim().toLowerCase();
    if (typeof l.align === 'string') l.align = l.align.trim().toLowerCase();
    if (l.region !== undefined && (normalizeRegion(l.region) === null || (isObj(l.region) && l.region.rows != null && !Array.isArray(l.region.rows)))) {
      const r = coerceRegion(l.region);
      if (r !== null && normalizeRegion(r) !== null) {
        repairs.push(`${p}.region ${JSON.stringify(l.region).slice(0, 60)} → ${JSON.stringify(r)}`);
        l.region = r;
      }
    }

    if ('colorIndex' in l && !Number.isInteger(l.colorIndex)) {
      const k = toIndex(l.colorIndex);
      if (k !== null) { l.colorIndex = k; repairs.push(`${p}.colorIndex → ${k}`); }
    }

    if (l.kind === 'stripes' || l.kind === 'gradient' || l.kind === 'pattern') {
      const rawColors = l.colors ?? l.colours ?? l.colorIndices ?? l.colorIndex;
      const list = Array.isArray(rawColors) ? rawColors : rawColors !== undefined ? [rawColors] : [];
      const colors = list.map(toIndex).filter((k): k is number => k !== null);
      const same = Array.isArray(l.colors) && colors.length === l.colors.length && colors.every((k, i) => k === (l.colors as unknown[])[i]);
      if (!same && colors.length) repairs.push(`${p}.colors → [${colors.join(',')}]`);
      l.colors = colors;
      delete l.colours;
      delete l.colorIndices;
      // One colour is not stripes or a gradient: it is a fill.
      if (colors.length === 1) {
        repairs.push(`${p}: one colour, drawn as a fill`);
        return { kind: 'fill', id: l.id, region: l.region, colorIndex: colors[0] };
      }
    }

    if (l.kind === 'stripes') {
      const o = String(l.orientation ?? l.direction ?? '').trim().toLowerCase();
      const fixed = ORIENTATIONS.has(o) ? o
        : /diag|sash|slant|angle/.test(o) ? 'diagonal'
        : /^h|horiz|hoop|row|across|band|landscape/.test(o) ? 'horizontal'
        : 'vertical'; // missing or unreadable: the stripes default
      if (fixed !== l.orientation) repairs.push(`${p}.orientation → ${fixed}`);
      l.orientation = fixed;
      delete l.direction;
    }
    if (l.kind === 'gradient' && typeof l.direction === 'string') {
      const d = l.direction.trim().toLowerCase();
      l.direction = /radial|circ|centre|center/.test(d) ? 'radial' : /^h|horiz|across|left|right/.test(d) ? 'horizontal' : 'vertical';
    }
    if (l.kind === 'pattern' && typeof l.pattern === 'string') {
      const pt = l.pattern.trim().toLowerCase();
      const fixed = (PATTERN_NAMES as readonly string[]).includes(pt) ? pt
        : /check|chess/.test(pt) ? 'checker'
        : /chevron|zig/.test(pt) ? 'chevron'
        : /hoop|stripe|band/.test(pt) ? 'hoops'
        : /grid|lattice|tartan|plaid/.test(pt) ? 'grid'
        : /flag/.test(pt) ? 'flag'
        : pt;
      if (fixed !== l.pattern) repairs.push(`${p}.pattern → ${fixed}`);
      l.pattern = fixed;
    }
    if (l.kind === 'symbol' && typeof l.symbol === 'string') l.symbol = l.symbol.trim().toLowerCase();
    return l;
  });
  return { spec: out, repairs };
}

/**
 * Validate a MODEL's design: repair what has one reading (coerceModelSpec), and
 * if a few layers are still broken, leave those layers out rather than throwing
 * away the design — at most a quarter of them, and never all. Anything worse is
 * a failed design, as before. `repairs` lists every change for the operator.
 */
export function validateModelSpec(input: unknown, fallback?: TifoSpec): SpecValidationResult & { repairs: string[] } {
  const { spec, repairs } = coerceModelSpec(input);
  const first = validateSpec(spec);
  if (first.valid || !isObj(spec) || !Array.isArray(spec.layers)) return { ...first, repairs };
  const bad = new Set<number>();
  for (const e of first.errors) {
    const m = /^layers\[(\d+)\]/.exec(e.path);
    if (!m) return { ...first, repairs }; // a palette or whole-spec problem: no salvage
    bad.add(Number(m[1]));
  }
  const total = spec.layers.length;
  if (bad.size === 0 || bad.size >= total || bad.size > Math.max(1, Math.floor(total / 4))) return { ...first, repairs };
  // A critic rewriting a design echoes its layer ids: a broken layer that has
  // a twin in the design it was given gets that layer back instead of vanishing
  // (losing the field under everything is worse than keeping the old one).
  const paletteLen = Array.isArray(spec.palette) ? spec.palette.length : 0;
  const fits = (l: SpecLayer): boolean => {
    const idx = 'colorIndex' in l ? [l.colorIndex] : 'colors' in l ? l.colors : [];
    return idx.every((k) => k >= 0 && k < paletteLen);
  };
  const restored: string[] = [];
  const kept = spec.layers.flatMap((raw, i) => {
    if (!bad.has(i)) return [raw];
    const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : `L${i}`;
    const twin = fallback?.layers.find((l) => l.id === id);
    if (twin && fits(twin)) { restored.push(id); return [twin]; }
    return [];
  });
  const second = validateSpec({ ...spec, layers: kept });
  if (!second.valid) return { ...first, repairs };
  return { ...second, repairs: [...repairs, ...restored.map((id) => `kept the original layer ${id}`), ...first.errors.map((e) => `${restored.length ? 'replaced or left out' : 'left out'} ${e.path}: ${e.message}`)] };
}
