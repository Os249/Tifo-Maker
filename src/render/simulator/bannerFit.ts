import type { BannerDoc } from '../../core/banner';
import { KIND_PROFILE } from '../../core/banner';
import type { StandFrame } from './standFrame';

/**
 * Where a banner goes, and how big the stand will let it be.
 *
 * One place decides both, because they are the same decision. The editor lets
 * you draw at any size, which is right — you are designing artwork, not
 * ordering fabric. Match Day is the stadium, and a stadium has a finite
 * amount of stand in it.
 *
 * Two things were wrong before this module existed, and both are visible in
 * the same screenshot: a 48 x 28 m sheet placed on a stand with 18 m of slope
 * above the chosen point, which hung off the top of the ground and into the
 * skyline; and a continuous "Along" slider, which gives a banner no reason to
 * line up with anything. Real crews do not think in slider positions. They
 * think "blocks 3 to 5, upper tier", because that is what the stand is
 * divided into and what they can actually get people into.
 *
 * So placement is a run of blocks and a tier, and the size is whatever that
 * run can hold. Everything here is pure: frame in, geometry out, no Three.js
 * and no DOM, so it can be checked without a browser.
 */

export interface FittedBanner {
  /** Resolved placement, in the stand's own coordinates. */
  alongU: number;
  heightV: number;
  /** The size the banner is actually built at, in metres. */
  widthM: number;
  heightM: number;
  /** The size the document asked for. */
  askedWidthM: number;
  askedHeightM: number;
  /** The most this slot can take. */
  maxWidthM: number;
  maxHeightM: number;
  /** True when the stand made it smaller than the document asked for. */
  cut: boolean;
  /** The blocks it ends up covering, resolved and clamped to the stand. */
  blockFrom: number;
  blockSpan: number;
  /** The tier it sits in; -1 for the whole face. */
  tier: number;
}

/** A banner covering every block there is, for "the whole stand". */
export const BLOCK_SPAN_MAX = 32;

/**
 * How much stand a banner of this kind is allowed to use.
 *
 * Not one rule for everything, because the limit is a different physical
 * thing in each case: a stand cover is bounded by the terracing, a fence
 * banner by the height of the fence, a pole banner by how long a pole two
 * people can hold up, and a pitch banner by the grass.
 */
function reachOf(kind: BannerDoc['kind'], frame: StandFrame, tier: number): { maxW: number; maxH: number } {
  const band = tier >= 0 && tier < frame.tiers.length ? frame.tiers[tier] : null;
  const slope = band ? band.slopeM : frame.slopeM;
  switch (kind) {
    // On the terracing: bounded by the terracing.
    case 'drop':
    case 'lift':
    case 'overhead-pass':
    case 'stand-cover':
      return { maxW: frame.widthM, maxH: slope };
    // In the air in front of the stand: bounded by the air.
    case 'roof-hung':
      return { maxW: frame.widthM, maxH: Math.max(4, frame.roofY - frame.railY - 2) };
    // Two people and two poles. Beyond about eight metres of pole nobody is
    // holding it up in any wind at all.
    case 'pole-out':
      return { maxW: Math.min(frame.widthM, 30), maxH: 9 };
    // A fence banner taller than the fence is not a fence banner.
    case 'fence':
      return { maxW: frame.widthM, maxH: 3 };
    // On the grass. A pitch is 68 m across at its widest and the banner has
    // to sit inside the markings, not on them.
    case 'pitch':
    default:
      return { maxW: 60, maxH: 60 };
  }
}

/** Does this kind hang from its top edge, or stand up from its bottom one? */
function bottomAnchored(doc: BannerDoc): boolean {
  return doc.reveal === 'lift' || doc.reveal === 'unfold';
}

export function fitBanner(doc: BannerDoc, frame: StandFrame): FittedBanner {
  const nBlocks = Math.max(1, frame.blocks.length);
  const askedWidthM = Math.max(0.5, doc.widthM);
  const askedHeightM = Math.max(0.3, doc.heightM);

  // ---- which tier -------------------------------------------------------
  const tier = doc.place.tier >= 0 && doc.place.tier < frame.tiers.length ? doc.place.tier : -1;
  const band = tier >= 0 ? frame.tiers[tier] : null;

  // ---- which blocks -----------------------------------------------------
  const useBlocks = doc.place.blockSpan > 0;
  // A negative first block with a span means "that many blocks, centred",
  // which is where a tifo goes unless someone says otherwise — and it is the
  // only sane default when the number of blocks depends on the ground. It
  // also keeps banners off the corners, where a stand curves hardest and a
  // flat sheet and a round rail have the most to argue about.
  const centred = Math.round((nBlocks - Math.max(1, Math.round(doc.place.blockSpan))) / 2);
  let blockFrom = doc.place.blockFrom < 0
    ? Math.max(0, Math.min(nBlocks - 1, centred))
    : Math.max(0, Math.min(nBlocks - 1, Math.round(doc.place.blockFrom)));
  let blockSpan = Math.max(1, Math.min(nBlocks - blockFrom, Math.round(doc.place.blockSpan)));
  let alongU: number;
  let runWidthM: number;
  if (useBlocks) {
    const a = frame.blocks[blockFrom];
    const b = frame.blocks[Math.min(nBlocks - 1, blockFrom + blockSpan - 1)];
    alongU = (a.u0 + b.u1) / 2;
    runWidthM = (b.u1 - a.u0) * frame.widthM;
  } else {
    blockFrom = -1;
    blockSpan = 0;
    alongU = Math.max(0, Math.min(1, doc.place.alongU));
    runWidthM = frame.widthM;
  }

  const reach = reachOf(doc.kind, frame, tier);
  const maxWidthM = Math.min(reach.maxW, runWidthM);
  const maxHeightM = reach.maxH;

  // ---- size -------------------------------------------------------------
  //
  // Scaled, never squashed. Clamping width and height independently would
  // change the shape of the banner, and the artwork is normalised to the
  // banner's width — so an independently clamped banner shows a stretched
  // version of the design the user drew. Scaling keeps the design and only
  // makes it smaller, which is what "it did not fit" should look like.
  const aspect = askedHeightM / askedWidthM;
  let widthM: number;
  if (useBlocks) {
    // Chosen blocks means exactly those blocks: the banner is as wide as the
    // run and its height follows the design's own proportions.
    widthM = maxWidthM;
  } else {
    widthM = Math.min(askedWidthM, maxWidthM);
  }
  let heightM = widthM * aspect;
  if (heightM > maxHeightM) {
    const s = maxHeightM / heightM;
    heightM = maxHeightM;
    widthM *= s;
  }

  // ---- how high up ------------------------------------------------------
  let heightV: number;
  if (doc.kind === 'roof-hung' || doc.kind === 'pitch') {
    // Neither of these sits on the terracing, so a tier means nothing to
    // them: one flies in front of the stand and the other lies on the grass.
    heightV = Math.max(0, Math.min(1.4, doc.place.heightV));
  } else if (band) {
    // Anchored to the tier's own edge: the rail it is tied to for anything
    // built upward, the back rail it hangs from for anything built down.
    heightV = bottomAnchored(doc) ? band.v0 : band.v1;
  } else {
    heightV = Math.max(0, Math.min(1.4, doc.place.heightV));
  }

  const cut = widthM < askedWidthM - 1e-3 || heightM < askedHeightM - 1e-3;
  return {
    alongU,
    heightV,
    widthM,
    heightM,
    askedWidthM,
    askedHeightM,
    maxWidthM,
    maxHeightM,
    cut,
    blockFrom,
    blockSpan,
    tier,
  };
}

/**
 * A short sentence for the panel when the stadium overruled the editor.
 *
 * Silently resizing someone's artwork is worse than not fitting it: they
 * chose 48 by 28 for a reason, and if the ground cannot take it they should
 * be told in metres rather than left to notice.
 */
export function fitNote(fit: FittedBanner): string | null {
  if (!fit.cut) return null;
  return `${fit.askedWidthM.toFixed(0)}x${fit.askedHeightM.toFixed(0)} m does not fit here; cut to ${fit.widthM.toFixed(0)}x${fit.heightM.toFixed(0)} m`;
}

/** The natural size for a run of blocks — what the UI offers when you pick them. */
export function sizeForBlocks(doc: BannerDoc, frame: StandFrame, from: number, span: number): { widthM: number; heightM: number } {
  const probe: BannerDoc = { ...doc, place: { ...doc.place, blockFrom: from, blockSpan: span } };
  const fit = fitBanner(probe, frame);
  return { widthM: fit.widthM, heightM: fit.heightM };
}

/** Every kind's reach on this stand, for the panel's limits. */
export function reachFor(kind: BannerDoc['kind'], frame: StandFrame, tier: number): { maxW: number; maxH: number } {
  void KIND_PROFILE;
  return reachOf(kind, frame, tier);
}
