/**
 * Server-side image generation for the AI Tifo Designer (Phase 5).
 *
 * When the planning model decides a tifo needs a portrait / figure / detailed
 * artwork, it emits an `image` layer describing the subject. This module turns
 * that description into an actual picture using Google's Gemini image model
 * ("Nano Banana"), returned as a data URL. The client then renders it onto seats
 * through the existing image-import quantizer (so it shades with the palette).
 *
 * Best-effort by design: if no key is set, the model is unavailable, or the call
 * fails (e.g. free-tier image limits), it returns null and the caller simply
 * drops the image layer — the rest of the tifo still renders.
 */

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

/** True when image generation can be attempted (a key is configured). */
export function imageGenAvailable(): boolean {
  return !!geminiKey();
}

/**
 * Generate one image for a subject description. Returns a `data:image/...;base64`
 * URL, or null on any failure (caller treats null as "skip this layer").
 */
export async function generateImage(prompt: string): Promise<string | null> {
  const key = geminiKey();
  if (!key) return null;
  const model = process.env.AI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  const timeoutMs = Number(process.env.AI_IMAGE_TIMEOUT_MS ?? 30000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    `${prompt}. A bold, high-contrast graphic poster designed for a giant stadium card mosaic: ` +
                    'strong clear silhouette, simple flat background, subject centered and filling the frame, ' +
                    'few distinct tones (no fine gradients or small detail), square composition.',
                },
              ],
            },
          ],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    };
    for (const part of data.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch {
    return null; // network/timeout/unavailable → skip the image layer
  } finally {
    clearTimeout(timer);
  }
}
