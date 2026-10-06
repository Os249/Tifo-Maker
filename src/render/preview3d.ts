import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { SeatMap, StadiumTemplate } from '../core/types';
import type { DesignStore } from '../core/design';
import type { BannerStore, StandIndex } from '../core/banner';
import { noTifoMask } from '../core/venueDetails';
import { buildBannerRigs, type BannerRigLayer } from './simulator/bannerRig';
import { spanFrameCache, type StandFrame } from './simulator/standFrame';
import { bannerShot } from './simulator/bannerCamera';
import { standIsRoofed } from './simulator/roof';
import { emptySeatColours } from './seatColours';
import { buildChairs, seatFacing, seatStateTexture, KEY_LIGHT_DIR, type ChairBuild } from './seatChairs';
import { viewTierSettings, type ViewTier, type ViewTierSettings } from './viewTier';
import type { ShellBuild } from './stadiumShell';

/**
 * The Stadium view: the design in the real stadium.
 *
 * What is on screen, from the ground up:
 *
 *   - the building (render/stadiumShell.ts): the ground's own stands, roofs,
 *     facade, floodlights, screens and pitch, from the same builders Match Day
 *     uses, merged into a few dozen draw calls. It streams in a moment after
 *     the view opens, so the view itself opens at once;
 *   - a chair on every seat in the ground's real seat colour
 *     (render/seatChairs.ts, render/seatColours.ts);
 *   - a card held up above every seat the tifo paints, in the design's colour,
 *     straight from the SAME DesignStore.cells the 2D editor paints into —
 *     there is no sync step, the store's dirty callback recolours them.
 *
 * A seat the tifo leaves empty shows its chair, as it would at the ground.
 *
 * It renders only when something changes — the camera, the design, the size,
 * a banner waving — never in an idle loop, so an open Stadium view costs a
 * still picture's worth of battery. While the camera moves it renders at a
 * lower pixel ratio on the tiers that need it, and sharpens when it stops.
 *
 * Camera presets matter more than free orbit: tifos are designed for specific
 * angles (above all the TV gantry), so presets ship first-class, fitted to
 * each ground's own size, and orbit is the exploration extra.
 */

export interface CameraPreset {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * The presets by name, at the size of the default bowl. The Stadium view fits
 * each one to the ground it is showing (Preview3D.applyPreset), so a 7,000-seat
 * ground and an 83,000-seat one are both framed, and no camera ever sits inside
 * a stand; these are what the menus list and what Match Day starts from.
 */
export const CAMERA_PRESETS: CameraPreset[] = [
  { name: 'TV gantry', position: [0, 34, -100], target: [0, 10, 25] },
  { name: 'Behind goal', position: [100, 7, 0], target: [-45, 14, 0] },
  { name: 'Pitch level', position: [40, 1.8, 26], target: [-60, 16, -48] },
  { name: 'Aerial', position: [0, 175, 95], target: [0, 0, 0] },
  // Centred high aerial pulled far enough back to frame the ENTIRE bowl/tifo at
  // once (same angle as Aerial, ~40% further out) — the "show me the whole
  // thing" preset.
  { name: 'Full view', position: [0, 245, 135], target: [0, 0, 0] },
];

const NO_SHOW_RATE = 0.1;
/** Where a held card sits: in front of its chair, at the chest of the person standing at it. */
const CARD_UP = 1.22;
const CARD_FORWARD = 0.06;
const CARD_TILT = 0.22;
const FOV = 50;

export interface Preview3DOptions {
  autoRotate?: boolean;
  transparent?: boolean;
  /** The ground. Looked up from the seat map's template id when not given. */
  template?: StadiumTemplate | null;
  /** Force a quality tier (the default is the device's own, see viewTier.ts). */
  quality?: ViewTier;
  /** Leave the building out (cards and chairs only). */
  structure?: boolean;
}

function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#3f6aa6');
  grd.addColorStop(0.55, '#8fb0d6');
  grd.addColorStop(1, '#d7e1ea');
  g.fillStyle = grd;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Preview3D {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly cards: THREE.InstancedMesh;
  private readonly cardShow: THREE.InstancedBufferAttribute;
  /** The same, one byte a seat, for the chairs' shader (a chair under a raised card goes dark). */
  private readonly seatState: THREE.DataTexture;
  private readonly facing: Float32Array;
  private paletteColors: THREE.Color[] = [];
  private readonly noShowMask: Uint8Array;
  private noShowsEnabled = false;
  private noTifo: Uint8Array | null = null;
  /** The empty seats' own colours (sRGB bytes), once the ground is known. */
  private seatRGB: Uint8Array | null = null;
  private template: StadiumTemplate | null;
  private readonly settings: ViewTierSettings;
  private running = false;
  private disposed = false;
  private raf = 0;
  private banners: BannerRigLayer | null = null;
  /** The same frames the panel and Match Day measure, one per stand window. */
  private readonly frameFor: (stand: StandIndex, stands?: number) => StandFrame;
  private bannerStore: BannerStore | null = null;
  private lastFrameAt = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly onDirtyCb: (indices: number[] | 'all') => void;
  private readonly onPaletteCb: () => void;
  private chairs: ChairBuild | null = null;
  private shell: ShellBuild | null = null;
  private placeholder: THREE.Group | null = null;
  private readonly staticTrash: { dispose(): void }[] = [];
  private envTarget: THREE.WebGLRenderTarget | null = null;
  /** Interaction: someone is dragging, so render cheaper until they stop. */
  private interacting = false;
  private moving = false;
  private pixelRatio = 1;
  private movingRatio = 1;
  private slowFrames = 0;
  private fastFrames = 0;
  /** The preset the camera is on, until somebody moves it by hand. */
  private onPreset: string | null = null;
  private readonly fitCache = new Map<string, CameraPreset>();
  private extentCache: { ax: number; bz: number; ty: number } | null = null;
  /** Roofs: shown unless asked otherwise; an indoor hall is cut open when seen from above. */
  private roofsWanted = true;
  private readonly cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private cutOn = false;
  private roofOpacity = 1;
  /** Frames drawn by the loop (the census reads it: an idle view draws none). */
  private framesDrawn = 0;
  private readyResolve!: () => void;
  /** Resolves once the building and the chairs are in (or have failed to come). */
  readonly ready: Promise<void> = new Promise((r) => (this.readyResolve = r));

  constructor(
    private readonly host: HTMLElement,
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    private readonly options: Preview3DOptions = {},
  ) {
    this.settings = viewTierSettings(options.quality);
    this.template = options.template ?? null;
    this.frameFor = spanFrameCache(map);
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.settings.antialias,
      alpha: options.transparent ?? false,
      preserveDrawingBuffer: true, // keep the buffer readable for video/GIF frame capture
      powerPreference: this.settings.tier === 'low' ? 'low-power' : 'high-performance',
    });
    this.pixelRatio = Math.min(this.settings.maxPixelRatio, window.devicePixelRatio || 1);
    this.movingRatio = Math.min(this.pixelRatio, this.settings.movingPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.canvas = this.renderer.domElement;
    this.canvas.addEventListener('webglcontextlost', this.onCtxLost);
    host.appendChild(this.canvas);

    // Transparent hero variant shows the page background through the canvas.
    if (options.transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else {
      const sky = skyTexture();
      this.staticTrash.push(sky);
      this.scene.background = sky;
      // Only the far ground fades: nothing in the stadium is this far away.
      this.scene.fog = new THREE.Fog(0xd7e1ea, 700, 2600);
    }
    // Reflections for the steel and glass on the tiers that can afford them.
    if (this.settings.tier !== 'low') {
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment();
        this.envTarget = pmrem.fromScene(room, 0.04);
        this.scene.environment = this.envTarget.texture;
        this.scene.environmentIntensity = 0.35;
        room.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        pmrem.dispose();
      } catch {
        /* no environment: the lights alone still light it */
      }
    }

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 6000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    // Hero showcase: slow auto-spin, and don't let the page-scroll gesture get
    // hijacked by zoom (disable zoom/pan so the hero never traps the scroll).
    if (options.autoRotate) {
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 0.45;
      this.controls.enableZoom = false;
      this.controls.enablePan = false;
    }
    this.controls.addEventListener('change', this.requestRender);
    this.controls.addEventListener('start', () => {
      this.interacting = true;
      this.onPreset = null;
      this.requestRender();
    });
    this.controls.addEventListener('end', () => {
      this.interacting = false;
      this.requestRender();
    });

    // Deterministic-enough no-show mask; regenerated per session is fine —
    // it is a visualization aid, not design data.
    this.noShowMask = new Uint8Array(map.count);
    for (let i = 0; i < map.count; i++) {
      if (Math.random() < NO_SHOW_RATE) this.noShowMask[i] = 1;
    }

    this.facing = seatFacing(map);
    this.rebuildPalette();
    this.cardShow = new THREE.InstancedBufferAttribute(new Float32Array(map.count), 1);
    this.seatState = seatStateTexture(map.count);
    this.staticTrash.push(this.seatState);
    this.cards = this.buildCards();
    this.scene.add(this.cards);
    this.recolorAll();

    // Light. The building is lit; the cards and chairs are not (their
    // colours must read true), so these only shape the concrete, the roofs
    // and a banner's folds.
    const sky = new THREE.HemisphereLight(0xe4ecf7, 0x5a554c, 1.55);
    this.scene.add(sky);
    const key = new THREE.DirectionalLight(0xfff3e2, 2.1);
    key.position.set(...KEY_LIGHT_DIR);
    this.scene.add(key);
    this.buildPlaceholder();

    this.applyPreset(CAMERA_PRESETS[0]);
    // Hero showcase: a high, pulled-back 3/4 view that always frames the WHOLE
    // bowl as it slowly spins (and stays that, not a preset, when the
    // building arrives).
    if (options.autoRotate) {
      this.onPreset = null;
      this.heroCamera();
    }

    this.onPaletteCb = (): void => {
      if (this.disposed) return;
      this.rebuildPalette();
      this.recolorAll();
    };
    this.onDirtyCb = (indices): void => {
      if (this.disposed) return;
      if (indices === 'all') {
        this.recolorAll();
        return;
      }
      for (const i of indices) this.recolor(i);
      this.flushCards();
    };
    // Palette swaps/edits must rebuild this view's color cache too — otherwise
    // the 3D preview keeps the palette it was built with and drifts from 2D.
    store.onPaletteChange(this.onPaletteCb);
    store.onDirty(this.onDirtyCb);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    if (options.structure === false) this.readyResolve();
    else void this.loadStadium();
  }

  // ---------------------------------------------------------------- the cards

  rebuildPalette(): void {
    this.paletteColors = this.store.palette.map((hex) => new THREE.Color(hex));
  }

  /** Does this seat hold up a card? */
  private cardUp(i: number): boolean {
    if (this.store.cells[i] === 0) return false;
    if (this.noShowsEnabled && this.noShowMask[i]) return false;
    if (this.noTifo && this.noTifo[i]) return false;
    return true;
  }

  private recolor(i: number): void {
    const up = this.cardUp(i);
    this.cardShow.setX(i, up ? 1 : 0);
    (this.seatState.image.data as Uint8Array)[i] = up ? 255 : 0;
    if (up) this.cards.setColorAt(i, this.paletteColors[this.store.cells[i]] ?? this.paletteColors[1] ?? new THREE.Color(0xffffff));
  }

  private flushCards(): void {
    this.cardShow.needsUpdate = true;
    this.seatState.needsUpdate = true;
    if (this.cards.instanceColor) this.cards.instanceColor.needsUpdate = true;
    this.requestRender();
  }

  recolorAll(): void {
    for (let i = 0; i < this.map.count; i++) this.recolor(i);
    this.flushCards();
  }

  /**
   * Apply per-seat reveal visibility (0 = card down, 1 = up/full). A card on
   * its way up fades in from the colour of the seat under it, so a reveal
   * rises out of the stand rather than out of the dark. Pass null to restore
   * the full design. Mirrors Editor.applyReveal so a reveal plays identically
   * in 2D and 3D.
   */
  applyReveal(visibility: ((seat: number) => number) | null): void {
    if (!visibility) {
      this.recolorAll();
      return;
    }
    const tmp = new THREE.Color();
    const seat = new THREE.Color();
    const rgb = this.seatRGB;
    const state = this.seatState.image.data as Uint8Array;
    for (let i = 0; i < this.map.count; i++) {
      if (!this.cardUp(i)) {
        this.cardShow.setX(i, 0);
        state[i] = 0;
        continue;
      }
      const a = visibility(i);
      if (a <= 0.02) {
        this.cardShow.setX(i, 0);
        state[i] = 0;
        continue;
      }
      this.cardShow.setX(i, 1);
      state[i] = 255;
      const full = this.paletteColors[this.store.cells[i]] ?? tmp.set(0xffffff);
      if (a >= 1) {
        this.cards.setColorAt(i, full);
      } else {
        if (rgb) seat.setRGB(rgb[i * 3] / 255, rgb[i * 3 + 1] / 255, rgb[i * 3 + 2] / 255, THREE.SRGBColorSpace);
        else seat.set(0x30343c);
        this.cards.setColorAt(i, seat.lerp(full, a));
      }
    }
    this.flushCards();
  }

  setNoShows(enabled: boolean): void {
    this.noShowsEnabled = enabled;
    this.recolorAll();
  }

  private buildCards(): THREE.InstancedMesh {
    // A held-up card: ~45 × 70 cm, unlit (cards are matte plastic under
    // floodlights — and the design's colours must read exactly as painted).
    const geometry = new THREE.PlaneGeometry(0.45, 0.7);
    geometry.setAttribute('aShow', this.cardShow);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
    // A card that is down is scaled to nothing in the vertex shader: painting
    // a seat flips one float, not a 64-byte matrix.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aShow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed *= aShow;');
    };
    material.customProgramCacheKey = () => 'tifo-cards';
    const mesh = new THREE.InstancedMesh(geometry, material, this.map.count);
    const m = new THREE.Matrix4();
    const P = this.map.pos3;
    const ct = Math.cos(CARD_TILT);
    const st = Math.sin(CARD_TILT);
    for (let i = 0; i < this.map.count; i++) {
      const fx = this.facing[i * 2];
      const fz = this.facing[i * 2 + 1];
      // Columns — x: across the seat; y: up, the top leaning back from the
      // pitch; z: the card's face, towards the pitch and a little up.
      m.set(
        fz, -fx * st, fx * ct, P[i * 3] + fx * CARD_FORWARD,
        0, ct, st, P[i * 3 + 1] + CARD_UP,
        -fx, -fz * st, fz * ct, P[i * 3 + 2] + fz * CARD_FORWARD,
        0, 0, 0, 1,
      );
      mesh.setMatrixAt(i, m);
    }
    mesh.setColorAt(0, new THREE.Color(0xffffff)); // allocates instanceColor
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    this.staticTrash.push(geometry, material);
    return mesh;
  }

  // --------------------------------------------------------- the building

  /** A pitch and its surround, shown until the real building arrives. */
  private buildPlaceholder(): void {
    const g = new THREE.Group();
    const { ax, bz } = this.extent();
    const apron = new THREE.Mesh(new THREE.CircleGeometry(Math.max(ax, bz) + 30, 64), new THREE.MeshLambertMaterial({ color: 0x4a4e55 }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.06;
    g.add(apron);
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(105, 68), new THREE.MeshLambertMaterial({ color: 0x23853f }));
    pitch.rotation.x = -Math.PI / 2;
    g.add(pitch);
    this.placeholder = g;
    this.scene.add(g);
  }

  private async loadStadium(): Promise<void> {
    try {
      if (!this.template) {
        const { templateById } = await import('../core/stadiumCatalog');
        this.template = templateById(this.map.templateRef.id) ?? null;
      }
      if (this.disposed) return;
      const tpl = this.template;
      this.noTifo = tpl ? noTifoMask(this.map, tpl) : null;
      this.seatRGB = emptySeatColours(tpl, this.map);
      if (this.noTifo) this.recolorAll();
      // Let the first picture (cards on a pitch) reach the screen before the
      // heavy part: a stadium's worth of geometry.
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (this.disposed) return;
      let chairMask: Uint8Array | null = null;
      if (tpl) {
        const { buildStadiumShell } = await import('./stadiumShell');
        if (this.disposed) return;
        const shell = buildStadiumShell(tpl, this.map, { tier: this.settings.tier, palette: this.store.palette, ground: !this.options.transparent });
        chairMask = shell.chairMask;
        this.shell = shell;
      }
      const chairs = buildChairs(this.map, this.seatRGB, this.facing, { skip: chairMask, detail: this.settings.chairs, cardUp: this.seatState });
      this.chairs = chairs;
      // Compile the new shaders off the main thread where the browser can.
      const staging = new THREE.Group();
      if (this.shell) staging.add(this.shell.object);
      staging.add(chairs.object);
      try {
        await this.renderer.compileAsync(staging, this.camera, this.scene);
      } catch {
        /* compiled on first draw instead */
      }
      if (this.disposed) {
        this.shell?.dispose();
        chairs.dispose();
        return;
      }
      if (this.shell) this.scene.add(this.shell.object);
      this.scene.add(chairs.object);
      if (this.placeholder) {
        this.scene.remove(this.placeholder);
        this.placeholder.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          (m.material as THREE.Material | undefined)?.dispose?.();
        });
        this.placeholder = null;
      }
      this.fitCache.clear();
      if (this.onPreset) {
        const p = CAMERA_PRESETS.find((c) => c.name === this.onPreset);
        if (p) this.applyPreset(p);
      } else if (this.options.autoRotate) this.heroCamera();
      this.requestRender();
    } catch (err) {
      // Never take the view down with it: the cards and the pitch are the design.
      console.error('[tifo] the stadium could not be built', err);
    } finally {
      this.readyResolve();
    }
  }

  /**
   * Take the roofs off, for a look at seats a roof hides from above. An
   * indoor hall takes its own off whenever the camera is above it — its
   * ceiling would otherwise be all the Full view showed.
   */
  setRoofsVisible(on: boolean): void {
    this.roofsWanted = on;
    this.requestRender();
  }

  /**
   * Roofs seen from above. From inside the bowl a roof is a roof; from up in
   * the air it is a lid over the back rows of the tifo, so it fades to a
   * ghost of itself as the camera climbs past it — the building still reads,
   * the design under it shows. An indoor hall is cut open above its seats
   * instead (its ceiling is not tagged as a roof: it is the whole building).
   */
  private updateRoofs(): void {
    const y = this.camera.position.y;
    const shell = this.shell;
    if (shell?.roofSpan) {
      const lo = shell.roofSpan.top + 8;
      const hi = shell.roofSpan.top + 45;
      const t = Math.max(0, Math.min(1, (y - lo) / (hi - lo)));
      const f = t * t * (3 - 2 * t);
      const opacity = this.roofsWanted ? 1 - 0.86 * f : 0;
      if (Math.abs(opacity - this.roofOpacity) > 0.004) {
        this.roofOpacity = opacity;
        const ghost = opacity < 0.995;
        for (const m of shell.roofMaterials) {
          const base = (m.userData.baseOpacity ??= m.opacity) as number;
          const wasTransparent = (m.userData.baseTransparent ??= m.transparent) as boolean;
          const want = ghost || wasTransparent;
          if (m.transparent !== want) {
            m.transparent = want;
            m.depthWrite = !ghost && (m.userData.baseDepthWrite ??= m.depthWrite);
            m.needsUpdate = true;
          }
          m.opacity = base * opacity;
        }
        for (const r of shell.roofs) r.visible = opacity > 0.01;
      }
    }
    const { ty } = this.extent();
    const cutY = ty + 2.5;
    const want = !!this.template?.indoor && y > cutY + 6;
    if (want === this.cutOn) return;
    this.cutOn = want;
    this.cutPlane.constant = cutY;
    this.renderer.clippingPlanes = want ? [this.cutPlane] : [];
  }

  // ---------------------------------------------------------------- cameras

  private extent(): { ax: number; bz: number; ty: number } {
    if (this.extentCache) return this.extentCache;
    let ax = 1;
    let bz = 1;
    let ty = 1;
    const P = this.map.pos3;
    for (let k = 0; k < this.map.count; k++) {
      ax = Math.max(ax, Math.abs(P[k * 3]));
      ty = Math.max(ty, P[k * 3 + 1]);
      bz = Math.max(bz, Math.abs(P[k * 3 + 2]));
    }
    return (this.extentCache = { ax, bz, ty });
  }

  /**
   * A place in the middle of the stand on one side: `depth` of the way from
   * its front row to its back row, as a coordinate across the pitch (z for
   * the south stand, x for the east end) and the seat height there. Null when
   * that side has no stand.
   */
  private standAt(side: 'south' | 'north' | 'east', depth: number): { d: number; y: number } | null {
    const P = this.map.pos3;
    const pts: { r: number; y: number }[] = [];
    const across = side === 'east';
    for (let k = 0; k < this.map.count; k++) {
      const x = P[k * 3];
      const z = P[k * 3 + 2];
      const r = side === 'south' ? -z : side === 'north' ? z : x;
      const lateral = across ? z : x;
      if (r > (across ? 52.5 : 34) && Math.abs(lateral) < 12) pts.push({ r, y: P[k * 3 + 1] });
    }
    if (pts.length < 20) return null;
    pts.sort((a, b) => a.r - b.r);
    const at = pts[Math.min(pts.length - 1, Math.floor(depth * (pts.length - 1)))];
    // The highest seat within a metre of that row, so the camera clears it.
    let y = at.y;
    for (const q of pts) if (Math.abs(q.r - at.r) < 1) y = Math.max(y, q.y);
    return { d: side === 'south' ? -at.r : at.r, y };
  }

  /**
   * A camera seat in a stand: `depth` of the way up it, `lift` metres over
   * the seats — then brought down the stand, a few rows at a time, while a
   * roof is still overhead a few metres in front of the lens. Tucked deep
   * under a roof, the underside fills the top of the picture and hides the
   * far stand, which is the one the tifo is on; a real gantry hangs at the
   * front of the roof, not at the back of it.
   */
  private inStand(side: 'south' | 'east', depth: number, lift: number): THREE.Vector3 | null {
    const obj = this.shell?.object;
    const up = new THREE.Raycaster();
    up.far = 40;
    let d = depth;
    for (let k = 0; k < 12; k++) {
      const st = this.standAt(side, d);
      if (!st) return null;
      const p = side === 'south' ? new THREE.Vector3(0, st.y + lift, st.d) : new THREE.Vector3(st.d, st.y + lift, 0);
      if (!obj) return p;
      // Seven metres towards the pitch from the lens: is there a roof above?
      const ahead = side === 'south' ? new THREE.Vector3(0, p.y, p.z + 7) : new THREE.Vector3(p.x - 7, p.y, 0);
      up.set(ahead, new THREE.Vector3(0, 1, 0));
      let roofOver = this.raycastBoth(up, obj).some((h) => (h.object as THREE.Mesh).isMesh && h.object.name !== 'apron');
      // …or a roof hanging low right over the lens (a membrane sags).
      if (!roofOver) {
        up.set(p, new THREE.Vector3(0, 1, 0));
        up.far = 4.5;
        roofOver = this.raycastBoth(up, obj).some((h) => (h.object as THREE.Mesh).isMesh);
        up.far = 40;
      }
      if (!roofOver) return p;
      if (d <= 0.3) break;
      d -= 0.08;
    }
    // A roof over the whole stand, down to its front row: hang the camera out
    // in front of it at the same height, like a cable camera, until the roof
    // is behind it.
    const st = this.standAt(side, Math.max(0.3, d));
    if (!st) return null;
    const p = side === 'south' ? new THREE.Vector3(0, st.y + lift, st.d) : new THREE.Vector3(st.d, st.y + lift, 0);
    for (let k = 0; k < 15; k++) {
      const ahead = side === 'south' ? new THREE.Vector3(0, p.y, p.z + 3) : new THREE.Vector3(p.x - 3, p.y, 0);
      up.set(ahead, new THREE.Vector3(0, 1, 0));
      if (!this.raycastBoth(up, obj!).some((h) => (h.object as THREE.Mesh).isMesh && h.object.name !== 'apron')) break;
      if (side === 'south') p.z += 2;
      else p.x -= 2;
    }
    return p;
  }

  /**
   * Nothing right under the lens: from up in a stand, the fascia of a box or
   * a balcony just below the camera fills the bottom of the picture (it is a
   * metre away, so it looks like a wall across the far stand). Lift the
   * camera over it, a step at a time, but never up into a roof.
   */
  private clearForeground(pos: THREE.Vector3, target: THREE.Vector3): void {
    const obj = this.shell?.object;
    if (!obj) return;
    const ray = new THREE.Raycaster();
    const fovDown = ((FOV / 2) * 0.9 * Math.PI) / 180;
    for (let k = 0; k < 10; k++) {
      const fwd = target.clone().sub(pos).normalize();
      const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      ray.set(pos, fwd.clone().applyAxisAngle(side, -fovDown));
      ray.far = 14;
      // Only what is up at the lens's own height: the stand's deck a couple
      // of metres below is where the camera stands, not in its way.
      const below = this.raycastBoth(ray, obj).some((h) => (h.object as THREE.Mesh).isMesh && h.object.name !== 'apron' && h.object.name !== 'pitch' && h.point.y > pos.y - 1.6);
      if (!below) return;
      ray.set(pos, new THREE.Vector3(0, 1, 0));
      ray.far = 3.5;
      if (this.raycastBoth(ray, obj).some((h) => (h.object as THREE.Mesh).isMesh)) return;
      pos.y += 1.5;
    }
  }

  /** Lift a camera that would be inside the seats to just above them. */
  private clearOfSeats(p: THREE.Vector3): void {
    let top = -Infinity;
    const P = this.map.pos3;
    for (let k = 0; k < this.map.count; k++) {
      const dx = P[k * 3] - p.x;
      const dz = P[k * 3 + 2] - p.z;
      if (dx * dx + dz * dz < 9) top = Math.max(top, P[k * 3 + 1]);
    }
    if (top > -Infinity && p.y < top + 2) p.y = top + 2.2;
  }

  /** Raycast the building testing both faces of everything: from inside the bowl a wall is seen from its back. */
  private raycastBoth(ray: THREE.Raycaster, obj: THREE.Object3D): THREE.Intersection[] {
    const sides: [THREE.Material, THREE.Side][] = [];
    obj.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m && !Array.isArray(m) && m.side !== THREE.DoubleSide) {
        sides.push([m, m.side]);
        m.side = THREE.DoubleSide;
      }
    });
    try {
      return ray.intersectObject(obj, true);
    } finally {
      for (const [m, sd] of sides) m.side = sd;
    }
  }

  /** Bring a camera in from behind a roof, a wall or a column: just this side of the first thing in the way. */
  private clearOfStructure(pos: THREE.Vector3, target: THREE.Vector3): void {
    const obj = this.shell?.object;
    if (!obj) return;
    const dir = pos.clone().sub(target);
    const len = dir.length();
    dir.normalize();
    const ray = new THREE.Raycaster(target.clone(), dir, 0, len + 1);
    const hits = this.raycastBoth(ray, obj);
    const hit = hits.find((h) => (h.object as THREE.Mesh).isMesh && h.object.name !== 'apron' && h.object.name !== 'pitch' && h.object.visible && h.object.parent?.visible !== false);
    if (hit && hit.distance < len + 0.5) pos.copy(target).addScaledVector(dir, Math.max(6, hit.distance - 2.5));
  }

  /** A preset, fitted to this ground. */
  private fitted(name: string): CameraPreset | null {
    const aspect = this.camera.aspect || 1.6;
    const key = name + '@' + aspect.toFixed(2);
    const hit = this.fitCache.get(key);
    if (hit) return hit;
    const { ax, bz, ty } = this.extent();
    let pos: THREE.Vector3;
    let tgt: THREE.Vector3;
    const wholeBowl = (scale: number): void => {
      // Fit the bowl (plus its roofs) to the picture, from the same angle as before.
      const elev = Math.atan2(245, 135);
      const vHalf = (FOV * Math.PI) / 360;
      const hHalf = Math.atan(Math.tan(vHalf) * aspect);
      const halfW = ax + 14;
      const halfH = (bz + 14) * Math.sin(elev) + (ty + 12) * Math.cos(elev);
      const d = Math.max(halfW / Math.tan(hHalf), halfH / Math.tan(vHalf)) * 1.08 + (bz + 14) * Math.cos(elev) * 0.6;
      pos = new THREE.Vector3(0, Math.sin(elev) * d * scale, Math.cos(elev) * d * scale);
      tgt = new THREE.Vector3(0, 0, 0);
    };
    // Kingdom Arena is a hall: its cameras are the ones Match Day keeps
    // under the roof (simulator/index.ts), not ones fitted to the seats.
    if (this.template?.id === 'kingdom-arena-26k' && name !== 'Full view' && name !== 'Aerial') {
      const b = this.template.plan.b;
      const shot: Record<string, [number[], number[]]> = {
        'TV gantry': [[0, 23.5, -(b + 9)], [0, 2, 8]],
        'Behind goal': [[-80, 20, 0], [20, 4, 0]],
        'Pitch level': [[10, 2.2, -(b - 12)], [0, 14, b + 20]],
      };
      const s = shot[name];
      if (!s) return null;
      const out: CameraPreset = { name, position: s[0] as [number, number, number], target: s[1] as [number, number, number] };
      this.fitCache.set(key, out);
      return out;
    }
    switch (name) {
      case 'Full view':
        wholeBowl(1);
        break;
      case 'Aerial':
        wholeBowl(0.72);
        break;
      case 'TV gantry': {
        // Over the back rows of the main stand at the halfway line, looking
        // across — measured on THAT stand, not on the tallest one in the
        // ground (a low main stand opposite a tall one would otherwise put
        // the camera up over its own roof).
        const st = this.inStand('south', 0.92, 2.6);
        pos = st ?? new THREE.Vector3(0, ty * 1.02 + 2, -bz * 0.95);
        tgt = new THREE.Vector3(0, 3, bz * 0.12);
        if (st && !this.standAt('north', 0.5)) {
          // Nothing on the far side (a one-stand ground): a gantry there
          // would look at an empty touchline. Look back at the main stand,
          // from a crane over the open side, instead.
          pos = new THREE.Vector3(0, Math.max(14, ty * 0.8), Math.min(bz, 62));
          tgt = new THREE.Vector3(0, ty * 0.4, -bz * 0.55);
        }
        this.clearOfSeats(pos);
        this.clearOfStructure(pos, tgt);
        this.clearForeground(pos, tgt);
        break;
      }
      case 'Behind goal': {
        // Two-thirds of the way up the end stand, behind the goal.
        const st = this.inStand('east', 0.62, 2.2);
        pos = st ?? new THREE.Vector3(ax * 0.9, ty * 0.58, 0);
        tgt = new THREE.Vector3(-ax * 0.35, ty * 0.3, 0);
        this.clearOfSeats(pos);
        this.clearOfStructure(pos, tgt);
        this.clearForeground(pos, tgt);
        break;
      }
      case 'Pitch level':
        // On the touchline, looking up at the far stand — the best angle for a tifo.
        pos = new THREE.Vector3(ax * 0.22, 1.8, Math.min(bz * 0.3, 30));
        tgt = new THREE.Vector3(-ax * 0.4, ty * 0.5, -bz * 0.85);
        break;
      default:
        return null;
    }
    const out: CameraPreset = { name, position: [pos!.x, pos!.y, pos!.z], target: [tgt!.x, tgt!.y, tgt!.z] };
    this.fitCache.set(key, out);
    return out;
  }

  applyPreset(preset: CameraPreset): void {
    const p = this.fitted(preset.name) ?? preset;
    this.camera.position.set(...p.position);
    this.controls.target.set(...p.target);
    this.camera.near = Math.max(0.5, Math.hypot(...p.position) / 2000);
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(600, (this.fitted('Full view')?.position[1] ?? 300) * 4);
    this.controls.update();
    this.onPreset = preset.name;
    this.requestRender();
  }

  /** Fitted presets, for anything that wants to know where they are. */
  presets(): CameraPreset[] {
    return CAMERA_PRESETS.map((p) => this.fitted(p.name) ?? p);
  }

  private heroCamera(): void {
    // The hero's long-standing 3/4 view of the default bowl, scaled to this one.
    const { ax, bz } = this.extent();
    const k = Math.max(ax, bz) / 133;
    this.camera.position.set(115 * k, 130 * k, 175 * k);
    this.controls.target.set(0, -4, 0);
    this.controls.update();
    this.requestRender();
  }

  // ---------------------------------------------------------------- banners

  /**
   * Show this design's banners in the preview.
   *
   * The same rig the bowl uses, not a second implementation of one. A banner
   * that only appears once you open Match Day is a banner you design blind.
   */
  attachBanners(store: BannerStore, template: { roof?: unknown }): void {
    if (this.banners) return;
    this.bannerStore = store;
    const frameFor = this.frameFor;
    this.banners = buildBannerRigs(
      store,
      frameFor,
      () => 0,
      (st, stands, alongU) => {
        const f = frameFor(st, stands);
        const covered = standIsRoofed(template as { roof?: never }, st);
        const q = f.pointAt(alongU, covered ? 0.84 : 1);
        return { x: q.x, y: covered ? f.roofY : q.y + 1.4, z: q.z, onRoof: covered };
      },
    );
    this.scene.add(this.banners.object);
    store.onChange(() => this.requestRender());
    this.requestRender();
  }

  /** Are there banners on show (which wave, so need frames)? */
  private bannersLive(): boolean {
    return !!this.banners && !!this.bannerStore && this.bannerStore.list().some((b) => b.visible !== false);
  }

  /**
   * Point the camera at a banner, the way Match Day's "Look at it" does.
   */
  focusBanner(id?: string | null): boolean {
    const store = this.bannerStore;
    const doc = store ? (id ? store.get(id) : store.active) : null;
    if (!doc) return false;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const aspect = w > 0 && h > 0 ? w / h : this.camera.aspect;
    const shot = bannerShot(doc, this.frameFor(doc.slot.stand, doc.slot.stands), { fov: this.camera.fov, aspect });
    if (!shot) return false;
    this.camera.position.set(...shot.position);
    this.controls.target.set(...shot.target);
    this.controls.update();
    this.onPreset = null;
    this.requestRender();
    return true;
  }

  /**
   * Add extra scene furniture. Kept deliberately narrow: the preview owns its
   * scene and its lifecycle, so callers hand over an object and dispose of it
   * themselves rather than reaching into the scene graph.
   */
  addSceneObject(obj: THREE.Object3D): void {
    this.scene.add(obj);
    this.requestRender();
  }

  // ------------------------------------------------------------- rendering

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The whole-bowl views depend on the picture's shape.
    for (const k of [...this.fitCache.keys()]) if (/^(Full view|Aerial)@/.test(k)) this.fitCache.delete(k);
    if (this.onPreset === 'Full view' || this.onPreset === 'Aerial') {
      const p = this.fitted(this.onPreset)!;
      this.camera.position.set(...p.position);
      this.controls.target.set(...p.target);
      this.controls.update();
    }
    this.requestRender();
  }

  /** Ask for one frame (more follow by themselves while anything is moving). */
  readonly requestRender = (): void => {
    if (!this.running || this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
  };

  private setRatio(r: number): void {
    if (Math.abs(this.renderer.getPixelRatio() - r) < 0.01) return;
    this.renderer.setPixelRatio(r);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w > 0 && h > 0) this.renderer.setSize(w, h);
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (!this.running || this.disposed) return;
    const dt = this.lastFrameAt ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 1 / 60;
    this.lastFrameAt = now;
    let again = false;
    if (this.bannersLive()) {
      // Clamped: a preview that has been in a background tab for a minute
      // must not hand the fabric a sixty-second step.
      this.banners!.update(0, Math.min(0.05, dt));
      again = true;
    }
    // With damping, the camera keeps gliding after the hand lets go.
    if (this.controls.update()) again = true;
    if (this.controls.autoRotate) again = true;
    const moving = again || this.interacting;
    // Cheaper pixels while it moves, sharp ones when it stops.
    this.setRatio(moving && this.moving ? this.movingRatio : this.pixelRatio);
    this.updateRoofs();
    this.renderer.render(this.scene, this.camera);
    this.framesDrawn++;
    if (moving && this.moving) this.watch(dt);
    if (moving) {
      this.moving = true;
      this.requestRender();
    } else if (this.moving) {
      // It just stopped: one more frame at full sharpness.
      this.moving = false;
      this.lastFrameAt = 0;
      this.requestRender();
    } else {
      this.lastFrameAt = 0;
    }
  };

  /**
   * A device slower than its tier guessed: while moving, give up pixels
   * until it keeps up (~24 fps); a quick one earns them back.
   */
  private watch(dt: number): void {
    if (dt > 1 / 24) {
      this.fastFrames = 0;
      if (++this.slowFrames >= 20 && this.movingRatio > 0.5) {
        this.movingRatio = Math.max(0.5, this.movingRatio - 0.15);
        this.slowFrames = 0;
      }
    } else if (dt < 1 / 50) {
      this.slowFrames = 0;
      if (++this.fastFrames >= 90 && this.movingRatio < Math.min(this.pixelRatio, this.settings.movingPixelRatio)) {
        this.movingRatio = Math.min(this.pixelRatio, this.movingRatio + 0.15);
        this.fastFrames = 0;
      }
    }
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.resize();
    this.lastFrameAt = 0;
    this.requestRender();
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly onCtxLost = (e: Event): void => {
    e.preventDefault();
    this.stop();
  };

  /**
   * A square still of the whole bowl, for "Post it" (ui/postMoment.ts).
   *
   * Rendered at its own size and from the whole-bowl camera, not cropped out of
   * whatever the editor happens to show. Everything is put back afterwards,
   * so the view on screen does not move.
   */
  captureStill(size = 1080): HTMLCanvasElement {
    const pos = this.camera.position.clone();
    const target = this.controls.target.clone();
    const aspect = this.camera.aspect;
    const ratio = this.renderer.getPixelRatio();
    const was = new THREE.Vector2();
    this.renderer.getSize(was);
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    try {
      this.renderer.setPixelRatio(1);
      // false: leave the canvas's CSS size alone, so nothing on screen jumps.
      this.renderer.setSize(size, size, false);
      this.camera.aspect = 1;
      this.fitCache.forEach((_, k) => k.endsWith('@1.00') && this.fitCache.delete(k));
      const full = this.fitted('Full view') ?? CAMERA_PRESETS[4];
      // A little further back than the preset: the side stands are the tifo too.
      this.camera.position.set(full.position[0] * 1.06, full.position[1] * 1.04, full.position[2] * 1.06);
      this.controls.target.set(...full.target);
      this.camera.lookAt(this.controls.target);
      this.camera.updateProjectionMatrix();
      this.updateRoofs();
      this.renderer.render(this.scene, this.camera);
      out.getContext('2d')?.drawImage(this.canvas, 0, 0, size, size);
    } finally {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(was.x, was.y, false);
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }
    return out;
  }

  /** Render a single frame on demand (used by the video/GIF exporter, which
   * pauses the internal loop and steps the reveal clock deterministically). */
  renderOnce(): void {
    this.updateRoofs();
    this.renderer.render(this.scene, this.camera);
  }

  /** What the view is drawing, for tests and the perf harness. */
  census(): { tier: ViewTier; structure: boolean; chairs: number; cardsUp: number; drawCalls: number; triangles: number; shell: ShellBuild['stats'] | null; pixelRatio: number; frames: number; roofOpacity: number; roofs: boolean; programs: number } {
    const info = this.renderer.info;
    const auto = info.autoReset;
    info.autoReset = false;
    info.reset();
    this.renderer.render(this.scene, this.camera);
    const out = {
      tier: this.settings.tier,
      structure: !!this.shell,
      chairs: this.chairs ? this.chairs.triangles : 0,
      cardsUp: (this.cardShow.array as Float32Array).reduce((s, v) => s + (v > 0 ? 1 : 0), 0),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      shell: this.shell ? this.shell.stats : null,
      pixelRatio: this.renderer.getPixelRatio(),
      frames: this.framesDrawn,
      roofOpacity: this.roofOpacity,
      roofs: !!this.shell?.roofSpan,
      programs: info.programs?.length ?? 0,
    };
    info.autoReset = auto;
    return out;
  }

  /** Fully tear down: stop the loop, disconnect observers, free GPU resources,
   * and remove the canvas. Call when closing the preview modal so repeated
   * opens don't leak WebGL contexts. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.readyResolve();
    this.resizeObserver.disconnect();
    this.store.offDirty?.(this.onDirtyCb);
    this.store.offPaletteChange?.(this.onPaletteCb);
    this.controls.dispose();
    this.banners?.dispose();
    this.banners = null;
    this.shell?.dispose();
    this.shell = null;
    this.chairs?.dispose();
    this.chairs = null;
    for (const t of this.staticTrash) t.dispose();
    this.envTarget?.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onCtxLost);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
