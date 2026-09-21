import type { SeatMap } from '../../core/types';

/**
 * A stand, described as a surface you can put a banner on.
 *
 * Everything else in the simulator places things with world coordinates and a
 * yaw, which works for a floodlight mast and falls apart for a banner: drag one
 * sideways along a curved end stand in world X and it walks straight through
 * the seats. A banner belongs to the stand it hangs on, so it is placed in the
 * stand's OWN coordinates — along it, up it, out from it — and this module is
 * what turns those three numbers back into a point in the bowl.
 *
 * It is built entirely from the seat map, so it adapts to any template: the
 * stands are whatever shape that ground's stands are.
 */

export interface SurfacePoint {
  /** World position on (or just off) the stand's face. */
  x: number;
  y: number;
  z: number;
  /** Unit vector along the stand, in the direction of increasing `alongU`. */
  rx: number;
  rz: number;
  /** Unit vector out of the stand, toward the pitch. */
  ox: number;
  oz: number;
}

export interface StandFrame {
  stand: 0 | 1 | 2 | 3;
  /** Metres along the stand's front, measured around the curve. */
  widthM: number;
  /** Metres from the front rail to the back row, vertically. */
  heightM: number;
  /**
   * Metres UP THE SLOPE from the front rail to the back row.
   *
   * The one a banner is measured against. A stand 24 m high with 40 m of
   * terracing behind it is 46 m of surface, and a banner "18 m high" covers 18
   * metres of THAT, not 18 metres of altitude. Sizing against the vertical
   * height is how a banner ends up covering three quarters of a stand when it
   * was meant to cover a third.
   */
  slopeM: number;
  /** Lowest and highest seat elevation. */
  minY: number;
  maxY: number;
  /** Elevation of the pitch-side rail — the top of the dark front wall. */
  railY: number;
  /** Where a roof rig would be: above the back of the stand. */
  roofY: number;
  /** Any seats at all? A box arena's corners have none. */
  ok: boolean;
  /**
   * A point on the stand's face.
   *
   * `alongU` runs 0..1 from one end of the stand to the other, `heightV` runs
   * 0 at the front rail to 1 at the back row. Both are clamped, so a banner
   * dragged past the end of a stand stops at the end rather than teleporting
   * onto the next one.
   */
  pointAt(alongU: number, heightV: number): SurfacePoint;
  /**
   * The outward normal of the seating at a point — up and out of the terracing.
   *
   * This is what lets a banner lie a metre and a half PROUD of the stand
   * instead of inside it. Hanging a sheet straight down in world space from a
   * point half way up a raked stand buries it in the seats below within a
   * couple of metres, which is exactly what the first version of the rig did.
   */
  normalAt(alongU: number, heightV: number): { nx: number; ny: number; nz: number };
  /** A coarse triangle mesh of the face, for raycasting a drag onto it. */
  surfaceGrid(cols: number, rows: number): { positions: Float32Array; indices: Uint32Array };

  /**
   * The blocks this stand is divided into, left to right.
   *
   * These are the real ones — the wedges of seating between the radial
   * aisles, which are the black gaps you can see running up every stand in
   * the bowl. They are found by looking for the gaps in the seating rather
   * than by dividing the stand into equal parts, so they land on the aisles
   * whatever the template does.
   *
   * They exist because free placement was a mistake. A banner dragged along a
   * continuous slider has no reason to line up with anything, ends up
   * straddling two aisles with a corner hanging off the end of the stand, and
   * a sheet sized in metres on a slider has no idea how much stand there is
   * to cover. A crew does not think that way: they think "the whole of block
   * 4 and 5". Blocks make that the unit.
   */
  blocks: StandBlock[];

  /**
   * The tiers, as bands of `heightV`.
   *
   * The vertical half of the same idea, and the same reason: a banner belongs
   * to a tier, not to an arbitrary height up a rake that happens to cross a
   * walkway.
   */
  tiers: TierBand[];
}

export interface StandBlock {
  /** Extent across the stand, in `alongU`. */
  u0: number;
  u1: number;
  /** Centre, and real width along the front rail in metres. */
  centerU: number;
  widthM: number;
}

export interface TierBand {
  /** Extent up the stand, in `heightV`. */
  v0: number;
  v1: number;
  /** Length of this band measured UP THE SLOPE, in metres. */
  slopeM: number;
}

const COLS = 56;

/** Which stand a perimeter fraction belongs to — the app's existing convention. */
export function standOfU(u: number): 0 | 1 | 2 | 3 {
  return Math.floor(((u + 0.125) % 1) * 4) as 0 | 1 | 2 | 3;
}

/**
 * Where a stand STARTS, as a perimeter fraction.
 *
 * Read this off the classifier rather than guessing it: `standOfU` puts a seat
 * on stand s when `floor(((u + 0.125) % 1) * 4) === s`, which is true for
 * u in [s/4 - 0.125, (s+1)/4 - 0.125). The first attempt here used
 * `s*0.25 + 0.125`, which is the stand's END — so every seat fell outside the
 * window, every stand reported itself empty, and every banner hung on the
 * fallback flat wall. The shot harness's census caught it; the screenshots did
 * not, because a banner on a plausible wall looks like a banner.
 */
function standU0(stand: 0 | 1 | 2 | 3): number {
  return (stand * 0.25 - 0.125 + 1) % 1;
}

/** `alongU` (0..1 across one stand) as a perimeter fraction. */
export function alongToU(stand: 0 | 1 | 2 | 3, alongU: number): number {
  return (standU0(stand) + clamp01(alongU) * 0.25) % 1;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface Column {
  /** Seats in this column, sorted by elevation. */
  ys: number[];
  xs: number[];
  zs: number[];
}

export function buildStandFrame(map: SeatMap, stand: 0 | 1 | 2 | 3, roofRise = 9): StandFrame {
  const u0 = standU0(stand);
  const cols: Column[] = Array.from({ length: COLS }, () => ({ ys: [], xs: [], zs: [] }));
  let minY = Infinity;
  let maxY = -Infinity;
  let n = 0;

  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    if (standOfU(u) !== stand) continue;
    // Position across this stand, 0..1. The +1 keeps the East stand — which
    // straddles u = 0 — from wrapping into a negative index.
    const su = (((u - u0 + 1) % 1) / 0.25);
    if (su < 0 || su >= 1) continue;
    const ci = Math.min(COLS - 1, Math.floor(su * COLS));
    const y = map.pos3[i * 3 + 1];
    cols[ci].xs.push(map.pos3[i * 3]);
    cols[ci].ys.push(y);
    cols[ci].zs.push(map.pos3[i * 3 + 2]);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    n++;
  }

  if (n === 0 || !isFinite(minY)) {
    // A stand with no seats (an open corner) still has to answer, so it answers
    // with a plausible flat wall rather than NaN — a banner placed on it will
    // look wrong, which is the correct amount of wrong.
    const flat: StandFrame = {
      stand, widthM: 40, heightM: 16, slopeM: 24, minY: 2, maxY: 18, railY: 2, roofY: 27, ok: false,
      pointAt: (a, v) => ({ x: (a - 0.5) * 40, y: 2 + clamp01(v) * 16, z: -60, rx: 1, rz: 0, ox: 0, oz: 1 }),
      normalAt: () => ({ nx: 0, ny: 0, nz: 1 }),
      surfaceGrid: () => ({ positions: new Float32Array(0), indices: new Uint32Array(0) }),
      blocks: [{ u0: 0, u1: 1, centerU: 0.5, widthM: 40 }],
      tiers: [{ v0: 0, v1: 1, slopeM: 24 }],
    };
    return flat;
  }

  // Sort each column bottom-to-top and fill empty columns from their neighbours
  // so an aisle does not punch a hole in the surface.
  for (const c of cols) {
    const order = c.ys.map((_, k) => k).sort((a, b) => c.ys[a] - c.ys[b]);
    c.xs = order.map((k) => c.xs[k]);
    c.ys = order.map((k) => c.ys[k]);
    c.zs = order.map((k) => c.zs[k]);
  }
  for (let i = 0; i < COLS; i++) {
    if (cols[i].ys.length >= 2) continue;
    let lo = i - 1;
    let hi = i + 1;
    while (lo >= 0 && cols[lo].ys.length < 2) lo--;
    while (hi < COLS && cols[hi].ys.length < 2) hi++;
    const src = lo >= 0 ? cols[lo] : hi < COLS ? cols[hi] : null;
    if (src) cols[i] = { xs: src.xs.slice(), ys: src.ys.slice(), zs: src.zs.slice() };
  }

  /** Interpolate one column's (x,z) at an elevation. */
  const colAt = (c: Column, y: number): { x: number; z: number } => {
    const m = c.ys.length;
    if (m === 0) return { x: 0, z: 0 };
    if (m === 1 || y <= c.ys[0]) return { x: c.xs[0], z: c.zs[0] };
    if (y >= c.ys[m - 1]) return { x: c.xs[m - 1], z: c.zs[m - 1] };
    let k = 1;
    while (k < m - 1 && c.ys[k] < y) k++;
    const y0 = c.ys[k - 1];
    const y1 = c.ys[k];
    const t = y1 > y0 ? (y - y0) / (y1 - y0) : 0;
    return { x: c.xs[k - 1] + (c.xs[k] - c.xs[k - 1]) * t, z: c.zs[k - 1] + (c.zs[k] - c.zs[k - 1]) * t };
  };

  // Width along the front rail, measured around the curve rather than corner to
  // corner: on an end stand the chord is several metres short of the arc, and a
  // banner sized to the chord leaves a visible gap at both ends.
  let widthM = 0;
  let prev: { x: number; z: number } | null = null;
  for (let i = 0; i < COLS; i++) {
    const p = colAt(cols[i], minY);
    if (prev) widthM += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  widthM *= COLS / (COLS - 1); // the samples are column centres, so add one gap

  const heightM = Math.max(1, maxY - minY);
  const railY = minY;
  const roofY = maxY + roofRise;

  const pointAt = (alongU: number, heightV: number): SurfacePoint => {
    const a = clamp01(alongU) * (COLS - 1);
    const i0 = Math.min(COLS - 1, Math.floor(a));
    const i1 = Math.min(COLS - 1, i0 + 1);
    const ft = a - i0;
    const y = minY + clamp01(heightV) * heightM;
    const p0 = colAt(cols[i0], y);
    const p1 = colAt(cols[i1], y);
    const x = p0.x + (p1.x - p0.x) * ft;
    const z = p0.z + (p1.z - p0.z) * ft;

    // Along-the-stand direction from the two bracketing columns; at the very
    // ends both are the same column, so step inward for the tangent.
    const ja = Math.max(0, Math.min(COLS - 2, i0));
    const q0 = colAt(cols[ja], y);
    const q1 = colAt(cols[ja + 1], y);
    let rx = q1.x - q0.x;
    let rz = q1.z - q0.z;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;

    // Out of the stand is toward the bowl's centre, which is the origin.
    const rad = Math.hypot(x, z) || 1;
    return { x, y, z, rx, rz, ox: -x / rad, oz: -z / rad };
  };

  // Slope length up the middle of the stand, walked rather than assumed: the
  // rake is not constant once a bowl has two tiers with a walkway between them.
  let slopeM = 0;
  {
    let prevP = pointAt(0.5, 0);
    for (let k = 1; k <= 24; k++) {
      const p = pointAt(0.5, k / 24);
      slopeM += Math.hypot(p.x - prevP.x, p.y - prevP.y, p.z - prevP.z);
      prevP = p;
    }
  }
  slopeM = Math.max(heightM, slopeM);

  const normalAt = (alongU: number, heightV: number): { nx: number; ny: number; nz: number } => {
    const dv = 0.02;
    const lo = pointAt(alongU, Math.max(0, heightV - dv));
    const hi = pointAt(alongU, Math.min(1, heightV + dv));
    // Up the rake, and along the stand: their cross product is the face normal.
    let ux = hi.x - lo.x;
    let uy = hi.y - lo.y;
    let uz = hi.z - lo.z;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const mid = pointAt(alongU, heightV);
    // cross(upTheRake, alongTheStand), with `along` horizontal: (rx, 0, rz).
    const nx = uy * mid.rz;
    const ny = uz * mid.rx - ux * mid.rz;
    const nz = -uy * mid.rx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    let ox = nx / nl;
    let oy = ny / nl;
    let oz = nz / nl;
    // Point it toward the pitch, not into the building.
    if (ox * mid.ox + oz * mid.oz < 0) {
      ox = -ox; oy = -oy; oz = -oz;
    }
    return { nx: ox, ny: oy, nz: oz };
  };

  const surfaceGrid = (gc: number, gr: number): { positions: Float32Array; indices: Uint32Array } => {
    const positions = new Float32Array(gc * gr * 3);
    for (let r = 0; r < gr; r++) {
      for (let c = 0; c < gc; c++) {
        const p = pointAt(gc > 1 ? c / (gc - 1) : 0.5, gr > 1 ? r / (gr - 1) : 0.5);
        const o = (r * gc + c) * 3;
        // Lifted a little off the seats so a drag ray hits the surface rather
        // than sliding between two rows of seat boxes.
        positions[o] = p.x + p.ox * 0.4;
        positions[o + 1] = p.y + 0.6;
        positions[o + 2] = p.z + p.oz * 0.4;
      }
    }
    const indices = new Uint32Array((gc - 1) * (gr - 1) * 6);
    let k = 0;
    for (let r = 0; r < gr - 1; r++) {
      for (let c = 0; c < gc - 1; c++) {
        const a = r * gc + c;
        const b = a + 1;
        const d = a + gc;
        const e = d + 1;
        indices[k++] = a; indices[k++] = d; indices[k++] = b;
        indices[k++] = b; indices[k++] = d; indices[k++] = e;
      }
    }
    return { positions, indices };
  };

  // ---- blocks: the wedges of seating between the radial aisles -----------
  //
  // Found by looking for the gaps rather than by dividing the stand up, so an
  // unevenly laid-out ground still gets its real blocks. The binning has to be
  // fine: a 1.2 m aisle on a 133 m stand is under a percent of it, and at the
  // 56 columns the surface is built from it does not leave an empty bin.
  const BINS = 320;
  const pop = new Int32Array(BINS);
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    if (standOfU(u) !== stand) continue;
    const su = (((u - u0 + 1) % 1) / 0.25);
    if (su < 0 || su >= 1) continue;
    pop[Math.min(BINS - 1, Math.floor(su * BINS))]++;
  }
  // "Empty" against the stand's own density, not against zero: the top of a
  // bin can catch a stray seat from the row above an aisle.
  let occupied = 0;
  for (let b = 0; b < BINS; b++) if (pop[b] > 0) occupied++;
  const mean = occupied > 0 ? n / occupied : 0;
  const gapAt = (b: number): boolean => pop[b] < mean * 0.25;

  const blocks: StandBlock[] = [];
  {
    let start = -1;
    for (let b = 0; b <= BINS; b++) {
      const solid = b < BINS && !gapAt(b);
      if (solid && start < 0) start = b;
      if (!solid && start >= 0) {
        const a0 = start / BINS;
        const a1 = b / BINS;
        // Ignore slivers: a couple of bins is noise, not a block.
        if (a1 - a0 > 0.012) {
          blocks.push({ u0: a0, u1: a1, centerU: (a0 + a1) / 2, widthM: (a1 - a0) * widthM });
        }
        start = -1;
      }
    }
  }
  // A stand with no detectable aisles is still one block, not none.
  if (blocks.length === 0) blocks.push({ u0: 0, u1: 1, centerU: 0.5, widthM });

  // ---- tiers: read off the seat map, not guessed from a histogram ---------
  //
  // The first version of this looked for a horizontal band with no seats in
  // it, the way the blocks look for a vertical one. It found one tier on
  // every ground in the catalogue including the two-tier ones, because the
  // walkway between tiers is a few metres out of forty and the rows either
  // side of it are dense enough to smear across it. The seat map already
  // carries `tierOf`; there was never a reason to infer it.
  const tierLo: number[] = [];
  const tierHi: number[] = [];
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    if (standOfU(u) !== stand) continue;
    const t = map.tierOf[i];
    const v = (map.pos3[i * 3 + 1] - minY) / Math.max(0.001, heightM);
    if (tierLo[t] === undefined || v < tierLo[t]) tierLo[t] = v;
    if (tierHi[t] === undefined || v > tierHi[t]) tierHi[t] = v;
  }
  const tiers: TierBand[] = [];
  for (let t = 0; t < tierLo.length; t++) {
    if (tierLo[t] === undefined) continue;
    tiers.push({ v0: Math.max(0, tierLo[t]), v1: Math.min(1, tierHi[t]), slopeM: 0 });
  }
  tiers.sort((a, b) => a.v0 - b.v0);
  if (tiers.length === 0) tiers.push({ v0: 0, v1: 1, slopeM: 0 });

  const frame: StandFrame = {
    stand, widthM, heightM, slopeM, minY, maxY, railY, roofY, ok: true,
    pointAt, normalAt, surfaceGrid, blocks, tiers,
  };
  // Each tier's slope length, walked on the finished frame.
  for (const t of tiers) {
    let len = 0;
    let q = pointAt(0.5, t.v0);
    for (let k = 1; k <= 12; k++) {
      const r = pointAt(0.5, t.v0 + ((t.v1 - t.v0) * k) / 12);
      len += Math.hypot(r.x - q.x, r.y - q.y, r.z - q.z);
      q = r;
    }
    t.slopeM = Math.max(0.5, len);
  }
  return frame;
}

/**
 * Where a drag lands, in stand coordinates.
 *
 * Inverting `pointAt` analytically would mean inverting a superellipse; a
 * search over the same grid the surface is drawn from is exact enough (the
 * refine step lands inside a tenth of a column) and cannot disagree with the
 * geometry the user is looking at, which an analytic inverse eventually would.
 */
export function nearestOnFrame(frame: StandFrame, x: number, y: number, z: number): { alongU: number; heightV: number } {
  let bestU = 0.5;
  let bestV = 0.5;
  let bestD = Infinity;
  const COARSE = 40;
  for (let i = 0; i <= COARSE; i++) {
    for (let j = 0; j <= 16; j++) {
      const u = i / COARSE;
      const v = j / 16;
      const p = frame.pointAt(u, v);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestU = u;
        bestV = v;
      }
    }
  }
  // Two refinement passes, each an order of magnitude finer.
  let step = 1 / COARSE;
  for (let pass = 0; pass < 2; pass++) {
    step /= 5;
    for (let i = -5; i <= 5; i++) {
      for (let j = -5; j <= 5; j++) {
        const u = clamp01(bestU + i * step);
        const v = clamp01(bestV + j * step * 2.5);
        const p = frame.pointAt(u, v);
        const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          bestU = u;
          bestV = v;
        }
      }
    }
  }
  return { alongU: bestU, heightV: bestV };
}
