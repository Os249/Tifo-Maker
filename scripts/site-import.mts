/**
 * Dev-only: turns the OpenStreetMap neighbourhood of a real ground into the
 * site file the Match Day simulator draws round it (src/render/simulator/site.ts).
 *
 *   npx tsx scripts/site-import.mts <raw.json> [<raw.json> ...]
 *     → src/render/simulator/sites/<key>.json
 *
 * A raw file is what scripts/site-export.js (run in a browser on
 * overpass-api.de) returns for one ground: the features within ~520 m, in
 * metres east and north of the pitch's centre spot, plus the bearing of the
 * main stand from it. This script:
 *
 *   - turns east/north into the template's own frame: the main stand is `south`
 *     (−z), so +z points across the pitch to the stand opposite, and +x is
 *     chosen so the frame is right-handed when seen from above (Y up), exactly
 *     as the stadium itself is built;
 *   - drops everything that is the stadium itself (its own pitch, stands,
 *     service roads under the roof) by cutting out the footprint the template
 *     draws, plus a margin;
 *   - simplifies lines and polygons and stores them in decimetres;
 *   - fills the residential streets the map has with the walled two- and
 *     three-storey villas a Saudi neighbourhood is made of, where the map has
 *     no buildings of its own (deterministic: the same input gives the same file).
 *
 * The data is © OpenStreetMap contributors, under the ODbL; the attribution is
 * kept in each file and shown with the Match Day credits.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { templateById } from '../src/core/stadiumCatalog';
import type { StadiumTemplate } from '../src/core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'src/render/simulator/sites');

type XZ = [number, number];
interface Raw {
  key: string;
  template: string;
  /** Bearing (degrees from north, clockwise) from the centre spot to the main stand. */
  main: number;
  /** Extra rotation, degrees, if the map's pitch is drawn a little off. */
  twist?: number;
  /** Centre-spot correction, metres east/north, if the map's pitch is off. */
  shift?: [number, number];
  radius: number;
  date: string;
  /** [kind, tags, flat east/north coordinates in decimetres] */
  f: [string, Record<string, string>, number[]][];
  /**
   * 'uk': an English ground. Its streets are mapped house by house, so no
   * villas are invented; churches are churches, not mosques.
   */
  style?: 'uk';
}

// ---------------------------------------------------------------------------
// Geometry helpers

const rnd = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function dp(pts: XZ[], tol: number): XZ[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const L = Math.hypot(bx - ax, bz - az) || 1e-9;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed ring (first point repeated at the end or not): split at the far point. */
function dpRing(p: XZ[], tol: number): XZ[] {
  const q = p.slice();
  if (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1]) q.pop();
  if (q.length < 4) return q;
  let far = 1;
  let best = -1;
  for (let i = 1; i < q.length; i++) {
    const d = Math.hypot(q[i][0] - q[0][0], q[i][1] - q[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dp(q.slice(0, far + 1), tol);
  const b = dp([...q.slice(far), q[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function area(p: XZ[]): number {
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

// ---------------------------------------------------------------------------
// The stadium's own footprint: everything the template draws, plus a margin.

function reachOf(t: StadiumTemplate): number {
  let r = 0;
  for (const tr of t.tiers) r = Math.max(r, (tr.baseOffset ?? 0) + tr.rows * tr.rowDepth + 2);
  for (const run of t.roofs ?? []) r = Math.max(r, run.back);
  for (const b of t.details?.buildings ?? []) r = Math.max(r, b.front + b.depth);
  for (const s of t.details?.skins ?? []) r = Math.max(r, s.offset);
  return r;
}

function footprint(t: StadiumTemplate, margin: number): (x: number, z: number) => boolean {
  const { a, b, exponent: p } = t.plan;
  const R = reachOf(t) + margin;
  // A superellipse grown by R, tested by its implicit function on the grown axes;
  // close enough for a cut-out with a margin.
  const A = a + R;
  const B = b + R;
  const pp = Math.max(2, Math.min(p, 8));
  // The lighting masts stand outside it on some grounds; keep their bases clear too.
  const masts = (t.lighting?.masts?.at ?? []).flatMap(([x, z]) => [[x, z], [-x, z], [x, -z], [-x, -z]] as XZ[]);
  return (x, z) =>
    Math.abs(x / A) ** pp + Math.abs(z / B) ** pp <= 1 || masts.some(([mx, mz]) => Math.hypot(x - mx, z - mz) < 7);
}

// ---------------------------------------------------------------------------

const ROAD_CLASS: Record<string, number> = {
  motorway: 0, trunk: 0, motorway_link: 1, trunk_link: 1, primary: 1, primary_link: 2,
  secondary: 2, secondary_link: 3, tertiary: 3, tertiary_link: 3,
  residential: 4, unclassified: 4, living_street: 4, road: 4,
  service: 5,
  pedestrian: 6, footway: 6, path: 6, cycleway: 6, steps: 6,
};
/** Carriageway width (m) by class when the map gives no width or lanes. */
const ROAD_W = [15, 12, 10, 8, 7, 5, 3];

function roadWidth(cls: number, tags: Record<string, string>): number {
  const w = parseFloat(tags.width ?? '');
  if (w > 2 && w < 40) return w;
  const lanes = parseInt(tags.lanes ?? '', 10);
  if (lanes > 0 && lanes < 10) return Math.max(3, lanes * 3.4 + (tags.oneway === 'yes' ? 1 : 1.5));
  return ROAD_W[cls];
}

function buildingHeight(tags: Record<string, string>, a: number): number {
  const h = parseFloat(tags.height ?? '');
  if (h > 2 && h < 300) return h;
  const lv = parseFloat(tags['building:levels'] ?? '');
  if (lv > 0 && lv < 80) return lv * 3.6 + 1.2;
  const b = tags.building;
  if (b === 'house' || b === 'detached' || b === 'villa' || b === 'residential' || b === 'terrace' || b === 'semidetached_house') return 8.5;
  if (b === 'garage' || b === 'shed' || b === 'roof' || b === 'kiosk') return 3.5;
  if (b === 'mosque') return 9;
  if (a > 6000) return 16;
  if (a > 1500) return 12;
  if (a > 300) return 9;
  return 7;
}

/** 0 generic, 1 mosque, 2 hall, 3 house, 4 office/commercial, 5 school/civic, 6 villa (infill), 7 shed/canopy, 8 church */
function buildingKind(tags: Record<string, string>, a: number): number {
  const b = tags.building;
  if (b === 'church' || b === 'chapel' || b === 'cathedral' || (tags.amenity === 'place_of_worship' && tags.religion === 'christian')) return 8;
  if (b === 'mosque' || tags.amenity === 'place_of_worship' || tags.religion === 'muslim') return 1;
  if (b === 'sports_hall' || b === 'sports_centre' || b === 'hangar' || b === 'warehouse' || b === 'industrial' || tags.leisure === 'sports_centre') return 2;
  if (b === 'house' || b === 'detached' || b === 'villa' || b === 'residential' || b === 'apartments' || b === 'terrace' || b === 'semidetached_house') return 3;
  if (b === 'commercial' || b === 'office' || b === 'retail' || b === 'hotel') return 4;
  if (b === 'school' || b === 'university' || b === 'college' || b === 'hospital' || b === 'public' || b === 'government' || b === 'civic') return 5;
  if (b === 'roof' || b === 'garage' || b === 'shed' || b === 'kiosk' || b === 'carport') return 7;
  if (a > 2500) return 2;
  return 0;
}

/** 0 grass/park, 1 football pitch, 2 tennis court, 3 other court, 4 water, 5 sand/bare, 6 paved plaza, 7 farm/orchard, 8 track, 9 basketball */
function areaKind(tags: Record<string, string>): number {
  if (tags.leisure === 'pitch') {
    const s = tags.sport ?? '';
    if (/tennis|padel/.test(s)) return 2;
    if (/basketball|volleyball|handball/.test(s)) return 9;
    if (/soccer|football/.test(s) || !s) return 1;
    return 3;
  }
  if (tags.leisure === 'track') return 8;
  if (tags.natural === 'water' || tags.water || tags.leisure === 'swimming_pool') return 4;
  if (tags.natural === 'sand' || tags.natural === 'bare_rock' || tags.landuse === 'construction' || tags.landuse === 'brownfield') return 5;
  if (tags.landuse === 'farmland' || tags.landuse === 'orchard' || tags.landuse === 'plant_nursery') return 7;
  if (tags.place === 'square' || tags.highway === 'pedestrian' || tags.amenity === 'marketplace') return 6;
  return 0;
}

// ---------------------------------------------------------------------------

function run(file: string): void {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Raw;
  const t = templateById(raw.template);
  if (!t) throw new Error(`no template ${raw.template}`);
  // Frame: +z from the centre spot away from the main stand; +x = up × z.
  const mb = ((raw.main + (raw.twist ?? 0)) * Math.PI) / 180;
  const M: XZ = [Math.sin(mb), Math.cos(mb)]; // main stand direction in (east, north)
  const Zr: XZ = [-M[0], -M[1]];
  const Xr: XZ = [-Zr[1], Zr[0]];
  const [sx, sy] = raw.shift ?? [0, 0];
  const toXZ = (e: number, n: number): XZ => {
    const E = e / 10 - sx;
    const N = n / 10 - sy;
    return [E * Xr[0] + N * Xr[1], E * Zr[0] + N * Zr[1]];
  };
  const pts = (flat: number[]): XZ[] => {
    const out: XZ[] = [];
    for (let i = 0; i < flat.length; i += 2) out.push(toXZ(flat[i], flat[i + 1]));
    return out;
  };
  const R = raw.radius;
  const inside = footprint(t, 6);
  const near = footprint(t, 1);
  const dm = (p: XZ[]): number[] => p.flatMap(([x, z]) => [Math.round(x * 10), Math.round(z * 10)]);
  const within = ([x, z]: XZ) => Math.hypot(x, z) <= R;

  const roads: number[][] = [];
  const bld: number[][] = [];
  const lots: number[][] = [];
  const areas: number[][] = [];
  const walls: number[][] = [];
  const trees: number[] = [];
  const mosquePoints: XZ[] = [];
  const residential: XZ[][] = [];
  const greens: { ring: XZ[]; k: number }[] = [];
  const majorRoads: { p: XZ[]; w: number; cls: number }[] = [];
  const resRoads: { p: XZ[]; w: number }[] = [];

  // Occupancy, 1 m cells over the site: what is already there.
  const N = Math.ceil(R) * 2 + 2;
  const occ = new Uint8Array(N * N);
  const cell = (x: number, z: number) => {
    const i = Math.floor(x + R + 1);
    const j = Math.floor(z + R + 1);
    return i >= 0 && j >= 0 && i < N && j < N ? j * N + i : -1;
  };
  const markPoly = (p: XZ[], grow = 0) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of p) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    for (let z = Math.floor(z0 - grow); z <= z1 + grow; z++)
      for (let x = Math.floor(x0 - grow); x <= x1 + grow; x++) {
        if (grow > 0 ? inPolyGrown(x + 0.5, z + 0.5, p, grow) : inPoly(x + 0.5, z + 0.5, p)) {
          const c = cell(x + 0.5, z + 0.5);
          if (c >= 0) occ[c] = 1;
        }
      }
  };
  const inPolyGrown = (x: number, z: number, p: XZ[], g: number) => {
    if (inPoly(x, z, p)) return true;
    for (let i = 0; i < p.length; i++) {
      const [ax, az] = p[i];
      const [bx, bz] = p[(i + 1) % p.length];
      if (segDist(x, z, ax, az, bx, bz) < g) return true;
    }
    return false;
  };
  const markLine = (p: XZ[], half: number) => {
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i];
      const [bx, bz] = p[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const steps = Math.ceil(L);
      for (let s = 0; s <= steps; s++) {
        const cx = ax + ((bx - ax) * s) / Math.max(1, steps);
        const cz = az + ((bz - az) * s) / Math.max(1, steps);
        for (let dz = -half; dz <= half; dz++)
          for (let dx = -half; dx <= half; dx++) {
            if (dx * dx + dz * dz > half * half) continue;
            const c = cell(cx + dx, cz + dz);
            if (c >= 0) occ[c] = 1;
          }
      }
    }
  };
  // The stadium footprint is occupied.
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) if (inside(i - R - 1 + 0.5, j - R - 1 + 0.5)) occ[j * N + i] = 1;
  // Hard occupancy (buildings, car parks, courts, the stadium): where a palm cannot stand.
  const hard = new Uint8Array(N * N);
  const hardPoly = (p: XZ[]) => {
    const before = occ.slice();
    markPoly(p);
    for (let i = 0; i < occ.length; i++) if (occ[i] && !before[i]) hard[i] = 1;
  };
  for (let i = 0; i < occ.length; i++) if (occ[i]) hard[i] = 1;

  for (const [kind, tags, flat] of raw.f) {
    if (kind === 't') {
      const [p] = pts(flat);
      if (within(p) && !inside(p[0], p[1])) trees.push(Math.round(p[0] * 10), Math.round(p[1] * 10));
      continue;
    }
    if (kind === 'm') {
      // A place of worship mapped only as a point: in the Gulf a mosque; in an
      // English street most are churches, and those are drawn as buildings.
      if (raw.style === 'uk' && tags.religion !== 'muslim') continue;
      const [p] = pts(flat);
      if (within(p) && !inside(p[0], p[1])) mosquePoints.push(p);
      continue;
    }
    const p = pts(flat);
    if (kind === 'tr') {
      for (const [x, z] of along(p, 7)) if (within([x, z]) && !inside(x, z)) trees.push(Math.round(x * 10), Math.round(z * 10));
      continue;
    }
    if (kind === 'h') {
      const cls = ROAD_CLASS[tags.highway];
      if (cls === undefined || tags.area === 'yes' || tags.tunnel === 'yes' || tags.indoor === 'yes') continue;
      const w = roadWidth(cls, tags);
      // Split where it enters the stadium's own footprint (its ring road, its ramps).
      let piece: XZ[] = [];
      const flush = () => {
        if (piece.length >= 2) {
          const s = dp(piece, 0.4);
          roads.push([cls, Math.round(w * 10), ...dm(s)]);
          markLine(s, Math.ceil(w / 2 + 0.5));
          if (cls === 4 && tags.highway !== 'unclassified') resRoads.push({ p: s, w });
          if (cls <= 3) majorRoads.push({ p: s, w, cls });
        }
        piece = [];
      };
      for (const q of p) {
        if (near(q[0], q[1]) || !within(q)) flush();
        else piece.push(q);
      }
      flush();
      continue;
    }
    if (p.length < 3) continue;
    const ring = dpRing(p, 0.3);
    if (ring.length < 3) continue;
    const a = Math.abs(area(ring));
    const cx = ring.reduce((s, q) => s + q[0], 0) / ring.length;
    const cz = ring.reduce((s, q) => s + q[1], 0) / ring.length;
    const touches = ring.some(([x, z]) => inside(x, z)) || inside(cx, cz);
    if (kind === 'lr') {
      residential.push(ring);
      continue;
    }
    // A river runs right past some grounds (the Thames behind Craven Cottage's
    // Riverside Stand): its bank may touch the footprint; the stand covers it.
    const river = kind === 'a' && areaKind(tags) === 4 && a > 20000;
    if ((touches && !river) || !within([cx, cz])) continue;
    if (kind === 'b') {
      if (tags.building === 'stadium' || tags.building === 'grandstand' || a < 12) continue;
      const k = buildingKind(tags, a);
      bld.push([Math.round(buildingHeight(tags, a) * 10), k, ...dm(ring)]);
      hardPoly(ring);
      markPoly(ring, 1);
      if (k === 1) mosquePoints.push([cx, cz]);
    } else if (kind === 'p') {
      if (a < 60) continue;
      lots.push(dm(ring));
      hardPoly(ring);
    } else if (kind === 'a') {
      let k = areaKind(tags);
      // A running track is ~16,000 m²; anything far bigger tagged as a track is
      // an events ground or a circuit, and reads as paving from above.
      if (k === 8 && a > 40000) k = 6;
      if (tags.leisure === 'stadium' || tags.leisure === 'sports_centre') continue;
      areas.push([k, ...dm(ring)]);
      if (k !== 0 && k !== 5 && k !== 7) hardPoly(ring);
      if (k === 0 || k === 7) greens.push({ ring, k });
    } else if (kind === 'w') {
      // Walls only: a fence round a training pitch is wire, not masonry.
      if (tags.barrier === 'wall') walls.push(dm(dp(p, 0.3)));
    }
  }

  // Neighbourhood mosques mapped only as a point: a small one with a dome and minaret.
  const r0 = rnd(raw.key.split('').reduce((s, c) => s * 31 + c.charCodeAt(0), 7));
  for (const [x, z] of mosquePoints) {
    const already = bld.some((b) => b[1] === 1 && inPoly(x, z, unflat(b.slice(2))));
    if (already) continue;
    const s = 16 + r0() * 10;
    const rect: XZ[] = [[x - s / 2, z - s / 2], [x + s / 2, z - s / 2], [x + s / 2, z + s / 2], [x - s / 2, z + s / 2]];
    if (rect.some(([qx, qz]) => occ[cell(qx, qz)] === 1)) continue;
    bld.push([90, 1, ...dm(rect)]);
    markPoly(rect, 1);
  }

  // Villas along the residential streets, where the map has none.
  let villas = 0;
  // Saudi residential streets are lined with villas whether or not the map
  // draws a residential area round them; the map's areas only add certainty.
  const inRes = (_x: number, _z: number) => raw.style !== 'uk';
  const free = (rect: XZ[]) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of rect) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    for (let z = Math.floor(z0); z <= z1; z++)
      for (let x = Math.floor(x0); x <= x1; x++) {
        if (!inPoly(x + 0.5, z + 0.5, rect)) continue;
        const c = cell(x + 0.5, z + 0.5);
        if (c < 0 || occ[c]) return false;
        if (Math.hypot(x, z) > R - 4) return false;
      }
    return true;
  };
  for (const { p, w } of resRoads) {
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i];
      const [bx, bz] = p[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 14) continue;
      const ux = (bx - ax) / L;
      const uz = (bz - az) / L;
      for (const side of [-1, 1]) {
        const nx = -uz * side;
        const nz = ux * side;
        let s = 2 + r0() * 4;
        while (s < L - 10) {
          const W = 15 + Math.floor(r0() * 4) * 2.5; // plot frontage
          const D = 22 + r0() * 8; // plot depth
          const off = w / 2 + 2.6; // kerb + pavement
          const p0x = ax + ux * s + nx * off;
          const p0z = az + uz * s + nz * off;
          const plot: XZ[] = [
            [p0x, p0z],
            [p0x + ux * W, p0z + uz * W],
            [p0x + ux * W + nx * D, p0z + uz * W + nz * D],
            [p0x + nx * D, p0z + nz * D],
          ];
          const mx = p0x + ux * W / 2 + nx * D / 2;
          const mz = p0z + uz * W / 2 + nz * D / 2;
          if (s + W <= L && inRes(mx, mz) && free(plot)) {
            // The villa: set back 3 m behind its wall, 1.5 m off the sides.
            const f0 = 3 + r0() * 2;
            const bw = W - 3;
            const bd = Math.min(D - f0 - 2.5, 13 + r0() * 6);
            const v0x = p0x + ux * 1.5 + nx * f0;
            const v0z = p0z + uz * 1.5 + nz * f0;
            const house: XZ[] = [
              [v0x, v0z],
              [v0x + ux * bw, v0z + uz * bw],
              [v0x + ux * bw + nx * bd, v0z + uz * bw + nz * bd],
              [v0x + nx * bd, v0z + nz * bd],
            ];
            const floors = r0() < 0.62 ? 2 : 3;
            bld.push([Math.round((floors * 3.5 + 1.4) * 10), 6, ...dm(house)]);
            // A palm or two in the front yard, behind the wall.
            if (r0() < 0.4) {
              const t0 = 1.5 + r0() * (W - 3);
              trees.push(Math.round((p0x + ux * t0 + nx * (f0 * 0.5)) * 10), Math.round((p0z + uz * t0 + nz * (f0 * 0.5)) * 10));
            }
            // Its boundary wall along the street, with a gap for the gate.
            const g0 = W * (0.2 + r0() * 0.4);
            walls.push(dm([plot[0], [p0x + ux * g0, p0z + uz * g0]]));
            walls.push(dm([[p0x + ux * (g0 + 4), p0z + uz * (g0 + 4)], plot[1]]));
            walls.push(dm([plot[1], plot[2]]));
            markPoly(plot);
            villas++;
          }
          s += W;
        }
      }
    }
  }

  // Palms down the main roads (most Saudi avenues are lined with them), and
  // scattered through the parks and the green verges the map has.
  const freeAt = (x: number, z: number) => {
    const c = cell(x, z);
    return c >= 0 && !hard[c] && Math.hypot(x, z) < R - 2 && !inside(x, z);
  };
  const placed = new Set<number>();
  const plant = (x: number, z: number) => {
    const key = Math.round(x / 4) * 100003 + Math.round(z / 4);
    if (placed.has(key) || !freeAt(x, z)) return;
    placed.add(key);
    trees.push(Math.round(x * 10), Math.round(z * 10));
  };
  for (const { p, w, cls } of majorRoads) {
    if (r0() > (cls <= 2 ? 0.85 : 0.5)) continue;
    for (const side of [-1, 1]) {
      const off = w / 2 + 1.6;
      for (const [x, z, ux, uz] of alongDir(p, 11)) plant(x - uz * off * side, z + ux * off * side);
    }
  }
  for (const { ring, k } of greens) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const step = k === 7 ? 8 : 15;
    for (let z = z0 + step / 2; z < z1; z += step)
      for (let x = x0 + step / 2; x < x1; x += step) {
        const jx = x + (r0() - 0.5) * step * 0.6;
        const jz = z + (r0() - 0.5) * step * 0.6;
        if (inPoly(jx, jz, ring) && (k === 7 || r0() < 0.55)) plant(jx, jz);
      }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    v: 1,
    key: raw.key,
    template: raw.template,
    attribution: '© OpenStreetMap contributors (ODbL)',
    date: raw.date,
    r: R,
    roads,
    bld,
    lots,
    areas,
    walls,
    trees,
  };
  const path = resolve(OUT_DIR, `${raw.key}.json`);
  writeFileSync(path, JSON.stringify(out));
  console.log(`${raw.key}: ${roads.length} roads, ${bld.length} buildings (${villas} villas filled in), ${lots.length} car parks, ${areas.length} areas, ${walls.length} walls, ${trees.length / 2} trees → ${path.replace(ROOT + '/', '')} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

/** Points every `step` metres along a polyline. */
function along(p: XZ[], step: number): XZ[] {
  return alongDir(p, step).map(([x, z]) => [x, z] as XZ);
}

/** Points every `step` metres along a polyline, with the direction there. */
function alongDir(p: XZ[], step: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let carry = step / 2;
  for (let i = 0; i + 1 < p.length; i++) {
    const [ax, az] = p[i];
    const [bx, bz] = p[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L;
    const uz = (bz - az) / L;
    let s = carry;
    for (; s < L; s += step) out.push([ax + ux * s, az + uz * s, ux, uz]);
    carry = s - L;
  }
  return out;
}

function unflat(a: number[]): XZ[] {
  const out: XZ[] = [];
  for (let i = 0; i < a.length; i += 2) out.push([a[i] / 10, a[i + 1] / 10]);
  return out;
}

for (const f of process.argv.slice(2)) run(f);
