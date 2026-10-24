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
import { DEFAULT_FROM, isNoReplyAddress } from './email';

export interface ConfigWarning {
  key: string;
  /** What is happening right now, in the absence of the setting. */
  effect: string;
  /** How the boot line reads. Most of these are unset; EMAIL_FROM can be set and wrong. */
  state?: 'unset' | 'wrong';
}

export function configWarnings(env: NodeJS.ProcessEnv): ConfigWarning[] {
  const out: ConfigWarning[] = [];
  const prod = env.NODE_ENV === 'production';

  const tp = env.TRUST_PROXY?.trim().toLowerCase();
  if (prod && !tp) {
    out.push({
      key: 'TRUST_PROXY',
      effect: 'assuming one proxy hop. Right for Railway alone; with Cloudflare in front set TRUST_PROXY=cloudflare, or every rate limit sees Cloudflare\'s address instead of the caller\'s.',
    });
  }
  // A plain count above one trusts the extra hop whoever wrote it. Cloudflare
  // does not stop anyone connecting to Railway directly, so a request that skips
  // it chooses its own address and walks past every per-IP limit.
  if (tp && !/^\d+$/.test(tp) && tp !== 'cloudflare') {
    out.push({
      key: 'TRUST_PROXY',
      effect: `set to "${env.TRUST_PROXY}", which is not a value this server knows. It is using one proxy hop (Railway alone). The values are 0, 1 or cloudflare.`,
      state: 'wrong',
    });
  }
  if (tp && /^\d+$/.test(tp) && Number(tp) >= 2) {
    out.push({
      key: 'TRUST_PROXY',
      effect: `set to ${tp}: a request sent straight to Railway, skipping the proxy in front, can pick its own IP address and dodge every rate limit. Behind Cloudflare use TRUST_PROXY=cloudflare, which trusts the extra hop only when it really is Cloudflare.`,
      state: 'wrong',
    });
  }
  // Half a Google client is the worst state to be in: the button never appears
  // and nothing says why, because "no credentials" and "one credential" look
  // identical from the outside.
  const gid = env.GOOGLE_CLIENT_ID?.trim();
  const gsecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!!gid !== !!gsecret) {
    out.push({
      key: gid ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID',
      effect: 'is missing while the other half is set, so Sign in with Google is off and the button does not appear. Set both, or neither.',
      state: 'wrong',
    });
  }
  if (prod && !env.PUBLIC_URL) {
    out.push({
      key: 'PUBLIC_URL',
      effect: 'password-reset links fall back to matching the Host header against a known list. Set PUBLIC_URL=https://tifomaker.org so the link never depends on what a caller sent.',
    });
  }
  // The one that answers "verification emails stopped arriving". With no key
  // the server silently falls back to the console sender: every verification
  // and password-reset message is written to the log and delivered to nobody,
  // while the API still answers 201 and 202 and the UI still says "check your
  // inbox". Nothing else in the product reports it.
  if (prod && !env.RESEND_API_KEY) {
    out.push({
      key: 'RESEND_API_KEY',
      effect: 'NO EMAIL IS BEING SENT. Verification and password-reset messages are not delivered (this log records who each was for, not its code or link), and the app still tells people to check their inbox.',
    });
  }
  // Resend refuses any From on a domain you have not verified with it, and it
  // re-checks those DNS records — so a send can start failing with nothing
  // changed at this end. The default From is on tifomaker.org for that reason.
  if (prod && env.RESEND_API_KEY && env.EMAIL_FROM && !/@([\w-]+\.)*tifomaker\.org>?\s*$/i.test(env.EMAIL_FROM)) {
    out.push({
      key: 'EMAIL_FROM',
      effect: `sending as ${env.EMAIL_FROM}, which is not on tifomaker.org. Resend rejects any From whose domain is not verified in your account.`,
      state: 'wrong',
    });
  }
  // A no-reply sender is one of the few spam signals the operator sets by hand.
  // Resend's own deliverability checks flag it, and the verification email was
  // landing in Gmail's spam folder with authentication fully passing.
  const from = env.EMAIL_FROM?.trim() || DEFAULT_FROM;
  if (prod && env.RESEND_API_KEY && isNoReplyAddress(from)) {
    out.push({
      key: 'EMAIL_FROM',
      effect: `sending as ${from}. Mailbox providers trust a no-reply sender less and replies bounce. Use ${DEFAULT_FROM} (or delete EMAIL_FROM) and forward hello@ to a real inbox.`,
      state: 'wrong',
    });
  }
  if (!env.AI_ADMIN_PASSWORD) {
    out.push({ key: 'AI_ADMIN_PASSWORD', effect: '/admin cannot be unlocked at all, and the AI designer has no admin bypass.' });
  }
  // The Security tab records attacks either way; this is whether anyone hears
  // about one while it is happening rather than the next time they look.
  const alertTo = env.SECURITY_ALERT_TO?.trim();
  if (prod && !alertTo) {
    out.push({
      key: 'SECURITY_ALERT_TO',
      effect: 'attacks are recorded on /admin#security, but nobody is emailed when one starts. Set it to the address that should hear about them.',
    });
  } else if (alertTo && !/^[^\s@<>()[\],;:"\\?&#%]+@[^\s@<>()[\],;:"\\?&#%]+\.[^\s@<>()[\],;:"\\?&#%]+$/.test(alertTo)) {
    out.push({ key: 'SECURITY_ALERT_TO', effect: `"${alertTo.slice(0, 80)}" is not an email address, so security alerts cannot be sent.`, state: 'wrong' });
  }
  // A process-wide V8 heap size (P2.14). V8 lets its own flag override the
  // memory limit the scene and PDF workers are started with (resourceLimits),
  // so with this set a hostile scene or PDF could take the server's memory
  // rather than only its worker's: measured, a worker limited to 16 MB grew
  // past 1.2 GB under --max-old-space-size=8192.
  if (/--max-old-space-size|--max-semi-space-size|--max-heap-size/.test(env.NODE_OPTIONS ?? '')) {
    out.push({ key: 'NODE_OPTIONS', effect: 'sets a V8 heap size for the whole process, which overrides the memory limit of the scene and PDF worker threads. Remove it: the image sets none, and the server needs none.', state: 'wrong' });
  }
  // The origin lock (P2.2). The server refuses to start with a short one
  // (server.ts); said here too, so the reason is in the boot log.
  const originSecret = env.ORIGIN_SECRET?.trim();
  if (originSecret && originSecret.length < 32) {
    out.push({ key: 'ORIGIN_SECRET', effect: `only ${originSecret.length} characters. The server will not start with it: use at least 32 random characters (openssl rand -hex 32).`, state: 'wrong' });
  }
  if (tp === 'cloudflare' && !originSecret) {
    out.push({ key: 'ORIGIN_SECRET', effect: 'not set while TRUST_PROXY=cloudflare: anyone can still reach Railway directly, around Cloudflare. Set it, and the Cloudflare Transform Rule that sends it (CLOUDFLARE.md).' });
  }
  const socKey = env.SOC_IP_KEY?.trim();
  if (socKey && socKey.length < 16) {
    out.push({
      key: 'SOC_IP_KEY',
      effect: `only ${socKey.length} characters, so it is ignored and a random key is used: address tags change on every restart. Use at least 32 random characters.`,
      state: 'wrong',
    });
  }

  // The one that fails silently in the OUTPUT rather than at boot: a portrait
  // layer with no image provider returns { url: null } and the design ships with
  // the face missing and a note, which looks like a model that had a bad day.
  const img = (env.AI_IMAGE_PROVIDER ?? '').toLowerCase();
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const pollKey = env.AI_POLLINATIONS_KEY || env.POLLINATIONS_KEY;
  const noBackup = /^(none|off|false)$/i.test((env.AI_IMAGE_FALLBACK ?? '').trim());
  const cfReady = /^[a-f0-9]{32}$/i.test(env.AI_CLOUDFLARE_ACCOUNT_ID?.trim() ?? '') && !!env.AI_CLOUDFLARE_API_TOKEN?.trim();
  if (img === 'none') {
    out.push({ key: 'AI_IMAGE_PROVIDER', effect: 'set to "none": every AI design with a portrait will ship with the face missing.' });
  } else if (img === 'cloudflare' && !cfReady) {
    out.push({
      key: 'AI_IMAGE_PROVIDER',
      effect: pollKey && !noBackup
        ? 'set to "cloudflare" without a working AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN, so every picture comes from the backup, Pollinations.'
        : 'set to "cloudflare" without a working AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN, which means no pictures: every AI design with a portrait ships with the face missing.',
      state: 'wrong',
    });
  } else if (img === 'gemini' && !geminiKey) {
    out.push({
      key: 'AI_IMAGE_PROVIDER',
      effect: pollKey && !noBackup
        ? 'set to "gemini" with no GEMINI_API_KEY or GOOGLE_API_KEY, so every picture comes from the backup, Pollinations.'
        : 'set to "gemini" with no GEMINI_API_KEY or GOOGLE_API_KEY, which silently means "none" — every AI design with a portrait ships with the face missing.',
    });
  } else if (prod && img !== 'gemini' && img !== 'cloudflare' && !pollKey) {
    // Pollinations is the main picture provider and refuses every request
    // without a key. Said only in production: a dev box without one is normal.
    out.push({
      key: 'AI_POLLINATIONS_KEY',
      effect: geminiKey && !noBackup
        ? 'Pollinations is the picture provider but has no key, so every picture comes from the backup, Gemini, which costs more per picture.'
        : 'Pollinations is the picture provider but has no key, and there is no backup: every AI design with a portrait ships with the face missing.',
    });
  }

  // The picture backup. Gemini's image models have no free quota, so on a
  // project without billing a Gemini backup only fails, pauses and emails.
  // Cloudflare Workers AI is free for about 170 pictures a day.
  const cloudflare = cfReady;
  const fb = (env.AI_IMAGE_FALLBACK ?? '').trim().toLowerCase();
  const unknownFb = fb.split(/[\s,]+/).filter((w) => w && !['auto', 'none', 'off', 'false', 'pollinations', 'cloudflare', 'gemini'].includes(w));
  if (unknownFb.length) {
    out.push({
      key: 'AI_IMAGE_FALLBACK',
      effect: `has "${unknownFb.join(', ').slice(0, 60)}", which is not a picture provider; ${fb.split(/[\s,]+/).some((w) => ['pollinations', 'cloudflare', 'gemini'].includes(w)) ? 'it is ignored' : 'the backup is chosen automatically'}. The values are auto, none, or provider names (cloudflare, gemini, pollinations), comma-separated.`,
      state: 'wrong',
    });
  }
  if (img !== 'cloudflare' && (env.AI_CLOUDFLARE_ACCOUNT_ID?.trim() || env.AI_CLOUDFLARE_API_TOKEN?.trim()) && !cloudflare) {
    out.push({
      key: env.AI_CLOUDFLARE_API_TOKEN?.trim() ? 'AI_CLOUDFLARE_ACCOUNT_ID' : 'AI_CLOUDFLARE_API_TOKEN',
      effect: env.AI_CLOUDFLARE_API_TOKEN?.trim()
        ? 'is missing or is not a 32-character account id, so the free Cloudflare picture backup is off. Copy the Account ID from the Cloudflare dashboard (Workers AI page).'
        : 'is missing while AI_CLOUDFLARE_ACCOUNT_ID is set, so the free Cloudflare picture backup is off. Create a token with the "Workers AI" permission.',
      state: 'wrong',
    });
  } else if (prod && (img === '' || img === 'pollinations') && !noBackup && !cloudflare && pollKey) {
    out.push({
      key: 'AI_CLOUDFLARE_API_TOKEN',
      effect: geminiKey
        ? 'not set, so the picture backup is Gemini, which has no free quota: without billing on the Google project it cannot make a single picture. Set AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN for a free backup (about 170 pictures a day).'
        : 'not set, so pictures have no backup: when Pollinations fails, AI designs arrive without their picture. Set AI_CLOUDFLARE_ACCOUNT_ID and AI_CLOUDFLARE_API_TOKEN for a free backup (about 170 pictures a day).',
    });
  }

  // A model id Google has retired. The server already asks for the current
  // model instead (currentModelId in aiProvider), but the variable should say
  // what is really answering, or the next person to read it is misled.
  for (const k of ['AI_MODEL', 'AI_MODEL_PREMIUM', 'AI_MODEL_FAST', 'AI_MODEL_FALLBACK', 'AI_MODEL_FALLBACK_PREMIUM', 'AI_MODEL_FALLBACK_FAST'] as const) {
    const v = env[k]?.trim();
    const now = v ? RETIRED_TEXT_MODELS[v] : undefined;
    if (now) out.push({ key: k, effect: `set to "${v}", which Google has retired; the server asks for "${now}" instead. Change the variable to ${now}.`, state: 'wrong' });
  }

  // Claude first, Gemini behind it (aiProvider). Claude with nothing behind it
  // turns every Claude outage, and the day the month's API credit runs out,
  // into "premium is busy" for everyone.
  const forcedAi = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  const claudeMain = !!env.ANTHROPIC_API_KEY?.trim() && (forcedAi === '' || forcedAi === 'anthropic');
  const noTextBackup = /^(none|off|false|0)$/i.test((env.AI_PROVIDER_FALLBACK ?? '').trim());
  if (prod && claudeMain && !geminiKey && !noTextBackup) {
    out.push({
      key: 'GEMINI_API_KEY',
      effect: 'Claude is the AI designer with no backup: when it is busy, or the month\'s API credit is spent, premium designs end "busy". Set GEMINI_API_KEY (Google\'s free tier is enough) and Gemini takes over by itself.',
    });
  }
  for (const k of ['AI_CLAUDE_MODEL_FAST', 'AI_CLAUDE_MODEL_PREMIUM'] as const) {
    const v = env[k]?.trim();
    if (v && !/^claude-/i.test(v)) {
      out.push({ key: k, effect: `set to "${v}", which is not a Claude model id. Claude refuses every call for it, so ${geminiKey ? 'Gemini answers all of them instead' : 'every AI design on that tier fails'}.`, state: 'wrong' });
    }
  }
  for (const k of ['AI_CLAUDE_EFFORT_FAST', 'AI_CLAUDE_EFFORT_PREMIUM'] as const) {
    const v = env[k]?.trim().toLowerCase();
    if (v && !['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) {
      out.push({ key: k, effect: `set to "${env[k]}", which is not an effort level, so the default is used. The levels are low, medium, high, xhigh and max.`, state: 'wrong' });
    }
  }

  return out;
}

/**
 * Text models Google retired, and what the server asks for instead
 * (aiProvider's currentModelId reads this list). Source: the Gemini API
 * deprecations page, ai.google.dev/gemini-api/docs/deprecations.
 */
export const RETIRED_TEXT_MODELS: Record<string, string> = {
  'gemini-3.5-flash': 'gemini-3.6-flash',
};

/** Print them, once, at boot. Nothing here should ever stop the server. */
export function logConfigWarnings(env: NodeJS.ProcessEnv = process.env, log = console.warn): void {
  for (const w of configWarnings(env)) log(`[tifo] ${w.key} ${w.state === 'wrong' ? 'needs changing' : 'is not set'}: ${w.effect}`);
}

/**
 * Say out loud which redirect URI Google will be sent.
 *
 * Not a warning — it is printed when the thing is configured *correctly*. It
 * exists because `redirect_uri_mismatch` is the near-universal first-attempt
 * failure, it happens entirely at Google's end (so nothing reaches our logs),
 * and the fix is to have registered the exact string the server sends. Printing
 * that string removes the guessing: copy it into the console, character for
 * character.
 *
 * Deliberately not a list of every environment — it prints what THIS boot will
 * use, which is the only one that can be wrong right now.
 */
export function logProviderSetup(env: NodeJS.ProcessEnv = process.env, log = console.info): void {
  if (!env.GOOGLE_CLIENT_ID?.trim() || !env.GOOGLE_CLIENT_SECRET?.trim()) return;
  const base = env.PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (base) {
    log(`[tifo] Sign in with Google is on. Register this exact redirect URI: ${base}/api/auth/google/callback`);
  } else {
    // Without PUBLIC_URL the callback is built from the request's Host (checked
    // against a known list first), so it cannot be printed with certainty.
    log(
      '[tifo] Sign in with Google is on, but PUBLIC_URL is not set, so the callback URL is built from each ' +
        'request\'s host. Set PUBLIC_URL so the redirect URI is one fixed string you can register.',
    );
  }
}
