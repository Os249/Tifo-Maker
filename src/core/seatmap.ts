import type { SeatMap, StadiumTemplate } from './types';
import { inLane, laneLines } from './venueDetails';
import { inGap, inStands } from './standSpans';
import { CURVE_SAMPLES, buildOffsetCurve, offsetLength, pointAt, pointOnOffset, samplePlanCurve, type Curve } from './planCurve';
import { arcAtIndex, compileBlocks, hasBlocks, indexAtArc, walkCovers, widestAisle, type BlockLine, type WalkLine } from './blocks';

/**
 * Deterministic seat-map generation.
 *
 * Pipeline per tier, per row:
 *   1. Offset the superellipse plan curve outward by the row's radial distance.
 *   2. Elevate by base elevation + k·rowDepth·tan(rake).
 *   3. Walk the offset curve emitting one seat per `seatPitch` metres of arc.
 *   4. Drop seats falling inside aisle bands (fixed perimeter fractions).
 *   5. Assign sections by bucketing u; compute editor xy and normalized uv.
 *   6. Precompute 4-neighbors (left/right in row, nearest-u in adjacent rows).
 *
 * No randomness anywhere: same template version ⇒ byte-identical output.
 */

const EDITOR_WIDTH = 4000; // editor units across the full unrolled perimeter
const ROW_PX = 8; // editor units per row
const TIER_GAP_PX = 24; // walkway gap between tiers in the editor view

/** A point on a straight stand's row line (TierSpec.straight): `radial` out from the plan's side, `along` it. */
export function straightPoint(template: StadiumTemplate, side: string, radial: number, along: number): [number, number] {
  const { a, b } = template.plan;
  if (side === 'north') return [along, b + radial];
  if (side === 'south') return [along, -(b + radial)];
  if (side === 'east') return [a + radial, along];
  return [-(a + radial), along];
}

/** Perimeter fraction u of the plan-curve point nearest (x, z). */
function uOnCurve(curve: Curve, template: StadiumTemplate, x: number, z: number): number {
  const { a, b, exponent: p } = template.plan;
  const n = CURVE_SAMPLES;
  // Start from the superellipse parameter whose point points the same way.
  const h = p / 2;
  const t0 = Math.atan2(Math.sign(z) * Math.abs(z / b) ** h, Math.sign(x) * Math.abs(x / a) ** h);
  const i0 = Math.round((((t0 / (Math.PI * 2)) % 1) + 1) % 1 * n);
  let best = i0;
  let bd = Infinity;
  for (let d = -160; d <= 160; d++) {
    const i = (((i0 + d) % n) + n) % n;
    const dd = (curve.px[i] - x) ** 2 + (curve.py[i] - z) ** 2;
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  // The samples are even in the superellipse's angle, not in arc length — on
  // a near-rectangular plan two of them can be 20 m apart along a side — so
  // project onto the segment either side of the nearest and interpolate.
  let bu = curve.s[best];
  let bdd = Infinity;
  for (const [i0, i1] of [[(best - 1 + n) % n, best], [best, (best + 1) % n]]) {
    const ax = curve.px[i0];
    const az = curve.py[i0];
    const ex = curve.px[i1] - ax;
    const ez = curve.py[i1] - az;
    const L2 = ex * ex + ez * ez || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
    const dd = (ax + ex * t - x) ** 2 + (az + ez * t - z) ** 2;
    if (dd < bdd) {
      bdd = dd;
      const s0 = curve.s[i0];
      const s1 = i1 === 0 ? curve.total : curve.s[i1];
      bu = s0 + (s1 - s0) * t;
    }
  }
  return (bu % curve.total) / curve.total;
}

/**
 * The template as the seat map sees it: without its tiers still being built.
 * Those must be the last tiers, so a seat's tier index means the same in both.
 */
export function seatedTemplate(template: StadiumTemplate): StadiumTemplate {
  const n = template.tiers.findIndex((t) => t.building);
  if (n < 0) return template;
  if (template.tiers.slice(n).some((t) => !t.building)) throw new Error(`${template.id}: a tier still being built must come after every seated tier`);
  return { ...template, tiers: template.tiers.slice(0, n) };
}

/**
 * Number a real layout's blocks (TierSpec.blocks) into `sections`, in place.
 *
 * A block is the seats with the same key — tier, band and the stairway on
 * their left — that are also together round the bowl: where a tier stops
 * (the open side of a horseshoe, the main stand an upper tier does not run
 * over) the seats either side are two blocks, even with the same stairway on
 * their left. Numbered tier by tier, band by band, in perimeter order from
 * u = 0; the block astride the seam at u = 0 starts last.
 */
function numberBlocks(keys: string[], us: number[], tiers: number[], sections: number[]): void {
  /** More than this much of the perimeter with none of a block's seats is two blocks. */
  const SPLIT_U = 0.05;
  const byKey = new Map<string, number[]>();
  keys.forEach((k, i) => (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(i));
  const pieces: { seats: number[]; tier: number; band: number; start: number }[] = [];
  for (const [k, seats] of byKey) {
    const band = Number(k.split(':')[1]);
    const sorted = [...new Set(seats.map((i) => us[i]))].sort((p, q) => p - q);
    // Gaps round the circle, including the one across u = 0.
    const cuts: number[] = [];
    for (let j = 0; j < sorted.length; j++) {
      const next = j + 1 < sorted.length ? sorted[j + 1] : sorted[0] + 1;
      if (next - sorted[j] > SPLIT_U) cuts.push(next % 1);
    }
    if (cuts.length <= 1) {
      // One piece: it starts after its one gap (or at its first seat, if it is a full ring).
      const start = cuts.length ? cuts[0] : sorted[0];
      pieces.push({ seats, tier: tiers[seats[0]], band, start });
      continue;
    }
    cuts.sort((p, q) => p - q);
    const pieceOf = (u: number): number => {
      // The last cut at or before u, circularly.
      let c = cuts.length - 1;
      for (let j = 0; j < cuts.length; j++) if (cuts[j] <= u) c = j;
      return c;
    };
    const split = new Map<number, number[]>();
    for (const i of seats) {
      const c = pieceOf(us[i]);
      (split.get(c) ?? split.set(c, []).get(c)!).push(i);
    }
    for (const [c, list] of split) pieces.push({ seats: list, tier: tiers[list[0]], band, start: cuts[c] });
  }
  pieces.sort((p, q) => p.tier - q.tier || p.band - q.band || p.start - q.start);
  pieces.forEach((pc, id) => {
    for (const i of pc.seats) sections[i] = id;
  });
}

export function generateSeatMap(full: StadiumTemplate): SeatMap {
  // Tiers still being built (TierSpec.building) have their concrete but no
  // seats. They come after every seated tier, so dropping them here leaves
  // every other tier's index — and every other template's map — as it was.
  const template = seatedTemplate(full);
  const curve = samplePlanCurve(template.plan.a, template.plan.b, template.plan.exponent);
  const cornerCut = template.cornerCut ?? 0;
  const evenRows = template.evenRows === true;
  // Empty for every template without vehicle lanes, so their maps are untouched.
  const lanes = laneLines(template);
  // Real block layouts (TierSpec.blocks). Null for every tier of every
  // template without one, which then runs exactly the code it always has.
  const blocks = compileBlocks(template, curve);
  const anyBlocks = hasBlocks(template);
  /**
   * With blocks, a seat's section is its block, keyed here and numbered once
   * every seat is placed: tier, band (how many walkways are in front of it)
   * and the stairway on its left. `numberBlocks` splits any key whose seats
   * fall in two pieces and numbers the blocks round the bowl.
   */
  const blockKeys: string[] = [];

  // Aisle bands as [uStart, uEnd) fractions; computed per row since row length varies,
  // but anchored at fixed u positions so aisles are radial.
  const aisleU: number[] = [];
  for (let i = 0; i < template.aisles.count; i++) aisleU.push(i / template.aisles.count);

  // First pass: emit seats row by row.
  const xs: number[] = [];
  const ys: number[] = [];
  const us: number[] = [];
  const vs: number[] = [];
  const wxs: number[] = [];
  const wys: number[] = [];
  const wzs: number[] = [];
  const tiers: number[] = [];
  const rows: number[] = [];
  const sections: number[] = [];
  /** rowStart[globalRow] = first seat index of that row (rows are contiguous). */
  const rowStart: number[] = [];

  const totalRowsBefore: number[] = [];
  let acc = 0;
  for (const t of template.tiers) {
    totalRowsBefore.push(acc);
    acc += t.rows;
  }
  const totalRows = acc;

  template.tiers.forEach((tier, tierIdx) => {
    const rake = Math.tan((tier.rakeDeg * Math.PI) / 180);
    if (tier.straight && tier.stands) {
      // Straight stands (TierSpec.straight): each row of each stand is a line
      // square to the pitch, its seats evenly spaced along it. A seat's u is
      // where it projects onto the plan curve, so sections, aisles, the
      // editor's unrolled view and the mirror all work as on any other tier.
      for (let r = 0; r < tier.rows; r++) {
        const globalRow = totalRowsBefore[tierIdx] + r;
        rowStart[globalRow] = xs.length;
        const editorY =
          (totalRows - 1 - globalRow) * ROW_PX + (tierIdx === 0 ? TIER_GAP_PX * (template.tiers.length - 1) : 0);
        const row: { u: number; x: number; z: number; y: number }[] = [];
        for (const st of tier.stands) {
          if (r >= (st.rows ?? tier.rows)) continue;
          const radial = tier.baseOffset + (st.offset ?? 0) + r * tier.rowDepth;
          const y = tier.baseElevation + (st.elevation ?? 0) + r * tier.rowDepth * rake;
          const H = st.halfLength;
          const C = st.center ?? 0;
          let n = Math.floor((2 * H) / tier.seatPitch);
          if (n % 2 === 1) n--;
          for (let k = 0; k < n; k++) {
            const along = C - H + ((k + 0.5) * 2 * H) / n;
            const [x, z] = straightPoint(template, st.side, radial, along);
            row.push({ u: uOnCurve(curve, template, x, z), x, z, y });
          }
        }
        row.sort((p, q) => p.u - q.u);
        const rowLen = row.length * tier.seatPitch || 1;
        const aisleHalfU = template.aisles.widthMeters / 2 / Math.max(rowLen, curve.total);
        for (const q of row) {
          let inAisle = false;
          for (const au of aisleU) {
            let du = Math.abs(q.u - au);
            if (du > 0.5) du = 1 - du;
            if (du < aisleHalfU) {
              inAisle = true;
              break;
            }
          }
          if (inAisle) continue;
          xs.push(q.u * EDITOR_WIDTH);
          ys.push(editorY);
          us.push(q.u);
          vs.push(globalRow / (totalRows - 1));
          wxs.push(q.x);
          wys.push(q.y);
          wzs.push(q.z);
          tiers.push(tierIdx);
          rows.push(globalRow);
          sections.push(
            Math.min(template.sectionsPerTier - 1, Math.floor(q.u * template.sectionsPerTier)) + tierIdx * template.sectionsPerTier,
          );
        }
      }
      return;
    }
    for (let r = 0; r < tier.rows; r++) {
      const globalRow = totalRowsBefore[tierIdx] + r;
      rowStart[globalRow] = xs.length;
      const radial = tier.baseOffset + r * tier.rowDepth;
      const elevation = tier.baseElevation + r * tier.rowDepth * rake;
      // Even-spacing mode measures the row on the curve the seats actually sit on.
      const oc = evenRows ? buildOffsetCurve(curve, radial) : null;
      const rowLen = oc ? oc.total : offsetLength(curve, radial);
      // Even seat count per row: the reflection u → 0.5 − u then maps each row's
      // seat set exactly onto itself, making the mirror map an exact involution.
      let nSeats = Math.floor(rowLen / tier.seatPitch);
      if (nSeats % 2 === 1) nSeats--;
      const aisleHalfU = template.aisles.widthMeters / 2 / rowLen;
      const editorY =
        (totalRows - 1 - globalRow) * ROW_PX + (tierIdx === 0 ? TIER_GAP_PX * (template.tiers.length - 1) : 0);
      // This row's stairways and openings, where they cross it (metres along it).
      const cb = blocks[tierIdx];
      let stairs: BlockLine[] = [];
      let stairArc: number[] = [];
      let holes: { arc: number; halfW: number }[] = [];
      let walkHere = false;
      let walkPartial: WalkLine[] = [];
      let walksBehind: WalkLine[] = [];
      if (cb && oc) {
        stairs = cb.aisles.filter((l) => r >= l.r0 && r <= l.r1);
        stairArc = stairs.map((l) => arcAtIndex(oc, l.idx));
        holes = cb.openings.filter((l) => r >= l.r0 && r <= l.r1).map((l) => ({ arc: arcAtIndex(oc, l.idx), halfW: l.halfW }));
        const here = cb.walkways.filter((w) => w.row === r);
        walkHere = here.some((w) => w.i0 === undefined);
        walkPartial = here.filter((w) => w.i0 !== undefined);
        walksBehind = cb.walkways.filter((w) => w.row < r);
      }

      for (let k = 0; k < nSeats; k++) {
        const u = (k + 0.5) / nSeats;
        let blockKey = '';
        if (cb && oc) {
          // A real tier: its own stairways, walkways and openings, in metres
          // along this row, instead of the template's even aisle fractions.
          if (walkHere) break;
          const arc = u * oc.total;
          const near = (at: number, halfW: number): boolean => {
            let d = Math.abs(arc - at);
            if (d > oc.total / 2) d = oc.total - d;
            return d < halfW;
          };
          // Stairways crossing the row, nearest first: binary search, then the neighbours either side.
          let lo = 0;
          let hi = stairArc.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (stairArc[mid] < arc) lo = mid + 1;
            else hi = mid;
          }
          const A = stairArc.length;
          if (A > 0 && (near(stairArc[lo % A], stairs[lo % A].halfW) || near(stairArc[(lo - 1 + A) % A], stairs[(lo - 1 + A) % A].halfW))) continue;
          if (holes.some((h) => near(h.arc, h.halfW))) continue;
          let idx = -1;
          if (walkPartial.length > 0 || walksBehind.some((w) => w.i0 !== undefined)) idx = indexAtArc(oc, arc);
          if (walkPartial.some((w) => walkCovers(w, idx))) continue;
          const band = walksBehind.filter((w) => w.i0 === undefined || walkCovers(w, idx)).length;
          const left = A > 0 ? stairs[(lo - 1 + A) % A] : null;
          blockKey = `${tierIdx}:${band}:${left ? left.id : -1}`;
        } else {
          // Skip seats inside any radial aisle band.
          let inAisle = false;
          for (const au of aisleU) {
            let du = Math.abs(u - au);
            if (du > 0.5) du = 1 - du;
            if (du < aisleHalfU) {
              inAisle = true;
              break;
            }
          }
          if (inAisle) continue;
        }

        const [wx, wy] = oc ? pointOnOffset(oc, u) : pointAt(curve, u, radial);
        // Box-arena corner cut: drop seats where BOTH plan axes are near their
        // extent (the rounded corners), leaving four straight stands with open
        // corners. Normalise by the row's outer extent so the notch is radial.
        if (cornerCut > 0) {
          const nxp = Math.abs(wx) / (template.plan.a + radial);
          const nyp = Math.abs(wy) / (template.plan.b + radial);
          if (nxp > cornerCut && nyp > cornerCut) continue;
        }
        // A tier that is only some stands (TierSpec.stands) has no seats elsewhere.
        if (tier.stands && !inStands(tier, template.plan, r, radial, wx, wy)) continue;
        // A ring tier with gaps (TierSpec.omit) has no seats in them.
        if (tier.omit && inGap(tier, template.plan, r, radial, wx, wy)) continue;
        // A vehicle lane is a real gap: the ramp is where these seats would be.
        if (lanes.length > 0 && inLane(lanes, tierIdx, wx, wy, r)) continue;
        xs.push(u * EDITOR_WIDTH);
        ys.push(editorY);
        us.push(u);
        vs.push(globalRow / (totalRows - 1));
        wxs.push(wx);
        wys.push(elevation);
        wzs.push(wy);
        tiers.push(tierIdx);
        rows.push(globalRow);
        sections.push(
          Math.min(template.sectionsPerTier - 1, Math.floor(u * template.sectionsPerTier)) +
            tierIdx * template.sectionsPerTier,
        );
        if (anyBlocks) {
          // A tier without blocks in a template with some keeps its even slices, numbered in with the rest.
          if (!blockKey) blockKey = `${tierIdx}:0:s${Math.min(template.sectionsPerTier - 1, Math.floor(u * template.sectionsPerTier))}`;
          blockKeys.push(blockKey);
        }
      }
    }
  });
  rowStart[totalRows] = xs.length;
  if (anyBlocks) {
    if (blockKeys.length !== xs.length) throw new Error(`${template.id}: blocks need every tier to be a ring tier`);
    numberBlocks(blockKeys, us, tiers, sections);
  }

  const count = xs.length;
  const xy = new Float32Array(count * 2);
  const uv = new Float32Array(count * 2);
  const pos3 = new Float32Array(count * 3);
  const tierOf = new Uint8Array(count);
  const rowOf = new Uint16Array(count);
  const sectionOf = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    xy[i * 2] = xs[i];
    xy[i * 2 + 1] = ys[i];
    uv[i * 2] = us[i];
    uv[i * 2 + 1] = vs[i];
    pos3[i * 3] = wxs[i];
    pos3[i * 3 + 1] = wys[i];
    pos3[i * 3 + 2] = wzs[i];
    tierOf[i] = tiers[i];
    rowOf[i] = rows[i];
    sectionOf[i] = sections[i];
  }

  // Second pass: neighbors. Rows are emitted in ascending-u order, so within a row
  // left/right are index ±1. Adjacency tolerance is wide enough to BRIDGE aisles:
  // a color region visually continues across an aisle, so global fill must cross it
  // (section-scoped fill provides the bounded behavior planners need). Tier
  // walkways still hard-stop everything via the tier check below.
  const neighbors = new Int32Array(count * 4).fill(-1);
  const pitch = template.tiers[0].seatPitch;
  // A real tier's stairways can be wider than the template-wide default; a
  // fill bridges the widest of them, as it bridges any aisle.
  const maxGapU = ((anyBlocks ? widestAisle(template) : template.aisles.widthMeters) + 2 * pitch) / curve.total;

  const rowOfGlobal = (g: number): { start: number; end: number } => ({
    start: rowStart[g],
    end: rowStart[g + 1],
  });

  /** Binary search the seat in row g with u closest to target. Returns -1 if row empty. */
  function nearestInRow(g: number, targetU: number): number {
    const { start, end } = rowOfGlobal(g);
    if (end <= start) return -1;
    let lo = start;
    let hi = end - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (uv[mid * 2] < targetU) lo = mid + 1;
      else hi = mid;
    }
    const cands = [lo - 1, lo].filter((i) => i >= start && i < end);
    let best = -1;
    let bd = Infinity;
    for (const c of cands) {
      const d = Math.abs(uv[c * 2] - targetU);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return bd < maxGapU * 2 ? best : -1;
  }

  for (let i = 0; i < count; i++) {
    const g = rowOf[i];
    const { start, end } = rowOfGlobal(g);
    const u = uv[i * 2];
    // Left / right within the row (wrap-around at the bowl seam, gap-checked).
    const left = i > start ? i - 1 : end - 1;
    const right = i < end - 1 ? i + 1 : start;
    let dl = Math.abs(uv[left * 2] - u);
    if (dl > 0.5) dl = 1 - dl;
    let dr = Math.abs(uv[right * 2] - u);
    if (dr > 0.5) dr = 1 - dr;
    if (left !== i && dl < maxGapU) neighbors[i * 4] = left;
    if (right !== i && dr < maxGapU) neighbors[i * 4 + 1] = right;
    // Down / up: nearest-u seat in the adjacent row of the SAME tier
    // (tier boundaries are walkways — flood fill must not cross them).
    if (g > 0) {
      let j = nearestInRow(g - 1, u);
      // A lateral walkway inside a tier is one empty row: a colour region runs
      // on across it, as it runs across a stairway (TierBlocks.walkways).
      if (j < 0 && anyBlocks && g > 1) j = nearestInRow(g - 2, u);
      if (j >= 0 && tierOf[j] === tierOf[i]) neighbors[i * 4 + 2] = j;
    }
    if (g < totalRows - 1) {
      let j = nearestInRow(g + 1, u);
      if (j < 0 && anyBlocks && g < totalRows - 2) j = nearestInRow(g + 2, u);
      if (j >= 0 && tierOf[j] === tierOf[i]) neighbors[i * 4 + 3] = j;
    }
  }

  // Mirror map: reflect across the halfway line (x → −x ⇒ u → 0.5 − u), same row.
  // Aisles sit at k/aisleCount, a set closed under this reflection, so nearly every
  // seat has a partner; tolerance is tight (≈2 seat pitches) to avoid snapping
  // across an aisle to the wrong wedge.
  const mirrorOf = new Int32Array(count).fill(-1);
  const mirrorTolU = (2 * pitch) / curve.total;
  for (let i = 0; i < count; i++) {
    const uM = (0.5 - uv[i * 2] + 1) % 1;
    const j = nearestInRow(rowOf[i], uM);
    if (j >= 0) {
      let du = Math.abs(uv[j * 2] - uM);
      if (du > 0.5) du = 1 - du;
      if (du < mirrorTolU) mirrorOf[i] = j;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = xy[i * 2];
    const y = xy[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    templateRef: { id: template.id, version: template.version },
    count,
    xy,
    uv,
    pos3,
    tierOf,
    rowOf,
    sectionOf,
    neighbors,
    mirrorOf,
    bounds: { minX, minY, maxX, maxY },
  };
}

/** colPx is the approximate editor width of one seat column (UI sizing only). */
export const EDITOR_UNITS = { width: EDITOR_WIDTH, rowPx: ROW_PX, tierGapPx: TIER_GAP_PX, colPx: 3.2 };
