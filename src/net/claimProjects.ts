/**
 * Moving local projects into an account.
 *
 * Someone who made tifos before signing up must arrive at an account that
 * already holds them: paying the cost of registering and finding an empty
 * Projects page is the failure the save-flow rewrite existed to prevent. So
 * the moment there is an account, every project this browser holds is
 * uploaded to it, and only then removed from the browser. A project that
 * fails to upload is left exactly where it was, to be tried again next time.
 */

import { flattenLayers } from '../core/tifoFormat';
import {
  bannersKey, docKey, listLocal, purgeLocal, readEnvelope, readRaw, thumbKey,
  type LocalProject,
} from '../core/projects';
import { ApiError, createDesignFromCells, deleteProject, fetchDesignFacts, isSignedIn, saveScene, setProjectPinned } from './api';

/**
 * An account copy made for a project that then could not finish moving, and
 * could not be taken back out either (offline, signed out). Remembered so the
 * next try removes it first instead of leaving a duplicate in the account.
 */
const orphanKey = (id: string): string => `tifo_proj_${id}_orphan`;
const remember = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: at worst a duplicate copy, never a lost project */
  }
};
const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
/**
 * Projects whose banners the server will never take (too large even alone).
 * They stay in this browser, whole, and are not tried again until their
 * banners change: each try spends one of the account's new designs for the
 * day. Remembered by a fingerprint of the banners record.
 */
const heldKey = (id: string): string => `tifo_proj_${id}_held`;
function fingerprintOf(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${raw.length}:${h.toString(16)}`;
}

/** A project that stays here because the server will never take its banners. */
export class HeldError extends Error {
  constructor() {
    super('banners too large to move');
    this.name = 'HeldError';
  }
}

async function takeBack(designId: string): Promise<boolean> {
  try {
    await deleteProject(designId);
    await deleteProject(designId, true);
    return true;
  } catch (e) {
    // Already gone, or not this account's (another account signed in since).
    return e instanceof ApiError && (e.status === 404 || e.status === 403);
  }
}

/** Upload one local project. Returns the new account id, or null if it stayed local. */
export async function claimLocalProject(p: LocalProject): Promise<string | null> {
  const env = readEnvelope(docKey(p.id));
  if (!env) {
    // A project with no seats saved is nothing to move; do not keep its card.
    purgeLocal(p.id);
    return null;
  }
  const bannersRaw = readRaw(bannersKey(p.id));
  const orphan = recall(orphanKey(p.id));
  if (orphan) {
    // Removed only while it is still the untouched copy this browser made. If
    // it has been worked on since (on another device), it is kept, and the
    // project here moves as a copy of its own.
    const facts = await fetchDesignFacts(orphan);
    const untouched = !!facts && facts.revisionCount === 0 && Date.parse(facts.updatedAt) - Date.parse(facts.createdAt) < 5000;
    if (untouched && !(await takeBack(orphan))) throw new Error('earlier copy not removed yet'); // stays here; tried again
    remember(orphanKey(p.id), null);
  }
  // After the clean-up above, so a half copy left by the try that found the
  // banners too large is still removed.
  const heldAs = recall(heldKey(p.id));
  if (heldAs && bannersRaw && heldAs === fingerprintOf(bannersRaw)) throw new HeldError(); // stays here, as it was
  // Read before anything is made in the account: a malformed banners record
  // is moved as no banners, as it always was, not thrown halfway through.
  let bannersDoc: unknown;
  try {
    bannersDoc = bannersRaw ? (JSON.parse(bannersRaw) as unknown) : undefined;
  } catch {
    bannersDoc = undefined;
  }
  const thumb = readRaw(thumbKey(p.id));
  const meta = await createDesignFromCells({
    title: p.title || env.title,
    templateId: p.templateId,
    templateVersion: p.templateVersion,
    palette: env.doc.palette,
    cells: flattenLayers(env.doc),
    thumbnailPngB64: thumb?.startsWith('data:image/png;base64,') ? thumb.split(',')[1] : null,
    origin: p.origin,
  });
  // The seats are what must not be lost; everything after is best-effort.
  // Its banners, and its layers — kept beside the draft in this browser, and
  // only when they are still the layers of these seats.
  let layers: unknown = null;
  try {
    const { readLayers } = await import('../core/layerStore');
    const { fingerprint } = await import('../core/layers');
    const doc = await readLayers(docKey(p.id));
    if (doc && doc.hash === fingerprint(flattenLayers(env.doc))) layers = doc;
  } catch {
    layers = null;
  }
  if (bannersDoc !== undefined || layers) {
    const scene = { v: 1, banners: bannersDoc, ...(layers ? { layers } : {}) };
    let sent = await sendScene(meta.id, scene);
    if (sent === 'never' && layers && scene.banners) {
      // The server will not take this scene as it is (too large, most often
      // because of the pictures). The banners still go; the pictures are
      // already flattened into the seats that moved.
      sent = await sendScene(meta.id, { v: 1, banners: scene.banners });
    }
    // Banners exist only in this browser. If they could not be saved, for any
    // reason, the copy just made is taken back out and the project stays here,
    // whole, to move on the next visit. It used to be deleted from here
    // regardless, banners and pictures with it (audit round six). A refused
    // scene of pictures alone is let go: they are flattened into the seats.
    if (sent === 'later' || (sent === 'never' && scene.banners)) {
      if (!(await takeBack(meta.id))) remember(orphanKey(p.id), meta.id);
      if (sent === 'never' && bannersRaw) {
        remember(heldKey(p.id), fingerprintOf(bannersRaw));
        throw new HeldError();
      }
      throw new Error('scene not moved yet'); // counted as failed: shown, and tried again
    }
  }
  if (p.pinned) await setProjectPinned(meta.id, true).catch(() => {});
  if (p.deletedAt) await deleteProject(meta.id).catch(() => {});
  purgeLocal(p.id);
  remember(heldKey(p.id), null);
  return meta.id;
}

/**
 * Save a moving project's scene. 'later' when the refusal is one that may pass
 * (429, a 5xx, no network, a lost session); 'never' when the server refused the
 * scene itself (400 or 413).
 * One short wait is allowed for a 429 that clears within seconds.
 */
async function sendScene(designId: string, scene: unknown): Promise<'ok' | 'later' | 'never'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await saveScene(designId, scene);
      return 'ok';
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // Only "this scene is malformed" and "this scene is too large" are about
      // the scene itself. A 401, 403 or 404 is about the session or the copy
      // and may pass.
      if (status === 400 || status === 413) return 'never';
      const wait = status === 429 ? (e as ApiError).retryAfterS : 1;
      if (attempt > 0 || wait === null || wait > 10) return 'later';
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  return 'later';
}

/**
 * Upload every local project. `except` is one the caller is moving itself
 * (the editor's open project, whose live state is newer than its copy here).
 */
export async function claimAllLocal(except?: string): Promise<{ moved: number; failed: number; held: number }> {
  if (!isSignedIn()) return { moved: 0, failed: 0, held: 0 };
  let moved = 0;
  let failed = 0;
  let held = 0;
  for (const p of listLocal()) {
    if (p.id === except) continue;
    try {
      if (await claimLocalProject(p)) moved++;
    } catch (e) {
      if (e instanceof HeldError) held++;
      else failed++;
    }
  }
  return { moved, failed, held };
}
