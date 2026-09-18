/**
 * Tifo of the day — one community design on the home page, changing daily.
 *
 * WHAT IT PICKS
 *   Public designs made by PEOPLE (the 619-design starter library is excluded:
 *   it is not somebody's work to celebrate) that have a thumbnail, because a
 *   thumbnail is what the card actually shows. Best first — the feed already
 *   orders by likes, then recency, then id — and only ones that have never had
 *   a turn, so the home page keeps introducing someone new. When everybody in
 *   the pool has had a turn it cycles: longest since its last turn first.
 *
 * WHY THERE IS A ROW AND NOT JUST A HASH OF THE DATE
 *   The pick has to be stable for the whole day even as likes move underneath
 *   it, identical across instances, and it has to notify the creator EXACTLY
 *   once. A stored day does all three; a date hash does none of them.
 *
 * Everything here is best-effort. The home page is not allowed to fail because
 * a feature section could not work out what to show.
 */

import type { DailyFeatureRepository } from './featureRepo';
import type { DesignRepository, GalleryItem, SocialRepository } from './repo';

/** The UTC day a moment belongs to, 'YYYY-MM-DD'. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** How far down the community feed the pick looks. */
const POOL_SIZE = 400;
/** How long an empty answer is remembered before the pool is read again. */
const MISS_TTL_MS = 60_000;

export interface FeaturedTifo {
  /** UTC day this pick belongs to. */
  day: string;
  item: GalleryItem;
}

export class DailyFeaturePicker {
  private hit: FeaturedTifo | null = null;
  private miss: { day: string; at: number } | null = null;
  private inFlight: Promise<FeaturedTifo | null> | null = null;

  constructor(
    private readonly designs: DesignRepository,
    private readonly store: DailyFeatureRepository,
    private readonly social?: SocialRepository,
  ) {}

  /**
   * Today's featured design, or null when there is nothing to feature.
   *
   * Cached for the day, because the home page asks on every single request —
   * including every crawler hit — and the answer cannot change until midnight.
   */
  async today(now: Date = new Date()): Promise<FeaturedTifo | null> {
    const day = utcDay(now);
    if (this.hit?.day === day) return this.hit;
    if (this.miss?.day === day && Date.now() - this.miss.at < MISS_TTL_MS) return null;
    // One resolve at a time. A cold cache under load would otherwise run the
    // pick once per in-flight request, and they would all be the same pick.
    this.inFlight ??= this.resolve(day).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async resolve(day: string): Promise<FeaturedTifo | null> {
    try {
      const pool = (
        await this.designs.listPublic({ sort: 'likes', excludeTemplates: true, limit: POOL_SIZE })
      ).filter((d) => d.hasThumbnail && d.ownerId);
      if (pool.length === 0) return this.nothing(day);

      const lastTurn = new Map<string, string>();
      for (const row of await this.store.history()) {
        if (!lastTurn.has(row.designId)) lastTurn.set(row.designId, row.day);
      }
      // `pool` arrives best first, so the first one that has never had a turn is
      // the pick. Once everyone has had one it cycles by oldest turn; sort is
      // stable, so within the same day the pool's own order breaks the tie.
      const newcomers = pool.filter((d) => !lastTurn.has(d.id));
      const chosen =
        newcomers.length > 0
          ? newcomers[0]
          : [...pool].sort((a, b) => (lastTurn.get(a.id) ?? '').localeCompare(lastTurn.get(b.id) ?? ''))[0];

      const claim = await this.store.claim(day, chosen.id);
      let item = pool.find((d) => d.id === claim.designId);
      let first = claim.inserted;
      if (!item) {
        // Whoever held the day is no longer showable: deleted, made private, or
        // taken down since. The day goes to today's pick instead of blanking.
        await this.store.replace(day, chosen.id);
        item = chosen;
        first = true;
      }
      if (first && item.ownerId && this.social) {
        // The creator hears about it once, on the day it happens. Best-effort:
        // a notification that fails must not blank the home page.
        await this.social.notifyFeatured(item.ownerId, item.id).catch(() => {});
      }
      this.miss = null;
      this.hit = { day, item };
      return this.hit;
    } catch {
      return this.nothing(day);
    }
  }

  private nothing(day: string): null {
    this.miss = { day, at: Date.now() };
    return null;
  }
}
