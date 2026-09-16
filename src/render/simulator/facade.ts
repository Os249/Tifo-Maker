import * as THREE from 'three';
import type { FacadeSpec, FacadeStyle, StadiumTemplate } from '../../core/types';

/**
 * The outside of the bowl.
 *
 * Until now every ground in the catalogue had the same outside: one flat grey
 * strip from the back of the top tier down to the ground. That is fine from
 * inside, where nobody looks at it, and it is the reason every stadium looked
 * like the same stadium from the approach shot.
 *
 * The eight styles here are the ones you can actually tell apart in a photo
 * taken from outside a ground, which matters because a photo is the only place
 * this information can come from. They differ in three ways that survive at
 * 150 m and a small screen:
 *
 *   - can you see through the skin (truss, lattice) or not (cladding, brick);
 *   - what rhythm does it have — the bay spacing, which is the single strongest
 *     cue to what a building is made of;
 *   - does it glow after dark. Only membrane does, and that one property is
 *     most of what "modern stadium at night" looks like.
 *
 * 'plain' exists so that a template that says nothing renders exactly as it did
 * before this file existed. It is not a style anyone would choose; it is the
 * promise that adding this feature moved nothing.
 */

const SAMPLES = 240;

export interface FacadeBuild {
  readonly object: THREE.Group;
  readonly style: FacadeStyle;
  /** Metres the facade stands out past the back of the bowl — for camera framing. */
  readonly footprintOut: number;
  dispose(): void;
}

type Pt = [number, number, number];

function se(a: number, b: number, p: number, t: number): [number, number] {
  const e = 2 / p;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
}

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

/** Triangulate between two equal-length closed rings, honouring a corner mask. */
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
    if (keep && (!keep[i] || !keep[j])) continue;
    idx.push(i, n + i, n + j, i, n + j, j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface Station {
  /** Position on the facade line, at ground level. */
  x: number;
  z: number;
  /** Outward unit normal. */
  nx: number;
  nz: number;
  /** Index into the SAMPLES ring, so the corner mask can be applied. */
  sample: number;
}

/**
 * Evenly spaced points round the facade line, by ARC LENGTH.
 *
 * Not by the angle parameter: on a superellipse, t runs fast along the flat
 * sides and slow round the ends, so evenly spaced t gives piers that crowd the
 * corners and stretch along the straights. The rhythm of the bays is the main
 * thing that tells you what a facade is made of, so an uneven one reads as a
 * mistake rather than as a material.
 */
function stations(a: number, b: number, p: number, off: number, spacing: number, keep?: boolean[]): Station[] {
  const pts: Pt[] = ring(a, b, p, off, 0);
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const q = pts[(i + 1) % SAMPLES];
    const r = pts[i];
    const d = Math.hypot(q[0] - r[0], q[2] - r[2]);
    seg.push(d);
    total += d;
  }
  const count = Math.max(8, Math.round(total / Math.max(1, spacing)));
  const step = total / count;
  const out: Station[] = [];
  let walked = 0;
  let i = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (i < SAMPLES - 1 && walked + seg[i] < target) {
      walked += seg[i];
      i++;
    }
    if (keep && !keep[i]) continue;
    const t = (i / SAMPLES) * Math.PI * 2;
    const [nx, nz] = normalAt(a, b, p, t);
    out.push({ x: pts[i][0], z: pts[i][2], nx, nz, sample: i });
  }
  return out;
}

interface Seg {
  from: [number, number, number];
  to: [number, number, number];
  /** Cross-section, metres. */
  w: number;
  d: number;
}

/**
 * Every structural member as one InstancedMesh of unit boxes.
 *
 * A facade is a few hundred sticks. As separate meshes that is a few hundred
 * draw calls on a scene that also has the crowd, the seats and the roof; as one
 * instanced box it is one. The cost is that each member's orientation has to be
 * built by hand from its own direction vector, which is what the basis below is.
 */
function members(list: Seg[], mat: THREE.Material, shadows: boolean): { mesh: THREE.InstancedMesh; geo: THREE.BufferGeometry } | null {
  if (!list.length) return null;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    dir.set(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
    const len = dir.length() || 0.001;
    dir.divideScalar(len);
    mid.set((s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2, (s.from[2] + s.to[2]) / 2);
    q.setFromUnitVectors(up, dir);
    scale.set(s.w, len, s.d);
    m.compose(mid, q, scale);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  return { mesh, geo };
}

/** Per-style look. Colours are the plausible middle of each material, not a brand. */
const PRESETS: Record<FacadeStyle, { color: number; accent: number; bay: number }> = {
  plain: { color: 0x4c515a, accent: 0x6b7178, bay: 0 },
  berm: { color: 0x5a5c3e, accent: 0x8b8d84, bay: 0 },
  truss: { color: 0x5b6672, accent: 0x76828f, bay: 6.5 },
  concrete: { color: 0x8d9089, accent: 0xa4a79f, bay: 7.5 },
  brick: { color: 0x8a4c35, accent: 0xb4ada0, bay: 6 },
  cladding: { color: 0x98a1ab, accent: 0xcdd4dc, bay: 4 },
  membrane: { color: 0xe2e7ee, accent: 0x767d87, bay: 9 },
  lattice: { color: 0xb9bfc7, accent: 0x8e949c, bay: 9 },
};

/**
 * Build the outside of the bowl.
 *
 * @param backRadial radial offset of the back of the top tier (metres out from plan)
 * @param topY       height of the back of the top tier
 */
export function buildFacade(
  template: StadiumTemplate,
  backRadial: number,
  topY: number,
  shadows: boolean,
  keep?: boolean[],
): FacadeBuild {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];
  const spec: FacadeSpec = template.facade ?? {};
  const style = spec.style ?? 'plain';
  const preset = PRESETS[style];
  const color = spec.color ?? preset.color;
  const accent = spec.accent ?? preset.accent;
  const bay = Math.max(2, spec.bayMeters ?? (preset.bay || 6));
  const { a, b, exponent: p } = template.plan;
  const H = Math.max(2, topY);

  const add = (geo: THREE.BufferGeometry | null, mat: THREE.Material, cast: boolean): void => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast && shadows;
    m.receiveShadow = shadows;
    group.add(m);
    trash.push(geo);
  };
  const addMembers = (list: Seg[], mat: THREE.Material): void => {
    const r = members(list, mat, shadows);
    if (!r) return;
    group.add(r.mesh);
    trash.push(r.geo, { dispose: () => r.mesh.dispose() });
  };

  // ---- berm: the bowl banked into the ground -----------------------------
  // What a municipal athletics ground built into a slope actually has, and what
  // a lot of the grounds this tool will be pointed at look like from the air.
  // About 24 degrees, the angle a grassed slope will stand at untterraced.
  //
  // Capped, though: at that angle a 39 m bowl would need an 87 m apron of earth
  // all the way round, which rendered as a grey lens the size of a car park.
  // Nobody banks a stadium that tall. A bank explains the bottom of a bowl and
  // structure explains the rest, so above the cap this falls back to a wall.
  if (style === 'berm') {
    const BANK_MAX = 14;
    const bank = Math.min(H, BANK_MAX);
    const run = bank / Math.tan((24 * Math.PI) / 180);
    const earth = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, envMapIntensity: 0.55 });
    const wall = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.95, metalness: 0 });
    trash.push(earth, wall);
    if (H > bank) {
      // The built part above the bank.
      add(strip(ring(a, b, p, backRadial, bank), ring(a, b, p, backRadial, H), keep), wall, false);
    }
    // A low retaining kerb where the bank meets what is above it. Without it the
    // slope runs into the deck at a knife edge and reads as a fold in paper.
    add(strip(ring(a, b, p, backRadial, bank - 1.1), ring(a, b, p, backRadial, bank), keep), wall, false);
    add(strip(ring(a, b, p, backRadial, bank - 1.1), ring(a, b, p, backRadial + run, 0), keep), earth, false);
    // And a kerb at the foot, which is what stops the bank washing into the road.
    add(strip(ring(a, b, p, backRadial + run, 0), ring(a, b, p, backRadial + run + 0.9, 0.55), keep), wall, false);
    return {
      object: group, style, footprintOut: run + 0.9,
      dispose(): void { for (const t of trash) t.dispose(); },
    };
  }

  // ---- everything else stands on the same wall line -----------------------
  const st = stations(a, b, p, backRadial, bay, keep);

  if (style === 'truss') {
    // Open steel: you see the back of the deck through it. No skin at all, which
    // is the point — a truss you cannot see through is just a dark wall.
    // Painted, not polished. Metalness near 1 with nothing to reflect renders
    // black, and the first version of this facade duly disappeared at night.
    const steel = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.25, envMapIntensity: 1.1 });
    trash.push(steel);
    const segs: Seg[] = [];
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      const n = st[(i + 1) % st.length];
      segs.push({ from: [s.x, 0, s.z], to: [s.x, H, s.z], w: 0.7, d: 0.7 });
      // Straight members between nodes, the way a truss is really built.
      for (const h of [H * 0.34, H * 0.67, H]) {
        segs.push({ from: [s.x, h, s.z], to: [n.x, h, n.z], w: 0.42, d: 0.42 });
      }
      segs.push({ from: [s.x, 0, s.z], to: [n.x, H, n.z], w: 0.32, d: 0.32 });
    }
    addMembers(segs, steel);
    return {
      object: group, style, footprintOut: 0.7,
      dispose(): void { for (const t of trash) t.dispose(); },
    };
  }

  if (style === 'lattice') {
    // A diagrid standing clear of the bowl — the expressive shell. Two helical
    // families crossing, plus the wall behind so it does not read as a cage
    // around nothing.
    const back = new THREE.MeshStandardMaterial({ color: 0x3d434b, roughness: 0.95, metalness: 0.1 });
    const rib = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3, envMapIntensity: 1.2 });
    trash.push(back, rib);
    add(strip(ring(a, b, p, backRadial, 0), ring(a, b, p, backRadial, H), keep), back, false);
    const stand = 2.6;
    const out = stations(a, b, p, backRadial + stand, bay, keep);
    const segs: Seg[] = [];
    const bands = 3;
    for (let k = 0; k < bands; k++) {
      const y0 = (k / bands) * H;
      const y1 = ((k + 1) / bands) * H;
      for (let i = 0; i < out.length; i++) {
        const s = out[i];
        const fwd = out[(i + 1) % out.length];
        const bwd = out[(i - 1 + out.length) % out.length];
        segs.push({ from: [s.x, y0, s.z], to: [fwd.x, y1, fwd.z], w: 0.55, d: 0.55 });
        segs.push({ from: [s.x, y0, s.z], to: [bwd.x, y1, bwd.z], w: 0.55, d: 0.55 });
      }
    }
    addMembers(segs, rib);
    return {
      object: group, style, footprintOut: stand + 0.6,
      dispose(): void { for (const t of trash) t.dispose(); },
    };
  }

  // ---- solid skins: concrete, brick, cladding, membrane, plain ------------
  const skin = style === 'membrane'
    ? new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0,
      // Fabric and ETFE are lit from behind. This is the one facade that is a
      // light source at night rather than a surface catching one, and without
      // the emissive it is a flat pale wall that reads as painted plaster.
      emissive: color,
      emissiveIntensity: 0.28,
      envMapIntensity: 0.9,
    })
    : new THREE.MeshStandardMaterial({
      color,
      roughness: style === 'cladding' ? 0.42 : 0.96,
      metalness: style === 'cladding' ? 0.55 : 0,
      envMapIntensity: style === 'cladding' ? 1.15 : 0.8,
    });
  trash.push(skin);

  // Modern skins lean outward a little; masonry and concrete stand plumb. Two
  // degrees is not much and is exactly what stops a 25 m wall reading as a slab.
  const batter = style === 'cladding' || style === 'membrane' ? H * 0.045 : 0;
  add(strip(ring(a, b, p, backRadial + batter, 0), ring(a, b, p, backRadial, H), keep), skin, false);

  if (style !== 'plain') {
    const pierMat = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: style === 'cladding' ? 0.35 : 0.9,
      metalness: style === 'cladding' ? 0.7 : 0.05,
      envMapIntensity: 1,
    });
    trash.push(pierMat);
    // Piers on masonry and concrete are structure and are deep; fins on a clad
    // or membrane facade are shading and are shallow and thin. Getting the
    // proportion wrong is what makes a render look like a video game.
    const deep = style === 'concrete' || style === 'brick' ? 1.1 : 0.55;
    const wide = style === 'concrete' || style === 'brick' ? 1.6 : 0.5;
    const segs: Seg[] = [];
    for (const s of st) {
      const x = s.x + s.nx * (deep * 0.4 + batter * 0.5);
      const z = s.z + s.nz * (deep * 0.4 + batter * 0.5);
      segs.push({ from: [x, 0, z], to: [x, H + (style === 'concrete' ? 1.2 : 0), z], w: wide, d: deep });
    }
    addMembers(segs, pierMat);

    if (style === 'brick') {
      // A string course near the top. One horizontal line is the whole
      // difference between brickwork and a brown wall.
      add(strip(ring(a, b, p, backRadial - 0.3, H * 0.82), ring(a, b, p, backRadial - 0.3, H * 0.88), keep), pierMat, false);
    }
  }

  return {
    object: group,
    style,
    footprintOut: style === 'plain' ? 0 : 1.2,
    dispose(): void { for (const t of trash) t.dispose(); },
  };
}
