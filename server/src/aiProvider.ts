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
 * whichever key is set, Claude first). No SDK dependency — we call the REST API
 * with global fetch.
 *
 * Claude FIRST, Gemini BEHIND IT (October 2026). With both keys set, every call
 * goes to Claude (Haiku 5.5 on the fast tier, Sonnet 5.5 on premium), and when
 * Claude cannot answer (busy, down, out of the month's API credit, a refused
 * key) the same request runs on Gemini exactly as it did before, with Gemini's
 * own fallback model behind that. A Claude account problem pauses Claude for a
 * while (providerCooldown) so every request does not pay a doomed round trip
 * first. A brief Claude's safety system declines (stop_reason "refusal") is
 * not sent on to Gemini: that is a decision about the content, not an outage.
 */

import { SYMBOL_NAMES, SPEC_FONT_IDS, STANDS, SPEC_LIMITS, PATTERN_NAMES } from '../../src/core/tifoSpec';
import { fewShotBlock } from '../../src/core/exemplars';
import { TIFO_VOICES } from '../../src/core/tifoVoices';
import { matchClub } from '../../src/core/clubs';
import { envNum } from './env';
import { addUsage, textCostMicros, zeroUsage, type TokenUsage } from './aiPricing';
import { RETIRED_TEXT_MODELS } from './preflight';

export { envNum };

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'none';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

/**
 * The model to ask for, given an id that Google may have retired.
 * `gemini-3.5-flash` was deprecated in 2026 and every call to it is silently
 * served by 3.6 Flash, so asking for it by name only hides which model (and
 * which price) answered. Naming the real model keeps the failure log, the cost
 * table and Google's own usage page in agreement. The list lives in
 * preflight.ts, which also warns at boot when a variable still names one.
 */
export function currentModelId(id: string): string {
  const m = id.trim();
  return RETIRED_TEXT_MODELS[m] ?? m;
}

/**
 * Pick the Gemini text model for a quality tier (Phase 5 fast/premium routing).
 * Both tiers default to AI_MODEL, so behaviour is UNCHANGED until AI_MODEL_FAST
 * / AI_MODEL_PREMIUM are set — e.g. set AI_MODEL_PREMIUM=gemini-2.5-pro to give
 * Super AI + the critic a stronger model while simple prompts stay on Flash.
 */
export function geminiModel(tier: 'fast' | 'premium'): string {
  // AI_MODEL may name a Claude model (it used to be how Claude was chosen);
  // that is never a Gemini model, and asking Google for it fails every call.
  const legacy = process.env.AI_MODEL?.trim();
  const base = legacy && !/^claude-/i.test(legacy) ? legacy : 'gemini-2.5-flash';
  return currentModelId(tier === 'premium' ? process.env.AI_MODEL_PREMIUM ?? base : process.env.AI_MODEL_FAST ?? base);
}

/**
 * The model a tier falls back to when its own model cannot answer.
 *
 * In the 30 days to 17 October 2026, 112 premium requests ended "busy", and
 * 45 of the last 50 were the premium model refusing: Google's "high demand"
 * 503s and quota 429s. Nothing tried anything else. Each Gemini model has its
 * own capacity and its own quota, so a second model usually answers when the
 * first will not, and a design from a lighter model beats "come back later".
 *
 * gemini-3.5-flash-lite by default: current, cheap ($0.30 / $2.50), structured
 * output, and on Google's free tier it allows 500 requests a day where the
 * Flash models allow 20. AI_MODEL_FALLBACK sets both tiers,
 * AI_MODEL_FALLBACK_PREMIUM / AI_MODEL_FALLBACK_FAST one each; "none" turns it
 * off (and brings back the old same-model retry).
 */
export const DEFAULT_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

export function geminiFallback(tier: 'fast' | 'premium'): string | null {
  const own = tier === 'premium' ? process.env.AI_MODEL_FALLBACK_PREMIUM : process.env.AI_MODEL_FALLBACK_FAST;
  // An EMPTY variable inherits (a blank line in .env or Railway is not "off");
  // only the words below turn the fallback off.
  const v = own?.trim() || process.env.AI_MODEL_FALLBACK?.trim() || DEFAULT_FALLBACK_MODEL;
  if (/^(none|off|false|0)$/i.test(v)) return null;
  return currentModelId(v);
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

/**
 * The provider that answers when the main one cannot: Gemini, behind Claude
 * (or OpenAI). Gemini as the main provider has its own fallback MODEL
 * (geminiFallback) and nothing behind that. AI_PROVIDER_FALLBACK=none turns
 * the backup off; it needs GEMINI_API_KEY (or GOOGLE_API_KEY).
 */
export function backupProvider(): AiProvider | null {
  const main = activeProvider();
  if (main === 'none' || main === 'gemini') return null;
  if (/^(none|off|false|0)$/i.test((process.env.AI_PROVIDER_FALLBACK ?? '').trim())) return null;
  return geminiKey() ? 'gemini' : null;
}

/**
 * Claude models per tier. Haiku 5.5 for the fast tier (standard designs, the
 * copywriter): the cheapest current model, $0.10 / $0.50 per million tokens.
 * Sonnet 5.5 for premium (Super's director, Polish, photo reading): fast, and
 * a size class above the Flash models it replaces. AI_CLAUDE_MODEL_FAST /
 * AI_CLAUDE_MODEL_PREMIUM change them (claude-opus-5-5 for the most capable).
 *
 * AI_MODEL used to name the Claude model for both tiers. It is honoured only
 * when it IS a Claude id: on Railway it may well name a Gemini model, and
 * asking Claude for that fails every call.
 */
export const CLAUDE_DEFAULT_MODELS = { fast: 'claude-haiku-5-5', premium: 'claude-sonnet-5-5' } as const;

export function claudeModel(tier: 'fast' | 'premium'): string {
  const own = (tier === 'premium' ? process.env.AI_CLAUDE_MODEL_PREMIUM : process.env.AI_CLAUDE_MODEL_FAST)?.trim();
  if (own) return own;
  const legacy = process.env.AI_MODEL?.trim();
  if (legacy && /^claude-/i.test(legacy)) return legacy;
  return CLAUDE_DEFAULT_MODELS[tier];
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * How much work Claude puts into a reply, thinking included (output_config.effort).
 *
 * Premium defaults to LOW. Sonnet 5.5 thinks at "high" when nothing is said,
 * and the director has a 45-second limit with pictures still to fetch after
 * it, inside Cloudflare's 100-second ceiling. Low keeps the wait close to what
 * Gemini Flash took; AI_CLAUDE_EFFORT_PREMIUM=medium buys more thought if the
 * "Average wait" in /admin → AI says there is room for it.
 * The fast tier keeps Haiku's own default, medium, with up-front thinking off
 * (claudeThinking): it writes a short JSON answer and nothing more.
 */
export function claudeEffort(tier: 'fast' | 'premium'): ClaudeEffort {
  const v = (tier === 'premium' ? process.env.AI_CLAUDE_EFFORT_PREMIUM : process.env.AI_CLAUDE_EFFORT_FAST)?.trim().toLowerCase();
  if (v && (EFFORTS as string[]).includes(v)) return v as ClaudeEffort;
  return tier === 'premium' ? 'low' : 'medium';
}

/**
 * Thinking off for the fast tier, where the model allows it: Haiku takes
 * {type:"disabled"}, Sonnet 5.5 {type:"between_tools"} (no up-front thinking).
 * Older Sonnets refuse "between_tools", Opus cannot turn thinking off, and
 * neither setting works at xhigh or max, so then nothing is sent and the
 * model's own default applies. Premium always thinks.
 */
export function claudeThinking(model: string, tier: 'fast' | 'premium', effort: ClaudeEffort): Record<string, unknown> | undefined {
  if (tier !== 'fast' || effort === 'xhigh' || effort === 'max') return undefined;
  if (/haiku/i.test(model)) return { type: 'disabled' };
  if (/sonnet-5-5/i.test(model)) return { type: 'between_tools' };
  return undefined;
}

/**
 * Claude's output ceiling. Thinking counts against max_tokens, and it is a cap
 * rather than a charge (only what is written is billed), so it is set well
 * above a design's ~2,000 tokens of JSON.
 */
export function claudeMaxTokens(): number {
  return envNum('AI_CLAUDE_MAX_TOKENS', 16000, 1024, 64000);
}

/** The model a provider asks for on a tier, for logs and the failure record. */
export function providerModel(provider: AiProvider, tier: 'fast' | 'premium'): string {
  if (provider === 'gemini') return geminiModel(tier);
  if (provider === 'anthropic') return claudeModel(tier);
  if (provider === 'openai') return process.env.AI_MODEL ?? 'gpt-4o-mini';
  return 'none';
}

// ---- a paused main provider --------------------------------------------------

/**
 * A main provider that refused for an ACCOUNT reason is paused, and requests
 * go straight to the backup until the pause ends: its key was refused, or the
 * API credit is spent (Claude: HTTP 400 "Your credit balance is too low", or
 * a spend limit the owner set). Neither fixes itself between two requests, so
 * asking first only adds a round trip to every design. After the pause the
 * provider is asked again, so a new month's credit heals on its own.
 * AI_PROVIDER_COOLDOWN_MS sets the pause (15 minutes; 0 turns it off).
 */
let cooldown: { provider: AiProvider; until: number; why: string } | null = null;

export function isAccountProblem(status: number | undefined, error: string | undefined): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  const text = error ?? '';
  // A spend limit the owner set answers 400; the tier's monthly cap answers
  // 429 "You have reached your API usage limits" (enforced_spend_limit_reached)
  // until the 1st. Neither is a busy minute.
  if (status === 429) return /enforced_spend_limit|usage limits/i.test(text);
  return status === 400 && /credit balance is too low|usage limits|spend limit|purchase credits|billing/i.test(text);
}

/** The main provider's pause, if one is on. */
export function providerCooldown(now: number = Date.now()): { provider: AiProvider; until: string; why: string } | null {
  if (!cooldown || cooldown.until <= now) return null;
  return { provider: cooldown.provider, until: new Date(cooldown.until).toISOString(), why: cooldown.why };
}

/** Tests only. */
export function resetProviderCooldownForTests(): void {
  cooldown = null;
}

/** Which text models are in use, and whether the main one is paused: for /admin → AI. */
export function textModelsStatus(): {
  main: AiProvider;
  backup: AiProvider | null;
  models: { fast: string; premium: string };
  backupModels: { fast: string; premium: string; fallback: string | null } | null;
  paused: { provider: AiProvider; until: string; why: string } | null;
} {
  const main = activeProvider();
  const backup = backupProvider();
  return {
    main,
    backup,
    models: { fast: providerModel(main, 'fast'), premium: providerModel(main, 'premium') },
    backupModels: backup === 'gemini'
      ? { fast: geminiModel('fast'), premium: geminiModel('premium'), fallback: geminiFallback('premium') }
      : null,
    paused: providerCooldown(),
  };
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
  '- Three dominant HUES. The rest of the palette is TONES of those three —',
  '  light-to-dark steps for shading — not more hues. A flat design needs 3-5',
  '  entries; one carrying a portrait or modelled artwork wants 10-16, ordered',
  '  dark to light. Every colour is a card someone must print and sort, so',
  '  spend them on depth, never on variety.',
  '- Palette index 0 is UNPAINTED seats and it is free — a card nobody prints.',
  '  Filling a stand with 0 and re-filling rows [0.07,0.93] leaves the art on a',
  '  margin of bare concrete. Use it on ONE stand, under a hero. NEVER on more',
  '  than one: a stand has no left or right edge of its own, so the only margin',
  '  it can make is top-and-bottom, and several stands wearing the same one is',
  '  not a frame — it is one dark stripe across the top of the whole stadium and',
  '  another across the bottom, and it reads as the design being cut off.',
  '- A stand is a POSTER about 6.6:1 wide: margin, field, ONE hero, ONE',
  '  supporting line. Put a stand\'s field fill immediately before the art on it.',
  '- SEATS ARE PIXELS. Obey each stand\'s "Holds" line in STADIUM CONTEXT:',
  '  glyph rows = heightFrac x rows; a word under 8 (Arabic 12) or a symbol',
  '  under 12 is noise. SHALLOW: ONE element, heightFrac 0.9, no row bands.',
  '  Only colour on a SLIVER or a stand with NO SEATS.',
  '- On a 34+ row stand jump scale 4:1: hero [0.06,0.60], support',
  '  [0.70,0.92]. Two lines of one size read as a paragraph.',
  '- Posterise: flat blocks, hard edges. Never ramp between two close tones.',
  '- ARABIC NEEDS ROOM: measured on seats, at heightFrac 0.22 Arabic loses 45%',
  '  of itself to strokes too fine to hold (Latin 2%), 100% on ONE tier. Give it',
  '  0.55+ over BOTH tiers and two or three words; past 0.55 only fewer words',
  '  help. Never a small Arabic support line: the hero or nothing.',
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
    '    { "kind":"image",   "region":Region, "prompt":string, "scaleFrac":number, "dither":boolean, "halftone":boolean?, "fit":"cover|contain"?, "cutout":boolean? }',
    '  ]',
    '}',
    '',
    'Region is EXACTLY one of "all"|"lower"|"upper"|"sides"|"ends"|"north"|"south"|',
    '"east"|"west" (lowercase, no "stand"/"tier" words), or { "stand", "tier":0|1|"all",',
    '"rows":[from,to], "stands":["north","south"] } where rows are fractions of',
    `stand height (0 = front, 1 = back). Stands: ${STANDS.join(', ')}.`,
    voiceLine(false),
    `SymbolName (drawable vector symbols): ${SYMBOL_NAMES.join(', ')}.`,
    'GIVE THE BOWL A PICTURE. An "image" layer is the HERO whenever the brief has',
    'a SUBJECT at all — a player or legend, a trophy, an eagle or lion, a crest,',
    'a crowd, a skyline, a moment. Not just people. scaleFrac 0.9-1.0 on its OWN',
    'stand, words on the OPPOSITE stand, subject in "prompt".',
    'Reach for a "symbol" only for a plain geometric mark (star, chevron, ring) or',
    'when the brief is purely typographic. A vector symbol is ONE flat colour: it',
    'cannot shade, so a design built on symbols and fills can only ever be flat',
    'blocks. The picture is what makes a deep palette worth having.',
    'Its flat backdrop is cut away by default ("cutout":false keeps it), so the',
    'fills and patterns you put on that stand show through around the subject —',
    'paint the stand properly, it is what the hero will be standing on.',
    'It is generated AT THE REGION\'S SHAPE and IN YOUR PALETTE, so the palette you',
    'pick IS the picture\'s palette: give it 6-10 tones ordered dark → light (plus a',
    'skin tone for a face) — two flat colours read as a shapeless blob. Do not',
    'flood the bowl with one flat fill behind it. "fit":"cover" (default) fills the',
    'region edge to edge; "contain" crops nothing. A mural may span ADJACENT stands',
    'via "stands":["north","west"]; "sides"/"ends" face each other and would tear it.',
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
    'GIVE THE BOWL A PICTURE. Almost every brief has a SUBJECT — a legend, a',
    'trophy, an eagle, a crest, a crowd, a skyline, a moment — and that subject is',
    'an "image" layer HERO on its OWN stand (scaleFrac 0.9-1.0), words on the',
    'OPPOSITE stand, "halftone": true (clustered tones read far better at seat',
    'scale than fine dithering). Use a "symbol" only for a plain geometric mark or',
    'a purely typographic brief: a symbol is ONE flat colour and cannot shade, so a',
    'bowl of symbols and fills is flat blocks however many colours you list.',
    'Its flat backdrop is cut away by default ("cutout":false keeps it), so what',
    'you paint on that stand shows through around the subject — the hero stands',
    'ON your design rather than in a photo block.',
    'The picture is generated AT ITS REGION\'S SHAPE and IN YOUR PALETTE, so the',
    'palette you pick IS the picture\'s palette — give it 6-10 tones dark→light',
    '(plus a skin tone for a face). That is what the colour budget is FOR.',
    '"fit":"cover" (default) fills the region edge to edge; "contain" crops nothing.',
    'A mural may span ADJACENT stands via "stands":["north","west"];',
    '"sides"/"ends" face each other and would tear it.',
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
    'first). Never drop "outline", "stretch", "dx", "dy", "wide", "fit", "halftone"',
    'or an image\'s "prompt" from a layer you rewrite. If a headline is losing to',
    'its field, ADD a pair rather than recolouring it. A palette of 10-16 tones is',
    'a MODELLED design, not a mistake — never flatten it back to three colours.',
    '',
    `JSON: { "title", "summary", "palette":["#rrggbb",...] (index 0 = empty seat #262a33, ${SPEC_LIMITS.minPalette}-${SPEC_LIMITS.maxPalette}),`,
    '"background": number|null, "layers":[ fill|stripes|gradient|pattern|text|symbol|image ] },',
    'each layer with a "region": "all"|"lower"|"upper"|"north"|"south"|"east"|"west"|',
    '"sides"|"ends" or { "stand","tier","rows":[from,to],"stands":[...] }.',
    'Text layers also take "outline", "stretch", "dx", "dy"; symbols take "wide".',
    'stripes: "colors" + "orientation" vertical|horizontal|diagonal (not "direction");',
    'gradient: "colors" + "direction". Every colour is a palette INDEX that exists —',
    'add a hex to "palette" before using it, never write hex in a layer.',
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
export async function writeCopy(prompt: string, hint?: string, meter?: (usage: TokenUsage) => void): Promise<TifoCopy | null> {
  const r = await generateSpecViaProvider(prompt, { system: buildCopywriterPrompt(), tier: 'fast', hint });
  // Its tokens belong to the request that asked, failed calls included.
  if (r.usage) meter?.(r.usage);
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

/**
 * Anthropic user content: the text, plus the image when there is one.
 *
 * There was one, and it was being dropped. `opts.image` reached this function's
 * Gemini twin and nowhere else, so on an Anthropic key the vision critic was
 * told "you are looking at a low-resolution render of that design" and shown
 * nothing at all — and then judged the design anyway. A prompt that describes a
 * picture the model cannot see is worse than no picture.
 */
function anthropicContent(text: string, image?: string): unknown {
  const m = image?.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
    { type: 'text', text },
  ];
}

/** OpenAI user content: same fix, same reason. It takes the data: URL whole. */
function openaiContent(text: string, image?: string): unknown {
  if (!image || !/^data:[^;]+;base64,/.test(image)) return text;
  return [
    { type: 'image_url', image_url: { url: image } },
    { type: 'text', text },
  ];
}

/** Pull the first JSON object out of a model response (tolerant of fences/prose). */
/**
 * The output-token ceiling for a generation.
 *
 * 8192, not 4096. On a thinking model the budget covers the model's REASONING as
 * well as its answer, and the director prompt now carries a full house style, a
 * lettering contract and a four-design gallery — plenty to think about. A design
 * with a 16-tone palette and outline pairs (which double the text layers) is a
 * bigger answer too. Run out and the reply is truncated to nothing usable, which
 * the caller can only report as "premium is busy".
 *
 * Number() of a QUOTED env value is NaN, and NaN fails every > comparison, so an
 * accidental AI_MAX_OUTPUT_TOKENS="8192" would silently pass 0 or NaN to the
 * provider. Fall back rather than trust it.
 */
export function maxOutputTokens(): number {
  return envNum('AI_MAX_OUTPUT_TOKENS', 8192, 1024, 32768);
}

export interface GeminiReply {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  /** What the call cost in tokens. Thinking is reported apart from the answer. */
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** One call's usage, priced for the model that answered. */
function callUsage(model: string, t: { in: number; out: number; thought: number; cached: number }): TokenUsage {
  return { ...t, calls: 1, costMicros: textCostMicros(model, t) };
}

/**
 * Usage from a Gemini reply. A reply that carried no usageMetadata was still
 * an answer Google bills, so its cost is UNKNOWN (null), not $0.
 */
export function geminiUsage(model: string, data: GeminiReply | null | undefined): TokenUsage {
  const u = data?.usageMetadata;
  if (!u) return { ...zeroUsage(), calls: 1, costMicros: null };
  return callUsage(model, {
    in: n0(u?.promptTokenCount),
    out: n0(u?.candidatesTokenCount),
    thought: n0(u?.thoughtsTokenCount),
    cached: n0(u?.cachedContentTokenCount),
  });
}

/**
 * Every answer part of a Gemini reply, joined.
 *
 * Reading parts[0] alone was wrong the moment a thinking model was pointed at
 * this: the model emits its thought summary as the first part and the JSON as a
 * later one, so the answer was being thrown away and reported as invalid JSON.
 * Parts flagged `thought` are reasoning, never the answer.
 */
export function geminiText(data: GeminiReply): string {
  return (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p?.thought)
    .map((p) => p?.text ?? '')
    .join('');
}

/**
 * Why a reply carried no usable JSON, in words an operator can act on. All of
 * these used to surface as the same "response was not valid JSON", which says
 * nothing about whether to raise a limit, soften a prompt or fix a model id.
 */
export function whyNoJson(data: GeminiReply, text: string): string {
  const finish = data.candidates?.[0]?.finishReason;
  const blocked = data.promptFeedback?.blockReason;
  if (finish === 'MAX_TOKENS') {
    return `ran out of output tokens before finishing the JSON (finishReason MAX_TOKENS, limit ${maxOutputTokens()}) — raise AI_MAX_OUTPUT_TOKENS`;
  }
  if (blocked) return `prompt blocked by the safety filter (blockReason ${blocked})`;
  if (finish && finish !== 'STOP') return `stopped early (finishReason ${finish})`;
  if (!text.trim()) return 'empty response (no text parts)';
  return `response was not valid JSON; it began: ${text.slice(0, 140).replace(/\s+/g, ' ')}`;
}

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
  /** HTTP status when the provider refused, so the retry decision isn't a string match. */
  status?: number;
  /** The model that answered, or the last one asked when none did. */
  model?: string;
  /** Tokens and estimated cost of every call this request made, failed ones included. */
  usage?: TokenUsage;
  /** Set when the answer came from the fallback model: the model that could not. */
  fellBackFrom?: string;
  /**
   * The failure says nothing about the brief, so another model (or another try)
   * may well answer: capacity, quota, timeouts, a retired or refused model id.
   * Not set for a key the provider refused, its safety filter, or an answer
   * that arrived but was not usable JSON.
   */
  transient?: boolean;
  /**
   * When the fallback failed too: what the FIRST model said. The failure is
   * classified from this, not from the fallback: a premium model at capacity
   * whose fallback is out of quota is "busy, try again", not "resting until
   * tomorrow", and a mistyped AI_MODEL_FALLBACK must not relabel every
   * premium failure as "model not found" (review, 17 October 2026).
   */
  firstFailure?: { error: string; status?: number };
  /** The provider that answered, or the last one asked when none did. */
  provider?: AiProvider;
  /**
   * The provider declined the brief itself (Claude's stop_reason "refusal",
   * Gemini's safety block). Not sent on to the backup: that is a decision
   * about the content, and shopping it around would be the wrong answer to it.
   */
  refused?: boolean;
}

/** HTTP statuses where a second model is worth asking. 401/403 are the key: every model refuses. */
const TRANSIENT_STATUS = new Set([404, 408, 429, 500, 502, 503, 504, 529]);

/**
 * Is this refusal worth a second model?
 *
 * A 400 only when it is about THIS model: a retired id, a setting the model
 * does not take. Google answers a wrong or expired key with 400 as well
 * (API_KEY_INVALID, not 401), and so it answers an unsupported region or an
 * image it cannot read. Every model refuses those, so falling back doubled the
 * calls and the budget during a key outage and fixed nothing (review, 17
 * October 2026). The whole body is read, not the 180 characters kept.
 */
export function isTransient(status: number, body: string): boolean {
  if (status !== 400) return TRANSIENT_STATUS.has(status);
  return /\bmodels?\b/i.test(body) && !/api[ _]?key|permission|location|region|country|mime|image/i.test(body);
}

/** A provider's refusal: the call still counts, and the error keeps a bounded copy of the body. */
async function refusal(label: string, res: Response, model: string): Promise<ProviderResult> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const short = body.slice(0, 180).replace(/\s+/g, ' ').trim();
  return {
    spec: null,
    status: res.status,
    model,
    usage: { ...zeroUsage(), calls: 1 },
    transient: isTransient(res.status, body),
    error: `${label}: HTTP ${res.status}${short ? `: ${short}` : ''}`,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the configured model for a TifoSpec. Returns the parsed (UNvalidated) JSON
 * plus, on failure, a human-readable reason. The caller validates and falls back
 * to the offline designer, surfacing the reason in the UI.
 *
 * A second attempt goes to the FALLBACK MODEL (geminiFallback) whenever the
 * first failure says nothing about the brief: a 503, a 429, a timeout, a
 * retired model id. Two calls at most, as before; only the second one now goes
 * where an answer is likely. With no fallback the old rules below apply.
 *
 * Retries ONCE on 503. "This model is currently experiencing high demand" is
 * Google's own wording for a temporary spike, and it costs the user a whole
 * generation: the image path has always retried these, while the text path —
 * the one that decides whether there is a design at all — did not.
 *
 * Never the same model on 429. A quota error is not transient for that model,
 * and retrying it spends another request against the limit that just refused
 * you. (Another model has its own quota, which is why the fallback does try.)
 *
 * And once on a TIMEOUT. The fast tier runs gemini-3.1-flash-lite, whose latency
 * is spiky — most calls answer in a couple of seconds, about one in four takes
 * 15-20 s (reported publicly, and seen here as "timed out" on a standard design
 * in October 2026). A second attempt is very likely to be one of the fast ones,
 * and the alternative is the user getting no design at all. AI_TIMEOUT_RETRY=0
 * turns it off.
 */
let retryMeter: (() => void) | null = null;
/**
 * Called for every second attempt the retry below makes. The route counts one
 * AI_DAILY_BUDGET call per request, and a retried request is two real calls
 * to the provider: during a slow spell the budget under-counted by up to half
 * (audit round five). aiRoutes hands in the budget counter.
 */
export function meterRetries(fn: (() => void) | null): void {
  retryMeter = fn;
}

type CallOpts = { system?: string; context?: string; image?: string; tier?: 'fast' | 'premium'; hint?: string; raw?: boolean };

/**
 * One call's time limit. Premium runs a bigger model on a longer prompt, and
 * Super makes two calls; 20 s was tuned for a single fast call and truncated
 * the rest. The fast tier gets 30 s, not 20: its slow calls land at 15-20 s,
 * right on the old limit, so they were cut off just before they answered.
 * A quoted value here used to abort every call on the next tick — see envNum.
 */
function callTimeoutMs(tier: 'fast' | 'premium'): number {
  return tier === 'premium' ? envNum('AI_TIMEOUT_PREMIUM_MS', 45000, 1000) : envNum('AI_TIMEOUT_MS', 30000, 1000);
}

export async function generateSpecViaProvider(prompt: string, opts: CallOpts = {}): Promise<ProviderResult> {
  const main = activeProvider();
  const backup = backupProvider();
  if (!backup) return generateWith(main, prompt, opts);

  // Paused for an account problem (no credit left, key refused): straight to
  // the backup, without the round trip that would only fail again.
  if (cooldown && cooldown.provider === main && cooldown.until > Date.now()) {
    return generateWith(backup, prompt, opts);
  }

  const started = Date.now();
  const r = await callProvider(prompt, opts, { provider: main });
  if (r.spec || r.refused) return r;
  const pauseMs = envNum('AI_PROVIDER_COOLDOWN_MS', 15 * 60_000, 0);
  if (pauseMs > 0 && isAccountProblem(r.status, r.error)) {
    // The provider's own sentence when there is one ("Your credit balance is
    // too low..."), not its JSON envelope.
    const said = /"message"\s*:\s*"([^"]+)/.exec(r.error ?? '')?.[1];
    cooldown = { provider: main, until: Date.now() + pauseMs, why: (said ?? r.error ?? '').slice(0, 200) };
  }
  // Anything else Claude could not do (busy, down, out of credit, an answer
  // that was not JSON) goes to Gemini, which runs exactly as it does on its
  // own: its tier model, then its fallback model. A SLOW failure (a timeout,
  // or any answer after half the time limit) leaves no time for two more
  // calls, since the whole request has to land inside Cloudflare's 100
  // seconds, so it gets one, to Gemini's quick fallback model (or its tier
  // model when the fallback is off). AI_TIMEOUT_RETRY=0 still means a timed
  // out request makes no second call at all.
  const tier = opts.tier ?? 'fast';
  const timedOut = /timed out$/.test(r.error ?? '');
  if (timedOut && process.env.AI_TIMEOUT_RETRY === '0') return r;
  const slow = timedOut || Date.now() - started > callTimeoutMs(tier) / 2;
  retryMeter?.();
  const g = slow && backup === 'gemini'
    ? await callProvider(prompt, opts, { provider: backup, model: geminiFallback(tier) ?? geminiModel(tier) })
    : await generateWith(backup, prompt, opts);
  const usage = addUsage(r.usage ?? zeroUsage(), g.usage);
  if (g.spec) return { ...g, usage, fellBackFrom: r.model };
  return {
    ...g,
    usage,
    error: `${r.error ?? 'no answer'}; then fallback ${g.error ?? 'no answer'}`,
    firstFailure: { error: r.error ?? 'no answer', ...(r.status ? { status: r.status } : {}) },
  };
}

/** One provider, with its own second chance: Gemini's fallback model, or a same-model retry. */
async function generateWith(provider: AiProvider, prompt: string, opts: CallOpts): Promise<ProviderResult> {
  const r = await callProvider(prompt, opts, { provider });
  if (r.spec) return r;
  const timedOut = /timed out$/.test(r.error ?? '');
  const timeoutRetry = timedOut && process.env.AI_TIMEOUT_RETRY !== '0';

  // A second MODEL first. Still at most two calls per request, so the wait and
  // the budget are what they were; the second call just goes somewhere that is
  // likely to answer. A 429 is now worth one: it is THIS model's quota that
  // refused, and the fallback has its own.
  const fallback = provider === 'gemini' ? geminiFallback(opts.tier ?? 'fast') : null;
  if (fallback && fallback !== r.model && r.transient && (!timedOut || timeoutRetry)) {
    retryMeter?.();
    const again = await callProvider(prompt, opts, { provider, model: fallback });
    const usage = addUsage(r.usage ?? zeroUsage(), again.usage);
    if (again.spec) return { ...again, usage, fellBackFrom: r.model };
    // Both failed. The first model's failure is the cause (firstFailure), the
    // fallback's is context; the error carries both, first model first.
    return {
      ...again,
      usage,
      error: `${r.error ?? 'no answer'}; then fallback ${again.error ?? 'no answer'}`,
      firstFailure: { error: r.error ?? 'no answer', ...(r.status ? { status: r.status } : {}) },
    };
  }

  // No fallback (or the fallback IS this model): the old same-model retry.
  // 529 is Claude's "overloaded", its word for Google's 503.
  if (r.status !== 503 && r.status !== 529 && !timeoutRetry) return r;
  if (!timedOut) await sleep(envNum('AI_RETRY_DELAY_MS', 1200, 100, 10000));
  retryMeter?.();
  const again = await callProvider(prompt, opts, { provider });
  // Report the SECOND failure: if it is still down, that is the current truth.
  return { ...again, usage: addUsage(r.usage ?? zeroUsage(), again.usage) };
}

async function callProvider(
  prompt: string,
  opts: CallOpts = {},
  target: { provider?: AiProvider; model?: string } = {},
): Promise<ProviderResult> {
  const provider = target.provider ?? activeProvider();
  if (provider === 'none') return { spec: null, error: 'no AI provider configured', usage: zeroUsage() };
  const r = await callOne(provider, prompt, opts, target.model);
  return { ...r, provider };
}

async function callOne(provider: AiProvider, prompt: string, opts: CallOpts, modelOverride?: string): Promise<ProviderResult> {
  // Premium runs a bigger model on a longer prompt, and Super now makes two
  // calls. 20s was tuned for a single fast call and truncates the rest.
  // A quoted value here used to abort every call on the next tick — see envNum.
  const timeoutMs = callTimeoutMs(opts.tier ?? 'fast');
  const system = opts.system ?? buildSystemPrompt();
  // Built ONCE. Three separate userMessage() calls meant a new argument had to
  // be threaded through three bodies, and forgetting one would silently drop it
  // for that provider alone.
  // `raw` is for callers asking something that is not "design me a tifo" — the
  // photo reader in src/core/photoFacts, for one. Wrapping its question in
  // "Return the TifoSpec JSON now" would ask the model for the wrong object.
  const user = opts.raw ? prompt : userMessage(prompt, opts.context, opts.hint);

  // The model this call asks, named before the call so a failure can say which.
  const tier = opts.tier ?? 'fast';
  const model = modelOverride ?? providerModel(provider, tier);
  // A refused call still counts as a call (the budget and the cost panel see
  // it), even though it bills no tokens.
  const refused = (): TokenUsage => ({ ...zeroUsage(), calls: 1 });

  try {
    if (provider === 'anthropic') {
      const label = `claude "${model}"`;
      const headers = { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' };
      const effort = claudeEffort(tier);
      const thinking = claudeThinking(model, tier, effort);
      const base = { model, max_tokens: claudeMaxTokens(), system, messages: [{ role: 'user', content: anthropicContent(user, opts.image) }] };
      const started = Date.now();
      let res = await postJson('https://api.anthropic.com/v1/messages', headers, { ...base, output_config: { effort }, ...(thinking ? { thinking } : {}) }, timeoutMs);
      let spent = zeroUsage();
      // A model that does not take the effort or thinking setting (an older
      // id in AI_CLAUDE_MODEL_*) says so with a 400. Losing the setting is far
      // better than losing the design, so it is dropped once and asked again.
      // Only the setting the error names is dropped: an older Sonnet that
      // refuses the thinking setting still gets its effort level.
      if (res.status === 400) {
        const body = await res.clone().text().catch(() => '');
        const noThinking = !!thinking && /thinking/i.test(body);
        const noEffort = /effort|output_config/i.test(body);
        if ((noThinking || noEffort) && !/credit balance|usage limits/i.test(body)) {
          spent = { ...zeroUsage(), calls: 1 };
          retryMeter?.();
          const again = { ...base, ...(noEffort ? {} : { output_config: { effort } }), ...(thinking && !noThinking ? { thinking } : {}) };
          res = await postJson('https://api.anthropic.com/v1/messages', headers, again, Math.max(5000, timeoutMs - (Date.now() - started)));
        }
      }
      if (!res.ok) {
        const r = await refusal(label, res, model);
        return { ...r, usage: addUsage(spent, r.usage) };
      }
      const data = (await res.json()) as {
        content?: Array<{ text?: string; type?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      };
      // Thinking is inside output_tokens (billed as output); Claude does not
      // report it apart, so `thought` stays 0 for Claude rows.
      const cached = n0(data.usage?.cache_read_input_tokens);
      const usage = addUsage(spent, data.usage
        ? callUsage(model, { in: n0(data.usage.input_tokens) + cached + n0(data.usage.cache_creation_input_tokens), out: n0(data.usage.output_tokens), thought: 0, cached })
        : { ...zeroUsage(), calls: 1, costMicros: null });
      if (data.stop_reason === 'refusal') {
        return { spec: null, model, usage, refused: true, error: `${label}: declined by its safety system (stop_reason refusal)` };
      }
      // The answer's text blocks only: thinking arrives in blocks of its own.
      const text = (data.content ?? []).filter((b) => (b?.type ?? 'text') === 'text').map((b) => b?.text ?? '').join('');
      const spec = extractJson(text);
      if (spec) return { spec, model, usage };
      if (data.stop_reason === 'max_tokens') {
        return { spec: null, model, usage, error: `${label}: ran out of output tokens before finishing the JSON (stop_reason max_tokens, limit ${claudeMaxTokens()}) — raise AI_CLAUDE_MAX_TOKENS` };
      }
      return { spec: null, model, usage, error: `${label}: ${text.trim() ? `response was not valid JSON; it began: ${text.slice(0, 140).replace(/\s+/g, ' ')}` : 'empty response (no text blocks)'}` };
    }
    if (provider === 'gemini') {
      const res = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        // The key goes in a header. Google documents x-goog-api-key and nothing
        // else; a key in the URL also ends up in every proxy and access log the
        // request passes through.
        { 'content-type': 'application/json', 'x-goog-api-key': geminiKey()! },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: geminiParts(user, opts.image) }],
          // No temperature. Google deprecated it for 3.6 Flash and later (it is
          // ignored there, and the next generation answers it with HTTP 400),
          // and for 3.0/3.1 it recommended the default anyway.
          generationConfig: {
            responseMimeType: 'application/json',
            ...(process.env.AI_RESPONSE_SCHEMA === '1' ? { responseJsonSchema: tifoResponseSchema() } : {}),
            maxOutputTokens: maxOutputTokens(),
          },
        },
        timeoutMs,
      );
      if (!res.ok) return refusal(`gemini "${model}"`, res, model);
      const data = (await res.json()) as GeminiReply;
      const usage = geminiUsage(model, data);
      const text = geminiText(data);
      const spec = extractJson(text);
      if (spec) return { spec, model, usage };
      const blocked = !!data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason === 'SAFETY';
      return { spec: null, model, usage, ...(blocked ? { refused: true } : {}), error: `gemini "${model}": ${whyNoJson(data, text)}` };
    }
    // openai
    const res = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
      { model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: openaiContent(user, opts.image) }] },
      timeoutMs,
    );
    if (!res.ok) return refusal('openai', res, model);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const thought = n0(data.usage?.completion_tokens_details?.reasoning_tokens);
    const usage = callUsage(model, {
      in: n0(data.usage?.prompt_tokens),
      out: Math.max(0, n0(data.usage?.completion_tokens) - thought),
      thought,
      cached: n0(data.usage?.prompt_tokens_details?.cached_tokens),
    });
    const spec = extractJson(data.choices?.[0]?.message?.content ?? '');
    return spec ? { spec, model, usage } : { spec: null, model, usage, error: 'openai: response was not valid JSON' };
  } catch (e) {
    // Timed out or unreachable: nothing about the brief, so worth another model.
    const who = provider === 'gemini' ? `gemini "${model}"` : provider === 'anthropic' ? `claude "${model}"` : provider;
    return { spec: null, model, usage: refused(), transient: true, error: `${who}: ${(e as Error)?.name === 'AbortError' ? 'timed out' : 'network error'}` };
  }
}
