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

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AiEventsRepository, AiOutcome, AiUsageRepository } from './repo';
import { secondsToNextPeriod } from './repo';
import { validateSpec, narrowToSingleStand, regionAspectHint, regionRowsHint, type TifoSpec } from '../../src/core/tifoSpec';
import { refineSpec } from '../../src/core/specRefine';
import { designFromPrompt, composeSuperOffline } from '../../src/core/promptDesigner';
import { generateSpecViaProvider, buildDirectorPrompt, critiqueSpecViaProvider, activeProvider, clubHintLine, writeCopy, copyLine } from './aiProvider';
import { generateImage } from './imageAssets';
import { envNum } from './env';
import { TtlCache, cacheKey } from './aiCache';
import { screenPrompt } from './promptSafety';

const MAX_PROMPT = 400;
const PREMIUM_RETRY_SEC = 90; // "wait and retry" countdown when premium is busy
const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
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
function notePremiumCall(): void {
  rollPremiumDay();
  premiumCount += 1;
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

/** Sign an unlock token: "<exp>.<hmac>", keyed by the admin password. */
function signUnlock(secret: string, exp: number): string {
  const sig = createHmac('sha256', secret).update(`ai-admin:${exp}`).digest('hex');
  return `${exp}.${sig}`;
}

/** Verify an unlock token against the current password (and its expiry). */
export function verifyUnlock(secret: string, token: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(`ai-admin:${exp}`).digest('hex');
  return safeEqual(token.slice(dot + 1), expected);
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const adminPassword = deps.adminPassword;

  type Access =
    | { kind: 'admin' }
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
    if (typeof tok === 'string' && adminPassword && verifyUnlock(adminPassword, tok)) return { kind: 'admin' };
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

  /** Unlimited use: admins and paid accounts. Everyone else is metered hourly. */
  /**
   * Write down what happened. Best-effort in the strongest sense: a telemetry
   * failure must never turn into a failed generation, so this is never awaited
   * and never throws.
   */
  const note = (userId: string | null, mode: 'std' | 'super', outcome: AiOutcome): void => {
    void deps.aiEvents?.record({ userId, mode, outcome }).catch(() => {});
  };

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
    return { token: signUnlock(adminPassword, exp), expiresAt: new Date(exp).toISOString() };
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
    const who0 = access.kind === 'user' ? access.userId : null;
    if (!prompt) { note(who0, mode0, 'invalid'); return reply.code(400).send({ error: 'a prompt is required' }); }
    if (prompt.length > MAX_PROMPT) {
      note(who0, mode0, 'invalid');
      return reply.code(400).send({ error: `prompt too long (max ${MAX_PROMPT} characters)` });
    }
    // First-line safety screen — block clearly-harmful prompts before the model.
    const safe = screenPrompt(prompt);
    if (!safe.ok) { note(who0, mode0, 'blocked'); return reply.code(400).send({ error: safe.message, reason: 'blocked' }); }

    // Mode 3 (Super AI): whole-bowl director prompt + the client's stadium context.
    const isSuper = body.mode === 'super';
    const stadium = isSuper && typeof body.stadium === 'string' ? body.stadium.slice(0, 2000) : undefined;
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
        note(userId, mode0, 'invalid');
        return reply.code(502).send({ error: 'could not produce a valid design', errors: q.errors });
      }
      note(userId, mode0, 'quick');
      return reply.code(200).send({ spec: refineSpec(q.spec), quota: quotaInfo, source: 'quick', notes: [] });
    }

    // Result cache: an identical brief returns the prior premium design instantly (free).
    const key = cacheKey('gen', isSuper ? 'super' : 'std', prompt, stadium, activeProvider());
    const hit = genCache.get(key);
    if (hit) {
      note(userId, mode0, 'cache');
      return reply.code(200).send({ spec: hit.spec, quota: quotaInfo, source: hit.source, notes: ['Served instantly from cache.'] });
    }

    // Hourly cap reached → offer the choice (Quick Designer now, or wait for reset).
    if (usage && usage.remaining <= 0) {
      note(userId, mode0, 'quota');
      return reply.code(200).send({ needsChoice: true, reason: 'quota', retryAfterSec: secondsToNextPeriod(), quota: quotaInfo });
    }

    // Daily circuit breaker: budget spent → route to the Quick Designer instead of
    // burning the provider's daily quota. Same "choice" UX, no error shown.
    if (premiumExhausted()) {
      note(userId, mode0, 'busy');
      return reply.code(200).send({ needsChoice: true, reason: 'busy', retryAfterSec: busyRetrySec(), quota: quotaInfo });
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
      isSuper ? { system: buildDirectorPrompt(), context: stadium, tier: 'premium', hint } : { tier: 'fast', hint },
    );
    const r = modelResult.spec ? validateSpec(modelResult.spec) : ({ valid: false } as ReturnType<typeof validateSpec>);
    if (!r.valid || !r.spec) {
      // Premium couldn't deliver — we don't admit failure; the client offers a choice
      // (use the free Quick Designer now, or wait out a short timer and retry).
      //
      // The user sees "busy", but the OPERATOR needs the real reason: a bad model
      // id, a key without access to that model, a timeout and a spec the
      // validator rejected all look identical from the outside, and this error
      // used to be computed and thrown away.
      app.log.warn(
        {
          reason: modelResult.error ?? 'spec failed validation',
          errors: modelResult.spec ? r.errors : undefined,
          mode: mode0,
          model: isSuper ? (process.env.AI_MODEL_PREMIUM ?? process.env.AI_MODEL ?? 'default') : (process.env.AI_MODEL_FAST ?? process.env.AI_MODEL ?? 'default'),
          provider: activeProvider(),
        },
        'ai generate: premium could not deliver',
      );
      note(userId, mode0, 'busy');
      // An ADMIN gets the real reason in the reply. "Busy" is the right message
      // for a visitor — it is honest about what they should do and gives nothing
      // away — but it is useless to the person who has to fix it, who would
      // otherwise be reading deploy logs to find out that a model id is wrong or
      // an env var is quoted. Never sent to a normal user.
      const detail = access.kind === 'admin'
        ? (modelResult.error ?? `spec failed validation: ${(r.errors ?? []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`)
        : undefined;
      return reply.code(200).send({ needsChoice: true, reason: 'busy', retryAfterSec: busyRetrySec(), quota: quotaInfo, ...(detail ? { detail } : {}) });
    }

    // Premium succeeded — the ONLY path that consumes a credit.
    let quota = quotaInfo;
    if (usage && userId) {
      const c = await deps.aiUsage.consume(userId, deps.freeLimit);
      quota = { admin: false, used: c.used, limit: c.limit, remaining: c.remaining, resetInSec: secondsToNextPeriod() };
    }
    note(userId, mode0, 'model');

    // Phase 4: deterministic art-director pass — fix legibility/contrast/field.
    const spec = refineSpec(r.spec);
    // Phase 5: best-effort picture for each image layer; failures just skip the layer.
    const notes: string[] = [];
    for (const layer of spec.layers) {
      if (layer.kind === 'image' && !layer.assetRef) {
        // Tell the generator what it is drawing FOR: the shape of the region the
        // picture has to fill, and the palette it is about to be quantized into.
        // Without both it returns a square in arbitrary colours, and the client
        // then destroys it snapping to the design's palette.
        const region = narrowToSingleStand(layer.region);
        const img = await generateImage(layer.prompt, {
          aspect: regionAspectHint(region),
          palette: spec.palette,
          rows: regionRowsHint(region),
        }).catch((e) => ({ url: null, error: String(e) }) as { url: null; error: string });
        if (img.url) layer.assetRef = img.url;
        else notes.push(`Portrait not generated: ${img.error ?? 'unknown error'}`);
      }
    }
    genCache.set(key, { spec, source: 'model' });
    return reply.code(200).send({ spec, quota, source: 'model', notes });
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
    if (activeProvider() === 'none') {
      notes.push('No AI provider configured: design left unchanged.');
    } else {
      // Portrait assetRefs are huge base64 data URLs; the critic sees the rendered
      // image, so send a SLIM spec (assetRef removed) — otherwise the prompt
      // balloons and the model's JSON reply truncates. Re-attach originals after.
      const origImages = incoming.spec.layers.filter((l) => l.kind === 'image');
      const slim = {
        ...incoming.spec,
        layers: incoming.spec.layers.map((l) => (l.kind === 'image' ? { ...l, assetRef: undefined } : l)),
      };
      const res = await critiqueSpecViaProvider(slim, image, stadium);
      const improved = res.spec ? validateSpec(res.spec) : null;
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
        notes.push(`Critique unavailable: ${res.error ?? 'invalid response'}: design left unchanged.`);
      }
    }
    return reply.code(200).send({ spec, source, notes });
  });
}
