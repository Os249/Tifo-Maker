/**
 * Club kits: on the fan's account when they are signed in (on every device
 * they sign in on), in this browser when they are not. Part of the club
 * kit's chunk (ui/clubKit.ts); the LED boards and the poster read loadKits()
 * too. Nothing here costs anything to run.
 *
 * A kit is a name, its colours (#rrggbb, the design's palette without the
 * empty seat), up to four logos (PNG, at most 512px on the long side, kept as
 * Blobs) and a font id. Up to three kits. The rules are core/kitRules.ts, the
 * same ones the server applies.
 *
 * Where a kit lives:
 *  - Signed in, Pro on for the account: on the account (server/src/kitRoutes.ts),
 *    with a copy here (IndexedDB 'acct', by account) so the kits are there when
 *    the network is not. A kit saved or deleted with no answer from the server
 *    is kept here and in a queue, and goes up at the next load that gets one.
 *  - The kits this browser made before (signed out, or before kits were on
 *    the account) move up to the account the first time it loads them: each
 *    browser kit moves once and is then gone from here, so there is one copy
 *    and the two never disagree. A kit that does not fit (the account already
 *    has three) stays here, and the sheet says so.
 *  - Signed out, or an account Pro is not on for: this browser only ('kits'),
 *    exactly as before.
 * The copy kept for an account is shown offline only to the session that
 * kept it (net/kitApi.sessionTag), so a shared computer never shows one
 * person's kits to the next.
 *
 * Every read and every write is in try/catch: a browser that keeps nothing
 * (a private window, storage turned off, a full disk) still has its kits for
 * the session, in memory, and the caller is told they were not kept.
 *
 * What comes back from storage or from the server is not trusted: another
 * tab, an extension or a person with the devtools open can put anything
 * there. Each record is checked field by field; a field that fails is left
 * out, a record without a usable id or a single valid colour is left out
 * entirely, and storage is tidied to match, so the same bad data is not read
 * twice.
 */
import { decodeImportBitmap } from '../core/importImage';
import {
  KIT_ID, KIT_LOGO_EDGE, KIT_LOGO_MAX_BYTES, KIT_NAME_MAX, MAX_KITS, MAX_KIT_COLOURS, MAX_KIT_LOGOS, cleanColours, cleanName,
} from '../core/kitRules';
import { fetchMeOnce, isSignedIn } from '../net/api';
import { accountLogo, deleteAccountKit, listAccountKits, putAccountKit, sessionTag, type AccountKit, type Answer } from '../net/kitApi';

export { KIT_LOGO_EDGE, KIT_NAME_MAX, MAX_KITS, MAX_KIT_COLOURS, MAX_KIT_LOGOS, cleanColours, cleanName };

/** A logo kept before kits were on the account could be this large (they are drawn again under 400 KB to go up). */
const LOGO_MAX_BYTES = 1_500_000;
const LOGO_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/webp']);
/** At most this many records are read: a store stuffed with junk costs one bounded pass. */
const MAX_ROWS = 64;
const DB_NAME = 'tifo_club_kits';
const STORE = 'kits';
const ACCT = 'acct';
/** Which account this browser's current session is (localStorage; see sessionTag). */
const SESSION_KEY = 'tifo_kit_session_v1';
const HASH = /^[0-9a-f]{64}$/;
/** Loads that start within this long of the last one share its answer (the sheet, the LED boards and the poster mount together). */
const SHARE_MS = 4000;

export interface KitLogo {
  blob: Blob;
  /** Decoded once, for the thumbnails; the blob is what is kept and placed. */
  bitmap: ImageBitmap;
}

export interface ClubKit {
  id: string;
  /** Cleaned; may be '' (the interface names it). */
  name: string;
  colors: string[];
  logos: KitLogo[];
  /** A font id the text picker knows, or '' for none. */
  font: string;
  at: number;
}

/** What is stored: the kit without its decoded pictures. */
interface KitRecord {
  v: 1;
  name: string;
  colors: string[];
  logos: Blob[];
  font: string;
  at: number;
}

/** A kit as the account's copy keeps it: with the account's hash of each logo, null until it is up. */
interface AcctKitRecord extends KitRecord {
  id: string;
  hashes: (string | null)[];
}

/** A change made with no answer from the server, to send at the next load that gets one. */
interface Op {
  op: 'put' | 'del';
  id: string;
}

interface AcctRecord {
  v: 1;
  kits: AcctKitRecord[];
  outbox: Op[];
}

export interface KitLoad {
  kits: ClubKit[];
  /** False: this browser keeps nothing, so kits last for this session only. */
  kept: boolean;
  /** Kits or parts of kits that did not validate and were left out. */
  dropped: number;
  /** 'account': these are the account's kits (on every device); 'browser': this browser's. */
  where?: 'account' | 'browser';
  /** The account's kits as this browser last had them: the server did not answer. */
  offline?: boolean;
  /** Changes made offline, still waiting to go up. */
  pending?: number;
  /** Kits of this browser's that moved up to the account in this load. */
  moved?: number;
  /** Kits of this browser's that could not move up (the account has three already). */
  left?: number;
}

// ------------------------------------------------------------- checking ---

/** A logo read back: a PNG or WebP Blob of a sane size that decodes to at most 512px. */
async function readLogo(b: unknown): Promise<KitLogo | null> {
  if (!(b instanceof Blob) || !LOGO_TYPES.has(b.type) || b.size <= 0 || b.size > LOGO_MAX_BYTES) return null;
  try {
    const bitmap = await createImageBitmap(b);
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > KIT_LOGO_EDGE || bitmap.height > KIT_LOGO_EDGE) {
      bitmap.close();
      return null;
    }
    return { blob: b, bitmap };
  } catch {
    return null;
  }
}

interface Checked {
  kit: Omit<ClubKit, 'logos'>;
  logos: unknown[];
  partial: boolean;
}

/** Everything but the pictures, which are decoded only for the kits that are kept. */
function check(key: unknown, value: unknown, knownFont: (id: string) => boolean): Checked | null {
  if (typeof key !== 'string' || !KIT_ID.test(key) || !value || typeof value !== 'object') return null;
  const r = value as Partial<Record<keyof KitRecord, unknown>>;
  if (r.v !== 1) return null;
  const colors = cleanColours(r.colors);
  if (!colors.length) return null;
  let partial = !Array.isArray(r.colors) || colors.length !== r.colors.length;
  const name = cleanName(r.name);
  if (name !== r.name) partial = true;
  const font = typeof r.font === 'string' && knownFont(r.font) ? r.font : '';
  if (font !== r.font) partial = true;
  const at = typeof r.at === 'number' && Number.isFinite(r.at) && r.at >= 0 ? r.at : 0;
  if (at !== r.at) partial = true;
  const logos = Array.isArray(r.logos) ? r.logos.slice(0, MAX_KIT_LOGOS) : [];
  if (!Array.isArray(r.logos) || r.logos.length > MAX_KIT_LOGOS) partial = true;
  return { kit: { id: key, name, colors, font, at }, logos, partial };
}

/** The checked kits of a set of records, oldest first, at most three, and which of them were not whole. */
async function decode(
  rows: { key: unknown; value: unknown }[],
  knownFont: (id: string) => boolean,
): Promise<{ kits: ClubKit[]; bad: unknown[]; fix: ClubKit[]; dropped: number }> {
  let dropped = 0;
  const bad: unknown[] = [];
  const ok: Checked[] = [];
  for (const row of rows) {
    const c = check(row.key, row.value, knownFont);
    if (c) ok.push(c);
    else {
      bad.push(row.key);
      dropped++;
    }
  }
  ok.sort((a, b) => a.kit.at - b.kit.at);
  const kits: ClubKit[] = [];
  const fix: ClubKit[] = [];
  for (const c of ok.slice(0, MAX_KITS)) {
    const logos: KitLogo[] = [];
    let partial = c.partial;
    for (const raw of c.logos) {
      const logo = await readLogo(raw);
      if (logo) logos.push(logo);
      else partial = true;
    }
    const kit: ClubKit = { ...c.kit, logos };
    kits.push(kit);
    if (partial) {
      fix.push(kit);
      dropped++;
    }
  }
  return { kits, bad, fix, dropped };
}

// -------------------------------------------------------------- storage ---

let dbOpen: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbOpen ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      // Version 2 adds the account's copy ('acct'); 'kits' is this browser's, as it was.
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
          if (!req.result.objectStoreNames.contains(ACCT)) req.result.createObjectStore(ACCT);
        } catch {
          /* the open fails below */
        }
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => d.close();
        resolve(d);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbOpen;
}

function run(d: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const tx = d.transaction(store, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('kit store'));
      tx.onabort = () => reject(tx.error ?? new Error('kit store'));
      fn(tx.objectStore(store));
    } catch (e) {
      reject(e);
    }
  });
}

function readRows(d: IDBDatabase): Promise<{ key: IDBValidKey; value: unknown }[]> {
  const rows: { key: IDBValidKey; value: unknown }[] = [];
  return run(d, STORE, 'readonly', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c || rows.length >= MAX_ROWS) return;
      rows.push({ key: c.key, value: c.value });
      c.continue();
    };
  }).then(() => rows);
}

function record(kit: ClubKit): KitRecord {
  return { v: 1, name: kit.name, colors: kit.colors.slice(), logos: kit.logos.map((l) => l.blob), font: kit.font, at: kit.at };
}

/** The browser's own kits: read, checked, tidied. */
async function loadBrowser(knownFont: (id: string) => boolean): Promise<KitLoad> {
  const d = await db();
  if (!d) return { kits: [], kept: false, dropped: 0, where: 'browser' };
  let rows: { key: IDBValidKey; value: unknown }[];
  try {
    rows = await readRows(d);
  } catch {
    return { kits: [], kept: false, dropped: 0, where: 'browser' };
  }
  const { kits, bad, fix, dropped } = await decode(rows, knownFont);
  // Tidy: what failed is not read again. Best effort; a failure here changes nothing shown.
  try {
    if (bad.length || fix.length) {
      await run(d, STORE, 'readwrite', (s) => {
        for (const k of bad) s.delete(k as IDBValidKey);
        for (const k of fix) s.put(record(k), k.id);
      });
    }
  } catch {
    /* shown as cleaned; storage keeps its copy until the next load */
  }
  return { kits, kept: true, dropped, where: 'browser' };
}

async function putBrowser(kit: ClubKit): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  try {
    await run(d, STORE, 'readwrite', (s) => {
      s.put(record(kit), kit.id);
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteBrowser(id: string): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  try {
    await run(d, STORE, 'readwrite', (s) => {
      s.delete(id);
    });
    return true;
  } catch {
    return false;
  }
}

/** The account's copy, as kept: shape-checked here, field-checked by decode(). */
async function readAcct(acct: string): Promise<AcctRecord> {
  const empty: AcctRecord = { v: 1, kits: [], outbox: [] };
  const d = await db();
  if (!d) return empty;
  let raw: unknown = null;
  try {
    await run(d, ACCT, 'readonly', (s) => {
      const req = s.get(acct);
      req.onsuccess = () => {
        raw = req.result;
      };
    });
  } catch {
    return empty;
  }
  const r = raw as Partial<AcctRecord> | null;
  if (!r || r.v !== 1) return empty;
  const kits = (Array.isArray(r.kits) ? r.kits : [])
    .slice(0, MAX_ROWS)
    .filter((k): k is AcctKitRecord => !!k && typeof k === 'object' && typeof (k as AcctKitRecord).id === 'string')
    .map((k) => ({ ...k, hashes: Array.isArray(k.hashes) ? k.hashes.map((h) => (typeof h === 'string' && HASH.test(h) ? h : null)) : [] }));
  const outbox = (Array.isArray(r.outbox) ? r.outbox : [])
    .slice(0, MAX_ROWS)
    .filter((o): o is Op => !!o && (o.op === 'put' || o.op === 'del') && typeof o.id === 'string' && KIT_ID.test(o.id));
  return { v: 1, kits, outbox };
}

async function writeAcct(acct: string, rec: AcctRecord): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  try {
    await run(d, ACCT, 'readwrite', (s) => {
      s.put(rec, acct);
    });
    return true;
  } catch {
    return false;
  }
}

export function newKitId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `k${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
}

// ------------------------------------------------------------- account ---

/** Each logo's hash on the account, as last seen, so saving a kit again does not send its pictures again. */
const hashOf = new WeakMap<Blob, string>();

/** The account this session is, or null (signed out, or not known without the network). */
async function sessionAccount(): Promise<{ acct: string; tag: string } | null> {
  if (!isSignedIn()) return null;
  const tag = await sessionTag();
  if (!tag) return null;
  try {
    const kept = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as { tag?: unknown; acct?: unknown } | null;
    if (kept && kept.tag === tag && typeof kept.acct === 'string' && /^[\w-]{1,64}$/.test(kept.acct)) return { acct: kept.acct, tag };
  } catch {
    /* asked below */
  }
  const me = await fetchMeOnce().catch(() => null);
  if (!me?.id) return null;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tag, acct: me.id }));
  } catch {
    /* asked again next time */
  }
  return { acct: me.id, tag };
}

/** This session's account, when its kits are on the account (null: this browser's kits, as before). */
let current: { acct: string; tag: string } | null = null;
/** Accounts the server said have no kits on the account (Pro is not on for them), this session. */
const notHere = new Set<string>();

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A logo as the account takes it: a PNG of at most 400 KB (drawn again smaller if it was not one). */
async function uploadable(blob: Blob): Promise<Blob | null> {
  if (blob.type === 'image/png' && blob.size <= KIT_LOGO_MAX_BYTES) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const logo = await logoFromImage(bmp);
    bmp.close();
    return logo?.blob ?? null;
  } catch {
    return null;
  }
}

type Push = { ok: true; kit: AccountKit } | { ok: false; offline: boolean; code?: string; status?: number };

/** Send one kit up: its logos by hash where the account has them, as PNGs where it does not. */
async function push(rec: AcctKitRecord): Promise<Push> {
  const body = { id: rec.id, name: rec.name, colours: rec.colors, font: rec.font, at: rec.at };
  const send = async (byHash: boolean): Promise<Answer<AccountKit> | null> => {
    const logos: ({ hash: string } | { png: string })[] = [];
    for (let i = 0; i < rec.logos.length; i++) {
      const h = byHash ? rec.hashes[i] : null;
      if (h) {
        logos.push({ hash: h });
        continue;
      }
      const up = await uploadable(rec.logos[i]);
      if (!up) continue; // a picture this browser can no longer read goes without
      logos.push({ png: await base64(up) });
    }
    return putAccountKit(body, logos);
  };
  let r = await send(true);
  // The account no longer has a logo this copy named (another device deleted its kit): send the pictures.
  if (r && !r.ok && !r.offline && r.code === 'kit_logo') r = await send(false);
  if (!r) return { ok: false, offline: true };
  if (r.ok) {
    rec.hashes = r.value.logos.map((l) => l.hash);
    rec.logos.forEach((b, i) => {
      if (rec.hashes[i]) hashOf.set(b, rec.hashes[i]!);
    });
    return { ok: true, kit: r.value };
  }
  return r.offline ? { ok: false, offline: true } : { ok: false, offline: false, code: r.code, status: r.status };
}

function toAcctRecord(kit: ClubKit): AcctKitRecord {
  return { ...record(kit), id: kit.id, hashes: kit.logos.map((l) => hashOf.get(l.blob) ?? null) };
}

interface Synced {
  rows: { key: string; value: AcctKitRecord }[];
  offline: boolean;
  pending: number;
  moved: number;
  left: number;
  /** Records of this browser's that were not kits, or not whole ones, as they moved up. */
  dropped: number;
}

/**
 * Bring the account and this browser together: the queue first, then this
 * browser's own kits, then the account's list, its logos fetched only where
 * this copy does not have them already. Null: the account has no kits for
 * this session (Pro is not on for it), so this browser's kits are the kits.
 */
async function sync(who: { acct: string; tag: string }): Promise<Synced | null> {
  const copy = await readAcct(who.acct);
  const answer = (offline: boolean, extra: Partial<Synced> = {}): Synced => ({
    rows: copy.kits.map((k) => ({ key: k.id, value: k })),
    offline,
    pending: copy.outbox.length,
    moved: 0,
    left: 0,
    dropped: 0,
    ...extra,
  });
  let moved = 0;
  let left = 0;
  let dropped = 0;
  // 1. What was changed with no answer, in the order it was changed.
  while (copy.outbox.length) {
    const op = copy.outbox[0];
    if (op.op === 'del') {
      const r = await deleteAccountKit(op.id);
      if (!r.ok && r.offline) return answer(true);
      if (!r.ok && (r.status === 401 || r.status === 404)) return null;
    } else {
      const rec = copy.kits.find((k) => k.id === op.id);
      if (rec) {
        const r = await push(rec);
        if (!r.ok && r.offline) return answer(true);
        if (!r.ok && (r.status === 401 || r.status === 404)) return null;
        if (!r.ok) {
          // Refused as it is (the account filled up meanwhile): kept in this browser, never lost.
          const d = await decode([{ key: rec.id, value: rec }], () => true);
          if (d.kits[0] && (await putBrowser(d.kits[0]))) left++;
          copy.kits = copy.kits.filter((k) => k !== rec);
        }
      }
    }
    copy.outbox.shift();
    await writeAcct(who.acct, copy);
  }
  // 2. This browser's own kits move up, once each; what does not read as a kit is tidied away, as loadBrowser does.
  const d = await db();
  const browserRows = d ? await readRows(d).catch(() => []) : [];
  if (browserRows.length) {
    const mine = await decode(browserRows, () => true);
    dropped += mine.dropped;
    if (d && mine.bad.length) {
      await run(d, STORE, 'readwrite', (st) => {
        for (const k of mine.bad) st.delete(k as IDBValidKey);
      }).catch(() => {});
    }
    for (const kit of mine.kits) {
      const r = await push(toAcctRecord(kit));
      if (!r.ok && r.offline) return answer(true, { moved, left, dropped });
      if (!r.ok && (r.status === 401 || r.status === 404)) return null;
      if (r.ok && (await deleteBrowser(kit.id))) moved++;
      else if (!r.ok) left++;
    }
  }
  // 3. The account's list, and the logos this copy does not have.
  const list = await listAccountKits();
  if (!list.ok) return list.offline ? answer(true, { moved, left, dropped }) : null;
  const byHash = new Map<string, Blob>();
  for (const k of copy.kits) k.logos.forEach((b, i) => {
    const h = k.hashes[i];
    if (h && b instanceof Blob) byHash.set(h, b);
  });
  const kits: AcctKitRecord[] = [];
  for (const k of list.value.slice(0, MAX_KITS)) {
    if (!k || typeof k !== 'object' || typeof k.id !== 'string') continue;
    const logos: Blob[] = [];
    const hashes: string[] = [];
    for (const l of Array.isArray(k.logos) ? k.logos.slice(0, MAX_KIT_LOGOS) : []) {
      if (!l || typeof l.hash !== 'string' || !HASH.test(l.hash)) continue;
      let blob = byHash.get(l.hash) ?? null;
      if (!blob) {
        const got = await accountLogo(l.hash);
        if (!got.ok && got.offline) return answer(true, { moved, left, dropped });
        blob = got.ok ? new Blob([got.value], { type: 'image/png' }) : null;
      }
      if (!blob) continue;
      logos.push(blob);
      hashes.push(l.hash);
      hashOf.set(blob, l.hash);
    }
    kits.push({ v: 1, id: k.id, name: k.name, colors: k.colours, font: k.font, at: k.at, logos, hashes });
  }
  // The copy for offline use; the kits are kept on the account whether or not this browser keeps it.
  await writeAcct(who.acct, { v: 1, kits, outbox: [] });
  return { rows: kits.map((k) => ({ key: k.id, value: k })), offline: false, pending: 0, moved, left, dropped };
}

let shared: { tag: string; at: number; p: Promise<Synced | null> } | null = null;

/** One sync for everything that asks at once (the sheet, the LED boards, the poster). */
function syncShared(who: { acct: string; tag: string }, fresh: boolean): Promise<Synced | null> {
  if (!fresh && shared && shared.tag === who.tag && Date.now() - shared.at < SHARE_MS) return shared.p;
  const p = sync(who).catch(() => null);
  shared = { tag: who.tag, at: Date.now(), p };
  return p;
}

const changed = (): void => {
  shared = null;
  try {
    window.dispatchEvent(new CustomEvent('tifo:kits'));
  } catch {
    /* no window: nothing to tell */
  }
};

/**
 * The kits to show, checked: the account's when this session's kits are on
 * the account (with this browser's moved up the first time), this browser's
 * otherwise. The three oldest are shown, in the order they were made; more
 * than three in this browser (two tabs saving at once) are left where they
 * are and come back when one is deleted.
 */
export async function loadKits(knownFont: (id: string) => boolean): Promise<KitLoad> {
  const who = await sessionAccount().catch(() => null);
  if (who && !notHere.has(who.acct)) {
    const s = await syncShared(who, false);
    if (s) {
      current = who;
      const { kits, dropped: bad } = await decode(s.rows, knownFont);
      const dropped = bad + s.dropped;
      // What came back is what the server holds, or this copy of it: nothing to tidy beyond leaving bad rows out.
      for (const k of kits) for (const l of k.logos) {
        const rec = s.rows.find((r) => r.key === k.id)?.value;
        const i = rec?.logos.indexOf(l.blob) ?? -1;
        if (rec && i >= 0 && rec.hashes[i]) hashOf.set(l.blob, rec.hashes[i]!);
      }
      return { kits, kept: true, dropped, where: 'account', offline: s.offline, pending: s.pending, moved: s.moved, left: s.left };
    }
    notHere.add(who.acct);
  }
  current = null;
  return loadBrowser(knownFont);
}

/** Queue a change made with no answer, and keep the copy as it now is. */
async function keepForLater(who: { acct: string }, op: Op, kit: AcctKitRecord | null): Promise<boolean> {
  const copy = await readAcct(who.acct);
  copy.kits = copy.kits.filter((k) => k.id !== op.id);
  if (kit) copy.kits.push(kit);
  // One op per kit: the last change is the one that counts.
  copy.outbox = [...copy.outbox.filter((o) => o.id !== op.id), op];
  return writeAcct(who.acct, copy);
}

/** Keep the account's copy in step with a change the server took. */
async function keepCopy(who: { acct: string }, id: string, kit: AcctKitRecord | null): Promise<void> {
  const copy = await readAcct(who.acct);
  copy.kits = copy.kits.filter((k) => k.id !== id);
  if (kit) copy.kits.push(kit);
  await writeAcct(who.acct, copy);
}

let saved: 'account' | 'later' | 'browser' = 'browser';
/** Where the last storeKit() kept its kit: on the account, here until the server answers, or in this browser only. */
export function lastSaved(): 'account' | 'later' | 'browser' {
  return saved;
}

/**
 * Keep a kit (new or changed): on the account, or in this browser. With no
 * answer from the server it is kept here and goes up at the next load. False:
 * it lasts for this session only.
 */
export async function storeKit(kit: ClubKit): Promise<boolean> {
  const who = current;
  saved = 'browser';
  if (!who) {
    const ok = await putBrowser(kit);
    changed();
    return ok;
  }
  const rec = toAcctRecord(kit);
  const r = await push(rec);
  let ok: boolean;
  if (r.ok) {
    await keepCopy(who, kit.id, rec);
    saved = 'account';
    ok = true;
  } else if (r.offline) {
    ok = await keepForLater(who, { op: 'put', id: kit.id }, rec);
    saved = 'later';
  } else if (r.status === 401 || r.status === 404) {
    // Pro is no longer on for this account: this browser keeps it, as it used to.
    notHere.add(who.acct);
    current = null;
    ok = await putBrowser(kit);
  } else {
    // Refused as it is (the account has three from another device): this browser keeps it, and the next load says so.
    ok = await putBrowser(kit);
  }
  changed();
  return ok;
}

/** Forget a kit, everywhere it is. False: storage did not answer (the session forgets it anyway). */
export async function forgetKit(id: string): Promise<boolean> {
  const who = current;
  // A kit that stayed in this browser (it did not fit on the account) goes too.
  const here = await deleteBrowser(id);
  if (!who) {
    changed();
    return here;
  }
  const r = await deleteAccountKit(id);
  const ok = r.ok || !r.offline ? (await keepCopy(who, id, null), true) : await keepForLater(who, { op: 'del', id }, null);
  changed();
  return ok;
}

// ---------------------------------------------------------------- logos ---

/** Long sides to try, largest first, until a logo's PNG is under the account's 400 KB. */
const EDGES = [KIT_LOGO_EDGE, 448, 384, 320, 256, 192, 128];

/** A picture as a kit keeps it: at most 512px on the long side, as a PNG (transparency kept) of at most 400 KB. */
export async function logoFromImage(src: ImageBitmap | HTMLCanvasElement): Promise<KitLogo | null> {
  try {
    const long = Math.max(src.width, src.height);
    if (!long) return null;
    for (const edge of EDGES) {
      const s = Math.min(1, edge / long);
      if (s === 1 && edge < KIT_LOGO_EDGE && long <= edge) continue;
      const w = Math.max(1, Math.round(src.width * s));
      const h = Math.max(1, Math.round(src.height * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      if (!g) return null;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) return null;
      if (blob.size <= KIT_LOGO_MAX_BYTES) return { blob, bitmap: await createImageBitmap(canvas) };
    }
    return null;
  } catch {
    return null;
  }
}

/** A picked file as a logo, or null when it is not a picture this browser can read. */
export async function logoFromFile(file: Blob): Promise<KitLogo | null> {
  try {
    const bmp = await decodeImportBitmap(file, KIT_LOGO_EDGE);
    const logo = await logoFromImage(bmp);
    bmp.close();
    return logo;
  } catch {
    return null;
  }
}
