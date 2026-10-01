import * as THREE from 'three';
import type { StadiumTemplate } from '../../core/types';
import { spanOn } from '../../core/standSpans';
import { ambulance } from './venue';

/**
 * Kingdom Arena, Riyadh — the building around the four stands.
 *
 * Built from StadiumDB's photo set of the ground after the December 2024
 * expansion, with the published figures (a box 220 x 150 m, 47 m high).
 * Every position comes from the template's stands, so the shell follows the
 * seats rather than a constant:
 *
 *   - THE HALL. One enclosed box. A high central section over the pitch and
 *     the two side stands, its ceiling black and pricked with a grid of small
 *     lights; lower wings over the ends. Where the two meet, a tall
 *     cross-braced truss wall rises over each end stand.
 *   - THE ROOF STEEL. Deep trusses span the width every 10 m; two lighter
 *     ones run the length over the front of the side stands and carry the
 *     rows of floodlights, with two big air ducts alongside.
 *   - THE MAIN STAND. A low tier of seats under three floors of glass: two
 *     floors of boxes with seats out on a terrace, and the sky lounge on top.
 *     The dugouts and the players' tunnel are in front of it.
 *   - THE OUTSIDE. The tall middle block clad in perforated beige panels, the
 *     lower wings in dark glass crossed by a bronze lattice, and stepped
 *     stone-coloured blocks at the entrances.
 *
 * The screens (centre-hung, ends, corner columns) and the 14 boxes of the
 * north stand are VenueDetails, drawn by venue.ts. Shell only: nothing here
 * moves a seat.
 */

type Trash = { dispose(): void };

export interface KingdomFrame {
  /** Inside faces of the walls: x either side, and z on the south and north. */
  X: number;
  Z_S: number;
  Z_N: number;
  /** Half-length of the high middle section, and its ceiling; the wings' ceiling. */
  HIGH_X: number;
  CEIL_HIGH: number;
  CEIL_LOW: number;
  /** Trusses: bottom and top chord of the cross trusses. */
  TRUSS_LO: number;
  TRUSS_HI: number;
  /** Outside: roof heights and wall thickness. */
  ROOF_HIGH: number;
  ROOF_LOW: number;
  WALL: number;
  /** The main stand's hospitality block: where it starts (plan offset), its floors. */
  HOSP_FRONT: number;
  HOSP_FLOORS: { y: number; h: number; balcony: boolean }[];
  HOSP_HALF: number;
  HOSP_BOXES: number;
}

/** The building's dimensions, from the template's stands. Pure. */
export function kingdomFrame(template: StadiumTemplate): KingdomFrame {
  const { a, b } = template.plan;
  const end = spanOn(template, 0, 'east');
  const northTop = spanOn(template, template.tiers.length - 1, 'north') ?? spanOn(template, 0, 'north');
  const main = spanOn(template, 0, 'south');
  const endBack = end ? a + end.back : a + 30;
  const northBack = northTop ? b + northTop.back : b + 30;
  const mainBack = main ? main.back : 10;
  const mainTopY = main ? main.backY : 6;
  // Floors over the main stand's seats (VenueDetails.hospitality): boxes with
  // a terrace in front of each, and the sky lounge on top.
  const hosp = template.details?.hospitality;
  const f1 = mainTopY + 0.3;
  const floors: { y: number; h: number; balcony: boolean }[] = [];
  let y = f1;
  for (let k = 0; k < (hosp?.boxFloors ?? 2); k++) {
    floors.push({ y, h: 3.8, balcony: true });
    y += 4.1;
  }
  if (hosp?.lounge ?? true) floors.push({ y, h: 4.6, balcony: false });
  return {
    X: endBack + 14,
    Z_S: -(b + mainBack + 15),
    Z_N: northBack + 3,
    HIGH_X: a + 4,
    CEIL_HIGH: 42,
    CEIL_LOW: 26,
    TRUSS_LO: 34,
    TRUSS_HI: 41.5,
    ROOF_HIGH: 47,
    ROOF_LOW: 28,
    WALL: 1.6,
    HOSP_FRONT: mainBack + 0.2,
    HOSP_FLOORS: floors,
    HOSP_HALF: hosp?.halfLength ?? 50,
    HOSP_BOXES: hosp?.boxesPerFloor ?? 10,
  };
}

/** Perforated beige cladding: panels with a field of small dark holes. */
function claddingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b9a184';
  g.fillRect(0, 0, 256, 256);
  // Panel joints.
  g.fillStyle = 'rgba(70,52,36,0.35)';
  for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 2, 256);
  for (let y = 0; y < 256; y += 128) g.fillRect(0, y, 256, 2);
  // Perforations, denser towards the top of each panel.
  g.fillStyle = 'rgba(52,38,26,0.55)';
  for (let y = 4; y < 256; y += 6) {
    for (let x = 4; x < 256; x += 6) {
      const k = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      if (k % 7 < 3) g.fillRect(x, y, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Dark glazing crossed by a bronze diagonal lattice. */
function latticeGlassTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#141a22');
  grd.addColorStop(1, '#0b0f15');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(176,138,96,0.85)';
  g.lineWidth = 4;
  for (let k = -256; k <= 512; k += 64) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 128, 256);
    g.stroke();
    g.beginPath();
    g.moveTo(k + 128, 0);
    g.lineTo(k, 256);
    g.stroke();
  }
  // Mullions.
  g.fillStyle = 'rgba(30,34,40,1)';
  for (let x = 0; x < 256; x += 32) g.fillRect(x, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The inside of a hospitality box: warm walls, a bar, tables and people. */
function roomTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, '#f3dfb8');
  grd.addColorStop(0.7, '#c9a678');
  grd.addColorStop(1, '#6e5238');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 64);
  // A bar along the back, pendant lights, and people standing.
  g.fillStyle = 'rgba(70,48,30,0.8)';
  g.fillRect(0, 40, 256, 8);
  g.fillStyle = 'rgba(255,240,205,0.95)';
  for (let x = 12; x < 256; x += 32) g.fillRect(x, 6, 10, 3);
  let r = seed * 9301 + 49297;
  const rnd = (): number => {
    r = (r * 9301 + 49297) % 233280;
    return r / 233280;
  };
  for (let i = 0; i < 14; i++) {
    const x = rnd() * 250;
    const robe = rnd() < 0.6;
    g.fillStyle = robe ? 'rgba(244,240,232,0.95)' : 'rgba(28,30,38,0.9)';
    g.fillRect(x, 26, 6, 26);
    g.fillStyle = robe ? 'rgba(238,236,230,1)' : 'rgba(60,44,34,1)';
    g.beginPath();
    g.arc(x + 3, 23, 3.4, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

interface Inst {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rx?: number;
  ry?: number;
  rz?: number;
}

/** Many boxes in one draw call. */
function instanced(list: Inst[], mat: THREE.Material, trash: Trash[], cast = false): THREE.InstancedMesh {
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(unit, mat, Math.max(1, list.length));
  const d = new THREE.Object3D();
  list.forEach((q, i) => {
    d.position.set(q.x, q.y, q.z);
    d.rotation.set(q.rx ?? 0, q.ry ?? 0, q.rz ?? 0);
    d.scale.set(q.sx, q.sy, q.sz);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
  });
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = cast;
  mesh.frustumCulled = false;
  trash.push(unit, { dispose: () => mesh.dispose() });
  return mesh;
}

/** A member from p to q, as an instanced box. */
function member(p: THREE.Vector3, q: THREE.Vector3, w: number): Inst {
  const d = new THREE.Vector3().subVectors(q, p);
  const len = d.length();
  const mid = new THREE.Vector3().addVectors(p, q).multiplyScalar(0.5);
  // Box long along local y, rotated onto p->q.
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  const e = new THREE.Euler().setFromQuaternion(quat);
  return { x: mid.x, y: mid.y, z: mid.z, sx: w, sy: len, sz: w, rx: e.x, ry: e.y, rz: e.z };
}

/** A plane facing a direction, sized w x h, centred at (x, y, z). */
function panel(w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, ry: number, trash: Trash[], rx = 0): THREE.Mesh {
  const g = new THREE.PlaneGeometry(w, h);
  trash.push(g);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, 0, 'YXZ');
  return m;
}

export function buildKingdom(template: StadiumTemplate, shadows: boolean): { object: THREE.Object3D; disposables: Trash[] } {
  const group = new THREE.Group();
  group.name = 'kingdom-arena';
  const trash: Trash[] = [];
  const F = kingdomFrame(template);
  const { a, b } = template.plan;
  const { X, Z_S, Z_N, HIGH_X, CEIL_HIGH, CEIL_LOW } = F;
  const W = Z_N - Z_S;
  const zMid = (Z_N + Z_S) / 2;

  // ---- materials ------------------------------------------------------------
  const wallIn = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.92, metalness: 0.15 });
  const ceilIn = new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.95, metalness: 0.1 });
  // Dark steel, but the photographs show every member: the floods' spill catches it.
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a4f58, emissive: 0x15171b, roughness: 0.55, metalness: 0.55 });
  const steelLight = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.55, metalness: 0.6 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.95 });
  const starMat = new THREE.MeshBasicMaterial({ color: 0xf4f6ff });
  const duct = new THREE.MeshStandardMaterial({ color: 0x3b3e44, roughness: 0.5, metalness: 0.7 });
  trash.push(wallIn, ceilIn, steel, steelLight, floorMat, starMat, duct);

  // ---- the hall: floor, walls, ceilings ---------------------------------------
  // Floor round the pitch (the pitch and its run-off are drawn over it).
  const floor = panel(2 * X, W, floorMat, 0, -0.03, zMid, 0, trash, -Math.PI / 2);
  floor.receiveShadow = shadows;
  group.add(floor);
  // Inside walls, facing in: the long walls full height of the high section,
  // the end walls up to the wings' ceiling.
  group.add(panel(2 * X, CEIL_HIGH, wallIn, 0, CEIL_HIGH / 2, Z_N, Math.PI, trash));
  group.add(panel(2 * X, CEIL_HIGH, wallIn, 0, CEIL_HIGH / 2, Z_S, 0, trash));
  group.add(panel(W, CEIL_LOW, wallIn, X, CEIL_LOW / 2, zMid, -Math.PI / 2, trash));
  group.add(panel(W, CEIL_LOW, wallIn, -X, CEIL_LOW / 2, zMid, Math.PI / 2, trash));
  // Ceilings, facing down: high over the middle, low over the wings.
  group.add(panel(2 * HIGH_X, W, ceilIn, 0, CEIL_HIGH, zMid, 0, trash, Math.PI / 2));
  for (const sx of [1, -1]) {
    const w = X - HIGH_X;
    group.add(panel(w, W, ceilIn, sx * (HIGH_X + w / 2), CEIL_LOW, zMid, 0, trash, Math.PI / 2));
    // The step between the two: a wall from the wings' ceiling up to the high one.
    group.add(panel(W, CEIL_HIGH - CEIL_LOW, wallIn, sx * HIGH_X, (CEIL_HIGH + CEIL_LOW) / 2, zMid, sx > 0 ? -Math.PI / 2 : Math.PI / 2, trash));
  }

  // ---- the ceiling's lights: a grid of small points over the high section ----
  const stars: Inst[] = [];
  const nx = Math.floor((2 * HIGH_X - 8) / 6);
  for (let i = 0; i <= nx; i++) {
    const x = -nx * 3 + i * 6;
    for (let z = Z_S + 4; z <= Z_N - 4; z += 6) {
      const k = ((Math.round(x) * 73856093) ^ (Math.round(z) * 19349663)) >>> 0;
      if (k % 9 === 0) continue;
      stars.push({ x: x + ((k % 7) - 3) * 0.3, y: CEIL_HIGH - 0.6, z: z + (((k >> 3) % 7) - 3) * 0.3, sx: 0.35, sy: 0.12, sz: 0.35 });
    }
  }
  for (const sx of [1, -1]) {
    for (let x = HIGH_X + 5; x <= X - 3; x += 7) {
      for (let z = Z_S + 5; z <= Z_N - 5; z += 7) stars.push({ x: sx * x, y: CEIL_LOW - 0.5, z, sx: 0.3, sy: 0.1, sz: 0.3 });
    }
  }
  group.add(instanced(stars, starMat, trash));

  // ---- roof steel ----------------------------------------------------------------
  const members: Inst[] = [];
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  // Cross trusses every 10 m, spanning the width of the hall.
  const lo = F.TRUSS_LO;
  const hi = F.TRUSS_HI;
  const crossXs: number[] = [];
  const nCross = Math.floor((2 * HIGH_X - 8) / 10);
  for (let k = 0; k <= nCross; k++) crossXs.push(-nCross * 5 + k * 10);
  for (const x of crossXs) {
    members.push(member(V(x, lo, Z_S), V(x, lo, Z_N), 0.7));
    members.push(member(V(x, hi, Z_S), V(x, hi, Z_N), 0.7));
    const step = 4.5;
    let up = true;
    for (let z = Z_S; z < Z_N - 0.1; z += step) {
      const z1 = Math.min(Z_N, z + step);
      members.push(member(V(x, lo, z), V(x, hi, z), 0.35));
      members.push(up ? member(V(x, lo, z), V(x, hi, z1), 0.3) : member(V(x, hi, z), V(x, lo, z1), 0.3));
      up = !up;
    }
  }
  // Two lighter trusses along the length, over the front of each side stand:
  // the floodlights hang from these.
  for (const z of [b + 3, -(b + 3)]) {
    const l2 = 29;
    const h2 = 33.5;
    members.push(member(V(-HIGH_X, l2, z), V(HIGH_X, l2, z), 0.5));
    members.push(member(V(-HIGH_X, h2, z), V(HIGH_X, h2, z), 0.5));
    let up = true;
    for (let x = -HIGH_X; x < HIGH_X - 0.1; x += 4) {
      members.push(member(V(x, l2, z), V(x, h2, z), 0.25));
      members.push(up ? member(V(x, l2, z), V(x + 4, h2, z), 0.22) : member(V(x, h2, z), V(x + 4, l2, z), 0.22));
      up = !up;
    }
    // Hangers up to the cross trusses.
    for (const x of crossXs) members.push(member(V(x, h2, z), V(x, lo, z), 0.18));
  }
  // The cross-braced truss walls where the high section steps down, over each end.
  for (const sx of [1, -1]) {
    const x = sx * (HIGH_X - 0.3);
    members.push(member(V(x, CEIL_LOW, Z_S), V(x, CEIL_LOW, Z_N), 0.6));
    members.push(member(V(x, CEIL_HIGH - 1, Z_S), V(x, CEIL_HIGH - 1, Z_N), 0.6));
    const step = 8;
    for (let z = Z_S; z < Z_N - 0.1; z += step) {
      const z1 = Math.min(Z_N, z + step);
      members.push(member(V(x, CEIL_LOW, z), V(x, CEIL_HIGH - 1, z), 0.45));
      members.push(member(V(x, CEIL_LOW, z), V(x, CEIL_HIGH - 1, z1), 0.3));
      members.push(member(V(x, CEIL_HIGH - 1, z), V(x, CEIL_LOW, z1), 0.3));
    }
    // A truss along the front of each end stand, carrying its screen and lamps.
    const xe = sx * (a + 3);
    for (const y of [CEIL_LOW - 4, CEIL_LOW - 0.5]) members.push(member(V(xe, y, Z_S), V(xe, y, Z_N), 0.45));
    for (let z = Z_S; z < Z_N - 0.1; z += 4) members.push(member(V(xe, CEIL_LOW - 4, z), V(xe, CEIL_LOW - 0.5, z + 4), 0.2));
  }
  group.add(instanced(members, steel, trash));
  // The air ducts, either side, along the length.
  const ductGeo = new THREE.CylinderGeometry(1.3, 1.3, 2 * HIGH_X - 4, 18, 1, true);
  trash.push(ductGeo);
  for (const z of [b + 12, -(b + 12)]) {
    const d = new THREE.Mesh(ductGeo, duct);
    d.rotation.z = Math.PI / 2;
    d.position.set(0, F.TRUSS_LO - 2.2, z);
    group.add(d);
  }

  // ---- the main stand: three floors of hospitality ---------------------------------
  const zFront = -(b + F.HOSP_FRONT); // the edge of the first terrace
  const zGlass = zFront - 2.2; // the glass line of the boxes
  const zBack = Z_S + 0.2;
  const half = F.HOSP_HALF;
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fbccc, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  const slabMat = new THREE.MeshStandardMaterial({ color: 0x1d2027, roughness: 0.8, metalness: 0.2 });
  const fasciaMat = new THREE.MeshStandardMaterial({ color: 0x101217, roughness: 0.6, metalness: 0.3 });
  const ribbonMat = new THREE.MeshStandardMaterial({ color: 0x0c1838, emissive: 0x2a5fd8, emissiveIntensity: 0.9, roughness: 0.4 });
  const ceilWarm = new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffe2b0, emissiveIntensity: 0.75, side: THREE.DoubleSide });
  trash.push(glassMat, slabMat, fasciaMat, ribbonMat, ceilWarm);
  const roomMats = F.HOSP_FLOORS.map((_, k) => {
    const tx = roomTexture(k + 3);
    tx.repeat.set(F.HOSP_FLOORS[k].balcony ? F.HOSP_BOXES : 12, 1);
    const m = new THREE.MeshStandardMaterial({ map: tx, emissive: 0xffffff, emissiveMap: tx, emissiveIntensity: 0.72, roughness: 0.8 });
    trash.push(tx, m);
    return m;
  });
  const posts: Inst[] = [];
  const chairs: Inst[] = [];
  const rails: Inst[] = [];
  F.HOSP_FLOORS.forEach((fl, k) => {
    const y0 = fl.y;
    const y1 = fl.y + fl.h;
    const glassZ = fl.balcony ? zGlass : zFront - 0.4;
    // Floor slab (and the terrace in front), its fascia, and a blue ribbon on the first.
    const slab = box3(2 * half, 0.35, Math.abs(zBack - zFront), slabMat, trash);
    slab.position.set(0, y0 - 0.17, (zBack + zFront) / 2);
    group.add(slab);
    const fascia = box3(2 * half, 0.7, 0.3, k === 0 ? ribbonMat : fasciaMat, trash);
    fascia.position.set(0, y0 - 0.35, zFront + 0.1);
    group.add(fascia);
    // The room's back wall (lit), ceiling, and glass front.
    group.add(panel(2 * half, fl.h, roomMats[k], 0, (y0 + y1) / 2, glassZ - 6, 0, trash));
    group.add(panel(2 * half, Math.abs(6), ceilWarm, 0, y1 - 0.02, glassZ - 3, 0, trash, Math.PI / 2));
    group.add(panel(2 * half, fl.h - 0.1, glassMat, 0, (y0 + y1) / 2, glassZ, 0, trash));
    // Mullions; a party wall between boxes on the box floors.
    const n = fl.balcony ? F.HOSP_BOXES : 40;
    for (let i = 0; i <= n; i++) {
      const x = -half + (2 * half * i) / n;
      posts.push({ x, y: (y0 + y1) / 2, z: glassZ, sx: fl.balcony ? 0.2 : 0.1, sy: fl.h, sz: 0.2 });
      if (fl.balcony) posts.push({ x, y: (y0 + y1) / 2, z: glassZ - 3, sx: 0.15, sy: fl.h, sz: 6 });
    }
    if (fl.balcony) {
      // Terrace: glass balustrade with a rail, two rows of padded seats per box.
      rails.push({ x: 0, y: y0 + 1.05, z: zFront + 0.05, sx: 2 * half, sy: 0.07, sz: 0.09 });
      for (let i = 0; i < F.HOSP_BOXES; i++) {
        const x0 = -half + (2 * half * i) / F.HOSP_BOXES + 0.8;
        const x1 = -half + (2 * half * (i + 1)) / F.HOSP_BOXES - 0.8;
        // Side screens between neighbouring terraces.
        posts.push({ x: x0 - 0.8, y: y0 + 0.6, z: (zFront + glassZ) / 2, sx: 0.08, sy: 1.2, sz: zFront - glassZ });
        for (let row = 0; row < 2; row++) {
          for (let x = x0; x <= x1; x += 0.75) {
            chairs.push({ x, y: y0 + 0.28 + row * 0.25, z: zFront - 0.6 - row * 0.9, sx: 0.56, sy: 0.5, sz: 0.55 });
          }
        }
      }
      group.add(panel(2 * half, 1.0, glassMat, 0, y0 + 0.5, zFront + 0.05, 0, trash));
    }
  });
  const lastFloor = F.HOSP_FLOORS[F.HOSP_FLOORS.length - 1];
  const topY = lastFloor.y + lastFloor.h;
  const topFascia = box3(2 * half + 0.4, 1.6, 0.4, fasciaMat, trash);
  topFascia.position.set(0, topY + 0.8, zFront - 0.4);
  group.add(topFascia);
  // The block's ends.
  for (const sx of [1, -1]) {
    const e = box3(0.6, topY + 1.6 - F.HOSP_FLOORS[0].y + 0.4, Math.abs(zBack - zFront), fasciaMat, trash);
    e.position.set(sx * (half + 0.3), (topY + 1.6 + F.HOSP_FLOORS[0].y - 0.4) / 2, (zBack + zFront) / 2);
    group.add(e);
  }
  const white = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5, metalness: 0.2 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x1f3d8f, roughness: 0.6 });
  trash.push(white, leather);
  group.add(instanced(posts, white, trash));
  group.add(instanced(rails, white, trash));
  group.add(instanced(chairs, leather, trash));

  // ---- the dugouts and the players' tunnel, in front of the main stand ---------------
  const zDug = -(34 + 4.2);
  const canopy = new THREE.MeshStandardMaterial({ color: 0xb8d4f2, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  const benchMat = new THREE.MeshStandardMaterial({ color: 0x2552b8, roughness: 0.5 });
  trash.push(canopy, benchMat);
  const shell = new THREE.CylinderGeometry(1.4, 1.4, 1, 20, 1, true, 0, Math.PI);
  trash.push(shell);
  for (const sx of [1, -1]) {
    const len = 13;
    const cx = sx * 13;
    const base = box3(len, 0.5, 2.4, benchMat, trash);
    base.position.set(cx, 0.25, zDug);
    group.add(base);
    const seats = box3(len - 0.4, 0.5, 0.7, benchMat, trash);
    seats.position.set(cx, 0.75, zDug - 0.6);
    group.add(seats);
    const c = new THREE.Mesh(shell, canopy);
    c.rotation.set(0, 0, Math.PI / 2);
    c.scale.set(1, len, 1);
    c.position.set(cx, 0.5, zDug);
    group.add(c);
  }
  // A telescopic tunnel from the stand to the touchline.
  const tunnelMat = new THREE.MeshStandardMaterial({ color: 0xdfe6f2, roughness: 0.5 });
  const tunnelMouth = new THREE.MeshStandardMaterial({ color: 0x0a1a3e, emissive: 0x1d4fbf, emissiveIntensity: 0.6 });
  trash.push(tunnelMat, tunnelMouth);
  // From the front of the stand (the plan curve, less half a row) to 4.5 m out.
  const tz0 = -(b - 0.3);
  const tunnel = box3(3.4, 2.8, 4.5, tunnelMat, trash);
  tunnel.position.set(0, 1.4, tz0 + 2.25);
  group.add(tunnel);
  const mouth = box3(2.6, 2.2, 0.1, tunnelMouth, trash);
  mouth.position.set(0, 1.2, tz0 + 4.55);
  group.add(mouth);

  // ---- an ambulance on standby in a corner, by the main stand -----------------------
  const amb = ambulance(trash);
  amb.position.set(-(a + 6), 0.02, -(b + 4));
  amb.rotation.y = -Math.PI / 4; // nose towards the pitch
  group.add(amb);

  // ---- outside -----------------------------------------------------------------------
  const clad = claddingTexture();
  // Lit from below after dark, as the building is on a match night.
  const cladMat = new THREE.MeshStandardMaterial({ map: clad, emissive: 0xffe2bd, emissiveMap: clad, emissiveIntensity: 0.32, roughness: 0.85, metalness: 0.05 });
  const glassTex = latticeGlassTexture();
  const glassOut = new THREE.MeshStandardMaterial({ map: glassTex, emissive: 0xffd9a8, emissiveMap: glassTex, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.5 });
  // White roofs; a little self-lit so they read as white from the air at night too.
  const roofOut = new THREE.MeshStandardMaterial({ color: 0xdedfdc, emissive: 0xdedfdc, emissiveIntensity: 0.16, roughness: 0.9 });
  const stone = new THREE.MeshStandardMaterial({ color: 0xd8c7ab, emissive: 0x5a4c3a, emissiveIntensity: 0.5, roughness: 0.9 });
  trash.push(clad, cladMat, glassTex, glassOut, roofOut, stone);
  const T = F.WALL;
  const XO = X + T;
  const ZSO = Z_S - T;
  const ZNO = Z_N + T;
  const WO = ZNO - ZSO;
  const H = F.ROOF_HIGH;
  const L = F.ROOF_LOW;
  // The tall middle block: perforated beige on all its outside faces.
  const tallX = HIGH_X + T;
  const repeat = (m: THREE.MeshStandardMaterial, w: number, h: number): THREE.MeshStandardMaterial => {
    const mm = m.clone();
    const tx = (m.map as THREE.Texture).clone();
    tx.needsUpdate = true;
    tx.repeat.set(w / 16, h / 16);
    mm.map = tx;
    if (mm.emissiveMap) mm.emissiveMap = tx;
    trash.push(mm, tx);
    return mm;
  };
  group.add(panel(2 * tallX, H, repeat(cladMat, 2 * tallX, H), 0, H / 2, ZSO, Math.PI, trash));
  group.add(panel(2 * tallX, H, repeat(cladMat, 2 * tallX, H), 0, H / 2, ZNO, 0, trash));
  for (const sx of [1, -1]) {
    // Where the tall block rises out of the wings' roof.
    group.add(panel(WO, H - L, repeat(cladMat, WO, H - L), sx * tallX, (H + L) / 2, (ZSO + ZNO) / 2, sx > 0 ? Math.PI / 2 : -Math.PI / 2, trash));
    // The wings: dark lattice glass on three sides, a white roof.
    const wx = sx * (tallX + (XO - tallX) / 2);
    const ww = XO - tallX;
    group.add(panel(ww, L, repeat(glassOut, ww, L), wx, L / 2, ZSO, Math.PI, trash));
    group.add(panel(ww, L, repeat(glassOut, ww, L), wx, L / 2, ZNO, 0, trash));
    group.add(panel(WO, L, repeat(glassOut, WO, L), sx * XO, L / 2, (ZSO + ZNO) / 2, sx > 0 ? Math.PI / 2 : -Math.PI / 2, trash));
    group.add(panel(ww, WO, roofOut, wx, L + 0.05, (ZSO + ZNO) / 2, 0, trash, -Math.PI / 2));
    // Stepped stone blocks at the outer corners of the main facade.
    for (let s = 0; s < 3; s++) {
      const h = 16 - s * 4.5;
      const blk = box3(12 - s * 3, h, 6 + s * 2.5, stone, trash);
      blk.position.set(sx * (XO - 8 - s * 1.5), h / 2, ZSO - 3 - s * 2.5 + 2.5);
      group.add(blk);
    }
  }
  group.add(panel(2 * tallX, WO, roofOut, 0, H + 0.05, (ZSO + ZNO) / 2, 0, trash, -Math.PI / 2));
  // Plant on the roofs: air handlers in rows, as the aerial photographs show.
  const plant: Inst[] = [];
  for (let i = -3; i <= 3; i++) {
    for (const zz of [-0.25, 0.05, 0.3]) plant.push({ x: i * 15, y: H + 1.3, z: zMid + zz * WO, sx: 8, sy: 2.6, sz: 5 });
  }
  for (const sx of [1, -1]) {
    for (const zz of [-0.3, 0, 0.3]) plant.push({ x: sx * (tallX + (XO - tallX) * 0.55), y: L + 1.1, z: zMid + zz * WO, sx: 10, sy: 2.2, sz: 6 });
  }
  const plantMat = new THREE.MeshStandardMaterial({ color: 0xb9bcbf, roughness: 0.7, metalness: 0.3 });
  trash.push(plantMat);
  group.add(instanced(plant, plantMat, trash));
  // The main entrance: two stone pylons with dark glass between, and lattice
  // glazing along the base of the tall block.
  for (const sx of [1, -1]) {
    const pyl = box3(12, 26, 5, stone, trash);
    pyl.position.set(sx * 9, 13, ZSO - 2.5);
    group.add(pyl);
  }
  group.add(panel(2 * tallX, 22, repeat(glassOut, 2 * tallX, 22), 0, 11, ZSO - 0.3, Math.PI, trash));

  return { object: group, disposables: trash };
}

function box3(w: number, h: number, d: number, mat: THREE.Material, trash: Trash[]): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  trash.push(g);
  return new THREE.Mesh(g, mat);
}
