/**
 * Stripped scenes, kept for anonymous views (performance plan P2.5).
 *
 * A public design's scene is shown to everyone but its owner without the
 * owner's layer stack (their own pictures). Taking the layers out means
 * decompressing, parsing, rewriting and recompressing the scene, and before
 * any of that the whole scene had to be read from the database: 1.3 MB for a
 * design with pictures, on every view. The result depends only on the stored
 * bytes, so it is kept here, by (design id, the hash stored with those bytes),
 * and a view reads the design's visibility and that hash, a few bytes, and
 * nothing else.
 *
 * The rules this cache is built on:
 *  - it holds only what stripLayers() returned: a scene without layers, or
 *    `null` for one that could not be read (which is then shown to nobody);
 *    the stored scene itself, layers and all, is never put in it;
 *  - it is keyed by the hash written in the same statement as the scene
 *    (putScene), read in the same query as the bytes it was computed from,
 *    never by a time read separately from them: a save changes the hash, so
 *    the next view misses and strips the new scene;
 *  - it is consulted only after the request has passed the visibility check,
 *    so a design that is private, taken down or in the Trash is never served
 *    from it to anyone;
 *  - bounded in bytes, least recently used out first, and one entry per
 *    design: a newer version replaces the older one.
 */
export class StrippedSceneCache {
  private readonly entries = new Map<string, Uint8Array | null>();
  /** design id -> the hash its entry is for, so a newer version replaces the old one. */
  private readonly versionOf = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}

  /**
   * What an entry really holds in memory: its whole backing buffer, not the
   * length of the view. A view into a pooled 8 KB slab or a 16 KB zlib chunk
   * pinned all of it while being charged a few hundred bytes (stage 2 review:
   * 200 small entries counted 9,290 bytes and held 3,276,800). Entries are
   * stored exact-size (set), so the two are the same; this stays the honest
   * figure whatever is passed in. A stripped-to-nothing scene costs 64, so
   * broken ones cannot fill it for free.
   */
  private static cost(v: Uint8Array | null): number {
    return v ? Math.max(v.buffer.byteLength, 64) : 64;
  }

  /** undefined: not kept. null: kept as unreadable (shown to nobody). */
  get(designId: string, hash: string): Uint8Array | null | undefined {
    const key = `${designId}:${hash}`;
    if (!this.entries.has(key)) return undefined;
    const hit = this.entries.get(key) ?? null;
    this.entries.delete(key); // most recently used goes last
    this.entries.set(key, hit);
    return hit;
  }

  /** Keep stripLayers() output (and only that) for this version of this design's scene. */
  set(designId: string, hash: string, given: Uint8Array | null): void {
    // Exact size: a view sharing a larger buffer is copied out of it, so an
    // entry never keeps someone else's bytes alive, or hidden from the cap.
    const stripped = given && (given.byteOffset !== 0 || given.buffer.byteLength !== given.byteLength) ? new Uint8Array(given) : given;
    const old = this.versionOf.get(designId);
    if (old !== undefined) this.remove(`${designId}:${old}`);
    const key = `${designId}:${hash}`;
    this.entries.set(key, stripped);
    this.versionOf.set(designId, hash);
    this.bytes += StrippedSceneCache.cost(stripped);
    for (const k of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.remove(k);
    }
  }

  private remove(key: string): void {
    if (!this.entries.has(key)) return;
    const v = this.entries.get(key) ?? null;
    this.entries.delete(key);
    this.bytes -= StrippedSceneCache.cost(v);
    const id = key.slice(0, key.lastIndexOf(':'));
    if (this.versionOf.get(id) === key.slice(key.lastIndexOf(':') + 1)) this.versionOf.delete(id);
  }

  /** What is kept, for the tests that check no layer is ever in it. */
  values(): (Uint8Array | null)[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }
}
