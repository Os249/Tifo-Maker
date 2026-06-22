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

/** The choreography-designer system prompt — also the human-readable spec contract. */
export function buildSystemPrompt(): string {
  return [
    'You are the lead choreography designer for TifoMaker, planning stadium-scale',
    'tifo displays (the giant coordinated card mosaics ultras hold up).',
    '',
    'You do NOT generate images or pixels. You output a DESIGN SPECIFICATION as',
    'JSON that TifoMaker renders onto tens of thousands of seats. Think like a',
    'director of a card stunt: bold, readable shapes that survive a ~10% no-show',
    'rate; never fine photographic detail.',
    '',
    'LANGUAGE: the brief may be in English or Arabic, or mix both — understand both',
    'fully. Interpret intent, mood, club identity, rivalries and any named person or',
    'club. Text layers may be Arabic OR English (the renderer shapes Arabic/RTL',
    'correctly); pick whatever fits the club and region, and transliterate names',
    'sensibly. If the brief is Arabic, prefer Arabic headline text unless asked otherwise.',
    '',
    'THINK LIKE AN ULTRAS CHOREOGRAPHER: choose ONE clear focal point, use the named',
    'stand(s) deliberately, build strong contrast and visual hierarchy, express the',
    'club identity and its real colours, and VARY the composition — never fall back',
    'on a single default template. Reflect the emotion in the brief (defiance, pride,',
    'celebration, mourning, derby intensity).',
    '',
    'COMPOSITION: for stadium-wide briefs, plan a MULTI-STAND scene — e.g. a hero',
    'emblem or figure on one end, a giant headline on the opposite end, and a',
    'gradient or patterned field on the sides — so the whole bowl tells ONE coherent',
    'story. Target each element to its stand; keep one dominant focal point per stand',
    'and never crowd a stand with competing big elements. Use gradient/pattern fields',
    'for depth and mosaic texture, not always a flat fill.',
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
    '    { "kind":"text",    "region":Region, "text":string, "colorIndex":number, "fontId":FontId, "arcDeg":number, "heightFrac":number, "align":"center|top|bottom" },',
    '    { "kind":"symbol",  "region":Region, "symbol":SymbolName, "colorIndex":number, "scaleFrac":number, "align":"center|top|bottom" },',
    '    { "kind":"image",   "region":Region, "prompt":string, "scaleFrac":number, "dither":boolean }',
    '  ]',
    '}',
    '',
    'Region is "all" | "lower" | "upper" | "north" | "south" | "east" | "west",',
    'or { "stand":"north|south|east|west|all", "tier":number|"all", "rows":[from,to] }',
    'where rows are fractions of stand height (0 = front row, 1 = back).',
    '',
    `Stands: ${STANDS.join(', ')} (each is one side of the bowl).`,
    `FontId: ${SPEC_FONT_IDS.join(', ')}.`,
    `SymbolName (drawable vector symbols): ${SYMBOL_NAMES.join(', ')}.`,
    'For a PORTRAIT, a player, a face, a mascot or detailed artwork, use an "image"',
    'layer — it is the HERO: make it large (scaleFrac 0.9-1.0) on its OWN stand,',
    'with the name/number on the OPPOSITE stand. Describe the subject in "prompt".',
    'Such designs NEED a tonal palette of 5-6 colours so the face shades cleanly:',
    'even if the brief names only one or two colours, ADD the in-between tones',
    '(e.g. black → dark grey → mid grey → light grey → white) PLUS one skin tone —',
    'a portrait rendered in two flat colours reads as a shapeless blob. Order the',
    'palette dark → light. Do NOT flood the whole bowl with one flat fill behind a',
    'portrait; give each stand a distinct role. Use vector symbols for simple',
    'emblems, image layers for any real person or photographic subject.',
    '',
    'Rules: keep the palette tight (2-5 colours typically). Put one clear focal',
    'element. Maximise contrast between text/symbol and the field behind it.',
    'heightFrac for a headline is usually 0.4-0.7; scaleFrac for a hero symbol',
    '0.6-0.9. Scope everything to the stand(s) the user names; use "all" only for',
    'stadium-wide stunts. Respect symmetry and a clear visual hierarchy.',
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
    'stadium experience — not a single image dropped in one stand.',
    '',
    'You output the SAME design-specification JSON as before (palette, background,',
    'ordered layers; never pixels or seat indices). The renderer compiles it to',
    'tens of thousands of seats and guarantees legibility, so think BOLD: shapes',
    'that survive a ~10% no-show rate, never fine photographic detail.',
    '',
    'DESIGN THE WHOLE BOWL:',
    '- Read the STADIUM CONTEXT in the user message (per-stand seat counts, tiers,',
    '  rows, columns, aspect) and plan FOR that geometry.',
    '- Give EACH stand a deliberate role — hero portrait/crest, giant headline,',
    '  colour field, or pattern — with ONE dominant focal point per stand. Never',
    '  crowd a stand with competing big elements.',
    '- Compose ACROSS stands: use region "sides" (east+west), "ends" (north+south)',
    '  or { "stands": ["north","east"] } for colour fields/patterns that wrap the',
    '  bowl; target single stands ("north","south","east","west") for focal pieces.',
    '- GO BIG: tifos are seen from 100m+ and on TV. Use FEW words and HUGE text',
    '  (1-2 word headlines filling the stand, heightFrac 0.5-0.8); make symbols and',
    '  portraits fill their stand; push maximum contrast. Thin, timid, small elements',
    '  vanish at scale — when unsure, go bigger.',
    '- Build clear hierarchy and strong contrast; reflect the brief’s emotion',
    '  (derby intensity, farewell, anniversary, trophy, heritage, defiance).',
    '',
    'LANGUAGE: briefs may be English, Arabic, or both — understand both fully. Text',
    'layers may be Arabic or English (the renderer shapes Arabic/RTL); pick what',
    'fits the club/region and transliterate names sensibly.',
    '',
    'PORTRAITS: for a player/legend/face use an "image" layer as the HERO on its',
    'OWN stand (scaleFrac 0.9-1.0), the name/number on the OPPOSITE stand, and a',
    '5-6 tone palette (dark→light + a skin tone) so the face shades cleanly. Set',
    '"halftone": true on the image layer — clustered tones read far more cleanly at',
    'seat scale than fine dithering.',
    '',
    `JSON: { "title", "summary", "palette":["#rrggbb",...] (index 0 = empty seat #262a33, ${SPEC_LIMITS.minPalette}-${SPEC_LIMITS.maxPalette}),`,
    '"background": number|null, "layers":[ ... ] }. Layer kinds: fill, stripes,',
    'gradient, pattern, text, symbol, image — each with a "region".',
    'Region: "all"|"lower"|"upper"|"north"|"south"|"east"|"west"|"sides"|"ends", or',
    '{ "stand", "tier", "rows":[from,to], "stands":[...] }.',
    `Fonts: ${SPEC_FONT_IDS.join(', ')}. Symbols: ${SYMBOL_NAMES.join(', ')}. Patterns: ${PATTERN_NAMES.join(', ')}.`,
    `Stands: ${STANDS.join(', ')}. Output STRICT JSON ONLY (no prose, no code fences).`,
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
    `JSON: { "title", "summary", "palette":["#rrggbb",...] (index 0 = empty seat #262a33, ${SPEC_LIMITS.minPalette}-${SPEC_LIMITS.maxPalette}),`,
    '"background": number|null, "layers":[ fill|stripes|gradient|pattern|text|symbol|image ] },',
    'each layer with a "region": "all"|"lower"|"upper"|"north"|"south"|"east"|"west"|',
    '"sides"|"ends" or { "stand","tier","rows":[from,to],"stands":[...] }.',
    `Fonts: ${SPEC_FONT_IDS.join(', ')}. Symbols: ${SYMBOL_NAMES.join(', ')}. Patterns: ${PATTERN_NAMES.join(', ')}.`,
    'Output STRICT JSON ONLY (no prose, no code fences).',
  ].join('\n');
}

/**
 * Ask the model to critique a rendered design and return an improved spec.
 * `image` is a data: URL of the bowl render; `stadium` is the geometry context.
 */
export async function critiqueSpecViaProvider(spec: unknown, image?: string, stadium?: string): Promise<ProviderResult> {
  const prompt = [
    stadium ? `STADIUM CONTEXT:\n${stadium}` : '',
    'CURRENT DESIGN SPEC (improve it; keep the intent and palette):',
    JSON.stringify(spec),
  ]
    .filter(Boolean)
    .join('\n\n');
  return generateSpecViaProvider(prompt, { system: buildCriticPrompt(), image, tier: 'premium' });
}

function userMessage(prompt: string, context?: string): string {
  const ctx = context ? `STADIUM CONTEXT:\n${context}\n\n` : '';
  return `${ctx}Brief: ${prompt}\n\nReturn the TifoSpec JSON now.`;
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
  return `${label}: HTTP ${res.status}${body ? ` — ${body}` : ''}`;
}

/**
 * Ask the configured model for a TifoSpec. Returns the parsed (UNvalidated) JSON
 * plus, on failure, a human-readable reason. The caller validates and falls back
 * to the offline designer, surfacing the reason in the UI.
 */
export async function generateSpecViaProvider(
  prompt: string,
  opts: { system?: string; context?: string; image?: string; tier?: 'fast' | 'premium' } = {},
): Promise<ProviderResult> {
  const provider = activeProvider();
  if (provider === 'none') return { spec: null, error: 'no AI provider configured' };
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 20000);
  const system = opts.system ?? buildSystemPrompt();
  try {
    if (provider === 'anthropic') {
      const res = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
        { model: process.env.AI_MODEL ?? 'claude-3-5-sonnet-latest', max_tokens: 1500, system, messages: [{ role: 'user', content: userMessage(prompt, opts.context) }] },
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
          contents: [{ role: 'user', parts: geminiParts(userMessage(prompt, opts.context), opts.image) }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 4096 },
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
      { model: process.env.AI_MODEL ?? 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage(prompt, opts.context) }] },
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
