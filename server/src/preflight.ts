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
  for (const w of configWarnings(env)) log(`[tifo] ${w.key} ${w.state === 'wrong' ? 'needs changing' : 'is not set'}: ${w.effect}`);
}
