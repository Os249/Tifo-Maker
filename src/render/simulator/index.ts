import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { CAMERA_PRESETS, type CameraPreset } from '../preview3d';
import { type QualityTier, type QualitySettings, settingsFor, probeQuality } from './quality';
import { buildStands } from './stands';
import { buildCrowd, type CrowdController, type CrowdPreset } from './crowd';
import { buildPitchside, type PitchsideController } from './pitchside';
import { buildBanners, type BannerController } from './banners';
import { buildEffects, type EffectsController } from './effects';
import { SIM_SHOTS, seatShot, flyover, applyShot as applyCameraShot, type SimShot } from './cameras';
import { revealVisibility, type RevealMode } from './choreo';
import { evalTimeline, type Timeline, type Cue } from './timeline';
import { buildAssetLayer, type AssetLayer } from './assetLayer';
import type { AssetStore, SceneAsset } from '../../core/sceneAssets';
import { rasterize } from '../../core/importImage';
import { printAssetPanels } from './printPanels';
import { buildWeather, type WeatherController, type Weather } from './weather';

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

export type TimeOfDay = 'day' | 'dusk' | 'night' | 'sunset';

interface SkyPreset {
  sky: [number, string][];
  fog: string;
  hemiSky: number;
  hemiGround: number;
  hemiInt: number;
  sunColor: number;
  sunInt: number;
  sunPos: [number, number, number];
  fillColor: number;
  fillInt: number;
  exposure: number;
}

const SKIES: Record<TimeOfDay, SkyPreset> = {
  day: { sky: [[0, '#3f72c4'], [0.5, '#7fa8db'], [1, '#cfe1f2']], fog: '#bcd2e6', hemiSky: 0xcfe0f5, hemiGround: 0x40484f, hemiInt: 0.85, sunColor: 0xfff6e8, sunInt: 1.7, sunPos: [120, 200, 80], fillColor: 0x9fb0c8, fillInt: 0.4, exposure: 1.0 },
  dusk: { sky: [[0, '#070d22'], [0.45, '#1b2b55'], [0.72, '#46476f'], [0.9, '#a36a5e'], [1, '#d59866']], fog: '#3a3550', hemiSky: 0x9fb4e6, hemiGround: 0x141a22, hemiInt: 0.5, sunColor: 0xffe2b0, sunInt: 1.25, sunPos: [120, 170, 70], fillColor: 0x6f86c9, fillInt: 0.35, exposure: 1.05 },
  night: { sky: [[0, '#02040a'], [0.6, '#070d1c'], [1, '#0c1830']], fog: '#060a14', hemiSky: 0x2a3550, hemiGround: 0x05080d, hemiInt: 0.28, sunColor: 0xaebfe0, sunInt: 0.4, sunPos: [80, 150, -60], fillColor: 0x33415e, fillInt: 0.25, exposure: 1.15 },
  sunset: { sky: [[0, '#16244e'], [0.45, '#5b3f6b'], [0.72, '#b5532f'], [0.9, '#e8893f'], [1, '#f3b15e']], fog: '#5a3a40', hemiSky: 0xd6a98f, hemiGround: 0x201820, hemiInt: 0.55, sunColor: 0xff8a42, sunInt: 1.35, sunPos: [200, 40, 40], fillColor: 0x7a5a8a, fillInt: 0.3, exposure: 1.08 },
};

function skyTexture(stops: [number, string][]): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  for (const [o, col] of stops) grad.addColorStop(o, col);
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
  private skyTex: THREE.Texture;
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private fill!: THREE.DirectionalLight;
  private readonly weather: WeatherController;
  private paletteColors: THREE.Color[] = [];
  private running = false;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver;
  private readonly onDirtyCb: (indices: number[] | 'all') => void;
  private readonly onPaletteCb: () => void;
  readonly settings: QualitySettings;

  // Phase 2-7 subsystems.
  private readonly crowd: CrowdController;
  private readonly pitchside: PitchsideController;
  private readonly banners: BannerController;
  private readonly effects: EffectsController;
  private readonly clock = new THREE.Clock();
  private elapsed = 0;
  private flyActive = false;
  private reveal: { mode: RevealMode; start: number; dur: number } | null = null;
  private readonly assetLayer: AssetLayer;
  private timeline: Timeline | null = null;
  private tlStart = 0;
  private tlPrev = 0;
  private tlLoop = false;
  private lastCamName: string | null = null;
  private revealActiveLast = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    private readonly template: StadiumTemplate,
    private readonly assetStore: AssetStore,
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

    this.skyTex = skyTexture(SKIES.dusk.sky);
    this.scene.background = this.skyTex;
    if (this.settings.fog) this.scene.fog = new THREE.Fog(SKIES.dusk.fog, 260, 620);

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

    // Subsystems (Phases 2-7). Each is independently toggleable from the overlay.
    this.crowd = buildCrowd(this.map, this.store);
    this.scene.add(this.crowd.object);
    this.pitchside = buildPitchside(this.settings.shadows);
    this.scene.add(this.pitchside.object);
    this.banners = buildBanners(this.map, this.store);
    this.scene.add(this.banners.object);
    this.effects = buildEffects(this.scene, this.renderer, this.camera, { bloom: this.settings.tier === 'ultra' });
    this.assetLayer = buildAssetLayer(this.assetStore, () => this.store.palette);
    this.scene.add(this.assetLayer.object);
    this.weather = buildWeather(this.scene);

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
    this.paletteColors = this.store.palette.map((hex) => new THREE.Color(hex));
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
    const p = SKIES.dusk;
    this.hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiInt);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(p.sunColor, p.sunInt);
    this.sun.position.set(p.sunPos[0], p.sunPos[1], p.sunPos[2]);
    if (this.settings.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(this.settings.shadowMapSize, this.settings.shadowMapSize);
      const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
      cam.left = -170;
      cam.right = 170;
      cam.top = 170;
      cam.bottom = -170;
      cam.near = 0.5;
      cam.far = 600;
      this.sun.shadow.bias = -0.0005;
    }
    this.scene.add(this.sun);

    // Cool low fill so shadowed sides don't go black.
    this.fill = new THREE.DirectionalLight(p.fillColor, p.fillInt);
    this.fill.position.set(-90, 60, -110);
    this.scene.add(this.fill);
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

  // ---- camera director (Phase 6) ----
  shots(): SimShot[] {
    return [...SIM_SHOTS, seatShot(this.map, 'crowd'), seatShot(this.map, 'ultra')];
  }
  applyShot(s: SimShot): void {
    this.flyActive = false;
    applyCameraShot(this.camera, this.controls, s);
  }
  setFlyover(on: boolean): void {
    this.flyActive = on;
  }

  // ---- crowd (Phase 2) ----
  setCrowdDensity(f: number): void {
    this.crowd.setDensity(f);
  }
  setCrowdPreset(p: CrowdPreset): void {
    this.crowd.setPreset(p);
  }
  setCrowdShowOnTifo(b: boolean): void {
    this.crowd.setShowOnTifo(b);
  }
  setCrowdVisible(b: boolean): void {
    this.crowd.object.visible = b;
  }

  // ---- pitch-side (Phase 3) ----
  setPitchsideVisible(b: boolean): void {
    this.pitchside.object.visible = b;
  }

  // ---- banners & flags (Phase 4) ----
  setBannersVisible(b: boolean): void {
    this.banners.setVisible(b);
  }
  setFlagsVisible(b: boolean): void {
    this.banners.setFlagsVisible(b);
  }

  // ---- effects (Phase 5) ----
  setFloodlights(b: boolean): void {
    this.effects.setFloodlights(b);
  }

  // ---- environment (Wave D) ----
  setTimeOfDay(tod: TimeOfDay): void {
    const p = SKIES[tod] ?? SKIES.dusk;
    this.skyTex.dispose();
    this.skyTex = skyTexture(p.sky);
    this.scene.background = this.skyTex;
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.set(p.fog);
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiInt;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunInt;
    this.sun.position.set(p.sunPos[0], p.sunPos[1], p.sunPos[2]);
    this.fill.color.set(p.fillColor);
    this.fill.intensity = p.fillInt;
    this.renderer.toneMappingExposure = p.exposure;
  }
  setWeather(w: Weather): void {
    this.weather.setWeather(w);
  }
  setExposure(v: number): void {
    this.renderer.toneMappingExposure = v;
  }
  setSunIntensity(v: number): void {
    this.sun.intensity = v;
  }

  /** Capture the current frame as a PNG data URL (Wave G — poster export). */
  snapshot(): string {
    this.effects.render(this.renderer, this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
  setSmoke(b: boolean, color?: THREE.ColorRepresentation): void {
    this.effects.setSmoke(b, color);
  }
  burstConfetti(): void {
    this.effects.burstConfetti();
  }
  burstPyro(): void {
    this.effects.burstPyro();
  }

  // ---- tifo assets: banners / text / floor (Wave A) ----
  /** Representative front-rail point of the top tier on a stand (0 E,1 N,2 W,3 S). */
  private standAnchor(stand: 0 | 1 | 2 | 3): { position: { x: number; y: number; z: number }; rotationY: number } {
    let topTier = 0;
    for (let i = 0; i < this.map.count; i++) if (this.map.tierOf[i] > topTier) topTier = this.map.tierOf[i];
    let frontRow = Infinity;
    for (let i = 0; i < this.map.count; i++)
      if (this.map.tierOf[i] === topTier && this.map.rowOf[i] < frontRow) frontRow = this.map.rowOf[i];
    const targetU = (stand * 0.25 + 0.25) % 1;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.map.count; i++) {
      if (this.map.tierOf[i] !== topTier || this.map.rowOf[i] !== frontRow) continue;
      let du = Math.abs(this.map.uv[i * 2] - targetU);
      if (du > 0.5) du = 1 - du;
      if (du < bd) {
        bd = du;
        best = i;
      }
    }
    if (best < 0) return { position: { x: 0, y: 14, z: -60 }, rotationY: 0 };
    const x = this.map.pos3[best * 3];
    const y = this.map.pos3[best * 3 + 1] + 2;
    const z = this.map.pos3[best * 3 + 2];
    return { position: { x, y, z }, rotationY: Math.atan2(-x, -z) };
  }

  addBanner(stand: 0 | 1 | 2 | 3 = 1): void {
    const a = this.standAnchor(stand);
    this.assetStore.add('banner', { position: a.position, rotationY: a.rotationY, scale: { x: 18, y: 4, z: 1 } });
  }
  addTextBanner(text: string, stand: 0 | 1 | 2 | 3 = 1): void {
    const a = this.standAnchor(stand);
    this.assetStore.add('banner', {
      position: { x: a.position.x, y: Math.max(2, a.position.y - 1), z: a.position.z },
      rotationY: a.rotationY,
      scale: { x: 22, y: 3, z: 1 },
      text,
    });
  }
  addFloorBanner(): void {
    this.assetStore.add('floor', { position: { x: 0, y: 0.05, z: 0 }, rotationY: 0, scale: { x: 26, y: 14, z: 1 } });
  }
  /** A giant draped surface tifo over a stand (image-able, cloth, can unfurl). */
  addSurface(stand: 0 | 1 | 2 | 3 = 1): void {
    const a = this.standAnchor(stand);
    this.assetStore.add('surface', {
      position: { x: a.position.x, y: Math.max(8, a.position.y - 6), z: a.position.z },
      rotationY: a.rotationY,
      scale: { x: 44, y: 26, z: 1 },
      cloth: true,
      imageRef: null,
    });
  }
  /** A crowd-surfed mega-flag low over a stand. */
  addMegaFlag(stand: 0 | 1 | 2 | 3 = 1): void {
    const a = this.standAnchor(stand);
    this.assetStore.add('flag', {
      position: { x: a.position.x * 0.7, y: 12, z: a.position.z * 0.7 },
      rotationY: a.rotationY,
      scale: { x: 30, y: 18, z: 1 },
      cloth: true,
    });
  }
  /** A waving scarf wall across the front of a stand. */
  addScarves(stand: 0 | 1 | 2 | 3 = 1): void {
    const a = this.standAnchor(stand);
    this.assetStore.add('scarf', {
      position: { x: a.position.x, y: Math.max(4, a.position.y - 10), z: a.position.z },
      rotationY: a.rotationY,
      scale: { x: 50, y: 3, z: 1 },
      cloth: true,
    });
  }
  unfurlSelected(): void {
    const s = this.assetStore.selected;
    if (s) this.assetLayer.unfurl(s.id, 3000);
  }
  setSelectedY(y: number): void {
    const s = this.assetStore.selected;
    if (s) this.assetStore.update(s.id, { position: { x: s.position.x, y, z: s.position.z } });
  }
  /** Print the selected image asset as tiled A4 panels (Wave E / #15). */
  printSelectedPanels(): boolean {
    const s = this.assetStore.selected;
    if (!s || !s.imageRef) return false;
    return printAssetPanels(s.imageRef, Math.abs(s.scale.x), Math.abs(s.scale.y));
  }

  /**
   * Perspective mega-mosaic (Wave B / #1): project an image onto the seats AS
   * SEEN FROM THE CURRENT CAMERA, so it reads undistorted from that viewpoint —
   * the thing a flat editor (or Photoshop) fundamentally cannot do. Each seat is
   * projected to the camera's screen space; the image is sampled there and
   * quantized to the palette. Written via one undoable stroke that flushes to
   * every view. Returns the number of seats painted.
   */
  projectImageToMosaic(source: HTMLImageElement | HTMLCanvasElement | ImageBitmap): number {
    const SW = 512;
    const SH = 512;
    let pixels: Uint8ClampedArray;
    try {
      pixels = rasterize(source, SW, SH);
    } catch {
      return 0;
    }
    const pal: [number, number, number][] = [];
    for (let i = 1; i < this.store.palette.length; i++) {
      let h = this.store.palette[i].replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const n = parseInt(h, 16);
      pal.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    }
    if (pal.length === 0) return 0;

    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3();
    const dirty: number[] = [];
    this.store.beginStroke();
    for (let i = 0; i < this.map.count; i++) {
      v.set(this.map.pos3[i * 3], this.map.pos3[i * 3 + 1] + 0.9, this.map.pos3[i * 3 + 2]).project(this.camera);
      if (v.z < -1 || v.z > 1) continue; // outside the frustum depth
      const sx = v.x * 0.5 + 0.5;
      const sy = 1 - (v.y * 0.5 + 0.5);
      if (sx < 0 || sx >= 1 || sy < 0 || sy >= 1) continue;
      const o = ((Math.min(SH - 1, (sy * SH) | 0) * SW) + Math.min(SW - 1, (sx * SW) | 0)) * 4;
      if (pixels[o + 3] < 128) continue; // transparent
      const r = pixels[o];
      const g = pixels[o + 1];
      const b = pixels[o + 2];
      let best = 1;
      let bd = Infinity;
      for (let k = 0; k < pal.length; k++) {
        const dr = r - pal[k][0];
        const dg = g - pal[k][1];
        const db = b - pal[k][2];
        const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
        if (d < bd) {
          bd = d;
          best = k + 1;
        }
      }
      if (this.store.paint(i, best)) dirty.push(i);
    }
    this.store.commitStroke();
    this.store.flush(dirty);
    return dirty.length;
  }
  selectAsset(id: string | null): void {
    this.assetStore.select(id);
  }
  removeSelected(): void {
    const s = this.assetStore.selected;
    if (s) this.assetStore.remove(s.id);
  }
  updateSelected(patch: Partial<SceneAsset>): void {
    const s = this.assetStore.selected;
    if (s) this.assetStore.update(s.id, patch);
  }
  listAssets(): { id: string; type: string }[] {
    return this.assetStore.list().map((a) => ({ id: a.id, type: a.type }));
  }
  get selectedAssetId(): string | null {
    return this.assetStore.selected?.id ?? null;
  }

  // ---- choreography reveal (Phase 7) ----
  playReveal(mode: RevealMode, durationMs = 4500): void {
    this.timeline = null;
    this.reveal = { mode, start: this.elapsed, dur: Math.max(0.5, durationMs / 1000) };
  }

  // ---- choreography timeline (Wave C) ----
  playTimeline(tl: Timeline, loop = false): void {
    this.reveal = null;
    this.flyActive = false;
    this.timeline = tl;
    this.tlStart = this.elapsed;
    this.tlPrev = 0;
    this.tlLoop = loop;
    this.lastCamName = null;
  }
  stopTimeline(): void {
    this.timeline = null;
    this.revealActiveLast = false;
    this.recolorAll();
    for (const a of this.assetStore.list()) this.assetLayer.setOpacity(a.id, 1);
  }
  /** A ready-made show: broadcast view -> tifo wipes in -> smoke -> ultra view -> pyro -> confetti -> drone. */
  buildAutoChoreo(): Timeline {
    const cues: Cue[] = [
      { kind: 'camera', start: 0, shot: 'TV Broadcast' },
      { kind: 'reveal', start: 0.5, dur: 4, mode: 'wipe-lr' },
      { kind: 'effect', start: 5, effect: 'smoke-on' },
      { kind: 'camera', start: 5.5, shot: 'Ultra View' },
      { kind: 'effect', start: 7.5, effect: 'pyro' },
      { kind: 'effect', start: 8.5, effect: 'confetti' },
      { kind: 'camera', start: 11, shot: 'Drone' },
    ];
    return { duration: 15, cues };
  }
  playAutoChoreo(): void {
    for (const a of this.assetStore.list()) if (a.type === 'surface') this.assetLayer.unfurl(a.id, 3000);
    this.playTimeline(this.buildAutoChoreo(), false);
  }
  private stepTimeline(): void {
    if (!this.timeline) return;
    let t = this.elapsed - this.tlStart;
    if (t > this.timeline.duration) {
      if (this.tlLoop) {
        this.tlStart = this.elapsed;
        this.tlPrev = 0;
        this.lastCamName = null;
        t = 0;
      } else {
        this.stopTimeline();
        return;
      }
    }
    const st = evalTimeline(this.timeline, t, this.tlPrev);
    this.tlPrev = t;
    if (st.reveal) {
      this.applyReveal(revealVisibility(this.map, st.reveal.mode, st.reveal.progress));
      this.revealActiveLast = true;
    } else if (this.revealActiveLast) {
      this.recolorAll();
      this.revealActiveLast = false;
    }
    for (const a of this.assetStore.list()) {
      const o = st.assetOpacity[a.id];
      if (o !== undefined) this.assetLayer.setOpacity(a.id, o);
    }
    for (const e of st.firedEffects) {
      if (e === 'confetti') this.effects.burstConfetti();
      else if (e === 'pyro') this.effects.burstPyro();
      else if (e === 'smoke-on') this.effects.setSmoke(true);
      else if (e === 'smoke-off') this.effects.setSmoke(false);
      else if (e === 'floods-on') this.effects.setFloodlights(true);
      else if (e === 'floods-off') this.effects.setFloodlights(false);
    }
    if (st.camera && st.camera !== this.lastCamName) {
      const shot = this.shots().find((s) => s.name === st.camera);
      if (shot) applyCameraShot(this.camera, this.controls, shot);
      this.lastCamName = st.camera;
    }
  }
  private stepReveal(): void {
    if (!this.reveal) return;
    const p = (this.elapsed - this.reveal.start) / this.reveal.dur;
    if (p >= 1) {
      this.applyReveal(null);
      this.reveal = null;
      return;
    }
    this.applyReveal(revealVisibility(this.map, this.reveal.mode, Math.max(0, p)));
  }
  private applyReveal(vis: ((seat: number) => number) | null): void {
    if (!vis) {
      this.recolorAll();
      return;
    }
    const tmp = new THREE.Color();
    for (let i = 0; i < this.map.count; i++) {
      const full = this.colorFor(i);
      const a = vis(i);
      if (a >= 1) this.seats.setColorAt(i, full);
      else {
        tmp.copy(EMPTY_COLOR).lerp(full, a);
        this.seats.setColorAt(i, tmp);
      }
    }
    if (this.seats.instanceColor) this.seats.instanceColor.needsUpdate = true;
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects.setSize(this.renderer, w, h);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.resize();
    this.clock.start();
    const loop = (): void => {
      if (!this.running) return;
      const dt = this.clock.getDelta();
      this.elapsed += dt;
      if (this.flyActive) applyCameraShot(this.camera, this.controls, flyover(this.elapsed));
      this.banners.update(this.elapsed);
      this.assetLayer.update(this.elapsed);
      this.effects.update(dt);
      this.weather.update(dt);
      if (this.reveal) this.stepReveal();
      if (this.timeline) this.stepTimeline();
      this.controls.update();
      this.effects.render(this.renderer, this.scene, this.camera);
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
    this.crowd.dispose();
    this.pitchside.dispose();
    this.banners.dispose();
    this.effects.dispose();
    this.assetLayer.dispose();
    this.weather.dispose();
    for (const d of this.disposables) d.dispose();
    this.skyTex.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
