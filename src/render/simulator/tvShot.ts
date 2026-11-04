/**
 * The TV gantry's view of a stand, as a yardstick for how big something on
 * that stand looks on television.
 *
 * The main camera sits high on the far side, straight across the pitch,
 * and the director's shot of a stand holds the whole of it, end to end, in
 * a 16:9 picture. That is the shot a banner is judged in: a face that is a
 * fifth of the picture's height reads as a face at home; one that is a
 * twentieth is a dot on a long, low stand. Pure: stand frames in, a camera
 * and a ruler out.
 */
import type { StandFrame } from './standFrame';

export interface TvShot {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view, degrees. */
  fov: number;
  /** The picture's height, in metres, at a point `d` metres from the camera. */
  frameHeightAt(d: number): number;
  /** Distance from the camera to a point, metres. */
  distanceTo(p: { x: number; y: number; z: number }): number;
}

const ASPECT = 16 / 9;

/**
 * The gantry shot of `stand`: from across the pitch (the stand's middle,
 * mirrored through the centre spot), at the height of the highest stand
 * (under the roof of a closed arena), zoomed so the stand's full width
 * fills the picture's width. Null when the stand has no seats.
 */
export function tvShot(frameFor: (stand: 0 | 1 | 2 | 3, stands?: number) => StandFrame, stand: 0 | 1 | 2 | 3): TvShot | null {
  const f = frameFor(stand, 1);
  if (!f.ok) return null;
  const mid = f.pointAt(0.5, 0.5);
  let top = f.maxY;
  for (const s of [0, 1, 2, 3] as const) {
    const g = frameFor(s, 1);
    if (g.ok) top = Math.max(top, g.maxY);
  }
  // The far stand's gantry: as high as the tallest stand, a little over it.
  const y = top * 1.02 + 2;
  const position: [number, number, number] = [-mid.x * 0.95, y, -mid.z * 0.95];
  const target: [number, number, number] = [mid.x, Math.max(1.5, mid.y), mid.z];
  const dist = (p: { x: number; y: number; z: number }): number =>
    Math.hypot(p.x - position[0], p.y - position[1], p.z - position[2]);
  const d0 = dist(mid);
  // The stand's width across the picture's width, then the height that leaves.
  const hHalf = Math.atan(f.widthM / 2 / Math.max(1, d0));
  const vHalfRaw = Math.atan(Math.tan(hHalf) / ASPECT);
  const fov = Math.max(12, Math.min(46, (vHalfRaw * 360) / Math.PI));
  const vHalf = (fov * Math.PI) / 360;
  return {
    position,
    target,
    fov,
    frameHeightAt: (d) => 2 * d * Math.tan(vHalf),
    distanceTo: dist,
  };
}
