import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { ObjectLayer, TifoObject } from '../core/objects';
import { renderObjectCanvas } from '../core/objects';

/**
 * Renders the floating ObjectLayer above the seat grid inside the editor's
 * world container, and owns the drag/resize/select interactions. Objects show
 * at 65% alpha with a violet selection frame + corner resize handle. Hit-testing
 * and gesture math run in WORLD (editor xy) space, which the editor converts to
 * from screen coordinates — so dragging tracks the cursor under any pan/zoom.
 */

interface SpriteEntry {
  sprite: Sprite;
  frame: Graphics;
  textureKey: string;
}

export class ObjectOverlay {
  readonly root = new Container();
  private entries = new Map<string, SpriteEntry>();
  /** Active gesture: which object, what mode, and the grab offset. */
  private drag: { id: string; mode: 'move' | 'resize'; ox: number; oy: number; aspect: number } | null = null;

  constructor(
    private readonly layer: ObjectLayer,
    private readonly worldScale: () => number,
  ) {
    this.root.eventMode = 'none'; // overlay itself is passive; editor routes pointers
    layer.onChange(() => this.sync());
  }

  /** Texture cache key — text re-renders when content/font/arc change. */
  private keyFor(obj: TifoObject): string {
    return obj.kind === 'text'
      ? `t:${obj.text}:${obj.fontId}:${obj.arcDeg}`
      : `i:${obj.id}`;
  }

  /** Reconcile sprites with the layer's current objects + selection. */
  sync(): void {
    const seen = new Set<string>();
    const objects = this.layer.list();
    // Draw order = array order (bake order); reflect via zIndex.
    this.root.sortableChildren = true;
    objects.forEach((obj, i) => {
      seen.add(obj.id);
      let entry = this.entries.get(obj.id);
      const key = this.keyFor(obj);
      if (!entry || entry.textureKey !== key) {
        if (entry) {
          entry.sprite.destroy({ texture: true, textureSource: true });
          entry.frame.destroy();
        }
        const source = renderObjectCanvas(obj);
        const sprite = source ? new Sprite(Texture.from(source)) : new Sprite(Texture.EMPTY);
        sprite.alpha = 0.65;
        sprite.eventMode = 'none';
        const frame = new Graphics();
        frame.eventMode = 'none';
        this.root.addChild(sprite);
        this.root.addChild(frame);
        entry = { sprite, frame, textureKey: key };
        this.entries.set(obj.id, entry);
      }
      const { sprite, frame } = entry;
      sprite.zIndex = i * 2;
      frame.zIndex = i * 2 + 1;
      sprite.width = obj.width;
      sprite.height = obj.height;
      sprite.position.set(obj.cx - obj.width / 2, obj.cy - obj.height / 2);

      frame.clear();
      if (this.layer.selected?.id === obj.id) {
        const hx = obj.cx + obj.width / 2;
        const hy = obj.cy + obj.height / 2;
        frame
          .rect(obj.cx - obj.width / 2, obj.cy - obj.height / 2, obj.width, obj.height)
          .stroke({ color: 0x8b7cff, width: 2 / this.worldScale(), pixelLine: false });
        const hs = 12 / this.worldScale();
        frame.rect(hx - hs, hy - hs, hs, hs).fill(0x8b7cff); // bottom-right resize handle
      }
    });
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.sprite.destroy({ texture: true, textureSource: true });
        entry.frame.destroy();
        this.entries.delete(id);
      }
    }
  }

  /** Hit-test in world coords: returns {id, onHandle} or null. Topmost first. */
  hitTest(wx: number, wy: number): { id: string; onHandle: boolean } | null {
    const objects = this.layer.list();
    const hs = 14 / this.worldScale();
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      const left = o.cx - o.width / 2;
      const top = o.cy - o.height / 2;
      const right = o.cx + o.width / 2;
      const bottom = o.cy + o.height / 2;
      // Resize handle (bottom-right) takes priority when this object is selected.
      if (this.layer.selected?.id === o.id) {
        if (Math.abs(wx - right) <= hs && Math.abs(wy - bottom) <= hs) return { id: o.id, onHandle: true };
      }
      if (wx >= left && wx <= right && wy >= top && wy <= bottom) return { id: o.id, onHandle: false };
    }
    return null;
  }

  /** Begin a move/resize gesture on an object at world point (wx, wy). */
  beginDrag(id: string, onHandle: boolean, wx: number, wy: number): void {
    const o = this.layer.list().find((x) => x.id === id);
    if (!o) return;
    this.layer.select(id);
    this.layer.beginGesture();
    this.drag = {
      id,
      mode: onHandle ? 'resize' : 'move',
      ox: wx - o.cx,
      oy: wy - o.cy,
      aspect: o.width / o.height,
    };
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** Continue an active gesture to world point (wx, wy). Returns the resize ratio if resizing. */
  updateDrag(wx: number, wy: number): { resizedToHeight: number } | null {
    if (!this.drag) return null;
    const o = this.layer.selected;
    if (!o) return null;
    if (this.drag.mode === 'move') {
      this.layer.mutateSelected({ cx: wx - this.drag.ox, cy: wy - this.drag.oy });
      return null;
    }
    // Resize from center, preserving aspect, driven by distance to the dragged corner.
    const newW = Math.max(16, (wx - o.cx) * 2);
    const newH = Math.max(8, newW / this.drag.aspect);
    this.layer.mutateSelected({ width: newW, height: newH });
    return { resizedToHeight: newH };
  }

  endDrag(): boolean {
    const wasResize = this.drag?.mode === 'resize';
    this.drag = null;
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
