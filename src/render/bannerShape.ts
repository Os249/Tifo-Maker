import type { SeatMap } from '../core/types';
import type { BannerStore } from '../core/banner';
import { spanFrameCache } from './simulator/standFrame';
import { settleSlot } from './simulator/bannerSlot';

/**
 * Teach a banner store what the stands allow.
 *
 * Its own module so the editor can load it on the side, after the first
 * paint: it needs the stand geometry, which is several hundred lines the
 * seat editor never uses. Every surface that edits a banner — the Banner
 * view, Match Day's panel, a drag in the bowl — goes through the store, so
 * installing it once covers all of them.
 */
export function installSlotRules(store: BannerStore, map: SeatMap): void {
  const frameFor = spanFrameCache(map);
  store.setSlotRules((doc) => settleSlot(doc, frameFor(doc.slot.stand, doc.slot.stands)));
}
