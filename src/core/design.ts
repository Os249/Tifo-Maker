import type { DesignState, SeatMap, SparseDiff } from './types';

type DirtyListener = (indices: number[] | 'all') => void;

/**
 * What the layer stack lends the store (see core/composer.ts).
 *
 * The store owns the Paint layer (`base`) and the flattened seats (`cells`);
 * the stack owns the objects above the paint. A stroke asks `route(i)` which
 * layer is showing at a seat — "tools edit what is on top" — and a stroke over
 * a picture becomes a touch-up on that picture through `touch`.
 */
export interface LayerHooks {
  /** Index of the object showing at seat i, or -1 for the Paint layer. */
  route(i: number): number;
  /** The top object's value at seat i, or -1 when the paint is showing. */
  top(i: number): number;
  /** Touch up object `owner` at seat i. Returns the seat's new flattened value, or -1 if nothing changed. */
  touch(owner: number, i: number, value: number): number;
  strokeBegin(): void;
  /** The objects before and after the stroke, when it touched any. */
  strokeEnd(): ObjectsChange | null;
  /** Put every object the stroke touched back. */
  strokeCancel(): void;
  /** Replace the objects with a snapshot (undo/redo) and flatten again. */
  restore(snapshot: unknown): void;
  /** Recompute `cells` at these seats from the paint and the objects. */
  recompose(indices: ArrayLike<number> | 'all'): void;
  /** Re-index the objects' colours after a palette remap. */
  remap(remap: number[]): ObjectsChange | null;
}

export interface ObjectsChange {
  before: unknown;
  after: unknown;
}

/** One undo step. A paint stroke can also have touched objects; a group is several steps as one. */
type HistoryEntry =
  | { t: 'paint'; diff: SparseDiff; objs: ObjectsChange | null }
  | { t: 'objs'; change: ObjectsChange }
  | { t: 'group'; list: HistoryEntry[] };

/**
 * Owns the design's cell buffer and its history.
 *
 * Lives OUTSIDE any UI framework — the renderer reads `cells` directly and
 * receives dirty-index notifications; React/DOM only ever holds UI state.
 *
 * Every mutation goes through a stroke: beginStroke() → paint(i, v)* → commitStroke().
 * First-touch old values are recorded, so a whole brush drag becomes ONE SparseDiff —
 * the same format used for autosave payloads, revision history, and future realtime sync.
 */
export class DesignStore {
  /**
   * The seats as everyone sees them: the Paint layer with every visible object
   * flattened on top. Every reader in the app — the editor, Match Day, the
   * exports, the thumbnails — reads this, so none of them needs to know that
   * layers exist.
   */
  readonly cells: Uint8Array;
  /** The Paint layer: the bottom of the stack, and the only layer a design without objects has. */
  readonly base: Uint8Array;
  palette: string[];
  readonly seatMapRef: DesignState['seatMapRef'];

  /** Before-values of the Paint layer, for the stroke in progress. */
  private strokeOld: Map<number, number> | null = null;
  private locked: Uint8Array | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private layers: LayerHooks | null = null;
  /** >0 while a stroke may only write the Paint layer (patterns, fill base, orientation). */
  private baseOnly = 0;
  /** Open groups: steps pushed while one is open become one undo step. */
  private groups: HistoryEntry[][] = [];
  private listeners: DirtyListener[] = [];
  private paletteListeners: (() => void)[] = [];
  private historyListeners: (() => void)[] = [];

  /** Max undo depth; a diff is typically a few hundred bytes, so this is cheap. */
  private static readonly MAX_UNDO = 200;

  /** Max distinct colors. One byte per seat, so 256 is the hard ceiling; a
   * tifo realistically uses a handful. The palette is the design's swatch set. */
  static readonly MAX_COLORS = 256;

  constructor(map: SeatMap, palette: string[]) {
    this.cells = new Uint8Array(map.count);
    this.base = new Uint8Array(map.count);
    this.palette = palette.slice(0, DesignStore.MAX_COLORS);
    this.seatMapRef = map.templateRef;
  }

  onDirty(fn: DirtyListener): void {
    this.listeners.push(fn);
  }

  /** Notified whenever the palette colors change (preset swap or swatch edit). */
  onPaletteChange(fn: () => void): void {
    this.paletteListeners.push(fn);
  }

  /**
   * Notified whenever the undo/redo stacks change.
   *
   * This exists because `onDirty` cannot answer "can I undo yet". A brush
   * stroke paints and flushes on every pointer event and only COMMITS on
   * pointerup, so at the moment of the last dirty notification the stroke is
   * not on the undo stack. The Undo button, refreshed from onDirty, therefore
   * sat greyed out immediately after the stroke that created something to
   * undo — and only lit up during the NEXT stroke, always one behind.
   * (Fill never showed it: fill commits before it flushes.)
   */
  onHistoryChange(fn: () => void): void {
    this.historyListeners.push(fn);
  }

  private notifyHistory(): void {
    for (const fn of this.historyListeners) fn();
  }

  /** Detach a dirty listener (for views that mount/unmount, e.g. the simulator). */
  offDirty(fn: DirtyListener): void {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** Detach a palette listener. */
  offPaletteChange(fn: () => void): void {
    const i = this.paletteListeners.indexOf(fn);
    if (i >= 0) this.paletteListeners.splice(i, 1);
  }

  /**
   * Replace the palette and notify every view. The single funnel for palette
   * changes — callers must use this rather than assigning `palette` directly,
   * so the 2D editor AND 3D preview both recolor and never drift apart.
   */
  setPalette(palette: string[]): void {
    this.palette = palette.slice(0, DesignStore.MAX_COLORS);
    for (const fn of this.paletteListeners) fn();
  }

  /**
   * Add a color to the swatch set (the design's living palette). Returns the
   * index to paint with. Dedupes case-insensitively so picking a color that's
   * already a swatch just selects it rather than piling up duplicates. Does NOT
   * touch any seats — adding a swatch never repaints the design.
   */
  addSwatch(hex: string): number {
    const norm = hex.toLowerCase();
    const existing = this.palette.findIndex((c) => c.toLowerCase() === norm);
    if (existing >= 0) return existing;
    if (this.palette.length >= DesignStore.MAX_COLORS) return this.palette.length - 1;
    this.palette = [...this.palette, hex];
    for (const fn of this.paletteListeners) fn();
    return this.palette.length - 1;
  }

  /**
   * Edit one swatch's color in place. This DOES recolor every seat painted with
   * that index — but that's the intended, explicit "change this color" action
   * (double-click a swatch), not a side effect of switching palettes.
   */
  setSwatch(index: number, hex: string): void {
    if (index < 0 || index >= this.palette.length || this.palette[index] === hex) return;
    this.palette = this.palette.map((c, i) => (i === index ? hex : c));
    for (const fn of this.paletteListeners) fn();
  }

  /**
   * Merge another palette's colors into the swatch set WITHOUT repainting:
   * existing colors keep their index; genuinely new colors append. Returns the
   * mapping from the incoming palette's indices to the merged indices (useful
   * when importing a design authored against a different palette).
   */
  addPaletteColors(incoming: string[]): number[] {
    const map: number[] = [];
    let changed = false;
    for (const hex of incoming) {
      const norm = hex.toLowerCase();
      let idx = this.palette.findIndex((c) => c.toLowerCase() === norm);
      if (idx < 0 && this.palette.length < DesignStore.MAX_COLORS) {
        this.palette = [...this.palette, hex];
        idx = this.palette.length - 1;
        changed = true;
      }
      map.push(idx < 0 ? 0 : idx);
    }
    if (changed) for (const fn of this.paletteListeners) fn();
    return map;
  }

  /**
   * Replace the palette with a new one AND remap every seat so the design keeps
   * its appearance as closely as possible: each old color is matched to the
   * nearest color in the new palette. This is the "remap design onto this
   * palette" choice — an explicit, undoable recolor. The Paint layer and every
   * object on it are remapped together, as one step.
   */
  remapToPalette(newPalette: string[]): void {
    const next = newPalette.slice(0, DesignStore.MAX_COLORS);
    if (next.length === 0) return;
    // Build old-index → new-index by nearest color.
    const remap = this.palette.map((oldHex) => nearestColorIndex(oldHex, next));
    const old = new Map<number, number>();
    for (let i = 0; i < this.base.length; i++) {
      if (this.locked && this.locked[i] === 1) continue;
      const oldIdx = this.base[i];
      const newIdx = remap[oldIdx] ?? 0;
      if (newIdx !== oldIdx) {
        if (!old.has(i)) old.set(i, oldIdx);
        this.base[i] = newIdx;
      }
    }
    this.palette = next;
    const objs = this.layers ? this.layers.remap(remap) : null;
    if (old.size > 0 || objs) {
      const entries = [...old.entries()];
      this.push({
        t: 'paint',
        diff: {
          indices: new Uint32Array(entries.map(([i]) => i)),
          before: new Uint8Array(entries.map(([, v]) => v)),
          after: new Uint8Array(entries.map(([i]) => this.base[i])),
        },
        objs,
      });
    }
    for (const fn of this.paletteListeners) fn();
    this.recompose('all');
    this.notify('all');
  }

  /**
   * Seats that never take the tifo — a royal box, where nobody holds up a
   * card (see SeatZone.noTifo). Locked seats are cleared now and every write
   * path leaves them empty, so the design itself says so: the editor, the AI,
   * an import, the card-distribution PDF and the seat lookup all agree with
   * the 3D view without each needing to know about zones.
   */
  setLockedSeats(mask: Uint8Array | null): void {
    this.locked = mask && mask.length === this.cells.length ? mask : null;
    if (!this.locked) return;
    const dirty: number[] = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.locked[i]) {
        this.base[i] = 0;
        if (this.cells[i] !== 0) {
          this.cells[i] = 0;
          dirty.push(i);
        }
      }
    }
    if (dirty.length) this.notify(dirty);
  }

  /** Is this seat locked out of the tifo? */
  isLocked(index: number): boolean {
    return !!this.locked && this.locked[index] === 1;
  }

  /** The locked-seat mask, for the layer stack (a stamp never covers one). */
  lockedMask(): Uint8Array | null {
    return this.locked;
  }

  private notify(indices: number[] | 'all'): void {
    for (const fn of this.listeners) fn(indices);
  }

  // ---- layers -------------------------------------------------------------

  /** Plug the layer stack in. Until then the store is exactly the flat store it always was. */
  attachLayers(hooks: LayerHooks | null): void {
    this.layers = hooks;
  }

  /** Recompute flattened seats (no notification; callers notify). */
  private recompose(indices: ArrayLike<number> | 'all'): void {
    if (this.layers) this.layers.recompose(indices);
    else if (indices === 'all') this.cells.set(this.base);
    else for (let k = 0; k < indices.length; k++) this.cells[indices[k]] = this.base[indices[k]];
  }

  /**
   * Record an object change as one undo step (add, move, rename, reorder…).
   * The layer stack calls this; nothing else should need to.
   */
  pushObjects(change: ObjectsChange): void {
    this.push({ t: 'objs', change });
  }

  /**
   * Run `fn` so every step it records becomes ONE undo step — merging a
   * picture into the paint, lifting a region into a layer, applying an AI
   * design. Nested groups fold into the outermost.
   */
  group<T>(fn: () => T): T {
    this.groups.push([]);
    let out: T;
    try {
      out = fn();
    } finally {
      const list = this.groups.pop()!;
      if (list.length === 1) this.push(list[0]);
      else if (list.length > 1) this.push({ t: 'group', list });
    }
    return out;
  }

  private push(entry: HistoryEntry): void {
    const open = this.groups[this.groups.length - 1];
    if (open) {
      open.push(entry);
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > DesignStore.MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    this.notifyHistory();
  }

  /**
   * Run a stroke that writes the Paint layer only, whatever is on top — a
   * whole-bowl pattern, Fill base, re-orienting the design. A background is
   * painted behind the pictures, not over them.
   */
  paintBaseOnly(fn: () => void): void {
    this.baseOnly++;
    try {
      fn();
    } finally {
      this.baseOnly--;
    }
  }

  /**
   * Replace the Paint layer without history — restoring a saved stack, whose
   * objects are then put back on top of it.
   */
  setBase(base: Uint8Array): void {
    this.base.set(base.subarray(0, this.base.length));
    if (this.locked) for (let i = 0; i < this.base.length; i++) if (this.locked[i]) this.base[i] = 0;
    this.recompose('all');
    this.notify('all');
  }

  // ---- strokes --------------------------------------------------------------

  beginStroke(): void {
    this.strokeOld = new Map();
    this.layers?.strokeBegin();
  }

  /**
   * Paint one cell inside an active stroke. No-ops if the value is unchanged.
   *
   * The seat goes to whatever is showing there: the Paint layer, or — when a
   * picture, text or shape is on top — that object, as a touch-up that moves
   * with it. Painting never disappears under a picture.
   */
  paint(index: number, value: number): boolean {
    if (this.locked && this.locked[index] === 1) return false;
    const L = this.layers;
    if (L && this.baseOnly === 0) {
      const owner = L.route(index);
      if (owner >= 0) {
        const nv = L.touch(owner, index, value);
        if (nv < 0 || nv === this.cells[index]) return false;
        this.cells[index] = nv;
        return true;
      }
    }
    if (this.base[index] === value) return false;
    if (this.strokeOld && !this.strokeOld.has(index)) {
      this.strokeOld.set(index, this.base[index]);
    }
    this.base[index] = value;
    if (L) {
      const t = L.top(index);
      const shown = t >= 0 ? t : value;
      if (this.cells[index] === shown) return false;
      this.cells[index] = shown;
    } else {
      this.cells[index] = value;
    }
    return true;
  }

  /**
   * Abandon the stroke in progress and put every cell it touched back.
   *
   * A touch that turns out to be the start of a two-finger gesture has already
   * painted a dab by the time the second finger lands — there is no way to know
   * in advance, and delaying the first dab would put latency on every stroke.
   * Committing that dab meant a two-finger tap (undo) spent itself undoing the
   * accident instead of the user's last real action: the toast said "Undone"
   * and nothing the user recognised changed.
   */
  cancelStroke(): number[] {
    const old = this.strokeOld;
    this.strokeOld = null;
    this.layers?.strokeCancel();
    if (!old || old.size === 0) return [];
    const dirty: number[] = [];
    for (const [i, before] of old) {
      this.base[i] = before;
      dirty.push(i);
    }
    this.recompose(dirty);
    this.notify(dirty);
    return dirty;
  }

  /** Close the stroke into a single undoable step. */
  commitStroke(): SparseDiff | null {
    const old = this.strokeOld;
    this.strokeOld = null;
    const objs = this.layers ? this.layers.strokeEnd() : null;
    // Drop entries that ended up back at their original value (e.g. paint then erase).
    const entries = old ? [...old.entries()].filter(([i, before]) => this.base[i] !== before) : [];
    if (entries.length === 0 && !objs) return null;
    const diff: SparseDiff = {
      indices: new Uint32Array(entries.map(([i]) => i)),
      before: new Uint8Array(entries.map(([, v]) => v)),
      after: new Uint8Array(entries.map(([i]) => this.base[i])),
    };
    this.push({ t: 'paint', diff, objs });
    return diff;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.apply(entry, 'before');
    this.redoStack.push(entry);
    this.notifyHistory();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.apply(entry, 'after');
    this.undoStack.push(entry);
    this.notifyHistory();
  }

  private apply(entry: HistoryEntry, side: 'before' | 'after'): void {
    if (entry.t === 'group') {
      const list = side === 'before' ? [...entry.list].reverse() : entry.list;
      for (const e of list) this.apply(e, side);
      return;
    }
    if (entry.t === 'objs') {
      this.layers?.restore(entry.change[side]);
      return;
    }
    const { diff, objs } = entry;
    this.applyValues(diff.indices, side === 'before' ? diff.before : diff.after);
    // The objects the stroke touched come back after the paint under them.
    if (objs) this.layers?.restore(objs[side]);
  }

  private applyValues(indices: Uint32Array, values: Uint8Array): void {
    const dirty: number[] = new Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      this.base[indices[k]] = this.locked && this.locked[indices[k]] === 1 ? 0 : values[k];
      dirty[k] = indices[k];
    }
    this.recompose(dirty);
    if (dirty.length) this.notify(dirty);
  }

  /** Notify the renderer after tool code mutates cells via paint() (or the layer stack re-flattens). */
  flush(indices: number[] | 'all'): void {
    if (indices === 'all' || indices.length) this.notify(indices);
  }

  /** Rewrite every Paint-layer cell via a pure function (one undo step). */
  transform(next: (index: number) => number): void {
    this.paintBaseOnly(() => {
      this.beginStroke();
      for (let i = 0; i < this.cells.length; i++) this.paint(i, next(i));
      this.commitStroke();
    });
    this.notify('all');
  }

  /** Reset every Paint-layer cell to one palette index (undoable). */
  fillAll(value: number): void {
    this.transform(() => value);
  }

  /** Serialize for save/export. Compress with gzip before upload (~2–8 KB). */
  toState(): DesignState {
    return { seatMapRef: this.seatMapRef, palette: this.palette, cells: this.cells.slice() };
  }

  /**
   * Load a flat design: it becomes the Paint layer, and the history starts
   * over. Whoever loads objects on top does that afterwards.
   */
  loadCells(cells: Uint8Array): void {
    this.base.set(cells.subarray(0, this.base.length));
    if (this.locked) for (let i = 0; i < this.base.length; i++) if (this.locked[i]) this.base[i] = 0;
    this.recompose('all');
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notifyHistory();
    this.notify('all');
  }
}

/** Parse #rgb or #rrggbb to [r,g,b]; tolerant of a missing leading #. */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Index of the nearest color in `palette` to `hex`, by squared RGB distance. */
function nearestColorIndex(hex: string, palette: string[]): number {
  const [r, g, b] = hexToRgb(hex);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = hexToRgb(palette[i]);
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
