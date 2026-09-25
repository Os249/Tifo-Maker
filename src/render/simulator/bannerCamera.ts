import type { BannerDoc } from '../../core/banner';
import type { StandFrame } from './standFrame';
import { hangCentre, resolveSlot, signCentre } from './bannerSlot';
import { signPlaceOf } from '../../core/banner';

/**
 * Where to stand to look at a banner.
 *
 * One answer for every camera that frames one — Match Day's "Look at it", the
 * editor bowl beside the Banner view, the shot harness — so a banner is never
 * framed well in one of them and off the edge of the picture in another. Pure:
 * a document and a stand frame in, a camera out.
 */
export interface BannerShot {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export function bannerShot(
  doc: BannerDoc,
  f: StandFrame,
  opts: { elevationDeg?: number; fov?: number; aspect?: number } = {},
): BannerShot | null {
  if (!f.ok) return null;
  const fov = opts.fov ?? 44;
  // Aim at the middle of the sheet, not at the rail it hangs from, and
  // stand where the people it is aimed at stand: back across the pitch and
  // LOW. Framed on the RESOLVED slot, not on anything the editor asked for:
  // the slot is where the banner is and how big it is, and it already knows
  // where its own top and bottom edges sit on the stand.
  const slot = resolveSlot(doc, f);
  if (doc.kind === 'sign') return signShot(doc, f, slot, opts, fov);
  const alongU = (slot.u0 + slot.u1) / 2;
  const onStand = f.pointAt(alongU, Math.max(0, (slot.v1 + slot.vBottom) / 2));
  // A hanging banner is not ON the stand, so the stand's own coordinates say
  // nothing about where it is: it hangs in the air, standing off its anchor
  // far enough to clear everything below, and aiming at the terracing
  // behind it pointed the camera at the seats while the sheet hung out of
  // frame entirely.
  const c = doc.kind === 'hanging' ? hangCentre(f, slot) : null;
  const mid = c
    ? { x: c.x, y: c.y, z: c.z, ox: onStand.ox, oz: onStand.oz }
    : onStand;
  const cy = c ? c.y : (f.pointAt(alongU, Math.min(1, slot.v1)).y + onStand.y) / 2;
  // Far enough back to hold the banner, and never outside the ground.
  //
  // A banner covering a whole stand is over a hundred metres wide, and
  // stepping back far enough to frame it put the camera two hundred metres
  // out — behind the stand it was aimed at, looking at the back of the
  // building. Every one of those shots came out black. And far enough to
  // hold BOTH dimensions: a flown banner can be taller than it is wide, and
  // a distance chosen from the width alone put the camera inside a 23 m drop.
  const bowlR = Math.hypot(mid.x, mid.z) || 60;
  const reach = Math.max(slot.size.widthM, slot.size.heightM * 1.7);
  let d = Math.min(bowlR * 1.85, Math.max(70, reach * 2.4 * (44 / fov)));
  // And far enough to hold its WIDTH in the picture it is going into. The
  // field of view is vertical, so on a screen taller than it is wide — a
  // phone held upright — the width runs out first: the same distance that
  // framed a 41 m banner with room to spare on a laptop cut both its ends off
  // on a phone.
  if (opts.aspect && opts.aspect > 0) {
    const vHalf = (fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * opts.aspect);
    const fitW = (slot.size.widthM / 2 / Math.tan(hHalf)) * 1.25;
    d = Math.min(bowlR * 1.85, Math.max(d, fitW));
  }
  // The angle follows what the banner IS, not a constant.
  //
  // A sheet lying on a raked stand is a near-horizontal surface: from pitch
  // level you see its edge, so it wants the thirty-odd degrees where the
  // main camera gantry sits. A flown banner is a vertical plane and wants
  // the opposite — look down at it and you see its top hem. Overridable,
  // because the flattering angle and the honest angle are not the same: the
  // shot harness asks for a grazing one on purpose.
  let el =
    opts.elevationDeg !== undefined
      ? (opts.elevationDeg * Math.PI) / 180
      : doc.kind === 'hanging' ? 0.2 : 0.55;
  // Under the roof. Thirty degrees up in a roofed arena puts the camera in
  // the rafters, looking at the dark underside of the roof, and the shot
  // comes back black — it did, on the Kingdom Arena, for every banner on it.
  if (opts.elevationDeg === undefined) {
    const headroom = f.roofY - 3 - cy;
    if (headroom < d * Math.sin(el)) {
      el = Math.max(0.12, Math.asin(Math.max(-1, Math.min(1, headroom / d))));
    }
  }
  return {
    position: [mid.x + mid.ox * d * Math.cos(el), cy + d * Math.sin(el), mid.z + mid.oz * d * Math.cos(el)],
    target: [mid.x, Math.max(1.5, cy), mid.z],
    fov,
  };
}

/**
 * A sign, from where it is meant to be read: across the pitch, a little above
 * it, and close enough that its words are the picture.
 *
 * A sign is a strip a metre tall. The distance that frames a forty-metre
 * banner makes a twelve-metre sign a line of pixels, so this stands off by
 * the sign's own length — and never so close that the stand it is in is lost:
 * seeing WHERE it is held is half of what the camera is for.
 */
function signShot(
  doc: BannerDoc,
  f: StandFrame,
  slot: ReturnType<typeof resolveSlot>,
  opts: { elevationDeg?: number; fov?: number; aspect?: number },
  fov: number,
): BannerShot {
  const c = signCentre(f, slot, signPlaceOf(doc.slot).row);
  const bowlR = Math.hypot(c.x, c.z) || 60;
  let d = Math.max(24, slot.size.widthM * 1.25);
  if (opts.aspect && opts.aspect > 0) {
    const vHalf = (fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * opts.aspect);
    d = Math.max(d, (slot.size.widthM / 2 / Math.tan(hHalf)) * 1.3);
  }
  d = Math.min(bowlR * 1.6, d);
  let el = opts.elevationDeg !== undefined ? (opts.elevationDeg * Math.PI) / 180 : 0.16;
  if (opts.elevationDeg === undefined) {
    const headroom = f.roofY - 3 - c.y;
    if (headroom < d * Math.sin(el)) el = Math.max(0.05, Math.asin(Math.max(-1, Math.min(1, headroom / d))));
  }
  return {
    position: [c.x + c.ox * d * Math.cos(el), c.y + d * Math.sin(el), c.z + c.oz * d * Math.cos(el)],
    target: [c.x, c.y, c.z],
    fov,
  };
}
