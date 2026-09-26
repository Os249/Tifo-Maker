import * as THREE from 'three';
import type { SeatMap } from '../../core/types';
import {
  ACCESSORY_BUDGET,
  ACCESSORY_KINDS,
  FLARE_COLOURS,
  SMOKE_COLOURS,
  clubColours,
  indexStands,
  noAccessories,
  planHolders,
  type AccessoryKind,
  type AccessoryLevel,
  type AccessoryLevels,
  type AccessoryWhere,
  type StandSeats,
} from '../../core/accessories';
import type { QualityTier } from './quality';
import { buildPhoneFlash, type PhoneFlash } from './sparkles';

/**
 * Match Day — the accessories fans bring into the stand: flags, flares, smoke
 * pots, strobes, paper and phone lights, each at a level (see core/accessories).
 *
 * Everything here stands on a REAL seat. The planner picks which seats hold
 * one; this file puts the thing in their hands: a flare held overhead at arm's
 * length, a smoke pot at their feet, a flag on a stick above their heads. So
 * a flare line runs along the actual front row of whatever ground is loaded,
 * and turning the level up fills the stand the way a real one fills.
 *
 * Rendering is camera-facing quads drawn in one instanced call per system
 * (not GL points: a smoke puff is metres across, and point sprites are capped
 * at a few hundred pixels on plenty of phones). The crowd and the seats are
 * unlit, so a flare's glow on the fans around it is an additive haze laid over
 * them; a few real point lights add the glow on the concrete, roof and pitch,
 * built once at startup so switching flares on never recompiles a shader.
 */

export interface AccessoriesCensus {
  holders: Record<AccessoryKind, number>;
  /** Live smoke, spark and paper quads right now. */
  particles: number;
  /** Point lights currently casting (intensity > 0). */
  lightsOn: number;
}

export interface AccessoriesController {
  readonly object: THREE.Group;
  levels(): AccessoryLevels;
  setLevel(kind: AccessoryKind, level: AccessoryLevel): void;
  setWhere(where: AccessoryWhere): void;
  where(): AccessoryWhere;
  setFlareColour(id: string): void;
  setSmokeColour(id: string): void;
  setPalette(palette: readonly string[]): void;
  /** `view`: the camera's vertical field of view (degrees) and the canvas height in CSS px. */
  update(dt: number, view?: { fov: number; height: number }): void;
  census(): AccessoriesCensus;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Textures, made once
// ---------------------------------------------------------------------------

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; // masks, not pictures
  return t;
}

/** A soft round glow, bright in the middle. */
function glowTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.18, 'rgba(255,255,255,0.75)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
}

/** A flame tongue: round at the bottom, drawn out upward. */
function flameTexture(): THREE.CanvasTexture {
  return canvasTex(32, 64, (g) => {
    g.translate(16, 44);
    for (let i = 10; i >= 1; i--) {
      const k = i / 10;
      g.fillStyle = `rgba(255,255,255,${0.1 + (1 - k) * 0.14})`;
      g.beginPath();
      g.ellipse(0, -18 * (1 - k) * 0.4, 14 * k, 40 * k, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/**
 * A puff of smoke: a handful of overlapping soft blobs, so it has lumps and
 * edges rather than being another round glow. Seeded, so every build draws the
 * same puff.
 */
function smokeTexture(): THREE.CanvasTexture {
  let s = 1234567;
  const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
  return canvasTex(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 30;
      const x = 64 + Math.cos(a) * r;
      const y = 64 + Math.sin(a) * r;
      const rad = 18 + rnd() * 26;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.28)');
      grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    }
    // Keep the square's edge clean whatever the blobs did.
    g.globalCompositeOperation = 'destination-in';
    const edge = g.createRadialGradient(64, 64, 20, 64, 64, 64);
    edge.addColorStop(0, 'rgba(0,0,0,1)');
    edge.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = edge;
    g.fillRect(0, 0, 128, 128);
  });
}

/** A scrap of paper: a plain rectangle with a slightly soft edge. */
function paperTexture(): THREE.CanvasTexture {
  return canvasTex(16, 16, (g) => {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.fillRect(1, 2, 14, 12);
  });
}

/**
 * The camera's pixel size, shared by every quad material (one uniform object,
 * so updating it once a frame updates them all). Module-wide on purpose: there
 * is one camera in the simulator.
 */
const VIEW = { uPx: { value: 0.0012 } };

// ---------------------------------------------------------------------------
// Camera-facing quads, one instanced draw per system
// ---------------------------------------------------------------------------

const BB_VERT = `
  attribute vec3 iPos;
  attribute vec3 iCol;
  attribute float iAlpha;
  attribute vec2 iSize;
  attribute float iRot;
  // World size of one CSS pixel at one metre, and the fewest pixels this
  // system may shrink to. A flare 130 m away is a third of a pixel at its
  // real size — and a flare across the ground is the brightest thing in it,
  // not something that vanishes. So the bright ones keep a floor.
  uniform float uPx;
  uniform float uMinPx;
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vUv = uv;
    vCol = iCol;
    vA = iAlpha;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float c = cos(iRot), s = sin(iRot);
    float k = max(1.0, uMinPx * uPx * -mv.z / max(1e-4, max(iSize.x, iSize.y)));
    vec2 p = position.xy * iSize * k;
    mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    gl_Position = projectionMatrix * mv;
  }
`;
const BB_FRAG = `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vA;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vCol * t.rgb, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * A pool of quads with packed, swap-removed live entries, so the draw call
 * only ever covers what is alive. The simulation state (velocity, age…) lives
 * in `f` — per-particle float slots the owning system defines.
 */
class Quads {
  readonly mesh: THREE.Mesh;
  readonly cap: number;
  count = 0;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly alpha: Float32Array;
  readonly size: Float32Array;
  readonly rot: Float32Array;
  /** Per-particle simulation slots, `stride` floats each. */
  readonly f: Float32Array;
  readonly stride: number;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly attrs: THREE.InstancedBufferAttribute[];

  constructor(cap: number, tex: THREE.Texture, additive: boolean, stride: number, renderOrder: number, minPx = 0) {
    this.cap = Math.max(1, cap);
    this.stride = stride;
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.alpha = new Float32Array(this.cap);
    this.size = new Float32Array(this.cap * 2);
    this.rot = new Float32Array(this.cap);
    this.f = new Float32Array(this.cap * stride);
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    const mk = (arr: Float32Array, n: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrs = [mk(this.pos, 3), mk(this.col, 3), mk(this.alpha, 1), mk(this.size, 2), mk(this.rot, 1)];
    ['iPos', 'iCol', 'iAlpha', 'iSize', 'iRot'].forEach((n, i) => this.geo.setAttribute(n, this.attrs[i]));
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uPx: VIEW.uPx, uMinPx: { value: minPx } },
      vertexShader: BB_VERT,
      fragmentShader: BB_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    // Not drawn at all while empty: seven empty systems would still cost seven
    // program binds a frame with every accessory Off.
    this.mesh.visible = false;
  }

  /** A new live slot, or -1 when the pool is full. */
  spawn(): number {
    if (this.count >= this.cap) return -1;
    return this.count++;
  }

  kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.col.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.size.copyWithin(i * 2, last * 2, last * 2 + 2);
    this.alpha[i] = this.alpha[last];
    this.rot[i] = this.rot[last];
    this.f.copyWithin(i * this.stride, last * this.stride, last * this.stride + this.stride);
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
  }

  flush(): void {
    this.geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// Flags — a stick and a sheet of cloth per holder
// ---------------------------------------------------------------------------

const FLAG_VERT = `
  attribute vec3 aColA;
  attribute vec3 aColB;
  attribute vec2 aPat;
  uniform float uTime;
  varying vec3 vColor;
  varying float vShade;
  void main() {
    // position.x: 0 at the pole .. 1 at the fly end; position.y: 0 top .. -1 bottom.
    vec3 p = position;
    float ph = aPat.y;
    float wave = sin(p.x * 5.2 - uTime * 7.0 + ph);
    p.z += wave * 0.16 * p.x;
    p.y -= p.x * p.x * 0.10 * (0.6 + 0.4 * sin(uTime * 2.3 + ph));
    vShade = 0.72 + 0.28 * cos(p.x * 5.2 - uTime * 7.0 + ph);
    // The flag's own pattern: 0 halves across, 1 halves down, 2 solid, 3 stripes.
    float pat = aPat.x;
    float useB = 0.0;
    if (pat < 0.5) useB = step(0.5, -position.y);
    else if (pat < 1.5) useB = step(0.5, position.x);
    else if (pat < 2.5) useB = 0.0;
    else useB = step(0.5, fract(-position.y * 1.5));
    vColor = mix(aColA, aColB, useB);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const FLAG_FRAG = `
  varying vec3 vColor;
  varying float vShade;
  void main() {
    gl_FragColor = vec4(vColor * vShade, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface FlagHolder { base: THREE.Vector3; frame: THREE.Quaternion; big: boolean; ph: number; f: number; amp: number }

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** How many particles each system may keep alive, per tier. */
const CAPS: Record<QualityTier, { flareSmoke: number; bombSmoke: number; sparks: number; paper: number; lights: number }> = {
  low: { flareSmoke: 1400, bombSmoke: 1600, sparks: 400, paper: 3000, lights: 0 },
  medium: { flareSmoke: 2800, bombSmoke: 3200, sparks: 800, paper: 6000, lights: 2 },
  high: { flareSmoke: 5000, bombSmoke: 6000, sparks: 1500, paper: 11000, lights: 3 },
  ultra: { flareSmoke: 7000, bombSmoke: 8000, sparks: 2200, paper: 15000, lights: 3 },
};

const FLARE_LIFE = 6.5;
const BOMB_LIFE = 13;

function seatHash(i: number, salt: number): number {
  let x = ((i + 1) * 2654435761 + salt * 40503) >>> 0;
  x ^= x >>> 15;
  x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export function buildAccessories(
  map: SeatMap,
  opts: { tier: QualityTier; palette: readonly string[] },
): AccessoriesController {
  const group = new THREE.Group();
  group.name = 'accessories';
  const caps = CAPS[opts.tier] ?? CAPS.high;
  const budget = ACCESSORY_BUDGET[opts.tier] ?? 1;
  const stands: StandSeats[] = indexStands(map);

  const texGlow = glowTexture();
  const texFlame = flameTexture();
  const texSmoke = smokeTexture();
  const texPaper = paperTexture();
  const trash: { dispose(): void }[] = [texGlow, texFlame, texSmoke, texPaper];

  let lv: AccessoryLevels = noAccessories();
  let where: AccessoryWhere = 'north';
  let flareColourId = 'red';
  let smokeColourId = 'club';
  let club = clubColours(opts.palette);
  let time = 0;
  // A light breeze across the bowl, so smoke leans rather than rising in pillars.
  const wind = new THREE.Vector3(0.7, 0, 0.25);

  const tmpC = new THREE.Color();
  const lin = (hex: string): THREE.Color => new THREE.Color(hex); // ColorManagement: sRGB hex -> linear
  const flareColourOf = (k: number): THREE.Color => {
    if (flareColourId === 'club') return lin(club[k % club.length]);
    return lin(FLARE_COLOURS[flareColourId] ?? FLARE_COLOURS.red);
  };
  const smokeColourOf = (k: number): THREE.Color => {
    if (smokeColourId === 'club') return lin(club[k % club.length]);
    return lin(SMOKE_COLOURS[smokeColourId] ?? SMOKE_COLOURS.red);
  };

  /** Seat world position, and the unit vector from it toward the pitch. */
  const seatPos = (i: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(map.pos3[i * 3], map.pos3[i * 3 + 1], map.pos3[i * 3 + 2]);
  const towardPitch = (i: number, out: THREE.Vector3): THREE.Vector3 => {
    out.set(-map.pos3[i * 3], 0, -map.pos3[i * 3 + 2]);
    const l = out.length() || 1;
    return out.multiplyScalar(1 / l);
  };

  const holders: Record<AccessoryKind, number[]> = { flags: [], flares: [], smoke: [], strobes: [], paper: [], phones: [] };
  const v1 = new THREE.Vector3();

  // ---- flares --------------------------------------------------------------
  // Three layers of quads that do not move (core, tongue, glow), rewritten when
  // the plan changes and flickered every frame; plus sparks and smoke that do.
  interface Flare { p: THREE.Vector3; out: THREE.Vector3; col: THREE.Color; glow: number; ph: number; f: number; emit: number; spark: number }
  /**
   * How strong a colour's glow should be to look as bright as red's. Glows add
   * light, and green carries three times red's luminance: without this, a stand
   * of green flares blows out to white where a red one reads as red.
   */
  const glowFor = (c: THREE.Color): number => {
    const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return Math.min(1.2, Math.max(0.3, 0.24 / Math.max(0.01, luma)));
  };
  let flares: Flare[] = [];
  let flareCoreQ = new Quads(1, texGlow, true, 0, 6, 3.5);
  const rebuildFlareStatics = (): void => {
    flareCoreQ.dispose();
    group.remove(flareCoreQ.mesh);
    // core + tongue + glow per flare, all in one additive draw
    flareCoreQ = new Quads(Math.max(1, flares.length * 3), texGlow, true, 0, 6, 3.5);
    group.add(flareCoreQ.mesh);
  };
  // The tongue needs its own texture, so it is its own draw.
  let flareTongueQ = new Quads(1, texFlame, true, 0, 7);
  group.add(flareCoreQ.mesh, flareTongueQ.mesh);
  const sparks = new Quads(caps.sparks, texGlow, true, 4, 8, 1.2); // vx vy vz age
  const flareSmoke = new Quads(caps.flareSmoke, texSmoke, false, 10, 4); // vx vy vz age life size0 rotSpeed r g b
  group.add(sparks.mesh, flareSmoke.mesh);

  // ---- smoke pots ----------------------------------------------------------
  interface Pot { p: THREE.Vector3; out: THREE.Vector3; col: THREE.Color; emit: number; ph: number }
  let pots: Pot[] = [];
  const bombSmoke = new Quads(caps.bombSmoke, texSmoke, false, 10, 3); // vx vy vz age life size0 rot r g b
  group.add(bombSmoke.mesh);

  // ---- strobes -------------------------------------------------------------
  interface Strobe { p: THREE.Vector3; hz: number; ph: number; duty: number; emit: number }
  let strobes: Strobe[] = [];
  let strobeQ = new Quads(1, texGlow, true, 0, 9, 5);
  group.add(strobeQ.mesh);

  // ---- paper ---------------------------------------------------------------
  interface Thrower { p: THREE.Vector3; out: THREE.Vector3; next: number }
  let throwers: Thrower[] = [];
  const paper = new Quads(caps.paper, texPaper, false, 7, 5, 2.4); // vx vy vz age spin spinSpeed floorY
  group.add(paper.mesh);

  // ---- flags ---------------------------------------------------------------
  let flagMeshes: { cloth: THREE.InstancedMesh; pole: THREE.InstancedMesh; mat: THREE.ShaderMaterial; geo: THREE.BufferGeometry; poleGeo: THREE.BufferGeometry; poleMat: THREE.Material } | null = null;
  let flagHolders: FlagHolder[] = [];
  const flagUniforms = { uTime: { value: 0 } };

  // ---- phones --------------------------------------------------------------
  let phones: PhoneFlash | null = null;

  // ---- lights --------------------------------------------------------------
  // Hidden until something is burning. A hidden light is not counted, so with
  // everything Off the bowl renders exactly as it did before accessories
  // existed — four more point lights in every lit fragment is a real cost on a
  // phone, and under software rendering it halved the drum call's frame rate.
  // Showing them recompiles the lit materials ONCE (three caches the program
  // per light count), so the first flare of a session may hitch; after that,
  // on and off are free. They are never shown or hidden per frame — a strobe
  // light that dims to zero between flashes stays counted.
  const flareLights: THREE.PointLight[] = [];
  for (let k = 0; k < caps.lights; k++) {
    const l = new THREE.PointLight(0xff3020, 0, 70, 1.6);
    l.position.set(0, -50, 0);
    l.visible = false;
    flareLights.push(l);
    group.add(l);
  }
  const strobeLight = caps.lights > 0 ? new THREE.PointLight(0xffffff, 0, 80, 1.6) : null;
  if (strobeLight) {
    strobeLight.position.set(0, -50, 0);
    strobeLight.visible = false;
    group.add(strobeLight);
  }
  /** Where each flare light sits and how strong it is, from the flares near it. */
  let lightSpots: { p: THREE.Vector3; n: number; power: number; col: THREE.Color }[] = [];
  let strobeSpot: THREE.Vector3 | null = null;

  // -------------------------------------------------------------------------
  // Planning: holders -> things in their hands
  // -------------------------------------------------------------------------

  const planFlares = (): void => {
    flares = holders.flares.map((i, k) => {
      const p = seatPos(i, new THREE.Vector3());
      const out = towardPitch(i, new THREE.Vector3());
      // Held up at arm's length, a little forward of the head and to one side.
      const side = new THREE.Vector3(-out.z, 0, out.x).multiplyScalar((seatHash(i, 3) - 0.5) * 0.5);
      p.add(side).addScaledVector(out, 0.28);
      p.y += 1.78 + seatHash(i, 5) * 0.28;
      const col = flareColourOf(k);
      return { p, out, col, glow: glowFor(col), ph: seatHash(i, 7) * 100, f: 8 + seatHash(i, 9) * 7, emit: seatHash(i, 11), spark: seatHash(i, 13) };
    });
    rebuildFlareStatics();
    group.remove(flareTongueQ.mesh);
    flareTongueQ.dispose();
    flareTongueQ = new Quads(Math.max(1, flares.length), texFlame, true, 0, 7);
    group.add(flareTongueQ.mesh);
    // Light clusters: split the flares along their order (which runs along the
    // stand) into as many runs as there are lights, one light per run.
    lightSpots = [];
    const nL = flareLights.length;
    if (nL && flares.length) {
      const per = Math.ceil(flares.length / nL);
      for (let k = 0; k < nL; k++) {
        const run = flares.slice(k * per, (k + 1) * per);
        if (!run.length) continue;
        const c = new THREE.Vector3();
        for (const f of run) c.add(f.p);
        c.multiplyScalar(1 / run.length);
        // Toward the pitch and a little up, so it lights the rows around the
        // run rather than the underside of the nearest fan.
        c.addScaledVector(run[0].out, 3).y += 2.5;
        lightSpots.push({ p: c, n: run.length, power: Math.sqrt(run.length) * run[0].glow, col: run[0].col.clone() });
      }
    }
    flareLights.forEach((l, k) => {
      l.intensity = 0;
      l.visible = !!lightSpots[k];
    });
  };

  const planPots = (): void => {
    pots = holders.smoke.map((i, k) => {
      const p = seatPos(i, new THREE.Vector3());
      const out = towardPitch(i, new THREE.Vector3());
      p.addScaledVector(out, 0.4);
      p.y += 0.9;
      return { p, out, col: smokeColourOf(k), emit: seatHash(i, 17), ph: seatHash(i, 19) * 10 };
    });
  };

  const planStrobes = (): void => {
    strobes = holders.strobes.map((i) => {
      const p = seatPos(i, new THREE.Vector3());
      p.addScaledVector(towardPitch(i, v1), 0.3);
      p.y += 1.85 + seatHash(i, 23) * 0.2;
      // 4–10 Hz, each pot on its own clock, never in step with the next one.
      return { p, hz: 4 + seatHash(i, 29) * 6, ph: seatHash(i, 31), duty: 0.16 + seatHash(i, 37) * 0.12, emit: seatHash(i, 41) };
    });
    group.remove(strobeQ.mesh);
    strobeQ.dispose();
    strobeQ = new Quads(Math.max(1, strobes.length * 2), texGlow, true, 0, 9, 5);
    group.add(strobeQ.mesh);
    if (strobes.length) {
      const c = new THREE.Vector3();
      for (const s of strobes) c.add(s.p);
      c.multiplyScalar(1 / strobes.length);
      strobeSpot = c;
    } else strobeSpot = null;
    if (strobeLight) {
      strobeLight.visible = !!strobeSpot;
      if (!strobeSpot) strobeLight.intensity = 0;
    }
  };

  const planPaper = (): void => {
    throwers = holders.paper.map((i) => {
      const p = seatPos(i, new THREE.Vector3());
      const out = towardPitch(i, new THREE.Vector3());
      p.y += 1.9;
      return { p, out, next: seatHash(i, 43) * 2.5 };
    });
  };

  const planFlags = (): void => {
    if (flagMeshes) {
      group.remove(flagMeshes.cloth, flagMeshes.pole);
      flagMeshes.geo.dispose();
      flagMeshes.poleGeo.dispose();
      flagMeshes.mat.dispose();
      flagMeshes.poleMat.dispose();
      flagMeshes.cloth.dispose();
      flagMeshes.pole.dispose();
      flagMeshes = null;
    }
    const ids = holders.flags;
    flagHolders = [];
    if (!ids.length) return;
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    ids.forEach((i, k) => {
      const base = seatPos(i, new THREE.Vector3());
      const out = towardPitch(i, new THREE.Vector3());
      // One in eight is a big flag on a long pole — and the first few at any
      // level, so even Light has a flag bearer in it.
      const big = k < 3 || seatHash(i, 47) < 0.15;
      base.y += big ? 1.1 : 1.4;
      base.addScaledVector(out, 0.15);
      // Frame: X along the stand, Y up, Z toward the pitch.
      const along = new THREE.Vector3().crossVectors(up, out).normalize();
      m.makeBasis(along, up, out);
      const frame = new THREE.Quaternion().setFromRotationMatrix(m);
      flagHolders.push({
        base,
        frame,
        big,
        ph: seatHash(i, 53) * Math.PI * 2,
        // A flag bearer sweeps slowly; a stick flag is shaken.
        f: big ? 0.42 + seatHash(i, 59) * 0.18 : 1.1 + seatHash(i, 61) * 0.8,
        amp: big ? 0.55 + seatHash(i, 67) * 0.2 : 0.35 + seatHash(i, 71) * 0.25,
      });
    });

    const cloth = new THREE.PlaneGeometry(1, 1, 10, 4);
    cloth.translate(0.5, -0.5, 0); // x 0..1 from the pole, y 0..-1 down from the top
    const n = flagHolders.length;
    const colA = new Float32Array(n * 3);
    const colB = new Float32Array(n * 3);
    const pat = new Float32Array(n * 2);
    flagHolders.forEach((h, k) => {
      // Club colour against white, or against the other club colour: a flag
      // in the same colours as the seats behind it disappears into them.
      const a = lin(club[k % club.length]);
      const b = k % 3 === 0 || club.length < 2 ? lin('#f4f4f2') : lin(club[(k + 1) % club.length]);
      colA.set([a.r, a.g, a.b], k * 3);
      colB.set([b.r, b.g, b.b], k * 3);
      pat[k * 2] = Math.floor(seatHash(ids[k], 73) * 4);
      pat[k * 2 + 1] = h.ph;
    });
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = cloth.index;
    geo.setAttribute('position', cloth.getAttribute('position'));
    geo.setAttribute('aColA', new THREE.InstancedBufferAttribute(colA, 3));
    geo.setAttribute('aColB', new THREE.InstancedBufferAttribute(colB, 3));
    geo.setAttribute('aPat', new THREE.InstancedBufferAttribute(pat, 2));
    const mat = new THREE.ShaderMaterial({
      uniforms: flagUniforms,
      vertexShader: FLAG_VERT,
      fragmentShader: FLAG_FRAG,
      side: THREE.DoubleSide,
    });
    const clothMesh = new THREE.InstancedMesh(geo, mat, n);
    clothMesh.frustumCulled = false;
    const poleGeo = new THREE.CylinderGeometry(0.018, 0.024, 1, 5, 1);
    poleGeo.translate(0, 0.5, 0);
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x2b2b2e });
    const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, n);
    poleMesh.frustumCulled = false;
    group.add(clothMesh, poleMesh);
    flagMeshes = { cloth: clothMesh, pole: poleMesh, mat, geo, poleGeo, poleMat };
    cloth.dispose();
    stepFlags(0);
  };

  const qTilt = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const qNod = new THREE.Quaternion();
  const qAll = new THREE.Quaternion();
  const mPole = new THREE.Matrix4();
  const mCloth = new THREE.Matrix4();
  const sPole = new THREE.Vector3();
  const sCloth = new THREE.Vector3();
  const top = new THREE.Vector3();
  const axisZ = new THREE.Vector3(0, 0, 1);
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisY = new THREE.Vector3(0, 1, 0);
  function stepFlags(t: number): void {
    if (!flagMeshes) return;
    const { cloth, pole } = flagMeshes;
    flagHolders.forEach((h, k) => {
      const w = t * h.f * Math.PI * 2 + h.ph;
      // Sideways sweep along the stand, a little figure-of-eight nod, and the
      // cloth turning on its pole as it goes.
      qTilt.setFromAxisAngle(axisZ, Math.sin(w) * h.amp);
      qNod.setFromAxisAngle(axisX, Math.sin(w * 2) * h.amp * 0.3 - 0.08);
      qAll.copy(h.frame).multiply(qTilt).multiply(qNod);
      const len = h.big ? 4.2 : 1.15;
      sPole.set(1, len, 1);
      mPole.compose(h.base, qAll, sPole);
      pole.setMatrixAt(k, mPole);
      top.set(0, len, 0).applyQuaternion(qAll).add(h.base);
      qYaw.setFromAxisAngle(axisY, Math.cos(w) * 0.55 * (h.big ? 0.6 : 1));
      const qc = qAll.clone().multiply(qYaw);
      if (h.big) sCloth.set(3.2, 2.2, 1);
      else sCloth.set(1.2, 0.8, 1);
      mCloth.compose(top, qc, sCloth);
      cloth.setMatrixAt(k, mCloth);
    });
    cloth.instanceMatrix.needsUpdate = true;
    pole.instanceMatrix.needsUpdate = true;
  }

  const planPhones = (): void => {
    phones?.dispose();
    if (phones) group.remove(phones.object);
    phones = null;
    if (!holders.phones.length) return;
    phones = buildPhoneFlash(map, holders.phones.length, holders.phones);
    group.add(phones.object);
  };

  const replan = (kind: AccessoryKind): void => {
    holders[kind] = planHolders(stands, kind, lv[kind], where, budget);
    if (kind === 'flares') planFlares();
    else if (kind === 'smoke') planPots();
    else if (kind === 'strobes') planStrobes();
    else if (kind === 'paper') planPaper();
    else if (kind === 'flags') planFlags();
    else if (kind === 'phones') planPhones();
  };

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  const smokeGrey = new THREE.Color(0.42, 0.42, 0.44);

  function stepFlares(dt: number): void {
    const q = flareCoreQ;
    const tq = flareTongueQ;
    q.count = 0;
    tq.count = 0;
    let lightSum = 0;
    // Steady state has to fit the pool: each flare's smoke rate is set so that
    // all of them together, each puff living FLARE_LIFE, fill it and no more.
    const smokeRate = flares.length ? Math.min(2.6, caps.flareSmoke / (flares.length * FLARE_LIFE)) : 0;
    const sparkRate = flares.length ? Math.min(9, caps.sparks / (flares.length * 0.7)) : 0;
    // A stand of 300 flares is not 300 times as bright as one flare's
    // surroundings — the glows overlap and the eye adapts. Each glow is
    // dimmed as the crowd of them grows, so Full reads as a stand on fire
    // rather than as a white-out.
    const crowdDim = Math.min(1, Math.max(0.38, 1.4 / Math.sqrt(Math.max(1, flares.length) / 12)));
    for (const f of flares) {
      // Bengals do not flicker like candles — they seethe: a fast shimmer on a
      // slower surge.
      const fl = 0.78 + 0.14 * Math.sin(time * f.f + f.ph) + 0.08 * Math.sin(time * f.f * 2.7 + f.ph * 1.7);
      lightSum += fl;
      let k = q.spawn();
      // Core: blown out to near-white, which the colour survives only at the rim.
      q.pos.set([f.p.x, f.p.y, f.p.z], k * 3);
      tmpC.copy(f.col).multiplyScalar(2.2 * fl).addScalar(0.9 * fl);
      q.col.set([tmpC.r, tmpC.g, tmpC.b], k * 3);
      q.alpha[k] = 1;
      q.size.set([0.55 * fl, 0.55 * fl], k * 2);
      q.rot[k] = 0;
      // Near glow: the fans holding it, and their neighbours.
      k = q.spawn();
      q.pos.set([f.p.x + f.out.x * 0.4, f.p.y - 0.5, f.p.z + f.out.z * 0.4], k * 3);
      tmpC.copy(f.col).multiplyScalar(0.8 * fl * f.glow * crowdDim);
      q.col.set([tmpC.r, tmpC.g, tmpC.b], k * 3);
      q.alpha[k] = 0.9;
      q.size.set([5.5, 5.5], k * 2);
      q.rot[k] = 0;
      // Wide glow: the patch of stand it lights.
      k = q.spawn();
      q.pos.set([f.p.x + f.out.x * 1.2, f.p.y - 1.4, f.p.z + f.out.z * 1.2], k * 3);
      tmpC.copy(f.col).multiplyScalar(0.3 * fl * f.glow * crowdDim);
      q.col.set([tmpC.r, tmpC.g, tmpC.b], k * 3);
      q.alpha[k] = 0.85;
      q.size.set([13, 13], k * 2);
      q.rot[k] = 0;
      // Tongue.
      const j = tq.spawn();
      tq.pos.set([f.p.x, f.p.y + 0.3, f.p.z], j * 3);
      tmpC.copy(f.col).multiplyScalar(1.6 * fl).addScalar(0.25);
      tq.col.set([tmpC.r, tmpC.g, tmpC.b], j * 3);
      tq.alpha[j] = 0.9;
      tq.size.set([0.42, 0.95 + 0.25 * Math.sin(time * 11 + f.ph)], j * 2);
      tq.rot[j] = Math.sin(time * 3 + f.ph) * 0.15;

      // Smoke, lit from inside by the flame.
      f.emit += smokeRate * dt;
      while (f.emit >= 1) {
        f.emit -= 1;
        const s = flareSmoke.spawn();
        if (s < 0) break;
        flareSmoke.pos.set([f.p.x, f.p.y + 0.35, f.p.z], s * 3);
        const o = s * flareSmoke.stride;
        flareSmoke.f[o] = f.out.x * 0.5 + (Math.random() - 0.5) * 0.5;
        flareSmoke.f[o + 1] = 1.6 + Math.random() * 0.9;
        flareSmoke.f[o + 2] = f.out.z * 0.5 + (Math.random() - 0.5) * 0.5;
        flareSmoke.f[o + 3] = 0;
        flareSmoke.f[o + 4] = FLARE_LIFE * (0.75 + Math.random() * 0.5);
        flareSmoke.f[o + 5] = 0.7 + Math.random() * 0.4;
        flareSmoke.f[o + 6] = (Math.random() - 0.5) * 0.6;
        flareSmoke.rot[s] = Math.random() * 6.28;
        // The flame's colour, remembered: the puff glows it while it is still
        // in the light, then goes grey as it climbs out of it.
        flareSmoke.f[o + 7] = f.col.r;
        flareSmoke.f[o + 8] = f.col.g;
        flareSmoke.f[o + 9] = f.col.b;
      }
      f.spark += sparkRate * dt;
      while (f.spark >= 1) {
        f.spark -= 1;
        const s = sparks.spawn();
        if (s < 0) break;
        sparks.pos.set([f.p.x, f.p.y + 0.1, f.p.z], s * 3);
        const o = s * sparks.stride;
        sparks.f[o] = (Math.random() - 0.5) * 1.6 + f.out.x * 0.6;
        sparks.f[o + 1] = 0.5 + Math.random() * 1.6;
        sparks.f[o + 2] = (Math.random() - 0.5) * 1.6 + f.out.z * 0.6;
        sparks.f[o + 3] = 0;
        tmpC.copy(f.col).multiplyScalar(1.4).addScalar(0.7);
        sparks.col.set([tmpC.r, tmpC.g, tmpC.b], s * 3);
      }
    }
    q.flush();
    tq.flush();

    // Lights follow the flicker of the run they stand for.
    const avg = flares.length ? lightSum / flares.length : 0;
    flareLights.forEach((l, k) => {
      const s = lightSpots[k];
      if (!s) { l.intensity = 0; return; }
      l.position.copy(s.p);
      l.color.copy(s.col);
      l.intensity = 260 * s.power * avg;
    });

    // Sparks: out, down, gone.
    for (let i = 0; i < sparks.count; i++) {
      const o = i * sparks.stride;
      sparks.f[o + 3] += dt;
      const age = sparks.f[o + 3];
      if (age > 0.7) { sparks.kill(i); i--; continue; }
      sparks.f[o + 1] -= 9.8 * dt;
      sparks.pos[i * 3] += sparks.f[o] * dt;
      sparks.pos[i * 3 + 1] += sparks.f[o + 1] * dt;
      sparks.pos[i * 3 + 2] += sparks.f[o + 2] * dt;
      sparks.alpha[i] = 1 - age / 0.7;
      const sz = 0.09;
      sparks.size[i * 2] = sz;
      sparks.size[i * 2 + 1] = sz;
    }
    sparks.flush();

    // Flare smoke: rises fast, slows, spreads, drifts with the wind, and goes
    // from flame-coloured near the flare to grey above the crowd.
    for (let i = 0; i < flareSmoke.count; i++) {
      const o = i * flareSmoke.stride;
      flareSmoke.f[o + 3] += dt;
      const age = flareSmoke.f[o + 3];
      const life = flareSmoke.f[o + 4];
      if (age >= life) { flareSmoke.kill(i); i--; continue; }
      const t = age / life;
      const drag = Math.exp(-0.45 * dt);
      flareSmoke.f[o] = flareSmoke.f[o] * drag + wind.x * (1 - drag);
      flareSmoke.f[o + 1] = flareSmoke.f[o + 1] * drag + 0.35 * (1 - drag);
      flareSmoke.f[o + 2] = flareSmoke.f[o + 2] * drag + wind.z * (1 - drag);
      flareSmoke.pos[i * 3] += flareSmoke.f[o] * dt;
      flareSmoke.pos[i * 3 + 1] += flareSmoke.f[o + 1] * dt;
      flareSmoke.pos[i * 3 + 2] += flareSmoke.f[o + 2] * dt;
      const sz = flareSmoke.f[o + 5] * (1 + t * 5.5);
      flareSmoke.size[i * 2] = sz;
      flareSmoke.size[i * 2 + 1] = sz;
      flareSmoke.rot[i] += flareSmoke.f[o + 6] * dt;
      flareSmoke.alpha[i] = Math.min(1, age * 4) * (1 - t) * (1 - t) * 0.6;
      // Lit from inside by the flame near the hand — glowing its colour, and
      // brighter than grey smoke could be — then plain grey above the crowd.
      const lit = 1 - Math.min(1, Math.max(0, (t - 0.04) / 0.4));
      const glow = lit * lit;
      flareSmoke.col[i * 3] = smokeGrey.r + (flareSmoke.f[o + 7] * 1.25 + 0.12 - smokeGrey.r) * glow;
      flareSmoke.col[i * 3 + 1] = smokeGrey.g + (flareSmoke.f[o + 8] * 1.25 + 0.12 - smokeGrey.g) * glow;
      flareSmoke.col[i * 3 + 2] = smokeGrey.b + (flareSmoke.f[o + 9] * 1.25 + 0.12 - smokeGrey.b) * glow;
    }
    flareSmoke.flush();
  }

  function stepPots(dt: number): void {
    // A pot pours for its whole burn; the pool decides how thick that can be.
    const rate = pots.length ? Math.min(14, caps.bombSmoke / (pots.length * BOMB_LIFE)) : 0;
    for (const pt of pots) {
      pt.emit += rate * dt;
      while (pt.emit >= 1) {
        pt.emit -= 1;
        const s = bombSmoke.spawn();
        if (s < 0) break;
        bombSmoke.pos.set([pt.p.x + (Math.random() - 0.5) * 0.4, pt.p.y, pt.p.z + (Math.random() - 0.5) * 0.4], s * 3);
        const o = s * bombSmoke.stride;
        // Rolls out low and forward first — the pot throws it — then lifts.
        const spread = (Math.random() - 0.5) * 3.2;
        bombSmoke.f[o] = pt.out.x * (1.6 + Math.random()) - pt.out.z * spread;
        bombSmoke.f[o + 1] = 0.6 + Math.random() * 0.8;
        bombSmoke.f[o + 2] = pt.out.z * (1.6 + Math.random()) + pt.out.x * spread;
        bombSmoke.f[o + 3] = 0;
        bombSmoke.f[o + 4] = BOMB_LIFE * (0.7 + Math.random() * 0.6);
        bombSmoke.f[o + 5] = 1.5 + Math.random() * 0.9;
        bombSmoke.f[o + 6] = (Math.random() - 0.5) * 0.4;
        // Coloured smoke is dye in a cloud of fine particles: it scatters
        // light, so it reads lighter and softer than the dye itself.
        const shade = 0.9 + Math.random() * 0.2;
        bombSmoke.col.set([
          (pt.col.r * 0.8 + 0.12) * shade,
          (pt.col.g * 0.8 + 0.12) * shade,
          (pt.col.b * 0.8 + 0.12) * shade,
        ], s * 3);
        bombSmoke.rot[s] = Math.random() * 6.28;
      }
    }
    for (let i = 0; i < bombSmoke.count; i++) {
      const o = i * bombSmoke.stride;
      bombSmoke.f[o + 3] += dt;
      const age = bombSmoke.f[o + 3];
      const life = bombSmoke.f[o + 4];
      if (age >= life) { bombSmoke.kill(i); i--; continue; }
      const t = age / life;
      const drag = Math.exp(-0.6 * dt);
      // Buoyant: after the throw it climbs, faster as it warms the air
      // round it, so each pot builds a column that leans with the breeze and
      // opens out over the stand — not a ball sitting on the seats.
      bombSmoke.f[o] = bombSmoke.f[o] * drag + wind.x * (1 - drag);
      bombSmoke.f[o + 1] = bombSmoke.f[o + 1] * drag + (1.0 + t * 1.6) * (1 - drag);
      bombSmoke.f[o + 2] = bombSmoke.f[o + 2] * drag + wind.z * (1 - drag);
      bombSmoke.pos[i * 3] += bombSmoke.f[o] * dt;
      bombSmoke.pos[i * 3 + 1] += bombSmoke.f[o + 1] * dt;
      bombSmoke.pos[i * 3 + 2] += bombSmoke.f[o + 2] * dt;
      const sz = bombSmoke.f[o + 5] * (0.8 + t * 9);
      bombSmoke.size[i * 2] = sz;
      bombSmoke.size[i * 2 + 1] = sz;
      bombSmoke.rot[i] += bombSmoke.f[o + 6] * dt;
      // Many thin puffs, not a few thick ones: overlapping, they make a cloud;
      // alone, each would be a coloured ball.
      bombSmoke.alpha[i] = Math.min(1, age * 2) * Math.pow(1 - t, 1.5) * 0.4;
    }
    bombSmoke.flush();
  }

  function stepStrobes(dt: number): void {
    const q = strobeQ;
    q.count = 0;
    let lit = 0;
    for (const s of strobes) {
      // Each pot alternates a smoulder and a flash; the flash is a few tens of
      // milliseconds. On a frame that straddles one, the pot shows it anyway:
      // a strobe that only lands on lucky frames reads as broken, not as fast.
      const cyc = (time * s.hz + s.ph) % 1;
      const prev = ((time - dt) * s.hz + s.ph) % 1;
      const on = cyc < s.duty || prev > cyc; // wrapped since the last frame
      const k = q.spawn();
      q.pos.set([s.p.x, s.p.y, s.p.z], k * 3);
      if (on) {
        lit++;
        q.col.set([6, 6, 6.4], k * 3);
        q.alpha[k] = 1;
        q.size.set([0.9, 0.9], k * 2);
        const h = q.spawn();
        q.pos.set([s.p.x, s.p.y - 0.6, s.p.z], h * 3);
        q.col.set([0.55, 0.55, 0.6], h * 3);
        q.alpha[h] = 1;
        q.size.set([7.5, 7.5], h * 2);
        q.rot[h] = 0;
      } else {
        // The smoulder between flashes: a dull ember, still just visible.
        q.col.set([0.5, 0.36, 0.3], k * 3);
        q.alpha[k] = 0.7;
        q.size.set([0.22, 0.22], k * 2);
      }
      q.rot[k] = 0;
      // A little white smoke off every pot.
      s.emit += 0.8 * dt;
      if (s.emit >= 1) {
        s.emit -= 1;
        const i = flareSmoke.spawn();
        if (i >= 0) {
          flareSmoke.pos.set([s.p.x, s.p.y + 0.2, s.p.z], i * 3);
          const o = i * flareSmoke.stride;
          flareSmoke.f.set([(Math.random() - 0.5) * 0.4, 1.3 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4, 0, FLARE_LIFE, 0.6, 0.2, 0.5, 0.5, 0.52], o);
          flareSmoke.rot[i] = Math.random() * 6.28;
        }
      }
    }
    q.flush();
    if (strobeLight) {
      strobeLight.intensity = strobeSpot && lit ? 180 * Math.sqrt(lit) : 0;
      if (strobeSpot) strobeLight.position.copy(strobeSpot).y += 3;
    }
  }

  const paperWhite = new THREE.Color(0.95, 0.95, 0.93);
  function stepPaper(dt: number): void {
    // Each thrower empties a handful every couple of seconds, not a steady
    // trickle — that is what makes it look thrown.
    const perHandful = Math.max(6, Math.min(26, Math.floor(caps.paper / Math.max(1, throwers.length) / 3)));
    for (const th of throwers) {
      th.next -= dt;
      if (th.next > 0) continue;
      th.next = 1.4 + Math.random() * 2.2;
      for (let n = 0; n < perHandful; n++) {
        const s = paper.spawn();
        if (s < 0) break;
        paper.pos.set([th.p.x, th.p.y + Math.random() * 0.3, th.p.z], s * 3);
        const o = s * paper.stride;
        const sp = (Math.random() - 0.5) * 2.4;
        // Thrown up and out over the heads in front, the way a handful of
        // paper is flung — it is the air in front of the stand that fills.
        paper.f[o] = th.out.x * (4 + Math.random() * 5) - th.out.z * sp;
        paper.f[o + 1] = 6 + Math.random() * 5;
        paper.f[o + 2] = th.out.z * (4 + Math.random() * 5) + th.out.x * sp;
        paper.f[o + 3] = 0;
        paper.f[o + 4] = Math.random() * 6.28;
        paper.f[o + 5] = 4 + Math.random() * 8;
        paper.f[o + 6] = 0.3;
        const c = Math.random() < 0.72 ? paperWhite : lin(club[Math.floor(Math.random() * club.length)]);
        paper.col.set([c.r, c.g, c.b], s * 3);
        paper.alpha[s] = 1;
        paper.rot[s] = Math.random() * 6.28;
      }
    }
    for (let i = 0; i < paper.count; i++) {
      const o = i * paper.stride;
      paper.f[o + 3] += dt;
      const age = paper.f[o + 3];
      if (age > 12 || paper.pos[i * 3 + 1] < paper.f[o + 6]) { paper.kill(i); i--; continue; }
      // Paper has almost no weight. Pulled down at a fraction of g against
      // heavy drag, it settles to about 1.5 m/s and flutters the rest of the way.
      const drag = Math.exp(-1.6 * dt);
      paper.f[o] = paper.f[o] * drag + wind.x * (1 - drag);
      paper.f[o + 1] = (paper.f[o + 1] - 2.4 * dt) * drag;
      paper.f[o + 2] = paper.f[o + 2] * drag + wind.z * (1 - drag);
      paper.f[o + 4] += paper.f[o + 5] * dt;
      const flutter = Math.sin(paper.f[o + 4]);
      paper.pos[i * 3] += (paper.f[o] + flutter * 0.4) * dt;
      paper.pos[i * 3 + 1] += paper.f[o + 1] * dt;
      paper.pos[i * 3 + 2] += paper.f[o + 2] * dt;
      // Tumbling: the scrap turns edge-on and back.
      paper.size[i * 2] = 0.22 * (0.25 + 0.75 * Math.abs(Math.cos(paper.f[o + 4])));
      paper.size[i * 2 + 1] = 0.16;
      paper.rot[i] += dt * 2;
      paper.alpha[i] = Math.min(1, (12 - age) * 2);
    }
    paper.flush();
  }

  // -------------------------------------------------------------------------

  const recolour = (): void => {
    flares.forEach((f, k) => { f.col.copy(flareColourOf(k)); f.glow = glowFor(f.col); });
    pots.forEach((p, k) => p.col.copy(smokeColourOf(k)));
    lightSpots.forEach((sp, k) => {
      sp.col.copy(flareColourOf(k));
      sp.power = Math.sqrt(sp.n) * glowFor(sp.col);
    });
  };

  return {
    object: group,
    levels: () => ({ ...lv }),
    setLevel(kind, level) {
      if (lv[kind] === level) return;
      lv = { ...lv, [kind]: level };
      replan(kind);
    },
    setWhere(w) {
      if (w === where) return;
      where = w;
      for (const k of ACCESSORY_KINDS) if (lv[k] > 0) replan(k);
      // Smoke already in the air belongs to the old stand; clear it rather than
      // leave a cloud hanging over a stand nobody is standing in.
      if (!lv.smoke) bombSmoke.clear();
    },
    where: () => where,
    setFlareColour(id) {
      flareColourId = id;
      recolour();
    },
    setSmokeColour(id) {
      smokeColourId = id;
      recolour();
    },
    setPalette(p) {
      club = clubColours(p);
      recolour();
      if (lv.flags) planFlags();
    },
    update(dt, view) {
      if (view && view.height > 0) VIEW.uPx.value = (2 * Math.tan((view.fov * Math.PI) / 360)) / view.height;
      const d = Math.min(0.05, Math.max(0, dt));
      time += d;
      flagUniforms.uTime.value = time;
      // The breeze wanders a little.
      wind.set(0.7 + Math.sin(time * 0.05) * 0.35, 0, 0.25 + Math.cos(time * 0.037) * 0.3);
      if (flares.length || sparks.count || flareSmoke.count || strobes.length) stepFlares(d);
      if (pots.length || bombSmoke.count) stepPots(d);
      if (strobes.length || strobeQ.count) stepStrobes(d);
      if (throwers.length || paper.count) stepPaper(d);
      if (flagHolders.length) stepFlags(time);
      phones?.update(d);
    },
    census() {
      const h = {} as Record<AccessoryKind, number>;
      for (const k of ACCESSORY_KINDS) h[k] = holders[k].length;
      const lightsOn = flareLights.filter((l) => l.visible && l.intensity > 0).length + (strobeLight?.visible ? 1 : 0);
      return { holders: h, particles: flareSmoke.count + bombSmoke.count + sparks.count + paper.count, lightsOn };
    },
    dispose() {
      for (const q of [flareCoreQ, flareTongueQ, sparks, flareSmoke, bombSmoke, strobeQ, paper]) q.dispose();
      if (flagMeshes) {
        flagMeshes.geo.dispose();
        flagMeshes.poleGeo.dispose();
        flagMeshes.mat.dispose();
        flagMeshes.poleMat.dispose();
        flagMeshes.cloth.dispose();
        flagMeshes.pole.dispose();
      }
      phones?.dispose();
      for (const t of trash) t.dispose();
      group.clear();
    },
  };
}
