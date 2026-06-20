/**
 * AI Tifo Designer HTTP surface.
 *
 *   POST /api/ai/generate   (bearer) { prompt } → { spec, quota, source }
 *   GET  /api/ai/quota      (bearer)            → { used, limit, remaining }
 *
 * Flow: authenticate → check the account's free quota → ask the model for a
 * TifoSpec (or use the offline designer) → validate it with the SAME validator
 * the client uses → consume one credit only on a delivered design → return the
 * spec (NOT seats; the client compiles it). Registered from buildApp so it
 * shares the app's auth and rate-limit plumbing.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AiUsageRepository } from './repo';
import { validateSpec } from '../../src/core/tifoSpec';
import { designFromPrompt } from '../../src/core/promptDesigner';
import { generateSpecViaProvider, activeProvider } from './aiProvider';

const MAX_PROMPT = 400;

export interface AiRouteDeps {
  aiUsage: AiUsageRepository;
  /** Resolve a user id from the request's bearer token (null = anonymous). */
  userOf: (req: FastifyRequest) => Promise<string | null>;
  /** Free generations per account. */
  freeLimit: number;
  /** Per-route rate-limit options ({config:{rateLimit}}) when limiting is on. */
  routeConfig?: object;
}

export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const limit = Math.max(1, deps.freeLimit);

  app.get('/api/ai/quota', async (req, reply) => {
    const userId = await deps.userOf(req);
    if (!userId) return reply.code(401).send({ error: 'sign in to use the AI designer' });
    const quota = await deps.aiUsage.get(userId, limit);
    return { ...quota, provider: activeProvider() };
  });

  app.post('/api/ai/generate', deps.routeConfig ?? {}, async (req, reply) => {
    const userId = await deps.userOf(req);
    if (!userId) return reply.code(401).send({ error: 'sign in to use the AI designer' });

    const prompt = typeof (req.body as { prompt?: unknown } | null)?.prompt === 'string'
      ? ((req.body as { prompt: string }).prompt).trim()
      : '';
    if (!prompt) return reply.code(400).send({ error: 'a prompt is required' });
    if (prompt.length > MAX_PROMPT) return reply.code(400).send({ error: `prompt too long (max ${MAX_PROMPT} characters)` });

    // Don't spend model time for an account that's already out of free credits.
    const pre = await deps.aiUsage.get(userId, limit);
    if (pre.remaining <= 0) {
      return reply.code(402).send({ error: 'you have used all your free AI generations', quota: pre });
    }

    // Try the configured model first; fall back to the deterministic designer.
    let source: 'model' | 'offline' = 'offline';
    let result = { valid: false } as ReturnType<typeof validateSpec>;
    const fromModel = await generateSpecViaProvider(prompt);
    if (fromModel) {
      const r = validateSpec(fromModel);
      if (r.valid) {
        result = r;
        source = 'model';
      }
    }
    if (!result.valid) {
      result = validateSpec(designFromPrompt(prompt));
      source = 'offline';
    }
    if (!result.valid || !result.spec) {
      return reply.code(502).send({ error: 'could not produce a valid design', errors: result.errors });
    }

    // Spend a credit only now that we have a deliverable design.
    const quota = await deps.aiUsage.consume(userId, limit);
    if (!quota.allowed) {
      return reply.code(402).send({ error: 'you have used all your free AI generations', quota });
    }

    return reply.code(200).send({ spec: result.spec, quota, source });
  });
}
