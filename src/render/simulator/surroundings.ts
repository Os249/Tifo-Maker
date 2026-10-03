import * as THREE from 'three';
import type { StadiumTemplate } from '../../core/types';
import { buildHorizon, buildSite, forecourt, groundTex, loadSite, type SiteBuild } from './site';

/**
 * Surroundings — the living world the stadium sits in. A dark ground plane, an
 * instanced city-skyline ring (glowing windows), a warm lamp-post plaza ring at
 * the stadium base, and streams of instanced pedestrians walking in toward the
 * ground on match night. Pedestrians are cross-quad billboards (read from any
 * angle) animated in update(dt). All instanced — a handful of draw calls.
 */

export interface Surroundings {
  readonly object: THREE.Group;
  update(dt: number): void;
  /** Lights in the windows and the street lights come on after dark. */
  setTimeOfDay(tod: 'day' | 'dusk' | 'night' | 'sunset'): void;
  /** Resolves once a real ground's neighbourhood has loaded and been added (at once for the generic city). */
  readonly ready: Promise<void>;
  /** A real ground's neighbourhood replaces the generic city (and the dark apron with it). */
  readonly real: boolean;
  /** What a camera on foot must stand clear of: a real ground's neighbourhood once it has loaded, else null. */
  sightlines(): Sightlines | null;
  dispose(): void;
}

export interface Sightlines {
  /** Is (x, z) open ground (not inside a building or a wall)? */
  walkable(x: number, z: number): boolean;
  /** Does a building, hall, mosque or wall stand between the two points? */
  blocked(from: THREE.Vector3, to: THREE.Vector3): boolean;
}

/** The neighbourhood's solid parts: what a view can be blocked by (not trees, cars, lamps or the ground). */
const SOLID = new Set(['site-buildings', 'site-halls', 'site-mosques', 'site-roofs', 'site-roof-units', 'site-walls']);

export interface RealSite {
  template: StadiumTemplate;
  /** Metres from the plan curve to the outside of everything the ground draws. */
  reach: number;
  shadows: boolean;
  detail: 'low' | 'full';
}

const NIGHT: Record<string, number> = { day: 0, sunset: 0.45, dusk: 0.75, night: 1 };

function windowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e1118';
  g.fillRect(0, 0, 64, 128);
  for (let y = 6; y < 128; y += 10) {
    for (let x = 6; x < 64; x += 12) {
      g.fillStyle = Math.random() < 0.45 ? '#ffd98a' : '#161d2a';
      g.fillRect(x, y, 7, 6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 6);
  return t;
}

/** A dark person silhouette with a warm rim light, on a transparent canvas. */
function personTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 32, 64);
  g.fillStyle = '#0a0c11';
  g.beginPath();
  g.ellipse(16, 46, 7, 17, 0, 0, Math.PI * 2); // torso + legs
  g.fill();
  g.beginPath();
  g.arc(16, 22, 6, 0, Math.PI * 2); // head
  g.fill();
  g.strokeStyle = 'rgba(255,196,120,0.5)'; // warm rim light down one side
  g.lineWidth = 2.5;
  g.beginPath();
  g.ellipse(16, 46, 7, 17, 0, -Math.PI / 2, Math.PI / 2);
  g.stroke();
  g.beginPath();
  g.arc(16, 22, 6, -Math.PI / 2, Math.PI / 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function crossQuad(w: number, h: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  const positions = new Float32Array([
    -hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, -hh, 0, hw, hh, 0, -hw, hh, 0,
    0, -hh, -hw, 0, -hh, hw, 0, hh, hw, 0, -hh, -hw, 0, hh, hw, 0, hh, -hw,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * @param bowlRadius metres from the middle to the outside of the building. The
 *   city is pushed out beyond it: a fixed ring put tower blocks inside the
 *   approach shot of a large ground — a 180 m oval had a skyscraper standing
 *   between the camera and its own facade — while leaving a small ground
 *   marooned in a car park. The skyline is context, so it has to know how big
 *   the thing it is context for actually is.
 */
export function buildSurroundings(bowlRadius = 130, real?: RealSite): Surroundings {
  if (real?.template.site) return buildRealSurroundings(bowlRadius, real);
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];

  // Far ground plane (asphalt-dark), well below the apron.
  const groundGeo = new THREE.PlaneGeometry(1600, 1600);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.2;
  group.add(ground);
  trash.push(groundGeo, groundMat);

  // City skyline ring (instanced buildings).
  const winTex = windowTexture();
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  const bMat = new THREE.MeshStandardMaterial({
    color: 0x232a36,
    map: winTex,
    emissive: 0xffe6b0,
    emissiveMap: winTex,
    emissiveIntensity: 0.5,
    roughness: 0.85,
    metalness: 0.1,
  });
  const COUNT = 170;
  const mesh = new THREE.InstancedMesh(bGeo, bMat, COUNT);
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    const ang = (i / COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
    const r = Math.max(240, bowlRadius * 1.9) + Math.random() * 240;
    const w = 8 + Math.random() * 22;
    const h = 14 + Math.random() * 92;
    const d = 8 + Math.random() * 22;
    dummy.position.set(Math.cos(ang) * r, h / 2 - 0.2, Math.sin(ang) * r);
    dummy.scale.set(w, h, d);
    dummy.rotation.y = ang + Math.PI / 2 + (Math.random() - 0.5);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const v = 0.6 + Math.random() * 0.6;
    mesh.setColorAt(i, tint.setRGB(v * 0.7, v * 0.74, v * 0.85));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  trash.push(bGeo, bMat, winTex);

  // Warm lamp-post plaza ring at the stadium base.
  const postGeo = new THREE.CylinderGeometry(0.35, 0.5, 15, 6);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x161a22, roughness: 0.6, metalness: 0.6, envMapIntensity: 0.6 });
  const bulbGeo = new THREE.SphereGeometry(1.2, 10, 10);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff2d4, emissive: 0xffcf87, emissiveIntensity: 2.4 });
  const LAMPS = 52;
  const posts = new THREE.InstancedMesh(postGeo, postMat, LAMPS);
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, LAMPS);
  posts.frustumCulled = false;
  bulbs.frustumCulled = false;
  const lm = new THREE.Object3D();
  for (let i = 0; i < LAMPS; i++) {
    const ang = (i / LAMPS) * Math.PI * 2;
    const x = Math.cos(ang) * 202;
    const z = Math.sin(ang) * 202;
    lm.position.set(x, 7.3, z);
    lm.updateMatrix();
    posts.setMatrixAt(i, lm.matrix);
    lm.position.set(x, 15.4, z);
    lm.updateMatrix();
    bulbs.setMatrixAt(i, lm.matrix);
  }
  posts.instanceMatrix.needsUpdate = true;
  bulbs.instanceMatrix.needsUpdate = true;
  group.add(posts, bulbs);
  trash.push(postGeo, postMat, bulbGeo, bulbMat);

  // Pedestrians — streams of fans converging on the stadium (cross-quad billboards).
  const personTex = personTexture();
  const personGeo = crossQuad(3.4, 7.2);
  const personMat = new THREE.MeshBasicMaterial({
    map: personTex,
    transparent: true,
    alphaTest: 0.4,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  const PEOPLE = 360;
  const people = new THREE.InstancedMesh(personGeo, personMat, PEOPLE);
  people.frustumCulled = false;
  const pAng = new Float32Array(PEOPLE);
  const pRad = new Float32Array(PEOPLE);
  const pSpd = new Float32Array(PEOPLE);
  const pPhase = new Float32Array(PEOPLE);
  const spawn = (i: number, near: boolean): void => {
    pAng[i] = Math.random() * Math.PI * 2;
    pRad[i] = near ? 200 + Math.random() * 170 : 345 + Math.random() * 45;
    pSpd[i] = 6 + Math.random() * 9;
    pPhase[i] = Math.random() * Math.PI * 2;
  };
  for (let i = 0; i < PEOPLE; i++) spawn(i, true);
  const pd = new THREE.Object3D();
  const writePeople = (t: number): void => {
    for (let i = 0; i < PEOPLE; i++) {
      const x = Math.cos(pAng[i]) * pRad[i];
      const z = Math.sin(pAng[i]) * pRad[i];
      const y = 3.7 + Math.sin(t * (pSpd[i] * 0.6) + pPhase[i]) * 0.35; // walking bob
      pd.position.set(x, y, z);
      pd.lookAt(0, y, 0); // face (and walk toward) the stadium
      pd.updateMatrix();
      people.setMatrixAt(i, pd.matrix);
    }
    people.instanceMatrix.needsUpdate = true;
  };
  writePeople(0);
  group.add(people);
  trash.push(personGeo, personMat, personTex);

  let clock = 0;
  return {
    object: group,
    real: false,
    ready: Promise.resolve(),
    sightlines: () => null,
    update(dt: number): void {
      clock += dt;
      for (let i = 0; i < PEOPLE; i++) {
        pRad[i] -= pSpd[i] * dt;
        if (pRad[i] < 196) spawn(i, false); // reached the ground — loop back out
      }
      writePeople(clock);
    },
    setTimeOfDay(): void {},
    dispose(): void {
      for (const t of trash) t.dispose();
    },
  };
}

/**
 * A real ground: its own neighbourhood (site.ts), a horizon of the right kind,
 * sand or paving underfoot instead of the dark void, and fans walking in down
 * its streets at walking pace and life size.
 */
function buildRealSurroundings(bowlRadius: number, real: RealSite): Surroundings {
  const spec = real.template.site!;
  const group = new THREE.Group();
  group.name = 'surroundings-real';
  const trash: { dispose(): void }[] = [];

  const groundGeo = new THREE.PlaneGeometry(6000, 6000);
  const gt = groundTex();
  gt.repeat.set(6000 / 64, 6000 / 64);
  const groundMat = new THREE.MeshStandardMaterial({ color: spec.ground ?? 0xc9b48e, map: gt, roughness: 1, metalness: 0 });
  trash.push(gt);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.2;
  ground.receiveShadow = real.shadows;
  ground.name = 'site-ground';
  group.add(ground);
  trash.push(groundGeo, groundMat);

  const court = forecourt(real.template, real.reach, spec.forecourt ?? 0xbdb6a8);
  court.receiveShadow = real.shadows;
  group.add(court);
  trash.push(court.geometry, court.material as THREE.Material);

  // Fans, life size, walking in at walking pace.
  const personTex = personTexture();
  const personGeo = crossQuad(0.75, 1.75);
  const personMat = new THREE.MeshBasicMaterial({ map: personTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
  const PEOPLE = real.detail === 'full' ? 700 : 250;
  const people = new THREE.InstancedMesh(personGeo, personMat, PEOPLE);
  people.frustumCulled = false;
  people.visible = false;
  people.name = 'site-fans';
  group.add(people);
  trash.push(personGeo, personMat, personTex);
  const px = new Float32Array(PEOPLE);
  const pz = new Float32Array(PEOPLE);
  const pSpd = new Float32Array(PEOPLE);
  const pPhase = new Float32Array(PEOPLE);
  const stopAt = bowlRadius + 6;
  let site: SiteBuild | null = null;
  let horizon: ReturnType<typeof buildHorizon> | null = null;
  let night = NIGHT.dusk;
  let seed = 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pathClear = (x: number, z: number) => {
    if (!site) return false;
    const L = Math.hypot(x, z);
    for (let d = stopAt; d < L; d += 3) if (!site.walkable((x / L) * d, (z / L) * d)) return false;
    return true;
  };
  // Fans start out on the streets and in the car parks (most within a few
  // hundred metres) and walk in to the ground; a few come across open ground.
  const spawn = (i: number, anywhere: boolean) => {
    for (let k = 0; k < 40; k++) {
      let x: number;
      let z: number;
      const p = k < 30 && rand() < 0.85 ? site?.pavedPoint(rand) : null;
      if (p) {
        [x, z] = p;
        const r = Math.hypot(x, z);
        // New arrivals appear at the edge of the crowd, not in the middle of it.
        if (r < stopAt + 8 || r > 320 || (!anywhere && r < 200)) continue;
      } else {
        const a = rand() * Math.PI * 2;
        const r = anywhere ? stopAt + 10 + rand() * 300 : 300 + rand() * 40;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
      }
      if (pathClear(x, z)) {
        px[i] = x;
        pz[i] = z;
        pSpd[i] = 1.1 + rand() * 0.7;
        pPhase[i] = rand() * 6.28;
        return;
      }
    }
    px[i] = 0;
    pz[i] = 0;
  };
  const pd = new THREE.Object3D();
  const writePeople = (t: number) => {
    for (let i = 0; i < PEOPLE; i++) {
      const y = 0.88 + Math.abs(Math.sin(t * 4 * pSpd[i] + pPhase[i])) * 0.05;
      pd.position.set(px[i], y, pz[i]);
      pd.lookAt(0, y, 0);
      pd.updateMatrix();
      people.setMatrixAt(i, pd.matrix);
    }
    people.instanceMatrix.needsUpdate = true;
  };

  const ready = loadSite(spec.key).then((data) => {
    if (!data) return;
    site = buildSite(real.template, spec, data, { shadows: real.shadows, detail: real.detail });
    group.add(site.object);
    const tex = horizonTextures();
    trash.push(tex.facade, tex.lit);
    const h = buildHorizon(spec, data.r, tex);
    horizon = h;
    group.add(h.object);
    site.setNight(night);
    h.setNight(night);
    for (let i = 0; i < PEOPLE; i++) spawn(i, true);
    writePeople(0);
    people.visible = true;
  });

  let clock = 0;
  return {
    object: group,
    real: true,
    ready,
    sightlines(): Sightlines | null {
      if (!site) return null;
      const s = site;
      const ray = new THREE.Raycaster();
      const dir = new THREE.Vector3();
      const solids: THREE.Object3D[] = s.object.children.filter((c) => SOLID.has(c.name));
      s.object.updateMatrixWorld(true);
      return {
        walkable: (x, z) => s.walkable(x, z),
        blocked(from, to) {
          dir.subVectors(to, from);
          const L = dir.length();
          if (L < 1e-3) return false;
          ray.set(from, dir.divideScalar(L));
          ray.far = L;
          return ray.intersectObjects(solids, true).length > 0;
        },
      };
    },
    update(dt: number): void {
      if (!site) return;
      clock += dt;
      for (let i = 0; i < PEOPLE; i++) {
        const L = Math.hypot(px[i], pz[i]);
        if (L < stopAt) {
          spawn(i, false);
          continue;
        }
        const s = (pSpd[i] * dt) / L;
        px[i] -= px[i] * s;
        pz[i] -= pz[i] * s;
      }
      writePeople(clock);
    },
    setTimeOfDay(tod): void {
      night = NIGHT[tod] ?? 0.75;
      site?.setNight(night);
      horizon?.setNight(night);
    },
    dispose(): void {
      site?.dispose();
      horizon?.dispose();
      for (const t of trash) t.dispose();
    },
  };
}

/** Façade textures for the horizon's blocks: plaster with windows, and which windows are lit. */
function horizonTextures(): { facade: THREE.Texture; lit: THREE.Texture } {
  const mk = (lit: boolean) => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = lit ? '#000' : '#ece6d8';
    g.fillRect(0, 0, 64, 64);
    for (let y = 6; y < 64; y += 16)
      for (let x = 6; x < 64; x += 16) {
        g.fillStyle = lit ? (Math.random() < 0.4 ? '#ffd79a' : '#000') : '#4a5260';
        g.fillRect(x, y, 7, 8);
      }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { facade: mk(false), lit: mk(true) };
}
