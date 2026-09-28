/**
 * Where a project's layers are kept in this browser.
 *
 * The draft of a project lives in localStorage (see core/draft.ts), which
 * holds a few megabytes for the whole site and strings only — no room for
 * twelve pictures. The layer stack is kept beside it in IndexedDB, under the
 * same key, and it carries the fingerprint of the seats it flattens to. A
 * stack whose fingerprint does not match the draft's seats (the tab closed
 * between the two writes, say) is simply not used: the project opens with its
 * seats, flat, rather than with layers that describe some other version.
 *
 * Every call is best-effort and never throws: private windows, blocked
 * storage and old browsers all just mean "no layers kept".
 */

import type { LayerDoc } from './composer';

const DB_NAME = 'tifo-layers';
const STORE = 'docs';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<any> | null): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? (req.result as T) : null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/** The stack kept for a draft key, or null. */
export async function readLayers(key: string): Promise<LayerDoc | null> {
  const v = await run<unknown>('readonly', (s) => s.get(key));
  return v && typeof v === 'object' ? (v as LayerDoc) : null;
}

/** Keep (or, with null, forget) the stack for a draft key. Resolves true when written. */
export async function writeLayers(key: string, doc: LayerDoc | null): Promise<boolean> {
  const r = await run<unknown>('readwrite', (s) => (doc ? s.put(doc, key) : s.delete(key)));
  return r !== null || doc === null;
}

/** Copy a stack to another key (a duplicated project keeps its layers). */
export async function copyLayers(from: string, to: string): Promise<void> {
  const doc = await readLayers(from);
  if (doc) await writeLayers(to, doc);
}
