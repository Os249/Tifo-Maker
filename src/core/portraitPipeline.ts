/**
 * A portrait's geometry on a stand (Pro portrait styles): where the face is,
 * how to crop it, how many rows it needs, and what shape the stand's cards
 * really are.
 *
 * Pure and DOM-free, like portraitStyles.ts: the browser finds the face
 * (ui/portraitVision.ts) and hands its 68 landmarks here; everything that
 * decides the crop, the size and the advice is in this file, so the shots and
 * the tests in Node see exactly what a fan gets.
 *
 * The numbers that matter, measured on the 20 test portraits (docs/pro-quality
 * /images.md): a face is read by its eye sockets and its mouth, and on a stand
 * each of those has to be three seats by three rows or more, or the empty seats
 * of a match day take it away (core/analysis.ts, MIN_LEGIBLE_RUN). With the
 * brows to the chin (F) about ten rows tall, the sockets, a gap and the mouth
 * fit, with F as small as nine. A head and shoulders is about 3.1 F tall, a
 * face cropped from the hairline to just under the chin about 2 F. So:
 *
 *   rows >= 28   head and shoulders (the crop most portrait tifos use): the
 *                hair, a hat, glasses and the shoulders are most of what makes
 *                a portrait someone, and the contact sheets showed a face
 *                cropped tight at 31 rows reading as a generic mask;
 *   rows >= 18   the face alone;
 *   below that   a silhouette: the head's outline reads, the face does not.
 */
import type { SeatMap } from './types';

/**
 * A face found in a picture: its box and the 68 landmarks of the iBUG 300-W
 * scheme (0-16 the jaw from the picture's left, 17-26 the brows, 27-35 the
 * nose, 36-47 the eyes, 48-67 the lips), each as a share (0..1) of the
 * picture's width and height, so the face stays put when the picture is
 * re-drawn at another size.
 */
export interface FaceInfo {
  box: [number, number, number, number];
  /** x0, y0, x1, y1, ... : 68 points, 136 numbers. */
  pts: number[];
}

export const FACE_POINTS = 68;

/** A face the pipeline can trust: 68 finite points inside a sane frame around the picture. */
export function isFaceInfo(v: unknown): v is FaceInfo {
  if (!v || typeof v !== 'object') return false;
  const f = v as FaceInfo;
  // Shares of the picture; a face box can run past a tight crop, never far past it.
  const ok = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > -3 && n < 4;
  return Array.isArray(f.box) && f.box.length === 4 && f.box.every(ok) &&
    Array.isArray(f.pts) && f.pts.length === FACE_POINTS * 2 && f.pts.every(ok);
}

/**
 * A found face the portrait can be built on: big enough in the picture to be
 * its subject (a face in the crowd behind is not), and with landmarks in a
 * face's proportions (brows over eyes over the mouth over the chin, the
 * brow-to-chin height most of the box). A detector's false find in a beard
 * or a pattern fails one or the other, and the picture is then kept whole.
 */
export function plausibleFace(face: FaceInfo, w: number, h: number): boolean {
  const f = faceFrame(face, w, h);
  const boxH = face.box[3] * h;
  const p = face.pts;
  const eyeY = (f.eyes[0][1] + f.eyes[1][1]) / 2;
  const mouthY = ((p[51 * 2 + 1] + p[57 * 2 + 1]) / 2) * h;
  const eyeGap = Math.abs(f.eyes[1][0] - f.eyes[0][0]);
  return boxH >= Math.min(w, h) * 0.1 &&
    f.brow < eyeY && eyeY < mouthY && mouthY < f.chin &&
    f.F >= boxH * 0.45 && f.F <= boxH * 1.4 &&
    eyeGap >= f.jaw * 0.2 && eyeGap <= f.jaw * 0.75;
}

/** Rows a stand needs for a head and shoulders that reads. */
export const ROWS_SHOULDERS = 28;
/** Rows a stand needs for a face (cropped to the face) that reads. */
export const ROWS_FACE = 18;

export type CropKind = 'shoulders' | 'face' | 'silhouette';

/** The crop a stand of this many rows can carry. */
export function cropKindFor(rows: number): CropKind {
  if (rows >= ROWS_SHOULDERS) return 'shoulders';
  if (rows >= ROWS_FACE) return 'face';
  return 'silhouette';
}

/** Where the face's parts are, in the picture's pixels. */
export interface FaceFrame {
  /** The brows' line and the chin, so F = chin - brow is the face's height. */
  brow: number;
  chin: number;
  F: number;
  /** Between the eyes: the face's centre across. */
  cx: number;
  /** The eyes' centres. */
  eyes: [[number, number], [number, number]];
  /** The jaw's width (ear to ear, about). */
  jaw: number;
}

const avg = (pts: number[], from: number, to: number, axis: 0 | 1, s: number): number => {
  let t = 0;
  for (let i = from; i <= to; i++) t += pts[i * 2 + axis];
  return (t / (to - from + 1)) * s;
};

export function faceFrame(face: FaceInfo, w: number, h: number): FaceFrame {
  const p = face.pts;
  const brow = avg(p, 17, 26, 1, h);
  const chin = p[8 * 2 + 1] * h;
  const eyes: [[number, number], [number, number]] = [
    [avg(p, 36, 41, 0, w), avg(p, 36, 41, 1, h)],
    [avg(p, 42, 47, 0, w), avg(p, 42, 47, 1, h)],
  ];
  let jx0 = Infinity;
  let jx1 = -Infinity;
  for (let i = 0; i <= 16; i++) {
    jx0 = Math.min(jx0, p[i * 2] * w);
    jx1 = Math.max(jx1, p[i * 2] * w);
  }
  return { brow, chin, F: Math.max(1, chin - brow), cx: (eyes[0][0] + eyes[1][0]) / 2, eyes, jaw: Math.max(1, jx1 - jx0) };
}

export interface Crop {
  /** In the picture's pixels; may run past its edges (the outside is transparent). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The crop for a portrait of this kind, in the picture's pixels, at most
 * `maxAspect` wide (width over height): a head and shoulders from just over
 * the hair to the shoulders, or the face from the hairline to under the chin.
 * Never wider than the picture has to give either side of the face, so a
 * narrow photo does not grow empty margins it would then be scaled up to fill.
 */
export function portraitCrop(face: FaceInfo, w: number, h: number, kind: CropKind, maxAspect = 4): Crop {
  const f = faceFrame(face, w, h);
  // The heights, in F (brow to chin): over the brow sits the forehead and the
  // hair, under the chin the neck and, for a head and shoulders, the shoulders.
  const [up, down, across] = kind === 'shoulders' ? [1.0, 1.1, 3.0] : kind === 'face' ? [0.8, 0.3, 1.75] : [0.85, 0.75, 2.2];
  const top = f.brow - up * f.F;
  const height = f.chin + down * f.F - top;
  let width = Math.min(across * f.F, maxAspect * height);
  // What the picture has either side of the face: the crop goes no further.
  const room = 2 * Math.min(f.cx, w - f.cx);
  width = Math.max(Math.min(width, Math.max(room, f.jaw * 1.1)), Math.min(width, f.jaw * 1.3));
  return { x: f.cx - width / 2, y: top, w: width, h: height };
}

/** The face as seen in a crop of its picture (0..1 of the crop). */
export function faceInCrop(face: FaceInfo, w: number, h: number, c: Crop): FaceInfo {
  const pts = face.pts.map((v, i) => (i % 2 === 0 ? (v * w - c.x) / c.w : (v * h - c.y) / c.h));
  const [bx, by, bw, bh] = face.box;
  return { box: [(bx * w - c.x) / c.w, (by * h - c.y) / c.h, (bw * w) / c.w, (bh * h) / c.h], pts };
}

// ------------------------------------------------------------- the stand ---

/** What a portrait needs to know about the seats it lands on. */
export interface SeatShape {
  /** Rows of seats, top to bottom. */
  rows: number;
  /** Seats in the widest row. */
  seats: number;
  /** Editor units per seat, across (a stand is always 1000 units wide in the editor, whatever its seats). */
  pitch: number;
  /**
   * One seat's card as the far side of the ground sees it, width over
   * height: the seat's width over the row's run up the rake. About 0.5 to
   * 0.6 on every ground the site models; the editor draws rows 8 units apart
   * and seats 2.9 to 6.3, so a picture drawn by editor units alone is wider
   * on the stand than on the screen on a big ground and narrower on a small one.
   */
  cell: number;
}

const DEFAULT_CELL = 0.55;

/**
 * The seats under an editor rectangle (centre, size), measured from the seat
 * map itself: rows, seats per row, the seat pitch in editor units, and the
 * cards' real shape from the seats' 3D positions. `accept` limits it to one
 * tier or one stand. Null when the rectangle holds fewer than four seats.
 */
export function seatShapeAt(
  map: SeatMap,
  rect: { cx: number; cy: number; width: number; height: number },
  accept?: (i: number) => boolean,
  wrapWidth?: number,
): SeatShape | null {
  // Edges included, as core/layers.ts stampObject includes them.
  const x0 = rect.cx - rect.width / 2 - 1e-6;
  const x1 = rect.cx + rect.width / 2 + 1e-6;
  const y0 = rect.cy - rect.height / 2 - 1e-6;
  const y1 = rect.cy + rect.height / 2 + 1e-6;
  const perRow = new Map<number, number>();
  const inside: number[] = [];
  for (let i = 0; i < map.count; i++) {
    if (accept && !accept(i)) continue;
    const y = map.xy[i * 2 + 1];
    if (y < y0 || y > y1) continue;
    let x = map.xy[i * 2];
    if ((x < x0 || x > x1) && wrapWidth) {
      if (x + wrapWidth >= x0 && x + wrapWidth <= x1) x += wrapWidth;
      else if (x - wrapWidth >= x0 && x - wrapWidth <= x1) x -= wrapWidth;
    }
    if (x < x0 || x > x1) continue;
    const key = map.tierOf[i] * 4096 + map.rowOf[i];
    perRow.set(key, (perRow.get(key) ?? 0) + 1);
    inside.push(i);
  }
  if (inside.length < 4) return null;
  let seats = 0;
  for (const n of perRow.values()) seats = Math.max(seats, n);
  // The pitch from the rows that are (nearly) full across the rectangle.
  const full = [...perRow.values()].filter((n) => n >= seats * 0.8);
  const median = full.sort((a, b) => a - b)[Math.floor(full.length / 2)] ?? seats;
  // The cards' shape: neighbours across (slot 1, the right) and up the rake (slot 3), in metres.
  const across: number[] = [];
  const up: number[] = [];
  const P = map.pos3;
  const dist = (a: number, b: number): number => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  const step = Math.max(1, Math.floor(inside.length / 400));
  for (let k = 0; k < inside.length; k += step) {
    const i = inside[k];
    const r = map.neighbors[i * 4 + 1];
    const u = map.neighbors[i * 4 + 3];
    if (r >= 0 && map.rowOf[r] === map.rowOf[i]) across.push(dist(i, r));
    if (u >= 0 && map.tierOf[u] === map.tierOf[i]) up.push(dist(i, u));
  }
  const mid = (v: number[]): number => v.sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? NaN;
  const a = mid(across);
  const b = mid(up);
  // An aisle or a vomitory is a long neighbour link; the medians ignore them.
  const cell = Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? Math.max(0.25, Math.min(1.5, a / b)) : DEFAULT_CELL;
  return { rows: perRow.size, seats, pitch: rect.width / Math.max(1, median), cell };
}

/**
 * The picture shape (width over height, in the picture's own pixels) that
 * fills `rows` rows and `seats` seats of a stand without stretching the face:
 * each seat is `cell` as wide as a row is tall.
 */
export function pictureAspectFor(seats: number, rows: number, cell: number): number {
  return (seats * cell) / Math.max(1, rows);
}

/**
 * The size of a portrait in editor units (width, height) whose crop has the
 * picture shape `aspect`, `rows` rows tall, on a stand of this shape: as wide
 * as the face needs on the real stand (the cards' shape), whatever the
 * editor's own units would make of it, and never wider than the stand.
 */
export function portraitFootprint(aspect: number, rows: number, shape: SeatShape): { width: number; height: number; seats: number } {
  const seats = Math.max(2, Math.min(shape.seats, Math.round((aspect * rows) / shape.cell)));
  return { width: seats * shape.pitch, height: rows * ROW_UNITS, seats };
}

/** Editor units between two rows (seatmap.ts ROW_PX). */
export const ROW_UNITS = 8;

/**
 * The card most of the seats under an editor rectangle already show (in
 * `cells`, the design beneath a picture), or -1 when none is. A picture
 * cut out of its background lands on this colour, so a tone of the picture
 * in the same card would melt into it: the styles and the AI pictures'
 * posterising leave it out when they have cards to spare.
 */
export function underAt(
  map: SeatMap,
  cells: Uint8Array,
  rect: { cx: number; cy: number; width: number; height: number },
  accept?: (i: number) => boolean,
  wrapWidth?: number,
): number {
  const x0 = rect.cx - rect.width / 2;
  const x1 = rect.cx + rect.width / 2;
  const y0 = rect.cy - rect.height / 2;
  const y1 = rect.cy + rect.height / 2;
  const counts = new Map<number, number>();
  let n = 0;
  for (let i = 0; i < map.count; i++) {
    if (accept && !accept(i)) continue;
    const y = map.xy[i * 2 + 1];
    if (y < y0 || y > y1) continue;
    let x = map.xy[i * 2];
    if ((x < x0 || x > x1) && wrapWidth) x += x < x0 ? wrapWidth : -wrapWidth;
    if (x < x0 || x > x1) continue;
    counts.set(cells[i], (counts.get(cells[i]) ?? 0) + 1);
    n++;
  }
  let best = -1;
  let most = 0;
  for (const [v, c] of counts) if (c > most) { most = c; best = v; }
  // Slot 0 is the empty seat, and a mix of colours has no one colour to avoid.
  return best > 0 && most >= n * 0.5 ? best : -1;
}
