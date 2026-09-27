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
import { createDesignFromCells, deleteProject, isSignedIn, saveScene, setProjectPinned } from './api';

/** Upload one local project. Returns the new account id, or null if it stayed local. */
export async function claimLocalProject(p: LocalProject): Promise<string | null> {
  const env = readEnvelope(docKey(p.id));
  if (!env) {
    // A project with no seats saved is nothing to move; do not keep its card.
    purgeLocal(p.id);
    return null;
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
  const banners = readRaw(bannersKey(p.id));
  if (banners) {
    try {
      await saveScene(meta.id, { v: 1, banners: JSON.parse(banners) });
    } catch {
      /* the project moved; its banners did not, and the seats matter more */
    }
  }
  if (p.pinned) await setProjectPinned(meta.id, true).catch(() => {});
  if (p.deletedAt) await deleteProject(meta.id).catch(() => {});
  purgeLocal(p.id);
  return meta.id;
}

/**
 * Upload every local project. `except` is one the caller is moving itself
 * (the editor's open project, whose live state is newer than its copy here).
 */
export async function claimAllLocal(except?: string): Promise<{ moved: number; failed: number }> {
  if (!isSignedIn()) return { moved: 0, failed: 0 };
  let moved = 0;
  let failed = 0;
  for (const p of listLocal()) {
    if (p.id === except) continue;
    try {
      if (await claimLocalProject(p)) moved++;
    } catch {
      failed++;
    }
  }
  return { moved, failed };
}
