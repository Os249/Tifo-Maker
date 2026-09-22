import type { BannerDoc } from '../../core/banner';
import type { StandFrame } from './standFrame';
import {
  crowdSupportM, hangAnchorV, hangAnchorY, hangStandoff, type ResolvedSlot,
} from './bannerSlot';

/**
 * A banner's geometry, as a function of where it is and what time it is.
 *
 * This file replaces an XPBD cloth solver, a heightfield collider, a rope net
 * and about three thousand lines of rig. The reason is not that the solver
 * was badly written — it is that a solver makes a banner's shape the output
 * of a nonlinear system with state, and that has two consequences a product
 * cannot live with:
 *
 *   1. The space of configurations is infinite and continuous, so it can be
 *      sampled but never proved. Every round, a size or a position nobody had
 *      tried turned out to be the one that broke.
 *   2. Shape depends on history. Frame ten thousand is not reproducible from
 *      the inputs alone, which makes every bug a story rather than a repro.
 *
 * Here the shape is a pure function `P(slot, u, v, t)`. It has no state, so
 * there is nothing to accumulate, resonate or explode; the same inputs give
 * the same vertices to the bit, forever.
 *
 * And, for the type that sits on the terracing:
 *
 *      P(u, v) = standSurface(u, v) + normal(u, v) * (positive offset)
 *
 * The banner is PARAMETERISED ON THE STAND. It is not near the stand, held
 * off the stand, or colliding with the stand — its coordinates are the
 * stand's coordinates, pushed out along the outward normal. It can no more
 * be inside the terracing than a decal can be inside a wall, for any size,
 * any block, any tier, any ground, any frame.
 *
 * What that gives up is real aerodynamics: this banner will not billow in a
 * gale. What it buys is a banner that is correct in all 864 configurations a
 * ground offers, which is the trade worth making for a design tool.
 */

/** Vertices across and down. Fixed, so cost does not depend on the slot. */
export const SURF_COLS = 41;
export const SURF_ROWS = 25;
export const SURF_VERTS = SURF_COLS * SURF_ROWS;

/**
 * Where the banner's seams sit across the stand, as `alongU`.
 *
 * Evenly divided by ARC LENGTH, not by `u`, and the difference is the
 * difference between a banner and a folded screen. `u` is a fraction of a
 * stand, and a stand's blocks are not equal: on the small arena the end
 * blocks are 3.7 m and the middle ones 29 m, so columns spaced evenly in `u`
 * put four of them across the tight corner and thirty across the straight.
 * The sheet then cut 4.75 metres inside the corner — a banner floating clear
 * of the terracing it is supposed to be lying on.
 *
 * Spacing by metres of fabric crowds the columns where the stand turns and
 * spreads them where it runs straight, which is where a real banner's panels
 * go and what keeps the artwork from being squashed at the corners.
 *
 * Exported because the test has to ask rather than re-derive; `out` is the
 * caller's, so there is no shared scratch between the two.
 */
export function columnsU(slot: ResolvedSlot, frame: StandFrame, out: Float64Array): void {
  const spanU = slot.u1 - slot.u0;
  // Measured at the middle of the sheet, so the division is fair over all of
  // it rather than true at one edge.
  const v = (slot.v1 + slot.vBottom) / 2;
  const N = 160;
  const cum = ARC_CUM;
  cum[0] = 0;
  let p = frame.pointAt(slot.u0, v);
  for (let k = 1; k <= N; k++) {
    const q = frame.pointAt(slot.u0 + (spanU * k) / N, v);
    cum[k] = cum[k - 1] + Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    p = q;
  }
  const total = cum[N];
  out[0] = slot.u0;
  out[SURF_COLS - 1] = slot.u1;
  if (total <= 1e-9) {
    for (let i = 1; i < SURF_COLS - 1; i++) out[i] = slot.u0 + (spanU * i) / (SURF_COLS - 1);
    return;
  }
  let k = 1;
  for (let i = 1; i < SURF_COLS - 1; i++) {
    const want = (total * i) / (SURF_COLS - 1);
    while (k < N && cum[k] < want) k++;
    const lo = cum[k - 1];
    const hi = cum[k];
    const f = hi > lo ? (want - lo) / (hi - lo) : 0;
    out[i] = slot.u0 + (spanU * (k - 1 + f)) / N;
  }
}

/** Scratch for the arc-length table. One banner is built at a time. */
const ARC_CUM = new Float64Array(161);
const COL_U = new Float64Array(SURF_COLS);

/** Everything the surface needs that is not the slot or the time. */
export interface SurfaceEnv {
  frame: StandFrame;
  /** Crowd fill 0..1: a banner over a full block rests on people. */
  crowdFill: number;
  /** Wind 0..1 from the panel. Scales the wave, nothing else. */
  wind: number;
  /** Reveal progress 0..1. */
  progress: number;
}

/**
 * The most the terms below can add, for `maxOffsetM`.
 *
 * The wave's three coefficients sum to one by construction, so its extreme is
 * exactly the amplitude.
 */
/**
 * How far a wave may move the fabric, in metres.
 *
 * A hard ceiling, not a target. Every motion term in this file is a bounded
 * function of position and time, so the furthest a vertex can ever be from
 * its rest place is the sum of these — a number I can state, rather than
 * whatever a solver happened to do that frame.
 */
const WAVE_STILL_M = 0.06;
/**
 * At full wind.
 *
 * Reported as "no movement at all even at max", and the number is why: 30 cm
 * of travel on a forty-metre sheet seen from across a pitch is about two
 * pixels. The motion has to be a fraction of the BANNER to be visible, not a
 * fraction of a metre — on a 40 m Blockfahne this is a sheet breathing by
 * about a fiftieth of its own width, which is a slight move and nothing more.
 */
const WAVE_WIND_M = 1.1;

/** How far the hem bows out between two ties. Eyelets go in every 50 cm. */
const SCALLOP_TIED_M = 0.08;
/** The same, where a crowd is holding it instead of a rail. */
const SCALLOP_HANDS_M = 0.22;

/** Sag of a rope-hung top edge, as a fraction of its span. */
const CATENARY_SAG_FRAC = 0.02;
/**
 * The most a top edge may dip, in metres, however long it is.
 *
 * Two per cent of the span is right for a banner slung between two corner
 * ropes, and badly wrong for a long one: across a whole stand it came to
 * 3.6 m of sag, which dropped a fascia banner straight out of the band it was
 * meant to fill. Past a few tens of metres nobody hangs a sheet off two
 * points — it is laced to the rail every metre or two, and what you see
 * between the ties is a scallop, not a catenary. So the catenary is capped at
 * about what one unsupported bay does.
 */
const CATENARY_SAG_MAX_M = 0.7;

/**
 * The scallop between ties.
 *
 * Real banners are punched with eyelets every 50 cm and the hem bows out
 * between them. It is a small thing and it is most of why a banner reads as
 * fabric rather than as a decal — a perfectly straight edge is the single
 * clearest tell that something is a texture on a quad.
 */
function scallop(t: number, ties: number, depth: number): number {
  const s = t * ties;
  return depth * Math.sin(Math.PI * (s - Math.floor(s)));
}

/**
 * How free this part of the sheet is to move, 0 at the ties and 1 in the
 * middle.
 *
 * This is what pins the anchored edges EXACTLY — the standard flag-shader
 * trick, and the reason the anchors are correct by construction rather than
 * by a constraint that has to win an argument with gravity every substep.
 */
function freedom(u: number, v: number, bottomFree: boolean): number {
  const across = Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
  const down = bottomFree
    ? Math.pow(Math.min(1, Math.max(0, v)), 0.7)
    : Math.sin(Math.PI * Math.min(1, Math.max(0, v)));
  return across * down;
}

/**
 * Two travelling waves, out of phase.
 *
 * One is enough to look mechanical and three are enough to look like noise.
 * The wavelengths are metres rather than fractions of the banner, so a small
 * banner and a huge one ripple at the same physical scale — which is what
 * makes a 6 m fence banner and a 55 m Blockfahne look like the same cloth.
 */
function wave(xM: number, yM: number, t: number, amp: number): number {
  const a = Math.sin(xM * 0.42 + t * 1.7);
  const b = Math.sin((xM * 0.17 + yM * 0.31) + t * 1.1 + 2.3);
  // A third, very slow and very long: the sheet as a whole leaning in and out
  // with the gust rather than only rippling within itself. Without it a
  // banner shimmers in place and still reads as a rigid board, because
  // nothing about it changes over the couple of seconds anyone looks at it.
  const c = Math.sin(xM * 0.045 + t * 0.34 + 1.1);
  return amp * (0.44 * a + 0.27 * b + 0.29 * c);
}

/**
 * A rope's own shape, between two points.
 *
 * `y = a·cosh(x/a)` is what a cable hanging under its own weight does, and a
 * banner hung on ropes takes the shape of the rope. Written as a dip below
 * the anchors so it is zero at both ends and deepest in the middle.
 *
 * For the shallow sags a banner is rigged at, `cosh` linearises to
 * `a = (span/2)² / (2·sag)`, which is exact enough that the difference is
 * under a millimetre on a fifty-metre span.
 */
function catenaryDip(u: number, spanM: number, sagM: number): number {
  if (sagM <= 1e-6 || spanM <= 1e-6) return 0;
  const half = spanM / 2;
  const a = (half * half) / (2 * sagM);
  const x = (u - 0.5) * spanM;
  return sagM - a * (Math.cosh(x / a) - 1);
}

/**
 * Build one banner's vertices.
 *
 * Writes straight into the position array. No allocation, no state, and the
 * same arguments always produce the same bytes — which is what makes the
 * whole-space test possible and what makes every bug a repro rather than a
 * story about what happened on frame four hundred.
 */
export function buildSurface(
  doc: BannerDoc,
  slot: ResolvedSlot,
  env: SurfaceEnv,
  t: number,
  out: Float32Array,
): void {
  if (doc.kind === 'hanging') buildHanging(doc, slot, env, t, out);
  else buildStand(doc, slot, env, t, out);
}

/**
 * The sheet that covers a block of terracing.
 *
 * Parameterised on the stand itself, which is the whole argument: every
 * vertex is a point of the stand's surface pushed out along that point's own
 * outward normal by a strictly positive amount. There is no configuration in
 * which it can be inside the seating.
 */
function buildStand(
  doc: BannerDoc,
  slot: ResolvedSlot,
  env: SurfaceEnv,
  t: number,
  out: Float32Array,
): void {
  const { frame } = env;
  const support = Math.max(0.06, crowdSupportM(env.crowdFill));
  const amp = WAVE_STILL_M + env.wind * WAVE_WIND_M;
  // The sheet runs from the top of its band down to `vBottom`, which the slot
  // worked out from the rake across this very run of blocks. Rows are evenly
  // spaced between the two, so the bottom edge is a straight line along a row
  // of seating rather than a ragged one.
  const vTop = slot.v1;
  const vDrop = slot.vBottom - slot.v1;
  // The seams, spaced by metres of fabric rather than by fraction of stand.
  const colU = COL_U;
  columnsU(slot, frame, colU);
  // The covered fraction during an unroll. At rest it is all of it.
  const covered = Math.max(0.0001, Math.min(1, env.progress));

  let k = 0;
  for (let j = 0; j < SURF_ROWS; j++) {
    const v = j / (SURF_ROWS - 1);
    // The unroll: the sheet is only as long as has been paid out, and the
    // rest of the grid is gathered at the leading edge — so the mesh is
    // always whole and the roll is never a gap.
    const vv = v * covered;
    const sv = vTop + vDrop * vv;
    for (let i = 0; i < SURF_COLS; i++) {
      const u = i / (SURF_COLS - 1);
      const su = colU[i];
      const p = frame.pointAt(su, sv);
      const n = frame.normalAt(su, sv);

      // Everything below is a distance OUT from the stand, along the normal.
      //
      // Two things have to hold and only one of them used to. The sum must be
      // positive, so the sheet is never inside the terracing — that was true.
      // And the sheet must clear the CROWD, which is a different question
      // entirely, because measuring against the concrete says nothing about
      // the people standing on it.
      //
      // A person is a VERTICAL segment, and what a vertical segment occupies
      // along a tilted normal is its height times that normal's own vertical
      // component. So that is the clearance: the full height where the
      // terracing is shallow and the crowd stands proud of it, tailing to
      // nothing on a face so steep that nobody is standing on it at all.
      //
      // The wave sits on a base raised by its own amplitude, so its trough
      // still clears. Without that, a gust at full wind subtracts a metre and
      // puts the sheet through the people holding it — which is exactly what
      // it did, and it was invisible to every check here.
      let off = Math.max(0.06, support * n.ny) + amp;
      // The hem and the two sides bow between the hands holding them.
      // A weighted hem hangs straighter than a loose one, so the bottom of
      // the sheet scallops less when there is a bar in it.
      const hemFree = doc.weightBar ? 0.45 : 1;
      off += scallop(u, Math.max(2, Math.round(slot.size.widthM / 6)), SCALLOP_HANDS_M) * v * 0.6 * hemFree;
      off += scallop(v, 2, SCALLOP_HANDS_M) * 0.4;
      off += wave(u * slot.size.widthM, v * slot.size.heightM, t, amp)
        * freedom(u, v, false);

      out[k++] = p.x + n.nx * off;
      out[k++] = p.y + n.ny * off;
      out[k++] = p.z + n.nz * off;
    }
  }
}

/**
 * The flat sheet that hangs in the air on ropes.
 *
 * A plane, not a projection: it hangs from a cable between two points, so its
 * top edge is a catenary and the rest of it follows straight down. It is
 * anchored at the lip of a tier or at the roof steel, both of which are in
 * front of the terracing, so there is nothing behind it to hit.
 */
function buildHanging(
  doc: BannerDoc,
  slot: ResolvedSlot,
  env: SurfaceEnv,
  t: number,
  out: Float32Array,
): void {
  const { frame } = env;
  const amp = WAVE_STILL_M + env.wind * WAVE_WIND_M;
  const W = slot.size.widthM;
  const H = slot.size.heightM;

  // The anchor line: a straight chord at the lip, because a banner flown on a
  // cable hangs from a cable and not from the curve of the rail behind it.
  //
  // At the FRONT of the stand. A roof's leading edge is above the front rail,
  // and a tier's lip is the front of that tier — both are out over the pitch,
  // which is the whole reason a hanging banner is visible at all. Anchoring
  // it at `v = 1`, the back row, hung it from the top of the terracing and
  // dropped it straight down through every seat in the stand: in the shots it
  // simply did not appear, because it was inside the building.
  const mid = frame.pointAt((slot.u0 + slot.u1) / 2, hangAnchorV(frame, slot.tier));
  // The BOTTOM edge does not move. The sheet is HAULED UP from it.
  //
  // This is an Aufziehfahne: the banner is laid out along the front of the
  // stand and hauled up its ropes, so it grows upward from a fixed hem. It
  // is the rig that goes with a banner fixed on the ground, and it is the
  // one worth watching — a sheet rising to cover a stand is the moment,
  // where a sheet unrolling down from a line already in place is not.
  //
  // At zero it is a bundle along its own bottom edge; at one it is at full
  // height. The artwork stays upright throughout, because the rows are laid
  // out from the bottom rather than the sheet being moved.
  const topY = hangAnchorY(frame, slot);
  const hauled = Math.max(0.0001, Math.min(1, env.progress));
  const baseY = topY - H;
  // Far enough out that the sheet hangs in front of everything below its
  // anchor, rather than through it.
  const standoff = hangStandoff(frame, slot);
  const sag = Math.min(CATENARY_SAG_MAX_M, CATENARY_SAG_FRAC * W);

  let k = 0;
  for (let j = 0; j < SURF_ROWS; j++) {
    const v = j / (SURF_ROWS - 1);
    for (let i = 0; i < SURF_COLS; i++) {
      const u = i / (SURF_COLS - 1);
      const s = (u - 0.5) * W;
      // The whole sheet hangs from the cable, so the cable's dip moves all of
      // it down — it is not a decoration on the top edge.
      // `v` runs 0 at the top of the artwork to 1 at its hem, so the height
      // above the fixed hem is (1 - v), scaled by how far it has been hauled.
      const y = baseY + (1 - v) * H * hauled - catenaryDip(u, W, sag) * hauled;
      let off = standoff;
      // A weighted hem hangs straight; without one the bottom scallops as
      // freely as the sides do.
      off += scallop(u, Math.max(2, Math.round(W / 4)), SCALLOP_TIED_M)
        * (doc.weightBar ? 0.5 + v * 0.2 : 0.5 + v * 0.8);
      off += wave(u * W, v * H, t, amp) * freedom(u, v, true);

      out[k++] = mid.x + mid.rx * s + mid.ox * off;
      out[k++] = y;
      out[k++] = mid.z + mid.rz * s + mid.oz * off;
    }
  }
}

/**
 * Normals from the grid the surface just wrote.
 *
 * Cross products of the neighbours, which is exact for a smooth surface and
 * costs one pass. This was a source of noise when the mesh came out of a
 * solver; it is not one now, because the mesh is a smooth function and its
 * neighbours are smooth neighbours.
 */
export function buildNormals(pos: Float32Array, out: Float32Array): void {
  for (let j = 0; j < SURF_ROWS; j++) {
    for (let i = 0; i < SURF_COLS; i++) {
      const k = (j * SURF_COLS + i) * 3;
      const ia = i > 0 ? k - 3 : k;
      const ib = i < SURF_COLS - 1 ? k + 3 : k;
      const ja = j > 0 ? k - SURF_COLS * 3 : k;
      const jb = j < SURF_ROWS - 1 ? k + SURF_COLS * 3 : k;
      const ux = pos[ib] - pos[ia];
      const uy = pos[ib + 1] - pos[ia + 1];
      const uz = pos[ib + 2] - pos[ia + 2];
      const vx = pos[jb] - pos[ja];
      const vy = pos[jb + 1] - pos[ja + 1];
      const vz = pos[jb + 2] - pos[ja + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      // Rows run down the banner, so the cross product points into it.
      out[k] = -nx;
      out[k + 1] = -ny;
      out[k + 2] = -nz;
    }
  }
}

/** Triangle indices for the grid. Built once; the topology never changes. */
export function surfaceIndices(): Uint32Array {
  const idx = new Uint32Array((SURF_COLS - 1) * (SURF_ROWS - 1) * 6);
  let k = 0;
  for (let j = 0; j < SURF_ROWS - 1; j++) {
    for (let i = 0; i < SURF_COLS - 1; i++) {
      const a = j * SURF_COLS + i;
      const b = a + 1;
      const c = a + SURF_COLS;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  return idx;
}

/** UVs for the grid. Also built once. */
export function surfaceUVs(): Float32Array {
  const uv = new Float32Array(SURF_VERTS * 2);
  let k = 0;
  for (let j = 0; j < SURF_ROWS; j++) {
    for (let i = 0; i < SURF_COLS; i++) {
      uv[k++] = i / (SURF_COLS - 1);
      uv[k++] = 1 - j / (SURF_ROWS - 1);
    }
  }
  return uv;
}

/**
 * The furthest any vertex can ever be from the stand's surface, in metres.
 *
 * Stated rather than measured, because every term that moves a vertex is
 * bounded by a constant in this file. The test asserts the geometry agrees
 * with this number; if it ever does not, a term has grown a way to be
 * unbounded and that is the bug.
 */
export function maxOffsetM(wind: number): number {
  const amp = WAVE_STILL_M + wind * WAVE_WIND_M;
  // The crowd term at its worst (a level surface), plus the amplitude twice:
  // once to raise the base so the trough clears, once for the crest.
  return crowdSupportM(1) + SCALLOP_HANDS_M + 2 * amp + 0.05;
}
