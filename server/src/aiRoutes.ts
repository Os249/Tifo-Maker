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
import type { AiUsageRepository } from './repo';
import { validateSpec } from '../../src/core/tifoSpec';
import { refineSpec } from '../../src/core/specRefine';
import { designFromPrompt } from '../../src/core/promptDesigner';
import { generateSpecViaProvider, activeProvider } from './aiProvider';
import { generateImage } from './imageAssets';

const MAX_PROMPT = 400;
const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AiRouteDeps {
  /** Quota store (retained for when AI reopens to all users; unused during the lock). */
  aiUsage: AiUsageRepository;
  /** Resolve a user id from the request's bearer token (null = anonymous). */
  userOf: (req: FastifyRequest) => Promise<string | null>;
  /** Whether a user id belongs to an ADMIN_USERNAMES admin. */
  isAdmin: (userId: string) => Promise<boolean>;
  /** The admin unlock password (from AI_ADMIN_PASSWORD). Unset ⇒ password unlock disabled. */
  adminPassword?: string;
  /** Free generations per account (retained for re-enable). */
  freeLimit: number;
  /** Per-route rate-limit options ({config:{rateLimit}}) when limiting is on. */
  routeConfig?: object;
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
function verifyUnlock(secret: string, token: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(`ai-admin:${exp}`).digest('hex');
  return safeEqual(token.slice(dot + 1), expected);
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const adminPassword = deps.adminPassword;

  /** Does this request have AI access (unlock token OR admin account)? */
  const hasAiAccess = async (req: FastifyRequest): Promise<boolean> => {
    const tok = req.headers['x-ai-unlock'];
    if (typeof tok === 'string' && adminPassword && verifyUnlock(adminPassword, tok)) return true;
    const userId = await deps.userOf(req);
    return userId ? deps.isAdmin(userId) : false;
  };

  // Exchange the admin password for a signed, time-limited unlock token.
  app.post('/api/ai/unlock', async (req, reply) => {
    if (!adminPassword) return reply.code(403).send({ error: 'admin unlock is not configured' });
    const pw = typeof (req.body as { password?: unknown } | null)?.password === 'string'
      ? (req.body as { password: string }).password
      : '';
    if (!pw || !safeEqual(pw, adminPassword)) return reply.code(401).send({ error: 'incorrect password' });
    const exp = Date.now() + UNLOCK_TTL_MS;
    return { token: signUnlock(adminPassword, exp), expiresAt: new Date(exp).toISOString() };
  });

  app.get('/api/ai/quota', async (req, reply) => {
    if (!(await hasAiAccess(req))) return reply.code(403).send({ error: 'AI is temporarily admin-only', locked: true });
    // During the lock, admins are unlimited; the per-account quota is paused.
    return { admin: true, used: 0, limit: 0, remaining: 999999, provider: activeProvider() };
  });

  app.post('/api/ai/generate', deps.routeConfig ?? {}, async (req, reply) => {
    if (!(await hasAiAccess(req))) {
      return reply.code(403).send({
        error: 'AI generation is temporarily limited to admins while it is being rebuilt.',
        locked: true,
      });
    }

    const prompt = typeof (req.body as { prompt?: unknown } | null)?.prompt === 'string'
      ? (req.body as { prompt: string }).prompt.trim()
      : '';
    if (!prompt) return reply.code(400).send({ error: 'a prompt is required' });
    if (prompt.length > MAX_PROMPT) return reply.code(400).send({ error: `prompt too long (max ${MAX_PROMPT} characters)` });

    // Try the configured model first; fall back to the deterministic designer.
    let source: 'model' | 'offline' = 'offline';
    let result = { valid: false } as ReturnType<typeof validateSpec>;
    const modelResult = await generateSpecViaProvider(prompt);
    let modelError = modelResult.error;
    if (modelResult.spec) {
      const r = validateSpec(modelResult.spec);
      if (r.valid) {
        result = r;
        source = 'model';
      } else {
        modelError = 'text model output failed schema validation';
      }
    }
    if (!result.valid) {
      result = validateSpec(designFromPrompt(prompt));
      source = 'offline';
    }
    if (!result.valid || !result.spec) {
      return reply.code(502).send({ error: 'could not produce a valid design', errors: result.errors });
    }
    // Phase 4: deterministic art-director pass — fix legibility/contrast/field.
    const spec = refineSpec(result.spec);

    // Diagnostics surfaced to the UI so failures are visible, not silent.
    const notes: string[] = [];
    if (source === 'offline' && activeProvider() !== 'none') {
      notes.push(`Text model unavailable — ${modelError ?? 'unknown error'} — used the offline designer.`);
    }

    // Phase 5: generate a picture for each image layer (portraits/figures).
    // Best-effort — a failed/unavailable generation leaves assetRef unset (the
    // client skips it) and records WHY so it shows in the status bar.
    for (const layer of spec.layers) {
      if (layer.kind === 'image' && !layer.assetRef) {
        const r = await generateImage(layer.prompt).catch((e) => ({ url: null, error: String(e) }) as { url: null; error: string });
        if (r.url) layer.assetRef = r.url;
        else notes.push(`Portrait not generated — ${r.error ?? 'unknown error'}`);
      }
    }

    // Admin-only lock: unlimited, no per-account credit consumed.
    return reply.code(200).send({ spec, quota: { admin: true, used: 0, limit: 0, remaining: 999999 }, source, notes });
  });
}
