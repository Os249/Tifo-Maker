/**
 * A portrait style drawn at print size, and the banner that carries it.
 *
 * A stand of a dozen rows cannot hold a face in cards: the eyes, the nose
 * and the mouth each need three seats, and there are not enough rows for
 * them. A banner can: it is printed, so the same style is drawn at full
 * resolution and laid over the middle of the stand, and the cards around it
 * carry the club colours and the words. Used by the import bar's "Put the
 * face on a banner" (proStyles.ts) and by the lab (scripts/portrait-shots).
 */
import { DEFAULT_FABRIC, newBanner, type BannerDoc, type StandIndex } from '../core/banner';
import type { SeatMap } from '../core/types';
import type { FaceInfo } from '../core/portraitPipeline';
import { duotoneRamp, stylePortrait, type PortraitStyle } from '../core/portraitStyles';
import { rasterize } from '../core/importImage';

/** Rows a style is drawn at for print, before it is scaled up three times. */
const PRINT_ROWS = 320;

/** The style drawn for print: palette colours (the duotone a smooth ramp), transparent outside the subject. */
export function printPortrait(
  p: { bitmap: ImageBitmap; face?: FaceInfo | null },
  style: PortraitStyle,
  palette: readonly string[],
  under = -1,
): HTMLCanvasElement {
  const rows = PRINT_ROWS;
  const cols = Math.max(8, Math.round((rows * p.bitmap.width) / p.bitmap.height));
  const px = rasterize(p.bitmap, cols, rows);
  const opts = { alphaThreshold: 128, aspect: 1, face: p.face ?? null, under };
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const g = c.getContext('2d')!;
  const img = g.createImageData(cols, rows);
  if (style === 'duotone') {
    img.data.set(duotoneRamp(px, cols, rows, palette, opts));
  } else {
    const out = stylePortrait(style, px, cols, rows, palette, opts);
    const rgb = palette.map((h) => {
      const v = parseInt(String(h).replace('#', '').slice(0, 6), 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    });
    for (let k = 0; k < out.length; k++) if (out[k] >= 0) img.data.set([...rgb[out[k]], 255], k * 4);
  }
  g.putImageData(img, 0, 0);
  // Three times up: flat tones kept hard-edged, the ramp smooth.
  const big = document.createElement('canvas');
  big.width = cols * 3;
  big.height = rows * 3;
  const bg = big.getContext('2d')!;
  bg.imageSmoothingEnabled = style === 'duotone';
  bg.drawImage(c, 0, 0, big.width, big.height);
  return big;
}

/** A style drawn for print, and how tall the face is in it (a share of its height). */
export interface FacePrint {
  canvas: HTMLCanvasElement;
  face: number;
}

/** The face's height (brow to chin, and a little forehead) as a share of the picture's, from its detection box. */
export function faceShareOf(face: FaceInfo | null | undefined): number {
  return face ? Math.max(0.2, Math.min(0.9, face.box[3] * 1.25)) : 0.5;
}

/** How a face banner is cut and hung. */
export interface FaceLayout {
  kind: 'stand' | 'hanging';
  tier: number;
  blockSpan: number;
  /** The sheet's height over its width. */
  aspect: number;
  /** The face at one end of a long cloth, the words beside it. */
  words: boolean;
}

export interface FaceBannerOptions {
  name: string;
  stand: StandIndex;
  tier: number;
  bg?: string;
  /** The club's words for a long cloth, and their colour. */
  words?: string;
  wordsColor?: string;
}

/** A face banner for this layout: the picture filling the sheet, or at its left end with the words beside it. */
export function faceBannerDoc(print: FacePrint | HTMLCanvasElement, o: FaceBannerOptions & { kind?: 'stand' | 'hanging' }, layout?: FaceLayout): BannerDoc {
  const p = print instanceof HTMLCanvasElement ? { canvas: print, face: 0.5 } : print;
  const img = p.canvas.height / Math.max(1, p.canvas.width);
  const l: FaceLayout = layout ?? { kind: o.kind ?? 'stand', tier: o.tier, blockSpan: 1, aspect: Math.max(0.6, Math.min(1.6, img)), words: false };
  const doc = newBanner(l.kind, o.name);
  doc.aspect = l.aspect;
  doc.bg = o.bg ?? DEFAULT_FABRIC;
  doc.slot = { ...doc.slot, stand: o.stand, stands: 1, blockFrom: -1, blockSpan: l.blockSpan, tier: l.tier };
  const src = p.canvas.toDataURL('image/png');
  const id = `m${Date.now().toString(36)}`;
  const A = l.aspect;
  if (l.words && o.words) {
    // The face at the left end, the sheet's full height; the words in the rest.
    const h = A;
    const w = Math.min(0.5, h / img);
    doc.items = [
      { id, kind: 'image', src, name: o.name, cx: w / 2, cy: h / 2, w, h, rot: 0, opacity: 1 },
      { id: `${id}t`, kind: 'text', role: 'message', text: o.words, fontId: 'condensed', arcDeg: 0, color: o.wordsColor ?? '#141414', cx: w + (1 - w) / 2, cy: h / 2, w: (1 - w) * 0.9, h: h * 0.6, rot: 0 },
    ];
  } else {
    // The picture as large as the sheet takes it, in the middle, its shape kept.
    const w = Math.min(1, A / img);
    const h = w * img;
    doc.items = [{ id, kind: 'image', src, name: o.name, cx: 0.5, cy: A / 2, w, h, rot: 0, opacity: 1 }];
  }
  return doc;
}

/** The face's height in the TV gantry's picture, as a share of it, for a face banner. */
export interface FacePlan {
  doc: BannerDoc;
  layout: FaceLayout;
  crop: 'shoulders' | 'face';
  /** The face's height over the picture's height, from the TV gantry. */
  share: number;
  /** The sheet, metres. */
  widthM: number;
  heightM: number;
}

/** What a face needs to read on television: a fifth of the picture's height. */
export const FACE_SHARE_MIN = 0.2;

/**
 * The face banner sized for the TV gantry (render/simulator/tvShot.ts): the
 * least cloth that makes the face a fifth of the picture's height, or the
 * biggest face the ground allows when nothing reaches that. Tried on the ground's own
 * frame: laid over the stand's whole height or over one tier, flown from
 * the roof in front of it (as tall as the air there allows), each with the
 * head and shoulders or the face alone, and, when the design has words, a
 * long cloth with the face at one end and the words beside it. A stand
 * banner one block wide when the frame cannot be had.
 */
export async function bestFaceBanner(
  prints: { shoulders: FacePrint; face: FacePrint },
  map: SeatMap,
  o: FaceBannerOptions,
): Promise<FacePlan> {
  const fallback = (): FacePlan => {
    const layout: FaceLayout = { kind: 'stand', tier: o.tier, blockSpan: 1, aspect: 1, words: false };
    return { doc: faceBannerDoc(prints.shoulders, o, layout), layout, crop: 'shoulders', share: 0, widthM: 0, heightM: 0 };
  };
  try {
    const [{ spanFrameCache }, slots, { tvShot }] = await Promise.all([
      import('../render/simulator/standFrame'),
      import('../render/simulator/bannerSlot'),
      import('../render/simulator/tvShot'),
    ]);
    const frameFor = spanFrameCache(map);
    const frame = frameFor(o.stand, 1);
    const tv = tvShot(frameFor, o.stand);
    if (!frame.ok || !tv) return fallback();
    const layouts: FaceLayout[] = [];
    for (const blockSpan of [1, 2, 3]) {
      for (const aspect of [1, 1.3, 1.6]) layouts.push({ kind: 'hanging', tier: -1, blockSpan, aspect, words: false });
      for (const aspect of [0.8, 1.1]) layouts.push({ kind: 'stand', tier: -1, blockSpan, aspect, words: false });
    }
    if (o.tier >= 0) for (const blockSpan of [1, 2]) for (const aspect of [0.8, 1.1]) layouts.push({ kind: 'stand', tier: o.tier, blockSpan, aspect, words: false });
    if (o.words) {
      for (const blockSpan of [3, 4, 6]) {
        layouts.push({ kind: 'stand', tier: -1, blockSpan, aspect: 0.25, words: true });
        layouts.push({ kind: 'hanging', tier: -1, blockSpan, aspect: 0.35, words: true });
      }
    }
    const plans: FacePlan[] = [];
    for (const layout of layouts) {
      for (const crop of ['shoulders', 'face'] as const) {
        const print = prints[crop];
        const doc = faceBannerDoc(print, o, layout);
        try {
          slots.settleSlot(doc, frame);
          if (doc.slot.tier !== layout.tier) continue;
          const slot = slots.resolveSlot(doc, frame);
          const img = doc.items[0];
          if (img.kind !== 'image') continue;
          const A = doc.slotAspect ?? doc.aspect;
          const faceM = slot.size.heightM * (img.h / A) * print.face;
          const alongU = (slot.u0 + slot.u1) / 2;
          const at = doc.kind === 'hanging' ? slots.hangCentre(frame, slot) : frame.pointAt(alongU, Math.max(0, (slot.v1 + slot.vBottom) / 2));
          const share = faceM / tv.frameHeightAt(tv.distanceTo(at));
          plans.push({ doc, layout, crop, share, widthM: slot.size.widthM, heightM: slot.size.heightM });
        } catch {
          /* a layout this stand cannot take */
        }
      }
    }
    // Sized to the yardstick: the least cloth that makes the face a fifth of
    // the picture (the more of the stand stays cards, the better), else the
    // biggest face the ground allows.
    const area = (p: FacePlan): number => p.widthM * p.heightM;
    const enough = plans.filter((p) => p.share >= FACE_SHARE_MIN).sort((a, b) => area(a) - area(b) || a.share - b.share);
    const best = enough[0] ?? plans.sort((a, b) => b.share - a.share || area(a) - area(b))[0];
    return best ?? fallback();
  } catch {
    return fallback();
  }
}
