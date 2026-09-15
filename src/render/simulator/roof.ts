import * as THREE from 'three';
import type { RoofCoverage, RoofSpec, StadiumTemplate } from '../../core/types';
import { standIndexOfU } from '../../core/tifoSpec';

/**
 * The roof over the bowl.
 *
 * Built as a real slab rather than a plane: a deck, an underside, and a leading
 * edge joining them. That matters more than it sounds, because from every camera
 * inside the stadium the roof is seen from BELOW — the deck is the surface
 * nobody looks at, and a single-sided plane lit from above reads as a black hole
 * over the stands. The underside is the lit surface, so it gets its own lighter
 * material and the geometry to carry it.
 *
 * Coverage is masked per perimeter sample using the same u → stand mapping the
 * seat generator and the tifo compiler use (standIndexOfU), so "roof over the
 * west stand" means the same stand a tifo region called 'west' means. Where the
 * mask opens, the slab is capped, or you would see straight through its edge.
 *
 * Everything here is shell geometry. It never touches seat positions.
 */

const SAMPLES = 240;

export interface RoofBuild {
  readonly object: THREE.Group;
  /** Metres the roof reaches in over the top tier — what the tifo loses to it. */
  readonly reachMeters: number;
  /** Height of the leading edge's underside, for anything that hangs off it. */
  readonly innerUnderY: number;
  dispose(): void;
}

type Pt = [number, number, number];

/** Superellipse point |x/a|^p+|z/b|^p=1 at angle t. */
function se(a: number, b: number, p: number, t: number): [number, number] {
  const e = 2 / p;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
}

/** Outward unit normal of the plan curve at angle t. */
function normalAt(a: number, b: number, p: number, t: number): [number, number] {
  const dt = (Math.PI * 2) / SAMPLES;
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
  return [nx, nz];
}

function ring(a: number, b: number, p: number, off: number, y: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const [x, z] = se(a, b, p, t);
    const [nx, nz] = normalAt(a, b, p, t);
    out.push([x + nx * off, y, z + nz * off]);
  }
  return out;
}

/**
 * Perimeter fraction u for each ring sample, by cumulative arc length.
 *
 * Not i/SAMPLES: the angle parameter t runs fast round the flat sides of a
 * superellipse and slow round the ends, so the two disagree by up to a tenth of
 * the perimeter — enough to put a roof boundary a long way from the stand line
 * a tifo would draw. Seats are placed by arc length, so the roof must be too.
 */
export function arcU(a: number, b: number, p: number): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < SAMPLES; i++) pts.push(se(a, b, p, (i / SAMPLES) * Math.PI * 2));
  const cum: number[] = [0];
  for (let i = 1; i <= SAMPLES; i++) {
    const q = pts[i % SAMPLES];
    const r = pts[i - 1];
    cum.push(cum[i - 1] + Math.hypot(q[0] - r[0], q[1] - r[1]));
  }
  const total = cum[SAMPLES] || 1;
  return cum.slice(0, SAMPLES).map((d) => d / total);
}

/** Which perimeter samples this coverage mode keeps. */
export function coverageMask(a: number, b: number, p: number, coverage: RoofCoverage): boolean[] {
  if (coverage === 'ring') return new Array(SAMPLES).fill(true);
  if (coverage === 'none') return new Array(SAMPLES).fill(false);
  const want =
    coverage === 'sides' ? [0, 2] // east + west, the two long sides
      : coverage === 'ends' ? [1, 3] // north + south
        : [['east', 'north', 'west', 'south'].indexOf(coverage)];
  const us = arcU(a, b, p);
  return us.map((u) => want.includes(standIndexOfU(u)));
}

/** Triangulate inner→outer between two equal-length rings, honouring a mask. */
function strip(inner: Pt[], outer: Pt[], keep: boolean[], flip = false): THREE.BufferGeometry {
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
    if (!keep[i] || !keep[j]) continue;
    const A = i;
    const B = j;
    const C = n + i;
    const D = n + j;
    if (flip) idx.push(A, D, C, A, B, D);
    else idx.push(A, C, D, A, D, B);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Close the slab where the mask opens, so a partial roof has a cut end rather
 * than a paper edge you can see through.
 */
function endCaps(innerTop: Pt[], outerTop: Pt[], innerBot: Pt[], outerBot: Pt[], keep: boolean[]): THREE.BufferGeometry | null {
  const n = keep.length;
  const verts: number[] = [];
  const idx: number[] = [];
  const quad = (q0: Pt, q1: Pt, q2: Pt, q3: Pt): void => {
    const base = verts.length / 3;
    for (const v of [q0, q1, q2, q3]) verts.push(v[0], v[1], v[2]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (keep[i] === keep[j]) continue;
    const k = keep[i] ? i : j; // the sample on the covered side of the break
    quad(innerTop[k], outerTop[k], outerBot[k], innerBot[k]);
  }
  if (!verts.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export const ROOF_DEFAULTS = {
  coverage: 'ring' as RoofCoverage,
  reach: 0.5,
  overhang: 5,
  rise: 6,
  slope: 2,
  thickness: 1.2,
  color: 0x23272e,
  underColor: 0xb9bfc8,
};

/**
 * @param backRadial radial offset of the back of the top tier (metres out from plan)
 * @param backY      height of the back of the top tier
 * @param tierDepth  depth of the top tier in metres — reach is a fraction of this
 */
export function buildRoof(
  template: StadiumTemplate,
  backRadial: number,
  backY: number,
  tierDepth: number,
  shadows: boolean,
  cornerKeep?: boolean[],
): RoofBuild {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];
  const spec: RoofSpec = template.roof ?? {};
  const cfg = { ...ROOF_DEFAULTS, ...spec };
  const { a, b, exponent: p } = template.plan;

  const cover = coverageMask(a, b, p, cfg.coverage);
  const keep = cornerKeep ? cover.map((v, i) => v && cornerKeep[i]) : cover;
  const any = keep.some(Boolean);
  const reachMeters = Math.max(0, Math.min(1, cfg.reach)) * tierDepth;
  const innerRadial = backRadial - reachMeters;
  const outerRadial = backRadial + cfg.overhang;
  const outerY = backY + cfg.rise;
  const innerY = outerY - cfg.slope;
  const th = Math.max(0.2, cfg.thickness);

  if (!any) {
    return { object: group, reachMeters: 0, innerUnderY: backY, dispose(): void {} };
  }

  const deckMat = new THREE.MeshStandardMaterial({ color: cfg.color, roughness: 0.55, metalness: 0.35, envMapIntensity: 1.2 });
  // The underside is the surface the whole stadium looks at. Pale, rough and
  // slightly self-lit so it still reads at night when the floodlights are the
  // only thing pointing at it — a dark underside turns the roof into a void.
  const underMat = new THREE.MeshStandardMaterial({
    color: cfg.underColor,
    roughness: 0.9,
    metalness: 0,
    emissive: 0x2a2f38,
    emissiveIntensity: 0.35,
    envMapIntensity: 1,
  });
  // The edge is what draws the roof's line against the sky, so it sits between
  // the dark deck and the pale underside rather than matching either.
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
  trash.push(deckMat, underMat, edgeMat);

  const add = (geo: THREE.BufferGeometry | null, mat: THREE.Material, cast: boolean): void => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast && shadows;
    m.receiveShadow = false;
    group.add(m);
    trash.push(geo);
  };

  const innerTop = ring(a, b, p, innerRadial, innerY);
  const outerTop = ring(a, b, p, outerRadial, outerY);
  const innerBot = ring(a, b, p, innerRadial, innerY - th);
  const outerBot = ring(a, b, p, outerRadial, outerY - th);

  // Winding matters here and is easy to get backwards: inner→outer round this
  // ring produces DOWNWARD normals, so the deck is the strip that needs
  // flipping and the underside is the one that does not. Backwards, the deck
  // renders away from the sun and gets culled from outside, leaving you looking
  // through it at a pale surface that only looks like a roof from above.
  add(strip(innerTop, outerTop, keep, true), deckMat, true); // deck, seen from outside
  add(strip(innerBot, outerBot, keep), underMat, false); // underside, seen from everywhere inside
  add(strip(innerBot, innerTop, keep), edgeMat, false); // leading edge
  add(strip(outerTop, outerBot, keep), edgeMat, false); // outer lip
  add(endCaps(innerTop, outerTop, innerBot, outerBot, keep), edgeMat, false);

  // Back wall: from the top of the bowl up to the roof's outer underside, so the
  // cantilever is visibly carried instead of floating.
  add(strip(ring(a, b, p, outerRadial, backY), ring(a, b, p, outerRadial, outerY - th), keep), edgeMat, false);

  return {
    object: group,
    reachMeters,
    innerUnderY: innerY - th,
    dispose(): void {
      for (const t of trash) t.dispose();
    },
  };
}
