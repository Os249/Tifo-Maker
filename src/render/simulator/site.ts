/// <reference types="vite/client" />
import * as THREE from 'three';
import type { SiteSpec, StadiumTemplate } from '../../core/types';

/**
 * The real neighbourhood round a real ground: its streets, car parks and the
 * cars in them, the buildings next door, the training pitches, the palms and
 * the street lights, and beyond them a horizon of the right kind (a low-rise
 * city, mountains, palm groves or desert).
 *
 * The streets, buildings and open spaces come from OpenStreetMap
 * (© OpenStreetMap contributors, ODbL), turned into the template's own frame
 * by scripts/site-import.mts, which also fills residential streets the map
 * shows without houses with the walled villas they are lined with. Each file
 * is its own chunk, fetched when the ground is opened.
 *
 * Everything is merged into a handful of meshes (one per material) or
 * instanced, so a neighbourhood of a thousand buildings is about twenty draw
 * calls.
 */

export interface SiteData {
  v: number;
  key: string;
  template: string;
  attribution: string;
  date: string;
  /** Radius of the mapped area, metres. */
  r: number;
  /** [class, width dm, x, z, x, z…] in decimetres. Classes: 0 motorway/trunk … 6 footway. */
  roads: number[][];
  /** [height dm, kind, x, z…]. Kinds: 0 generic, 1 mosque, 2 hall, 3 house, 4 office, 5 civic, 6 villa, 7 shed. */
  bld: number[][];
  /** Car parks: [x, z…]. */
  lots: number[][];
  /** [kind, x, z…]. Kinds: 0 grass, 1 football, 2 tennis, 3 court, 4 water, 5 sand, 6 plaza, 7 farm, 8 track, 9 basketball. */
  areas: number[][];
  /** Boundary walls: [x, z…]. */
  walls: number[][];
  /** Palms: x, z, x, z… */
  trees: number[];
}

const loaders = import.meta.glob<SiteData>('./sites/*.json', { import: 'default' });

/** The site file for a key, or null if there is none (or it fails to load). */
export async function loadSite(key: string): Promise<SiteData | null> {
  const f = loaders[`./sites/${key}.json`];
  if (!f) return null;
  try {
    return await f();
  } catch {
    return null;
  }
}

export interface SiteBuild {
  readonly object: THREE.Group;
  /** 0 by day … 1 at night: windows, street lights and their pools of light. */
  setNight(level: number): void;
  /** Is (x, z) open ground a fan could walk on (not inside a building or a wall)? */
  walkable(x: number, z: number): boolean;
  /** A random point on a road, pavement or car park (where fans come from), or null if there are none. */
  pavedPoint(rand: () => number): XZ | null;
  dispose(): void;
}

type XZ = [number, number];
type Trash = { dispose(): void };

const unflat = (a: number[], from = 0): XZ[] => {
  const out: XZ[] = [];
  for (let i = from; i + 1 < a.length; i += 2) out.push([a[i] / 10, a[i + 1] / 10]);
  return out;
};

function hash(x: number, z: number, k = 0): number {
  let h = Math.imul(Math.round(x * 7) ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(Math.round(z * 13) + k * 977, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function signedArea(p: XZ[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i];
    const [x1, z1] = p[(i + 1) % p.length];
    s += x0 * z1 - x1 * z0;
  }
  return s / 2;
}

function inPoly(x: number, z: number, p: XZ[]): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i];
    const [xj, zj] = p[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Principal axis of a polygon: unit vector along its longest direction. */
function axisOf(p: XZ[]): XZ {
  let best = 0;
  let ax: XZ = [1, 0];
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i];
    const [x1, z1] = p[(i + 1) % p.length];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L > best) {
      best = L;
      ax = [(x1 - x0) / L, (z1 - z0) / L];
    }
  }
  return ax;
}

/**
 * A training pitch seen from the stands or the air: mowing stripes across it,
 * the halfway line, the centre circle and both boxes. Only when the mapped
 * shape is close to a rectangle — a pitch drawn as a rough blob keeps its plain
 * colour and boundary line. Small pitches (five- and seven-a-side) scale the
 * markings with their length.
 */
function pitchDetail(m: Mesher, lines: Mesher, p: XZ[], y: number, white: THREE.Color): void {
  let A = axisOf(p);
  let B: XZ = [-A[1], A[0]];
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of p) {
    const s = x * A[0] + z * A[1];
    const t = x * B[0] + z * B[1];
    a0 = Math.min(a0, s); a1 = Math.max(a1, s); b0 = Math.min(b0, t); b1 = Math.max(b1, t);
  }
  if (b1 - b0 > a1 - a0) {
    [A, B] = [B, [-A[0], -A[1]]];
    [a0, a1, b0, b1] = [b0, b1, -a1, -a0];
  }
  const len = a1 - a0;
  const wid = b1 - b0;
  if (len < 28 || wid < 16 || Math.abs(signedArea(p)) < 0.85 * len * wid) return;
  const at = (s: number, t: number): XZ => [A[0] * s + B[0] * t, A[1] * s + B[1] * t];
  // Stripes, every other one lighter, across the length like a mown pitch.
  const n = Math.max(6, 2 * Math.round(len / 18));
  const light = new THREE.Color(0x45894c);
  for (let i = 1; i < n; i += 2) {
    const s0 = a0 + (len * i) / n;
    const s1 = a0 + (len * (i + 1)) / n;
    m.flat([at(s0, b0), at(s1, b0), at(s1, b1), at(s0, b1)], y + 0.003, light);
  }
  const ly = y + 0.008;
  const k = Math.min(1, len / 100);
  const mid = (a0 + a1) / 2;
  const cb = (b0 + b1) / 2;
  ribbon(lines, [at(mid, b0), at(mid, b1)], 0.07, ly, white, 10);
  const r = 9.15 * k;
  const circle: XZ[] = [];
  for (let i = 0; i <= 28; i++) circle.push(at(mid + r * Math.cos((i / 28) * Math.PI * 2), cb + r * Math.sin((i / 28) * Math.PI * 2)));
  ribbon(lines, circle, 0.07, ly, white, 10);
  const box = (d: number, w: number) => {
    const hw = Math.min(w, wid * 0.8) / 2;
    for (const [e, sg] of [[a0, 1], [a1, -1]] as const)
      ribbon(lines, [at(e, cb - hw), at(e + sg * d, cb - hw), at(e + sg * d, cb + hw), at(e, cb + hw)], 0.07, ly, white, 10);
  };
  box(16.5 * k, 40.3 * k);
  box(5.5 * k, 18.3 * k);
}

/** A growable set of triangles with positions, normals, UVs and colours. */
class Mesher {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** A flat polygon at height y, UV from (u, v) = uvOf(x, z). */
  flat(p: XZ[], y: number, c: THREE.Color, uvOf: (x: number, z: number) => [number, number] = (x, z) => [x / 8, z / 8]): void {
    if (p.length < 3) return;
    const ring = signedArea(p) < 0 ? p.slice().reverse() : p;
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []);
    } catch {
      return;
    }
    const base = this.pos.length / 3;
    for (const [x, z] of ring) {
      const [u, v] = uvOf(x, z);
      this.vert(x, y, z, 0, 1, 0, u, v, c);
    }
    // ShapeUtils winds counter-clockwise in (x, z); seen from +y that is
    // clockwise, so flip each triangle to face up.
    for (const [a, b, d] of tris) this.tri(base + a, base + d, base + b);
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Offsets of a polyline to either side, mitred, for a ribbon `half` wide. */
function ribbonSides(p: XZ[], half: number): { l: XZ[]; r: XZ[]; s: number[] } {
  const l: XZ[] = [];
  const r: XZ[] = [];
  const s: number[] = [];
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    const prev = p[Math.max(0, i - 1)];
    const next = p[Math.min(p.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L;
    dz /= L;
    let nx = -dz;
    let nz = dx;
    // Mitre: scale the offset at a bend, but not past twice the width.
    if (i > 0 && i < p.length - 1) {
      const ax = p[i][0] - prev[0];
      const az = p[i][1] - prev[1];
      const al = Math.hypot(ax, az) || 1;
      const anx = -az / al;
      const anz = ax / al;
      const cos = nx * anx + nz * anz;
      const k = Math.min(2, 1 / Math.max(0.5, cos));
      nx *= k;
      nz *= k;
    }
    if (i > 0) acc += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    l.push([p[i][0] + nx * half, p[i][1] + nz * half]);
    r.push([p[i][0] - nx * half, p[i][1] - nz * half]);
    s.push(acc);
  }
  return { l, r, s };
}

function ribbon(m: Mesher, p: XZ[], half: number, y: number, c: THREE.Color, vScale: number): void {
  const { l, r, s } = ribbonSides(p, half);
  let prev = -1;
  for (let i = 0; i < p.length; i++) {
    const a = m.vert(l[i][0], y, l[i][1], 0, 1, 0, 0, s[i] / vScale, c);
    m.vert(r[i][0], y, r[i][1], 0, 1, 0, 1, s[i] / vScale, c);
    // Wound so each strip faces up (+y): left, then on along the line.
    if (prev >= 0) m.quad(prev, a, a + 1, prev + 1);
    prev = a;
  }
}

// ---------------------------------------------------------------------------
// Textures

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, seed: number): void {
  const r = rng(seed);
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = (r() - 0.5) * amp;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/** A major road: asphalt, edge lines, and a dashed centre line (u across, v along every 12 m). */
function majorRoadTex(): THREE.CanvasTexture {
  return canvasTex(128, 128, (g) => {
    noise(g, 128, 128, [112, 113, 116], 16, 3);
    g.fillStyle = 'rgba(235,235,225,0.9)';
    g.fillRect(4, 0, 2, 128);
    g.fillRect(122, 0, 2, 128);
    g.fillRect(63, 0, 2, 44);
  });
}

function minorRoadTex(): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => noise(g, 64, 64, [122, 121, 120], 18, 5));
}

/** A car park: 2.6 m bays across rows of 5 m either side of a 6 m aisle (u along one bay, v across a 16 m module). */
function lotTex(): THREE.CanvasTexture {
  return canvasTex(64, 256, (g) => {
    noise(g, 64, 256, [118, 118, 120], 16, 9);
    g.fillStyle = 'rgba(236,236,228,0.85)';
    const row = (y0: number, y1: number) => g.fillRect(0, y0, 2, y1 - y0);
    row(0, 80);
    row(176, 256);
    g.fillRect(0, 79, 64, 2);
    g.fillRect(0, 175, 64, 2);
  });
}

/** A façade tile of 4 bays by 4 floors: plaster with windows; `lit` picks out windows with the light on. */
function facadeTex(lit: boolean, seed: number): THREE.CanvasTexture {
  return canvasTex(256, 256, (g) => {
    const r = rng(seed);
    if (lit) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 256, 256);
    } else noise(g, 256, 256, [236, 232, 224], 10, seed);
    for (let fy = 0; fy < 4; fy++)
      for (let bx = 0; bx < 4; bx++) {
        const x = bx * 64 + 18;
        const y = fy * 64 + 16;
        if (lit) {
          const on = r() < 0.42;
          g.fillStyle = on ? (r() < 0.5 ? '#ffd9a0' : '#f4efe4') : '#000';
          g.fillRect(x, y, 28, 30);
        } else {
          g.fillStyle = '#3c4654';
          g.fillRect(x, y, 28, 30);
          g.fillStyle = 'rgba(255,255,255,0.25)';
          g.fillRect(x, y, 28, 3);
          g.fillStyle = 'rgba(0,0,0,0.18)';
          g.fillRect(x - 2, y + 30, 32, 3);
        }
      }
  });
}

/** Corrugated sheet for halls and sheds. */
function sheetTex(): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => {
    noise(g, 64, 64, [228, 226, 220], 8, 11);
    for (let x = 0; x < 64; x += 8) {
      g.fillStyle = 'rgba(0,0,0,0.10)';
      g.fillRect(x, 0, 3, 64);
    }
  });
}

/**
 * Open ground: sand and gravel in drifts, so a plain of it does not read as a
 * flat colour. Tiles every 64 m; the colour comes from the material.
 */
export function groundTex(): THREE.CanvasTexture {
  return canvasTex(256, 256, (g) => {
    const r = rng(77);
    noise(g, 256, 256, [236, 236, 236], 22, 41);
    // Soft drifts, lighter and darker.
    for (let i = 0; i < 90; i++) {
      const x = r() * 256;
      const y = r() * 256;
      const rad = 10 + r() * 40;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      const light = r() < 0.5;
      grd.addColorStop(0, light ? 'rgba(255,255,255,0.10)' : 'rgba(120,110,95,0.10)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) {
        g.save();
        g.translate(dx, dy);
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        g.restore();
      }
    }
    // Tyre tracks and footpaths worn into it.
    g.strokeStyle = 'rgba(110,100,85,0.12)';
    g.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(r() * 256, 0);
      g.bezierCurveTo(r() * 256, 85, r() * 256, 170, r() * 256, 256);
      g.stroke();
    }
  });
}

/** A soft round pool of light (additive). */
function poolTex(): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    // Saudi streets are lit by white LED heads now, a little warm on the ground.
    grd.addColorStop(0, 'rgba(255,238,212,0.55)');
    grd.addColorStop(0.45, 'rgba(255,228,196,0.2)');
    grd.addColorStop(1, 'rgba(255,220,190,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
}

// ---------------------------------------------------------------------------
// Instanced shapes

/** A car: body and cabin, the cabin darker (it is mostly glass). Unit: metres, long axis along z. */
function carGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.8, 0.75, 4.5);
  body.translate(0, 0.62, 0);
  const cab = new THREE.BoxGeometry(1.6, 0.6, 2.4);
  cab.translate(0, 1.3, -0.15);
  const shade = (g: THREE.BufferGeometry, k: number) => {
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(k), 3));
  };
  shade(body, 1);
  shade(cab, 0.32);
  const g = mergeGeometries([body, cab]);
  body.dispose();
  cab.dispose();
  return g;
}

/** A date palm's crown: drooping fronds round the top of the trunk (unit: about 4 m across). */
function crownGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  const c = new THREE.Color(1, 1, 1);
  const N = 11;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + (i % 2) * 0.2;
    const up = i % 3 === 0 ? 0.55 : 0.15;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Three segments out and down, a tapering strip.
    const pts: [number, number, number][] = [
      [0, 0, 0.22],
      [1.1, 0.35 + up * 0.6, 0.36],
      [2.2, 0.2 + up * 0.5, 0.3],
      [3.1, -0.45 + up * 0.2, 0.05],
    ];
    let prev = -1;
    for (const [r, y, w] of pts) {
      const x = ca * r;
      const z = sa * r;
      const px = -sa * w;
      const pz = ca * w;
      const k = 0.75 + 0.25 * (r / 3.1);
      const cc = c.clone().multiplyScalar(k);
      const a0 = m.vert(x + px, y, z + pz, 0, 1, 0, 0, 0, cc);
      m.vert(x - px, y, z - pz, 0, 1, 0, 1, 0, cc);
      if (prev >= 0) m.quad(prev, a0, a0 + 1, prev + 1);
      prev = a0;
    }
  }
  return m.geometry();
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of parts) {
    const ng = g.index ? g : g;
    const p = ng.getAttribute('position');
    const n = ng.getAttribute('normal');
    const c = ng.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      col.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
    }
    const ix = ng.index;
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    else for (let i = 0; i < p.count; i++) idx.push(i + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

// ---------------------------------------------------------------------------

const AREA_COLOUR: number[] = [
  0x6d9447, // grass / park (irrigated, so properly green)
  0x377a40, // football pitch (artificial turf; its lighter stripes are drawn over it)
  0x2f6b9e, // tennis
  0x5b8c6a, // other court
  0x3d7896, // water
  0xd4bf98, // sand / bare / construction
  0xc4bcad, // paved plaza
  0x7c8c4c, // farm / orchard
  0xb5523a, // track
  0xc9763f, // basketball
];

const WALL_TINTS = [0xe7dcc3, 0xddcba7, 0xefe8da, 0xd8c4a3, 0xe3d6bf, 0xcfc2a8, 0xf2eee4, 0xd9c2a5];
const OFFICE_TINTS = [0xdfe3e6, 0xc7d2da, 0xe9e6df];
/** English streets: red and brown brick, a few rendered or pebble-dashed fronts. */
const UK_BRICK = [0x8f4a36, 0x9c5a43, 0x7f4433, 0xa86a50, 0x8a5240, 0x995e47, 0xb57b5f, 0x7a4b3c];
const UK_RENDER = [0xddd6c8, 0xe8e2d4, 0xcfc8b8];
/** Welsh slate and brown concrete tile. */
const UK_ROOF = [0x4b5058, 0x545960, 0x5e5650, 0x6a4c40, 0x43474e];

export function buildSite(_template: StadiumTemplate, spec: SiteSpec, data: SiteData, opts: { shadows: boolean; detail: 'low' | 'full' }): SiteBuild {
  const group = new THREE.Group();
  group.name = 'site';
  const trash: Trash[] = [];
  const own = <T extends Trash>(x: T): T => {
    trash.push(x);
    return x;
  };
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, cast = false): THREE.Mesh => {
    own(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = cast && opts.shadows;
    m.receiveShadow = opts.shadows;
    group.add(m);
    return m;
  };
  const C = (hex: number) => new THREE.Color(hex);
  const full = opts.detail === 'full';
  const uk = spec.style === 'uk';

  // ---- Open ground: grass, pitches, courts, water, sand, plazas ----
  {
    const m = new Mesher();
    const lines = new Mesher();
    const white = C(0xf2f2ec);
    for (const a of data.areas) {
      const kind = a[0];
      const p = unflat(a, 1);
      const y = kind === 0 || kind === 5 || kind === 7 ? 0.012 : 0.03;
      // Waste ground in an English city is weeds and gravel, not sand.
      m.flat(p, y, C(uk && kind === 5 ? 0x8b8b70 : AREA_COLOUR[kind] ?? AREA_COLOUR[0]));
      if (kind === 1) pitchDetail(m, lines, p, y, white);
      if (kind === 1 || kind === 2 || kind === 9) {
        // Its white boundary line.
        const ring = [...p, p[0]];
        ribbon(lines, ring, 0.08, y + 0.008, white, 10);
      }
    }
    if (!m.empty) add(m.geometry(), own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })), 'site-areas');
    if (!lines.empty) add(lines.geometry(), own(new THREE.MeshStandardMaterial({ color: 0xf4f4ee, roughness: 0.8 })), 'site-lines');
  }

  // ---- Roads, with pavements either side of the ones people live on ----
  const majorTex = own(majorRoadTex());
  const minorTex = own(minorRoadTex());
  const lightsAt: { x: number; z: number; nx: number; nz: number }[] = [];
  {
    const major = new Mesher();
    const minor = new Mesher();
    const pave = new Mesher();
    const kerb = C(0xb9b2a5);
    const asph = C(0xffffff);
    // Wider roads first, so a lane joining a main road is drawn under it.
    const order = data.roads.slice().sort((a, b) => b[0] - a[0]);
    for (const r of order) {
      const cls = r[0];
      const w = r[1] / 10;
      const p = unflat(r, 2);
      if (p.length < 2) continue;
      const y = 0.04 + (6 - cls) * 0.004;
      if (cls <= 4) ribbon(pave, p, w / 2 + 2.4, 0.026, kerb, 8);
      if (cls === 6) ribbon(pave, p, w / 2, 0.03, C(0xcbc3b4), 8);
      else ribbon(cls <= 3 ? major : minor, p, w / 2, y, asph, cls <= 3 ? 12 : 8);
      // Street lights down the main roads, both sides, every 32 m.
      if (cls <= 3) {
        let acc = 0;
        for (let i = 0; i + 1 < p.length; i++) {
          const [ax, az] = p[i];
          const [bx, bz] = p[i + 1];
          const L = Math.hypot(bx - ax, bz - az);
          const ux = (bx - ax) / (L || 1);
          const uz = (bz - az) / (L || 1);
          for (let s = (32 - (acc % 32)) % 32; s < L; s += 32) {
            const x = ax + ux * s;
            const z = az + uz * s;
            for (const side of [-1, 1]) {
              const nx = -uz * side;
              const nz = ux * side;
              lightsAt.push({ x: x + nx * (w / 2 + 1.0), z: z + nz * (w / 2 + 1.0), nx: -nx, nz: -nz });
            }
          }
          acc += L;
        }
      }
    }
    if (!pave.empty) add(pave.geometry(), own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 })), 'site-pavements');
    if (!major.empty) add(major.geometry(), own(new THREE.MeshStandardMaterial({ map: majorTex, roughness: 0.88 })), 'site-roads');
    if (!minor.empty) add(minor.geometry(), own(new THREE.MeshStandardMaterial({ map: minorTex, roughness: 0.9 })), 'site-lanes');
  }

  // ---- Car parks, and the cars in them ----
  const carSpots: { x: number; z: number; a: number }[] = [];
  {
    const m = new Mesher();
    const lt = own(lotTex());
    const r = rng(data.key.length * 7919 + data.lots.length);
    for (const lot of data.lots) {
      const p = unflat(lot);
      if (p.length < 3) continue;
      const [ax, az] = axisOf(p);
      const bx = -az;
      const bz = ax;
      // Lay the bays out from the polygon's own corner, along its longest side.
      let u0 = Infinity;
      let v0 = Infinity;
      let u1 = -Infinity;
      let v1 = -Infinity;
      for (const [x, z] of p) {
        const u = x * ax + z * az;
        const v = x * bx + z * bz;
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      m.flat(p, 0.035, C(0xffffff), (x, z) => [((x * ax + z * az) - u0) / 2.6, ((x * bx + z * bz) - v0) / 16]);
      // Rows at 2.5 m and 13.5 m into each 16 m module, a bay every 2.6 m.
      const fill = 0.72;
      for (let mv = v0; mv < v1; mv += 16) {
        for (const off of [2.5, 13.5]) {
          const v = mv + off;
          if (v + 2.3 > v1) continue;
          for (let u = u0 + 1.3; u + 1.3 < u1; u += 2.6) {
            const x = u * ax + v * bx;
            const z = u * az + v * bz;
            // The whole car inside the lot.
            const ok = [[-1, -2.3], [1, -2.3], [-1, 2.3], [1, 2.3]].every(([du, dv]) => inPoly(x + du * ax + dv * bx, z + du * az + dv * bz, p));
            if (!ok || r() > fill) continue;
            carSpots.push({ x, z, a: Math.atan2(bx, bz) + (r() < 0.5 ? 0 : Math.PI) });
          }
        }
      }
    }
    if (!m.empty) add(m.geometry(), own(new THREE.MeshStandardMaterial({ map: lt, roughness: 0.9 })), 'site-carparks');
  }
  if (full && carSpots.length) {
    const geo = own(carGeometry());
    const mat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }));
    const cars = new THREE.InstancedMesh(geo, mat, carSpots.length);
    cars.name = 'site-cars';
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    // Saudi car parks: mostly white, then silver, black, grey, a few colours.
    const paints: [number, number][] = [[0xf2f2ef, 0.42], [0xb9bcc0, 0.2], [0x1d1f23, 0.14], [0x6c7076, 0.1], [0x8a2323, 0.04], [0x2a3f6e, 0.04], [0xd3c3a0, 0.06]];
    carSpots.forEach((s, i) => {
      d.position.set(s.x, 0.04, s.z);
      d.rotation.set(0, s.a, 0);
      d.updateMatrix();
      cars.setMatrixAt(i, d.matrix);
      let k = hash(s.x, s.z, 3);
      let c = paints[0][0];
      for (const [hex, w] of paints) {
        if (k < w) {
          c = hex;
          break;
        }
        k -= w;
      }
      cars.setColorAt(i, col.set(c));
    });
    cars.instanceMatrix.needsUpdate = true;
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    group.add(cars);
  }

  // ---- Buildings ----
  const facade = own(facadeTex(false, 21));
  const facadeLit = own(facadeTex(true, 21));
  const sheet = own(sheetTex());
  const wallMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, map: facade, emissive: 0xffffff, emissiveMap: facadeLit, emissiveIntensity: 0, roughness: 0.85, side: THREE.DoubleSide }));
  const hallMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, map: sheet, roughness: 0.75, metalness: 0.15, side: THREE.DoubleSide }));
  const roofMat = own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  const occupied: XZ[][] = [];
  const clutter: { x: number; z: number; y: number; s: number }[] = [];
  const domes: { x: number; z: number; y: number; r: number; mx: number; mz: number; mh: number }[] = [];
  const spires: { x: number; z: number; y: number; w: number; u: XZ; k: number }[] = [];
  {
    const walls = new Mesher();
    const halls = new Mesher();
    const roofs = new Mesher();
    for (const b of data.bld) {
      const h = b[0] / 10;
      const kind = b[1];
      let p = unflat(b, 2);
      if (p.length < 3) continue;
      if (signedArea(p) < 0) p = p.slice().reverse();
      occupied.push(p);
      const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
      const cz = p.reduce((s, q) => s + q[1], 0) / p.length;
      const k = hash(cx, cz);
      const area = Math.abs(signedArea(p));
      let tint: THREE.Color;
      if (!uk) tint = C(kind === 4 ? OFFICE_TINTS[Math.floor(k * OFFICE_TINTS.length)] : WALL_TINTS[Math.floor(k * WALL_TINTS.length)]);
      else if (kind === 4 || (kind === 5 && h > 14)) tint = C(OFFICE_TINTS[Math.floor(k * OFFICE_TINTS.length)]);
      else if (kind === 0 && area > 900 && hash(cx, cz, 2) < 0.5) tint = C(UK_RENDER[Math.floor(k * UK_RENDER.length)]);
      else tint = C(UK_BRICK[Math.floor(k * UK_BRICK.length)]);
      if (uk && (kind === 2 || kind === 7)) tint = C([0x9aa0a6, 0x8d9399, 0xa9adb1, 0x7e868c][Math.floor(k * 4)]);
      const plain = kind === 2 || kind === 7;
      const m = plain ? halls : walls;
      // An English house, terrace or chapel: walls to the eaves and a pitched
      // roof along its long axis, ridge at the building's height.
      let gable: { u: XZ; v: XZ; u0: number; u1: number; v0: number; v1: number; eave: number } | null = null;
      if (uk && !plain && (kind === 3 || kind === 6 || kind === 8 || (kind === 0 && area < 420 && h <= 13))) {
        const u = axisOf(p);
        const v: XZ = [-u[1], u[0]];
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const [x, z] of p) {
          const a1 = x * u[0] + z * u[1];
          const b1 = x * v[0] + z * v[1];
          u0 = Math.min(u0, a1); u1 = Math.max(u1, a1); v0 = Math.min(v0, b1); v1 = Math.max(v1, b1);
        }
        const wide = v1 - v0;
        if (wide > 2.5 && wide < 18) gable = { u, v, u0, u1, v0, v1, eave: Math.max(2.6, h - Math.min(4.2, wide * 0.36)) };
      }
      const wallTop = gable ? gable.eave : h;
      // Walls, outward-facing (the polygon is counter-clockwise in x/z, so
      // the outward normal of edge a→b is (dz, −dx)). The roof sits 0.9 m
      // below the top: the parapet every flat roof here has.
      let acc = hash(cx, cz, 1) * 12.8;
      for (let i = 0; i < p.length; i++) {
        const [x0, z0] = p[i];
        const [x1, z1] = p[(i + 1) % p.length];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 0.05) continue;
        const nx = (z1 - z0) / L;
        const nz = -(x1 - x0) / L;
        const us = plain ? 8 : 12.8; // 4 bays of 3.2 m a tile
        const vs = plain ? 8 : 14; // 4 floors of 3.5 m a tile
        const a = m.vert(x0, 0, z0, nx, 0, nz, acc / us, 0, tint);
        m.vert(x1, 0, z1, nx, 0, nz, (acc + L) / us, 0, tint);
        m.vert(x1, wallTop, z1, nx, 0, nz, (acc + L) / us, wallTop / vs, tint);
        m.vert(x0, wallTop, z0, nx, 0, nz, acc / us, wallTop / vs, tint);
        m.quad(a, a + 1, a + 2, a + 3);
        acc += L;
      }
      if (gable) {
        // Two slopes from the eaves to the ridge, a little overhang, and the
        // gable triangles at the ends in the wall's brick.
        const { u, v, u0, u1, v0, v1, eave } = gable;
        const W = (a1: number, b1: number, y: number): [number, number, number] => [u[0] * a1 + v[0] * b1, y, u[1] * a1 + v[1] * b1];
        const o = 0.3;
        const vm = (v0 + v1) / 2;
        const rc = C(UK_ROOF[Math.floor(hash(cx, cz, 3) * UK_ROOF.length)]);
        const slope = (vEdge: number): void => {
          const e0 = W(u0 - o, vEdge, eave - 0.15);
          const e1 = W(u1 + o, vEdge, eave - 0.15);
          const r1 = W(u1 + o, vm, h);
          const r0 = W(u0 - o, vm, h);
          const nx = (e0[0] + e1[0]) / 2 - (r0[0] + r1[0]) / 2;
          const nz = (e0[2] + e1[2]) / 2 - (r0[2] + r1[2]) / 2;
          const nl = Math.hypot(nx, h - eave, nz) || 1;
          const ny = Math.abs(vEdge - vm) / nl;
          const a = roofs.vert(...e0, nx / nl, ny, nz / nl, 0, 0, rc);
          roofs.vert(...e1, nx / nl, ny, nz / nl, 1, 0, rc);
          roofs.vert(...r1, nx / nl, ny, nz / nl, 1, 1, rc);
          roofs.vert(...r0, nx / nl, ny, nz / nl, 0, 1, rc);
          roofs.quad(a, a + 1, a + 2, a + 3);
          roofs.quad(a, a + 3, a + 2, a + 1);
        };
        slope(v0 - o);
        slope(v1 + o);
        for (const ue of [u0, u1]) {
          const a = m.vert(...W(ue, v0, eave), 0, 1, 0, 0, eave / 14, tint);
          m.vert(...W(ue, v1, eave), 0, 1, 0, 1, eave / 14, tint);
          m.vert(...W(ue, vm, h), 0, 1, 0, 0.5, h / 14, tint);
          m.tri(a, a + 1, a + 2);
          m.tri(a, a + 2, a + 1);
        }
        if (kind === 8 && full) spires.push({ x: u[0] * u1 + v[0] * vm, z: u[1] * u1 + v[1] * vm, y: h, w: Math.min(7, (v1 - v0) * 0.7), u, k });
      } else {
        const roofC = uk && !plain ? C(0x5d5f63).lerp(tint, 0.15) : tint.clone().multiplyScalar(plain ? 0.92 : 0.86);
        roofs.flat(p, plain ? h : h - (uk ? 0.4 : 0.9), roofC);
      }
      // Mosque: a dome and a minaret.
      if (kind === 1) {
        let r = Infinity;
        for (let i = 0; i < p.length; i++) {
          const [x0, z0] = p[i];
          const [x1, z1] = p[(i + 1) % p.length];
          const L = Math.hypot(x1 - x0, z1 - z0) || 1;
          r = Math.min(r, Math.abs((x1 - x0) * (z0 - cz) - (x0 - cx) * (z1 - z0)) / L);
        }
        const [mx0, mz0] = p[0];
        const toC = Math.hypot(cx - mx0, cz - mz0) || 1;
        domes.push({ x: cx, z: cz, y: h - 0.9, r: Math.max(2.5, Math.min(9, r * 0.75)), mx: mx0 + ((cx - mx0) / toC) * 2.2, mz: mz0 + ((cz - mz0) / toC) * 2.2, mh: h + 12 + k * 8 });
      } else if (full && !plain && h < 20 && !uk) {
        // Air-conditioning units and water tanks on the roof.
        const n = 1 + Math.floor(k * 3);
        for (let i = 0; i < n; i++) {
          const t = hash(cx, cz, 10 + i);
          const s2 = hash(cx, cz, 20 + i);
          const x = cx + (t - 0.5) * 4;
          const z = cz + (s2 - 0.5) * 4;
          if (inPoly(x, z, p)) clutter.push({ x, z, y: h - 0.9, s: 0.8 + t * 0.7 });
        }
      }
    }
    if (!walls.empty) add(walls.geometry(), wallMat, 'site-buildings', true);
    if (!halls.empty) add(halls.geometry(), hallMat, 'site-halls', true);
    if (!roofs.empty) add(roofs.geometry(), roofMat, 'site-roofs');
  }
  if (domes.length) {
    const parts: THREE.BufferGeometry[] = [];
    for (const d of domes) {
      const dome = new THREE.SphereGeometry(d.r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.translate(d.x, d.y, d.z);
      const drum = new THREE.CylinderGeometry(d.r, d.r, 1.6, 16, 1, true);
      drum.translate(d.x, d.y + 0.2, d.z);
      const shaft = new THREE.CylinderGeometry(1.1, 1.4, d.mh, 8);
      shaft.translate(d.mx, d.mh / 2, d.mz);
      const balcony = new THREE.CylinderGeometry(1.9, 1.9, 0.6, 8);
      balcony.translate(d.mx, d.mh * 0.8, d.mz);
      const cap = new THREE.ConeGeometry(1.2, 3.2, 8);
      cap.translate(d.mx, d.mh + 1.6, d.mz);
      parts.push(dome, drum, shaft, balcony, cap);
    }
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    add(g, own(new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.6, vertexColors: true })), 'site-mosques', true);
  }
  if (spires.length) {
    // A church tower at the end of the nave, with a short spire on most.
    const parts: THREE.BufferGeometry[] = [];
    for (const t of spires) {
      const w = Math.max(3.5, t.w);
      const th = t.y + 8 + t.k * 10;
      const tower = new THREE.BoxGeometry(w, th, w);
      tower.translate(0, th / 2, 0);
      tower.rotateY(-Math.atan2(t.u[1], t.u[0]));
      tower.translate(t.x, 0, t.z);
      parts.push(tower);
      if (t.k > 0.35) {
        const sp = new THREE.ConeGeometry(w * 0.62, 6 + t.k * 12, 4);
        sp.rotateY(Math.PI / 4 - Math.atan2(t.u[1], t.u[0]));
        sp.translate(t.x, th + (6 + t.k * 12) / 2, t.z);
        parts.push(sp);
      }
    }
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    add(g, own(new THREE.MeshStandardMaterial({ color: 0x8b8378, roughness: 0.9, vertexColors: true })), 'site-mosques', true);
  }
  if (clutter.length) {
    const geo = own(new THREE.BoxGeometry(1.4, 1.1, 1.1));
    geo.translate(0, 0.55, 0);
    const units = new THREE.InstancedMesh(geo, own(new THREE.MeshStandardMaterial({ color: 0xcfd0cd, roughness: 0.6, metalness: 0.3 })), clutter.length);
    units.name = 'site-roof-units';
    const d = new THREE.Object3D();
    clutter.forEach((c, i) => {
      d.position.set(c.x, c.y, c.z);
      d.rotation.set(0, hash(c.x, c.z, 5) * Math.PI, 0);
      d.scale.setScalar(c.s);
      d.updateMatrix();
      units.setMatrixAt(i, d.matrix);
    });
    units.instanceMatrix.needsUpdate = true;
    group.add(units);
  }

  // ---- Boundary walls ----
  {
    const m = new Mesher();
    const c = C(uk ? 0x8a5543 : 0xd9cbb0);
    for (const w of data.walls) {
      const p = unflat(w);
      for (let i = 0; i + 1 < p.length; i++) {
        const [x0, z0] = p[i];
        const [x1, z1] = p[i + 1];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 0.2) continue;
        const nx = (z1 - z0) / L;
        const nz = -(x1 - x0) / L;
        const h = uk ? 1.6 : 2.8;
        const a = m.vert(x0, 0, z0, nx, 0, nz, 0, 0, c);
        m.vert(x1, 0, z1, nx, 0, nz, L / 4, 0, c);
        m.vert(x1, h, z1, nx, 0, nz, L / 4, h / 4, c);
        m.vert(x0, h, z0, nx, 0, nz, 0, h / 4, c);
        m.quad(a, a + 1, a + 2, a + 3);
      }
    }
    if (!m.empty) add(m.geometry(), own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide })), 'site-walls');
  }

  // ---- Palms ----
  const palms: XZ[] = [];
  for (let i = 0; i + 1 < data.trees.length; i += 2) palms.push([data.trees[i] / 10, data.trees[i + 1] / 10]);
  const shown = full ? palms : palms.filter((_, i) => i % 3 === 0);
  if (shown.length && uk) {
    // Broadleaf trees: a short trunk and a full, slightly lumpy crown, every
    // one a different size and shade of an early-autumn green.
    const trunkGeo = own(new THREE.CylinderGeometry(0.22, 0.34, 1, 6));
    trunkGeo.translate(0, 0.5, 0);
    const crownGeo = own(new THREE.IcosahedronGeometry(1, 1));
    {
      const pa = crownGeo.getAttribute('position');
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        const f = 0.86 + 0.28 * hash(x * 9, z * 9 + y * 5, 3);
        pa.setXYZ(i, x * f, y * f * 0.86, z * f);
      }
      crownGeo.computeVertexNormals();
    }
    const trunks = new THREE.InstancedMesh(trunkGeo, own(new THREE.MeshStandardMaterial({ color: 0x5b4a3c, roughness: 0.95 })), shown.length);
    const crowns = new THREE.InstancedMesh(crownGeo, own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true })), shown.length);
    trunks.name = 'site-palm-trunks';
    crowns.name = 'site-palm-crowns';
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    const SHADES = [0x4f6e34, 0x5b7a3a, 0x46652f, 0x6a8340, 0x587236, 0x7f8a3f, 0x8c7a3c];
    shown.forEach(([x, z], i) => {
      const h = 7 + hash(x, z, 7) * 9;
      const rad = 2.6 + hash(x, z, 9) * 2.6;
      d.position.set(x, 0, z);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, h * 0.55, 1);
      d.updateMatrix();
      trunks.setMatrixAt(i, d.matrix);
      d.position.set(x, h * 0.55 + rad * 0.75, z);
      d.rotation.set(0, hash(x, z, 8) * Math.PI * 2, 0);
      d.scale.set(rad, rad * (1.05 + hash(x, z, 5) * 0.3), rad);
      d.updateMatrix();
      crowns.setMatrixAt(i, d.matrix);
      crowns.setColorAt(i, col.set(SHADES[Math.floor(hash(x, z, 4) * SHADES.length)]));
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    trunks.castShadow = crowns.castShadow = opts.shadows;
    group.add(trunks, crowns);
  } else if (shown.length) {
    const trunkGeo = own(new THREE.CylinderGeometry(0.2, 0.32, 1, 6));
    trunkGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, own(new THREE.MeshStandardMaterial({ color: 0x8a7155, roughness: 0.95 })), shown.length);
    const crownGeo = own(crownGeometry());
    const crowns = new THREE.InstancedMesh(crownGeo, own(new THREE.MeshStandardMaterial({ color: 0x55823a, vertexColors: true, roughness: 0.8, side: THREE.DoubleSide })), shown.length);
    trunks.name = 'site-palm-trunks';
    crowns.name = 'site-palm-crowns';
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    shown.forEach(([x, z], i) => {
      const h = 6 + hash(x, z, 7) * 6;
      d.position.set(x, 0, z);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, h, 1);
      d.updateMatrix();
      trunks.setMatrixAt(i, d.matrix);
      d.position.set(x, h, z);
      d.rotation.set(0, hash(x, z, 8) * Math.PI * 2, 0);
      d.scale.setScalar(0.85 + hash(x, z, 9) * 0.4);
      d.updateMatrix();
      crowns.setMatrixAt(i, d.matrix);
      const g = 0.82 + hash(x, z, 4) * 0.3;
      crowns.setColorAt(i, col.setRGB(g, g * (0.95 + hash(x, z, 6) * 0.1), g * 0.85));
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    trunks.castShadow = crowns.castShadow = opts.shadows;
    group.add(trunks, crowns);
  }

  // ---- Street lights, and their pools of light at night ----
  let bulbMat: THREE.MeshStandardMaterial | null = null;
  let poolMat: THREE.MeshBasicMaterial | null = null;
  let pools: THREE.InstancedMesh | null = null;
  if (lightsAt.length) {
    const pole = new THREE.CylinderGeometry(0.09, 0.14, 10, 6);
    pole.translate(0, 5, 0);
    const arm = new THREE.BoxGeometry(0.1, 0.1, 1.8);
    arm.translate(0, 9.9, 0.9);
    const poleGeo = own(mergeGeometries([pole, arm]));
    pole.dispose();
    arm.dispose();
    const headGeo = own(new THREE.BoxGeometry(0.42, 0.16, 0.9));
    headGeo.translate(0, 9.8, 1.7);
    const poles = new THREE.InstancedMesh(poleGeo, own(new THREE.MeshStandardMaterial({ color: 0x8e9196, roughness: 0.5, metalness: 0.6, vertexColors: true })), lightsAt.length);
    bulbMat = own(new THREE.MeshStandardMaterial({ color: 0xf6f1e6, emissive: 0xffd49a, emissiveIntensity: 0 }));
    const heads = new THREE.InstancedMesh(headGeo, bulbMat, lightsAt.length);
    const poolGeo = own(new THREE.PlaneGeometry(11, 11));
    poolGeo.rotateX(-Math.PI / 2);
    poolMat = own(new THREE.MeshBasicMaterial({ map: own(poolTex()), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, lightsAt.length);
    pools = poolMesh;
    poolMesh.visible = false;
    poles.name = 'site-street-lights';
    heads.name = 'site-street-lamps';
    poolMesh.name = 'site-light-pools';
    const d = new THREE.Object3D();
    lightsAt.forEach((l, i) => {
      d.position.set(l.x, 0, l.z);
      d.rotation.set(0, Math.atan2(l.nx, l.nz), 0);
      d.updateMatrix();
      poles.setMatrixAt(i, d.matrix);
      heads.setMatrixAt(i, d.matrix);
      d.position.set(l.x + l.nx * 2.2, 0.07, l.z + l.nz * 2.2);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      poolMesh.setMatrixAt(i, d.matrix);
    });
    poles.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    poolMesh.instanceMatrix.needsUpdate = true;
    group.add(poles, heads, poolMesh);
  }

  // Where a fan can walk: not inside a building (a coarse grid, 2 m).
  const R = data.r;
  const G = Math.ceil((R * 2) / 2) + 2;
  const blocked = new Uint8Array(G * G);
  for (const p of occupied) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of p) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    for (let z = Math.floor(z0 / 2) * 2; z <= z1; z += 2)
      for (let x = Math.floor(x0 / 2) * 2; x <= x1; x += 2) {
        if (!inPoly(x + 1, z + 1, p)) continue;
        const i = Math.floor((x + R) / 2);
        const j = Math.floor((z + R) / 2);
        if (i >= 0 && j >= 0 && i < G && j < G) blocked[j * G + i] = 1;
      }
  }

  // Where fans come from: the roads, pavements and car parks (same grid).
  const pavedCells: number[] = [];
  {
    const seen = new Uint8Array(G * G);
    const mark = (x: number, z: number) => {
      const i = Math.floor((x + R) / 2);
      const j = Math.floor((z + R) / 2);
      if (i < 0 || j < 0 || i >= G || j >= G) return;
      const c = j * G + i;
      if (seen[c] || blocked[c]) return;
      seen[c] = 1;
      pavedCells.push(c);
    };
    for (const r of data.roads) {
      const half = r[1] / 20 + (r[0] <= 4 ? 2.4 : 0);
      const p = unflat(r, 2);
      for (let k = 0; k + 1 < p.length; k++) {
        const [ax, az] = p[k];
        const [bx, bz] = p[k + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const ux = (bx - ax) / (L || 1);
        const uz = (bz - az) / (L || 1);
        for (let t = 0; t <= L; t += 2) for (let o = -half; o <= half; o += 2) mark(ax + ux * t - uz * o, az + uz * t + ux * o);
      }
    }
    for (const lot of data.lots) {
      const p = unflat(lot);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of p) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let z = z0; z <= z1; z += 2) for (let x = x0; x <= x1; x += 2) if (inPoly(x, z, p)) mark(x, z);
    }
  }

  return {
    object: group,
    setNight(level: number): void {
      wallMat.emissiveIntensity = 0.95 * level;
      if (bulbMat) bulbMat.emissiveIntensity = 3.2 * level;
      if (poolMat && pools) {
        poolMat.opacity = 0.4 * level;
        pools.visible = level > 0.05;
      }
    },
    walkable(x: number, z: number): boolean {
      const i = Math.floor((x + R) / 2);
      const j = Math.floor((z + R) / 2);
      if (i < 0 || j < 0 || i >= G || j >= G) return true;
      return blocked[j * G + i] === 0;
    },
    pavedPoint(rand: () => number): XZ | null {
      if (!pavedCells.length) return null;
      const c = pavedCells[Math.floor(rand() * pavedCells.length)];
      return [(c % G) * 2 - R + rand() * 2, Math.floor(c / G) * 2 - R + rand() * 2];
    },
    dispose(): void {
      group.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      for (const t of trash) t.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// The horizon beyond the mapped neighbourhood.

export function buildHorizon(spec: SiteSpec, inner: number, tex: { facade: THREE.Texture; lit: THREE.Texture }): { object: THREE.Group; setNight(l: number): void; dispose(): void } {
  const uk = spec.style === 'uk';
  const group = new THREE.Group();
  group.name = 'site-horizon';
  const C = (hex: number) => new THREE.Color(hex);
  const trash: Trash[] = [];
  const r = rng(spec.key.length * 131 + inner);
  const kind = spec.horizon;

  // Low-rise city all round: two to five storeys, the odd tower.
  const towers = kind === 'city-towers' ? 0.08 : 0.02;
  const COUNT = kind === 'desert' ? 70 : kind === 'mountains' ? 160 : 260;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: false, color: 0xffffff, map: tex.facade, emissive: 0xffffff, emissiveMap: tex.lit, emissiveIntensity: 0, roughness: 0.9 });
  const city = new THREE.InstancedMesh(geo, mat, COUNT);
  city.name = 'site-horizon-city';
  const d = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    const ang = r() * Math.PI * 2;
    const rad = inner + 20 + Math.pow(r(), 0.7) * (kind === 'desert' ? 260 : 520);
    const tall = r() < towers;
    const h = tall ? 40 + r() * 70 : uk ? 7 + r() * 8 : 6 + r() * (kind === 'desert' ? 6 : 13);
    const w = tall ? 16 + r() * 14 : uk ? 8 + r() * 14 : 12 + r() * 30;
    const dd = tall ? 16 + r() * 14 : uk ? 30 + r() * 50 : 12 + r() * 30;
    d.position.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad);
    d.rotation.set(0, r() * Math.PI, 0);
    d.scale.set(w, h, dd);
    d.updateMatrix();
    city.setMatrixAt(i, d.matrix);
    city.setColorAt(i, col.set(uk ? (tall ? OFFICE_TINTS[Math.floor(r() * 3)] : UK_BRICK[Math.floor(r() * UK_BRICK.length)]) : WALL_TINTS[Math.floor(r() * WALL_TINTS.length)]));
  }
  city.instanceMatrix.needsUpdate = true;
  if (city.instanceColor) city.instanceColor.needsUpdate = true;
  group.add(city);
  trash.push(geo, mat);

  // An English skyline is half trees: clumps of them between the rooftops.
  if (uk) {
    const N = 700;
    const tg = new THREE.IcosahedronGeometry(1, 0);
    const tm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    const trees = new THREE.InstancedMesh(tg, tm, N);
    const SH = [0x4a6432, 0x56703a, 0x41592c, 0x667a3c];
    for (let i = 0; i < N; i++) {
      const ang = r() * Math.PI * 2;
      const rad = inner + 15 + Math.pow(r(), 0.8) * 560;
      const s1 = 4 + r() * 5;
      d.position.set(Math.cos(ang) * rad, s1 * 1.2, Math.sin(ang) * rad);
      d.rotation.set(0, r() * 6.28, 0);
      d.scale.set(s1 * (1 + r()), s1, s1 * (1 + r()));
      d.updateMatrix();
      trees.setMatrixAt(i, d.matrix);
      trees.setColorAt(i, col.set(SH[Math.floor(r() * SH.length)]));
    }
    trees.instanceMatrix.needsUpdate = true;
    if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
    trees.name = 'site-horizon-trees';
    group.add(trees);
    trash.push(tg, tm);
  }

  // Mountains (Abha's Asir highlands) or low hills (Tabuk, Majma'ah): a ring of
  // ridges far out. At two kilometres a ridge is mostly haze, so it is drawn
  // unlit, its rock already faded towards the sky (more at the foot, where the
  // air is thicker), and dimmed as the light goes.
  let ridgeMat: THREE.MeshBasicMaterial | null = null;
  if (kind === 'mountains' || kind === 'hills' || kind === 'desert') {
    const ring = new Mesher();
    const near = kind === 'mountains' ? 1300 : 1600;
    const top = kind === 'mountains' ? 420 : kind === 'hills' ? 140 : 60;
    const SEG = 160;
    const ridge = (a: number) => {
      // A sum of a few slow waves, never negative.
      const v = 0.55 + 0.25 * Math.sin(a * 3 + 1.3) + 0.15 * Math.sin(a * 7 + 0.4) + 0.08 * Math.sin(a * 17 + 2.2) + 0.05 * Math.sin(a * 31);
      return Math.max(0.05, v);
    };
    const rock = C(kind === 'mountains' ? 0x5f604a : 0xb09a74);
    const haze = C(0xbcd2e6);
    const foot = rock.clone().lerp(haze, kind === 'mountains' ? 0.62 : 0.55);
    const crest = rock.clone().lerp(haze, kind === 'mountains' ? 0.38 : 0.4);
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const h = ridge(a + (spec.key.length % 5)) * top;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const shade = 0.92 + 0.08 * Math.sin(a * 5 + 1);
      const iv = ring.vert(ca * near, -2, sa * near, -ca, 0.3, -sa, 0, 0, foot.clone().multiplyScalar(shade));
      ring.vert(ca * (near + 700), h, sa * (near + 700), -ca, 0.6, -sa, 0, 1, crest.clone().multiplyScalar(shade));
      if (i > 0) ring.quad(iv - 2, iv, iv + 1, iv - 1);
    }
    const g = ring.geometry();
    ridgeMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, ridgeMat);
    mesh.name = 'site-horizon-hills';
    group.add(mesh);
    trash.push(g, ridgeMat);
  }

  // Palm groves (the Al-Ahsa oasis): dense palms in the gaps of the city ring.
  if (kind === 'oasis') {
    const N = 900;
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 1, 5);
    trunkGeo.translate(0, 0.5, 0);
    const crownGeo = crownGeometry();
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x7d6650 }), N);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x4e7a34, side: THREE.DoubleSide }), N);
    for (let i = 0; i < N; i++) {
      const ang = r() * Math.PI * 2;
      const rad = inner + 40 + r() * 600;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      const h = 7 + r() * 6;
      d.position.set(x, 0, z);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, h, 1);
      d.updateMatrix();
      trunks.setMatrixAt(i, d.matrix);
      d.position.set(x, h, z);
      d.rotation.set(0, r() * 6.28, 0);
      d.scale.setScalar(0.9 + r() * 0.4);
      d.updateMatrix();
      crowns.setMatrixAt(i, d.matrix);
    }
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    group.add(trunks, crowns);
    trash.push(trunkGeo, crownGeo, trunks.material as THREE.Material, crowns.material as THREE.Material);
  }

  return {
    object: group,
    setNight(l: number): void {
      mat.emissiveIntensity = 0.8 * l;
      ridgeMat?.color.setScalar(1 - 0.88 * l);
    },
    dispose(): void {
      group.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      for (const t of trash) t.dispose();
    },
  };
}

/** The ground's own forecourt: paving round the outside of the bowl, out to `reach` + 14 m. */
export function forecourt(template: StadiumTemplate, reach: number, colour: number): THREE.Mesh {
  const { a, b, exponent: p } = template.plan;
  const A = a + reach + 14;
  const B = b + reach + 14;
  const e = Math.max(2, Math.min(p, 6));
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(new THREE.Vector2(A * Math.sign(c) * Math.abs(c) ** (2 / e), B * Math.sign(s) * Math.abs(s) ** (2 / e)));
  }
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.92, side: THREE.DoubleSide }));
  m.position.y = -0.04;
  m.name = 'site-forecourt';
  return m;
}
