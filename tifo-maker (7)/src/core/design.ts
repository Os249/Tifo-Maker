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

  constructor(map: SeatMap, palette: string[]) {
    this.cells = new Uint8Array(map.count);
    this.palette = palette.slice(0, 8);
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
   * Replace the palette and notify every view. The single funnel for palette
   * changes — callers must use this rather than assigning `palette` directly,
   * so the 2D editor AND 3D preview both recolor and never drift apart.
   */
  setPalette(palette: string[]): void {
    this.palette = palette.slice(0, 8);
    for (const fn of this.paletteListeners) fn();
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
