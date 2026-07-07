import type { SeatMap } from './types';
import type { DesignStore } from './design';
import { applyGridToSeats, enhanceForBake, maskFromAlpha, quantizePixels, rasterize } from './importImage';
import { renderTextCanvas, type TifoFont } from './text';
import { drawSymbol } from './symbols';

/**
 * Floating object layer.
 *
 * Text and images live here as movable/resizable objects ABOVE the seat grid
 * until the user "bakes" them into the cells buffer. This keeps the engine's
 * verified painting + sparse-diff undo untouched: objects are their own state
 * with their own undo, and baking is a single ordinary stroke through
 * applyGridToSeats. An object stores enough to re-render its source canvas at
 * any size (text keeps its string/font/arc; images keep their bitmap), so
 * scaling re-rasterizes crisply rather than stretching pixels.
 */

export interface BaseObject {
  id: string;
  /** Center in editor (xy) coordinates. */
  cx: number;
  cy: number;
  /** Footprint in editor units. */
  width: number;
  height: number;
  /** Palette index used when baking (text + the empty-skip for images). */
  colorIndex: number;
  /** Tier limiting on bake: null = both. */
  tier: number | null;
}

export interface TextObject extends BaseObject {
  kind: 'text';
  text: string;
  fontCss: string;
  fontId: string;
  arcDeg: number;
  /** Letterform height in seats — the sizing anchor (width derives from it). */
  heightSeats: number;
}

export interface ImageObject extends BaseObject {
  kind: 'image';
  bitmap: ImageBitmap;
  name: string;
  dither: boolean;
  halftone?: boolean;
  alphaThreshold: number;
}

export interface ShapeObject extends BaseObject {
  kind: 'shape';
  /** A SHAPE_NAMES entry (rect, ellipse, star, shield, …). Drawn as a 1-colour mask. */
  shape: string;
}

export type TifoObject = TextObject | ImageObject | ShapeObject;

type Listener = () => void;

/** Holds the floating objects, selection, and an object-level undo stack. */
export class ObjectLayer {
  private objects: TifoObject[] = [];
  private selectedId: string | null = null;
  private listeners: Listener[] = [];
  private undoStack: TifoObject[][] = [];
  private redoStack: TifoObject[][] = [];
  private seq = 0;

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private snapshot(): TifoObject[] {
    // Shallow clone of each object (bitmaps are shared by reference — immutable).
    return this.objects.map((o) => ({ ...o }));
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  list(): readonly TifoObject[] {
    return this.objects;
  }

  get selected(): TifoObject | null {
    return this.objects.find((o) => o.id === this.selectedId) ?? null;
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.notify();
  }

  addText(obj: Omit<TextObject, 'id' | 'kind'>): TextObject {
    this.pushHistory();
    const created: TextObject = { ...obj, id: `t${++this.seq}`, kind: 'text' };
    this.objects.push(created);
    this.selectedId = created.id;
    this.notify();
    return created;
  }

  addImage(obj: Omit<ImageObject, 'id' | 'kind'>): ImageObject {
    this.pushHistory();
    const created: ImageObject = { ...obj, id: `i${++this.seq}`, kind: 'image' };
    this.objects.push(created);
    this.selectedId = created.id;
    this.notify();
    return created;
  }

  addShape(obj: Omit<ShapeObject, 'id' | 'kind'>): ShapeObject {
    this.pushHistory();
    const created: ShapeObject = { ...obj, id: `s${++this.seq}`, kind: 'shape' };
    this.objects.push(created);
    this.selectedId = created.id;
    this.notify();
    return created;
  }

  /** Live-update during drag/resize WITHOUT spamming history (call commit() on release). */
  mutateSelected(patch: Partial<TifoObject>): void {
    const o = this.selected;
    if (!o) return;
    Object.assign(o, patch);
    this.notify();
  }

  /** Snapshot the pre-edit state once at the START of a drag/resize gesture. */
  beginGesture(): void {
    this.pushHistory();
  }

  deleteSelected(): void {
    if (!this.selectedId) return;
    this.pushHistory();
    this.objects = this.objects.filter((o) => o.id !== this.selectedId);
    this.selectedId = null;
    this.notify();
  }

  /** Move the selected object up/down the stacking order. */
  reorderSelected(dir: 'front' | 'back'): void {
    const idx = this.objects.findIndex((o) => o.id === this.selectedId);
    if (idx < 0) return;
    this.pushHistory();
    const [obj] = this.objects.splice(idx, 1);
    if (dir === 'front') this.objects.push(obj);
    else this.objects.unshift(obj);
    this.notify();
  }

  undo(): void {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this.snapshot());
    this.objects = this.undoStack.pop()!;
    if (!this.objects.some((o) => o.id === this.selectedId)) this.selectedId = null;
    this.notify();
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this.snapshot());
    this.objects = this.redoStack.pop()!;
    this.notify();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.objects = [];
    this.selectedId = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  /**
   * Bake one object into the seat grid as a single undoable stroke.
   * Returns the dirty seat indices (already flushed by the caller's store).
   */
  bake(obj: TifoObject, store: DesignStore, map: SeatMap, wrapWidth: number, clip?: (i: number) => boolean): number[] {
    const source = renderObjectCanvas(obj);
    if (!source) return [];
    const cols = Math.max(2, Math.min(2400, Math.round(obj.width / 3)));
    const rows = Math.max(2, Math.min(400, Math.round(obj.height / 8)));
    const pixels = rasterize(source, cols, rows);
    const grid =
      obj.kind === 'image'
        ? quantizePixels(enhanceForBake(pixels, cols, rows), cols, rows, store.palette, {
            dither: obj.dither,
            halftone: obj.halftone,
            alphaThreshold: obj.alphaThreshold,
          })
        : maskFromAlpha(pixels, cols, rows, obj.colorIndex); // text + shape: 1-colour mask
    const target = { x: obj.cx - obj.width / 2, y: obj.cy - obj.height / 2, width: obj.width, height: obj.height };
    const tierAccept = obj.tier === null ? undefined : (i: number) => map.tierOf[i] === obj.tier;
    // Optional region clip (e.g. keep an AI portrait inside its own stand), AND-ed with the tier.
    const accept = clip && tierAccept ? (i: number) => clip(i) && tierAccept(i) : (clip ?? tierAccept);
    store.beginStroke();
    const dirty = applyGridToSeats(store, map, grid, cols, rows, target, wrapWidth, accept);
    store.commitStroke();
    return dirty;
  }

  /** Bake every object bottom-to-top, then clear the layer. One stroke each. */
  bakeAll(store: DesignStore, map: SeatMap, wrapWidth: number): number {
    let total = 0;
    for (const obj of this.objects) total += this.bake(obj, store, map, wrapWidth).length;
    this.clear();
    return total;
  }
}

/** Render an object's source canvas (white-on-transparent text, or the image bitmap). */
export function renderObjectCanvas(obj: TifoObject): HTMLCanvasElement | ImageBitmap | null {
  if (obj.kind === 'text') {
    const r = renderTextCanvas(obj.text, obj.fontCss, obj.arcDeg);
    return r?.canvas ?? null;
  }
  if (obj.kind === 'shape') {
    // White-on-transparent shape at the object's aspect (resize preserves aspect,
    // so this is stamped without distortion). Colour is applied at bake time.
    const aspect = obj.width / obj.height || 1;
    const canvas = document.createElement('canvas');
    canvas.height = 220;
    canvas.width = Math.max(8, Math.round(220 * aspect));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    drawSymbol(ctx, obj.shape, canvas.width, canvas.height);
    return canvas;
  }
  return obj.bitmap;
}

export function fontForObject(fonts: TifoFont[], id: string): string {
  return fonts.find((f) => f.id === id)?.css ?? fonts[0].css;
}
