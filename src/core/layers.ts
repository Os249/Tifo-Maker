/**
 * Layers — the pure half.
 *
 * A tifo is one colour per seat, and for most of this editor's life that was
 * also the whole data model: text and pictures floated above the seats only
 * until they were "baked", and after that they were paint like everything
 * else. People could not move a picture once it had landed, and every save and
 * every export baked whatever was still floating.
 *
 * Now the seats are a stack: one Paint layer at the bottom, and every text,
 * picture, shape and lifted region as its own layer above it. `cells` — the
 * buffer every reader in the app already uses — is the stack flattened, top-most
 * object wins at each seat. Nothing downstream (Match Day, exports, thumbnails,
 * the community) needs to know layers exist.
 *
 * This module is DOM-free: stamping an object onto seats, flattening, and the
 * encodings used to save a stack. The browser-only half (rasterising text and
 * pictures into grids) lives in core/objects.ts and core/composer.ts.
 */

import type { SeatMap } from './types';

/** A touch-up cell with nothing in it. */
export const NO_TOUCH = -1;
/** A touch-up cell that cuts through the object to whatever is below. */
export const HOLE = -2;

/** A raster of palette indices over an object's own frame. -1 is transparent. */
export interface Grid {
  cols: number;
  rows: number;
  data: Int16Array;
}

/** Where an object sits, in editor units. Rotation in degrees, clockwise on screen. */
export interface Placement {
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
}

/** The seats an object covers and the colour it gives each of them. */
export interface Stamp {
  seats: Uint32Array;
  vals: Int16Array;
}

export const EMPTY_STAMP: Stamp = { seats: new Uint32Array(0), vals: new Int16Array(0) };

/** Nearest-cell sample of a grid at normalised (u, v) in [0, 1). */
export function sampleGrid(g: Grid, u: number, v: number): number {
  const ix = Math.min(g.cols - 1, Math.max(0, Math.floor(u * g.cols)));
  const iy = Math.min(g.rows - 1, Math.max(0, Math.floor(v * g.rows)));
  return g.data[iy * g.cols + ix];
}

/** Index of the grid cell under normalised (u, v). */
export function cellIndex(g: { cols: number; rows: number }, u: number, v: number): number {
  const ix = Math.min(g.cols - 1, Math.max(0, Math.floor(u * g.cols)));
  const iy = Math.min(g.rows - 1, Math.max(0, Math.floor(v * g.rows)));
  return iy * g.cols + ix;
}

/**
 * A world point in the object's own frame, as normalised (u, v), or null when
 * it falls outside. The bowl is unrolled, so x wraps at `wrapWidth`: an object
 * hanging over the seam covers seats on both ends.
 */
export function localUV(p: Placement, x: number, y: number, wrapWidth: number): [number, number] | null {
  let dx = x - p.cx;
  if (wrapWidth > 0) dx -= wrapWidth * Math.round(dx / wrapWidth);
  const dy = y - p.cy;
  const a = (p.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const u = lx / p.width + 0.5;
  const v = ly / p.height + 0.5;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
  return [u, v];
}

/** The axis-aligned half extents of a rotated box. */
export function halfExtents(p: Placement): [number, number] {
  const a = (p.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return [(p.width * c + p.height * s) / 2, (p.width * s + p.height * c) / 2];
}

/**
 * The value an object gives a seat, before anything above it: its touch-up if
 * it has one there, otherwise its own grid. -1 when it shows nothing there.
 */
export function objectValueAt(grid: Grid | null, touch: Grid | null, u: number, v: number): number {
  if (touch) {
    const t = sampleGrid(touch, u, v);
    if (t === HOLE) return -1;
    if (t >= 0) return t;
  }
  return grid ? sampleGrid(grid, u, v) : -1;
}

/**
 * Stamp one object onto the seat map.
 *
 * Returns only the seats it actually shows something on, so a transparent
 * corner of a cut-out picture or a hole cut in it lets the layers below show.
 * `accept` is the object's clip (a tier, a stand); `locked` seats (a royal box
 * nobody holds a card in) are never covered.
 */
export function stampObject(
  map: SeatMap,
  p: Placement,
  grid: Grid | null,
  touch: Grid | null,
  wrapWidth: number,
  accept: ((i: number) => boolean) | null,
  locked: Uint8Array | null,
): Stamp {
  if (!(p.width > 0 && p.height > 0) || (!grid && !touch)) return EMPTY_STAMP;
  const [aw, ah] = halfExtents(p);
  const a = (p.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const xy = map.xy;
  const seats: number[] = [];
  const vals: number[] = [];
  for (let i = 0; i < map.count; i++) {
    const dy = xy[i * 2 + 1] - p.cy;
    if (dy < -ah || dy > ah) continue;
    let dx = xy[i * 2] - p.cx;
    if (wrapWidth > 0 && (dx > aw || dx < -aw)) dx -= wrapWidth * Math.round(dx / wrapWidth);
    if (dx < -aw || dx > aw) continue;
    const u = (dx * c + dy * s) / p.width + 0.5;
    const v = (-dx * s + dy * c) / p.height + 0.5;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    if (locked && locked[i] === 1) continue;
    if (accept && !accept(i)) continue;
    const val = objectValueAt(grid, touch, u, v);
    if (val < 0) continue;
    seats.push(i);
    vals.push(val);
  }
  return { seats: Uint32Array.from(seats), vals: Int16Array.from(vals) };
}

/**
 * Flatten the stack into `cells`.
 *
 * `stamps` is bottom to top. `owner[i]` is the index into `stamps` of the
 * object on top at seat i (-1: the Paint layer), and `top[i]` its value — the
 * two arrays the paint router reads to send a brush stroke to whatever is
 * showing. With `region`, only those seats are recomputed (`mark` is a
 * scratch buffer the length of the map, left zeroed).
 */
export function flatten(
  cells: Uint8Array,
  owner: Int16Array,
  top: Int16Array,
  base: Uint8Array,
  stamps: readonly Stamp[],
  region: ArrayLike<number> | null,
  mark: Uint8Array,
): void {
  if (!region) {
    cells.set(base);
    owner.fill(-1);
    top.fill(-1);
    for (let k = 0; k < stamps.length; k++) {
      const { seats, vals } = stamps[k];
      for (let j = 0; j < seats.length; j++) {
        const i = seats[j];
        cells[i] = vals[j];
        owner[i] = k;
        top[i] = vals[j];
      }
    }
    return;
  }
  for (let r = 0; r < region.length; r++) {
    const i = region[r];
    mark[i] = 1;
    cells[i] = base[i];
    owner[i] = -1;
    top[i] = -1;
  }
  for (let k = 0; k < stamps.length; k++) {
    const { seats, vals } = stamps[k];
    for (let j = 0; j < seats.length; j++) {
      const i = seats[j];
      if (mark[i] !== 1) continue;
      cells[i] = vals[j];
      owner[i] = k;
      top[i] = vals[j];
    }
  }
  for (let r = 0; r < region.length; r++) mark[region[r]] = 0;
}

/** FNV-1a over a byte buffer: the fingerprint that ties a saved stack to its seats. */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bytes.length.toString(36)}-${h.toString(36)}`;
}

// ---- encodings -----------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A grid as JSON: Int16 little-endian, base64. */
export interface GridJSON {
  cols: number;
  rows: number;
  b64: string;
}

export function gridToJSON(g: Grid): GridJSON {
  const le = new Uint8Array(g.data.length * 2);
  const dv = new DataView(le.buffer);
  for (let i = 0; i < g.data.length; i++) dv.setInt16(i * 2, g.data[i], true);
  return { cols: g.cols, rows: g.rows, b64: bytesToB64(le) };
}

export function gridFromJSON(j: unknown): Grid | null {
  if (!j || typeof j !== 'object') return null;
  const { cols, rows, b64 } = j as Partial<GridJSON>;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || typeof b64 !== 'string') return null;
  if (cols! < 1 || rows! < 1 || cols! > 4800 || rows! > 1600) return null;
  const bytes = b64ToBytes(b64);
  if (bytes.length !== cols! * rows! * 2) return null;
  const dv = new DataView(bytes.buffer);
  const data = new Int16Array(cols! * rows!);
  for (let i = 0; i < data.length; i++) data[i] = dv.getInt16(i * 2, true);
  return { cols: cols!, rows: rows!, data };
}

export function bytesToJSON(bytes: Uint8Array): string {
  return bytesToB64(bytes);
}

export function bytesFromJSON(b64: unknown, length: number): Uint8Array | null {
  if (typeof b64 !== 'string') return null;
  try {
    const bytes = b64ToBytes(b64);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

/** Copy a grid (touch-ups are copy-on-write: an undo snapshot keeps the old one). */
export function cloneGrid(g: Grid): Grid {
  return { cols: g.cols, rows: g.rows, data: g.data.slice() };
}
