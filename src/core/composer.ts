import type { SeatMap } from './types';
import type { DesignStore, LayerHooks } from './design';
import type { Region } from './tifoSpec';
import {
  type Grid, type Stamp, EMPTY_STAMP, HOLE, bytesFromJSON, bytesToJSON, cellIndex, cloneGrid,
  fingerprint, flatten, localUV, objectValueAt, stampObject,
} from './layers';
import {
  ObjectLayer, ensureGrid, objectFromJSON, objectToJSON,
  type CellsObject, type ObjectJSON, type TifoObject,
} from './objects';
import type { TifoFont } from './text';
import { EDITOR_UNITS } from './seatmap';

/**
 * The layer stack, put together.
 *
 * Owns the flattening of the objects onto the Paint layer (`store.cells` is the
 * result, and it is all anyone else reads) and lends the store the hooks a
 * stroke needs to paint on whatever is showing. A drag re-stamps only the
 * object being dragged — about a millisecond on a 90,000-seat bowl — so the
 * seats you see while you drag are the seats you get.
 */

export interface ComposerOptions {
  /** The unrolled bowl's width: objects wrap across the seam. */
  wrapWidth: number;
  /** A clip for "keep inside" regions (the AI's stands). */
  clipFor?: (region: Region) => ((i: number) => boolean) | null;
}

/** A saved stack. */
export interface LayerDoc {
  v: 1;
  /** Fingerprint of the flattened seats this stack produces — it is only trusted when they match. */
  hash: string;
  /** The Paint layer, base64. */
  paint: string;
  objects: ObjectJSON[];
}

export class Composer {
  /** Index into the visible objects of the one showing at each seat (-1: paint). */
  readonly owner: Int16Array;
  /** The value that object shows there (-1: paint). */
  readonly top: Int16Array;
  private readonly mark: Uint8Array;
  private visible: TifoObject[] = [];
  private stamps: Stamp[] = [];
  private cache = new Map<string, { key: string; stamp: Stamp }>();
  private gridIds = new WeakMap<object, number>();
  private gridSeq = 0;
  private clipCache = new Map<string, ((i: number) => boolean) | null>();
  private strokeBefore: TifoObject[] | null = null;
  private strokeTouched = new Set<TifoObject>();
  /**
   * Where each seat went on its first touch in the stroke in progress. A
   * stroke keeps to the layers it started on: an eraser that has cut through a
   * picture must not carry on and erase the paint under the hole on its next
   * pass over the same seat.
   */
  private strokeRoutes: Map<number, number> | null = null;
  /** The last object a stroke could not paint on because it is locked (for the UI to say so). */
  lockedHit: TifoObject | null = null;
  private syncing = false;

  constructor(
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    readonly layer: ObjectLayer,
    private readonly opts: ComposerOptions,
  ) {
    this.owner = new Int16Array(map.count).fill(-1);
    this.top = new Int16Array(map.count).fill(-1);
    this.mark = new Uint8Array(map.count);
    store.attachLayers(this.hooks());
    layer.recorder = (change) => store.pushObjects(change);
    layer.onChange((why) => {
      if (why === 'content') this.sync();
    });
  }

  // ---- flattening -----------------------------------------------------------

  private idOf(g: object | null | undefined): number {
    if (!g) return 0;
    let id = this.gridIds.get(g);
    if (!id) {
      id = ++this.gridSeq;
      this.gridIds.set(g, id);
    }
    return id;
  }

  private keyOf(o: TifoObject): string {
    const keep = o.keep ? JSON.stringify(o.keep) : '';
    return `${o.cx}|${o.cy}|${o.width}|${o.height}|${o.rotation}|${o.tier}|${keep}|${this.idOf(o.grid)}|${this.idOf(o.touch)}`;
  }

  /** The seats an object may cover: its tier and its "keep inside" region. */
  clipOf(o: TifoObject): ((i: number) => boolean) | null {
    const k = `${o.tier}|${o.keep ? JSON.stringify(o.keep) : ''}`;
    if (this.clipCache.has(k)) return this.clipCache.get(k)!;
    const tier = o.tier;
    const region = o.keep && this.opts.clipFor ? this.opts.clipFor(o.keep) : null;
    const tierOf = this.map.tierOf;
    let fn: ((i: number) => boolean) | null = null;
    if (tier !== null && region) fn = (i) => tierOf[i] === tier && region(i);
    else if (tier !== null) fn = (i) => tierOf[i] === tier;
    else if (region) fn = region;
    this.clipCache.set(k, fn);
    return fn;
  }

  private stampOf(o: TifoObject): Stamp {
    return stampObject(this.map, o, o.grid ?? null, o.touch ?? null, this.opts.wrapWidth, this.clipOf(o), this.store.lockedMask());
  }

  /** The stamp an object has now (cached by position, size, raster and touch-ups). */
  stampFor(o: TifoObject): Stamp {
    const key = this.keyOf(o);
    const hit = this.cache.get(o.id);
    if (hit && hit.key === key) return hit.stamp;
    const stamp = this.stampOf(o);
    this.cache.set(o.id, { key, stamp });
    return stamp;
  }

  /**
   * Bring the flattened seats up to date with the objects. A reorder, a new
   * or removed layer, a hide flattens everything; a move flattens only the
   * seats the moved object left and the seats it now covers.
   */
  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const all = this.layer.list();
      const liveId = this.layer.live ? this.layer.selected?.id : undefined;
      for (const o of all) {
        if (o.hidden || o.id === liveId) continue;
        ensureGrid(o, this.store.palette);
      }
      const next = all.filter((o) => !o.hidden);
      const nextStamps = next.map((o) => this.stampFor(o));
      const sameOrder = next.length === this.visible.length && next.every((o, k) => o.id === this.visible[k].id);
      const ids = new Set(all.map((o) => o.id));
      for (const id of [...this.cache.keys()]) if (!ids.has(id)) this.cache.delete(id);
      if (!sameOrder) {
        this.visible = next;
        this.stamps = nextStamps;
        this.flattenAll();
        this.store.flush('all');
        return;
      }
      const region: number[] = [];
      const add = (st: Stamp): void => {
        for (let j = 0; j < st.seats.length; j++) {
          const i = st.seats[j];
          if (this.mark[i] === 2) continue;
          this.mark[i] = 2;
          region.push(i);
        }
      };
      for (let k = 0; k < next.length; k++) {
        if (nextStamps[k] === this.stamps[k]) continue;
        add(this.stamps[k]);
        add(nextStamps[k]);
      }
      for (const i of region) this.mark[i] = 0;
      this.visible = next;
      this.stamps = nextStamps;
      if (region.length === 0) return;
      flatten(this.store.cells, this.owner, this.top, this.store.base, this.stamps, region, this.mark);
      this.store.flush(region);
    } finally {
      this.syncing = false;
    }
  }

  private flattenAll(): void {
    flatten(this.store.cells, this.owner, this.top, this.store.base, this.stamps, null, this.mark);
  }

  /** Forget every cached stamp and flatten from scratch (the locked seats changed, say). */
  refreshAll(): void {
    this.cache.clear();
    this.clipCache.clear();
    this.visible = [];
    this.sync();
    this.flattenAll();
    this.store.flush('all');
  }

  /** The object showing at a seat, or null when it is the paint. */
  objectAtSeat(i: number): TifoObject | null {
    const k = this.owner[i];
    return k >= 0 ? this.visible[k] ?? null : null;
  }

  // ---- the store's hooks ------------------------------------------------------

  private hooks(): LayerHooks {
    return {
      route: (i) => {
        const memo = this.strokeRoutes;
        if (!memo) return this.owner[i];
        const k = memo.get(i);
        if (k !== undefined) return k;
        memo.set(i, this.owner[i]);
        return this.owner[i];
      },
      top: (i) => this.top[i],
      touch: (k, i, value) => this.touchAt(k, i, value),
      strokeBegin: () => {
        this.strokeBefore = null;
        this.strokeTouched.clear();
        this.strokeRoutes = new Map();
        this.lockedHit = null;
      },
      strokeEnd: () => {
        this.strokeRoutes = null;
        if (!this.strokeBefore) return null;
        const before = this.strokeBefore;
        this.strokeBefore = null;
        // Re-stamp what was touched: a touch-up cell can cover a neighbouring
        // seat too, and that seat has not been redrawn yet.
        for (const o of this.strokeTouched) this.cache.delete(o.id);
        this.strokeTouched.clear();
        this.sync();
        return { before, after: this.layer.snapshot() };
      },
      strokeCancel: () => {
        this.strokeRoutes = null;
        const before = this.strokeBefore;
        this.strokeBefore = null;
        this.strokeTouched.clear();
        if (before) this.layer.restore(before);
      },
      restore: (snapshot) => this.layer.restore(snapshot),
      recompose: (indices) => {
        if (indices === 'all') this.flattenAll();
        else flatten(this.store.cells, this.owner, this.top, this.store.base, this.stamps, indices, this.mark);
      },
      remap: (remap) => this.layer.remapColours(remap),
    };
  }

  /** The value object `o` gives seat i, honouring its clip; -1 when none. */
  private valueOf(o: TifoObject, i: number): number {
    const uv = localUV(o, this.map.xy[i * 2], this.map.xy[i * 2 + 1], this.opts.wrapWidth);
    if (!uv) return -1;
    const clip = this.clipOf(o);
    if (clip && !clip(i)) return -1;
    return objectValueAt(o.grid ?? null, o.touch ?? null, uv[0], uv[1]);
  }

  /**
   * A stroke landed on an object: touch it up, in its own frame, so the fix
   * moves with it. The eraser cuts a hole to whatever is below.
   */
  private touchAt(k: number, i: number, value: number): number {
    const o = this.visible[k];
    if (!o) return -1;
    if (o.locked) {
      this.lockedHit = o;
      return -1;
    }
    const uv = localUV(o, this.map.xy[i * 2], this.map.xy[i * 2 + 1], this.opts.wrapWidth);
    if (!uv) return -1;
    const tv = value === 0 ? HOLE : value;
    if (!this.strokeBefore) this.strokeBefore = this.layer.snapshot();
    if (!this.strokeTouched.has(o)) {
      // Copy on write: the undo snapshot keeps the touch-ups as they were.
      o.touch = o.touch ? cloneGrid(o.touch) : newTouchGrid(o);
      this.strokeTouched.add(o);
    }
    const touch = o.touch!;
    const c = cellIndex(touch, uv[0], uv[1]);
    if (touch.data[c] === tv) return -1;
    touch.data[c] = tv;
    if (tv !== HOLE) {
      this.top[i] = tv;
      return tv;
    }
    // A hole: what shows through is the next object down, or the paint.
    for (let m = k - 1; m >= 0; m--) {
      const val = this.valueOf(this.visible[m], i);
      if (val >= 0) {
        this.owner[i] = m;
        this.top[i] = val;
        return val;
      }
    }
    this.owner[i] = -1;
    this.top[i] = -1;
    return this.store.base[i];
  }

  // ---- operations that change paint and layers together ------------------------

  /**
   * Merge a layer into the paint — the old Bake, now a choice. One undo step.
   * Returns the number of seats it covered.
   */
  merge(id: string): number {
    const o = this.layer.get(id);
    if (!o) return 0;
    ensureGrid(o, this.store.palette);
    const stamp = o.hidden ? EMPTY_STAMP : this.stampFor(o);
    this.store.group(() => {
      this.store.paintBaseOnly(() => {
        this.store.beginStroke();
        for (let j = 0; j < stamp.seats.length; j++) this.store.paint(stamp.seats[j], stamp.vals[j]);
        this.store.commitStroke();
      });
      this.layer.remove(id);
    });
    return stamp.seats.length;
  }

  /** Merge every layer into the paint, bottom to top. One undo step. */
  mergeAll(): number {
    let n = 0;
    this.store.group(() => {
      for (const o of [...this.layer.list()]) n += this.merge(o.id);
    });
    return n;
  }

  /**
   * Make movable: lift painted seats off the Paint layer into a layer of their
   * own. Only seats where the paint is showing are lifted — a picture is
   * already a layer. The gap left behind takes `fill`, or, by default, the
   * colour most common around it. One undo step. Returns the new layer.
   */
  lift(selection: Iterable<number>, fill: number | 'auto' = 'auto'): CellsObject | null {
    const W = this.opts.wrapWidth;
    const xy = this.map.xy;
    const seats: number[] = [];
    for (const i of selection) if (this.owner[i] < 0 && !this.store.isLocked(i)) seats.push(i);
    if (seats.length === 0) return null;
    // Across the seam, keep the region in one piece.
    let minX = Infinity, maxX = -Infinity;
    for (const i of seats) {
      minX = Math.min(minX, xy[i * 2]);
      maxX = Math.max(maxX, xy[i * 2]);
    }
    const shift = maxX - minX > W / 2 ? W : 0;
    const X = (i: number): number => (shift && xy[i * 2] < W / 2 ? xy[i * 2] + shift : xy[i * 2]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of seats) {
      const x = X(i);
      const y = xy[i * 2 + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    // A cell is half a seat each way, so a lifted region re-stamps exactly
    // where it came from and still reads as solid when moved elsewhere.
    const CW = EDITOR_UNITS.colPx / 2;
    const CH = EDITOR_UNITS.rowPx / 2;
    const PADX = EDITOR_UNITS.colPx * 0.56;
    const PADY = EDITOR_UNITS.rowPx * 0.53;
    const left = x0 - PADX;
    const topY = y0 - PADY;
    const cols = Math.max(2, Math.min(4800, Math.ceil((x1 - x0 + 2 * PADX) / CW)));
    const rows = Math.max(2, Math.min(1600, Math.ceil((y1 - y0 + 2 * PADY) / CH)));
    const data = new Int16Array(cols * rows).fill(-1);
    const base = this.store.base;
    const put = (x: number, y: number, v: number): void => {
      const ix = Math.floor((x - left) / CW);
      const iy = Math.floor((y - topY) / CH);
      if (ix >= 0 && ix < cols && iy >= 0 && iy < rows) data[iy * cols + ix] = v;
    };
    // Fill each seat's footprint, then write each seat's own cell last so the
    // seat itself is exact however close its neighbours sit.
    for (const i of seats) {
      const x = X(i);
      const y = xy[i * 2 + 1];
      for (let yy = y - PADY + CH / 2; yy < y + PADY; yy += CH) {
        for (let xx = x - PADX + CW / 2; xx < x + PADX; xx += CW) put(xx, yy, base[i]);
      }
    }
    for (const i of seats) put(X(i), xy[i * 2 + 1], base[i]);
    // Seats sit a little further apart in some rows than others; close the
    // hairline gaps between footprints in a row (an aisle is far wider).
    for (let r = 0; r < rows; r++) {
      let last = -1;
      for (let c = 0; c < cols; c++) {
        const v = data[r * cols + c];
        if (v < 0) continue;
        if (last >= 0 && c - last > 1 && c - last <= 3) {
          for (let f = last + 1; f < c; f++) data[r * cols + f] = data[r * cols + last];
        }
        last = c;
      }
    }
    // And between rows: rows sit further apart in some stands than others.
    for (let c = 0; c < cols; c++) {
      let last = -1;
      for (let r = 0; r < rows; r++) {
        const v = data[r * cols + c];
        if (v < 0) continue;
        if (last >= 0 && r - last > 1 && r - last <= 3) {
          for (let f = last + 1; f < r; f++) data[f * cols + c] = data[last * cols + c];
        }
        last = r;
      }
    }
    const gap = fill === 'auto' ? this.surroundingColour(seats) : fill;
    let created: CellsObject | null = null;
    this.store.group(() => {
      this.store.paintBaseOnly(() => {
        this.store.beginStroke();
        for (const i of seats) this.store.paint(i, gap);
        this.store.commitStroke();
      });
      created = this.layer.addCells({
        cx: left + (cols * CW) / 2,
        cy: topY + (rows * CH) / 2,
        width: cols * CW,
        height: rows * CH,
        colorIndex: 0,
        tier: null,
        grid: { cols, rows, data },
        gridKey: 'c',
      });
    });
    return created;
  }

  /** The Paint layer's most common colour just outside a region (0 when there is none). */
  private surroundingColour(region: number[]): number {
    const inside = new Uint8Array(this.map.count);
    for (const i of region) inside[i] = 1;
    const counts = new Map<number, number>();
    const nb = this.map.neighbors;
    for (const i of region) {
      for (let k = 0; k < 4; k++) {
        const j = nb[i * 4 + k];
        if (j < 0 || inside[j]) continue;
        const v = this.store.base[j];
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    let best = 0;
    let bestN = -1;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return best;
  }

  // ---- saving -------------------------------------------------------------------

  /** The stack as a saved document, or null when there are no layers (a flat design needs none). */
  toDoc(): LayerDoc | null {
    const list = this.layer.list();
    if (list.length === 0) return null;
    for (const o of list) ensureGrid(o, this.store.palette);
    return {
      v: 1,
      hash: fingerprint(this.store.cells),
      paint: bytesToJSON(this.store.base),
      objects: list.map(objectToJSON),
    };
  }

  /**
   * Put a saved stack back — but only onto the seats it was saved with. If the
   * design's seats were changed by anything that did not know about the
   * layers, the stack no longer describes them, and the flat seats win.
   * Returns true when the layers were restored.
   */
  loadDoc(doc: unknown, fonts: TifoFont[], expectHash?: string): boolean {
    const d = parseDoc(doc, this.map.count, fonts, this.store.palette.length);
    if (!d) return false;
    const want = expectHash ?? fingerprint(this.store.cells);
    if (d.hash !== want) return false;
    const savedBase = this.store.base.slice();
    const savedObjects = this.layer.snapshot();
    this.layer.load(d.objects);
    this.store.setBase(d.paint);
    this.refreshAll();
    if (fingerprint(this.store.cells) !== d.hash) {
      // Flattening did not give back the saved seats: never show a different
      // design from the one saved. Put the flat one back.
      this.layer.load(savedObjects);
      this.store.setBase(savedBase);
      this.refreshAll();
      return false;
    }
    return true;
  }
}

/** A fresh touch-up grid at about one cell per seat. */
function newTouchGrid(o: TifoObject): Grid {
  const cols = Math.max(2, Math.min(2400, Math.round(o.width / EDITOR_UNITS.colPx)));
  const rows = Math.max(2, Math.min(800, Math.round(o.height / EDITOR_UNITS.rowPx)));
  return { cols, rows, data: new Int16Array(cols * rows).fill(-1) };
}

/** Validate a saved stack. */
export function parseDoc(
  doc: unknown,
  seatCount: number,
  fonts: TifoFont[],
  paletteLen: number,
): { hash: string; paint: Uint8Array; objects: TifoObject[] } | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Partial<LayerDoc>;
  if (d.v !== 1 || typeof d.hash !== 'string' || !Array.isArray(d.objects)) return null;
  const paint = bytesFromJSON(d.paint, seatCount);
  if (!paint) return null;
  const objects: TifoObject[] = [];
  for (const j of d.objects.slice(0, 64)) {
    const o = objectFromJSON(j, fonts, paletteLen);
    if (o) objects.push(o);
  }
  return { hash: d.hash, paint, objects };
}
