import type { SceneAsset, SceneModel } from './sceneAssets';
import type { BannerDoc, BannerKind, StandIndex } from './banner';
import { newBanner } from './banner';

/**
 * Bring the old Banner Studio's work forward.
 *
 * Before this, a banner was a PNG painted in a modal and pushed into the scene
 * store with a `place` hint the simulator resolved on open. That studio is
 * gone. Anything it made is still in somebody's localStorage — and in their
 * saved scene — so it is converted rather than dropped: the PNG becomes a
 * full-bleed image item on a real banner of the right type, on the stand it
 * was aimed at.
 *
 * Pure and DOM-free so `npm run verify` can check the mapping without a
 * browser. Assets that were never banners (corner flags, scarf walls) are left
 * alone: they still belong to the scene layer.
 */

/** What the old `place` hint meant, in the new taxonomy. */
const PLACE_TO_KIND: Record<string, BannerKind> = {
  surface: 'stand-cover', // a giant draped sheet over the seating
  big: 'drop',            // a large banner over the face of the stand
  small: 'fence',         // the dark front wall between pitch and first row
  gap: 'fence',           // the inter-tier walkway: the same job, lower down
  stairs: 'drop',         // a vertical strip down an aisle
  floor: 'pitch',         // flat on the grass
};

/** True for a scene asset the Banner view should own from now on. */
export function isLegacyBanner(a: SceneAsset): boolean {
  if (!a.imageRef) return false;
  if (a.place && PLACE_TO_KIND[a.place]) return true;
  return a.type === 'banner' || a.type === 'surface' || a.type === 'floor';
}

/**
 * Convert one legacy asset into a banner.
 *
 * Size comes from the asset's own scale, which the simulator had already
 * resolved to metres — so a banner that was sitting correctly on a stand keeps
 * the size it was sitting at rather than jumping to a type default.
 */
export function bannerFromAsset(a: SceneAsset, name: string): BannerDoc {
  const kind = (a.place && PLACE_TO_KIND[a.place]) || (a.type === 'surface' ? 'stand-cover' : a.type === 'floor' ? 'pitch' : 'drop');
  const doc = newBanner(kind, name);
  const w = Math.abs(a.scale?.x ?? 0);
  const h = Math.abs(a.scale?.y ?? 0);
  if (w > 0.5 && h > 0.3) {
    doc.widthM = Math.min(400, w);
    doc.heightM = Math.min(120, h);
  }
  doc.place.stand = ((a.anchor?.stand ?? 1) % 4) as StandIndex;
  doc.bg = a.color ?? null;
  if (a.imageRef) {
    // Full bleed: the old studio's canvas WAS the banner, edge to edge.
    doc.items.push({
      id: `m${doc.id}`,
      kind: 'image',
      src: a.imageRef,
      name,
      cx: 0.5,
      cy: (doc.heightM / doc.widthM) / 2,
      w: 1,
      h: doc.heightM / doc.widthM,
      rot: 0,
      opacity: 1,
    });
  }
  return doc;
}

export interface MigrationResult {
  banners: BannerDoc[];
  /** The scene with the migrated assets removed, so nothing renders twice. */
  scene: SceneModel;
  moved: number;
}

/** Split a stored scene into the banners it now contains and what is left. */
export function migrateScene(scene: SceneModel | null | undefined, label = 'Banner'): MigrationResult {
  const assets = scene && Array.isArray(scene.assets) ? scene.assets : [];
  const banners: BannerDoc[] = [];
  const keep: SceneAsset[] = [];
  for (const a of assets) {
    if (isLegacyBanner(a)) banners.push(bannerFromAsset(a, `${label} ${banners.length + 1}`));
    else keep.push(a);
  }
  return { banners, scene: { version: 1, assets: keep }, moved: banners.length };
}
