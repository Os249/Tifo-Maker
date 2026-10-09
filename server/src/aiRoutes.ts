/**
 * AI Tifo Designer HTTP surface.
 *
 *   POST /api/ai/unlock     { password } → { token, expiresAt }   (admin gate)
 *   GET  /api/ai/quota      → { admin, ... } | 403 locked
 *   POST /api/ai/generate   { prompt }     → { spec, source } | 403 locked
 *
 * TEMPORARY LOCK (Phase 1 of the AI rebuild): generation is restricted to
 * admins while the next-generation system is built. Access is granted two ways,
 * both validated SERVER-SIDE:
 *   1. A signed-in user whose username is in ADMIN_USERNAMES (existing mechanism).
 *   2. A password unlock: the admin posts AI_ADMIN_PASSWORD to /api/ai/unlock and
 *      receives an HMAC-signed, time-limited token. The raw password never leaves
 *      the server (it lives only in the environment); the client only ever holds
 *      the opaque signed token, which the server re-verifies on every request.
 *
 * To change the password: set AI_ADMIN_PASSWORD in the server environment and
 * restart. Existing unlock tokens keep working until they expire (30 days) unless
 * the password changes (which invalidates every issued token, since it is the
 * HMAC key).
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AiEventsRepository, AiMode, AiOutcome, AiUsageRepository } from './repo';
import { classifyAiFailure, publicCause, sanitizeDetail, type AiFailure } from './aiFailure';
import { secondsToNextPeriod } from './repo';
import { validateSpec, validateModelSpec, narrowToSingleStand, regionAspectHint, regionRowsHint, type TifoSpec } from '../../src/core/tifoSpec';
import { refineSpec } from '../../src/core/specRefine';
import { designFromPrompt, composeSuperOffline } from '../../src/core/promptDesigner';
import { ensureHeroImage } from '../../src/core/heroImage';
import { matchClub } from '../../src/core/clubs';
import { generateSpecViaProvider, buildDirectorPrompt, critiqueSpecViaProvider, activeProvider, clubHintLine, writeCopy, copyLine } from './aiProvider';
import { readGroundPhoto, PHOTO_SAMPLE_DEFAULT, PHOTO_SAMPLE_MAX } from './photoRead';
import { generateImage, type ImageResult } from './imageAssets';
import { envNum } from './env';
import { TtlCache, cacheKey } from './aiCache';
import { screenPrompt } from './promptSafety';

const MAX_PROMPT = 400;

/**
 * What the caller actually received, in terms the UI can act on.
 *
 * 'full' is the thing that was promised. 'degraded' is a design that rendered
 * but is missing part of what makes it worth a premium call — today that means
 * a hero picture the image provider would not produce. The distinction exists
 * because collapsing it into a generic note is how a user ends up paying a
 * Super AI credit for a stand with a hole in it and never being told.
 */
export interface GenOutcome {
  kind: 'full' | 'degraded';
  /**
   * How many pictures were asked for and never arrived. A COUNT, not a phrase:
   * the client speaks Arabic as well as English, and a sentence assembled from
   * English fragments on the server cannot be translated on the way out.
   */
  missingCount?: number;
  /** How many were attempted. */
  of?: number;
  /** Whether this consumed one of the caller's premium designs. */
  charged: boolean;
  /** Retired: the provider's reason is recorded for /admin → AI instead of
   *  being sent to the editor, admins included. Kept optional for old clients. */
  detail?: string;
}
const PREMIUM_RETRY_SEC = 90; // "wait and retry" countdown when premium is busy
/**
 * How long an unlock token lives.
 *
 * Was 30 days. This one token is the whole key to the AI designer and every
 * /api/admin/* endpoint, and it lives in a browser on whatever machine the
 * operator last used — a month is a long time for that to be true of a laptop.
 * Twelve hours covers a working day and expires overnight; AI_UNLOCK_TTL_HOURS
 * raises it to at most a week for anyone who genuinely needs longer.
 */
const UNLOCK_TTL_MS = Math.min(
  7 * 24 * 60 * 60 * 1000,
  Math.max(1, Number(process.env.AI_UNLOCK_TTL_HOURS) || 12) * 60 * 60 * 1000,
);
// Result cache: identical (mode+prompt+stadium+provider) generations return the
// prior model design instantly — no model call, no image gen. Cuts tokens + RPD.
const genCache = new TtlCache<{ spec: TifoSpec; source: 'model' }>(80, 30 * 60 * 1000);

// Daily circuit breaker: cap premium model calls per UTC day so we never blow past
// the provider's free daily quota / budget. When spent, everyone is routed to the
// free Quick Designer ("premium resting") until midnight UTC. <=0 disables the cap.
// In-memory (fine for a single instance); a multi-instance deploy would share this.
const DAILY_BUDGET = envNum('AI_DAILY_BUDGET', 1000, 0);
let premiumDay = '';
let premiumCount = 0;
function rollPremiumDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== premiumDay) {
    premiumDay = today;
    premiumCount = 0;
  }
}
/** True when the day's premium budget is spent (breaker tripped). */
function premiumExhausted(): boolean {
  if (!(DAILY_BUDGET > 0)) return false;
  rollPremiumDay();
  return premiumCount >= DAILY_BUDGET;
}
function notePremiumCall(calls = 1): void {
  rollPremiumDay();
  premiumCount += calls;
}
/** Busy-retry countdown with a little jitter so retries don't stampede the same second. */
function busyRetrySec(): number {
  return PREMIUM_RETRY_SEC + Math.floor(Math.random() * 16);
}

export interface AiRouteDeps {
  /** Quota store (retained for when AI reopens to all users; unused during the lock). */
  aiUsage: AiUsageRepository;
  /** History of every request, for the admin AI section. Optional so tests and
   *  older wiring keep working; when absent nothing is recorded. */
  aiEvents?: AiEventsRepository;
  /** Resolve a user id from the request's bearer token (null = anonymous). */
  userOf: (req: FastifyRequest) => Promise<string | null>;
  /** Whether a user id belongs to an ADMIN_USERNAMES admin. */
  isAdmin: (userId: string) => Promise<boolean>;
  /** The admin unlock password (from AI_ADMIN_PASSWORD). Unset ⇒ password unlock disabled. */
  adminPassword?: string;
  /** Free generations per account per month (used when metering is enforced). */
  freeLimit: number;
  /** When true, AI is free for any signed-in, email-verified user (no per-account limit). */
  freeForAll: boolean;
  /** Email-verification + paid state for a user, used to gate AI. null ⇒ unknown user. */
  userState: (userId: string) => Promise<{ emailVerified: boolean; isPro: boolean } | null>;
  /** Per-route rate-limit options ({config:{rateLimit}}) when limiting is on. */
  routeConfig?: object;
  /** Tighter limit for the password-guessing surface. */
  authRouteConfig?: object;
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * The HMAC key for unlock tokens, derived from the admin password.
 *
 * It used to BE the admin password. An HMAC key is recoverable offline from a
 * single signed message at roughly 500,000 guesses per second per core, so
 * anyone who ever held one issued token — a browser extension, a shared
 * screenshot, a proxy log — could work the password back out at leisure. And
 * that one password gates the AI designer and every /api/admin/* endpoint.
 *
 * Putting scrypt in front makes each of those guesses cost 348 ms instead of
 * two microseconds: about eight orders of magnitude, which is the difference
 * between an afternoon and never.
 *
 * The salt is fixed rather than random because the key has to come out the same
 * on every process and after every restart, and there is nowhere to keep a
 * random one. That is the normal trade for a derived key with no store: it
 * costs the (irrelevant here) protection against a precomputed table of one
 * specific application's admin passwords, and keeps all of the per-guess cost,
 * which is the part that matters.
 *
 * Cached, and this is not an optimisation — verifyUnlock runs on EVERY AI and
 * admin request, and a 348 ms derivation per request would be a denial of
 * service we inflicted on ourselves.
 */
const unlockKeys = new Map<string, Buffer>();
function unlockKey(secret: string): Buffer {
  let key = unlockKeys.get(secret);
  if (!key) {
    key = scryptSync(secret, Buffer.from('tifomaker/ai-unlock/v2'), 32, { N: 65536, r: 8, p: 2, maxmem: 256 * 65536 * 8 });
    unlockKeys.set(secret, key);
  }
  return key;
}

/**
 * Sign an unlock token: "v2.<exp>.<jti>.<hmac>".
 *
 * `jti` is a random id, so two tokens issued in the same millisecond differ and
 * a token can be named in a log without printing the token itself. It is not a
 * revocation handle: revoking one token would need somewhere to write it down,
 * and an in-memory list would be undone by the next restart or the next
 * instance — theatre rather than a control. The lever that does work is rotating
 * AI_ADMIN_PASSWORD, which the derivation above makes total and immediate,
 * because every existing token is keyed to the old one.
 */
function signUnlock(secret: string, exp: number, jti = randomBytes(9).toString('hex')): string {
  const sig = createHmac('sha256', unlockKey(secret)).update(`ai-admin:${exp}:${jti}`).digest('hex');
  return `v2.${exp}.${jti}.${sig}`;
}

/** A fresh admin-password session token, exactly as /api/ai/unlock issues one. */
export function mintUnlock(secret: string): string {
  return signUnlock(secret, Date.now() + UNLOCK_TTL_MS);
}

/**
 * Verify an unlock token against the current password (and its expiry).
 *
 * Tokens signed before the key derivation existed are refused rather than
 * grandfathered: there are only ever a handful outstanding, they are held by
 * the operator, and re-entering the password costs one click — whereas
 * accepting them would keep the recoverable-key window open for their full life.
 */
export function verifyUnlock(secret: string, token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v2') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  // Bound the horizon too. A token whose expiry is years out is either forged
  // against a leaked key or was minted before the TTL came down, and neither is
  // something to honour.
  if (exp > Date.now() + UNLOCK_TTL_MS + 60_000) return false;
  if (!/^[0-9a-f]{18}$/.test(parts[2])) return false;
  const expected = createHmac('sha256', unlockKey(secret)).update(`ai-admin:${exp}:${parts[2]}`).digest('hex');
  return safeEqual(parts[3], expected);
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const adminPassword = deps.adminPassword;

  type Access =
    | { kind: 'admin'; actorId: string | null }
    | { kind: 'user'; userId: string; pro: boolean }
    | { kind: 'deny'; status: number; error: string; reason: 'signin' | 'verify' };

  /**
   * Who may use the AI Designer:
   *  - an admin unlock token or ADMIN_USERNAMES account → unlimited;
   *  - otherwise a signed-in user whose email is verified.
   * Anonymous or unverified callers are denied with a reason the client acts on
   * (prompt to sign in / verify). This is the loophole guard for free AI usage.
   */
  const baseAccess = async (req: FastifyRequest): Promise<Access> => {
    const tok = req.headers['x-ai-unlock'];
    if (typeof tok === 'string' && adminPassword && verifyUnlock(adminPassword, tok)) {
      // Unlimited either way; the account behind it is looked up only so the
      // admin AI tab can say WHO ran a request, not "admin / unlocked".
      return { kind: 'admin', actorId: await deps.userOf(req).catch(() => null) };
    }
    const userId = await deps.userOf(req);
    if (!userId) return { kind: 'deny', status: 401, error: 'Sign in to use the AI Designer.', reason: 'signin' };
    // Admins are metered like everyone for now (no auto-unlimited AI); the /admin
    // dashboard is separate. Only the unlock token and paid (pro) accounts are unlimited.
    const st = await deps.userState(userId);
    if (!st) return { kind: 'deny', status: 401, error: 'Sign in to use the AI Designer.', reason: 'signin' };
    if (!st.emailVerified) {
      return { kind: 'deny', status: 403, error: 'Verify your email to use the AI Designer.', reason: 'verify' };
    }
    return { kind: 'user', userId, pro: st.isPro };
  };

  /**
   * Each free account's own daily share of the premium calls that are not
   * charged to its hourly design quota: photo readings and the critic.
   *
   * Both spend the site-wide AI_DAILY_BUDGET, and nothing stopped one account
   * from spending all of it: one verified free account at the route's 12 a
   * minute made 1,000 paid vision calls in about eleven minutes, and premium
   * AI then rested for everyone until midnight (audit round four). Admin
   * sessions and paid accounts are not counted. In memory, by UTC day.
   */
  const PREMIUM_SIDE_PER_DAY = { photo: 24, polish: 30 } as const;
  const sideUse = new Map<string, number>();
  const takeSide = (a: Access, kind: keyof typeof PREMIUM_SIDE_PER_DAY, n: number): boolean => {
    if (a.kind !== 'user' || a.pro) return true;
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}|${kind}|${a.userId}`;
    const used = sideUse.get(key) ?? 0;
    if (used + n > PREMIUM_SIDE_PER_DAY[kind]) return false;
    if (sideUse.size > 20_000) for (const k of sideUse.keys()) if (!k.startsWith(day)) sideUse.delete(k);
    sideUse.set(key, used + n);
    return true;
  };

  /** Unlimited use: admins and paid accounts. Everyone else is metered hourly. */
  /**
   * Write down what happened. Best-effort in the strongest sense: a telemetry
   * failure must never turn into a failed generation, so this is never awaited
   * and never throws.
   */
  const note = (a: Access, mode: AiMode, outcome: AiOutcome, fail?: AiFailure): void => {
    const userId = a.kind === 'user' ? a.userId : a.kind === 'admin' ? a.actorId : null;
    void deps.aiEvents
      ?.record({
        userId,
        mode,
        outcome,
        via: a.kind === 'admin' ? 'password' : null,
        ...(fail ? { reason: fail.reason, detail: fail.status && !fail.detail.includes(String(fail.status)) ? `HTTP ${fail.status}: ${fail.detail}` : fail.detail } : {}),
      })
      .catch(() => {});
  };
  /** The model id a tier resolves to, for the operator's failure detail. */
  const modelOf = (isSuper: boolean): string =>
    isSuper ? (process.env.AI_MODEL_PREMIUM ?? process.env.AI_MODEL ?? 'default') : (process.env.AI_MODEL_FAST ?? process.env.AI_MODEL ?? 'default');
  /** Name the model in the operator's detail when the provider's text did not. */
  const withModel = (err: string, model: string): string =>
    model === 'default' || err.includes(model) ? err : `${err} (model ${model})`;
  const budgetFailure = (): AiFailure => ({
    reason: 'budget',
    detail: `AI_DAILY_BUDGET spent: ${DAILY_BUDGET} premium calls today; resets at 00:00 UTC`,
  });

  const isUnlimited = (a: Access): boolean => a.kind === 'admin' || (a.kind === 'user' && a.pro);
  /** May the caller use the premium model at all? freeForAll is the kill-switch. */
  const premiumAllowed = (a: Access): boolean =>
    a.kind === 'admin' || (a.kind === 'user' && (a.pro || deps.freeForAll));
  /** Free, instant offline ("Quick Designer") spec — never consumes a credit. */
  const quickDesign = (prompt: string, isSuper: boolean): ReturnType<typeof validateSpec> =>
    validateSpec(isSuper ? composeSuperOffline(prompt) : designFromPrompt(prompt));

  // Exchange the admin password for a signed, time-limited unlock token.
  // This single shared password gates the AI designer AND every /api/admin/*
  // analytics endpoint. It had no route limit, so the global 300/min allowed
  // 432,000 guesses a day from one IP against one password. It belongs on the
  // same limiter as /api/auth/login.
  app.post('/api/ai/unlock', deps.authRouteConfig ?? {}, async (req, reply) => {
    if (!adminPassword) return reply.code(403).send({ error: 'admin unlock is not configured' });
    const pw = typeof (req.body as { password?: unknown } | null)?.password === 'string'
      ? (req.body as { password: string }).password
      : '';
    if (!pw || !safeEqual(pw, adminPassword)) return reply.code(401).send({ error: 'incorrect password' });
    const exp = Date.now() + UNLOCK_TTL_MS;
    const token = signUnlock(adminPassword, exp);
    // Names this admin session in the audit trail by the token's random id.
    req.socActor = `admin password (session ${token.split('.')[2]?.slice(0, 6) ?? '?'})`;
    // The same token as a cookie, for the one thing a header cannot do: let a
    // <script src> and a browser navigation prove who they are, so /admin.js
    // can stop being public. HttpOnly, so script cannot read it back out;
    // SameSite=Strict, so it never leaves this site; Secure whenever the request
    // arrived over TLS — unconditionally Secure would silently break admin on a
    // local http dev server, which reads as "the password is wrong".
    const secure = req.protocol === 'https' || process.env.NODE_ENV === 'production';
    void reply.header('set-cookie',
      `tm_admin=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(UNLOCK_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    return { token, expiresAt: new Date(exp).toISOString() };
  });

  // Signing out has to clear the cookie too, or the dashboard module keeps
  // being served to a browser whose localStorage token is gone.
  app.delete('/api/ai/unlock', async (req, reply) => {
    const secure = req.protocol === 'https' || process.env.NODE_ENV === 'production';
    void reply.header('set-cookie',
      `tm_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    return reply.code(204).send();
  });

  app.get('/api/ai/quota', async (req, reply) => {
    const access = await baseAccess(req);
    if (access.kind === 'deny') {
      return reply.code(access.status).send({ error: access.error, reason: access.reason, locked: true });
    }
    if (access.kind !== 'user' || isUnlimited(access)) {
      return { unlimited: true, used: 0, limit: 0, remaining: 999999, resetInSec: 0, provider: activeProvider() };
    }
    const usage = await deps.aiUsage.get(access.userId, deps.freeLimit);
    return { unlimited: false, ...usage, resetInSec: secondsToNextPeriod(), provider: activeProvider() };
  });

  app.post('/api/ai/generate', deps.routeConfig ?? {}, async (req, reply) => {
    const access = await baseAccess(req);
    if (access.kind === 'deny') {
      return reply.code(access.status).send({ error: access.error, reason: access.reason, locked: true });
    }

    const body = (req.body ?? {}) as { prompt?: unknown; mode?: unknown; stadium?: unknown; engine?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const mode0: 'std' | 'super' = body.mode === 'super' ? 'super' : 'std';
    if (!prompt) { note(access, mode0, 'invalid'); return reply.code(400).send({ error: 'a prompt is required' }); }
    if (prompt.length > MAX_PROMPT) {
      note(access, mode0, 'invalid');
      return reply.code(400).send({ error: `prompt too long (max ${MAX_PROMPT} characters)` });
    }
    // First-line safety screen — block clearly-harmful prompts before the model.
    const safe = screenPrompt(prompt);
    if (!safe.ok) {
      // Which list matched, never the prompt itself (see the ai_events note in schema.sql).
      note(access, mode0, 'blocked', { reason: 'prompt_screen', detail: `matched the "${safe.rule}" list of the prompt screen` });
      return reply.code(400).send({ error: safe.message, reason: 'blocked' });
    }

    // The client's stadium context: Super AI plans the whole bowl from it, and
    // the standard designer needs it too — on a 13-row ground "hero in the top
    // 60%, support below" is two words nobody can read.
    const isSuper = body.mode === 'super';
    const stadium = typeof body.stadium === 'string' ? body.stadium.slice(0, 2000) : undefined;
    const engine = body.engine === 'offline' ? 'offline' : 'auto';
    const userId = access.kind === 'user' ? access.userId : null;
    const unlimited = isUnlimited(access);
    const usage = userId && !unlimited ? await deps.aiUsage.get(userId, deps.freeLimit) : null;
    const quotaInfo = usage
      ? { admin: false, used: usage.used, limit: usage.limit, remaining: usage.remaining, resetInSec: secondsToNextPeriod() }
      : { admin: true, used: 0, limit: 0, remaining: 999999, resetInSec: 0 };

    // Quick Designer: free, instant offline engine — the user's explicit choice, or
    // used automatically when premium is switched off. Never consumes a credit.
    if (engine === 'offline' || !premiumAllowed(access)) {
      const q = quickDesign(prompt, isSuper);
      if (!q.valid || !q.spec) {
        note(access, mode0, 'invalid', {
          reason: 'invalid_design',
          detail: sanitizeDetail(`Quick Designer spec failed validation: ${(q.errors ?? []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`),
        });
        return reply.code(502).send({ error: 'could not produce a valid design' });
      }
      note(access, mode0, 'quick');
      return reply.code(200).send({ spec: refineSpec(q.spec), quota: quotaInfo, source: 'quick', notes: [], outcome: { kind: 'full', charged: false } satisfies GenOutcome });
    }

    // Result cache: an identical brief returns the prior premium design instantly (free).
    const key = cacheKey('gen', isSuper ? 'super' : 'std', prompt, stadium, activeProvider());
    const hit = genCache.get(key);
    if (hit) {
      note(access, mode0, 'cache');
      return reply.code(200).send({ spec: hit.spec, quota: quotaInfo, source: hit.source, notes: ['Served instantly from cache.'], outcome: { kind: 'full', charged: false } satisfies GenOutcome });
    }

    // Hourly cap reached → offer the choice (Quick Designer now, or wait for reset).
    if (usage && usage.remaining <= 0) {
      note(access, mode0, 'quota');
      return reply.code(200).send({ needsChoice: true, reason: 'quota', retryAfterSec: secondsToNextPeriod(), quota: quotaInfo });
    }

    // Daily circuit breaker: budget spent → route to the Quick Designer instead of
    // burning the provider's daily quota. Same "choice" UX, no error shown.
    if (premiumExhausted()) {
      note(access, mode0, 'busy', budgetFailure());
      return reply.code(200).send({ needsChoice: true, reason: 'busy', cause: publicCause('budget'), retryAfterSec: busyRetrySec(), quota: quotaInfo });
    }

    // Try the premium model (counts against the daily budget).
    notePremiumCall();
    // The club hint is a pure function of `prompt`, so the result-cache key above
    // stays correct without mentioning it.
    const hint = clubHintLine(prompt);

    // Stage 1 (Super only): the copywriter picks the WORDS before anything is
    // laid out. A hero phrase is what decides whether a stand can be filled at
    // all, and a model choosing words while already reasoning about regions
    // reliably picks the club's legal name or the brief verbatim. Best-effort:
    // a failure or a disabled stage just means the director designs from the raw
    // brief, exactly as before. Costs a fraction of a cent on the fast tier.
    const wantsCopy = isSuper && process.env.AI_COPYWRITER !== '0';
    const copy = wantsCopy ? await writeCopy(prompt, hint).catch(() => null) : null;
    const brief = copy ? `${prompt}\n\n${copyLine(copy)}` : prompt;

    const modelResult = await generateSpecViaProvider(
      brief,
      isSuper ? { system: buildDirectorPrompt(), context: stadium, tier: 'premium', hint } : { context: stadium, tier: 'fast', hint },
    );
    // Repaired before it is judged: a stripes layer that says `direction` for
    // `orientation`, or colours as hex, has one obvious reading and used to cost
    // the user the whole design.
    const r = modelResult.spec ? validateModelSpec(modelResult.spec) : ({ valid: false, errors: [], repairs: [] } as ReturnType<typeof validateModelSpec>);
    if (r.repairs.length) app.log.info({ mode: mode0, repairs: r.repairs.slice(0, 12) }, 'ai: model design repaired');
    if (!r.valid || !r.spec) {
      // Premium couldn't deliver — we don't admit failure; the client offers a choice
      // (use the free Quick Designer now, or wait out a short timer and retry).
      //
      // The user sees "busy", but the OPERATOR needs the real reason: a bad model
      // id, a key without access to that model, a timeout and a spec the
      // validator rejected all look identical from the outside, and this error
      // used to be computed and thrown away.
      const fail: AiFailure = modelResult.spec
        ? {
            reason: 'invalid_design',
            detail: sanitizeDetail(`${modelOf(isSuper)}: spec failed validation: ${(r.errors ?? []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`),
          }
        : classifyAiFailure(withModel(modelResult.error ?? 'the model did not answer', modelOf(isSuper)), modelResult.status);
      app.log.warn(
        {
          reason: fail.reason,
          detail: fail.detail,
          mode: mode0,
          model: modelOf(isSuper),
          provider: activeProvider(),
        },
        'ai generate: premium could not deliver',
      );
      note(access, mode0, 'busy', fail);
      // The editor gets ONE vendor-free word it turns into a translated
      // sentence (busy / resting / slow / content / garbled / unavailable).
      // It used to get the provider's raw reply when the caller was an admin,
      // which is how "gemini \"gemini-3.5-flash\": HTTP 503: {...}" ended up in
      // the Arabic card and on the status line. The whole story — reason,
      // provider text, model, account — is in /admin → AI now, for everyone.
      return reply.code(200).send({ needsChoice: true, reason: 'busy', cause: publicCause(fail.reason), retryAfterSec: busyRetrySec(), quota: quotaInfo });
    }

    // Phase 4: deterministic art-director pass — fix legibility/contrast/field.
    let spec = refineSpec(r.spec);
    // Super AI's whole promise is a picture on the bowl. The director is told
    // to make one the hero and usually does, but a Super design that came back
    // with only symbols and fills is a Quick Designer result charged as premium.
    // So the guarantee is structural, not a request in a prompt.
    if (isSuper) {
      const club = matchClub(prompt.toLowerCase());
      const hero = ensureHeroImage(spec, { brief: prompt, crest: club?.crest });
      spec = hero.spec;
      if (hero.via !== 'present') {
        app.log.info({ via: hero.via, mode: mode0 }, 'ai generate: hero picture guaranteed');
      }
    }
    // Phase 5: best-effort picture for each image layer; failures just skip the layer.
    const notes: string[] = [];
    let wanted = 0;
    let missed = 0;
    let firstFailure: string | undefined;
    for (const layer of spec.layers) {
      if (layer.kind === 'image' && !layer.assetRef) {
        wanted++;
        // Tell the generator what it is drawing FOR: the shape of the region the
        // picture has to fill, and the palette it is about to be quantized into.
        // Without both it returns a square in arbitrary colours, and the client
        // then destroys it snapping to the design's palette.
        const region = narrowToSingleStand(layer.region);
        const style = {
          aspect: regionAspectHint(region),
          palette: spec.palette,
          rows: regionRowsHint(region),
        };
        const draw = (p: string): Promise<ImageResult> =>
          generateImage(p, style).catch((e) => ({ url: null, error: String(e) }));

        let { url, error, kind } = await draw(layer.prompt);
        // An account that is out of credit, a refused key or a rate limit say
        // nothing about the prompt, so a second prompt only doubles the wait
        // and the bill for a picture that cannot come.
        if (!url && kind !== 'credit' && kind !== 'auth' && kind !== 'rate') {
          // A refused prompt is usually the BRIEF, not the subject: a player's
          // name, a club, a phrase some provider filter dislikes. Try the bare
          // subject once before giving up on the hero — a generic eagle beats an
          // empty stand, and the picture is the reason Super AI exists.
          const bare = layer.prompt.split(', for:')[0].trim();
          if (bare && bare !== layer.prompt.trim()) {
            const second = await draw(bare);
            if (second.url) { url = second.url; error = undefined; }
          }
        }
        if (url) layer.assetRef = url;
        else {
          missed++;
          firstFailure = firstFailure ?? error ?? 'unknown error';
          // The provider's words go to /admin → AI, not into the design's notes.
          notes.push('Picture not generated.');
        }
      }
    }

    // What the user actually got. A design whose hero picture failed is NOT what
    // Super AI promises: the stand it was meant to carry comes out bare. So it
    // is reported as degraded, and — the part that matters — it is NOT CHARGED.
    // Charging used to happen the moment the model returned a valid spec, which
    // meant a failed picture still cost a Super AI use and the user was told
    // nothing beyond a line of small grey text.
    const degraded = missed > 0;
    // Recorded here rather than when the spec validated, so a design whose
    // picture never came is on file WITH the reason it did not.
    note(access, mode0, 'model', degraded ? { reason: 'picture_failed', detail: sanitizeDetail(`${missed} of ${wanted}: ${firstFailure ?? 'unknown error'}`) } : undefined);
    const charged = !!(usage && userId) && !degraded;
    let quota = quotaInfo;
    if (charged && userId) {
      const c = await deps.aiUsage.consume(userId, deps.freeLimit);
      quota = { admin: false, used: c.used, limit: c.limit, remaining: c.remaining, resetInSec: secondsToNextPeriod() };
    }
    // Never cache a degraded design: the cache is keyed on the brief, so storing
    // one meant the next 30 minutes of retries returned the same holed design
    // instantly, without even attempting the picture again.
    if (!degraded) genCache.set(key, { spec, source: 'model' });

    const outcome: GenOutcome = degraded
      ? {
          kind: 'degraded',
          missingCount: missed,
          of: wanted,
          charged,
        }
      : { kind: 'full', charged };
    return reply.code(200).send({ spec, quota, source: 'model', notes, outcome });
  });

  // Phase 4b: vision critique — take the current design + a render of it, ask the
  // model to fix legibility/balance, and return an improved spec. Best-effort: any
  // failure returns the ORIGINAL design unchanged, so polish never breaks a design.
  app.post('/api/ai/critique', deps.routeConfig ?? {}, async (req, reply) => {
    const access = await baseAccess(req);
    if (access.kind === 'deny') {
      return reply.code(access.status).send({ error: access.error, reason: access.reason, locked: true });
    }
    const b = (req.body ?? {}) as { spec?: unknown; image?: unknown; stadium?: unknown };
    const incoming = validateSpec(b.spec);
    if (!incoming.valid || !incoming.spec) {
      return reply.code(400).send({ error: 'a valid current spec is required', errors: incoming.errors });
    }
    const image = typeof b.image === 'string' ? b.image : undefined;
    const stadium = typeof b.stadium === 'string' ? b.stadium.slice(0, 2000) : undefined;

    const notes: string[] = [];
    let spec = incoming.spec;
    let source: 'model' | 'original' = 'original';
    // Set when the critic could not run; the client says so in its own words.
    let failed: AiFailure | null = null;
    if (activeProvider() === 'none') {
      failed = { reason: 'no_provider', detail: 'no AI provider configured' };
    } else if (premiumExhausted() || !takeSide(access, 'polish', 1)) {
      // The critic is a premium call like any other. It used to skip the daily
      // budget entirely, so it kept spending once generation had stopped; and
      // each account has its own daily share of it (takeSide).
      failed = budgetFailure();
    } else {
      notePremiumCall();
      // Portrait assetRefs are huge base64 data URLs; the critic sees the rendered
      // image, so send a SLIM spec (assetRef removed) — otherwise the prompt
      // balloons and the model's JSON reply truncates. Re-attach originals after.
      const origImages = incoming.spec.layers.filter((l) => l.kind === 'image');
      const slim = {
        ...incoming.spec,
        layers: incoming.spec.layers.map((l) => (l.kind === 'image' ? { ...l, assetRef: undefined } : l)),
      };
      const res = await critiqueSpecViaProvider(slim, image, stadium);
      const improved = res.spec ? validateModelSpec(res.spec, incoming.spec) : null;
      if (improved?.repairs.length) app.log.info({ mode: 'polish', repairs: improved.repairs.slice(0, 12) }, 'ai: critic design repaired');
      if (improved && improved.valid && improved.spec) {
        let k = 0;
        for (const l of improved.spec.layers) {
          if (l.kind === 'image') {
            const o = origImages[k++];
            if (o && o.kind === 'image' && o.assetRef && !l.assetRef) l.assetRef = o.assetRef;
          }
        }
        spec = refineSpec(improved.spec);
        source = 'model';
      } else {
        failed = res.spec
          ? { reason: 'invalid_design', detail: sanitizeDetail(`critique spec failed validation: ${(improved?.errors ?? []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`) }
          : classifyAiFailure(withModel(res.error ?? 'invalid response', modelOf(true)), res.status);
      }
    }
    if (failed) {
      // Only failures of the critic are recorded (mode 'polish'): the design is
      // left exactly as it was, and the provider's words stay on the server.
      note(access, 'polish', 'busy', failed);
      return reply.code(200).send({ spec, source, notes, cause: publicCause(failed.reason) });
    }
    return reply.code(200).send({ spec, source, notes });
  });

  // Read a photo of a real ground and report the categorical facts the bowl
  // estimator would otherwise have to guess: tiers, roof, track, floodlights,
  // facade. The reply is a VOTE, not an answer — n readings of the same picture,
  // with the agreement rate for each field — because a single confident reply
  // entering a template as plain data is exactly what the provenance record in
  // src/core/stadiumFit exists to prevent.
  //
  // A photo is a megabyte or two, well past the global 1 MB body limit, so this
  // route carries its own like the design-photo upload does.
  app.post('/api/stadium/photo', { ...(deps.routeConfig ?? {}), bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const access = await baseAccess(req);
    if (access.kind === 'deny') {
      return reply.code(access.status).send({ error: access.error, reason: access.reason, locked: true });
    }
    const b = (req.body ?? {}) as { image?: unknown; samples?: unknown };
    const image = typeof b.image === 'string' ? b.image : '';
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      return reply.code(400).send({ error: 'image must be a png/jpeg/webp data URL' });
    }
    if (activeProvider() === 'none') {
      note(access, 'photo', 'busy', { reason: 'no_provider', detail: 'no AI provider configured' });
      return reply.code(503).send({ error: 'no AI provider configured' });
    }
    const samples = Math.max(1, Math.min(PHOTO_SAMPLE_MAX, Number(b.samples) || PHOTO_SAMPLE_DEFAULT));
    // Up to eight premium vision calls per request, and none of them used to
    // count against AI_DAILY_BUDGET: the breaker that stops generation did not
    // stop this. Every reading now counts.
    if (premiumExhausted() || !takeSide(access, 'photo', samples)) {
      note(access, 'photo', 'busy', budgetFailure());
      return reply.code(503).send({ error: 'premium AI is resting for today, try again tomorrow', reason: 'busy', retryAfterSec: busyRetrySec() });
    }
    notePremiumCall(samples);
    const out = await readGroundPhoto(image, samples);
    // Every reading failed: that is an upstream problem, not an empty photo.
    if (!out.vote.samples) {
      const fail = classifyAiFailure(out.errors[0] ?? 'the model did not answer');
      if (out.errors.length > 1) fail.detail = sanitizeDetail(`${fail.detail} (${out.errors.length} readings failed)`);
      note(access, 'photo', 'busy', fail);
      // The provider's text used to ride back in `error` and `errors`.
      return reply.code(502).send({ error: 'the model did not answer', reason: 'busy', cause: publicCause(fail.reason) });
    }
    // Readings that failed while others succeeded are the operator's business.
    return reply.code(200).send({ ...out, errors: [] });
  });
}
