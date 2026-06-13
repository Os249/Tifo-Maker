import {
  Application,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Sprite,
  Texture,
} from 'pixi.js';
import type { SeatMap, ToolId } from '../core/types';
import { ObjectOverlay } from './objectOverlay';
import type { ObjectLayer } from '../core/objects';
import type { DesignStore } from '../core/design';
import { SpatialHash } from '../core/spatialHash';
import { brushSegment, brushStamp, floodFill } from '../core/tools';
import { EMPTY_SEAT_COLOR } from '../core/template';

/**
 * The 2D editor surface.
 *
 * Rendering: one ParticleContainer with `count` particles — a single instanced
 * draw call. Positions are static (uploaded once); only color is dynamic.
 * Painting writes palette indices into the DesignStore; the store's dirty
 * callback updates per-particle tints. React/DOM never touches any of this.
 */
export class Editor {
  readonly app: Application;
  private readonly world = new Container();
  private readonly seats: ParticleContainer;
  private readonly particles: Particle[] = [];
  private readonly gridOverlay = new Graphics();
  objectOverlay: ObjectOverlay | null = null;
  private readonly hash: SpatialHash;
  private paletteRGB: number[] = [];

  tool: ToolId = 'brush';
  colorIndex = 1;
  brushRadius = 10;
  fillScope: 'section' | 'global' = 'section';
  /** Mirror painting across the halfway line (uses SeatMap.mirrorOf). */
  mirror = false;
  /** Set by the toolbar; receives world coords on text/import placement clicks. */
  onPlaceStamp: ((x: number, y: number) => void) | null = null;
  /** Fired during object resize with the new height in editor units. */
  onObjectResize: ((heightEditor: number) => void) | null = null;
  /** Set while a partial reveal dims the grid; any edit asks the UI to clear it. */
  revealActive = false;
  /** UI hook to cancel a reveal preview before an edit repaints seats. */
  onEditWhileRevealed: (() => void) | null = null;
  /** Aisle count for the section-guide overlay (template-dependent). */
  aisleCount = 28;
  /** Fired on hover with the seat index under the cursor (-1 if none). */
  onHoverSeat: ((seat: number) => void) | null = null;
  /** Fired after pan/zoom with the normalized viewport rect for the minimap. */
  onViewChange: ((u0: number, v0: number, u1: number, v1: number, zoom: number) => void) | null = null;

  private stampPreview: Sprite | null = null;
  private stampPreviewTinted = true;
  private stampPreviewW = 0;
  private stampPreviewH = 0;

  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  private painting = false;
  private panning = false;
  private lastX = 0;
  private lastY = 0;

  private constructor(
    private readonly map: SeatMap,
    private readonly store: DesignStore,
    app: Application,
  ) {
    this.app = app;
    this.hash = new SpatialHash(map);
    this.seats = new ParticleContainer({
      dynamicProperties: { position: false, rotation: false, vertex: false, uvs: false, color: true },
    });
    this.rebuildPalette();

    const seatW = 3.2;
    const seatH = 6.4;
    for (let i = 0; i < map.count; i++) {
      const p = new Particle({
        texture: Texture.WHITE,
        x: map.xy[i * 2],
        y: map.xy[i * 2 + 1],
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: seatW / Texture.WHITE.width,
        scaleY: seatH / Texture.WHITE.height,
        tint: this.tintFor(this.store.cells[i]),
      });
      this.particles.push(p);
      this.seats.addParticle(p);
    }

    this.world.addChild(this.seats);
    this.world.addChild(this.gridOverlay);
    app.stage.addChild(this.world);

    this.drawGrid(true);
    this.fitToView();
    this.bindPointer();

    store.onDirty((indices) => {
      if (indices === 'all') {
        for (let i = 0; i < map.count; i++) this.particles[i].tint = this.tintFor(store.cells[i]);
      } else {
        for (const i of indices) this.particles[i].tint = this.tintFor(store.cells[i]);
      }
    });
  }

  static async create(canvasHost: HTMLElement, map: SeatMap, store: DesignStore): Promise<Editor> {
    const app = new Application();
    await app.init({
      background: 0x0e1016,
      resizeTo: canvasHost,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    });
    canvasHost.appendChild(app.canvas);
    return new Editor(map, store, app);
  }

  private tintFor(cell: number): number {
    return cell === 0 ? EMPTY_SEAT_COLOR : this.paletteRGB[cell] ?? EMPTY_SEAT_COLOR;
  }

  rebuildPalette(): void {
    this.paletteRGB = this.store.palette.map((hex) => parseInt(hex.slice(1), 16));
  }

  repaintAll(): void {
    for (let i = 0; i < this.map.count; i++) {
      this.particles[i].tint = this.tintFor(this.store.cells[i]);
    }
  }

  /**
   * Apply per-seat reveal visibility (0 = card down/dim, 1 = up/full). Lerps each
   * seat's tint toward the empty-seat color. Pass null to restore the full design.
   */
  applyReveal(visibility: ((seat: number) => number) | null): void {
    if (!visibility) {
      this.revealActive = false;
      this.repaintAll();
      return;
    }
    this.revealActive = true;
    const pit = EMPTY_SEAT_COLOR;
    const pr = (pit >> 16) & 0xff;
    const pg = (pit >> 8) & 0xff;
    const pb = pit & 0xff;
    for (let i = 0; i < this.map.count; i++) {
      const full = this.tintFor(this.store.cells[i]);
      const a = visibility(i);
      if (a >= 1) {
        this.particles[i].tint = full;
        continue;
      }
      const fr = (full >> 16) & 0xff;
      const fg = (full >> 8) & 0xff;
      const fb = full & 0xff;
      const r = Math.round(pr + (fr - pr) * a);
      const g = Math.round(pg + (fg - pg) * a);
      const b = Math.round(pb + (fb - pb) * a);
      this.particles[i].tint = (r << 16) | (g << 8) | b;
    }
  }

  /**
   * Ghost preview of the pending stamp (text or image); follows the cursor at
   * 55% alpha. `tinted` previews tint to the active color (white text canvases);
   * image previews keep their own colors.
   */
  setStampPreview(source: HTMLCanvasElement | ImageBitmap | null, tinted = true): void {
    if (this.stampPreview) {
      this.stampPreview.destroy({ texture: true, textureSource: true });
      this.stampPreview = null;
    }
    if (!source) return;
    const sprite = new Sprite(Texture.from(source));
    sprite.alpha = 0.55;
    sprite.visible = false;
    sprite.eventMode = 'none';
    this.stampPreview = sprite;
    this.stampPreviewTinted = tinted;
    this.world.addChild(sprite);
    this.applyStampPreviewSize();
    this.refreshStampPreviewTint();
  }

  setStampPreviewSize(w: number, h: number): void {
    this.stampPreviewW = w;
    this.stampPreviewH = h;
    this.applyStampPreviewSize();
  }

  private applyStampPreviewSize(): void {
    if (this.stampPreview) {
      this.stampPreview.width = this.stampPreviewW;
      this.stampPreview.height = this.stampPreviewH;
    }
  }

  refreshStampPreviewTint(): void {
    if (this.stampPreview) {
      this.stampPreview.tint = this.stampPreviewTinted ? this.tintFor(this.colorIndex) : 0xffffff;
    }
  }

  hideStampPreview(): void {
    if (this.stampPreview) this.stampPreview.visible = false;
  }

  /** Expand a dirty set with halfway-line mirrors, painted at the same value. */
  private applyMirrorTo(dirty: number[], value: number): number[] {
    if (!this.mirror) return dirty;
    const extra: number[] = [];
    for (const i of dirty) {
      const m = this.map.mirrorOf[i];
      if (m >= 0 && this.store.paint(m, value)) extra.push(m);
    }
    return dirty.length ? dirty.concat(extra) : dirty;
  }

  /** Temporarily tint seats a warning color (legibility check), then restore. */
  flashSeats(indices: number[], durationMs = 1800): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
      this.repaintAll();
    }
    const warn = 0xff2d78;
    for (const i of indices) this.particles[i].tint = warn;
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      for (const i of indices) this.particles[i].tint = this.tintFor(this.store.cells[i]);
    }, durationMs);
  }

  /** Aisle (section boundary) and tier walkway guides. */
  drawGrid(visible: boolean): void {
    const g = this.gridOverlay;
    g.clear();
    g.visible = visible;
    if (!visible) return;
    const { minY, maxY } = this.map.bounds;
    // Section boundaries: one vertical guide per aisle u position.
    for (let i = 0; i < this.aisleCount; i++) {
      const x = (i / this.aisleCount) * 4000;
      g.moveTo(x, minY - 8).lineTo(x, maxY + 8);
    }
    g.stroke({ color: 0xffffff, alpha: 0.1, width: 1, pixelLine: true });
    // Tier walkway: find the y gap between tier 0 and tier 1.
    let tier0Top = Infinity;
    let tier1Bottom = -Infinity;
    for (let i = 0; i < this.map.count; i++) {
      const y = this.map.xy[i * 2 + 1];
      if (this.map.tierOf[i] === 0 && y < tier0Top) tier0Top = y;
      if (this.map.tierOf[i] === 1 && y > tier1Bottom) tier1Bottom = y;
    }
    if (isFinite(tier0Top) && isFinite(tier1Bottom)) {
      const yWalk = (tier0Top + tier1Bottom) / 2;
      g.moveTo(-20, yWalk).lineTo(4020, yWalk);
      g.stroke({ color: 0xffffff, alpha: 0.16, width: 1, pixelLine: true });
    }
  }

  fitToView(): void {
    const { minX, minY, maxX, maxY } = this.map.bounds;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const scale = Math.min(w / (maxX - minX + 80), h / (maxY - minY + 80));
    this.world.scale.set(scale);
    this.world.position.set(
      (w - (maxX - minX) * scale) / 2 - minX * scale,
      (h - (maxY - minY) * scale) / 2 - minY * scale,
    );
    this.emitView();
  }

  /** Push the current viewport to onViewChange as normalized (u,v) bounds. */
  emitView(): void {
    if (!this.onViewChange) return;
    const r = this.getViewportRect();
    const { minX, minY, maxX, maxY } = this.map.bounds;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    this.onViewChange((r.x - minX) / w, (r.y - minY) / h, (r.x + r.width - minX) / w, (r.y + r.height - minY) / h, this.world.scale.x);
  }

  /** Frame a section by its seat-index list: fit its bounds with padding. */
  zoomToSeats(seats: number[]): void {
    if (seats.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of seats) {
      const x = this.map.xy[i * 2];
      const y = this.map.xy[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const pad = 60;
    const scale = Math.min(8, Math.max(0.1, Math.min((w - pad) / (maxX - minX + 1), (h - pad) / (maxY - minY + 1))));
    this.world.scale.set(scale);
    this.world.position.set(w / 2 - ((minX + maxX) / 2) * scale, h / 2 - ((minY + maxY) / 2) * scale);
    this.emitView();
  }

  /** Pan/zoom so a normalized (u,v) point sits at the viewport center. */
  centerOn(u: number, v: number): void {
    const { minX, minY, maxX, maxY } = this.map.bounds;
    const wx = minX + u * (maxX - minX);
    const wy = minY + v * (maxY - minY);
    this.world.position.x = this.app.screen.width / 2 - wx * this.world.scale.x;
    this.world.position.y = this.app.screen.height / 2 - wy * this.world.scale.y;
    this.emitView();
  }

  /** Zoom by a factor about the viewport center (zoom buttons). */
  zoomBy(factor: number): void {
    const cx = this.app.screen.width / 2;
    const cy = this.app.screen.height / 2;
    const next = Math.min(12, Math.max(0.1, this.world.scale.x * factor));
    const applied = next / this.world.scale.x;
    this.world.position.x = cx - (cx - this.world.position.x) * applied;
    this.world.position.y = cy - (cy - this.world.position.y) * applied;
    this.world.scale.set(next);
    this.emitView();
  }

  /** Mount the floating object layer's overlay into the world container. */
  attachObjectLayer(layer: ObjectLayer): ObjectOverlay {
    const overlay = new ObjectOverlay(layer, () => this.world.scale.x);
    this.objectOverlay = overlay;
    this.world.addChild(overlay.root);
    overlay.sync();
    return overlay;
  }

  /** World-space rect currently visible — the import target ("zoom to place"). */
  getViewportRect(): { x: number; y: number; width: number; height: number } {
    return {
      x: -this.world.position.x / this.world.scale.x,
      y: -this.world.position.y / this.world.scale.y,
      width: this.app.screen.width / this.world.scale.x,
      height: this.app.screen.height / this.world.scale.y,
    };
  }

  private toWorld(e: PointerEvent): [number, number] {
    const rect = this.app.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return [
      (sx - this.world.position.x) / this.world.scale.x,
      (sy - this.world.position.y) / this.world.scale.y,
    ];
  }

  private bindPointer(): void {
    const canvas = this.app.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const [wx, wy] = this.toWorld(e);
      if (this.tool === 'pan' || e.button === 1 || e.button === 2) {
        this.panning = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        return;
      }
      if (this.tool === 'select' && this.objectOverlay) {
        const hit = this.objectOverlay.hitTest(wx, wy);
        if (hit) this.objectOverlay.beginDrag(hit.id, hit.onHandle, wx, wy);
        else this.objectOverlay.selectAt(null);
        return;
      }
      if (this.tool === 'text' || this.tool === 'import') {
        // Stamps are never mirrored — reflected glyphs/crests read backwards.
        this.onPlaceStamp?.(wx, wy);
        return;
      }
      if (this.revealActive) this.onEditWhileRevealed?.();
      if (this.tool === 'fill') {
        const seat = this.hash.nearest(wx, wy, 24);
        if (seat >= 0) {
          this.store.beginStroke();
          let dirty = floodFill(this.store, this.map, seat, this.colorIndex, this.fillScope);
          dirty = this.applyMirrorTo(dirty, this.colorIndex);
          this.store.commitStroke();
          this.store.flush(dirty);
        }
        return;
      }
      // brush / eraser
      this.painting = true;
      this.store.beginStroke();
      const value = this.tool === 'eraser' ? 0 : this.colorIndex;
      const dirty = this.applyMirrorTo(
        brushStamp(this.store, this.hash, wx, wy, this.brushRadius, value),
        value,
      );
      this.store.flush(dirty);
      this.lastX = wx;
      this.lastY = wy;
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.panning) {
        this.world.position.x += e.clientX - this.lastX;
        this.world.position.y += e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.emitView();
        return;
      }
      if (this.objectOverlay?.isDragging) {
        const [dx, dy] = this.toWorld(e);
        const r = this.objectOverlay.updateDrag(dx, dy);
        if (r && this.onObjectResize) this.onObjectResize(r.resizedToHeight);
        return;
      }
      if ((this.tool === 'text' || this.tool === 'import') && this.stampPreview) {
        const [tx, ty] = this.toWorld(e);
        this.stampPreview.position.set(tx - this.stampPreviewW / 2, ty - this.stampPreviewH / 2);
        this.stampPreview.visible = true;
        return;
      }
      if (this.onHoverSeat && !this.painting) {
        const [hx, hy] = this.toWorld(e);
        this.onHoverSeat(this.hash.nearest(hx, hy, 18));
      }
      if (!this.painting) return;
      const [wx, wy] = this.toWorld(e);
      const value = this.tool === 'eraser' ? 0 : this.colorIndex;
      const dirty = this.applyMirrorTo(
        brushSegment(this.store, this.hash, this.lastX, this.lastY, wx, wy, this.brushRadius, value),
        value,
      );
      this.store.flush(dirty);
      this.lastX = wx;
      this.lastY = wy;
    });

    const end = () => {
      if (this.painting) this.store.commitStroke();
      if (this.objectOverlay?.isDragging) this.objectOverlay.endDrag();
      this.painting = false;
      this.panning = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => this.hideStampPreview());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Wheel zoom around the cursor.
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0012);
        const next = Math.min(12, Math.max(0.1, this.world.scale.x * factor));
        const applied = next / this.world.scale.x;
        this.world.position.x = sx - (sx - this.world.position.x) * applied;
        this.world.position.y = sy - (sy - this.world.position.y) * applied;
        this.world.scale.set(next);
        this.emitView();
      },
      { passive: false },
    );
  }
}
