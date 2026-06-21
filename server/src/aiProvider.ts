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

import { SYMBOL_NAMES, SPEC_FONT_IDS, STANDS, SPEC_LIMITS } from '../../src/core/tifoSpec';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'none';

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
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
    'layer — it is the HERO: make it large (scaleFrac 0.85-1.0) on its OWN stand,',
    'with the name/number on the OPPOSITE stand. Describe the subject in "prompt".',
    'Such designs NEED a tonal palette of 5-6 colours (dark/mid/light of the main',
    'colour + skin tones) so the picture shades — never just two flat colours. Do',
    'NOT flood the whole bowl with one flat fill behind a portrait; give each stand',
    'a distinct role. Use vector symbols for simple emblems, image layers for any',
    'real person or photographic subject.',
    '',
    'Rules: keep the palette tight (2-5 colours typically). Put one clear focal',
    'element. Maximise contrast between text/symbol and the field behind it.',
    'heightFrac for a headline is usually 0.4-0.7; scaleFrac for a hero symbol',
    '0.6-0.9. Scope everything to the stand(s) the user names; use "all" only for',
    'stadium-wide stunts. Respect symmetry and a clear visual hierarchy.',
  ].join('\n');
}

function userMessage(prompt: string): string {
  return `Brief: ${prompt}\n\nReturn the TifoSpec JSON now.`;
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

/**
 * Ask the configured model for a TifoSpec. Returns the parsed (UNvalidated) JSON,
 * or null if no provider is configured or the call/parsing fails — the caller
 * always validates and falls back to the offline designer.
 */
export async function generateSpecViaProvider(prompt: string): Promise<unknown | null> {
  const provider = activeProvider();
  if (provider === 'none') return null;
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 20000);
  const system = buildSystemPrompt();
  try {
    if (provider === 'anthropic') {
      const res = await postJson(
        'https://api.anthropic.com/v1/messages',
        {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        {
          model: process.env.AI_MODEL ?? 'claude-3-5-sonnet-latest',
          max_tokens: 1500,
          system,
          messages: [{ role: 'user', content: userMessage(prompt) }],
        },
        timeoutMs,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      return extractJson(data.content?.[0]?.text ?? '');
    }
    if (provider === 'gemini') {
      const model = process.env.AI_MODEL ?? 'gemini-2.5-flash';
      const res = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey()!}`,
        { 'content-type': 'application/json' },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userMessage(prompt) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 2048 },
        },
        timeoutMs,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
    }
    // openai
    const res = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY!}` },
      {
        model: process.env.AI_MODEL ?? 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage(prompt) },
        ],
      },
      timeoutMs,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return extractJson(data.choices?.[0]?.message?.content ?? '');
  } catch {
    return null; // network/timeout/parse → fall back to offline
  }
}
