import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatMap, StadiumTemplate } from '../../core/types';
import type { DesignStore } from '../../core/design';
import { CAMERA_PRESETS, type CameraPreset } from '../preview3d';
import { type QualityTier, type QualitySettings, settingsFor, probeQuality } from './quality';
import { applyNightIBL } from './env';
import { buildStands } from './stands';
import { buildTrack, type TrackBuild } from './track';
import { describeRecording, pickRecordingFormat, recordingPlan, type RecordingFormat } from './recordPlan';

export { RECORD_MAX_BYTES } from './recordPlan';
import { buildCrowd, type CrowdController, type CrowdPreset } from './crowd';
import { buildPitchside, type PitchsideController } from './pitchside';
import { buildBanners, type BannerController } from './banners';
import { buildEffects, type EffectsController } from './effects';
import { bowlShots, seatShot, flyover, applyShot as applyCameraShot, type SimShot } from './cameras';
import { revealVisibility, type RevealMode } from './choreo';
import { evalTimeline, type Timeline, type Cue } from './timeline';
import { buildAssetLayer, type AssetLayer } from './assetLayer';
import { buildBannerRigs, type BannerRigLayer } from './bannerRig';
import { standIsRoofed } from './roof';
import { buildPlacement, type PlacementHelper } from './bannerPlace';
import { maxUsefulSpan, hangableTiers } from './bannerSlot';
import { bannerShot } from './bannerCamera';
import type { BannerStore, StandIndex } from '../../core/banner';
import type { AssetStore, SceneAsset } from '../../core/sceneAssets';
import { rasterize } from '../../core/importImage';
import { printAssetPanels } from './printPanels';
import { buildWeather, type WeatherController, type Weather } from './weather';
import { buildSurroundings, type Surroundings } from './surroundings';
import { buildPhoneFlash, type PhoneFlash } from './sparkles';
import { buildJewelCrown } from './jewelCrown';
import { buildAlAwwalExtras, buildKingdomArenaExtras } from './stadiumExtras';
import { buildPitchDetail, pitchStripeTexture } from './pitchDetail';
import { dbg } from './debug';
import { buildAtmosphere, type Atmosphere, type SoundBus, type SoundLevels } from './atmosphere';

/**
 * How full each crowd preset leaves the ground, for the mixer.
 *
 * The same numbers `crowd.ts` builds the instances from — duplicated rather
 * than exported because the two are answering different questions (how many
 * people to draw, how loud they are) and the day one of them wants a different
 * curve is the day sharing a constant becomes a problem. If they drift, the
 * drift is visible in one screen of code.
 */
const PRESET_FILL: Record<CrowdPreset, number> = {
  sellout: 0.97,
  home: 0.9,
  'away-end': 0.88,
  half: 0.5,
  empty: 0,
};

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

/** A finished recording, and what it actually is. */
export interface RecordedClip extends RecordingFormat {
  blob: Blob;
}

export class MatchDaySimulator {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /** Public so a shot harness can report where it ended up. */
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly seats: THREE.InstancedMesh;
  private readonly standsGroup: THREE.Group;
  private readonly disposables: { dispose(): void }[] = [];
  private skyTex: THREE.Texture;
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private fill!: THREE.DirectionalLight;
  private readonly weather: WeatherController;
  private readonly surroundings: Surroundings;
  private readonly sparkles: PhoneFlash;
  private manassaMask: Uint8Array | null = null;
  private readonly manassaColor = new THREE.Color(0xc69a3a);
  private readonly jewelSeatColors = [new THREE.Color(0x8f2d2d), new THREE.Color(0xb14a2a), new THREE.Color(0xc98a4b), new THREE.Color(0x6f2222), new THREE.Color(0xd8b98a), new THREE.Color(0xa33b2b)];
  private readonly alawwalSeatColors = [new THREE.Color(0xf2c40f), new THREE.Color(0xe8bd10), new THREE.Color(0xf5cd2a), new THREE.Color(0xd9ae0c), new THREE.Color(0xf7d43a), new THREE.Color(0xf2c40f), new THREE.Color(0xefc200)];
  private readonly alawwalBlue = new THREE.Color(0x15245e);
  private readonly kingdomSeatColors = [new THREE.Color(0x1c2a5e), new THREE.Color(0x2b4a9c), new THREE.Color(0xe8ecf6), new THREE.Color(0x24377a), new THREE.Color(0xd8deea), new THREE.Color(0x1c3a8a), new THREE.Color(0x203a72)];
  private pitchMat!: THREE.MeshStandardMaterial;
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
  private track!: TrackBuild;
  private readonly effects: EffectsController;
  private readonly atmosphere: Atmosphere;
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
  private camTween: {
    t0: number;
    dur: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toTgt: THREE.Vector3;
    fromFov: number;
    toFov: number;
  } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    private readonly template: StadiumTemplate,
    private readonly assetStore: AssetStore,
    options: { quality?: QualityTier; onContextLost?: () => void; bannerStore?: BannerStore } = {},
  ) {
    this.bannerStore = options.bannerStore ?? null;
    this.settings = settingsFor(options.quality ?? probeQuality());
    this.onContextLost = options.onContextLost;

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
    // A phone under memory pressure — a call arriving, a camera app opening —
    // takes the GL context back. Unhandled, the bowl goes black and stays
    // black while the loop keeps calling draw on a dead context, which is both
    // silent and expensive. preventDefault is what makes it restorable at all.
    this.canvas.addEventListener('webglcontextlost', this.onCtxLost);
    host.appendChild(this.canvas);

    this.skyTex = skyTexture(SKIES.dusk.sky);
    this.scene.background = this.skyTex;
    if (this.settings.fog) this.scene.fog = new THREE.Fog(SKIES.dusk.fog, 260, 620);
    // P1: image-based lighting — real ambient + reflections on every PBR surface.
    if (this.settings.ibl) applyNightIBL(this.renderer, this.scene, this.settings.envIntensity);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 5000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 2; // zoom right in
    this.controls.maxDistance = 2500; // and far out past the skyline
    this.controls.zoomSpeed = 1.2;
    this.applyPreset(CAMERA_PRESETS[0]);

    this.buildLights();
    this.buildEnvironment();
    this.standsGroup = buildStands(this.template, this.settings.shadows);
    this.scene.add(this.standsGroup);

    this.rebuildPalette();
    this.manassaMask = this.computeManassaMask();
    this.seats = this.buildSeats();
    this.scene.add(this.seats);

    // Subsystems (Phases 2-7). Each is independently toggleable from the overlay.
    this.crowd = buildCrowd(this.map, this.store);
    this.scene.add(this.crowd.object);
    this.pitchside = buildPitchside(this.settings.shadows);
    this.scene.add(this.pitchside.object);
    this.banners = buildBanners(this.map, this.store);
    this.scene.add(this.banners.object);
    this.effects = buildEffects(this.scene, this.renderer, this.camera, { bloom: this.settings.tier === 'high' || this.settings.tier === 'ultra', template: this.template });
    this.assetLayer = buildAssetLayer(this.assetStore, () => this.store.palette);
    this.scene.add(this.assetLayer.object);
    this.resolveEditorBanners();
    // Banners: their own layer, because a banner is not a decal on a stand —
    // it is fabric on a rig, and both of those are geometry that has to follow
    // the bowl's real shape. The placement helper owns the stand frames, so
    // the rigs and the drag-and-snap agree on where a stand is by construction.
    if (this.bannerStore) {
      this.placement = buildPlacement(this.map, this.bannerStore, this.template.sectionsPerTier);
      this.scene.add(this.placement.object);
      const place = this.placement;
      this.bannerRigs = buildBannerRigs(
        this.bannerStore,
        (st, stands) => place.frameFor(st, stands),
        // Live, not captured: a banner that was resting on a full kop has to
        // come down onto the seats when the user empties the stand.
        () => this.crowdFill,
        // Where a flown banner's ropes are tied. Only the simulator knows
        // whether this ground has a roof over that stand, and a rope to a
        // roof that is not there is two threads ending in mid-air.
        (st, stands, alongU) => {
          const f = place.frameFor(st, stands);
          const covered = standIsRoofed(this.template, st);
          // A cantilever reaches in over the top tier, so its leading edge is
          // short of the back of the bowl — which is what makes the rope lean
          // back instead of running straight up past the seats.
          const p = f.pointAt(alongU, covered ? 0.84 : 1);
          return { x: p.x, y: covered ? f.roofY : p.y + 1.4, z: p.z, onRoof: covered };
        },
      );
      this.scene.add(this.bannerRigs.object);
      this.bindBannerPointer();
    }
    // Silent until asked for. Sound that starts by itself is hostile, and a
    // browser will refuse to start it outside a gesture anyway.
    this.atmosphere = buildAtmosphere();
    this.weather = buildWeather(this.scene);
    // The city is placed relative to THIS bowl, not to a constant — see
    // buildSurroundings. The radius is the plan curve plus the deepest tier,
    // which is the outside of the building.
    this.surroundings = buildSurroundings(
      Math.max(this.template.plan.a, this.template.plan.b) +
      this.template.tiers.reduce((m, tr) => Math.max(m, (tr.baseOffset ?? 0) + tr.rows * tr.rowDepth), 0),
    );
    this.scene.add(this.surroundings.object);
    this.sparkles = buildPhoneFlash(this.map);
    // Off until asked for: a bowl that twinkles by itself misreads a still tifo
    // as motion, and it is the first thing to distract from the artwork.
    this.sparkles.object.visible = false;
    this.scene.add(this.sparkles.object);
    if (this.template.id === 'community-jewel-jeddah-62k') {
      const crown = buildJewelCrown();
      this.scene.add(crown.object);
      this.disposables.push(...crown.disposables);
    }
    if (this.template.id === 'community-alawwal-park-25k') {
      let mx = 1;
      let mz = 1;
      let my = 1;
      for (let k = 0; k < this.map.count; k++) {
        mx = Math.max(mx, Math.abs(this.map.pos3[k * 3]));
        my = Math.max(my, this.map.pos3[k * 3 + 1]);
        mz = Math.max(mz, Math.abs(this.map.pos3[k * 3 + 2]));
      }
      const ex = buildAlAwwalExtras(mx, mz, my);
      this.scene.add(ex.object);
      this.disposables.push(...ex.disposables);
    }
    if (this.template.id === 'community-kingdom-arena-28k') {
      let kx = 1;
      let kz = 1;
      let ky = 1;
      for (let k = 0; k < this.map.count; k++) {
        kx = Math.max(kx, Math.abs(this.map.pos3[k * 3]));
        ky = Math.max(ky, this.map.pos3[k * 3 + 1]);
        kz = Math.max(kz, Math.abs(this.map.pos3[k * 3 + 2]));
      }
      const ex = buildKingdomArenaExtras(kx, kz, ky);
      this.scene.add(ex.object);
      this.disposables.push(...ex.disposables);
    }

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
    dbg('mounted', { tier: this.settings.tier, seats: this.map.count, shadows: this.settings.shadows, fog: this.settings.fog });
  }

  // ---- colour (shared semantics with the editor preview) ----
  private rebuildPalette(): void {
    this.paletteColors = this.store.palette.map((hex) => new THREE.Color(hex));
  }
  private colorFor(i: number): THREE.Color {
    if (this.manassaMask && this.manassaMask[i] === 1) return this.manassaColor;
    const cell = this.store.cells[i];
    if (cell === 0 && this.template.id === 'community-jewel-jeddah-62k') {
      return this.jewelSeatColors[(Math.imul(i, 2654435761) >>> 0) % this.jewelSeatColors.length];
    }
    if (cell === 0 && this.template.id === 'community-alawwal-park-25k') {
      // Two-tone Al-Nassr: blue pitch-side front rail, gold body (matches the ground).
      if (this.map.rowOf[i] < 4) return this.alawwalBlue;
      return this.alawwalSeatColors[(Math.imul(i, 2654435761) >>> 0) % this.alawwalSeatColors.length];
    }
    if (cell === 0 && this.template.id === 'community-kingdom-arena-28k') {
      return this.kingdomSeatColors[(Math.imul(i, 2654435761) >>> 0) % this.kingdomSeatColors.length];
    }
    return cell === 0 ? EMPTY_COLOR : (this.paletteColors[cell] ?? EMPTY_COLOR);
  }

  /** The Jewel's main VIP tribune (al-manassa) — West-stand centre, lower two
   * tiers. Those gold-ticket seats never take the tifo; they render as a fixed
   * premium gold block. Jewel template only. */
  private computeManassaMask(): Uint8Array | null {
    if (this.template.id !== 'community-jewel-jeddah-62k') return null;
    const n = this.map.count;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const u = (((this.map.uv[i * 2] + 0.125) % 1) + 1) % 1;
      const s = u * 4;
      const stand = Math.floor(s);
      const frac = s - stand;
      if (stand === 2 && this.map.tierOf[i] <= 1 && frac > 0.34 && frac < 0.66) mask[i] = 1;
    }
    return mask;
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
    const apronMat = new THREE.MeshStandardMaterial({ color: 0x0c0f15, roughness: 0.85, metalness: 0, envMapIntensity: 0.5 });
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.06;
    apron.receiveShadow = this.settings.shadows;
    this.scene.add(apron);
    this.disposables.push(apronGeo, apronMat);
    if (this.template.id === 'community-jewel-jeddah-62k') {
      // The Jewel's wide flat run-off (warm sand) between the pitch and the stands.
      const roGeo = new THREE.CircleGeometry(58, 64);
      const roMat = new THREE.MeshStandardMaterial({ color: 0x5f5540, roughness: 0.9, metalness: 0, envMapIntensity: 0.5 });
      const ro = new THREE.Mesh(roGeo, roMat);
      ro.rotation.x = -Math.PI / 2;
      ro.scale.set(1.2, 1, 1);
      ro.position.y = -0.02;
      ro.receiveShadow = this.settings.shadows;
      this.scene.add(ro);
      this.disposables.push(roGeo, roMat);
    }

    // Pitch (lit grass).
    const pitchGeo = new THREE.PlaneGeometry(105, 68);
    this.pitchMat = new THREE.MeshStandardMaterial({ color: 0x1f7a3a, map: pitchStripeTexture(), roughness: 0.72, metalness: 0, envMapIntensity: 1.1 });
    const pitch = new THREE.Mesh(pitchGeo, this.pitchMat);
    pitch.rotation.x = -Math.PI / 2;
    pitch.receiveShadow = this.settings.shadows;
    this.scene.add(pitch);
    this.disposables.push(pitchGeo, this.pitchMat);
    this.scene.add(buildPitchDetail(this.settings.shadows)); // goals + full markings

    // The track, if this ground has one AND has room for it. buildTrack checks
    // the fit itself, so a template cannot claim a 400 m oval its bowl could
    // never hold — see track.ts.
    this.track = buildTrack(this.template, this.settings.shadows);
    this.scene.add(this.track.object);

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
  private seatBoundsCache: { ax: number; bz: number; ty: number } | null = null;
  /** Bowl extent from the seat map. Memoised — the flyover asks for it per frame. */
  private seatBounds(): { ax: number; bz: number; ty: number } {
    if (this.seatBoundsCache) return this.seatBoundsCache;
    let ax = 1;
    let bz = 1;
    let ty = 1;
    for (let k = 0; k < this.map.count; k++) {
      ax = Math.max(ax, Math.abs(this.map.pos3[k * 3]));
      ty = Math.max(ty, this.map.pos3[k * 3 + 1]);
      bz = Math.max(bz, Math.abs(this.map.pos3[k * 3 + 2]));
    }
    this.seatBoundsCache = { ax, bz, ty };
    return this.seatBoundsCache;
  }
  shots(): SimShot[] {
    if (this.template.id === 'community-kingdom-arena-28k') {
      const { ax, bz, ty } = this.seatBounds();
      return [
        { name: 'TV Broadcast', position: [-ax * 0.62, ty * 0.85, bz * 0.6], target: [ax * 0.62, ty * 0.42, 0], fov: 62 },
        { name: 'Main Camera', position: [ax * 0.2, ty + 4, -bz * 0.92], target: [0, 1, 0], fov: 60 },
        { name: 'Behind Goal', position: [-ax * 0.98, ty * 0.7, 0], target: [ax * 0.35, 2, 0], fov: 62 },
        { name: 'Pitch Level', position: [ax * 0.4, 2.5, bz * 0.5], target: [-ax * 0.5, 8, -bz * 0.3], fov: 62 },
        { name: 'High Corner', position: [ax * 0.95, ty + 4, bz * 0.95], target: [0, 0, 0], fov: 62 },
        { name: 'Centre', position: [0, ty + 5, -bz * 0.98], target: [0, 1, bz * 0.3], fov: 62 },
      ];
    }
    // Every other ground: shots derived from ITS bowl, so the cameras always sit
    // on the seating looking in (absolute SIM_SHOTS only fit the default 92x70).
    return [...bowlShots(this.seatBounds()), seatShot(this.map, 'crowd'), seatShot(this.map, 'ultra')];
  }
  /** Smoothly glide to a shot (eased), instead of snapping. */
  applyShot(s: SimShot): void {
    this.flyActive = false;
    this.camTween = {
      t0: this.elapsed,
      dur: 0.8,
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3(s.position[0], s.position[1], s.position[2]),
      fromTgt: this.controls.target.clone(),
      toTgt: new THREE.Vector3(s.target[0], s.target[1], s.target[2]),
      fromFov: this.camera.fov,
      toFov: s.fov,
    };
    this.controls.enabled = false;
  }
  private stepCamTween(): void {
    const tw = this.camTween;
    if (!tw) return;
    let t = tw.dur > 0 ? (this.elapsed - tw.t0) / tw.dur : 1;
    if (t > 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
    this.controls.target.lerpVectors(tw.fromTgt, tw.toTgt, e);
    this.camera.fov = tw.fromFov + (tw.toFov - tw.fromFov) * e;
    this.camera.updateProjectionMatrix();
    if (t >= 1) {
      this.camTween = null;
      this.controls.enabled = true;
    }
  }
  setFlyover(on: boolean): void {
    this.flyActive = on;
    if (on) {
      this.camTween = null;
      this.controls.enabled = true;
    }
  }

  // ---- crowd (Phase 2) ----
  /**
   * How full the bowl is, as the mixer hears it.
   *
   * `crowdReactive` is what the checkbox turns off; `crowdFill` is what the
   * scene last said. Keeping both means switching the checkback on does not
   * need the density slider touched again to take effect.
   */
  private crowdFill = PRESET_FILL.sellout;
  private crowdReactive = true;
  private weatherSound = true;
  private weatherNow: Weather = 'clear';

  private pushCrowdFill(f: number): void {
    this.crowdFill = Math.max(0, Math.min(1, f));
    this.atmosphere.setCrowdFill(this.crowdReactive ? this.crowdFill : 1);
  }

  setCrowdDensity(f: number): void {
    this.crowd.setDensity(f);
    this.pushCrowdFill(f);
  }
  setCrowdPreset(p: CrowdPreset): void {
    this.crowd.setPreset(p);
    this.pushCrowdFill(PRESET_FILL[p] ?? 1);
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
  setStairsVisible(b: boolean): void {
    this.banners.setStairsVisible(b);
  }
  setFlagsVisible(b: boolean): void {
    this.banners.setFlagsVisible(b);
  }

  // ---- effects (Phase 5) ----
  setFloodlights(b: boolean): void {
    this.effects.setFloodlights(b);
    // The contactor. Stadium lights are one of the few things on this panel
    // that everybody has heard as well as seen.
    this.atmosphere.floodlights(b);
  }

  /**
   * What the built scene actually contains.
   *
   * A screenshot cannot tell you that the floodlight group exists but is empty,
   * or that a facade was requested and produced nothing: both look exactly like
   * a dark night. This can, which is what scripts/matchday-shots.mts checks
   * before anyone squints at a picture.
   */
  sceneCensus(): { meshes: number; spotLights: number; lamps: number; instances: number } {
    let meshes = 0;
    let spotLights = 0;
    let lamps = 0;
    let instances = 0;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
      if ((o as THREE.SpotLight).isSpotLight) spotLights++;
      if (!m.isMesh) return;
      meshes++;
      if (m.isInstancedMesh) instances += m.count ?? 0;
      const mat = m.material as THREE.MeshStandardMaterial | undefined;
      if (mat && 'emissiveIntensity' in mat && (mat.emissiveIntensity ?? 0) >= 1) lamps++;
    });
    return { meshes, spotLights, lamps, instances };
  }

  // ---- sound (see ./atmosphere.ts) ----
  /** Must be called from a user gesture the first time, or the browser refuses. */
  async setSound(on: boolean): Promise<void> {
    await this.atmosphere.setEnabled(on);
    if (on) {
      // Catch the rig up on everything it missed while it was off: the ground
      // may have been emptied and the weather changed three times before
      // anybody turned the sound on.
      this.atmosphere.setCrowdFill(this.crowdFill);
      this.atmosphere.setWeatherBed(this.weatherSound ? this.weatherNow : 'clear');
    }
  }
  soundOn(): boolean { return this.atmosphere.isEnabled(); }
  setSoundLevel(b: 'master' | SoundBus, v: number): void { this.atmosphere.setLevel(b, v); }
  soundLevels(): SoundLevels { return this.atmosphere.getLevels(); }
  setSoundMuted(m: boolean): void { this.atmosphere.setMuted(m); }
  soundMuted(): boolean { return this.atmosphere.isMuted(); }
  setDrum(on: boolean): void { this.atmosphere.setDrum(on); }
  drumOn(): boolean { return this.atmosphere.isDrumming(); }

  /**
   * Whether the crowd's level follows how full the ground is.
   *
   * On by default, because an empty stadium that roars like a sell-out is the
   * audio version of painting a crowd onto empty seats. Off for anyone who
   * wants the soundtrack regardless of what the bowl is showing.
   */
  setCrowdReactive(b: boolean): void {
    this.crowdReactive = b;
    // Through pushCrowdFill, which is the one place that knows the flag means
    // "send 1 instead of the real fill". Setting the fill directly here made
    // the checkbox one-way: it could quieten an empty ground and never bring
    // it back.
    this.pushCrowdFill(this.crowdFill);
  }
  crowdReactiveOn(): boolean { return this.crowdReactive; }
  /** Whether rain and wind are audible. */
  setWeatherSound(b: boolean): void {
    this.weatherSound = b;
    this.atmosphere.setWeatherBed(b ? this.weatherNow : 'clear');
  }
  weatherSoundOn(): boolean { return this.weatherSound; }

  /** For the overlay's "try it" buttons, and for anything that wants a cheer. */
  roar(strength = 1): void { this.atmosphere.roar(strength); }
  whistle(long = false): void { this.atmosphere.whistle(long); }
  applause(strength = 1): void { this.atmosphere.applause(strength); }
  chant(): void { this.atmosphere.chant(); }
  airhorn(): void { this.atmosphere.airhorn(); }

  /** Phone-flash twinkle across the stands. Starts off; see the constructor. */
  setSparkles(b: boolean): void {
    this.sparkles.object.visible = b;
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
    this.weatherNow = w;
    this.atmosphere.setWeatherBed(this.weatherSound ? w : 'clear');
  }
  setExposure(v: number): void {
    this.renderer.toneMappingExposure = v;
  }
  setSunIntensity(v: number): void {
    this.sun.intensity = v;
  }
  /** Wet-look pitch: drop the turf roughness so the sun + floodlights glint off it. */
  setWetPitch(on: boolean): void {
    if (!this.pitchMat) return;
    this.pitchMat.roughness = on ? 0.1 : 0.92;
    this.pitchMat.metalness = on ? 0.5 : 0;
    this.pitchMat.color.set(on ? 0x123018 : 0x1f7a3a);
    this.pitchMat.needsUpdate = true;
    this.pitchside.setWet(on); // the visible mown-stripe layer must go glossy too
    dbg('setWetPitch', on, '-> pitch roughness', this.pitchMat.roughness, 'metalness', this.pitchMat.metalness);
  }

  /** Capture the current frame as a PNG data URL (Wave G — poster export). */
  snapshot(): string {
    this.effects.render(this.renderer, this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  private recording = false;
  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Record the auto-choreography reveal off the live canvas as a shareable WebM,
   * with the tifomaker.org watermark burned into every frame (so the clip is an
   * ad for the site wherever it's posted). Returns null if the browser can't
   * record. `onTick` reports remaining whole seconds for a countdown UI.
   *
   * The clip is sized to a BYTE BUDGET, not to a bitrate someone once picked.
   * It used to ask for a flat 8 Mbps, which is not a quality setting so much as
   * a multiplication: nine seconds at 8 Mbps is nine megabytes, every time,
   * whatever the clip contained. Past about 5 MB a video stops going through
   * WhatsApp and Telegram without being re-encoded by them — which costs far
   * more picture than encoding it properly ourselves would.
   *
   * Resolution is never what gives way. See the fps note below for what does.
   */
  async recordReveal(
    opts: { seconds?: number; fps?: number; height?: number; maxBytes?: number } = {},
    onTick?: (remaining: number) => void,
  ): Promise<RecordedClip | null> {
    if (this.recording) return null;
    if (typeof MediaRecorder === 'undefined' || typeof this.canvas.captureStream !== 'function') return null;
    this.recording = true;
    const seconds = Math.max(1, Math.round(opts.seconds ?? 9));
    // Everything about the clip's weight is decided here, in one pure function
    // that a test can call without a browser. See ./recordPlan.ts.
    const plan = recordingPlan({ seconds, fps: opts.fps, maxBytes: opts.maxBytes });
    const fps = plan.fps;
    const srcW = this.canvas.width;
    const srcH = this.canvas.height;
    const outH = Math.min(opts.height ?? srcH, srcH); // never upscale past the canvas
    const scale = srcH > 0 ? outH / srcH : 1;
    const w = Math.max(2, Math.round(srcW * scale));
    const h = Math.max(2, Math.round(srcH * scale));
    const comp = document.createElement('canvas');
    comp.width = w;
    comp.height = h;
    const ctx = comp.getContext('2d')!;
    const fs = Math.max(14, Math.round(h * 0.026));
    let raf = 0;
    const drawFrame = (): void => {
      ctx.drawImage(this.canvas, 0, 0, w, h);
      const txt = 'tifomaker.org';
      ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
      const tw = ctx.measureText(txt).width;
      const pad = Math.round(fs * 0.5);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(w - tw - pad * 3, h - fs - pad * 2, tw + pad * 2, fs + pad);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(txt, w - tw - pad * 2, h - Math.round(pad * 1.5));
      raf = requestAnimationFrame(drawFrame);
    };
    drawFrame();
    const stream = comp.captureStream(fps);
    /**
     * The crowd goes in the file.
     *
     * Every clip this has ever produced was silent: `captureStream` on a canvas
     * carries one video track and nothing else, so the thing people actually
     * post — the reveal, the pyro, the roar — arrived with no roar. The
     * atmosphere's own limiter is tapped into a MediaStreamDestination and its
     * track is added here.
     *
     * Only when the sound is actually on. A suspended AudioContext produces a
     * track that never delivers a buffer, and a recorder waiting on one can sit
     * there producing nothing at all.
     */
    let audioTracks: MediaStreamTrack[] = [];
    if (this.atmosphere.isEnabled()) {
      const mix = this.atmosphere.captureStream();
      audioTracks = mix ? mix.getAudioTracks() : [];
      for (const track of audioTracks) stream.addTrack(track);
    }
    // MP4 with H.264 where the browser has it, because that is what "a video"
    // means outside a browser — see pickRecordingFormat for the order and why
    // it names the codec rather than trusting video/mp4.
    const asked = pickRecordingFormat(undefined, audioTracks.length > 0);
    if (!asked) {
      cancelAnimationFrame(raf);
      this.recording = false;
      return null;
    }
    const recorder = new MediaRecorder(stream, { mimeType: asked.mimeType, videoBitsPerSecond: plan.bitsPerSecond });
    // What it actually negotiated — read at the END, not here. Chromium leaves
    // `mimeType` as whatever it was asked for until recording has actually
    // started, so reading it at construction reports `video/mp4` with no codec
    // and the clip looks like it might not be H.264 when it is.
    let format = asked as RecordingFormat;
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e): void => {
      if (e.data.size) chunks.push(e.data);
    };
    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = (): void => {
        format = describeRecording(recorder.mimeType, asked);
        resolve(new Blob(chunks, { type: format.mimeType }));
      };
    });
    recorder.start();
    this.playAutoChoreo();
    for (let s = seconds; s > 0; s--) {
      onTick?.(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    recorder.stop();
    cancelAnimationFrame(raf);
    const blob = await finished;
    // Detach, never stop: these tracks belong to the atmosphere's live output.
    // `track.stop()` here would end them for good and leave every later
    // recording — and the speakers — silent.
    for (const track of audioTracks) stream.removeTrack(track);
    this.recording = false;
    return { blob, ...format };
  }

  setSmoke(b: boolean, color?: THREE.ColorRepresentation): void {
    this.effects.setSmoke(b, color);
  }
  burstConfetti(): void {
    this.effects.burstConfetti();
    this.atmosphere.confetti();
    // Paper goes up because something happened, and a crowd that watches it in
    // silence is the wrong crowd.
    this.atmosphere.applause(0.8);
  }
  burstPyro(): void {
    this.effects.burstPyro();
    this.atmosphere.pyro();
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

  /** Centroid + extent of a whole stand (0 E,1 N,2 W,3 S), for sizing banners to it. */
  private standExtent(stand: 0 | 1 | 2 | 3): {
    cx: number; cy: number; cz: number; width: number; height: number; rotationY: number; frontY: number; frontX: number; frontZ: number; dx: number; dz: number;
  } {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minR = Infinity;
    for (let i = 0; i < this.map.count; i++) {
      if (Math.floor(((this.map.uv[i * 2] + 0.125) % 1) * 4) !== stand) continue;
      const x = this.map.pos3[i * 3];
      const y = this.map.pos3[i * 3 + 1];
      const z = this.map.pos3[i * 3 + 2];
      sx += x;
      sy += y;
      sz += z;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const r = Math.hypot(x, z);
      if (r < minR) minR = r;
    }
    if (n === 0) return { cx: 0, cy: 12, cz: -60, width: 30, height: 16, rotationY: 0, frontY: 2, frontX: 0, frontZ: -60, dx: 0, dz: 1 };
    const cx = sx / n;
    const cy = sy / n;
    const cz = sz / n;
    const len = Math.hypot(cx, cz) || 1;
    const ang = Math.atan2(cz, cx);
    const fr = isFinite(minR) ? minR : len;
    return {
      cx,
      cy,
      cz,
      width: Math.hypot(maxX - minX, maxZ - minZ),
      height: maxY - minY,
      rotationY: Math.atan2(-cx, -cz),
      frontY: minY,
      frontX: Math.cos(ang) * fr,
      frontZ: Math.sin(ang) * fr,
      dx: -cx / len,
      dz: -cz / len,
    };
  }

  /** Resolve editor-placed banners (they carry a `place` hint + stand anchor) to
   * real 3D transforms with the same math as the add* helpers. Idempotent. */
  private resolveEditorBanners(): void {
    for (const a of this.assetStore.list()) {
      if (!a.place) continue;
      if (a.place === 'floor') {
        this.assetStore.update(a.id, { position: { x: 0, y: 0.05, z: 0 }, rotationY: 0, scale: { x: 26, y: 14, z: 1 } });
        continue;
      }
      const stand = (a.anchor?.stand ?? 1) as 0 | 1 | 2 | 3;
      const e = this.standExtent(stand);
      if (a.place === 'surface') {
        const an = this.standAnchor(stand);
        this.assetStore.update(a.id, { position: { x: an.position.x, y: Math.max(8, an.position.y - 6), z: an.position.z }, rotationY: an.rotationY, scale: { x: 44, y: 26, z: 1 } });
      } else if (a.place === 'big') {
        this.assetStore.update(a.id, { position: { x: e.cx + e.dx * 5, y: Math.max(6, e.cy), z: e.cz + e.dz * 5 }, rotationY: e.rotationY, scale: { x: Math.max(10, e.width * 0.7), y: Math.max(8, e.height * 0.85), z: 1 } });
      } else if (a.place === 'small') {
        const wallH = Math.max(3, e.frontY + 1);
        this.assetStore.update(a.id, { position: { x: e.frontX + e.dx * 1.5, y: wallH / 2, z: e.frontZ + e.dz * 1.5 }, rotationY: e.rotationY, scale: { x: Math.max(12, e.width * 0.8), y: wallH, z: 1 } });
      } else if (a.place === 'gap') {
        this.assetStore.update(a.id, { position: { x: e.cx + e.dx * 4, y: Math.max(4, e.cy), z: e.cz + e.dz * 4 }, rotationY: e.rotationY, scale: { x: Math.max(12, e.width * 0.85), y: 4, z: 1 } });
      } else if (a.place === 'stairs') {
        this.assetStore.update(a.id, { position: { x: e.cx + e.dx * 4, y: Math.max(6, e.cy), z: e.cz + e.dz * 4 }, rotationY: e.rotationY, scale: { x: 5, y: Math.max(10, e.height * 0.8), z: 1 } });
      }
    }
  }

  /** Big 3D banner draping the stand's seating. */
  addBanner(stand: 0 | 1 | 2 | 3 = 1): void {
    const e = this.standExtent(stand);
    this.assetStore.add('banner', {
      position: { x: e.cx + e.dx * 5, y: Math.max(6, e.cy), z: e.cz + e.dz * 5 },
      rotationY: e.rotationY,
      scale: { x: Math.max(10, e.width * 0.7), y: Math.max(8, e.height * 0.85), z: 1 },
    });
  }
  /** Small banner covering the dark front-wall / infrastructure of a stand. */
  addSmallBanner(stand: 0 | 1 | 2 | 3 = 1): void {
    const e = this.standExtent(stand);
    // Hug the dark front wall: the stand's front edge (inner radius), from pitch
    // level up to the first row of seats — not floating over the seating.
    const wallH = Math.max(3, e.frontY + 1);
    this.assetStore.add('banner', {
      position: { x: e.frontX + e.dx * 1.5, y: wallH / 2, z: e.frontZ + e.dz * 1.5 },
      rotationY: e.rotationY,
      scale: { x: Math.max(12, e.width * 0.8), y: wallH, z: 1 },
    });
  }
  addTextBanner(text: string, stand: 0 | 1 | 2 | 3 = 1): void {
    const e = this.standExtent(stand);
    this.assetStore.add('banner', {
      position: { x: e.cx + e.dx * 5, y: Math.max(4, e.cy * 0.85), z: e.cz + e.dz * 5 },
      rotationY: e.rotationY,
      scale: { x: Math.max(12, e.width * 0.7), y: 4, z: 1 },
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
  setSelectedX(x: number): void {
    const s = this.assetStore.selected;
    if (s) this.assetStore.update(s.id, { position: { x, y: s.position.y, z: s.position.z } });
  }
  setSelectedZ(z: number): void {
    const s = this.assetStore.selected;
    if (s) this.assetStore.update(s.id, { position: { x: s.position.x, y: s.position.y, z } });
  }
  setSelectedRot(deg: number): void {
    const s = this.assetStore.selected;
    if (s) this.assetStore.update(s.id, { rotationY: (deg * Math.PI) / 180 });
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
    dbg('projectImageToMosaic painted', dirty.length, 'seats from camera');
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

  // ---- banners (the fourth view's output, hanging in the bowl) ----
  private readonly bannerStore: BannerStore | null = null;
  private bannerRigs: BannerRigLayer | null = null;
  private placement: PlacementHelper | null = null;
  private bannerDrag = true;
  private draggingBanner = false;
  private dragStartedAt = 0;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private setNdc(ev: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this.ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  private bindBannerPointer(): void {
    this.canvas.addEventListener('pointerdown', this.onBannerDown);
    this.canvas.addEventListener('pointermove', this.onBannerMove);
    this.canvas.addEventListener('pointerup', this.onBannerUp);
    this.canvas.addEventListener('pointercancel', this.onBannerUp);
  }

  /**
   * Press on a banner to take hold of it.
   *
   * There is no "move banners" mode to turn on, because a mode is a thing to
   * forget you are in. Pressing ON a banner drags the banner; pressing
   * anywhere else orbits the camera, which is what pressing anywhere else has
   * always done. The camera is only given up for as long as the finger is on
   * the fabric.
   */
  private readonly onBannerDown = (ev: PointerEvent): void => {
    if (!this.bannerRigs || !this.placement || !this.bannerDrag || ev.button !== 0) return;
    this.setNdc(ev);
    const id = this.bannerRigs.pick(this.ray);
    if (!id) return;
    this.bannerRigs.select(id);
    this.bannerStore?.setActive(id);
    this.onBannerSelect?.(id);
    if (!this.placement.begin(id, this.ray)) return;
    this.bannerStore?.begin();
    this.draggingBanner = true;
    this.dragStartedAt = this.elapsed;
    this.controls.enabled = false;
    try {
      this.canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* some engines refuse capture on a canvas that already has one */
    }
    ev.preventDefault();
  };

  private readonly onBannerMove = (ev: PointerEvent): void => {
    if (!this.draggingBanner || !this.placement || !this.bannerStore) return;
    this.setNdc(ev);
    const res = this.placement.move(this.ray, this.camera, this.canvas.clientHeight || 900);
    if (!res) return;
    const a = this.bannerStore.active;
    if (!a) return;
    // A banner moves a block at a time. Dragging it is choosing blocks, not
    // sliding it along a rail, so the drag lands on whichever block the
    // pointer is over and the banner goes there whole — which is the point of
    // blocks, and is why it can never end up straddling an aisle with a
    // corner hanging off the end of the stand.
    const f = this.placement.frameFor(a.slot.stand, a.slot.stands);
    const span = Math.max(1, Math.min(f.blocks.length, a.slot.blockSpan));
    let hit = 0;
    for (let i = 0; i < f.blocks.length; i++) {
      if (res.alongU >= f.blocks[i].u0 && res.alongU <= f.blocks[i].u1) { hit = i; break; }
      if (res.alongU > f.blocks[i].u1) hit = Math.min(f.blocks.length - 1, i + 1);
    }
    const from = Math.max(0, Math.min(f.blocks.length - span, hit - Math.floor((span - 1) / 2)));
    if (from !== a.slot.blockFrom) this.bannerStore.patchSlot({ blockFrom: from });
    this.onBannerSnap?.(['block']);
  };

  private readonly onBannerUp = (ev: PointerEvent): void => {
    if (!this.draggingBanner) return;
    this.draggingBanner = false;
    this.placement?.end();
    this.bannerStore?.commit();
    this.controls.enabled = true;
    this.onBannerSnap?.([]);
    try {
      this.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
    // A press that never moved is a selection, not a move, and it should not
    // leave an empty entry on the undo stack. `commit()` already drops a
    // gesture that changed nothing, so this only guards the toast.
    if (this.elapsed - this.dragStartedAt < 0.12) this.onBannerSnap?.([]);
  };

  /** Told which banner the user grabbed, so the panel can follow. */
  onBannerSelect: ((id: string) => void) | null = null;
  /** Told which guides are lit, so the panel can name the snap. */
  onBannerSnap: ((keys: string[]) => void) | null = null;

  /** Let the overlay turn dragging off (e.g. while recording). */
  setBannerDrag(on: boolean): void {
    this.bannerDrag = on;
  }
  /** Replay one banner's reveal, or every banner's. */
  playBannerReveal(id?: string): void {
    this.bannerRigs?.play(id);
  }
  /** Park a banner part-way through its reveal, for scrubbing. */
  setBannerProgress(id: string, p: number): void {
    this.bannerRigs?.setProgress(id, p);
  }
  /** Where a banner has got to in its reveal, for a scrub bar that follows it. */
  bannerRevealState(id: string): { progress: number; playing: boolean } | null {
    return this.bannerRigs?.revealState(id) ?? null;
  }
  selectBanner(id: string | null): void {
    this.bannerRigs?.select(id);
  }
  /** What the banner layer actually contains. A screenshot cannot say this. */
  bannerCensus(): { banners: number; ropes: number; nets: number; bars: number; poles: number; particles: number } {
    return this.bannerRigs?.census() ?? { banners: 0, ropes: 0, nets: 0, bars: 0, poles: 0, particles: 0 };
  }

  /**
   * Run the cloth forward without drawing, so a still is a settled still.
   *
   * A screenshot taken the instant a banner is placed catches it mid-fall.
   * The shot harness and the reveal-progress scrub both want the shape the
   * fabric ends up in, which is a few seconds of solver away.
   */
  settleBanners(seconds = 2.5): void {
    this.bannerRigs?.settle(seconds);
  }

  /**
   * Deepest a banner is inside the terracing right now, in metres.
   *
   * This is the number the whole rewrite exists to drive to zero, and it is
   * measured against the same heightfield the solver collides with, so it
   * cannot flatter itself.
   */
  worstBannerPenetration(): number {
    return this.bannerRigs?.worstPenetration() ?? 0;
  }

  /** How far a banner has dipped below whatever is holding it up, in metres. */
  worstBannerSag(): number {
    return this.bannerRigs?.worstSag() ?? 0;
  }

  /** The world box a banner's fabric occupies once the solver has settled. */
  bannerBounds(id: string): { min: [number, number, number]; max: [number, number, number] } | null {
    return this.bannerRigs?.bounds(id) ?? null;
  }
  /**
   * Put the camera where the banner is aimed.
   *
   * A banner is made to be read from the opposite side of the ground, so this
   * stands off along the stand's own outward normal at a distance set by the
   * banner's width — far enough to take the whole sheet in, which is the only
   * view from which a tifo makes sense. It is also what the shot harness uses,
   * so a screenshot is framed by the product's own idea of where to look from
   * rather than by a constant that goes stale the moment a bowl changes shape.
   */
  focusBanner(id: string, elevationDeg?: number): boolean {
    const doc = this.bannerStore?.get(id);
    if (!doc || !this.placement) return false;
    const shot = bannerShot(doc, this.placement.frameFor(doc.slot.stand, doc.slot.stands), { elevationDeg, aspect: this.camera.aspect });
    if (!shot) return false;
    // Whatever glide was under way is over. Opening the simulator starts one
    // towards the default camera, and it carried on for most of a second after
    // this had pointed the camera at the banner — so the banner was framed,
    // and then quietly un-framed, before anyone saw it.
    this.camTween = null;
    this.flyActive = false;
    applyCameraShot(this.camera, this.controls, { name: 'Banner', ...shot });
    return true;
  }

  /**
   * How many blocks and tiers a stand has.
   *
   * The overlay's pickers are built from this, so they offer exactly the
   * places that exist on this ground rather than a fixed list that is wrong
   * on most of them.
   */
  standSlots(stand: StandIndex, bannerId?: string, stands = 1): {
    blocks: number; tiers: number; maxSpan: number; tierOptions: number[];
  } {
    const f = this.placement?.frameFor(((stand % 4) + 4) % 4 as StandIndex, stands);
    if (!f || !f.ok) return { blocks: 1, tiers: 1, maxSpan: 1, tierOptions: [0] };
    const doc = bannerId ? this.bannerStore?.get(bannerId) : this.bannerStore?.active;
    // A flown banner can only use a tier whose fascia band is deep enough to
    // hang anything in; a banner on the terracing can use any of them.
    const all = f.tiers.map((_, i) => i);
    return {
      blocks: f.blocks.length,
      tiers: f.tiers.length,
      maxSpan: doc ? maxUsefulSpan(doc, f) : f.blocks.length,
      tierOptions: doc?.kind === 'hanging' ? hangableTiers(f) : all,
    };
  }

  /** A stand's real size in metres, for sizing a banner to it. */
  standSizeM(stand: StandIndex): { width: number; height: number } | null {
    const f = this.placement?.frameFor(stand);
    return f && f.ok ? { width: f.widthM, height: f.heightM } : null;
  }

  // ---- choreography reveal (Phase 7) ----
  private autoReveal: RevealMode = 'wipe-lr';
  /** Reveal style the auto-choreography uses (kept in sync with the panel). */
  setAutoReveal(mode: RevealMode): void {
    this.autoReveal = mode;
  }
  playReveal(mode: RevealMode, durationMs = 4500): void {
    this.timeline = null;
    this.reveal = { mode, start: this.elapsed, dur: Math.max(0.5, durationMs / 1000) };
  }

  // ---- choreography timeline (Wave C) ----
  playTimeline(tl: Timeline, loop = false): void {
    this.reveal = null;
    this.flyActive = false;
    this.camTween = null;
    this.controls.enabled = true;
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
    // Stopping a show should leave the tifo up, not half-unrolled: the state
    // people want to look at afterwards is the finished one.
    for (const b of this.bannerStore?.list() ?? []) this.bannerRigs?.setProgress(b.id, 1);
  }
  /** A ready-made show: broadcast view -> tifo wipes in -> smoke -> ultra view -> pyro -> confetti -> drone. */
  buildAutoChoreo(): Timeline {
    const cues: Cue[] = [
      { kind: 'camera', start: 0, shot: 'TV Broadcast' },
      // The referee's whistle opens it. Before this the show started on a drum
      // with no reason for the drum to have started.
      { kind: 'effect', start: 0, effect: 'whistle-long' },
      // The drum starts before anything is visible — that is the order it
      // happens in, and it is what makes the reveal feel like it was waited for.
      { kind: 'effect', start: 0, effect: 'drum-on' },
      // And the stand answers it, over the drum, while the cards go up.
      { kind: 'effect', start: 1.4, effect: 'chant' },
      { kind: 'reveal', start: 0.5, dur: 4, mode: this.autoReveal },
      // Timed to the END of the reveal, not the start. The crowd roars at the
      // finished tifo; a roar on the first row of cards is a crowd cheering at
      // nothing.
      { kind: 'effect', start: 4.2, effect: 'roar' },
      { kind: 'effect', start: 5, effect: 'smoke-on' },
      { kind: 'camera', start: 5.5, shot: 'Ultra View' },
      { kind: 'effect', start: 7.2, effect: 'airhorn' },
      { kind: 'effect', start: 7.5, effect: 'pyro' },
      { kind: 'effect', start: 8.5, effect: 'confetti' },
      { kind: 'effect', start: 8.6, effect: 'roar' },
      { kind: 'camera', start: 11, shot: 'Drone' },
      // The roar has four and a half seconds of tail; applause underneath it is
      // how a crowd actually comes down off one, rather than stopping dead.
      { kind: 'effect', start: 11.4, effect: 'applause' },
      { kind: 'effect', start: 13.5, effect: 'drum-off' },
    ];
    // Where each banner belongs in the show, from how it is actually rigged.
    //
    // A roof-hung banner is put up by rope technicians before anyone is in the
    // ground, so on the show's clock it is simply there first. A drop banner
    // is released on the whistle. A rope lift rises WITH the cards — that is
    // the whole point of an Aufziehfahne, the crowd behind it still has their
    // hands free. And a crowd pass starts a beat later, because it has to
    // travel the length of the block over people's heads.
    for (const b of this.bannerStore?.list() ?? []) {
      if (b.visible === false) continue;
      const dur = Math.max(0.4, b.revealMs / 1000);
      // A sheet flown from the roof is rigged before anyone is in the ground,
      // so on the show's clock it is simply there first. One rolled over the
      // terracing is paid out by the crowd on the whistle, a beat later.
      const start = b.kind === 'hanging' ? 0 : 0.5;
      cues.push({ kind: 'banner', start, dur, bannerId: b.id });
    }
    return { duration: 15, cues };
  }
  playAutoChoreo(): void {
    for (const a of this.assetStore.list()) if (a.type === 'surface') this.assetLayer.unfurl(a.id, 3000);
    // Take every banner back to nothing before the clock starts, or a show
    // replayed twice opens with the tifo already up.
    for (const b of this.bannerStore?.list() ?? []) this.bannerRigs?.setProgress(b.id, 0);
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
    for (const id of Object.keys(st.bannerProgress)) {
      this.bannerRigs?.setProgress(id, st.bannerProgress[id]);
    }
    for (const e of st.firedEffects) {
      // Through the wrappers, not straight at `this.effects` — the wrappers are
      // where the sound of each of these lives, and a cue that fires the
      // particles without the noise is the bug this whole pass is about.
      if (e === 'confetti') this.burstConfetti();
      else if (e === 'pyro') this.burstPyro();
      else if (e === 'smoke-on') this.effects.setSmoke(true);
      else if (e === 'smoke-off') this.effects.setSmoke(false);
      else if (e === 'floods-on') this.setFloodlights(true);
      else if (e === 'floods-off') this.setFloodlights(false);
      else if (e === 'roar') this.atmosphere.roar(1);
      else if (e === 'whistle') this.atmosphere.whistle(false);
      else if (e === 'whistle-long') this.atmosphere.whistle(true);
      else if (e === 'applause') this.atmosphere.applause(1);
      else if (e === 'chant') this.atmosphere.chant();
      else if (e === 'airhorn') this.atmosphere.airhorn();
      else if (e === 'drum-on') this.atmosphere.setDrum(true);
      else if (e === 'drum-off') this.atmosphere.setDrum(false);
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

  // ---- performance governor -------------------------------------------
  private fpsT = 0;
  private fpsN = 0;
  private visBound = false;
  /** Pause the loop while the tab is hidden (saves battery / heat). */
  private readonly onVisibility = (): void => {
    // The renderer already stopped here; the AudioContext did not, so until now
    // switching tabs left a stadium roaring out of a tab nobody was looking at.
    this.atmosphere.setSuspended(document.hidden);
    if (document.hidden) this.stop();
    else if (!this.disposed) this.start();
  };

  private readonly onContextLost?: () => void;
  /**
   * The GPU took the context back.
   *
   * preventDefault keeps it restorable, and stopping the loop is not optional:
   * every subsequent draw call on a lost context is a no-op that still costs a
   * frame. Recovery is a rebuild, not a resume — every buffer, texture and
   * program died with the context — so the owner is told and decides.
   */
  private readonly onCtxLost = (e: Event): void => {
    e.preventDefault();
    this.running = false;
    this.onContextLost?.();
  };

  /** Hold a smooth frame rate by trimming/raising pixel ratio (no rebuild). */
  private adaptPerf(dt: number): void {
    if (this.elapsed < 2.5) return; // let the scene settle before judging
    this.fpsT += dt;
    this.fpsN++;
    if (this.fpsT < 1.2) return;
    const fps = this.fpsN / this.fpsT;
    this.fpsT = 0;
    this.fpsN = 0;
    const cur = this.renderer.getPixelRatio();
    const cap = Math.min(this.settings.maxPixelRatio, window.devicePixelRatio || 1);
    if (fps < 45 && cur > 0.75) {
      this.renderer.setPixelRatio(Math.max(0.75, cur - 0.2));
      this.resize();
      dbg('adaptPerf low fps=' + Math.round(fps) + ' -> pr=' + this.renderer.getPixelRatio().toFixed(2));
    } else if (fps > 58 && cur < cap - 0.01) {
      this.renderer.setPixelRatio(Math.min(cap, cur + 0.2));
      this.resize();
      dbg('adaptPerf recover fps=' + Math.round(fps) + ' -> pr=' + this.renderer.getPixelRatio().toFixed(2));
    }
  }

  start(): void {
    if (this.running || this.disposed) return;
    if (!this.visBound) {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.visBound = true;
    }
    this.running = true;
    this.resize();
    this.clock.start();
    const loop = (): void => {
      if (!this.running) return;
      const dt = this.clock.getDelta();
      this.elapsed += dt;
      if (this.flyActive) {
      if (this.template.id === 'community-kingdom-arena-28k') {
        const { ax, bz, ty } = this.seatBounds();
        const a = ((this.elapsed % 22) / 22) * Math.PI * 2;
        applyCameraShot(this.camera, this.controls, { name: 'Flyover', position: [Math.cos(a) * ax * 0.95, ty + 8, Math.sin(a) * bz * 0.95], target: [0, 1, 0], fov: 60 });
      } else {
        applyCameraShot(this.camera, this.controls, flyover(this.elapsed, this.seatBounds()));
      }
    }
      this.banners.update(this.elapsed);
      this.assetLayer.update(this.elapsed);
      this.bannerRigs?.update(this.elapsed, dt);
      this.effects.update(dt);
      this.surroundings.update(dt);
      if (this.sparkles.object.visible) this.sparkles.update(dt);
      this.weather.update(dt);
      if (this.reveal) this.stepReveal();
      if (this.timeline) this.stepTimeline();
      if (this.camTween) this.stepCamTween();
      this.controls.update();
      this.adaptPerf(dt);
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
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onCtxLost);
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
    this.track.dispose();
    this.banners.dispose();
    this.bannerRigs?.dispose();
    this.placement?.dispose();
    this.canvas.removeEventListener('pointerdown', this.onBannerDown);
    this.canvas.removeEventListener('pointermove', this.onBannerMove);
    this.canvas.removeEventListener('pointerup', this.onBannerUp);
    this.effects.dispose();
    this.atmosphere.dispose();
    this.assetLayer.dispose();
    this.weather.dispose();
    this.surroundings.dispose();
    this.sparkles.dispose();
    for (const d of this.disposables) d.dispose();
    this.skyTex.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
