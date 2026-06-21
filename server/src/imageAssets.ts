/**
 * Server-side image generation for the AI Tifo Designer (Phase 5).
 *
 * Provider-agnostic. Defaults to Pollinations.ai — FREE, no API key, FLUX-based —
 * so portraits work at zero cost during the MVP. Switch to Gemini's paid image
 * model (higher quality) later with AI_IMAGE_PROVIDER=gemini.
 *
 * Robust + best-effort: one retry on transient 429/503; on any other failure it
 * returns the reason (surfaced in the UI) and the caller drops the image layer so
 * the rest of the tifo still renders. The picture is quantized to the palette
 * client-side, so modest source quality is fine at seat scale.
 */

const MOSAIC_STYLE =
  '. A bold, high-contrast graphic poster for a giant stadium card mosaic: a single ' +
  'clear subject centered and filling the frame, strong silhouette, flat simple ' +
  'background, a small number of distinct flat tones, no text or letters, square 1:1.';

export type ImageProvider = 'pollinations' | 'gemini' | 'none';

export interface ImageResult {
  url: string | null;
  /** Human-readable reason when url is null (surfaced to the UI for debugging). */
  error?: string;
}

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

/** Free Pollinations by default (no key, no cost). Gemini only if forced + keyed. */
export function activeImageProvider(): ImageProvider {
  const forced = (process.env.AI_IMAGE_PROVIDER ?? '').toLowerCase();
  if (forced === 'none') return 'none';
  if (forced === 'gemini') return geminiKey() ? 'gemini' : 'none';
  return 'pollinations';
}

export function imageGenAvailable(): boolean {
  return activeImageProvider() !== 'none';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Attempt {
  url: string | null;
  error?: string;
  status?: number;
}

/** Pollinations.ai — free, no key. Prompt goes in the URL path; returns image bytes. */
async function callPollinations(prompt: string, timeoutMs: number): Promise<Attempt> {
  const key = process.env.AI_POLLINATIONS_KEY || process.env.POLLINATIONS_KEY;
  if (!key) {
    return { url: null, error: 'pollinations needs a free key — create one at enter.pollinations.ai and set AI_POLLINATIONS_KEY' };
  }
  const base = process.env.AI_POLLINATIONS_URL || 'https://gen.pollinations.ai/image/';
  const model = process.env.AI_POLLINATIONS_MODEL || 'flux';
  const url = `${base}${encodeURIComponent(prompt + MOSAIC_STYLE)}?width=768&height=768&model=${encodeURIComponent(model)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ').trim(); } catch { /* ignore */ }
      return { url: null, status: res.status, error: `pollinations: HTTP ${res.status}${body ? ` — ${body}` : ''}` };
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
async function callGemini(prompt: string, timeoutMs: number): Promise<Attempt> {
  const key = geminiKey();
  if (!key) return { url: null, error: 'no GEMINI_API_KEY configured' };
  const model = process.env.AI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt + MOSAIC_STYLE }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 160).replace(/\s+/g, ' ').trim(); } catch { /* ignore */ }
      return { url: null, status: res.status, error: `image model "${model}": HTTP ${res.status}${body ? ` — ${body}` : ''}` };
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

/** Generate one image (free Pollinations by default), one retry on rate limits. */
export async function generateImage(prompt: string): Promise<ImageResult> {
  const provider = activeImageProvider();
  if (provider === 'none') return { url: null, error: 'image generation disabled (AI_IMAGE_PROVIDER=none)' };
  const timeoutMs = Number(process.env.AI_IMAGE_TIMEOUT_MS ?? 45000);
  const call = provider === 'gemini' ? callGemini : callPollinations;
  let r = await call(prompt, timeoutMs);
  if (!r.url && (r.status === 429 || r.status === 503)) {
    await sleep(1500);
    r = await call(prompt, timeoutMs);
  }
  return { url: r.url, error: r.error };
}
