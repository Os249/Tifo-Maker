import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

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

export function buildEffects(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  opts: { bloom: boolean },
): EffectsController {
  const tex = dotTexture();
  const trash: { dispose(): void }[] = [tex];

  // ---- Floodlights ----
  const floodGroup = new THREE.Group();
  floodGroup.visible = false;
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.5 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff0c8, emissiveIntensity: 3 });
  const mastGeo = new THREE.BoxGeometry(1.4, 55, 1.4);
  const lampGeo = new THREE.BoxGeometry(7, 3.2, 1);
  trash.push(mastMat, lampMat, mastGeo, lampGeo);
  const spots: THREE.SpotLight[] = [];
  for (const [x, z] of [
    [122, 96],
    [122, -96],
    [-122, 96],
    [-122, -96],
  ]) {
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(x, 27.5, z);
    floodGroup.add(mast);
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(x, 55, z);
    lamp.lookAt(0, 0, 0);
    floodGroup.add(lamp);
    const spot = new THREE.SpotLight(0xfff2d8, 0, 360, Math.PI / 6, 0.4, 1.2);
    spot.position.set(x, 55, z);
    spot.target.position.set(0, 0, 0);
    floodGroup.add(spot);
    floodGroup.add(spot.target);
    spots.push(spot);
  }
  scene.add(floodGroup);

  // ---- Smoke ----
  const smoke = new Particles(240, tex, 9, 0xcfd6df, false);
  smoke.mat.opacity = 0.35;
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
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.6, 0.82));
      composer.addPass(new OutputPass());
    } catch {
      composer = null;
    }
  }

  return {
    setFloodlights(on) {
      floodGroup.visible = on;
      for (const s of spots) s.intensity = on ? 700 : 0;
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
      if (composer) composer.render();
      else r.render(s, cam);
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
