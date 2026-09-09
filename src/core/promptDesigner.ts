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
  type PatternName,
  type RegionInput,
  SYMBOL_NAMES,
  normalizeRegion,
  validateSpec,
} from './tifoSpec';
import { matchClub } from './clubs';

const EMPTY = '#262a33';

/** Colour lexicon: word(s) → hex. Two-word phrases are matched before singles. */
const COLOR_WORDS: Array<[RegExp, string]> = [
  // Two-word / specific shades first so "navy blue" isn't also caught as "blue".
  [/royal blue|أزرق ملكي/, '#1c5fd9'],
  [/sky blue|سماوي|سماوية/, '#5bc0eb'],
  [/navy( blue)?|كحلي|كحلية/, '#10233f'],
  [/light blue/, '#5bc0eb'],
  [/dark blue/, '#10233f'],
  [/claret|عنابي/, '#7a1f3d'],
  [/maroon|burgundy|خمري|نبيتي/, '#6e1423'],
  [/\bgold(en)?\b|ذهبي|ذهبية|دهبي/, '#e8b73a'],
  [/\byellow\b|أصفر|صفراء|اصفر/, '#f4d03f'],
  [/\bred\b|crimson|scarlet|أحمر|حمراء|احمر/, '#c8242c'],
  [/\bwhite\b|أبيض|بيضاء|ابيض/, '#f2f1ec'],
  [/\bblack\b|أسود|سوداء|اسود/, '#16161a'],
  [/\bblue\b|أزرق|زرقاء|ازرق/, '#1c5fd9'],
  [/\bgreen\b|أخضر|خضراء|اخضر/, '#0f7a3d'],
  [/\borange\b|برتقالي|برتقالية/, '#e8731a'],
  [/\bpurple|violet\b|بنفسجي|أرجواني/, '#6b2fb3'],
  [/\bpink|magenta\b|وردي|زهري/, '#e85aa0'],
  [/\bcyan|teal|turquoise\b|تركواز|فيروزي/, '#1bb6c1'],
  [/\blime\b/, '#7ac70c'],
  [/\bsilver\b|فضي|فضية/, '#c7ccd1'],
  [/\bgrey|gray\b|رمادي|رمادية/, '#8a8f98'],
  [/\bbrown\b|بني|بنية/, '#6b4423'],
  [/\bbeige|cream\b|بيج|كريمي/, '#e8dcc0'],
];

/** Keyword → symbol. Animals/figures we can't draw map to a bold emblem. */
const SYMBOL_WORDS: Array<[RegExp, SymbolName]> = [
  [/eagle|falcon|hawk|bird|نسر|صقر|طائر/, 'eagle'],
  [/wings?|أجنحة|جناح/, 'wings'],
  [/crown|king|royal|تاج|ملك|ملكي/, 'crown'],
  [/shield|crest|emblem|badge|lion|bull|tiger|wolf|dragon|bear|ram|fox|devil|درع|شعار|أسد|نمر|ثور|ذئب|تنين/, 'shield'],
  [/star\b|stars?|نجمة|نجوم|نجم/, 'star'],
  [/heart|love|قلب|حب/, 'heart'],
  [/\bcross\b|صليب/, 'cross'],
  [/lightning|bolt|thunder|power|برق|رعد|قوة/, 'bolt'],
  [/flame|fire|burn|نار|لهب|لهيب/, 'flame'],
  [/anchor|harbou?r|port|dock|مرساة|ميناء/, 'anchor'],
  [/ball|football|soccer|كرة|كورة/, 'ball'],
  [/fist|strength|fight|resist|قبضة|نضال/, 'fist'],
  [/crescent|moon|هلال|قمر/, 'crescent'],
  [/diamond|ماس|معين/, 'diamond'],
  [/triangle|مثلث/, 'triangle'],
  [/square|مربع/, 'square'],
  [/circle|round|dot|دائرة/, 'circle'],
  [/ring|hoop|حلقة/, 'ring'],
  [/chevron|arrow|سهم/, 'chevron'],
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
const SLOGANS = [
  'champions', 'forza', 'ultras', 'allez', 'history', 'legends', 'glory', 'pride', 'believe', 'invincible', 'fortuna', 'fede',
  'الزعيم', 'العالمي', 'أبطال', 'مجد', 'شرف', 'الأسطورة', 'جمهور', 'إيمان', 'فخر', 'العنيد', 'عشق',
];

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
  if (/\b(across|whole|entire|all stands?|full|stadium-?wide|everywhere|four stands?)\b|كامل|كل المدرجات|الملعب كامل|كل الملعب|المدرجات كلها/.test(p)) return 'all';
  if (/\bnorth\b|الشمال|الشمالي|شمالي/.test(p)) return 'north';
  if (/\bsouth\b|الجنوب|الجنوبي|جنوبي/.test(p)) return 'south';
  if (/\beast\b|الشرق|الشرقي|شرقي/.test(p)) return 'east';
  if (/\bwest\b|الغرب|الغربي|غربي/.test(p)) return 'west';
  if (/\bkop\b/.test(p)) return 'north';
  if (/\bupper\b|علوي|العلوي/.test(p)) return 'upper';
  if (/\blower\b|سفلي|السفلي/.test(p)) return 'lower';
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

  // 3b) Arabic text trigger: "مكتوب / يقول / شعار / عبارة / كلمة X".
  const saysAr = original.match(/(?:مكتوب|يقول|شعار|عبارة|كلمة)\s*[:\-]?\s*["“']?([؀-ۿ0-9 ]{2,30})/);
  if (saysAr) return { head: saysAr[1].trim(), sub: null };

  // 4) A standalone ALL-CAPS token already in the brief (e.g. CHAMPIONS).
  const caps = original.match(/\b[A-Z][A-Z0-9]{2,20}\b/g)?.filter((w) => !['AI', 'TIFO'].includes(w));
  if (caps && caps.length) return { head: caps[0], sub: null };

  // 5) A slogan keyword.
  for (const s of SLOGANS) if (lower.includes(s)) return { head: s.toUpperCase(), sub: null };

  return { head: null, sub: null };
}

function detectStripes(p: string): 'stripes' | 'halves' | null {
  if (/\bstripe|striped|stripes|hoops?|bands?\b|مخطط|خطوط|مقلم/.test(p)) return 'stripes';
  if (/\bhalf|halves|half-?and-?half|split\b|نصفين|نصفان|مقسوم/.test(p)) return 'halves';
  return null;
}

/** Detect a repeating mosaic pattern (checker/grid/flag/hoops/chevron). */
function detectPattern(p: string): PatternName | null {
  if (/checker|chequer|checked|رقعة|شطرنج/.test(p)) return 'checker';
  if (/mosaic|grid|pixel|tiles?|بلاط|فسيفساء|موزاييك|شبكة/.test(p)) return 'grid';
  if (/\bflag\b|tricolor|tricolour|علم|أعلام/.test(p)) return 'flag';
  if (/hoops?|طوق|حلقات/.test(p)) return 'hoops';
  if (/chevron|zigzag|أسهم|متعرج|زجزاج/.test(p)) return 'chevron';
  return null;
}

/** Detect a dithered gradient and its direction. */
function detectGradient(p: string): 'vertical' | 'horizontal' | 'radial' | null {
  if (/radial|glow|halo|sunburst|burst|إشعاع|توهج|دائري/.test(p)) return 'radial';
  if (/gradient|fade|ombre|تدرج|متدرج/.test(p)) return /horizontal|أفقي/.test(p) ? 'horizontal' : 'vertical';
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
  const club = matchClub(p);
  const colors = club ? club.palette : pickColors(p);
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

  // 2) field treatment: gradient > pattern (checker/grid/flag/hoops/chevron) > stripes/halves
  const gradientKind = detectGradient(p);
  const patternKind = detectPattern(p);
  const stripeKind = detectStripes(p);
  const triCols = [bg, head, accent].slice(0, Math.min(3, palette.length - 1));
  if (gradientKind && palette.length >= 3) {
    layers.push({ kind: 'gradient', id: 'grad', region: regionObj(region), colors: [bg, head], direction: gradientKind });
  } else if (patternKind && palette.length >= 3) {
    const scale = patternKind === 'grid' ? 18 : patternKind === 'hoops' ? 9 : patternKind === 'flag' ? 6 : 14;
    layers.push({ kind: 'pattern', id: 'pattern', region: regionObj(region), pattern: patternKind, colors: triCols, scale });
  } else if (stripeKind && palette.length >= 3) {
    layers.push({
      kind: 'stripes', id: 'stripes', region: regionObj(region),
      colors: stripeKind === 'halves' ? [bg, head] : triCols,
      orientation: /horizontal|hoops?|أفقي/.test(p) ? 'horizontal' : /diagonal|sash|مائل/.test(p) ? 'diagonal' : 'vertical',
      bands: stripeKind === 'halves' ? 2 : 0, // 0 → compiler/validator default; set explicitly below
    });
    // validator clamps bands to >=2; pick a sensible count for true stripes.
    const last = layers[layers.length - 1];
    if (last.kind === 'stripes' && stripeKind === 'stripes') last.bands = 9;
  }

  // 3) symbol (centred, bold)
  const symbol = pickSymbol(p) ?? club?.crest ?? null;
  if (symbol) {
    layers.push({
      kind: 'symbol', id: 'symbol', region: regionObj(region),
      symbol, colorIndex: head,
      scaleFrac: 0.8,
      align: 'center',
    });
  }

  // 4) text: headline + optional number, stacked when both present
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

function hasKnownPlayer(lower: string): boolean {
  return Object.keys(PLAYERS).some((k) => lower.includes(k));
}

/** Build an image prompt for a portrait hero (known player → name; else the brief). */
function portraitPrompt(original: string, lower: string): string {
  for (const key of Object.keys(PLAYERS)) {
    if (lower.includes(key)) return `bold graphic poster portrait of ${PLAYERS[key].name}, flat tones`;
  }
  return `${original.trim().slice(0, 120)}: bold graphic poster portrait, flat tones`;
}

type Occasion = 'derby' | 'farewell' | 'anniversary' | 'title' | 'heritage' | 'welcome' | 'mosaic' | 'generic';

/** Classify the brief into a choreography occasion → drives a distinct layout. */
function detectOccasion(p: string): Occasion {
  if (/\bderby\b|\brival|clasico|clásico|\bvs\b|versus|\bagainst\b|ديربي|كلاسيكو|ضد|مواجهة/.test(p)) return 'derby';
  if (/farewell|goodbye|tribute|\bretir|thank you|grazie|gracias|memorial|\brip\b|forever|legend|وداع|شكرا|شكرًا|تكريم|أسطورة|رحيل/.test(p)) return 'farewell';
  if (/anniversar|centenar|\byears?\b|since\s*\d{4}|est\.?\s*\d{4}|founded|\b\d{4}\s*[-–]\s*\d{4}\b|ذكرى|سنوية|تأسيس|سنة|عام/.test(p)) return 'anniversary';
  if (/champion|\btitle\b|troph|winners?|\bglory\b|victory|\bcup\b|treble|invincible|بطل|بطولة|كأس|لقب|مجد|انتصار/.test(p)) return 'title';
  if (/heritage|history|tradition|legacy|roots|dynasty|تاريخ|تراث|إرث|عراقة|تقاليد/.test(p)) return 'heritage';
  if (/welcome|promotion|promoted|\breturn\b|back to|مرحبا|أهلا|أهلاً|العودة|صعود|ترقية/.test(p)) return 'welcome';
  if (/mosaic|card stunt|mega.?word|فسيفساء|موزاييك|بطاقات/.test(p)) return 'mosaic';
  return 'generic';
}

/** A standalone number for an anniversary headline (e.g. "100" from "100 years"). */
function pickNumber(p: string): string | null {
  const yrs = p.match(/\b(\d{1,3})\s*years?\b/);
  if (yrs) return yrs[1];
  const any = p.match(/\b(\d{2,3})\b/);
  return any ? any[1] : null;
}

/** A years line for the sub-headline (a range, or "EST. yyyy"). */
function pickYears(p: string): string | null {
  const range = p.match(/\b(\d{4})\s*[-–to ]+\s*(\d{4})\b/);
  if (range) return `${range[1]} – ${range[2]}`;
  const since = p.match(/(?:since|est\.?|founded(?:\s+in)?)\s*(\d{4})/);
  return since ? `EST. ${since[1]}` : null;
}

/** Warmest palette card (gold/yellow/red) for celebrations; else a contrast card. */
function warmestIndex(palette: string[], avoid: number): number {
  let best = -1;
  let bestW = -Infinity;
  for (let i = 1; i < palette.length; i++) {
    if (i === avoid) continue;
    const v = parseInt(palette[i].slice(1), 16);
    const w = ((v >> 16) & 255) + 0.5 * ((v >> 8) & 255) - (v & 255);
    if (w > bestW) { bestW = w; best = i; }
  }
  return best < 0 ? contrastIndex(palette, avoid) : best;
}

/**
 * Offline MULTI-STAND composer for Super AI (Mode 3) — a deterministic, varied,
 * full-bowl design with NO model call. Super AI's fallback when the model is
 * unavailable (e.g. a free-tier 429), so "design the whole stadium" still yields
 * a real, occasion-appropriate scene rather than one fixed template.
 *
 * The brief is classified into an OCCASION and each gets a distinct composition:
 * chevrons + colour blocking for a derby, solemn gradients + portrait for a
 * farewell, a mosaic + giant number for an anniversary, a gold radial glow for a
 * title, classic stripes + crest for heritage, else a clean hero/name/sides
 * layout. Portraits ride the free image path (Pollinations), so even this offline
 * route renders a face without touching the text-model quota. Bold by default and
 * normalized through validateSpec (same contract as model output).
 */
export function composeSuperOffline(prompt: string, opts: { variant?: number } = {}): TifoSpec {
  const original = (prompt ?? '').slice(0, 400);
  const p = original.toLowerCase();

  const club = matchClub(p);
  let colors = club ? club.palette : pickColors(p);
  // Variant seed: rotate the design colours so each "shuffle" emphasises a
  // different one — free, deterministic variety with no model call.
  const variant = Math.max(0, Math.floor(opts.variant ?? 0));
  if (variant > 0 && colors.length > 1) {
    const k = variant % colors.length;
    colors = [...colors.slice(k), ...colors.slice(0, k)];
  }
  const palette = colors.length > 0 ? [EMPTY, ...colors.slice(0, 6)] : [EMPTY, '#16161a', '#f2f1ec'];
  if (palette.length < 3) palette.push(palette[1] === '#f2f1ec' ? '#16161a' : '#f2f1ec');

  const bg = darkestIndex(palette);
  const head = contrastIndex(palette, bg);
  const accent = accentIndex(palette, [bg, head]);
  const gold = warmestIndex(palette, bg);

  const { head: headline, sub } = pickText(original, p);
  const symbol = pickSymbol(p) ?? club?.crest ?? null;
  const isPerson = hasKnownPlayer(p) || /\b(portrait|face|captain|legend|player|hero|footballer|photo|striker|keeper|icon)\b/.test(p);
  const occasion = detectOccasion(p);

  const layers: SpecLayer[] = [];
  let seq = 0;
  const nid = (): string => `L${seq++}`;
  // Deterministic seeded picker so each shuffle varies motif/orientation/symbol.
  const pick = <T>(arr: readonly T[], n: number): T => arr[((n % arr.length) + arr.length) % arr.length];

  // Hero on the north: a portrait for a person, else a bold symbol, else a headline.
  const addHero = (preferred: SymbolName | null): 'image' | 'symbol' | 'text' => {
    if (isPerson) {
      layers.push({ kind: 'image', id: nid(), region: regionObj('north'), prompt: portraitPrompt(original, p), scaleFrac: 0.95, dither: true, halftone: true });
      return 'image';
    }
    const s = symbol ?? preferred;
    if (s) {
      layers.push({ kind: 'symbol', id: nid(), region: regionObj('north'), symbol: s, colorIndex: head, scaleFrac: 0.85, align: 'center' });
      return 'symbol';
    }
    layers.push({ kind: 'text', id: nid(), region: regionObj('north'), text: headline ?? 'ULTRAS', colorIndex: head, fontId: 'black', arcDeg: 0, heightFrac: 0.7, align: 'center' });
    return 'text';
  };

  // Name (+ optional number) or a slogan on the south, big and bold.
  const addName = (text: string | null, color: number): void => {
    if (!text) return;
    if (sub) {
      layers.push({ kind: 'text', id: nid(), region: rowsObj('south', [0.4, 1]), text, colorIndex: color, fontId: 'black', arcDeg: 0, heightFrac: 0.55, align: 'center' });
      layers.push({ kind: 'text', id: nid(), region: rowsObj('south', [0, 0.36]), text: sub, colorIndex: accent, fontId: 'impact', arcDeg: 0, heightFrac: 0.34, align: 'center' });
    } else {
      layers.push({ kind: 'text', id: nid(), region: regionObj('south'), text, colorIndex: color, fontId: 'black', arcDeg: 0, heightFrac: 0.66, align: 'center' });
    }
  };

  let heroKind: 'image' | 'symbol' | 'text' = 'text';
  let summary: string;

  if (occasion === 'derby') {
    layers.push({ kind: 'fill', id: nid(), region: regionObj('all'), colorIndex: bg });
    layers.push({ kind: 'pattern', id: nid(), region: regionObj('sides'), pattern: pick<PatternName>(['chevron', 'checker', 'grid'], variant), colors: [bg, head], scale: 10 });
    heroKind = addHero('shield');
    layers.push({ kind: 'fill', id: nid(), region: regionObj('south'), colorIndex: head });
    addName(headline ?? 'PRIDE OF THE CITY', bg);
    summary = 'Derby: chevron-charged sides, a crest on the north, a defiant headline blazed across the south.';
  } else if (occasion === 'farewell') {
    layers.push({ kind: 'gradient', id: nid(), region: regionObj('sides'), colors: [bg, head], direction: 'vertical' });
    layers.push({ kind: 'gradient', id: nid(), region: regionObj('ends'), colors: [bg, accent], direction: 'vertical' });
    heroKind = addHero('crown');
    addName(headline ?? 'GRAZIE', gold);
    summary = 'Farewell: solemn gradients framing the bowl, the portrait/crest hero on the north, the name on the south.';
  } else if (occasion === 'anniversary') {
    const num = pickNumber(p) ?? '100';
    layers.push({ kind: 'pattern', id: nid(), region: regionObj('all'), pattern: 'checker', colors: [bg, head], scale: 26 });
    layers.push({ kind: 'text', id: nid(), region: regionObj('north'), text: num, colorIndex: gold, fontId: 'black', arcDeg: 0, heightFrac: 0.85, align: 'center' });
    addName(pickYears(p) ?? headline ?? 'YEARS', head);
    layers.push({ kind: 'symbol', id: nid(), region: regionObj('sides'), symbol: 'star', colorIndex: gold, scaleFrac: 0.5, align: 'center' });
    heroKind = 'text';
    summary = `Anniversary: a mosaic across the bowl, a giant ${num} on the north, the founding years on the south, stars down the sides.`;
  } else if (occasion === 'title') {
    layers.push({ kind: 'gradient', id: nid(), region: regionObj('all'), colors: [bg, gold], direction: 'radial' });
    layers.push({ kind: 'symbol', id: nid(), region: rowsObj('north', [0.45, 1]), symbol: symbol ?? 'crown', colorIndex: gold, scaleFrac: 0.6, align: 'top' });
    layers.push({ kind: 'text', id: nid(), region: rowsObj('north', [0, 0.5]), text: headline ?? 'CHAMPIONS', colorIndex: head, fontId: 'black', arcDeg: 0, heightFrac: 0.42, align: 'bottom' });
    layers.push({ kind: 'symbol', id: nid(), region: regionObj('sides'), symbol: 'star', colorIndex: gold, scaleFrac: 0.5, align: 'center' });
    addName(pickYears(p) ?? 'GLORY', head);
    heroKind = 'symbol';
    summary = 'Title: a gold radial glow, a crown and CHAMPIONS on the north, stars down the sides, the year on the south.';
  } else if (occasion === 'heritage') {
    layers.push({ kind: 'stripes', id: nid(), region: regionObj('sides'), colors: [bg, head], orientation: pick(['vertical', 'diagonal', 'horizontal'] as const, variant), bands: 8 });
    layers.push({ kind: 'fill', id: nid(), region: regionObj('north'), colorIndex: bg });
    heroKind = addHero('shield');
    layers.push({ kind: 'fill', id: nid(), region: regionObj('south'), colorIndex: bg });
    addName(headline ?? 'HISTORY', head);
    summary = 'Heritage: classic vertical stripes on the sides, the club crest on the north, the motto on the south.';
  } else if (occasion === 'welcome') {
    layers.push({ kind: 'gradient', id: nid(), region: regionObj('all'), colors: [bg, head], direction: 'vertical' });
    heroKind = addHero(symbol ?? 'wings');
    addName(headline ?? 'WELCOME', gold);
    layers.push({ kind: 'symbol', id: nid(), region: regionObj('sides'), symbol: pick<SymbolName>(['star', 'star6', 'diamond'], variant), colorIndex: accent, scaleFrac: 0.45, align: 'center' });
    summary = 'Welcome: a bright gradient bowl, a bold hero on the north, the welcome word across the south, stars down the sides.';
  } else if (occasion === 'mosaic') {
    layers.push({ kind: 'pattern', id: nid(), region: regionObj('all'), pattern: pick<PatternName>(['checker', 'grid', 'flag'], variant), colors: [bg, head], scale: 22 });
    layers.push({ kind: 'text', id: nid(), region: regionObj('all'), text: headline ?? 'ULTRAS', colorIndex: accent, fontId: 'black', arcDeg: 0, heightFrac: 0.5, align: 'center' });
    heroKind = 'text';
    summary = 'Mosaic: a full-bowl pattern with a giant mega-word stretched across the whole stadium.';
  } else {
    const sideDir = (['horizontal', 'vertical', 'diagonal'] as const)[variant % 3];
    layers.push({ kind: 'stripes', id: nid(), region: regionObj('sides'), colors: [bg, head], orientation: sideDir, bands: 6 });
    layers.push({ kind: 'fill', id: nid(), region: regionObj('north'), colorIndex: bg });
    heroKind = addHero(null);
    layers.push({ kind: 'fill', id: nid(), region: regionObj('south'), colorIndex: bg });
    addName(headline ?? (heroKind !== 'text' ? 'ULTRAS' : null), head);
    summary = `Full-bowl: a ${heroKind === 'image' ? 'portrait' : heroKind} on the north, the name on the south, club colours on the sides.`;
  }

  const titleWord = headline || (occasion !== 'generic' ? occasion : symbol || 'Full stadium');
  const spec: TifoSpec = {
    version: 1,
    title: cap(`${titleWord} tifo`),
    summary,
    palette,
    background: bg,
    layers,
  };
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
