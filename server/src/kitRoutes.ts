/**
 * Club kits and the credit line on the account (Pro): what lets a kit made on
 * a laptop be there on the fan's phone, and their credit line go in the
 * corner of every export on any device.
 *
 *   GET    /api/pro/kits                the account's kits (no pictures, their hashes)
 *   PUT    /api/pro/kits/:id            save a kit, new or changed (idempotent)
 *   DELETE /api/pro/kits/:id            forget one (idempotent)
 *   GET    /api/pro/kits/logos/:hash    one of the account's logos, as a PNG
 *   GET    /api/pro/credit              the credit line
 *   PUT    /api/pro/credit              keep it ('' removes it)
 *
 * Only for a signed-in account Pro is on for (PRO_MODE, PRO_PREVIEW_USERS);
 * anyone else gets a 404, as with every Pro route, so nobody learns about a
 * preview from here. Saving kits is free (it always was: the free try is a
 * use in a project, counted in the browser); nothing here costs money.
 *
 * Nothing is trusted. A name, the colours and the font are cleaned exactly
 * as the browser cleans them (src/core/kitRules.ts); a logo must be a PNG by
 * its bytes, at most 400 KB and 512 px, and is kept with its metadata
 * stripped (imageMeta.ts), under the SHA-256 of what is kept; a kit can only
 * name logos its own account holds. Every answer is about the caller's own
 * account: no id here reaches anyone else's.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  KIT_ID, KIT_LOGO_EDGE, KIT_LOGO_MAX_BYTES, MAX_KIT_LOGOS, cleanColours, cleanCredit, cleanFontId, cleanName,
} from '../../src/core/kitRules';
import { TIFO_FONTS } from '../../src/core/text';
import { PRO_FONTS } from '../../src/core/proVoices';
import { sniffImage, stripImageMetadata } from './imageMeta';
import type { KitRepository, NewLogo, StoredKit } from './kitRepo';
import type { ProService } from './pro';
import type { UserRow } from './repo';

export interface KitRouteDeps {
  kits: KitRepository;
  pro: ProService;
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  accountOf: (req: FastifyRequest, userId: string) => Promise<UserRow | null>;
  /** Rate limits, when the app has them on: reads (lists, logos) and writes. */
  readConfig?: object;
  writeConfig?: object;
}

/** The voices a kit may name: the Text tool's free ones and the Pro ones. */
const FONT_IDS = new Set([...TIFO_FONTS.map((f) => f.id), ...PRO_FONTS.map((f) => f.id)]);
const HASH = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The base64 of the largest logo, and a little room for the rest of the kit. */
const B64_MAX = Math.ceil(KIT_LOGO_MAX_BYTES / 3) * 4;
export const KIT_BODY_LIMIT = MAX_KIT_LOGOS * B64_MAX + 32 * 1024;

/** A PNG's size, from its header (bytes 16 to 23, after the signature and the IHDR chunk's type). */
function pngSize(b: Buffer): { w: number; h: number } | null {
  if (b.byteLength < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

type Logo = { kind: 'hash'; hash: string } | { kind: 'new'; logo: NewLogo };
/** Why a logo was refused; `notImage` when its bytes are no PNG (the security monitor counts those). */
type Refused = { error: string; notImage?: true };

/** One logo of a kit as sent: a hash the account holds, or a PNG. */
function readLogo(v: unknown): Logo | Refused {
  const shape = { error: 'each logo is { hash } or { png }' };
  if (!v || typeof v !== 'object') return shape;
  const o = v as { hash?: unknown; png?: unknown };
  if (typeof o.hash === 'string' && o.png === undefined) {
    return HASH.test(o.hash) ? { kind: 'hash', hash: o.hash } : { error: 'a logo hash is 64 hex characters' };
  }
  if (typeof o.png !== 'string' || o.hash !== undefined) return shape;
  const tooBig = { error: `a logo is a PNG of at most ${KIT_LOGO_MAX_BYTES} bytes, in base64` };
  if (!o.png || o.png.length > B64_MAX || !B64.test(o.png)) return tooBig;
  const raw = Buffer.from(o.png, 'base64');
  if (raw.byteLength === 0 || raw.byteLength > KIT_LOGO_MAX_BYTES) return tooBig;
  // By its bytes, not by what it says it is; and never with its metadata.
  const notPng: Refused = { error: 'a logo must be a PNG', notImage: true };
  if (sniffImage(raw) !== 'png') return notPng;
  const png = stripImageMetadata(raw);
  const size = png ? pngSize(png) : null;
  if (!png || !size) return notPng;
  if (size.w < 1 || size.h < 1 || size.w > KIT_LOGO_EDGE || size.h > KIT_LOGO_EDGE) {
    return { error: `a logo is at most ${KIT_LOGO_EDGE} pixels on each side` };
  }
  const hash = createHash('sha256').update(png).digest('hex');
  return { kind: 'new', logo: { hash, w: size.w, h: size.h, png } };
}

/** A kit as the browser reads it. */
function shown(k: StoredKit): object {
  return { id: k.id, name: k.name, colours: k.colours, font: k.font, at: k.at, logos: k.logos, updatedAt: k.updatedAt };
}

export function registerKitRoutes(app: FastifyInstance, deps: KitRouteDeps): void {
  const { kits, pro } = deps;
  const read = deps.readConfig ?? {};
  const write = deps.writeConfig ?? {};

  /** The caller, when Pro is on for them; otherwise the refusal has been sent and null comes back. */
  const member = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return null;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) {
      await reply.code(401).send({ error: 'authentication required' });
      return null;
    }
    if (!pro.live(user.username)) {
      await reply.code(404).send({ error: 'not found' });
      return null;
    }
    return user.id;
  };

  app.get('/api/pro/kits', read, async (req, reply) => {
    const userId = await member(req, reply);
    if (!userId) return;
    void reply.header('cache-control', 'no-store');
    return { kits: (await kits.list(userId)).map(shown) };
  });

  app.put('/api/pro/kits/:id', { ...write, bodyLimit: KIT_BODY_LIMIT }, async (req, reply) => {
    const userId = await member(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    if (!KIT_ID.test(id)) return reply.code(400).send({ error: 'not a kit id' });
    const b = (req.body ?? {}) as { name?: unknown; colours?: unknown; font?: unknown; at?: unknown; logos?: unknown };
    if (!b || typeof b !== 'object' || Array.isArray(b)) return reply.code(400).send({ error: 'a kit is an object' });
    const colours = cleanColours(b.colours);
    if (!colours.length) return reply.code(400).send({ error: 'a kit has at least one #rrggbb colour' });
    const logosIn = b.logos === undefined ? [] : b.logos;
    if (!Array.isArray(logosIn) || logosIn.length > MAX_KIT_LOGOS) {
      return reply.code(400).send({ error: `a kit has at most ${MAX_KIT_LOGOS} logos` });
    }
    const logos: (string | NewLogo)[] = [];
    for (const raw of logosIn) {
      const l = readLogo(raw);
      if ('error' in l) {
        if (l.notImage) req.socNote = { kind: 'upload_refused' };
        return reply.code(400).send({ error: l.error });
      }
      logos.push(l.kind === 'hash' ? l.hash : l.logo);
    }
    const at = typeof b.at === 'number' && Number.isFinite(b.at) && b.at >= 0 ? Math.min(Math.floor(b.at), Number.MAX_SAFE_INTEGER) : Date.now();
    const r = await kits.put(userId, {
      id,
      name: cleanName(b.name),
      colours,
      font: cleanFontId(b.font, (f) => FONT_IDS.has(f)),
      at,
      logos,
    });
    if (!r.ok) {
      return r.reason === 'full'
        ? reply.code(409).send({ error: 'you have 3 kits, the most there is; delete one to save another', code: 'kit_full' })
        : reply.code(409).send({ error: 'a logo this kit names is not on the account; send it again', code: 'kit_logo' });
    }
    return { kit: shown(r.kit) };
  });

  app.delete('/api/pro/kits/:id', write, async (req, reply) => {
    const userId = await member(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    if (!KIT_ID.test(id)) return reply.code(400).send({ error: 'not a kit id' });
    // Idempotent: a delete sent again from a browser that was offline is not an error.
    return { ok: true, removed: await kits.remove(userId, id) };
  });

  app.get('/api/pro/kits/logos/:hash', read, async (req, reply) => {
    const userId = await member(req, reply);
    if (!userId) return;
    const { hash } = req.params as { hash: string };
    if (!HASH.test(hash)) return reply.code(400).send({ error: 'not a logo hash' });
    const png = await kits.logo(userId, hash);
    if (!png) return reply.code(404).send({ error: 'not found' });
    // Its own name never changes (it is its hash), and it is this person's alone.
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-security-policy', "default-src 'none'")
      .header('x-content-type-options', 'nosniff')
      .send(png);
  });

  app.get('/api/pro/credit', read, async (req, reply) => {
    const userId = await member(req, reply);
    if (!userId) return;
    void reply.header('cache-control', 'no-store');
    return { credit: await kits.credit(userId) };
  });

  app.put('/api/pro/credit', write, async (req, reply) => {
    const userId = await member(req, reply);
    if (!userId) return;
    const b = (req.body ?? {}) as { credit?: unknown };
    if (!b || typeof b !== 'object' || typeof b.credit !== 'string') return reply.code(400).send({ error: 'credit is a string' });
    const credit = cleanCredit(b.credit);
    await kits.setCredit(userId, credit);
    return { credit };
  });
}
