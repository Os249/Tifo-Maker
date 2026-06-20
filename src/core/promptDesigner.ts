/**
 * Offline prompt designer — the deterministic "choreography brain".
 *
 * Turns a natural-language brief ("giant eagle covering the south stand",
 * "red and white CHAMPIONS across the stadium") into a TifoSpec, with NO model
 * call. It encodes the same supporter-culture heuristics we put in the LLM
 * system prompt: pick a small legible palette, fill a background, lay out big
 * bold text and a bold symbol, scope everything to the requested stand, and keep
 * the visual hierarchy (background → stripes → symbol → text).
 *
 * The server uses this as the default generator (and as the fallback whenever a
 * model is unavailable), so the feature works end-to-end with zero credentials.
 * It is pure and DOM-free, so it also runs in the verify harness.
 */

import {
  type TifoSpec,
  type SpecLayer,
  type Region,
  type SymbolName,
  type RegionInput,
  SYMBOL_NAMES,
  normalizeRegion,
  validateSpec,
} from './tifoSpec';

const EMPTY = '#262a33';

/** Colour lexicon: word(s) → hex. Two-word phrases are matched before singles. */
const COLOR_WORDS: Array<[RegExp, string]> = [
  [/royal blue/, '#1c5fd9'],
  [/sky blue/, '#5bc0eb'],
  [/navy( blue)?/, '#10233f'],
  [/light blue/, '#5bc0eb'],
  [/dark blue/, '#10233f'],
  [/claret/, '#7a1f3d'],
  [/maroon/, '#6e1423'],
  [/burgundy/, '#6e1423'],
  [/\bgold(en)?\b/, '#e8b73a'],
  [/\byellow\b/, '#f4d03f'],
  [/\bred\b/, '#c8242c'],
  [/crimson|scarlet/, '#c8242c'],
  [/\bwhite\b/, '#f2f1ec'],
  [/\bblack\b/, '#16161a'],
  [/\bblue\b/, '#1c5fd9'],
  [/\bgreen\b/, '#0f7a3d'],
  [/\borange\b/, '#e8731a'],
  [/\bpurple|violet\b/, '#6b2fb3'],
  [/\bpink|magenta\b/, '#e85aa0'],
  [/\bcyan|teal\b/, '#1bb6c1'],
  [/\blime\b/, '#7ac70c'],
  [/\bsilver\b/, '#c7ccd1'],
  [/\bgrey|gray\b/, '#8a8f98'],
  [/\bbrown\b/, '#6b4423'],
];

/** Keyword → symbol. Animals/figures we can't draw map to a bold emblem. */
const SYMBOL_WORDS: Array<[RegExp, SymbolName]> = [
  [/eagle|falcon|hawk|bird/, 'eagle'],
  [/wings?/, 'wings'],
  [/crown|king|royal/, 'crown'],
  [/shield|crest|emblem|badge|lion|bull|tiger|wolf|dragon|bear|ram|fox|devil/, 'shield'],
  [/star\b|stars?/, 'star'],
  [/heart|love/, 'heart'],
  [/\bcross\b/, 'cross'],
  [/lightning|bolt|thunder|power/, 'bolt'],
  [/flame|fire|burn/, 'flame'],
  [/anchor|harbou?r|port|dock/, 'anchor'],
  [/ball|football|soccer/, 'ball'],
  [/fist|strength|fight|resist/, 'fist'],
  [/crescent|moon/, 'crescent'],
  [/diamond/, 'diamond'],
  [/circle|round|dot/, 'circle'],
  [/ring|hoop/, 'ring'],
  [/chevron|arrow/, 'chevron'],
];

/** A few well-known players → display name + shirt number, for "<player> tifo". */
const PLAYERS: Record<string, { name: string; num?: string }> = {
  ronaldo: { name: 'RONALDO', num: '7' },
  messi: { name: 'MESSI', num: '10' },
  mbappe: { name: 'MBAPPE', num: '7' },
  neymar: { name: 'NEYMAR', num: '10' },
  salah: { name: 'SALAH', num: '11' },
  benzema: { name: 'BENZEMA', num: '9' },
  haaland: { name: 'HAALAND', num: '9' },
  maradona: { name: 'MARADONA', num: '10' },
  pele: { name: 'PELE', num: '10' },
  zidane: { name: 'ZIDANE', num: '5' },
};

/** Slogan words worth promoting to the headline when no explicit text is given. */
const SLOGANS = ['champions', 'forza', 'ultras', 'allez', 'history', 'legends', 'glory', 'pride', 'believe', 'invincible', 'fortuna', 'fede'];

function luminance(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
}

/** Darkest non-empty colour — the authentic "field" for an ultras display. */
function darkestIndex(palette: string[]): number {
  let best = 1;
  let bestL = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const l = luminance(palette[i]);
    if (l < bestL) { bestL = l; best = i; }
  }
  return best;
}

/** Index whose colour contrasts most with `bg` (skipping empty + bg itself). */
function contrastIndex(palette: string[], bgIndex: number): number {
  const bgLum = luminance(palette[bgIndex] ?? EMPTY);
  let best = bgIndex;
  let bestD = -1;
  for (let i = 1; i < palette.length; i++) {
    if (i === bgIndex) continue;
    const d = Math.abs(luminance(palette[i]) - bgLum);
    if (d > bestD) { bestD = d; best = i; }
  }
  return best;
}

/** A third colour different from both given indices, for accents (number, trim). */
function accentIndex(palette: string[], avoid: number[]): number {
  for (let i = 1; i < palette.length; i++) if (!avoid.includes(i)) return i;
  return contrastIndex(palette, avoid[0] ?? 0);
}

function pickColors(p: string): string[] {
  const out: string[] = [];
  let rest = p;
  for (const [re, hex] of COLOR_WORDS) {
    if (re.test(rest) && !out.includes(hex)) {
      out.push(hex);
      rest = rest.replace(new RegExp(re, 'g'), ' '); // consume so "navy blue" isn't also "blue"
    }
  }
  return out;
}

function pickRegion(p: string): RegionInput {
  if (/\b(across|whole|entire|all stands?|full|stadium-?wide|everywhere|four stands?)\b/.test(p)) return 'all';
  if (/\bnorth\b/.test(p)) return 'north';
  if (/\bsouth\b/.test(p)) return 'south';
  if (/\beast\b/.test(p)) return 'east';
  if (/\bwest\b/.test(p)) return 'west';
  if (/\bkop\b/.test(p)) return 'north';
  if (/\bupper\b/.test(p)) return 'upper';
  if (/\blower\b/.test(p)) return 'lower';
  return 'all';
}

function pickSymbol(p: string): SymbolName | null {
  for (const [re, name] of SYMBOL_WORDS) if (re.test(p)) return name;
  return null;
}

/** Headline + optional sub-number, from quotes / known players / slogans / CAPS. */
function pickText(original: string, lower: string): { head: string | null; sub: string | null } {
  // 1) Quoted text wins.
  const q = original.match(/["“”']([^"“”']{1,40})["“”']/);
  if (q) return { head: q[1].toUpperCase().trim(), sub: null };

  // 2) Known player → surname + number.
  for (const key of Object.keys(PLAYERS)) {
    if (lower.includes(key)) return { head: PLAYERS[key].name, sub: PLAYERS[key].num ?? null };
  }

  // 3) Explicit "says / saying / reads / text / word X..."
  const says = original.match(/\b(?:says?|saying|reads?|text|word|slogan)\s+["“']?([A-Za-z0-9 ]{2,30})/i);
  if (says) return { head: says[1].toUpperCase().trim(), sub: null };

  // 4) A standalone ALL-CAPS token already in the brief (e.g. CHAMPIONS).
  const caps = original.match(/\b[A-Z][A-Z0-9]{2,20}\b/g)?.filter((w) => !['AI', 'TIFO'].includes(w));
  if (caps && caps.length) return { head: caps[0], sub: null };

  // 5) A slogan keyword.
  for (const s of SLOGANS) if (lower.includes(s)) return { head: s.toUpperCase(), sub: null };

  return { head: null, sub: null };
}

function detectStripes(p: string): 'stripes' | 'halves' | null {
  if (/\bstripe|striped|stripes|hoops?|bands?\b/.test(p)) return 'stripes';
  if (/\bhalf|halves|half-?and-?half|split\b/.test(p)) return 'halves';
  return null;
}

/**
 * Compose a TifoSpec from a free-text prompt. Always returns a spec that passes
 * validateSpec (it is normalized through it before returning).
 */
export function designFromPrompt(prompt: string): TifoSpec {
  const original = (prompt ?? '').slice(0, 400);
  const p = original.toLowerCase();

  // ---- palette ----
  const colors = pickColors(p);
  const palette = colors.length > 0 ? [EMPTY, ...colors.slice(0, 7)] : [EMPTY, '#16161a', '#f2f1ec'];
  if (palette.length < 3) palette.push(palette[1] === '#f2f1ec' ? '#16161a' : '#f2f1ec'); // guarantee a contrast colour

  // ---- region ----
  const region = pickRegion(p);
  const scopeAll = region === 'all';

  // ---- roles ----
  // The darkest colour becomes the field (dark stands + bright art reads best at
  // stadium scale and matches ultras convention); the brightest contrasts it.
  const bg = darkestIndex(palette);
  const head = contrastIndex(palette, bg); // headline / main symbol contrasts the field
  const accent = accentIndex(palette, [bg, head]);

  const layers: SpecLayer[] = [];

  // 1) background field over the scoped region
  layers.push({ kind: 'fill', id: 'bg', region: regionObj(region), colorIndex: bg });

  // 2) stripes / halves, if asked
  const stripeKind = detectStripes(p);
  if (stripeKind && palette.length >= 3) {
    layers.push({
      kind: 'stripes', id: 'stripes', region: regionObj(region),
      colors: stripeKind === 'halves' ? [bg, head] : [bg, head, accent].slice(0, Math.min(3, palette.length - 1)),
      orientation: /horizontal|hoops?/.test(p) ? 'horizontal' : /diagonal|sash/.test(p) ? 'diagonal' : 'vertical',
      bands: stripeKind === 'halves' ? 2 : 0, // 0 → compiler/validator default; set explicitly below
    });
    // validator clamps bands to >=2; pick a sensible count for true stripes.
    const last = layers[layers.length - 1];
    if (last.kind === 'stripes' && stripeKind === 'stripes') last.bands = 9;
  }

  // 3) symbol (centred, bold)
  const symbol = pickSymbol(p);
  if (symbol) {
    layers.push({
      kind: 'symbol', id: 'symbol', region: regionObj(region),
      symbol, colorIndex: head,
      scaleFrac: 0.8,
      align: 'center',
    });
  }

  // 4) text — headline + optional number, stacked when both present
  const { head: headline, sub } = pickText(original, p);
  if (headline) {
    const wide = scopeAll || headline.length >= 9;
    if (sub) {
      // surname on top, number below
      layers.push({ kind: 'text', id: 'headline', region: rowsObj(region, [0.42, 1]), text: headline, colorIndex: symbol ? accent : head, fontId: 'impact', arcDeg: 0, heightFrac: 0.5, align: 'center' });
      layers.push({ kind: 'text', id: 'number', region: rowsObj(region, [0, 0.38]), text: sub, colorIndex: accent, fontId: 'impact', arcDeg: 0, heightFrac: 0.34, align: 'center' });
    } else {
      layers.push({ kind: 'text', id: 'headline', region: regionObj(region), text: headline, colorIndex: symbol ? accent : head, fontId: 'impact', arcDeg: wide ? 0 : 0, heightFrac: symbol ? 0.34 : 0.62, align: symbol ? 'bottom' : 'center' });
    }
  }

  const title = (headline || symbol || (colors.length ? 'Colour' : 'Tifo')) + ' tifo';
  const spec: TifoSpec = {
    version: 1,
    title: cap(title),
    summary: summarize(region, palette.length - 1, headline, symbol, stripeKind),
    palette,
    background: scopeAll ? bg : undefined,
    layers,
  };

  // Normalize through the validator so offline output obeys the exact same
  // contract as model output (defaults filled, bands clamped, regions expanded).
  const res = validateSpec(spec);
  return res.spec ?? spec;
}

/** Normalize a region shorthand to the object form layers require. */
function regionObj(r: RegionInput): Region {
  return normalizeRegion(r) ?? { stand: 'all', tier: 'all' };
}
/** Same, but clipped to a vertical row band (front=0 … back=1). */
function rowsObj(r: RegionInput, rows: [number, number]): Region {
  return { ...regionObj(r), rows };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function summarize(region: RegionInput, nColors: number, headline: string | null, symbol: SymbolName | null, stripes: string | null): string {
  const where = region === 'all' ? 'the whole stadium' : `the ${region} stand`;
  const bits: string[] = [];
  if (symbol) bits.push(`a bold ${symbol}`);
  if (headline) bits.push(`“${headline}”`);
  if (stripes) bits.push(stripes === 'halves' ? 'a split field' : 'stripes');
  const what = bits.length ? bits.join(' + ') : 'a solid colour field';
  return `${cap(what)} across ${where}, ${nColors}-colour palette.`;
}

/** Exposed for the UI / docs: the vocabulary the designer understands. */
export const DESIGNER_VOCAB = { symbols: SYMBOL_NAMES, players: Object.keys(PLAYERS) };
