import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { CAMERA_PRESETS, type CameraPreset } from '../preview3d';
import { type QualityTier, type QualitySettings, settingsFor, probeQuality } from './quality';
import { buildStands } from './stands';

/**
 * Match Day Stadium Simulator — Phase 0 core (the HIGH/ULTRA renderer).
 *
 * A SEPARATE renderer from the editor's preview3d.ts: its own Three.js scene,
 * lazily imported and mounted in a fullscreen overlay, fully disposed on close
 * so only one heavy WebGL context lives at a time. It reuses the SAME data —
 * SeatMap.pos3 for seat positions and DesignStore.cells/palette for colour, with
 * live recolour via the store's dirty events — so the tifo is identical to the
 * editor, just shown on a lit, atmospheric, match-day scene.
 *
 * Phase 0 adds: dusk gradient sky, hemisphere + directional (sun) lighting with
 * optional shadows, ACES tone mapping, distance fog, and a lit pitch. Real
 * extruded stands, crowd, banners and effects arrive in later phases; the tifo
 * cards stay unlit so their colours read true under any lighting.
 */

const EMPTY_COLOR = new THREE.Color(0x20242c);

function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#070d22'); // zenith
  grad.addColorStop(0.45, '#1b2b55');
  grad.addColorStop(0.72, '#46476f'); // dusk band
  grad.addColorStop(0.9, '#a36a5e');
  grad.addColorStop(1.0, '#d59866'); // warm horizon
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class MatchDaySimulator {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly seats: THREE.InstancedMesh;
  private readonly standsGroup: THREE.Group;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly skyTex: THREE.Texture;
  private paletteColors: THREE.Color[] = [];
  private running = false;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly onDirtyCb: (indices: number[] | 'all') => void;
  private readonly onPaletteCb: () => void;
  readonly settings: QualitySettings;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    private readonly template: StadiumTemplate,
    options: { quality?: QualityTier } = {},
  ) {
    this.settings = settingsFor(options.quality ?? probeQuality());

    this.renderer = new THREE.WebGLRenderer({
      antialias: this.settings.antialias,
      preserveDrawingBuffer: true, // future video/GIF capture
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(this.settings.maxPixelRatio, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    if (this.settings.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.canvas = this.renderer.domElement;
    host.appendChild(this.canvas);

    this.skyTex = skyTexture();
    this.scene.background = this.skyTex;
    if (this.settings.fog) this.scene.fog = new THREE.Fog(0x3a3550, 260, 620);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2200);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.applyPreset(CAMERA_PRESETS[0]);

    this.buildLights();
    this.buildEnvironment();
    this.standsGroup = buildStands(this.template, this.settings.shadows);
    this.scene.add(this.standsGroup);

    this.rebuildPalette();
    this.seats = this.buildSeats();
    this.scene.add(this.seats);

    this.onDirtyCb = (indices): void => {
      if (this.disposed) return;
      if (indices === 'all') this.recolorAll();
      else for (const i of indices) this.recolor(i);
      this.seats.instanceColor!.needsUpdate = true;
    };
    this.onPaletteCb = (): void => {
      if (this.disposed) return;
      this.rebuildPalette();
      this.recolorAll();
    };
    store.onDirty(this.onDirtyCb);
    store.onPaletteChange(this.onPaletteCb);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  // ---- colour (shared semantics with the editor preview) ----
  private rebuildPalette(): void {
    this.paletteColors = this.store.palette.map((hex) => new THREE.Color(hex).convertSRGBToLinear());
  }
  private colorFor(i: number): THREE.Color {
    const cell = this.store.cells[i];
    return cell === 0 ? EMPTY_COLOR : (this.paletteColors[cell] ?? EMPTY_COLOR);
  }
  private recolor(i: number): void {
    this.seats.setColorAt(i, this.colorFor(i));
  }
  recolorAll(): void {
    for (let i = 0; i < this.map.count; i++) this.recolor(i);
    if (this.seats.instanceColor) this.seats.instanceColor.needsUpdate = true;
  }

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight(0x9fb4e6, 0x141a22, 0.5);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffe2b0, 1.25);
    sun.position.set(120, 170, 70);
    if (this.settings.shadows) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(this.settings.shadowMapSize, this.settings.shadowMapSize);
      const cam = sun.shadow.camera as THREE.OrthographicCamera;
      cam.left = -170;
      cam.right = 170;
      cam.top = 170;
      cam.bottom = -170;
      cam.near = 0.5;
      cam.far = 600;
      sun.shadow.bias = -0.0005;
    }
    this.scene.add(sun);

    // Cool low fill so shadowed sides don't go black.
    const fill = new THREE.DirectionalLight(0x6f86c9, 0.35);
    fill.position.set(-90, 60, -110);
    this.scene.add(fill);
  }

  private buildEnvironment(): void {
    // Concourse apron (receives shadow).
    const apronGeo = new THREE.CircleGeometry(190, 72);
    const apronMat = new THREE.MeshStandardMaterial({ color: 0x0c0f15, roughness: 1, metalness: 0 });
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.06;
    apron.receiveShadow = this.settings.shadows;
    this.scene.add(apron);
    this.disposables.push(apronGeo, apronMat);

    // Pitch (lit grass).
    const pitchGeo = new THREE.PlaneGeometry(105, 68);
    const pitchMat = new THREE.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.92, metalness: 0 });
    const pitch = new THREE.Mesh(pitchGeo, pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = this.settings.shadows;
    this.scene.add(pitch);
    this.disposables.push(pitchGeo, pitchMat);

    // Markings (unlit lines, like the editor preview).
    const lineMat = new THREE.LineBasicMaterial({ color: 0xe7eee7, transparent: true, opacity: 0.75 });
    const y = 0.03;
    const addLine = (pts: THREE.Vector3[]): void => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.scene.add(new THREE.Line(geo, lineMat));
      this.disposables.push(geo);
    };
    addLine([
      new THREE.Vector3(-52.5, y, -34), new THREE.Vector3(52.5, y, -34),
      new THREE.Vector3(52.5, y, 34), new THREE.Vector3(-52.5, y, 34),
      new THREE.Vector3(-52.5, y, -34),
    ]);
    addLine([new THREE.Vector3(0, y, -34), new THREE.Vector3(0, y, 34)]);
    const circle: THREE.Vector3[] = [];
    for (let a = 0; a <= 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      circle.push(new THREE.Vector3(Math.cos(t) * 9.15, y, Math.sin(t) * 9.15));
    }
    addLine(circle);
    this.disposables.push(lineMat);
  }

  private buildSeats(): THREE.InstancedMesh {
    const geometry = new THREE.PlaneGeometry(0.45, 0.7);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geometry, material, this.map.count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < this.map.count; i++) {
      const x = this.map.pos3[i * 3];
      const yy = this.map.pos3[i * 3 + 1] + 0.9;
      const z = this.map.pos3[i * 3 + 2];
      dummy.position.set(x, yy, z);
      dummy.lookAt(0, yy, 0);
      dummy.rotateX(-0.22);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, this.colorFor(i));
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.disposables.push(geometry, material);
    return mesh;
  }

  applyPreset(preset: CameraPreset): void {
    this.camera.position.set(...preset.position);
    this.controls.target.set(...preset.target);
    this.controls.update();
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.resize();
    const loop = (): void => {
      if (!this.running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.resizeObserver.disconnect();
    this.store.offDirty(this.onDirtyCb);
    this.store.offPaletteChange(this.onPaletteCb);
    this.controls.dispose();
    this.seats.geometry.dispose();
    (this.seats.material as THREE.Material).dispose();
    this.standsGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.skyTex.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
