import { Container, Graphics, Text } from 'pixi.js';
import type { ObjectLayer, TifoObject } from '../core/objects';
import { halfExtents } from '../core/layers';

/**
 * The selection frame over the seats.
 *
 * Objects are drawn AS SEATS now — the flattened stack is what the editor
 * shows — so this layer draws only what is not a seat: the frame around the
 * selected object with its eight handles and the turn handle below it, a thin
 * outline under the pointer so a picture can be told from paint, the snapping
 * guides, and the angle while turning.
 *
 * Handle sizes are in screen pixels (divided by the zoom). Touch gets a larger
 * hit area — 44 px, the size a fingertip needs — than a mouse does.
 */

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'rotate';

export interface OverlayHit {
  id: string;
  handle: Handle;
}

export interface DragMods {
  /** Free the aspect ratio (corners), or turn in 15° steps. */
  shift?: boolean;
  /** Resize from the centre. */
  alt?: boolean;
  /** No snapping while held. */
  ctrl?: boolean;
}

export interface SnapTargets {
  xs: number[];
  ys: number[];
}

const VIOLET = 0x8b7cff;
const MUTED = 0x9aa3b2;
const GUIDE = 0xff4fa3;
/** Where each handle sits, as a fraction of the half-size in the object's own frame. */
const HANDLE_POS: Record<Exclude<Handle, 'move' | 'rotate'>, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};
const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw'];
const EDGES: Handle[] = ['n', 'e', 's', 'w'];

interface DragState {
  id: string;
  handle: Handle;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  ox: number;
  oy: number;
  startAngle: number;
}

export class ObjectOverlay {
  readonly root = new Container();
  private readonly hoverG = new Graphics();
  private readonly frameG = new Graphics();
  private readonly guideG = new Graphics();
  private readonly angleText: Text;
  private drag: DragState | null = null;
  private hoverId: string | null = null;
  private highlightId: string | null = null;
  private guides: { xs: number[]; ys: number[] } = { xs: [], ys: [] };
  /** Called when a gesture starts and ends (the floating action bar steps aside). */
  onGesture: ((active: boolean) => void) | null = null;

  constructor(
    private readonly layer: ObjectLayer,
    private readonly worldScale: () => number,
    private readonly wrapWidth: number,
    private readonly snapTargets: () => SnapTargets,
    private readonly bowl: { minY: number; maxY: number },
  ) {
    this.root.eventMode = 'none'; // passive: the editor routes pointers here
    this.angleText = new Text({
      text: '',
      style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x14121f, width: 4 } },
      resolution: 3,
    });
    this.angleText.anchor.set(0.5, 1);
    this.angleText.visible = false;
    this.root.addChild(this.hoverG, this.guideG, this.frameG, this.angleText);
    layer.onChange(() => this.sync());
  }

  // ---- geometry ---------------------------------------------------------------

  private toLocal(o: TifoObject, wx: number, wy: number): [number, number] {
    let dx = wx - o.cx;
    if (this.wrapWidth > 0) dx -= this.wrapWidth * Math.round(dx / this.wrapWidth);
    const dy = wy - o.cy;
    const a = (o.rotation * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  private toWorld(o: { cx: number; cy: number; rotation: number }, lx: number, ly: number): [number, number] {
    const a = (o.rotation * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [o.cx + lx * c - ly * s, o.cy + lx * s + ly * c];
  }

  /** Offset of the turn handle below the object, in world units. */
  private rotateOffset(): number {
    return 28 / this.worldScale();
  }

  /** Too small on screen for eight handles: corners only. */
  private edgesShown(o: TifoObject): boolean {
    const k = this.worldScale();
    return o.width * k >= 44 && o.height * k >= 44;
  }

  /** The world-space bounding box of an object (rotated), for the action bar. */
  boundsOf(id: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const o = this.layer.get(id);
    if (!o) return null;
    const [aw, ah] = halfExtents(o);
    return { minX: o.cx - aw, minY: o.cy - ah, maxX: o.cx + aw, maxY: o.cy + ah + (o.locked ? 0 : this.rotateOffset()) };
  }

  // ---- drawing ------------------------------------------------------------------

  private outline(g: Graphics, o: TifoObject, color: number, width: number, dashed: boolean): void {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([fx, fy]) =>
      this.toWorld(o, (fx * o.width) / 2, (fy * o.height) / 2),
    );
    if (!dashed) {
      g.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
      g.stroke({ color, width, alpha: 0.95 });
      return;
    }
    const dash = 6 / this.worldScale();
    for (let k = 0; k < 4; k++) {
      const [x0, y0] = pts[k];
      const [x1, y1] = pts[k + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      for (let d = 0; d < len; d += dash * 2) {
        const e = Math.min(len, d + dash);
        g.moveTo(x0 + ((x1 - x0) * d) / len, y0 + ((y1 - y0) * d) / len).lineTo(x0 + ((x1 - x0) * e) / len, y0 + ((y1 - y0) * e) / len);
      }
    }
    g.stroke({ color, width, alpha: 0.9 });
  }

  /** Redraw the frame, the outlines and the guides. Cheap: a few dozen lines. */
  sync(): void {
    const k = this.worldScale();
    const line = 1.5 / k;
    this.hoverG.clear();
    this.frameG.clear();
    this.guideG.clear();
    const sel = this.layer.selected;
    for (const id of [this.hoverId, this.highlightId]) {
      if (!id || id === sel?.id) continue;
      const o = this.layer.get(id);
      if (o && !o.hidden) this.outline(this.hoverG, o, VIOLET, line, true);
    }
    if (sel && !sel.hidden) {
      this.outline(this.frameG, sel, sel.locked ? MUTED : VIOLET, (sel.locked ? 1.5 : 2) / k, !!sel.locked);
      if (!sel.locked) {
        const hs = 9 / k;
        const handles = this.edgesShown(sel) ? [...CORNERS, ...EDGES] : CORNERS;
        // The turn handle hangs below the object on a short stem — reachable on
        // touch, where there is no hover to reveal a rotate cursor.
        const [bx, by] = this.toWorld(sel, 0, sel.height / 2);
        const [rx, ry] = this.toWorld(sel, 0, sel.height / 2 + this.rotateOffset());
        this.frameG.moveTo(bx, by).lineTo(rx, ry).stroke({ color: VIOLET, width: line });
        this.frameG.circle(rx, ry, 6 / k).fill(0xffffff).stroke({ color: VIOLET, width: line * 1.4 });
        for (const h of handles) {
          const [fx, fy] = HANDLE_POS[h as keyof typeof HANDLE_POS];
          const [x, y] = this.toWorld(sel, (fx * sel.width) / 2, (fy * sel.height) / 2);
          this.frameG.rect(x - hs / 2, y - hs / 2, hs, hs).fill(0xffffff).stroke({ color: VIOLET, width: line * 1.2 });
        }
      }
    }
    if (this.guides.xs.length || this.guides.ys.length) {
      const top = this.bowl.minY - 40;
      const bottom = this.bowl.maxY + 40;
      for (const x of this.guides.xs) this.guideG.moveTo(x, top).lineTo(x, bottom);
      for (const y of this.guides.ys) this.guideG.moveTo(-40, y).lineTo(this.wrapWidth + 40, y);
      this.guideG.stroke({ color: GUIDE, width: 1 / k, alpha: 0.9 });
    }
    if (this.drag?.handle === 'rotate' && sel) {
      const [rx, ry] = this.toWorld(sel, 0, sel.height / 2 + this.rotateOffset());
      const deg = Math.round(((sel.rotation % 360) + 360) % 360);
      this.angleText.text = `${deg > 180 ? deg - 360 : deg}°`;
      this.angleText.scale.set(1 / k);
      this.angleText.position.set(rx, ry - 12 / k);
      this.angleText.visible = true;
    } else {
      this.angleText.visible = false;
    }
  }

  // ---- hit testing ------------------------------------------------------------------

  /** What is under a world point: a handle of the selection, or the topmost unlocked object. */
  hitTest(wx: number, wy: number, touch = false): OverlayHit | null {
    const k = this.worldScale();
    const r = (touch ? 22 : 9) / k;
    const sel = this.layer.selected;
    if (sel && !sel.hidden && !sel.locked) {
      const [lx, ly] = this.toLocal(sel, wx, wy);
      const hw = sel.width / 2;
      const hh = sel.height / 2;
      if (Math.hypot(lx, ly - (hh + this.rotateOffset())) <= r) return { id: sel.id, handle: 'rotate' };
      const handles = this.edgesShown(sel) ? [...CORNERS, ...EDGES] : CORNERS;
      for (const h of handles) {
        const [fx, fy] = HANDLE_POS[h as keyof typeof HANDLE_POS];
        if (Math.abs(lx - fx * hw) <= r && Math.abs(ly - fy * hh) <= r) return { id: sel.id, handle: h };
      }
      if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return { id: sel.id, handle: 'move' };
    }
    const list = this.layer.list();
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (o.hidden || o.locked) continue;
      const [lx, ly] = this.toLocal(o, wx, wy);
      if (Math.abs(lx) <= o.width / 2 && Math.abs(ly) <= o.height / 2) return { id: o.id, handle: 'move' };
    }
    return null;
  }

  /** Hover feedback: an outline on the object under the pointer. Returns what a press would grab. */
  hover(wx: number, wy: number): OverlayHit | null {
    const hit = this.hitTest(wx, wy);
    const id = hit?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.sync();
    }
    return hit;
  }

  clearHover(): void {
    if (this.hoverId === null) return;
    this.hoverId = null;
    this.sync();
  }

  /** Outline one layer (the Layers panel row under the pointer). */
  setHighlight(id: string | null): void {
    if (this.highlightId === id) return;
    this.highlightId = id;
    this.sync();
  }

  // ---- gestures -----------------------------------------------------------------------

  beginDrag(id: string, handle: Handle, wx: number, wy: number): void {
    const o = this.layer.get(id);
    if (!o || o.locked) return;
    this.layer.select(id);
    this.layer.beginGesture();
    this.drag = {
      id,
      handle,
      cx: o.cx,
      cy: o.cy,
      w: o.width,
      h: o.height,
      rot: o.rotation,
      ox: wx - o.cx,
      oy: wy - o.cy,
      startAngle: (Math.atan2(wy - o.cy, wx - o.cx) * 180) / Math.PI,
    };
    this.onGesture?.(true);
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  get dragHandle(): Handle | null {
    return this.drag?.handle ?? null;
  }

  /** Continue a gesture. Returns the new height while resizing (the panel's slider follows it). */
  updateDrag(wx: number, wy: number, mods: DragMods = {}): { resizedToHeight: number } | null {
    const d = this.drag;
    if (!d) return null;
    const o = this.layer.get(d.id);
    if (!o) return null;
    if (d.handle === 'move') {
      let cx = wx - d.ox;
      let cy = wy - d.oy;
      this.guides = { xs: [], ys: [] };
      if (!mods.ctrl) [cx, cy] = this.snap(o, cx, cy);
      this.layer.mutate(d.id, { cx, cy });
      return null;
    }
    if (d.handle === 'rotate') {
      const ang = (Math.atan2(wy - d.cy, wx - d.cx) * 180) / Math.PI;
      let rot = d.rot + (ang - d.startAngle);
      if (mods.shift) {
        rot = Math.round(rot / 15) * 15;
      } else {
        // A gentle pull to square: within 4° of a right angle, it is one.
        const near = Math.round(rot / 90) * 90;
        if (Math.abs(rot - near) < 4) rot = near;
      }
      rot = ((((rot + 180) % 360) + 360) % 360) - 180;
      this.layer.mutate(d.id, { rotation: Math.round(rot * 10) / 10 });
      return null;
    }
    return this.resize(d, wx, wy, mods);
  }

  private resize(d: DragState, wx: number, wy: number, mods: DragMods): { resizedToHeight: number } {
    const start = { cx: d.cx, cy: d.cy, rotation: d.rot };
    // The pointer in the object's frame as it was when the gesture began.
    const a = (d.rot * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let dx = wx - d.cx;
    if (this.wrapWidth > 0) dx -= this.wrapWidth * Math.round(dx / this.wrapWidth);
    const dy = wy - d.cy;
    const plx = dx * c + dy * s;
    const ply = -dx * s + dy * c;
    const [fx, fy] = HANDLE_POS[d.handle as keyof typeof HANDLE_POS];
    const MIN = 6;
    const fromCentre = !!mods.alt;
    // Anchor: the opposite handle, or the centre with Alt.
    const ax = fromCentre ? 0 : (-fx * d.w) / 2;
    const ay = fromCentre ? 0 : (-fy * d.h) / 2;
    let w = d.w;
    let h = d.h;
    const corner = fx !== 0 && fy !== 0;
    if (corner && !mods.shift) {
      // Keep the proportions: project the pointer onto the diagonal.
      const hx = (fx * d.w) / 2 - ax;
      const hy = (fy * d.h) / 2 - ay;
      const t = ((plx - ax) * hx + (ply - ay) * hy) / (hx * hx + hy * hy || 1);
      const k = Math.max(MIN / Math.min(d.w, d.h), t);
      w = d.w * k;
      h = d.h * k;
    } else {
      if (fx !== 0) w = Math.max(MIN, fromCentre ? Math.abs(plx) * 2 : Math.abs(plx - ax));
      if (fy !== 0) h = Math.max(MIN, fromCentre ? Math.abs(ply) * 2 : Math.abs(ply - ay));
    }
    // New centre, in the start frame, then back to the world.
    const lcx = fromCentre ? 0 : ax + (fx * w) / 2;
    const lcy = fromCentre ? 0 : ay + (fy * h) / 2;
    const [cx, cy] = this.toWorld(start, fx === 0 ? 0 : lcx, fy === 0 ? 0 : lcy);
    this.layer.mutate(d.id, { cx, cy, width: w, height: h });
    return { resizedToHeight: h };
  }

  /**
   * Snap a moving object's edges and centre to the stand edges, the middle of
   * the bowl and the other layers, within 7 screen pixels. Holding Ctrl
   * switches it off.
   */
  private snap(o: TifoObject, cx: number, cy: number): [number, number] {
    const thr = 7 / this.worldScale();
    const [aw, ah] = halfExtents(o);
    const targets = this.snapTargets();
    const xs = [...targets.xs];
    const ys = [...targets.ys];
    for (const p of this.layer.list()) {
      if (p.id === o.id || p.hidden) continue;
      const [pw, ph] = halfExtents(p);
      xs.push(p.cx - pw, p.cx, p.cx + pw);
      ys.push(p.cy - ph, p.cy, p.cy + ph);
    }
    const best = (cands: number[], lines: number[]): { delta: number; at: number } | null => {
      let out: { delta: number; at: number } | null = null;
      for (const c of cands) {
        for (const l of lines) {
          const delta = l - c;
          if (Math.abs(delta) <= thr && (!out || Math.abs(delta) < Math.abs(out.delta))) out = { delta, at: l };
        }
      }
      return out;
    };
    const bx = best([cx - aw, cx, cx + aw], xs);
    const by = best([cy - ah, cy, cy + ah], ys);
    if (bx) {
      cx += bx.delta;
      this.guides.xs.push(bx.at);
    }
    if (by) {
      cy += by.delta;
      this.guides.ys.push(by.at);
    }
    return [cx, cy];
  }

  endDrag(): boolean {
    const wasResize = !!this.drag && this.drag.handle !== 'move' && this.drag.handle !== 'rotate';
    const had = this.drag !== null;
    this.drag = null;
    this.guides = { xs: [], ys: [] };
    if (had) {
      this.layer.endGesture();
      this.onGesture?.(false);
    }
    this.sync();
    return wasResize;
  }

  /** Select the object at a world point, or clear selection if none. */
  selectAt(idOrNull: string | null): void {
    this.layer.select(idOrNull);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
}

/** The CSS cursor for a handle, allowing for the object's rotation. */
export function cursorFor(handle: Handle | null, rotation = 0): string {
  if (!handle) return 'crosshair';
  if (handle === 'move') return 'move';
  if (handle === 'rotate') return 'grab';
  const base: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const ang = (((base[handle] + rotation) % 180) + 180) % 180;
  const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  return names[Math.round(ang / 45) % 4];
}
