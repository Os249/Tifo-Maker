import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { hashPassword, hashToken, issueToken, TOKEN_TTL_MS, verifyPassword } from './auth';
import { gunzipBytes, gzipBytes, u32FromB64, u8FromB64 } from './codec';
import type { AuthRepository, DesignRepository } from './repo';

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
const MAX_THUMB_BYTES = 128 * 1024;
// A full 60k design gzips to a few hundred bytes, but base64 of (cells + a
// thumbnail PNG up to 128KB) can approach ~200KB. 1MB gives generous headroom
// while still capping the request body as an abuse ceiling.
const MAX_BODY_BYTES = 1024 * 1024;

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
}

export async function buildApp(
  repo: DesignRepository,
  auth: AuthRepository,
  templates: TemplateInfo[],
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_BODY_BYTES });

  // Security headers. CSP is relaxed enough for the inline-bootstrapped SPA;
  // tighten per-deployment if you serve from a fixed origin.
  await app.register(helmet, { contentSecurityPolicy: false });

  // Rate limiting protects the auth endpoints (and everything else) from
  // brute-force and spam. Generous global ceiling; auth routes add a tighter
  // per-route limit below.
  if (options.rateLimit) {
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  }

  const seatCount = (id: string, version: number): number | null =>
    templates.find((t) => t.id === id && t.version === version)?.seatCount ?? null;

  const validPalette = (p: unknown): p is string[] =>
    Array.isArray(p) && p.length >= 2 && p.length <= 8 && p.every((c) => typeof c === 'string' && HEX.test(c));

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
  app.get('/api/templates', async () => templates);

  // ---------- auth ----------
  // Tighter limit on credential endpoints: 10 attempts/minute/IP. Only takes
  // effect when the rate-limit plugin is registered (production), ignored in tests.
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !USERNAME.test(username) || !password || password.length < 8) {
      return reply.code(400).send({ error: 'username 3-24 [a-zA-Z0-9_], password >= 8 chars' });
    }
    const user = await auth.createUser(username, hashPassword(password));
    if (!user) return reply.code(409).send({ error: 'username taken' });
    const { token, tokenHash } = issueToken();
    await auth.createToken(user.id, tokenHash, new Date(Date.now() + TOKEN_TTL_MS));
    return reply.code(201).send({ token, username: user.username });
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
    return { id: userId, username: user?.username ?? null };
  });

  // ---------- gallery ----------
  app.get('/api/gallery', async (req) => {
    const q = req.query as { sort?: string; search?: string };
    const sort = q.sort === 'likes' ? 'likes' : 'recent';
    const viewerId = await userOf(req); // annotate the caller's votes when signed in
    return repo.listPublic({ sort, search: q.search, viewerId });
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
    const [created, liked] = await Promise.all([
      repo.listPublic({ sort: 'recent', viewerId }).then((all) => all.filter((d) => d.ownerId === id)),
      repo.listLikedBy(id),
    ]);
    return { id: user.id, username: user.username, created, liked };
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
      return reply.code(400).send({ error: 'title, known templateRef, palette (2-8 hex), cellsGzB64 required' });
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
    return { ...meta, cellsGzB64: cellsGz.toString('base64') };
  });

  app.get('/api/designs/:id/thumbnail.png', async (req, reply) => {
    const v = await getVisible(req, reply);
    if (!v) return;
    const png = await repo.getThumbnail(v.rec.id);
    if (!png) return reply.code(404).send({ error: 'no thumbnail' });
    return reply.header('content-type', 'image/png').header('cache-control', 'no-cache').send(png);
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
    return repo.patchMeta(rec.id, patch);
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
    // WhatsApp, Twitter/X, Discord, Slack, etc. — before any JS runs. Humans
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
        title = `${rec.title} — Tifo Maker`;
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
      ].join('\n    ');
      // Inject after <head>, and drop the SPA's default <title> to avoid a dupe.
      const html = indexHtml
        .replace(/<title>.*?<\/title>/i, '')
        .replace(/<head>/i, `<head>\n    ${meta}`);
      return reply.type('text/html').send(html);
    });

    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
