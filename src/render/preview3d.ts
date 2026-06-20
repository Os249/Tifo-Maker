import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatMap } from '../core/types';
import type { DesignStore } from '../core/design';

/**
 * Phase 2: the stadium preview.
 *
 * One InstancedMesh — one card-quad geometry, `count` instances — positioned from
 * SeatMap.pos3 (metric world coordinates computed by the generator) and colored
 * from the SAME DesignStore.cells buffer the 2D editor paints into. There is no
 * sync step: the store's dirty callback updates per-instance colors directly.
 *
 * Camera presets matter more than free orbit: tifos are designed for specific
 * angles (above all the TV gantry), so presets ship first-class and orbit is
 * the exploration extra.
 */

export interface CameraPreset {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { name: 'TV gantry', position: [0, 34, -100], target: [0, 10, 25] },
  { name: 'Behind goal', position: [100, 7, 0], target: [-45, 14, 0] },
  { name: 'Pitch level', position: [40, 1.8, 26], target: [-60, 16, -48] },
  { name: 'Aerial', position: [0, 175, 95], target: [0, 0, 0] },
  // Centred high aerial pulled far enough back to frame the ENTIRE bowl/tifo at
  // once (same angle as Aerial, ~40% further out) — the "show me the whole
  // thing" preset. Works for the big oval template too, which Aerial can crop.
  { name: 'Full view', position: [0, 245, 135], target: [0, 0, 0] },
];

const EMPTY_COLOR = new THREE.Color(0x262a33);
const NO_SHOW_RATE = 0.1;

export class Preview3D {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly seats: THREE.InstancedMesh;
  private paletteColors: THREE.Color[] = [];
  private readonly noShowMask: Uint8Array;
  private noShowsEnabled = false;
  private running = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    options: { autoRotate?: boolean; transparent?: boolean } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: options.transparent ?? false,
      preserveDrawingBuffer: true, // keep the buffer readable for video/GIF frame capture
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.canvas = this.renderer.domElement;
    host.appendChild(this.canvas);

    // Transparent hero variant shows the page background through the canvas;
    // the editor preview keeps its dark scene backdrop.
    if (options.transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.scene.background = new THREE.Color(0x0a0c11);
    }
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1200);
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
    this.applyPreset(CAMERA_PRESETS[0]);
    // Hero showcase: a high, pulled-back 3/4 view that always frames the WHOLE
    // bowl as it slowly spins (not the editor's tight inspection angle). Pulled
    // far enough back that no rotation angle crops the near stand.
    if (options.autoRotate) {
      this.camera.position.set(115, 130, 175);
      this.controls.target.set(0, -4, 0);
      this.controls.update();
    }

    // Deterministic-enough no-show mask; regenerated per session is fine —
    // it is a visualization aid, not design data.
    this.noShowMask = new Uint8Array(map.count);
    for (let i = 0; i < map.count; i++) {
      if (Math.random() < NO_SHOW_RATE) this.noShowMask[i] = 1;
    }

    this.rebuildPalette();
    this.seats = this.buildSeats();
    this.scene.add(this.seats);
    this.buildEnvironment();

    // Palette swaps/edits must rebuild this view's color cache too — otherwise
    // the 3D preview keeps the palette it was built with and drifts from 2D.
    store.onPaletteChange(() => {
      this.rebuildPalette();
      this.recolorAll();
    });
    store.onDirty((indices) => {
      if (indices === 'all') this.recolorAll();
      else for (const i of indices) this.recolor(i);
      this.seats.instanceColor!.needsUpdate = true;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  rebuildPalette(): void {
    this.paletteColors = this.store.palette.map((hex) => new THREE.Color(hex));
  }

  private colorFor(i: number): THREE.Color {
    if (this.noShowsEnabled && this.noShowMask[i]) return EMPTY_COLOR;
    const cell = this.store.cells[i];
    return cell === 0 ? EMPTY_COLOR : (this.paletteColors[cell] ?? EMPTY_COLOR);
  }

  private recolor(i: number): void {
    this.seats.setColorAt(i, this.colorFor(i));
  }

  recolorAll(): void {
    for (let i = 0; i < this.map.count; i++) this.recolor(i);
    this.seats.instanceColor!.needsUpdate = true;
  }

  /**
   * Apply per-seat reveal visibility (0 = card down/dark, 1 = up/full), lerping
   * each card toward the dark empty color. Pass null to restore the full design.
   * Mirrors Editor.applyReveal so a reveal plays identically in 2D and 3D.
   */
  applyReveal(visibility: ((seat: number) => number) | null): void {
    if (!visibility) {
      this.recolorAll();
      return;
    }
    const tmp = new THREE.Color();
    for (let i = 0; i < this.map.count; i++) {
      const full = this.colorFor(i);
      const a = visibility(i);
      if (a >= 1) {
        this.seats.setColorAt(i, full);
      } else {
        tmp.copy(EMPTY_COLOR).lerp(full, a);
        this.seats.setColorAt(i, tmp);
      }
    }
    this.seats.instanceColor!.needsUpdate = true;
  }

  setNoShows(enabled: boolean): void {
    this.noShowsEnabled = enabled;
    this.recolorAll();
  }

  applyPreset(preset: CameraPreset): void {
    this.camera.position.set(...preset.position);
    this.controls.target.set(...preset.target);
    this.controls.update();
  }

  private buildSeats(): THREE.InstancedMesh {
    // A held-up card: ~45 × 70 cm, flat-shaded (cards are matte plastic under
    // floodlights — MeshBasicMaterial reads truer than lit shading here).
    const geometry = new THREE.PlaneGeometry(0.45, 0.7);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geometry, material, this.map.count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < this.map.count; i++) {
      const x = this.map.pos3[i * 3];
      const y = this.map.pos3[i * 3 + 1] + 0.9; // card held at chest height above the step
      const z = this.map.pos3[i * 3 + 2];
      dummy.position.set(x, y, z);
      dummy.lookAt(0, y, 0); // face the bowl center
      dummy.rotateX(-0.22); // lean back with the rake
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, this.colorFor(i));
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildEnvironment(): void {
    // Apron / concourse floor.
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(170, 64),
      new THREE.MeshBasicMaterial({ color: 0x10131a }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.05;
    this.scene.add(apron);

    // Pitch: 105 × 68 m along x.
    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(105, 68),
      new THREE.MeshBasicMaterial({ color: 0x17552e }),
    );
    pitch.rotation.x = -Math.PI / 2;
    this.scene.add(pitch);

    // Markings: touchlines, halfway line, center circle.
    const lineMat = new THREE.LineBasicMaterial({ color: 0xdfe6df, transparent: true, opacity: 0.8 });
    const y = 0.03;
    const outline = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-52.5, y, -34),
      new THREE.Vector3(52.5, y, -34),
      new THREE.Vector3(52.5, y, 34),
      new THREE.Vector3(-52.5, y, 34),
      new THREE.Vector3(-52.5, y, -34),
    ]);
    this.scene.add(new THREE.Line(outline, lineMat));
    const halfway = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, y, -34),
      new THREE.Vector3(0, y, 34),
    ]);
    this.scene.add(new THREE.Line(halfway, lineMat));
    const circlePts: THREE.Vector3[] = [];
    for (let a = 0; a <= 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      circlePts.push(new THREE.Vector3(Math.cos(t) * 9.15, y, Math.sin(t) * 9.15));
    }
    this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts), lineMat));
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
    if (this.running) return;
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

  /** Render a single frame on demand (used by the video/GIF exporter, which
   * pauses the internal loop and steps the reveal clock deterministically). */
  renderOnce(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Fully tear down: stop the loop, disconnect observers, free GPU resources,
   * and remove the canvas. Call when closing the preview modal so repeated
   * opens don't leak WebGL contexts. */
  dispose(): void {
    this.running = false;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.seats.geometry.dispose();
    const mat = this.seats.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
