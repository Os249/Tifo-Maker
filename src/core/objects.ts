import type { Region } from './tifoSpec';
import type { ObjectsChange } from './design';
import {
  type Grid, type GridJSON, cloneGrid, gridFromJSON, gridToJSON,
} from './layers';
import { cutoutBackground, enhanceForBake, halftoneCellFor, maskFromAlpha, quantizePixels, rasterize } from './importImage';
import { renderTextCanvas, type TifoFont } from './text';
import { drawSymbol } from './symbols';

/**
 * The layer stack's objects.
 *
 * Text, pictures, shapes and lifted regions each sit on their own layer above
 * the Paint layer, for the life of the project. They used to float only until
 * they were "baked" into the seats — and every save and every export baked
 * whatever was still floating — so a picture could never be moved again once
 * it had landed. Now nothing is baked: the stack is flattened into the seats
 * whenever anything needs seats (see core/composer.ts), and an object stays an
 * object until its owner chooses "Merge into paint".
 *
 * An object keeps its source (the text and font, the picture, the shape) and a
 * raster of palette indices at its current size (`grid`), so it can be moved,
 * turned and flattened without re-drawing anything, and re-drawn crisply when
 * it is resized. Touch-ups painted on it live in its own frame (`touch`), so
 * they move and scale with it.
 *
 * History belongs to the DesignStore: every change here is handed to
 * `recorder` as a before/after pair, so paint and objects share ONE undo.
 */

/** How many pictures one design may hold (the saved scene has a size cap). */
export const MAX_PICTURES = 12;
/** How many layers one design may hold. */
export const MAX_LAYERS = 64;

export interface BaseObject {
  id: string;
  /** Center in editor (xy) coordinates. */
  cx: number;
  cy: number;
  /** Footprint in editor units (before rotation). */
  width: number;
  height: number;
  /** Degrees, clockwise on screen. */
  rotation: number;
  /** Palette index used for text and shapes. */
  colorIndex: number;
  /** Tier limit: null = both. */
  tier: number | null;
  /** The name the user gave the layer; absent = named after what it is. */
  label?: string;
  /** Hidden layers are left out of the seats, and so out of every export. */
  hidden?: boolean;
  /** A locked layer cannot be moved, resized or painted on from the canvas. */
  locked?: boolean;
  /** Keep inside one stand (the AI's portraits; "Keep inside" in the panel). */
  keep?: Region | null;
  /** Touch-ups in the object's own frame: -1 none, -2 a hole, else a palette index. */
  touch?: Grid | null;
  /** The object rasterised to palette indices at its current size. */
  grid?: Grid | null;
  /** What `grid` was drawn from; a different key means it is out of date. */
  gridKey?: string;
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
  /** The decoded picture. Null until a restored picture has been decoded. */
  bitmap: ImageBitmap | null;
  /** The file it came from. */
  name: string;
  /** The picture itself, as a data URL, for saving. */
  src?: string;
  dither: boolean;
  halftone?: boolean;
  /** Flood the flat backdrop away so the design underneath shows through. */
  cutout?: boolean;
  alphaThreshold: number;
}

export interface ShapeObject extends BaseObject {
  kind: 'shape';
  /** A SHAPE_NAMES entry (rect, ellipse, star, shield, …). Drawn as a 1-colour mask. */
  shape: string;
}

/** Seats lifted off the Paint layer with Make movable: its grid is the art itself. */
export interface CellsObject extends BaseObject {
  kind: 'cells';
}

export type TifoObject = TextObject | ImageObject | ShapeObject | CellsObject;
export type ObjectKind = TifoObject['kind'];

type NewObject<T extends TifoObject> = Omit<T, 'id' | 'kind' | 'rotation'> & { rotation?: number };

/** Why the layer changed: 'select' is selection only, nothing to redraw. */
export type ChangeKind = 'content' | 'select';
type Listener = (why: ChangeKind) => void;

const PREFIX: Record<ObjectKind, string> = { text: 't', image: 'i', shape: 's', cells: 'c' };

/** Holds the layer objects and the selection. The DesignStore holds their history. */
export class ObjectLayer {
  private objects: TifoObject[] = [];
  private selectedId: string | null = null;
  private listeners: Listener[] = [];
  private seq = 0;
  private gestureBefore: TifoObject[] | null = null;
  /** Receives every change as one undo step. Wired by the Composer. */
  recorder: ((change: ObjectsChange) => void) | null = null;
  /**
   * True while a drag, resize or turn is under way. The composer then keeps
   * the object's current raster (stretched) rather than re-drawing a picture
   * on every pointer move, and re-draws it once when the gesture ends.
   */
  live = false;

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private notify(why: ChangeKind = 'content'): void {
    for (const fn of this.listeners) fn(why);
  }

  /** Bottom to top — the order they are flattened in. */
  list(): readonly TifoObject[] {
    return this.objects;
  }

  get(id: string): TifoObject | null {
    return this.objects.find((o) => o.id === id) ?? null;
  }

  get selected(): TifoObject | null {
    return this.selectedId ? this.get(this.selectedId) : null;
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.notify('select');
  }

  pictureCount(): number {
    return this.objects.filter((o) => o.kind === 'image').length;
  }

  /** A copy of the stack for history: objects are cloned, rasters shared (they are never written in place). */
  snapshot(): TifoObject[] {
    return this.objects.map((o) => ({ ...o }));
  }

  private record(before: TifoObject[]): void {
    this.recorder?.({ before, after: this.snapshot() });
  }

  private nextId(kind: ObjectKind): string {
    let id: string;
    do id = `${PREFIX[kind]}${++this.seq}`;
    while (this.objects.some((o) => o.id === id));
    return id;
  }

  /** Add an object on top and select it. One undo step. */
  add<T extends TifoObject>(kind: T['kind'], obj: NewObject<T>): T {
    const before = this.snapshot();
    const created = { rotation: 0, ...obj, id: this.nextId(kind), kind } as unknown as T;
    this.objects.push(created);
    this.selectedId = created.id;
    this.record(before);
    this.notify();
    return created;
  }

  addText(obj: NewObject<TextObject>): TextObject {
    return this.add<TextObject>('text', obj);
  }

  addImage(obj: NewObject<ImageObject>): ImageObject {
    return this.add<ImageObject>('image', obj);
  }

  addShape(obj: NewObject<ShapeObject>): ShapeObject {
    return this.add<ShapeObject>('shape', obj);
  }

  addCells(obj: NewObject<CellsObject>): CellsObject {
    return this.add<CellsObject>('cells', obj);
  }

  /** Change an object's properties as one undo step. */
  update(id: string, patch: Partial<TifoObject>): void {
    const o = this.get(id);
    if (!o) return;
    const changed = Object.keys(patch).some((k) => (o as unknown as Record<string, unknown>)[k] !== (patch as Record<string, unknown>)[k]);
    if (!changed) return;
    const before = this.snapshot();
    Object.assign(o, patch);
    this.record(before);
    this.notify();
  }

  /** Change an object WITHOUT an undo step — the frames of a gesture. */
  mutate(id: string, patch: Partial<TifoObject>): void {
    const o = this.get(id);
    if (!o) return;
    Object.assign(o, patch);
    this.notify();
  }

  /** Live-update the selection during a drag/resize WITHOUT spamming history (endGesture() records it). */
  mutateSelected(patch: Partial<TifoObject>): void {
    if (this.selectedId) this.mutate(this.selectedId, patch);
  }

  /**
   * Snapshot the stack at the START of a drag/resize/turn. `live` keeps the
   * raster stretched until the end (a drag); a text edit re-draws as it goes.
   */
  beginGesture(live = true): void {
    this.gestureBefore = this.snapshot();
    this.live = live;
  }

  /** The gesture ended: one undo step if anything moved. */
  endGesture(): void {
    const before = this.gestureBefore;
    this.gestureBefore = null;
    this.live = false;
    if (!before) return;
    const moved = before.length !== this.objects.length || before.some((b, k) => {
      const o = this.objects[k];
      return !o || o.id !== b.id || o.cx !== b.cx || o.cy !== b.cy || o.width !== b.width || o.height !== b.height || o.rotation !== b.rotation
        || (o.kind === 'text' && b.kind === 'text' && o.text !== b.text);
    });
    if (moved) this.record(before);
    // Re-draw at the final size now that nobody is dragging.
    this.notify();
  }

  get inGesture(): boolean {
    return this.gestureBefore !== null;
  }

  remove(id: string): void {
    if (!this.get(id)) return;
    const before = this.snapshot();
    this.objects = this.objects.filter((o) => o.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.record(before);
    this.notify();
  }

  deleteSelected(): void {
    if (this.selectedId) this.remove(this.selectedId);
  }

  /** A copy just above the original, nudged so it can be seen, and selected. */
  duplicate(id: string, offset = 12.8): TifoObject | null {
    const o = this.get(id);
    if (!o) return null;
    const before = this.snapshot();
    const copy = { ...o, id: this.nextId(o.kind), cx: o.cx + offset, cy: o.cy + offset / 2, locked: false } as TifoObject;
    this.objects.splice(this.objects.indexOf(o) + 1, 0, copy);
    this.selectedId = copy.id;
    this.record(before);
    this.notify();
    return copy;
  }

  /** Move one object in the stack. Front = top of the list = drawn last. */
  reorder(id: string, dir: 'front' | 'back' | 'forward' | 'backward'): void {
    const idx = this.objects.findIndex((o) => o.id === id);
    if (idx < 0) return;
    const target =
      dir === 'front' ? this.objects.length - 1
        : dir === 'back' ? 0
          : dir === 'forward' ? Math.min(this.objects.length - 1, idx + 1)
            : Math.max(0, idx - 1);
    this.moveTo(id, target);
  }

  /** Put an object at a position in the stack (0 = just above the paint). */
  moveTo(id: string, index: number): void {
    const idx = this.objects.findIndex((o) => o.id === id);
    const to = Math.max(0, Math.min(this.objects.length - 1, index));
    if (idx < 0 || idx === to) return;
    const before = this.snapshot();
    const [obj] = this.objects.splice(idx, 1);
    this.objects.splice(to, 0, obj);
    this.record(before);
    this.notify();
  }

  /** Back-compat for the panel's two buttons. */
  reorderSelected(dir: 'front' | 'back'): void {
    if (this.selectedId) this.reorder(this.selectedId, dir);
  }

  /** Replace the stack from history (no undo step of its own). */
  restore(snapshot: unknown): void {
    const list = Array.isArray(snapshot) ? (snapshot as TifoObject[]) : [];
    const had = new Set(this.objects.map((o) => o.id));
    this.objects = list.map((o) => ({ ...o }));
    // An undo that brings a layer back selects it, so the next key acts on it.
    const back = this.objects.filter((o) => !had.has(o.id));
    if (back.length === 1) this.selectedId = back[0].id;
    else if (this.selectedId && !this.get(this.selectedId)) this.selectedId = null;
    this.gestureBefore = null;
    this.live = false;
    this.notify();
  }

  /** Replace the stack from a saved project (no history, nothing selected). */
  load(list: TifoObject[]): void {
    this.objects = list.map((o) => ({ ...o }));
    this.selectedId = null;
    this.seq = 0;
    for (const o of this.objects) {
      const n = Number(o.id.slice(1));
      if (Number.isFinite(n) && n > this.seq) this.seq = n;
    }
    this.notify();
  }

  /** Replace the whole stack as one undo step (the AI's Revert puts the old one back). */
  replaceAll(list: readonly TifoObject[]): void {
    const before = this.snapshot();
    this.objects = list.map((o) => ({ ...o }));
    if (this.selectedId && !this.get(this.selectedId)) this.selectedId = null;
    this.record(before);
    this.notify();
  }

  /** Remove every object. Recorded, so it can be undone, unless `record` is false. */
  clear(record = true): void {
    if (this.objects.length === 0 && this.selectedId === null) return;
    const before = this.snapshot();
    this.objects = [];
    this.selectedId = null;
    if (record && before.length) this.record(before);
    this.notify();
  }

  /**
   * Re-index every object's colours after a palette remap. Returns the change
   * for the store to put in the same undo step as the Paint layer's remap.
   */
  remapColours(remap: number[]): ObjectsChange | null {
    if (this.objects.length === 0) return null;
    const before = this.snapshot();
    const mapGrid = (g: Grid | null | undefined): Grid | null | undefined => {
      if (!g) return g;
      const out = cloneGrid(g);
      for (let i = 0; i < out.data.length; i++) if (out.data[i] >= 0) out.data[i] = remap[out.data[i]] ?? 0;
      return out;
    };
    for (const o of this.objects) {
      o.colorIndex = remap[o.colorIndex] ?? o.colorIndex;
      o.touch = mapGrid(o.touch) ?? null;
      o.grid = mapGrid(o.grid) ?? null;
      // A remapped raster is still the raster for this size and source: keep
      // its key (text and shapes carry their colour in it, so update that).
      if (o.grid) o.gridKey = gridKeyFor(o);
    }
    const after = this.snapshot();
    this.notify();
    return { before, after };
  }
}

// ---------------------------------------------------------------------------
// Rasterising (browser only)

/** The grid size an object is drawn at: about one cell per 3 × 8 editor units, like the old bake. */
export function gridSize(o: Pick<BaseObject, 'width' | 'height'>): { cols: number; rows: number } {
  return {
    cols: Math.max(2, Math.min(2400, Math.round(o.width / 3))),
    rows: Math.max(2, Math.min(400, Math.round(o.height / 8))),
  };
}

/** What an object's raster depends on. Position and rotation are not in it: moving never re-draws. */
export function gridKeyFor(o: TifoObject): string {
  const { cols, rows } = gridSize(o);
  switch (o.kind) {
    case 'text':
      return `t|${o.text}|${o.fontId}|${o.arcDeg}|${o.colorIndex}|${cols}x${rows}`;
    case 'shape':
      return `s|${o.shape}|${o.colorIndex}|${cols}x${rows}`;
    case 'image':
      return `i|${cols}x${rows}|${o.dither ? 1 : 0}${o.halftone ? 1 : 0}${o.cutout ? 1 : 0}|${o.alphaThreshold}`;
    case 'cells':
      return 'c';
  }
}

/**
 * Decoded pictures by their saved source. An undo snapshot holds a copy of the
 * object, and a picture decoded after the snapshot was taken would otherwise
 * be missing from it — this is where every copy finds its bitmap.
 */
const pictures = new Map<string, ImageBitmap>();

export function rememberPicture(src: string | undefined, bitmap: ImageBitmap | null): void {
  if (src && bitmap) pictures.set(src, bitmap);
}

/** Decode every saved picture that is not decoded yet (for re-drawing at a new size). */
export async function decodePictures(list: readonly TifoObject[]): Promise<void> {
  for (const o of list) {
    if (o.kind !== 'image' || o.bitmap || !o.src || pictures.has(o.src)) continue;
    const bmp = await decodePictureSrc(o.src);
    if (bmp) pictures.set(o.src, bmp);
  }
}

/** Render an object's source canvas (white-on-transparent text or shape, or the picture). */
export function renderObjectCanvas(obj: TifoObject): HTMLCanvasElement | ImageBitmap | null {
  if (obj.kind === 'text') {
    const r = renderTextCanvas(obj.text, obj.fontCss, obj.arcDeg);
    return r?.canvas ?? null;
  }
  if (obj.kind === 'shape') {
    // White-on-transparent shape at the object's aspect (resize preserves aspect,
    // so this is drawn without distortion). Colour is applied as the mask value.
    const aspect = obj.width / obj.height || 1;
    const canvas = document.createElement('canvas');
    canvas.height = 220;
    canvas.width = Math.max(8, Math.round(220 * aspect));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    drawSymbol(ctx, obj.shape, canvas.width, canvas.height);
    return canvas;
  }
  if (obj.kind === 'image') return obj.bitmap ?? (obj.src ? pictures.get(obj.src) ?? null : null);
  return null;
}

/**
 * Draw an object's raster at its current size, if it is out of date.
 *
 * Returns true when the grid changed. A picture whose bitmap has not been
 * decoded yet, or a lifted region, keeps the grid it has (stretched).
 */
export function ensureGrid(o: TifoObject, palette: string[]): boolean {
  if (o.kind === 'cells') return false;
  const key = gridKeyFor(o);
  if (o.grid && o.gridKey === key) return false;
  const source = renderObjectCanvas(o);
  if (!source) return false;
  const { cols, rows } = gridSize(o);
  const pixels = rasterize(source, cols, rows);
  let data: Int16Array;
  if (o.kind === 'image') {
    // Both of these effects assume a grid with resolution to spare, and a hero
    // portrait on one stand has ~52 rows. Clustering it 3x3 left EIGHTEEN rows
    // of tone for a whole face, which is why AI portraits arrived as blobs;
    // error diffusion at that size scatters single-cell specks a ~10% no-show
    // erases. Below the threshold both are switched off and the picture is
    // quantized straight to the palette — the source is already posterised, so
    // that yields big contiguous regions, which is what reads at 200m.
    const affordable = halftoneCellFor(rows);
    const cell = o.halftone ? affordable : 1;
    // Cut the backdrop BEFORE the contrast boost, while it is still the flat
    // colour the generator produced. enhanceForBake preserves alpha, and the
    // quantizer skips transparent cells, so the layers beneath keep their cards.
    if (o.cutout) cutoutBackground(pixels, cols, rows);
    data = quantizePixels(enhanceForBake(pixels, cols, rows), cols, rows, palette, {
      dither: o.dither && affordable > 1,
      halftone: !!o.halftone && cell > 1,
      halftoneCell: cell,
      alphaThreshold: o.alphaThreshold,
    });
  } else {
    data = maskFromAlpha(pixels, cols, rows, o.colorIndex); // text + shape: 1-colour mask
  }
  o.grid = { cols, rows, data };
  o.gridKey = key;
  return true;
}

export function fontForObject(fonts: TifoFont[], id: string): string {
  return fonts.find((f) => f.id === id)?.css ?? fonts[0].css;
}

/**
 * A picture as a data URL small enough to save: WebP where the browser can
 * write it, at most 1024 px on the long edge. Twelve of these fit in the
 * design's scene with room for its banners.
 */
export function encodePictureSrc(bitmap: ImageBitmap, maxEdge = 1024): string | undefined {
  try {
    const k = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * k));
    c.height = Math.max(1, Math.round(bitmap.height * k));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', 0.84);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/** Decode a saved picture back into a bitmap (an <img>, because the CSP allows data: images). */
export async function decodePictureSrc(src: string): Promise<ImageBitmap | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    return await createImageBitmap(img);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Saving

/** One object in a saved stack. */
export interface ObjectJSON {
  id: string;
  kind: ObjectKind;
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
  colorIndex: number;
  tier: number | null;
  label?: string;
  hidden?: boolean;
  locked?: boolean;
  keep?: Region | null;
  touch?: GridJSON;
  grid?: GridJSON;
  gridKey?: string;
  // text
  text?: string;
  fontId?: string;
  arcDeg?: number;
  heightSeats?: number;
  // picture
  name?: string;
  src?: string;
  dither?: boolean;
  halftone?: boolean;
  cutout?: boolean;
  alphaThreshold?: number;
  // shape
  shape?: string;
}

export function objectToJSON(o: TifoObject): ObjectJSON {
  const out: ObjectJSON = {
    id: o.id, kind: o.kind, cx: o.cx, cy: o.cy, width: o.width, height: o.height,
    rotation: o.rotation, colorIndex: o.colorIndex, tier: o.tier,
  };
  if (o.label) out.label = o.label;
  if (o.hidden) out.hidden = true;
  if (o.locked) out.locked = true;
  if (o.keep) out.keep = o.keep;
  if (o.touch) out.touch = gridToJSON(o.touch);
  if (o.grid) {
    out.grid = gridToJSON(o.grid);
    if (o.gridKey) out.gridKey = o.gridKey;
  }
  if (o.kind === 'text') Object.assign(out, { text: o.text, fontId: o.fontId, arcDeg: o.arcDeg, heightSeats: o.heightSeats });
  else if (o.kind === 'image') Object.assign(out, { name: o.name, src: o.src, dither: o.dither, halftone: o.halftone, cutout: o.cutout, alphaThreshold: o.alphaThreshold });
  else if (o.kind === 'shape') out.shape = o.shape;
  return out;
}

const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

/** A saved object back into a live one, or null if it cannot be trusted. */
export function objectFromJSON(j: unknown, fonts: TifoFont[], paletteLen: number): TifoObject | null {
  if (!j || typeof j !== 'object') return null;
  const r = j as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== 'text' && kind !== 'image' && kind !== 'shape' && kind !== 'cells') return null;
  const id = typeof r.id === 'string' && /^[a-z]\d{1,9}$/.test(r.id) ? r.id : null;
  const cx = num(r.cx, -20000, 20000);
  const cy = num(r.cy, -20000, 20000);
  const width = num(r.width, 0.5, 20000);
  const height = num(r.height, 0.5, 20000);
  const rotation = num(r.rotation ?? 0, -3600, 3600);
  const colorIndex = num(r.colorIndex ?? 0, 0, Math.max(0, paletteLen - 1));
  if (!id || cx === null || cy === null || width === null || height === null || rotation === null || colorIndex === null) return null;
  const tier = r.tier === null || r.tier === undefined ? null : num(r.tier, 0, 8);
  const base: BaseObject = { id, cx, cy, width, height, rotation, colorIndex, tier };
  if (typeof r.label === 'string' && r.label.trim()) base.label = r.label.slice(0, 60);
  if (r.hidden === true) base.hidden = true;
  if (r.locked === true) base.locked = true;
  if (r.keep && typeof r.keep === 'object') base.keep = r.keep as Region;
  const touch = r.touch ? gridFromJSON(r.touch) : null;
  if (touch) base.touch = touch;
  const grid = r.grid ? gridFromJSON(r.grid) : null;
  if (grid) {
    base.grid = grid;
    if (typeof r.gridKey === 'string') base.gridKey = r.gridKey;
  }
  if (kind === 'text') {
    if (typeof r.text !== 'string' || !r.text) return null;
    const fontId = typeof r.fontId === 'string' ? r.fontId : fonts[0].id;
    return {
      ...base, kind, text: r.text.slice(0, 200), fontId, fontCss: fontForObject(fonts, fontId),
      arcDeg: num(r.arcDeg ?? 0, -360, 360) ?? 0, heightSeats: num(r.heightSeats ?? 18, 1, 400) ?? 18,
    };
  }
  if (kind === 'image') {
    const src = typeof r.src === 'string' && /^data:image\/(webp|png|jpeg);base64,/.test(r.src) ? r.src : undefined;
    if (!src && !grid) return null;
    return {
      ...base, kind, bitmap: null, name: typeof r.name === 'string' ? r.name.slice(0, 120) : 'picture', src,
      dither: r.dither === true, halftone: r.halftone === true, cutout: r.cutout === true,
      alphaThreshold: num(r.alphaThreshold ?? 128, 1, 254) ?? 128,
    };
  }
  if (kind === 'shape') {
    if (typeof r.shape !== 'string') return null;
    return { ...base, kind, shape: r.shape.slice(0, 40) };
  }
  if (!grid) return null;
  return { ...base, kind: 'cells', gridKey: 'c' };
}
