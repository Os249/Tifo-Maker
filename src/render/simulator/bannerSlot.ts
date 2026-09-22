import type { BannerDoc, BannerSlot, BannerSize, StandIndex } from '../../core/banner';
import type { StandFrame } from './standFrame';

/**
 * A slot, resolved against a real stand.
 *
 * Everything downstream — the geometry, the camera, the panel, the tests —
 * works from this and nothing else. It is a pure function of a document and a
 * stand frame: no Three.js, no DOM, no state, so it can be enumerated and
 * checked without a browser.
 *
 * The point of the slot is that the set of them is FINITE. Four stands, every
 * contiguous run of a stand's blocks, every tier: about 864 per ground. That
 * is a space to prove, not a space to sample, and proving it is the only
 * honest answer to "it breaks when I change something".
 */

export interface ResolvedSlot {
  stand: StandIndex;
  /** The run of blocks, clamped to the stand. */
  blockFrom: number;
  blockSpan: number;
  /** Extent across the stand, in the stand's own `alongU`. */
  u0: number;
  u1: number;
  /** The tier, or -1 for the whole stand / the roof. */
  tier: number;
  /** Extent up the stand, in `heightV`. */
  v0: number;
  v1: number;
  /**
   * Where the banner's bottom edge sits, in `heightV`.
   *
   * The single number that lays the sheet out, and it lives here rather than
   * in the geometry so that the renderer, the camera and the test all read
   * the same one. The last version had the test derive it with its own
   * formula; the formula drifted from the surface's and reported a wall of
   * failures against geometry that was right.
   */
  vBottom: number;
  /** What the banner is actually built at, in metres. */
  size: BannerSize;
  /** The most this slot could hold, for the panel. */
  maxWidthM: number;
  maxHeightM: number;
  /** True when the artwork's shape, not the blocks, decided the width. */
  heightLimited: boolean;
}

/**
 * Every slot a stand offers, in the order a person would read them.
 *
 * Used by the panel to fill its pickers, and by the tests to enumerate the
 * whole space. `blockFrom` is always concrete here — never the -1 that means
 * "centred" — because this is the list of real places, not of intents.
 */
export function slotsOf(frame: StandFrame, stand: StandIndex): BannerSlot[] {
  const out: BannerSlot[] = [];
  const nb = Math.max(1, frame.blocks.length);
  const tiers: number[] = [-1];
  for (let t = 0; t < frame.tiers.length; t++) tiers.push(t);
  for (const tier of tiers) {
    for (let from = 0; from < nb; from++) {
      for (let span = 1; from + span <= nb; span++) {
        out.push({ stand, blockFrom: from, blockSpan: span, tier });
      }
    }
  }
  return out;
}

/** How many slots a stand offers. `n(n+1)/2` runs × the tier choices. */
export function slotCount(frame: StandFrame): number {
  const nb = Math.max(1, frame.blocks.length);
  return ((nb * (nb + 1)) / 2) * (frame.tiers.length + 1);
}

/**
 * How high the crowd holds a sheet off the concrete, in metres.
 *
 * A banner drawn over a full block does not lie on the terracing — it lies on
 * the people, and stays about head height above the treads for as long as
 * they hold it. It needs a crowd to work: one person cannot hold up a sheet
 * spanning twenty rows, a packed block can, because the support is
 * continuous. So it comes in over the fill fraction rather than switching on.
 */
export function crowdSupportM(fill: number): number {
  const t = (fill - 0.15) / 0.45;
  const s = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  return 1.72 * s;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Resolve a document's slot against a stand.
 *
 * The size comes out of here rather than going in, and that is the whole
 * design: a banner is as wide as the blocks it covers, and as deep as its
 * artwork's proportions make it. There is no configuration in which the size
 * does not fit, because the slot IS the size.
 */
export function resolveSlot(doc: BannerDoc, frame: StandFrame): ResolvedSlot {
  const nb = Math.max(1, frame.blocks.length);
  const span = Math.round(clamp(doc.slot.blockSpan, 1, nb));
  // A negative first block means "centre the run", which is where a tifo goes
  // unless someone moves it — and the only sane default when the number of
  // blocks depends on which ground you are in. It also keeps banners off the
  // corners, where a stand curves hardest.
  const from = doc.slot.blockFrom < 0
    ? Math.round((nb - span) / 2)
    : Math.round(clamp(doc.slot.blockFrom, 0, nb - span));
  const a = frame.blocks[from];
  const b = frame.blocks[Math.min(nb - 1, from + span - 1)];

  const tier = doc.slot.tier >= 0 && doc.slot.tier < frame.tiers.length ? doc.slot.tier : -1;
  const band = tier >= 0
    ? frame.tiers[tier]
    : { v0: 0, v1: 1, slopeM: frame.slopeM };

  // Measured at the height the banner will actually sit, not at the front
  // rail. A bowl's back row is half as long again as its rail for the same
  // blocks, and a banner sized off the rail comes out a third too small,
  // with the wrong seam count and the wrong weight.
  //
  // A banner on a fanning stand is a trapezoid, so "its width" has to mean
  // something: it means the width across the middle of the SHEET. Which
  // depends on how deep the sheet is, which depends on its width — so it is
  // solved rather than assumed, by measuring at the middle of the band,
  // seeing where the bottom edge lands, and measuring again there. One pass
  // is enough; the second correction is under a per cent.
  let sizingV = doc.kind === 'hanging' ? band.v0 : (band.v0 + band.v1) / 2;
  let maxWidthM = frame.widthAt(a.u0, b.u1, sizingV);
  // What is available going DOWN from the top of the band, measured up the
  // slope across the banner's own run rather than at the stand's middle. A
  // hanging banner is bounded by air rather than by terracing.
  const rakeM = Math.max(1, frame.slopeAt(a.u0, b.u1, band.v0, band.v1));
  const maxHeightM = doc.kind === 'hanging'
    ? Math.max(4, hangDrop(frame, tier))
    : rakeM;

  if (doc.kind === 'stand') {
    const deep = Math.min(maxHeightM, maxWidthM * clamp(doc.aspect, 0.05, 6));
    const dv = (deep / rakeM) * (band.v1 - band.v0);
    sizingV = Math.max(band.v0, band.v1 - dv / 2);
    maxWidthM = frame.widthAt(a.u0, b.u1, sizingV);
  }

  // Fill the blocks; let the artwork's shape decide the depth; shrink both
  // together if that is deeper than the slot can take. Scaled, never
  // squashed: the artwork is normalised to the banner's width, so clamping
  // the two independently would show a design the user never drew.
  const aspect = clamp(doc.aspect, 0.05, 6);
  let widthM = maxWidthM;
  let heightM = widthM * aspect;
  let heightLimited = false;
  let u0 = a.u0;
  let u1 = b.u1;
  if (heightM > maxHeightM) {
    heightLimited = true;
    widthM = maxHeightM / aspect;
    // And ACTUALLY be that narrow, centred on the chosen blocks.
    //
    // Reporting a smaller width while still drawing across the whole run is
    // how a 54 m banner came out as 103 m of fabric with the wrong artwork
    // scale on it. A stand is not straight, so the `u` that gives a width is
    // found by asking rather than by dividing: six bisections land inside a
    // hundredth of a metre and only run when the stand has overruled the
    // blocks, which is rare.
    const midUu = (a.u0 + b.u1) / 2;
    const halfU = (b.u1 - a.u0) / 2;
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 10; k++) {
      const m = (lo + hi) / 2;
      const w = frame.widthAt(midUu - halfU * m, midUu + halfU * m, sizingV);
      if (w > widthM) hi = m; else lo = m;
    }
    // `lo`, not the midpoint. `lo` is the largest run KNOWN to be under the
    // target, so the banner is at worst a tenth of a per cent too small;
    // the midpoint sits anywhere in the bracket and came out 48.6 m of sheet
    // in a 47.8 m slot — over the rake, which is the one thing this is for.
    const f = lo;
    u0 = midUu - halfU * f;
    u1 = midUu + halfU * f;
    // The measured width of the run we settled on, and the depth its own
    // proportions ask for. NOT re-clamped to the rake: the bisection already
    // made it fit, and clamping here again is what quietly changed the shape
    // of a cut banner by a per cent — which is a design the user never drew.
    widthM = frame.widthAt(u0, u1, sizingV);
    heightM = widthM * aspect;
  }

  // How far down the band the sheet reaches. The rake is near enough uniform
  // across a run of blocks — 1 to 6% on every ground in the catalogue — so
  // the depth converts to height by one ratio, and the bottom edge comes out
  // as a straight line along a row of seating, which is what a Blockfahne
  // looks like in every photograph of one.
  const vBottom = doc.kind === 'hanging'
    ? band.v0
    : Math.max(band.v0, band.v1 - (heightM / rakeM) * (band.v1 - band.v0));

  return {
    stand: doc.slot.stand,
    blockFrom: from,
    blockSpan: span,
    u0,
    u1,
    tier,
    v0: band.v0,
    v1: band.v1,
    vBottom,
    size: { widthM, heightM },
    maxWidthM,
    maxHeightM,
    heightLimited,
  };
}

/**
 * How much air a hanging banner has under its rigging, in metres.
 *
 * From wherever it is tied — the roof steel, or the lip of a tier — down to a
 * couple of metres above the front rail. It is bounded by the building, which
 * is why a hanging banner cannot be made to reach the skyline, and it is NOT
 * bounded by the tier below: a sheet flown over the front of an upper tier
 * hangs down across the lower tier's view, which is the entire point of
 * hanging it there and is what every photograph of one shows.
 *
 * The first version stopped it at the tier below. On a two-tier bowl that is
 * about four metres of air, so a 37 m banner was scaled down to keep its
 * proportions and came out as a seven-metre handkerchief.
 */
export function hangDrop(frame: StandFrame, tier: number): number {
  const top = tier < 0 || tier >= frame.tiers.length
    ? frame.roofY - 1.5
    : frame.pointAt(0.5, frame.tiers[tier].v0).y;
  return Math.max(4, top - frame.railY - 2);
}

/**
 * How far out a hanging banner has to sit to hang clear, in metres.
 *
 * A sheet flown on a cable hangs straight down, and anything the stand puts
 * under its anchor is in the way. From the roof that is nothing — the roof's
 * leading edge is already out over the front rail — but from the lip of an
 * upper tier the whole of the lower tier is below, so a banner hung at arm's
 * length from that lip drops through twenty rows of seats and is simply not
 * visible. In the shots it did not appear at all.
 *
 * Going down a stand the radius shrinks, so the front rail is the innermost
 * thing there is: standing the sheet off by the difference in radius, plus a
 * margin, guarantees it hangs in front of everything below it. Which is what
 * a real one does — a tifo flown off the upper deck hangs out over the lower
 * one, on ropes, in the air.
 */
export function hangStandoff(frame: StandFrame, slot: ResolvedSlot): number {
  const u = (slot.u0 + slot.u1) / 2;
  const anchorV = slot.tier < 0 ? 0 : frame.tiers[slot.tier].v0;
  const a = frame.pointAt(u, anchorV);
  const rail = frame.pointAt(u, 0);
  const dr = Math.hypot(a.x, a.z) - Math.hypot(rail.x, rail.z);
  return Math.max(0.9, dr + 1.2);
}

/**
 * Where a hanging banner's top edge is, in world Y.
 *
 * The lip of the tier it hangs over, or the roof steel. Both are in front of
 * the terracing by construction, which is why a hanging banner never has to
 * be checked against the stand: there is nothing behind it to hit.
 */
export function hangAnchorY(frame: StandFrame, slot: ResolvedSlot): number {
  if (slot.tier < 0) return frame.roofY - 1.5;
  return frame.pointAt(0.5, frame.tiers[slot.tier].v0).y;
}

/**
 * Where a hanging banner actually is, in world space.
 *
 * Not where the stand is. A hanging banner is held off its anchor by however
 * much it takes to clear the terracing below — which on an upper tier is ten
 * metres or more — so a camera aimed at the stand behind it is aimed at the
 * seats, with the sheet hanging somewhere off the side of the frame. That is
 * exactly what the shots showed: a banner with correct geometry and nothing
 * visible in the picture.
 */
export function hangCentre(frame: StandFrame, slot: ResolvedSlot): { x: number; y: number; z: number } {
  const u = (slot.u0 + slot.u1) / 2;
  const anchorV = slot.tier < 0 ? 0 : frame.tiers[slot.tier].v0;
  const p = frame.pointAt(u, anchorV);
  const off = hangStandoff(frame, slot);
  return {
    x: p.x + p.ox * off,
    y: hangAnchorY(frame, slot) - slot.size.heightM / 2,
    z: p.z + p.oz * off,
  };
}

/**
 * The seats a banner hides, as a fraction of the stand.
 *
 * The real trade a tifo crew makes, and the thing no other tool tells you: a
 * sheet over blocks 3 to 5 of the upper tier is a sheet over everyone holding
 * a card in blocks 3 to 5 of the upper tier.
 */
export function occludedFraction(slot: ResolvedSlot, frame: StandFrame): number {
  void frame;
  const acrossFrac = slot.u1 - slot.u0;
  return Math.max(0, Math.min(1, acrossFrac * (slot.v1 - slot.vBottom)));
}
