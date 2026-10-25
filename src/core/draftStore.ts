/**
 * Where a project's autosave is kept: gzip-compressed, in IndexedDB
 * (performance plan P3.7).
 *
 * A draft used to be JSON in localStorage: the whole tifo, seats and palette,
 * about 257,000 characters on a busy Bernabeu, serialised and stored on the
 * main thread at every save, in a store of about 5 MB for the whole site.
 * Here it is the same JSON, gzip-compressed (CompressionStream, off the main
 * thread) and kept as bytes in IndexedDB, under the same key as before.
 *
 * Same origin, same keys, same cap: a draft whose JSON is over DRAFT_MAX_BYTES
 * (at two bytes a character, as localStorage counted it) is refused exactly as
 * it was. Reading back is bounded too: a stored record larger than any write
 * could make, or one that unpacks past the cap, is treated as corrupt and
 * never unpacked further, so a damaged or planted record cannot make the page
 * allocate without limit.
 *
 * Nothing here throws. Corrupt, truncated or oversized records read as
 * "corrupt"; a browser without IndexedDB or CompressionStream (or with
 * storage blocked) reads as "unavailable", and the caller falls back to
 * localStorage, which is what this browser did before; a store that fails
 * when asked reads as "failed", which the caller must not mistake for "no
 * draft" (core/projects.ts loadEnvelope).
 */

import type { DraftEnvelope, DraftWriteResult } from './draft';

const DB_NAME = 'tifo-drafts';
const STORE = 'drafts';

/** The cap on one draft, as localStorage had it: its JSON at two bytes a character. */
export const DRAFT_MAX_BYTES = 3_500_000;
/**
 * The most a stored draft may unpack to. A write is refused when its UTF-8
 * is larger than this (as well as when its JSON is over the cap at two bytes
 * a character), so no record written by this code unpacks to more: anything
 * that does is not ours, and reading stops there.
 */
export const DRAFT_MAX_UNPACKED = DRAFT_MAX_BYTES;
/**
 * The most a stored record may hold. gzip never grows its input by more than
 * a few bytes per 32 KB block and a header, so a record of the cap is a
 * little over it at worst; anything past this margin is not one of ours.
 */
const MAX_STORED = DRAFT_MAX_BYTES + 64 * 1024;

/** One stored draft: the envelope's JSON, gzip-compressed, with its time for comparing copies. */
interface StoredDraft {
  v: 2;
  savedAt: number;
  /** Length of the JSON in characters, for the record's own sanity check. */
  chars: number;
  gz: Uint8Array;
}

export type StoreReadResult =
  | { state: 'ok'; env: DraftEnvelope }
  | { state: 'none' }
  | { state: 'corrupt' }
  | { state: 'unavailable' }
  | { state: 'failed' };

export type StoreWriteResult = DraftWriteResult | { ok: false; reason: 'unavailable' };

/** IndexedDB and the compression streams are all there (not true in every private mode or old browser). */
export function draftStoreUsable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB && typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  } catch {
    return false; // indexedDB itself can throw when storage is blocked
  }
}

let dbPromise: Promise<IDBDatabase | 'unavailable' | 'failed'> | null = null;

function openDb(): Promise<IDBDatabase | 'unavailable' | 'failed'> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase | 'unavailable' | 'failed'>((resolve) => {
    if (!draftStoreUsable()) return resolve('unavailable');
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading the database, or the browser closing the
        // connection: the next call opens a fresh one.
        db.onversionchange = () => { db.close(); if (dbPromise === p) dbPromise = null; };
        db.onclose = () => { if (dbPromise === p) dbPromise = null; };
        resolve(db);
      };
      // SecurityError / InvalidStateError: storage blocked for this origin.
      req.onerror = () => resolve(/Security|InvalidState/i.test(req.error?.name ?? '') ? 'unavailable' : 'failed');
      req.onblocked = () => resolve('failed');
    } catch {
      resolve('unavailable');
    }
  });
  dbPromise = p;
  // A connection that could not be made is not kept: the next call tries again.
  void p.then((db) => { if (db === 'failed' && dbPromise === p) dbPromise = null; });
  return p;
}

/**
 * How much of a stored record is handed to the decompressor at a time when a
 * draft is read back (security review of stage 3). Chromium inflates each
 * written chunk whole into the stream's queue before the reader sees any of
 * it, so a record handed over in one piece is unpacked in full however early
 * the reader gives up: 1 MB of gzip unpacks to 1 GB (measured: +1,072 MB of
 * renderer memory, 4.7 s), and a record of the most a draft may store, to
 * about 3.6 GB, which kills the tab every time the project is opened. Deflate
 * expands at most about 1,032 times, so a 4 KB slice unpacks to at most about
 * 4 MB, and with the reader stopping at the cap the most ever held is the cap
 * plus a slice or two (measured: the same 1 GB record, +46 MB and 4 ms).
 */
const UNPACK_SLICE = 4 * 1024;

/**
 * gunzip `bytes`, fed in slices, giving up (null) as soon as the output passes
 * `limit`, and null for anything that is not a sound gzip stream.
 */
async function gunzipBounded(bytes: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let stop = false;
  // Writes wait for the reader (the stream's queue holds one slice's output),
  // so at most a slice is unpacked ahead of what has been counted.
  const feeding = (async () => {
    try {
      for (let o = 0; o < bytes.byteLength && !stop; o += UNPACK_SLICE) {
        await writer.write(bytes.subarray(o, Math.min(bytes.byteLength, o + UNPACK_SLICE)) as Uint8Array<ArrayBuffer>);
      }
      if (!stop) await writer.close();
    } catch {
      /* the reader gave up, or the stream failed: the reader's answer stands */
    }
  })();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        stop = true;
        await reader.cancel().catch(() => {});
        await feeding;
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // Damaged or truncated: the stream errors.
    stop = true;
    await reader.cancel().catch(() => {});
    await feeding;
    return null;
  }
  await feeding;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * How much of a draft is handed to the compressor at a time. Chrome runs the
 * compression on the main thread, one written chunk at a time: a busy
 * 187,000-character draft in one piece held the thread for 26 ms (89 ms at
 * 4x CPU), longer than the old localStorage write (6 and 19 ms). In 16 KB
 * slices, with the thread let go between them, no slice holds it for long.
 */
const SLICE = 16 * 1024;

/** Let the page handle input before going on (a message, not a timer, so a hidden tab is not slowed to one a second). */
function letGo(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

/** gzip, fed in slices; null when the output would pass `limit`. */
async function gzipInSlices(bytes: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reading = (async () => {
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  })();
  try {
    // Not in the task that asked for the write either (a Save press, a
    // timer): that one has just built and serialised the draft.
    for (let o = 0; o < bytes.byteLength; o += SLICE) {
      await letGo();
      await writer.write(bytes.subarray(o, Math.min(bytes.byteLength, o + SLICE)) as Uint8Array<ArrayBuffer>);
    }
    await writer.close();
  } catch {
    // The reader gave up (past the limit) or the stream failed: its answer stands.
  }
  return reading;
}

/** The envelope as its stored record, or why it cannot be one. */
export async function packDraft(env: DraftEnvelope, serialised?: string): Promise<{ record: StoredDraft; bytes: number } | { error: 'too-big' | 'blocked' }> {
  let json: string;
  try {
    json = serialised ?? JSON.stringify(env);
  } catch {
    return { error: 'blocked' };
  }
  // The cap as it always was: two bytes a character.
  if (json.length * 2 > DRAFT_MAX_BYTES) return { error: 'too-big' };
  const utf8 = new TextEncoder().encode(json);
  if (utf8.byteLength > DRAFT_MAX_UNPACKED) return { error: 'too-big' };
  try {
    const gz = await gzipInSlices(utf8, MAX_STORED);
    if (!gz) return { error: 'too-big' };
    return { record: { v: 2, savedAt: env.savedAt, chars: json.length, gz }, bytes: gz.byteLength };
  } catch {
    return { error: 'blocked' };
  }
}

/** A stored record back to its envelope, or null when it is not a sound one of ours. */
export async function unpackDraft(record: unknown): Promise<DraftEnvelope | null> {
  try {
    if (!record || typeof record !== 'object') return null;
    const r = record as Partial<StoredDraft>;
    if (r.v !== 2 || !(r.gz instanceof Uint8Array) || r.gz.byteLength === 0 || r.gz.byteLength > MAX_STORED) return null;
    if (typeof r.chars !== 'number' || r.chars <= 0 || r.chars * 2 > DRAFT_MAX_BYTES) return null;
    const raw = await gunzipBounded(r.gz, DRAFT_MAX_UNPACKED);
    if (!raw) return null; // past the cap: not ours
    // fatal: bytes that are not UTF-8 are not a draft either.
    const json = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (json.length !== r.chars) return null;
    const env = JSON.parse(json) as DraftEnvelope;
    if (!env || typeof env !== 'object' || env.v !== 1 || !env.doc || typeof env.savedAt !== 'number') return null;
    return env;
  } catch {
    return null; // a truncated or damaged gzip stream, or JSON that does not parse
  }
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<{ ok: true; value: T } | { ok: false; quota: boolean }> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      // Resolved on the transaction's completion, not the request's success:
      // a write counts only once it is committed.
      tx.oncomplete = () => resolve({ ok: true, value: req.result });
      // A failed request aborts its transaction (its error event is left to
      // do so), and the abort is where the failure is reported, once.
      tx.onabort = () => resolve({ ok: false, quota: /quota/i.test(tx.error?.name ?? req.error?.name ?? '') });
      (tx as IDBTransaction & { commit?: () => void }).commit?.();
    } catch (e) {
      resolve({ ok: false, quota: /quota/i.test((e as { name?: string })?.name ?? '') });
    }
  });
}

/**
 * Operations on one key, in the order they were asked for. A write is
 * compressed before its transaction opens, so without this a write asked for
 * before a delete (a project moved into the account, then dropped from here)
 * could land after it and bring the draft back.
 */
const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(op, op);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

/** Store a draft. `bytes` in the result is what was stored (compressed). */
export function storeDraft(key: string, env: DraftEnvelope, serialised?: string): Promise<StoreWriteResult> {
  return inOrder(key, () => storeNow(key, env, serialised));
}

async function storeNow(key: string, env: DraftEnvelope, serialised?: string): Promise<StoreWriteResult> {
  const db = await openDb();
  if (db === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (db === 'failed') return { ok: false, reason: 'blocked' };
  const packed = await packDraft(env, serialised);
  if ('error' in packed) return { ok: false, reason: packed.error };
  const r = await request(db, 'readwrite', (s) => s.put(packed.record, key));
  if (r.ok) return { ok: true, bytes: packed.bytes };
  if (!r.quota) dbPromise = null; // a broken connection is not reused
  return { ok: false, reason: r.quota ? 'quota' : 'blocked' };
}

/** Read a draft back (after any write or delete of it already asked for). */
export function loadDraft(key: string): Promise<StoreReadResult> {
  return inOrder(key, () => loadNow(key));
}

async function loadNow(key: string): Promise<StoreReadResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDb();
    if (db === 'unavailable') return { state: 'unavailable' };
    if (db !== 'failed') {
      const r = await request<unknown>(db, 'readonly', (s) => s.get(key));
      if (r.ok) {
        if (r.value === undefined) return { state: 'none' };
        const env = await unpackDraft(r.value);
        return env ? { state: 'ok', env } : { state: 'corrupt' };
      }
    }
    // Once more on a fresh connection: the browser may have closed the old one.
    dbPromise = null;
  }
  return { state: 'failed' };
}

/** Forget a draft (best-effort). */
export function dropDraft(key: string): Promise<void> {
  return inOrder(key, async () => {
    const db = await openDb();
    if (db === 'unavailable' || db === 'failed') return;
    await request(db, 'readwrite', (s) => s.delete(key));
  });
}
