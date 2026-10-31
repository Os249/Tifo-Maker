import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatMap } from '../../core/types';

/**
 * Match Day Simulator — camera director (Phase 6).
 *
 * Named broadcast/cinematic shots plus two shots derived from the seat map at
 * runtime (a seat in the crowd, and the top of the painted "ultra" end), and a
 * looping cinematic flyover that orbits and pushes in. The simulator applies a
 * shot on selection and, while the flyover is active, calls flyover() each frame.
 */

export interface SimShot {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const SIM_SHOTS: SimShot[] = [
  { name: 'TV Broadcast', position: [0, 40, -120], target: [0, 8, 8], fov: 38 },
  { name: 'Main Camera', position: [0, 28, -92], target: [0, 6, 6], fov: 42 },
  { name: 'Pitch Level', position: [36, 1.8, 30], target: [-50, 14, -40], fov: 55 },
  { name: 'Behind Goal', position: [106, 9, 0], target: [-40, 14, 0], fov: 45 },
  { name: 'Tunnel', position: [0, 2.2, 48], target: [0, 9, -20], fov: 62 },
  { name: 'Drone', position: [72, 92, 92], target: [0, 0, 0], fov: 50 },
];

/** Extent of the seating bowl in world metres (max |x|, max |z|, top seat height). */
export interface BowlBounds {
  ax: number;
  bz: number;
  ty: number;
}

/**
 * Broadcast shots DERIVED FROM THE ACTUAL BOWL, so every stadium — a 25k
 * compact ground or an 80k oval — is framed correctly.
 *
 * SIM_SHOTS above are absolute metres tuned for the 92x70 default bowl; used
 * on a smaller ground (Al-Awwal's seats stop at ~63m) they place the camera
 * tens of metres OUTSIDE the stadium, staring at the back of the roof. These
 * are expressed as fractions of the bowl instead, so they always sit on the
 * seating and look in at the pitch.
 *
 * Convention: goals lie on ±x (pitch is 105 long in x), sidelines on ±z.
 */
export function bowlShots(b: BowlBounds): SimShot[] {
  const { ax, bz, ty } = b;
  return [
    // Classic TV gantry: top of the main stand at the halfway line.
    { name: 'TV Broadcast', position: [0, ty * 1.02 + 2, -bz * 0.95], target: [0, 2, 0], fov: 46 },
    // Lower, tighter main camera.
    { name: 'Main Camera', position: [0, ty * 0.7, -bz * 0.82], target: [0, 1.5, 0], fov: 50 },
    // Behind one goal, looking down the length of the pitch.
    { name: 'Behind Goal', position: [-ax * 0.92, ty * 0.58, 0], target: [ax * 0.3, 3, 0], fov: 55 },
    // Pitch level looking UP at the far stand — the best angle for a tifo.
    { name: 'Pitch Level', position: [ax * 0.2, 2.2, -bz * 0.42], target: [0, ty * 0.6, bz * 0.92], fov: 60 },
    // Tunnel mouth, low and central.
    { name: 'Tunnel', position: [0, 1.8, -bz * 0.46], target: [0, ty * 0.55, bz * 0.9], fov: 62 },
    // High drone over a corner, whole-bowl establishing shot.
    { name: 'Drone', position: [ax * 0.7, ty * 2.2 + 26, bz * 0.7], target: [0, 0, 0], fov: 55 },
  ];
}

export function applyShot(camera: THREE.PerspectiveCamera, controls: OrbitControls, s: SimShot): void {
  camera.position.set(s.position[0], s.position[1], s.position[2]);
  controls.target.set(s.target[0], s.target[1], s.target[2]);
  camera.fov = s.fov;
  camera.updateProjectionMatrix();
  controls.update();
}

/** A shot placed at a real seat: 'crowd' = high north stand, 'ultra' = high south (often the painted end). */
export function seatShot(map: SeatMap, which: 'crowd' | 'ultra'): SimShot {
  const wantStand = which === 'crowd' ? 1 : 3;
  let best = -1;
  let bestY = -Infinity;
  for (let i = 0; i < map.count; i++) {
    const stand = Math.floor(((map.uv[i * 2] + 0.125) % 1) * 4);
    if (stand !== wantStand) continue;
    const y = map.pos3[i * 3 + 1];
    if (y > bestY) {
      bestY = y;
      best = i;
    }
  }
  if (best < 0) return SIM_SHOTS[0];
  return {
    name: which === 'crowd' ? 'Crowd View' : 'Ultra View',
    position: [map.pos3[best * 3], map.pos3[best * 3 + 1] + 1.2, map.pos3[best * 3 + 2]],
    target: [0, 6, 0],
    fov: 62,
  };
}

/** Seconds per loop of the live flyover. */
export const FLY_DURATION = 18;

/**
 * How long one pass of the flyover takes in a clip of `seconds`.
 *
 * A clip starts at the top of the pass: wide and high, sweeping in towards the
 * tifo. Up to 18 s that is the live flyover's own pace, so a 9 s clip is the
 * first half of a pass and ends closest to the stands, which is where a reveal
 * is best seen. A longer clip gets exactly one full orbit, so a 20 or 30 s
 * drum call ends where it began and loops cleanly when posted. It never goes
 * faster than the live pace: a camera whipping round a bowl in six seconds is
 * a ride, not a shot.
 */
export function flyoverPeriodFor(seconds: number): number {
  return Math.max(FLY_DURATION, seconds);
}

/**
 * Camera state for the cinematic flyover at a given elapsed time (loops).
 *
 * Pass `bounds` so the orbit is sized to the actual bowl — a fixed 165 m radius
 * flies ~100 m outside a compact 25k ground and shows only its back wall. The
 * orbit is elliptical (ax/bz) so it tracks the stadium's real footprint.
 * `period` is the seconds per loop (a recorded clip sets its own).
 */
export function flyover(elapsed: number, bounds?: BowlBounds, period = FLY_DURATION): SimShot {
  const P = Math.max(1, period);
  const t = (((elapsed % P) + P) % P) / P;
  const ang = t * Math.PI * 2;
  const ease = Math.sin(t * Math.PI); // 0 -> 1 -> 0
  if (bounds) {
    const { ax, bz, ty } = bounds;
    const r = 1.5 - 0.62 * ease; // sweep in from wide to close
    const height = ty * (2.1 - 1.15 * ease) + 6;
    return {
      name: 'Flyover',
      position: [Math.cos(ang) * ax * r, Math.max(5, height), Math.sin(ang) * bz * r],
      target: [0, ty * 0.28, 0],
      fov: 50,
    };
  }
  const radius = 165 - 80 * ease;
  const height = 130 - 85 * ease;
  return {
    name: 'Flyover',
    position: [Math.cos(ang) * radius, Math.max(5, height), Math.sin(ang) * radius],
    target: [0, 9, 0],
    fov: 46,
  };
}

/**
 * Where the tifo is: the seats that hold a card, as the cameras need them.
 *
 * Reported on 30 Oct 2026: a tifo behind one goal, and every show opened on
 * the TV gantry, which looks across at the other side of the ground. The
 * tifo's middle sat just off the edge of the picture for the whole reveal,
 * and every cut after that was to a fixed place too. The cameras below are
 * worked out from this instead.
 */
export interface TifoFootprint {
  /** The middle of the painted seats, metres. */
  centre: [number, number, number];
  /** From the middle of the pitch out towards the tifo, along the ground (unit x, z). */
  dir: [number, number];
  /** Across: the painted seats' spread along the stand, metres. */
  width: number;
  /** Lowest and highest painted seat, metres. */
  y0: number;
  y1: number;
  /** Nearest to and furthest from the pitch, along `dir`, metres. */
  near: number;
  far: number;
  /** How much of the way round the bowl it reaches, degrees. */
  arcDeg: number;
  /** The stand most of it is in: 0 east, 1 north, 2 west, 3 south (standOfU). */
  stand: 0 | 1 | 2 | 3;
  /** That stand's share of the painted seats. */
  standShare: number;
  seats: number;
}

/**
 * The painted seats' footprint, or null when there is no tifo to look at, or
 * when it goes round so much of the bowl that no one place sees it better
 * than the gantry does (a whole-stadium design).
 */
export function tifoFootprint(map: SeatMap, painted: (i: number) => boolean): TifoFootprint | null {
  const bins = new Uint8Array(360);
  /** Where the ground has seats at all: a ground with two stands is "whole" at two. */
  const groundBins = new Uint8Array(360);
  const perStand = [0, 0, 0, 0];
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let rSum = 0;
  for (let i = 0; i < map.count; i++) {
    const x = map.pos3[i * 3];
    const z = map.pos3[i * 3 + 2];
    const deg = Math.floor(((Math.atan2(z, x) * 180) / Math.PI + 360) % 360);
    groundBins[Math.min(359, deg)] = 1;
    if (!painted(i)) continue;
    const y = map.pos3[i * 3 + 1];
    sx += x;
    sy += y;
    sz += z;
    rSum += Math.hypot(x, z);
    n++;
    bins[Math.min(359, deg)] = 1;
    perStand[Math.floor(((map.uv[i * 2] + 0.125) % 1) * 4) & 3]++;
  }
  // A handful of seats is a mark, not a tifo to frame.
  if (n < 24) return null;
  // How far round it reaches: the whole circle less its widest empty gap.
  const arcOf = (on: Uint8Array): number => {
    let gap = 0;
    let run = 0;
    for (let k = 0; k < 720; k++) {
      if (on[k % 360]) run = 0;
      else gap = Math.max(gap, ++run);
    }
    return 360 - Math.min(360, gap);
  };
  const arcDeg = arcOf(bins);
  const cx = sx / n;
  const cz = sz / n;
  const len = Math.hypot(cx, cz);
  // Round most of the bowl, or so evenly spread that its middle is the middle
  // of the pitch: the gantry is the camera for that. "The bowl" is the
  // ground's own seats: on a ground with stands on two sides, a design on
  // all of them (most of its seats, or most of the way round them) is a
  // whole-stadium design, and its own cameras are the ones made for it.
  if (arcDeg > 200 || arcDeg > arcOf(groundBins) * 0.8 || n > map.count * 0.85 || len < (rSum / n) * 0.35) return null;
  const dx = cx / len;
  const dz = cz / len;
  let y0 = Infinity;
  let y1 = -Infinity;
  let a0 = Infinity;
  let a1 = -Infinity;
  let near = Infinity;
  let far = -Infinity;
  for (let i = 0; i < map.count; i++) {
    if (!painted(i)) continue;
    const x = map.pos3[i * 3];
    const y = map.pos3[i * 3 + 1];
    const z = map.pos3[i * 3 + 2];
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    const across = x * -dz + z * dx;
    a0 = Math.min(a0, across);
    a1 = Math.max(a1, across);
    const out = x * dx + z * dz;
    near = Math.min(near, out);
    far = Math.max(far, out);
  }
  let stand = 0;
  for (let s = 1; s < 4; s++) if (perStand[s] > perStand[stand]) stand = s;
  return {
    centre: [cx, sy / n, cz],
    dir: [dx, dz],
    width: Math.max(4, a1 - a0),
    y0,
    y1,
    near,
    far,
    arcDeg,
    stand: stand as 0 | 1 | 2 | 3,
    standShare: perStand[stand] / n,
    seats: n,
  };
}

/**
 * The vertical field of view that holds `w` metres across and `h` metres up at
 * `d` metres, with room round them. The room across is generous on purpose:
 * Match Day's panel covers about a fifth of one side of the picture, and the
 * tifo is framed in the middle of the whole of it, so it is held to the middle
 * three-fifths, clear of the panel with it open.
 */
function fovToHold(w: number, h: number, d: number, aspect: number): number {
  const a = aspect > 0 ? aspect : 16 / 9;
  const half = Math.max(Math.atan((h * 1.4) / 2 / d), Math.atan((w * 1.6) / 2 / d / a));
  return (half * 360) / Math.PI;
}

/**
 * Two cameras on the tifo, from where people really film one.
 *
 * "Your Tifo": the far side's gantry, straight across the pitch from it, high
 * enough to see over the front rows and zoomed (by field of view, not by
 * moving into the air) so the whole tifo fills the picture. "Tifo Pitch
 * Level": on the grass in front of it, looking up, a step to one side — the
 * angle the tifo is made for. `bounds` is the bowl's extent; `aspect` the
 * picture's, so a phone held upright still gets the tifo's full width.
 */
export function tifoShots(
  fp: TifoFootprint,
  bounds: BowlBounds,
  aspect: number,
  /** How far back and how high a camera can go: inside the building, and in a hall below the roof. */
  room?: { back: number; y: number },
): SimShot[] {
  const [dx, dz] = fp.dir;
  const [cx, cy0, cz] = fp.centre;
  // The far side, measured along the same line: an end stand faces an end,
  // a side faces a side, and an oval's corner faces the opposite corner. The
  // bowl's radius that way, as an ellipse: |dx|·ax + |dz|·bz is the same on
  // the axes but reaches past the stands on a diagonal, and a tifo off to one
  // side had its camera outside the ground.
  const reach = 1 / Math.hypot(dx / Math.max(1, bounds.ax), dz / Math.max(1, bounds.bz));
  const back = Math.min(room?.back ?? Infinity, Math.max(30, reach * 0.95));
  const camY = Math.min(room?.y ?? Infinity, bounds.ty * 1.02 + 2);
  const pos: [number, number, number] = [-dx * back, camY, -dz * back];
  const midY = (fp.y0 + fp.y1) / 2;
  const target: [number, number, number] = [cx, Math.max(1.5, midY), cz];
  const dist = Math.hypot(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
  // Seen from across, a raked stand shows its rise and part of its depth.
  const tall = fp.y1 - fp.y0 + (fp.far - fp.near) * 0.35;
  const fov = Math.max(16, Math.min(58, fovToHold(fp.width, tall, dist, aspect)));
  const wide: SimShot = { name: 'Your Tifo', position: pos, target, fov };

  // On the grass: far enough out to hold the tifo at a wide lens, but close
  // enough to look UP at it (from much further than 55 m a stand is a thin
  // band at eye level, across a running track), never inside the front row,
  // and never far past the middle of the pitch.
  const lens = 62;
  const a = aspect > 0 ? aspect : 16 / 9;
  const hHalf = Math.atan(Math.tan((lens * Math.PI) / 360) * a);
  const hold = (fp.width * 0.62) / Math.tan(hHalf);
  const out = Math.max(fp.near - Math.max(18, Math.min(hold, 55)), -reach * 0.15);
  const side = fp.width * 0.12;
  const low: SimShot = {
    name: 'Tifo Pitch Level',
    position: [dx * out - dz * side, 2.2, dz * out + dx * side],
    target: [cx, Math.max(4, cy0 + (fp.y1 - cy0) * 0.35), cz],
    fov: lens,
  };
  return [wide, low];
}
