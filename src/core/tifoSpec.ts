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
export const SPEC_FONT_IDS = ['impact', 'black', 'verdana', 'georgia', 'courier'] as const;
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
}

/** A single-colour symbol scaled to a fraction of the region's smaller side. */
export interface SymbolLayer extends BaseLayer {
  kind: 'symbol';
  symbol: SymbolName;
  colorIndex: number;
  /** Size as a fraction of min(regionWidth, regionHeight) (0.05..1). */
  scaleFrac: number;
  align: TextAlign;
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
  /** Size as a fraction of the region's smaller side (0.2..1). */
  scaleFrac: number;
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
  maxPalette: 8,
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
    return region.rows
      ? { stand: region.stands[0], tier: region.tier, rows: region.rows }
      : { stand: region.stands[0], tier: region.tier };
  }
  if (region.stand === 'all') return { ...region, stand: 'north' };
  return region;
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
        err(`${p}.region`, 'region must be a stand ("north"/"south"/"east"/"west"), "all"/"lower"/"upper"/"sides"/"ends", or { stand, tier, rows, stands }');
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
