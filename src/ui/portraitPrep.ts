/**
 * A photo made ready for a portrait style on one stand (Pro): the subject
 * lifted off its background, the face found, the picture cropped to a head
 * and shoulders (or the face alone, on a stand too small for more) and sized
 * to fill the stand's rows at the shape its seats really are.
 *
 * Browser-only (canvas, ImageBitmap) and lazy: proStyles.ts loads it the
 * first time a style is picked. Every decision is in core/portraitPipeline.ts
 * and core/matte.ts, where the tests and the contact sheets see it.
 *
 *   1. the subject: the picture's own cut-out when it has one (the smart
 *      cut-out, or a PNG that came transparent), else the browser's person
 *      mask (portraitVision.ts), snapped to the photo's edges with a guided
 *      filter; either way cleaned (islands, holes, a halo-free edge) and the
 *      background's colour taken out of the edge;
 *   2. the face and its 68 landmarks;
 *   3. the crop, sized to fill the stand's rows, as wide as the face needs on
 *      the real stand (portraitFootprint), drawn at the editor's shape so the
 *      placed layer covers exactly those seats.
 *
 * With no face found, the picture is kept whole (a badge, a falcon) and only
 * cut out; the style still draws it, on tone alone.
 */
import {
  cropKindFor, faceInCrop, pictureAspectFor, plausibleFace, portraitCrop, portraitFootprint,
  type CropKind, type FaceInfo, type SeatShape,
} from '../core/portraitPipeline';
import { alphaBounds, alphaOf, decontaminate, guidedFilter, hasMatte, lumaOf, refineMatte, resizeBilinear } from '../core/matte';
import { findFace, personMask } from './portraitVision';

export interface Prepared {
  /** The picture to place: cropped, cut out, at the editor's shape. */
  bitmap: ImageBitmap;
  /** The face in it (0..1 of the new picture), when there is one. */
  face: FaceInfo | null;
  kind: CropKind;
  /** Its footprint in editor units, and the seats and rows it covers. */
  width: number;
  height: number;
  seats: number;
  rows: number;
  /** Where the subject came from. */
  subject: 'cut-out' | 'local' | 'none';
}

/** The long edge the work is done at: well past what any stand or banner panel needs from a crop. */
const WORK_EDGE = 1280;
/** The prepared picture's height: a banner prints it, so more than the seats need. */
const OUT_HEIGHT = 768;

function rgbaOf(src: CanvasImageSource & { width: number; height: number }, edge: number): { data: Uint8ClampedArray; w: number; h: number } {
  const k = Math.min(1, edge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

function canvasFrom(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  return c;
}

/**
 * The person's mask over a region of the picture (in its pixels), from the
 * browser's own model: run on the region (a head and shoulders is what the
 * model was made for), scaled up and snapped to the photo's edges.
 */
async function localMask(img: { data: Uint8ClampedArray; w: number; h: number }, region: { x: number; y: number; w: number; h: number }): Promise<Float32Array> {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(img.w, Math.ceil(region.x + region.w));
  const y1 = Math.min(img.h, Math.ceil(region.y + region.h));
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  const sub = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++) sub.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1) * 4), y * rw * 4);
  const { mask, w, h } = await personMask(canvasFrom(sub, rw, rh));
  const up = resizeBilinear(mask, w, h, rw, rh);
  const snapped = guidedFilter(lumaOf(sub, rw, rh), up, rw, rh, Math.max(2, Math.round(Math.min(rw, rh) / 60)), 1e-3);
  const out = new Float32Array(img.w * img.h);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) out[(y0 + y) * img.w + x0 + x] = snapped[y * rw + x];
  return out;
}

/** The local mask covers most of the face's box, and is not the whole picture. */
function trustMask(alpha: Float32Array, w: number, face: FaceInfo): boolean {
  const h = alpha.length / w;
  const [bx, by, bw, bh] = face.box;
  let inFace = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(by * h)); y < Math.min(h, Math.ceil((by + bh) * h)); y++) {
    for (let x = Math.max(0, Math.floor(bx * w)); x < Math.min(w, Math.ceil((bx + bw) * w)); x++) {
      inFace += alpha[y * w + x];
      n++;
    }
  }
  let all = 0;
  for (let k = 0; k < alpha.length; k++) all += alpha[k];
  return n > 0 && inFace / n >= 0.6 && all / alpha.length <= 0.97;
}

const faces = new WeakMap<ImageBitmap, Promise<FaceInfo | null>>();

/**
 * Prepare `src` for a portrait on a stand of this shape. `rows` is how many
 * of the stand's rows it should fill (all of them, by default).
 */
export async function preparePortrait(src: ImageBitmap, shape: SeatShape, rows = shape.rows): Promise<Prepared> {
  const img = rgbaOf(src, WORK_EDGE);
  // The face is the picture's, not the stand's: looked for once per picture
  // (the second detector can take seconds on a slow phone).
  let look = faces.get(src);
  if (!look) {
    look = findFace(canvasFrom(img.data, img.w, img.h)).catch(() => null);
    faces.set(src, look);
  }
  const found = await look;
  const face = found && plausibleFace(found, img.w, img.h) ? found : null;
  const kind = cropKindFor(rows);
  // The widest crop the stand can take, at its cards' real shape.
  const standAspect = pictureAspectFor(shape.seats, rows, shape.cell);
  let crop = face ? portraitCrop(face, img.w, img.h, kind, standAspect) : { x: 0, y: 0, w: img.w, h: img.h };

  // 1. The subject.
  let subject: Prepared['subject'] = 'none';
  let alpha: Float32Array | null = null;
  if (hasMatte(img.data, img.w, img.h)) {
    alpha = alphaOf(img.data, img.w, img.h);
    subject = 'cut-out';
  } else if (face) {
    // A little more than the crop, so the mask's edge is not the crop's.
    const pad = 0.08;
    alpha = await localMask(img, { x: crop.x - crop.w * pad, y: crop.y - crop.h * pad, w: crop.w * (1 + 2 * pad), h: crop.h * (1 + 2 * pad) }).catch(() => null);
    // A mask that misses the face it was run for (a drawing, a statue, a
    // face the model does not take for a person) is no mask at all: the
    // picture is kept whole rather than cut down to nothing.
    if (alpha && !trustMask(alpha, img.w, face)) alpha = null;
    if (alpha) subject = 'local';
  }
  if (alpha) {
    refineMatte(alpha, img.w, img.h);
    decontaminate(img.data, alpha, img.w, img.h);
    // Without a face, the crop is the subject itself, so it fills the rows.
    if (!face) {
      const b = alphaBounds(alpha, img.w, img.h);
      if (b) {
        const m = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.02);
        crop = { x: b.x0 - m, y: b.y0 - m, w: b.x1 - b.x0 + 2 * m, h: b.y1 - b.y0 + 2 * m };
      }
    }
  }

  // 3. The footprint: the rows filled, as wide as the face needs on the real stand.
  const foot = portraitFootprint(crop.w / crop.h, rows, shape);
  // A stand narrower than the portrait: the crop narrows to it, about the face.
  const fitAspect = pictureAspectFor(foot.seats, rows, shape.cell);
  if (fitAspect < crop.w / crop.h - 1e-6) {
    const w = crop.h * fitAspect;
    crop = { ...crop, x: crop.x + (crop.w - w) / 2, w };
  }
  // Drawn at the editor's shape (width over height in editor units), so the
  // placed layer and its seats agree; the seats then show the face at its own.
  const outH = OUT_HEIGHT;
  const outW = Math.max(8, Math.round((outH * foot.width) / foot.height));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvasFrom(img.data, img.w, img.h), crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
  const bitmap = await createImageBitmap(canvas);
  return {
    bitmap,
    face: face ? faceInCrop(face, img.w, img.h, crop) : null,
    kind,
    width: foot.width,
    height: foot.height,
    seats: foot.seats,
    rows,
    subject,
  };
}
