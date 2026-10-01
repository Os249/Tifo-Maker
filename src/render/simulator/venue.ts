import * as THREE from 'three';
import type { StadiumTemplate, SeatMap } from '../../core/types';
import { curveSampler, laneCut, laneLines, tierEdges, type LaneLine } from '../../core/venueDetails';
import { sideOfU, spanGeometry, spanOn } from '../../core/standSpans';

/**
 * A real ground's details, drawn from its template (VenueDetails in types.ts):
 *
 *   - vehicle lanes: the ramp floor, the cut faces of the stand either side,
 *     and the tunnel mouth under the rows that run over its roof (or a portal
 *     at the back, for a lane cut the full depth of its tier), with an
 *     ambulance on standby in one of them
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
  /**
   * The screens' picture: ONE canvas and one texture shared by every screen —
   * they show the same thing, so painting it once is the whole cost. Null on a
   * ground without screens. Call `screensChanged` after painting.
   */
  screen: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } | null;
  screenCount: number;
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

/**
 * The inside of one hospitality box, seen through its glass: a lit back wall,
 * a TV, a framed print, people at the bar. Repeated once per box.
 */
function boxInteriorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  const wall = g.createLinearGradient(0, 0, 0, 64);
  wall.addColorStop(0, '#f3d9a6');
  wall.addColorStop(1, '#b98247');
  g.fillStyle = wall;
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#1b1d22'; // the TV
  g.fillRect(18, 14, 30, 18);
  g.fillStyle = '#3f6fb5';
  g.fillRect(20, 16, 26, 14);
  g.fillStyle = '#6b4a2b'; // a framed print
  g.fillRect(78, 12, 22, 16);
  g.fillStyle = '#e9d7b0';
  g.fillRect(80, 14, 18, 12);
  g.fillStyle = '#4a2f1d'; // the bar counter
  g.fillRect(0, 46, 128, 18);
  g.fillStyle = 'rgba(40,24,14,0.75)'; // people
  for (const [x, h] of [[12, 22], [30, 25], [60, 23], [94, 24], [112, 21]] as const) {
    g.beginPath();
    g.arc(x, 64 - h - 4, 4, 0, Math.PI * 2);
    g.fill();
    g.fillRect(x - 5, 64 - h, 10, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Hazard hatching for the keep-clear box in front of a ramp. */
function hatchTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(242,196,15,0.95)';
  g.lineWidth = 6;
  for (let k = -64; k < 128; k += 16) {
    g.beginPath();
    g.moveTo(k, 64);
    g.lineTo(k + 64, 0);
    g.stroke();
  }
  g.strokeRect(2, 2, 60, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
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
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f5132';
  g.fillRect(0, 0, 512, 96);
  g.fillStyle = '#ffffff';
  g.font = 'bold 42px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Held to the sign's width: fonts differ, and a wide one ran off the end.
  g.fillText('طوارئ  •  EMERGENCY', 256, 50, 480);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A Saudi Red Crescent-style ambulance: white van, red band, light bar. Generic. */
export function ambulance(trash: Trash[]): THREE.Group {
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
  // Distance of a ground-plane point from the plan curve (outward positive):
  // the offset the seat map and the concrete are laid out by.
  const planPts: { x: number; z: number }[] = [];
  for (let i = 0; i < 2048; i++) planPts.push(at(i / 2048, 0));
  const offsetFromPlan = (x: number, z: number): number => {
    let best = Infinity;
    for (const q of planPts) {
      const d = (q.x - x) ** 2 + (q.z - z) ** 2;
      if (d < best) best = d;
    }
    const inside = Math.abs(x / template.plan.a) ** template.plan.exponent + Math.abs(z / template.plan.b) ** template.plan.exponent < 1;
    return inside ? -Math.sqrt(best) : Math.sqrt(best);
  };

  const concrete = new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95, side: THREE.DoubleSide });
  const soffitMat = new THREE.MeshStandardMaterial({ color: 0x2c2926, roughness: 0.95, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.9, side: THREE.DoubleSide });
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.92 });
  const tunnelDark = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 1 });
  const fasciaWhite = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.55, metalness: 0.1 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c40f, roughness: 0.5 });
  const cladding = new THREE.MeshStandardMaterial({ color: 0xd6d2c9, roughness: 0.7, side: THREE.DoubleSide, emissive: 0x3d3a35 });
  const tunnelWall = new THREE.MeshStandardMaterial({ color: 0x8a867e, roughness: 0.9, side: THREE.BackSide, emissive: 0x2a2620 });
  const tunnelGate = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.8, side: THREE.BackSide });
  const tunnelLight = new THREE.MeshBasicMaterial({ color: 0xfff1d8 });
  const railGlass = new THREE.MeshStandardMaterial({ color: 0xbfd6e0, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  trash.push(concrete, soffitMat, floorMat, asphalt, tunnelDark, fasciaWhite, yellow, cladding, tunnelWall, tunnelGate, tunnelLight, railGlass);

  // ---- vehicle lanes ------------------------------------------------------
  // Local frame per lane: +z runs outward along the lane, z = 0 is the front
  // edge of the tier it cuts. Everything stays behind z = -1.5 — the ramp is
  // in the stand, the ambulance waits in the stand, and the only thing on the
  // run-off is the painted keep-clear box.
  const lanes = laneLines(template);
  const chev = lanes.length ? chevronTexture() : null;
  const sign = lanes.length ? emergencySign() : null;
  const hatch = lanes.length ? hatchTexture() : null;
  if (chev) trash.push(chev);
  if (sign) trash.push(sign);
  if (hatch) trash.push(hatch);
  lanes.forEach((l: LaneLine, k) => {
    const e = tierEdges(template, l.lane.tier);
    const cut = laneCut(template, l.lane);
    const w = l.lane.widthM;
    const depth = cut.back - e.front; // how far the open cut runs into the stand
    // A tunnel when the lane stops short of the back of the tier: the rows
    // behind it sit on the tunnel roof. Otherwise the cut runs the full depth
    // and the portal is at the back of the tier.
    const tunnel = cut.back < e.back - 1e-6;
    const lane = new THREE.Group();
    lane.name = 'vehicle-lane';
    lane.position.set(l.x + l.dx * e.front, 0, l.z + l.dz * e.front);
    lane.rotation.y = Math.atan2(l.dx, l.dz);

    // Clear height of the mouth, and the lintel over it up to the deck.
    const mouthH = tunnel ? Math.max(3.2, cut.backY - 0.7) : 5.2;
    const lintelH = tunnel ? Math.max(0.35, cut.backY - mouthH) : 0.55;
    const tunnelLen = 12;

    // Road from the run-off's edge to the back of the tunnel, with edge lines.
    const roadLen = depth + (tunnel ? tunnelLen : 4.5);
    const road = box(w, 0.08, roadLen, asphalt, trash);
    road.position.set(0, 0.04, roadLen / 2);
    road.receiveShadow = shadows;
    lane.add(road);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xdadada });
    trash.push(lineMat);
    for (const sx of [-1, 1]) {
      const ln = box(0.12, 0.02, roadLen, lineMat, trash);
      ln.position.set(sx * (w / 2 - 0.35), 0.09, roadLen / 2);
      lane.add(ln);
    }
    // Keep-clear hatching on the run-off in front of the ramp.
    const hatchMat = new THREE.MeshBasicMaterial({ map: hatch, transparent: true, depthWrite: false });
    const hatchGeo = new THREE.PlaneGeometry(w, 1.4);
    trash.push(hatchMat, hatchGeo);
    const hb = new THREE.Mesh(hatchGeo, hatchMat);
    hb.rotation.x = -Math.PI / 2;
    hb.position.set(0, 0.03, -0.75);
    lane.add(hb);

    // The cut faces of the stand, clad in white like the real portals, built
    // along the concrete's real edge: each point up the lane's side line gets
    // the deck height for its actual distance from the plan curve — the same
    // test the concrete was clipped with — so wall and deck meet with no slit
    // and no notch at the front.
    const rakeTan = Math.tan((template.tiers[l.lane.tier].rakeDeg * Math.PI) / 180);
    const deckY = (r: number): number => e.frontY + (Math.min(cut.back, Math.max(e.front, r)) - e.front) * rakeTan;
    const bx = l.x + l.dx * e.front;
    const bz = l.z + l.dz * e.front;
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2);
      const pts: { z: number; top: number }[] = [];
      for (let z = -3; z <= depth + 3; z += 0.25) {
        // Lane-local (x, z) to world: +z along the lane, +x = (dz, -dx).
        const wx = bx + l.dx * z + l.dz * x;
        const wz = bz + l.dz * z - l.dx * x;
        const r = offsetFromPlan(wx, wz);
        if (r < e.front - 0.02 || r > cut.back + 0.02) continue;
        pts.push({ z, top: deckY(r) + 0.02 });
      }
      if (pts.length < 2) continue;
      const pos: number[] = [];
      const idx: number[] = [];
      pts.forEach((q, i) => {
        pos.push(x, 0, q.z, x, q.top, q.z);
        if (i > 0) {
          const k2 = (i - 1) * 2;
          idx.push(k2, k2 + 1, k2 + 2, k2 + 1, k2 + 3, k2 + 2);
        }
      });
      const wallGeo = new THREE.BufferGeometry();
      wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      wallGeo.setIndex(idx);
      wallGeo.computeVertexNormals();
      trash.push(wallGeo);
      const wall = new THREE.Mesh(wallGeo, cladding);
      wall.castShadow = shadows;
      wall.receiveShadow = shadows;
      lane.add(wall);
      // Handrail along the top of the cut, where spectators stand beside it.
      const railPath = new THREE.CurvePath<THREE.Vector3>();
      const rp = pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).map((q) => new THREE.Vector3(x, q.top + 1.05, q.z));
      for (let i = 0; i < rp.length - 1; i++) railPath.add(new THREE.LineCurve3(rp[i], rp[i + 1]));
      if (rp.length > 1) {
        const railGeo = new THREE.TubeGeometry(railPath, rp.length * 2, 0.04, 6, false);
        trash.push(railGeo);
        lane.add(new THREE.Mesh(railGeo, fasciaWhite));
      }
      // A yellow bollard either side of the mouth.
      const bol = box(0.3, 0.9, 0.3, yellow, trash);
      bol.position.set(sx * (w / 2 - 0.45), 0.45, 0.2);
      lane.add(bol);
    }

    if (tunnel) {
      // The tunnel itself: a lit concrete box running on under the stand, open
      // to the pitch, with a gate at the far end — seen from the stands as a
      // doorway in the front rows, which is what the real one is.
      const inner = new THREE.BoxGeometry(w, mouthH, tunnelLen);
      trash.push(inner);
      const hidden = new THREE.MeshBasicMaterial({ visible: false });
      trash.push(hidden);
      // BoxGeometry face order: +x, -x, +y, -y, +z (far end), -z (the mouth).
      const tube = new THREE.Mesh(inner, [tunnelWall, tunnelWall, tunnelWall, hidden, tunnelGate, hidden]);
      tube.position.set(0, mouthH / 2, depth + tunnelLen / 2);
      lane.add(tube);
      const strip = box(0.35, 0.04, tunnelLen - 1, tunnelLight, trash);
      strip.position.set(0, mouthH - 0.03, depth + tunnelLen / 2);
      lane.add(strip);
      // The lintel: white, under the first row that runs over the roof, with
      // the sign on its face and a hazard band along its underside.
      const lintel = box(w, lintelH, 0.5, fasciaWhite, trash);
      lintel.position.set(0, mouthH + lintelH / 2, depth + 0.25);
      lane.add(lintel);
      const bandMat = new THREE.MeshStandardMaterial({ map: chev, roughness: 0.6 });
      trash.push(bandMat);
      const band = box(w, 0.12, 0.52, bandMat, trash);
      band.position.set(0, mouthH + 0.06, depth + 0.25);
      lane.add(band);
      const signMat = new THREE.MeshBasicMaterial({ map: sign, side: THREE.DoubleSide });
      const sh = Math.min(0.42, lintelH - 0.2);
      const signGeo = new THREE.PlaneGeometry(sh * (256 / 48), sh);
      trash.push(signMat, signGeo);
      const sg = new THREE.Mesh(signGeo, signMat);
      sg.position.set(0, mouthH + 0.12 + (lintelH - 0.12) / 2, depth - 0.01);
      sg.rotation.y = Math.PI; // face the pitch
      lane.add(sg);
      // Glass and a rail along the edge of the row above the mouth.
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.0), railGlass);
      trash.push(glass.geometry);
      glass.position.set(0, cut.backY + 0.5, depth + 0.02);
      lane.add(glass);
      const topRail = box(w, 0.06, 0.06, fasciaWhite, trash);
      topRail.position.set(0, cut.backY + 1.05, depth + 0.02);
      lane.add(topRail);
    } else {
      // The barrier arm, raised (it is a matchday: the ramp is kept open).
      const arm = box(0.12, w - 1.6, 0.12, yellow, trash);
      arm.position.set(-(w / 2 - 0.6), 1.0 + (w - 1.6) / 2, 0.2);
      lane.add(arm);
      // Tunnel portal at the back of the tier: a dark mouth, a lintel with the
      // hazard band and the sign, and the concourse above it.
      const mouth = box(w, mouthH, 3.4, tunnelDark, trash);
      mouth.position.set(0, mouthH / 2, depth + 1.7);
      lane.add(mouth);
      const lintelMat = new THREE.MeshStandardMaterial({ map: chev, roughness: 0.6 });
      trash.push(lintelMat);
      const lintel = box(w + 0.6, lintelH, 0.4, lintelMat, trash);
      lintel.position.set(0, mouthH + 0.28, depth - 0.1);
      lane.add(lintel);
      const signMat = new THREE.MeshBasicMaterial({ map: sign, side: THREE.DoubleSide });
      const signGeo = new THREE.PlaneGeometry(w * 0.8, w * 0.8 * (48 / 256));
      trash.push(signMat, signGeo);
      const sg = new THREE.Mesh(signGeo, signMat);
      sg.position.set(0, mouthH + 1.05, depth - 0.35);
      sg.rotation.y = Math.PI; // face the pitch
      lane.add(sg);
      const aboveH = Math.max(0.5, e.backY - mouthH - 0.6);
      const above = box(w + 0.6, aboveH, 0.6, concrete, trash);
      above.position.set(0, mouthH + 0.55 + aboveH / 2, depth);
      lane.add(above);
    }

    // One ambulance on standby, parked in the first lane — in the stand, not
    // on the grass — nose out, its tail just inside the tunnel.
    if (k === 0) {
      const amb = ambulance(trash);
      amb.rotation.y = Math.PI / 2; // nose toward the pitch (local -z)
      // The van runs 4.1 m ahead of its origin and 2.8 m behind it.
      amb.position.set(0, 0.08, tunnel ? Math.max(4.4, depth - 1.4) : Math.min(depth - 3.8, 7.5));
      lane.add(amb);
    }
    group.add(lane);
  });

  // ---- between the tiers: concourse floor, soffit and back wall -----------
  // Under an overhanging tier there is a concourse: a floor, the underside of
  // the tier above, and a wall at the back of it. Without them the gap looks
  // straight through the building. The hospitality boxes live in here.
  const CONCOURSE = 5;
  for (let t = 1; t < template.tiers.length; t++) {
    // A ring tier has one concourse all the way round; a tier made of stands
    // (TierSpec.stands) has one behind each of its stands only.
    const runs: { below: ReturnType<typeof tierEdges>; above: ReturnType<typeof tierEdges>; u0: number; u1: number }[] = [];
    if (template.tiers[t].stands) {
      for (const sg of spanGeometry(template)[t]) {
        const lo = template.tiers[t - 1].stands ? spanOn(template, t - 1, sg.side) : null;
        const below = lo ?? tierEdges(template, t - 1);
        runs.push({ below, above: sg, u0: sg.u0, u1: sg.u1 });
      }
    } else {
      runs.push({ below: tierEdges(template, t - 1), above: tierEdges(template, t), u0: 0, u1: 1 });
    }
    const rakeT = Math.tan((template.tiers[t].rakeDeg * Math.PI) / 180);
    for (const { below, above, u0, u1 } of runs) {
      const under = (r: number): number => above.frontY + (r - above.front) * rakeT - 0.45;
      const r0 = below.back + 0.2;
      const r1 = below.back + CONCOURSE;
      if (under(r0) - below.backY < 1) continue;
      // A full ring keeps the resolution it always had; a stand's run gets its share.
      const ring = u0 === 0 && u1 === 1;
      const segs = ring ? 240 : Math.max(24, Math.round((u1 - u0) * 360));
      const floor = new THREE.Mesh(flatRing(at, r0, r1, below.backY - 0.05, below.backY - 0.05, u0, u1, segs), floorMat);
      const soffit = new THREE.Mesh(flatRing(at, above.front + 0.3, r1, under(above.front + 0.3), under(r1), u0, u1, segs), soffitMat);
      const back = new THREE.Mesh(curtain(at, u0, u1, r1, below.backY - 0.1, under(r1) + 0.1, ring ? 360 : segs), soffitMat);
      for (const m of [floor, soffit, back]) {
        trash.push(m.geometry);
        group.add(m);
      }
    }
  }

  // ---- hospitality boxes ---------------------------------------------------
  // Real rooms: a glass front, white mullions and party walls, a lit interior
  // four metres deep with a downlight strip, under the tier above.
  const unit = new THREE.BoxGeometry(1, 1, 1);
  trash.push(unit);
  const posts: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }[] = [];
  for (const band of details.boxes ?? []) {
    const t = band.underTier;
    if (t < 1 || t >= template.tiers.length) continue;
    // On a ground of separate stands, the stand on the band's side.
    const side = sideOfU(band.centerU);
    const below = (template.tiers[t - 1].stands ? spanOn(template, t - 1, side) : null) ?? tierEdges(template, t - 1);
    const above = (template.tiers[t].stands ? spanOn(template, t, side) : null) ?? tierEdges(template, t);
    const rakeT = Math.tan((template.tiers[t].rakeDeg * Math.PI) / 180);
    const under = (r: number): number => above.frontY + (r - above.front) * rakeT - 0.45;
    const gl = below.back + 0.3; // the glass line
    const inner = gl + 4.2; // the back wall of the rooms
    const y0 = below.backY;
    const y1 = Math.min(y0 + 2.9, under(gl) - 0.05);
    if (y1 - y0 < 2) continue;
    const u0 = band.centerU - band.halfU;
    const u1 = band.centerU + band.halfU;

    const interior = boxInteriorTexture();
    interior.repeat.set(band.count, 1);
    const intMat = new THREE.MeshStandardMaterial({ map: interior, emissive: 0xffffff, emissiveMap: interior, emissiveIntensity: 0.7, roughness: 0.8, side: THREE.DoubleSide });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xa9c9da, roughness: 0.04, metalness: 0.5, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xffe6b8, emissiveIntensity: 0.6, side: THREE.DoubleSide });
    trash.push(interior, intMat, glassMat, ceilMat);
    const backWall = curtain(at, u0, u1, inner, y0, y1, 96);
    const glassFront = curtain(at, u0, u1, gl, y0 + 0.02, y1, 96);
    const ceiling = flatRing(at, gl, inner, y1, y1, u0, u1);
    const floorG = flatRing(at, gl, inner, y0 + 0.01, y0 + 0.01, u0, u1);
    trash.push(backWall, glassFront, ceiling, floorG);
    group.add(new THREE.Mesh(backWall, intMat), new THREE.Mesh(ceiling, ceilMat), new THREE.Mesh(floorG, floorMat), new THREE.Mesh(glassFront, glassMat));
    // White fascia band above the glass, running the length of the boxes.
    // Up to the soffit, so there is no slot of sky between the two.
    const fg = curtain(at, u0 - 0.003, u1 + 0.003, gl - 0.05, y1, Math.max(y1 + 0.6, under(gl - 0.05) + 0.05), 96);
    trash.push(fg);
    group.add(new THREE.Mesh(fg, fasciaWhite));
    // Mullions at every box boundary, and a party wall back from each.
    for (let b = 0; b <= band.count; b++) {
      const u = u0 + ((u1 - u0) * b) / band.count;
      const pf = at(u, gl);
      const pb = at(u, inner);
      const ry = Math.atan2(pb.x - pf.x, pb.z - pf.z);
      const mid = at(u, (gl + inner) / 2);
      posts.push({ x: pf.x, y: (y0 + y1) / 2, z: pf.z, sx: 0.14, sy: y1 - y0, sz: 0.14, ry });
      posts.push({ x: mid.x, y: (y0 + y1) / 2, z: mid.z, sx: 0.12, sy: y1 - y0, sz: inner - gl, ry });
      // A slimmer mullion in the middle of each pane.
      if (b < band.count) {
        const um = u + (u1 - u0) / band.count / 2;
        const pm = at(um, gl);
        posts.push({ x: pm.x, y: (y0 + y1) / 2, z: pm.z, sx: 0.06, sy: y1 - y0, sz: 0.06, ry });
      }
    }
  }
  if (posts.length) {
    const postMesh = new THREE.InstancedMesh(unit, fasciaWhite, posts.length);
    const d = new THREE.Object3D();
    posts.forEach((q, i) => {
      d.position.set(q.x, q.y, q.z);
      d.rotation.set(0, q.ry, 0);
      d.scale.set(q.sx, q.sy, q.sz);
      d.updateMatrix();
      postMesh.setMatrixAt(i, d.matrix);
    });
    postMesh.instanceMatrix.needsUpdate = true;
    postMesh.frustumCulled = false;
    trash.push({ dispose: () => postMesh.dispose() });
    group.add(postMesh);
  }

  // ---- big screens --------------------------------------------------------
  // Every screen shows the same picture (one canvas, one texture): the ones on
  // the stands, the ones hung from the roof, a centre-hung board and the
  // portrait screens on the corner columns.
  const screens = details.screens ?? [];
  const centre = details.centreScreen;
  const corners = details.cornerScreens;
  let screen: VenueBuild['screen'] = null;
  let screenCount = 0;
  if (screens.length || centre || corners) {
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
    const steel = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.7, metalness: 0.5 });
    trash.push(texture, face, frame, steel);
    screen = { canvas, texture };
    const rod = new THREE.CylinderGeometry(0.06, 0.06, 1, 6);
    trash.push(rod);
    const hangers = (holder: THREE.Object3D, xs: [number, number][], top: number, len: number): void => {
      for (const [x, z] of xs) {
        const r = new THREE.Mesh(rod, steel);
        r.scale.y = len;
        r.position.set(x, top + len / 2, z);
        holder.add(r);
      }
    };
    // Where a screen on the back of a stand stands: the highest tier with a
    // stand on that side, or the top tier of a ring bowl.
    const backOf = (u: number): ReturnType<typeof tierEdges> => {
      const side = sideOfU(u);
      for (let t = template.tiers.length - 1; t >= 0; t--) {
        if (!template.tiers[t].stands) return tierEdges(template, t);
        const sg = spanOn(template, t, side);
        if (sg) return sg;
      }
      return tierEdges(template, template.tiers.length - 1);
    };
    for (const sc of screens) {
      const faceGeo = new THREE.PlaneGeometry(sc.widthM, sc.heightM);
      trash.push(faceGeo);
      const holder = new THREE.Group();
      if (sc.hang) {
        // Hung from the roof over the stand, facing the pitch.
        const p = at(sc.centerU, sc.hang.offset);
        holder.position.set(p.x, sc.hang.y, p.z);
        holder.rotation.y = Math.atan2(-p.nx, -p.nz);
        const topY = sc.hang.y + sc.heightM / 2 + 0.4;
        hangers(holder, [[-sc.widthM * 0.35, -0.4], [sc.widthM * 0.35, -0.4]], sc.heightM / 2 + 0.4, Math.max(0.5, (sc.hang.ceiling ?? topY + 14) - topY));
      } else {
        // On the back of the top tier, just over the last row's heads, under the roof.
        const te = backOf(sc.centerU);
        const p = at(sc.centerU, te.back + 0.2);
        holder.position.set(p.x, te.backY + 0.7 + sc.heightM / 2, p.z);
        holder.rotation.y = Math.atan2(-p.nx, -p.nz); // face the pitch
      }
      const back = box(sc.widthM + 0.8, sc.heightM + 0.8, 0.9, frame, trash);
      back.position.z = -0.5;
      holder.add(back, new THREE.Mesh(faceGeo, face));
      group.add(holder);
      screenCount++;
    }
    if (centre) {
      // Four faces round a dark box, hung on cables over the centre spot.
      const board = new THREE.Group();
      board.name = 'centre-screen';
      board.position.set(0, centre.y, 0);
      // Footprint: widthM along x, depthM along z. The long faces sit at ±z
      // looking at the side stands; the short ones at ±x looking at the ends.
      const body = box(centre.widthM, centre.heightM + 0.6, centre.depthM, frame, trash);
      board.add(body);
      const longFace = new THREE.PlaneGeometry(centre.widthM, centre.heightM);
      const shortFace = new THREE.PlaneGeometry(centre.depthM, centre.heightM);
      trash.push(longFace, shortFace);
      for (const [geo, x, z, ry] of [
        [longFace, 0, centre.depthM / 2 + 0.02, 0],
        [longFace, 0, -centre.depthM / 2 - 0.02, Math.PI],
        [shortFace, centre.widthM / 2 + 0.02, 0, Math.PI / 2],
        [shortFace, -centre.widthM / 2 - 0.02, 0, -Math.PI / 2],
      ] as [THREE.PlaneGeometry, number, number, number][]) {
        const m = new THREE.Mesh(geo, face);
        m.position.set(x, 0, z);
        m.rotation.y = ry;
        board.add(m);
      }
      const hx = centre.widthM / 2 - 0.5;
      const hz = centre.depthM / 2 - 0.5;
      const top = centre.y + centre.heightM / 2 + 0.3;
      hangers(board, [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]], centre.heightM / 2 + 0.3, Math.max(0.5, (centre.ceiling ?? top + 16) - top));
      group.add(board);
      screenCount += 4;
    }
    if (corners) {
      // A steel column at each corner of the pitch, where the stands do not
      // meet, carrying a portrait screen that faces the centre spot. The
      // picture is the same landscape one, turned on its side.
      const { a, b } = template.plan;
      const portrait = new THREE.PlaneGeometry(corners.widthM, corners.heightM);
      const uv = portrait.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        uv.setXY(i, v, 1 - u);
      }
      uv.needsUpdate = true;
      trash.push(portrait);
      const colTop = corners.columnTop ?? Math.max(corners.y + corners.heightM / 2 + 18, 30);
      for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as [number, number][]) {
        const x = sx * (a + 1.2);
        const z = sz * (b + 1.2);
        const col = box(1.1, colTop, 1.1, steel, trash);
        col.position.set(x, colTop / 2, z);
        group.add(col);
        const holder = new THREE.Group();
        holder.position.set(x - sx * 0.9, corners.y, z - sz * 0.9);
        holder.rotation.y = Math.atan2(-x, -z);
        const back = box(corners.widthM + 0.4, corners.heightM + 0.4, 0.5, frame, trash);
        back.position.z = -0.3;
        holder.add(back, new THREE.Mesh(portrait, face));
        group.add(holder);
        screenCount++;
      }
    }
  }

  void map;
  return {
    object: group,
    disposables: trash,
    screen,
    screenCount,
    screensChanged() {
      if (screen) screen.texture.needsUpdate = true;
    },
  };
}

/**
 * A horizontal-ish band between two offsets of the plan curve (optionally only
 * between u0 and u1), with its own height at each edge — a floor, a ceiling,
 * or a sloping soffit.
 */
function flatRing(
  at: (u: number, off: number) => { x: number; z: number },
  rIn: number,
  rOut: number,
  yIn: number,
  yOut: number,
  u0 = 0,
  u1 = 1,
  segs = 240,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = u0 + ((u1 - u0) * i) / segs;
    const a = at(u, rIn);
    const b = at(u, rOut);
    pos.push(a.x, yIn, a.z, b.x, yOut, b.z);
  }
  for (let i = 0; i < segs; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
