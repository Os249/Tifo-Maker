import type { SeatMap, StadiumTemplate } from './types';
import { inLane, laneLines } from './venueDetails';
import { inGap, inStands } from './standSpans';

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

const CURVE_SAMPLES = 4096;
const EDITOR_WIDTH = 4000; // editor units across the full unrolled perimeter
const ROW_PX = 8; // editor units per row
const TIER_GAP_PX = 24; // walkway gap between tiers in the editor view

interface Curve {
  /** Sampled closed polyline: points and outward unit normals. */
  px: Float64Array;
  py: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  /** Cumulative arc length at each sample (s[0]=0), plus total length. */
  s: Float64Array;
  total: number;
}

/** Sample the superellipse |x/a|^p + |y/b|^p = 1 as a closed polyline with normals. */
function samplePlanCurve(a: number, b: number, p: number): Curve {
  const n = CURVE_SAMPLES;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const e = 2 / p;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    px[i] = a * Math.sign(c) * Math.abs(c) ** e;
    py[i] = b * Math.sign(s) * Math.abs(s) ** e;
  }
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const s = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n;
    const i1 = (i + 1) % n;
    // Central-difference tangent → outward normal (curve is CCW, so normal = (ty, -tx) flipped).
    const tx = px[i1] - px[i0];
    const ty = py[i1] - py[i0];
    const len = Math.hypot(tx, ty) || 1;
    nx[i] = ty / len;
    ny[i] = -tx / len;
    // Ensure the normal points outward (away from origin).
    if (nx[i] * px[i] + ny[i] * py[i] < 0) {
      nx[i] = -nx[i];
      ny[i] = -ny[i];
    }
    s[i] = total;
    total += Math.hypot(px[i1] - px[i], py[i1] - py[i]);
  }
  return { px, py, nx, ny, s, total };
}

/** Point + normal on the offset curve at arc-length fraction u ∈ [0,1). */
function pointAt(curve: Curve, u: number, offset: number): [number, number] {
  const target = u * curve.total;
  // Binary search the cumulative-length table.
  let lo = 0;
  let hi = CURVE_SAMPLES - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (curve.s[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const i1 = (i + 1) % CURVE_SAMPLES;
  const segLen =
    (i1 === 0 ? curve.total : curve.s[i1]) - curve.s[i] || 1e-9;
  const f = (target - curve.s[i]) / segLen;
  const x = curve.px[i] + (curve.px[i1] - curve.px[i]) * f + (curve.nx[i] + (curve.nx[i1] - curve.nx[i]) * f) * offset;
  const y = curve.py[i] + (curve.py[i1] - curve.py[i]) * f + (curve.ny[i] + (curve.ny[i1] - curve.ny[i]) * f) * offset;
  return [x, y];
}

/** Approximate length of the curve offset outward by `d` (perimeter grows ~2πd for convex curves). */
function offsetLength(curve: Curve, d: number): number {
  return curve.total + 2 * Math.PI * d;
}

/** The plan curve pushed outward by `d`, with its OWN cumulative arc-length table. */
interface OffsetCurve {
  x: Float64Array;
  z: Float64Array;
  s: Float64Array;
  total: number;
}

/**
 * Build the offset curve for a row so seats can be spaced evenly along the row
 * the spectator actually sits on.
 *
 * Why this exists: pointAt() walks `u` along the BASE curve then pushes outward,
 * but a row's seat count comes from the OFFSET perimeter. Local spacing on the
 * offset curve scales by (1 + curvature*d), so sampling the base curve bunches
 * seats on the straights and stretches them round the corners — and the error
 * grows with every row back. Sampling this table instead gives a genuinely
 * uniform seat pitch all the way round.
 */
function buildOffsetCurve(curve: Curve, d: number): OffsetCurve {
  const n = CURVE_SAMPLES;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = curve.px[i] + curve.nx[i] * d;
    z[i] = curve.py[i] + curve.ny[i] * d;
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    s[i] = total;
    const j = (i + 1) % n;
    total += Math.hypot(x[j] - x[i], z[j] - z[i]);
  }
  return { x, z, s, total };
}

/** Point at arc-length fraction u along the offset curve (uniform seat spacing). */
function pointOnOffset(oc: OffsetCurve, u: number): [number, number] {
  const target = u * oc.total;
  let lo = 0;
  let hi = CURVE_SAMPLES - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (oc.s[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const i1 = (i + 1) % CURVE_SAMPLES;
  const segLen = (i1 === 0 ? oc.total : oc.s[i1]) - oc.s[i] || 1e-9;
  const f = (target - oc.s[i]) / segLen;
  return [oc.x[i] + (oc.x[i1] - oc.x[i]) * f, oc.z[i] + (oc.z[i1] - oc.z[i]) * f];
}

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

      for (let k = 0; k < nSeats; k++) {
        const u = (k + 0.5) / nSeats;
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
      }
    }
  });
  rowStart[totalRows] = xs.length;

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
  const maxGapU = (template.aisles.widthMeters + 2 * pitch) / curve.total;

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
      const j = nearestInRow(g - 1, u);
      if (j >= 0 && tierOf[j] === tierOf[i]) neighbors[i * 4 + 2] = j;
    }
    if (g < totalRows - 1) {
      const j = nearestInRow(g + 1, u);
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
