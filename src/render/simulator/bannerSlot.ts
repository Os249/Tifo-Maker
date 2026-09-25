import type { BannerDoc, BannerSlot, BannerSize, StandIndex } from '../../core/banner';
import { signPlaceOf, signHeightM } from '../../core/banner';
import { rowV, type StandFrame, type SurfacePoint } from './standFrame';

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
  /**
   * A sign's row as it is actually held: the one it asked for, or the
   * nearest this stand can take (see `signRowFor`). Signs only.
   */
  row?: number;
}

/**
 * Every slot a stand offers, in the order a person would read them.
 *
 * Used by the panel to fill its pickers, and by the tests to enumerate the
 * whole space. `blockFrom` is always concrete here — never the -1 that means
 * "centred" — because this is the list of real places, not of intents.
 */
export function slotsOf(frame: StandFrame, stand: StandIndex, stands = 1): BannerSlot[] {
  const out: BannerSlot[] = [];
  const nb = Math.max(1, frame.blocks.length);
  const tiers: number[] = [-1];
  for (let t = 0; t < frame.tiers.length; t++) tiers.push(t);
  for (const tier of tiers) {
    for (let from = 0; from < nb; from++) {
      for (let span = 1; from + span <= nb; span++) {
        out.push({ stand, stands, blockFrom: from, blockSpan: span, tier });
      }
    }
  }
  return out;
}

/**
 * The widest run of blocks that still makes this banner bigger.
 *
 * Past a point the stand runs out of rake before the artwork's proportions
 * are satisfied, and every wider run resolves to the same sheet: on a generic
 * bowl at 2:1 that happens at three blocks, so "four", "five" and "six" in
 * the picker all drew the identical banner. An option that does nothing is
 * worse than a missing one — it reads as the control being broken, which is
 * exactly how it was reported.
 *
 * So the picker asks this and stops there, and the panel says why.
 */
export function maxUsefulSpan(doc: BannerDoc, frame: StandFrame): number {
  const nb = Math.max(1, frame.blocks.length);
  let best = 1;
  let prev = 0;
  for (let span = 1; span <= nb; span++) {
    const r = resolveSlot({ ...doc, slot: { ...doc.slot, blockSpan: span } }, frame);
    // Half a metre: below that it is measurement noise on a curved stand, not
    // a banner anyone could tell apart from the one before it.
    if (span > 1 && r.size.widthM <= prev + 0.5) break;
    prev = r.size.widthM;
    best = span;
  }
  return best;
}

/** How many slots a stand offers. `n(n+1)/2` runs × the tier choices. */
export function slotCount(frame: StandFrame): number {
  const nb = Math.max(1, frame.blocks.length);
  return ((nb * (nb + 1)) / 2) * (frame.tiers.length + 1);
}

/**
 * How tall a crowd figure stands above its seat, in metres.
 *
 * Not a guess: the crowd is a 1.25 m billboard centred 0.62 m above the seat
 * and scaled up to 1.10, so the tallest head reaches 1.31 m. A banner has to
 * clear that VERTICALLY, and a margin on top for the ones nearest the camera.
 */
export const CROWD_TOP_M = 1.42;

/**
 * How tall a HELD-UP CARD stands above its seat, in metres.
 *
 * The floor under everything below, and its absence is why seats showed
 * through the fabric in the editor's bowl. A card is drawn at every seat
 * whether or not anyone is in it — 0.7 m tall, centred 0.9 m up, so its top
 * is at 1.25 m — and the editor's preview has no crowd at all, so it asked
 * for a crowd support of ZERO. The sheet then sat 0.4 m off the terracing
 * with the cards reaching past a metre, and thirty thousand of them came
 * through it.
 *
 * An empty stand is not a bare stand. There is always something on it.
 */
export const SEAT_CARD_TOP_M = 1.34;

/**
 * How high the crowd holds a sheet off the terracing, measured STRAIGHT UP.
 *
 * A banner drawn over a full block does not lie on the terracing — it lies on
 * the people, and stays above their heads for as long as they hold it. It
 * needs a crowd to work: one person cannot hold up a sheet spanning twenty
 * rows, a packed block can, because the support is continuous. So it comes in
 * over the fill fraction rather than switching on.
 *
 * Vertical, and that word is the fix. The surface offsets along the stand's
 * NORMAL, which on a raked stand leans out by the angle of the rake — so
 * 1.72 m measured along it is only about 1.4 m of height, right at the crowd's
 * hairline, and heads came through the sheet. The surface now divides this by
 * the normal's vertical component, so what is asked for here is what you get.
 */
export function crowdSupportM(fill: number): number {
  const t = (fill - 0.15) / 0.45;
  const s = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  // From the cards to the heads, never from nothing.
  return SEAT_CARD_TOP_M + (CROWD_TOP_M - SEAT_CARD_TOP_M) * s;
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
  if (doc.kind === 'sign') return resolveSign(doc, frame);
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
  const maxHeightM = doc.kind === 'hanging' ? hangDrop(frame, tier) : rakeM;

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
  // A banner in the gap between two tiers FILLS that gap.
  //
  // It is a fascia banner, and a fascia is three metres of band across a
  // hundred metres of stand — the shape every ground in the world puts
  // advertising on. Letting the artwork's proportions drive the depth there
  // would size a 5:3 design to six metres wide and leave the rest of the
  // band bare, which is not a thing anyone hangs.
  const fascia = doc.kind === 'hanging' && tier >= 1 && tier < frame.tiers.length;
  if (fascia) {
    heightM = maxHeightM;
    heightLimited = heightM < widthM * aspect - 1e-6;
  } else if (heightM > maxHeightM) {
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

/** Grass level. The pitch plane sits at zero; this is a boot's height above it. */
const GROUND_Y = 0.25;

// ---------------------------------------------------------------------------
// Signs
// ---------------------------------------------------------------------------

/**
 * How many places along a stand a sign can be, in half blocks.
 *
 * Every block's middle and every aisle between two: `2n - 1` for `n` blocks.
 */
export function signPlaces(frame: StandFrame): number {
  return Math.max(1, 2 * Math.max(1, frame.blocks.length) - 1);
}

/** Where along the stand a sign's middle is, for a place in half blocks. */
export function signCentreU(frame: StandFrame, at: number): number {
  const b = frame.blocks;
  const nb = b.length;
  if (nb === 0) return 0.5;
  if (at < 0) return (b[0].u0 + b[nb - 1].u1) / 2;
  const k = Math.min(signPlaces(frame) - 1, Math.max(0, Math.round(at)));
  const i = k >> 1;
  return k % 2 === 0 ? b[i].centerU : (b[i].u1 + b[Math.min(nb - 1, i + 1)].u0) / 2;
}

/** The place in half blocks nearest to a point along the stand. */
export function signPlaceNear(frame: StandFrame, alongU: number): number {
  let best = 0;
  let bestD = Infinity;
  const n = signPlaces(frame);
  for (let k = 0; k < n; k++) {
    const d = Math.abs(signCentreU(frame, k) - alongU);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** The tier a sign is in, on this stand: always a real one. */
export function signTier(frame: StandFrame, tier: number): number {
  return Math.max(0, Math.min(Math.max(0, frame.tiers.length - 1), tier < 0 ? 0 : tier));
}

/** How many rows a sign can be held in, in a tier of this stand. */
export function signRows(frame: StandFrame, tier: number): number {
  const band = frame.tiers[signTier(frame, tier)];
  return Math.max(1, band?.rows ?? 1);
}

/**
 * The row nearest to a height up the stand, or -1 for the fence below it.
 *
 * What a drag in the bowl turns into: pointing at the concrete in front of a
 * tier's first row means the fence along it.
 */
export function signRowNear(frame: StandFrame, tier: number, heightV: number): { tier: number; row: number } {
  // The tier the pointer is in — or the one whose front it is just below.
  let t = 0;
  for (let i = 0; i < frame.tiers.length; i++) if (heightV >= frame.tiers[i].v0 - 0.02) t = i;
  void tier;
  const band = frame.tiers[t];
  if (!band) return { tier: 0, row: 0 };
  const n = Math.max(1, band.rows);
  const step = n > 1 ? (band.v1 - band.v0) / (n - 1) : 0.05;
  if (heightV < band.v0 - step * 0.6) return { tier: t, row: -1 };
  const r = step > 0 ? Math.round((heightV - band.v0) / step) : 0;
  return { tier: t, row: Math.max(0, Math.min(n - 1, r)) };
}

/**
 * A sign, resolved against a stand.
 *
 * Its length is its own — the sheet it was painted on — so this finds the run
 * of the stand that is that long at the row it is held in, centred on its
 * place and slid back inside the stand if it would hang off an end. Only a
 * sign longer than the whole stand is cut down, and then the whole sheet is
 * scaled with it, like a banner the rake cannot hold: its letters keep their
 * shape.
 */
export function resolveSign(doc: BannerDoc, frame: StandFrame): ResolvedSlot {
  const place = signPlaceOf(doc.slot);
  const tier = signTier(frame, doc.slot.tier);
  const band = frame.tiers[tier] ?? { v0: 0, v1: 1, slopeM: frame.slopeM, rows: 1 };
  const row = signRowFor(frame, tier, place.row, place.lengthM * Math.max(0.005, Math.min(6, doc.aspect)));
  const vRow = row < 0 ? band.v0 : rowV(band, row);
  const c = signCentreU(frame, place.at);
  const whole = frame.widthAt(0, 1, vRow);
  const want = Math.min(place.lengthM, whole * 0.98);
  const run = (du: number): [number, number] => {
    let lo = c - du;
    let hi = c + du;
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > 1) { lo -= hi - 1; hi = 1; }
    return [Math.max(0, lo), Math.min(1, hi)];
  };
  let a = 0;
  let b = 0.5;
  for (let k = 0; k < 16; k++) {
    const m = (a + b) / 2;
    const [u0, u1] = run(m);
    if (frame.widthAt(u0, u1, vRow) > want) b = m; else a = m;
  }
  const [u0, u1] = run(a);
  const widthM = frame.widthAt(u0, u1, vRow);
  const heightM = widthM * Math.max(0.005, Math.min(6, doc.aspect));
  let blockFrom = 0;
  for (let i = 0; i < frame.blocks.length; i++) if (c >= frame.blocks[i].u0 - 1e-9) blockFrom = i;
  return {
    stand: doc.slot.stand,
    blockFrom,
    blockSpan: 1,
    u0,
    u1,
    tier,
    v0: band.v0,
    v1: band.v1,
    vBottom: vRow,
    size: { widthM, heightM },
    maxWidthM: whole,
    maxHeightM: 2.5,
    heightLimited: place.lengthM > whole * 0.98 + 1e-6,
    row,
  };
}

/** Where a sign's top edge is held when it is at the front, above the tread. */
export const SIGN_CHEST_M = 1.15;
/** How far in front of the people holding it a sign is, in metres. */
export const SIGN_HELD_OUT_M = 0.35;
/** The top of the fence along the front of a tier, above that tier's first row. */
export const SIGN_FENCE_TOP_M = 1.0;
/** How far in front of a tier's first row its fence is. */
export const SIGN_FENCE_OUT_M = 0.75;

/**
 * Where a sign is, at one point along it.
 *
 * `base` is the stand at the sign's row; the sheet stands `out` metres in
 * front of it, between two heights.
 *
 * - **Tied to the fence**: its top edge at the top of the fence, hanging
 *   down in front of it.
 * - **Held in the front row**: at chest height, the top edge a little over a
 *   metre up. Nobody is in front of it.
 * - **Held further back**: up over the heads of the row in front, or all the
 *   ground would see is the back of their heads. The row in front is lower by
 *   the rake, so how high that is depends on the stand — and it is measured,
 *   not assumed, from the row itself.
 *
 * A sheet too tall for its hands is held higher, never pushed into the stand:
 * its bottom edge is always off the concrete.
 */
export function signHold(
  frame: StandFrame,
  slot: ResolvedSlot,
  row: number,
  u: number,
): SignHold {
  return holdAt(frame, slot.tier, slot.row ?? signRowFor(frame, slot.tier, row, slot.size.heightM), u, slot.vBottom, slot.size.heightM);
}

/** How a sign is held at one point along it: see `signHold`. */
export interface SignHold { base: SurfacePoint; bottomY: number; topY: number; out: number; minOut: number }

function holdAt(frame: StandFrame, tier: number, row: number, u: number, v: number, H: number): SignHold {
  const slot = { tier }; // the one thing about the slot this needs
  const base = frame.pointAt(u, v);
  if (row < 0) {
    const topY = base.y + SIGN_FENCE_TOP_M;
    // Never below the floor it hangs over: the grass in front of the lowest
    // tier, the bottom of the fascia under an upper one.
    const floor = slot.tier >= 1 ? hangSpan(frame, slot.tier).bottomY + 0.1 : GROUND_Y;
    // A sheet with no room to hang its full depth is not squashed to fit:
    // it is tied along the rail and stands up above it instead, which is
    // what a group does when the tier below comes right up to the balcony.
    const bottomY = Math.max(floor, topY - H);
    const lift = Math.max(0, bottomY - (topY - H));
    // In front of the fascia it drops down, not just the fence it is tied to.
    // A balcony's face is not always vertical: on a steep ground it leans out
    // towards the pitch below the lip, and a sheet stood off the fence by the
    // usual amount went a few centimetres into it at its bottom hem.
    const protrude = slot.tier >= 1 ? fasciaProtrusion(frame, slot.tier, u, base, bottomY - 0.05) : 0;
    return {
      base, bottomY, topY: topY + lift,
      out: Math.max(SIGN_FENCE_OUT_M, protrude + 0.4), minOut: protrude + 0.08,
    };
  }
  // The front row of a tier that starts right behind the back of the one
  // below it — no balcony, no gap — has people in front of it after all:
  // the back row of the lower tier. It holds up over their heads like any
  // row further back.
  const band = frame.tiers[slot.tier];
  const lower = slot.tier >= 1 && !signFenceOk(frame, slot.tier) ? frame.tiers[slot.tier - 1] : null;
  if (row === 0 && !lower) {
    const topY = base.y + Math.max(SIGN_CHEST_M, 0.08 + H);
    return { base, bottomY: topY - H, topY, out: SIGN_HELD_OUT_M, minOut: -Infinity };
  }
  const front = row === 0 && lower
    ? frame.pointAt(u, rowV(lower, lower.rows - 1))
    : band ? frame.pointAt(u, rowV(band, row - 1)) : base;
  // Signed: the back row of a lower tier can be HIGHER than the front row of
  // the one behind it, and then the sheet has to go up by the difference.
  const rise = base.y - front.y;
  const bottomY = base.y + Math.max(0.08, CROWD_TOP_M - rise + 0.06);
  return { base, bottomY, topY: bottomY + H, out: SIGN_HELD_OUT_M, minOut: -Infinity };
}

/**
 * How far the face under a tier's lip reaches out past the lip, in metres,
 * anywhere above `downToY`.
 *
 * Measured along the stand's outward direction at `u`, down the band between
 * the tier and the one below it — which is all a sign tied to the balcony
 * hangs in front of — and only as far down as the sheet itself goes. The
 * band slopes out towards the pitch as it falls, to the back row of the tier
 * below; standing the sheet clear of all of it would float a balcony sign
 * metres out in the air, when all it has to clear is the face beside it.
 */
function fasciaProtrusion(frame: StandFrame, tier: number, u: number, base: SurfacePoint, downToY: number): number {
  const t = frame.tiers;
  if (tier < 1 || tier >= t.length) return 0;
  const vLow = t[tier - 1].v1;
  const vLip = t[tier].v0;
  let most = 0;
  let prev: { d: number; y: number } | null = null;
  for (let k = 0; k <= 24; k++) {
    const p = frame.pointAt(u, vLip + ((vLow - vLip) * k) / 24);
    const cur = { d: (p.x - base.x) * base.ox + (p.z - base.z) * base.oz, y: p.y };
    if (cur.y >= downToY) {
      most = Math.max(most, cur.d);
    } else {
      // Where the face crosses the sheet's hem, and no further.
      if (prev && prev.y > cur.y) {
        const f = (prev.y - downToY) / (prev.y - cur.y);
        most = Math.max(most, prev.d + (cur.d - prev.d) * f);
      }
      break;
    }
    prev = cur;
  }
  return most;
}

/**
 * Whether a tier has a fence along its front to tie a sign to.
 *
 * The lowest tier always does: the one between the terrace and the pitch. An
 * upper tier has one only where there is a balcony — a drop from its first
 * row down to the tier below. On a ground whose tiers run straight on into
 * each other there is nothing to tie a sheet to and nothing for it to hang
 * down in front of: on one in the catalogue the lower tier's back rows are
 * above the upper tier's front one, and a "balcony" sign went into them.
 */
export function signFenceOk(frame: StandFrame, tier: number): boolean {
  if (!frame.ok || tier <= 0) return true;
  if (tier >= frame.tiers.length) return false;
  const { topY, bottomY } = hangSpan(frame, tier);
  return topY - bottomY >= SIGN_BALCONY_MIN_M;
}

/** The deepest a drop can be and still not count as a balcony, in metres. */
export const SIGN_BALCONY_MIN_M = 0.5;

/**
 * The row a sign `heightM` tall is actually held at, in a tier of this stand.
 *
 * The one it asks for, when the stand can take it. A fence that is not there
 * is the front row; a row past the last one a sheet that tall can be held up
 * in is that last one (see `signUsableRows`).
 */
export function signRowFor(frame: StandFrame, tier: number, row: number, heightM: number): number {
  const t = signTier(frame, tier);
  if (row < 0) return signFenceOk(frame, t) ? -1 : 0;
  return Math.min(row, signUsableRows(frame, t, heightM) - 1);
}

/**
 * How many rows, from the front, a sign `heightM` tall can be held up in.
 *
 * All of them, on most stands. Not under an overhang: where the tier above
 * juts out over the back of this one, the last few rows have its underside a
 * couple of metres over their heads, and a sheet held up over the row in
 * front went straight into it — eighty centimetres into the concrete on the
 * widest oval in the catalogue. A row is offered only if the top of a sheet
 * that tall, held there, is clear of the stand.
 */
export function signUsableRows(frame: StandFrame, tier: number, heightM: number): number {
  const t = signTier(frame, tier);
  const band = frame.tiers[t];
  if (!frame.ok || !band) return 1;
  const H = Math.round(Math.max(0.1, heightM) * 100) / 100;
  let memo = USABLE.get(frame);
  if (!memo) { memo = new Map(); USABLE.set(frame, memo); }
  const key = `${t}|${H}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const rows = Math.max(1, band.rows);
  let n = rows;
  // Only a tier with another above it can be overhung.
  if (t < frame.tiers.length - 1) {
    for (let r = 0; r < rows; r++) {
      if (!signRowFits(frame, t, r, H)) { n = Math.max(1, r); break; }
    }
  }
  memo.set(key, n);
  return n;
}
const USABLE = new WeakMap<StandFrame, Map<string, number>>();

/** Whether the top of a sheet held in a row is clear of the stand, along its whole length. */
function signRowFits(frame: StandFrame, tier: number, row: number, H: number): boolean {
  const band = frame.tiers[tier];
  const v = rowV(band, row);
  for (const u of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const h = holdAt(frame, tier, row, u, v, H);
    // Its top edge, with room for the hands bobbing and the sheet swaying.
    const x = h.base.x + h.base.ox * h.out;
    const y = h.topY + 0.15;
    const z = h.base.z + h.base.oz * h.out;
    if (standClearance(frame, u, x, y, z) < 0.05) return false;
  }
  return true;
}

/**
 * How far a point is outside the stand, measured along the stand's normal at
 * its nearest point down the line at `u` — negative inside.
 */
function standClearance(frame: StandFrame, u: number, x: number, y: number, z: number): number {
  let best = Infinity;
  let bestV = 0.5;
  for (let j = 0; j <= 48; j++) {
    const p = frame.pointAt(u, j / 48);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bestV = j / 48; }
  }
  for (let j = -3; j <= 3; j++) {
    const vv = Math.max(0, Math.min(1, bestV + j / 480));
    const p = frame.pointAt(u, vv);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bestV = vv; }
  }
  const p = frame.pointAt(u, bestV);
  const n = frame.normalAt(u, bestV);
  return (x - p.x) * n.nx + (y - p.y) * n.ny + (z - p.z) * n.nz;
}

/** Where a sign's middle is, in the world. */
export function signCentre(frame: StandFrame, slot: ResolvedSlot, row: number): { x: number; y: number; z: number; ox: number; oz: number } {
  const u = (slot.u0 + slot.u1) / 2;
  const h = signHold(frame, slot, row, u);
  return {
    x: h.base.x + h.base.ox * h.out,
    y: (h.bottomY + h.topY) / 2,
    z: h.base.z + h.base.oz * h.out,
    ox: h.base.ox,
    oz: h.base.oz,
  };
}

/**
 * Where on the stand a flown banner is rigged from, in `heightV`.
 *
 * ONE definition, because three places need it and they disagreed. The
 * geometry anchored at the front rail while the standoff and the camera
 * measured from the back row, so the standoff came out as the difference in
 * radius between the two — twenty-five metres on a big bowl — and the banner
 * was pushed that far out, hanging in the air over the pitch.
 *
 * A banner over the whole stand or the lowest tier is rigged at the front
 * rail, which is the innermost thing the stand has. One in a fascia gap is
 * rigged at the lip of the tier above it.
 */
export function hangAnchorV(frame: StandFrame, tier: number): number {
  const t = frame.tiers;
  return tier >= 1 && tier < t.length ? t[tier].v0 : 0;
}

/**
 * The air a hanging banner has to hang in, as two world heights.
 *
 * Three cases, and they are three different rigs rather than three sizes of
 * one:
 *
 * - **The whole stand.** Flown from the roof steel and reaching the grass —
 *   the full face of the building.
 * - **The lower tier.** The same, but rigged off the top of that tier rather
 *   than the roof, so it is bounded above by the tier it hangs from.
 * - **An upper tier.** Not to the ground at all: into the GAP between that
 *   tier and the one below it. That band of fascia is the one piece of a
 *   stand with nobody sitting on it, which is why every ground in the world
 *   has advertising along it and why a tifo hung there covers no one.
 *
 * Both of the first two are fixed at the bottom, on the grass. The third is
 * fixed in its gap. That is what decides where a short banner sits: a short
 * ground-fixed one still stands on the ground, with air above it.
 */
export function hangSpan(frame: StandFrame, tier: number): { topY: number; bottomY: number } {
  const t = frame.tiers;
  if (tier < 0 || t.length === 0) {
    return { topY: frame.roofY - 1.5, bottomY: GROUND_Y };
  }
  const i = Math.min(t.length - 1, Math.max(0, tier));
  if (i === 0) {
    return { topY: frame.pointAt(0.5, t[0].v1).y, bottomY: GROUND_Y };
  }
  const bottomY = frame.pointAt(0.5, t[i - 1].v1).y;
  // Never inverted. The bands come from the seat map's own tier numbering and
  // on one ground in the catalogue the upper tier's lowest seat sits twenty
  // centimetres BELOW the lower tier's highest — so the "gap" was negative
  // and a banner in it hung below its own floor.
  return { topY: Math.max(bottomY, frame.pointAt(0.5, t[i].v0).y), bottomY };
}

/**
 * The height of the fascia band between a tier and the one below it.
 *
 * Measured across the catalogue: 3.3 to 3.5 m on most grounds, which is a
 * real band and the one place on a stand with nobody sitting in it — but
 * 0.8 m on two of them and negative on a third. Below about a metre and a
 * half there is nothing to hang, so that tier is not offered for a flown
 * banner at all rather than drawing a useless strip.
 */
export const FASCIA_MIN_M = 1.5;

/** Which tiers a hanging banner can actually use on this stand. */
export function hangableTiers(frame: StandFrame): number[] {
  const out: number[] = [];
  for (let i = 0; i < frame.tiers.length; i++) {
    if (i === 0 || hangDrop(frame, i) >= FASCIA_MIN_M) out.push(i);
  }
  return out;
}

/**
 * How much air a hanging banner has under its rigging, in metres.
 *
 * Bounded by the building, which is why a hanging banner cannot be made to
 * reach the skyline.
 */
export function hangDrop(frame: StandFrame, tier: number): number {
  const { topY, bottomY } = hangSpan(frame, tier);
  // The span, not a comfortable minimum. A four-metre floor on a three-and-a-
  // half-metre fascia is half a metre of banner hanging below its own band.
  return Math.max(0.8, topY - bottomY);
}

/**
 * Where a hanging banner's TOP edge is, in world Y.
 *
 * A banner that reaches the ground is fixed at the bottom, so its top edge is
 * a sheet's height above the grass and a shorter one simply has more air
 * above it. One in a gap between tiers hangs from the lip of the upper tier,
 * which is the thing it is actually tied to.
 */
export function hangAnchorY(frame: StandFrame, slot: ResolvedSlot): number {
  const { topY, bottomY } = hangSpan(frame, slot.tier);
  if (slot.tier >= 1 && slot.tier < frame.tiers.length) return topY;
  return Math.min(topY, bottomY + slot.size.heightM);
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
  const a = frame.pointAt(u, hangAnchorV(frame, slot.tier));
  const rail = frame.pointAt(u, 0);
  const dr = Math.hypot(a.x, a.z) - Math.hypot(rail.x, rail.z);
  return Math.max(0.9, dr + 1.2);
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
  const p = frame.pointAt(u, hangAnchorV(frame, slot.tier));
  const off = hangStandoff(frame, slot);
  return {
    x: p.x + p.ox * off,
    y: hangAnchorY(frame, slot) - slot.size.heightM / 2,
    z: p.z + p.oz * off,
  };
}

/**
 * The shape a slot imposes on a sheet, or null when the artwork decides.
 *
 * Only one slot imposes one: a hanging banner in the gap between two tiers,
 * which fills that gap edge to edge and so is exactly as deep as the band is,
 * whatever proportions the artwork was drawn at. Everywhere else the artwork's
 * own shape sets the depth and a slot that cannot take it scales the whole
 * sheet down — which keeps the shape — so there is nothing to impose.
 *
 * The store asks this after every change to a banner's slot or type, and the
 * artboard and the texture then draw at the band's proportions: the design is
 * drawn on the strip it will be printed on, instead of being drawn at 2:1 and
 * squashed onto an 11:1 strip in the bowl.
 */
export function slotAspectFor(doc: BannerDoc, frame: StandFrame): number | null {
  if (!frame.ok || doc.kind !== 'hanging') return null;
  const r = resolveSlot(doc, frame);
  if (!(r.tier >= 1 && r.tier < frame.tiers.length)) return null;
  return r.size.heightM / Math.max(0.1, r.size.widthM);
}

/**
 * Bring a banner into line with the stand it is now on.
 *
 * Two things can go stale when a banner moves — to another stand, round a
 * corner, or into the air — and both used to be papered over in the panel
 * while the bowl drew something else:
 *
 * - its TIER. A flown banner cannot use a tier whose fascia gap is too thin
 *   to hang anything in, and a stand may have fewer tiers than the last one.
 *   The picker showed "Whole stand" for such a tier while the bowl drew a
 *   strip in a gap half a metre deep.
 * - the SHAPE a gap imposes — `slotAspectFor`, above.
 *
 * Returns true if it changed anything.
 */
export function settleSlot(doc: BannerDoc, frame: StandFrame): boolean {
  if (!frame.ok) return false;
  let changed = false;
  // A sign keeps to a tier this stand has, and a row that tier has.
  if (doc.kind === 'sign') {
    const tier = signTier(frame, doc.slot.tier);
    const place = signPlaceOf(doc.slot);
    const row = signRowFor(frame, tier, place.row, signHeightM(doc));
    const at = place.at < 0 ? -1 : Math.min(signPlaces(frame) - 1, place.at);
    if (tier !== doc.slot.tier || row !== doc.slot.row || at !== doc.slot.at) {
      doc.slot = { ...doc.slot, tier, row, at };
      changed = true;
    }
    if (doc.slotAspect !== null && doc.slotAspect !== undefined) {
      doc.slotAspect = null;
      changed = true;
    }
    return changed;
  }
  const tier = doc.slot.tier;
  if (tier >= 0) {
    const ok = tier < frame.tiers.length && (doc.kind !== 'hanging' || hangableTiers(frame).includes(tier));
    if (!ok) {
      doc.slot = { ...doc.slot, tier: -1 };
      changed = true;
    }
  }
  const next = slotAspectFor(doc, frame);
  const was = doc.slotAspect ?? null;
  const same = next === null ? was === null : was !== null && Math.abs(next - was) < 1e-4;
  if (!same) {
    doc.slotAspect = next;
    changed = true;
  }
  return changed;
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
