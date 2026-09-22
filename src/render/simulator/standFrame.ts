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
   *
   * `slopeAt` over the whole stand — see the note there for why it is
   * measured in the (radius, height) plane. Across every ground in the
   * catalogue the rake varies by 1-6% between one run of blocks and another,
   * so this single number describes a stand well; the two-tier bend is in it
   * because the measure follows the surface.
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
   * Metres across the stand between two `alongU`, at a given height.
   *
   * NOT the same as a fraction of `widthM`, and the difference is large. A
   * bowl's back row sits on a bigger radius than its front rail, so the same
   * angular span is far longer up the back: on the generic bowl, four blocks
   * measure 74 m at the rail and 115 m at the back row.
   *
   * A banner high on a stand is therefore half as wide again as its share of
   * `widthM` suggests, and sizing it off the rail understates its seams, its
   * weight and the shape its artwork is stretched into. Measured by walking
   * the row rather than assumed, because a superellipse does not have a
   * radius to divide by.
   */
  widthAt(u0: number, u1: number, heightV: number): number;

  /**
   * Metres UP THE SLOPE across a run of the stand, between two heights.
   *
   * Measured in the (radius, height) plane rather than in world space, and
   * that is not a refinement — it is the difference between a number and
   * noise. A column of this surface is interpolated through individual seat
   * positions, and consecutive seats jitter sideways; a 3-D arc length
   * therefore picks up that jitter and DIVERGES as you sample it more finely.
   * On the generic bowl the same 48 m rake measured 48 m at 8 steps, 75 m at
   * 64 and 214 m at 256. Two rounds of banner bugs came out of trusting it:
   * the "corner rake is four times the centre" I fixed last time was this
   * artefact, not geometry.
   *
   * Going back up a stand, radius and height both increase monotonically, and
   * the lateral jitter is entirely in the direction that (r, y) throws away.
   * So this converges: 48.0 m at 8 steps, 48.1 m at 64.
   *
   * Taken as the median across the run, so one degenerate column at the very
   * edge of a stand — where the bins straddle the corner — cannot move it.
   */
  slopeAt(u0: number, u1: number, v0: number, v1: number): number;

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

/**
 * A column of the stand: ONE POINT PER ROW OF SEATING, not one per seat.
 *
 * A column is a 1/56 slice of a stand, which is a couple of metres wide, and
 * the seats inside it scatter across that width. Threading the surface
 * through every one of them in elevation order makes it zig-zag sideways by
 * a seat's width between consecutive points — noise at a scale far below
 * anything the stand actually does.
 *
 * That noise is the hidden cause of a long run of banner problems. It made
 * arc length along a column diverge as you sampled it more finely (a 48 m
 * rake measured 214 m at 256 steps), which made every "metres down the
 * slope" figure depend on its step count; and a banner with rows a
 * centimetre apart in `heightV` inherited the zig-zag as a visible ripple.
 *
 * Averaging each row's seats within the column removes it at the source. The
 * profile that comes out is the real one — the noses of the steps — and it
 * is smooth, monotone and resolution-independent.
 */
interface Column {
  /** Row centres in this column, sorted by elevation. */
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

  // Accumulated per (column, row) and averaged below — see `Column`.
  const acc = new Map<number, { x: number; y: number; z: number; n: number }>();
  for (let i = 0; i < map.count; i++) {
    const u = map.uv[i * 2];
    if (standOfU(u) !== stand) continue;
    // Position across this stand, 0..1. The +1 keeps the East stand — which
    // straddles u = 0 — from wrapping into a negative index.
    const su = (((u - u0 + 1) % 1) / 0.25);
    if (su < 0 || su >= 1) continue;
    const ci = Math.min(COLS - 1, Math.floor(su * COLS));
    const y = map.pos3[i * 3 + 1];
    const key = ci * 65536 + map.tierOf[i] * 4096 + map.rowOf[i];
    let a = acc.get(key);
    if (!a) { a = { x: 0, y: 0, z: 0, n: 0 }; acc.set(key, a); }
    a.x += map.pos3[i * 3];
    a.y += y;
    a.z += map.pos3[i * 3 + 2];
    a.n++;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    n++;
  }
  for (const [key, a] of acc) {
    const c = cols[Math.floor(key / 65536)];
    c.xs.push(a.x / a.n);
    c.ys.push(a.y / a.n);
    c.zs.push(a.z / a.n);
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
      widthAt: (a0, a1) => Math.abs(a1 - a0) * 40,
      slopeAt: (_a, _b, v0, v1) => Math.abs(v1 - v0) * 24,
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
    //
    // Widened until the pair is actually distinct. An empty column is filled
    // from its nearest populated neighbour, so two adjacent columns can be
    // copies of one another — and then the difference between them is zero,
    // the tangent is zero, and anything built along it collapses to a point.
    // On the little arena that is exactly what a hanging banner over the last
    // two blocks did: 33 m of sheet rendered as a 1.5 m sliver.
    const ja = Math.max(0, Math.min(COLS - 2, i0));
    let rx = 0;
    let rz = 0;
    let rl = 0;
    for (let w = 1; w < COLS && rl < 1e-6; w++) {
      const lo = Math.max(0, ja - w + 1);
      const hi = Math.min(COLS - 1, ja + w);
      const q0 = colAt(cols[lo], y);
      const q1 = colAt(cols[hi], y);
      rx = q1.x - q0.x;
      rz = q1.z - q0.z;
      rl = Math.hypot(rx, rz);
    }
    if (rl < 1e-6) {
      // A stand that is a single point in plan has no direction of its own;
      // take the one perpendicular to the radius so the frame stays usable.
      const rr = Math.hypot(x, z) || 1;
      rx = -z / rr;
      rz = x / rr;
      rl = 1;
    }
    rx /= rl;
    rz /= rl;

    // Out of the stand is toward the bowl's centre, which is the origin.
    const rad = Math.hypot(x, z) || 1;
    return { x, y, z, rx, rz, ox: -x / rad, oz: -z / rad };
  };

  // Filled in below, once `slopeAt` exists to measure it properly.
  const slopeM = heightM;

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
  // ---- drop the corner curls ---------------------------------------------
  //
  // A stand's ends are where its parameterisation is worst. On a ground with
  // a hard corner cut the last few metres of seating double back on
  // themselves in plan — the front rail of the Kingdom Arena's end stand runs
  // out to (66, -51), back to (61, -39), and only then forward along the
  // straight — and the gap detector faithfully reports those curls as blocks
  // three or four metres wide.
  //
  // They are not blocks. Nobody hangs a banner on four metres of doubled-back
  // corner, and every geometric check in the sweep failed on exactly them:
  // five metres of sheet standing clear of the terracing, because there is no
  // single sensible surface there to lie on. Offering a place that cannot
  // work is worse than not offering it.
  //
  // Judged against the stand's own blocks rather than an absolute: grounds in
  // the catalogue run from 15 m blocks to 29 m ones. A half-width block at a
  // stand boundary — the other half belongs to the next stand — is a real
  // place and survives this.
  if (blocks.length > 1) {
    const widths = blocks.map((b) => b.widthM).sort((x, y) => x - y);
    const median = widths[widths.length >> 1];
    const floorM = Math.max(6, median * 0.4);
    const kept = blocks.filter((b) => b.widthM >= floorM);
    if (kept.length > 0) {
      blocks.length = 0;
      blocks.push(...kept);
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

  const widthAt = (a0: number, a1: number, heightV: number): number => {
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    let len = 0;
    let prev = pointAt(lo, heightV);
    const steps = 48;
    for (let k = 1; k <= steps; k++) {
      const p = pointAt(lo + ((hi - lo) * k) / steps, heightV);
      len += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      prev = p;
    }
    return len;
  };

  // Thirty-two steps: fine enough to follow the bend where a two-tier stand
  // changes rake at the walkway, coarse enough not to start resolving
  // individual seats — which is where the measurement stops converging.
  const RAKE_STEPS = 32;
  const rakeAt = (alongU: number, v0: number, v1: number): number => {
    let len = 0;
    let p = pointAt(alongU, v0);
    let pr = Math.hypot(p.x, p.z);
    for (let k = 1; k <= RAKE_STEPS; k++) {
      const q = pointAt(alongU, v0 + ((v1 - v0) * k) / RAKE_STEPS);
      const qr = Math.hypot(q.x, q.z);
      len += Math.hypot(qr - pr, q.y - p.y);
      p = q;
      pr = qr;
    }
    return len;
  };
  const RAKE_SAMPLES = 7;
  const rakeBuf = new Float64Array(RAKE_SAMPLES);
  const slopeAt = (a0: number, a1: number, v0: number, v1: number): number => {
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    for (let k = 0; k < RAKE_SAMPLES; k++) {
      rakeBuf[k] = rakeAt(lo + ((hi - lo) * k) / (RAKE_SAMPLES - 1), v0, v1);
    }
    rakeBuf.sort();
    return Math.max(0.5, rakeBuf[RAKE_SAMPLES >> 1]);
  };

  const frame: StandFrame = {
    stand, widthM, heightM, slopeM, minY, maxY, railY, roofY, ok: true,
    pointAt, normalAt, surfaceGrid, blocks, tiers, widthAt, slopeAt,
  };
  // The stand's own rake, on the same convergent measure everything else uses.
  frame.slopeM = slopeAt(0, 1, 0, 1);
  // Each tier's rake, measured the same way.
  for (const t of tiers) t.slopeM = slopeAt(0, 1, t.v0, t.v1);
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
