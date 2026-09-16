/**
 * What the deployment has not been told.
 *
 * Every line here is something the code has a safe default for, which is exactly
 * why it is worth printing: a safe default is silent, and a silent default that
 * is not what the operator intended can go unnoticed for months. Two of these
 * were sitting in the security audit's "still worth doing" list as things to set
 * in Railway, where they have stayed unset because nothing ever said so out loud.
 *
 * Pure, so a test can assert the wording without booting a server.
 */

export interface ConfigWarning {
  key: string;
  /** What is happening right now, in the absence of the setting. */
  effect: string;
}

export function configWarnings(env: NodeJS.ProcessEnv): ConfigWarning[] {
  const out: ConfigWarning[] = [];
  const prod = env.NODE_ENV === 'production';

  if (prod && !env.TRUST_PROXY) {
    out.push({
      key: 'TRUST_PROXY',
      effect: 'assuming one proxy hop. Right for Railway alone; with Cloudflare in front set TRUST_PROXY=2, or every rate limit sees Cloudflare\'s address instead of the caller\'s.',
    });
  }
  if (prod && !env.PUBLIC_URL) {
    out.push({
      key: 'PUBLIC_URL',
      effect: 'password-reset links fall back to matching the Host header against a known list. Set PUBLIC_URL=https://tifomaker.org so the link never depends on what a caller sent.',
    });
  }
  if (!env.AI_ADMIN_PASSWORD) {
    out.push({ key: 'AI_ADMIN_PASSWORD', effect: '/admin cannot be unlocked at all, and the AI designer has no admin bypass.' });
  }

  // The one that fails silently in the OUTPUT rather than at boot: a portrait
  // layer with no image provider returns { url: null } and the design ships with
  // the face missing and a note, which looks like a model that had a bad day.
  const img = (env.AI_IMAGE_PROVIDER ?? '').toLowerCase();
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (img === 'none') {
    out.push({ key: 'AI_IMAGE_PROVIDER', effect: 'set to "none": every AI design with a portrait will ship with the face missing.' });
  } else if (img === 'gemini' && !geminiKey) {
    out.push({
      key: 'AI_IMAGE_PROVIDER',
      effect: 'set to "gemini" with no GEMINI_API_KEY or GOOGLE_API_KEY, which silently means "none" — every AI design with a portrait ships with the face missing.',
    });
  }

  return out;
}

/** Print them, once, at boot. Nothing here should ever stop the server. */
export function logConfigWarnings(env: NodeJS.ProcessEnv = process.env, log = console.warn): void {
  for (const w of configWarnings(env)) log(`[tifo] ${w.key} is not set: ${w.effect}`);
}
