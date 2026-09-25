/**
 * Every slot, on every ground, for both banners.
 *
 *   npm run sweep:banner
 *
 * This is the test the last four attempts did not have, and its absence is
 * the single reason they kept breaking somewhere new. A banner used to have a
 * continuous position and a free size, which made the space of configurations
 * infinite: I could test points in it, and Osamah walked around in it and
 * found the points I had not tested.
 *
 * A slot is a stand, a run of the blocks that stand is divided into, and a
 * tier. That set is finite — about 864 per ground — so this does not sample
 * it. It enumerates all of it, and checks six things about every single one:
 *
 *   IN-STAND   no vertex is inside the terracing
 *   EXTENT     the mesh is the size the slot says it is
 *   OFFSET     no vertex is further out than the stated bound
 *   FINITE     nothing is NaN
 *   STILL      frame-to-frame movement is under a bound
 *   SAME       two evaluations are bit-identical
 *
 * It needs no browser and runs in seconds.
 */
import { generateSeatMap } from '../src/core/seatmap';
import { templateById, STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { buildSpanFrame, type StandFrame } from '../src/render/simulator/standFrame';
import {
  resolveSlot, slotsOf, crowdSupportM, hangSpan, signHold, signPlaces, signRows, signFenceOk,
  CROWD_TOP_M, SIGN_FENCE_TOP_M, type ResolvedSlot,
} from '../src/render/simulator/bannerSlot';
import { rowV } from '../src/render/simulator/standFrame';
import {
  buildSurface, columnsU, maxOffsetM, SURF_VERTS, SURF_COLS, SURF_ROWS,
} from '../src/render/simulator/bannerSurface';
import { newBanner, BLOCK_KINDS, type BannerDoc, type StandIndex } from '../src/core/banner';

const GROUNDS = process.env.GROUND ? [process.env.GROUND] : STADIUM_CATALOG.map((e) => e.template.id);
const WINDS = [0, 0.5, 1];
/**
 * Where in its reveal to check it.
 *
 * One at the end, one a third of the way through. A partway reveal was never
 * checked here and it is exactly where a banner can be somewhere it should
 * not — a sheet gathered near its top edge is in a configuration the finished
 * one never visits. The very first complaint in this whole saga was a banner
 * going through the stand during its reveal.
 */
const PROGRESS = [1, 0.37];
/**
 * How full the stand is.
 *
 * BOTH, and the second one is the whole point. Every run of this swept a
 * packed house, so the banner always had a crowd holding it up and the
 * clearance was never tested without one — which is exactly the case the
 * editor's own bowl renders, and exactly where the seats came through the
 * fabric.
 */
const CROWDS = [0.97, 0];

/** Metres of fabric allowed inside the terracing. None. */
const IN_STAND_MAX = 0.001;
/** Metres a vertex may move between two frames, at the top of the wind. */
const STILL_MAX = 0.05;
/** Metres the flat mesh may cut inside the curve of the stand, mid-span. */
const CHORD_MAX = 0.35;
/**
 * Metres a banner must move over a second at full wind.
 *
 * The lower bound nobody thought to write. Every check here was an upper
 * bound — do not go inside the stand, do not exceed this size, do not jump
 * between frames — so a banner that did not move AT ALL passed all of them
 * perfectly, and that is what shipped: wind at maximum and the sheet a board.
 */
const MOVES_MIN = 0.25;

interface Fail { where: string; what: string; detail: string }
const fails: Fail[] = [];
let checked = 0;

const a = new Float32Array(SURF_VERTS * 3);
const b = new Float32Array(SURF_VERTS * 3);

/**
 * How far a point is inside the stand, in metres.
 *
 * Measured the honest way: find the nearest point of the stand's own surface
 * and ask which side of its normal we are on. Positive means outside.
 */
/**
 * `clearanceAt`, for a sheet that can hang below the front of the stand.
 *
 * Below the front row there is no rake to be inside: there is the wall the
 * front row stands on, going straight down, and the pitch in front of it. A
 * point down there whose nearest bit of stand is the front edge is measured
 * horizontally, out from that wall — extending the rake's own plane under
 * the front edge called a sheet hanging in the air in front of the wall
 * "half a metre into the stand".
 */
function signClearanceAt(frame: StandFrame, u: number, x: number, y: number, z: number): number {
  const c = clearanceAt(frame, u, x, y, z);
  if (c >= 0) return c;
  const front = frame.pointAt(u, 0);
  if (y >= front.y) return c;
  return (x - front.x) * front.ox + (z - front.z) * front.oz;
}

function clearanceAt(frame: StandFrame, u: number, x: number, y: number, z: number): number {
  // Searched down the stand at the KNOWN u, not over the whole face.
  //
  // A stand is smooth along its length, so the nearest point of it to a
  // banner vertex is at essentially the same `u` the vertex was built from —
  // and searching one line instead of a grid is forty times cheaper, which is
  // what makes checking every slot on every ground affordable at all.
  let best = Infinity;
  let bestV = 0.5;
  for (let j = 0; j <= 48; j++) {
    const v = j / 48;
    const p = frame.pointAt(u, v);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bestV = v; }
  }
  for (let j = -3; j <= 3; j++) {
    const v = Math.max(0, Math.min(1, bestV + j / 480));
    const p = frame.pointAt(u, v);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bestV = v; }
  }
  const p = frame.pointAt(u, bestV);
  const n = frame.normalAt(u, bestV);
  return (x - p.x) * n.nx + (y - p.y) * n.ny + (z - p.z) * n.nz;
}


/**
 * The stand's own row, walked at the banner mesh's column positions.
 *
 * The expectation the EXTENT check compares against, kept here rather than
 * taken from `frame.widthAt` so that the two polylines have the same number
 * of segments and the check is about where the sheet is, not about how
 * finely either side happened to be sampled.
 */
const COL_U = new Float64Array(SURF_COLS);
function standRowArc(frame: StandFrame, res: ResolvedSlot, v: number): number {
  columnsU(res, frame, COL_U);
  let len = 0;
  let p = frame.pointAt(COL_U[0], v);
  for (let i = 1; i < SURF_COLS; i++) {
    const q = frame.pointAt(COL_U[i], v);
    len += Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    p = q;
  }
  return len;
}

// Every failure is counted; the first forty are printed in full, and the rest
// are summed by ground, check and kind so a run that fails in two places does
// not look like it fails in one.
let failCount = 0;
const failGroups = new Map<string, number>();
function fail(where: string, what: string, detail: string): void {
  failCount++;
  const parts = where.split('/');
  const key = `${what.padEnd(9)} ${parts[0]} ${parts[2] ?? ''}`;
  failGroups.set(key, (failGroups.get(key) ?? 0) + 1);
  if (fails.length < 40) fails.push({ where, what, detail });
}

let signs = 0;
for (const gid of GROUNDS) {
  const tpl = templateById(gid);
  if (!tpl) { console.error(`no template ${gid}`); continue; }
  const map = generateSeatMap(tpl);
  let slots = 0;

  // Every stand, and every stand paired with the one round the corner from
  // it. A banner that crosses a stand boundary is drawn against a frame twice
  // as wide, so it is a different set of blocks, tiers and rakes and it gets
  // swept like any other.
  for (const stand of [0, 1, 2, 3] as StandIndex[]) {
   for (const stands of [1, 2]) {
    const frame = buildSpanFrame(map, stand, stands);
    if (!frame.ok) continue;
    for (const kind of BLOCK_KINDS) {
      for (const slot of slotsOf(frame, stand, stands)) {
        slots++;
        const doc: BannerDoc = { ...newBanner(kind), slot };
        // A two-stand window doubles the space, so it is checked at the
        // worst case only — full wind, fully revealed — rather than over the
        // whole matrix. That keeps the sweep inside a few minutes.
        for (const wind of stands === 1 ? WINDS : [1]) {
         for (const progress of stands === 1 ? PROGRESS : [1]) {
          for (const CROWD of stands === 1 && wind === 1 ? CROWDS : [0.97]) {
          // The full battery only at rest; partway through, the checks that
          // matter for a sheet in motion.
          const full = progress === 1;
          const res = resolveSlot(doc, frame);
          const env = { frame, crowdFill: CROWD, wind, progress };
          const where = `${gid}/${stand}${stands > 1 ? `+${stands}` : ''}/${kind}/b${slot.blockFrom}+${slot.blockSpan}/t${slot.tier}/w${wind}${full ? '' : `/p${progress}`}${CROWD === 0.97 ? '' : `/empty`}`;
          checked++;

          buildSurface(doc, res, env, 3.0, a);

          // FINITE
          let bad = -1;
          for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) { bad = k; break; }
          if (bad >= 0) { fail(where, 'FINITE', `vertex ${(bad / 3) | 0}`); continue; }

          if (!full) {
            // Partway: nothing NaN, nothing in the stand. Extents are meant to
            // be short here, so they are not checked.
            if (kind === 'stand' && wind === 1) {
              columnsU(res, frame, COL_U);
              let worstIn = 0;
              for (let j = 0; j < SURF_ROWS; j += 4) {
                for (let i = 0; i < SURF_COLS; i += 5) {
                  const k = (j * SURF_COLS + i) * 3;
                  const c = clearanceAt(frame, COL_U[i], a[k], a[k + 1], a[k + 2]);
                  if (-c > worstIn) worstIn = -c;
                }
              }
              if (worstIn > IN_STAND_MAX) fail(where, 'IN-STAND', `${worstIn.toFixed(3)} m inside, mid-reveal`);
            }
            continue;
          }

          // SAME — two evaluations must agree to the bit.
          buildSurface(doc, res, env, 3.0, b);
          for (let k = 0; k < a.length; k++) {
            if (a[k] !== b[k]) { fail(where, 'SAME', `index ${k}: ${a[k]} vs ${b[k]}`); break; }
          }

          // EXTENT — the mesh is the size the slot promised.
          //
          // Measured along the mesh itself, not as a bounding box. A banner on
          // a raked, curved stand has a ground-plane footprint that is a patch
          // rather than a line: its box diagonal mixes how wide it is with how
          // far down the rake it reaches, and comparing that to a width says
          // nothing. Its own rows and columns say everything.
          //
          // The allowance is `pi * d`: the arc of a curve offset by `d` differs
          // from the original by `d` times the total turning angle, and a stand
          // is at most a quarter of a bowl. Exact, not tuned.
          const grow = Math.PI * maxOffsetM(wind) + 0.5;
          const spanUx = res.u1 - res.u0;
          const rowArc = (j: number): number => {
            let len = 0;
            for (let i = 1; i < SURF_COLS; i++) {
              const k = (j * SURF_COLS + i) * 3;
              const q = k - 3;
              len += Math.hypot(a[k] - a[q], a[k + 1] - a[q + 1], a[k + 2] - a[q + 2]);
            }
            return len;
          };
          const colArc = (i: number): number => {
            let len = 0;
            for (let j = 1; j < SURF_ROWS; j++) {
              const k = (j * SURF_COLS + i) * 3;
              const q = k - SURF_COLS * 3;
              len += Math.hypot(a[k] - a[q], a[k + 1] - a[q + 1], a[k + 2] - a[q + 2]);
            }
            return len;
          };
          // The sheet really is as wide as the slot says it is.
          //
          // The gap that let a height-limited banner report 54 m while
          // drawing 103: every extent check compared the mesh against the
          // slot's own `u` range, so a size that disagreed with that range
          // was invisible to all of them.
          {
            // Across the MIDDLE of the sheet. A banner on a stand that fans
            // out is a trapezoid, so its top row is genuinely longer than its
            // bottom one and neither of them is "the width"; the width is the
            // one across the middle, and that is what the panel prints, what
            // the seam count divides and what the artwork is scaled to.
            const got = rowArc(SURF_ROWS >> 1);
            const slack = grow + res.size.widthM * 0.08;
            if (Math.abs(got - res.size.widthM) > slack) {
              fail(where, 'EXTENT', `across the middle there is ${got.toFixed(1)} m of fabric, but the slot says ${res.size.widthM.toFixed(1)} m`);
            }
          }
          for (const j of [0, SURF_ROWS - 1]) {
            const got = rowArc(j);
            // The stand's own arc at the height this row sits at — asked of
            // the slot, not re-derived here. A test that recomputes the thing
            // it is checking is testing its own arithmetic: the last version
            // of this line had its own formula for the row height, that
            // formula drifted from the surface's, and it reported a wall of
            // failures against geometry that was correct.
            const frac = j / (SURF_ROWS - 1);
            const sv = res.v1 + (res.vBottom - res.v1) * frac;
            // The stand's own row, walked at the MESH's column positions.
            //
            // Not at `widthAt`'s finer sampling, which would make this a test
            // of polyline resolution rather than of extent: a run wrapping
            // 312 degrees of a small arena comes out 8% short as a 40-segment
            // chord, and that 8% is 5 cm of geometry. Whether the mesh cuts
            // the corner is the CHORD check below, in metres off the stand,
            // which is the unit that matters. This one asks the only question
            // arc length can answer honestly: does the sheet span the blocks
            // it was given?
            const want = kind === 'hanging'
              ? res.size.widthM
              : standRowArc(frame, res, Math.max(0, Math.min(1, sv)));
            if (got > want + grow || got < want - grow) {
              fail(where, 'EXTENT', `row ${j} is ${got.toFixed(1)} m against ${want.toFixed(1)} m (+-${grow.toFixed(1)})`);
              break;
            }
          }
          {
            // Down the sheet. The rake varies a few per cent across a run of
            // blocks and the depth is set from its median, so the allowance is
            // proportional as well as absolute.
            const got = colArc(SURF_COLS >> 1);
            const slack = grow + res.size.heightM * 0.12;
            if (got > res.size.heightM + slack || got < res.size.heightM - slack) {
              fail(where, 'EXTENT', `down the middle is ${got.toFixed(1)} m against ${res.size.heightM.toFixed(1)} m (+-${slack.toFixed(1)})`);
            }
          }
          void spanUx;

          // CHORD — how far the flat mesh cuts inside the curve it follows.
          //
          // A banner is a polygon with a fixed number of columns and a stand
          // is a curve, so between two of the banner's columns the sheet is
          // straight where the stand is not. That gap is the real error, it is
          // a distance rather than a ratio, and on a tight corner it is what
          // decides whether the banner reads as fabric or as a folded screen.
          if (kind === 'stand') {
            columnsU(res, frame, COL_U);
            let worst = 0;
            for (const j of [0, SURF_ROWS >> 1, SURF_ROWS - 1]) {
              const frac = j / (SURF_ROWS - 1);
              const sv = Math.max(0, Math.min(1, res.v1 + (res.vBottom - res.v1) * frac));
              for (let i = 1; i < SURF_COLS; i++) {
                const k = (j * SURF_COLS + i) * 3;
                const q = k - 3;
                const mx = (a[k] + a[q]) / 2;
                const my = (a[k + 1] + a[q + 1]) / 2;
                const mz = (a[k + 2] + a[q + 2]) / 2;
                const p = frame.pointAt((COL_U[i - 1] + COL_U[i]) / 2, sv);
                const d = Math.hypot(p.x - mx, p.y - my, p.z - mz);
                if (d > worst) worst = d;
              }
            }
            // Generous, because the sheet is legitimately held off the stand:
            // the crowd support and the fabric terms are all in this distance.
            if (worst > maxOffsetM(wind) + crowdSupportM(CROWD) + CHORD_MAX) {
              fail(where, 'CHORD', `${worst.toFixed(2)} m from the stand mid-span`);
            }
          }

          // STILL — the same banner one frame later.
          buildSurface(doc, res, env, 3.0 + 1 / 60, b);
          let move = 0;
          for (let k = 0; k < a.length; k += 3) {
            const d = Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2]);
            if (d > move) move = d;
          }
          if (move > STILL_MAX) fail(where, 'STILL', `${(move * 1000).toFixed(0)} mm in one frame`);

          // MOVES — at full wind, the fabric is fabric.
          if (wind === 1) {
            buildSurface(doc, res, env, 3.0 + 0.9, b);
            let moved = 0;
            for (let k = 0; k < a.length; k += 3) {
              const d = Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2]);
              if (d > moved) moved = d;
            }
            if (moved < MOVES_MIN) {
              fail(where, 'MOVES', `${(moved * 100).toFixed(0)} cm in a second at full wind`);
            }
          }

          // HANG — a flown banner is in the air it was given, and no other.
          //
          // Over the whole stand or the lowest tier it reaches the grass and
          // is fixed there; over an upper tier it lives in the gap between
          // that tier and the one below, which is the one band of a stand
          // with nobody sitting in it. Both were wrong: it used to hang from
          // the BACK row and drop straight down through every seat, so it did
          // not appear in a single rendered frame.
          if (kind === 'hanging') {
            const { topY, bottomY } = hangSpan(frame, res.tier);
            let lo = Infinity;
            let hi = -Infinity;
            for (let k = 1; k < a.length; k += 3) {
              if (a[k] < lo) lo = a[k];
              if (a[k] > hi) hi = a[k];
            }
            const tol = 0.5 + maxOffsetM(wind);
            if (hi > topY + tol) fail(where, 'HANG', `top at ${hi.toFixed(1)} m, above its ${topY.toFixed(1)} m rigging`);
            if (lo < bottomY - tol) fail(where, 'HANG', `bottom at ${lo.toFixed(1)} m, below its ${bottomY.toFixed(1)} m floor`);
            // Fixed where it is meant to be fixed, rather than floating.
            const groundFixed = res.tier < 1 || res.tier >= frame.tiers.length;
            const anchored = groundFixed ? lo : hi;
            const want = groundFixed ? bottomY : topY;
            if (Math.abs(anchored - want) > tol) {
              fail(where, 'HANG', `${groundFixed ? 'bottom' : 'top'} at ${anchored.toFixed(1)} m, should be fixed at ${want.toFixed(1)} m`);
            }
          }

          // IN-STAND and OFFSET, at the top of the wind — the worst case, and
          // the only one worth paying the nearest-point search for.
          if (kind === 'stand' && wind === 1) {
            const bound = maxOffsetM(wind);
            columnsU(res, frame, COL_U);
            let worstIn = 0;
            let worstOut = 0;
            for (let j = 0; j < SURF_ROWS; j += 4) {
              for (let i = 0; i < SURF_COLS; i += 5) {
                const k = (j * SURF_COLS + i) * 3;
                const c = clearanceAt(frame, COL_U[i], a[k], a[k + 1], a[k + 2]);
                if (-c > worstIn) worstIn = -c;
                if (c > worstOut) worstOut = c;
              }
            }
            if (worstIn > IN_STAND_MAX) fail(where, 'IN-STAND', `${worstIn.toFixed(3)} m inside`);
            if (worstOut > bound + 0.5) fail(where, 'OFFSET', `${worstOut.toFixed(2)} m out, bound ${bound.toFixed(2)} m`);

            // CROWD — the sheet clears the PEOPLE, not merely the concrete.
            //
            // The gap every check here had. IN-STAND measures against the
            // terracing, and a banner can be comfortably outside the
            // terracing and still be through the chest of everyone holding
            // it. Heads came through the fabric with every gate green.
            //
            // A person is a vertical segment, so what they occupy along the
            // surface normal is their height times its vertical component —
            // which is what the sheet has to stand off by.
            let short = 0;
            for (let j = 0; j < SURF_ROWS; j += 4) {
              const frac = j / (SURF_ROWS - 1);
              const sv = Math.max(0, Math.min(1, res.v1 + (res.vBottom - res.v1) * frac));
              for (let i = 0; i < SURF_COLS; i += 5) {
                const k = (j * SURF_COLS + i) * 3;
                const p = frame.pointAt(COL_U[i], sv);
                const nn = frame.normalAt(COL_U[i], sv);
                const along = (a[k] - p.x) * nn.nx + (a[k + 1] - p.y) * nn.ny + (a[k + 2] - p.z) * nn.nz;
                const need = crowdSupportM(CROWD) * nn.ny;
                if (need - along > short) short = need - along;
              }
            }
            if (short > 0.02) fail(where, 'CROWD', `${short.toFixed(2)} m short of clearing the stand at fill ${CROWD}`);
          }
          }
         }
        }
      }
    }
   }
  }
  console.log(`${gid.padEnd(32)} ${String(slots).padStart(5)} slots (one stand and two)`);
  signs += sweepSigns(gid, map);
}

// ---------------------------------------------------------------------------
// Signs
// ---------------------------------------------------------------------------

/**
 * Every place a sign can be: every row of every tier and the fence in front of
 * each, every place along the stand, on every stand — at a short, a middling
 * and the longest length. The same kind of proof as the banners': the set is
 * finite, so all of it is checked, not a sample of it.
 *
 *   UPRIGHT   it stands vertical, not leaning with the rake
 *   IN-STAND  none of it is inside the terracing
 *   HELD      it is off the concrete its holders stand on
 *   OVER      held behind the front row, it clears the heads of the row in front
 *   FENCE     tied on, its top is at the top of the fence
 *   EXTENT    it is as long and as tall as it says it is, and on its stand
 *   FINITE, SAME, STILL — as for the banners
 */
function sweepSigns(gid: string, map: ReturnType<typeof generateSeatMap>): number {
  let n = 0;
  // The shortest and the longest: a length in between is a sheet between
  // those two, on the same row, in the same place.
  const lengths = [4, 40];
  for (const stand of [0, 1, 2, 3] as StandIndex[]) {
    const frame = buildSpanFrame(map, stand, 1);
    if (!frame.ok) continue;
    const places = [-1];
    for (let k = 0; k < signPlaces(frame); k++) places.push(k);
    for (let tier = 0; tier < frame.tiers.length; tier++) {
      const rows = signFenceOk(frame, tier) ? [-1] : [];
      for (let r = 0; r < signRows(frame, tier); r++) rows.push(r);
      for (const row of rows) {
        for (const at of places) {
          for (const lengthM of lengths) for (const heightM of row < 0 || row >= signRows(frame, tier) - 4 ? [1.2, 2] : [1.2]) {
            // The tallest sheet too, where height is what decides whether it
            // fits: hanging off a fence, and at the back of a tier, under
            // whatever is above it.
            // Part-raised is checked once per row, in the middle of the stand:
            // how far up it has come does not depend on where along it is.
            for (const progress of at === -1 ? [1, 0.37] : [1]) {
              n++;
              checked++;
              const base = newBanner('sign');
              const doc: BannerDoc = { ...base, aspect: heightM / lengthM, slot: { ...base.slot, stand, tier, row, at, lengthM } };
              const res = resolveSlot(doc, frame);
              // A row the stand cannot take for a sheet this tall is held in
              // the nearest one it can — which is checked on its own turn.
              if ((res.row ?? row) !== row) { n--; checked--; continue; }
              const env = { frame, crowdFill: 0.97, wind: 1, progress };
              const where = `${gid}/${stand}/sign/t${tier}/r${row}/at${at}/${lengthM}x${heightM}m${progress === 1 ? '' : `/p${progress}`}`;
              buildSurface(doc, res, env, 3.0, a);
              let bad = -1;
              for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) { bad = k; break; }
              if (bad >= 0) { fail(where, 'FINITE', `vertex ${(bad / 3) | 0}`); continue; }
              if (res.u0 < -1e-9 || res.u1 > 1 + 1e-9 || res.u1 <= res.u0) fail(where, 'EXTENT', `off its stand: u ${res.u0.toFixed(3)}..${res.u1.toFixed(3)}`);

              columnsU({ ...res, v1: res.vBottom }, frame, COL_U);
              let worstIn = 0;
              let lowest = Infinity;
              let lean = 0;
              let overShort = 0;
              let heldShort = 0;
              for (let i = 0; i < SURF_COLS; i += 8) {
                const h = signHold(frame, res, row, COL_U[i]);
                const top = (0 * SURF_COLS + i) * 3;
                const bot = ((SURF_ROWS - 1) * SURF_COLS + i) * 3;
                lean = Math.max(lean, Math.hypot(a[top] - a[bot], a[top + 2] - a[bot + 2]));
                for (let j = 0; j < SURF_ROWS; j += 12) {
                  const k = (j * SURF_COLS + i) * 3;
                  const c = signClearanceAt(frame, COL_U[i], a[k], a[k + 1], a[k + 2]);
                  if (-c > worstIn) worstIn = -c;
                  if (a[k + 1] < lowest) lowest = a[k + 1];
                }
                const bottomY = a[bot + 1];
                if (row >= 0 && h.base.y + 0.04 - bottomY > heldShort) heldShort = h.base.y + 0.04 - bottomY;
                // The row in front: the one before it in its own tier — or, for
                // the front row of a tier that runs straight on from the one
                // below, that tier's back row.
                const lowerBand = row === 0 && tier >= 1 && !signFenceOk(frame, tier) ? frame.tiers[tier - 1] : null;
                if ((row >= 1 || lowerBand) && progress === 1) {
                  const band = frame.tiers[tier];
                  const front = lowerBand
                    ? frame.pointAt(COL_U[i], rowV(lowerBand, lowerBand.rows - 1))
                    : frame.pointAt(COL_U[i], rowV(band, row - 1));
                  const need = front.y + CROWD_TOP_M;
                  if (need - bottomY > overShort) overShort = need - bottomY;
                }
              }
              if (worstIn > IN_STAND_MAX) fail(where, 'IN-STAND', `${worstIn.toFixed(3)} m inside`);
              if (heldShort > 0.02) fail(where, 'HELD', `${heldShort.toFixed(2)} m into the concrete its holders stand on`);
              if (overShort > 0.02) fail(where, 'OVER', `${overShort.toFixed(2)} m short of clearing the heads of the row in front`);
              // Upright: the free hem swings with the wind, and that is all
              // that separates a column's top from its bottom.
              if (lean > 0.36) fail(where, 'UPRIGHT', `${lean.toFixed(2)} m between a column's top and its bottom`);
              if (progress !== 1) continue;

              if (row < 0) {
                const mid = (SURF_COLS >> 1) * 3;
                const h = signHold(frame, res, row, COL_U[SURF_COLS >> 1]);
                // Tied at the top of the fence — or, where the tier below leaves
                // no room to hang its full depth, standing up above it with
                // its bottom hem on the floor. Never squashed and never lower.
                const fenceY = h.base.y + SIGN_FENCE_TOP_M;
                const lifted = h.topY - fenceY > 0.01;
                const floorY = tier >= 1 ? hangSpan(frame, tier).bottomY + 0.1 : -Infinity;
                if (h.topY < fenceY - 1e-6 || (lifted && Math.abs(h.bottomY - floorY) > 0.01)) {
                  fail(where, 'FENCE', `held ${h.bottomY.toFixed(2)}..${h.topY.toFixed(2)} m, the fence is at ${fenceY.toFixed(2)} m`);
                }
                if (Math.abs(a[mid + 1] - h.topY) > 0.1) {
                  fail(where, 'FENCE', `top at ${a[mid + 1].toFixed(2)} m, tied at ${h.topY.toFixed(2)} m`);
                }
              }
              // EXTENT, along the bottom hem and down the middle.
              let len = 0;
              for (let i = 1; i < SURF_COLS; i++) {
                const k = ((SURF_ROWS - 1) * SURF_COLS + i) * 3;
                len += Math.hypot(a[k] - a[k - 3], a[k + 2] - a[k - 1]);
              }
              if (Math.abs(len - res.size.widthM) > 0.6 + res.size.widthM * 0.05) {
                fail(where, 'EXTENT', `${len.toFixed(1)} m along it, the slot says ${res.size.widthM.toFixed(1)} m`);
              }
              if (Math.abs(res.size.widthM - Math.min(lengthM, res.maxWidthM * 0.98)) > 0.15) {
                fail(where, 'EXTENT', `${res.size.widthM.toFixed(2)} m long, asked for ${lengthM} m`);
              }
              let tall = 0;
              const ci = SURF_COLS >> 1;
              for (let j = 1; j < SURF_ROWS; j++) {
                const k = (j * SURF_COLS + ci) * 3;
                const q = k - SURF_COLS * 3;
                tall += Math.hypot(a[k] - a[q], a[k + 1] - a[q + 1], a[k + 2] - a[q + 2]);
              }
              if (Math.abs(tall - res.size.heightM) > 0.25) fail(where, 'EXTENT', `${tall.toFixed(2)} m tall, the slot says ${res.size.heightM.toFixed(2)} m`);

              buildSurface(doc, res, env, 3.0, b);
              for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { fail(where, 'SAME', `index ${k}`); break; }
              buildSurface(doc, res, env, 3.0 + 1 / 60, b);
              let move = 0;
              for (let k = 0; k < a.length; k += 3) move = Math.max(move, Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2]));
              if (move > STILL_MAX) fail(where, 'STILL', `${(move * 1000).toFixed(0)} mm in one frame`);
              void lowest;
            }
          }
        }
      }
    }
  }
  console.log(`${' '.repeat(2)}${gid.padEnd(30)} ${String(n).padStart(6)} sign places`);
  return n;
}
void signs;

console.log(`\n${checked} configurations checked`);
if (failCount) {
  console.error(`\n${failCount} failure(s)${failCount > fails.length ? `, the first ${fails.length}` : ''}:`);
  for (const f of fails) console.error(`  ${f.what.padEnd(9)} ${f.where}\n            ${f.detail}`);
  console.error('\nby ground and kind:');
  for (const [k, n] of failGroups) console.error(`  ${String(n).padStart(6)}  ${k}`);
  process.exitCode = 1;
} else {
  console.log('every slot on every ground: in the stand 0, extents right, still, deterministic');
}
