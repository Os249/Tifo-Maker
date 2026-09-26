import * as THREE from 'three';
import type { StadiumTemplate, SeatMap } from '../../core/types';
import { curveSampler, laneLines, tierEdges, type LaneLine } from '../../core/venueDetails';

/**
 * A real ground's details, drawn from its template (VenueDetails in types.ts):
 *
 *   - vehicle lanes: the ramp floor, the cut faces of the stand either side,
 *     a tunnel portal at the back, and an ambulance on standby at one of them
 *   - the box band: glass-fronted hospitality boxes between two tiers
 *   - the royal box around the VIP zone
 *   - the big screens, whose picture the caller supplies (see ScreenPicture)
 *
 * Data-driven, so any ground that gains a `details` block gets these without
 * new code. Everything here is shell: it never moves a seat (the lanes' seats
 * are removed by the seat-map generator, not here).
 */

type Trash = { dispose(): void };

export interface VenueBuild {
  object: THREE.Group;
  disposables: Trash[];
  /** One canvas per screen, painted by the caller; call `screensChanged` after. */
  screens: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }[];
  screensChanged(): void;
}

/** Pixel size of a screen's picture: 2.74:1, a 26 x 9.5 m board. */
export const SCREEN_PX = { w: 832, h: 304 };

function box(w: number, h: number, d: number, mat: THREE.Material, trash: Trash[]): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  trash.push(g);
  return new THREE.Mesh(g, mat);
}

/** A quad strip along the plan curve between u0 and u1 at a fixed offset, from y0 to y1. */
function curtain(
  at: (u: number, off: number) => { x: number; z: number },
  u0: number,
  u1: number,
  off: number,
  y0: number,
  y1: number,
  segs: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    const p = at(u0 + (u1 - u0) * f, off);
    pos.push(p.x, y0, p.z, p.x, y1, p.z);
    uv.push(f, 0, f, 1);
  }
  for (let i = 0; i < segs; i++) {
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

/** One hospitality box's glazing: lit interior, mullions, a dark spandrel. */
function boxTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1712';
  g.fillRect(0, 0, 64, 32);
  const grad = g.createLinearGradient(0, 6, 0, 30);
  grad.addColorStop(0, '#f6d9a0');
  grad.addColorStop(1, '#b77a3e');
  g.fillStyle = grad;
  g.fillRect(3, 6, 58, 24);
  g.fillStyle = 'rgba(40,30,20,0.9)';
  for (const x of [22, 42]) g.fillRect(x, 6, 2, 24);
  g.fillStyle = '#e9e2d2';
  g.fillRect(0, 0, 64, 4); // white fascia above the glass
  g.fillRect(0, 0, 2, 32);
  g.fillRect(62, 0, 2, 32);
  // Silhouettes of people at the glass, so a lit box reads as a room.
  g.fillStyle = 'rgba(60,35,20,0.55)';
  for (const [x, h] of [[9, 10], [15, 12], [30, 11], [50, 12]] as const) {
    g.beginPath();
    g.arc(x, 30 - h, 2.2, 0, Math.PI * 2);
    g.fill();
    g.fillRect(x - 3, 30 - h + 2, 6, h - 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Hazard chevrons for a vehicle lane's portal. */
function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2c40f';
  g.fillRect(0, 0, 128, 16);
  g.fillStyle = '#16161a';
  for (let x = -16; x < 144; x += 16) {
    g.beginPath();
    g.moveTo(x, 16);
    g.lineTo(x + 8, 0);
    g.lineTo(x + 14, 0);
    g.lineTo(x + 6, 16);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A sign reading "EMERGENCY" in Arabic and English, for the portal lintel. */
function emergencySign(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f5132';
  g.fillRect(0, 0, 256, 48);
  g.fillStyle = '#ffffff';
  g.font = 'bold 22px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('طوارئ  •  EMERGENCY', 128, 25);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A Saudi Red Crescent-style ambulance: white van, red band, light bar. Generic. */
function ambulance(trash: Trash[]): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.45, metalness: 0.1 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2533, roughness: 0.2, metalness: 0.4 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const beacon = new THREE.MeshBasicMaterial({ color: 0xff3030 });
  const beacon2 = new THREE.MeshBasicMaterial({ color: 0x3a7bff });
  trash.push(white, red, glass, tyre, beacon, beacon2);
  const body = box(5.6, 2.5, 2.1, white, trash);
  body.position.set(0, 1.55, 0);
  g.add(body);
  const cab = box(1.4, 1.7, 2.05, white, trash);
  cab.position.set(3.4, 1.15, 0);
  g.add(cab);
  const wind = box(0.1, 0.8, 1.8, glass, trash);
  wind.position.set(4.12, 1.5, 0);
  g.add(wind);
  const band = box(5.62, 0.35, 2.12, red, trash);
  band.position.set(0, 1.35, 0);
  g.add(band);
  const barL = box(0.5, 0.18, 0.6, beacon, trash);
  barL.position.set(2.2, 2.9, -0.45);
  g.add(barL);
  const barR = box(0.5, 0.18, 0.6, beacon2, trash);
  barR.position.set(2.2, 2.9, 0.45);
  g.add(barR);
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14);
  trash.push(wheelGeo);
  for (const [x, z] of [[-1.9, 1.0], [-1.9, -1.0], [2.9, 1.0], [2.9, -1.0]] as const) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.42, z);
    g.add(w);
  }
  return g;
}

export function buildVenueDetails(template: StadiumTemplate, map: SeatMap, shadows: boolean): VenueBuild {
  const group = new THREE.Group();
  group.name = 'venue-details';
  const trash: Trash[] = [];
  const details = template.details ?? {};
  const at = curveSampler(template);

  const concrete = new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95, side: THREE.DoubleSide });
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.92 });
  const tunnelDark = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 1 });
  const fasciaWhite = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.55, metalness: 0.1 });
  trash.push(concrete, asphalt, tunnelDark, fasciaWhite);

  // ---- vehicle lanes ------------------------------------------------------
  const lanes = laneLines(template);
  const chev = lanes.length ? chevronTexture() : null;
  const sign = lanes.length ? emergencySign() : null;
  if (chev) trash.push(chev);
  if (sign) trash.push(sign);
  lanes.forEach((l: LaneLine, k) => {
    const e = tierEdges(template, l.lane.tier);
    const w = l.lane.widthM;
    const len = e.back - e.front + 6; // from the pitch-side edge to the portal
    const ang = Math.atan2(l.dx, l.dz); // yaw so local +z runs outward
    const lane = new THREE.Group();
    lane.position.set(l.x + l.dx * (e.front - 2), 0, l.z + l.dz * (e.front - 2));
    lane.rotation.y = ang;

    // Road surface, with a white edge line either side.
    const road = box(w, 0.08, len, asphalt, trash);
    road.position.set(0, 0.04, len / 2);
    road.receiveShadow = shadows;
    lane.add(road);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xdadada });
    trash.push(lineMat);
    for (const sx of [-1, 1]) {
      const ln = box(0.15, 0.02, len, lineMat, trash);
      ln.position.set(sx * (w / 2 - 0.4), 0.09, len / 2);
      lane.add(ln);
    }

    // The cut faces of the stand: a wall either side, rising with the rake.
    const rise = e.backY;
    for (const sx of [-1, 1]) {
      const wallGeo = new THREE.BufferGeometry();
      const z0 = 2;
      const z1 = 2 + (e.back - e.front);
      const x = sx * (w / 2 + 0.15);
      wallGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([x, 0, z0, x, Math.max(0.6, e.frontY), z0, x, 0, z1, x, rise, z1], 3),
      );
      wallGeo.setIndex([0, 1, 2, 1, 3, 2]);
      wallGeo.computeVertexNormals();
      trash.push(wallGeo);
      const wall = new THREE.Mesh(wallGeo, concrete);
      wall.castShadow = shadows;
      wall.receiveShadow = shadows;
      lane.add(wall);
      // Handrail along the top of the cut, where spectators stand beside it.
      const rail = box(0.08, 0.08, z1 - z0, fasciaWhite, trash);
      rail.position.set(x, 0, (z0 + z1) / 2);
      rail.position.y = (Math.max(0.6, e.frontY) + rise) / 2 + 1.0;
      rail.rotation.x = -Math.atan2(rise - Math.max(0.6, e.frontY), z1 - z0);
      lane.add(rail);
    }

    // Tunnel portal at the back of the tier: a dark mouth, a lintel with the
    // hazard band and the sign, and the concourse above it.
    const portalZ = 2 + (e.back - e.front);
    const mouthH = 5.2;
    const mouth = box(w, mouthH, 3, tunnelDark, trash);
    mouth.position.set(0, mouthH / 2, portalZ + 1.4);
    lane.add(mouth);
    const lintelMat = new THREE.MeshStandardMaterial({ map: chev, roughness: 0.6 });
    trash.push(lintelMat);
    const lintel = box(w + 0.6, 0.55, 0.4, lintelMat, trash);
    lintel.position.set(0, mouthH + 0.28, portalZ - 0.1);
    lane.add(lintel);
    const signMat = new THREE.MeshBasicMaterial({ map: sign, side: THREE.DoubleSide });
    trash.push(signMat);
    const signGeo = new THREE.PlaneGeometry(w * 0.8, w * 0.8 * (48 / 256));
    trash.push(signGeo);
    const sg = new THREE.Mesh(signGeo, signMat);
    sg.position.set(0, mouthH + 1.05, portalZ - 0.35);
    sg.rotation.y = Math.PI; // face the pitch
    lane.add(sg);
    const above = box(w + 0.6, Math.max(0.5, rise - mouthH - 0.6), 0.6, concrete, trash);
    above.position.set(0, mouthH + 0.55 + Math.max(0.5, rise - mouthH - 0.6) / 2, portalZ);
    lane.add(above);

    // One ambulance on standby, parked in the mouth of the first lane —
    // which is where they wait on a matchday, facing out onto the pitch.
    if (k === 0) {
      const amb = ambulance(trash);
      amb.rotation.y = Math.PI / 2; // nose toward the pitch (local -z)
      amb.position.set(0, 0.08, 6);
      lane.add(amb);
    }
    group.add(lane);
  });

  // ---- the concourse wall between tiers ------------------------------------
  // The back of each tier up to the underside of the one above it. Without it
  // the gap under an overhanging tier looks straight through the building.
  for (let t = 1; t < template.tiers.length; t++) {
    const below = tierEdges(template, t - 1);
    const above = tierEdges(template, t);
    const top = above.frontY + (below.back + 0.3 - above.front) * Math.tan((template.tiers[t].rakeDeg * Math.PI) / 180) - 0.4;
    if (top - below.backY < 0.8) continue;
    const g = curtain(at, 0, 1, below.back + 0.3, below.backY - 0.2, top, 360);
    trash.push(g);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3a3733, roughness: 0.95, side: THREE.DoubleSide }));
    trash.push(m.material as THREE.Material);
    group.add(m);
  }

  // ---- hospitality boxes -------------------------------------------------
  for (const band of details.boxes ?? []) {
    const t = band.underTier;
    if (t < 1 || t >= template.tiers.length) continue;
    const below = tierEdges(template, t - 1);
    const above = tierEdges(template, t);
    const top = above.frontY + (below.back + 0.5 - above.front) * Math.tan((template.tiers[t].rakeDeg * Math.PI) / 180) - 0.5;
    const y0 = below.backY + 0.1;
    const y1 = Math.max(y0 + 2.2, top);
    const tex = boxTexture();
    tex.repeat.set(band.count, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });
    const g = curtain(at, band.centerU - band.halfU, band.centerU + band.halfU, below.back + 0.25, y0, y1, 96);
    trash.push(tex, mat, g);
    group.add(new THREE.Mesh(g, mat));
    // White fascia band running the length of the boxes, above the glass.
    const fg = curtain(at, band.centerU - band.halfU - 0.004, band.centerU + band.halfU + 0.004, below.back - 0.05, y1, y1 + 0.7, 96);
    trash.push(fg);
    group.add(new THREE.Mesh(fg, fasciaWhite));
  }

  // ---- the royal box around the VIP zone ----------------------------------
  for (const z of details.zones ?? []) {
    if (z.kind !== 'vip') continue;
    const tier = z.tiers[0] ?? 1;
    const e = tierEdges(template, tier);
    const gold = new THREE.MeshStandardMaterial({ color: 0xc9a13a, roughness: 0.35, metalness: 0.7, emissive: 0x3a2a08, emissiveIntensity: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0xbfd8e6, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
    trash.push(gold, glass);
    // Glass screen along the front of the box, with a gold rail on top.
    const gg = curtain(at, z.centerU - z.halfU, z.centerU + z.halfU, e.front - 0.35, e.frontY - 0.2, e.frontY + 1.25, 24);
    trash.push(gg);
    group.add(new THREE.Mesh(gg, glass));
    const rg = curtain(at, z.centerU - z.halfU, z.centerU + z.halfU, e.front - 0.4, e.frontY + 1.25, e.frontY + 1.45, 24);
    trash.push(rg);
    group.add(new THREE.Mesh(rg, gold));
    // Gold side fins framing the box, and a canopy over the back rows.
    for (const s of [-1, 1]) {
      const p0 = at(z.centerU + s * z.halfU, e.front);
      const p1 = at(z.centerU + s * z.halfU, e.back);
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      // Low gold partitions, not walls: the box is open to the pitch, and the
      // broadcast camera sits right beside it.
      const fin = box(0.12, 1.1, len, gold, trash);
      fin.position.set((p0.x + p1.x) / 2, (e.frontY + e.backY) / 2 + 0.55, (p0.z + p1.z) / 2);
      fin.rotation.y = Math.atan2(p1.x - p0.x, p1.z - p0.z);
      fin.rotation.x = -Math.atan2(e.backY - e.frontY, len);
      group.add(fin);
    }
    const cg = curtain(at, z.centerU - z.halfU, z.centerU + z.halfU, e.back - 4, e.backY + 3.2, e.backY + 3.4, 24);
    trash.push(cg);
    group.add(new THREE.Mesh(cg, gold));
  }

  // ---- big screens --------------------------------------------------------
  const screens: VenueBuild['screens'] = [];
  const topTier = template.tiers.length - 1;
  const te = tierEdges(template, topTier);
  for (const sc of details.screens ?? []) {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_PX.w;
    canvas.height = SCREEN_PX.h;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    // Unlit and not tone-mapped: an LED board is a light source, and its
    // picture should read the same at noon and at midnight.
    const face = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const frame = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.6, metalness: 0.4 });
    const faceGeo = new THREE.PlaneGeometry(sc.widthM, sc.heightM);
    trash.push(texture, face, frame, faceGeo);
    // On the back of the top tier, just over the last row's heads, under the roof.
    const p = at(sc.centerU, te.back + 0.2);
    const holder = new THREE.Group();
    holder.position.set(p.x, te.backY + 0.7 + sc.heightM / 2, p.z);
    holder.rotation.y = Math.atan2(-p.nx, -p.nz); // face the pitch
    const back = box(sc.widthM + 0.8, sc.heightM + 0.8, 0.9, frame, trash);
    back.position.z = -0.5;
    holder.add(back);
    const faceMesh = new THREE.Mesh(faceGeo, face);
    faceMesh.position.z = 0.0;
    holder.add(faceMesh);
    group.add(holder);
    screens.push({ canvas, texture });
  }

  void map;
  return {
    object: group,
    disposables: trash,
    screens,
    screensChanged() {
      for (const s of screens) s.texture.needsUpdate = true;
    },
  };
}
