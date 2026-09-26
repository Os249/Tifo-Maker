import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SeatMap, SeatZoneKind, StadiumTemplate } from '../../core/types';
import { curveSampler, seatZones, ZONE_CODE, ZONE_KINDS } from '../../core/venueDetails';

/**
 * Premium seating, drawn as what it is rather than as coloured cards:
 *
 *   - ARMCHAIRS on every premium seat. Gold velvet on the gold platform, grey
 *     on the silver, cream leather in the royal box. An ordinary seat is a
 *     card-sized square because it is a tifo pixel; a premium seat is a chair.
 *   - A GLASS BALUSTRADE along the front of each platform, capped by a rail
 *     in its own metal, and glass PARTITIONS up the rake where one platform
 *     meets the next, which is how a ticketed section is actually closed off.
 *   - A GOLD LED BAND on the front wall under the gold platform, with its
 *     name on it.
 *   - THE ROYAL BOX: a glazed front with a gold rail, cream side walls, a
 *     carpet, a panelled back wall, and a canopy over the back rows with
 *     downlights and the box's name on its gold fascia.
 *
 * Everything is placed from the zone's actual seats, never from a perimeter
 * fraction, so the frame fits the seats it frames on any ground. Shell only:
 * nothing here moves a seat.
 */

type Trash = { dispose(): void };

export interface PremiumBuild {
  object: THREE.Group;
  disposables: Trash[];
  /** 1 where a seat has a chair (its card is hidden while the seat is empty). */
  chairMask: Uint8Array;
}

const CHAIR_COLOURS: Record<SeatZoneKind, number[]> = {
  gold: [0xb8912e, 0xc49a33, 0xa9842a],
  silver: [0x7f868f, 0x8b929b, 0x747b84],
  vip: [0xe6d6b2, 0xdccaa2, 0xeadcbc],
};
const RAIL: Record<SeatZoneKind, number> = { gold: 0xd4af37, silver: 0xc7ccd3, vip: 0xd4af37 };

/** One armchair, facing +z (the renderer turns it to the pitch). */
function chairGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  add(0.44, 0.13, 0.42, 0, 0.44, 0.02); // cushion
  add(0.44, 0.56, 0.1, 0, 0.76, -0.19); // back
  add(0.05, 0.17, 0.4, -0.235, 0.58, 0.0); // arms
  add(0.05, 0.17, 0.4, 0.235, 0.58, 0.0);
  add(0.36, 0.38, 0.3, 0, 0.19, -0.02); // base
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  return merged;
}

/** A canvas-lettered band: name in Arabic and English on a coloured strip. */
function bandTexture(text: string, bg: string, fg: string, glow: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, bg);
  grad.addColorStop(0.5, glow ? '#ffe9a6' : bg);
  grad.addColorStop(1, bg);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 32);
  g.fillStyle = fg;
  g.font = 'bold 19px "Noto Kufi Arabic", "Cairo", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 17);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Warm downlights on a cream ceiling. */
function ceilingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e9dfc8';
  g.fillRect(0, 0, 64, 64);
  const r = g.createRadialGradient(32, 32, 1, 32, 32, 12);
  r.addColorStop(0, 'rgba(255,248,220,1)');
  r.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Walnut panelling with gold pinstripes. */
function panelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#5a3a22');
  grad.addColorStop(1, '#3e2716');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#d4af37';
  for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 2, 64);
  g.fillRect(0, 8, 128, 1);
  g.fillRect(0, 56, 128, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** A vertical ribbon along a polyline, from its points up by `h`. U runs 0..1 along it. */
function ribbon(points: THREE.Vector3[], h: number, y0 = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1]);
  let len = 0;
  points.forEach((p, i) => {
    if (i > 0) len += p.distanceTo(points[i - 1]);
    pos.push(p.x, p.y + y0, p.z, p.x, p.y + y0 + h, p.z);
    uv.push(len / (total || 1), 0, len / (total || 1), 1);
  });
  for (let i = 0; i < points.length - 1; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A surface between two polylines of equal length (left edge, right edge). */
function sheet(left: THREE.Vector3[], right: THREE.Vector3[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < left.length; i++) {
    pos.push(left[i].x, left[i].y, left[i].z, right[i].x, right[i].y, right[i].z);
    const v = i / Math.max(1, left.length - 1);
    uv.push(0, v, 1, v);
  }
  for (let i = 0; i < left.length - 1; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A rail: a tube through a polyline. */
function rail(points: THREE.Vector3[], r: number): THREE.BufferGeometry {
  if (points.length < 2) return new THREE.BufferGeometry();
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < points.length - 1; i++) path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  return new THREE.TubeGeometry(path, Math.max(2, points.length * 2), r, 6, false);
}

export function buildPremium(template: StadiumTemplate, map: SeatMap, shadows: boolean): PremiumBuild {
  const group = new THREE.Group();
  group.name = 'premium';
  const trash: Trash[] = [];
  const chairMask = new Uint8Array(map.count);
  const zones = template.details?.zones ?? [];
  if (zones.length === 0) return { object: group, disposables: trash, chairMask };

  const codes = seatZones(map, template);
  const at = curveSampler(template);
  const P = (i: number): THREE.Vector3 => new THREE.Vector3(map.pos3[i * 3], map.pos3[i * 3 + 1], map.pos3[i * 3 + 2]);
  /** Unit vector pointing from a seat towards the pitch, in the ground plane. */
  const inward = (i: number): THREE.Vector3 => {
    const n = at(map.uv[i * 2], 0);
    return new THREE.Vector3(-n.nx, 0, -n.nz);
  };
  /** Unit vector along the row, towards increasing u. */
  const along = (i: number): THREE.Vector3 => {
    const n = at(map.uv[i * 2], 0);
    return new THREE.Vector3(-n.nz, 0, n.nx);
  };

  // ---- armchairs -----------------------------------------------------------
  let chairs = 0;
  for (let i = 0; i < map.count; i++) if (codes[i]) chairs++;
  const chairGeo = chairGeometry();
  const chairMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const chairMesh = new THREE.InstancedMesh(chairGeo, chairMat, Math.max(1, chairs));
  chairMesh.count = chairs;
  chairMesh.frustumCulled = false;
  chairMesh.castShadow = false;
  chairMesh.receiveShadow = shadows;
  trash.push(chairGeo, chairMat, { dispose: () => chairMesh.dispose() });
  const d = new THREE.Object3D();
  const col = new THREE.Color();
  let k = 0;
  for (let i = 0; i < map.count; i++) {
    const c = codes[i];
    if (!c) continue;
    const x = map.pos3[i * 3];
    const y = map.pos3[i * 3 + 1];
    const z = map.pos3[i * 3 + 2];
    d.position.set(x, y, z);
    d.lookAt(0, y, 0);
    d.updateMatrix();
    chairMesh.setMatrixAt(k, d.matrix);
    const pal = CHAIR_COLOURS[ZONE_KINDS[c - 1]];
    col.setHex(pal[(Math.imul(i, 2654435761) >>> 0) % pal.length]);
    chairMesh.setColorAt(k, col);
    chairMask[i] = 1;
    k++;
  }
  chairMesh.instanceMatrix.needsUpdate = true;
  if (chairMesh.instanceColor) chairMesh.instanceColor.needsUpdate = true;
  group.add(chairMesh);

  // ---- per-zone seat outlines: rows, and the extreme seat of each row -------
  interface ZoneShape {
    kind: SeatZoneKind;
    center: number;
    rows: { row: number; left: number; right: number; seats: number[] }[];
  }
  const shapes: ZoneShape[] = [];
  for (const kind of ZONE_KINDS) {
    const z = zones.find((q) => q.kind === kind);
    if (!z) continue;
    const byRow = new Map<number, number[]>();
    for (let i = 0; i < map.count; i++) {
      if (codes[i] !== ZONE_CODE[kind]) continue;
      const r = map.rowOf[i];
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push(i);
    }
    // Signed position along the row relative to the zone's centre, so a zone
    // that straddles u = 0 sorts correctly.
    const rel = (i: number): number => {
      let v = map.uv[i * 2] - z.centerU;
      if (v > 0.5) v -= 1;
      if (v < -0.5) v += 1;
      return v;
    };
    const rows = [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, seats]) => {
        seats.sort((a, b) => rel(a) - rel(b));
        return { row, left: seats[0], right: seats[seats.length - 1], seats };
      });
    if (rows.length) shapes.push({ kind, center: z.centerU, rows });
  }

  const glass = new THREE.MeshStandardMaterial({ color: 0xcfe3ee, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  trash.push(glass);
  const metal = (hex: number): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.3, metalness: 0.75, emissive: hex, emissiveIntensity: 0.12 });
    trash.push(m);
    return m;
  };
  const addMesh = (g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh => {
    trash.push(g);
    const mesh = new THREE.Mesh(g, m);
    group.add(mesh);
    return mesh;
  };

  /**
   * Split a front row into runs: an aisle is bridged (the balustrade runs
   * across it), a gap of more than a few metres is not — the silver platform's
   * front row is two runs, one each side of the gold.
   */
  const runs = (seats: number[]): number[][] => {
    const out: number[][] = [[]];
    for (let q = 0; q < seats.length; q++) {
      if (q > 0 && P(seats[q]).distanceTo(P(seats[q - 1])) > 3) out.push([]);
      out[out.length - 1].push(seats[q]);
    }
    return out.filter((r) => r.length > 1);
  };
  /** Points along a run of seats, pushed towards the pitch by `ahead` metres. */
  const frontLine = (seats: number[], ahead: number, dy = 0): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    const step = Math.max(1, Math.floor(seats.length / 40));
    for (let q = 0; q < seats.length; q += step) {
      const i = seats[q];
      pts.push(P(i).addScaledVector(inward(i), ahead).add(new THREE.Vector3(0, dy, 0)));
    }
    const last = seats[seats.length - 1];
    pts.push(P(last).addScaledVector(inward(last), ahead).add(new THREE.Vector3(0, dy, 0)));
    // Carry the ends out by half a seat so the glass covers the end seats.
    const a0 = along(seats[0]);
    const a1 = along(last);
    pts[0].addScaledVector(a0, -0.25);
    pts[pts.length - 1].addScaledVector(a1, 0.25);
    return pts;
  };
  /** One side edge of a zone, up the rake, half a seat outside its end seats. */
  const sideLine = (shape: ZoneShape, side: 'left' | 'right', dy = 0): THREE.Vector3[] =>
    shape.rows.map((r) => {
      const i = r[side];
      return P(i).addScaledVector(along(i), side === 'left' ? -0.28 : 0.28).add(new THREE.Vector3(0, dy, 0));
    });

  for (const shape of shapes) {
    const front = shape.rows[0];
    const railMat = metal(RAIL[shape.kind]);
    const isBox = shape.kind === 'vip';
    const glassH = isBox ? 1.2 : 1.0;

    // Glass along the front, with a rail on top and posts every few metres.
    for (const run of runs(front.seats)) {
      const base = frontLine(run, 0.55, -0.1);
      addMesh(ribbon(base, glassH), glass);
      addMesh(rail(base.map((p) => p.clone().add(new THREE.Vector3(0, glassH, 0))), 0.045), railMat);
      addMesh(rail(base.map((p) => p.clone().add(new THREE.Vector3(0, 0.05, 0))), 0.03), railMat);
    }

    // Partitions up the rake at the zone's ends. The gold platform closes both
    // of its ends; the silver closes only its outer ends (its inner ends meet
    // the gold, which already has glass there).
    const sides: ('left' | 'right')[] = ['left', 'right'];
    for (const side of sides) {
      const line = sideLine(shape, side);
      if (line.length < 2) continue;
      if (isBox) {
        // The royal box has solid cream walls with a gold cap, not glass.
        const wallMat = new THREE.MeshStandardMaterial({ color: 0xece3cf, roughness: 0.6, side: THREE.DoubleSide });
        trash.push(wallMat);
        addMesh(ribbon(line, 1.7, -0.2), wallMat);
        addMesh(rail(line.map((p) => p.clone().add(new THREE.Vector3(0, 1.5, 0))), 0.05), railMat);
      } else {
        addMesh(ribbon(line, 1.1, -0.2), glass);
        addMesh(rail(line.map((p) => p.clone().add(new THREE.Vector3(0, 0.9, 0))), 0.035), railMat);
      }
    }

    if (shape.kind === 'gold') {
      // The gold LED band on the front wall under the platform, named.
      const tex = bandTexture('المنصة الذهبية   •   GOLD PLATFORM   •   المنصة الذهبية', '#a67c1f', '#fff6d8', true);
      const run = front.seats;
      const base = frontLine(run, 0.9, -map.pos3[run[0] * 3 + 1]); // down to the ground
      let len = 0;
      for (let q = 1; q < base.length; q++) len += base[q].distanceTo(base[q - 1]);
      tex.repeat.set(Math.max(1, len / 28), 1);
      const bandMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide });
      trash.push(tex, bandMat);
      addMesh(ribbon(base, Math.max(0.5, map.pos3[run[0] * 3 + 1] - 0.35), 0.15), bandMat);
    }

    if (isBox) {
      const rows = shape.rows;
      // Carpet under the chairs, edge to edge.
      const carpetMat = new THREE.MeshStandardMaterial({ color: 0x6e1420, roughness: 0.95 });
      trash.push(carpetMat);
      const lEdge = sideLine(shape, 'left', 0.03);
      const rEdge = sideLine(shape, 'right', 0.03);
      // Pull the carpet forward to the glass.
      const f = rows[0];
      lEdge.unshift(P(f.left).addScaledVector(inward(f.left), 0.6).addScaledVector(along(f.left), -0.28).add(new THREE.Vector3(0, 0.03, 0)));
      rEdge.unshift(P(f.right).addScaledVector(inward(f.right), 0.6).addScaledVector(along(f.right), 0.28).add(new THREE.Vector3(0, 0.03, 0)));
      addMesh(sheet(lEdge, rEdge), carpetMat).receiveShadow = shadows;

      // The panelled back wall behind the last row.
      const last = rows[rows.length - 1];
      const backSeats = last.seats;
      const back = frontLine(backSeats, -0.55, 0);
      const panel = panelTexture();
      let blen = 0;
      for (let q = 1; q < back.length; q++) blen += back[q].distanceTo(back[q - 1]);
      panel.repeat.set(Math.max(1, blen / 4), 1);
      const panelMat = new THREE.MeshStandardMaterial({ map: panel, emissive: 0xffffff, emissiveMap: panel, emissiveIntensity: 0.35, roughness: 0.6, side: THREE.DoubleSide });
      trash.push(panel, panelMat);
      addMesh(ribbon(back, 3.4), panelMat);

      // The canopy over the back rows, following the rake, with downlights.
      const startIdx = Math.floor(rows.length * 0.45);
      const cl: THREE.Vector3[] = [];
      const cr: THREE.Vector3[] = [];
      for (let q = startIdx; q < rows.length; q++) {
        cl.push(P(rows[q].left).addScaledVector(along(rows[q].left), -0.28).add(new THREE.Vector3(0, 2.9, 0)));
        cr.push(P(rows[q].right).addScaledVector(along(rows[q].right), 0.28).add(new THREE.Vector3(0, 2.9, 0)));
      }
      // ...out to the back wall.
      cl.push(back[0].clone().add(new THREE.Vector3(0, 3.4, 0)));
      cr.push(back[back.length - 1].clone().add(new THREE.Vector3(0, 3.4, 0)));
      const ceil = ceilingTexture();
      ceil.repeat.set(Math.max(1, cl[0].distanceTo(cr[0]) / 2.5), Math.max(1, cl[0].distanceTo(cl[cl.length - 1]) / 2.5));
      const canopyMat = new THREE.MeshStandardMaterial({ color: 0xf1e9d6, map: ceil, emissive: 0xffffff, emissiveMap: ceil, emissiveIntensity: 0.45, roughness: 0.6, side: THREE.DoubleSide });
      trash.push(ceil, canopyMat);
      addMesh(sheet(cl, cr), canopyMat);

      // Its gold fascia, named, along the leading edge.
      const lead = rows[startIdx].seats;
      const fascia = frontLine(lead, 0.35, 2.0);
      const nameTex = bandTexture('المقصورة الرئيسية   •   ROYAL BOX', '#9c7418', '#fff6d8', true);
      const nameMat = new THREE.MeshBasicMaterial({ map: nameTex, toneMapped: false, side: THREE.DoubleSide });
      trash.push(nameTex, nameMat);
      addMesh(ribbon(fascia, 1.1), nameMat);
      addMesh(rail(fascia.map((p) => p.clone().add(new THREE.Vector3(0, 1.12, 0))), 0.07), railMat);
      addMesh(rail(fascia, 0.07), railMat);
      // Gold columns at the canopy's front corners, down to the carpet.
      const colGeo = new THREE.CylinderGeometry(0.14, 0.16, 1, 12);
      trash.push(colGeo);
      for (const end of [fascia[0], fascia[fascia.length - 1]]) {
        const floorY = end.y - 2.0;
        const h = end.y + 1.1 - floorY;
        const col = new THREE.Mesh(colGeo, railMat);
        col.scale.set(1, h, 1);
        col.position.set(end.x, floorY + h / 2, end.z);
        group.add(col);
      }
    }
  }

  return { object: group, disposables: trash, chairMask };
}

