import * as THREE from 'three';
import type { StadiumTemplate } from '../../core/types';

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
 * simple cantilever roof ring over the top tier. Everything is a handful of
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
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide, envMapIntensity: 1.3 });

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

  tiers.forEach((tier, idx) => {
    const rakeTan = Math.tan((tier.rakeDeg * Math.PI) / 180);
    const lastRow = Math.max(1, tier.rows - 1);
    // Extend the deck a little past the seats so seats sit on it, not at the lip.
    const frontRadial = tier.baseOffset - tier.rowDepth * 0.5;
    const backRadial = tier.baseOffset + lastRow * tier.rowDepth + tier.rowDepth * 0.5;
    const frontY = tier.baseElevation - tier.rowDepth * rakeTan * 0.5;
    const backY = tier.baseElevation + lastRow * tier.rowDepth * rakeTan + tier.rowDepth * rakeTan * 0.5;

    // Sloped seating deck.
    add(strip(ring(a, b, p, frontRadial, frontY), ring(a, b, p, backRadial, backY), keep), concrete, true, true);

    // Vertical riser under the front of this tier, down to the previous tier's
    // top (tier 0 goes to ground). Closes the step between tiers.
    const floor = idx === 0 ? 0 : Math.max(0, topBackY - 0.2);
    if (frontY - floor > 0.4) {
      add(strip(ring(a, b, p, frontRadial, floor), ring(a, b, p, frontRadial, frontY), keep), structure, false, true);
    }

    rowsBefore += tier.rows;
    topBackRadial = backRadial;
    topBackY = backY;
  });

  // Outer skirt: back of the top tier down to the ground.
  add(strip(ring(a, b, p, topBackRadial, 0), ring(a, b, p, topBackRadial, topBackY), keep), structure, false, true);

  // Cantilever roof over the top tier, connected to the back wall by a vertical
  // fascia so it reads as supported rather than floating in the air.
  const roofY = topBackY + 4;
  const roofInner = ring(a, b, p, topBackRadial - 16, roofY); // reaches in over the back rows
  const roofOuter = ring(a, b, p, topBackRadial + 5, roofY);
  add(strip(roofInner, roofOuter, keep), roofMat, true, false);
  // Fascia: vertical web from the stand top edge up to the roof's outer lip.
  add(strip(ring(a, b, p, topBackRadial + 5, topBackY), ring(a, b, p, topBackRadial + 5, roofY), keep), structure, false, true);

  // Avoid an unused-variable lint while keeping the running total documented.
  void rowsBefore;
  return group;
}
