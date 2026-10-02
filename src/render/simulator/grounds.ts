import * as THREE from 'three';
import type { RoofRun, Skin, StadiumTemplate, StandBuilding, StandGap, StandSide } from '../../core/types';
import { curveSampler } from '../../core/venueDetails';
import { alongOf, gapHalfPlanes, SIDE_U } from '../../core/standSpans';
import { subtractGaps } from './stands';

/**
 * The structures that make a real club ground that ground: its roofs, stand
 * by stand (TemplateSpec.roofs), its floodlight masts as built
 * (lighting.masts), and the buildings behind its stands (details.buildings).
 *
 * The Saudi grounds are a family. Three of them (the Al-Shabab, Ettifaq and
 * Al-Fateh grounds, all rebuilt by the Ministry of Sport in 2021-23) share
 * one look — white fabric vaults on steel ribs over single-tier stands, four
 * lattice masts behind the corners — and the 1970s and 80s sports cities
 * share another: a horseshoe of open terracing round a track and a separate
 * main stand under a sheet roof. So this is data-driven, the way the venue
 * details are: a ground describes its roofs and masts and gets them, and the
 * next ground of the same kind is a data entry.
 *
 * Everything here is shell. It never moves a seat.
 */

type Trash = { dispose(): void };
type Sampler = ReturnType<typeof curveSampler>;
type V3 = [number, number, number];

export interface GroundBuild {
  object: THREE.Group;
  disposables: Trash[];
}

/** One station along a run: its plan position at the back and front, and heights. */
interface Station {
  u: number;
  bx: number;
  bz: number;
  fx: number;
  fz: number;
  /** Underside height at the back and the front (with any arch). */
  by: number;
  fy: number;
  /** Along the run's side (for arches and clipping). */
  along: number;
  /** Arc length from the start of the run, measured on the back line. */
  s: number;
}

/** The u range of one side between along = from and along = to, on the line at offset r. */
function sideRange(at: Sampler, side: StandSide, r: number, from: number, to: number): [number, number] {
  const c = SIDE_U[side];
  const lo = c - 0.2;
  const hi = c + 0.2;
  // Along decreases with u on the north and west sides, increases on the south and east.
  const alongAt = (u: number): number => {
    const q = at(u, r);
    return alongOf(side, q.x, q.z);
  };
  const solve = (target: number): number => {
    let a = lo;
    let b = hi;
    const fa = alongAt(a) - target;
    for (let i = 0; i < 50; i++) {
      const m = (a + b) / 2;
      const fm = alongAt(m) - target;
      if ((fm >= 0) === (fa >= 0)) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  // Clamp the targets to what the quarter actually spans.
  const span = [alongAt(lo), alongAt(hi)];
  const mn = Math.min(...span) + 0.01;
  const mx = Math.max(...span) - 0.01;
  const u0 = solve(Math.max(mn, Math.min(mx, from)));
  const u1 = solve(Math.max(mn, Math.min(mx, to)));
  return u0 < u1 ? [u0, u1] : [u1, u0];
}

/**
 * A sampler along one straight side (TierSpec.straight): u runs 0..1 from
 * along = from to along = to, and the offset is out from the plan's side line.
 */
function straightSampler(template: StadiumTemplate, side: StandSide, from: number, to: number): Sampler {
  const { a, b } = template.plan;
  return (u: number, off: number) => {
    const along = from + (to - from) * u;
    if (side === 'north') return { x: along, z: b + off, nx: 0, nz: 1 };
    if (side === 'south') return { x: along, z: -(b + off), nx: 0, nz: -1 };
    if (side === 'east') return { x: a + off, z: along, nx: 1, nz: 0 };
    return { x: -(a + off), z: along, nx: -1, nz: 0 };
  };
}

/** Stations along a run, `step` metres apart on its back line. */
function stations(at: Sampler, run: RoofRun, step: number): Station[] {
  let u0 = 0;
  let u1 = 1;
  if (run.side && !run.straight) [u0, u1] = sideRange(at, run.side, run.back, run.from ?? -1e4, run.to ?? 1e4);
  // Arc length of the back line over [u0, u1].
  const N = 2000;
  const cum: number[] = [0];
  let prev = at(u0, run.back);
  for (let i = 1; i <= N; i++) {
    const q = at(u0 + ((u1 - u0) * i) / N, run.back);
    cum.push(cum[i - 1] + Math.hypot(q.x - prev.x, q.z - prev.z));
    prev = q;
  }
  const L = cum[N];
  const count = Math.max(2, Math.round(L / step));
  const out: Station[] = [];
  const ring = !run.side;
  for (let k = 0; k <= count; k++) {
    if (ring && k === count) break;
    const target = (L * k) / count;
    let lo = 0;
    let hi = N;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (cum[m] <= target) lo = m;
      else hi = m - 1;
    }
    const f = lo < N ? (target - cum[lo]) / (cum[lo + 1] - cum[lo] || 1) : 0;
    const u = u0 + ((u1 - u0) * (lo + f)) / N;
    const b = at(u, run.back);
    const fr = at(u, run.front);
    const along = run.side ? alongOf(run.side, b.x, b.z) : 0;
    let lift = 0;
    if (run.arch) {
      // Over the middle of one side: measured along that side, on that side only.
      const ar = run.arch;
      const onSide = ar.side === 'north' ? b.z > 0 : ar.side === 'south' ? b.z < 0 : ar.side === 'east' ? b.x > 0 : b.x < 0;
      const al = alongOf(ar.side, b.x, b.z);
      const deep = ar.side === 'north' || ar.side === 'south' ? Math.abs(b.z) > Math.abs(b.x) * 0.3 : Math.abs(b.x) > Math.abs(b.z) * 0.3;
      if (onSide && deep && Math.abs(al) < ar.halfLength) lift = ar.rise * Math.cos((Math.PI / 2) * (al / ar.halfLength)) ** 2;
    }
    out.push({ u, bx: b.x, bz: b.z, fx: fr.x, fz: fr.z, by: run.backY + lift, fy: run.frontY + lift, along, s: target });
  }
  return out;
}

/** Is a plan point inside any of these gaps (a ring run's `omit`)? */
function inAnyGap(template: StadiumTemplate, gaps: StandGap[] | undefined, r: number, x: number, z: number): boolean {
  if (!gaps?.length) return false;
  return gaps.some((g) => gapHalfPlanes(g, template.plan, r).every((h) => h[0] * x + h[1] * z + h[2] >= 0));
}

/** A surface over the stations: rows of points from back (t=0) to front (t=1), with a lift per (station, t). */
function sheet(st: Station[], tSteps: number, lift: (i: number, t: number) => number, closed: boolean, under = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const n = st.length;
  for (let i = 0; i < n; i++) {
    const q = st[i];
    for (let j = 0; j <= tSteps; j++) {
      const t = j / tSteps;
      const x = q.bx + (q.fx - q.bx) * t;
      const z = q.bz + (q.fz - q.bz) * t;
      const y = q.by + (q.fy - q.by) * t + lift(i, t) - under;
      pos.push(x, y, z);
      uv.push(q.s, t);
    }
  }
  const row = tSteps + 1;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % n;
    for (let j = 0; j < tSteps; j++) {
      const a = i * row + j;
      const b = i1 * row + j;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Thin members as one instanced mesh: each a box from p to q with a cross-section. */
function members(list: { p: V3; q: V3; w: number; h?: number }[], mat: THREE.Material, trash: Trash[], cast: boolean): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  trash.push(geo);
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion();
  list.forEach((e, i) => {
    v.set(e.q[0] - e.p[0], e.q[1] - e.p[1], e.q[2] - e.p[2]);
    const len = v.length() || 1e-3;
    quat.setFromUnitVectors(up, v.clone().normalize());
    m.compose(new THREE.Vector3((e.p[0] + e.q[0]) / 2, (e.p[1] + e.q[1]) / 2, (e.p[2] + e.q[2]) / 2), quat, new THREE.Vector3(e.w, e.h ?? e.w, len));
    mesh.setMatrixAt(i, m);
  });
  mesh.count = list.length;
  mesh.castShadow = cast;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** The vaulted look of fabric seen from below: soft seams and a little shading across each bay. */
function fabricTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#d9d5cc');
  grad.addColorStop(0.5, '#fbfaf6');
  grad.addColorStop(1, '#d9d5cc');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(120,115,105,0.25)';
  g.lineWidth = 1;
  for (let y = 8; y < 64; y += 16) {
    g.beginPath();
    g.moveTo(0, y);
    g.quadraticCurveTo(32, y - 5, 64, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** A steel space truss seen from below: a square grid with its diagonals. */
function trussTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#d8d2c4';
  g.lineWidth = 5;
  g.strokeRect(2, 2, 124, 124);
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(128, 128);
  g.moveTo(128, 0);
  g.lineTo(0, 128);
  g.moveTo(64, 0);
  g.lineTo(64, 128);
  g.moveTo(0, 64);
  g.lineTo(128, 64);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Profiled sheet: light and dark ribs running down the slope. */
function sheetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 8;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 32; x++) {
    const v = 200 + Math.round(30 * Math.sin((x / 32) * Math.PI * 4));
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(x, 0, 1, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** One roof run. */
function buildRun(template: StadiumTemplate, run: RoofRun, at: Sampler, shadows: boolean, trash: Trash[]): THREE.Group {
  const grp = new THREE.Group();
  grp.name = `roof-${run.style}-${run.side ?? 'ring'}`;
  const bay = run.bay ?? (run.style === 'membrane' ? 7.5 : 8);
  // Several stations a bay, so the vaults are smooth.
  const sub = run.style === 'membrane' ? 6 : 1;
  if (run.straight && run.side) at = straightSampler(template, run.side, run.from ?? -50, run.to ?? 50);
  const st = stations(at, run, bay / sub);
  const ring = !run.side;
  const gaps = ring ? run.omit : undefined;
  const midR = (run.back + run.front) / 2;
  const cut = (g: THREE.BufferGeometry): THREE.BufferGeometry =>
    gaps?.length ? subtractGaps(g, gaps.map((gp) => gapHalfPlanes(gp, template.plan, midR))) : g;
  const keepAt = (q: { bx: number; bz: number }): boolean => !inAnyGap(template, gaps, run.back, q.bx, q.bz);
  const ribAt = (i: number): boolean => i % sub === 0 && keepAt(st[i]);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, cast = false): THREE.Mesh => {
    trash.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast && shadows;
    grp.add(m);
    return m;
  };
  const steel = new THREE.MeshStandardMaterial({ color: run.style === 'truss' ? (run.underColor ?? 0xe8e0cc) : 0xe9e9e6, roughness: 0.45, metalness: 0.2, emissive: run.style === 'truss' ? 0x5a5446 : 0x000000 });
  trash.push(steel);
  const memberList: { p: V3; q: V3; w: number; h?: number }[] = [];
  const depth = run.depth ?? (run.style === 'truss' ? 3.2 : run.style === 'membrane' ? 0.6 : 1.0);

  if (run.style === 'membrane') {
    // Fabric vaults between ribs: each bay arches up between its two ribs, and
    // its leading edge is scalloped up between them, which is what reads as a
    // fabric roof from the pitch.
    const vault = bay * 0.17;
    const lift = (i: number, t: number): number => {
      const s = (i % sub) / sub;
      const arch = Math.sin(Math.PI * s);
      return vault * arch * (1 - 0.35 * t) + (t > 0.85 ? (t - 0.85) / 0.15 * 0.5 * arch : 0);
    };
    const fab = fabricTexture();
    fab.repeat.set(1 / bay, 1);
    const top = new THREE.MeshStandardMaterial({ color: run.color ?? 0xf3f1ea, map: fab, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
    // Fabric is translucent: from below it glows with the daylight through it.
    const under = new THREE.MeshStandardMaterial({
      color: run.underColor ?? 0xf1ede4,
      map: fab,
      roughness: 0.9,
      emissive: 0xd8d0bd,
      emissiveIntensity: 0.55,
      emissiveMap: fab,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.97,
    });
    trash.push(fab, top, under);
    add(cut(sheet(st, 6, lift, ring)), top, true);
    add(cut(sheet(st, 6, lift, ring, 0.04)), under);
    // Ribs: a steel arch over each bay line from the back to the leading edge,
    // and a beam along the back.
    st.forEach((q, i) => {
      if (!ribAt(i)) return;
      const yb = q.by;
      const yf = q.fy;
      const mx = (q.bx + q.fx) / 2;
      const mz = (q.bz + q.fz) / 2;
      const peak = (yb + yf) / 2 + 0.6;
      memberList.push({ p: [q.bx, yb, q.bz], q: [mx, peak, mz], w: 0.32 });
      memberList.push({ p: [mx, peak, mz], q: [q.fx, yf, q.fz], w: 0.28 });
    });
  } else if (run.style === 'truss') {
    // A deep space truss: a dark deck on top, the truss grid seen from below,
    // a lattice fascia along the leading edge, and a truss on every bay line.
    // Roof sheeting on the truss: seen from below, through the truss, it is the lit ceiling.
    const deckMat = new THREE.MeshStandardMaterial({ color: run.color ?? 0x8f9196, roughness: 0.6, metalness: 0.25, emissive: run.underColor ?? 0xe6dfcf, emissiveIntensity: 0.28, side: THREE.DoubleSide });
    const tt = trussTexture();
    tt.repeat.set(1 / 4, 3);
    const gridMat = new THREE.MeshStandardMaterial({ color: run.underColor ?? 0xe6dfcf, map: tt, alphaTest: 0.35, transparent: false, roughness: 0.5, metalness: 0.2, emissive: 0x6a6252, emissiveIntensity: 0.6, emissiveMap: tt, side: THREE.DoubleSide });
    const ft = trussTexture();
    ft.repeat.set(1 / 4, 1);
    const faceMat = new THREE.MeshStandardMaterial({ color: run.underColor ?? 0xe6dfcf, map: ft, alphaTest: 0.35, roughness: 0.5, metalness: 0.2, emissive: 0x6a6252, emissiveIntensity: 0.5, emissiveMap: ft, side: THREE.DoubleSide });
    trash.push(deckMat, tt, gridMat, ft, faceMat);
    // The deck sits `depth` above the underside, a little lower at the front.
    const deck = sheet(st, 2, (_i, t) => depth * (1 - 0.35 * t), ring);
    add(cut(deck), deckMat, true);
    add(cut(sheet(st, 6, () => 0, ring)), gridMat);
    // Leading-edge face: from the underside up to the deck along the front line.
    const face: Station[] = st.map((q) => ({ ...q, bx: q.fx, bz: q.fz, by: q.fy, fy: q.fy + depth * 0.65 }));
    const fg = new THREE.BufferGeometry();
    {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      face.forEach((q, i) => {
        pos.push(q.bx, q.by, q.bz, q.bx, q.fy, q.bz);
        uv.push(q.s, 0, q.s, 1);
        if (i > 0) {
          const k = (i - 1) * 2;
          idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
        }
      });
      if (ring) {
        const k = (face.length - 1) * 2;
        idx.push(k, 0, k + 1, k + 1, 0, 1);
      }
      fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      fg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      fg.setIndex(idx);
      fg.computeVertexNormals();
    }
    add(cut(fg), faceMat);
    // A truss in every bay line: top and bottom chords and their diagonals.
    st.forEach((q, i) => {
      if (!ribAt(i)) return;
      const seg = 5;
      for (let k = 0; k < seg; k++) {
        const t0 = k / seg;
        const t1 = (k + 1) / seg;
        const P = (t: number, top: boolean): V3 => [
          q.bx + (q.fx - q.bx) * t,
          q.by + (q.fy - q.by) * t + (top ? depth * (1 - 0.35 * t) : 0),
          q.bz + (q.fz - q.bz) * t,
        ];
        memberList.push({ p: P(t0, false), q: P(t1, false), w: 0.22 });
        memberList.push({ p: P(t0, true), q: P(t1, true), w: 0.22 });
        memberList.push({ p: P(t0, false), q: P(t1, true), w: 0.14 });
        memberList.push({ p: P(t1, false), q: P(t1, true), w: 0.14 });
      }
    });
  } else {
    // Sheet or slab: a profiled (or plain) deck on cantilever beams.
    const tex = run.style === 'sheet' ? sheetTexture() : null;
    if (tex) tex.repeat.set(1 / 1.2, 1);
    const deckMat = new THREE.MeshStandardMaterial({ color: run.color ?? 0xd9dadc, map: tex, roughness: 0.55, metalness: 0.4, side: THREE.DoubleSide });
    const underMat = new THREE.MeshStandardMaterial({ color: run.underColor ?? 0xc9c9c6, map: tex, roughness: 0.8, metalness: 0.2, emissive: 0x2c2c2a, emissiveIntensity: 0.4, side: THREE.DoubleSide });
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
    trash.push(deckMat, underMat, edgeMat);
    if (tex) trash.push(tex);
    add(cut(sheet(st, 2, () => depth, ring)), deckMat, true);
    add(cut(sheet(st, 2, () => 0, ring)), underMat);
    // The fascia along the leading edge.
    const face = new THREE.BufferGeometry();
    const pos: number[] = [];
    const idx: number[] = [];
    st.forEach((q, i) => {
      pos.push(q.fx, q.fy - 0.2, q.fz, q.fx, q.fy + depth, q.fz);
      if (i > 0) {
        const k = (i - 1) * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    });
    face.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    face.setIndex(idx);
    face.computeVertexNormals();
    add(cut(face), edgeMat);
    // Cantilever beams under the deck on every bay line.
    st.forEach((q, i) => {
      if (!ribAt(i)) return;
      memberList.push({ p: [q.bx, q.by - 0.45, q.bz], q: [q.fx, q.fy - 0.25, q.fz], w: 0.3, h: 0.7 });
    });
  }

  // Columns at the back, from the ground to the roof.
  if (run.columns) {
    const colMat = new THREE.MeshStandardMaterial({ color: run.columns.color ?? 0xe8e6e0, roughness: 0.55, metalness: 0.2 });
    trash.push(colMat);
    const every = Math.max(1, Math.round((run.columns.every ?? bay) / (bay / sub)));
    const cols: { p: V3; q: V3; w: number; h?: number }[] = [];
    const colOff = run.columns.offset;
    st.forEach((q, i) => {
      if (i % every !== 0 || !keepAt(q)) return;
      const shape = run.columns!.shape ?? 'post';
      // At the column line (by default just behind the back line), and the
      // roof's underside height there.
      let ox = q.bx + (q.bx - q.fx) * 0.04;
      let oz = q.bz + (q.bz - q.fz) * 0.04;
      let oy = q.by;
      if (colOff !== undefined) {
        const f = (colOff - run.back) / (run.front - run.back);
        ox = q.bx + (q.fx - q.bx) * f;
        oz = q.bz + (q.fz - q.bz) * f;
        oy = q.by + (q.fy - q.by) * f;
      }
      q = { ...q, by: oy };
      if (shape === 'y') {
        // A Y: one leg up to a fork, two arms to the roof.
        const fork = q.by * 0.55;
        cols.push({ p: [ox, 0, oz], q: [ox, fork, oz], w: 0.9 });
        const dx = (q.fx - q.bx) * 0.08;
        const dz = (q.fz - q.bz) * 0.08;
        cols.push({ p: [ox, fork, oz], q: [ox + dx, q.by, oz + dz], w: 0.7 });
        cols.push({ p: [ox, fork, oz], q: [ox - dx * 0.6, q.by + depth * 0.6, oz - dz * 0.6], w: 0.7 });
      } else if (shape === 'raking') {
        const dx = (q.bx - q.fx) * 0.12;
        const dz = (q.bz - q.fz) * 0.12;
        cols.push({ p: [ox + dx, 0, oz + dz], q: [ox, q.by, oz], w: 0.6 });
      } else {
        cols.push({ p: [ox, 0, oz], q: [ox, q.by + 0.2, oz], w: 0.45 });
      }
    });
    grp.add(members(cols, colMat, trash, shadows));
  }

  // Lamps along the top of the leading edge.
  if (run.lights) {
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xbfc4cc, roughness: 0.4, metalness: 0.6, emissive: 0x1d2026 });
    trash.push(lampMat);
    const lamps: { p: V3; q: V3; w: number; h?: number }[] = [];
    let last = -1e9;
    st.forEach((q) => {
      if (!keepAt(q) || q.s - last < run.lights!.every) return;
      last = q.s;
      const x = q.fx + (q.bx - q.fx) * 0.08;
      const z = q.fz + (q.bz - q.fz) * 0.08;
      const y = Math.max(run.lights!.y, q.fy + depth);
      // A frame of three lamp heads on a short rail.
      const tx = -(q.fz - q.bz);
      const tz = q.fx - q.bx;
      const tl = Math.hypot(tx, tz) || 1;
      for (const k of [-1, 0, 1]) {
        const px = x + (tx / tl) * k * 0.9;
        const pz = z + (tz / tl) * k * 0.9;
        lamps.push({ p: [px, y, pz], q: [px + (q.fx - q.bx) * 0.012, y + 0.7, pz + (q.fz - q.bz) * 0.012], w: 0.75 });
      }
      lamps.push({ p: [x, q.fy + depth * 0.65, z], q: [x, y, z], w: 0.12 });
    });
    grp.add(members(lamps, lampMat, trash, false));
  }

  if (memberList.length) grp.add(members(memberList, steel, trash, shadows));
  return grp;
}

/** A lattice mast with a lamp head, standing day and night. */
function buildMasts(template: StadiumTemplate, trash: Trash[], shadows: boolean): THREE.Group | null {
  const spec = template.lighting?.masts;
  if (!spec?.style) return null;
  const grp = new THREE.Group();
  grp.name = 'masts';
  const at = spec.at.length >= 4 ? spec.at : spec.at.flatMap(([x, z]) => [[x, z], [-x, z], [x, -z], [-x, -z]] as [number, number][]);
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.5, metalness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.5, metalness: 0.5 });
  trash.push(steel, headMat);
  const list: { p: V3; q: V3; w: number; h?: number }[] = [];
  const heads: { p: V3; q: V3; w: number; h?: number }[] = [];
  for (const [x, z] of at) {
    const H = Math.max(spec.height, Math.hypot(x, z) * Math.tan((25 * Math.PI) / 180) + 0.5);
    if (spec.style === 'lattice') {
      // Three legs tapering up, with cross-bracing.
      const base = 1.6;
      const topW = 0.7;
      const legs = [0, 1, 2].map((k) => (k / 3) * Math.PI * 2);
      const legAt = (k: number, y: number): V3 => {
        const r = base + (topW - base) * (y / H);
        return [x + Math.cos(legs[k]) * r, y, z + Math.sin(legs[k]) * r];
      };
      for (let k = 0; k < 3; k++) list.push({ p: legAt(k, 0), q: legAt(k, H - 2), w: 0.22 });
      for (let y = 0; y < H - 4; y += 3) {
        for (let k = 0; k < 3; k++) {
          list.push({ p: legAt(k, y), q: legAt((k + 1) % 3, y + 3), w: 0.08 });
          list.push({ p: legAt(k, y + 3), q: legAt((k + 1) % 3, y + 3), w: 0.08 });
        }
      }
    } else {
      list.push({ p: [x, 0, z], q: [x, H - 2, z], w: 1.2 });
    }
    // The head: a frame of lamps tilted toward the pitch, facing the centre spot.
    const L = Math.hypot(x, z) || 1;
    const ix = -x / L;
    const iz = -z / L;
    const tx = -iz;
    const tz = ix;
    const W = 11;
    const tilt = spec.head === 'tilted' ? 2.2 : 0;
    for (let row = 0; row < 3; row++) {
      const y = H - 1 + row * 1.25;
      const back = row * 0.35 + tilt * (row / 3);
      heads.push({ p: [x - tx * W / 2 - ix * back, y, z - tz * W / 2 - iz * back], q: [x + tx * W / 2 - ix * back, y, z + tz * W / 2 - iz * back], w: 0.7, h: 1.0 });
    }
    heads.push({ p: [x - tx * W / 2, H - 1.8, z - tz * W / 2], q: [x + tx * W / 2, H - 1.8, z + tz * W / 2], w: 0.25 });
  }
  grp.add(members(list, steel, trash, shadows));
  grp.add(members(heads, headMat, trash, shadows));
  return grp;
}

/** A building behind a stand: solid below, glazed floors at the top on the pitch side, a fascia. */
function buildBuilding(template: StadiumTemplate, b: StandBuilding, at: Sampler, trash: Trash[], shadows: boolean): THREE.Group {
  const grp = new THREE.Group();
  grp.name = `building-${b.side}`;
  const c = b.center ?? 0;
  let u0 = 0;
  let u1 = 1;
  if (b.straight) at = straightSampler(template, b.side, c - b.halfLength, c + b.halfLength);
  else [u0, u1] = sideRange(at, b.side, b.front, c - b.halfLength, c + b.halfLength);
  const p0 = at(u0, b.front);
  const p1 = at(u1, b.front);
  const lengthM = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const N = Math.max(8, Math.round(lengthM / 2));
  const wall = new THREE.MeshStandardMaterial({ color: b.color ?? 0xe7e1d4, roughness: 0.8, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({ color: 0x6d8ca3, roughness: 0.12, metalness: 0.35, emissive: 0x5a4a30, emissiveIntensity: 0.5, side: THREE.DoubleSide });
  const fascia = new THREE.MeshStandardMaterial({ color: b.fascia ?? b.color ?? 0xe7e1d4, roughness: 0.6, side: THREE.DoubleSide });
  trash.push(wall, glass, fascia);
  const strip = (r: number, y0: number, y1: number): THREE.BufferGeometry => {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const q = at(u0 + ((u1 - u0) * i) / N, r);
      pos.push(q.x, y0, q.z, q.x, y1, q.z);
      if (i > 0) {
        const k = (i - 1) * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    trash.push(g);
    return g;
  };
  const flat = (r0: number, r1: number, y: number): THREE.BufferGeometry => {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const u = u0 + ((u1 - u0) * i) / N;
      const p = at(u, r0);
      const q = at(u, r1);
      pos.push(p.x, y, p.z, q.x, y, q.z);
      if (i > 0) {
        const k = (i - 1) * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    trash.push(g);
    return g;
  };
  const glassH = (b.glassFloors ?? 0) * 3.6;
  const gy = b.y1 - 1.2 - glassH;
  const front = (y0: number, y1: number, m: THREE.Material): void => {
    if (y1 - y0 > 0.05) grp.add(new THREE.Mesh(strip(b.front, y0, y1), m));
  };
  front(b.y0, Math.max(b.y0, gy), wall);
  if (glassH > 0) front(gy, gy + glassH, glass);
  front(Math.max(b.y0, gy + glassH), b.y1, fascia);
  grp.add(new THREE.Mesh(strip(b.front + b.depth, b.y0, b.y1), wall));
  grp.add(new THREE.Mesh(flat(b.front, b.front + b.depth, b.y1), wall));
  grp.add(new THREE.Mesh(flat(b.front, b.front + b.depth, b.y0), wall));
  // The ends.
  for (const u of [u0, u1]) {
    const p = at(u, b.front);
    const q = at(u, b.front + b.depth);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([p.x, b.y0, p.z, q.x, b.y0, q.z, p.x, b.y1, p.z, q.x, b.y1, q.z], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    g.computeVertexNormals();
    trash.push(g);
    grp.add(new THREE.Mesh(g, wall));
  }
  // Mullions on the glass.
  if (glassH > 0) {
    const mull = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.5, metalness: 0.4 });
    trash.push(mull);
    const list: { p: V3; q: V3; w: number; h?: number }[] = [];
    const count = Math.round(lengthM / 1.6);
    for (let i = 0; i <= count; i++) {
      const q = at(u0 + ((u1 - u0) * i) / count, b.front - 0.03);
      list.push({ p: [q.x, gy, q.z], q: [q.x, gy + glassH, q.z], w: 0.09 });
    }
    for (let f = 0; f <= (b.glassFloors ?? 0); f++) {
      const y = gy + f * 3.6;
      const p = at(u0, b.front - 0.03);
      const q = at(u1, b.front - 0.03);
      // Straight sides only — a transom between the two ends.
      list.push({ p: [p.x, y, p.z], q: [q.x, y, q.z], w: 0.16 });
    }
    grp.add(members(list, mull, trash, false));
  }
  grp.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = shadows;
      m.receiveShadow = shadows;
    }
  });
  return grp;
}

/** The pattern of a skin: holes, slats or panel joints, as a repeating tile. */
function skinTexture(pattern: Skin['pattern']): THREE.CanvasTexture | null {
  if (!pattern || pattern === 'solid') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  if (pattern === 'perforated') {
    // Vertical panels with a seam, and a fine grid of holes that reads as a
    // sheen from a distance.
    for (let x = 0; x < 64; x++) {
      const v = 235 + Math.round(18 * Math.sin((x / 64) * Math.PI * 2));
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, 0, 1, 64);
    }
    g.fillStyle = '#8a8070';
    g.fillRect(0, 0, 2, 64);
    g.fillStyle = 'rgba(70,60,48,0.55)';
    for (let y = 2; y < 64; y += 4) for (let x = (y / 4) % 2 ? 2 : 4; x < 64; x += 4) g.fillRect(x, y, 1.6, 1.6);
  } else if (pattern === 'slats') {
    for (let x = 0; x < 64; x += 8) {
      g.fillStyle = '#9a948a';
      g.fillRect(x, 0, 3, 64);
    }
  } else {
    g.strokeStyle = '#8a857c';
    g.lineWidth = 2;
    g.strokeRect(1, 1, 62, 62);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildSkin(template: StadiumTemplate, sk: Skin, at: Sampler, trash: Trash[], shadows: boolean): THREE.Mesh {
  let u0 = 0;
  let u1 = 1;
  if (sk.side && sk.straight) at = straightSampler(template, sk.side, sk.from ?? -50, sk.to ?? 50);
  else if (sk.side) [u0, u1] = sideRange(at, sk.side, sk.offset, sk.from ?? -1e4, sk.to ?? 1e4);
  const N = Math.max(16, Math.round((u1 - u0) * 900));
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let sAcc = 0;
  let prev = at(u0, sk.offset);
  const keep: boolean[] = [];
  for (let i = 0; i <= N; i++) {
    const q = at(u0 + ((u1 - u0) * i) / N, sk.offset);
    sAcc += Math.hypot(q.x - prev.x, q.z - prev.z);
    prev = q;
    pos.push(q.x, sk.y0, q.z, q.x, sk.y1, q.z);
    uv.push(sAcc / 4, 0, sAcc / 4, (sk.y1 - sk.y0) / 4);
    // A ring skin stops where its gaps are (a main stand's own building, say).
    keep.push(sk.side ? true : !inAnyGap(template, sk.omit, sk.offset, q.x, q.z));
    if (i > 0 && keep[i] && keep[i - 1]) {
      const k = (i - 1) * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const tex = skinTexture(sk.pattern);
  const mat = new THREE.MeshStandardMaterial({
    color: sk.color,
    map: tex,
    roughness: 0.7,
    metalness: sk.pattern === 'perforated' ? 0.45 : 0.05,
    side: THREE.DoubleSide,
    emissive: sk.glow ? sk.color : 0x000000,
    emissiveIntensity: sk.glow ?? 0,
    emissiveMap: sk.glow ? tex : null,
  });
  trash.push(g, mat);
  if (tex) trash.push(tex);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  m.name = 'skin';
  return m;
}

/** Everything this file draws for one ground; an empty group for a ground without any of it. */
export function buildGround(template: StadiumTemplate, shadows: boolean): GroundBuild {
  const group = new THREE.Group();
  group.name = 'ground';
  const trash: Trash[] = [];
  const at = curveSampler(template);
  for (const run of template.roofs ?? []) group.add(buildRun(template, run, at, shadows, trash));
  const masts = buildMasts(template, trash, shadows);
  if (masts) group.add(masts);
  for (const b of template.details?.buildings ?? []) group.add(buildBuilding(template, b, at, trash, shadows));
  for (const sk of template.details?.skins ?? []) group.add(buildSkin(template, sk, at, trash, shadows));
  return { object: group, disposables: trash };
}

