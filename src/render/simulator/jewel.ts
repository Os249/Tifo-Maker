import * as THREE from 'three';
import type { StadiumTemplate } from '../../core/types';
import { curveSampler, tierEdges } from '../../core/venueDetails';

/**
 * King Abdullah Sports City — the building around the generated bowl.
 *
 * Built from StadiumDB's photo set (September 2026), and every dimension is
 * taken from the template so the shell follows the seats rather than a
 * constant:
 *
 *   - THE CROWN. Twenty-four pillowed bays of white membrane on top. Each bay
 *     narrows towards the opening, so from above the inner edge reads as the
 *     ring of white points the aerial photographs show. Under it there is a
 *     flat structural deck.
 *   - THE TRUSSES. Forty-eight white steel cantilevers radiate from the outer
 *     supports to a compression ring at the opening. Seen from inside, they
 *     are the Jewel's roof: open lattice girders with the membrane above.
 *   - THE ARCHES. A V-strut ring behind the upper tier carries the trusses
 *     down onto the back of the bowl. From the pitch it reads as the row of
 *     arches under the roof.
 *   - THE SKIN. A diamond-lattice screen wraps the base, glowing warm after
 *     dark. It is crossed by pairs of steel legs that make the X pattern round
 *     the outside.
 *
 * Shell only: nothing here moves a seat.
 */

type Trash = { dispose(): void };

/** A lattice screen: diagonal members and triangles pointing down, on transparent. */
function latticeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(240,232,214,1)';
  g.lineWidth = 7;
  for (let k = -128; k <= 128; k += 32) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 128, 128);
    g.stroke();
    g.beginPath();
    g.moveTo(k + 128, 0);
    g.lineTo(k, 128);
    g.stroke();
  }
  // The solid perforated triangles between the diagonals.
  g.fillStyle = 'rgba(232,222,200,0.9)';
  for (let y = 0; y < 128; y += 32) {
    for (let x = 0; x < 128; x += 32) {
      g.beginPath();
      g.moveTo(x + 6, y + 4);
      g.lineTo(x + 26, y + 4);
      g.lineTo(x + 16, y + 14);
      g.closePath();
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * The crown's dimensions, from the template alone. Pure (no DOM, no GL), so
 * the checks can hold the lighting mount to the roof it claims to hang from.
 */
export function jewelFrame(template: StadiumTemplate): {
  R_BACK: number; Y_BACK: number; R_IN: number; R_OUT: number; R_SKIN: number;
  Y_OUT: number; Y_IN: number; SH_R: number; SH_Y: number; CHORD_END_Y: number;
} {
  const top = tierEdges(template, template.tiers.length - 1);
  // Offsets from the plan curve, all from the top tier's back edge. Arup: the
  // roof girders are "only" 60 m long and still cover every spectator — so the
  // opening edge sits over the front of the lower tier, not over the upper.
  const R_BACK = top.back; // back of the upper tier
  const Y_BACK = top.backY;
  const R_IN = 5; // the opening, over the front rows of the lower tier
  const R_OUT = R_BACK + 1; // outer edge of the roof, where it rolls over
  const R_SKIN = R_BACK + 10; // the lattice wall
  const Y_OUT = Y_BACK + 15; // high enough for the arch ring and the screens under it
  const Y_IN = Y_BACK + 15.5;
  const SH_R = 9; // the roll-over: out this far...
  const SH_Y = 16; // ...and down this far, which is where the pillows meet the lattice
  const CHORD_END_Y = Y_BACK + 11; // bottom chord where it lands over the arches
  return { R_BACK, Y_BACK, R_IN, R_OUT, R_SKIN, Y_OUT, Y_IN, SH_R, SH_Y, CHORD_END_Y };
}

export interface JewelBuild {
  object: THREE.Group;
  disposables: Trash[];
  /** Where the crown's inner edge is, for the lighting mount and the cameras. */
  crown: { inner: number; innerY: number; outer: number; outerY: number };
}

export function buildJewel(template: StadiumTemplate, shadows: boolean): JewelBuild {
  const group = new THREE.Group();
  group.name = 'jewel';
  const trash: Trash[] = [];
  const at = curveSampler(template);

  const { R_BACK, Y_BACK, R_IN, R_OUT, R_SKIN, Y_OUT, Y_IN, SH_R, SH_Y, CHORD_END_Y } = jewelFrame(template);
  const N = 24; // bays

  // ---- materials --------------------------------------------------------
  const membrane = new THREE.MeshStandardMaterial({
    color: 0xefe9dc,
    emissive: 0xf3dcb0,
    emissiveIntensity: 0.12,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  // The underside is what a fan actually looks at: PTFE is translucent and the
  // Jewel lights its roof from below, so it reads bright and warm at night.
  const deck = new THREE.MeshStandardMaterial({
    color: 0xe9e3d6,
    emissive: 0xfff0d6,
    emissiveIntensity: 0.34,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  // Painted white steel. Low metalness: without an environment to reflect,
  // metal renders dark — and the Jewel's steel is the whitest thing on it.
  const steel = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.5, metalness: 0.1, emissive: 0xbdb5a3, emissiveIntensity: 0.45 });
  trash.push(membrane, deck, steel);

  // ---- the crown: pillowed bays over a flat deck -----------------------
  const RS = 14; // radial segments over the top
  const SS = 6; // segments round the shoulder
  const AS = 10; // across each bay
  const pos: number[] = [];
  const idx: number[] = [];
  const deckPos: number[] = [];
  const deckIdx: number[] = [];
  for (let bay = 0; bay < N; bay++) {
    const u0 = bay / N;
    const u1 = (bay + 1) / N;
    const base = pos.length / 3;
    const rows = RS + SS + 1;
    for (let r = 0; r < rows; r++) {
      let off: number;
      let y: number;
      let s: number; // 0 at the opening, 1 at the outer edge (and beyond, on the shoulder)
      if (r <= RS) {
        s = r / RS;
        off = R_IN + (R_OUT - R_IN) * s;
        y = Y_IN + (Y_OUT - Y_IN) * s;
      } else {
        const phi = ((r - RS) / SS) * (Math.PI / 2);
        s = 1;
        off = R_OUT + SH_R * Math.sin(phi);
        y = Y_OUT - SH_Y * (1 - Math.cos(phi));
      }
      // The bay narrows towards the opening: that is what makes the star.
      const width = 0.3 + 0.7 * Math.min(1, s);
      const bulge = 1.2 + 3.4 * Math.min(1, s) * Math.min(1, s);
      for (let k = 0; k <= AS; k++) {
        const f = k / AS;
        const uf = 0.5 + (f - 0.5) * width;
        const p = at(u0 + (u1 - u0) * uf, off);
        const h = Math.sin(f * Math.PI) * bulge;
        pos.push(p.x, y + h, p.z);
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < AS; k++) {
        const a = base + r * (AS + 1) + k;
        const b = a + AS + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    // The flat deck under the whole bay, a little below the pillows.
    const db = deckPos.length / 3;
    for (let r = 0; r <= 4; r++) {
      const s = r / 4;
      const off = R_IN + (R_OUT - R_IN) * s;
      const y = Y_IN + (Y_OUT - Y_IN) * s - 0.3;
      for (let k = 0; k <= 4; k++) {
        const p = at(u0 + ((u1 - u0) * k) / 4, off);
        deckPos.push(p.x, y, p.z);
      }
    }
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) {
        const a = db + r * 5 + k;
        const b = a + 5;
        deckIdx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const crownGeo = new THREE.BufferGeometry();
  crownGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  crownGeo.setIndex(idx);
  crownGeo.computeVertexNormals();
  const crown = new THREE.Mesh(crownGeo, membrane);
  crown.castShadow = shadows;
  group.add(crown);
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckPos, 3));
  deckGeo.setIndex(deckIdx);
  deckGeo.computeVertexNormals();
  group.add(new THREE.Mesh(deckGeo, deck));
  trash.push(crownGeo, deckGeo);

  // ---- steel: trusses, compression ring, arches and legs -----------------
  // One instanced mesh of unit boxes for every member — a few thousand pieces
  // of steel as a few thousand draw calls would cost more than the crowd.
  const members: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
  const P = (u: number, off: number, y: number): THREE.Vector3 => {
    const p = at(u, off);
    return new THREE.Vector3(p.x, y, p.z);
  };
  const TRUSSES = N * 2;
  // Perimeter at the back of the upper tier, to turn a screen's width into u.
  let perim = 0;
  for (let i = 0; i < 256; i++) {
    const a = P(i / 256, R_BACK, 0);
    const b = P((i + 1) / 256, R_BACK, 0);
    perim += a.distanceTo(b);
  }
  const screenGaps: [number, number][] = (template.details?.screens ?? []).map((sc) => [sc.centerU, (sc.widthM / 2 + 4) / perim]);
  const PANELS = 9;
  for (let i = 0; i < TRUSSES; i++) {
    const u = i / TRUSSES;
    const topAt = (s: number): THREE.Vector3 => P(u, R_IN + (R_OUT - 1 - R_IN) * s, Y_IN + (Y_OUT - Y_IN) * s - 0.5);
    // The bottom chord drops as it runs out: a cantilever is deepest at its support.
    const botAt = (s: number): THREE.Vector3 => P(u, R_IN + 1 + (R_BACK - 1 - R_IN - 1) * s, Y_IN - 2 + (CHORD_END_Y - (Y_IN - 2)) * s);
    for (let k = 0; k < PANELS; k++) {
      const s0 = k / PANELS;
      const s1 = (k + 1) / PANELS;
      members.push({ a: topAt(s0), b: topAt(s1), r: 0.32 });
      members.push({ a: botAt(s0), b: botAt(s1), r: 0.32 });
      members.push({ a: botAt(s1), b: topAt(s1), r: 0.16 });
      members.push({ a: k % 2 ? botAt(s0) : topAt(s0), b: k % 2 ? topAt(s1) : botAt(s1), r: 0.14 });
    }
    members.push({ a: botAt(0), b: topAt(0), r: 0.2 });
    // Down onto the back of the upper tier: the V of the arch ring — except
    // where a big screen stands in the arch, which is how the real ones sit.
    if (screenGaps.some(([c, h]) => Math.min(Math.abs(u + 0.5 / TRUSSES - c), 1 - Math.abs(u + 0.5 / TRUSSES - c)) < h)) continue;
    const foot = P(u + 0.5 / TRUSSES, R_BACK + 0.6, Y_BACK + 0.2);
    const spread = 0.5 / TRUSSES;
    members.push({ a: foot, b: P(u, R_BACK - 1, CHORD_END_Y), r: 0.34 });
    members.push({ a: foot, b: P(u + 2 * spread, R_BACK - 1, CHORD_END_Y), r: 0.34 });
  }
  // Compression ring round the opening, and a tie ring at the arch tops.
  const RING = 192;
  for (let i = 0; i < RING; i++) {
    const u0 = i / RING;
    const u1 = (i + 1) / RING;
    members.push({ a: P(u0, R_IN, Y_IN - 0.5), b: P(u1, R_IN, Y_IN - 0.5), r: 0.45 });
    members.push({ a: P(u0, R_IN + 1, Y_IN - 2), b: P(u1, R_IN + 1, Y_IN - 2), r: 0.4 });
    members.push({ a: P(u0, R_BACK - 1, CHORD_END_Y), b: P(u1, R_BACK - 1, CHORD_END_Y), r: 0.34 });
  }
  // The legs round the outside. Each bay boundary drops a Λ to the ground;
  // neighbouring Λs cross half way down, which is the X of the facade.
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const d = 0.75 / N;
    const head = P(u, R_SKIN + 0.9, Y_OUT - SH_Y + 0.8);
    members.push({ a: head, b: P(u - d, R_SKIN + 3.2, 0), r: 0.75 });
    members.push({ a: head, b: P(u + d, R_SKIN + 3.2, 0), r: 0.75 });
  }
  const unit = new THREE.BoxGeometry(1, 1, 1);
  trash.push(unit);
  const steelMesh = new THREE.InstancedMesh(unit, steel, members.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const scl = new THREE.Vector3();
  members.forEach((mb, i) => {
    dir.subVectors(mb.b, mb.a);
    const len = dir.length();
    dir.normalize();
    q.setFromUnitVectors(up, dir);
    mid.addVectors(mb.a, mb.b).multiplyScalar(0.5);
    scl.set(mb.r, len, mb.r);
    m.compose(mid, q, scl);
    steelMesh.setMatrixAt(i, m);
  });
  steelMesh.instanceMatrix.needsUpdate = true;
  steelMesh.castShadow = shadows;
  steelMesh.frustumCulled = false;
  group.add(steelMesh);

  // ---- the skin -------------------------------------------------------------
  const lat = latticeTexture();
  const segs = 480;
  const skinPos: number[] = [];
  const skinUv: number[] = [];
  const skinIdx: number[] = [];
  const skinTop = Y_OUT - SH_Y + 1.2;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const p = at(u, R_SKIN);
    skinPos.push(p.x, 0, p.z, p.x, skinTop, p.z);
    skinUv.push(u * 64, 0, u * 64, skinTop / 12);
  }
  for (let i = 0; i < segs; i++) {
    const k = i * 2;
    skinIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const skinGeo = new THREE.BufferGeometry();
  skinGeo.setAttribute('position', new THREE.Float32BufferAttribute(skinPos, 3));
  skinGeo.setAttribute('uv', new THREE.Float32BufferAttribute(skinUv, 2));
  skinGeo.setIndex(skinIdx);
  skinGeo.computeVertexNormals();
  const skinMat = new THREE.MeshStandardMaterial({
    map: lat,
    alphaMap: lat,
    transparent: true,
    alphaTest: 0.35,
    color: 0xf6f1e6,
    emissive: 0xfff1d8,
    emissiveMap: lat,
    emissiveIntensity: 0.4,
    roughness: 0.5,
    metalness: 0.25,
    side: THREE.DoubleSide,
  });
  const skin = new THREE.Mesh(skinGeo, skinMat);
  group.add(skin);
  trash.push(lat, skinGeo, skinMat);
  // A warm inner wall behind the lattice — the lit concourse you see through it.
  const glowGeo = skinGeo.clone();
  const gp = glowGeo.getAttribute('position') as THREE.BufferAttribute;
  // It also closes the band between the back of the upper tier and the roof:
  // taken up to just under the pillows' roll-over, so the arches frame the
  // concourse rather than the city behind the building.
  const wallOff = R_SKIN - 2.5;
  const phiAt = Math.asin(Math.min(1, (wallOff - R_OUT) / SH_R));
  const wallTop = Math.max(skinTop, Y_OUT - SH_Y * (1 - Math.cos(phiAt)) - 0.6);
  for (let i = 0; i <= segs; i++) {
    const p = at(i / segs, wallOff);
    gp.setXYZ(i * 2, p.x, 0, p.z);
    gp.setXYZ(i * 2 + 1, p.x, skinTop, p.z);
  }
  gp.needsUpdate = true;
  // The band above the lattice, under the roll-over: in shadow from outside,
  // and the dark behind the arches from inside, as in the photographs.
  const bandGeo = glowGeo.clone();
  const bp = bandGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i <= segs; i++) {
    const p = at(i / segs, wallOff);
    bp.setXYZ(i * 2, p.x, skinTop - 0.2, p.z);
    bp.setXYZ(i * 2 + 1, p.x, wallTop, p.z);
  }
  bp.needsUpdate = true;
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x191613, roughness: 0.95, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(bandGeo, bandMat));
  trash.push(bandGeo, bandMat);
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, emissive: 0x9a5a26, emissiveIntensity: 0.2, roughness: 0.9, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(glowGeo, glowMat));
  trash.push(glowGeo, glowMat);

  // ---- the run-off: grass to the front of the stands -----------------------
  const shape = new THREE.Shape();
  for (let i = 0; i <= 256; i++) {
    const p = at(i / 256, -0.6);
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  const runGeo = new THREE.ShapeGeometry(shape, 1);
  const runMat = new THREE.MeshStandardMaterial({ color: 0x1d5e2e, roughness: 0.85 });
  const run = new THREE.Mesh(runGeo, runMat);
  run.rotation.x = -Math.PI / 2;
  run.position.y = -0.02;
  run.receiveShadow = shadows;
  group.add(run);
  trash.push(runGeo, runMat);

  return {
    object: group,
    disposables: trash,
    crown: { inner: R_IN, innerY: Y_IN, outer: R_OUT + SH_R, outerY: Y_OUT },
  };
}
