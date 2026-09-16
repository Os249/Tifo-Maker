import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { dummyHash, hashPassword, hashToken, issueToken, TOKEN_TTL_MS, verifyPassword } from './auth';
import { gunzipBytes, gzipBytes, u32FromB64, u8FromB64 } from './codec';
import { generateSeatMap } from '../../src/core/seatmap';
import { TEMPLATES } from '../../src/core/template';
import { validateTifo, TIFO_SCHEMA_VERSION } from '../../src/core/tifoFormat';
import { renderDistributionPdf } from '../../src/export/distributionPdf';

import { tmpdir } from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import type { AiEventsRepository, AiUsageRepository, AuthRepository, DesignRepository, EventsRepository, LeadsRepository, SocialRepository } from './repo';
import { registerAiRoutes, verifyUnlock } from './aiRoutes';
import { emailHealth, type EmailSender } from './email';
import type { StadiumSubmissionRepository } from './stadiumRepo';
import type { AdminStatsRepository } from './statsRepo';
import { buildVisit, isSocialHost, type TrafficRepository } from './trafficRepo';
import { isFeedbackKind, type FeedbackContext, type FeedbackRepository } from './feedbackRepo';
import { adminHtml, ADMIN_JS, ADMIN_UNLOCK_JS } from './adminPage';
import { isValidTemplate } from '../../src/core/customStadiums';
import { clubFilterOptions, COLOUR_FAMILIES, designFacets } from '../../src/core/facets';

/**
 * HTTP surface (blueprint §2.2, completed with auth + gallery):
 *
 *   GET   /health
 *   POST  /api/auth/register               { username, password } → { token, username }
 *   POST  /api/auth/login                  { username, password } → { token, username }
 *   POST  /api/auth/logout                 (bearer)
 *   GET   /api/me                          (bearer) → { id }
 *   GET   /api/templates
 *   GET   /api/gallery                     public designs + owner names
 *   GET   /api/designs                     (bearer) caller's designs
 *   POST  /api/designs                     (bearer) create; optional thumbnailPngB64
 *   GET   /api/designs/:id                 public OR owner
 *   PUT   /api/designs/:id                 owner; full snapshot save
 *   PATCH /api/designs/:id                 owner; { title?, isPublic? }
 *   GET   /api/designs/:id/thumbnail.png   public OR owner
 *   POST  /api/designs/:id/revisions       owner; SparseDiff append
 *   GET   /api/designs/:id/revisions       public OR owner
 *   POST  /api/designs/:id/fork            (bearer) source must be visible
 *
 * Visibility rule: a private design is a 404 to non-owners (existence is not
 * leaked); mutations on a visible-but-not-owned design are 403.
 */

export const SNAPSHOT_EVERY = 20;
const HEX = /^#[0-9a-fA-F]{6}$/;
const USERNAME = /^[a-zA-Z0-9_]{3,24}$/;
/** Longest design title anywhere. PATCH already enforced this; create, fork and
 *  remix did not, so a title could be as large as the 1MB body allowed - and it
 *  is echoed into page <title> and OG tags on every share page. */
const MAX_TITLE = 120;
const cleanTitle = (v: unknown, fallback: string): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  return (t || fallback).slice(0, MAX_TITLE);
};
// Pragmatic email check; real validation is delivery of the verification email.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_THUMB_BYTES = 128 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // real photos, resized client-side before upload
// A full 60k design gzips to a few hundred bytes, but base64 of (cells + a
// thumbnail PNG up to 128KB) can approach ~200KB. 1MB gives generous headroom
// while still capping the request body as an abuse ceiling.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The 404 page. Deliberately a self-contained string: the site CSP forbids inline
 * <script> and external origins, and a 404 must render even if the build output is
 * missing, so it carries no scripts and no asset references at all.
 */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>الصفحة غير موجودة · Page not found · TifoMaker</title>
<style>
  :root{ color-scheme: dark; }
  body{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
        background:#0d1117; color:#e6edf3; text-align:center; padding:24px;
        font:16px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  .n{ font-size:64px; font-weight:800; letter-spacing:-.03em; margin:0; color:#3fb950; }
  h1{ font-size:20px; margin:12px 0 8px; font-weight:600; }
  p{ margin:0 0 24px; color:#8b949e; max-width:32rem; }
  a{ display:inline-block; margin:0 6px; padding:10px 18px; border-radius:8px;
     border:1px solid #2a323d; color:#e6edf3; text-decoration:none; font-size:14px; }
  a.p{ background:#3fb950; border-color:#3fb950; color:#04220e; font-weight:600; }
  a:hover{ border-color:#3d4754; }
  .c{ margin:28px 0 0; font-size:13px; color:#7b8592; } /* #6b7480 was 4.00:1 on this ground */
  .c a{ display:inline; margin:0; padding:0; border:0; color:#58a6ff; text-decoration:underline; }
  .c a:hover{ color:#79b8ff; }
</style>
</head>
<body>
  <main>
    <p class="n">404</p>
    <!-- Server-rendered, so there is no client i18n here and no way to know the
         visitor's language. Both languages ship, Arabic first. -->
    <h1 dir="rtl" lang="ar">هذي الصفحة ما هي موجودة</h1>
    <p dir="rtl" lang="ar">يمكن الرابط مكسور، أو التصميم انحذف أو صار خاص.</p>
    <h1 lang="en">This page does not exist</h1>
    <p lang="en">The link may be broken, or the design may have been deleted or made private.</p>
    <a class="p" href="/app">افتح المحرر · Open the editor</a>
    <a href="/">الرئيسية · Go home</a>
    <a href="/community">المجتمع · Browse community</a>
    <p class="c">تابعت رابط المفروض يشتغل؟
      <a href="https://x.com/OS99GameDev" target="_blank" rel="noopener noreferrer">بلّغ المطوّر</a>.
      شخص واحد يبني هذا الموقع، فالرسالة توصله مباشرة.<br />
      Followed a link that should have worked?
      <a href="https://x.com/OS99GameDev" target="_blank" rel="noopener noreferrer">Tell the developer</a>.
      One person builds this, so it goes straight to him.</p>
  </main>
</body>
</html>`;

export interface TemplateInfo {
  id: string;
  version: number;
  name: string;
  seatCount: number;
}

export interface AppOptions {
  /** Absolute path to the built frontend (dist/) to serve. Omit for API-only. */
  staticDir?: string;
  /** Enable rate limiting (off in tests to avoid throttling the suite). */
  rateLimit?: boolean;
  /** Fastify request logging. */
  logger?: boolean;
  /** Optional anonymous-analytics sink. When absent, event endpoints no-op. */
  events?: EventsRepository;
  /** Usernames with moderator privileges (from ADMIN_USERNAMES). Case-insensitive. */
  adminUsernames?: string[];
  /** Optional social layer (follows, comments, remix lineage, notifications). */
  social?: SocialRepository;
  /** Optional B2B leads store (For Clubs enterprise form). */
  leads?: LeadsRepository;
  /** AI Tifo Designer quota store. When present, the /api/ai/* routes are enabled. */
  aiUsage?: AiUsageRepository;
  aiEvents?: AiEventsRepository;
  /** Free AI generations per account (default 5). */
  aiFreeLimit?: number;
  /** Optional community stadium submissions store. When present, /api/stadiums/* is enabled. */
  stadiums?: StadiumSubmissionRepository;
  /** Optional admin analytics aggregates. When present, /api/admin/overview is enabled. */
  stats?: AdminStatsRepository;
  /** Optional cookieless traffic-source store. When present, /api/admin/traffic is enabled. */
  traffic?: TrafficRepository;
  /** Optional in-product bug/idea store. When present, /api/feedback is enabled. */
  feedback?: FeedbackRepository;
  /** Transactional email sender (verification, password reset). When absent, emails are skipped. */
  emailSender?: EmailSender;
  /** Where in-product feedback is emailed. Unset means store-only. */
  feedbackTo?: string;
  /** Public base URL for links in emails. Defaults to the request's own origin. */
  publicUrl?: string;
  /**
   * How long after a verification email goes out before another may be sent to
   * the same account. Defaults to a minute; tests shorten it rather than wait.
   */
  verifyResendCooldownMs?: number;
}

export async function buildApp(
  repo: DesignRepository,
  auth: AuthRepository,
  templates: TemplateInfo[],
  options: AppOptions = {},
): Promise<FastifyInstance> {
  // Behind a reverse proxy, req.ip must come from X-Forwarded-For or EVERY request
  // looks like it came from the proxy — which silently collapses per-IP rate limiting
  // into a single global bucket (one abuser then locks out the whole site) and makes
  // visitor counting meaningless. But trusting the header when there is NO proxy lets
  // anyone spoof their address, so this is deliberately explicit:
  //   TRUST_PROXY=0  → never trust (direct exposure)
  //   TRUST_PROXY=<n> → trust n proxy hops: 1 = Railway alone, 2 = Cloudflare → Railway
  //   unset          → on in production (Railway always terminates at its edge), off in dev/tests
  const tp = process.env.TRUST_PROXY;
  // Hop COUNT, never `true`. `true` trusts every hop, which makes req.ip the
  // leftmost X-Forwarded-For entry - a value the caller writes - so rotating one
  // header defeated every rate limit and poisoned the visitor hashing. Expressed
  // as the predicate Fastify uses internally for a numeric setting: trust the
  // first n addresses from the socket inward, and nothing beyond them.
  const hops =
    tp === '0' ? 0
      : tp && /^\d+$/.test(tp) ? Number(tp)
        : tp === undefined ? (process.env.NODE_ENV === 'production' ? 1 : 0)
          : 1;
  const trustProxy: boolean | ((addr: string, hop: number) => boolean) =
    hops === 0 ? false : (_addr: string, hop: number) => hop < hops;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_BODY_BYTES, trustProxy });

  // An empty body is not broken JSON.
  //
  // Fastify's JSON parser rejects a request that says `content-type:
  // application/json` and then sends no body. It answers 400
  // FST_ERR_CTP_EMPTY_JSON_BODY before any route runs. The browser client did
  // exactly that for every action with nothing to send: resend the
  // verification email, dismiss a report, take a design down, delete a photo.
  // In production every one of those answered 400 and never reached its
  // handler, so "Resend" sent no email at all. The route tests never saw it
  // because app.inject sends no content-type unless it is given a payload.
  //
  // Every handler already reads `req.body ?? {}`, so an empty body now means
  // the same as no body. A body that IS there still goes through Fastify's own
  // parser, with the same proto/constructor poisoning rules as before.
  {
    const { onProtoPoisoning, onConstructorPoisoning } = app.initialConfig;
    const strictJson = app.getDefaultJsonParser(onProtoPoisoning ?? 'error', onConstructorPoisoning ?? 'error');
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text.length === 0) {
        done(null, undefined);
        return;
      }
      strictJson(req, text, done);
    });
  }

  // Security headers, including a real Content-Security-Policy. The policy is a
  // strict allow-list derived from exactly what the pages load:
  //  - script-src 'self'           — all scripts are external ES modules; NO inline
  //                                  <script>, so an injected <script> simply won't run.
  //                                  This is the primary defense-in-depth against XSS.
  //  - style-src 'self' + inline   — the app injects its theme CSS via JS and uses a
  //                                  couple of inline style= attributes; 'unsafe-inline'
  //                                  for *styles* is low-risk (style injection ≠ script
  //                                  execution). Google Fonts + jsDelivr ship CSS too.
  //  - font-src                    — Google Fonts + the Tabler icons webfont (jsDelivr).
  //  - img-src 'self' data:        — thumbnails and the generated QR PNGs are data: URIs.
  //  - connect-src 'self'          — the app only talks to its own origin (no CORS).
  //  - object-src 'none', frame-ancestors 'none' — no plugins; can't be framed
  //                                  (clickjacking protection).
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-eval' is required by PixiJS 8 (the editor's WebGL renderer compiles
        // shaders/uniforms via eval). This weakens one defense-in-depth layer, but the
        // primary XSS defenses remain intact: no inline <script> is allowed, injected
        // <script src> from other origins is still blocked, and script-src-attr 'none'
        // (set below by helmet) blocks inline on*= handlers. Combined with the fact that
        // all user input is HTML-escaped before rendering, the residual risk is low.
        scriptSrc: ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  });

  // Rate limiting protects the auth endpoints (and everything else) from
  // brute-force and spam. Generous global ceiling; auth routes add a tighter
  // per-route limit below.
  if (options.rateLimit) {
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  }

  const seatCount = (id: string, version: number): number | null =>
    templates.find((t) => t.id === id && t.version === version)?.seatCount ?? null;

  // Palette ceiling matches the client (DesignStore.MAX_COLORS) and the .tifo
  // format: one byte per seat ⇒ up to 256 distinct colours. (It used to cap at 8,
  // which silently rejected any design with more swatches — e.g. after an image
  // import or "real colours" — so saving privately AND publishing both failed.)
  /**
   * Base URL for links we put in EMAIL. Never trust the request's Host header
   * here: a forged Host on /api/auth/forgot produces an authentic-looking mail
   * whose reset link carries a real token to the attacker's domain. PUBLIC_URL
   * wins; otherwise the Host must match a known hostname before it is used, and
   * failing that we fall back to the canonical domain.
   */
  const CANONICAL_ORIGIN = 'https://tifomaker.org';
  const ALLOWED_EMAIL_HOSTS = new Set(['tifomaker.org', 'www.tifomaker.org', 'localhost', '127.0.0.1']);
  const emailBase = (req: FastifyRequest): string => {
    if (options.publicUrl) return options.publicUrl.replace(/\/+$/, '');
    const host = String(req.headers.host ?? '');
    const bare = host.split(':')[0]?.toLowerCase() ?? '';
    if (ALLOWED_EMAIL_HOSTS.has(bare)) return `${req.protocol}://${host}`;
    return CANONICAL_ORIGIN;
  };

  const validPalette = (p: unknown): p is string[] =>
    Array.isArray(p) && p.length >= 2 && p.length <= 256 && p.every((c) => typeof c === 'string' && HEX.test(c));

  /**
   * The site's own share card, loaded once from the static build. Used as the
   * last resort for a design that has no image of its own.
   */
  let defaultCardPng: Buffer | null = null;

  /** User id from a bearer token, or null. Never writes to the reply. */
  const userOf = async (req: FastifyRequest): Promise<string | null> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return auth.getUserIdByToken(hashToken(header.slice(7)));
  };

  const requireUser = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const userId = await userOf(req);
    if (!userId) {
      await reply.code(401).send({ error: 'authentication required' });
      return null;
    }
    return userId;
  };

  // Admin = the user's username is in the ADMIN_USERNAMES allow-list. This is
  // intentionally NOT grantable via any API — you bootstrap admins through the
  // environment, so no request (forged or otherwise) can escalate privilege.
  // Matched EXACTLY, not case-folded. Usernames are unique case-sensitively
  // (schema.sql has no lower(username) index), so a case-insensitive compare here
  // meant registering "Admin" next to the real "admin" and inheriting moderator:
  // one unauthenticated request to full admin. Registration now also refuses any
  // username that case-folds onto an allow-listed one, so the pair cannot exist.
  const adminSet = new Set(options.adminUsernames ?? []);
  const adminFolded = new Set((options.adminUsernames ?? []).map((u) => u.toLowerCase()));
  const isAdminUser = async (userId: string): Promise<boolean> => {
    if (adminSet.size === 0) return false;
    const user = await auth.getUserById(userId).catch(() => null);
    return user ? adminSet.has(user.username) : false;
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const userId = await requireUser(req, reply);
    if (!userId) return null;
    if (!(await isAdminUser(userId))) {
      await reply.code(403).send({ error: 'moderator access required' });
      return null;
    }
    return userId;
  };

  // Admin gate for read-only analytics: either a valid AI_ADMIN_PASSWORD unlock token
  // (the dashboard exchanges the password for one via /api/ai/unlock) or a signed-in
  // ADMIN_USERNAMES account. Hoisted here so the funnel and traffic endpoints share it.
  const UNLOCK_COOKIE = 'tm_admin';
  /** One cookie by name. No cookie plugin is registered, and one line is enough. */
  const readCookie = (req: FastifyRequest, name: string): string | null => {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string') return null;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return null;
  };

  const aiAdminPassword = process.env.AI_ADMIN_PASSWORD;
  const adminAccess = async (req: FastifyRequest): Promise<boolean> => {
    const tok = req.headers['x-ai-unlock'];
    if (typeof tok === 'string' && aiAdminPassword && verifyUnlock(aiAdminPassword, tok)) return true;
    const userId = await userOf(req);
    return userId ? isAdminUser(userId) : false;
  };

  /** undefined = invalid (reply sent); null = none provided; Buffer = decoded. */
  const decodeThumb = (b64: string | undefined, reply: FastifyReply): Buffer | null | undefined => {
    if (b64 === undefined) return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.byteLength === 0 || buf.byteLength > MAX_THUMB_BYTES) {
      void reply.code(400).send({ error: `thumbnailPngB64 must decode to 1..${MAX_THUMB_BYTES} bytes` });
      return undefined;
    }
    return buf;
  };

  app.get('/health', async () => ({ ok: true }));

  // ---------- .tifo format validation (the ecosystem primitive) ----------
  // A generator (an LLM, a third-party tool) POSTs a .tifo document and gets
  // back { valid, errors[] } WITHOUT saving anything — the tight write→validate→
  // fix loop that lets external systems hit 100% data integrity. Seat counts are
  // memoized so repeated validations don't regenerate maps.
  const seatCountCache = new Map<string, number | null>();
  const seatCountFor = (templateId: string, version: number): number | null => {
    const key = `${templateId}@${version}`;
    if (seatCountCache.has(key)) return seatCountCache.get(key) ?? null;
    const tpl = TEMPLATES.find((t) => t.id === templateId && t.version === version);
    const count = tpl ? generateSeatMap(tpl).count : null;
    seatCountCache.set(key, count);
    return count;
  };

  app.post('/api/tifo/validate', async (req, reply) => {
    const result = validateTifo(req.body, seatCountFor);
    // 200 with {valid:false, errors} is the contract — a failed *document* is a
    // successful *validation*. (Reserve 4xx for malformed requests, not invalid docs.)
    return reply.code(200).send({
      schemaVersion: TIFO_SCHEMA_VERSION,
      valid: result.valid,
      errors: result.errors,
    });
  });

  // ---------- anonymous funnel analytics ----------
  // The ordered funnel steps. Capture is whitelisted to these so the table
  // can't be polluted with arbitrary names.
  const FUNNEL_STEPS = [
    'landed',          // arrived in the editor
    'paint_first',     // first brush stroke
    'view_3d',         // opened the stadium / split view
    'draft_restored',  // returned and their local draft was still there
    'save_clicked',    // pressed Save
    'save_local',      // work kept without an account
    'account_prompt',  // the "keep it anywhere" offer was shown, after a save
    'auth_opened',     // opened the sign-up form
    'signed_up',       // created an account
    'draft_claimed',   // the local draft was attached to that new account
    'published',       // published to the community
    'exported',        // exported a production PDF/CSV
  ];
  const FUNNEL_SET = new Set(FUNNEL_STEPS);

  // Record one anonymous event. No auth required; best-effort (never errors the
  // client over analytics). Ignores unknown names and missing sink.
  app.post('/api/events', async (req, reply) => {
    const body = (req.body ?? {}) as { session?: unknown; name?: unknown; signedIn?: unknown };
    const session = typeof body.session === 'string' ? body.session : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!session || !FUNNEL_SET.has(name)) {
      return reply.code(204).send(); // silently ignore junk
    }
    if (options.events) {
      await options.events.record(session, name, Boolean(body.signedIn)).catch(() => {});
    }
    return reply.code(204).send();
  });

  // Funnel summary: distinct sessions per step over a window, plus step-to-step
  // conversion. Admin-gated: this is business intelligence — conversion rates and
  // account counts — and it was previously world-readable, so anyone could watch the
  // site's performance without credentials.
  app.get('/api/funnel', async (req, reply) => {
    if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const q = req.query as { days?: string };
    const days = Math.min(365, Math.max(1, Number(q.days) || 30));
    if (!options.events) return { days, steps: [], note: 'analytics not enabled' };
    const steps = await options.events.funnel(FUNNEL_STEPS, days);
    // Annotate each step with conversion from the top and from the previous step.
    const top = steps[0]?.sessions || 0;
    const annotated = steps.map((s, i) => {
      const prev = i > 0 ? steps[i - 1].sessions : s.sessions;
      return {
        name: s.name,
        sessions: s.sessions,
        pctOfTop: top > 0 ? Math.round((s.sessions / top) * 1000) / 10 : 0,
        pctOfPrev: prev > 0 ? Math.round((s.sessions / prev) * 1000) / 10 : 0,
      };
    });
    return { days, steps: annotated };
  });
  // ---------- traffic sources (cookieless, server-side reach measurement) ----------
  // Records ONE row per HTML page view, after the response has already been sent, so
  // it can never slow down or break a request. See trafficRepo.ts for the privacy
  // model: no cookie, no IP stored, no raw user-agent, referrer reduced to a hostname.
  if (options.traffic) {
    const traffic = options.traffic;
    app.addHook('onResponse', async (req, reply) => {
      try {
        if (reply.statusCode >= 400) return;
        const ct = String(reply.getHeader('content-type') ?? '');
        if (!ct.startsWith('text/html')) return; // pages only — not assets, not API
        const url = req.url || '/';
        if (url.startsWith('/api/') || url.startsWith('/admin')) return;
        const h = req.headers;
        const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        await traffic.record(
          buildVisit({
            ip: req.ip || '0.0.0.0',
            ua: one(h['user-agent']) ?? '',
            referer: one(h.referer),
            host: one(h.host),
            path: url,
            query: (req.query ?? {}) as Record<string, unknown>,
            acceptLanguage: one(h['accept-language']),
            // Present only when Cloudflare (or another edge that sets it) fronts the app.
            country: one(h['cf-ipcountry']),
          }),
        );
      } catch {
        /* analytics must never affect a response */
      }
    });

    app.get('/api/admin/traffic', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      const q = req.query as { days?: string };
      const days = Math.min(365, Math.max(1, Number(q.days) || 30));
      return reply.send(await traffic.summary(days));
    });
  }

  // Sharing, site-wide. Admin-gated for the same reason as the funnel: it is
  // business intelligence, not public information.
  if (options.stats) {
    const stats = options.stats;
    // AI: what people actually did with the designer. ai_usage is only a meter
    // (one row per user, current hour only), so this reads the ai_events
    // history instead — the difference is the whole point of the section.
    app.get('/api/admin/ai', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      if (!options.aiEvents) return { days: 0, since: null, unavailable: true };
      const q = req.query as { days?: string };
      const days = Math.min(365, Math.max(1, Number(q.days) || 30));
      return options.aiEvents.stats(days);
    });

    app.get('/api/admin/shares', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      const q = req.query as { days?: string };
      const days = Math.min(365, Math.max(1, Number(q.days) || 30));
      const summary = await stats.shares(days);

      // The return leg: where shared links actually land. Visits to /d/:id and
      // /t/:id are already in the visits table, so this costs no new tracking,
      // and it is the half that says whether the sharing did anything.
      // No `visitors` total here on purpose. The traffic summary buckets unique
      // visitors PER PAGE, so summing those columns counts one person twice as
      // soon as they open two shared tifos - it reported 2 uniques for a single
      // visitor in testing. Visits sum correctly, so that is what is reported,
      // alongside how many distinct tifos were opened.
      let inbound: {
        visits: number;
        tifosOpened: number;
        pages: { key: string; visits: number; visitors: number }[];
        social: { key: string; visits: number; visitors: number }[];
      } | null = null;
      if (options.traffic) {
        const t = await options.traffic.summary(days);
        const shared = t.pages.filter((p) => /^\/(d|t)\//.test(p.key));
        inbound = {
          visits: shared.reduce((n, p) => n + p.visits, 0),
          tifosOpened: shared.length,
          pages: shared.slice(0, 10),
          // A floor, not a count: most messaging apps send no referrer at all,
          // so links passed round WhatsApp or Discord arrive looking direct.
          social: t.referrers.filter((r) => isSocialHost(r.key)).slice(0, 10),
        };
      }
      return reply.send({ ...summary, inbound });
    });
  }

  // ---------- in-product feedback ----------
  // The only route out of a broken state used to be leaving the site and
  // messaging the developer, which nobody does, so bugs cost users silently.
  if (options.feedback) {
    const feedback = options.feedback;

    /** Bots fill every field they can see, including the ones humans cannot. */
    const HONEYPOT = 'website';
    /** Nothing a person actually typed arrives this fast. */
    const MIN_FILL_MS = 2000;

    const oneLine = (v: unknown, max: number): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.trim().replace(/\s+/g, ' ').slice(0, max);
      return t || null;
    };

    app.post('/api/feedback', {
      config: options.rateLimit ? { rateLimit: { max: 5, timeWindow: '10 minutes' } } : undefined,
    }, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Both traps answer 200 rather than an error: telling a bot which check it
      // failed is how it learns to pass. A person never sees either path.
      if (typeof body[HONEYPOT] === 'string' && body[HONEYPOT] !== '') {
        return reply.code(200).send({ ok: true });
      }
      const elapsed = Number(body.elapsedMs);
      if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
        return reply.code(200).send({ ok: true });
      }

      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (message.length < 4) {
        return reply.code(400).send({ error: 'tell me a little more than that' });
      }
      if (!isFeedbackKind(body.kind)) {
        return reply.code(400).send({ error: 'unknown kind' });
      }

      const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
      if (rawEmail && !EMAIL.test(rawEmail)) {
        return reply.code(400).send({ error: 'that email does not look right' });
      }

      // Only ever the coarse facts, and only when the sender left them attached.
      const c = (body.context ?? null) as Record<string, unknown> | null;
      const context: FeedbackContext | null = c
        ? {
            path: oneLine(c.path, 120),
            browser: oneLine(c.browser, 40),
            os: oneLine(c.os, 40),
            device: oneLine(c.device, 20),
            viewport: oneLine(c.viewport, 20),
            language: oneLine(c.language, 12),
            signedIn: Boolean(c.signedIn),
          }
        : null;

      const userId = await userOf(req);
      const saved = await feedback
        .create({ kind: body.kind, message, email: rawEmail || null, steps: oneLine(body.steps, 2000), context, userId })
        .catch(() => null);
      if (!saved) return reply.code(503).send({ error: 'could not save that, please try again' });

      // Best-effort notification: a bug the developer hears about tomorrow is
      // worth far more than one sitting in a dashboard nobody opened. Never let
      // a mail failure lose the report, which is already stored by this point.
      if (options.emailSender && options.feedbackTo) {
        const esc2 = (x: string): string =>
          x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const ctxLine = context
          ? `${context.path ?? '?'} · ${context.browser ?? '?'} on ${context.os ?? '?'} · ${context.device ?? '?'} · ${context.viewport ?? '?'}`
          : 'no diagnostics attached';
        void options.emailSender
          .send({
            to: options.feedbackTo,
            subject: `TifoMaker ${body.kind}: ${message.slice(0, 60)}`,
            html:
              `<p><b>${esc2(body.kind)}</b>${rawEmail ? ` from ${esc2(rawEmail)}` : ' (no reply address)'}</p>` +
              `<p style="white-space:pre-wrap">${esc2(message)}</p>` +
              (body.steps ? `<p><b>What they were doing</b><br><span style="white-space:pre-wrap">${esc2(String(body.steps))}</span></p>` : '') +
              `<p style="color:#666;font-size:12px">${esc2(ctxLine)}</p>`,
            text: `${body.kind}: ${message}\n\n${body.steps ? 'Doing: ' + String(body.steps) + '\n\n' : ''}${ctxLine}`,
          })
          .catch(() => {});
      }

      return reply.code(201).send({ ok: true, id: saved.id });
    });

    app.get('/api/admin/feedback', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      const q = req.query as { limit?: string };
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const [items, counts] = await Promise.all([feedback.list(limit), feedback.counts()]);
      return reply.send({ items, counts });
    });
  }

  app.get('/api/templates', async () => templates);

  // ---------- AI Tifo Designer (offline designer + optional model) ----------
  // Auth-gated with a per-account free quota; the spec is validated server-side
  // with the same validator the client uses before a credit is spent.
  if (options.aiUsage) {
    registerAiRoutes(app, {
      aiUsage: options.aiUsage,
      aiEvents: options.aiEvents,
      userOf,
      isAdmin: isAdminUser,
      adminPassword: process.env.AI_ADMIN_PASSWORD,
      freeLimit: options.aiFreeLimit ?? 10,
      // Launch: AI is free for any signed-in, email-verified user. Set
      // AI_FREE_FOR_ALL=false later to enforce the per-account free limit
      // (which is HOURLY — see aiPeriod; this comment used to say monthly).
      freeForAll: (process.env.AI_FREE_FOR_ALL ?? 'true') !== 'false',
      userState: async (userId) => {
        const u = await auth.getUserById(userId).catch(() => null);
        return u ? { emailVerified: !!u.emailVerifiedAt, isPro: u.isPro } : null;
      },
      routeConfig: options.rateLimit ? { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } } : undefined,
      // The unlock endpoint is a password prompt, so it gets the login limit.
      authRouteConfig: options.rateLimit ? { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } : undefined,
    });
  }

  // ---------- community stadium templates (submit → moderate → public) ----------
  if (options.stadiums) {
    const stadiums = options.stadiums;
    const submitCfg = options.rateLimit ? { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } } : {};
    // Public: submit a community template (validated server-side; stored pending).
    app.post('/api/stadiums', submitCfg, async (req, reply) => {
      const b = (req.body ?? {}) as { template?: unknown; name?: unknown; country?: unknown };
      if (!isValidTemplate(b.template)) return reply.code(400).send({ error: 'invalid stadium template' });
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : b.template.name;
      const country = typeof b.country === 'string' && b.country.trim() ? b.country.trim().slice(0, 60) : null;
      const submitterId = await userOf(req);
      const { id } = await stadiums.submit({ template: b.template, name, country, submitterId });
      return reply.code(201).send({ id, status: 'pending' });
    });
    // Public: approved community templates, for the catalog.
    app.get('/api/stadiums/community', async (_req, reply) => {
      const rows = await stadiums.listApproved();
      return reply.send({ stadiums: rows.map((r) => ({ id: r.id, name: r.name, country: r.country, template: r.template })) });
    });
    // Admin: review queue + decision.
    app.get('/api/stadiums/pending', async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      return reply.send({ stadiums: await stadiums.listPending() });
    });
    app.post('/api/stadiums/:id/review', async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const id = (req.params as { id: string }).id;
      const approve = (req.body as { approve?: unknown } | null)?.approve === true;
      const ok = await stadiums.review(id, approve);
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ error: 'submission not found' });
    });
  }

  // ---------- admin analytics dashboard ----------
  // Read-only aggregates powering /admin. Admin-gated: the caller must present a
  // login token whose username is in ADMIN_USERNAMES (the "admin password" is
  // simply that account's password). The dashboard PAGE is public HTML/JS — all
  // protection lives here, on the data endpoint.
  if (options.stats) {
    const stats = options.stats;
    // Admin gate for analytics: a valid AI_ADMIN_PASSWORD unlock token (the
    // dashboard exchanges the password for it via /api/ai/unlock) OR a signed-in
    // ADMIN_USERNAMES account. Mirrors the AI routes' hasAiAccess so the same
    // "admin password" opens both the AI designer and this dashboard.
    app.get('/api/admin/overview', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      return reply.send(await stats.overview());
    });
  }
  // The dashboard shell + its ES module. CSP forbids inline <script> and
  // cross-origin CDNs, so the JS is served from our own origin and all charts are
  // hand-drawn SVG (no external libraries). Registered before the SPA fallback so
  // /admin and /admin.js resolve to these, not index.html.
  //
  // /admin.js names every /api/admin/* endpoint the server has, and it was
  // served to anyone who typed the URL. All of those endpoints are gated, so it
  // was a map rather than a key — but a map is the first step of everything that
  // comes after, and there is no reason to hand one out. It is now behind the
  // same unlock the data is, and the shell only references it when the caller
  // can already prove they are through.
  //
  // The proof is a cookie rather than the x-ai-unlock header, because a <script
  // src> and a browser navigation cannot send a header. It is HttpOnly (so the
  // token cannot be read back out by script), Secure, SameSite=Strict, and it
  // authorises exactly one thing: fetching a script. Every endpoint that
  // *changes* anything still requires the header, so the cookie carries no CSRF
  // surface — there is no state-changing request it can authorise.
  const adminUnlocked = async (req: FastifyRequest): Promise<boolean> => {
    const cookie = readCookie(req, UNLOCK_COOKIE);
    if (cookie && aiAdminPassword && verifyUnlock(aiAdminPassword, cookie)) return true;
    return adminAccess(req);
  };
  app.get('/admin', async (req, reply) =>
    reply.type('text/html').header('cache-control', 'no-store').send(adminHtml(await adminUnlocked(req))));
  app.get('/admin.js', async (req, reply) => {
    // 404 and not 403: a 403 confirms the file is there to be had.
    if (!(await adminUnlocked(req))) return reply.code(404).send({ error: 'not found' });
    return reply.header('cache-control', 'no-store').type('text/javascript').send(ADMIN_JS);
  });
  app.get('/admin-unlock.js', async (_req, reply) =>
    reply.header('cache-control', 'no-cache').type('text/javascript').send(ADMIN_UNLOCK_JS),
  );

  // ---------- auth ----------
  // Tighter limit on credential endpoints: 10 attempts/minute/IP. Only takes
  // effect when the rate-limit plugin is registered (production), ignored in tests.
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
  /**
   * The in-app code is short-lived where the emailed link is not.
   *
   * A link carries 256 bits of entropy; a six-digit code carries about twenty,
   * so its safety comes from the controls around it rather than its length.
   * Ten minutes, single use, and five wrong guesses before the code is
   * destroyed — 5 chances in 1,000,000 per issued code, against NIST's ceiling
   * of 100 consecutive failures.
   *
   * This is only safe because of WHAT the code unlocks. It does not sign anyone
   * in and it does not reset a password: the endpoint requires an authenticated
   * session and verifies an address on THAT account. Guessing it gains an
   * attacker nothing they did not already have.
   */
  const VERIFY_CODE_TTL_MS = 10 * 60 * 1000;
  const VERIFY_CODE_MAX_TRIES = 5;
  /** Wrong-guess counters, per user. In-memory, like the AI budget — a second
   *  instance would keep its own, which the link flow makes acceptable. */
  const codeTries = new Map<string, number>();

  /**
   * Per-account cooldown between verification messages, and the clock behind
   * it: when each account was last sent one, by ANY path (registration, adding
   * or changing an address, or Resend).
   *
   * The rate limit is 10 a minute per ADDRESS, which does nothing to stop one
   * impatient person pressing Resend twenty times — and on a transactional mail
   * plan with a daily allowance, that is how a whole day's quota disappears
   * before lunch and everyone else's verification silently stops arriving.
   * A new message also invalidates the previous code, so rapid resends are
   * actively unhelpful: the code in the message you just opened stops working.
   *
   * The clock used to be started only by the Resend route, so the message
   * registration had just sent did not count. The AI panel resends on its own
   * the moment it finds an unverified account, which for a new signup is about
   * two seconds after registering. Once Resend actually worked, that would
   * silently replace the code in the email the person was already opening.
   * Now the second request inside the window is a 429 that says a message is
   * on its way, and the first code keeps working.
   */
  const RESEND_COOLDOWN_MS = Math.max(0, options.verifyResendCooldownMs ?? 60_000);
  const lastVerifySentAt = new Map<string, number>();
  const noteVerifySent = (userId: string): void => {
    const now = Date.now();
    lastVerifySentAt.set(userId, now);
    // In-memory, like codeTries; forget entries once they can no longer matter,
    // so a long-lived process does not keep one per account it ever mailed.
    if (lastVerifySentAt.size > 5000) {
      for (const [id, at] of lastVerifySentAt) if (now - at >= RESEND_COOLDOWN_MS) lastVerifySentAt.delete(id);
    }
  };

  /** A cryptographically random 6-digit code. Never Math.random. */
  const newVerifyCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
  /** Salted with the user id, so two people can hold the same digits and one
   *  person can never consume — or destroy — another's code. */
  const codeHash = (userId: string, code: string): string => hashToken(`verify:${userId}:${code}`);
  // Issue a fresh verification token and email the link. Best-effort: a mail
  // failure never blocks the API response (the user can request a resend).
  const sendVerifyEmail = async (req: FastifyRequest, user: { id: string; email: string }): Promise<boolean> => {
    if (!options.emailSender) return false;
    try {
      await auth.deleteEmailTokens(user.id, 'verify_email');
      await auth.deleteEmailTokens(user.id, 'verify_code');
      codeTries.delete(user.id);
      const { token, tokenHash } = issueToken();
      await auth.createEmailToken(user.id, tokenHash, 'verify_email', new Date(Date.now() + VERIFY_TTL_MS));
      // The same message carries both: a code to type where the person already
      // is, and a link for whoever would rather just click. On a phone, leaving
      // for a mail app and finding the way back is where people give up.
      const code = newVerifyCode();
      await auth.createEmailToken(user.id, codeHash(user.id, code), 'verify_code', new Date(Date.now() + VERIFY_CODE_TTL_MS));
      const base = emailBase(req);
      const link = `${base}/api/auth/verify?token=${token}`;
      // Bilingual: the server does not know which language the person picked
      // (that lives in their browser), and most of the audience is Saudi, so
      // both languages ship in one message with Arabic first.
      await options.emailSender.send({
        to: user.email,
        subject: 'وثّق بريدك في تيفو ميكر · Verify your TifoMaker email',
        html:
          `<div dir="rtl" lang="ar" style="text-align:right">` +
          `<p>أهلاً بك في تيفو ميكر.</p>` +
          `<p>وثّق بريدك عشان تفتح مصمّم الذكاء الاصطناعي. رمز التحقق:</p>` +
          `<p style="font-size:30px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>` +
          `<p>اكتب الرمز في الموقع خلال 10 دقائق، أو افتح هذا الرابط:</p>` +
          `<p><a href="${link}">وثّق بريدي</a></p>` +
          `<p>الرابط ينتهي خلال 24 ساعة. وإذا ما أنشأت حساب، تجاهل هذي الرسالة.</p>` +
          `</div><hr />` +
          `<div dir="ltr" lang="en">` +
          `<p>Welcome to TifoMaker.</p>` +
          `<p>Confirm your email to unlock the AI Designer. Your code:</p>` +
          `<p style="font-size:30px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>` +
          `<p>Type it on the site within 10 minutes, or open this link instead:</p>` +
          `<p><a href="${link}">Verify my email</a></p>` +
          `<p>This link expires in 24 hours. If you didn't create an account, ignore this email.</p>` +
          `</div>`,
        text:
          `رمز التحقق في تيفو ميكر: ${code} (صالح 10 دقائق)\nأو افتح: ${link}\n\n` +
          `Your TifoMaker code: ${code} (valid 10 minutes)\nOr open: ${link}`,
      });
      noteVerifySent(user.id);
      return true;
    } catch (err) {
      // Loud, and with the provider's own words. This used to be the ONLY trace
      // a failed verification email left anywhere — the API answered 201/202
      // either way and the UI said "check your inbox", so "email verification
      // stopped working" arrived with nothing to go on but the time of day.
      app.log.error({ err: String((err as Error)?.message ?? err) }, 'verification email was NOT sent');
      return false;
    }
  };

  const RESET_TTL_MS = 60 * 60 * 1000;
  // Issue a password-reset token and email the link. Best-effort.
  const sendResetEmail = async (req: FastifyRequest, user: { id: string; email: string }): Promise<void> => {
    if (!options.emailSender) return;
    try {
      await auth.deleteEmailTokens(user.id, 'reset_password');
      const { token, tokenHash } = issueToken();
      await auth.createEmailToken(user.id, tokenHash, 'reset_password', new Date(Date.now() + RESET_TTL_MS));
      const base = emailBase(req);
      const link = `${base}/reset?token=${token}`;
      await options.emailSender.send({
        to: user.email,
        subject: 'إعادة تعيين كلمة مرور تيفو ميكر · Reset your TifoMaker password',
        html:
          `<div dir="rtl" lang="ar" style="text-align:right">` +
          `<p>وصلنا طلب لإعادة تعيين كلمة مرورك في تيفو ميكر.</p>` +
          `<p><a href="${link}">اختر كلمة مرور جديدة</a></p>` +
          `<p>الرابط ينتهي خلال ساعة. وإذا ما طلبت هذا، تجاهل الرسالة وكلمة مرورك ما تغيّرت.</p>` +
          `</div><hr />` +
          `<div dir="ltr" lang="en">` +
          `<p>We received a request to reset your TifoMaker password.</p>` +
          `<p><a href="${link}">Choose a new password</a></p>` +
          `<p>This link expires in 1 hour. If you didn't request this, ignore this email, your password is unchanged.</p>` +
          `</div>`,
        text:
          `إعادة تعيين كلمة مرور تيفو ميكر: ${link}\nالرابط ينتهي خلال ساعة.\n\n` +
          `Reset your TifoMaker password: ${link}\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
      });
    } catch (err) {
      // /api/auth/forgot answers 202 whether or not the address exists — that is
      // deliberate, so it cannot be used to test for accounts — which means the
      // log and /api/admin/email are the ONLY places a refused send can show up.
      app.log.error({ err: String((err as Error)?.message ?? err) }, 'password-reset email was NOT sent');
    }
  };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const { username, password, email, acceptedVersion } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      email?: string;
      acceptedVersion?: string;
    };
    // Reject any username that case-folds onto an admin name, whether or not that
    // account exists yet: it closes the impersonation angle as well as the
    // escalation one, and it keeps the allow-list unambiguous.
    if (typeof username === 'string' && adminFolded.has(username.toLowerCase()) && !adminSet.has(username)) {
      return reply.code(409).send({ error: 'username or email taken' });
    }
    if (!username || !USERNAME.test(username) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'username 3-24 [a-zA-Z0-9_], password >= 8 chars' });
    }
    const mail = typeof email === 'string' ? email.trim() : '';
    if (!mail || mail.length > MAX_EMAIL || !EMAIL.test(mail)) {
      return reply.code(400).send({ error: 'a valid email is required' });
    }
    // Clear message for duplicates; the unique index is the real race guard.
    // One generic 409 for BOTH cases. A distinct "email already in use" turned
    // registration into an oracle: pick a username you know exists, vary the
    // email, and the response tells you which addresses have accounts - exactly
    // what /api/auth/forgot refuses to reveal. The unique index below is the
    // real race guard, so nothing is lost by dropping the friendly message.
    if (await auth.getUserByEmail(mail).catch(() => null)) {
      return reply.code(409).send({ error: 'username or email taken' });
    }
    const version = typeof acceptedVersion === 'string' ? acceptedVersion.slice(0, 32) : null;
    const user = await auth.createUser(username, await hashPassword(password), { email: mail, acceptedVersion: version });
    if (!user) return reply.code(409).send({ error: 'username or email taken' });
    const { token, tokenHash } = issueToken();
    await auth.createToken(user.id, tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
    // The account is real whether or not the mail went out, so registration
    // still succeeds — but it says which, so the UI can offer a resend instead
    // of sending someone to an inbox nothing is coming to.
    const emailSent = await sendVerifyEmail(req, { id: user.id, email: mail });
    return reply.code(201).send({
      token,
      username: user.username,
      email: user.email,
      emailVerified: !!user.emailVerifiedAt,
      emailSent,
    });
  });

  // Email-link verification: a GET that consumes the (single-use, expiring) token
  // and redirects back to the app — works straight from an email client, no JS,
  // CSP-safe. A consumed or expired link simply lands on verified=0.
  app.get('/api/auth/verify', async (req, reply) => {
    const q = req.query as { token?: string };
    const token = typeof q.token === 'string' ? q.token : '';
    const userId = token ? await auth.consumeEmailToken(hashToken(token), 'verify_email') : null;
    if (userId) await auth.markEmailVerified(userId);
    // The token is in the URL: don't cache it and don't leak it via the Referer header.
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .redirect(`/app?verified=${userId ? 1 : 0}`);
  });

  // Re-send the verification email to the signed-in user. The cooldown and its
  // reasons are with lastVerifySentAt, above sendVerifyEmail.
  app.post('/api/auth/verify/resend', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await auth.getUserById(userId).catch(() => null);
    if (!user?.email) return reply.code(400).send({ error: 'no email on file' });
    if (user.emailVerifiedAt) return reply.code(200).send({ ok: true, alreadyVerified: true });
    const last = lastVerifySentAt.get(userId);
    const since = last === undefined ? Number.POSITIVE_INFINITY : Date.now() - last;
    if (since < RESEND_COOLDOWN_MS) {
      return reply.code(429).send({
        error: 'a message is already on its way',
        retryInSeconds: Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - since) / 1000)),
      });
    }
    // Claim the slot before the provider call, so two quick presses cannot
    // both get through while the first is still waiting on Resend.
    lastVerifySentAt.set(userId, Date.now());
    const sent = await sendVerifyEmail(req, { id: user.id, email: user.email });
    if (!sent) {
      // Don't let someone's failed send lock them out of retrying.
      if (last === undefined) lastVerifySentAt.delete(userId);
      else lastVerifySentAt.set(userId, last);
      // Generic to the caller, exact in the log and on /api/admin/email: the
      // provider's refusal can name the account and the sending domain.
      return reply.code(502).send({ error: 'we could not send that email just now', emailSent: false });
    }
    return reply.code(202).send({ ok: true, emailSent: true });
  });

  /**
   * Verify the signed-in account's email with the 6-digit code.
   *
   * Requires a session, so this can only ever verify an address on the caller's
   * OWN account — which is what makes a short code acceptable here. One generic
   * error for wrong, expired and already-spent, so it never becomes an oracle.
   */
  app.post('/api/auth/verify/code', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const raw = (req.body ?? {}) as { code?: unknown };
    const code = typeof raw.code === 'string' ? raw.code.replace(/\D/g, '') : '';
    const user = await auth.getUserById(userId).catch(() => null);
    if (user?.emailVerifiedAt) return reply.code(200).send({ ok: true, alreadyVerified: true });
    if (code.length !== 6) return reply.code(400).send({ error: 'enter the 6-digit code' });

    const tries = codeTries.get(userId) ?? 0;
    if (tries >= VERIFY_CODE_MAX_TRIES) {
      return reply.code(429).send({ error: 'too many attempts, request a new code', exhausted: true });
    }
    const ok = await auth.consumeEmailToken(codeHash(userId, code), 'verify_code');
    if (ok !== userId) {
      const next = tries + 1;
      codeTries.set(userId, next);
      // Burn the code once the budget is spent, so a new one must be requested.
      if (next >= VERIFY_CODE_MAX_TRIES) await auth.deleteEmailTokens(userId, 'verify_code').catch(() => {});
      return reply.code(400).send({
        error: 'that code is not right or has expired',
        triesLeft: Math.max(0, VERIFY_CODE_MAX_TRIES - next),
      });
    }
    codeTries.delete(userId);
    await auth.deleteEmailTokens(userId, 'verify_email');
    await auth.markEmailVerified(userId);
    return reply.code(200).send({ ok: true });
  });

  /**
   * Rename the signed-in account.
   *
   * The handle is public — it is the @name on every design in the community —
   * and attribution joins on the user rather than copying the name, so a rename
   * follows the person everywhere rather than orphaning their work. Same
   * character rules as registration, and the same generic 409 so this cannot be
   * used to probe which names exist.
   */
  app.post('/api/account/username', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const raw = (req.body ?? {}) as { username?: unknown };
    const username = typeof raw.username === 'string' ? raw.username.trim() : '';
    if (!USERNAME.test(username)) {
      return reply.code(400).send({ error: '3-24 characters: letters, numbers or underscore' });
    }
    // Stricter than registration, deliberately. Registration allows the exact
    // admin name through (that is how an admin bootstraps); a RENAME never can
    // — if the allow-listed name is not yet registered, renaming onto it would
    // hand the caller moderator rights, and uniqueness would not stop it.
    if (adminFolded.has(username.toLowerCase())) {
      return reply.code(409).send({ error: 'that name is taken' });
    }
    const ok = await auth.setUsername(userId, username);
    if (!ok) return reply.code(409).send({ error: 'that name is taken' });
    return reply.code(200).send({ ok: true, username });
  });

  // Change password while signed in (requires the current password).
  app.post('/api/account/password', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'new password must be at least 8 characters' });
    }
    const user = await auth.getUserById(userId).catch(() => null);
    const current = await verifyPassword(currentPassword ?? '', user?.passwordHash ?? await dummyHash());
    if (!user || !currentPassword || !current.ok) {
      return reply.code(401).send({ error: 'current password is incorrect' });
    }
    await auth.setPasswordHash(userId, await hashPassword(newPassword));
    // Changing a password is what someone does when they think a session is
    // compromised. It has to end the other sessions, or it is theatre: tokens
    // live 30 days, so a stolen one otherwise outlived the "fix" by a month.
    // /api/auth/reset already did this; this path did not.
    await auth.deleteUserTokens(userId).catch(() => {});
    // Mint a replacement so the person who just changed it stays signed in here.
    const { token, tokenHash } = issueToken();
    await auth.createToken(userId, tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
    return reply.code(200).send({ ok: true, token, signedOutEverywhereElse: true });
  });

  // Forgot password: always 200 so the response can't be used to probe which
  // emails have accounts. Sends a reset link only when the address actually exists.
  app.post('/api/auth/forgot', authLimit, async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string };
    const mail = typeof email === 'string' ? email.trim() : '';
    if (mail && mail.length <= MAX_EMAIL && EMAIL.test(mail)) {
      const user = await auth.getUserByEmail(mail).catch(() => null);
      if (user?.email) await sendResetEmail(req, { id: user.id, email: user.email });
    }
    return reply.code(200).send({ ok: true });
  });

  // Reset password using the emailed token. Single-use; invalidates all sessions.
  app.post('/api/auth/reset', authLimit, async (req, reply) => {
    const { token, newPassword } = (req.body ?? {}) as { token?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'new password must be at least 8 characters' });
    }
    const userId = token ? await auth.consumeEmailToken(hashToken(token), 'reset_password') : null;
    if (!userId) return reply.code(400).send({ error: 'invalid or expired reset link' });
    await auth.setPasswordHash(userId, await hashPassword(newPassword));
    await auth.deleteUserTokens(userId);
    return reply.code(200).send({ ok: true });
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    // Accounts created through the editor never choose a username (it is derived
    // from the email), so the sign-in field accepts either. The generic 401 below
    // still means neither form reveals whether an account exists.
    let user = username ? await auth.getUserByName(username) : null;
    if (!user && username && username.includes('@')) {
      user = await auth.getUserByEmail(username);
    }
    // Always hash, even when no account matched. The bodies below were already
    // identical for both cases; the CLOCK was the oracle — a missing account
    // short-circuited in about 0.3 ms against 35 for a real one, which is enough
    // to enumerate who has an account here. Verifying against a dummy spends the
    // same time on an address that has never registered.
    const check = await verifyPassword(password ?? '', user?.passwordHash ?? await dummyHash());
    if (!user || !password || !check.ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    // Right password, weaker parameters than we now use: this is the only moment
    // the password exists in the clear, so it is the only moment it can be
    // upgraded. Best-effort — a failed rehash must not fail the sign-in.
    if (check.needsRehash) {
      await auth.setPasswordHash(user.id, await hashPassword(password)).catch(() => {});
    }
    const { token, tokenHash } = issueToken();
    await auth.createToken(user.id, tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
    return { token, username: user.username };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) await auth.deleteToken(hashToken(header.slice(7)));
    return reply.code(204).send();
  });

  app.get('/api/me', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await auth.getUserById(userId).catch(() => null);
    return {
      id: userId,
      username: user?.username ?? null,
      email: user?.email ?? null,
      emailVerified: !!user?.emailVerifiedAt,
      isAdmin: await isAdminUser(userId),
    };
  });

  // Add or replace the caller's email (pre-launch accounts, or changing it).
  // Resets verification; uniqueness is enforced case-insensitively.
  app.post('/api/account/email', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { email, acceptedVersion } = (req.body ?? {}) as { email?: string; acceptedVersion?: string };
    const mail = typeof email === 'string' ? email.trim() : '';
    if (!mail || mail.length > MAX_EMAIL || !EMAIL.test(mail)) {
      return reply.code(400).send({ error: 'a valid email is required' });
    }
    const version = typeof acceptedVersion === 'string' ? acceptedVersion.slice(0, 32) : null;
    const ok = await auth.setEmail(userId, mail, version);
    if (!ok) return reply.code(409).send({ error: 'email already in use' });
    // Send the verification link for the newly added/changed email, server-side,
    // so it never depends on a separate client call.
    await sendVerifyEmail(req, { id: userId, email: mail });
    return reply.code(200).send({ email: mail, emailVerified: false });
  });

  // Export the caller's data (PDPL/GDPR access right): account fields + their designs.
  app.get('/api/account/export', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await auth.getUserById(userId).catch(() => null);
    const designs = await repo.listByOwner(userId).catch(() => []);
    return reply.header('content-disposition', 'attachment; filename="tifomaker-data.json"').send({
      exportedAt: new Date().toISOString(),
      account: user
        ? { id: user.id, username: user.username, email: user.email, emailVerified: !!user.emailVerifiedAt }
        : null,
      designs,
    });
  });

  // Permanently delete the caller's account and all their designs (right to erasure).
  app.delete('/api/account', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    await repo.deleteByOwner(userId).catch(() => {});
    await auth.deleteUser(userId);
    return reply.code(204).send();
  });

  // Admin: grant/revoke the paid (unlimited-AI) entitlement. No payment processor
  // yet — this lets you comp testers or friends to Pro until billing exists.
  app.post('/api/admin/pro', authLimit, async (req, reply) => {
    const adminId = await requireUser(req, reply);
    if (!adminId) return;
    if (!(await isAdminUser(adminId))) return reply.code(403).send({ error: 'admin access required' });
    const { username, isPro } = (req.body ?? {}) as { username?: string; isPro?: boolean };
    const target = username ? await auth.getUserByName(username) : null;
    if (!target) return reply.code(404).send({ error: 'user not found' });
    await auth.setPro(target.id, isPro !== false);
    return { username: target.username, isPro: isPro !== false };
  });

  // ---------- gallery ----------
  // Fastify hands back an ARRAY when a query key repeats (?search=a&search=b), and
  // .trim()/.split() on an array threw an unauthenticated 500. Collapse to one value.
  const oneParam = (v: unknown): string | undefined => {
    const raw = Array.isArray(v) ? v[v.length - 1] : v;
    return typeof raw === 'string' ? raw : undefined;
  };

  /** Default gallery page size, shared by the API and the crawler feed. */
  const GALLERY_PAGE = 60;

  app.get('/api/gallery', async (req) => {
    const q = req.query as Record<string, unknown>;
    const sort = oneParam(q.sort) === 'likes' ? 'likes' : 'recent';
    const viewerId = await userOf(req); // annotate the caller's votes when signed in
    const rawTags = oneParam(q.tags);
    const tags = rawTags ? rawTags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8) : undefined;
    const search = oneParam(q.search)?.slice(0, 80);
    // The library alone is ~600 designs. Paging keeps the first paint small and
    // stops a single request from shipping every card on the site.
    const limit = Math.min(120, Math.max(1, Number(oneParam(q.limit)) || GALLERY_PAGE));
    const offset = Math.max(0, Number(oneParam(q.offset)) || 0);
    // Colour chips are OR'd (red + gold means either), tags are AND'd. That is
    // not an inconsistency: picking two tags narrows a search, picking two
    // colours widens one, and both match what the chips look like they do.
    const rawColors = oneParam(q.colors);
    const colors = rawColors
      ? rawColors.split(',').map((c) => c.trim().toLowerCase()).filter((c) => (COLOUR_FAMILIES as readonly string[]).includes(c)).slice(0, 6)
      : undefined;
    const clubId = oneParam(q.club)?.slice(0, 60) || undefined;
    return repo.listPublic({
      sort, search, viewerId, tags, limit, offset, colors, clubId,
      templatesOnly: oneParam(q.templates) === '1',
      // `made=people` is the other half of the Templates tab: 619 seeded designs
      // otherwise bury every real one on the newest page.
      excludeTemplates: oneParam(q.made) === 'people',
    });
  });

  /**
   * What the filter chips can offer.
   *
   * The colour list is fixed (it is a classification, not data), but the CLUB
   * list is not worth showing in full: thirty-nine clubs of which the library
   * covers a dozen is a wall of dead chips. So the clubs are the ones that
   * actually have public designs, which means asking the feed.
   */
  app.get('/api/gallery/facets', async (req) => {
    const q = req.query as Record<string, unknown>;
    const made = oneParam(q.made) === 'people';
    const scope = { sort: 'recent' as const, limit: 5000, excludeTemplates: made, templatesOnly: oneParam(q.templates) === '1' };
    const rows = await repo.listPublic(scope);
    const colourCounts = new Map<string, number>();
    const clubCounts = new Map<string, number>();
    for (const r of rows) {
      const f = designFacets({ title: r.title, titleAr: r.titleAr, palette: r.palette });
      for (const c of f.colors) colourCounts.set(c, (colourCounts.get(c) ?? 0) + 1);
      if (f.clubId) clubCounts.set(f.clubId, (clubCounts.get(f.clubId) ?? 0) + 1);
    }
    const names = new Map(clubFilterOptions().map((c) => [c.id, c]));

    // How many a candidate selection would return.
    //
    // The filter panel stages your choices and only applies them when you
    // confirm, so without this the confirm button is a leap: you pick three
    // things, press it, and land on an empty grid with no idea which one was
    // the mistake. Counting first turns that into a number you can watch.
    const wantColors = oneParam(q.colors)?.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean).slice(0, 6);
    const wantTags = oneParam(q.tags)?.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
    const wantClub = oneParam(q.club)?.slice(0, 60) || undefined;
    const matching = (wantColors?.length || wantTags?.length || wantClub)
      ? (await repo.listPublic({ ...scope, colors: wantColors, tags: wantTags, clubId: wantClub })).length
      : rows.length;

    return {
      total: rows.length,
      matching,
      colors: COLOUR_FAMILIES.filter((c) => colourCounts.has(c)).map((c) => ({ id: c, count: colourCounts.get(c)! })),
      clubs: [...clubCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id, count]) => ({ id, name: names.get(id)?.name ?? id, nameAr: names.get(id)?.nameAr ?? id, count })),
    };
  });

  // Most-used tags, for the filter chips.
  app.get('/api/tags', async () => repo.popularTags(24));  // Replace a design's tags (owner only).
  app.put('/api/designs/:id/tags', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const tags = (req.body as { tags?: unknown } | null)?.tags;
    if (!Array.isArray(tags)) return reply.code(400).send({ error: 'tags must be an array of strings' });
    const result = await repo.setTags(id, userId, tags.map(String));
    if (result === null) return reply.code(404).send({ error: 'not found or not yours' });
    return { tags: result };
  });

  // Flag/unflag a design as a community template (owner only).
  app.put('/api/designs/:id/template', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const isTemplate = Boolean((req.body as { isTemplate?: unknown } | null)?.isTemplate);
    const result = await repo.setTemplate(id, userId, isTemplate);
    if (result === null) return reply.code(404).send({ error: 'not found or not yours' });
    return { isTemplate: result };
  });

  // Report a public item for moderation. Signed-in optional but recorded if present.
  app.post('/api/report', async (req, reply) => {
    const reporterId = await userOf(req);
    const body = (req.body ?? {}) as { targetType?: string; targetId?: string; reason?: string };
    const type = body.targetType === 'comment' ? 'comment' : 'design';
    if (!body.targetId || typeof body.reason !== 'string' || !body.reason.trim()) {
      return reply.code(400).send({ error: 'targetId and reason required' });
    }
    if (badId(body.targetId, reply)) return;
    const reportId = await repo.report(type, body.targetId, reporterId, body.reason.trim());
    return { reportId, status: 'received' };
  });

  // ---------- Before/After real match-day photos ----------
  // List a design's photos (metadata only; bytes via the image route below).
  app.get('/api/designs/:id/photos', async (req, reply) => {
    // getVisible, like every other design route. Without it a private design
    // answered 404 while its photos answered 200 with captions naming the
    // venue, date and opponent.
    const v = await getVisible(req, reply);
    if (!v) return;
    return repo.listPhotos(v.rec.id);
  });

  // Upload a real photo to a design (owner only). Resized client-side; a larger
  // per-route body limit than the global 1MB accommodates the image.
  app.post(
    '/api/designs/:id/photos',
    { bodyLimit: MAX_PHOTO_BYTES + 512 * 1024 },
    async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { imageB64?: string; width?: number; height?: number; caption?: string };
      if (typeof body.imageB64 !== 'string' || !body.imageB64) {
        return reply.code(400).send({ error: 'imageB64 required' });
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(body.imageB64, 'base64');
      } catch {
        return reply.code(400).send({ error: 'imageB64 not valid base64' });
      }
      if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) {
        return reply.code(400).send({ error: `image must decode to 1..${MAX_PHOTO_BYTES} bytes (resize before upload)` });
      }
      const w = Number(body.width) || 0;
      const h = Number(body.height) || 0;
      const photoId = await repo.addPhoto(id, userId, buf, w, h, body.caption ?? null);
      if (!photoId) return reply.code(404).send({ error: 'not found or not yours' });
      return { photoId };
    },
  );

  // Serve a photo's bytes. Content type sniffed from magic bytes (JPEG/PNG/WebP).
  app.get('/api/photos/:photoId', async (req, reply) => {
    const { photoId } = req.params as { photoId: string };
    const photo = await repo.getPhoto(photoId).catch(() => null);
    if (!photo) return reply.code(404).send({ error: 'not found' });
    // The bytes need the same gate as the listing: a leaked photo id was enough
    // to pull an image off a design its owner had kept private.
    const parent = await repo.get(photo.designId).catch(() => null);
    if (!parent) return reply.code(404).send({ error: 'not found' });
    if (!parent.isPublic) {
      const viewer = await userOf(req);
      if (!viewer || viewer !== parent.ownerId) return reply.code(404).send({ error: 'not found' });
    }
    const b = photo.image;
    const type =
      b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' :
      b[0] === 0x89 && b[1] === 0x50 ? 'image/png' :
      b[0] === 0x52 && b[1] === 0x49 ? 'image/webp' : 'application/octet-stream';
    // Defense-in-depth for user-uploaded bytes served from our origin:
    //  - nosniff: never let the browser MIME-sniff this into HTML/JS (helmet sets it
    //    globally too, but we pin it here since this route serves untrusted content).
    //  - Content-Disposition inline with a fixed, non-user filename: no header injection
    //    and no surprising download names.
    return reply
      .header('content-type', type)
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="photo-${photoId}.img"`)
      .header('cache-control', 'public, max-age=86400')
      .send(b);
  });

  // Delete a photo (owner of the parent design only).
  app.delete('/api/photos/:photoId', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { photoId } = req.params as { photoId: string };
    const ok = await repo.deletePhoto(photoId, userId);
    if (!ok) return reply.code(404).send({ error: 'not found or not yours' });
    return { deleted: true };
  });

  // ---------- moderation & trust review (admin only) ----------
  // The review queue: open reports with target context.
  app.get('/api/admin/reports', async (req, reply) => {
    const adminId = await requireAdmin(req, reply);
    if (!adminId) return;
    const q = req.query as { status?: string };
    const status = ['open', 'reviewed', 'actioned'].includes(q.status ?? '') ? q.status! : 'open';
    return repo.listReports(status, 100);
  });

  // Dismiss a report (no action needed) → reviewed.
  app.post('/api/admin/reports/:id/dismiss', async (req, reply) => {
    const adminId = await requireAdmin(req, reply);
    if (!adminId) return;
    const { id } = req.params as { id: string };
    const ok = await repo.setReportStatus(id, 'reviewed');
    if (!ok) return reply.code(404).send({ error: 'report not found' });
    return { status: 'reviewed' };
  });

  // Take a reported design down: make it private + mark its open reports actioned.
  app.post('/api/admin/designs/:id/takedown', async (req, reply) => {
    const adminId = await requireAdmin(req, reply);
    if (!adminId) return;
    const { id } = req.params as { id: string };
    const ok = await repo.takedownDesign(id);
    if (!ok) return reply.code(404).send({ error: 'design not found' });
    return { takendown: true };
  });

  /**
   * Is email working right now?
   *
   * Admin-gated because the answer names the sending domain and quotes the
   * provider's refusal verbatim, which can carry account details. This exists
   * so "verification emails stopped arriving" is a question with an answer
   * rather than an afternoon of guessing: it distinguishes a missing key from a
   * refused key from an unverified sending domain from an exhausted quota.
   */
  app.get('/api/admin/email', async (req, reply) => {
    if (!(await adminAccess(req))) return reply.code(403).send({ error: 'forbidden' });
    const h = emailHealth();
    return {
      ...h,
      // Spelled out, because the whole point is that nobody has to infer it.
      summary: !h.delivering
        ? 'NOT DELIVERING: no RESEND_API_KEY is set, so every message is written to the server log and nobody receives it.'
        : h.lastError && (!h.lastSentAt || h.lastErrorAt! > h.lastSentAt)
          ? `FAILING: the last attempt was refused — ${h.lastError}`
          : h.sent > 0
            ? `delivering; ${h.sent} sent, ${h.failed} refused since this process started`
            : 'configured, but nothing has been sent since this process started',
    };
  });

  /**
   * Send one real message to a chosen address and report exactly what happened.
   *
   * The provider's own words, not a summary — "The tifomaker.org domain is not
   * verified", "You have reached your daily sending quota" and "API key is
   * invalid" are three completely different problems that all present to a user
   * as an email that never arrives.
   */
  app.post('/api/admin/email/test', async (req, reply) => {
    if (!(await adminAccess(req))) return reply.code(403).send({ error: 'forbidden' });
    if (!options.emailSender) return reply.code(503).send({ ok: false, error: 'no email sender is configured' });
    const to = String((req.body as { to?: unknown } | null)?.to ?? '').trim();
    if (!to || to.length > MAX_EMAIL || !EMAIL.test(to)) {
      return reply.code(400).send({ ok: false, error: 'a valid address is required' });
    }
    const stamp = new Date().toISOString();
    try {
      await options.emailSender.send({
        to,
        subject: `TifoMaker email test · ${stamp}`,
        html: `<p>This is a test from the TifoMaker admin dashboard.</p><p>Sent ${stamp}.</p>`,
        text: `This is a test from the TifoMaker admin dashboard.\nSent ${stamp}.`,
      });
      const h = emailHealth();
      return {
        ok: true,
        delivering: h.delivering,
        note: h.delivering
          ? 'the provider accepted it — if it does not arrive, the problem is after the hand-off (SPF/DKIM, spam, or the recipient)'
          : 'NO KEY IS SET: this went to the server log, not to an inbox',
      };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: String((err as Error)?.message ?? err).slice(0, 400) });
    }
  });

  // Photo verification queue.
  app.get('/api/admin/photos/unverified', async (req, reply) => {
    const adminId = await requireAdmin(req, reply);
    if (!adminId) return;
    return repo.listUnverifiedPhotos(100);
  });

  // Confirm (or un-confirm) a photo as a genuine match.
  app.post('/api/admin/photos/:photoId/verify', async (req, reply) => {
    const adminId = await requireAdmin(req, reply);
    if (!adminId) return;
    const { photoId } = req.params as { photoId: string };
    const verified = (req.body as { verified?: unknown } | null)?.verified !== false; // default true
    const ok = await repo.setPhotoVerified(photoId, verified);
    if (!ok) return reply.code(404).send({ error: 'photo not found' });
    return { verified };
  });

  // A moderator can remove any photo outright (not just its owner).
  app.delete('/api/admin/photos/:photoId', async (req, reply) => {
    const adminId = await requireAdmin(req, reply);
    if (!adminId) return;
    const { photoId } = req.params as { photoId: string };
    const ok = await repo.deletePhotoAsModerator(photoId);
    if (!ok) return reply.code(404).send({ error: 'photo not found' });
    return { deleted: true };
  });

  // Like / dislike / clear. value: 1, -1, or 0.
  app.post('/api/designs/:id/vote', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const raw = (req.body as { value?: unknown } | null)?.value;
    const value = raw === 1 || raw === -1 || raw === 0 ? raw : null;
    if (value === null) return reply.code(400).send({ error: 'value must be 1, -1, or 0' });
    const result = await repo.vote(id, userId, value as -1 | 0 | 1);
    if (!result) return reply.code(404).send({ error: 'not found' });
    return result;
  });

  // Public profile: a user's published designs + the public designs they liked.
  app.get('/api/users/:id/profile', async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await auth.getUserById(id).catch(() => null);
    if (!user) return reply.code(404).send({ error: 'not found' });
    const viewerId = await userOf(req);
    const [created, liked, socialProfile] = await Promise.all([
      repo.listPublic({ sort: 'recent', viewerId }).then((all) => all.filter((d) => d.ownerId === id)),
      repo.listLikedBy(id),
      options.social ? options.social.getProfile(id, viewerId) : Promise.resolve(null),
    ]);
    return {
      id: user.id,
      username: user.username,
      created,
      liked,
      // Social graph fields (present when the social layer is enabled).
      handle: socialProfile?.handle ?? null,
      followerCount: socialProfile?.followerCount ?? 0,
      followingCount: socialProfile?.followingCount ?? 0,
      designCount: socialProfile?.designCount ?? created.length,
      isFollowing: socialProfile?.isFollowing ?? false,
    };
  });

  // ---------- designs ----------
  app.get('/api/designs', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    return repo.listByOwner(userId);
  });

  app.post('/api/designs', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const body = req.body as {
      title?: string;
      templateId?: string;
      templateVersion?: number;
      palette?: unknown;
      cellsGzB64?: string;
      thumbnailPngB64?: string;
    };
    const count = seatCount(body.templateId ?? '', body.templateVersion ?? -1);
    if (typeof body.title === 'string' && body.title.length > MAX_TITLE) {
      return reply.code(400).send({ error: `title must be 1..${MAX_TITLE} chars` });
    }
    if (!body.title || count === null || !validPalette(body.palette) || !body.cellsGzB64) {
      return reply.code(400).send({ error: 'title, known templateRef, palette (2-256 hex), cellsGzB64 required' });
    }
    const cellsGz = Buffer.from(body.cellsGzB64, 'base64');
    let cells: Buffer;
    try {
      cells = gunzipBytes(cellsGz);
    } catch {
      return reply.code(400).send({ error: 'cellsGzB64 is not valid gzip' });
    }
    if (cells.byteLength !== count) {
      return reply.code(400).send({ error: `cells must have ${count} bytes for this template` });
    }
    const thumb = decodeThumb(body.thumbnailPngB64, reply);
    if (thumb === undefined) return;
    return reply.code(201).send(
      await repo.create({
        title: body.title,
        templateId: body.templateId!,
        templateVersion: body.templateVersion!,
        palette: body.palette,
        cellsGz,
        ownerId: userId,
        thumbnailPng: thumb,
      }),
    );
  });

  /** Load + visibility check. Sends 404 itself when not visible. */
  /**
   * Every id this API hands out is a UUID. Anything else reached the driver and
   * came back as an unhandled Postgres error — "invalid input syntax for type
   * uuid" — which the error handler correctly turned into a 500. A 500 is the
   * server saying it broke; a client sending `abc` as an id has sent a bad
   * request, and saying so is both truer and cheaper than a round trip to the
   * database to find out.
   */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const badId = (id: unknown, reply: FastifyReply): boolean => {
    if (typeof id === 'string' && UUID_RE.test(id)) return false;
    void reply.code(400).send({ error: 'invalid id' });
    return true;
  };

  const getVisible = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await repo.get(id).catch(() => null);
    const userId = await userOf(req);
    if (!rec || (!rec.isPublic && rec.ownerId !== userId)) {
      await reply.code(404).send({ error: 'not found' });
      return null;
    }
    return { rec, userId };
  };

  /** Load + ownership check for mutations. Sends 404/401/403 itself. */
  const getOwned = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await repo.get(id).catch(() => null);
    const userId = await userOf(req);
    if (!rec || (!rec.isPublic && rec.ownerId !== userId)) {
      await reply.code(404).send({ error: 'not found' });
      return null;
    }
    if (!userId) {
      await reply.code(401).send({ error: 'authentication required' });
      return null;
    }
    if (rec.ownerId !== userId) {
      await reply.code(403).send({ error: 'not your design' });
      return null;
    }
    return rec;
  };

  app.get('/api/designs/:id', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    const { cellsGz, ...meta } = v.rec;
    // Creator name is needed by the public share page; resolve it from the owner id.
    const owner = meta.ownerId ? await auth.getUserById(meta.ownerId).catch(() => null) : null;
    return { ...meta, ownerName: owner?.username ?? null, cellsGzB64: cellsGz.toString('base64') };
  });

  app.get('/api/designs/:id/thumbnail.png', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    const png = await repo.getThumbnail(v.rec.id);
    if (!png) return reply.code(404).send({ error: 'no thumbnail' });
    return reply.header('content-type', 'image/png').header('cache-control', 'no-cache').send(png);
  });

  // ---------- sharing system ----------
  // Platforms we accept in the analytics log (whitelist keeps the table clean).
  const SHARE_PLATFORMS = new Set([
    'whatsapp', 'x', 'twitter', 'instagram', 'tiktok', 'facebook', 'discord',
    'telegram', 'reddit', 'email', 'copy', 'webshare', 'qr', 'link',
  ]);

  // Branded 1200x630 social card (public OR owner via getVisible). Falls back to
  // the existing thumbnail if no OG image has been generated yet.
  /**
   * The link-preview image for one design.
   *
   * Served from /og/ as well as /api/, and the card points at /og/. robots.txt
   * has to disallow /api/ because everything else under it is JSON, and
   * Twitterbot, facebookexternalhit, LinkedInBot and TelegramBot all obey
   * robots.txt - so a card image living under /api/ is fetched by none of them.
   * Wildcard Allow rules are unevenly supported, so the path moves instead.
   */
  const sendDesignCard = async (req: FastifyRequest, reply: FastifyReply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    // Never 404 here. This URL is what og:image points at, and a card image that
    // fails to fetch is cached as a failure for up to a week on X and a month on
    // Facebook - so one missing thumbnail silently kills the preview for every
    // share of that design long after the thumbnail arrives. Designs published
    // before the og-image upload existed, or whose canvas export failed, land on
    // the site card instead of nothing.
    const img =
      (await repo.getOgImage(v.rec.id)) ?? (await repo.getThumbnail(v.rec.id)) ?? defaultCardPng;
    if (!img) return reply.code(404).send({ error: 'no image' });
    return reply
      .header('content-type', 'image/png')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=3600')
      .send(img);
  };
  app.get('/og/t/:id.png', sendDesignCard);
  // Kept so cards already sitting in a platform's cache keep resolving.
  app.get('/api/designs/:id/og.png', sendDesignCard);

  // Store the branded OG card (owner only). Decoupled from the save path so the
  // core save stays lean; the client posts it right after a public save.
  app.post('/api/designs/:id/og-image', async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const b64 = (req.body as { ogPngB64?: string } | null)?.ogPngB64;
    if (typeof b64 !== 'string' || !b64) return reply.code(400).send({ error: 'ogPngB64 required' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) {
      return reply.code(400).send({ error: 'image must be 1..2MB' });
    }
    const ok = await repo.setOgImage(rec.id, rec.ownerId!, buf);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // Count a public view. Private designs are a 404 to non-owners via getVisible,
  // and we refuse to count views on a private design even for the owner.
  app.post('/api/designs/:id/view', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    if (!v.rec.isPublic) return reply.code(403).send({ error: 'not public' });
    const views = await repo.incrementView(v.rec.id);
    return { views };
  });

  // Log a share (button press) or open (link visit) per platform. Public only.
  app.post('/api/designs/:id/share', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    if (!v.rec.isPublic) return reply.code(403).send({ error: 'not public' });
    const body = (req.body ?? {}) as { platform?: unknown; kind?: unknown };
    const platform = typeof body.platform === 'string' ? body.platform.toLowerCase() : '';
    if (!SHARE_PLATFORMS.has(platform)) return reply.code(400).send({ error: 'unknown platform' });
    const kind = body.kind === 'open' ? 'open' : 'share';
    await repo.recordShare(v.rec.id, platform, kind).catch(() => {});
    return reply.code(204).send();
  });

  // Aggregate share/view analytics for a (visible) design.
  app.get('/api/designs/:id/stats', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    return repo.shareStats(v.rec.id);
  });

  // Production distribution PDF. Accepts the design inline (cells + palette +
  // template) so it works whether or not the design is saved. Generates server-
  // side (pdfkit is Node-only) and streams the file back. Free tier watermarks.
  // The heaviest route here by far (0.5-1.9s of CPU even with valid input), and
  // reachable without an account. The global 300/min let one IP demand ~9x the
  // CPU the process has.
  const pdfLimit = options.rateLimit ? { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } } : {};
  app.post('/api/export/pdf', pdfLimit, async (req, reply) => {
    const userId = await userOf(req); // signed-in users get clean (un-watermarked) output
    const body = (req.body ?? {}) as {
      title?: string;
      templateId?: string;
      templateVersion?: number;
      palette?: unknown;
      cellsGzB64?: string;
      cardsPerBag?: number;
      colorNames?: string[];
    };
    const tpl = TEMPLATES.find((t) => t.id === body.templateId && t.version === (body.templateVersion ?? t.version));
    if (!tpl) return reply.code(400).send({ error: 'unknown templateId/version' });
    if (!validPalette(body.palette) || !body.cellsGzB64) {
      return reply.code(400).send({ error: 'palette and cellsGzB64 required' });
    }
    let cells: Buffer;
    try {
      cells = gunzipBytes(Buffer.from(body.cellsGzB64, 'base64'));
    } catch {
      return reply.code(400).send({ error: 'cells not gzip' });
    }
    const map = generateSeatMap(tpl);
    if (cells.length !== map.count) {
      return reply.code(400).send({ error: `cells must have ${map.count} bytes for this template` });
    }
    const outPath = join(tmpdir(), `tifo-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    await renderDistributionPdf(
      { cells: new Uint8Array(cells), palette: body.palette as string[], seatMapRef: { id: tpl.id, version: tpl.version } },
      map,
      {
        designTitle: body.title || 'Tifo',
        stadiumName: tpl.name,
        cardsPerBag: body.cardsPerBag ?? 100,
        // pdfkit flows this text and auto-adds pages, so an oversized name is
        // quadratic synchronous CPU on the only thread the server has. Measured
        // 8s from one 20KB entry; longer ones run for minutes.
        colorNames: Array.isArray(body.colorNames)
          ? body.colorNames.slice(0, 256).map((n) => (typeof n === 'string' ? n.slice(0, 40) : ''))
          : undefined,
        watermark: !userId, // anonymous/free → watermark; signed-in → clean
      },
      outPath,
    );
    const pdf = await readFile(outPath);
    await unlink(outPath).catch(() => {});
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${(body.title || 'tifo').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-distribution.pdf"`)
      .send(pdf);
  });

  app.put('/api/designs/:id', async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const body = req.body as { palette?: unknown; cellsGzB64?: string; thumbnailPngB64?: string };
    if (!validPalette(body.palette) || !body.cellsGzB64) {
      return reply.code(400).send({ error: 'palette and cellsGzB64 required' });
    }
    const count = seatCount(rec.templateId, rec.templateVersion)!;
    const cellsGz = Buffer.from(body.cellsGzB64, 'base64');
    let cells: Buffer;
    try {
      cells = gunzipBytes(cellsGz);
    } catch {
      return reply.code(400).send({ error: 'cellsGzB64 is not valid gzip' });
    }
    if (cells.byteLength !== count) {
      return reply.code(400).send({ error: `cells must have ${count} bytes for this template` });
    }
    const thumb = decodeThumb(body.thumbnailPngB64, reply);
    if (thumb === undefined) return;
    return repo.updateCells(rec.id, cellsGz, body.palette, thumb);
  });

  app.patch('/api/designs/:id', async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const body = (req.body ?? {}) as { title?: unknown; isPublic?: unknown };
    const patch: { title?: string; isPublic?: boolean } = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.length === 0 || body.title.length > 120) {
        return reply.code(400).send({ error: 'title must be 1..120 chars' });
      }
      patch.title = body.title;
    }
    if (body.isPublic !== undefined) {
      if (typeof body.isPublic !== 'boolean') return reply.code(400).send({ error: 'isPublic must be boolean' });
      patch.isPublic = body.isPublic;
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nothing to patch' });
    const wasPublic = rec.isPublic;
    const result = await repo.patchMeta(rec.id, patch);
    // Newly published → notify the owner's followers (best-effort, non-blocking).
    if (options.social && patch.isPublic === true && !wasPublic && rec.ownerId) {
      options.social.notifyFollowersOfPost(rec.ownerId, rec.id).catch(() => {});
    }
    return result;
  });

  app.post('/api/designs/:id/revisions', async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const body = req.body as { indicesB64?: string; beforeB64?: string; afterB64?: string };
    if (!body.indicesB64 || !body.beforeB64 || !body.afterB64) {
      return reply.code(400).send({ error: 'indicesB64, beforeB64, afterB64 required' });
    }
    const indices = u32FromB64(body.indicesB64);
    const before = u8FromB64(body.beforeB64);
    const after = u8FromB64(body.afterB64);
    if (indices.length !== before.length || indices.length !== after.length || indices.length === 0) {
      return reply.code(400).send({ error: 'diff arrays must be non-empty and equal length' });
    }
    const count = seatCount(rec.templateId, rec.templateVersion)!;
    const cells = new Uint8Array(gunzipBytes(rec.cellsGz));
    for (let k = 0; k < indices.length; k++) {
      if (indices[k] >= count) return reply.code(400).send({ error: `index ${indices[k]} out of range` });
    }
    for (let k = 0; k < indices.length; k++) cells[indices[k]] = after[k];

    const newGz = gzipBytes(cells);
    const willSnapshot = (rec.revisionCount + 1) % SNAPSHOT_EVERY === 0;
    const meta = await repo.appendRevision(
      rec.id,
      {
        indices: Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
        before: Buffer.from(before.buffer, before.byteOffset, before.byteLength),
        after: Buffer.from(after.buffer, after.byteOffset, after.byteLength),
      },
      newGz,
      willSnapshot ? newGz : null,
    );
    return reply.code(201).send(meta);
  });

  app.get('/api/designs/:id/revisions', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    const limit = Math.min(200, Number((req.query as { limit?: string }).limit ?? 50));
    return repo.listRevisions(v.rec.id, limit);
  });

  app.post('/api/designs/:id/fork', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    if (!v.userId) return reply.code(401).send({ error: 'authentication required' });
    const title = cleanTitle((req.body as { title?: string } | null)?.title, `${v.rec.title} (fork)`);
    return reply.code(201).send(await repo.fork(v.rec.id, title, v.userId));
  });

  // ============ SOCIAL ENDPOINTS ============
  const social = options.social;
  const socialOn = (reply: FastifyReply): boolean => {
    if (!social) {
      void reply.code(503).send({ error: 'social features not enabled' });
      return false;
    }
    return true;
  };

  // Set creator's explanation + remix permission on a design (owner only).
  app.put('/api/designs/:id/publish-meta', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { description?: unknown; allowRemix?: unknown };
    const description = typeof body.description === 'string' ? body.description : null;
    const allowRemix = body.allowRemix !== false;
    const ok = await social!.setPublishMeta(id, userId, description, allowRemix);
    if (!ok) return reply.code(404).send({ error: 'not found or not yours' });
    return { ok: true };
  });

  // Remix a public, remixable design into the caller's account.
  app.post('/api/designs/:id/remix', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const title = (req.body as { title?: string } | null)?.title;
    const rec = await repo.get(id).catch(() => null);
    const remixTitle = cleanTitle(title, `${rec?.title ?? 'Tifo'} (remix)`);
    const created = await social!.remix(id, userId, remixTitle);
    if (!created) return reply.code(403).send({ error: 'this design cannot be remixed' });
    return reply.code(201).send(created);
  });

  // Follow / unfollow a user.
  app.post('/api/users/:id/follow', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    if (badId(id, reply)) return;
    await social!.follow(userId, id);
    return { following: true };
  });
  app.delete('/api/users/:id/follow', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    if (badId(id, reply)) return;
    await social!.unfollow(userId, id);
    return { following: false };
  });

  // Public profile is served by the merged /api/users/:id/profile above
  // (it includes the social graph fields when the social layer is enabled).

  // User search (typeahead). Signed-in only, and a real prefix is required: as a
  // public endpoint that answered "?q=a" it let anyone walk the entire user list one
  // letter at a time, which is exactly the enumeration the social layer must not allow.
  app.get('/api/users/search', async (req, reply) => {
    if (!socialOn(reply)) return;
    if (!(await requireUser(req, reply))) return;
    const q = ((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return reply.send([]);
    return social!.searchUsers(q, 12);
  });

  // Comments: list (public), add (auth), delete (author or design owner).
  // Both gated by getVisible, like every other design route. Without it, anyone
  // could post a comment on a PRIVATE design — which the owner then received a
  // notification about — and read the thread back anonymously, while the design
  // itself answered 404. The comment is on the design; it cannot be more visible
  // than the design is.
  app.get('/api/designs/:id/comments', async (req, reply) => {
    if (!socialOn(reply)) return;
    const v = await getVisible(req, reply);
    if (!v) return;
    return social!.listComments(v.rec.id);
  });
  app.post('/api/designs/:id/comments', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const v = await getVisible(req, reply);
    if (!v) return;
    const body = (req.body ?? {}) as { body?: unknown; parentId?: unknown };
    if (typeof body.body !== 'string' || !body.body.trim()) {
      return reply.code(400).send({ error: 'comment body required' });
    }
    const parentId = typeof body.parentId === 'string' ? body.parentId : null;
    const comment = await social!.addComment(v.rec.id, userId, body.body, parentId);
    if (!comment) return reply.code(400).send({ error: 'could not add comment' });
    return reply.code(201).send(comment);
  });
  app.delete('/api/comments/:commentId', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { commentId } = req.params as { commentId: string };
    const ok = await social!.deleteComment(commentId, userId);
    if (!ok) return reply.code(404).send({ error: 'not found or not allowed' });
    return { deleted: true };
  });

  // Notifications feed.
  app.get('/api/notifications', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const [items, unread] = await Promise.all([
      social!.listNotifications(userId, 50),
      social!.unreadCount(userId),
    ]);
    return { unread, items };
  });
  app.post('/api/notifications/read', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const id = (req.body as { id?: string } | null)?.id;
    await social!.markNotificationsRead(userId, id);
    return { ok: true };
  });

  // B2B lead capture from the For Clubs page. Public + lightly validated.
  app.post('/api/leads', async (req, reply) => {
    if (!options.leads) return reply.code(503).send({ error: 'lead capture not enabled' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reply.code(400).send({ error: 'a name and a valid email are required' });
    }
    const lead = await options.leads.createLead({
      name,
      email,
      organization: typeof body.organization === 'string' ? body.organization.trim() : null,
      orgType: typeof body.orgType === 'string' ? body.orgType.trim() : null,
      message: typeof body.message === 'string' ? body.message.trim() : null,
    });
    return reply.code(201).send({ ok: true, id: lead.id });
  });


  // Serve the built frontend from the same origin as the API, so the client's
  // relative `/api/...` calls just work in production (no proxy, no CORS). A
  // catch-all returns index.html for client-side routes; unknown /api paths 404.
  if (options.staticDir) {
    const staticDir = options.staticDir;
    const indexHtml = readFileSync(join(staticDir, 'index.html'), 'utf8');
    /**
     * Absolute base for anything we put IN the page - og:url, og:image, canonical.
     * Same rule as email links: PUBLIC_URL wins, otherwise the Host has to be one
     * we know before it is echoed back, because a forged Host would otherwise
     * write an attacker's domain into the canonical URL of our own card.
     */
    const origin = (req: FastifyRequest): string => {
      if (options.publicUrl) return options.publicUrl.replace(/\/+$/, '');
      const host = String(req.headers.host ?? '');
      const bare = host.split(':')[0]?.toLowerCase() ?? '';
      if (!ALLOWED_EMAIL_HOSTS.has(bare)) return CANONICAL_ORIGIN;
      // https unless this is plainly a dev host. An http:// og:image is a
      // documented way to lose the card entirely: an edge rule that upgrades
      // http to https answers the crawler with a 301 the origin never sees,
      // and og:image:secure_url is https by definition.
      const local = bare === 'localhost' || bare === '127.0.0.1';
      return `${local ? 'http' : 'https'}://${host}`;
    };

    /**
     * The link preview card, as HTML the crawler can actually read.
     *
     * No social crawler runs JavaScript - not Twitterbot, facebookexternalhit,
     * LinkedInBot, WhatsApp, Telegram, Discord or Slack - so a single-page app
     * that sets these from JS shows an empty card on every platform. They have
     * to be in the bytes the server sends.
     *
     * Three details that are each enough on their own to blank the card:
     *  - og:image MUST be absolute. A relative path is never resolved.
     *  - twitter:card has no Open Graph fallback. Without it X renders the small
     *    thumbnail card and Discord crops to an 80px square.
     *  - width/height let a card render before the image has downloaded; without
     *    them the image is commonly missing on the FIRST share of a URL.
     */
    const CARD_PATH = '/og-card.png';
    const CARD_ALT =
      'A stadium bowl with a red and white tifo across the stands, designed in TifoMaker.';

    const cardTags = (
      req: FastifyRequest,
      o: { title: string; description: string; path: string; image?: string; alt?: string },
    ): string => {
      const base = origin(req);
      const url = `${base}${o.path}`;
      const img = o.image ?? `${base}${CARD_PATH}`;
      const alt = o.alt ?? CARD_ALT;
      return [
        `<title>${esc(o.title)}</title>`,
        `<link rel="canonical" href="${esc(url)}" />`,
        `<meta name="description" content="${esc(o.description)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="TifoMaker" />`,
        `<meta property="og:locale" content="en_US" />`,
        `<meta property="og:url" content="${esc(url)}" />`,
        `<meta property="og:title" content="${esc(o.title)}" />`,
        `<meta property="og:description" content="${esc(o.description)}" />`,
        `<meta property="og:image" content="${esc(img)}" />`,
        `<meta property="og:image:secure_url" content="${esc(img)}" />`,
        `<meta property="og:image:type" content="image/png" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="${esc(alt)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${esc(o.title)}" />`,
        `<meta name="twitter:description" content="${esc(o.description)}" />`,
        `<meta name="twitter:image" content="${esc(img)}" />`,
        `<meta name="twitter:image:alt" content="${esc(alt)}" />`,
      ].join('\n    ');
    };

    /**
     * Put the card into a static page. Any title or og:/twitter: tag already in
     * the file is dropped first, so there is exactly one of each - duplicates are
     * resolved differently by each platform and produce cards nobody intended.
     */
    const withCard = (
      html: string,
      req: FastifyRequest,
      o: { title: string; description: string; path: string; image?: string; alt?: string },
    ): string => {
      const stripped = html
        .replace(/<title>[\s\S]*?<\/title>/gi, '')
        .replace(/<meta[^>]+(?:property|name)=["'](?:og:|twitter:)[^"']*["'][^>]*>\s*/gi, '')
        .replace(/<link[^>]+rel=["']canonical["'][^>]*>\s*/gi, '');
      return injectOnce(stripped, /<head>/i, `<head>\n    ${cardTags(req, o)}`);
    };
    /**
     * Insert a built block into a page WITHOUT letting its content be reinterpreted.
     *
     * String.prototype.replace expands $&, $` and $' when the replacement is a
     * string. Design titles reach the injected <meta> block, and "$'" means
     * "everything after the match" - with <head> near the top of a 31KB page,
     * each pair re-emitted almost the whole document. Measured: a 400-byte title
     * produced a 31.6MB response, and titles have no length cap on create, so a
     * 20KB one is roughly 1.5GB and takes the process out. A replacer FUNCTION
     * is returned verbatim, with no dollar expansion at all.
     */
    /**
     * Insert `replacement` at the first match of `pattern`. `$&` in the
     * replacement stands for the matched text, so callers can prepend to an
     * element without having to restate its attributes — restating them is how
     * adding data-i18n to #grid-loading silently switched the crawler feed off.
     */
    const injectOnce = (haystack: string, pattern: RegExp, replacement: string): string =>
      haystack.replace(pattern, (m) => replacement.replace(/\$&/g, m));

    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    /**
     * The meta description for one design page.
     *
     * Every design page used to carry the same sentence, which makes a set of
     * pages look like near-duplicates to a search engine and gives a searcher
     * no reason to click one over another. This builds a line out of what the
     * design actually is.
     *
     * The creator's own words win when they wrote any: nothing generated here
     * beats a human describing their own tifo. Otherwise it is assembled from
     * the stadium, its size, and who made it - facts that genuinely differ from
     * one design to the next.
     */
    const describeDesign = (
      rec: { title: string; templateId: string; description?: string | null; remixedFrom?: string | null },
      ownerName: string | null,
    ): string => {
      const own = (rec.description ?? '').trim().replace(/\s+/g, ' ');
      if (own.length >= 40) return own.slice(0, 300);

      const tpl = templates.find((t) => t.id === rec.templateId);
      const where = tpl ? tpl.name : 'a stadium';
      const seats = tpl?.seatCount ? `${tpl.seatCount.toLocaleString('en-US')} seats` : null;
      const name = (rec.title ?? '').trim();

      const parts: string[] = [];
      parts.push(name && !/^untitled/i.test(name) ? `"${name}", a tifo` : 'A tifo');
      parts.push(`on ${where}`);
      if (seats) parts.push(`across ${seats}`);
      if (ownerName) parts.push(`by @${ownerName}`);
      let line = `${parts.join(' ')}.`;
      if (rec.remixedFrom) line += ' Remixed from another supporter\u2019s design.';
      // Short one, so give the searcher the next useful fact.
      if (own) line += ` ${own}`;
      else line += ' Open it to view the full stand in 3D, or remix it into your own.';
      return line.slice(0, 300);
    };

    // Share links: /d/:id. Inject Open Graph + Twitter Card tags so a pasted
    // link shows a rich preview (title, author, the stadium thumbnail) in
    // WhatsApp, Twitter/X, Discord, Slack, etc., before any JS runs. Humans
    // get the same HTML and the SPA boots and loads the design normally.
    app.get('/d/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const rec = await repo.get(id).catch(() => null);
      const base = origin(req);
      let title = 'Tifo Maker';
      let description = 'Design a 60,000-seat stadium tifo and share it.';
      let image = `${base}/og-default.png`;
      // Only expose metadata for PUBLIC designs (private ones stay unlisted).
      if (rec && rec.isPublic) {
        const owner = rec.ownerId ? await auth.getUserById(rec.ownerId).catch(() => null) : null;
        title = `${rec.title}: Tifo Maker`;
        description = describeDesign(rec, owner?.username ?? null);
        const thumb = await repo.getThumbnail(rec.id).catch(() => null);
        if (thumb) image = `${base}/api/designs/${rec.id}/thumbnail.png`;
      }
      const meta = [
        `<title>${esc(title)}</title>`,
        `<meta name="description" content="${esc(description)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="Tifo Maker" />`,
        `<meta property="og:title" content="${esc(title)}" />`,
        `<meta property="og:description" content="${esc(description)}" />`,
        `<meta property="og:image" content="${esc(image)}" />`,
        `<meta property="og:url" content="${esc(base)}/d/${esc(id)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${esc(title)}" />`,
        `<meta name="twitter:description" content="${esc(description)}" />`,
        `<meta name="twitter:image" content="${esc(image)}" />`,
        // /d/:id and /t/:id render the same design. Point both at /t/:id so search
        // engines consolidate them instead of treating each as duplicate content.
        `<link rel="canonical" href="${esc(base)}/t/${esc(id)}" />`,
      ].join('\n    ');
      // Inject after <head>, and drop the SPA's default <title> to avoid a dupe.
      const html = injectOnce(
        indexHtml.replace(/<title>.*?<\/title>/i, ''),
        /<head>/i,
        `<head>\n    ${meta}`,
      );
      return reply.type('text/html').send(html);
    });

    // Dedicated public VIEW page at /t/:id, the canonical share link. Serves the
    // standalone share page with a branded OG/Twitter card so it previews richly
    // in WhatsApp/X/Discord/Telegram/Facebook. Private/unknown designs get the
    // generic card (no metadata leak); the page client shows "unavailable".
    let shareHtmlRaw: string | null = null;
    try {
      shareHtmlRaw = readFileSync(join(staticDir, 'share.html'), 'utf8');
    } catch {
      shareHtmlRaw = null; // API-only build without the share page
    }
    if (shareHtmlRaw) {
      const sharePage = shareHtmlRaw;
      app.get('/t/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const rec = await repo.get(id).catch(() => null);
        const base = origin(req);
        let title = 'TifoMaker';
        let description = 'A stadium tifo on TifoMaker, open it to view in full.';
        let image = `${base}${CARD_PATH}`;
        let alt: string | undefined;
        if (rec && rec.isPublic) {
          const owner = rec.ownerId ? await auth.getUserById(rec.ownerId).catch(() => null) : null;
          title = `${rec.title}: TifoMaker`;
          description = describeDesign(rec, owner?.username ?? null);
          image = `${base}/og/t/${rec.id}.png`;
          // Alt text describes the picture, not the page: what a card reader hears.
          alt = `"${rec.title}", a stadium tifo designed in TifoMaker${
            owner?.username ? ` by @${owner.username}` : ''
          }.`;
        }
        const html = withCard(sharePage, req, { title, description, path: `/t/${id}`, image, alt });
        return reply.type('text/html').send(html);
      });
    }

    // Marketing landing at the root; the editor app lives at /app. Return users
    // bookmark /app; first-time visitors get the pitch. Share links (/d/:id)
    // and the SPA fallback both serve the editor.
    const landingHtml = readFileSync(join(staticDir, 'landing.html'), 'utf8');
    // Held in memory so the og.png fallback never touches the disk per request.
    try {
      defaultCardPng = readFileSync(join(staticDir, 'og-card.png'));
    } catch {
      /* no card in this build; og.png then 404s exactly as it used to */
    }
    // HTML entry points are served no-cache so the browser/CDN always revalidate
    // and never reference stale hashed chunks after a deploy (the cause of
    // "Failed to load module script / MIME text/html" errors). The hashed
    // /assets/* files are immutable by name, so they stay long-cacheable.
    app.get('/', async (req, reply) =>
      reply
        .header('cache-control', 'no-cache')
        .type('text/html')
        .send(
          withCard(landingHtml, req, {
            title: 'TifoMaker: design the display 60,000 fans will never forget',
            description:
              'Design a stadium tifo in your browser, watch it light up the stands in 3D, and export the seat-by-seat instructions that make it real on match day. Free, no account needed to start.',
            path: '/',
          }),
        ));
    app.get('/app', async (req, reply) =>
      reply
        .header('cache-control', 'no-cache')
        .type('text/html')
        .send(
          withCard(indexHtml, req, {
            title: 'The TifoMaker editor: paint 60,000 seats',
            description:
              'Paint a tifo seat by seat, drop in a crest or text, and watch the whole bowl update in 3D as you work. Free, in the browser, no download.',
            path: '/app',
          }),
        ));
    // Public developer spec for the .tifo format.
    try {
      const specHtml = readFileSync(join(staticDir, 'tifo-spec.html'), 'utf8');
      app.get('/tifo-spec', async (req, reply) =>
        reply.type('text/html').send(
          withCard(specHtml, req, {
            title: 'The .tifo format: an open spec for stadium choreography',
            description:
              'The open file format behind TifoMaker: seat maps, palettes and per-seat instructions, documented so anyone can read or write a tifo.',
            path: '/tifo-spec',
          }),
        ));
    } catch {
      /* spec page optional in API-only builds */
    }

    // The standalone community / social feed page (third pillar).
    //
    // The grid is built client-side, which meant a crawler saw a heading, a
    // promise and no links: every published tifo was an ORPHAN, reachable only
    // through sitemap.xml. Orphan pages get crawled rarely and rank badly,
    // because nothing on the site points at them. So the server injects a real
    // list of links before sending the page. The client still renders the rich
    // interactive grid on top and hides this one, so nothing is shown twice and
    // nobody sees a flash of a second list.
    try {
      const communityHtml = readFileSync(join(staticDir, 'community.html'), 'utf8');
      app.get('/community', async (req, reply) => {
        let items: { id: string; title: string; ownerName: string; hasThumbnail: boolean }[] = [];
        try {
          items = await repo.listPublic({ sort: 'recent', limit: GALLERY_PAGE });
        } catch {
          items = []; // a failed query must never take the page down
        }
        const base = origin(req);
        const list = items
          .map((d) => {
            const name = d.title?.trim() || 'Untitled tifo';
            const thumb = d.hasThumbnail
              ? `<img src="${base}/api/designs/${esc(d.id)}/thumbnail.png" alt="${esc(name)}" width="320" height="200" loading="lazy" />`
              : '';
            // /t/:id is the canonical URL for a design, so link that, not /d/:id.
            return `<li><a href="/t/${esc(d.id)}">${thumb}<span>${esc(name)}</span></a>`
              + `<small> by ${esc(d.ownerName || 'a supporter')}</small></li>`;
          })
          .join('');
        const seo = items.length
          ? `<nav id="seo-feed" class="seo-feed" aria-label="Published tifos"><ul>${list}</ul></nav>`
          : '';
        const withFeed = injectOnce(
          communityHtml,
          /<div class="grid-loading" id="grid-loading"[^>]*>/i,
          `${seo}$&`,
        );
        const html = withCard(withFeed, req, {
          title: 'The tifo community: displays from supporters worldwide',
          description:
            'Browse tifos designed by supporters around the world. Like, comment, follow the people making them, and remix any display into your own.',
          path: '/community',
        });
        return reply.type('text/html').send(html);
      });
    } catch {
      /* community page optional in API-only builds */
    }

    // Match-day QR landing: fans scan one stadium-wide code → /s/:id → find seat.
    try {
      const seatHtml = readFileSync(join(staticDir, 'seat.html'), 'utf8');
      app.get('/s/:id', async (_req, reply) => reply.type('text/html').send(seatHtml));
    } catch {
      /* seat page optional in API-only builds */
    }

    // B2B "For Clubs" enterprise page with lead capture.
    try {
      const clubsHtml = readFileSync(join(staticDir, 'clubs.html'), 'utf8');
      app.get('/clubs', async (req, reply) =>
        reply.type('text/html').send(
          withCard(clubsHtml, req, {
            title: 'TifoMaker for clubs: run the whole stand like a production',
            description:
              'Your actual venue modelled to seat-level accuracy, a branded editor for your design team, white-label fan pages and match-day exports.',
            path: '/clubs',
          }),
        ));
    } catch {
      /* clubs page optional in API-only builds */
    }

    // Legal documents (Terms, Privacy, Acceptable Use, Cookies) at /legal.
    try {
      const legalHtml = readFileSync(join(staticDir, 'legal.html'), 'utf8');
      app.get('/legal', async (req, reply) =>
        reply.type('text/html').send(
          withCard(legalHtml, req, {
            title: 'Terms, privacy and acceptable use: TifoMaker',
            description:
              'How TifoMaker handles your designs and your data, what you can publish, and how to get in touch.',
            path: '/legal',
          }),
        ));
    } catch {
      /* legal page optional in API-only builds */
    }

    // Password-reset landing (opened from the reset email link).
    try {
      const resetHtml = readFileSync(join(staticDir, 'reset.html'), 'utf8');
      app.get('/reset', async (_req, reply) => reply.header('cache-control', 'no-cache').type('text/html').send(resetHtml));
    } catch {
      /* reset page optional in API-only builds */
    }

    // Account settings. noindex in its own <head>; nothing here is public.
    try {
      const accountHtml = readFileSync(join(staticDir, 'account.html'), 'utf8');
      app.get('/account', async (_req, reply) => reply.header('cache-control', 'no-cache').type('text/html').send(accountHtml));
    } catch {
      /* account page optional in API-only builds */
    }

    // sitemap.xml: generated per request rather than shipped as a static file, so
    // designs published after the last deploy still get discovered. robots.txt (a
    // static file in public/) points here. Public designs only: private ones must
    // never be enumerable, and /t/:id is the canonical URL for each one.
    app.get('/sitemap.xml', async (req, reply) => {
      const base = origin(req);
      const staticPages: [string, string, string][] = [
        // path, changefreq, priority
        ['/', 'weekly', '1.0'],
        ['/app', 'weekly', '0.9'],
        ['/community', 'daily', '0.8'],
        ['/clubs', 'monthly', '0.6'],
        ['/tifo-spec', 'yearly', '0.4'],
        ['/legal', 'yearly', '0.3'],
      ];
      let designs: { id: string; updatedAt: string }[] = [];
      try {
        const items = await repo.listPublic({ sort: 'recent' });
        // The protocol caps a sitemap at 50k URLs; stay well inside it.
        designs = items.slice(0, 5000).map((d) => ({ id: d.id, updatedAt: d.updatedAt }));
      } catch {
        designs = []; // a gallery failure must not take the sitemap down
      }
      const urls: string[] = [];
      for (const [path, freq, pri] of staticPages) {
        urls.push(
          `  <url>\n    <loc>${esc(base + path)}</loc>\n` +
            `    <changefreq>${freq}</changefreq>\n    <priority>${pri}</priority>\n  </url>`,
        );
      }
      for (const d of designs) {
        // lastmod is optional in the spec, and an unparseable date would throw and
        // 500 the whole sitemap, so omit the element rather than risk that.
        const t = Date.parse(d.updatedAt);
        const lastmod = Number.isFinite(t) ? `    <lastmod>${new Date(t).toISOString().slice(0, 10)}</lastmod>\n` : '';
        urls.push(
          `  <url>\n    <loc>${esc(base)}/t/${esc(d.id)}</loc>\n` +
            lastmod +
            `    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
        );
      }
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.join('\n') +
        `\n</urlset>\n`;
      return reply.header('cache-control', 'public, max-age=3600').type('application/xml').send(xml);
    });

    // index:false so the static plugin doesn't auto-serve index.html at '/'
    // (we serve the landing there instead); assets still resolve by path.
    await app.register(fastifyStatic, { root: staticDir, wildcard: false, index: false });
    // Unknown paths get a REAL 404. Previously this served the editor with a 200,
    // which meant every mistyped link and every vulnerability probe (/.git/config,
    // /wp-login.php — hundreds a week) looked to Google like a real page, producing
    // an unbounded set of soft-404 duplicates competing with the pages that matter.
    // Safe to do: every genuine page is registered explicitly above, and the client
    // only ever reads /d/:id, /t/:id and /s/:id from the URL — there is no
    // client-side router relying on this fallback.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.code(404).header('cache-control', 'no-cache').type('text/html').send(NOT_FOUND_HTML);
    });
  }

  return app;
}
