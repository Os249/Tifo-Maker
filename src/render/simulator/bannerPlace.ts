import * as THREE from 'three';
import type { BannerStore, StandIndex } from '../../core/banner';
import { spanFrameCache, nearestOnFrame, type StandFrame } from './standFrame';
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

export interface PlacementHelper {
  readonly object: THREE.Group;
  frameFor(stand: StandIndex, stands?: number): StandFrame;
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

export function buildPlacement(map: SeatMap, bannerStore: BannerStore, _sectionsPerTier = 0): PlacementHelper {
  const object = new THREE.Group();
  object.name = 'banner-placement';

  // Keyed by stand AND how many stands the window covers, because a banner
  // that carries on round the corner is drawn against a frame twice as wide.
  const frameFor: (stand: StandIndex, stands?: number) => StandFrame = spanFrameCache(map);

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
  let dragStands = 1;
  let grabAlong = 0;
  let grabUp = 0;

  function fitProxyTo(stand: StandIndex, stands = 1): void {
    const f = frameFor(stand, stands);
    const g = f.surfaceGrid(40 * stands, 14);
    proxyGeo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    proxyGeo.setIndex(new THREE.BufferAttribute(g.indices, 1));
    proxyGeo.computeBoundingSphere();
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
      dragStand = doc.slot.stand;
      dragStands = doc.slot.stands;
      fitProxyTo(dragStand, dragStands);
      const hit = raycaster.intersectObject(proxy, false)[0];
      if (!hit) return false;
      nearestOnFrame(frameFor(dragStand, dragStands), hit.point.x, hit.point.y, hit.point.z);
      // No grab offset. A banner is on a run of blocks, so dragging it is
      // choosing blocks rather than sliding a sheet: the block under the
      // pointer is the block you meant, and an offset would mean the banner
      // landed one along from wherever you pointed.
      grabAlong = 0;
      grabUp = 0;
      dragId = id;
      return true;
    },
    move(raycaster, camera, viewportH) {
      if (!dragId) return null;
      const hit = raycaster.intersectObject(proxy, false)[0];
      if (!hit) return null;
      const at = nearestOnFrame(frameFor(dragStand, dragStands), hit.point.x, hit.point.y, hit.point.z);
      const raw = { alongU: at.alongU + grabAlong, heightV: at.heightV + grabUp };
      const doc = bannerStore.get(dragId);
      if (!doc) return null;
      // The blocks ARE the snap, so there is nothing left to magnetise to and
      // no guide to draw. A continuous slider with a magnet on it was the
      // wrong answer to "it does not line up with anything"; lining up with
      // the aisles by construction is the right one.
      void camera;
      void viewportH;
      showGuides(dragStand, []);
      return { alongU: clamp01(raw.alongU), heightV: clamp(raw.heightV, 0, 1.2), snaps: [] };
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
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
