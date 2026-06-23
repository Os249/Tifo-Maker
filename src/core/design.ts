import type { DesignState, SeatMap, SparseDiff } from './types';

type DirtyListener = (indices: number[] | 'all') => void;

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
  readonly cells: Uint8Array;
  palette: string[];
  readonly seatMapRef: DesignState['seatMapRef'];

  private strokeOld: Map<number, number> | null = null;
  private undoStack: SparseDiff[] = [];
  private redoStack: SparseDiff[] = [];
  private listeners: DirtyListener[] = [];
  private paletteListeners: (() => void)[] = [];

  /** Max undo depth; a diff is typically a few hundred bytes, so this is cheap. */
  private static readonly MAX_UNDO = 200;

  /** Max distinct colors. One byte per seat, so 256 is the hard ceiling; a
   * tifo realistically uses a handful. The palette is the design's swatch set. */
  static readonly MAX_COLORS = 256;

  constructor(map: SeatMap, palette: string[]) {
    this.cells = new Uint8Array(map.count);
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
   * palette" choice — an explicit, undoable recolor.
   */
  remapToPalette(newPalette: string[]): void {
    const next = newPalette.slice(0, DesignStore.MAX_COLORS);
    if (next.length === 0) return;
    // Build old-index → new-index by nearest color.
    const remap = this.palette.map((oldHex) => nearestColorIndex(oldHex, next));
    const old = new Map<number, number>();
    for (let i = 0; i < this.cells.length; i++) {
      const oldIdx = this.cells[i];
      const newIdx = remap[oldIdx] ?? 0;
      if (newIdx !== oldIdx) {
        if (!old.has(i)) old.set(i, oldIdx);
        this.cells[i] = newIdx;
      }
    }
    this.palette = next;
    if (old.size > 0) {
      const entries = [...old.entries()];
      this.undoStack.push({
        indices: new Uint32Array(entries.map(([i]) => i)),
        before: new Uint8Array(entries.map(([, v]) => v)),
        after: new Uint8Array(entries.map(([i]) => this.cells[i])),
      });
      if (this.undoStack.length > DesignStore.MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
    }
    for (const fn of this.paletteListeners) fn();
    this.notify('all');
  }

  private notify(indices: number[] | 'all'): void {
    for (const fn of this.listeners) fn(indices);
  }

  beginStroke(): void {
    this.strokeOld = new Map();
  }

  /** Paint one cell inside an active stroke. No-ops if the value is unchanged. */
  paint(index: number, value: number): boolean {
    if (this.cells[index] === value) return false;
    if (this.strokeOld && !this.strokeOld.has(index)) {
      this.strokeOld.set(index, this.cells[index]);
    }
    this.cells[index] = value;
    return true;
  }

  /** Close the stroke into a single undoable SparseDiff. */
  commitStroke(): SparseDiff | null {
    const old = this.strokeOld;
    this.strokeOld = null;
    if (!old || old.size === 0) return null;
    // Drop entries that ended up back at their original value (e.g. paint then erase).
    const entries = [...old.entries()].filter(([i, before]) => this.cells[i] !== before);
    if (entries.length === 0) return null;
    const diff: SparseDiff = {
      indices: new Uint32Array(entries.map(([i]) => i)),
      before: new Uint8Array(entries.map(([, v]) => v)),
      after: new Uint8Array(entries.map(([i]) => this.cells[i])),
    };
    this.undoStack.push(diff);
    if (this.undoStack.length > DesignStore.MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    return diff;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const diff = this.undoStack.pop();
    if (!diff) return;
    this.applyValues(diff.indices, diff.before);
    this.redoStack.push(diff);
  }

  redo(): void {
    const diff = this.redoStack.pop();
    if (!diff) return;
    this.applyValues(diff.indices, diff.after);
    this.undoStack.push(diff);
  }

  private applyValues(indices: Uint32Array, values: Uint8Array): void {
    const dirty: number[] = new Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      this.cells[indices[k]] = values[k];
      dirty[k] = indices[k];
    }
    this.notify(dirty);
  }

  /** Notify the renderer after tool code mutates cells via paint(). */
  flush(indices: number[]): void {
    if (indices.length) this.notify(indices);
  }

  /** Rewrite every cell via a pure function (one undo step). */
  transform(next: (index: number) => number): void {
    this.beginStroke();
    for (let i = 0; i < this.cells.length; i++) this.paint(i, next(i));
    this.commitStroke();
    this.notify('all');
  }

  /** Reset every cell to one palette index (undoable). */
  fillAll(value: number): void {
    this.transform(() => value);
  }

  /** Serialize for save/export. Compress with gzip before upload (~2–8 KB). */
  toState(): DesignState {
    return { seatMapRef: this.seatMapRef, palette: this.palette, cells: this.cells.slice() };
  }

  loadCells(cells: Uint8Array): void {
    this.cells.set(cells.subarray(0, this.cells.length));
    this.undoStack.length = 0;
    this.redoStack.length = 0;
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
