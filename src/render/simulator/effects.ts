import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { StadiumTemplate } from '../../core/types';
import { kelvinToRgb, layOutLights } from './lighting';

let _beamGrad: THREE.Texture | null = null;
/** Soft vertical gradient (bright at the lamp, fading toward the pitch) so the
 * floodlight beams read as haze rather than a hard cone. Cached module-wide. */
function beamGradient(): THREE.Texture {
  if (_beamGrad) return _beamGrad;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 64);
  _beamGrad = new THREE.CanvasTexture(c);
  return _beamGrad;
}

/**
 * Match Day Simulator — effects & atmosphere (Phase 5).
 *
 * Floodlight masts, drifting (colourable) smoke, a confetti burst, a pyro burst,
 * and optional bloom post-processing (ULTRA). Particle systems are THREE.Points
 * recycled on the CPU — cheap and self-contained. Bloom is wrapped in try/catch
 * so a failure degrades to a normal render rather than breaking the simulator.
 */

export interface EffectsController {
  setFloodlights(on: boolean): void;
  setSmoke(on: boolean, color?: THREE.ColorRepresentation): void;
  burstConfetti(): void;
  burstPyro(): void;
  update(dt: number): void;
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(renderer: THREE.WebGLRenderer, w: number, h: number): void;
  dispose(): void;
}

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

class Particles {
  readonly points: THREE.Points;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly life: Float32Array;
  readonly n: number;
  readonly mat: THREE.PointsMaterial;
  private readonly geo: THREE.BufferGeometry;

  constructor(n: number, tex: THREE.Texture, size: number, color: THREE.ColorRepresentation, additive: boolean) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); // 0 = dead
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = -9999;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      size,
      map: tex,
      color,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }
  setColor(c: THREE.ColorRepresentation): void {
    this.mat.color.set(c);
  }
  flush(): void {
    this.geo.attributes.position.needsUpdate = true;
  }
  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uContrast: { value: 1.11 },
    uSaturation: { value: 1.16 },
    uLift: { value: new THREE.Color(0.02, 0.03, 0.055) },
    uGain: { value: new THREE.Color(0.05, 0.03, 0.0) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uContrast; uniform float uSaturation;
    uniform vec3 uLift; uniform vec3 uGain;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      col = (col - 0.5) * uContrast + 0.5;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, uSaturation);
      col += uLift * (1.0 - l) + uGain * l;
      vec2 d = vUv - 0.5;
      col *= 1.0 - smoothstep(0.32, 0.8, length(d)) * 0.55;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }
  `,
};

export function buildEffects(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  opts: { bloom: boolean; template: StadiumTemplate },
): EffectsController {
  const tex = dotTexture();
  const trash: { dispose(): void }[] = [tex];

  // ---- Floodlights ----
  // Positions, heights and colour all come from the template now (see
  // ./lighting.ts), because the four masts that used to be hard-coded at
  // (+-122, +-96) and 55 m up hung in mid-air over a small ground and stood
  // inside the stand of a large one. The layout obeys the 25-degree elevation
  // rule and the 15-degree goalkeeper-dazzle exclusion; nothing here chooses a
  // coordinate.
  const plan = layOutLights(opts.template);
  const floodGroup = new THREE.Group();
  floodGroup.visible = false;
  const lampHex = kelvinToRgb(plan.kelvin);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.5 });
  const lampMat = new THREE.MeshStandardMaterial({ color: lampHex, emissive: lampHex, emissiveIntensity: 1.15 });
  trash.push(mastMat, lampMat);
  const spots: THREE.SpotLight[] = [];
  /** Per-spot "on" intensity, so a near light is not brighter than a far one. */
  const spotPower: number[] = [];

  // At most this many real lights. A roof-rim array is 60-odd luminaires and
  // sixty THREE.SpotLights would cost more than the rest of the scene put
  // together; the honest split is that every luminaire is geometry and a
  // representative handful of them actually cast light.
  const MAX_SPOTS = 4;
  const spotEvery = Math.max(1, Math.floor(plan.luminaires.length / MAX_SPOTS));

  plan.luminaires.forEach((lum, i) => {
    const [x, y, z] = lum.pos;

    if (lum.mast) {
      // A tower under the lamp, reaching the ground — and sized to this lamp's
      // own height rather than a fixed 55 m box that floats or buries itself.
      const mastGeo = new THREE.BoxGeometry(1.4, y, 1.4);
      const mast = new THREE.Mesh(mastGeo, mastMat);
      mast.position.set(x, y / 2, z);
      floodGroup.add(mast);
      trash.push(mastGeo);
    }

    const lampGeo = new THREE.BoxGeometry(lum.width, lum.mast ? 3.2 : 1.1, 0.9);
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(x, y, z);
    lamp.lookAt(0, 0, 0);
    floodGroup.add(lamp);
    trash.push(lampGeo);

    if (i % spotEvery !== 0 || spots.length >= MAX_SPOTS) return;
    const dist = Math.hypot(x, y, z);
    const spot = new THREE.SpotLight(lampHex, 0, dist * 3, Math.PI / 6, 0.4, 1.2);
    spot.position.set(x, y, z);
    spot.target.position.set(0, 0, 0);
    floodGroup.add(spot);
    floodGroup.add(spot.target);
    spots.push(spot);
    // The old single intensity of 700 was tuned for a mast 155 m from the
    // middle. THREE's physical falloff means the same number on a roof-rim
    // luminaire 60 m away is four times the light on the grass, so the power
    // follows the throw: 700 at 155 m, matched through the decay exponent.
    spotPower.push(1.648 * dist ** 1.2);

    // Visible volumetric-ish beam toward the pitch (glows at night + bloom).
    // Its width scales with the throw: a cone tuned for a 155 m mast is a
    // searchlight when it starts 60 m away on a roof rim.
    const beamGeo = new THREE.ConeGeometry(dist * 0.22, dist, 40, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: lampHex,
      transparent: true,
      opacity: lum.mast ? 0.05 : 0.035,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      alphaMap: beamGradient(),
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    const lampPos = new THREE.Vector3(x, y, z);
    const dir = lampPos.clone().negate().normalize(); // lamp -> pitch centre
    beam.position.copy(lampPos).addScaledVector(dir, dist / 2);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
    floodGroup.add(beam);
    trash.push(beamGeo, beamMat);
  });
  scene.add(floodGroup);

  // ---- Smoke ----
  const smoke = new Particles(240, tex, 6, 0xcfd6df, false);
  smoke.mat.opacity = 0.2;
  smoke.points.visible = false;
  scene.add(smoke.points);
  trash.push(smoke);
  let smokeOn = false;
  const seedSmoke = (i: number): void => {
    const side = i % 2 === 0 ? 60 : -60;
    smoke.pos[i * 3] = (Math.random() - 0.5) * 60;
    smoke.pos[i * 3 + 1] = Math.random() * 6;
    smoke.pos[i * 3 + 2] = side + (Math.random() - 0.5) * 30;
    smoke.vel[i * 3] = (Math.random() - 0.5) * 1.2;
    smoke.vel[i * 3 + 1] = 3 + Math.random() * 3;
    smoke.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    smoke.life[i] = 1;
  };

  // ---- Confetti ----
  const confetti = new Particles(600, tex, 1.6, 0xffffff, false);
  confetti.mat.opacity = 0.95;
  scene.add(confetti.points);
  trash.push(confetti);
  const confColors = [0xff4d4d, 0x4d7cff, 0xffd24d, 0x4dff88, 0xffffff];

  // ---- Pyro ----
  const pyro = new Particles(180, tex, 4, 0xffa53d, true);
  scene.add(pyro.points);
  trash.push(pyro);

  // ---- Bloom composer (optional, guarded) ----
  let composer: EffectComposer | null = null;
  if (opts.bloom) {
    try {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.6, 0.95));
      composer.addPass(new OutputPass());
      composer.addPass(new ShaderPass(GRADE_SHADER));
    } catch {
      composer = null;
    }
  }

  return {
    setFloodlights(on) {
      floodGroup.visible = on;
      spots.forEach((s, i) => { s.intensity = on ? spotPower[i] : 0; });
    },
    setSmoke(on, color) {
      smokeOn = on;
      smoke.points.visible = on;
      if (color !== undefined) smoke.setColor(color);
      if (on) for (let i = 0; i < smoke.n; i++) seedSmoke(i);
    },
    burstConfetti() {
      for (let i = 0; i < confetti.n; i++) {
        confetti.pos[i * 3] = (Math.random() - 0.5) * 150;
        confetti.pos[i * 3 + 1] = 60 + Math.random() * 40;
        confetti.pos[i * 3 + 2] = (Math.random() - 0.5) * 110;
        confetti.vel[i * 3] = (Math.random() - 0.5) * 6;
        confetti.vel[i * 3 + 1] = -(4 + Math.random() * 5);
        confetti.vel[i * 3 + 2] = (Math.random() - 0.5) * 6;
        confetti.life[i] = 1;
      }
      confetti.setColor(confColors[Math.floor(Math.random() * confColors.length)]);
    },
    burstPyro() {
      for (let i = 0; i < pyro.n; i++) {
        const ex = (i % 2 === 0 ? 1 : -1) * (40 + Math.random() * 20);
        pyro.pos[i * 3] = ex;
        pyro.pos[i * 3 + 1] = 2;
        pyro.pos[i * 3 + 2] = (Math.random() - 0.5) * 50;
        pyro.vel[i * 3] = (Math.random() - 0.5) * 3;
        pyro.vel[i * 3 + 1] = 14 + Math.random() * 10;
        pyro.vel[i * 3 + 2] = (Math.random() - 0.5) * 3;
        pyro.life[i] = 1;
      }
    },
    update(dt) {
      const d = Math.min(0.05, dt);
      if (smokeOn) {
        for (let i = 0; i < smoke.n; i++) {
          smoke.pos[i * 3] += smoke.vel[i * 3] * d;
          smoke.pos[i * 3 + 1] += smoke.vel[i * 3 + 1] * d;
          smoke.pos[i * 3 + 2] += smoke.vel[i * 3 + 2] * d;
          if (smoke.pos[i * 3 + 1] > 45) seedSmoke(i);
        }
        smoke.flush();
      }
      for (let i = 0; i < confetti.n; i++) {
        if (confetti.life[i] <= 0) continue;
        confetti.vel[i * 3 + 1] -= 2.2 * d; // gravity
        confetti.pos[i * 3] += (confetti.vel[i * 3] + Math.sin(confetti.pos[i * 3 + 1] + i) * 1.5) * d;
        confetti.pos[i * 3 + 1] += confetti.vel[i * 3 + 1] * d;
        confetti.pos[i * 3 + 2] += confetti.vel[i * 3 + 2] * d;
        if (confetti.pos[i * 3 + 1] < 0) {
          confetti.life[i] = 0;
          confetti.pos[i * 3 + 1] = -9999;
        }
      }
      confetti.flush();
      for (let i = 0; i < pyro.n; i++) {
        if (pyro.life[i] <= 0) continue;
        pyro.vel[i * 3 + 1] -= 9 * d;
        pyro.pos[i * 3] += pyro.vel[i * 3] * d;
        pyro.pos[i * 3 + 1] += pyro.vel[i * 3 + 1] * d;
        pyro.pos[i * 3 + 2] += pyro.vel[i * 3 + 2] * d;
        pyro.life[i] -= d * 0.6;
        if (pyro.life[i] <= 0 || pyro.pos[i * 3 + 1] < 0) {
          pyro.life[i] = 0;
          pyro.pos[i * 3 + 1] = -9999;
        }
      }
      pyro.flush();
    },
    render(r, s, cam) {
      if (composer) {
        try {
          composer.render();
          return;
        } catch {
          // A post pass failed at runtime — degrade to a plain render instead of
          // a black frame, and stop trying the broken composer.
          composer.dispose();
          composer = null;
        }
      }
      r.render(s, cam);
    },
    setSize(r, w, h) {
      if (composer) {
        composer.setPixelRatio(r.getPixelRatio());
        composer.setSize(w, h);
      }
    },
    dispose() {
      scene.remove(floodGroup);
      scene.remove(smoke.points);
      scene.remove(confetti.points);
      scene.remove(pyro.points);
      for (const t of trash) t.dispose();
      composer?.dispose();
    },
  };
}
