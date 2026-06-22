/**
 * Tiny in-memory TTL + LRU cache for AI generations.
 *
 * Identical briefs (same mode + prompt + stadium + provider) return the prior
 * design instantly — no model call and no image generation — which cuts BOTH
 * token usage and request count (the latter eases free-tier 429s). It resets on
 * restart, which is fine: it's a cost/latency optimization, not a store of record.
 *
 * Pure and dependency-free, so it runs in the server and the test harness.
 */

interface Entry<V> {
  v: V;
  exp: number;
}

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  constructor(
    private readonly max = 80,
    private readonly ttlMs = 30 * 60 * 1000,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Bump to most-recently-used (Map preserves insertion order).
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** Build a stable cache key from parts (case/space-insensitive, NUL-separated). */
export function cacheKey(...parts: (string | undefined)[]): string {
  return parts.map((p) => (p ?? '').trim().toLowerCase()).join('');
}
