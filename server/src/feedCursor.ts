import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GalleryQuery, GallerySort } from './repo';

/**
 * The community feed's paging cursor (performance plan P3.4).
 *
 * The feed paged by OFFSET, so every page re-read every row above it: 72 ms at
 * offset 1200 on the plan's dataset, half a second at 5,000, and growing with
 * depth. A cursor names the last row a page returned, so the next page starts
 * right after it in the index (keyset paging) at the same cost at any depth.
 *
 * What a cursor holds: the sort it belongs to, and the last row's position in
 * that sort (its like score for "likes", its last edit to the microsecond, its
 * id). All of it is public: the same three values are on the card itself. What
 * a cursor must never be is a way in: it is never spliced into SQL, only bound
 * as typed parameters, and it never stands in for any filter. The feed's WHERE
 * (public only, the tab, the colours, the club, the search, the tags) is built
 * from the request exactly as it is without one; the cursor only adds "after
 * this row" to it.
 *
 * Opaque, and strict. The client is handed the cursor in the `x-next-cursor`
 * header and gives it back unchanged; it never builds or reads one. The server
 * accepts only one it issued: the text is `<payload>.<tag>`, the tag an HMAC
 * of the payload and of the query it was issued for (the sort and every
 * filter, not the viewer), so a cursor edited by hand, carried to another sort
 * or another filter, or made up, is refused. After the tag, every field is
 * checked for its exact shape, type and range. Anything that does not pass is
 * a 400, never a quiet fall back to the first page.
 *
 * The tag is integrity, not access control: a cursor grants nothing a reader
 * could not get by scrolling. Its key is kept in the database (server_keys,
 * created once at random), so a cursor stays good across a deploy and across
 * instances; without a database, a random key per process.
 */

/** A row's place in one of the feed's sorts. */
export interface FeedPosition {
  sort: GallerySort;
  /** The like score, for the "likes" sort only (null for "recent"). */
  likeScore: number | null;
  /** The last edit, in whole microseconds since 1970 (what Postgres stores). */
  updatedUs: number;
  /** The design's id: the tie-breaker that makes the order total. */
  id: string;
}

/** Longest cursor text accepted; one the server issues is about 100 characters. */
export const CURSOR_MAX_CHARS = 200;
/** The latest edit time a cursor may name: 2100-01-01, far past any real row. */
const MAX_US = 4_102_444_800_000_000;
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHAPE = /^([A-Za-z0-9_-]{16,160})\.([A-Za-z0-9_-]{22})$/;
const RECENT = /^1~r~(0|[1-9]\d{0,15})~([0-9a-f-]{36})$/;
const LIKES = /^1~l~(0|-?[1-9]\d{0,9})~(0|[1-9]\d{0,15})~([0-9a-f-]{36})$/;
const DOMAIN = 'tifomaker/feed-cursor/v1';

/** A fresh random key, for a process with no database to keep one in. */
export const randomCursorKey = (): Buffer => randomBytes(32);

/**
 * The query a cursor belongs to: the sort and every filter, in one canonical
 * text. Not the viewer (signing in mid-scroll keeps the place), not the page
 * size (a cursor names a row, not a page).
 */
export function feedScope(q: Omit<GalleryQuery, 'limit' | 'offset' | 'viewerId'>): string {
  return JSON.stringify([
    q.sort,
    q.templatesOnly === true,
    q.excludeTemplates === true,
    [...(q.colors ?? [])].sort(),
    q.clubId ?? '',
    (q.search ?? '').trim(),
    [...(q.tags ?? [])].map((t) => t.toLowerCase()).sort(),
  ]);
}

const tag = (key: Buffer, scope: string, payload: string): Buffer =>
  createHmac('sha256', key).update(`${DOMAIN}\n${scope}\n${payload}`).digest().subarray(0, 16);

/** The cursor for the page after `pos`, for this query. */
export function sealCursor(key: Buffer, scope: string, pos: FeedPosition): string {
  const payload = pos.sort === 'likes'
    ? `1~l~${pos.likeScore ?? 0}~${pos.updatedUs}~${pos.id}`
    : `1~r~${pos.updatedUs}~${pos.id}`;
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `${body}.${tag(key, scope, payload).toString('base64url')}`;
}

/**
 * The position a cursor names, or null when it is not one this server issued
 * for this query, or anything about it is out of shape. Never throws.
 */
export function openCursor(key: Buffer, scope: string, sort: GallerySort, text: unknown): FeedPosition | null {
  if (typeof text !== 'string' || text.length > CURSOR_MAX_CHARS) return null;
  const m = SHAPE.exec(text);
  if (!m) return null;
  const payload = Buffer.from(m[1], 'base64url').toString('utf8');
  // One spelling only: base64url that decodes but re-encodes differently (a
  // padding bit flipped, a character outside the payload's alphabet) is not
  // what the server wrote.
  if (Buffer.from(payload, 'utf8').toString('base64url') !== m[1]) return null;
  const given = Buffer.from(m[2], 'base64url');
  // The same for the tag: its last character has four spare bits, and a
  // cursor whose tag differs only there is still not the one handed out.
  if (given.toString('base64url') !== m[2]) return null;
  const want = tag(key, scope, payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  // Signed by this server for this very query; still checked field by field,
  // so a key that ever leaked could not be used to send a value out of range.
  if (sort === 'recent') {
    const r = RECENT.exec(payload);
    if (!r) return null;
    const us = Number(r[1]);
    if (!Number.isSafeInteger(us) || us > MAX_US || !UUID.test(r[2])) return null;
    return { sort, likeScore: null, updatedUs: us, id: r[2] };
  }
  const l = LIKES.exec(payload);
  if (!l) return null;
  const score = Number(l[1]);
  const us = Number(l[2]);
  if (!Number.isSafeInteger(score) || score < INT4_MIN || score > INT4_MAX) return null;
  if (!Number.isSafeInteger(us) || us > MAX_US || !UUID.test(l[3])) return null;
  return { sort, likeScore: score, updatedUs: us, id: l[3] };
}

/** Microseconds since 1970 as the ISO text Postgres reads back exactly ('…T12:00:00.123456Z'). */
export function usToIso(us: number): string {
  const ms = Math.floor(us / 1000);
  const frac = String(us - ms * 1000).padStart(3, '0');
  return new Date(ms).toISOString().replace(/Z$/, `${frac}Z`);
}

/** The reverse, for a timestamp written by to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'). */
export function isoToUs(iso: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})(\d{3})Z$/.exec(iso);
  if (!m) throw new Error(`not a microsecond timestamp: ${iso.slice(0, 40)}`);
  return Date.parse(`${m[1]}.${m[2]}Z`) * 1000 + Number(m[3]);
}

/**
 * The cursor key kept in the database (server_keys), made at random the first
 * time and the same for every instance and every boot after. Throws when it
 * cannot be read: the caller then uses a key of its own for this process,
 * and cursors are only good until the next boot.
 */
export async function storedCursorKey(db: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }): Promise<Buffer> {
  await db.query("INSERT INTO server_keys (name, secret) VALUES ('feed-cursor', $1) ON CONFLICT (name) DO NOTHING", [randomCursorKey()]);
  const r = await db.query("SELECT secret FROM server_keys WHERE name = 'feed-cursor'");
  const key = r.rows[0]?.secret;
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('no usable feed cursor key in server_keys');
  return key;
}
