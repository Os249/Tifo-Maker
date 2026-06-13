import type { SeatMap, StadiumTemplate } from './types';

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

export function generateSeatMap(template: StadiumTemplate): SeatMap {
  const curve = samplePlanCurve(template.plan.a, template.plan.b, template.plan.exponent);

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
    for (let r = 0; r < tier.rows; r++) {
      const globalRow = totalRowsBefore[tierIdx] + r;
      rowStart[globalRow] = xs.length;
      const radial = tier.baseOffset + r * tier.rowDepth;
      const elevation = tier.baseElevation + r * tier.rowDepth * rake;
      const rowLen = offsetLength(curve, radial);
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

        const [wx, wy] = pointAt(curve, u, radial);
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
