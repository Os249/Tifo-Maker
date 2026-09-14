import type { SpecLayer, SymbolName, SpecFontId } from './tifoSpec';
import { CLUBS, type ClubIdentity } from './clubs';

/**
 * The template library's compositions.
 *
 * These are AUTHORED, not generated. promptDesigner.ts composes a spec from a
 * sentence, which is the right tool when someone types a brief — but pointed at
 * a library it produces mush: 24 generated designs collapsed to 13 distinct
 * rendered outputs, and half the layers were the same shape with different
 * colours. A template library is a different job. It wants a small number of
 * compositions that are actually good, each instantiated across palettes,
 * stands and messages, so every result inherits a deliberate layout.
 *
 * Everything here is built around one measurement. Unrolled, a stand is about
 * **317 seats wide by 48 rows tall** — a 6.6:1 ribbon — and the full bowl is
 * 10:1. Vertical space is the scarce resource, so:
 *
 *   - 48 rows is the ceiling for EVERYTHING. A symbol at scaleFrac 0.9 is 43
 *     rows tall; text at heightFrac 0.6 is 29 rows of cap height.
 *   - Horizontal bands are the canvas's natural grain. Vertical stripes work
 *     across the whole bowl (1268 columns) and look cramped inside one stand.
 *   - Two elements per region is the limit. A symbol AND a word in one stand
 *     leaves 24 rows each and both turn to soup; put them on opposite stands.
 *   - Fine detail is impossible and the symbol set is already curated for bold
 *     silhouettes. Nothing here asks for more than that.
 *
 * Palettes stay at 2-3 colours plus the empty-seat grey, which is both the flag
 * designers' rule of thumb and what a real card mosaic can physically hand out.
 */

/** Palette index 0 is always the empty seat. */
const EMPTY = '#262a33';

export interface Archetype {
  id: string;
  /** What the composition is, for the library's own documentation. */
  note: string;
  /** How many colours beyond the empty seat this composition needs. */
  minColors: number;
  /** Builds the spec. `colors` excludes the empty seat; indices are 1-based. */
  build(ctx: BuildContext): { layers: SpecLayer[]; background?: number };
  /** Which naming family this belongs to, for titles and tags. */
  family: 'block' | 'banner' | 'crest' | 'pattern' | 'split';
}

export interface BuildContext {
  /** Palette colours, index 1..n (0 is the empty seat). */
  n: number;
  /** The stand this instance targets, when the composition uses one. */
  stand: 'north' | 'south' | 'east' | 'west';
  /** The opposite stand, for compositions that use the bowl. */
  opposite: 'north' | 'south' | 'east' | 'west';
  /** A short word for text compositions, already upper-cased. */
  word: string;
  /** A second, shorter word or number. */
  word2: string;
  /** The symbol this instance uses. */
  symbol: SymbolName;
  fontId: SpecFontId;
  /** Deterministic 0..1 from the instance seed, for small controlled variation. */
  jitter: (k: number) => number;
}

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' } as const;

const region = (stand: BuildContext['stand'] | 'all', tier: number | 'all' = 'all', rows?: [number, number]) =>
  ({ stand, tier, ...(rows ? { rows } : {}) }) as SpecLayer['region'];

const multi = (stands: BuildContext['stand'][], rows?: [number, number]) =>
  ({ stand: 'all', tier: 'all', stands, ...(rows ? { rows } : {}) }) as SpecLayer['region'];

let uid = 0;
/** Omit that distributes over the union: a plain Omit<SpecLayer,'id'> collapses
 *  to the intersection of every layer kind's keys, which is almost nothing. */
type LayerBody = SpecLayer extends infer T ? (T extends SpecLayer ? Omit<T, 'id'> : never) : never;
/** Stamp an id onto a layer body; each call site supplies one concrete kind. */
const L = (l: LayerBody): SpecLayer => ({ id: `a${++uid}`, ...l }) as SpecLayer;

export const ARCHETYPES: Archetype[] = [
  {
    id: 'hoops',
    family: 'pattern',
    minColors: 2,
    note: 'Horizontal bands around the whole bowl. The canvas is a 10:1 ribbon, so this is its natural grain — and it is what a two-colour club looks like from the far side of the pitch.',
    build: ({ n, jitter }) => ({
      background: 1,
      layers: [L({ kind: 'stripes', region: region('all'), colors: n >= 3 ? [1, 2, 3] : [1, 2], orientation: 'horizontal', bands: 4 + Math.floor(jitter(1) * 3) * 2 })],
    }),
  },
  {
    id: 'scarf',
    family: 'pattern',
    minColors: 2,
    note: 'Vertical stripes around the bowl — the scarf held up end to end. Needs the full 1268-column width; inside one stand the bands crowd.',
    build: ({ n, jitter }) => ({
      background: 1,
      layers: [L({ kind: 'stripes', region: region('all'), colors: n >= 3 ? [1, 2, 3] : [1, 2], orientation: 'vertical', bands: 16 + Math.floor(jitter(2) * 4) * 4 })],
    }),
  },
  {
    id: 'halves',
    family: 'split',
    minColors: 2,
    note: 'The bowl cut once across the middle. Reads instantly from anywhere in the ground and survives a heavy no-show rate, because there is nothing small in it.',
    build: () => ({
      background: 1,
      layers: [L({ kind: 'fill', region: region('all', 'all', [0.5, 1]), colorIndex: 2 })],
    }),
  },
  {
    id: 'tier-split',
    family: 'split',
    minColors: 2,
    note: 'Upper tier one colour, lower the other. Uses the stadium\'s own architecture as the dividing line, so the edge is perfectly straight.',
    build: ({ n }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region('all', 1), colorIndex: 2 }),
        ...(n >= 3 ? [L({ kind: 'stripes', region: region('all', 0, [0.86, 1]), colors: [3, 3], orientation: 'horizontal', bands: 2 })] : []),
      ],
    }),
  },
  {
    id: 'ends-and-sides',
    family: 'split',
    minColors: 2,
    note: 'The two ends in one colour, the two long sides in the other. A derby composition: it makes the ground look like two halves of an argument.',
    build: () => ({
      background: 1,
      layers: [L({ kind: 'fill', region: multi(['north', 'south']), colorIndex: 2 })],
    }),
  },
  {
    id: 'banner',
    family: 'banner',
    minColors: 2,
    note: 'One word, as large as the stand can carry, on a flat field. The most-used tifo there is, and the hardest to beat: 29 rows of cap height reads from the opposite stand.',
    build: ({ stand, word, fontId }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region(stand), colorIndex: 1 }),
        L({ kind: 'text', region: region(stand), text: word, colorIndex: 2, fontId, arcDeg: 0, heightFrac: 0.62, align: 'center' }),
      ],
    }),
  },
  {
    id: 'banner-framed',
    family: 'banner',
    minColors: 3,
    note: 'The same word, held inside a band top and bottom in the third colour. The frame gives the letters an edge to sit against instead of floating.',
    build: ({ stand, word, fontId }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region(stand), colorIndex: 1 }),
        L({ kind: 'fill', region: region(stand, 'all', [0, 0.12]), colorIndex: 3 }),
        L({ kind: 'fill', region: region(stand, 'all', [0.88, 1]), colorIndex: 3 }),
        L({ kind: 'text', region: region(stand, 'all', [0.12, 0.88]), text: word, colorIndex: 2, fontId, arcDeg: 0, heightFrac: 0.72, align: 'center' }),
      ],
    }),
  },
  {
    id: 'banner-arched',
    family: 'banner',
    minColors: 2,
    note: 'The word bent along the curve of the bowl. Costs a few rows of height, and buys the look of a display built for that specific stand.',
    build: ({ stand, word, fontId, jitter }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region(stand), colorIndex: 1 }),
        L({ kind: 'text', region: region(stand), text: word, colorIndex: 2, fontId, arcDeg: 18 + Math.round(jitter(3) * 14), heightFrac: 0.58, align: 'center' }),
      ],
    }),
  },
  {
    id: 'crest-on-stripes',
    family: 'crest',
    minColors: 3,
    note: 'A badge on a banded field. One symbol is only 48 columns of a stand\'s 317, so it needs the bands around it to read as a centrepiece instead of a speck.',
    build: ({ stand, symbol }) => ({
      background: 1,
      layers: [
        L({ kind: 'stripes', region: region(stand), colors: [1, 3], orientation: 'horizontal', bands: 6 }),
        L({ kind: 'fill', region: region(stand, 'all', [0.34, 0.66]), colorIndex: 1 }),
        L({ kind: 'symbol', region: region(stand), symbol, colorIndex: 2, scaleFrac: 0.95, align: 'center' }),
      ],
    }),
  },
  {
    id: 'crest-and-word',
    family: 'crest',
    minColors: 3,
    note: 'Symbol on one end, word on the other, facing each other across the pitch. This is how you use a whole bowl without cramming two things into 48 rows.',
    build: ({ stand, opposite, symbol, word, fontId }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region(stand), colorIndex: 3 }),
        L({ kind: 'symbol', region: region(stand), symbol, colorIndex: 2, scaleFrac: 0.95, align: 'center' }),
        L({ kind: 'text', region: region(opposite), text: word, colorIndex: 2, fontId, arcDeg: 0, heightFrac: 0.62, align: 'center' }),
      ],
    }),
  },
  {
    id: 'number',
    family: 'banner',
    minColors: 2,
    note: 'A squad number at full stand height. Two glyphs across 317 columns is the most legible thing this canvas can draw.',
    build: ({ stand, word2, fontId }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region(stand), colorIndex: 1 }),
        L({ kind: 'text', region: region(stand), text: word2, colorIndex: 2, fontId, arcDeg: 0, heightFrac: 0.86, align: 'center' }),
      ],
    }),
  },
  {
    id: 'checker',
    family: 'pattern',
    minColors: 2,
    note: 'A coarse checkerboard. Deliberately coarse: at finer scales the squares fall below the row height and the whole thing greys out.',
    build: ({ n, jitter }) => ({
      background: 1,
      layers: [L({ kind: 'pattern', region: region('all'), pattern: 'checker', colors: n >= 3 ? [1, 2, 3] : [1, 2], scale: 10 + Math.floor(jitter(4) * 3) * 4 })],
    }),
  },
  {
    id: 'chevron',
    family: 'pattern',
    minColors: 2,
    note: 'Chevrons around the bowl. The diagonal is the one direction plain stripes cannot give you, and it makes a static display look like it is moving.',
    build: ({ n, jitter }) => ({
      background: 1,
      layers: [L({ kind: 'pattern', region: region('all'), pattern: 'chevron', colors: n >= 3 ? [1, 2, 3] : [1, 2], scale: 12 + Math.floor(jitter(5) * 3) * 4 })],
    }),
  },
  {
    id: 'sash',
    family: 'pattern',
    minColors: 2,
    note: 'A diagonal sash across the whole ground. Wide bands only — a thin diagonal on a 48-row canvas turns into a staircase.',
    build: ({ n }) => ({
      background: 1,
      layers: [L({ kind: 'stripes', region: region('all'), colors: n >= 3 ? [1, 2, 3] : [1, 2], orientation: 'diagonal', bands: 6 })],
    }),
  },
  {
    id: 'gradient-wall',
    family: 'pattern',
    minColors: 2,
    note: 'A dithered fade up the stand, darkest at the front. The dither is what makes two colours read as many at seat scale.',
    build: ({ n }) => ({
      background: 1,
      layers: [L({ kind: 'gradient', region: region('all'), colors: n >= 3 ? [1, 2, 3] : [1, 2], direction: 'vertical' })],
    }),
  },
  {
    id: 'mosaic-word',
    family: 'block',
    minColors: 3,
    note: 'A fine grid across the bowl with one word cut out of it on a flat panel. The texture everywhere else makes the clear panel read as deliberate.',
    build: ({ stand, word, fontId }) => ({
      background: 1,
      layers: [
        L({ kind: 'pattern', region: region('all'), pattern: 'grid', colors: [1, 3], scale: 34 }),
        L({ kind: 'fill', region: region(stand), colorIndex: 1 }),
        L({ kind: 'text', region: region(stand), text: word, colorIndex: 2, fontId, arcDeg: 0, heightFrac: 0.64, align: 'center' }),
      ],
    }),
  },
  {
    id: 'goalline-band',
    family: 'block',
    minColors: 3,
    note: 'A thick accent band low across the whole ground with the word riding above it. Uses the rows nearest the pitch, which are the ones on television.',
    build: ({ word, fontId, stand }) => ({
      background: 1,
      layers: [
        L({ kind: 'fill', region: region('all', 'all', [0, 0.3]), colorIndex: 3 }),
        L({ kind: 'text', region: region(stand, 'all', [0.3, 1]), text: word, colorIndex: 2, fontId, arcDeg: 0, heightFrac: 0.8, align: 'center' }),
      ],
    }),
  },
  {
    id: 'flag',
    family: 'pattern',
    minColors: 3,
    note: 'Flag bands around the bowl. Three colours, hard edges, nothing else — the composition that survives the worst no-show rate of any here.',
    build: () => ({
      background: 1,
      layers: [L({ kind: 'pattern', region: region('all'), pattern: 'flag', colors: [1, 2, 3], scale: 6 })],
    }),
  },
];

// ---------------------------------------------------------------------------
// Instance vocabulary
// ---------------------------------------------------------------------------

/** Short, stadium-legible words. Anything longer than about nine characters
 *  drops below readable cap height once it has to fit 317 columns. */
export const WORDS_EN = [
  'CHAMPIONS', 'FOREVER', 'PRIDE', 'BELIEVE', 'LEGENDS', 'GLORY', 'UNITED',
  'HOME', 'ALWAYS', 'FEARLESS', 'OUR CITY', 'ONE CLUB', 'RISE', 'NEVER',
  'LOYAL', 'HONOUR', 'DERBY', 'FINAL', 'HISTORY', 'TOGETHER',
];

/** The same register in Arabic — the primary audience, not an afterthought. */
export const WORDS_AR = [
  'الزعيم', 'دائماً', 'فخر', 'أسطورة', 'المجد', 'إلى الأبد', 'نحن هنا',
  'العميد', 'الوفاء', 'الديربي', 'النهائي', 'التاريخ', 'معاً', 'الأبطال',
];

export const NUMBERS = ['7', '10', '9', '1', '11', '21', '99', '3'];

export const NEUTRAL_PALETTES: { name: string; colors: string[] }[] = [
  { name: 'Red & white', colors: ['#c8242c', '#f2f1ec'] },
  { name: 'Blue & white', colors: ['#1c5fd9', '#f2f1ec'] },
  { name: 'Black & gold', colors: ['#16161a', '#e8b73a'] },
  { name: 'Green & white', colors: ['#0f7a3d', '#f2f1ec'] },
  { name: 'Claret & blue', colors: ['#7a1f3d', '#1c5fd9'] },
  { name: 'Monochrome', colors: ['#16161a', '#f2f1ec'] },
  { name: 'Red, white & black', colors: ['#c8242c', '#f2f1ec', '#16161a'] },
  { name: 'Blue, white & gold', colors: ['#1c5fd9', '#f2f1ec', '#e8b73a'] },
  { name: 'Green, white & black', colors: ['#0f7a3d', '#f2f1ec', '#16161a'] },
  { name: 'Sky & navy', colors: ['#5bc0eb', '#10233f'] },
  { name: 'Orange & black', colors: ['#e8731a', '#16161a'] },
  { name: 'Purple & gold', colors: ['#6b2fb3', '#e8b73a'] },
];

export const SYMBOLS_BOLD: SymbolName[] = [
  'eagle', 'crown', 'shield', 'star', 'crescent', 'flame', 'bolt', 'fist',
  'wings', 'heart', 'anchor', 'ball', 'star6', 'diamond',
];

export const FONTS: SpecFontId[] = ['impact', 'black', 'verdana'];

/** Clubs, with the empty-seat colour prepended to make a spec palette. */
export function clubPalette(club: ClubIdentity): string[] {
  return [EMPTY, ...club.palette.slice(0, 3)];
}

export function neutralPalette(colors: string[]): string[] {
  return [EMPTY, ...colors.slice(0, 3)];
}

export { CLUBS, EMPTY, OPPOSITE };
