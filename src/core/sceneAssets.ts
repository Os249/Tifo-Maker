/**
 * Scene assets — the layered-design foundation (Wave F: F1 schema + F2 store).
 *
 * Today a design is a card mosaic (DesignStore: cells + palette). Real tifos add
 * PRINTED SURFACES on top — banners, drapes, flags, scarves, floor banners. This
 * module is the single data model for those overlay objects, plus an in-memory
 * store with change events (mirroring DesignStore's pattern).
 *
 * Scope note: this is pure, additive data. NOTHING imports it yet, so it cannot
 * affect the live editor or save/load. Server persistence of the scene (saving
 * assets with a design) is deliberately staged for a later, test-gated step —
 * a blind change to the live save path could break every existing design.
 */

export type AssetType = 'banner' | 'surface' | 'flag' | 'scarf' | 'floor';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where an asset attaches, for auto-placement from the seat map. */
export interface AssetAnchor {
  stand?: 0 | 1 | 2 | 3; // 0 E, 1 N, 2 W, 3 S
  tier?: number;
  corner?: boolean;
  pitch?: boolean;
}

export interface SceneAsset {
  id: string;
  type: AssetType;
  anchor?: AssetAnchor;
  /** World position in simulator metres. */
  position: Vec3;
  /** Yaw in radians (0 = facing bowl centre when placed by anchor). */
  rotationY: number;
  scale: Vec3;
  /** Image asset reference (data URL or stored id); null = solid colour. */
  imageRef?: string | null;
  /** Tint / fallback colour (hex). */
  color?: string;
  /** Text for auto-generated text banners. */
  text?: string | null;
  /** Cloth/sag + waving animation. */
  cloth?: boolean;
  /** Unfurl progress 0..1 (1 = fully shown); drives the drop-down reveal. */
  unfurl?: number;
  /** Draw/stack order. */
  order?: number;
  visible?: boolean;
  /** Editor-placed banner: zone-snap placement the simulator resolves on open. */
  place?: 'surface' | 'big' | 'small' | 'floor' | 'gap' | 'stairs';
}

export interface SceneModel {
  version: 1;
  assets: SceneAsset[];
}

export function emptyScene(): SceneModel {
  return { version: 1, assets: [] };
}

let counter = 0;
function newId(): string {
  return `as_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

export type AssetInit = Partial<Omit<SceneAsset, 'id' | 'type'>>;

/** In-memory store for scene assets. One instance is shared by editor + simulator. */
export class AssetStore {
  private assets: SceneAsset[] = [];
  private listeners: (() => void)[] = [];
  private selectedId: string | null = null;

  list(): readonly SceneAsset[] {
    return this.assets;
  }
  get(id: string): SceneAsset | undefined {
    return this.assets.find((a) => a.id === id);
  }
  get selectedId_(): string | null {
    return this.selectedId;
  }
  get selected(): SceneAsset | undefined {
    return this.selectedId ? this.get(this.selectedId) : undefined;
  }

  add(type: AssetType, init: AssetInit = {}): SceneAsset {
    const a: SceneAsset = {
      id: newId(),
      type,
      anchor: init.anchor,
      position: init.position ?? { x: 0, y: 10, z: 0 },
      rotationY: init.rotationY ?? 0,
      scale: init.scale ?? { x: 1, y: 1, z: 1 },
      imageRef: init.imageRef ?? null,
      color: init.color,
      text: init.text ?? null,
      cloth: init.cloth ?? false,
      unfurl: init.unfurl ?? 1,
      order: init.order ?? this.assets.length,
      visible: init.visible ?? true,
      place: init.place,
    };
    this.assets.push(a);
    this.selectedId = a.id;
    this.emit();
    return a;
  }

  update(id: string, patch: Partial<SceneAsset>): void {
    const a = this.get(id);
    if (!a) return;
    Object.assign(a, patch);
    this.emit();
  }

  remove(id: string): void {
    const i = this.assets.findIndex((a) => a.id === id);
    if (i < 0) return;
    this.assets.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.emit();
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.emit();
  }

  clear(): void {
    this.assets = [];
    this.selectedId = null;
    this.emit();
  }

  /** Subscribe to any change; returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  toJSON(): SceneModel {
    return { version: 1, assets: this.assets.map((a) => ({ ...a })) };
  }
  loadJSON(m: SceneModel | null | undefined): void {
    this.assets = m && Array.isArray(m.assets) ? m.assets.map((a) => ({ ...a })) : [];
    this.selectedId = null;
    this.emit();
  }
}
