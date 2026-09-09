import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { hashPassword, hashToken, issueToken, TOKEN_TTL_MS, verifyPassword } from './auth';
import { gunzipBytes, gzipBytes, u32FromB64, u8FromB64 } from './codec';
import { generateSeatMap } from '../../src/core/seatmap';
import { TEMPLATES } from '../../src/core/template';
import { validateTifo, TIFO_SCHEMA_VERSION } from '../../src/core/tifoFormat';
import { renderDistributionPdf } from '../../src/export/distributionPdf';

import { tmpdir } from 'node:os';
import { readFile, unlink } from 'node:fs/promises';
import type { AiUsageRepository, AuthRepository, DesignRepository, EventsRepository, LeadsRepository, SocialRepository } from './repo';
import { registerAiRoutes, verifyUnlock } from './aiRoutes';
import type { EmailSender } from './email';
import type { StadiumSubmissionRepository } from './stadiumRepo';
import type { AdminStatsRepository } from './statsRepo';
import { buildVisit, type TrafficRepository } from './trafficRepo';
import { ADMIN_HTML, ADMIN_JS } from './adminPage';
import { isValidTemplate } from '../../src/core/customStadiums';

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
<title>Page not found - TifoMaker</title>
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
  .c{ margin:28px 0 0; font-size:13px; color:#6b7480; }
  .c a{ display:inline; margin:0; padding:0; border:0; color:#58a6ff; text-decoration:underline; }
  .c a:hover{ color:#79b8ff; }
</style>
</head>
<body>
  <main>
    <p class="n">404</p>
    <h1>This page does not exist</h1>
    <p>The link may be broken, or the design may have been deleted or made private.</p>
    <a class="p" href="/app">Open the editor</a>
    <a href="/">Go home</a>
    <a href="/community">Browse community</a>
    <p class="c">Followed a link that should have worked?
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
  /** Free AI generations per account (default 5). */
  aiFreeLimit?: number;
  /** Optional community stadium submissions store. When present, /api/stadiums/* is enabled. */
  stadiums?: StadiumSubmissionRepository;
  /** Optional admin analytics aggregates. When present, /api/admin/overview is enabled. */
  stats?: AdminStatsRepository;
  /** Optional cookieless traffic-source store. When present, /api/admin/traffic is enabled. */
  traffic?: TrafficRepository;
  /** Transactional email sender (verification, password reset). When absent, emails are skipped. */
  emailSender?: EmailSender;
  /** Public base URL for links in emails. Defaults to the request's own origin. */
  publicUrl?: string;
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
  const trustProxy: boolean | number =
    tp === '0' ? false : tp && /^\d+$/.test(tp) ? Number(tp) : tp === undefined ? process.env.NODE_ENV === 'production' : true;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_BODY_BYTES, trustProxy });

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
  const validPalette = (p: unknown): p is string[] =>
    Array.isArray(p) && p.length >= 2 && p.length <= 256 && p.every((c) => typeof c === 'string' && HEX.test(c));

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
  const adminSet = new Set((options.adminUsernames ?? []).map((u) => u.toLowerCase()));
  const isAdminUser = async (userId: string): Promise<boolean> => {
    if (adminSet.size === 0) return false;
    const user = await auth.getUserById(userId).catch(() => null);
    return user ? adminSet.has(user.username.toLowerCase()) : false;
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
    'landed',        // arrived in the editor
    'paint_first',   // first brush stroke
    'view_3d',       // opened the stadium / split view
    'save_clicked',  // opened the save dialog
    'signed_up',     // created an account
    'published',     // published to the community
    'exported',      // exported a production PDF/CSV
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

  app.get('/api/templates', async () => templates);

  // ---------- AI Tifo Designer (offline designer + optional model) ----------
  // Auth-gated with a per-account free quota; the spec is validated server-side
  // with the same validator the client uses before a credit is spent.
  if (options.aiUsage) {
    registerAiRoutes(app, {
      aiUsage: options.aiUsage,
      userOf,
      isAdmin: isAdminUser,
      adminPassword: process.env.AI_ADMIN_PASSWORD,
      freeLimit: options.aiFreeLimit ?? 10,
      // Launch: AI is free for any signed-in, email-verified user. Set
      // AI_FREE_FOR_ALL=false later to enforce the per-account monthly free limit.
      freeForAll: (process.env.AI_FREE_FOR_ALL ?? 'true') !== 'false',
      userState: async (userId) => {
        const u = await auth.getUserById(userId).catch(() => null);
        return u ? { emailVerified: !!u.emailVerifiedAt, isPro: u.isPro } : null;
      },
      routeConfig: options.rateLimit ? { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } } : undefined,
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
  app.get('/admin', async (_req, reply) => reply.type('text/html').send(ADMIN_HTML));
  app.get('/admin.js', async (_req, reply) =>
    reply.header('cache-control', 'no-cache').type('text/javascript').send(ADMIN_JS),
  );

  // ---------- auth ----------
  // Tighter limit on credential endpoints: 10 attempts/minute/IP. Only takes
  // effect when the rate-limit plugin is registered (production), ignored in tests.
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
  // Issue a fresh verification token and email the link. Best-effort: a mail
  // failure never blocks the API response (the user can request a resend).
  const sendVerifyEmail = async (req: FastifyRequest, user: { id: string; email: string }): Promise<void> => {
    if (!options.emailSender) return;
    try {
      await auth.deleteEmailTokens(user.id, 'verify_email');
      const { token, tokenHash } = issueToken();
      await auth.createEmailToken(user.id, tokenHash, 'verify_email', new Date(Date.now() + VERIFY_TTL_MS));
      const base = options.publicUrl ?? `${req.protocol}://${req.headers.host}`;
      const link = `${base}/api/auth/verify?token=${token}`;
      await options.emailSender.send({
        to: user.email,
        subject: 'Verify your TifoMaker email',
        html:
          `<p>Welcome to TifoMaker.</p>` +
          `<p>Confirm your email to unlock the AI Designer:</p>` +
          `<p><a href="${link}">Verify my email</a></p>` +
          `<p>This link expires in 24 hours. If you didn't create an account, ignore this email.</p>`,
        text: `Verify your TifoMaker email: ${link}\nThis link expires in 24 hours.`,
      });
    } catch (err) {
      app.log.error({ err }, 'verification email failed');
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
      const base = options.publicUrl ?? `${req.protocol}://${req.headers.host}`;
      const link = `${base}/reset?token=${token}`;
      await options.emailSender.send({
        to: user.email,
        subject: 'Reset your TifoMaker password',
        html:
          `<p>We received a request to reset your TifoMaker password.</p>` +
          `<p><a href="${link}">Choose a new password</a></p>` +
          `<p>This link expires in 1 hour. If you didn't request this, ignore this email, your password is unchanged.</p>`,
        text: `Reset your TifoMaker password: ${link}\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
      });
    } catch (err) {
      app.log.error({ err }, 'reset email failed');
    }
  };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const { username, password, email, acceptedVersion } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      email?: string;
      acceptedVersion?: string;
    };
    if (!username || !USERNAME.test(username) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'username 3-24 [a-zA-Z0-9_], password >= 8 chars' });
    }
    const mail = typeof email === 'string' ? email.trim() : '';
    if (!mail || mail.length > MAX_EMAIL || !EMAIL.test(mail)) {
      return reply.code(400).send({ error: 'a valid email is required' });
    }
    // Clear message for duplicates; the unique index is the real race guard.
    if (await auth.getUserByEmail(mail).catch(() => null)) {
      return reply.code(409).send({ error: 'email already in use' });
    }
    const version = typeof acceptedVersion === 'string' ? acceptedVersion.slice(0, 32) : null;
    const user = await auth.createUser(username, hashPassword(password), { email: mail, acceptedVersion: version });
    if (!user) return reply.code(409).send({ error: 'username or email taken' });
    const { token, tokenHash } = issueToken();
    await auth.createToken(user.id, tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
    await sendVerifyEmail(req, { id: user.id, email: mail });
    return reply.code(201).send({
      token,
      username: user.username,
      email: user.email,
      emailVerified: !!user.emailVerifiedAt,
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

  // Re-send the verification email to the signed-in user.
  app.post('/api/auth/verify/resend', authLimit, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const user = await auth.getUserById(userId).catch(() => null);
    if (!user?.email) return reply.code(400).send({ error: 'no email on file' });
    if (user.emailVerifiedAt) return reply.code(200).send({ ok: true, alreadyVerified: true });
    await sendVerifyEmail(req, { id: user.id, email: user.email });
    return reply.code(202).send({ ok: true });
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
    if (!user || !currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
      return reply.code(401).send({ error: 'current password is incorrect' });
    }
    await auth.setPasswordHash(userId, hashPassword(newPassword));
    return reply.code(200).send({ ok: true });
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
    await auth.setPasswordHash(userId, hashPassword(newPassword));
    await auth.deleteUserTokens(userId);
    return reply.code(200).send({ ok: true });
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const user = username ? await auth.getUserByName(username) : null;
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid credentials' });
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
  app.get('/api/gallery', async (req) => {
    const q = req.query as { sort?: string; search?: string; tags?: string; templates?: string };
    const sort = q.sort === 'likes' ? 'likes' : 'recent';
    const viewerId = await userOf(req); // annotate the caller's votes when signed in
    const tags = q.tags ? q.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    return repo.listPublic({ sort, search: q.search, viewerId, tags, templatesOnly: q.templates === '1' });
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
    const reportId = await repo.report(type, body.targetId, reporterId, body.reason.trim());
    return { reportId, status: 'received' };
  });

  // ---------- Before/After real match-day photos ----------
  // List a design's photos (metadata only; bytes via the image route below).
  app.get('/api/designs/:id/photos', async (req) => {
    const { id } = req.params as { id: string };
    return repo.listPhotos(id);
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
  app.get('/api/designs/:id/og.png', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    const img = (await repo.getOgImage(v.rec.id)) ?? (await repo.getThumbnail(v.rec.id));
    if (!img) return reply.code(404).send({ error: 'no image' });
    return reply
      .header('content-type', 'image/png')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=3600')
      .send(img);
  });

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
  app.post('/api/export/pdf', async (req, reply) => {
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
        colorNames: body.colorNames,
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
    const title = (req.body as { title?: string } | null)?.title ?? `${v.rec.title} (fork)`;
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
    const remixTitle = title || `${rec?.title ?? 'Tifo'} (remix)`;
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
    await social!.follow(userId, id);
    return { following: true };
  });
  app.delete('/api/users/:id/follow', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
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
  app.get('/api/designs/:id/comments', async (req, reply) => {
    if (!socialOn(reply)) return;
    const { id } = req.params as { id: string };
    return social!.listComments(id);
  });
  app.post('/api/designs/:id/comments', async (req, reply) => {
    if (!socialOn(reply)) return;
    const userId = await requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { body?: unknown; parentId?: unknown };
    if (typeof body.body !== 'string' || !body.body.trim()) {
      return reply.code(400).send({ error: 'comment body required' });
    }
    const parentId = typeof body.parentId === 'string' ? body.parentId : null;
    const comment = await social!.addComment(id, userId, body.body, parentId);
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
    const origin = (req: FastifyRequest): string => {
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const host = req.headers.host ?? 'tifomaker.org';
      return `${proto}://${host}`;
    };
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
        title = `${rec.title}: Tifo Maker`;
        description = 'A stadium tifo on Tifo Maker. Open it to remix.';
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
      const html = indexHtml
        .replace(/<title>.*?<\/title>/i, '')
        .replace(/<head>/i, `<head>\n    ${meta}`);
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
        let image = `${base}/og-default.png`;
        if (rec && rec.isPublic) {
          const owner = rec.ownerId ? await auth.getUserById(rec.ownerId).catch(() => null) : null;
          title = `${rec.title}: TifoMaker`;
          description = `A stadium tifo${owner ? ` by @${owner.username}` : ''} on TifoMaker.`;
          image = `${base}/api/designs/${rec.id}/og.png`;
        }
        const meta = [
          `<title>${esc(title)}</title>`,
          `<meta name="description" content="${esc(description)}" />`,
          `<meta property="og:type" content="website" />`,
          `<meta property="og:site_name" content="TifoMaker" />`,
          `<meta property="og:title" content="${esc(title)}" />`,
          `<meta property="og:description" content="${esc(description)}" />`,
          `<meta property="og:image" content="${esc(image)}" />`,
          `<meta property="og:image:width" content="1200" />`,
          `<meta property="og:image:height" content="630" />`,
          `<meta property="og:url" content="${esc(base)}/t/${esc(id)}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
          `<meta name="twitter:title" content="${esc(title)}" />`,
          `<meta name="twitter:description" content="${esc(description)}" />`,
          `<meta name="twitter:image" content="${esc(image)}" />`,
        ].join('\n    ');
        const html = sharePage.replace(/<title>.*?<\/title>/i, '').replace(/<head>/i, `<head>\n    ${meta}`);
        return reply.type('text/html').send(html);
      });
    }

    // Marketing landing at the root; the editor app lives at /app. Return users
    // bookmark /app; first-time visitors get the pitch. Share links (/d/:id)
    // and the SPA fallback both serve the editor.
    const landingHtml = readFileSync(join(staticDir, 'landing.html'), 'utf8');
    // HTML entry points are served no-cache so the browser/CDN always revalidate
    // and never reference stale hashed chunks after a deploy (the cause of
    // "Failed to load module script / MIME text/html" errors). The hashed
    // /assets/* files are immutable by name, so they stay long-cacheable.
    app.get('/', async (_req, reply) => reply.header('cache-control', 'no-cache').type('text/html').send(landingHtml));
    app.get('/app', async (_req, reply) => reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml));
    // Public developer spec for the .tifo format.
    try {
      const specHtml = readFileSync(join(staticDir, 'tifo-spec.html'), 'utf8');
      app.get('/tifo-spec', async (_req, reply) => reply.type('text/html').send(specHtml));
    } catch {
      /* spec page optional in API-only builds */
    }

    // The standalone community / social feed page (third pillar).
    try {
      const communityHtml = readFileSync(join(staticDir, 'community.html'), 'utf8');
      app.get('/community', async (_req, reply) => reply.type('text/html').send(communityHtml));
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
      app.get('/clubs', async (_req, reply) => reply.type('text/html').send(clubsHtml));
    } catch {
      /* clubs page optional in API-only builds */
    }

    // Legal documents (Terms, Privacy, Acceptable Use, Cookies) at /legal.
    try {
      const legalHtml = readFileSync(join(staticDir, 'legal.html'), 'utf8');
      app.get('/legal', async (_req, reply) => reply.type('text/html').send(legalHtml));
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
