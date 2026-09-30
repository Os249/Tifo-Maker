/**
 * Server-side image generation for the AI Tifo Designer (Phase 5).
 *
 * Provider-agnostic. Defaults to Pollinations.ai (FLUX, cheap, paid from a pollen
 * balance with AI_POLLINATIONS_KEY). Gemini's image model (higher quality, more
 * per picture) is the main one with AI_IMAGE_PROVIDER=gemini, and the backup by
 * default whenever GEMINI_API_KEY is set.
 *
 * Robust + best-effort: one retry on transient 429/503, then the BACKUP provider
 * (the other one, when it has a key; AI_IMAGE_FALLBACK=none turns that off). A
 * provider that is out of credit or has its key refused is paused for a few
 * minutes so every picture does not pay a doomed round trip first, and the
 * operator is emailed (imageHealth.ts). When nothing produces a picture, the
 * reason goes back to the caller, which drops the image layer so the rest of the
 * tifo still renders.
 *
 * The picture is quantized to the DESIGN'S palette client-side, which is why
 * every request now carries an ImageStyle: a generator told nothing returns a
 * square in colours of its own choosing, and the quantizer then has to force
 * that into the club's two colours — the single biggest source of mush in an AI
 * tifo. Given the region's shape and the palette up front, the same quantizer is
 * nearly lossless.
 */

import { envNum } from './env';
import { classifyImageFailure, imageHealth, type ImageFailureKind, type PictureProvider } from './imageHealth';

export type ImageProvider = 'pollinations' | 'gemini' | 'none';

/**
 * What the picture has to fit into. Before this existed the generator was told
 * nothing: every prompt got the same "square 1:1, a small number of flat tones"
 * suffix, so a hero destined for a 2.4:1 stand arrived square and was generated
 * in whatever colours the model felt like — then the client quantized it to the
 * design's palette, which is where the mush came from.
 */
export interface ImageStyle {
  /** Aspect (width / height) of the region the picture will fill. 1 = square. */
  aspect?: number;
  /** The design palette the picture is quantized to. Index 0 is the empty seat. */
  palette?: string[];
  /** Rows of seats the picture will actually be drawn with. ~52 for one stand. */
  rows?: number;
}

export interface ImageResult {
  url: string | null;
  /** Human-readable reason when url is null (surfaced to the UI for debugging). */
  error?: string;
  /** Which provider made the picture. */
  provider?: PictureProvider;
  /** True when the main provider could not and the backup did. */
  viaBackup?: boolean;
  /** When url is null: what kind of failure the last provider tried reported. */
  kind?: ImageFailureKind;
}

// ---- describing the target to a diffusion model ----

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const HUES: Array<[number, string]> = [
  [15, 'red'], [35, 'orange'], [50, 'gold'], [68, 'yellow'], [95, 'lime'],
  [152, 'green'], [178, 'teal'], [198, 'cyan'], [212, 'azure'], [255, 'blue'],
  [275, 'indigo'], [292, 'violet'], [320, 'magenta'], [342, 'pink'], [360, 'red'],
];

/**
 * A plain-English name for a hex colour.
 *
 * Image models follow "deep crimson" far more reliably than "#8B0000", and the
 * whole point is that the picture arrives already close to the palette it is
 * about to be quantized into — a portrait generated in the club's own two
 * colours survives quantization almost losslessly; one generated in arbitrary
 * skin tones does not.
 */
export function colourName(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'grey';
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  // A colour this dark or this light has no hue an image model can act on:
  // #101820 is a navy on paper and black on a seat, and calling it "sky blue"
  // sends the generator somewhere the design never goes.
  if (l < 0.1) return 'black';
  if (l > 0.93) return 'white';
  if (sat < 0.12) {
    if (l < 0.35) return 'charcoal';
    if (l < 0.62) return 'grey';
    if (l < 0.88) return 'light grey';
    return 'white';
  }
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const base = HUES.find(([bound]) => h <= bound)?.[1] ?? 'red';
  const shade = l < 0.22 ? 'very dark ' : l < 0.42 ? 'deep ' : l > 0.82 ? 'pale ' : l > 0.66 ? 'light ' : '';
  // One modifier, never two — "near-black muted sky blue" is not a colour anyone
  // can picture, and a prompt full of qualifiers reads as noise.
  const muted = !shade && sat < 0.35 ? 'muted ' : '';
  return `${shade}${muted}${base}`.trim();
}

/** Up to `max` colour names spread evenly across the paint palette (index 0 is empty). */
function paletteNames(palette: string[], max: number): string[] {
  const paint = palette.slice(1).filter((c) => typeof c === 'string' && c.trim());
  if (paint.length === 0) return [];
  const step = paint.length <= max ? 1 : paint.length / max;
  const out: string[] = [];
  for (let i = 0; i < paint.length && out.length < max; i += step) {
    const n = colourName(paint[Math.floor(i)]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function shapeWord(aspect: number): string {
  if (aspect >= 2.6) return 'an extremely wide banner, far wider than it is tall';
  if (aspect >= 1.7) return 'a wide landscape banner';
  if (aspect >= 1.15) return 'a landscape panel';
  if (aspect > 0.85) return 'a square panel';
  return 'a tall upright panel';
}

/**
 * The style suffix appended to the designer's prompt.
 *
 * Every clause here is doing a job the old one-line constant was not:
 * - the SHAPE, so a stand-shaped hero is composed for a stand, not cropped from
 *   a square;
 * - the PALETTE by name, so quantization is nearly lossless instead of
 *   destructive;
 * - a tone COUNT and what to spend it on, because the design can now carry up to
 *   24 colours and flat-poster shading is what reads at seat scale;
 * - the negatives (gradients, blur, photographic detail, text) — each one is a
 *   thing that survives quantization badly or duplicates lettering the renderer
 *   draws far more sharply itself.
 */
export function mosaicStyle(style: ImageStyle = {}): string {
  const aspect = Math.max(0.5, Math.min(4, style.aspect ?? 1));
  const palette = style.palette ?? [];
  const names = paletteNames(palette, 8);
  const tones = Math.max(3, Math.min(12, Math.max(palette.length - 1, 4)));
  const colour = names.length
    ? `Use this exact colour palette and nothing else: ${names.join(', ')}.`
    : 'Use a small set of bold, saturated flat colours.';
  // The number that governs everything. A hero on one stand is redrawn with
  // about 52 ROWS of cards — a person per card — so the composition, not the
  // rendering, decides whether it reads. A full-length figure spends 40 of
  // those rows on a body and leaves a dozen for the face.
  const rows = Math.max(8, Math.round(style.rows ?? 52));
  return [
    '. Screen-printed poster art for a giant stadium card mosaic, where every',
    'pixel becomes one coloured card held up by one person. The finished picture',
    `is redrawn with only about ${rows} ROWS of cards from top to bottom, so it`,
    'must survive being reduced to that: build it from a few big, flat, clearly',
    'separated shapes and nothing that depends on fine detail.',
    `Shape: ${shapeWord(aspect)}.`,
    'CROP IN CLOSE. One subject, filling the frame from top edge to bottom edge',
    'with almost no margin. For a person, that means a TIGHT head-and-shoulders',
    'crop — the head alone spanning nearly the full height, cropped at the',
    'shoulders. Never a full-length or waist-up figure: at this size the face',
    'would be a handful of rows and read as a smudge.',
    'Unmistakable silhouette. The background is ONE FLAT COLOUR, completely plain,',
    'and CLEARLY DIFFERENT IN BRIGHTNESS from every edge of the subject — it gets',
    'flood-filled away so the stadium design shows through, and a subject whose',
    'outline matches its backdrop loses that edge with it. Dark subject on a light',
    'field, or light subject on a dark one. No scenery, no floor, no shadow on the',
    'background, nothing touching the subject.',
    colour,
    `Build the form from about ${tones} FLAT hard-edged tones — deep shadow,`,
    'midtone, light, bright highlight — like a screen print with posterised',
    'banding, each tone a big connected area rather than speckles. No gradients,',
    'no soft focus, no blur, no photographic texture, no drop shadows, no fine',
    'lines. No text, letters, numbers, logos, signatures or watermarks anywhere.',
  ].join(' ');
}

/** Pixel dimensions for the requested shape, at roughly 1.2MP. */
export function pollinationsSize(aspect: number): { width: number; height: number } {
  const a = Math.max(0.5, Math.min(4, aspect));
  const MAX_SIDE = 1536;
  const MIN_SIDE = 384;
  let h = Math.sqrt(1_200_000 / a);
  let w = h * a;
  const big = Math.max(w, h);
  if (big > MAX_SIDE) { w *= MAX_SIDE / big; h *= MAX_SIDE / big; }
  const small = Math.min(w, h);
  if (small < MIN_SIDE) { w *= MIN_SIDE / small; h *= MIN_SIDE / small; }
  const snap = (n: number): number => Math.max(256, Math.min(1536, Math.round(n / 64) * 64));
  return { width: snap(w), height: snap(h) };
}

/** Aspect ratios the Gemini image models accept, as label → value. */
const GEMINI_RATIOS: Array<[string, number]> = [
  ['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5], ['1:1', 1],
  ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['21:9', 21 / 9],
];

/** Nearest supported Gemini ratio (nearest in log space, so 2:1 picks 16:9 not 3:2). */
export function geminiAspect(aspect: number): string {
  const a = Math.max(0.5, Math.min(4, aspect));
  let best = GEMINI_RATIOS[0];
  for (const r of GEMINI_RATIOS) {
    if (Math.abs(Math.log(r[1] / a)) < Math.abs(Math.log(best[1] / a))) best = r;
  }
  return best[0];
}


function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

function pollinationsKey(): string | undefined {
  return process.env.AI_POLLINATIONS_KEY || process.env.POLLINATIONS_KEY || undefined;
}

/** Pollinations by default (needs AI_POLLINATIONS_KEY). Gemini only if forced + keyed. */
export function activeImageProvider(): ImageProvider {
  const forced = (process.env.AI_IMAGE_PROVIDER ?? '').toLowerCase();
  if (forced === 'none') return 'none';
  if (forced === 'gemini') return geminiKey() ? 'gemini' : 'none';
  return 'pollinations';
}

/**
 * The provider tried when the main one cannot deliver.
 *
 * AI_IMAGE_FALLBACK:
 *   unset / auto   the other provider, if its key is set
 *   gemini | pollinations   that one, if its key is set (and it is not the main)
 *   none           no backup
 *
 * On by default because the alternative is worse: on 28 Sep 2026 the
 * Pollinations credit ran out and every Super AI design shipped with a bare
 * stand while a working Gemini key sat unused in the same environment. Gemini
 * pictures cost more, so the backup only runs when the main provider fails,
 * and the operator is emailed when it starts doing so.
 */
export function fallbackImageProvider(): PictureProvider | null {
  // "none" means no pictures at all, not "no main provider".
  if ((process.env.AI_IMAGE_PROVIDER ?? '').trim().toLowerCase() === 'none') return null;
  const main = activeImageProvider();
  const pref = (process.env.AI_IMAGE_FALLBACK ?? 'auto').trim().toLowerCase();
  if (pref === 'none' || pref === 'off' || pref === 'false') return null;
  const keyed = (p: PictureProvider): boolean => (p === 'gemini' ? !!geminiKey() : !!pollinationsKey());
  const pick = (p: PictureProvider): PictureProvider | null => (p !== main && keyed(p) ? p : null);
  if (pref === 'gemini' || pref === 'pollinations') return pick(pref);
  return pick(main === 'gemini' ? 'pollinations' : 'gemini');
}

/**
 * The providers to try, in order. AI_IMAGE_PROVIDER=gemini without a key
 * resolves to "none" as the main, which the backup can still cover.
 */
export function imageProviderChain(): PictureProvider[] {
  const main = activeImageProvider();
  const backup = fallbackImageProvider();
  const chain: PictureProvider[] = [];
  if (main !== 'none') chain.push(main);
  if (backup && !chain.includes(backup)) chain.push(backup);
  return chain;
}

export function imageGenAvailable(): boolean {
  return imageProviderChain().length > 0;
}

/** What /admin → AI → Pictures shows. */
export function picturesStatus(): ReturnType<typeof imageHealth.snapshot> {
  const main = activeImageProvider();
  return imageHealth.snapshot(main === 'none' ? null : main, fallbackImageProvider());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Attempt {
  url: string | null;
  error?: string;
  status?: number;
}

/**
 * Pollinations.ai, FLUX. Paid per picture from the account's pollen balance
 * (about 0.002 pollen each), with a key from enter.pollinations.ai. Prompt goes
 * in the URL path; returns image bytes.
 */
async function callPollinations(prompt: string, timeoutMs: number, style: ImageStyle): Promise<Attempt> {
  const key = pollinationsKey();
  if (!key) {
    return { url: null, error: 'pollinations needs a key, create one at enter.pollinations.ai and set AI_POLLINATIONS_KEY' };
  }
  const base = process.env.AI_POLLINATIONS_URL || 'https://gen.pollinations.ai/image/';
  const model = process.env.AI_POLLINATIONS_MODEL || 'flux';
  // Was hard-coded 768x768 for every request, whatever shape it had to fill.
  const { width, height } = pollinationsSize(style.aspect ?? 1);
  const url = `${base}${encodeURIComponent(prompt + mosaicStyle(style))}?width=${width}&height=${height}&model=${encodeURIComponent(model)}&nologo=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ').trim(); } catch { /* ignore */ }
      return { url: null, status: res.status, error: `pollinations: HTTP ${res.status}${body ? `: ${body}` : ''}` };
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength < 128) return { url: null, error: 'pollinations returned an empty image' };
    const mime = res.headers.get('content-type') || 'image/jpeg';
    return { url: `data:${mime};base64,${Buffer.from(ab).toString('base64')}` };
  } catch (e) {
    return { url: null, error: `pollinations: ${(e as Error)?.name === 'AbortError' ? 'request timed out' : 'network error'}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Google Gemini image model ("Nano Banana") — PAID tier. */
async function callGemini(prompt: string, timeoutMs: number, style: ImageStyle, withAspect = true): Promise<Attempt> {
  const key = geminiKey();
  if (!key) return { url: null, error: 'no GEMINI_API_KEY configured' };
  const model = process.env.AI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    if (withAspect && style.aspect) generationConfig.imageConfig = { aspectRatio: geminiAspect(style.aspect) };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt + mosaicStyle(style) }] }],
          generationConfig,
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ').trim(); } catch { /* ignore */ }
      // Older image models reject imageConfig outright. Losing the aspect is far
      // better than losing the picture, so drop it once and try again.
      if (withAspect && res.status === 400 && /imageConfig|aspectRatio|aspect_ratio/i.test(body)) {
        clearTimeout(timer);
        return callGemini(prompt, timeoutMs, style, false);
      }
      return { url: null, status: res.status, error: `image model "${model}": HTTP ${res.status}${body ? `: ${body}` : ''}` };
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    };
    for (const part of data.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) return { url: `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}` };
    }
    return { url: null, error: `image model "${model}" returned no image` };
  } catch (e) {
    return { url: null, error: `image model "${model}": ${(e as Error)?.name === 'AbortError' ? 'request timed out' : 'network error'}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate one image: the main provider, then the backup.
 *
 * Each provider gets one retry on a busy answer (429/503) that is not a credit
 * problem. A provider the breaker has paused (out of credit, key refused) goes
 * to the back of the queue: it is not asked while another provider delivers,
 * and it is still asked when none did, so a top-up heals the very next picture
 * rather than ten minutes later.
 */
export async function generateImage(prompt: string, style: ImageStyle = {}): Promise<ImageResult> {
  const chain = imageProviderChain();
  if (chain.length === 0) {
    return { url: null, kind: 'other', error: (process.env.AI_IMAGE_PROVIDER ?? '').toLowerCase() === 'none'
      ? 'image generation disabled (AI_IMAGE_PROVIDER=none)'
      : 'no image provider has a key (AI_POLLINATIONS_KEY or GEMINI_API_KEY)' };
  }
  const timeoutMs = envNum('AI_IMAGE_TIMEOUT_MS', 45000, 1000);
  const breakerMs = envNum('AI_IMAGE_BREAKER_MS', 10 * 60_000, 0);
  const retryMs = envNum('AI_IMAGE_RETRY_MS', 1500, 0);
  const main = chain[0];
  const backup = chain[1] ?? null;
  // Paused providers go last: skipped while another can deliver, still asked
  // when nothing else did, so a top-up heals on the next picture.
  const order = [...chain.filter((p) => !imageHealth.isPaused(p)), ...chain.filter((p) => imageHealth.isPaused(p))];

  const started = Date.now();
  const problems: { provider: PictureProvider; kind: ImageFailureKind; detail: string }[] = [];
  const errors: string[] = [];
  let lastKind: ImageFailureKind = 'other';
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    // The backup gets what is left of the budget, but never less than 15 s:
    // a main provider that timed out must not leave the backup no time at all.
    const budget = i === 0 ? timeoutMs : Math.max(Math.min(15_000, timeoutMs), timeoutMs - (Date.now() - started));
    const call = p === 'gemini' ? callGemini : callPollinations;
    let r = await call(prompt, budget, style);
    // A busy answer is worth one more try; a 429 that really means "no credit"
    // (Gemini without billing says limit: 0) will not pass in 1.5 s.
    if (!r.url && (r.status === 429 || r.status === 503) && ['rate', 'down'].includes(classifyImageFailure(r.status, r.error))) {
      await sleep(retryMs);
      r = await call(prompt, budget, style);
    }
    if (r.url) {
      const viaBackup = p !== main;
      imageHealth.recordOk(p, viaBackup);
      imageHealth.finish({ deliveredBy: p, main, backup, problems, breakerMs });
      return { url: r.url, provider: p, viaBackup };
    }
    lastKind = imageHealth.recordFailure(p, r.status, r.error, breakerMs);
    const detail = r.error ?? 'unknown error';
    problems.push({ provider: p, kind: lastKind, detail });
    errors.push(detail);
  }
  const error = errors.join('; then ');
  imageHealth.finish({ deliveredBy: null, main, backup, problems, breakerMs, lastError: error });
  return { url: null, error, kind: lastKind };
}
