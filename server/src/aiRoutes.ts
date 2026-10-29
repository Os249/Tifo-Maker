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

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AiBudgetRepository, AiEventsRepository, AiEventUsage, AiMode, AiOutcome, AiUsageRepository } from './repo';
import { classifyAiFailure, publicCause, sanitizeDetail, type AiFailure } from './aiFailure';
import { secondsToNextPeriod } from './repo';
import { addCostMicros, addUsage, pictureCostMicros, zeroUsage, type TokenUsage } from './aiPricing';
import { validateSpec, validateModelSpec, narrowToSingleStand, regionAspectHint, regionRowsHint, type TifoSpec } from '../../src/core/tifoSpec';
import { refineSpec } from '../../src/core/specRefine';
import { composeSuperOffline } from '../../src/core/promptDesigner';
import { ensureHeroImage } from '../../src/core/heroImage';
import { matchClub } from '../../src/core/clubs';
import { generateSpecViaProvider, buildDirectorPrompt, critiqueSpecViaProvider, activeProvider, clubHintLine, writeCopy, copyLine, meterRetries, providerModel, type ProviderResult } from './aiProvider';
import { readGroundPhoto, PHOTO_SAMPLE_DEFAULT, PHOTO_SAMPLE_MAX } from './photoRead';
import { generateImage, type ImageResult } from './imageAssets';
import { envNum } from './env';
import { TtlCache, cacheKey } from './aiCache';
import { screenPrompt } from './promptSafety';
import { sniffImage } from './imageMeta';
import type { Allowance, ProService, Ticket } from './pro';
import type { PlanKind } from './proPlan';
import { cutoutConfigured, cutoutPicture, CUTOUT_MODEL, CUTOUT_PRICE_USD, MAX_CUTOUT_BYTES } from './cutout';

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
//
// Counted in memory, because it is checked on every request, and written
// through to the AI budget store (ai_budget in Postgres) as it grows. On start-up
// the day's count is read back, so a deploy no longer hands out a fresh 1,000:
// before October 2026 a day with three deploys had a cap of 4,000.
const DAILY_BUDGET = envNum('AI_DAILY_BUDGET', 1000, 0);
/**
 * Picture requests per UTC day, across everyone. The model budget never
 * counted them, and a picture is paid for separately (the Pollinations credit
 * the owner tops up, or Gemini at about 20 times the price when Pollinations is
 * down). Every request to the image provider counts, a failed try or the
 * bare-subject retry included, since a provider may bill those too. When it is
 * spent, designs arrive without their picture, reported as incomplete (the
 * usual incomplete-run rules decide whether that is charged), until 00:00 UTC.
 * <=0 disables the cap.
 */
const pictureBudget = (): number => envNum('AI_DAILY_PICTURE_BUDGET', 1000, 0);
/** Pictures one Super AI design may ask for: one per stand. */
const MAX_PICTURES_PER_DESIGN = 4;
let premiumDay = '';
let premiumCount = 0;
let pictureCount = 0;
let budgetStore: AiBudgetRepository | null = null;
/** The day whose stored count has been read back (or is being read). */
let loadedDay = '';
let loading: Promise<void> | null = null;
function rollPremiumDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== premiumDay) {
    premiumDay = today;
    premiumCount = 0;
    pictureCount = 0;
  }
}
/** After a failed read-back, when to try again (ms since epoch). */
let loadRetryAt = 0;
/** How long an AI request waits for the stored count before going on without it. */
const BUDGET_LOAD_WAIT_MS = 2000;
/**
 * Read the day's stored count back once per day (and once per start-up).
 * A store that cannot answer leaves the memory count in charge, and is asked
 * again a minute later: a database blip on the first request after a deploy
 * must not reset the day's cap to zero until midnight (review, 17 October
 * 2026). A request never waits more than two seconds for it.
 */
async function budgetReady(): Promise<void> {
  rollPremiumDay();
  if (!budgetStore) return;
  if (loadedDay === premiumDay) return loading ?? undefined;
  if (Date.now() < loadRetryAt) return;
  const day = premiumDay;
  loadedDay = day;
  const load = budgetStore.load(day).then((v) => {
    // Late answers still count: max() can only raise the count.
    if (premiumDay !== day) return true;
    premiumCount = Math.max(premiumCount, v.calls);
    pictureCount = Math.max(pictureCount, v.pictures);
    return true;
  });
  const failed = (): void => {
    if (loadedDay !== day) return;
    loadedDay = '';
    loading = null;
    loadRetryAt = Date.now() + 60_000;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), BUDGET_LOAD_WAIT_MS); });
  loading = Promise.race([load, wait]).then(
    (ok) => { clearTimeout(timer); if (!ok) failed(); },
    () => { clearTimeout(timer); failed(); },
  );
  return loading;
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
  void budgetStore?.add(premiumDay, calls, 0).catch(() => {});
}
/** Take one picture from the day's budget; false when it is spent. */
function takePicture(): boolean {
  rollPremiumDay();
  const cap = pictureBudget();
  if (cap > 0 && pictureCount >= cap) return false;
  pictureCount++;
  void budgetStore?.add(premiumDay, 0, 1).catch(() => {});
  return true;
}
// A retried provider call is a real second call, and counts as one.
meterRetries(() => notePremiumCall(1));
/** Premium calls counted today (for tests and the record; read-only). */
export function premiumCallsToday(): number {
  rollPremiumDay();
  return premiumCount;
}
/** Pictures counted today (for tests; read-only). */
export function picturesToday(): number {
  rollPremiumDay();
  return pictureCount;
}
/** Tests only: forget today's in-memory count, as a restart would. */
export function forgetBudgetMemoryForTests(): void {
  premiumDay = '';
  premiumCount = 0;
  pictureCount = 0;
  loadRetryAt = 0;
  loadedDay = '';
  loading = null;
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
  /** Where the daily budget survives a restart. Absent ⇒ memory only, as before. */
  aiBudget?: AiBudgetRepository;
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
  /**
   * Email-verification + paid state for a user, used to gate AI. null ⇒ unknown user.
   * With the request, the caller's own state comes from the request's session
   * read rather than another query (performance plan P2.17).
   */
  userState: (userId: string, req?: FastifyRequest) => Promise<{ emailVerified: boolean; isPro: boolean; username?: string | null } | null>;
  /**
   * Pro (proPlan.ts): when present, accounts it is on for use its allowances
   * (Standard by day, Super, Polish, photo and the smart cut-out by week, or a
   * pass's ceilings) instead of the hourly meter and the daily shares below.
   */
  pro?: ProService;
  /** Per-route rate-limit options ({config:{rateLimit}}) when limiting is on. */
  routeConfig?: object;
  /** Tighter limit for the password-guessing surface. */
  authRouteConfig?: object;
}

/**
 * Constant-time string compare that never throws on length mismatch.
 *
 * Both sides are hashed to 32 bytes first. It used to return early when the
 * lengths differed, so the time a wrong guess took told the guesser whether
 * they had the admin password's length right (audit round six). Equal digests
 * mean equal strings for any purpose here.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
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
 * Derive the unlock key now, while the server is starting, rather than on the
 * first request that carries a token. That first request could be anyone's:
 * a well-formed `x-ai-unlock` header from an anonymous caller held the only
 * event loop for the 0.35-0.74 s the derivation takes, once per process
 * (audit round six). Synchronous on purpose, so `verifyUnlock` stays a plain
 * boolean check with no window in which a key is missing or a promise could be
 * mistaken for a yes. A failure throws here and stops the boot.
 */
export function warmUnlockKey(secret: string | undefined): void {
  if (secret) unlockKey(secret);
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

/** What one request spent, for its ai_events row (/admin → AI → cost). */
interface Spent {
  usage: TokenUsage;
  /** The model that answered (or failed last). */
  model?: string | null;
  startedAt: number;
  /** Pictures delivered. */
  pictures?: number;
}

function usageFields(s: Spent): AiEventUsage {
  return {
    model: s.model ?? null,
    latencyMs: Date.now() - s.startedAt,
    tokensIn: s.usage.in,
    tokensOut: s.usage.out,
    tokensThought: s.usage.thought,
    tokensCached: s.usage.cached,
    calls: s.usage.calls,
    pictures: s.pictures ?? 0,
    costMicros: s.usage.costMicros,
  };
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const adminPassword = deps.adminPassword;
  budgetStore = deps.aiBudget ?? null;
  loadedDay = '';
  loading = null;

  type Access =
    | { kind: 'admin'; actorId: string | null }
    | { kind: 'user'; userId: string; pro: boolean; live: boolean }
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
    const st = await deps.userState(userId, req);
    if (!st) return { kind: 'deny', status: 401, error: 'Sign in to use the AI Designer.', reason: 'signin' };
    if (!st.emailVerified) {
      return { kind: 'deny', status: 403, error: 'Verify your email to use the AI Designer.', reason: 'verify' };
    }
    return { kind: 'user', userId, pro: st.isPro, live: !!deps.pro && deps.pro.live(st.username ?? null) };
  };

  /**
   * The Pro allowances apply to this caller: a signed-in account Pro is on for
   * (PRO_MODE, PRO_PREVIEW_USERS). Not admins, and not an account on the old
   * paid flag (users.is_pro), which stays unlimited as before. Null: the old
   * hourly meter and daily shares rule, exactly as before Pro.
   */
  const proFor = async (a: Access): Promise<{ plan: PlanKind } | null> => {
    if (!deps.pro || a.kind !== 'user' || !a.live || a.pro) return null;
    return { plan: (await deps.pro.plan(a.userId)).plan };
  };
  const secsUntil = (iso: string): number => Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  /** An allowance in the shape the editor's quota line reads, old fields included. */
  const quotaFrom = (al: Allowance, plan: PlanKind) => ({
    admin: false,
    used: al.used,
    limit: al.limit,
    remaining: al.remaining,
    resetInSec: secsUntil(al.resetAt),
    live: true,
    kind: al.kind,
    period: al.period,
    resetAt: al.resetAt,
    plan,
  });
  /** The same allowance as it stands after a refund of one. */
  const refunded = (al: Allowance): Allowance => ({ ...al, used: Math.max(0, al.used - 1), remaining: Math.min(al.limit, al.remaining + 1) });

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
  //
  // Two more since round five, for Super AI's pictures:
  //  - picture: each picture asked of the image service (the second,
  //    bare-subject attempt included; one ask may try the backup provider
  //    too). They were metered by nothing but the provider's own credit
  //    breaker, so one account could spend the image credit the owner tops
  //    up himself.
  //  - uncharged: Super AI runs that come back without a picture are not
  //    charged to the hourly quota, by design (the user did not get what Super
  //    promises). With no limit on that, a run whose picture failed was free:
  //    50 runs from one free account cost 50 paid pictures and 50 model calls
  //    against AI_DAILY_BUDGET and used 0 of its 10 an hour (audit round five).
  //    After this many in a day, an incomplete run is charged like any other.
  const PREMIUM_SIDE_PER_DAY = { photo: 24, polish: 30, picture: 60, uncharged: 20 } as const;
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
  const note = (a: Access, mode: AiMode, outcome: AiOutcome, fail?: AiFailure, spent?: Spent): void => {
    const userId = a.kind === 'user' ? a.userId : a.kind === 'admin' ? a.actorId : null;
    void deps.aiEvents
      ?.record({
        userId,
        mode,
        outcome,
        via: a.kind === 'admin' ? 'password' : null,
        ...(fail ? { reason: fail.reason, detail: fail.status && !fail.detail.includes(String(fail.status)) ? `HTTP ${fail.status}: ${fail.detail}` : fail.detail } : {}),
        ...(spent ? usageFields(spent) : {}),
      })
      .catch(() => {});
  };
  /** The model id a tier resolves to on the main provider, for the operator's failure detail. */
  const modelOf = (): string => providerModel(activeProvider(), 'premium');
  /** Name the model in the operator's detail when the provider's text did not. */
  const withModel = (err: string, model: string): string =>
    model === 'default' || err.includes(model) ? err : `${err} (model ${model})`;
  /**
   * Why a provider call failed. When the fallback model failed too, the
   * reason is the FIRST model's (firstFailure); the operator's detail keeps
   * both answers.
   */
  const failureOf = (res: ProviderResult, otherwise: string, model: string): AiFailure => {
    const first = res.firstFailure;
    // The model that was asked, not the main tier's: during a Claude pause,
    // or after a fall back, that is Gemini.
    if (!first) return classifyAiFailure(withModel(res.error ?? otherwise, res.model ?? model), res.status);
    // Both providers' errors already name their model.
    const fail = classifyAiFailure(first.error, first.status);
    return { ...fail, detail: sanitizeDetail(res.error ?? first.error) };
  };
  const budgetFailure = (): AiFailure => ({
    reason: 'budget',
    detail: `AI_DAILY_BUDGET spent: ${DAILY_BUDGET} premium calls today; resets at 00:00 UTC`,
  });

  const isUnlimited = (a: Access): boolean => a.kind === 'admin' || (a.kind === 'user' && a.pro);
  /** May the caller use the premium model at all? freeForAll is the kill-switch. */
  const premiumAllowed = (a: Access): boolean =>
    a.kind === 'admin' || (a.kind === 'user' && (a.pro || deps.freeForAll));
  /** Free, instant offline ("Quick Designer") spec — never consumes a credit. The whole bowl, like every design. */
  const quickDesign = (prompt: string): ReturnType<typeof validateSpec> => validateSpec(composeSuperOffline(prompt));

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
    // A secret in the body and in a cookie: never stored, never rewritten or
    // recompressed on the way (performance plan P2.3; SECURITY-CHECKS.md).
    return reply.header('cache-control', 'no-store, no-transform').send({ token, expiresAt: new Date(exp).toISOString() });
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
    const pf = await proFor(access);
    if (pf && deps.pro) {
      const allowances = await deps.pro.allowances(access.userId, pf.plan);
      return { unlimited: false, ...quotaFrom(allowances.std, pf.plan), allowances, provider: activeProvider() };
    }
    const usage = await deps.aiUsage.get(access.userId, deps.freeLimit);
    return { unlimited: false, ...usage, resetInSec: secondsToNextPeriod(), provider: activeProvider() };
  });

  app.post('/api/ai/generate', deps.routeConfig ?? {}, async (req, reply) => {
    const startedAt = Date.now();
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

    // The client's stadium context: every design plans the whole bowl from it.
    // On a 13-row ground "hero in the top 60%, support below" is two words
    // nobody can read. `mode` no longer picks a pipeline — there is one, the
    // director's — it only says which allowance the design is metered on.
    const stadium = typeof body.stadium === 'string' ? body.stadium.slice(0, 2000) : undefined;
    const engine = body.engine === 'offline' ? 'offline' : 'auto';
    const userId = access.kind === 'user' ? access.userId : null;
    const unlimited = isUnlimited(access);
    // Pro's allowances, when they apply; otherwise the hourly meter.
    const pf = await proFor(access);
    let allowance: Allowance | null = pf && userId && deps.pro ? await deps.pro.allowance(userId, mode0, pf.plan) : null;
    const usage = userId && !unlimited && !pf ? await deps.aiUsage.get(userId, deps.freeLimit) : null;
    const quotaInfo = allowance && pf
      ? quotaFrom(allowance, pf.plan)
      : usage
        ? { admin: false, used: usage.used, limit: usage.limit, remaining: usage.remaining, resetInSec: secondsToNextPeriod() }
        : { admin: true, used: 0, limit: 0, remaining: 999999, resetInSec: 0 };

    // Quick Designer: free, instant offline engine — the user's explicit choice, or
    // used automatically when premium is switched off. Never consumes a credit.
    if (engine === 'offline' || !premiumAllowed(access)) {
      const q = quickDesign(prompt);
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
    const key = cacheKey('gen', mode0, prompt, stadium, activeProvider());
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

    // Pro: one of the allowance is taken NOW, before any model is asked, so
    // two requests racing for the last Super design cannot both have it. It
    // is handed back (finally, below) unless a design is delivered and charged.
    let ticket: Ticket | null = null;
    let keepTicket = false;
    if (pf && userId && deps.pro) {
      const t = await deps.pro.take(userId, mode0, pf.plan);
      allowance = t.allowance;
      if (!t.ok) {
        note(access, mode0, 'quota');
        return reply.code(200).send({
          needsChoice: true, reason: 'quota', kind: mode0, plan: pf.plan,
          retryAfterSec: secsUntil(t.allowance.resetAt), quota: quotaFrom(t.allowance, pf.plan),
        });
      }
      ticket = t.ticket;
    }
    try {

      // Daily circuit breaker: budget spent → route to the Quick Designer instead of
      // burning the provider's daily quota. Same "choice" UX, no error shown.
      await budgetReady();
      if (premiumExhausted()) {
        note(access, mode0, 'busy', budgetFailure());
        return reply.code(200).send({ needsChoice: true, reason: 'busy', cause: publicCause('budget'), retryAfterSec: busyRetrySec(), quota: quotaInfo });
      }

      // Try the premium model (counts against the daily budget).
      notePremiumCall();
      // The club hint is a pure function of `prompt`, so the result-cache key above
      // stays correct without mentioning it.
      const hint = clubHintLine(prompt);
      // Every provider call this request makes, failed ones included: the row in
      // ai_events carries the total, which is what the request cost.
      let spent: TokenUsage = zeroUsage();

      // Stage 1: the copywriter picks the WORDS before anything is laid out. A
      // hero phrase is what decides whether a stand can be filled at all, and a
      // model choosing words while already reasoning about regions reliably
      // picks the club's legal name or the brief verbatim. Best-effort: a
      // failure or a disabled stage just means the director designs from the
      // raw brief. Costs a fraction of a cent on the fast tier.
      const wantsCopy = process.env.AI_COPYWRITER !== '0';
      const copy = wantsCopy ? await writeCopy(prompt, hint, (u) => { spent = addUsage(spent, u); }).catch(() => null) : null;
      const brief = copy ? `${prompt}\n\n${copyLine(copy)}` : prompt;

      // Stage 2: the director plans the whole bowl, on the premium tier. There
      // used to be a cheaper single-stand designer for requests without
      // mode: "super"; a tifo is the whole stadium, so every design is this one.
      const modelResult = await generateSpecViaProvider(brief, { system: buildDirectorPrompt(), context: stadium, tier: 'premium', hint });
      spent = addUsage(spent, modelResult.usage);
      if (modelResult.fellBackFrom) {
        app.log.info({ mode: mode0, from: modelResult.fellBackFrom, to: modelResult.model }, 'ai generate: answered by the fallback model');
      }
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
              detail: sanitizeDetail(`${modelResult.model ?? modelOf()}: spec failed validation: ${(r.errors ?? []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`),
            }
          : failureOf(modelResult, 'the model did not answer', modelOf());
        app.log.warn(
          {
            reason: fail.reason,
            detail: fail.detail,
            mode: mode0,
            model: modelResult.model ?? modelOf(),
            provider: modelResult.provider ?? activeProvider(),
          },
          'ai generate: premium could not deliver',
        );
        note(access, mode0, 'busy', fail, { usage: spent, model: modelResult.model, startedAt });
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
      // A premium design's whole promise is a picture on the bowl. The director
      // is told to make one the hero and usually does, but a design that came
      // back with only symbols and fills is a Quick Designer result charged as
      // premium. So the guarantee is structural, not a request in a prompt.
      {
        const club = matchClub(prompt.toLowerCase());
        const hero = ensureHeroImage(spec, { brief: prompt, crest: club?.crest });
        spec = hero.spec;
        if (hero.via !== 'present') {
          app.log.info({ via: hero.via, mode: mode0 }, 'ai generate: hero picture guaranteed');
        }
      }
      // A design gets at most one picture per stand. The director is asked for a
      // hero picture on its own stand; a brief written to get twenty image layers
      // got twenty (and up to forty paid picture requests) from one run (audit
      // round five). Any beyond that are left out of the design.
      const pictures = spec.layers.filter((l) => l.kind === 'image' && !l.assetRef);
      if (pictures.length > MAX_PICTURES_PER_DESIGN) {
        const drop = new Set(pictures.slice(MAX_PICTURES_PER_DESIGN));
        spec = { ...spec, layers: spec.layers.filter((l) => !drop.has(l)) };
        app.log.info({ mode: mode0, asked: pictures.length, kept: MAX_PICTURES_PER_DESIGN }, 'ai generate: extra picture layers left out');
      }
      // Phase 5: best-effort picture for each image layer; failures just skip the layer.
      const notes: string[] = [];
      let wanted = 0;
      let missed = 0;
      let delivered = 0;
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
          // Each request to the image provider is one of the account's daily
          // pictures, and one of the site's (AI_DAILY_PICTURE_BUDGET). A spent
          // share is reported like a rate limit, so the bare-subject second
          // attempt is not made either.
          const draw = async (p: string): Promise<ImageResult> => {
            if (!takeSide(access, 'picture', 1)) return { url: null, error: "this account's pictures for today are used up", kind: 'rate' };
            if (!takePicture()) return { url: null, error: `AI_DAILY_PICTURE_BUDGET spent: ${pictureBudget()} pictures today; resets at 00:00 UTC`, kind: 'rate' };
            const got = await generateImage(p, style).catch((e) => ({ url: null, error: String(e) }) as ImageResult);
            if (got.url) {
              delivered++;
              spent = addCostMicros(spent, pictureCostMicros(got.provider, got.model));
            }
            return got;
          };

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
      note(
        access, mode0, 'model',
        degraded ? { reason: 'picture_failed', detail: sanitizeDetail(`${missed} of ${wanted}: ${firstFailure ?? 'unknown error'}`) } : undefined,
        { usage: spent, model: modelResult.model, startedAt, pictures: delivered },
      );
      // An incomplete run is free only while the account's daily allowance of
      // free incomplete runs lasts (see PREMIUM_SIDE_PER_DAY.uncharged).
      const charged = (!!(usage && userId) || !!ticket) && (!degraded || !takeSide(access, 'uncharged', 1));
      let quota = quotaInfo;
      if (ticket && allowance && pf) {
        // Pro: the use was taken up front; keep it only if this is charged.
        keepTicket = charged;
        quota = quotaFrom(charged ? allowance : refunded(allowance), pf.plan);
      } else if (charged && userId) {
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
    } finally {
      // Anything but a charged delivery (busy, a failed model, an error thrown
      // anywhere above) gives the use back.
      if (ticket && !keepTicket && userId && deps.pro) await deps.pro.giveBack(userId, ticket).catch(() => {});
    }
  });

  // Phase 4b: vision critique — take the current design + a render of it, ask the
  // model to fix legibility/balance, and return an improved spec. Best-effort: any
  // failure returns the ORIGINAL design unchanged, so polish never breaks a design.
  app.post('/api/ai/critique', deps.routeConfig ?? {}, async (req, reply) => {
    const startedAt = Date.now();
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
    // What the critic spent, when it ran.
    let spent: Spent | undefined;
    // Pro: a Polish from the account's allowance, taken before the call and
    // handed back if the critic does not deliver.
    const pf = await proFor(access);
    let ticket: Ticket | null = null;
    /** The Polish allowance after this one was taken, for the editor's count. */
    let polishLeft: Allowance | null = null;
    await budgetReady();
    if (pf && access.kind === 'user' && deps.pro && activeProvider() !== 'none' && !premiumExhausted()) {
      const t = await deps.pro.take(access.userId, 'polish', pf.plan);
      if (!t.ok) {
        note(access, 'polish', 'quota');
        return reply.code(200).send({ spec, source, notes, reason: 'quota', kind: 'polish', plan: pf.plan, quota: quotaFrom(t.allowance, pf.plan) });
      }
      ticket = t.ticket;
      polishLeft = t.allowance;
    }
    if (activeProvider() === 'none') {
      failed = { reason: 'no_provider', detail: 'no AI provider configured' };
    } else if (premiumExhausted() || (!pf && !takeSide(access, 'polish', 1))) {
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
      const res = await critiqueSpecViaProvider(slim, image, stadium).catch(async (e) => {
        if (ticket && access.kind === 'user' && deps.pro) await deps.pro.giveBack(access.userId, ticket).catch(() => {});
        throw e;
      });
      spent = { usage: res.usage ?? zeroUsage(), model: res.model, startedAt };
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
          : failureOf(res, 'invalid response', modelOf());
      }
    }
    if (failed) {
      // A failed critic leaves the design exactly as it was, and the
      // provider's words stay on the server.
      note(access, 'polish', 'busy', failed, spent);
      if (ticket && access.kind === 'user' && deps.pro) await deps.pro.giveBack(access.userId, ticket).catch(() => {});
      return reply.code(200).send({
        spec, source, notes, cause: publicCause(failed.reason),
        ...(pf && polishLeft ? { quota: quotaFrom(refunded(polishLeft), pf.plan) } : {}),
      });
    }
    // Successes are recorded too (from October 2026): without them a Polish
    // failure rate, or what Polish costs, had no denominator.
    note(access, 'polish', 'model', undefined, spent);
    return reply.code(200).send({ spec, source, notes, ...(pf && polishLeft ? { quota: quotaFrom(polishLeft, pf.plan) } : {}) });
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
    const startedAt = Date.now();
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
    const pf = await proFor(access);
    await budgetReady();
    if (premiumExhausted() || (!pf && !takeSide(access, 'photo', samples))) {
      note(access, 'photo', 'busy', budgetFailure());
      return reply.code(503).send({ error: 'premium AI is resting for today, try again tomorrow', reason: 'busy', retryAfterSec: busyRetrySec() });
    }
    // Pro: one photo import from the allowance (however many readings it takes).
    let ticket: Ticket | null = null;
    if (pf && access.kind === 'user' && deps.pro) {
      const t = await deps.pro.take(access.userId, 'photo', pf.plan);
      if (!t.ok) {
        note(access, 'photo', 'quota');
        return reply.code(429).send({ error: 'photo imports used up for now', reason: 'quota', kind: 'photo', plan: pf.plan, quota: quotaFrom(t.allowance, pf.plan) });
      }
      ticket = t.ticket;
    }
    const giveBack = async (): Promise<void> => {
      if (ticket && access.kind === 'user' && deps.pro) await deps.pro.giveBack(access.userId, ticket).catch(() => {});
    };
    notePremiumCall(samples);
    const read = await readGroundPhoto(image, samples).catch(async (e) => { await giveBack(); throw e; });
    const { usage: readUsage, model: readModel, failure: readFailure, ...out } = read;
    const spent: Spent = { usage: readUsage, model: readModel, startedAt };
    // Every reading failed: that is an upstream problem, not an empty photo.
    if (!out.vote.samples) {
      const fail = classifyAiFailure(readFailure?.error ?? out.errors[0] ?? 'the model did not answer', readFailure?.status);
      if (readFailure && out.errors[0]) fail.detail = sanitizeDetail(out.errors[0]);
      if (out.errors.length > 1) fail.detail = sanitizeDetail(`${fail.detail} (${out.errors.length} readings failed)`);
      note(access, 'photo', 'busy', fail, spent);
      await giveBack();
      // The provider's text used to ride back in `error` and `errors`.
      return reply.code(502).send({ error: 'the model did not answer', reason: 'busy', cause: publicCause(fail.reason) });
    }
    // Recorded from October 2026, so photo reading has a success rate and a cost.
    note(access, 'photo', 'model', undefined, spent);
    // Readings that failed while others succeeded are the operator's business,
    // and so are the tokens: neither goes back to the browser.
    return reply.code(200).send({ ...out, errors: [] });
  });

  // Smart cut-out (Pro, cutout.ts): the subject of a photo lifted out as a
  // transparent PNG, for a picture the person is about to place. Only where
  // Pro is on (an admin, or an account PRO_MODE covers): a free account takes
  // it from its weekly allowance of 1, a pass from its ceilings. The picture
  // is checked here before anything is spent or sent anywhere.
  const cutoutDay = { day: '', n: 0 };
  const takeSiteCutout = (): boolean => {
    const day = new Date().toISOString().slice(0, 10);
    if (cutoutDay.day !== day) { cutoutDay.day = day; cutoutDay.n = 0; }
    if (cutoutDay.n >= envNum('AI_DAILY_CUTOUT_BUDGET', 200, 0)) return false;
    cutoutDay.n++;
    return true;
  };
  const giveSiteCutout = (): void => { if (cutoutDay.n > 0) cutoutDay.n--; };
  const CUTOUT_BODY = Math.ceil((MAX_CUTOUT_BYTES * 4) / 3) + 4096;
  app.post('/api/ai/cutout', { ...(deps.routeConfig ?? {}), bodyLimit: CUTOUT_BODY }, async (req, reply) => {
    const startedAt = Date.now();
    const access = await baseAccess(req);
    if (access.kind === 'deny') {
      return reply.code(access.status).send({ error: access.error, reason: access.reason, locked: true });
    }
    const pf = await proFor(access);
    // Hidden where Pro is off: the same answer as a route that does not exist.
    if (access.kind === 'user' && !pf && !(access.pro && access.live)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as { image?: unknown };
    const m = typeof b.image === 'string' ? /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(b.image) : null;
    if (!m) return reply.code(400).send({ error: 'image must be a PNG or JPEG data URL' });
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > MAX_CUTOUT_BYTES) return reply.code(413).send({ error: 'that picture is too large' });
    const sniffed = sniffImage(bytes);
    if (bytes.length < 64 || sniffed !== (m[1] === 'png' ? 'png' : 'jpeg')) {
      return reply.code(400).send({ error: 'that is not a PNG or JPEG picture' });
    }
    if (!cutoutConfigured()) {
      note(access, 'cutout', 'busy', { reason: 'no_provider', detail: 'smart cut-out: AI_CLOUDFLARE_ACCOUNT_ID / AI_CLOUDFLARE_API_TOKEN not set, or AI_CUTOUT=off' });
      return reply.code(503).send({ error: 'smart cut-out is not available right now', reason: 'unavailable' });
    }
    // Allowance first, then the site's daily cap; each is given back if the
    // cut-out does not come.
    let ticket: Ticket | null = null;
    let allowance: Allowance | null = null;
    if (pf && access.kind === 'user' && deps.pro) {
      const t = await deps.pro.take(access.userId, 'cutout', pf.plan);
      if (!t.ok) {
        note(access, 'cutout', 'quota');
        return reply.code(429).send({ error: 'smart cut-outs used up for now', reason: 'quota', kind: 'cutout', plan: pf.plan, quota: quotaFrom(t.allowance, pf.plan) });
      }
      ticket = t.ticket;
      allowance = t.allowance;
    }
    const giveBack = async (): Promise<void> => {
      if (ticket && access.kind === 'user' && deps.pro) await deps.pro.giveBack(access.userId, ticket).catch(() => {});
    };
    if (!takeSiteCutout()) {
      await giveBack();
      note(access, 'cutout', 'busy', { reason: 'budget', detail: `AI_DAILY_CUTOUT_BUDGET spent: ${envNum('AI_DAILY_CUTOUT_BUDGET', 200, 0)} cut-outs today; resets at 00:00 UTC` });
      return reply.code(503).send({ error: 'smart cut-out is resting for today', reason: 'busy', cause: publicCause('budget') });
    }
    const r = await cutoutPicture(bytes).catch((e) => ({ ok: false as const, kind: 'provider' as const, error: String(e) }));
    if (!r.ok) {
      await giveBack();
      giveSiteCutout();
      const reason: AiFailure['reason'] =
        r.kind === 'config' ? 'auth' : r.kind === 'credit' ? 'rate_limited' : r.kind === 'refused' ? 'safety' : r.kind === 'timeout' ? 'timeout' : 'upstream_error';
      note(access, 'cutout', 'busy', { reason, detail: sanitizeDetail(r.error) }, { usage: { ...zeroUsage(), calls: 1, costMicros: 0 }, model: CUTOUT_MODEL, startedAt });
      return reply.code(502).send({ error: 'the cut-out did not come', reason: r.kind === 'refused' ? 'refused' : 'busy', cause: publicCause(reason) });
    }
    note(access, 'cutout', 'model', undefined, {
      usage: { ...zeroUsage(), calls: 1, costMicros: Math.round(CUTOUT_PRICE_USD * 1e6) },
      model: CUTOUT_MODEL,
      startedAt,
      pictures: 1,
    });
    return reply.code(200).send({
      image: `data:image/png;base64,${r.png.toString('base64')}`,
      quota: pf && allowance ? quotaFrom(allowance, pf.plan) : null,
    });
  });
}
