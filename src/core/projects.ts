/**
 * Projects: the unit a person works in.
 *
 * Every tifo lives in a project, and the only way into the editor is through
 * one. A project has a name and a stadium from the moment it exists, and it is
 * kept in one of two places:
 *
 *  - an ACCOUNT project is a design row on the server. Its id is the design id,
 *    and the server is the copy that counts. This browser still keeps a local
 *    copy of it (see `accountDraftKey`) so unsaved changes survive a closed tab.
 *  - a LOCAL project belongs to someone who is not signed in. It lives in this
 *    browser only, and moves into the account the moment they make one.
 *
 * Local storage layout (all JSON):
 *   tifo_projects_v1            the index: LocalProject[]
 *   tifo_proj_<id>              the project's DraftEnvelope (seats, palette…)
 *   tifo_proj_<id>_banners      its banners (BannerStore JSON)
 *   tifo_proj_<id>_thumb        a small PNG data URL for its card
 *   tifo_proj_d_<designId>      this browser's copy of an account project
 *   tifo_proj_d_<designId>_banners
 *
 * Honesty rules carried over from draft.ts: localStorage is not a backup, so a
 * failed write is reported, never swallowed, and the page says "in this
 * browser" rather than "saved".
 */

import type { DraftEnvelope, DraftWriteResult } from './draft';
import type { SeatMap } from './types';
import type { DesignStore } from './design';

export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const INDEX_KEY = 'tifo_projects_v1';
const LEGACY_DRAFT_KEY = 'tifo_draft_v1';
const LEGACY_BANNERS_KEY = 'tifo_banners_v1';
/** Refuse to write one project beyond this; the whole origin gets ~5MB. */
const MAX_BYTES = 3_500_000;

export interface LocalProject {
  id: string;
  title: string;
  templateId: string;
  templateVersion: number;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** Epoch ms it went into the Trash, or null. */
  deletedAt: number | null;
  /** 'ai' when the project was generated from a prompt. */
  origin: 'ai' | null;
}

/** Where the editor's autosave for the open project goes. */
export type ProjectRef = { kind: 'local'; id: string } | { kind: 'account'; id: string };

export const docKey = (id: string): string => `tifo_proj_${id}`;
export const bannersKey = (id: string): string => `tifo_proj_${id}_banners`;
export const thumbKey = (id: string): string => `tifo_proj_${id}_thumb`;
export const accountDraftKey = (designId: string): string => `tifo_proj_d_${designId}`;
export const accountBannersKey = (designId: string): string => `tifo_proj_d_${designId}_banners`;

/** The storage keys a project's autosave writes, for either kind. */
export function keysFor(ref: ProjectRef): { doc: string; banners: string } {
  return ref.kind === 'local'
    ? { doc: docKey(ref.id), banners: bannersKey(ref.id) }
    : { doc: accountDraftKey(ref.id), banners: accountBannersKey(ref.id) };
}

// ---------------------------------------------------------------- storage ---

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // blocked, or corrupt: treat as absent rather than crash
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

function isQuota(e: unknown): boolean {
  return /quota|exceed/i.test((e as { name?: string })?.name ?? '');
}

/**
 * Make room by dropping this browser's copies of account projects that have
 * nothing unsaved in them. They are caches: the server holds the real thing.
 */
function freeSpace(except: string): number {
  let freed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tifo_proj_d_') && !k.endsWith('_banners') && k !== except) keys.push(k);
    }
    for (const k of keys) {
      const env = read<DraftEnvelope>(k);
      if (env && env.dirty) continue; // unsaved work is never thrown away
      remove(k);
      remove(`${k}_banners`);
      freed++;
    }
  } catch {
    /* storage blocked */
  }
  return freed;
}

/** Write a value, freeing cached copies once if the origin is full. */
function write(key: string, value: string): DraftWriteResult {
  const bytes = value.length * 2;
  if (bytes > MAX_BYTES) return { ok: false, reason: 'too-big' };
  try {
    localStorage.setItem(key, value);
    return { ok: true, bytes };
  } catch (e) {
    if (!isQuota(e)) return { ok: false, reason: 'blocked' };
    if (freeSpace(key) === 0) return { ok: false, reason: 'quota' };
    try {
      localStorage.setItem(key, value);
      return { ok: true, bytes };
    } catch (e2) {
      return { ok: false, reason: isQuota(e2) ? 'quota' : 'blocked' };
    }
  }
}

export function readEnvelope(key: string): DraftEnvelope | null {
  const env = read<DraftEnvelope>(key);
  return env && env.v === 1 && env.doc ? env : null;
}

export function writeEnvelope(key: string, env: DraftEnvelope): DraftWriteResult {
  let json: string;
  try {
    json = JSON.stringify(env);
  } catch {
    return { ok: false, reason: 'blocked' };
  }
  return write(key, json);
}

export function writeRaw(key: string, value: string): DraftWriteResult {
  return write(key, value);
}

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ index ---

function readIndex(): LocalProject[] {
  const list = read<LocalProject[]>(INDEX_KEY);
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string') : [];
}

function writeIndex(list: LocalProject[]): boolean {
  return write(INDEX_KEY, JSON.stringify(list)).ok;
}

/** Local projects, trashed ones included. Anything past its 30 days is purged first. */
export function listLocal(now = Date.now()): LocalProject[] {
  const list = readIndex();
  const keep = list.filter((p) => !(p.deletedAt && now - p.deletedAt > TRASH_DAYS * DAY));
  if (keep.length !== list.length) {
    for (const p of list) if (!keep.includes(p)) dropLocalData(p.id);
    writeIndex(keep);
  }
  return keep;
}

export function getLocal(id: string): LocalProject | null {
  return readIndex().find((p) => p.id === id) ?? null;
}

/** A short id that cannot be mistaken for a design UUID. */
export function newLocalId(): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `l${rnd.slice(0, 15)}`;
}

export function isLocalId(id: string): boolean {
  return /^l[a-z0-9]{6,20}$/i.test(id);
}

export function createLocal(p: { title: string; templateId: string; templateVersion: number; origin?: 'ai' | null }): LocalProject {
  const now = Date.now();
  const project: LocalProject = {
    id: newLocalId(),
    title: p.title,
    templateId: p.templateId,
    templateVersion: p.templateVersion,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    deletedAt: null,
    origin: p.origin ?? null,
  };
  writeIndex([project, ...readIndex()]);
  return project;
}

export function updateLocal(id: string, patch: Partial<Omit<LocalProject, 'id'>>): LocalProject | null {
  const list = readIndex();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  writeIndex(list);
  return list[i];
}

export function trashLocal(id: string): LocalProject | null {
  return updateLocal(id, { deletedAt: Date.now() });
}

export function restoreLocal(id: string): LocalProject | null {
  return updateLocal(id, { deletedAt: null });
}

function dropLocalData(id: string): void {
  remove(docKey(id));
  remove(bannersKey(id));
  remove(thumbKey(id));
}

/** Delete a local project for good. */
export function purgeLocal(id: string): void {
  dropLocalData(id);
  void import('./layerStore').then(({ writeLayers }) => writeLayers(docKey(id), null));
  writeIndex(readIndex().filter((p) => p.id !== id));
}

/** Copy a local project, seats, banners and card picture included. */
export function duplicateLocal(id: string, title: string): LocalProject | null {
  const src = getLocal(id);
  const env = readEnvelope(docKey(id));
  if (!src || !env) return null;
  const copy = createLocal({ title, templateId: src.templateId, templateVersion: src.templateVersion, origin: src.origin });
  const w = writeEnvelope(docKey(copy.id), { ...env, title, savedAt: Date.now(), designId: null, projectId: copy.id });
  if (!w.ok) {
    purgeLocal(copy.id);
    return null;
  }
  const b = readRaw(bannersKey(id));
  if (b) writeRaw(bannersKey(copy.id), b);
  const th = readRaw(thumbKey(id));
  if (th) writeRaw(thumbKey(copy.id), th);
  // Its layers too: a copy should open as movable as the original.
  void import('./layerStore').then(({ copyLayers }) => copyLayers(docKey(id), docKey(copy.id)));
  return copy;
}

export function localThumb(id: string): string | null {
  const v = readRaw(thumbKey(id));
  return v && v.startsWith('data:image/') ? v : null;
}

// -------------------------------------------------------------- migration ---

/**
 * Bring the one-draft world forward, once.
 *
 * Before projects there was a single draft per browser. If it belongs to no
 * account design it becomes a local project, banners and all, so nobody who
 * painted something before this shipped arrives at an empty Projects page. If
 * it belongs to an account design it becomes that project's local copy, marked
 * unsaved so it is offered back rather than silently dropped.
 */
export function migrateLegacyDraft(): LocalProject | null {
  const env = readEnvelope(LEGACY_DRAFT_KEY);
  if (!env) return null;
  let made: LocalProject | null = null;
  if (env.designId) {
    const key = accountDraftKey(env.designId);
    if (!readEnvelope(key)) {
      writeEnvelope(key, { ...env, dirty: true });
      const b = readRaw(LEGACY_BANNERS_KEY);
      if (b) writeRaw(accountBannersKey(env.designId), b);
    }
  } else {
    made = createLocal({
      title: env.title || env.doc.meta?.title || 'My tifo',
      templateId: env.templateId,
      templateVersion: env.templateVersion,
    });
    updateLocal(made.id, { updatedAt: env.savedAt || Date.now(), createdAt: env.savedAt || Date.now() });
    const w = writeEnvelope(docKey(made.id), { ...env, projectId: made.id });
    if (!w.ok) {
      // Leave the old draft where it is rather than lose it.
      purgeLocal(made.id);
      return null;
    }
    const b = readRaw(LEGACY_BANNERS_KEY);
    if (b) writeRaw(bannersKey(made.id), b);
  }
  remove(LEGACY_DRAFT_KEY);
  remove(LEGACY_BANNERS_KEY);
  return made;
}

// ------------------------------------------------------- new-project hand-off ---

/**
 * What the Create panel asked for, carried to the editor across one navigation.
 * sessionStorage, not the URL: a prompt can be long, and a reload of the
 * editor's URL must not create a second project.
 */
export interface NewProjectIntent {
  title: string;
  templateId: string;
  /** Set when the project is to be generated from a prompt. */
  prompt?: string;
  /** True when the user left the name as it was, so the AI may name it. */
  autoName?: boolean;
}

const INTENT_KEY = 'tifo_new_project';

export function stashNewProject(intent: NewProjectIntent): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* the editor falls back to a default name and the URL's stadium */
  }
}

export function takeNewProject(): NewProjectIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(INTENT_KEY);
    const v = JSON.parse(raw) as NewProjectIntent;
    return v && typeof v.templateId === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The editor URL that creates a project on this stadium. */
export function newProjectUrl(templateId: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ new: '1', template: templateId, ...extra });
  return `/app?${q.toString()}`;
}

export function openUrl(ref: ProjectRef, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ [ref.kind === 'local' ? 'local' : 'project']: ref.id, ...extra });
  return `/app?${q.toString()}`;
}

// ------------------------------------------------------------- thumbnails ---

/**
 * The card picture: the unrolled bowl as a strip, the same view the gallery
 * uses, but small enough that a few dozen of them fit comfortably in storage.
 */
export function makeStripDataUrl(map: SeatMap, store: DesignStore, W = 480): string {
  const bw = map.bounds.maxX - map.bounds.minX;
  const bh = map.bounds.maxY - map.bounds.minY;
  const scale = W / bw;
  const H = Math.max(16, Math.round(bh * scale) + 2);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#14171f';
  ctx.fillRect(0, 0, W, H);
  const colors = store.palette.map((hex, i) => (i === 0 ? '#262a33' : hex));
  // Whole pixels: a fractional edge antialiases into a new colour, and new
  // colours are what make a PNG big, which matters in a 5 MB origin.
  const w = Math.max(1, Math.round(3.2 * scale));
  const h = Math.max(1, Math.round(8 * scale * 0.85));
  for (let c = 0; c < colors.length; c++) {
    ctx.fillStyle = colors[c];
    for (let i = 0; i < map.count; i++) {
      if (store.cells[i] !== c) continue;
      ctx.fillRect(Math.round((map.xy[i * 2] - map.bounds.minX) * scale), Math.round((map.xy[i * 2 + 1] - map.bounds.minY) * scale + 1), w, h);
    }
  }
  return canvas.toDataURL('image/png');
}

// ------------------------------------------------------------------ names ---

/** "My tifo 3": the next free default name among the ones already in use. */
export function nextDefaultName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return base;
}
