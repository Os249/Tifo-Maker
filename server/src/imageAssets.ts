/**
 * Server-side image generation for the AI Tifo Designer (Phase 5).
 *
 * Provider-agnostic. Defaults to Pollinations.ai (FLUX, cheap, paid from a pollen
 * balance with AI_POLLINATIONS_KEY). The backup is Cloudflare Workers AI when
 * its account id and token are set: the same FLUX.1 [schnell] model, free for
 * about 170 pictures a day. Gemini's image model (higher quality, more per
 * picture, and no free quota at all) is the backup only when Cloudflare is not
 * set up, and the main one with AI_IMAGE_PROVIDER=gemini.
 *
 * Robust + best-effort: one retry on transient 429/503, then the BACKUP provider
 * (AI_IMAGE_FALLBACK names it, or a list; "none" turns it off). A
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

export type ImageProvider = 'pollinations' | 'cloudflare' | 'gemini' | 'none';

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
  /** The model that drew it (e.g. "flux", "gemini-2.5-flash-image"), for the cost panel. */
  model?: string;
}

/** The model each picture provider is asked for. */
export function pictureModel(p: PictureProvider): string {
  if (p === 'gemini') return process.env.AI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  if (p === 'cloudflare') return cloudflareModel();
  return process.env.AI_POLLINATIONS_MODEL || 'flux';
}

/**
 * The Workers AI model. FLUX.1 [schnell] by default: the model Pollinations'
 * "flux" runs, so a picture from the backup looks like one from the main
 * provider, and at about 58 neurons a picture the free 10,000 a day go a long
 * way. Anything that is not a plain @cf/ id is ignored, since it lands in the
 * request path.
 */
const CLOUDFLARE_DEFAULT_MODEL = '@cf/black-forest-labs/flux-1-schnell';
function cloudflareModel(): string {
  const v = process.env.AI_CLOUDFLARE_IMAGE_MODEL?.trim();
  return v && /^@cf\/[\w-][\w.-]*\/[\w-][\w.-]*$/.test(v) ? v : CLOUDFLARE_DEFAULT_MODEL;
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

/** Cloudflare needs both the account id (32 hex characters) and an API token. */
function cloudflareCreds(): { account: string; token: string } | null {
  const account = process.env.AI_CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const token = process.env.AI_CLOUDFLARE_API_TOKEN?.trim() ?? '';
  return /^[a-f0-9]{32}$/i.test(account) && token ? { account, token } : null;
}

const keyed = (p: PictureProvider): boolean =>
  p === 'gemini' ? !!geminiKey() : p === 'cloudflare' ? !!cloudflareCreds() : !!pollinationsKey();

/** Pollinations by default (needs AI_POLLINATIONS_KEY). Gemini or Cloudflare only if forced + keyed. */
export function activeImageProvider(): ImageProvider {
  const forced = (process.env.AI_IMAGE_PROVIDER ?? '').toLowerCase();
  if (forced === 'none') return 'none';
  if (forced === 'gemini') return geminiKey() ? 'gemini' : 'none';
  if (forced === 'cloudflare') return cloudflareCreds() ? 'cloudflare' : 'none';
  return 'pollinations';
}

/**
 * The providers tried, in order, when the main one cannot deliver.
 *
 * AI_IMAGE_FALLBACK:
 *   unset / auto   Cloudflare when it is set up (free), otherwise the other
 *                  keyed provider (Gemini behind Pollinations, as before)
 *   a name or a comma list (cloudflare,gemini)   those, in that order, each
 *                  only if its key is set and it is not the main
 *   none           no backup
 *
 * On by default because the alternative is worse: on 28 Sep 2026 the
 * Pollinations credit ran out and every Super AI design shipped with a bare
 * stand while a working Gemini key sat unused in the same environment. Gemini
 * has no free picture quota, so "auto" no longer reaches for it once a free
 * backup exists: a project without billing would only fail, pause and email.
 */
const PICTURE_PROVIDERS: PictureProvider[] = ['pollinations', 'cloudflare', 'gemini'];

export function fallbackImageProviders(): PictureProvider[] {
  // "none" means no pictures at all, not "no main provider".
  if ((process.env.AI_IMAGE_PROVIDER ?? '').trim().toLowerCase() === 'none') return [];
  const main = activeImageProvider();
  const pref = (process.env.AI_IMAGE_FALLBACK ?? 'auto').trim().toLowerCase();
  if (pref === 'none' || pref === 'off' || pref === 'false') return [];
  const usable = (p: PictureProvider): boolean => p !== main && keyed(p);
  // Names it knows, in the order given. A value with none ("on", "yes", a
  // typo) is read as "auto": a misspelt setting must not quietly switch off
  // the backup (the boot report names the unknown word).
  const named = pref.split(/[\s,]+/).filter((p): p is PictureProvider => (PICTURE_PROVIDERS as string[]).includes(p));
  if (named.length) return [...new Set(named)].filter(usable);
  // auto: the cheapest provider that can answer. Cloudflare is free; Gemini,
  // with no free picture quota, comes last.
  const first = (['cloudflare', 'pollinations', 'gemini'] as PictureProvider[]).find(usable);
  return first ? [first] : [];
}

/** The first backup, or null. */
export function fallbackImageProvider(): PictureProvider | null {
  return fallbackImageProviders()[0] ?? null;
}

/**
 * The providers to try, in order. AI_IMAGE_PROVIDER=gemini without a key
 * resolves to "none" as the main, which the backup can still cover.
 */
export function imageProviderChain(): PictureProvider[] {
  const main = activeImageProvider();
  const chain: PictureProvider[] = [];
  if (main !== 'none') chain.push(main);
  for (const b of fallbackImageProviders()) if (!chain.includes(b)) chain.push(b);
  return chain;
}

export function imageGenAvailable(): boolean {
  return imageProviderChain().length > 0;
}

/** What /admin → AI → Pictures shows. */
export function picturesStatus(): ReturnType<typeof imageHealth.snapshot> {
  const main = activeImageProvider();
  return imageHealth.snapshot(main === 'none' ? null : main, fallbackImageProviders());
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
  const model = pictureModel('pollinations');
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
  const model = pictureModel('gemini');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    if (withAspect && style.aspect) generationConfig.imageConfig = { aspectRatio: geminiAspect(style.aspect) };
    const res = await fetch(
      // The key in a header, as Google documents it, not in the URL.
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
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
 * Cloudflare Workers AI, FLUX.1 [schnell]. Free up to 10,000 neurons a day on
 * any Cloudflare account (about 170 of these pictures); past that it answers
 * 429 "used up your daily free allocation" until 00:00 UTC, which the health
 * tracker reads as "out of credit" and pauses. JSON in, base64 JPEG out.
 *
 * The model takes no width or height: it always draws a square. The prompt
 * still carries the region's shape (mosaicStyle), and the client fits the
 * picture to the stand. The prompt is capped at 2,048 characters; the
 * subject is kept whole and the style suffix is what gets shortened.
 */
async function callCloudflare(prompt: string, timeoutMs: number, style: ImageStyle): Promise<Attempt> {
  const creds = cloudflareCreds();
  if (!creds) return { url: null, error: 'cloudflare needs AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN' };
  const model = cloudflareModel();
  const text = (prompt.slice(0, 600) + mosaicStyle(style)).slice(0, 2048);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.account}/ai/run/${model}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.token}` },
      body: JSON.stringify({ prompt: text, steps: envNum('AI_CLOUDFLARE_STEPS', 4, 1, 8) }),
      signal: ctrl.signal,
    });
    // Some Workers AI image models answer with the picture's bytes rather
    // than JSON; take either.
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && /^image\//i.test(type)) {
      const ab = await res.arrayBuffer();
      if (ab.byteLength < 128) return { url: null, error: 'cloudflare returned an empty image' };
      return { url: `data:${type.split(';')[0]};base64,${Buffer.from(ab).toString('base64')}` };
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const body = raw.slice(0, 160).replace(/\s+/g, ' ').trim();
      return { url: null, status: res.status, error: `cloudflare: HTTP ${res.status}${body ? `: ${body}` : ''}` };
    }
    let data: { result?: { image?: string }; image?: string; success?: boolean; errors?: Array<{ message?: string }> } = {};
    try { data = JSON.parse(raw); } catch { /* not JSON */ }
    const image = data.result?.image ?? data.image;
    if (data.success === false || !image) {
      const why = data.errors?.map((e) => e?.message).filter(Boolean).join('; ');
      return { url: null, error: `cloudflare returned no image${why ? `: ${why.slice(0, 160)}` : ''}` };
    }
    if (image.length < 128) return { url: null, error: 'cloudflare returned an empty image' };
    return { url: `data:image/jpeg;base64,${image}` };
  } catch (e) {
    return { url: null, error: `cloudflare: ${(e as Error)?.name === 'AbortError' ? 'request timed out' : 'network error'}` };
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
      : 'no image provider has a key (AI_POLLINATIONS_KEY, AI_CLOUDFLARE_API_TOKEN or GEMINI_API_KEY)' };
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
    const call = p === 'gemini' ? callGemini : p === 'cloudflare' ? callCloudflare : callPollinations;
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
      imageHealth.finish({ deliveredBy: p, main, backup, backups: chain.slice(1), problems, breakerMs });
      return { url: r.url, provider: p, viaBackup, model: pictureModel(p) };
    }
    lastKind = imageHealth.recordFailure(p, r.status, r.error, breakerMs);
    const detail = r.error ?? 'unknown error';
    problems.push({ provider: p, kind: lastKind, detail });
    errors.push(detail);
  }
  const error = errors.join('; then ');
  imageHealth.finish({ deliveredBy: null, main, backup, backups: chain.slice(1), problems, breakerMs, lastError: error });
  return { url: null, error, kind: lastKind };
}
