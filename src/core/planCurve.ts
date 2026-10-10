/**
 * The plan curve every seat is laid out on: the superellipse sampled as a
 * closed polyline with outward normals, and the same curve pushed out by a
 * row's radial offset with its own arc-length table.
 *
 * Moved here unchanged from seatmap.ts so the block layouts (core/blocks.ts)
 * measure along exactly the curves the seats are placed on. Nothing here may
 * change behaviour: every saved design indexes into seats placed by it.
 */

export const CURVE_SAMPLES = 4096;

export interface Curve {
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
export function samplePlanCurve(a: number, b: number, p: number): Curve {
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
export function pointAt(curve: Curve, u: number, offset: number): [number, number] {
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
export function offsetLength(curve: Curve, d: number): number {
  return curve.total + 2 * Math.PI * d;
}

/** The plan curve pushed outward by `d`, with its OWN cumulative arc-length table. */
export interface OffsetCurve {
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
export function buildOffsetCurve(curve: Curve, d: number): OffsetCurve {
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
export function pointOnOffset(oc: OffsetCurve, u: number): [number, number] {
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
