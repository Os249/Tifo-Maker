import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isDatabaseUnavailable } from './db';
import { OneLineLogController, redactUrl, requestLine, watchResponse } from './requestLog';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import helmet from 'helmet';
import fastifyStatic from '@fastify/static';
import { dummyHash, hashPassword, hashToken, issueToken, TOKEN_TTL_MS, verifyPassword } from './auth';
import { gunzipBytes, gzipBytes, u32FromB64, u8FromB64 } from './codec';
import { PDF_POOL, SCENE_POOL, SCENE_VIEW_ROOM, WorkerPool, workerFile } from './workerPool';
import { StrippedSceneCache } from './sceneCache';
import type { SceneTask } from './sceneWorker';
import type { PdfTask } from './pdfWorker';
import type { SceneVerdict } from './sceneCheck';
import { shippedTemplates } from '../../src/core/stadiumCatalog';
import { seatTable } from './seatTable';
import { validateTifo, TIFO_SCHEMA_VERSION } from '../../src/core/tifoFormat';

import type { AiBudgetRepository, AiEventsRepository, AiUsageRepository, AuthRepository, DesignRepository, EventsRepository, FacetBase, FacetScope, LeadsRepository, SocialRepository, UserRow } from './repo';
import { contentHash } from './repo';
import { picturesStatus } from './imageAssets';
import { textModelsStatus } from './aiProvider';
import { imageHealth } from './imageHealth';
import { registerAiRoutes, safeEqual, verifyUnlock, warmUnlockKey } from './aiRoutes';
import { stadiumPlan } from './stadiumPlan';
import { emailHealth, type EmailSender } from './email';
import { button, codeBox, layoutEmail, para, smallPrint, textFooter } from './emailLayout';
import { clientKey, proxyModeFrom, trustProxyFor, viaCloudflare } from './proxyTrust';
import { RESET_TO_ADDRESS, SendBudget, VERIFY_BY_ACCOUNT, VERIFY_TO_ADDRESS } from './sendBudget';
import { stripImageMetadata } from './imageMeta';
import { attachSecurityMonitor, maskEmail, type SocMonitor } from './soc';
import { RETENTION_DAYS } from './socRepo';
import { securityPosture } from './posture';
import type { StadiumSubmissionRepository } from './stadiumRepo';
import type { DailyFeatureRepository } from './featureRepo';
import { DailyFeaturePicker, utcDay, type FeaturedTifo } from './featured';
import type { AdminStatsRepository } from './statsRepo';
import { buildVisit, isSocialReferrer, type TrafficRepository } from './trafficRepo';
import { isFeedbackKind, type FeedbackContext, type FeedbackRepository } from './feedbackRepo';
import { CURSOR_MAX_CHARS, feedScope, openCursor, randomCursorKey, sealCursor, type FeedPosition } from './feedCursor';
import { ADMIN_WINDOW_MAX_DAYS } from './retention';
import { adminHtml, ADMIN_JS, ADMIN_UNLOCK_JS } from './adminPage';
import { heroPages, pickHeroPage } from './landingHero';
import { HERO_GROUND_KEYS } from '../../src/heroGrounds';
import HERO_TIFOS from '../../src/data/heroTifos.json';
import { isValidTemplate } from '../../src/core/customStadiums';
import { clubFilterOptions, COLOUR_FAMILIES } from '../../src/core/facets';
import {
  checkPassword,
  normalizePassword,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type PasswordContext,
  type PasswordProblem,
  type PasswordVerdict,
} from '../../src/core/password';
import { deriveUsername } from '../../src/core/handle';
import { escapeHtml } from '../../src/core/escape';
import { pathIn } from '../../src/core/langPath';
import { alternateLinks, checkPageText, formatCount, groundName, ogLocale, pageFile, pageText, routeIn, type PageLang } from './pageLang';
import {
  describeProviderError,
  newChallenge,
  openPending,
  PROVIDERS,
  safeReturnTo,
  sameState,
  sealPending,
  type PendingAuth,
} from './oauth';

/**
 * HTTP surface (blueprint §2.2, completed with auth + gallery):
 *
 *   GET   /health
 *   POST  /api/auth/register               { username, password } → { token, username }
 *         (password policy: src/core/password.ts, shared with the browser)
 *   POST  /api/auth/login                  { username, password } → { token, username }
 *   POST  /api/auth/logout                 (bearer)
 *   GET   /api/me                          (bearer) → { id }
 *   GET   /api/templates
 *   GET   /api/gallery                     public designs + owner names
 *   GET   /api/gallery/:id                 one public design, same card shape
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
/** The general per-client limit: every route without one of its own, 404s included. */
export const REQUESTS_PER_MINUTE = 300;
/** The shortest ORIGIN_SECRET accepted (P2.2): a long random value, never a word. */
export const ORIGIN_SECRET_MIN = 32;
/** The hashed files under /assets, in a bucket of their own (performance plan P1.27). */
export const ASSETS_PER_MINUTE = 600;
const ASSET_BUCKET = '|assets';
/** Public pictures and icons outside /assets, which may be cached for an hour (P1.29). */
const PUBLIC_PICTURE = /\.(?:png|jpe?g|webp|avif|gif|svg|ico)$/i;
/** The build's compressed copy of a file (P2.3): its name, plus one of these. */
const PRECOMPRESSED = /\.(?:br|gz)$/;
/**
 * For an answer that carries a secret (a session token, a sign-in ticket, the
 * account export): never stored, and never rewritten or recompressed by
 * anything between here and the browser (P2.3; see SECURITY-CHECKS.md).
 */
const SECRET_NO_STORE = 'no-store, no-transform';
const HEX = /^#[0-9a-fA-F]{6}$/;
const USERNAME = /^[a-zA-Z0-9_]{3,24}$/;
/** Longest design title anywhere. PATCH already enforced this; create, fork and
 *  remix did not, so a title could be as large as the 1MB body allowed - and it
 *  is echoed into page <title> and OG tags on every share page. */
const MAX_TITLE = 120;
/** How long a project stays in the Trash before it is deleted for good. */
export const TRASH_DAYS = 30;
const cleanTitle = (v: unknown, fallback: string): string => {
  const t = typeof v === 'string' ? v.trim() : '';
  return (t || fallback).slice(0, MAX_TITLE);
};
// Pragmatic email check; real validation is delivery of the verification email.
/**
 * An address we are willing to send to, or to print as a link.
 *
 * The domain half must be a real hostname: letters (any script), digits and
 * hyphens in dot-separated labels, ending in a letter. The old pattern took any
 * non-space characters, so "dev@example.com?bcc=attacker%40evil.example&body=…"
 * was a valid feedback reply address, and the admin's "reply" link opened a mail
 * with a hidden BCC and the attacker's text pre-filled.
 */
const EMAIL = /^[^\s@<>()[\],;:"\\]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}[\p{L}\p{N}-]{0,62}$/u;
const MAX_EMAIL = 254;

/** Request URLs as they may be logged: one-time secrets in the query replaced (requestLog.ts). */
export { redactUrl };

declare module 'fastify' {
  interface FastifyInstance {
    /** Resolves once every response-independent task (e.g. a reset email) has finished. */
    drainBackground(): Promise<void>;
    /**
     * The set of public designs changed outside a request (the template library
     * seeded, facets backfilled at boot): forget the counts remembered from it.
     */
    forgetPublicCounts(): void;
    /** The HTML shells (P2.9): how many times one was built, and how many are kept. Tests read it. */
    htmlShellStats?(): { rendered: number; cached: number };
  }
}
const MAX_THUMB_BYTES = 128 * 1024;
/**
 * How big a design's scene may be, gzipped.
 *
 * A banner is a display list — polylines, text, shapes — so a hand-drawn one
 * is a few kilobytes and this cap is never near. What can reach it is an
 * imported photograph embedded as a data URL, which is why the editor
 * downscales those to 1,600 px on the long edge before they go in. 3 MB is
 * room for several photographic banners and still small enough that the limit
 * is reached long before a database row becomes a problem.
 */
const SCENE_MAX_BYTES = 3 * 1024 * 1024;

// How much structure a saved scene may have before it is parsed, and the
// parse itself, are in sceneCheck.ts, run in the scene worker (P2.14).
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
  /* Floodlight (src/ui/tokens.css), written out by hand: this page carries no
     asset references, so it cannot import the stylesheet. Night ground, the
     card-mosaic texture, one blue action, the scarf under the number. */
  :root{ color-scheme: dark; }
  body{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
        background:#0B1120 radial-gradient(circle at 50% 50%, rgba(255,255,255,.06) 0 1.4px, transparent 1.6px) 0 0/14px 14px;
        color:#F1F4FB; text-align:center; padding:24px;
        font:16px/1.6 Inter,Almarai,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  main{ background:#0B1120; border:1px solid #243049; border-radius:22px; padding:32px 28px; max-width:34rem; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .w{ font-weight:800; letter-spacing:.02em; font-size:15px; margin:0 0 18px; }
  .w b{ color:#4A92F2; }
  .n{ font-size:72px; font-weight:800; letter-spacing:-.02em; line-height:1; margin:0; color:#F1F4FB; }
  .s{ height:6px; width:120px; margin:14px auto 6px; border-radius:2px;
      background:repeating-linear-gradient(90deg,#1C6FE0 0 22px,#F1F4FB 22px 30px,#0B1120 30px 52px,#F1F4FB 52px 60px); }
  h1{ font-size:20px; margin:14px 0 6px; font-weight:700; }
  p{ margin:0 0 20px; color:#A6B0C8; }
  a{ display:inline-block; margin:4px; padding:10px 18px; border-radius:999px;
     border:1px solid #33415C; color:#F1F4FB; text-decoration:none; font-size:14px; font-weight:600; }
  a.p{ background:#1C6FE0; border-color:#1C6FE0; color:#fff; }
  a:hover{ border-color:#7FB0FF; }
  a.p:hover{ background:#155EC4; border-color:#155EC4; }
  .c{ margin:24px 0 0; font-size:13px; color:#A6B0C8; }
  .c a{ display:inline; margin:0; padding:0; border:0; border-radius:0; color:#7FB0FF; text-decoration:underline; font-weight:500; }
  .c a:hover{ color:#A9CAFF; }
</style>
</head>
<body>
  <main>
    <p class="w">TIFO<b>MAKER</b></p>
    <p class="n">404</p>
    <div class="s" aria-hidden="true"></div>
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
  /** Where request logs go when logger is on. Tests capture them; production uses stdout. */
  logStream?: { write(line: string): void };
  /** Optional anonymous-analytics sink. When absent, event endpoints no-op. */
  events?: EventsRepository;
  /** Usernames with moderator privileges (from ADMIN_USERNAMES). Matched exactly. */
  adminUsernames?: string[];
  /** The admin password (default: AI_ADMIN_PASSWORD). Tests pass it here rather than through the environment. */
  aiAdminPassword?: string;
  /** Optional social layer (follows, comments, remix lineage, notifications). */
  social?: SocialRepository;
  /** Optional B2B leads store (For Clubs enterprise form). */
  leads?: LeadsRepository;
  /** AI Tifo Designer quota store. When present, the /api/ai/* routes are enabled. */
  aiUsage?: AiUsageRepository;
  aiEvents?: AiEventsRepository;
  /** Where the daily AI budget survives a restart (memory only when absent). */
  aiBudget?: AiBudgetRepository;
  /** Free AI generations per account (default 5). */
  aiFreeLimit?: number;
  /** Optional community stadium submissions store. When present, /api/stadiums/* is enabled. */
  stadiums?: StadiumSubmissionRepository;
  /**
   * Tifo of the day store. When present the home page features one community
   * design a day and /api/featured/today answers; when absent the section is
   * simply not there.
   */
  featured?: DailyFeatureRepository;
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
  /**
   * Where AI picture alerts go (a provider out of credit or refusing its key,
   * pictures failing everywhere). Unset: recorded on /admin → AI, not emailed.
   */
  aiAlertTo?: string;
  /** Public base URL for links in emails. Defaults to the request's own origin. */
  publicUrl?: string;
  /**
   * How long after a verification email goes out before another may be sent to
   * the same account. Defaults to a minute; tests shorten it rather than wait.
   */
  verifyResendCooldownMs?: number;
  /** Security monitor behind /admin#security. When present, /api/admin/soc is enabled. */
  soc?: SocMonitor;
  /** Which store the repositories use, for the posture panel. */
  database?: 'postgres' | 'memory';
  /**
   * Provider credentials, overriding the environment.
   *
   * Production reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET; tests pass them
   * here so the sign-in routes can be exercised without setting process-wide
   * variables that would leak into every other test in the file.
   */
  oauth?: Record<string, { id: string; secret: string }>;
  /**
   * Sees every route as it is registered. Tests only: the Cache-Control walk in
   * security.test.mts asks every /api route how it may be cached, including
   * the ones added after the test was written.
   */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
  /**
   * Worker pools to use instead of the process's shared ones (P2.14). Tests
   * only: a tiny time limit, a worker that crashes.
   */
  workers?: { scene?: ScenePool; pdf?: PdfPool };
  /** Where stripped scenes are kept (P2.5). Tests pass their own to look inside. */
  sceneCache?: StrippedSceneCache;
  /**
   * The origin lock's secret (P2.2), overriding ORIGIN_SECRET. Tests pass it
   * here; unset (or empty) is no lock at all, exactly as before.
   */
  originSecret?: string;
  /** What the boot did with the schema, for the posture panel (P2.15). */
  schemaStatus?: () => { pendingSecurity: { id: string; why: string }[]; failed: number } | null;
  /**
   * May the content hashes stored with pictures and scenes be believed (the
   * thumbnail 304, the kept strip)? On Postgres only once the database's own
   * hash triggers are in force and every older hash has been recomputed
   * (server.ts, stage 2 review); until then the bytes read are hashed
   * instead. Unset: true (the memory store computes them in code).
   */
  storedHashesTrusted?: () => boolean;
  /**
   * The key that tags the community feed's paging cursors (P3.4, feedCursor.ts).
   * Production keeps it in the database so a cursor outlives a deploy; unset,
   * a random key for this process.
   */
  feedCursorKey?: Buffer;
}

type ScenePool = WorkerPool<SceneTask, SceneVerdict | Uint8Array | null>;
type PdfPool = WorkerPool<PdfTask, Uint8Array>;
let sharedScene: ScenePool | null = null;
let sharedPdf: PdfPool | null = null;
/** The process's scene worker pool, started on first use. */
export const sharedScenePool = (): ScenePool => (sharedScene ??= new WorkerPool({ ...SCENE_POOL, file: workerFile('sceneWorker') }));
/** The process's PDF worker pool, started on first use. */
export const sharedPdfPool = (): PdfPool => (sharedPdf ??= new WorkerPool({ ...PDF_POOL, file: workerFile('pdfWorker') }));

export async function buildApp(
  repo: DesignRepository,
  auth: AuthRepository,
  templates: TemplateInfo[],
  options: AppOptions = {},
): Promise<FastifyInstance> {
  // Behind a reverse proxy, req.ip must come from X-Forwarded-For or EVERY request
  // looks like it came from the proxy, which collapses per-IP rate limiting into
  // one global bucket. Trusting the header when there is no proxy lets anyone
  // spoof their address. The rules, including why Cloudflare is its own mode and
  // not "2", are in proxyTrust.ts.
  const proxyMode = proxyModeFrom(process.env.TRUST_PROXY, process.env.NODE_ENV);
  const trustProxy = trustProxyFor(proxyMode);
  const app = Fastify({
    logger: options.logger
      ? {
          ...(options.logStream ? { stream: options.logStream } : {}),
          serializers: {
            // The URL with its one-time secrets redacted, and the address
            // req.ip worked out; never a header (requestLog.ts).
            req: requestLine,
          },
          // The origin secret (P2.2) never reaches a log line: no line writes
          // headers, the hook below deletes it once checked, and should
          // anything ever log a request's headers, this blanks it there too.
          redact: { paths: ['req.headers["x-origin-secret"]', 'headers["x-origin-secret"]', 'request.headers["x-origin-secret"]'], censor: '[redacted]' },
        }
      : false,
    // One line per request, written when the response closes, instead of an
    // "incoming" and a "completed" line (performance plan P2.20; see
    // requestLog.ts for what each line keeps).
    ...(options.logger ? { logController: new OneLineLogController() } : {}),
    bodyLimit: MAX_BODY_BYTES,
    trustProxy,
    // A URL the router cannot read (`/%E0%A4%A`), a path parameter too long,
    // or a failed route constraint is answered by Fastify before any hook
    // runs: no security headers, no Cache-Control, the path echoed back, and
    // never counted by the rate limiter, so this one shape of scanner probe
    // was unlimited (found by the performance plan's security review; on the
    // code before it too). Answered here with the same headers, the same
    // limit as any other probe, and a body that repeats nothing.
    frameworkErrors: (err, req, reply) => {
      void answerFrameworkError(err as { statusCode?: number }, req, reply);
    },
  });
  /**
   * The origin lock (performance plan P2.2; CLOUDFLARE.md). With
   * ORIGIN_SECRET set, Cloudflare adds `x-origin-secret: <it>` to every
   * request it forwards (a Transform Rule), and a request without it, or with
   * anything else, went around Cloudflare straight to Railway and is refused:
   * 403, the pinned security headers, no-store, and counted by the rate
   * limiter like any request. Only `GET /health`, decided on the registered
   * route, is exempt, for Railway's own healthcheck. Compared in constant
   * time over fixed-length digests, so neither the secret nor its length
   * leaks through timing; and deleted from the request once checked, so
   * nothing later can log it. Unset: no lock, exactly as before.
   */
  const originSecret = (options.originSecret ?? process.env.ORIGIN_SECRET ?? '').trim();
  if (originSecret && originSecret.length < ORIGIN_SECRET_MIN) {
    // server.ts refuses to boot first; this is for anything else that builds the app.
    throw new Error(`ORIGIN_SECRET must be at least ${ORIGIN_SECRET_MIN} characters`);
  }
  const originKey = originSecret ? createHash('sha256').update(originSecret).digest() : null;
  const fromOrigin = (req: FastifyRequest): boolean => {
    if (!originKey) return true;
    const given = req.headers['x-origin-secret'];
    delete req.headers['x-origin-secret'];
    return typeof given === 'string' && timingSafeEqual(createHash('sha256').update(given).digest(), originKey);
  };
  /** When a request last arrived with Cloudflare's headers while TRUST_PROXY is not cloudflare (P2.2). */
  let cloudflareSeenAt: number | null = null;
  let cloudflareLoggedAt = 0;

  /** Set once the limiter is registered (below), when it is on. */
  let frameworkErrorLimit: ReturnType<FastifyInstance['rateLimit']> | null = null;
  const answerFrameworkError = async (err: { statusCode?: number }, req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // No hook runs for these, so the request's one log line is asked for here.
    if (options.logger) watchResponse(req, reply);
    try {
      securityHeaders(req.raw, reply.raw, () => {});
      reply.header('cache-control', 'no-store');
      if (frameworkErrorLimit) {
        await frameworkErrorLimit.call(app, req, reply);
        if (reply.sent) return;
      }
      // Locked to Cloudflare (P2.2): refused like any other request without the secret.
      if (!fromOrigin(req)) {
        req.socNote = { ignore: true };
        await reply.code(403).send({ error: 'forbidden' });
        return;
      }
      const status = err.statusCode === 414 ? 414 : err.statusCode === 400 ? 400 : 500;
      await reply.code(status).send({ error: status === 500 ? 'internal error' : 'bad request' });
    } catch {
      if (!reply.sent) reply.raw.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"error":"bad request"}');
    }
  };
  if (options.onRoute) {
    const seen = options.onRoute;
    app.addHook('onRoute', (r) => seen({ method: r.method, url: r.url }));
  }
  // The first hook of all, so a request refused by any later one (a rate
  // limit, a 404) still gets its line.
  if (options.logger) {
    app.addHook('onRequest', (req, reply, done) => {
      watchResponse(req, reply);
      done();
    });
  }

  // What a finished request meant for security, for /admin#security. Declared
  // before any route so every one of them is watched. See soc.ts.
  app.decorateRequest('socNote', null);
  app.decorateRequest('socActor', null);
  attachSecurityMonitor(app, options.soc);

  // Nothing that answers about one person may be kept by a shared cache.
  //
  // Most JSON routes set no Cache-Control at all: /api/me, a design's owner-only
  // fields, the scene with its owner's layers, the gallery with the caller's own
  // votes, notifications, the account export. Harmless while nothing sits in
  // front of Railway; the day a CDN does, a rule that matches /api/* would store
  // one person's answer and hand it to the next (audit round six). So any /api
  // response, and any error response anywhere, that has not said how it may be
  // cached is `no-store`. Routes that chose a policy (photos, og cards,
  // thumbnails, the projects list) keep it: this only fills a header that is
  // missing, it never overrides one.
  // Decided on the route that answered, not the raw URL: `/%61pi/me` is
  // /api/me to the router and must be no-store too.
  app.addHook('onSend', async (req, reply, payload) => {
    const path = req.routeOptions?.url ?? req.url;
    if (!reply.hasHeader('cache-control') && (path.startsWith('/api/') || req.url.startsWith('/api/') || reply.statusCode >= 400)) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  // No stack traces, driver messages or constraint names in a response.
  //
  // Without a handler, Fastify answers an unexpected throw with the error's own
  // message and code, in production too. A Postgres error like "duplicate key
  // value violates unique constraint ... DETAIL: Key (email)=(someone@...)"
  // went straight to the caller, naming tables, constraints and another
  // person's email address. Deliberate client errors (4xx: bad JSON, body too
  // large, rate limited) keep their message, because it is written for them.
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; code?: unknown };
    // Postgres refusing a value as the wrong type ("invalid input syntax for
    // type uuid"): the caller sent a bad id, which is a 400, not the server
    // breaking. Several routes still passed ids straight through, so `abc` as
    // a comment, follow or notification id answered 500 on Postgres only, was
    // logged as a server fault, and twenty of them set off the server-error
    // alert email for anyone who wanted it to (audit round five). Answered
    // here so a route added later cannot reopen it.
    if (e.code === '22P02') return reply.code(400).send({ error: 'invalid id' });
    // And a row that went away under the request: a reply to a comment
    // deleted a moment before fails its foreign key. That is the caller's
    // race, not a fault, and it could be set off at will to fill the error log
    // and trip the alert. (A unique violation stays a 500: when one gets this
    // far it is a bug to see, not a race.)
    if (e.code === '23503') return reply.code(409).send({ error: 'that changed while you were doing it, please try again' });
    // The database too slow or out of reach: a statement past its 10 s, no
    // free connection within 5 s (performance plan P1.26), a restart. The
    // request did nothing it can report, so it says so and asks for a retry.
    // Still a server error (logged, counted by the security monitor).
    if (isDatabaseUnavailable(err)) {
      req.log.error({ err }, 'database unavailable');
      return reply.code(503).send({ error: 'the server is busy, please try again', code: 'retry' });
    }
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(status).send({ error: 'internal error' });
    }
    return reply.code(status).send(err);
  });

  // Work that must not decide how long a response takes. Password-reset mail is
  // the case in point: awaiting the provider only when the account exists made
  // /api/auth/forgot ~150 ms slower for real accounts, which is the enumeration
  // oracle the identical response body was meant to prevent. Tests and shutdown
  // wait for these through drainBackground().
  const background = new Set<Promise<unknown>>();
  const inBackground = (task: Promise<unknown>): void => {
    const p = task.catch((err) => app.log.error({ err: String((err as Error)?.message ?? err) }, 'background task failed'));
    background.add(p);
    void p.finally(() => background.delete(p));
  };
  app.decorate('drainBackground', async (): Promise<void> => {
    while (background.size) await Promise.allSettled([...background]);
  });
  app.addHook('onClose', async () => {
    while (background.size) await Promise.allSettled([...background]);
  });

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
  //                                  execution).
  //  - font-src 'self'             — every font is bundled (@fontsource, the Tabler
  //                                  subset in src/vendor). Google Fonts and jsDelivr
  //                                  were allowed here and in style-src until audit
  //                                  round six, long after the last page stopped
  //                                  using them: an origin nothing needs is only room
  //                                  for someone else's stylesheet.
  //  - img-src 'self' data:        — thumbnails and the generated QR PNGs are data: URIs.
  //  - connect-src 'self'          — the app only talks to its own origin (no CORS).
  //  - object-src 'none', frame-ancestors 'none' — no plugins; can't be framed
  //                                  (clickjacking protection).
  //
  // Built ONCE, here, not per request. @fastify/helmet called helmet(options)
  // inside its onRequest hook, so every request re-validated and re-joined the
  // whole policy before setting the same twelve headers: 24.5 µs a request,
  // against 7.6 µs for the middleware built once (performance plan P1.30). Same
  // options, same headers (pinned byte for byte in security.test.mts), and the
  // same place: a root onRequest hook registered at this point, before the rate
  // limiter and every route, so a refusal, a 404 and a static file carry them
  // too. helmet is a direct dependency, pinned in package.json.
  const securityHeaders = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // Exactly 'self': no string is ever evaluated as code, on any page or in
        // any worker. 'unsafe-eval' was allowed here for PixiJS 8, which builds
        // its shader, uniform and particle code with new Function. The editor
        // now loads Pixi's eval-free code (`import 'pixi.js/unsafe-eval'` in
        // render/editor.ts, the only module that starts Pixi) and draws its
        // seats without particles (performance plan P3.1), so eval is refused
        // everywhere. No WebAssembly is compiled either; if some ever is, it
        // gets 'wasm-unsafe-eval', never 'unsafe-eval' back. Pinned in
        // security.test.mts (P0.1 and the P3.1 block), which fails on anything
        // looser.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  });
  app.addHook('onRequest', (req, reply, done) => {
    securityHeaders(req.raw, reply.raw, (err?: unknown) => done(err as Error | undefined));
  });

  /**
   * The static file routes under /assets, as registered by @fastify/static
   * (one route per file: `wildcard: false`). Filled while that plugin
   * registers, below, and read by the rate limiter's key: a request is an
   * asset request only when one of these routes is what answered it.
   */
  const assetRoutes = new Set<string>();
  let collectingAssetRoutes = false;
  app.addHook('onRoute', (r) => {
    if (collectingAssetRoutes && r.url.startsWith('/assets/')) assetRoutes.add(r.url);
  });

  // Rate limiting protects the auth endpoints (and everything else) from
  // brute-force and spam. Generous global ceiling; auth routes add a tighter
  // per-route limit below.
  if (options.rateLimit) {
    // Counted per client, not per address string: an IPv6 address counts as
    // its /64 and is written one way first. Before @fastify/rate-limit 11.2.0
    // the bucket was the raw req.ip, so a caller walking its own /64 (or
    // writing one address five ways) was a new client on every request and
    // every limit in this file was unlimited for it (audit round five,
    // CVE-2026-15144). 64 is the plugin's default; it is spelled out so a
    // downgrade or a changed default cannot quietly undo it.
    //
    // The hashed build files under /assets count in a bucket of their own, 600
    // a minute, beside the 300 for everything else (performance plan P1.27).
    // They were in the 300, and a page pulls 20 to 40 of them: six ordinary
    // page views in 50 seconds used the whole minute, and the seventh page's
    // own scripts were refused with 429, which leaves a page broken. They are
    // still limited, and per client: same address, same /64, one bucket for
    // all of them (never one per file, which would multiply the allowance by
    // the number of files). What counts as an asset is the registered static
    // route that answered (see assetRoutes), never the URL as written: a path
    // that only looks like /assets/ (a 404, a traversal, `/assets/../api/me`)
    // is the router's to resolve, and anything that is not one of those files
    // stays in the 300. Every route with its own limit (sign-in 10, PDF 6,
    // scene saves 30...) keeps its own store and number; only the key is
    // shared, and for those it is exactly the address as before.
    await app.register(rateLimit, {
      global: true,
      timeWindow: '1 minute',
      ipv6Subnet: 64,
      keyGenerator: (req) => {
        const client = normalizeIP(req.ip, 64);
        const route = req.routeOptions?.url;
        const isAsset = (req.method === 'GET' || req.method === 'HEAD') && route !== undefined && assetRoutes.has(route);
        return isAsset ? `${client}${ASSET_BUCKET}` : client;
      },
      max: (_req, key) => (key.endsWith(ASSET_BUCKET) ? ASSETS_PER_MINUTE : REQUESTS_PER_MINUTE),
      // Twice the plugin's default number of remembered clients, since each
      // now has up to two entries: the same number of clients fit before the
      // least recent are forgotten.
      cache: 10_000,
    });
  }

  // Cloudflare in front, and the server not told (P2.2). Behind Cloudflare
  // with TRUST_PROXY unset or a number, req.ip is a Cloudflare edge, so every
  // visitor of one edge shares one set of rate limits and one address in the
  // logs. Noticed here, said in the log at most once a minute and on the
  // posture panel, as a check: anyone can send these headers, so it may be
  // nothing (the advice says both). Only the headers' presence is looked at:
  // CF-Connecting-IP is never used for anything (a caller reaching Railway
  // directly can write it), and the address still comes only from
  // TRUST_PROXY's rules.
  if (proxyMode.kind !== 'cloudflare') {
    app.addHook('onRequest', (req, _reply, done) => {
      if (req.headers['cf-ray'] !== undefined || req.headers['cf-connecting-ip'] !== undefined) {
        const now = Date.now();
        cloudflareSeenAt = now;
        if (now - cloudflareLoggedAt >= 60_000) {
          cloudflareLoggedAt = now;
          console.warn('[tifo] TRUST_PROXY: a request arrived with Cloudflare headers (cf-ray / cf-connecting-ip) while TRUST_PROXY is not "cloudflare". If Cloudflare is in front, set TRUST_PROXY=cloudflare (CLOUDFLARE.md); if it is not, someone sent those headers themselves, they are never believed, and there is nothing to do.');
        }
      }
      done();
    });
  }
  if (originKey) {
    const lockLimit = options.rateLimit ? app.rateLimit() : null;
    app.addHook('onRequest', async (req, reply) => {
      const health = req.method === 'GET' && req.routeOptions?.url === '/health';
      if (fromOrigin(req) || health) return;
      reply.header('cache-control', 'no-store');
      if (lockLimit) {
        await lockLimit.call(app, req, reply);
        // A 429 here is recorded by the Security tab like any other: a flood
        // aimed at the origin itself is worth knowing about.
        if (reply.sent) return;
      }
      // A request that went around Cloudflare (a scanner, mostly): expected,
      // and not an admin or sign-in event for the Security tab.
      req.socNote = { ignore: true };
      await reply.code(403).send({ error: 'forbidden' });
    });
  }

  const seatCount = (id: string, version: number): number | null =>
    templates.find((t) => t.id === id && t.version === version)?.seatCount ?? null;
  // The PDF export's seat maps are built in the PDF worker now, once per
  // ground there (P2.14); the request is checked against the seat table here.

  /**
   * The worker pools (performance plan P2.14; workerPool.ts). Shared by every
   * app in the process unless a test hands in its own: there is one event
   * loop to protect, and one worker of each kind is enough for it.
   */
  const scenePool = options.workers?.scene ?? sharedScenePool();
  /** May the stored content hashes be believed? (AppOptions.storedHashesTrusted) */
  const hashesTrusted = (): boolean => options.storedHashesTrusted?.() ?? true;
  const pdfPool = options.workers?.pdf ?? sharedPdfPool();
  /** A pool that cannot take or finish the task: the server is busy, try again. */
  const busy = (reply: FastifyReply): FastifyReply =>
    reply.code(503).send({ error: 'the server is busy, please try again', code: 'retry' });
  /**
   * Seats that never take the tifo (a royal box — see SeatZone.noTifo). The
   * editor locks them, and the server enforces the same rule, so a design from
   * an old client or an outside generator cannot print cards for them. Returns
   * true if any cell had to be cleared.
   *
   * The runs come from the seat table (seatTable.ts), generated from the same
   * seat maps: the first save on a ground used to generate its whole map to
   * find them, up to 1.3 s on the one event loop (performance plan P1.28).
   */
  const clearLocked = (templateId: string, version: number, cells: Uint8Array): boolean => {
    const runs = seatTable.lockedRuns(templateId, version);
    if (!runs) return false;
    let changed = false;
    for (const [start, end] of runs) {
      for (let i = start; i < end && i < cells.length; i++) {
        if (cells[i] !== 0) {
          cells[i] = 0;
          changed = true;
        }
      }
    }
    return changed;
  };

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
  /**
   * The request's Host, only when it is exactly one of ours: a name from the
   * allow-list and at most a port. Checking only the part before the first
   * colon and then echoing the whole header back let `tifomaker.org:@evil.example`
   * through, which a browser reads as user info followed by the attacker's host,
   * so a reset link sent its token to evil.example (audit round four). The
   * value returned is rebuilt from what was parsed, never the raw header.
   */
  const knownHost = (req: FastifyRequest): { bare: string; host: string } | null => {
    const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(String(req.headers.host ?? ''));
    if (!m) return null;
    const bare = m[1].toLowerCase();
    if (!ALLOWED_EMAIL_HOSTS.has(bare)) return null;
    // A port only on a dev host. The public names are only ever reached on the
    // default port, and accepting any port let a request write
    // `tifomaker.org:1234` into the canonical and og:url of the page it got
    // back, and into the links of the mail it set off (audit round six). With
    // PUBLIC_URL set this is never reached, which is the setting for production.
    const local = bare === 'localhost' || bare === '127.0.0.1';
    if (m[2] && !local) return null;
    return { bare, host: m[2] ? `${bare}:${Number(m[2])}` : bare };
  };
  const emailBase = (req: FastifyRequest): string => {
    if (options.publicUrl) return options.publicUrl.replace(/\/+$/, '');
    const known = knownHost(req);
    return known ? `${req.protocol === 'https' ? 'https' : 'http'}://${known.host}` : CANONICAL_ORIGIN;
  };

  const validPalette = (p: unknown): p is string[] =>
    Array.isArray(p) && p.length >= 2 && p.length <= 256 && p.every((c) => typeof c === 'string' && HEX.test(c));

  /**
   * The site's own share card, loaded once from the static build. Used as the
   * last resort for a design that has no image of its own.
   */
  let defaultCardPng: Buffer | null = null;

  /**
   * The account behind this request's bearer token, read once per request
   * (performance plan P2.17).
   *
   * A signed-in request used to ask the database for the token, then whether
   * the account had chosen its name, then for the account itself, then again
   * whether it was an admin: up to four reads of the same row for one
   * request. Now the token and its account are one statement
   * (getSessionUser: the token joined to its user, still `expires_at >
   * now()`), and every check in the same request reads that answer.
   *
   * Kept on the request object and nowhere else: a WeakMap keyed by the
   * request, so the answer dies with the request and can never be handed to
   * another request or another account. Nothing is remembered between
   * requests, so a sign-out, a password change, a revoked session or a
   * deleted account is refused on the very next request, exactly as before.
   * A copy, so nothing the request writes later changes what it read.
   */
  const sessions = new WeakMap<FastifyRequest, Promise<UserRow | null>>();
  const sessionUser = (req: FastifyRequest): Promise<UserRow | null> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return Promise.resolve(null);
    let read = sessions.get(req);
    if (!read) {
      read = auth.getSessionUser(hashToken(header.slice(7))).then((u) => (u ? { ...u } : null));
      sessions.set(req, read);
    }
    return read;
  };
  /** User id from a bearer token, or null. Never writes to the reply. */
  const userOf = async (req: FastifyRequest): Promise<string | null> => (await sessionUser(req))?.id ?? null;
  /**
   * The same, for the checks that must refuse when it cannot be read: the
   * username wall and the owner routes answer 503 "try again", as the name
   * check did before it became part of this read (audit round six). undefined
   * means the refusal has been sent.
   */
  const userOrRetry = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null | undefined> => {
    try {
      return await userOf(req);
    } catch {
      await reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
      return undefined;
    }
  };
  /**
   * An account's row: the caller's own straight from this request's session
   * read, anyone else's from the database. For the checks a route makes on
   * the caller right after requireUser (verified email, the password to
   * confirm, the admin allow-list). Reads that must see a change made during
   * the request (stillThePassword, the email change's second look) go to the
   * database, never here.
   */
  const accountOf = async (req: FastifyRequest, userId: string): Promise<UserRow | null> => {
    const own = await sessionUser(req).catch(() => null);
    if (own && own.id === userId) return own;
    return auth.getUserById(userId);
  };

  /**
   * The routes an account still wearing a name we invented may call.
   *
   * Signing up with Google gives us an email and no handle, and the handle is
   * the public part — it goes under every design in the community feed. So a
   * provider-created account is held at the door until its owner picks one, and
   * this is the short list of things they can do while standing there: find out
   * who they are, pick the name, and leave.
   *
   * The wall lives in `requireUser` rather than in the browser because a wall
   * only in the browser is a suggestion. Anyone can call the API directly.
   */
  const OPEN_WHILE_UNNAMED = new Set([
    'GET /api/me',
    'POST /api/account/username',
    'POST /api/auth/logout',
    'POST /api/auth/handoff',
    'DELETE /api/account',
  ]);

  const requireUser = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const userId = await userOrRetry(req, reply);
    if (userId === undefined) return null;
    if (!userId) {
      await reply.code(401).send({ error: 'authentication required' });
      return null;
    }
    const where = `${req.method} ${(req.routeOptions?.url ?? req.url).split('?')[0]}`;
    if (!OPEN_WHILE_UNNAMED.has(where)) {
      const chosen = await usernameChosen(req, userId, reply);
      if (chosen === null) return null;
      if (!chosen) {
        // 428: the request is fine, something has to happen first. A 403 would
        // read as "you may not", which is the wrong thing to tell someone who has
        // simply not finished signing up.
        await reply.code(428).send({ error: 'choose a username first', code: 'needs_username' });
        return null;
      }
    }
    return userId;
  };
  /**
   * Has this account picked its @name? null when the answer could not be read,
   * after telling the caller to try again.
   *
   * A database error used to count as "yes" (`.catch(() => true)`), so the wall
   * opened whenever the lookup failed: an account still wearing the handle we
   * derived from its email could publish under it during any database hiccup
   * (audit round six). A check that cannot be made now refuses now.
   *
   * For the caller's own account the answer is in the session read
   * (accountOf, P2.17); the flag comes from the same row as the token.
   */
  const usernameChosen = async (req: FastifyRequest, userId: string, reply: FastifyReply): Promise<boolean | null> => {
    try {
      const own = await sessionUser(req);
      if (own && own.id === userId) return own.usernameChosen !== false;
      return await auth.hasChosenUsername(userId);
    } catch {
      await reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
      return null;
    }
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
  /**
   * The username when the account is an allow-listed admin, else null.
   *
   * Throws when the account cannot be read. It used to answer "not an admin" on
   * a database error, which is the safe answer for granting rights but the
   * unsafe one for the guards that protect an admin account (no rename away
   * from the name, no deletion): those opened whenever the lookup failed, and
   * the freed name was moderator rights for whoever registered it next (audit
   * round six). Every caller treats a throw as a failed request, so it now
   * fails closed both ways.
   */
  // With the request, the caller's own row is the session read (accountOf, P2.17).
  const adminNameOf = async (userId: string, req?: FastifyRequest): Promise<string | null> => {
    if (adminSet.size === 0) return null;
    const user = req ? await accountOf(req, userId) : await auth.getUserById(userId);
    return user && adminSet.has(user.username) ? user.username : null;
  };
  const isAdminUser = async (userId: string, req?: FastifyRequest): Promise<boolean> => (await adminNameOf(userId, req)) !== null;
  /**
   * Posture: every allow-listed admin name should belong to an account. One
   * that does not is moderator rights waiting for whoever registers it first.
   */
  const adminNamesClaimed = async (): Promise<{ id: string; label: string; state: 'good' | 'warn' | 'bad' | 'info'; detail: string }> => {
    const names = [...adminSet];
    if (names.length === 0) return { id: 'admins', label: 'Admin accounts', state: 'info', detail: 'ADMIN_USERNAMES is empty: moderation uses the admin password only.' };
    const missing: string[] = [];
    for (const n of names) if (!(await auth.getUserByName(n).catch(() => null))) missing.push(n);
    // Not a hole any more (sign-up refuses the name without the admin
    // password), but still worth a line: an allow-list entry nobody holds is
    // either a typo or an account that was never made.
    return missing.length
      ? { id: 'admins', label: 'Admin accounts', state: 'warn', detail: `Not registered: ${missing.map((m) => '@' + m).join(', ')}. The name is reserved: nobody can sign up with it or rename onto it without the admin password, so it gives no one moderator rights. To make it yours, rename your account to it in Account and give the admin password when the page asks for it (the page asks in a browser where the AI panel is unlocked); otherwise remove it from ADMIN_USERNAMES.` }
      : { id: 'admins', label: 'Admin accounts', state: 'good', detail: `Every allow-listed name belongs to an account (${names.length}).` };
  };
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const userId = await requireUser(req, reply);
    if (!userId) return null;
    const name = await adminNameOf(userId, req);
    if (!name) {
      await reply.code(403).send({ error: 'moderator access required' });
      return null;
    }
    req.socActor = `@${name}`; // for the audit trail
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

  const aiAdminPassword = options.aiAdminPassword ?? process.env.AI_ADMIN_PASSWORD;
  warmUnlockKey(aiAdminPassword);
  /**
   * May this request take an allow-listed admin name? Only the exact name (a
   * case-folded lookalike never), and only with the admin password itself in
   * the body, as `adminPassword`. Recorded in the audit trail.
   *
   * It used to accept the x-ai-unlock session instead, on the grounds that the
   * session already opens every queue. But a session is meant to be small: it
   * ends after 12 hours, and changing AI_ADMIN_PASSWORD ends all of them at
   * once. A name claimed with one is neither. A token copied out of a browser
   * became a moderator ACCOUNT that outlived the password change made to shut
   * it out, could not be renamed or deleted from the account page, and opened
   * routes the session alone never did, such as granting Pro (audit round
   * five). A wrong password counts as a wrong admin password, for the alert.
   */
  const adminClaim = (req: FastifyRequest, username: string): boolean => {
    if (!adminSet.has(username) || !aiAdminPassword) return false;
    const given = (req.body as { adminPassword?: unknown } | null)?.adminPassword;
    if (typeof given !== 'string' || !given) return false;
    if (given.length > 1024 || !safeEqual(given, aiAdminPassword)) {
      req.socNote = { kind: 'admin_unlock_failed' };
      return false;
    }
    req.socActor = `admin password claiming @${username}`;
    return true;
  };
  const adminAccess = async (req: FastifyRequest): Promise<boolean> => {
    const tok = req.headers['x-ai-unlock'];
    if (typeof tok === 'string' && aiAdminPassword && verifyUnlock(aiAdminPassword, tok)) {
      // The token's random id names the session without exposing the token.
      req.socActor = `admin password (session ${tok.split('.')[2]?.slice(0, 6) ?? '?'})`;
      return true;
    }
    const userId = await userOf(req);
    const name = userId ? await adminNameOf(userId, req) : null;
    if (name) req.socActor = `@${name}`;
    return name !== null;
  };

  /**
   * Gate for the review queues: reports, match photos and stadium submissions.
   *
   * These used to demand an ADMIN_USERNAMES account and nothing else, while
   * the dashboard that counts them is opened with the admin PASSWORD. So the
   * operator saw "4 pending stadiums", followed the card, and was refused
   * with 403: the password session and the account allow-list were two
   * different doors, and the queues were only behind one of them.
   *
   * The unlock token is accepted here exactly as it is for the analytics and
   * the test-alert/test-email actions: in a header, so no cross-site page can
   * make a browser send it (the tm_admin cookie is NOT accepted), and every
   * action is still written to the security audit under the session's id.
   * Without a token this falls through to requireAdmin unchanged, so an
   * anonymous caller still gets 401 and an ordinary account 403.
   */
  const requireModerator = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const tok = req.headers['x-ai-unlock'];
    if (typeof tok === 'string' && aiAdminPassword && verifyUnlock(aiAdminPassword, tok)) {
      req.socActor = `admin password (session ${tok.split('.')[2]?.slice(0, 6) ?? '?'})`;
      return true;
    }
    return (await requireAdmin(req, reply)) !== null;
  };

  /**
   * Thumbnails and share cards are served as image/png from our own origin, so
   * they must be PNGs: anything else was stored as given (audit round four).
   */
  const isPng = (b: Buffer): boolean =>
    b.byteLength >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;

  /** undefined = invalid (reply sent); null = none provided; Buffer = decoded. */
  const decodeThumb = (b64: string | undefined, reply: FastifyReply): Buffer | null | undefined => {
    if (b64 === undefined) return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.byteLength === 0 || buf.byteLength > MAX_THUMB_BYTES) {
      void reply.code(400).send({ error: `thumbnailPngB64 must decode to 1..${MAX_THUMB_BYTES} bytes` });
      return undefined;
    }
    if (!isPng(buf)) {
      void reply.code(400).send({ error: 'thumbnailPngB64 must be a PNG' });
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
  // The same list saving checks against, so validate and save can never
  // disagree — and already counted at boot, so nothing is regenerated here.
  // (This used to memoise into a map keyed by whatever id the client sent,
  // which a client could grow without limit.)
  const seatCountFor = (templateId: string, version: number): number | null => seatCount(templateId, version);

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
    'project_created', // named a project and picked its stadium
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
    'view_banner',     // opened the Banner view (sent since the banners release, dropped until now)
    'post_opened',     // opened "Post it": the picture of their tifo, ready to post
    'shared',          // pressed a share: a platform, the phone's share sheet, copy
    'guide_started',   // the guided first tifo opened (src/ui/guide.ts)
    'guide_done',      // ...and was followed to its last step, Post it
    'guide_free',      // ...or left for the whole editor ("Free mode")
    'ai_cta',          // "Generate with AI" pressed outside the editor (Projects page)
    'template_cta',    // "Use as template" pressed on the home page's showcase
  ];
  const FUNNEL_SET = new Set(FUNNEL_STEPS);

  // Record one anonymous event. No auth required; best-effort (never errors the
  // client over analytics). Ignores unknown names and missing sink.
  // A few events per visit is normal; the global 300 a minute was the only
  // limit, and every row is kept for a year (audit round five).
  app.post('/api/events', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
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
            // Cloudflare's country header, believed only when the request really
            // came through Cloudflare; otherwise it is just text the caller sent.
            country: viaCloudflare(proxyMode, h['x-forwarded-for']) ? one(h['cf-ipcountry']) : undefined,
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
      if (!options.aiEvents) return { days: 0, since: null, unavailable: true, pictures: picturesStatus(), text: textModelsStatus() };
      const q = req.query as { days?: string };
      // At most ADMIN_WINDOW_MAX_DAYS: raw ai_events are kept longer than
      // that (retention.ts), so a window never reaches the rolled-up days.
      const days = Math.min(ADMIN_WINDOW_MAX_DAYS, Math.max(1, Number(q.days) || 30));
      // Pictures are live state since the last restart, not history, so they
      // sit beside the stats rather than in ai_events.
      return { ...(await options.aiEvents.stats(days)), pictures: picturesStatus(), text: textModelsStatus() };
    });

    app.get('/api/admin/shares', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      const q = req.query as { days?: string };
      // Raw shares outlive this window (retention.ts); see the AI tab above.
      const days = Math.min(ADMIN_WINDOW_MAX_DAYS, Math.max(1, Number(q.days) || 30));
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
      let opened: { key: string; visits: number; visitors: number }[] = [];
      if (options.traffic) {
        const t = await options.traffic.summary(days);
        // Their Arabic twins (/ar/t/:id, /ar/d/:id) are the same links (performance plan P3.3).
        const shared = t.pages.filter((p) => /^(?:\/ar)?\/(d|t)\//.test(p.key));
        inbound = {
          visits: shared.reduce((n, p) => n + p.visits, 0),
          tifosOpened: new Set(shared.map((p) => p.key.replace(/^\/ar(?=\/)/, ''))).size,
          pages: shared.slice(0, 10),
          // A floor, not a count: most messaging apps send no referrer at all,
          // so links passed round WhatsApp or Discord arrive looking direct.
          // Stored referrers are labels ("X / Twitter"), so they are matched as
          // labels; matching them as hostnames left this row always empty.
          social: t.referrers.filter((r) => isSocialReferrer(r.key)).slice(0, 10),
        };
        opened = t.shared;
      }
      // "Links opened" used to count design_shares rows of kind 'open', which
      // nothing ever wrote, so it read 0 forever. The share buttons now tag
      // their links (utm_medium=share, utm_source=<platform>), and the visits
      // table already counts everyone who arrives on one, WhatsApp included.
      if (options.traffic) {
        const byKey = new Map(summary.platforms.map((p) => [p.key, { ...p }]));
        for (const o of opened) {
          const row = byKey.get(o.key) ?? { key: o.key, shares: 0, opens: 0 };
          row.opens = o.visits;
          byKey.set(o.key, row);
        }
        summary.platforms = [...byKey.values()].sort((a, b) => b.shares - a.shares || b.opens - a.opens);
        summary.opens = opened.reduce((n, o) => n + o.visits, 0);
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
        req.socNote = { kind: 'bot_trap' };
        return reply.code(200).send({ ok: true });
      }
      const elapsed = Number(body.elapsedMs);
      if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
        req.socNote = { kind: 'bot_trap' };
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
        // The shared escaper (quotes included), not a local one that left them
        // alone: harmless while every value lands in element text, one
        // attribute away from not being (audit round five).
        const esc2 = escapeHtml;
        const ctxLine = context
          ? `${context.path ?? '?'} · ${context.browser ?? '?'} on ${context.os ?? '?'} · ${context.device ?? '?'} · ${context.viewport ?? '?'}`
          : 'no diagnostics attached';
        void options.emailSender
          .send({
            to: options.feedbackTo,
            subject: `TifoMaker ${body.kind}: ${message.slice(0, 60).replace(/[\r\n\t]+/g, ' ')}`,
            html:
              `<p><b>${esc2(body.kind)}</b>${rawEmail ? ` from ${esc2(rawEmail)}` : ' (no reply address)'}</p>` +
              `<p style="white-space:pre-wrap">${esc2(message.slice(0, 4000))}</p>` +
              (body.steps ? `<p><b>What they were doing</b><br><span style="white-space:pre-wrap">${esc2(String(body.steps).slice(0, 2000))}</span></p>` : '') +
              `<p style="color:#666;font-size:12px">${esc2(ctxLine)}</p>`,
            text: `${body.kind}: ${message.slice(0, 4000)}\n\n${body.steps ? 'Doing: ' + String(body.steps).slice(0, 2000) + '\n\n' : ''}${ctxLine}`,
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
    // Picture alerts use the same sender as account mail, so the Email tab's
    // delivery counts cover them too.
    imageHealth.configure({ sender: options.emailSender, to: options.aiAlertTo, publicUrl: options.publicUrl });
    registerAiRoutes(app, {
      aiUsage: options.aiUsage,
      aiEvents: options.aiEvents,
      aiBudget: options.aiBudget,
      userOf,
      isAdmin: isAdminUser,
      adminPassword: aiAdminPassword,
      freeLimit: options.aiFreeLimit ?? 10,
      // Launch: AI is free for any signed-in, email-verified user. Set
      // AI_FREE_FOR_ALL=false later to enforce the per-account free limit
      // (which is HOURLY — see aiPeriod; this comment used to say monthly).
      freeForAll: (process.env.AI_FREE_FOR_ALL ?? 'true') !== 'false',
      userState: async (userId, req) => {
        const u = await (req ? accountOf(req, userId) : auth.getUserById(userId)).catch(() => null);
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
      if (!(await requireModerator(req, reply))) return;
      return reply.send({ stadiums: await stadiums.listPending() });
    });
    app.post('/api/stadiums/:id/review', async (req, reply) => {
      if (!(await requireModerator(req, reply))) return;
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
  /** Writes that store something each time (revisions, reports): a person's pace. */
  const writeLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const reportLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /**
   * "Once per visitor per day" for counters anyone can bump.
   *
   * Views and shares were counted on every request, so 500 anonymous POSTs
   * made a design read 500 views (audit round four). The visitor is the
   * account when signed in, else the address as the rate limiter sees it.
   * In memory and bounded: a restart forgets, which errs towards counting.
   */
  /**
   * How much one account may store. Nothing capped it: one account that had
   * only chosen a username (no verified email) created 300 designs and put 50
   * photos on one of them, every photo up to 2 MB, all of it in the Postgres
   * the site runs on (audit round five). A full database is the whole site
   * down. Admin accounts are not counted; everyone else gets far more than a
   * person uses, and a photo now needs a verified email, as a vote does.
   */
  const DESIGNS_PER_ACCOUNT = 1000;
  const NEW_DESIGNS_PER_DAY = 100;
  // And per client (an address, or an IPv6 /64), whichever accounts it uses:
  // sign-up is open, so a cap per account alone was a cap per sign-up.
  const NEW_DESIGNS_PER_CLIENT_DAY = 300;
  const PHOTOS_PER_DESIGN = 20;
  const PHOTOS_PER_DAY = 30;
  const dailyUse = new Map<string, number>();
  const takeDaily = (userId: string, what: string, max: number): boolean => {
    const day = utcDay();
    const key = `${day}|${what}|${userId}`;
    const used = dailyUse.get(key) ?? 0;
    if (used >= max) return false;
    if (dailyUse.size > 20_000) for (const k of dailyUse.keys()) if (!k.startsWith(day)) dailyUse.delete(k);
    dailyUse.set(key, used + 1);
    return true;
  };
  /** Room for one more design on this account? Sends the refusal itself. */
  const roomForDesign = async (req: FastifyRequest, userId: string, reply: FastifyReply): Promise<boolean> => {
    if (await adminNameOf(userId, req)) return true;
    // A count that cannot be read is not a count of zero: that let an account
    // past its thousand whenever the lookup failed, which a statement limit
    // makes a thing that happens (performance plan P1.26 fail-closed review).
    let owned: number;
    try {
      owned = (await repo.listTitlesByOwner(userId)).length;
    } catch {
      await reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
      return false;
    }
    if (owned >= DESIGNS_PER_ACCOUNT) {
      await reply.code(403).send({ error: 'this account has reached its limit of designs', code: 'design_limit', limit: DESIGNS_PER_ACCOUNT });
      return false;
    }
    if (!takeDaily(userId, 'design', NEW_DESIGNS_PER_DAY)) {
      await reply.code(429).send({ error: 'too many new designs today, try again tomorrow', code: 'design_limit' });
      return false;
    }
    if (!takeDaily(`ip:${clientKey(req.ip)}`, 'design', NEW_DESIGNS_PER_CLIENT_DAY)) {
      refundDesign(req, userId, false);
      await reply.code(429).send({ error: 'too many new designs today, try again tomorrow', code: 'design_limit' });
      return false;
    }
    return true;
  };
  /** Give back the day's design that a refused copy did not make. */
  const refundDesign = (req: FastifyRequest, userId: string, client = true): void => {
    for (const who of client ? [userId, `ip:${clientKey(req.ip)}`] : [userId]) {
      const key = `${utcDay()}|design|${who}`;
      const used = dailyUse.get(key) ?? 0;
      if (used > 0) dailyUse.set(key, used - 1);
    }
  };

  const seenToday = new Map<string, number>();
  const SEEN_MAX = 50_000;
  const firstToday = (req: FastifyRequest, who: string | null, what: string): boolean => {
    const key = `${utcDay()}|${what}|${who ?? `ip:${clientKey(req.ip)}`}`;
    if (seenToday.has(key)) return false;
    if (seenToday.size >= SEEN_MAX) {
      const today = utcDay();
      for (const k of seenToday.keys()) if (!k.startsWith(today)) seenToday.delete(k);
      if (seenToday.size >= SEEN_MAX) seenToday.delete(seenToday.keys().next().value as string);
    }
    seenToday.set(key, 1);
    return true;
  };

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
  const codeTriesAt = new Map<string, number>();
  const noteCodeTry = (userId: string, n: number): void => {
    const now = Date.now();
    codeTries.set(userId, n);
    codeTriesAt.set(userId, now);
    if (codeTries.size > 5000) {
      for (const [id, at] of codeTriesAt) {
        if (now - at > VERIFY_CODE_TTL_MS) { codeTries.delete(id); codeTriesAt.delete(id); }
      }
    }
  };

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
  /** Per-recipient and per-account mail limits; see sendBudget.ts. */
  const mailBudget = new SendBudget();
  const addressKey = (prefix: string, email: string): string => `${prefix}:${email.trim().toLowerCase()}`;
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
  const codeHash = (userId: string, email: string, code: string): string =>
    hashToken(`verify:${userId}:${email.trim().toLowerCase()}:${code}`);
  /**
   * Which address a verification was sent to, carried inside what proves it.
   *
   * Verifying used to mark the ACCOUNT verified, whatever its address had become
   * by then: hold the link sent to your own inbox, change the account's email
   * to someone else's, click, and their address was "verified" on your account,
   * ready to catch their first Google sign-in (audit round four). Now the code's
   * hash includes the address and the link's last 16 characters name it, and
   * the account is marked verified only while its address is still that one.
   */
  const addressTag = (email: string): string => hashToken(`addr:${email.trim().toLowerCase()}`).slice(0, 16);
  // Issue a fresh verification token and email the link. Best-effort: a mail
  // failure never blocks the API response (the user can request a resend).
  const sendVerifyEmail = async (req: FastifyRequest, user: { id: string; email: string }): Promise<boolean> => {
    if (!options.emailSender) return false;
    try {
      await auth.deleteEmailTokens(user.id, 'verify_email');
      await auth.deleteEmailTokens(user.id, 'verify_code');
      codeTries.delete(user.id);
      const token = `${issueToken().token.slice(0, 48)}${addressTag(user.email)}`;
      await auth.createEmailToken(user.id, hashToken(token), 'verify_email', new Date(Date.now() + VERIFY_TTL_MS));
      // The same message carries both: a code to type where the person already
      // is, and a link for whoever would rather just click. On a phone, leaving
      // for a mail app and finding the way back is where people give up.
      const code = newVerifyCode();
      await auth.createEmailToken(user.id, codeHash(user.id, user.email, code), 'verify_code', new Date(Date.now() + VERIFY_CODE_TTL_MS));
      const base = emailBase(req);
      const link = `${base}/api/auth/verify?token=${token}`;
      // Bilingual: the server does not know which language the person picked
      // (that lives in their browser), and most of the audience is Saudi, so
      // both languages ship in one message with Arabic first. The layout (a
      // real HTML document, and a footer saying who sent it and why) is in
      // emailLayout.ts; the words are here.
      const subject = 'وثّق بريدك في تيفو ميكر · Verify your TifoMaker email';
      await options.emailSender.send({
        to: user.email,
        subject,
        html: layoutEmail({
          title: subject,
          siteUrl: base,
          blocks: [
            {
              lang: 'ar',
              html:
                para('أهلاً بك في تيفو ميكر.') +
                para('وثّق بريدك عشان تفتح مصمّم الذكاء الاصطناعي. رمز التحقق:') +
                codeBox(code) +
                para('اكتب الرمز في الموقع خلال 10 دقائق، أو اضغط الزر:') +
                button(link, 'وثّق بريدي') +
                smallPrint('الرابط ينتهي خلال 24 ساعة. وإذا ما أنشأت حساب، تجاهل هذي الرسالة.'),
            },
            {
              lang: 'en',
              html:
                para('Welcome to TifoMaker.') +
                para('Confirm your email to unlock the AI Designer. Your code:') +
                codeBox(code) +
                para('Type it on the site within 10 minutes, or use the button:') +
                button(link, 'Verify my email') +
                smallPrint("This link expires in 24 hours. If you didn't create an account, ignore this email."),
            },
          ],
        }),
        text:
          `أهلاً بك في تيفو ميكر.\n` +
          `رمز التحقق في تيفو ميكر: ${code} (صالح 10 دقائق)\nأو افتح: ${link}\n\n` +
          `Welcome to TifoMaker.\n` +
          `Your TifoMaker code: ${code} (valid 10 minutes)\nOr open: ${link}` +
          textFooter(base),
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
      // Only while the account still has this address: an email change landing
      // since the lookup would otherwise leave a working link in the old
      // mailbox, mailed after the change had spent the others (audit round six).
      if (!(await auth.createEmailTokenForAddress(user.id, user.email, tokenHash, 'reset_password', new Date(Date.now() + RESET_TTL_MS)))) return;
      const base = emailBase(req);
      const link = `${base}/reset?token=${token}`;
      const subject = 'إعادة تعيين كلمة مرور تيفو ميكر · Reset your TifoMaker password';
      await options.emailSender.send({
        to: user.email,
        subject,
        html: layoutEmail({
          title: subject,
          siteUrl: base,
          blocks: [
            {
              lang: 'ar',
              html:
                para('وصلنا طلب لإعادة تعيين كلمة مرورك في تيفو ميكر.') +
                button(link, 'اختر كلمة مرور جديدة') +
                smallPrint('الرابط ينتهي خلال ساعة. وإذا ما طلبت هذا، تجاهل الرسالة وكلمة مرورك ما تغيّرت.'),
            },
            {
              lang: 'en',
              html:
                para('We received a request to reset your TifoMaker password.') +
                button(link, 'Choose a new password') +
                smallPrint("This link expires in 1 hour. If you didn't request this, ignore this email, your password is unchanged."),
            },
          ],
        }),
        text:
          `إعادة تعيين كلمة مرور تيفو ميكر: ${link}\nالرابط ينتهي خلال ساعة.\n\n` +
          `Reset your TifoMaker password: ${link}\nThis link expires in 1 hour. If you didn't request this, ignore this email.` +
          textFooter(base),
      });
    } catch (err) {
      // /api/auth/forgot answers 202 whether or not the address exists — that is
      // deliberate, so it cannot be used to test for accounts — which means the
      // log and /api/admin/email are the ONLY places a refused send can show up.
      app.log.error({ err: String((err as Error)?.message ?? err) }, 'password-reset email was NOT sent');
    }
  };

  /**
   * A short security notice to the account's own address: a new way in was
   * added, or the address itself changed. The one signal an owner gets that
   * something happened on their account that they did not do. Sent after the
   * reply (it must not slow the request or change its timing), best-effort.
   */
  const securityNotice = (req: FastifyRequest, to: string, en: string, ar: string): void => {
    if (!options.emailSender) return;
    // The same per-recipient pace as verification mail: a notice is still mail
    // to an address, and must never become a way to flood one.
    if (mailBudget.take(addressKey('notice-to', to), VERIFY_TO_ADDRESS) > 0) return;
    const sender = options.emailSender;
    const base = emailBase(req);
    const subject = 'تنبيه أمان من تيفو ميكر · TifoMaker security notice';
    const tailEn = 'If this was you, there is nothing to do. If it was not, reset your password now and remove anything you do not recognise on your account page.';
    const tailAr = 'إذا كان هذا أنت فلا تسوِّ شيء. وإذا ما كان أنت، غيّر كلمة المرور الآن واحذف أي شيء ما تعرفه من صفحة حسابك.';
    inBackground(
      sender
        .send({
          to,
          subject,
          html: layoutEmail({
            title: subject,
            siteUrl: base,
            blocks: [
              { lang: 'ar', html: para(escapeHtml(ar)) + para(tailAr) + button(`${base}/account`, 'صفحة حسابي') },
              { lang: 'en', html: para(escapeHtml(en)) + para(tailEn) + button(`${base}/account`, 'My account') },
            ],
          }),
          text: `${ar}\n${tailAr}\n\n${en}\n${tailEn}\n${base}/account` + textFooter(base),
        })
        .catch((err: unknown) => app.log.error({ err: String((err as Error)?.message ?? err) }, 'security notice was NOT sent')),
    );
  };
  const PROVIDER_NAMES: Record<string, string> = { google: 'Google', x: 'X' };
  const noticeLinked = (req: FastifyRequest, userId: string, provider: string): void => {
    inBackground((async () => {
      const user = await auth.getUserById(userId).catch(() => null);
      if (!user?.email) return;
      const name = PROVIDER_NAMES[provider] ?? provider;
      securityNotice(req, user.email, `A ${name} sign-in was connected to your TifoMaker account (@${user.username}).`, `تم ربط تسجيل دخول ${name} بحسابك في تيفو ميكر (@${user.username}).`);
    })());
  };

  /**
   * The account's current password, for the changes that hand out a lasting
   * way in: connecting another sign-in, or moving the account to another email
   * address (from which a reset link would then work). A session token alone is
   * not enough for those, because a stolen one would become a permanent key
   * that survives the owner changing the password (audit round four). Accounts
   * with no password (made with a provider) have nothing to confirm with, and
   * pass. Sends the reply and returns false when it fails.
   */
  /**
   * The account's hash now, when it is no longer `before` but `password` still
   * opens it: another sign-in upgraded the same password. Null for anything
   * else, a reset above all.
   */
  const stillThePassword = async (userId: string, password: string, before: string): Promise<string | null> => {
    const now = (await auth.getUserById(userId).catch(() => null))?.passwordHash ?? null;
    if (!now || now === before || !password) return null;
    return (await verifyPassword(password, now)).ok ? now : null;
  };

  const reauthenticated = async (req: FastifyRequest, reply: FastifyReply, user: { username: string; passwordHash: string | null }): Promise<boolean> => {
    if (user.passwordHash === null) return true;
    const given = (req.body as { password?: unknown } | null)?.password;
    const ok = typeof given === 'string' && given.length > 0 && given.length <= 1024 && (await verifyPassword(given, user.passwordHash)).ok;
    if (ok) return true;
    req.socNote = { kind: 'password_change_failed', subject: user.username };
    await reply.code(401).send({ error: 'current password is incorrect', code: 'reauth' });
    return false;
  };

  /**
   * English for every way a password can be refused.
   *
   * These strings are part of the wire format: `src/ui/i18n.ts` maps each one
   * to its Arabic, so the sentence the user reads is chosen by their language
   * rather than by this file. The `code` beside it exists so that anything
   * needing to branch on the reason — a test, a future funnel event — can do it
   * without matching on prose.
   */
  const PASSWORD_ERRORS: Record<PasswordProblem, string> = {
    blank: 'a password is required',
    short: `password must be at least ${PASSWORD_MIN} characters`,
    long: `password must be at most ${PASSWORD_MAX} characters`,
    digits: 'a password of only numbers is too easy to guess',
    repeated: 'that password repeats one short pattern',
    sequence: 'that password is a straight run of letters or keys',
    context: 'a password must not contain your email or username',
    common: 'that password is too easy to guess',
  };

  const passwordError = (verdict: PasswordVerdict): { error: string; code: string } => {
    const problem = verdict.problem ?? 'common';
    return { error: PASSWORD_ERRORS[problem], code: `password_${problem}` };
  };

  /**
   * The policy, applied. Returns the NFC-normalised password when it passes and
   * null when it has already been refused, so every caller reads:
   *
   *   const next = await gradePassword(reply, body.password, ctx);
   *   if (next === null) return;
   *
   * Normalising here rather than at each call site is the point: the string that
   * was judged is the string that gets hashed, which is the only way those two
   * can never disagree.
   */
  const gradePassword = (reply: FastifyReply, supplied: unknown, ctx?: PasswordContext): string | null => {
    const pw = normalizePassword(typeof supplied === 'string' ? supplied : '');
    const verdict = checkPassword(pw, ctx);
    if (!verdict.ok) {
      void reply.code(400).send(passwordError(verdict));
      return null;
    }
    return pw;
  };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const { username, password, email, acceptedVersion } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      email?: string;
      acceptedVersion?: string;
    };
    if (!username || !USERNAME.test(username)) {
      return reply.code(400).send({ error: 'username 3-24 [a-zA-Z0-9_]' });
    }
    const mail = typeof email === 'string' ? email.trim() : '';
    if (!mail || mail.length > MAX_EMAIL || !EMAIL.test(mail)) {
      return reply.code(400).send({ error: 'a valid email is required' });
    }
    // The password is judged last of the three because it is the only one whose
    // verdict depends on the other two: `osamah@gmail.com` is a fine email and a
    // terrible password for the person who owns it.
    const secret = gradePassword(reply, password, { email: mail, username });
    if (secret === null) return;
    // An allow-listed name is RESERVED. Admin rights follow the name, so an
    // allow-listed name with no account behind it used to be moderator rights
    // for whoever signed up with it first: one unauthenticated request. Public
    // sign-up refuses it exactly as it refuses a taken name; claiming it takes
    // the admin password (adminClaim). A name that merely case-folds onto an
    // admin name is refused outright: it closes the impersonation angle and
    // keeps the list unambiguous.
    //
    // Checked here, after the body is otherwise valid, and not first: first,
    // `{"username":"x"}` alone answered 409 for an admin name and 400 for any
    // other, which listed the moderators' names, claimed or not, to anyone who
    // asked (audit round five). Now it is the same 409 a taken name gets,
    // and it takes as long: a taken name is refused only after the password
    // is hashed, so a refusal that skipped the hash answered in 1 ms instead
    // of ~390, and said "moderator" just as clearly.
    if (adminFolded.has(username.toLowerCase()) && !adminClaim(req, username)) {
      await hashPassword(secret);
      return reply.code(409).send({ error: 'username or email taken' });
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
    const user = await auth.createUser(username, await hashPassword(secret), { email: mail, acceptedVersion: version });
    if (!user) return reply.code(409).send({ error: 'username or email taken' });
    const { token, tokenHash } = issueToken();
    await auth.createToken(user.id, tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
    // The account is real whether or not the mail went out, so registration
    // still succeeds — but it says which, so the UI can offer a resend instead
    // of sending someone to an inbox nothing is coming to.
    // The signup message counts toward the same per-account and per-address
    // daily limits as every later one.
    mailBudget.take(`verify-by:${user.id}`, VERIFY_BY_ACCOUNT);
    mailBudget.take(addressKey('verify-to', mail), VERIFY_TO_ADDRESS);
    const emailSent = await sendVerifyEmail(req, { id: user.id, email: mail });
    if (!emailSent) {
      mailBudget.refund(`verify-by:${user.id}`);
      mailBudget.refund(addressKey('verify-to', mail));
    }
    return reply.code(201).header('cache-control', SECRET_NO_STORE).send({
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
    const userId = /^[a-f0-9]{64}$/.test(token) ? await auth.consumeEmailToken(hashToken(token), 'verify_email') : null;
    let verified = false;
    if (userId) {
      // Only for the address this link was sent to, and only while the account
      // still has it: the mark is conditional on the address in one statement.
      const user = await auth.getUserById(userId).catch(() => null);
      if (user?.email && addressTag(user.email) === token.slice(-16)) {
        verified = await auth.markEmailVerified(userId, user.email);
      }
    }
    // The token is in the URL: don't cache it and don't leak it via the Referer header.
    return reply
      .header('cache-control', SECRET_NO_STORE)
      .header('referrer-policy', 'no-referrer')
      .redirect(`/projects?verified=${verified ? 1 : 0}`);
  });

  // Re-send the verification email to the signed-in user. The cooldown and its
  // reasons are with lastVerifySentAt, above sendVerifyEmail.
  app.post('/api/auth/verify/resend', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await accountOf(req, userId).catch(() => null);
    if (!user?.email) return reply.code(400).send({ error: 'no email on file' });
    if (user.emailVerifiedAt) return reply.code(200).send({ ok: true, alreadyVerified: true });
    const last = lastVerifySentAt.get(userId);
    const since = last === undefined ? Number.POSITIVE_INFINITY : Date.now() - last;
    if (since < RESEND_COOLDOWN_MS) {
      req.socNote = { ignore: true }; // a second press, not an attack
      return reply.code(429).send({
        error: 'a message is already on its way',
        retryInSeconds: Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - since) / 1000)),
      });
    }
    // Ten verification messages a day per account. Each one is five guesses at
    // a 6-digit code, so this is also what keeps guessing out of reach.
    const dailyWait = mailBudget.take(`verify-by:${userId}`, VERIFY_BY_ACCOUNT);
    if (dailyWait > 0) {
      req.socNote = { kind: 'mail_refused' };
      return reply.code(429).send({ error: 'too many verification emails today', retryInSeconds: dailyWait });
    }
    // Claim the slot before the provider call, so two quick presses cannot
    // both get through while the first is still waiting on Resend.
    lastVerifySentAt.set(userId, Date.now());
    const sent = await sendVerifyEmail(req, { id: user.id, email: user.email });
    if (!sent) {
      // Don't let someone's failed send lock them out of retrying.
      mailBudget.refund(`verify-by:${userId}`);
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
    const user = await accountOf(req, userId).catch(() => null);
    if (user?.emailVerifiedAt) return reply.code(200).send({ ok: true, alreadyVerified: true });
    if (code.length !== 6) return reply.code(400).send({ error: 'enter the 6-digit code' });

    const tries = codeTries.get(userId) ?? 0;
    if (tries >= VERIFY_CODE_MAX_TRIES) {
      req.socNote = { kind: 'code_exhausted' };
      return reply.code(429).send({ error: 'too many attempts, request a new code', exhausted: true });
    }
    // The try is taken BEFORE the code is looked up, not after. Counted after
    // the await, every request sent at the same moment read the same count:
    // 30 guesses fired together on Postgres were all checked against one code,
    // and the right one among them verified an address the account never
    // proved it owned (audit round five) — the first step of the pre-sign-up
    // takeover round four closed. A right code clears the count below.
    noteCodeTry(userId, tries + 1);
    const sentTo = user?.email ?? '';
    const ok = sentTo ? await auth.consumeEmailToken(codeHash(userId, sentTo, code), 'verify_code') : null;
    if (ok !== userId) {
      const next = Math.max(tries + 1, codeTries.get(userId) ?? 0);
      // Burn the code once the budget is spent, so a new one must be requested.
      if (next >= VERIFY_CODE_MAX_TRIES) await auth.deleteEmailTokens(userId, 'verify_code').catch(() => {});
      req.socNote = { kind: next >= VERIFY_CODE_MAX_TRIES ? 'code_exhausted' : 'code_failed' };
      return reply.code(400).send({
        error: 'that code is not right or has expired',
        triesLeft: Math.max(0, VERIFY_CODE_MAX_TRIES - next),
      });
    }
    codeTries.delete(userId);
    await auth.deleteEmailTokens(userId, 'verify_email');
    // Conditional on the address the code was sent to: if the account's email
    // changed while the code was being typed, nothing is verified.
    if (!(await auth.markEmailVerified(userId, sentTo))) {
      return reply.code(400).send({ error: 'that code is not right or has expired', triesLeft: 0 });
    }
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
    // Renaming onto an admin name is claiming it, so it takes the same proof as
    // signing up with one: the admin password (adminClaim). Without it, an
    // allow-listed name nobody holds would be moderator rights for the first
    // account to rename onto it, and uniqueness would not stop that. This is
    // also how the operator claims it in practice, because sign-up derives the
    // name from the email: rename in Account, and give the admin password when
    // the page asks for it.
    if (adminFolded.has(username.toLowerCase()) && !adminClaim(req, username)) {
      return reply.code(409).send({ error: 'that name is taken' });
    }
    // And never AWAY from one. Admin rights follow the name, so an admin who
    // renamed (or deleted) their account freed it, and whoever registered it
    // next was a moderator (audit round four). Change ADMIN_USERNAMES first.
    if (await adminNameOf(userId, req)) {
      return reply.code(403).send({ error: 'an admin account keeps its name; change ADMIN_USERNAMES first', code: 'admin_name' });
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
    const user = await accountOf(req, userId).catch(() => null);
    // Copied out: a repository may hand back a live object that a reset changes.
    const checkedHash = user ? user.passwordHash ?? null : null;
    // An account created by signing in with a provider has no password to
    // confirm. Asking for one it never had would lock it out of ever getting
    // one — and the bearer token has already proved who is asking, which is the
    // only thing the current password was ever there to prove.
    const settingFirst = !!user && checkedHash === null;
    if (settingFirst && user.email && user.emailVerifiedAt) {
      // A session alone used to be enough here. On an account that signs in
      // only with Google, a stolen session could then set a password the thief
      // knows, move the email with it, and reset the owner out for good (audit
      // round six). Where there is a proven mailbox, the mailbox decides: the
      // page sends the set-a-password link there instead (the reset flow).
      return reply.code(403).send({ error: 'we will email you a link to set a password', code: 'use_email_link' });
    }
    if (!settingFirst) {
      // Ownership first, then the policy. The old order graded the new password
      // before checking that the caller could prove the account was theirs, which
      // meant anyone holding a stale token could probe the blocklist for free.
      const current = await verifyPassword(currentPassword ?? '', checkedHash ?? await dummyHash());
      if (!user || !currentPassword || !current.ok) {
        req.socNote = { kind: 'password_change_failed', subject: user?.username };
        return reply.code(401).send({ error: 'current password is incorrect' });
      }
    }
    if (!user) return reply.code(401).send({ error: 'current password is incorrect' });
    const next = gradePassword(reply, newPassword, { email: user.email ?? undefined, username: user.username });
    if (next === null) return;
    // Changing a password is what someone does when they think a session is
    // compromised. It has to end the other sessions, or it is theatre: tokens
    // live 30 days, so a stolen one otherwise outlived the "fix" by a month.
    // A replacement session is minted so the person who just changed it stays
    // signed in here.
    //
    // Reset links stay. The mailbox outranks a session: someone holding a
    // stolen session and the password could otherwise spend every link the
    // owner asked for by changing the password every few seconds, and the
    // owner could never take the account back (audit round six).
    //
    // One step, all or nothing. It was four writes with the token cleanup's
    // errors swallowed, so a failure there kept every stolen session alive and
    // still answered `signedOutEverywhereElse: true` (audit round six). Now a
    // failure changes nothing, says so, and the old password still works.
    // And only over the password just checked: a reset that landed while this
    // was hashing has taken the account back, and this change must not undo it.
    const { token, tokenHash } = issueToken();
    let changed: boolean;
    try {
      const nextHash = await hashPassword(next);
      const write = (expectedHash: string | null) =>
        auth.replacePassword(userId, nextHash, {
          expectedHash,
          keepResetLinks: true,
          newSession: { tokenHash, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
        });
      changed = await write(checkedHash);
      if (!changed && checkedHash !== null) {
        // A sign-in in another tab may have upgraded the hash of this same
        // password meanwhile. That is not a reset: go on over the new hash if
        // the password just confirmed still opens it.
        const now = await stillThePassword(userId, currentPassword ?? '', checkedHash);
        if (now) changed = await write(now);
      }
    } catch (err) {
      req.log.error({ err }, 'password change failed');
      return reply.code(503).send({ error: 'your password was not changed, please try again', code: 'retry' });
    }
    if (!changed) {
      req.socNote = { kind: 'password_change_failed', subject: user.username };
      return reply.code(401).send({ error: 'current password is incorrect' });
    }
    return reply.code(200).header('cache-control', SECRET_NO_STORE).send({ ok: true, token, signedOutEverywhereElse: true });
  });

  // Forgot password: always 200 so the response can't be used to probe which
  // emails have accounts. Sends a reset link only when the address actually exists.
  app.post('/api/auth/forgot', authLimit, async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string };
    const mail = typeof email === 'string' ? email.trim() : '';
    if (mail && mail.length <= MAX_EMAIL && EMAIL.test(mail)) {
      // The lookup and the send happen after the answer is decided. Awaiting the
      // provider only for real accounts made them ~150 ms slower, which told a
      // caller which addresses have accounts; the identical body did not help.
      // And at most one reset email per address every 5 minutes (5 a day): the
      // rate limit is per caller, so without this one IP could mail a victim a
      // reset link every six seconds and spend the provider's daily allowance.
      inBackground((async () => {
        const user = await auth.getUserByEmail(mail).catch(() => null);
        if (!user?.email) return;
        if (mailBudget.take(addressKey('reset', user.email), RESET_TO_ADDRESS) > 0) {
          options.soc?.record('mail_refused', { ip: req.ip, route: 'POST /api/auth/forgot', subject: user.username, reqId: String(req.id) });
          return;
        }
        await sendResetEmail(req, { id: user.id, email: user.email });
      })());
    }
    return reply.code(200).send({ ok: true });
  });

  // Reset password using the emailed token. Single-use; invalidates all sessions.
  app.post('/api/auth/reset', authLimit, async (req, reply) => {
    const { token, newPassword } = (req.body ?? {}) as { token?: string; newPassword?: string };
    // Graded before the token is spent. `consumeEmailToken` is single-use, so
    // grading afterwards would burn someone's reset link on a typo and send them
    // back to the forgot-password form to ask for another one.
    //
    // That ordering costs the one thing the other two paths have: there is no
    // account in hand yet, so the email-and-username check cannot run here. A
    // reset is the rarer path and the link is proof of the mailbox, so the
    // trade is worth it.
    const next = gradePassword(reply, newPassword);
    if (next === null) return;
    // Hashed before the link is spent, so spending it and using it are
    // milliseconds apart rather than the 0.3 s of the hash.
    const newHash = token ? await hashPassword(next) : null;
    const userId = token ? await auth.consumeEmailToken(hashToken(token), 'reset_password') : null;
    if (!userId || !newHash) return reply.code(400).send({ error: 'invalid or expired reset link' });
    // A reset is how an account is taken back. It proves who owns the mailbox,
    // not who connected the Google or X sign-ins already on the account, so
    // those are removed too: one connected by whoever had the account before
    // would otherwise still open it (audit round four). The owner's own comes
    // back by itself the next time they sign in with it, because the account's
    // verified address matches.
    //
    // New password, every session ended, every other reset link spent and the
    // sign-ins removed, in one transaction. The removals used to be separate
    // writes with their errors swallowed, so a failure could leave the
    // intruder's Google sign-in on an account that had just been "taken back",
    // behind a reply of ok (audit round six). Now it is all of it or none of it.
    let reset: boolean;
    try {
      reset = await auth.replacePassword(userId, newHash, { dropIdentities: true });
    } catch (err) {
      req.log.error({ err }, 'password reset failed');
      return reply.code(503).send({ error: 'your password was not changed; request a new reset link and try again', code: 'retry' });
    }
    if (!reset) return reply.code(400).send({ error: 'invalid or expired reset link' }); // the account is gone
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
    //
    // The password is normalised to NFC first, because that is the form
    // registration now stores. For ASCII the two strings are identical, so no
    // existing account notices; for Arabic it is the difference between the same
    // password typed on two keyboards matching and not. The raw form is tried
    // afterwards so an account created before this change, with a password that
    // was never NFC, still opens — a second scrypt that only ever runs for a
    // password that is not already NFC and did not match, which is nobody's
    // normal sign-in and no new signal about whether the account exists.
    const supplied = typeof password === 'string' ? password : '';
    // Read once: the hash this sign-in is judged against, and the one the
    // session is issued against below. A repository may hand back a live
    // object that a reset changes while scrypt runs.
    const storedHash = user?.passwordHash ?? null;
    let matched = normalizePassword(supplied);
    let check = await verifyPassword(matched, storedHash ?? await dummyHash());
    if (!check.ok && matched !== supplied) {
      matched = supplied;
      check = await verifyPassword(matched, storedHash ?? await dummyHash());
    }
    // The account a sign-in was aimed at, for the Security tab: its public
    // @name when it exists, nothing when it does not (what was typed stays out).
    req.socNote = { subject: user?.username };
    if (!user || !password || !check.ok || !storedHash) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    // Right password, weaker parameters than we now use: this is the only moment
    // the password exists in the clear, so it is the only moment it can be
    // upgraded. Best-effort — a failed rehash must not fail the sign-in. And
    // only over the hash just checked: written unconditionally, a sign-in that
    // overlapped a reset put the OLD password back over the new one (audit
    // round six).
    let sessionHash = storedHash;
    if (check.needsRehash) {
      const upgraded = await hashPassword(matched);
      if (await auth.upgradePasswordHash(user.id, storedHash, upgraded).catch(() => false)) {
        sessionHash = upgraded;
      } else {
        // Someone else changed the hash meanwhile. Another sign-in upgrading the
        // same password is fine and this one goes ahead on the hash it wrote; a
        // reset is not, and the password just typed will not match it.
        const now = (await auth.getUserById(user.id).catch(() => null))?.passwordHash ?? null;
        if (now && now !== storedHash && (await verifyPassword(matched, now)).ok) sessionHash = now;
      }
    }
    // The session is issued only while the password is still the one checked.
    // A reset or a password change that landed meanwhile has signed everyone
    // out, this sign-in included; it gets the same answer as a wrong password.
    const { token, tokenHash } = issueToken();
    if (!(await auth.createTokenIfPassword(user.id, sessionHash, tokenHash, new Date(Date.now() + TOKEN_TTL_MS)))) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    return reply.header('cache-control', SECRET_NO_STORE).send({ token, username: user.username });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) await auth.deleteToken(hashToken(header.slice(7)));
    return reply.code(204).send();
  });

  // ---------- signing in with a provider ----------
  //
  // The whole round trip lives here. The provider-specific parts — which URL,
  // which scopes, how to read a profile — are in oauth.ts; what is below is the
  // part that is the same for every provider and is where the security is.

  const providerSecrets: Record<string, { id: string; secret: string }> = {
    google: {
      id: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
      secret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    },
    ...(options.oauth ?? {}),
  };
  /** A provider is offered only when it is fully configured. */
  const providerReady = (id: string): boolean =>
    !!PROVIDERS[id] && !!providerSecrets[id]?.id && !!providerSecrets[id]?.secret;

  const PENDING_COOKIE = 'tm_oauth';
  const HANDOFF_COOKIE = 'tm_handoff';
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const HANDOFF_TTL_MS = 2 * 60 * 1000;

  // Unconditional Secure would silently break sign-in on a local http dev
  // server, which reads to the developer as "Google is broken".
  const wantsSecure = (req: FastifyRequest): boolean =>
    req.protocol === 'https' || process.env.NODE_ENV === 'production';

  /**
   * SameSite=Lax, not Strict.
   *
   * The callback is a top-level GET navigation arriving from accounts.google.com
   * — a cross-site request. Strict would withhold the cookie exactly then, and
   * every sign-in would fail the state check. Lax sends it on a top-level GET
   * and withholds it on a cross-site POST, which is precisely the pair of
   * behaviours this needs.
   */
  const cookieLine = (req: FastifyRequest, name: string, value: string, path: string, maxAgeMs: number): string =>
    `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${wantsSecure(req) ? '; Secure' : ''}`;
  const clearLine = (req: FastifyRequest, name: string, path: string): string =>
    `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax${wantsSecure(req) ? '; Secure' : ''}`;

  /**
   * The callback URL, built the same way email links are.
   *
   * `emailBase` prefers PUBLIC_URL and otherwise only trusts a Host it
   * recognises. A forged Host header must not be able to bend an OAuth callback
   * any more than it can bend a password-reset link — and the redirect_uri is
   * matched exactly by the provider, so a wrong one fails loudly rather than
   * quietly sending a code somewhere else.
   */
  const callbackUri = (req: FastifyRequest, provider: string): string =>
    `${emailBase(req)}/api/auth/${provider}/callback`;

  /** Which providers the sign-in form should offer. */
  app.get('/api/auth/providers', async () => ({
    providers: Object.keys(PROVIDERS).filter(providerReady),
  }));

  const startFlow = (req: FastifyRequest, reply: FastifyReply, provider: string, extra: Partial<PendingAuth>): string => {
    const { state, verifier, challenge, nonce } = newChallenge();
    const q = req.query as { returnTo?: string; claim?: string; policy?: string };
    const pending: PendingAuth = {
      p: provider,
      s: state,
      v: verifier,
      r: safeReturnTo(q.returnTo),
      c: q.claim === '1' ? 1 : 0,
      e: Date.now() + PENDING_TTL_MS,
      ...extra,
    };
    void reply.header('set-cookie', [cookieLine(req, PENDING_COOKIE, sealPending(pending), '/api/auth', PENDING_TTL_MS)]);
    return PROVIDERS[provider]!.authorizeUrl({
      clientId: providerSecrets[provider]!.id,
      redirectUri: callbackUri(req, provider),
      state,
      challenge,
      nonce,
    });
  };

  // Step one: send the browser to the provider. A plain navigation, so there is
  // no script from anyone else on any page of this site and the CSP is untouched.
  app.get('/api/auth/:provider', authLimit, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!providerReady(provider)) return reply.code(404).send({ error: 'not found' });
    const policy = (req.query as { policy?: string }).policy;
    const url = startFlow(req, reply, provider, typeof policy === 'string' ? { a: policy.slice(0, 32) } : {});
    // The sealed state and PKCE verifier go out in its cookie.
    return reply.header('cache-control', SECRET_NO_STORE).redirect(url);
  });

  // Step two: the browser comes back. Everything here is about being sure it is
  // the same browser finishing the same request it started.
  app.get('/api/auth/:provider/callback', authLimit, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const impl = PROVIDERS[provider];
    const pending = openPending(readCookie(req, PENDING_COOKIE) ?? undefined);
    const cleared = clearLine(req, PENDING_COOKIE, '/api/auth');

    /**
     * Fail towards the normal sign-in form with a reason in the query, never a
     * stack trace and never a blank page. `reason` is one of a fixed set the
     * client has copy for; nothing from the provider is echoed back.
     */
    const bail = (reason: string, to = '/app'): FastifyReply =>
      reply
        .header('set-cookie', [cleared])
        .header('cache-control', SECRET_NO_STORE)
        .header('referrer-policy', 'no-referrer')
        .redirect(`${to}?signin=failed&reason=${encodeURIComponent(reason)}`);

    if (!impl || !providerReady(provider) || !pending || pending.p !== provider) return bail('state');
    const q = req.query as { code?: string; state?: string; error?: string };
    // The provider sent the browser back without a code. Which of our words that
    // deserves depends on why — pressing cancel and Google refusing to run at
    // all inside an app's browser are very different things to be told.
    if (typeof q.error === 'string') {
      // JSON-quoted and printable only: the value is whatever was in the URL, and
      // a raw newline in it wrote a second, forged line into the log.
      console.error(`[tifo] oauth ${provider} returned error=${JSON.stringify(q.error.slice(0, 64).replace(/[^\x20-\x7e]/g, '?'))}`);
      return bail(describeProviderError(q.error), pending.r);
    }
    if (typeof q.code !== 'string' || typeof q.state !== 'string') return bail('state', pending.r);
    // RFC 9700: one-time state, bound to this user agent (it arrived in an
    // HttpOnly cookie), compared without leaking position through timing.
    if (!sameState(q.state, pending.s)) return bail('state', pending.r);

    const accessToken = await impl.exchange({
      code: q.code,
      verifier: pending.v,
      clientId: providerSecrets[provider]!.id,
      clientSecret: providerSecrets[provider]!.secret,
      redirectUri: callbackUri(req, provider),
    });
    if (!accessToken) return bail('provider', pending.r);
    const profile = await impl.profile(accessToken);
    if (!profile) return bail('provider', pending.r);

    // A failed lookup is not "nobody has this sign-in": answered as that, the
    // code below made a new account holding the provider's verified address, or
    // linked the sign-in somewhere it does not belong (audit round six).
    let owner: string | null;
    try {
      owner = await auth.getUserIdByIdentity(provider, profile.id);
    } catch {
      return bail('provider', pending.r);
    }

    // ---- linking an extra provider onto an account that is already signed in.
    // Safe by construction: `pending.u` was written by us, in a request that
    // carried a bearer token, and the cookie carrying it is signed.
    if (pending.u) {
      // The session that started the link must still be the account's: one
      // revoked since (password changed, signed out everywhere) cannot finish it.
      const live = pending.t ? await auth.getUserIdByToken(pending.t).catch(() => null) : null;
      if (live !== pending.u || !pending.t) return bail('state', pending.r);
      if (owner && owner !== pending.u) return bail('linked_elsewhere', pending.r);
      // Stored only while that session is still live, in the same statement: a
      // reset landing between the check above and the write used to leave this
      // sign-in on the account it had just taken back (audit round six).
      if (!owner && !(await auth.linkIdentityForSession(provider, profile.id, pending.u, pending.t).catch(() => false))) {
        const now = await auth.getUserIdByIdentity(provider, profile.id).catch(() => null);
        if (now && now !== pending.u) return bail('linked_elsewhere', pending.r);
        if (now !== pending.u) return bail('state', pending.r);
        // Linked by this same sign-in finishing twice at once: fine.
      }
      if (!owner) noticeLinked(req, pending.u, provider);
      req.socNote = { kind: 'oauth_linked', subject: provider };
      return reply
        .header('set-cookie', [cleared])
        .header('cache-control', SECRET_NO_STORE)
        .redirect(`${pending.r}?linked=${provider}`);
    }

    // ---- signing in.
    let userId = owner;

    // Attaching this identity to an account that already exists is the one
    // genuinely dangerous step in the whole flow, and it needs BOTH sides
    // verified. Checking only the provider's claim is CVE-2026-53516: an
    // attacker registers the victim's address with a password, leaves it
    // unverified, waits for the victim to sign in with Google, and the link
    // hands them an account with a password they know. So an unverified local
    // account is never linked to — it is sent to prove ownership first.
    // An address from a provider is still an address, and it goes through the
    // same gate as one typed into the form. Trusting Google to have validated it
    // would leave this one path able to write a row every other path treats as
    // impossible — and a stored value nothing else can produce is how a
    // never-reproducible bug starts.
    const claimedEmail =
      profile.email && profile.email.length <= MAX_EMAIL && EMAIL.test(profile.email) ? profile.email : null;

    if (!userId && claimedEmail && profile.emailVerified) {
      // A failed lookup is not "nobody has this address": answered as that, it
      // made a new empty account and tied the sign-in to it, so the owner's
      // Google opened an account that was not theirs from then on (audit
      // round six). Stop and let them try again.
      let byEmail: Awaited<ReturnType<typeof auth.getUserByEmail>>;
      try {
        byEmail = await auth.getUserByEmail(claimedEmail);
      } catch {
        return bail('provider', pending.r);
      }
      if (byEmail) {
        if (!byEmail.emailVerifiedAt) {
          req.socNote = { kind: 'oauth_link_refused', subject: byEmail.username };
          return bail('verify_first', pending.r);
        }
        if (!(await auth.linkIdentity(provider, profile.id, byEmail.id).catch(() => false))) {
          return bail('provider', pending.r);
        }
        userId = byEmail.id;
      }
    }

    // ---- nobody here yet: a new account, with no password at all.
    if (!userId) {
      const seed = claimedEmail ?? profile.name ?? 'tifo';
      // The address goes on the account only when the provider verified it, and
      // only when it is free. An unverified address that already belongs to
      // someone else is dropped rather than fought over — the account is created
      // without one and the app asks for an address afterwards.
      const mail = claimedEmail && profile.emailVerified ? claimedEmail : null;
      let created = null as Awaited<ReturnType<typeof auth.createUser>>;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        const name = deriveUsername(seed, attempt, () => randomInt(0, 1_000_000) / 1_000_000);
        if (adminFolded.has(name.toLowerCase())) continue;
        created =
          (await auth
            .createUser(name, null, {
              email: mail,
              acceptedVersion: pending.a ?? null,
              emailVerified: !!mail,
              // We invented this handle from their email. It is a placeholder
              // until they say otherwise, and the wall in `requireUser` is what
              // makes sure they get asked.
              usernameChosen: false,
            })
            .catch(() => null)) ?? null;
        // A taken EMAIL fails every attempt, so stop rewriting the name and try
        // once without it rather than burning all five tries on the same clash.
        const bare = deriveUsername(seed, attempt + 1, () => randomInt(0, 1_000_000) / 1_000_000);
        if (!created && mail && attempt === 1 && !adminFolded.has(bare.toLowerCase())) {
          created =
            (await auth
              .createUser(bare, null, {
                acceptedVersion: pending.a ?? null,
                usernameChosen: false,
              })
              .catch(() => null)) ?? null;
        }
      }
      if (!created) return bail('provider', pending.r);
      if (!(await auth.linkIdentity(provider, profile.id, created.id).catch(() => false))) {
        return bail('provider', pending.r);
      }
      userId = created.id;
    }

    // A one-time ticket, not a session: it lives two minutes, is not accepted
    // as a bearer anywhere, and is spent atomically when traded. It used to be
    // a full 30-day session token, so the cookie itself was a session, and two
    // concurrent trades of one cookie both succeeded (audit round four).
    //
    // Stored only while this identity still opens the account: a reset that
    // removed it after the lookup above would otherwise be followed by a
    // ticket, and a session, for the very sign-in it took away (audit round six).
    const { token, tokenHash } = issueToken();
    if (!(await auth.createHandoffIfLinked(userId, provider, profile.id, tokenHash, new Date(Date.now() + HANDOFF_TTL_MS)).catch(() => false))) {
      return bail('provider', pending.r);
    }
    req.socNote = { subject: (await auth.getUserById(userId).catch(() => null))?.username };

    // The session must not travel in the URL. This site's own logger redacts
    // `token=` out of request lines precisely because URLs end up in history,
    // in Referer headers and in logs — so the token goes in a short-lived
    // HttpOnly cookie scoped to the one endpoint that trades it back, and the
    // page swaps it for the real thing on load.
    return reply
      .header('set-cookie', [cleared, cookieLine(req, HANDOFF_COOKIE, token, '/api/auth/handoff', HANDOFF_TTL_MS)])
      .header('cache-control', SECRET_NO_STORE)
      .header('referrer-policy', 'no-referrer')
      .redirect(`${pending.r}?signedin=${provider}${pending.c ? '&claim=1' : ''}`);
  });

  /**
   * Trade the handoff cookie for the bearer token the app actually uses.
   *
   * Single-use, and not merely because the cookie is cleared — clearing is a
   * request to the browser, not a fact. The handed token is *spent*: a fresh one
   * is minted and the old one deleted, so a replay of the same cookie finds a
   * token that no longer exists. Whoever holds a copy gets 401, not a session.
   *
   * A POST, so SameSite=Lax withholds the cookie from any cross-site attempt.
   */
  app.post('/api/auth/handoff', authLimit, async (req, reply) => {
    const handed = readCookie(req, HANDOFF_COOKIE);
    void reply.header('set-cookie', [clearLine(req, HANDOFF_COOKIE, '/api/auth/handoff')]);
    if (!handed) return reply.code(401).send({ error: 'no session to adopt' });
    // Spent in one statement: only the first trade of a ticket gets a session,
    // and the ticket and the session are one write, so a reset cannot land
    // between them and leave the session standing.
    const fresh = issueToken();
    const userId = await auth.exchangeHandoff(hashToken(handed), fresh.tokenHash, new Date(Date.now() + TOKEN_TTL_MS)).catch(() => null);
    if (!userId) return reply.code(401).send({ error: 'no session to adopt' });
    const user = await auth.getUserById(userId).catch(() => null);
    return reply.header('cache-control', SECRET_NO_STORE).send({ token: fresh.token, username: user?.username ?? null });
  });

  /**
   * Start a link from the account page. Authenticated, so the callback can trust `u`.
   *
   * Three conditions, each closing a way in found in audit round four:
   *  - the account's email must be verified. Otherwise an attacker registers a
   *    victim's address with a password, links their own Google, and keeps that
   *    way in after the victim recovers the account by resetting the password;
   *  - the account's current password, when it has one. A link is a permanent
   *    second key, and a stolen session alone must not be enough to cut one;
   *  - the link is tied to the session that started it (`t`), checked again at
   *    the callback.
   * And the owner is emailed whenever a sign-in method is added.
   */
  app.post('/api/account/link/:provider', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { provider } = req.params as { provider: string };
    if (!providerReady(provider)) return reply.code(404).send({ error: 'not found' });
    const user = await accountOf(req, userId).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (user.email && !user.emailVerifiedAt) {
      return reply.code(403).send({ error: 'verify your email before connecting another sign-in', code: 'verify_first' });
    }
    // A link is a lasting second key. An account with no password has nothing
    // but the session to confirm one with, and a stolen session must not be
    // able to add the thief's own Google (audit round six): where there is a
    // proven address, a password is set through it first.
    if (user.passwordHash === null && user.email) {
      return reply.code(403).send({ error: 'set a password before connecting another sign-in', code: 'set_password_first' });
    }
    if (!(await reauthenticated(req, reply, user))) return;
    const header = String(req.headers.authorization ?? '');
    const url = startFlow(req, reply, provider, { u: userId, t: hashToken(header.slice(7)) });
    return reply.header('cache-control', SECRET_NO_STORE).send({ url });
  });

  /** Remove one. Never leaves an account with no way back in. */
  app.delete('/api/account/link/:provider', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { provider } = req.params as { provider: string };
    const user = await accountOf(req, userId).catch(() => null);
    const linked = await auth.identitiesFor(userId).catch(() => [] as string[]);
    // Counted after the removal: every sign-in of that provider goes at once.
    if (!user?.passwordHash && linked.filter((p) => p !== provider).length === 0) {
      return reply.code(400).send({
        error: 'set a password before removing your last sign-in method',
        code: 'last_method',
      });
    }
    const removed = await auth.unlinkIdentity(provider, userId).catch(() => false);
    if (!removed) return reply.code(404).send({ error: 'not found' });
    return { ok: true, providers: await auth.identitiesFor(userId).catch(() => [] as string[]) };
  });

  app.get('/api/me', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await accountOf(req, userId).catch(() => null);
    return {
      id: userId,
      username: user?.username ?? null,
      email: user?.email ?? null,
      emailVerified: !!user?.emailVerifiedAt,
      isAdmin: await isAdminUser(userId, req),
      // What this account can sign in with. The account page needs both: it
      // offers "Set a password" instead of "Change password" when there is
      // none, and it refuses to unlink the last way in.
      providers: await auth.identitiesFor(userId).catch(() => [] as string[]),
      hasPassword: !!user?.passwordHash,
      // True only for an account created by a provider whose owner has not yet
      // picked a handle. Everything else is refused with 428 until they do.
      needsUsername: user ? user.usernameChosen === false : false,
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
    const before = await accountOf(req, userId).catch(() => null);
    if (!before) return reply.code(401).send({ error: 'authentication required' });
    // Copied out: a repository may hand back a live object that setEmail changes.
    const oldEmail = before.email;
    const oldHash = before.passwordHash ?? null;
    const oldVerified = !!before.emailVerifiedAt;
    const handle = before.username;
    // An address on the account is where its reset links go, so putting one
    // there asks for the password, a first address included: without one, a
    // stolen session could add the thief's address, verify it, and reset the
    // password out from under the owner (audit round six). Sending the same
    // address again (a new code) changes nothing and needs no password.
    const moving = !oldEmail || oldEmail.toLowerCase() !== mail.toLowerCase();
    if (moving && !(await reauthenticated(req, reply, before))) return;
    // An account with no password has nothing to confirm a move with, and its
    // proven address is what would take it back after a stolen session: so it
    // keeps that address until it has a password (set through the emailed
    // link, see /api/account/password).
    if (moving && oldHash === null && oldEmail && before.emailVerifiedAt) {
      return reply.code(403).send({ error: 'set a password before changing your email', code: 'set_password_first' });
    }
    // Every call here mails a code to whatever address it names, so without
    // limits one signed-in account could mail any stranger over and over. And an
    // address that already has an account answers 409, which a person changing
    // their email needs to be told, so each attempt costs the account one of its
    // ten daily emails whatever the answer: otherwise a signed-in script could
    // test every address on a mailing list for free.
    const byWait = mailBudget.take(`verify-by:${userId}`, VERIFY_BY_ACCOUNT);
    if (byWait > 0) {
      req.socNote = { kind: 'mail_refused' };
      return reply.code(429).send({ error: 'too many verification emails today', retryInSeconds: byWait });
    }
    const holder = await auth.getUserByEmail(mail).catch(() => null);
    if (holder && holder.id !== userId) {
      return reply.code(409).send({ error: 'email already in use' });
    }
    // At most one message a minute and five a day to one address. Checked before
    // anything changes, so a refusal leaves the account exactly as it was.
    const toWait = mailBudget.take(addressKey('verify-to', mail), VERIFY_TO_ADDRESS);
    if (toWait > 0) {
      mailBudget.refund(`verify-by:${userId}`); // nothing was sent and nothing was learned
      req.socNote = { kind: 'mail_refused' };
      return reply.code(429).send({ error: 'too many emails to that address, try again later', retryInSeconds: toWait });
    }
    // The move also spends any reset link already sent to the old address, in
    // the same write (see setEmail): it used to be a second call whose failure
    // was swallowed, so a link in a compromised old mailbox kept working.
    // And only over the password just confirmed: a reset that landed meanwhile
    // has taken the account back, and this move must not land after it.
    let ok: boolean;
    let overHash = oldHash;
    try {
      ok = await auth.setEmail(userId, mail, version, oldHash);
      if (!ok && oldHash !== null) {
        // As for a password change: a hash upgraded by another sign-in of the
        // same password is not a reset.
        const given = (req.body as { password?: unknown } | null)?.password;
        const now = typeof given === 'string' && given.length <= 1024 ? await stillThePassword(userId, given, oldHash) : null;
        if (now) {
          overHash = now;
          ok = await auth.setEmail(userId, mail, version, now);
        }
      }
    } catch (err) {
      req.log.error({ err }, 'email change failed');
      mailBudget.refund(addressKey('verify-to', mail));
      mailBudget.refund(`verify-by:${userId}`);
      return reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
    }
    if (!ok) {
      // Taken between the lookup and the write, or the password changed under
      // it. Nothing went to the address either way.
      mailBudget.refund(addressKey('verify-to', mail));
      const now = await auth.getUserById(userId).catch(() => null);
      if (!now || (now.passwordHash ?? null) !== overHash) {
        mailBudget.refund(`verify-by:${userId}`);
        return reply.code(401).send({ error: 'current password is incorrect', code: 'reauth' });
      }
      return reply.code(409).send({ error: 'email already in use' });
    }
    // Send the verification link for the newly added/changed email, server-side,
    // so it never depends on a separate client call.
    await sendVerifyEmail(req, { id: userId, email: mail });
    // Only an address that was proven to be the owner's hears about it: telling
    // an unverified one would let anyone flip their own account's email to and
    // from a stranger's to mail them (the round-three mail-bomb test).
    if (oldEmail && oldVerified && oldEmail.toLowerCase() !== mail.toLowerCase()) {
      securityNotice(
        req,
        oldEmail,
        `The email on your TifoMaker account (@${handle}) was changed to ${maskEmail(mail)}.`,
        `تم تغيير البريد في حسابك في تيفو ميكر (@${handle}) إلى ${maskEmail(mail)}.`,
      );
    }
    return reply.code(200).send({ email: mail, emailVerified: false });
  });

  // Export the caller's data (PDPL/GDPR access right): account fields + their designs.
  app.get('/api/account/export', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    // All of it or none of it: an export that quietly left out the designs it
    // could not read would be a wrong answer to an access request, given as if
    // complete (P1.26 fail-closed review).
    let user: Awaited<ReturnType<typeof auth.getUserById>>;
    let designs: Awaited<ReturnType<typeof repo.listByOwner>>;
    try {
      [user, designs] = await Promise.all([accountOf(req, userId), repo.listByOwner(userId)]);
    } catch {
      return reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
    }
    return reply.header('content-disposition', 'attachment; filename="tifomaker-data.json"').header('cache-control', SECRET_NO_STORE).send({
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
    // Deleting an allow-listed account would free its name for anyone to
    // register, with moderator rights attached (see the rename route).
    if (await adminNameOf(userId, req)) {
      return reply.code(403).send({ error: 'an admin account cannot be deleted here; remove it from ADMIN_USERNAMES first', code: 'admin_name' });
    }
    // For good, with every design: the password, when there is one, not a
    // session alone, which may be a stolen one (audit round six).
    const who = await accountOf(req, userId).catch(() => null);
    if (!who) return reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
    if (!(await reauthenticated(req, reply, who))) return;
    // The designs first, and only then the account. A failure to delete them
    // used to be swallowed and the account deleted anyway (or not, depending
    // on the store), so an erasure could answer 204 having left the person's
    // designs behind with no owner. Now a failure stops here and says so;
    // nothing is half done that a retry cannot finish (P1.26 review).
    try {
      await repo.deleteByOwner(userId);
    } catch {
      return reply.code(503).send({ error: 'your account was not deleted, please try again', code: 'retry' });
    }
    await auth.deleteUser(userId);
    publicSetChanged();
    // Today's home-page pick goes with the account at once, not at the next
    // 60-second recheck: until then the landing page kept showing a deleted
    // person's design and their name (audit round six). After the deletion,
    // so a request in between cannot pick it again.
    daily?.forgetOwner(userId);
    return reply.code(204).send();
  });

  // Admin: grant/revoke the paid (unlimited-AI) entitlement. No payment processor
  // yet — this lets you comp testers or friends to Pro until billing exists.
  app.post('/api/admin/pro', authLimit, async (req, reply) => {
    const adminId = await requireUser(req, reply);
    if (!adminId) return;
    if (!(await isAdminUser(adminId, req))) return reply.code(403).send({ error: 'admin access required' });
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
  /**
   * The deepest `offset` still answered (P3.4). Clients page with the cursor
   * now; `offset` stays for a page that was open across the deploy (its old
   * script pages by offset), up to 20 pages of 60. Each row above the offset
   * is read again on every request, so past this a request costs more than
   * any page should: 400, not a slow answer.
   */
  const GALLERY_OFFSET_MAX = 1200;
  const cursorKey = options.feedCursorKey ?? randomCursorKey();
  const badCursor = (reply: FastifyReply) =>
    reply.code(400).send({ error: 'that page of the feed is not available, start again from the top', code: 'bad_cursor' });

  /**
   * The community feed, a page at a time.
   *
   * The answer is the page's cards, as it always was. When there are more,
   * `x-next-cursor` carries the cursor for the next page (feedCursor.ts):
   * the client sends it back as `cursor` with the same sort and filters, and
   * gets the rows after the last one it has, at the same cost at any depth.
   * The cursor is checked before anything is read: one this server did not
   * issue for this sort and these filters, or with anything out of shape,
   * is a 400.
   */
  app.get('/api/gallery', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const sort = oneParam(q.sort) === 'likes' ? 'likes' : 'recent';
    const rawTags = oneParam(q.tags);
    const tags = rawTags ? rawTags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8) : undefined;
    const search = oneParam(q.search)?.slice(0, 80);
    // The library alone is ~600 designs. Paging keeps the first paint small and
    // stops a single request from shipping every card on the site.
    const limit = Math.min(120, Math.max(1, Math.floor(Number(oneParam(q.limit))) || GALLERY_PAGE));
    const offset = Math.max(0, Math.floor(Number(oneParam(q.offset))) || 0);
    // Colour chips are OR'd (red + gold means either), tags are AND'd. That is
    // not an inconsistency: picking two tags narrows a search, picking two
    // colours widens one, and both match what the chips look like they do.
    const rawColors = oneParam(q.colors);
    const colors = rawColors
      ? rawColors.split(',').map((c) => c.trim().toLowerCase()).filter((c) => (COLOUR_FAMILIES as readonly string[]).includes(c)).slice(0, 6)
      : undefined;
    const clubId = oneParam(q.club)?.slice(0, 60) || undefined;
    const filters = {
      sort, search, tags, colors, clubId,
      templatesOnly: oneParam(q.templates) === '1',
      // `made=people` is the other half of the Templates tab: 619 seeded designs
      // otherwise bury every real one on the newest page.
      excludeTemplates: oneParam(q.made) === 'people',
    } as const;
    const scope = feedScope(filters);
    let after: FeedPosition | null = null;
    if (q.cursor !== undefined) {
      // Exactly one, on its own: a repeated cursor, or a cursor and an offset
      // together, is a question with two answers.
      if (typeof q.cursor !== 'string' || q.cursor.length > CURSOR_MAX_CHARS || q.offset !== undefined) return badCursor(reply);
      after = openCursor(cursorKey, scope, sort, q.cursor);
      if (!after || after.sort !== sort) return badCursor(reply);
    } else if (offset > GALLERY_OFFSET_MAX) {
      return reply.code(400).send({ error: `offset is at most ${GALLERY_OFFSET_MAX}; page with the cursor instead`, code: 'offset_too_deep' });
    }
    const viewerId = await userOf(req); // annotate the caller's votes when signed in
    const page = await repo.listPublicPage({ ...filters, viewerId, limit, offset: after ? 0 : offset, after });
    if (page.next) void reply.header('x-next-cursor', sealCursor(cursorKey, scope, page.next));
    return page.items;
  });

  /**
   * One public design, as the feed would show it.
   *
   * A notification, or a /community?t=<id> link, arrives holding an id and
   * nothing else, and the preview needs a full card: owner name, like score,
   * the caller's own vote, views. The alternative was fetching a page of the
   * feed and hoping the design was on it.
   */
  app.get('/api/gallery/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const viewerId = await userOf(req);
    const item = await repo.getPublicItem(id, viewerId);
    // Private and missing are the same answer on purpose: "this id is not
    // public" must not become a way to learn that a private design exists.
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });

  // ---------- tifo of the day ----------
  /**
   * One community design on the home page, changing daily, and its creator told
   * about it. The pick itself lives in featured.ts; this is the wiring.
   *
   * Constructed once per app so the day's answer is cached in the process: the
   * home page asks on EVERY request, crawlers included, and the answer cannot
   * change until midnight UTC.
   */
  const daily = options.featured
    ? new DailyFeaturePicker(repo, options.featured, options.social)
    : null;

  /**
   * Today's featured tifo, or `item: null` when there is nothing to feature.
   *
   * Always 200 with a nullable item rather than a 404: "no community designs
   * with a thumbnail yet" is an ordinary state of a young site, not an error,
   * and the client hides the section either way. The home page is rendered
   * with this server-side, so in production this endpoint is the development
   * path (vite serves landing.html itself, with no injection) and a fallback.
   */
  app.get('/api/featured/today', async () => {
    const picked = daily ? await daily.today() : null;
    return { day: picked?.day ?? utcDay(), item: picked?.item ?? null };
  });

  /**
   * The four base facet scopes (people or all, templates or not), remembered
   * for up to a minute (performance plan P1.12).
   *
   * /community asks for them on every load. They are counts over public
   * designs and nothing else: no viewer, no selection, the same answer for
   * everyone, so there is nothing personal to keep. They are forgotten at once
   * whenever a design joins or leaves the public set, or changes in a way that
   * moves a count: publish, unpublish, a title or palette edit, the template
   * flag, takedown, trash, restore, delete and account deletion (see
   * publicSetChanged). The minute is only the backstop for a change made
   * outside this process.
   */
  const FACET_MEMO_MS = 60_000;
  const facetMemo = new Map<string, { at: number; value: Promise<FacetBase> }>();
  const facetsFor = (scope: FacetScope): Promise<FacetBase> => {
    const key = `${scope.excludeTemplates ? 'people' : 'all'}|${scope.templatesOnly ? 'templates' : 'any'}`;
    const hit = facetMemo.get(key);
    if (hit && Date.now() - hit.at < FACET_MEMO_MS) return hit.value;
    const value = repo.facetBase(scope);
    facetMemo.set(key, { at: Date.now(), value });
    // A failed count is not remembered: the next request asks again.
    value.catch(() => {
      if (facetMemo.get(key)?.value === value) facetMemo.delete(key);
    });
    return value;
  };
  /** Something about the set of public designs changed: drop what was counted from it. */
  const publicSetChanged = (): void => facetMemo.clear();
  app.decorate('forgetPublicCounts', publicSetChanged);

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
    const scope: FacetScope = { excludeTemplates: oneParam(q.made) === 'people', templatesOnly: oneParam(q.templates) === '1' };
    const base = await facetsFor(scope);
    const names = new Map(clubFilterOptions().map((c) => [c.id, c]));

    // How many a candidate selection would return.
    //
    // The filter panel stages your choices and only applies them when you
    // confirm, so without this the confirm button is a leap: you pick three
    // things, press it, and land on an empty grid with no idea which one was
    // the mistake. Counting first turns that into a number you can watch.
    // Counted in SQL with the feed's own WHERE; never remembered, since it
    // depends on what the caller picked.
    const wantColors = oneParam(q.colors)?.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean).slice(0, 6);
    const wantTags = oneParam(q.tags)?.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
    const wantClub = oneParam(q.club)?.slice(0, 60) || undefined;
    const matching = (wantColors?.length || wantTags?.length || wantClub)
      ? await repo.countPublic({ ...scope, colors: wantColors, tags: wantTags, clubId: wantClub })
      : base.total;

    return {
      total: base.total,
      matching,
      colors: COLOUR_FAMILIES.filter((c) => (base.colors[c] ?? 0) > 0).map((c) => ({ id: c, count: base.colors[c] })),
      clubs: Object.entries(base.clubs)
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
    publicSetChanged(); // the templates / people scopes count it differently now
    return { isTemplate: result };
  });

  // Report a public item for moderation. Signed-in optional but recorded if present.
  app.post('/api/report', reportLimit, async (req, reply) => {
    const reporterId = await userOf(req);
    const body = (req.body ?? {}) as { targetType?: string; targetId?: string; reason?: string };
    const type = body.targetType === 'comment' ? 'comment' : 'design';
    if (!body.targetId || typeof body.reason !== 'string' || !body.reason.trim()) {
      return reply.code(400).send({ error: 'targetId and reason required' });
    }
    if (badId(body.targetId, reply)) return;
    // Reports on things that do not exist, and the same reporter reporting the
    // same thing again, used to land in the queue every time: 120 anonymous
    // reports on random ids pushed a real one out of the moderators' view
    // (audit round four). A design must be one the reporter can see.
    // And a comment must be on one: comment reports were never checked, so the
    // same flood came back through `targetType: "comment"` with random ids,
    // and 100 of them hid the real report (audit round five).
    const designId = type === 'design' ? body.targetId : ((await options.social?.commentDesign(body.targetId).catch(() => null)) ?? null);
    const target = designId ? await repo.get(designId).catch(() => null) : null;
    if (!target || (!target.isPublic && !(reporterId && target.ownerId === reporterId))) return reply.code(404).send({ error: 'not found' });
    if (!firstToday(req, reporterId, `report:${type}:${body.targetId}`)) return { reportId: null, status: 'received' };
    const reportId = await repo.report(type, body.targetId, reporterId, body.reason.trim().slice(0, 500));
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
      // Only real JPEG/PNG/WebP, and never with its metadata: a photo sent
      // straight to the API kept its EXIF GPS position, served to anyone who
      // could see the design. See imageMeta.ts.
      const clean = stripImageMetadata(buf);
      if (!clean) {
        req.socNote = { kind: 'upload_refused' };
        return reply.code(400).send({ error: 'photo must be a JPEG, PNG or WebP image' });
      }
      // Photos are shown to everyone who can see the design, so like a vote
      // they need a verified email, and there is a ceiling per design and per
      // day (see DESIGNS_PER_ACCOUNT above).
      if (badId(id, reply)) return;
      // Someone else's design is a 404 before anything else, as it always was.
      const target = await repo.get(id).catch(() => null);
      if (!target || !ownsDesign(target, userId)) return reply.code(404).send({ error: 'not found or not yours' });
      const uploader = await accountOf(req, userId).catch(() => null);
      const admin = !!(await adminNameOf(userId, req));
      if (!uploader?.emailVerifiedAt && !admin) {
        return reply.code(403).send({ error: 'verify your email to add photos', code: 'verify' });
      }
      // Counted, or refused: an unreadable list is not an empty one (P1.26 review).
      const existing = await repo.listPhotos(id).catch(() => null);
      if (existing === null) return reply.code(503).send({ error: 'something went wrong on our side, please try again', code: 'retry' });
      if (existing.length >= PHOTOS_PER_DESIGN) {
        return reply.code(403).send({ error: 'this design has as many photos as it can hold', code: 'photo_limit', limit: PHOTOS_PER_DESIGN });
      }
      if (!admin && !takeDaily(userId, 'photo', PHOTOS_PER_DAY)) {
        return reply.code(429).send({ error: 'too many photos today, try again tomorrow', code: 'photo_limit' });
      }
      const w = Number(body.width) || 0;
      const h = Number(body.height) || 0;
      const photoId = await repo.addPhoto(id, userId, clean, w, h, typeof body.caption === 'string' ? body.caption.slice(0, 280) : null);
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
      // Only a public design's photo may sit in a shared cache. A private one
      // was sent `public` too, so an edge could keep serving it after the owner
      // hid it (audit round four).
      .header('cache-control', parent.isPublic ? 'public, max-age=86400' : 'private, no-store')
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
    if (!(await requireModerator(req, reply))) return;
    const q = req.query as { status?: string };
    const status = ['open', 'reviewed', 'actioned'].includes(q.status ?? '') ? q.status! : 'open';
    return repo.listReports(status, 100);
  });

  // Dismiss a report (no action needed) → reviewed.
  app.post('/api/admin/reports/:id/dismiss', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const { id } = req.params as { id: string };
    const ok = await repo.setReportStatus(id, 'reviewed');
    if (!ok) return reply.code(404).send({ error: 'report not found' });
    return { status: 'reviewed' };
  });

  // Take a reported design down: make it private + mark its open reports actioned.
  app.post('/api/admin/designs/:id/takedown', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const { id } = req.params as { id: string };
    if (badId(id, reply)) return;
    const ok = await repo.takedownDesign(id);
    if (!ok) return reply.code(404).send({ error: 'design not found' });
    daily?.forget(id);
    publicSetChanged();
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
      // Same layout as the real account email, so a test says something about
      // how those are received rather than about a two-line fragment.
      const subject = `TifoMaker email test · ${stamp}`;
      await options.emailSender.send({
        to,
        subject,
        html: layoutEmail({
          title: subject,
          siteUrl: emailBase(req),
          blocks: [{ lang: 'en', html: para('This is a test from the TifoMaker admin dashboard.') + smallPrint(`Sent ${stamp}.`) }],
        }),
        text: `This is a test from the TifoMaker admin dashboard.\nSent ${stamp}.` + textFooter(emailBase(req)),
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

  // ---------- security operations: /admin#security ----------
  // One read for the whole tab: whether anything is firing, the counts behind
  // it, the admin audit trail, the alerts sent, and the posture checklist.
  // Everything in it is already aggregate or hashed; see soc.ts and socRepo.ts.
  if (options.soc) {
    const soc = options.soc;
    app.get('/api/admin/soc', async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      await soc.flush(); // include the last few seconds, not just what the timer wrote
      const [summary, audit, alerts] = await Promise.all([soc.summary(), soc.auditTrail(60), soc.alerts(30)]);
      return reply.header('cache-control', 'no-store').send({
        generatedAt: new Date().toISOString(),
        rules: soc.status(),
        summary,
        recent: soc.recent(80),
        audit,
        alerts,
        alertsTo: soc.alertTo ? maskEmail(soc.alertTo) : null,
        retentionDays: RETENTION_DAYS,
        keyStable: soc.keyInfo.stable,
        posture: [
          ...securityPosture({
            // The origin lock as it is in force in this app, not only as the environment has it.
            env: { ...process.env, ORIGIN_SECRET: originSecret },
            nodeVersion: process.version,
            uid: typeof process.getuid === 'function' ? process.getuid() : null,
            rateLimit: !!options.rateLimit,
            database: options.database ?? 'memory',
            email: options.emailSender ? emailHealth() : null,
            soc: { alertTo: soc.alertTo, keyStable: soc.keyInfo.stable, lastWriteError: soc.lastWriteError },
            schema: options.schemaStatus?.() ?? null,
            cloudflareSeen: cloudflareSeenAt ? new Date(cloudflareSeenAt).toISOString() : null,
          }),
          await adminNamesClaimed(),
        ],
      });
    });
    // Proves the address and the provider before an attack does. Answers 200
    // either way: a refusal here is a setup problem, not a server error, and
    // counting it as one would trip the error-spike alert it is testing.
    app.post('/api/admin/soc/test-alert', options.rateLimit ? { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } } : {}, async (req, reply) => {
      if (!(await adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
      const result = await soc.sendTestAlert();
      if (!result.ok) req.socActor = null; // nothing was sent, so nothing to audit
      return reply.code(200).send(result);
    });
  }

  // Photo verification queue.
  app.get('/api/admin/photos/unverified', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    return repo.listUnverifiedPhotos(100);
  });

  // Confirm (or un-confirm) a photo as a genuine match.
  app.post('/api/admin/photos/:photoId/verify', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const { photoId } = req.params as { photoId: string };
    const verified = (req.body as { verified?: unknown } | null)?.verified !== false; // default true
    const ok = await repo.setPhotoVerified(photoId, verified);
    if (!ok) return reply.code(404).send({ error: 'photo not found' });
    return { verified };
  });

  // A moderator can remove any photo outright (not just its owner).
  app.delete('/api/admin/photos/:photoId', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const { photoId } = req.params as { photoId: string };
    const ok = await repo.deletePhotoAsModerator(photoId);
    if (!ok) return reply.code(404).send({ error: 'photo not found' });
    return { deleted: true };
  });

  // ---------- review queues, for the /admin dashboard ----------
  // Everything waiting for a decision, in one call, so the dashboard can show
  // the work where the count is instead of sending the operator to an editor
  // panel. Stadium submissions carry a top-down seat plan drawn from their real
  // geometry (stadiumPlan.ts) and the submitter's handle; plans are cached by
  // id, since a submission never changes while it waits.
  const planCache = new Map<string, ReturnType<typeof stadiumPlan>>();
  app.get('/api/admin/queue', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const [reports, photos, pending] = await Promise.all([
      repo.listReports('open', 100),
      repo.listUnverifiedPhotos(100),
      options.stadiums ? options.stadiums.listPending(100) : Promise.resolve([]),
    ]);
    const handles = new Map<string, string | null>();
    for (const p of pending) {
      if (p.submitterId && !handles.has(p.submitterId)) {
        handles.set(p.submitterId, (await auth.getUserById(p.submitterId).catch(() => null))?.username ?? null);
      }
    }
    const stadiums = pending.map((p) => {
      let plan = planCache.get(p.id);
      if (plan === undefined) {
        plan = stadiumPlan(p.template);
        planCache.set(p.id, plan);
        if (planCache.size > 500) planCache.delete(planCache.keys().next().value as string);
      }
      return {
        id: p.id,
        name: p.name,
        country: p.country,
        createdAt: p.createdAt,
        submitter: p.submitterId ? handles.get(p.submitterId) ?? null : null,
        tiers: plan?.tiers ?? (Array.isArray(p.template?.tiers) ? p.template.tiers.length : 0),
        seats: plan?.seats ?? null,
        planSvg: plan?.svg ?? null,
      };
    });
    return { reports, photos, stadiums, stadiumsEnabled: !!options.stadiums };
  });

  // The images a reviewer has to see. The public routes rightly hide a photo on
  // a private design and a taken-down design's thumbnail — which are exactly
  // the ones a moderator may need to look at. Header-gated like the queue, so
  // the dashboard fetches them with the token rather than an <img> URL.
  app.get('/api/admin/photos/:photoId/image', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const { photoId } = req.params as { photoId: string };
    const photo = await repo.getPhoto(photoId).catch(() => null);
    if (!photo) return reply.code(404).send({ error: 'not found' });
    const b = photo.image;
    const type =
      b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' :
      b[0] === 0x89 && b[1] === 0x50 ? 'image/png' :
      b[0] === 0x52 && b[1] === 0x49 ? 'image/webp' : 'application/octet-stream';
    return reply
      .header('content-type', type)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(b);
  });
  app.get('/api/admin/designs/:id/thumbnail.png', async (req, reply) => {
    if (!(await requireModerator(req, reply))) return;
    const { id } = req.params as { id: string };
    const png = await repo.getThumbnail(id).catch(() => null);
    if (!png) return reply.code(404).send({ error: 'no thumbnail' });
    return reply.header('content-type', 'image/png').header('cache-control', 'private, no-store').send(png);
  });

  // Like / dislike / clear. value: 1, -1, or 0.
  app.post('/api/designs/:id/vote', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const raw = (req.body as { value?: unknown } | null)?.value;
    const value = raw === 1 || raw === -1 || raw === 0 ? raw : null;
    if (value === null) return reply.code(400).send({ error: 'value must be 1, -1, or 0' });
    // Likes decide the ranking and the home page's Tifo of the day, so a vote
    // needs an account with a verified email. Five throwaway sign-ups with
    // made-up addresses used to be enough to put any design on the home page
    // (audit round four). Taking a vote back is always allowed.
    if (value !== 0) {
      const voter = await accountOf(req, userId).catch(() => null);
      if (!voter?.emailVerifiedAt) return reply.code(403).send({ error: 'verify your email to vote', code: 'verify_first' });
    }
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
    // Their public designs, asked for as such: owner AND public, in SQL, at
    // most `limit` (1-200, default 200). It used to fetch every public design
    // on the site and filter in JavaScript, 414 KB for the library's owner on
    // every share page (performance plan P1.12). Never listByOwner: that is
    // the owner's own list, private designs included.
    const limit = Math.min(200, Math.max(1, Number(oneParam((req.query as Record<string, unknown>).limit)) || 200));
    const [created, liked, socialProfile] = await Promise.all([
      repo.listPublicByOwner(id, { viewerId, limit }),
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
      origin?: unknown;
    };
    const count = seatCount(body.templateId ?? '', body.templateVersion ?? -1);
    if (typeof body.title === 'string' && body.title.length > MAX_TITLE) {
      return reply.code(400).send({ error: `title must be 1..${MAX_TITLE} chars` });
    }
    if (!body.title || count === null || !validPalette(body.palette) || !body.cellsGzB64) {
      return reply.code(400).send({ error: 'title, known templateRef, palette (2-256 hex), cellsGzB64 required' });
    }
    let cellsGz: Buffer = Buffer.from(body.cellsGzB64, 'base64');
    let cells: Buffer;
    try {
      cells = gunzipBytes(cellsGz);
    } catch {
      return reply.code(400).send({ error: 'cellsGzB64 is not valid gzip' });
    }
    if (cells.byteLength !== count) {
      return reply.code(400).send({ error: `cells must have ${count} bytes for this template` });
    }
    if (clearLocked(body.templateId!, body.templateVersion!, cells)) cellsGz = gzipBytes(cells);
    const thumb = decodeThumb(body.thumbnailPngB64, reply);
    if (thumb === undefined) return;
    if (!(await roomForDesign(req, userId, reply))) return;
    return reply.code(201).send(
      await repo.create({
        title: body.title,
        templateId: body.templateId!,
        templateVersion: body.templateVersion!,
        palette: body.palette,
        cellsGz,
        ownerId: userId,
        thumbnailPng: thumb,
        // A closed set: this is a badge on the owner's own card, not free text.
        origin: body.origin === 'ai' ? 'ai' : null,
      }),
    );
  });

  // ---------- projects ----------
  //
  // Every design someone owns is one of their projects. The page lists them
  // all, trashed ones included (the client shows those under Trash), with
  // nothing capped: listByOwner is the profile query and stops at 200.
  app.get('/api/projects', async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    reply.header('cache-control', 'no-store');
    return { projects: await repo.listProjects(userId), trashDays: TRASH_DAYS };
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

  /**
   * The choose-a-username wall for routes that load a design themselves rather
   * than through `requireUser`. Fork, publish, scene writes, revisions and the
   * rest all went through here and skipped it, so an account still wearing the
   * handle we derived from its email could publish under it (audit round four).
   * Reads stay open; anything that changes something is held at the door.
   */
  const unnamedWall = async (req: FastifyRequest, reply: FastifyReply, userId: string | null): Promise<boolean> => {
    if (!userId || req.method === 'GET' || req.method === 'HEAD') return false;
    const chosen = await usernameChosen(req, userId, reply);
    if (chosen === null) return true; // refused with a 503: the check could not be made
    if (chosen) return false;
    await reply.code(428).send({ error: 'choose a username first', code: 'needs_username' });
    return true;
  };

  /**
   * Is this person the design's owner? Never for a design with no owner.
   *
   * The checks used to read `rec.ownerId !== userId`, and for a row with no
   * owner (owner_id is nullable: designs saved before accounts existed) and a
   * visitor with no session that is `null !== null`, false: the anonymous
   * visitor WAS the owner. A private ownerless design answered 200 to
   * strangers who were not signed in, layers and all, while signed-in ones got
   * 404 (audit round five).
   */
  const ownsDesign = (rec: { ownerId: string | null }, userId: string | null): boolean => !!userId && rec.ownerId === userId;

  /**
   * The visibility rule every design route applies: public, or the caller
   * owns it; anything else is the same 404 a missing id gets (existence is
   * not leaked). getVisible loads the whole design; a route that needs only
   * a few columns (the thumbnail's ETag, P2.4; the anonymous scene's hash,
   * P2.5) passes the row it loaded, and the rule is this same code.
   */
  const visibleFor = async <R extends { isPublic: boolean; ownerId: string | null }>(
    req: FastifyRequest,
    reply: FastifyReply,
    rec: R | null,
  ): Promise<{ rec: R; userId: string | null } | null> => {
    const userId = await userOrRetry(req, reply);
    if (userId === undefined) return null;
    if (!rec || (!rec.isPublic && !ownsDesign(rec, userId))) {
      await reply.code(404).send({ error: 'not found' });
      return null;
    }
    if (await unnamedWall(req, reply, userId)) return null;
    return { rec, userId };
  };
  const getVisible = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    return visibleFor(req, reply, await repo.get(id).catch(() => null));
  };

  /** Load + ownership check for mutations. Sends 404/401/403 itself. */
  const getOwned = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await repo.get(id).catch(() => null);
    const userId = await userOrRetry(req, reply);
    if (userId === undefined) return null;
    if (!rec || (!rec.isPublic && !ownsDesign(rec, userId))) {
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
    if (await unnamedWall(req, reply, userId)) return null;
    return rec;
  };

  app.get('/api/designs/:id', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    const { cellsGz, ...all } = v.rec;
    // Whether it is pinned, in the Trash, taken down or began as an AI design
    // is the owner's business: those fields describe their Projects page, and
    // they were in every anonymous answer (audit round five).
    const { pinned: _p, deletedAt: _d, takenDown: _t, origin: _o, ...shared } = all;
    // Whether the caller owns it, from the same check that chose the fields,
    // after getVisible: the page no longer has to ask /api/me and compare ids
    // (performance plan P1.8). True only for the bearer token's own account;
    // anonymous callers, other accounts and ownerless designs get false.
    const isOwner = ownsDesign(v.rec, v.userId);
    const meta = isOwner ? all : shared;
    // Creator name is needed by the public share page; resolve it from the owner id.
    const owner = meta.ownerId ? await accountOf(req, meta.ownerId).catch(() => null) : null;
    // Per caller, so the /api default (no-store, the onSend hook above) is
    // what keeps it out of every cache; the security suite pins it.
    return { ...meta, isOwner, ownerName: owner?.username ?? null, cellsGzB64: cellsGz.toString('base64') };
  });

  /**
   * The scene a design carries: its banners.
   *
   * Two routes of its own rather than fields on the design, because a scene is
   * optional, is written by a different part of the editor, and must never be
   * able to fail a save of the tifo itself. A design with no scene answers
   * `null` rather than 404 — "this one has no banners" is a normal state, not
   * an error, and a share link should not have to tell the two apart.
   */
  app.get('/api/designs/:id/scene', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Who may see it, and the stored scene's hash: not the scene (P2.5).
    const v = await visibleFor(req, reply, await repo.getSceneMeta(id).catch(() => null));
    if (!v) return;
    if (!v.rec.hasScene) return { sceneGzB64: null };
    // The layer stack (the owner's own pictures, as uploaded) is the owner's,
    // and the owner gets the scene exactly as stored.
    if (ownsDesign(v.rec, v.userId)) {
      const gz = await repo.getScene(id);
      return { sceneGzB64: gz ? gz.toString('base64') : null };
    }
    // Everyone else sees the design as its seats: the banners come with it,
    // the layers do not. A scene that cannot be stripped is shown to nobody
    // but its owner; a strip that could not be done now (the worker busy,
    // slow or gone) is a 503, and never the scene as stored.
    let out: Uint8Array | null;
    try {
      out = await strippedScene(id, v.rec.hash);
    } catch {
      return busy(reply);
    }
    return { sceneGzB64: out ? Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64') : null };
  });

  /**
   * A design's scene without its layers, for anyone but its owner (P2.5):
   * from the stripped copies kept by the hash stored with the scene
   * (sceneCache.ts), and only when none is kept, read (bytes and hash
   * together) and stripped in the scene worker (P2.14). Throws when the
   * worker cannot do it; nothing is kept then.
   */
  const sceneCache = options.sceneCache ?? new StrippedSceneCache();
  const strippedScene = async (designId: string, knownHash: string | null): Promise<Uint8Array | null> => {
    const trusted = hashesTrusted();
    if (knownHash && trusted) {
      const kept = sceneCache.get(designId, knownHash);
      if (kept !== undefined) return kept;
    }
    const row = await repo.getSceneRow(designId);
    if (!row) return null;
    // The stored hash when it can be believed; otherwise (and for a scene
    // stored before hashes were) the hash of the bytes just read.
    const hash = trusted && row.hash ? row.hash : contentHash(row.gz);
    if (!row.hash) void repo.backfillHashes(designId).catch(() => {});
    const kept = sceneCache.get(designId, hash);
    if (kept !== undefined) return kept;
    // An exact-size copy, handed over rather than cloned: a Buffer can be a
    // view into a larger shared slab, and cloning a view sends the whole slab,
    // other requests' bytes included (stage 2 review).
    const input = new Uint8Array(row.gz);
    // A view may wait only in the first SCENE_VIEW_ROOM places, so a flood
    // of views never leaves an owner's save without room (workerPool.ts).
    const out = (await scenePool.run({ kind: 'strip', gz: input }, [input.buffer], { room: SCENE_VIEW_ROOM })) as Uint8Array | null;
    sceneCache.set(designId, hash, out);
    return out;
  };

  // A scene is saved when someone presses Save or moves a project into their
  // account, not continuously, so 30 a minute is far above any real pace. The
  // limit is there because each save is decompressed (up to 16 MB) and parsed:
  // a crafted 21 KB body cost 0.6 s, so the global 300 a minute let one free
  // account hold the server for three minutes in every minute (audit round
  // six). The work is in the scene worker now (P2.14), and the limit stays:
  // it is what keeps that worker's queue for everyone.
  const sceneLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  app.put('/api/designs/:id/scene', sceneLimit, async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const body = (req.body ?? {}) as { sceneGzB64?: unknown };
    if (typeof body.sceneGzB64 !== 'string' || body.sceneGzB64.length === 0) {
      return reply.code(400).send({ error: 'sceneGzB64 required' });
    }
    const gz = Buffer.from(body.sceneGzB64, 'base64');
    if (gz.byteLength > SCENE_MAX_BYTES) {
      return reply.code(413).send({ error: `scene must be under ${Math.round(SCENE_MAX_BYTES / 1024)} KB gzipped` });
    }
    // Inflated (16 MB at most), its structure bounded before it is parsed,
    // and parsed, in the scene worker (sceneCheck.checkScene), not on the
    // event loop every other request waits on.
    let verdict: SceneVerdict;
    try {
      // An exact-size copy, handed over; and ahead of any waiting view.
      const input = new Uint8Array(gz);
      verdict = (await scenePool.run({ kind: 'check', gz: input }, [input.buffer], { urgent: true })) as SceneVerdict;
    } catch {
      return busy(reply);
    }
    if (verdict === 'gzip') return reply.code(400).send({ error: 'sceneGzB64 is not valid gzip' });
    if (verdict === 'complex') return reply.code(413).send({ error: 'scene is too complex to save', code: 'scene_complex' });
    if (verdict !== 'ok') return reply.code(400).send({ error: 'scene is not valid JSON' });
    const ok = await repo.putScene(rec.id, gz);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true, bytes: gz.byteLength };
  });

  /**
   * A design's picture, revalidated by its content hash (performance plan P2.4).
   *
   * Every view of /community downloaded every picture again: `no-cache` and
   * nothing to revalidate against. A public design's picture now carries an
   * ETag, the sha-256 of the stored bytes (written in the same statement as
   * them), and a repeat view is one read of visibility and hash, then a 304
   * with no body.
   *
   * The order is the guardrail: who may see it is decided first, by the same
   * rule as every design route (visibleFor), and only then is If-None-Match
   * compared. A 304 before that would tell anyone holding an old ETag that a
   * private or taken-down design still exists; instead they get the same 404
   * as for an id that never existed. Only a public design's answer has an
   * ETag and says `public`: it is the same bytes and headers for everyone.
   * A private design's picture is for its owner only: `private, no-store`,
   * no ETag, never a 304, not kept by any cache, the browser's included
   * (audit round six).
   */
  const PUBLIC_THUMB = 'public, no-cache';
  const etagOf = (hash: string): string => `"${hash}"`;
  /** Does If-None-Match name this ETag? (Weak comparison, as RFC 9110 has it for this header.) */
  const ifNoneMatch = (req: FastifyRequest, etag: string): boolean => {
    const h = req.headers['if-none-match'];
    return typeof h === 'string' && h.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
  };
  app.get('/api/designs/:id/thumbnail.png', async (req, reply) => {
    const { id } = req.params as { id: string };
    const trusted = hashesTrusted();
    if (trusted && typeof req.headers['if-none-match'] === 'string') {
      // Asked conditionally: visibility and the hash, not the picture.
      const v = await visibleFor(req, reply, await repo.getThumbnailMeta(id).catch(() => null));
      if (!v) return;
      if (v.rec.isPublic && v.rec.hash && ifNoneMatch(req, etagOf(v.rec.hash))) {
        // The same headers as the 200 it stands for.
        return reply.code(304).header('cache-control', PUBLIC_THUMB).header('etag', etagOf(v.rec.hash)).send();
      }
    }
    // The picture, read together with who may see it, and the rule applied
    // to that read: a design made private a moment ago is refused here too.
    const v = await visibleFor(req, reply, await repo.getThumbnailRow(id).catch(() => null));
    if (!v) return;
    const png = v.rec.png;
    if (!png) return reply.code(404).send({ error: 'no thumbnail' });
    if (!v.rec.isPublic) {
      return reply.header('content-type', 'image/png').header('cache-control', 'private, no-store').send(png);
    }
    // The stored hash when it can be believed; otherwise (and for a picture
    // stored before hashes were) the hash of the bytes just read.
    const hash = trusted && v.rec.hash ? v.rec.hash : contentHash(png);
    if (!v.rec.hash) void repo.backfillHashes(id).catch(() => {});
    reply.header('cache-control', PUBLIC_THUMB).header('etag', etagOf(hash));
    if (ifNoneMatch(req, etagOf(hash))) return reply.code(304).send();
    return reply.header('content-type', 'image/png').send(png);
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
    // Only a public design's card is public. A private design's owner can fetch
    // its card too (getVisible lets them), and that answer was also marked
    // `public, max-age=3600`: any shared cache in front of the site would have
    // kept a private design's picture for an hour and served it on (audit
    // round six; photos follow the same rule since round four). A card cached
    // while its design WAS public can still be served by such a cache for up to
    // the hour after it is made private or taken down; a CDN in front needs a
    // purge on takedown for that (see CLOUDFLARE.md).
    return reply
      .header('content-type', 'image/png')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', v.rec.isPublic ? 'public, max-age=3600' : 'private, no-store')
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
    if (!isPng(buf)) return reply.code(400).send({ error: 'ogPngB64 must be a PNG' });
    const ok = await repo.setOgImage(rec.id, rec.ownerId!, buf);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // Count a public view. Private designs are a 404 to non-owners via getVisible,
  // and we refuse to count views on a private design even for the owner.
  app.post('/api/designs/:id/view', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    if (!v.rec.isPublic) return reply.code(403).send({ error: 'not public' });
    if (!firstToday(req, v.userId, `view:${v.rec.id}`)) return { views: v.rec.viewCount ?? 0 };
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
    if (firstToday(req, v.userId, `share:${kind}:${platform}:${v.rec.id}`)) {
      await repo.recordShare(v.rec.id, platform, kind).catch(() => {});
    }
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
    const tpl = shippedTemplates().find((t) => t.id === body.templateId && t.version === (body.templateVersion ?? t.version));
    if (!tpl || !templates.some((t) => t.id === tpl.id && t.version === tpl.version)) {
      return reply.code(400).send({ error: 'unknown templateId/version' });
    }
    if (!validPalette(body.palette) || !body.cellsGzB64) {
      return reply.code(400).send({ error: 'palette and cellsGzB64 required' });
    }
    let cells: Buffer;
    try {
      cells = gunzipBytes(Buffer.from(body.cellsGzB64, 'base64'));
    } catch {
      return reply.code(400).send({ error: 'cells not gzip' });
    }
    // Checked against the seat table here (the same counts as the generator,
    // test:deploy), so no seat map is built on the event loop; the worker
    // builds its own and checks again.
    const count = seatCount(tpl.id, tpl.version);
    if (count === null || cells.length !== count) {
      return reply.code(400).send({ error: `cells must have ${count ?? 0} bytes for this template` });
    }
    clearLocked(tpl.id, tpl.version, cells); // no cards are printed for a royal box
    // Rendered in the PDF worker (P2.14): seconds of pdfkit layout on a big
    // ground no longer hold every other request. A full queue, a timeout or
    // a crash is a 503; the limit of 6 a minute and every cap below stay.
    // The temporary file pdfkit writes is named here and removed here too,
    // whatever happened: a worker stopped for running too long or crashing
    // never reaches its own `finally`.
    const outPath = join(tmpdir(), `tifo-${randomBytes(12).toString('hex')}.pdf`);
    let pdf: Uint8Array;
    const cellsCopy = new Uint8Array(cells); // exact size, handed over (see strippedScene)
    try {
      pdf = await pdfPool.run({
        outPath,
        templateId: tpl.id,
        templateVersion: tpl.version,
        cells: cellsCopy,
        palette: body.palette as string[],
        meta: {
          // Capped like every other title. It was the one uncapped string on this
          // anonymous route: pdfkit flows a long title across pages synchronously,
          // and a 60 KB title held the only event loop for 6 seconds.
          designTitle: cleanTitle(body.title, 'Tifo'),
          stadiumName: tpl.name,
          cardsPerBag: Number.isFinite(Number(body.cardsPerBag)) ? Math.min(10_000, Math.max(1, Math.round(Number(body.cardsPerBag)))) : 100,
          // pdfkit flows this text and auto-adds pages, so an oversized name is
          // quadratic synchronous CPU. Measured 8s from one 20KB entry; longer
          // ones run for minutes.
          colorNames: Array.isArray(body.colorNames)
            ? body.colorNames.slice(0, 256).map((n) => (typeof n === 'string' ? n.slice(0, 40) : ''))
            : undefined,
          watermark: !userId, // anonymous/free → watermark; signed-in → clean
        },
      }, [cellsCopy.buffer]);
    } catch {
      // Once now, and once more when a write the stopped thread had already
      // handed to the file system has landed.
      setTimeout(() => void unlink(outPath).catch(() => {}), 2_000).unref();
      return busy(reply);
    } finally {
      await unlink(outPath).catch(() => {});
    }
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${(body.title || 'tifo').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-distribution.pdf"`)
      .send(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
  });

  app.put('/api/designs/:id', async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const body = req.body as { palette?: unknown; cellsGzB64?: string; thumbnailPngB64?: string };
    if (!validPalette(body.palette) || !body.cellsGzB64) {
      return reply.code(400).send({ error: 'palette and cellsGzB64 required' });
    }
    const count = seatCount(rec.templateId, rec.templateVersion)!;
    let cellsGz: Buffer = Buffer.from(body.cellsGzB64, 'base64');
    let cells: Buffer;
    try {
      cells = gunzipBytes(cellsGz);
    } catch {
      return reply.code(400).send({ error: 'cellsGzB64 is not valid gzip' });
    }
    if (cells.byteLength !== count) {
      return reply.code(400).send({ error: `cells must have ${count} bytes for this template` });
    }
    if (clearLocked(rec.templateId, rec.templateVersion, cells)) cellsGz = gzipBytes(cells);
    const thumb = decodeThumb(body.thumbnailPngB64, reply);
    if (thumb === undefined) return;
    const saved = await repo.updateCells(rec.id, cellsGz, body.palette, thumb);
    // A public design's palette is its colour facets.
    if (rec.isPublic) publicSetChanged();
    return saved;
  });

  app.patch('/api/designs/:id', async (req, reply) => {
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const body = (req.body ?? {}) as { title?: unknown; isPublic?: unknown; pinned?: unknown };
    // Pinning is the owner's own ordering, not an edit to the design, so it
    // takes a path of its own that leaves "last edited" alone.
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') return reply.code(400).send({ error: 'pinned must be boolean' });
      if (body.title === undefined && body.isPublic === undefined) return repo.setPinned(rec.id, body.pinned);
      await repo.setPinned(rec.id, body.pinned);
    }
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
    // A moderator's takedown is final for its owner (the repositories refuse
    // too; this is the answer the person reads).
    if (patch.isPublic === true && rec.takenDown) {
      return reply.code(403).send({ error: 'this design was taken down by a moderator', code: 'taken_down' });
    }
    // Something in the Trash is on its way out. Publishing it would put a
    // design in the community feed that deletes itself within the month.
    if (patch.isPublic === true && rec.deletedAt) {
      return reply.code(409).send({ error: 'restore this project from the trash before publishing it' });
    }
    const wasPublic = rec.isPublic;
    const result = await repo.patchMeta(rec.id, patch);
    if (patch.isPublic === false) daily?.forget(rec.id);
    // Published, unpublished or renamed (a title names the club facet).
    publicSetChanged();
    // Newly published → notify the owner's followers (best-effort, non-blocking).
    if (options.social && patch.isPublic === true && !wasPublic && rec.ownerId) {
      options.social.notifyFollowersOfPost(rec.ownerId, rec.id).catch(() => {});
    }
    return result;
  });

  /**
   * Delete a project: into the Trash first, for good from there.
   *
   * Two steps because a delete is the one action on this page that cannot be
   * taken back by the person who did it, and a mis-click on a menu is common.
   * `?permanent=1` only works on something already in the Trash.
   */
  app.delete('/api/designs/:id', async (req, reply) => {
    if (badId((req.params as { id: string }).id, reply)) return;
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const permanent = (req.query as { permanent?: string }).permanent === '1';
    daily?.forget(rec.id);
    if (permanent) {
      if (!rec.deletedAt) return reply.code(409).send({ error: 'move it to the trash first' });
      await repo.purge(rec.id);
      publicSetChanged();
      return reply.code(204).send();
    }
    const trashed = await repo.trash(rec.id);
    publicSetChanged();
    return trashed;
  });

  app.post('/api/designs/:id/restore', async (req, reply) => {
    if (badId((req.params as { id: string }).id, reply)) return;
    const rec = await getOwned(req, reply);
    if (!rec) return;
    const restored = await repo.restore(rec.id);
    publicSetChanged();
    return restored;
  });

  app.post('/api/designs/:id/revisions', writeLimit, async (req, reply) => {
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
    // A change can touch each seat once at most; longer diffs only add bytes.
    if (indices.length > count) return reply.code(400).send({ error: 'diff is larger than the stadium' });
    const cells = new Uint8Array(gunzipBytes(rec.cellsGz));
    for (let k = 0; k < indices.length; k++) {
      if (indices[k] >= count) return reply.code(400).send({ error: `index ${indices[k]} out of range` });
    }
    for (let k = 0; k < indices.length; k++) cells[indices[k]] = after[k];
    if (clearLocked(rec.templateId, rec.templateVersion, cells)) {
      // Keep the revision honest too: it records what the seats now hold.
      for (let k = 0; k < indices.length; k++) after[k] = cells[indices[k]];
    }

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
    const own = ownsDesign(v.rec, v.userId);
    // Someone else's design: the creator's "no remixes" holds here too. Fork
    // used to copy it anyway, banners included and without the credit a remix
    // carries (audit round four).
    if (!own && v.rec.allowRemix === false) return reply.code(403).send({ error: 'this design cannot be remixed' });
    const title = cleanTitle((req.body as { title?: string } | null)?.title, `${v.rec.title} (fork)`);
    if (!(await roomForDesign(req, v.userId, reply))) return;
    const created = await repo.fork(v.rec.id, title, v.userId);
    if (!created) refundDesign(req, v.userId);
    if (created) await copyScene(v.rec.id, created.id, own);
    // A copy of a design a moderator took down is taken down with it, or
    // publishing the copy would undo the takedown.
    //
    // The repository copies the takedown in the same write that makes the
    // copy. It used to be a second call whose failure was swallowed, leaving a
    // copy its owner could publish while the reply said `takenDown: true`
    // (audit round six). Should a copy ever come back without it, it is
    // deleted and the fork refused rather than handed over.
    if (created && v.rec.takenDown) {
      if (!created.takenDown) {
        // Taken down first, so a copy that cannot be deleted is at least down.
        await repo.takedownDesign(created.id).catch(() => false);
        await repo.purge(created.id).catch(() => false);
        refundDesign(req, v.userId);
        return reply.code(503).send({ error: 'could not copy this design, please try again', code: 'retry' });
      }
      return reply.code(201).send({ ...created, isPublic: false, takenDown: true });
    }
    return reply.code(201).send(created);
  });

  /**
   * A copy of a design takes its banners with it.
   *
   * Fork and remix copied the seats and nothing else, so remixing a tifo for
   * its banner — the reason anyone remixes a design with one — opened a copy
   * with no banner on it. Best-effort, like every scene write: a copy whose
   * banners failed to come across is still the copy that was asked for.
   */
  async function copyScene(fromId: string, toId: string, keepLayers: boolean): Promise<void> {
    try {
      // A copy for someone else is the design as its seats: its banners, not
      // its owner's layers (and pictures). The owner's own copy keeps them.
      // A strip that cannot be done copies nothing, never the scene as stored.
      const copy = keepLayers ? await repo.getScene(fromId) : await strippedScene(fromId, null);
      if (copy) await repo.putScene(toId, Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength));
    } catch {
      /* the seats are copied; that is the part that must not fail */
    }
  }

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
    if (!(await roomForDesign(req, userId, reply))) return;
    const created = await social!.remix(id, userId, remixTitle);
    if (!created) {
      refundDesign(req, userId);
      return reply.code(403).send({ error: 'this design cannot be remixed' });
    }
    // A remix is the design as its seats: whoever remixes gets them flat.
    await copyScene(id, created.id, false);
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
  // How many are unread, and nothing else (performance plan P2.16). The bell
  // asks every 60 seconds, and it used to fetch the whole feed to read one
  // number: 50 rows joined to their actors and designs, about 15 KB, each
  // time. The feed is fetched when the bell is opened. Same gate as the feed
  // (signed in, the username wall, the caller's own count only), the same
  // limits, and never kept by any cache.
  app.get('/api/notifications/unread', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const unread = await social!.unreadCount(userId);
    return reply.header('cache-control', 'no-store').send({ unread });
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
  // The For Clubs form. Same pace as feedback (five in ten minutes from one
  // address) and every field capped: it had neither, and one address could
  // file hundreds of 4 KB leads a minute (audit round four).
  app.post('/api/leads', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!options.leads) return reply.code(503).send({ error: 'lead capture not enabled' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const name = field(body.name, 120) ?? '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!name || !email || email.length > MAX_EMAIL || !EMAIL.test(email)) {
      return reply.code(400).send({ error: 'a name and a valid email are required' });
    }
    const lead = await options.leads.createLead({
      name,
      email,
      organization: field(body.organization, 120),
      orgType: field(body.orgType, 40),
      message: field(body.message, 2000),
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
     * Each page in English and, where the build made one, in Arabic under /ar/
     * (performance plan P3.3; pageLang.ts). Every page below is registered
     * once per language by the same code, so the Arabic page runs exactly the
     * English page's checks, sends exactly its headers and is cached, or not,
     * exactly as it is: nothing about it is decided anywhere else. A page
     * whose Arabic file this build lacks simply has no /ar/ address (a 404
     * like any unknown path).
     */
    checkPageText();
    /** The English paths (or path prefixes, '/t/') whose Arabic twin this build serves; the sitemap lists those. */
    const servedInArabic = new Set<string>();
    const pagesOf = (file: string, english: string, enPath?: string): [PageLang, string][] => {
      let arabic: string | null = null;
      try {
        arabic = readFileSync(join(staticDir, pageFile(file, 'ar')), 'utf8');
      } catch {
        arabic = null;
      }
      if (arabic !== null && enPath) servedInArabic.add(enPath);
      return arabic === null ? [['en', english]] : [['en', english], ['ar', arabic]];
    };
    /**
     * Absolute base for anything we put IN the page - og:url, og:image, canonical.
     * Same rule as email links: PUBLIC_URL wins, otherwise the Host has to be one
     * we know before it is echoed back, because a forged Host would otherwise
     * write an attacker's domain into the canonical URL of our own card.
     */
    const origin = (req: FastifyRequest): string => {
      if (options.publicUrl) return options.publicUrl.replace(/\/+$/, '');
      const known = knownHost(req);
      if (!known) return CANONICAL_ORIGIN;
      const { bare, host } = known;
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

    /**
     * `path` is the page's own address in its language, `enPath` its English
     * page's (performance plan P3.3): with it, the page names both versions to
     * search engines (hreflang en, ar and x-default, and og:locale:alternate),
     * and its canonical is itself, so each language is indexed as its own page.
     */
    type Card = { title: string; description: string; path: string; image?: string; alt?: string; lang?: PageLang; enPath?: string };
    const cardTags = (req: FastifyRequest, o: Card): string => {
      const base = origin(req);
      const lang = o.lang ?? 'en';
      const url = `${base}${o.path}`;
      const img = o.image ?? `${base}${CARD_PATH}`;
      const alt = o.alt ?? pageText('meta.card.alt', lang);
      const twins = o.enPath !== undefined;
      return [
        `<title>${esc(o.title)}</title>`,
        `<link rel="canonical" href="${esc(url)}" />`,
        ...(twins ? alternateLinks(base, o.enPath!, esc) : []),
        `<meta name="description" content="${esc(o.description)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="${esc(pageText('meta.site', lang))}" />`,
        `<meta property="og:locale" content="${ogLocale(lang)}" />`,
        ...(twins ? [`<meta property="og:locale:alternate" content="${ogLocale(lang === 'ar' ? 'en' : 'ar')}" />`] : []),
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
    const withCard = (html: string, req: FastifyRequest, o: Card): string => {
      // The page's own description too: the card carries the one for this
      // address, and two descriptions are as ambiguous as two titles (the
      // landing, /clubs and /community each sent their file's own as well).
      const stripped = html
        .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
        .replace(/<meta[^>]+(?:property|name)=["'](?:og:|twitter:)[^"']*["'][^>]*>\s*/gi, '')
        .replace(/<meta[^>]+name=["']description["'][^>]*>\s*/gi, '')
        .replace(/<link[^>]+rel=["'](?:canonical|alternate)["'][^>]*>\s*/gi, '');
      return injectOnce(stripped, /<head>/i, (m) => `${m}\n    ${cardTags(req, o)}`);
    };
    /**
     * For the pages served as built, with no card (performance plan P3.3): the
     * links naming both versions, and a canonical for a page meant to be found.
     * Not on the noindex pages (/reset, /account, /projects), where a canonical
     * contradicts the noindex; their hreflang links are harmless and kept.
     */
    const withTwins = (html: string, req: FastifyRequest, enPath: string, lang: PageLang, canonical: boolean): string => {
      const base = origin(req);
      const links = [
        ...(canonical ? [`<link rel="canonical" href="${esc(base)}${esc(pathIn(enPath, lang))}" />`] : []),
        ...alternateLinks(base, enPath, esc),
      ];
      return injectOnce(html, /<head>/i, (m) => `${m}\n    ${links.join('\n    ')}`);
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
    // The insert is built by a function from the match, so no `$` in it is ever
    // special. The old version ran `replacement.replace(/\$&/g, m)` over the
    // whole block, titles included: a design called "Ultras $& Co" put a copy of
    // the matched tag into every page that listed it (a duplicate
    // #grid-loading on /community that left the loader stuck, <head> inside
    // share titles), and a title of repeated $& added 4 KB per card.
    const injectOnce = (haystack: string, pattern: RegExp, insert: (match: string) => string): string =>
      haystack.replace(pattern, (m) => insert(m));

    // The one escaper (src/core/escape.ts): quotes included, single as well.
    const esc = (s: string): string => escapeHtml(s);

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
    // In the page's language (performance plan P3.3): the same facts, each
    // phrase from the string table, the ground under its Arabic name on an
    // Arabic page. The English is word for word what it always was.
    const describeDesign = (
      rec: { title: string; templateId: string; description?: string | null; remixedFrom?: string | null },
      ownerName: string | null,
      lang: PageLang = 'en',
    ): string => {
      const own = (rec.description ?? '').trim().replace(/\s+/g, ' ');
      if (own.length >= 40) return own.slice(0, 300);

      const tpl = templates.find((t) => t.id === rec.templateId);
      const where = tpl ? groundName(tpl.id, tpl.name, lang) : pageText('meta.describe.somewhere', lang);
      const name = (rec.title ?? '').trim();

      const parts: string[] = [];
      parts.push(name && !/^untitled/i.test(name) ? pageText('meta.describe.named', lang, { title: name }) : pageText('meta.describe.unnamed', lang));
      parts.push(pageText('meta.describe.on', lang, { ground: where }));
      if (tpl?.seatCount) parts.push(pageText('meta.describe.seats', lang, { seats: formatCount(tpl.seatCount, lang) }));
      if (ownerName) parts.push(pageText('meta.describe.by', lang, { owner: ownerName }));
      let line = `${parts.join(' ')}.`;
      if (rec.remixedFrom) line += ` ${pageText('meta.describe.remixed', lang)}`;
      // Short one, so give the searcher the next useful fact.
      if (own) line += ` ${own}`;
      else line += ` ${pageText('meta.describe.open', lang)}`;
      return line.slice(0, 300);
    };

    /**
     * Pages whose HTML depends on nothing but the site's own address,
     * rendered once and revalidated by an ETag (performance plan P2.9).
     *
     * /app, /clubs, /legal and /tifo-spec are a static file with the link
     * card put in: three regular expressions over up to 66 KB of HTML on
     * every request, for the same answer every time. Each is now built on its
     * first request, kept, and served with an ETag (a hash of the bytes) and
     * `no-cache`, so the browser still asks every time and gets a 304 when
     * nothing changed (a new deploy is a new process, so new HTML is new
     * bytes and a new ETag).
     *
     * What may vary the page is the address it names (origin(), above), and
     * nothing else: never the caller, a token, a cookie or the language, which
     * is why the bytes can be kept. With PUBLIC_URL set (the setting for
     * production) that is one fixed value, so a page is kept once and a
     * forged Host can never reach it. Without it the address comes from the
     * Host header (allow-listed by knownHost; a dev host may carry any port),
     * so each page keeps at most SHELL_MAX of them and renders any further
     * one fresh, uncached, every time: nothing a caller sends can grow it.
     *
     * Never a page that lists or names designs (/, /community, /t, /d): those
     * read the database on every request, so a takedown or an unpublish is
     * seen by the next visitor.
     */
    const SHELL_MAX = 8;
    const shellStats = { rendered: 0, cached: 0 };
    const htmlShell = (path: string, html: string, card: Omit<Card, 'path'>) => {
      const kept = new Map<string, { body: string; etag: string }>();
      return (req: FastifyRequest, reply: FastifyReply): FastifyReply => {
        const at = options.publicUrl ? '' : origin(req);
        let page = kept.get(at);
        if (!page) {
          const body = withCard(html, req, { ...card, path });
          shellStats.rendered++;
          page = { body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` };
          if (kept.size < SHELL_MAX) {
            kept.set(at, page);
            shellStats.cached++;
          }
        }
        reply.header('cache-control', 'no-cache').header('etag', page.etag).type('text/html; charset=utf-8');
        if (ifNoneMatch(req, page.etag)) return reply.code(304).send();
        return reply.send(page.body);
      };
    };
    app.decorate('htmlShellStats', () => ({ ...shellStats }));

    // Share links: /d/:id. Inject Open Graph + Twitter Card tags so a pasted
    // link shows a rich preview (title, author, the stadium thumbnail) in
    // WhatsApp, Twitter/X, Discord, Slack, etc., before any JS runs. Humans
    // get the same HTML and the SPA boots and loads the design normally.
    /**
     * A design's title in a page's language: the starter library ships an
     * Arabic name; anything a person saved is their own words, in the language
     * they wrote it in, and is never translated (ui/i18n.ts tTitle()).
     */
    const titleIn = (rec: { title: string; titleAr?: string | null }, lang: PageLang): string =>
      (lang === 'ar' && rec.titleAr?.trim()) || rec.title;
    /**
     * Every page says its encoding in the header (performance plan P3.3). The
     * link card goes in first thing in <head>, so a page's own <meta charset>
     * can end up past the first 1024 bytes, where a browser stops looking for
     * it, and an Arabic card is all non-ASCII: without the header the browser
     * would be guessing how to read it.
     */
    const PAGE_HTML = 'text/html; charset=utf-8';
    for (const [lang, editorHtml] of pagesOf('index.html', indexHtml)) {
      app.get(routeIn('/d/:id', lang), async (req, reply) => {
        const { id } = req.params as { id: string };
        const rec = await repo.get(id).catch(() => null);
        const base = origin(req);
        let title = pageText('meta.design.site', lang);
        let description = pageText('meta.design.none.desc', lang);
        let image = `${base}/og-default.png`;
        // Only expose metadata for PUBLIC designs (private ones stay unlisted).
        if (rec && rec.isPublic) {
          const owner = rec.ownerId ? await auth.getUserById(rec.ownerId).catch(() => null) : null;
          title = pageText('meta.design.title', lang, { title: titleIn(rec, lang) });
          description = describeDesign({ ...rec, title: titleIn(rec, lang) }, owner?.username ?? null, lang);
          // Whether there is a picture, not the picture itself.
          const thumb = await repo.getThumbnailMeta(rec.id).catch(() => null);
          if (thumb?.hasThumbnail) image = `${base}/api/designs/${rec.id}/thumbnail.png`;
        }
        const meta = [
          `<title>${esc(title)}</title>`,
          `<meta name="description" content="${esc(description)}" />`,
          `<meta property="og:type" content="website" />`,
          `<meta property="og:site_name" content="${esc(pageText('meta.design.site', lang))}" />`,
          `<meta property="og:title" content="${esc(title)}" />`,
          `<meta property="og:description" content="${esc(description)}" />`,
          `<meta property="og:image" content="${esc(image)}" />`,
          `<meta property="og:url" content="${esc(base)}${esc(pathIn(`/d/${id}`, lang))}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
          `<meta name="twitter:title" content="${esc(title)}" />`,
          `<meta name="twitter:description" content="${esc(description)}" />`,
          `<meta name="twitter:image" content="${esc(image)}" />`,
          // /d/:id and /t/:id render the same design. Point both at /t/:id so search
          // engines consolidate them instead of treating each as duplicate content;
          // in Arabic, at /ar/t/:id, and both versions named (performance plan P3.3).
          `<link rel="canonical" href="${esc(base)}${esc(pathIn(`/t/${id}`, lang))}" />`,
          ...alternateLinks(base, `/t/${id}`, esc),
        ].join('\n    ');
        // Inject after <head>, and drop the SPA's default <title> to avoid a dupe.
        const html = injectOnce(
          editorHtml.replace(/<title>.*?<\/title>/i, ''),
          /<head>/i,
          (m) => `${m}\n    ${meta}`,
        );
        return reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(html);
      });
    }

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
      for (const [lang, sharePage] of pagesOf('share.html', shareHtmlRaw, '/t/')) {
        app.get(routeIn('/t/:id', lang), async (req, reply) => {
          const { id } = req.params as { id: string };
          const rec = await repo.get(id).catch(() => null);
          const base = origin(req);
          let title = pageText('meta.tifo.none.title', lang);
          let description = pageText('meta.tifo.none.desc', lang);
          let image = `${base}${CARD_PATH}`;
          let alt: string | undefined;
          if (rec && rec.isPublic) {
            const owner = rec.ownerId ? await auth.getUserById(rec.ownerId).catch(() => null) : null;
            const name = titleIn(rec, lang);
            title = pageText('meta.tifo.title', lang, { title: name });
            description = describeDesign({ ...rec, title: name }, owner?.username ?? null, lang);
            image = `${base}/og/t/${rec.id}.png`;
            // Alt text describes the picture, not the page: what a card reader hears.
            alt = owner?.username
              ? pageText('meta.tifo.altBy', lang, { title: name, owner: owner.username })
              : pageText('meta.tifo.alt', lang, { title: name });
          }
          const html = withCard(sharePage, req, { title, description, path: pathIn(`/t/${id}`, lang), enPath: `/t/${id}`, image, alt, lang });
          return reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(html);
        });
      }
    }

    // Marketing landing at the root; the editor app lives at /app. Return users
    // bookmark /app; first-time visitors get the pitch. Share links (/d/:id)
    // and the SPA fallback both serve the editor.
    const landingHtml = readFileSync(join(staticDir, 'landing.html'), 'utf8');
    // The hero opens on a different club each visit: one page per hero club
    // and language, made once here (landingHero.ts). Without the hero (a test
    // build), none. The Arabic page's caption is said in Arabic from the same
    // keys its script re-says it from (performance plan P3.3).
    const heroClubs = (HERO_TIFOS as { club: string; title: string; templateId: string }[]).map(({ club, title, templateId }) => ({
      club,
      title,
      ground: HERO_GROUND_KEYS[templateId],
    }));
    const sayCaption = (lang: PageLang) =>
      lang === 'en'
        ? undefined
        : (clubKey: string, groundKey: string): string =>
            pageText('st.nameAt', lang, {
              club: pageText(clubKey, lang),
              ground: pageText(groundKey, lang).replace(/\s*[(（][^)）]*[)）]\s*$/, ''),
            });
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
    /**
     * The Tifo of the Day card, rendered on the server into the home page.
     *
     * Server-rendered for two reasons. It is the largest block on the page and
     * should not arrive a request late on a phone. And it is the first link the
     * home page has ever had to a design page: /community got its crawlable feed
     * because every published tifo was an orphan that nothing on the site
     * pointed at, and the home page is the strongest page there is to point
     * from.
     *
     * Only phrasing content inside the <a>, so spans rather than headings. The
     * fixed labels carry data-i18n and are translated on load with the rest of
     * the static page; the design's own title ships in both languages because
     * only the browser knows which one is wanted.
     */
    // In the page's language (performance plan P3.3): the labels in its words
    // (still marked data-i18n, so the toggle translates them in place), the
    // design's own title as it was given, and the link to its page in the
    // same language.
    const featuredCard = (req: FastifyRequest, picked: FeaturedTifo, lang: PageLang): string => {
      const base = origin(req);
      const d = picked.item;
      const name = d.title?.trim() || pageText('ed.docTitlePlaceholder', lang);
      const nameAr = d.titleAr?.trim() ?? '';
      const shown = lang === 'ar' && nameAr ? nameAr : name;
      const by = d.ownerName || pageText('meta.someone', lang);
      return (
        `<div class="fd-label"><span class="fd-star" aria-hidden="true">★</span>` +
        `<span data-i18n="daily.badge">${esc(pageText('daily.badge', lang))}</span></div>` +
        `<a class="fd-card" href="${esc(pathIn(`/t/${d.id}`, lang))}">` +
        `<span class="fd-shot-wrap">` +
        `<img class="fd-shot" src="${esc(base)}/api/designs/${esc(d.id)}/thumbnail.png"` +
        ` alt="${esc(pageText('meta.daily.alt', lang, { title: shown, owner: by }))}" width="800" height="84" loading="lazy" decoding="async" /></span>` +
        `<span class="fd-body"><span class="fd-main">` +
        `<span class="fd-title" data-title-en="${esc(name)}"${nameAr ? ` data-title-ar="${esc(nameAr)}"` : ''}>${esc(shown)}</span>` +
        `<span class="fd-by">@${esc(by)}</span></span>` +
        `<span class="fd-cta" data-i18n="daily.view">${esc(pageText('daily.view', lang))}</span>` +
        `</span></a>` +
        `<p class="fd-note" data-i18n="daily.sub">${esc(pageText('daily.sub', lang))}</p>`
      );
    };

    for (const [lang, html] of pagesOf('landing.html', landingHtml, '/')) {
      const landingByClub = heroPages(html, heroClubs, sayCaption(lang));
      app.get(routeIn('/', lang), async (req, reply) => {
        // Never let the feature section take the page down: today() already
        // swallows its own failures and answers null, and a null simply leaves
        // the empty container, which CSS hides.
        const picked = daily ? await daily.today() : null;
        // A club for this visit: the page is every fan's, not one club's.
        const landing = pickHeroPage(landingByClub, html);
        const page = picked
          ? injectOnce(
              landing,
              /<div class="featured-daily" id="featured-tifo"[^>]*>/i,
              (m) => `${m}${featuredCard(req, picked, lang)}`,
            )
          : landing;
        return reply
          .header('cache-control', 'no-cache')
          .type(PAGE_HTML)
          .send(
            withCard(page, req, {
              title: pageText('meta.landing.title', lang),
              description: pageText('meta.landing.desc', lang),
              path: routeIn('/', lang),
              enPath: '/',
              lang,
            }),
          );
      });
      // /ar is /ar/: one address for the Arabic landing, the query kept.
      if (lang === 'ar') {
        app.get('/ar', async (req, reply) => {
          const raw = req.raw.url ?? req.url;
          const at = raw.indexOf('?');
          return reply.header('cache-control', 'no-cache').redirect(`/ar/${at === -1 ? '' : raw.slice(at)}`, 301);
        });
      }
    }
    /**
     * Where a bare /app goes: the Projects page, decided here instead of in
     * the editor (performance plan P1.9).
     *
     * The editor always has a project open, so main.ts sent a bare /app on to
     * /projects?start=1 itself, but only after the browser had fetched and run
     * the editor to find that out: one page, about 300 KB and 2.2 s of a phone's
     * first paint spent on a redirect. Only a query that is empty, or nothing
     * but campaign tags, is bare. Anything else (?design=, ?project=, ?local=,
     * ?new=1, ?admin=, ?signedin= from a provider's sign-in, and whatever is
     * added later) is the editor's to read, exactly as before. The target is a
     * fixed path on this site; the only thing carried over is the utm_* tags,
     * re-encoded, so the visit is still counted with its campaign on the page it
     * lands on. Not an open redirect: nothing in the request picks where it goes.
     */
    const UTM_KEY = /^utm_[a-z_]{1,32}$/;
    // /ar/app goes to /ar/projects: the same fixed page, in the same language.
    const bareAppTarget = (rawUrl: string, lang: PageLang): string | null => {
      const at = rawUrl.indexOf('?');
      const query = new URLSearchParams(at === -1 ? '' : rawUrl.slice(at + 1));
      const kept = new URLSearchParams({ start: '1' });
      for (const [k, v] of query) {
        if (!UTM_KEY.test(k)) return null;
        kept.append(k, v);
      }
      return `${routeIn('/projects', lang)}?${kept.toString()}`;
    };
    for (const [lang, html] of pagesOf('index.html', indexHtml)) {
      const editorShell = htmlShell(routeIn('/app', lang), html, {
        title: pageText('meta.app.title', lang),
        description: pageText('meta.app.desc', lang),
        enPath: '/app',
        lang,
      });
      app.get(routeIn('/app', lang), async (req, reply) => {
        const bare = bareAppTarget(req.raw.url ?? req.url, lang);
        if (bare) return reply.header('cache-control', 'no-cache').redirect(bare, 302);
        // The query is the editor's to read in the browser; the page is the same for every one.
        return editorShell(req, reply);
      });
    }
    // Public developer spec for the .tifo format.
    try {
      const specHtml = readFileSync(join(staticDir, 'tifo-spec.html'), 'utf8');
      const specShell = htmlShell('/tifo-spec', specHtml, {
        title: 'The .tifo format: an open spec for stadium choreography',
        description:
          'The open file format behind TifoMaker: seat maps, palettes and per-seat instructions, documented so anyone can read or write a tifo.',
      });
      app.get('/tifo-spec', async (req, reply) => specShell(req, reply));
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
      for (const [lang, communityPage] of pagesOf('community.html', communityHtml, '/community')) {
        app.get(routeIn('/community', lang), async (req, reply) => {
          let items: { id: string; title: string; titleAr?: string | null; ownerName: string; hasThumbnail: boolean }[] = [];
          try {
            items = await repo.listPublic({ sort: 'recent', limit: GALLERY_PAGE });
          } catch {
            items = []; // a failed query must never take the page down
          }
          const base = origin(req);
          const list = items
            .map((d) => {
              const name = (lang === 'ar' && d.titleAr?.trim()) || d.title?.trim() || pageText('ed.docTitlePlaceholder', lang);
              const thumb = d.hasThumbnail
                ? `<img src="${esc(base)}/api/designs/${esc(d.id)}/thumbnail.png" alt="${esc(name)}" width="320" height="200" loading="lazy" />`
                : '';
              // /t/:id is the canonical URL for a design, so link that, not /d/:id
              // (and /ar/t/:id from the Arabic page).
              return `<li><a href="${esc(pathIn(`/t/${d.id}`, lang))}">${thumb}<span>${esc(name)}</span></a>`
                + `<small> ${esc(pageText('cm.by', lang))} ${esc(d.ownerName || pageText('meta.someone', lang))}</small></li>`;
            })
            .join('');
          const seo = items.length
            ? `<nav id="seo-feed" class="seo-feed" aria-label="${esc(pageText('meta.feed.label', lang))}"><ul>${list}</ul></nav>`
            : '';
          const withFeed = injectOnce(
            communityPage,
            /<div class="grid-loading" id="grid-loading"[^>]*>/i,
            (m) => `${seo}${m}`,
          );
          const html = withCard(withFeed, req, {
            title: pageText('meta.community.title', lang),
            description: pageText('meta.community.desc', lang),
            path: routeIn('/community', lang),
            enPath: '/community',
            lang,
          });
          return reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(html);
        });
      }
    } catch {
      /* community page optional in API-only builds */
    }

    // Match-day QR landing: fans scan one stadium-wide code → /s/:id → find seat.
    try {
      const seatHtml = readFileSync(join(staticDir, 'seat.html'), 'utf8');
      for (const [lang, seatPage] of pagesOf('seat.html', seatHtml)) {
        app.get(routeIn('/s/:id', lang), async (req, reply) => {
          const { id } = req.params as { id: string };
          return reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(withTwins(seatPage, req, `/s/${id}`, lang, true));
        });
      }
    } catch {
      /* seat page optional in API-only builds */
    }

    // B2B "For Clubs" enterprise page with lead capture.
    try {
      const clubsHtml = readFileSync(join(staticDir, 'clubs.html'), 'utf8');
      for (const [lang, html] of pagesOf('clubs.html', clubsHtml, '/clubs')) {
        const clubsShell = htmlShell(routeIn('/clubs', lang), html, {
          title: pageText('meta.clubs.title', lang),
          description: pageText('meta.clubs.desc', lang),
          enPath: '/clubs',
          lang,
        });
        app.get(routeIn('/clubs', lang), async (req, reply) => clubsShell(req, reply));
      }
    } catch {
      /* clubs page optional in API-only builds */
    }

    // Legal documents (Terms, Privacy, Acceptable Use, Cookies) at /legal.
    try {
      const legalHtml = readFileSync(join(staticDir, 'legal.html'), 'utf8');
      for (const [lang, html] of pagesOf('legal.html', legalHtml, '/legal')) {
        const legalShell = htmlShell(routeIn('/legal', lang), html, {
          title: pageText('meta.legal.title', lang),
          description: pageText('meta.legal.desc', lang),
          enPath: '/legal',
          lang,
        });
        app.get(routeIn('/legal', lang), async (req, reply) => legalShell(req, reply));
      }
    } catch {
      /* legal page optional in API-only builds */
    }

    // Password-reset landing (opened from the reset email link).
    try {
      const resetHtml = readFileSync(join(staticDir, 'reset.html'), 'utf8');
      for (const [lang, page] of pagesOf('reset.html', resetHtml)) {
        app.get(routeIn('/reset', lang), async (req, reply) =>
          reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(withTwins(page, req, '/reset', lang, false)));
      }
    } catch {
      /* reset page optional in API-only builds */
    }

    // Account settings. noindex in its own <head>; nothing here is public.
    try {
      const accountHtml = readFileSync(join(staticDir, 'account.html'), 'utf8');
      for (const [lang, page] of pagesOf('account.html', accountHtml)) {
        app.get(routeIn('/account', lang), async (req, reply) =>
          reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(withTwins(page, req, '/account', lang, false)));
      }
    } catch {
      /* account page optional in API-only builds */
    }

    // Projects: a person's own tifos. Private by nature, so noindex in its own
    // <head> and never in the sitemap. The list itself is fetched by the page.
    try {
      const projectsHtml = readFileSync(join(staticDir, 'projects.html'), 'utf8');
      for (const [lang, page] of pagesOf('projects.html', projectsHtml)) {
        app.get(routeIn('/projects', lang), async (req, reply) =>
          reply.header('cache-control', 'no-cache').type(PAGE_HTML).send(withTwins(page, req, '/projects', lang, false)));
      }
    } catch {
      /* projects page optional in API-only builds */
    }

    // sitemap.xml: generated per request rather than shipped as a static file, so
    // designs published after the last deploy still get discovered. robots.txt (a
    // static file in public/) points here. Public designs only: private ones must
    // never be enumerable, and /t/:id is the canonical URL for each one.
    // A limit of its own (performance plan P3.3): with every page and design
    // listed in both languages, each with its hreflang links, one answer is
    // about 69 ms of this one event loop and 5.2 MB at 5000 designs (it was
    // 18.5 ms and 0.9 MB), so 300 a minute from one client would hold a third
    // of the server. Crawlers read a sitemap a few times a day; ten a minute
    // per client leaves them all the room they need.
    const sitemapLimit = options.rateLimit ? { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } : {};
    app.get('/sitemap.xml', sitemapLimit, async (req, reply) => {
      const base = origin(req);
      const staticPages: [string, string, string][] = [
        // path, changefreq, priority
        ['/', 'weekly', '1.0'],
        // Not /app: a bare /app is a redirect to /projects now (performance
        // plan P1.9), and a sitemap lists pages, not redirects.
        ['/community', 'daily', '0.8'],
        ['/clubs', 'monthly', '0.6'],
        ['/tifo-spec', 'yearly', '0.4'],
        ['/legal', 'yearly', '0.3'],
      ];
      let designs: { id: string; updatedAt: string }[] = [];
      try {
        // The protocol caps a sitemap at 50k URLs; stay well inside it. Ids and
        // dates only: it read every public design's whole card for these two.
        designs = await repo.listPublicIds(5000);
      } catch {
        designs = []; // a gallery failure must not take the sitemap down
      }
      const urls: string[] = [];
      const b = esc(base);
      /**
       * A page, and its Arabic twin when this build serves one (performance plan
       * P3.3): each is listed, and each names both, en, ar and x-default (the
       * English), the way the pages' own <head> does. The links go after the
       * protocol's own elements, where its schema allows other namespaces.
       */
      const add = (enPath: string, twin: boolean, rest: string): void => {
        if (!twin) {
          urls.push(`  <url>\n    <loc>${b}${esc(enPath)}</loc>\n${rest}  </url>`);
          return;
        }
        const en = `${b}${esc(pathIn(enPath, 'en'))}`;
        const ar = `${b}${esc(pathIn(enPath, 'ar'))}`;
        const links =
          `    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>\n` +
          `    <xhtml:link rel="alternate" hreflang="ar" href="${ar}"/>\n` +
          `    <xhtml:link rel="alternate" hreflang="x-default" href="${en}"/>\n`;
        urls.push(`  <url>\n    <loc>${en}</loc>\n${rest}${links}  </url>`, `  <url>\n    <loc>${ar}</loc>\n${rest}${links}  </url>`);
      };
      for (const [path, freq, pri] of staticPages) {
        add(path, servedInArabic.has(path), `    <changefreq>${freq}</changefreq>\n    <priority>${pri}</priority>\n`);
      }
      const designsInArabic = servedInArabic.has('/t/');
      for (const d of designs) {
        // lastmod is optional in the spec, and an unparseable date would throw and
        // 500 the whole sitemap, so omit the element rather than risk that.
        const t = Date.parse(d.updatedAt);
        const lastmod = Number.isFinite(t) ? `    <lastmod>${new Date(t).toISOString().slice(0, 10)}</lastmod>\n` : '';
        add(`/t/${d.id}`, designsInArabic, `${lastmod}    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n`);
      }
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
        urls.join('\n') +
        `\n</urlset>\n`;
      return reply.header('cache-control', 'public, max-age=3600').type('application/xml').send(xml);
    });

    // index:false so the static plugin doesn't auto-serve index.html at '/'
    // (we serve the landing there instead); assets still resolve by path.
    const hashedAssets = join(staticDir, 'assets') + sep;
    const robotsTxt = join(staticDir, 'robots.txt');
    // The routes it registers under /assets/ are the asset bucket's (see
    // assetRoutes); nothing registered before or after this is.
    collectingAssetRoutes = true;
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
      index: false,
      // Vite names every file under /assets after a hash of its contents, so a
      // changed file is a new URL and the old one can be cached for good. The
      // plugin's default is max-age=0, which made the browser re-ask for every
      // script, stylesheet and font on every page view: 26 requests for the home
      // page and 109 for /community, each counted by the 300-a-minute limit, so a
      // supporter who opened /community three times in a minute was locked out by
      // their own browser, and the security log filled with them.
      //
      // The public pictures, icons and robots.txt keep their names across
      // deploys, so they cannot be kept for a year, but max-age=0 had every
      // page view ask again for each of them (performance plan P1.29): an hour,
      // then a day in which a stale copy is shown while a fresh one is fetched
      // in the background. They are the same for everyone and carry nothing
      // private. Pages (.html) and scripts outside /assets keep max-age=0: a
      // page must never be served from a cache, and a script must not run a
      // day late.
      //
      // Compressed copies made at build time (performance plan P2.3): the
      // build writes `x.js.br` and `x.js.gz` next to `x.js` (brotli 11, gzip
      // 9, only where smaller), and the plugin sends the one the browser
      // accepts, with Content-Encoding, the original's Content-Type, the
      // copy's own Content-Length and ETag, and `Vary: Accept-Encoding` on
      // every answer, the uncompressed one included. Nothing is compressed
      // while a request waits, which on this one event loop would be a CPU
      // lever for anyone (brotli 11 is slow by design). They are public files
      // with no secret in them, so BREACH has nothing to work with; the
      // responses that do carry a secret say no-transform (SECURITY-CHECKS.md).
      //
      // The copies are never routes of their own (globIgnore): /x.js.br is a
      // 404, and so is any path whose original is not there, so the routes
      // are exactly the files the build made, as before; the /assets rate
      // limit bucket is decided by those same routes. A copy's headers are
      // its original's (setHeaders is told the copy's path).
      preCompressed: true,
      globIgnore: ['**/*.br', '**/*.gz'],
      setHeaders: (reply, sentPath) => {
        const filePath = sentPath.replace(PRECOMPRESSED, '');
        if (filePath.startsWith(hashedAssets)) reply.header('cache-control', 'public, max-age=31536000, immutable');
        else if (PUBLIC_PICTURE.test(filePath) || filePath === robotsTxt) reply.header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
      },
    });
    collectingAssetRoutes = false;
  }

  // Unknown paths get a REAL 404. Previously this served the editor with a 200,
  // which meant every mistyped link and every vulnerability probe (/.git/config,
  // /wp-login.php — hundreds a week) looked to Google like a real page, producing
  // an unbounded set of soft-404 duplicates competing with the pages that matter.
  // Safe to do: every genuine page is registered explicitly above, and the client
  // only ever reads /d/:id, /t/:id and /s/:id from the URL — there is no
  // client-side router relying on this fallback.
  //
  // And under the same per-client limit as everything else. The limiter
  // attaches itself to routes, and a 404 is not a route, so a
  // scanner could fire unlimited probes (/.env, /wp-login.php, /api/anything)
  // from one address: 320 in a row got 320 answers and no 429 (audit round
  // six). Same store and key as the global limit, so a probe costs the prober
  // and nobody else. Registered for the API-only server too.
  const notFound = (req: FastifyRequest, reply: FastifyReply) => {
    if (!options.staticDir || req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.code(404).header('cache-control', 'no-cache').type('text/html').send(NOT_FOUND_HTML);
  };
  //
  // Counted in onRequest, before the body is read. As a preHandler it ran after
  // the parser, so a POST with a malformed body was answered 400 and never
  // counted, however many came from one address.
  if (options.rateLimit) {
    const limit404 = app.rateLimit();
    app.addHook('onRequest', async (req, reply) => {
      if (req.is404) await limit404.call(app, req, reply);
    });
    // The same limit for the URLs the router could not read (see frameworkErrors).
    frameworkErrorLimit = limit404;
  }
  app.setNotFoundHandler(notFound);

  return app;
}
