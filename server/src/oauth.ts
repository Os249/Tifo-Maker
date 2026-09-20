/**
 * Signing in with someone else's account. Google today; the shape is built so a
 * second provider is a descriptor and a pair of routes, not a second design.
 *
 * The flow is the plain OAuth 2.0 **authorization code** grant with PKCE, run
 * entirely server-side. That choice is worth defending, because the obvious
 * alternative — dropping Google's JavaScript library onto the page — is worse
 * here in three specific ways:
 *
 *   - It would put a third-party script on every page and force `script-src`
 *     and `connect-src` open. This site's CSP is `connect-src 'self'` and no
 *     foreign script at all, and the security audit spent real effort getting
 *     it there. A top-level redirect to accounts.google.com is a *navigation*,
 *     which no CSP directive governs, so none of that has to move.
 *   - The library is what the FedCM migration churns. Google's own guidance is
 *     that server-side authorization-code flows are untouched by it.
 *   - The token would arrive in the browser, where it has to be believed. Here
 *     it arrives on our own socket, over TLS, from Google directly — which is
 *     why the profile can be read from the userinfo endpoint and no ID token,
 *     JWKS fetch or RS256 verification is needed. One less thing to get wrong,
 *     and no new dependency.
 *
 * What has to be got right instead is the round trip: the browser leaves, comes
 * back, and we must be certain it is the same browser finishing the same
 * request it started. That is `state` plus PKCE, both carried in a signed
 * cookie — see `sealPending`.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** What we need from a provider about a person, and nothing more. */
export interface OAuthProfile {
  /**
   * The provider's own stable id for this person — Google's `sub`.
   *
   * Never the email. Google is explicit: "Don't use the email field as a unique
   * identifier for a user. Always use the sub field." An address can move
   * between people; `sub` cannot.
   */
  id: string;
  email: string | null;
  /**
   * Did the provider say it has verified that address?
   *
   * This single boolean decides whether we may attach this identity to an
   * account that already exists. Treat it as unverified whenever in doubt.
   */
  emailVerified: boolean;
  /** A display name, used only to derive a username. */
  name: string | null;
}

export interface OAuthProvider {
  readonly id: string;
  /** The consent screen to send the browser to. */
  authorizeUrl(args: { clientId: string; redirectUri: string; state: string; challenge: string; nonce: string }): string;
  /** Swap the code for an access token. Null on any failure. */
  exchange(args: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<string | null>;
  /** Read the profile with that access token. Null on any failure. */
  profile(accessToken: string): Promise<OAuthProfile | null>;
}

/** Every call out to a provider is bounded. A hung sign-in is a broken sign-in. */
const NET_TIMEOUT_MS = 8000;

async function postForm(url: string, body: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getJson(url: string, accessToken: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Google, via OpenID Connect.
 *
 * Scopes are `openid email profile` — all non-sensitive, which is why this
 * needs no verification review, faces no 100-user cap and shows no "unverified
 * app" warning. Asking for one scope more than this would change all three.
 */
export const GOOGLE: OAuthProvider = {
  id: 'google',

  authorizeUrl({ clientId, redirectUri, state, challenge, nonce }) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Ask every time rather than silently reusing a session: someone signed
      // into three Google accounts should get to pick which one is the tifo one.
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  },

  async exchange({ code, verifier, clientId, clientSecret, redirectUri }) {
    const data = (await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    })) as { access_token?: string } | null;
    return typeof data?.access_token === 'string' ? data.access_token : null;
  },

  async profile(accessToken) {
    const me = (await getJson('https://openidconnect.googleapis.com/v1/userinfo', accessToken)) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    } | null;
    if (!me || typeof me.sub !== 'string' || !me.sub) return null;
    const email = typeof me.email === 'string' && me.email.includes('@') ? me.email.trim() : null;
    return {
      id: me.sub,
      email,
      // `=== true` and not truthiness: some providers send the string "true",
      // and a string is not a verification.
      emailVerified: email !== null && me.email_verified === true,
      name: typeof me.name === 'string' ? me.name : null,
    };
  },
};

export const PROVIDERS: Record<string, OAuthProvider> = { google: GOOGLE };

// ---------------------------------------------------------------- the round trip

/**
 * What we have to remember while the browser is away at Google.
 *
 * It does not live in server memory. A Map would not survive a deploy, would
 * not be shared if this ever runs as two instances, and — most of all — would
 * not be *bound to the browser that started the request*, which RFC 9700
 * requires: "one-time use CSRF tokens carried in the `state` parameter that are
 * securely bound to the user agent MUST be used for CSRF protection." So it
 * rides along in an HttpOnly cookie, signed so it cannot be edited.
 */
export interface PendingAuth {
  /** Provider id, so a code from one can never be redeemed against another. */
  p: string;
  /** The `state` echoed back in the callback. */
  s: string;
  /** The PKCE verifier whose SHA-256 went to the provider. */
  v: string;
  /** Where to send the browser afterwards. A PATH on our origin, never a URL. */
  r: string;
  /** Claim the local draft onto the account once signed in. */
  c: 0 | 1;
  /** Expiry, epoch ms. */
  e: number;
  /**
   * Linking rather than signing in: the account to attach this identity to.
   *
   * Only ever written in a request that carried a bearer token, and the cookie
   * it rides in is signed, so the callback can act on it without re-checking —
   * a user id here means *we* put it here.
   */
  u?: string;
  /** The Terms version accepted at sign-up, recorded like the password path does. */
  a?: string;
}

const b64url = (b: Buffer): string => b.toString('base64url');

/**
 * The key that signs the pending-auth cookie.
 *
 * `OAUTH_STATE_KEY` when set, otherwise a fresh random key per boot — which
 * means a deploy in the middle of someone's sign-in invalidates it and they
 * press the button again. That is a far better failure than a predictable key.
 *
 * Deliberately NOT derived from `AI_ADMIN_PASSWORD`, for the same reason the
 * SOC address-hashing key is not: a database or log leak must not become an
 * offline cracking oracle for the admin password.
 */
let stateKey: Buffer | null = null;
function key(): Buffer {
  if (!stateKey) {
    const fromEnv = process.env.OAUTH_STATE_KEY?.trim();
    stateKey = fromEnv ? createHash('sha256').update(fromEnv).digest() : randomBytes(32);
  }
  return stateKey;
}

/** Only for tests, which need two "boots" to disagree. */
export function resetStateKeyForTests(): void {
  stateKey = null;
}

const sign = (payload: string): string => b64url(createHmac('sha256', key()).update(payload).digest());

export function sealPending(pending: PendingAuth): string {
  const payload = b64url(Buffer.from(JSON.stringify(pending), 'utf8'));
  return `${payload}.${sign(payload)}`;
}

export function openPending(sealed: string | undefined): PendingAuth | null {
  if (!sealed) return null;
  const dot = sealed.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = sealed.slice(0, dot);
  const mac = sealed.slice(dot + 1);
  const expected = sign(payload);
  // Length first: timingSafeEqual throws on a mismatch, and a thrown error is
  // its own timing signal.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PendingAuth;
    if (typeof parsed?.p !== 'string' || typeof parsed?.s !== 'string' || typeof parsed?.v !== 'string') return null;
    if (typeof parsed.e !== 'number' || Date.now() > parsed.e) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A fresh state + PKCE pair. 32 bytes each, from the same source as our tokens. */
export function newChallenge(): { state: string; verifier: string; challenge: string; nonce: string } {
  const verifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(32).toString('base64url'),
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
    nonce: randomBytes(16).toString('base64url'),
  };
}

/** Constant-time string compare for the state echo. */
export function sameState(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Where the browser may be sent after signing in.
 *
 * RFC 9700: "Clients and authorization servers MUST NOT expose URLs that
 * forward the user's browser to arbitrary URIs obtained from a query parameter
 * (open redirectors)." So this never accepts a URL. It accepts a path, and only
 * one that starts with a single slash — `//evil.example` is a protocol-relative
 * URL that a browser treats as another origin, and it is the classic way this
 * check gets walked through.
 */
const RETURN_ALLOW = /^\/(app|account|community|clubs)?(\/[A-Za-z0-9._~\-/]*)?$/;

export function safeReturnTo(raw: unknown): string {
  const path = typeof raw === 'string' ? raw : '';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/app';
  const clean = path.split(/[?#]/)[0] ?? '';
  return RETURN_ALLOW.test(clean) ? clean : '/app';
}
