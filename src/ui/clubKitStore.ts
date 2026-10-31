/**
 * Club kits, kept in this browser (IndexedDB). Part of the club kit's chunk
 * (ui/clubKit.ts); nothing here goes to the server, and nothing here costs
 * anything to run.
 *
 * A kit is a name, its colours (#rrggbb, the design's palette without the
 * empty seat), up to four logos (PNG, at most 512px on the long side, kept as
 * Blobs) and a font id. Up to three kits.
 *
 * Every read and every write is in try/catch: a browser that keeps nothing
 * (a private window, storage turned off, a full disk) still has its kits for
 * the session, in memory, and the caller is told they were not kept.
 *
 * What comes back from storage is not trusted: another tab, an extension or
 * a person with the devtools open can put anything there. Each record is
 * checked field by field; a field that fails is left out, a record without a
 * usable id or a single valid colour is left out entirely, and storage is
 * tidied to match, so the same bad data is not read twice.
 */
import { decodeImportBitmap } from '../core/importImage';

export const MAX_KITS = 3;
export const MAX_KIT_LOGOS = 4;
/** A logo's long side is at most this many pixels when it is kept. */
export const KIT_LOGO_EDGE = 512;
export const KIT_NAME_MAX = 40;
/** The palette holds 256, and index 0 is the empty seat. */
export const MAX_KIT_COLOURS = 255;
const LOGO_MAX_BYTES = 1_500_000;
const LOGO_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/webp']);
/** At most this many records are read: a store stuffed with junk costs one bounded pass. */
const MAX_ROWS = 64;
const DB_NAME = 'tifo_club_kits';
const STORE = 'kits';
const ID = /^k[0-9a-z]{8,32}$/;
const HEX = /^#[0-9a-f]{6}$/i;

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

export interface KitLoad {
  kits: ClubKit[];
  /** False: this browser keeps nothing, so kits last for this session only. */
  kept: boolean;
  /** Kits or parts of kits that did not validate and were left out. */
  dropped: number;
}

// ------------------------------------------------------------- checking ---

/** A kit's name: text only, no control or direction-override characters, one line, at most 40. */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return '';
  const flat = v
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(flat).slice(0, KIT_NAME_MAX).join('').trim();
}

/** Valid #rrggbb colours, lower-cased, once each, at most 255. */
export function cleanColours(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c !== 'string' || !HEX.test(c)) continue;
    const hex = c.toLowerCase();
    if (!out.includes(hex)) out.push(hex);
    if (out.length >= MAX_KIT_COLOURS) break;
  }
  return out;
}

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
  if (typeof key !== 'string' || !ID.test(key) || !value || typeof value !== 'object') return null;
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

// -------------------------------------------------------------- storage ---

let dbOpen: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbOpen ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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

function run(d: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const tx = d.transaction(STORE, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('kit store'));
      tx.onabort = () => reject(tx.error ?? new Error('kit store'));
      fn(tx.objectStore(STORE));
    } catch (e) {
      reject(e);
    }
  });
}

function readRows(d: IDBDatabase): Promise<{ key: IDBValidKey; value: unknown }[]> {
  const rows: { key: IDBValidKey; value: unknown }[] = [];
  return run(d, 'readonly', (s) => {
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

/**
 * The kits this browser keeps, checked. The three oldest are shown, in the
 * order they were made; more than three (two tabs saving at once) are left
 * where they are and come back when one is deleted.
 */
export async function loadKits(knownFont: (id: string) => boolean): Promise<KitLoad> {
  const d = await db();
  if (!d) return { kits: [], kept: false, dropped: 0 };
  let rows: { key: IDBValidKey; value: unknown }[];
  try {
    rows = await readRows(d);
  } catch {
    return { kits: [], kept: false, dropped: 0 };
  }
  let dropped = 0;
  const bad: IDBValidKey[] = [];
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
  // Tidy: what failed is not read again. Best effort; a failure here changes nothing shown.
  try {
    if (bad.length || fix.length) {
      await run(d, 'readwrite', (s) => {
        for (const k of bad) s.delete(k);
        for (const k of fix) s.put(record(k), k.id);
      });
    }
  } catch {
    /* shown as cleaned; storage keeps its copy until the next load */
  }
  return { kits, kept: true, dropped };
}

/** Keep a kit (new or changed). False: it lasts for this session only. */
export async function storeKit(kit: ClubKit): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  try {
    await run(d, 'readwrite', (s) => {
      s.put(record(kit), kit.id);
    });
    return true;
  } catch {
    return false;
  }
}

/** Forget a kit. False: storage did not answer (the session forgets it anyway). */
export async function forgetKit(id: string): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  try {
    await run(d, 'readwrite', (s) => {
      s.delete(id);
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

// ---------------------------------------------------------------- logos ---

/** A picture as a kit keeps it: at most 512px on the long side, as a PNG (transparency kept). */
export async function logoFromImage(src: ImageBitmap | HTMLCanvasElement): Promise<KitLogo | null> {
  try {
    const long = Math.max(src.width, src.height);
    if (!long) return null;
    const s = Math.min(1, KIT_LOGO_EDGE / long);
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
    if (!blob || blob.size > LOGO_MAX_BYTES) return null;
    return { blob, bitmap: await createImageBitmap(canvas) };
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
