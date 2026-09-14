/**
 * Optional LLM provider for the AI Tifo Designer.
 *
 * The product currently ships with the deterministic offline designer
 * (core/promptDesigner.ts), so this module is the *future hook*: if an API key
 * is present in the environment it asks a model to author a TifoSpec; otherwise
 * it returns null and the route falls back to the offline designer. The model is
 * asked for JSON ONLY, matching the TifoSpec schema — never pixels, never seat
 * assignments. Validation happens in the route via validateSpec(), so a model
 * that drifts from the schema simply gets rejected and the offline result wins.
 *
 * Provider-agnostic: AI_PROVIDER=anthropic|openai|gemini (auto-detected from
 * whichever key is set). No SDK dependency — we call the REST API with global fetch.
 */

import { SYMBOL_NAMES, SPEC_FONT_IDS, STANDS, SPEC_LIMITS, PATTERN_NAMES } from '../../src/core/tifoSpec';
import { fewShotBlock } from '../../src/core/exemplars';
import { TIFO_VOICES } from '../../src/core/tifoVoices';
import { matchClub } from '../../src/core/clubs';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'none';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

/**
 * Pick the Gemini text model for a quality tier (Phase 5 fast/premium routing).
 * Both tiers default to AI_MODEL, so behaviour is UNCHANGED until AI_MODEL_FAST
 * / AI_MODEL_PREMIUM are set — e.g. set AI_MODEL_PREMIUM=gemini-2.5-pro to give
 * Super AI + the critic a stronger model while simple prompts stay on Flash.
 */
function geminiModel(tier: 'fast' | 'premium'): string {
  const base = process.env.AI_MODEL ?? 'gemini-2.5-flash';
  return tier === 'premium' ? process.env.AI_MODEL_PREMIUM ?? base : process.env.AI_MODEL_FAST ?? base;
}

export function activeProvider(): AiProvider {
  const forced = (process.env.AI_PROVIDER ?? '').toLowerCase();
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (forced === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (forced === 'gemini' && geminiKey()) return 'gemini';
  if (!forced && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (!forced && process.env.OPENAI_API_KEY) return 'openai';
  if (!forced && geminiKey()) return 'gemini';
  return 'none';
}


// ---- shared prompt material ------------------------------------------------
// One source for the three prompts so they cannot drift, and so the additions
// are paid for by deleting the prose they replace.

/**
 * The house style, measured by rendering designs on real seats and looking at
 * them. Index 0..7 are whole-bowl rules; std mode gets no stadium context and
 * often designs a single stand, so it receives only the first group.
 */
const HOUSE_RULES_CORE: string[] = [
  '- Judge colour by VALUE, not hue. Any two colours that must read apart need',
  '  3:1 contrast; two mid-tones of different hues merge into mud at 200m.',
  '- Three dominant colours. Everything else is an accent or a tint of those.',
  '- Palette index 0 is UNPAINTED seats (stadium grey) and it is free. Fill a',
  '  stand with 0, then re-fill rows [0.07,0.93] with the field colour, and the',
  '  art is framed in bare concrete. It is a FRAME, never a whole empty stand.',
  '- A stand is a POSTER about 6.6:1 wide: margin, field, ONE hero, ONE',
  '  supporting line. Put a stand\'s field fill immediately before the art on it.',
  '- Jump scale 4:1 between hero and support — hero in rows [0.06,0.60], support',
  '  in rows [0.70,0.92]. Two lines of similar size read as a paragraph.',
  '- Posterise: flat blocks, hard edges. Never ramp between two close tones.',
  '- The PHRASE decides the design. Text is aspect-locked and shrinks to fit its',
  '  stand, so heightFrac is a ceiling, not a promise: fewer words = bigger',
  '  letters. "GRAZIE CAPITANO" fills a stand; "10" cannot without stretch.',
  '  Prefer the terrace nickname over the club\'s legal name.',
];
const HOUSE_RULES_BOWL: string[] = [
  '- A black band of stairs crosses every stand between tiers. Let it fall',
  '  BETWEEN hero and support (that is what the row bands are for), never',
  '  through a word.',
  '- The TV camera sees the far END head-on and the SIDES foreshortened to about',
  '  a third: put WORDS on north/south and PATTERN or STRIPES on east/west.',
  '  "east" also straddles the bowl seam, so never put text there. A stand the',
  '  user NAMES still wins over this.',
  '- ONE idea for the whole bowl, not one idea per stand.',
];
const houseRules = (bowl: boolean): string =>
  ['HOUSE STYLE (measured on real seats — follow it):', ...HOUSE_RULES_CORE, ...(bowl ? HOUSE_RULES_BOWL : [])].join('\n');

/**
 * The four optional controls the renderer gained with the display faces. The
 * worked two-line example is the highest-value text here: the likeliest failure
 * is emitting one fat layer, or the pair in the wrong order — reversed, the fat
 * copy paints over the plain one AND stops being recognised as a backing layer,
 * so the refiner recolours it. Silent and ugly.
 */
const LETTERING = [
  'LETTERING (all optional, all on top of the fields above):',
  '- "outline" (0-24) fattens the glyphs. AN OUTLINED HEADLINE IS TWO LAYERS:',
  '  the same text, region, fontId, heightFrac, arcDeg, stretch and align twice —',
  '  FIRST the fattened copy in the edge colour, THEN the plain copy in the fill',
  '  colour immediately after (layers paint bottom→top). Scale the stroke with',
  '  the word: outline = round(letters * 0.6) clamped to 2..7; a fixed stroke',
  '  welds a short word shut. Add "dx":1,"dy":6 to the FIRST copy and the',
  '  outline becomes a drop shadow. ONLY outline when fill and field are CLOSE',
  '  in value, and the edge must separate from BOTH — it is drawn fatter than',
  '  the fill, so an edge that blends into the field swallows the letterform.',
  '  Black on gold is 13:1 already: no outline, just go bigger. Example:',
  '  {"kind":"text","region":"south","text":"GRAZIE","colorIndex":4,"fontId":"condensed","arcDeg":0,"heightFrac":0.8,"align":"center","outline":4},',
  '  {"kind":"text","region":"south","text":"GRAZIE","colorIndex":1,"fontId":"condensed","arcDeg":0,"heightFrac":0.8,"align":"center"}',
  '- "stretch" (1-6) widens a run toward the stand edges. One or two words at',
  '  natural aspect sit as an island in a 6.6:1 band: use 1.5-2 for two words,',
  '  3 for a squad number. "dx"/"dy" (-20..20) shift by % of the region.',
  '- symbol "scaleFrac" measures the region\'s HEIGHT, so a crest at 0.9 covers',
  '  only ~15% of a stand\'s width. "wide" spends the rest — but it STRETCHES the',
  '  mask, so keep it near 1.5 for anything with a recognisable outline (shield,',
  '  crest, crescent, fist, crown, star): past about 2 they distort into blobs.',
  '  Only naturally wide marks (eagle, wings, chevron, bolt) take 2.5-3.5.',
].join('\n');

const LEGACY_FONT_IDS = (SPEC_FONT_IDS as readonly string[]).filter((id) => !TIFO_VOICES.some((v) => v.id === id));

/**
 * The font line, derived from the shipped voice table so a new voice reaches all
 * three prompts for free. `full` spends ~120 tokens on each voice's character;
 * the compact form just steers away from the legacy stacks.
 */
function voiceLine(full: boolean): string {
  const head = `FontId — prefer these six display voices (each ONE family covering Arabic AND Latin): ${TIFO_VOICES.map((v) => v.id).join(', ')}.`;
  const legacy = `Legacy device fonts (${LEGACY_FONT_IDS.join(', ')}) still work but render differently on every device — avoid them.`;
  if (!full) return `${head} ${legacy}`;
  return [head, ...TIFO_VOICES.map((v) => `  ${v.id} — ${v.note}`), legacy].join('\n');
}

/**
 * Authentic club colours for a brief, as one line for the USER turn.
 *
 * Deliberately a separate exported function that the CALLER opts into, not a
 * lookup inside userMessage: critiqueSpecViaProvider passes a serialised spec as
 * its `prompt`, and that blob is full of club names and hexes. Sniffing `prompt`
 * would hand the critic a club hint for a design it is only meant to repair.
 */
export function clubHintLine(prompt: string): string {
  const club = matchClub((prompt ?? '').toLowerCase());
  if (!club) return '';
  return `CLUB COLOURS (authentic, matched on "${club.aliases[0]}"): ${club.palette.join(', ')}; crest symbol: ${club.crest}. `
    + 'Use these exact hexes unless the brief names different colours. Ignore this line if the club is wrong.';
}

/** The choreography-designer system prompt — also the human-readable spec contract. */
export function buildSystemPrompt(): string {
  return [
    'You are the lead choreography designer for TifoMaker, planning stadium-scale',
    'tifo displays (the giant coordinated card mosaics ultras hold up).',
    '',
    'You output a DESIGN SPECIFICATION as JSON, never pixels. The renderer paints',
    'it onto tens of thousands of seats, so think card stunt: bold shapes that',
    'survive a ~10% no-show rate, never fine photographic detail.',
    '',
    'LANGUAGE: briefs may be English, Arabic or both — understand both fully. Text',
    'layers may be either (the renderer shapes Arabic/RTL); pick what fits the club',
    'and region, transliterate names sensibly, and prefer Arabic text for an',
    'Arabic brief unless asked otherwise.',
    '',
    'Choose ONE focal point, use the stand(s) the brief names, express the club\'s',
    'real colours, and vary the composition — never one default template. Reflect',
    'the emotion in the brief. For a stadium-wide brief plan a MULTI-STAND scene:',
    'a hero on one end, a headline on the opposite end, a patterned field on the',
    'sides, so the bowl tells ONE story.',
    '',
    'Output STRICT JSON ONLY (no prose, no code fences) matching this shape:',
    '{',
    '  "title": string,',
    '  "summary": string,                       // one line describing the design',
    `  "palette": ["#rrggbb", ...],             // index 0 = empty seat (#262a33). ${SPEC_LIMITS.minPalette}-${SPEC_LIMITS.maxPalette} entries`,
    '  "background": number|null,               // palette index flooded over the whole bowl (optional)',
    '  "layers": [                              // painted bottom→top',
    '    { "kind":"fill",    "region":Region, "colorIndex":number },',
    '    { "kind":"stripes", "region":Region, "colors":[number,...], "orientation":"vertical|horizontal|diagonal", "bands":number },',
    '    { "kind":"gradient","region":Region, "colors":[number,number], "direction":"vertical|horizontal|radial" },',
    '    { "kind":"pattern", "region":Region, "pattern":"checker|chevron|grid|flag|hoops", "colors":[number,...], "scale":number },',
    '    { "kind":"text",    "region":Region, "text":string, "colorIndex":number, "fontId":FontId, "arcDeg":number, "heightFrac":number, "align":"center|top|bottom", "outline":number?, "stretch":number?, "dx":number?, "dy":number? },',
    '    { "kind":"symbol",  "region":Region, "symbol":SymbolName, "colorIndex":number, "scaleFrac":number, "align":"center|top|bottom", "wide":number? },',
    '    { "kind":"image",   "region":Region, "prompt":string, "scaleFrac":number, "dither":boolean }',
    '  ]',
    '}',
    '',
    'Region is "all"|"lower"|"upper"|"north"|"south"|"east"|"west", or',
    '{ "stand", "tier":number|"all", "rows":[from,to] } where rows are fractions of',
    `stand height (0 = front, 1 = back). Stands: ${STANDS.join(', ')}.`,
    voiceLine(false),
    `SymbolName (drawable vector symbols): ${SYMBOL_NAMES.join(', ')}.`,
    'For a PORTRAIT, player, face or detailed artwork use an "image" layer as the',
    'HERO: scaleFrac 0.9-1.0 on its OWN stand, name/number on the OPPOSITE stand,',
    'subject described in "prompt".',
    'Portraits NEED a tonal palette of 5-6 colours so the face shades cleanly: even',
    'if the brief names one or two, ADD the in-between tones (black → dark grey →',
    'mid grey → light grey → white) PLUS one skin tone, ordered dark → light — two',
    'flat colours read as a shapeless blob. Do not flood the bowl with one flat',
    'fill behind a portrait. Vector symbols for simple emblems, image layers for',
    'any real person or photographic subject.',
    '',
    houseRules(false),
    '',
    LETTERING,
  ].join('\n');
}

/**
 * Super AI "director" system prompt (Mode 3). Same JSON contract as Mode 2, but
 * the director designs the WHOLE bowl: it reads the STADIUM CONTEXT in the user
 * message, gives each stand a deliberate role, and composes a coherent
 * multi-stand scene (using sides/ends/stands regions for cross-stand fields). A
 * curated few-shot gallery is appended so the model learns the house style.
 */
export function buildDirectorPrompt(): string {
  return [
    'You are the LEAD CHOREOGRAPHY DIRECTOR for TifoMaker, designing an ENTIRE',
    'stadium experience: not a single image dropped in one stand.',
    '',
    'You output a design-specification JSON, never pixels: shapes bold enough to',
    'survive a ~10% no-show rate, never fine photographic detail.',
    '',
    'DESIGN THE WHOLE BOWL:',
    '- Read the STADIUM CONTEXT in the user message (per-stand seats, tiers, rows,',
    '  columns, aspect) and plan FOR that geometry.',
    '- Give EACH stand a deliberate role — hero, headline, colour field, pattern —',
    '  with ONE dominant element each. Never crowd a stand.',
    '- Compose ACROSS stands: "sides" (east+west), "ends" (north+south) or',
    '  { "stands": [...] } for fields that wrap the bowl; single stands for focal',
    '  pieces.',
    '- The brief’s emotion picks the composition (derby, farewell, anniversary,',
    '  trophy, heritage, defiance) — never a default template.',
    '',
    'LANGUAGE: briefs may be English, Arabic or both. Text layers may be either',
    '(the renderer shapes Arabic/RTL); pick what fits the club and region.',
    '',
    'If the user message carries a COPY block, a copywriter has already chosen the',
    'words. Use them EXACTLY as the hero and supporting text — do not translate,',
    'shorten, expand or paraphrase them. Your job is then purely to stage them.',
    '',
    'PORTRAITS: a player/legend/face is an "image" layer HERO on its OWN stand',
    '(scaleFrac 0.9-1.0), name on the OPPOSITE stand, with a 5-6 tone palette',
    '(dark→light + a skin tone) and "halftone": true — clustered tones read far',
    'better at seat scale than fine dithering.',
    '',
    `JSON: { "title", "summary", "palette":["#rrggbb",...] (index 0 = empty seat #262a33, ${SPEC_LIMITS.minPalette}-${SPEC_LIMITS.maxPalette}),`,
    '"background": number|null, "layers":[ ... ] }. Layer kinds: fill, stripes,',
    'gradient, pattern, text, symbol, image, each with a "region".',
    'Region: "all"|"lower"|"upper"|"north"|"south"|"east"|"west"|"sides"|"ends", or',
    '{ "stand", "tier", "rows":[from,to], "stands":[...] }.',
    `Symbols: ${SYMBOL_NAMES.join(', ')}. Patterns: ${PATTERN_NAMES.join(', ')}.`,
    `Stands: ${STANDS.join(', ')}. Output STRICT JSON ONLY (no prose, no code fences).`,
    voiceLine(true),
    '',
    houseRules(true),
    '',
    LETTERING,
    '',
    fewShotBlock(),
  ].join('\n');
}

/**
 * Super AI vision critic (Phase 4b). Shown the design spec AND a low-res render
 * of it on the seats; returns a corrected TifoSpec (same contract) that fixes
 * legibility/contrast/balance while preserving the intent, palette and roles.
 */
export function buildCriticPrompt(): string {
  return [
    'You are a STADIUM-TIFO LEGIBILITY & COMPOSITION CRITIC.',
    'You are given (1) a design SPECIFICATION as JSON and, when available, (2) a',
    'low-resolution image of that design rendered on the stadium seats. Judge it as',
    'a spectator across the pitch and the main TV camera would.',
    '',
    'Find the real problems: text too small or thin to read, weak contrast against',
    'the field behind it, a crowded stand, an empty or sparse stand, an unclear',
    'focal point, or a portrait that does not read as its subject.',
    '',
    'Then RETURN A CORRECTED TifoSpec JSON (identical contract) that fixes those',
    'problems while preserving the design’s intent, palette and per-stand roles.',
    'Prefer bigger, bolder, higher-contrast. If it is already strong, return it',
    'essentially unchanged. Keep portraits as image layers on their own stand.',
    '',
    'JUDGE BY: 3:1 minimum contrast between anything and the field behind it;',
    'three dominant colours, the rest accents; a 4:1 scale jump between hero and',
    'supporting line; flat posterised blocks, never a ramp between close tones;',
    'depth from an offset copy, never from a soft edge. Words belong on the ends',
    '(north/south), pattern on the sides — "east" straddles the bowl seam.',
    '',
    'PRESERVE: two text layers with the same words in the same region are an',
    'outline/shadow PAIR — keep BOTH and keep their order (the fattened copy',
    'first). Never drop "outline", "stretch", "dx", "dy" or "wide" from a layer',
    'you rewrite. If a headline is losing to its field, ADD a pair rather than',
    'recolouring it.',
    '',
    `JSON: { "title", "summary", "palette":["#rrggbb",...] (index 0 = empty seat #262a33, ${SPEC_LIMITS.minPalette}-${SPEC_LIMITS.maxPalette}),`,
    '"background": number|null, "layers":[ fill|stripes|gradient|pattern|text|symbol|image ] },',
    'each layer with a "region": "all"|"lower"|"upper"|"north"|"south"|"east"|"west"|',
    '"sides"|"ends" or { "stand","tier","rows":[from,to],"stands":[...] }.',
    'Text layers also take "outline", "stretch", "dx", "dy"; symbols take "wide".',
    `Symbols: ${SYMBOL_NAMES.join(', ')}. Patterns: ${PATTERN_NAMES.join(', ')}.`,
    voiceLine(false),
    'Output STRICT JSON ONLY (no prose, no code fences).',
  ].join('\n');
}

/**
 * Ask the model to critique a rendered design and return an improved spec.
 * `image` is a data: URL of the bowl render; `stadium` is the geometry context.
 */
export async function critiqueSpecViaProvider(spec: unknown, image?: string, stadium?: string): Promise<ProviderResult> {
  // Note the missing `hint`: the critic must never be handed club colours. Its
  // "prompt" is a serialised spec, not a brief.
  return generateSpecViaProvider(criticUserMessage(spec, stadium), { system: buildCriticPrompt(), image, tier: 'premium' });
}

/** The critic's user turn. Exported so the no-club-hint invariant is testable. */
export function criticUserMessage(spec: unknown, stadium?: string): string {
  return [
    stadium ? `STADIUM CONTEXT:\n${stadium}` : '',
    'CURRENT DESIGN SPEC (improve it; keep the intent and palette):',
    JSON.stringify(spec),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The generator's user turn. `hint` is per-brief data and belongs here, not in
 *  the system prompt, which stays identical across every user. */
export function userMessage(prompt: string, context?: string, hint?: string): string {
  const ctx = context ? `STADIUM CONTEXT:\n${context}\n\n` : '';
  const h = hint ? `${hint}\n\n` : '';
  return `${ctx}Brief: ${prompt}\n\n${h}Return the TifoSpec JSON now.`;
}


/**
 * A JSON Schema for the TifoSpec, for Gemini's structured-output mode.
 *
 * OFF by default. Gemini now accepts `anyOf` and `$ref`, so the string-or-object
 * `region` union is finally expressible — but constrained decoding changes what
 * the model writes, not just whether it parses, and that cannot be judged from
 * here without an API key. Set AI_RESPONSE_SCHEMA=1 to A/B it against real
 * briefs; the tolerant `extractJson` path stays the default.
 *
 * Deliberately permissive: every layer field except `kind` and `region` is
 * optional, because a schema that rejects a good design is far worse than one
 * that lets a malformed one through to the validator.
 */
function tifoResponseSchema(): unknown {
  const region = {
    anyOf: [
      { type: 'string', enum: ['all', 'lower', 'upper', 'sides', 'ends', ...STANDS] },
      {
        type: 'object',
        properties: {
          stand: { type: 'string', enum: ['all', ...STANDS] },
          tier: { anyOf: [{ type: 'number' }, { type: 'string', enum: ['all'] }] },
          rows: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          stands: { type: 'array', items: { type: 'string', enum: STANDS } },
        },
      },
    ],
  };
  const num = { type: 'number' };
  return {
    type: 'object',
    required: ['title', 'palette', 'layers'],
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      palette: { type: 'array', items: { type: 'string' }, minItems: SPEC_LIMITS.minPalette, maxItems: SPEC_LIMITS.maxPalette },
      background: num,
      layers: {
        type: 'array',
        maxItems: SPEC_LIMITS.maxLayers,
        items: {
          type: 'object',
          required: ['kind', 'region'],
          properties: {
            kind: { type: 'string', enum: ['fill', 'stripes', 'gradient', 'pattern', 'text', 'symbol', 'image'] },
            region,
            colorIndex: num,
            colors: { type: 'array', items: num },
            orientation: { type: 'string', enum: ['vertical', 'horizontal', 'diagonal'] },
            direction: { type: 'string', enum: ['vertical', 'horizontal', 'radial'] },
            pattern: { type: 'string', enum: PATTERN_NAMES as unknown as string[] },
            bands: num,
            scale: num,
            text: { type: 'string' },
            fontId: { type: 'string', enum: SPEC_FONT_IDS as unknown as string[] },
            arcDeg: num,
            heightFrac: num,
            align: { type: 'string', enum: ['center', 'top', 'bottom'] },
            outline: num,
            stretch: num,
            dx: num,
            dy: num,
            symbol: { type: 'string', enum: SYMBOL_NAMES as unknown as string[] },
            scaleFrac: num,
            wide: num,
            prompt: { type: 'string' },
            dither: { type: 'boolean' },
            halftone: { type: 'boolean' },
          },
        },
      },
    },
  };
}


/**
 * Stage 1 of a two-call generation: the COPYWRITER.
 *
 * Every strong tifo in our rendering tests turned on the phrase, not the
 * layout. "GRAZIE CAPITANO" fills a stand; "10" is two glyphs and aspect-locked,
 * so no amount of art direction saves it. Asking one model to invent the words
 * AND lay them out means the words are chosen while it is already thinking about
 * regions — so they come out as the club's legal name, or the literal brief.
 *
 * This call does nothing but choose words. It is tiny (a few hundred tokens in,
 * a few dozen out) and runs on the fast tier, so the whole stage costs a
 * fraction of a cent.
 */
export function buildCopywriterPrompt(): string {
  return [
    'You are the COPYWRITER for a stadium tifo. You do not design anything: you',
    'choose the WORDS the crowd will hold up, and nothing else.',
    '',
    'A stand is roughly 6.6:1. Letters are sized to fit it, so fewer words means',
    'bigger letters. One to three words is the target; five is the ceiling.',
    '',
    'Prefer what a terrace would actually chant: the club\'s nickname over its',
    'legal name (الزعيم over الهلال, "I Zingari" over the registered name), a',
    'claim or a vow over a statement of fact, the emotion over the fixture.',
    'Never output the brief back verbatim, and never a full sentence.',
    '',
    'Match the brief\'s language. An Arabic brief gets Arabic words; an English',
    'brief gets English. If the brief mixes both, pick the one the club\'s own',
    'supporters would use.',
    '',
    'Also return a SUPPORTING line — a date, a score, a year range, a squad',
    'number with a word ("NUMERO 10", not "10"), or a second short phrase. It is',
    'set small under the hero, so it may be longer. Use "" if nothing fits.',
    '',
    'Output STRICT JSON ONLY, no prose, no code fences:',
    '{ "phrase": string, "support": string, "language": "ar"|"en",',
    '  "mood": string (one word), "voice": string }',
    `where voice is one of: ${TIFO_VOICES.map((v) => v.id).join(', ')} —`,
    ...TIFO_VOICES.map((v) => `  ${v.id}: ${v.note}`),
  ].join('\n');
}

export interface TifoCopy {
  phrase: string;
  support: string;
  language: 'ar' | 'en';
  mood: string;
  voice: string;
}

const VOICE_IDS = new Set(TIFO_VOICES.map((v) => v.id));

/**
 * Run the copywriter. Best-effort by contract: any failure returns null and the
 * director simply designs from the raw brief, exactly as it did before. A words
 * stage that can break generation would not be worth having.
 */
export async function writeCopy(prompt: string, hint?: string): Promise<TifoCopy | null> {
  const r = await generateSpecViaProvider(prompt, { system: buildCopywriterPrompt(), tier: 'fast', hint });
  const o = r.spec as Partial<TifoCopy> | null;
  if (!o || typeof o.phrase !== 'string' || !o.phrase.trim()) return null;
  const phrase = o.phrase.trim().slice(0, 60);
  return {
    phrase,
    support: typeof o.support === 'string' ? o.support.trim().slice(0, 60) : '',
    language: o.language === 'ar' ? 'ar' : 'en',
    mood: typeof o.mood === 'string' ? o.mood.trim().slice(0, 24) : '',
    voice: typeof o.voice === 'string' && VOICE_IDS.has(o.voice) ? o.voice : 'poster',
  };
}

/** The copywriter's choices, as one block for the director's user turn. */
export function copyLine(copy: TifoCopy | null): string {
  if (!copy) return '';
  return [
    `COPY (already chosen — use these exact words as the hero text; do not invent your own):`,
    `  hero: "${copy.phrase}"`,
    ...(copy.support ? [`  supporting line: "${copy.support}"`] : []),
    `  mood: ${copy.mood || 'n/a'} · suggested fontId: ${copy.voice}`,
  ].join('\n');
}

/** Gemini user parts: the text plus an optional inline image (a data: URL). */
function geminiParts(text: string, image?: string): unknown[] {
  const parts: unknown[] = [{ text }];
  const m = image?.match(/^data:([^;]+);base64,(.+)$/);
  if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  return parts;
}

/** Pull the first JSON object out of a model response (tolerant of fences/prose). */
function extractJson(text: string): unknown | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface ProviderResult {
  /** Parsed (UNvalidated) JSON spec, or null on failure. */
  spec: unknown | null;
  /** Human-readable failure reason (surfaced to the UI when it falls back offline). */
  error?: string;
}

async function httpError(label: string, res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 180).replace(/\s+/g, ' ').trim();
  } catch {
    /* ignore */
  }
  return `${label}: HTTP ${res.status}${body ? `: ${body}` : ''}`;
}

/**
 * Ask the configured model for a TifoSpec. Returns the parsed (UNvalidated) JSON
 * plus, on failure, a human-readable reason. The caller validates and falls back
 * to the offline designer, surfacing the reason in the UI.
 */
export async function generateSpecViaProvider(
  prompt: string,
  opts: { system?: string; context?: string; image?: string; tier?: 'fast' | 'premium'; hint?: string } = {},
): Promise<ProviderResult> {
  const provider = activeProvider();
  if (provider === 'none') return { spec: null, error: 'no AI provider configured' };
  // Premium runs a bigger model on a longer prompt, and Super now makes two
  // calls. 20s was tuned for a single fast call and truncates the rest.
  const timeoutMs = opts.tier === 'premium'
    ? Number(process.env.AI_TIMEOUT_PREMIUM_MS ?? 45000)
    : Number(process.env.AI_TIMEOUT_MS ?? 20000);
  const system = opts.system ?? buildSystemPrompt();
  // Built ONCE. Three separate userMessage() calls meant a new argument had to
  // be threaded through three bodies, and forgetting one would silently drop it
  // for that provider alone.
  const user = userMessage(prompt, opts.context, opts.hint);

  try {
    if (provider === 'anthropic') {
      const res = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
        // 4096 to match Gemini: outline pairs double the text-layer count and
        // Anthropic is not in JSON mode, so it pretty-prints. A truncated reply
        // fails extractJson and surfaces to the user as "premium is busy".
        { model: process.env.AI_MODEL ?? 'claude-3-5-sonnet-latest', max_tokens: 4096, system, messages: [{ role: 'user', content: user }] },
        timeoutMs,
      );
      if (!res.ok) return { spec: null, error: await httpError('claude', res) };
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      const spec = extractJson(data.content?.[0]?.text ?? '');
      return spec ? { spec } : { spec: null, error: 'claude: response was not valid JSON' };
    }
    if (provider === 'gemini') {
      const model = geminiModel(opts.tier ?? 'fast');
      const res = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey()!}`,
        { 'content-type': 'application/json' },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: geminiParts(user, opts.image) }],
          generationConfig: {
            responseMimeType: 'application/json',
            ...(process.env.AI_RESPONSE_SCHEMA === '1' ? { responseJsonSchema: tifoResponseSchema() } : {}),
            temperature: 0.9,
            maxOutputTokens: 4096,
          },
        },
        timeoutMs,
      );
      if (!res.ok) return { spec: null, error: await httpError(`gemini "${model}"`, res) };
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const spec = extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
      return spec ? { spec } : { spec: null, error: `gemini "${model}": response was not valid JSON` };
    }
    // openai
    const res = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
      { model: process.env.AI_MODEL ?? 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      timeoutMs,
    );
    if (!res.ok) return { spec: null, error: await httpError('openai', res) };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const spec = extractJson(data.choices?.[0]?.message?.content ?? '');
    return spec ? { spec } : { spec: null, error: 'openai: response was not valid JSON' };
  } catch (e) {
    return { spec: null, error: `${provider}: ${(e as Error)?.name === 'AbortError' ? 'timed out' : 'network error'}` };
  }
}
