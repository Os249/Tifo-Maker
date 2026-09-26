import * as THREE from 'three';
import type { StadiumTemplate } from '../../core/types';
import { buildRoof } from './roof';
import { buildFacade } from './facade';
import { inLane, laneLines, type LaneLine } from '../../core/venueDetails';

/**
 * Match Day Simulator — extruded stand architecture (Phase 1).
 *
 * Builds the concrete bowl that the seats sit on, derived from the SAME
 * superellipse + per-tier maths the seat-map generator uses (see core/seatmap.ts):
 *   radial(row)    = baseOffset + row * rowDepth
 *   elevation(row) = baseElevation + row * rowDepth * tan(rake)
 * so the shell lines up under the seats by construction rather than by guesswork.
 *
 * Per tier we loft a sloped "deck" ring between the front (row 0) and back (last
 * row) edges. We then close the bowl with a front wall (pitch-side of tier 0
 * down to ground), an outer skirt (back of the top tier down to ground), and a
 * roof (see ./roof.ts, driven by template.roof). Everything is a handful of
 * indexed ring-strips, so it is cheap and fully parametric.
 */

const SAMPLES = 240; // perimeter samples per ring (smoothness vs cost)

type Pt = [number, number, number];

/** Superellipse point |x/a|^p+|z/b|^p=1 at angle t (x,z in the ground plane). */
function se(a: number, b: number, p: number, t: number): [number, number] {
  const e = 2 / p;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
}

/** A closed ring of 3D points on the plan curve, offset outward by `off`, at height `y`. */
function ring(a: number, b: number, p: number, off: number, y: number): Pt[] {
  const pts: Pt[] = [];
  const dt = (Math.PI * 2) / SAMPLES;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const [x, z] = se(a, b, p, t);
    const [x0, z0] = se(a, b, p, t - dt);
    const [x1, z1] = se(a, b, p, t + dt);
    const tx = x1 - x0;
    const tz = z1 - z0;
    const L = Math.hypot(tx, tz) || 1;
    let nx = tz / L;
    let nz = -tx / L;
    if (nx * x + nz * z < 0) {
      nx = -nx;
      nz = -nz;
    }
    pts.push([x + nx * off, y, z + nz * off]);
  }
  return pts;
}

/**
 * Triangulate a strip between two equal-length closed rings (inner -> outer).
 * When `keep` is given, quads whose either edge sample is masked-out are skipped,
 * opening the ring at those samples (used to cut the four corners of a box arena).
 */
function strip(inner: Pt[], outer: Pt[], keep?: boolean[]): THREE.BufferGeometry {
  const n = inner.length;
  const pos = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = inner[i][0];
    pos[i * 3 + 1] = inner[i][1];
    pos[i * 3 + 2] = inner[i][2];
    pos[(n + i) * 3] = outer[i][0];
    pos[(n + i) * 3 + 1] = outer[i][1];
    pos[(n + i) * 3 + 2] = outer[i][2];
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (keep && (!keep[i] || !keep[j])) continue; // open the corner gap
    const a = i;
    const b = j;
    const c = n + i;
    const d = n + j;
    idx.push(a, c, d, a, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Like strip(), but with vehicle lanes cut out exactly: every quad is clipped
 * against the side line of the lane it straddles (Sutherland-Hodgman against
 * one plane), so the cut edge is the lane's own edge whatever the ring spacing.
 * Only used on a tier a lane runs through.
 */
function clippedStrip(inner: Pt[], outer: Pt[], lanes: LaneLine[], keep?: boolean[]): THREE.BufferGeometry {
  const n = inner.length;
  const out: number[] = [];
  // Signed distance past the lane's side line (positive = outside the lane).
  const sideDist = (l: LaneLine, q: Pt, side: number): number => {
    const rx = q[0] - l.x;
    const rz = q[2] - l.z;
    return side * (rx * -l.dz + rz * l.dx) - l.lane.widthM / 2;
  };
  const inAny = (q: Pt): LaneLine | null => {
    for (const l of lanes) if (inLane([l], l.lane.tier, q[0], q[2])) return l;
    return null;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (keep && (!keep[i] || !keep[j])) continue;
    let poly: Pt[] = [inner[i], outer[i], outer[j], inner[j]];
    const hit = poly.map(inAny);
    const lane = hit.find((h) => h) ?? null;
    if (lane) {
      if (hit.every((h) => h)) continue; // wholly inside the lane
      // Which side of the lane this quad is on: the side its outside corners are.
      const outsideCorner = poly[hit.findIndex((h) => !h)];
      const across = (outsideCorner[0] - lane.x) * -lane.dz + (outsideCorner[2] - lane.z) * lane.dx;
      const side = across >= 0 ? 1 : -1;
      const next: Pt[] = [];
      for (let k = 0; k < poly.length; k++) {
        const P = poly[k];
        const Q = poly[(k + 1) % poly.length];
        const dp = sideDist(lane, P, side);
        const dq = sideDist(lane, Q, side);
        if (dp >= 0) next.push(P);
        if ((dp >= 0) !== (dq >= 0)) {
          const t = dp / (dp - dq);
          next.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t, P[2] + (Q[2] - P[2]) * t]);
        }
      }
      poly = next;
      if (poly.length < 3) continue;
    }
    // Fan-triangulate with the same winding as strip(): a, c, d / a, d, b.
    for (let k = 1; k < poly.length - 1; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

export function buildStands(template: StadiumTemplate, shadows: boolean): THREE.Group {
  const group = new THREE.Group();
  const { a, b, exponent: p } = template.plan;

  // Box-arena corner mask: same criterion as the seat generator (core/seatmap.ts)
  // so the concrete shell opens at exactly the corners where seats were dropped.
  const cornerCut = template.cornerCut ?? 0;
  let keep: boolean[] | undefined;
  if (cornerCut > 0) {
    keep = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = (i / SAMPLES) * Math.PI * 2;
      const [x0, z0] = se(a, b, p, t);
      keep.push(!(Math.abs(x0) / a > cornerCut && Math.abs(z0) / b > cornerCut));
    }
  }

  const concrete = new THREE.MeshStandardMaterial({ color: 0x6b7178, roughness: 0.96, metalness: 0, envMapIntensity: 0.8 });
  const structure = new THREE.MeshStandardMaterial({ color: 0x4c515a, roughness: 0.95, metalness: 0, envMapIntensity: 0.8 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean): void => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast && shadows;
    m.receiveShadow = receive && shadows;
    group.add(m);
  };

  let rowsBefore = 0;
  const tiers = template.tiers;
  let topBackRadial = 0;
  let topBackY = 0;
  let topTierDepth = 0;

  // Vehicle lanes: the concrete of the tier a ramp runs through is cut open
  // where its seats were removed (core/seatmap drops them by the same test),
  // so the ramp is a real slot in the stand rather than a hole in the seats
  // with a floor still under it. Templates without lanes are untouched.
  const lanes = laneLines(template);

  tiers.forEach((tier, idx) => {
    const rakeTan = Math.tan((tier.rakeDeg * Math.PI) / 180);
    const lastRow = Math.max(1, tier.rows - 1);
    // Extend the deck a little past the seats so seats sit on it, not at the lip.
    const frontRadial = tier.baseOffset - tier.rowDepth * 0.5;
    const backRadial = tier.baseOffset + lastRow * tier.rowDepth + tier.rowDepth * 0.5;
    const frontY = tier.baseElevation - tier.rowDepth * rakeTan * 0.5;
    const backY = tier.baseElevation + lastRow * tier.rowDepth * rakeTan + tier.rowDepth * rakeTan * 0.5;

    const laneHere = lanes.filter((l) => l.lane.tier === idx);
    if (laneHere.length) {
      // Cut exactly along the lane's side lines, so the concrete stops where
      // the seats stop and meets the ramp's walls — not a ring sample or two
      // either side of them, which left back-row seats floating over nothing.
      add(clippedStrip(ring(a, b, p, frontRadial, frontY), ring(a, b, p, backRadial, backY), laneHere, keep), concrete, true, true);
    } else {
      add(strip(ring(a, b, p, frontRadial, frontY), ring(a, b, p, backRadial, backY), keep), concrete, true, true);
    }

    // Vertical riser under the front of this tier, down to the previous tier's
    // top (tier 0 goes to ground). Closes the step between tiers.
    const floor = idx === 0 ? 0 : Math.max(0, topBackY - 0.2);
    if (frontY - floor > 0.4) {
      const lo = ring(a, b, p, frontRadial, floor);
      const hi = ring(a, b, p, frontRadial, frontY);
      add(laneHere.length ? clippedStrip(lo, hi, laneHere, keep) : strip(lo, hi, keep), structure, false, true);
    }

    rowsBefore += tier.rows;
    topBackRadial = backRadial;
    topBackY = backY;
    topTierDepth = backRadial - frontRadial;
  });

  // The outside of the bowl. A template that says nothing gets the flat grey
  // skirt this has always drawn, byte for byte — buildFacade's 'plain' is that
  // strip and that material. A template that names a style gets a real facade
  // instead, and the skirt is not drawn twice.
  if (template.facade?.style && template.facade.style !== 'plain') {
    group.add(buildFacade(template, topBackRadial, topBackY, shadows, keep).object);
  } else {
    add(strip(ring(a, b, p, topBackRadial, 0), ring(a, b, p, topBackRadial, topBackY), keep), structure, false, true);
  }

  // Roof. Was a flat ring reaching a hard-coded 16 m in over the seats, which on
  // a shallow top tier covered the whole stand and some of the one below it —
  // i.e. it hid the tifo. It is now a real slab whose reach is a fraction of the
  // tier it sits over, and which the template can shape or switch off.
  group.add(buildRoof(template, topBackRadial, topBackY, topTierDepth, shadows, keep).object);

  // Avoid an unused-variable lint while keeping the running total documented.
  void rowsBefore;
  return group;
}
