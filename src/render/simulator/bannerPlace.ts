import * as THREE from 'three';
import type { BannerStore, StandIndex } from '../../core/banner';
import { buildStandFrame, nearestOnFrame, type StandFrame } from './standFrame';
import type { SeatMap } from '../../core/types';

/**
 * Putting a banner where you want it, and snapping it where it belongs.
 *
 * Dragging is the obvious half and the smaller one. The half that matters is
 * that "exactly centred" should not require a steady hand at a hundred metres:
 * a banner meant for the middle of the Kop is never *approximately* in the
 * middle, and a designer who has to nudge it for a minute will settle for
 * nearly. So the drag runs through a magnet with a handful of targets that are
 * all things the stadium actually has — the stand's centre, the halfway line,
 * the line the main camera looks down, the boundaries between sections, the
 * top of each tier — and every one of them draws its own guide and says what
 * it is when it engages.
 *
 * The magnet's threshold is in SCREEN pixels, not metres, so it feels the same
 * whether you are looking at the whole bowl or at one block.
 */

export interface SnapHit {
  /** Which axis it caught: along the stand, or up it. */
  axis: 'along' | 'up';
  /** The snapped value in stand coordinates. */
  at: number;
  /** i18n key under `bn.snap.` for the label the guide shows. */
  key: string;
}

export interface DragResult {
  alongU: number;
  heightV: number;
  snaps: SnapHit[];
}

/** Pixels of magnet. Wide enough to be findable, narrow enough to escape. */
const SNAP_PX = 22;

export interface PlacementHelper {
  readonly object: THREE.Group;
  frameFor(stand: StandIndex): StandFrame;
  /** Start dragging a banner. Returns false if the pointer missed the stand. */
  begin(id: string, raycaster: THREE.Raycaster): boolean;
  /** Continue a drag. Returns the snapped stand coordinates it settled on. */
  move(raycaster: THREE.Raycaster, camera: THREE.Camera, viewportH: number): DragResult | null;
  end(): void;
  readonly dragging: boolean;
  /** Draw (or clear) the guide lines for a set of snaps. */
  showGuides(stand: StandIndex, snaps: SnapHit[]): void;
  dispose(): void;
}

export function buildPlacement(map: SeatMap, bannerStore: BannerStore, sectionsPerTier: number): PlacementHelper {
  const object = new THREE.Group();
  object.name = 'banner-placement';

  const frames = new Map<StandIndex, StandFrame>();
  const frameFor = (stand: StandIndex): StandFrame => {
    let f = frames.get(stand);
    if (!f) {
      f = buildStandFrame(map, stand);
      frames.set(stand, f);
    }
    return f;
  };

  // An invisible copy of the stand's face, which is what a drag actually hits.
  // Raycasting the seats themselves would drop the pointer between two rows of
  // seat boxes and the banner would jump; raycasting a flat plane would ignore
  // the rake and the curve, and the banner would slide off the stand.
  const proxyGeo = new THREE.BufferGeometry();
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  const proxy = new THREE.Mesh(proxyGeo, proxyMat);
  proxy.frustumCulled = false;
  object.add(proxy);

  const guideGeo = new THREE.BufferGeometry();
  guideGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 2 * 3), 3));
  const guideMat = new THREE.LineBasicMaterial({ color: 0xff5db1, transparent: true, opacity: 0.92, depthTest: false });
  const guides = new THREE.LineSegments(guideGeo, guideMat);
  guides.frustumCulled = false;
  guides.renderOrder = 7;
  guides.visible = false;
  object.add(guides);

  let dragId: string | null = null;
  let dragStand: StandIndex = 1;
  let grabAlong = 0;
  let grabUp = 0;

  function fitProxyTo(stand: StandIndex): void {
    const f = frameFor(stand);
    const g = f.surfaceGrid(40, 14);
    proxyGeo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    proxyGeo.setIndex(new THREE.BufferAttribute(g.indices, 1));
    proxyGeo.computeBoundingSphere();
  }

  /**
   * Everything a banner can snap to on this stand.
   *
   * `sectionsPerTier` is the bowl's own idea of how it is divided — the same
   * number the editor's section strip uses — so a banner snaps to the edges of
   * the blocks people actually stand in rather than to an arbitrary grid.
   */
  function targets(stand: StandIndex): { along: SnapHit[]; up: SnapHit[] } {
    const along: SnapHit[] = [
      { axis: 'along', at: 0.5, key: 'centre' },
      { axis: 'along', at: 0.25, key: 'quarter' },
      { axis: 'along', at: 0.75, key: 'quarter' },
      { axis: 'along', at: 0.02, key: 'end' },
      { axis: 'along', at: 0.98, key: 'end' },
    ];
    // Section boundaries. Only for a stand divided into few enough blocks that
    // the magnets do not merge into a continuous sheet of magnetism.
    const perStand = Math.round(sectionsPerTier / 4);
    if (perStand >= 2 && perStand <= 10) {
      for (let k = 1; k < perStand; k++) along.push({ axis: 'along', at: k / perStand, key: 'section' });
    }
    // The centre of a SIDE stand is the halfway line, and the main camera looks
    // straight down it: for a banner on the side, that is the one position that
    // is framed flat rather than obliquely. For an end stand it is the goal
    // centre line. Same number, different reason, so it gets its own label.
    along.push({ axis: 'along', at: 0.5, key: stand === 1 || stand === 3 ? 'halfway' : 'goal' });

    const f = frameFor(stand);
    const up: SnapHit[] = [
      { axis: 'up', at: 0, key: 'rail' },
      { axis: 'up', at: 1, key: 'back' },
      { axis: 'up', at: 0.5, key: 'middle' },
    ];
    // The top of each tier, which is where a real drop banner is tied off.
    const tiers = new Set<number>();
    for (let i = 0; i < map.count; i++) tiers.add(map.tierOf[i]);
    const list = [...tiers].sort((a, b) => a - b);
    for (const tRaw of list) {
      let maxY = -Infinity;
      for (let i = 0; i < map.count; i++) {
        if (map.tierOf[i] !== tRaw) continue;
        const y = map.pos3[i * 3 + 1];
        if (y > maxY) maxY = y;
      }
      if (!isFinite(maxY)) continue;
      const v = (maxY - f.minY) / Math.max(1, f.heightM);
      if (v > 0.06 && v < 0.97) up.push({ axis: 'up', at: v, key: 'tier' });
    }
    return { along, up };
  }

  /** How many stand-units one screen pixel is worth, near the banner. */
  function unitsPerPixel(stand: StandIndex, camera: THREE.Camera, viewportH: number): { along: number; up: number } {
    const f = frameFor(stand);
    const a = f.pointAt(0.5, 0.5);
    const p = new THREE.Vector3(a.x, a.y, a.z);
    const cam = camera as THREE.PerspectiveCamera;
    const dist = cam.position.distanceTo(p) || 1;
    const fov = ((cam.isPerspectiveCamera ? cam.fov : 50) * Math.PI) / 180;
    const metresPerPixel = (2 * Math.tan(fov / 2) * dist) / Math.max(1, viewportH);
    return {
      along: metresPerPixel / Math.max(1, f.widthM),
      up: metresPerPixel / Math.max(1, f.heightM),
    };
  }

  function applySnap(stand: StandIndex, alongU: number, heightV: number, upp: { along: number; up: number }): DragResult {
    const t = targets(stand);
    const snaps: SnapHit[] = [];
    let a = alongU;
    let v = heightV;
    const tolA = SNAP_PX * upp.along;
    const tolV = SNAP_PX * upp.up;
    let bestA: SnapHit | null = null;
    let bestV: SnapHit | null = null;
    for (const s of t.along) {
      const d = Math.abs(alongU - s.at);
      if (d < tolA && (!bestA || d < Math.abs(alongU - bestA.at))) bestA = s;
    }
    for (const s of t.up) {
      const d = Math.abs(heightV - s.at);
      if (d < tolV && (!bestV || d < Math.abs(heightV - bestV.at))) bestV = s;
    }
    if (bestA) {
      a = bestA.at;
      snaps.push(bestA);
    }
    if (bestV) {
      v = bestV.at;
      snaps.push(bestV);
    }
    return { alongU: a, heightV: v, snaps };
  }

  function showGuides(stand: StandIndex, snaps: SnapHit[]): void {
    const arr = guideGeo.attributes.position.array as Float32Array;
    if (snaps.length === 0) {
      guides.visible = false;
      return;
    }
    const f = frameFor(stand);
    let seg = 0;
    const put = (a: THREE.Vector3, b: THREE.Vector3): void => {
      const o = seg * 6;
      if (o + 5 >= arr.length) return;
      arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
      arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
      seg++;
    };
    const P = (u: number, v: number): THREE.Vector3 => {
      const p = f.pointAt(u, v);
      return new THREE.Vector3(p.x + p.ox * 1.4, p.y + 1.4, p.z + p.oz * 1.4);
    };
    for (const s of snaps) {
      if (s.axis === 'along') {
        // A vertical guide is drawn as several short segments so it follows the
        // rake instead of cutting through the stand.
        for (let k = 0; k < 4; k++) put(P(s.at, k / 4), P(s.at, (k + 1) / 4));
      } else {
        for (let k = 0; k < 4; k++) put(P(k / 4, s.at), P((k + 1) / 4, s.at));
      }
    }
    for (let k = seg; k < arr.length / 6; k++) {
      const o = k * 6;
      for (let q = 0; q < 6; q++) arr[o + q] = 0;
    }
    guideGeo.attributes.position.needsUpdate = true;
    guides.visible = true;
  }

  return {
    object,
    frameFor,
    get dragging() {
      return dragId !== null;
    },
    begin(id, raycaster) {
      const doc = bannerStore.get(id);
      if (!doc) return false;
      dragStand = doc.place.stand;
      fitProxyTo(dragStand);
      const hit = raycaster.intersectObject(proxy, false)[0];
      if (!hit) return false;
      const at = nearestOnFrame(frameFor(dragStand), hit.point.x, hit.point.y, hit.point.z);
      // Grab offsets, so the banner does not jump its centre to the cursor —
      // you are moving the sheet, not teleporting it.
      // Dragging a block-placed banner moves it a block at a time, so the
      // grab offset is measured from where it actually IS rather than from a
      // free coordinate it is no longer using.
      grabAlong = doc.place.blockSpan > 0 ? 0 : doc.place.alongU - at.alongU;
      grabUp = doc.place.blockSpan > 0 ? 0 : doc.place.heightV - at.heightV;
      dragId = id;
      return true;
    },
    move(raycaster, camera, viewportH) {
      if (!dragId) return null;
      const hit = raycaster.intersectObject(proxy, false)[0];
      if (!hit) return null;
      const at = nearestOnFrame(frameFor(dragStand), hit.point.x, hit.point.y, hit.point.z);
      const raw = { alongU: at.alongU + grabAlong, heightV: at.heightV + grabUp };
      const doc = bannerStore.get(dragId);
      if (!doc) return null;
      if (!doc.place.snap) {
        showGuides(dragStand, []);
        return { alongU: clamp01(raw.alongU), heightV: clamp(raw.heightV, 0, 1.2), snaps: [] };
      }
      const res = applySnap(dragStand, clamp01(raw.alongU), clamp(raw.heightV, 0, 1.2), unitsPerPixel(dragStand, camera, viewportH));
      showGuides(dragStand, res.snaps);
      return res;
    },
    end() {
      dragId = null;
      guides.visible = false;
    },
    showGuides,
    dispose() {
      proxyGeo.dispose();
      proxyMat.dispose();
      guideGeo.dispose();
      guideMat.dispose();
      frames.clear();
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
