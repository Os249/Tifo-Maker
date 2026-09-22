import * as THREE from 'three';
import type { BannerDoc, BannerStore, StandIndex } from '../../core/banner';
import { revealEase } from '../../core/banner';
import { bannerToCanvas, onBannerImageReady } from '../bannerRender';
import type { StandFrame } from './standFrame';
import { resolveSlot, hangAnchorY, type ResolvedSlot } from './bannerSlot';
import {
  buildSurface, buildNormals, surfaceIndices, surfaceUVs, columnsU,
  SURF_COLS, SURF_ROWS, SURF_VERTS, type SurfaceEnv,
} from './bannerSurface';

/**
 * Banners in the bowl.
 *
 * This used to be sixteen hundred lines: an XPBD cloth solver, a baked
 * heightfield collider, a rope net, a lashing pass and a lot of care about
 * the order constraints were applied in. It is now a mesh whose vertices come
 * from a pure function of (slot, time). The solver is gone, and with it every
 * bug that could only be described as a story about what happened on frame
 * four hundred.
 *
 * What is left here is only what a renderer has to do: own the Three.js
 * objects, keep the texture cache, run the reveal clock, and draw the rope
 * and the weight bar. The shape itself belongs to `bannerSurface`, which has
 * no Three.js in it and is checked exhaustively — every slot, on every ground,
 * for both kinds — by `npm run sweep:banner`.
 */

export interface BannerRigLayer {
  readonly object: THREE.Group;
  refresh(): void;
  /** Advance the reveal clock. `dt` is real seconds since the last frame. */
  update(elapsed: number, dt: number): void;
  play(id?: string): void;
  setProgress(id: string, p: number): void;
  /**
   * Bring the banners to a given time without drawing.
   *
   * Kept for the shot harness, and now almost free: the shape is a function
   * of the clock, so there is no history to run forward and a still is
   * settled the moment it is asked for.
   */
  settle(seconds: number): void;
  pick(raycaster: THREE.Raycaster): string | null;
  select(id: string | null): void;
  census(): { banners: number; ropes: number; nets: number; bars: number; poles: number; particles: number };
  /**
   * Deepest any banner is inside its stand, in metres.
   *
   * Zero by construction — a stand banner's vertices ARE points of the stand
   * pushed out along its own normal — and measured anyway, because a gate
   * that trusts the construction it is gating is not a gate.
   */
  worstPenetration(): number;
  /** Retained for the harness. There is no solver left to sag. */
  worstSag(): number;
  /** World-space box the fabric occupies, for framing and for tests. */
  bounds(id: string): { min: [number, number, number]; max: [number, number, number] } | null;
  dispose(): void;
}

const ROPE_COLOR = 0xd8d2c4;
const BAR_COLOR = 0x2b2f36;
/** Fabric thickness above the concrete: what "inside the stand" means. */
const SOLID_CLEARANCE = 0.03;

interface Rig {
  doc: BannerDoc;
  /**
   * The stand and kind this rig was BUILT for.
   *
   * Scalars, copied at build time, and that is the whole point. The store
   * patches a banner in place — `patchSlot` assigns to `a.slot` on the same
   * document object — so the rig's `doc` and the document arriving in
   * `refresh` are the same object, and `existing.doc.slot.stand !== doc.slot.stand`
   * compared a number with itself and was never true. Changing the stand in
   * the panel therefore did nothing at all: the banner kept being drawn
   * against the frame of the stand it started on. Changing the TYPE was
   * silently broken the same way, so a banner switched to hanging kept its
   * old rigging.
   */
  standOf: StandIndex;
  kindOf: BannerDoc['kind'];
  barOf: boolean;
  slot: ResolvedSlot;
  frame: StandFrame;
  group: THREE.Group;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  pos: Float32Array;
  nrm: Float32Array;
  texKey: string;
  ropes: THREE.LineSegments | null;
  bar: THREE.Mesh | null;
  outline: THREE.LineSegments;
  /** Reveal progress 0..1, how long it takes, and when it started. */
  prog: number;
  playing: boolean;
  t0: number;
  durationS: number;
}

function textureKey(doc: BannerDoc): string {
  const art = JSON.stringify(doc.items);
  return `${doc.id}|${doc.material}|${doc.bg ?? '-'}|${art.length}|${hash(art)}`;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function revealSeconds(doc: BannerDoc): number {
  return Math.max(0.2, doc.revealMs / 1000);
}

export function buildBannerRigs(
  bannerStore: BannerStore,
  frameFor: (stand: StandIndex) => StandFrame,
  /** Crowd fill 0..1, live: a banner over a full block rests on people. */
  crowdFill: () => number = () => 0,
): BannerRigLayer {
  const root = new THREE.Group();
  root.name = 'banners';
  const rigs = new Map<string, Rig>();
  const texCache = new Map<string, THREE.Texture>();
  let elapsed = 0;
  let selectedId: string | null = null;

  const INDICES = surfaceIndices();
  const UVS = surfaceUVs();
  const colU = new Float64Array(SURF_COLS);

  function texture(doc: BannerDoc): THREE.Texture {
    const key = textureKey(doc);
    const hit = texCache.get(key);
    if (hit) return hit;
    const canvas = bannerToCanvas(doc, { maxEdge: 1024, perforate: true });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    texCache.set(key, tex);
    if (texCache.size > 12) {
      for (const [k, t] of texCache) {
        if (k === key) continue;
        t.dispose();
        texCache.delete(k);
        if (texCache.size <= 12) break;
      }
    }
    return tex;
  }

  function envOf(rig: Rig): SurfaceEnv {
    return {
      frame: rig.frame,
      crowdFill: crowdFill(),
      wind: rig.doc.wind,
      // EASED, not linear. The easing curves were written and gate-tested and
      // then never reached the renderer, so every reveal ran at a constant
      // rate: an unroll that should start slow and run away as the roll pays
      // out crept down the stand instead, and a banner lowered on ropes
      // arrived without the settle that makes it read as having weight.
      progress: revealEase(rig.doc.reveal, rig.prog),
    };
  }

  function makeRig(doc: BannerDoc): Rig {
    const frame = frameFor(doc.slot.stand);
    const slot = resolveSlot(doc, frame);
    const group = new THREE.Group();
    group.name = `banner:${doc.id}`;

    const pos = new Float32Array(SURF_VERTS * 3);
    const nrm = new Float32Array(SURF_VERTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(UVS, 2));
    geo.setIndex(new THREE.BufferAttribute(INDICES, 1));

    // Lit, with the artwork also carried as emission.
    //
    // It was unlit, and that is why a banner read as a painted board and why
    // the wind looked like nothing: with no shading term, moving the surface
    // changes no pixel except at the silhouette. The fabric was rippling the
    // whole time and there was no way to see it.
    //
    // Emission at just over half keeps the design legible in any light — a
    // tifo is the brightest thing in the ground and must never go to mud on
    // the far side of a curve — while the diffuse half picks up the
    // floodlights and, with it, every fold the wave puts in the sheet.
    const tex = texture(doc);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.58,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: 0.02,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `banner-mesh:${doc.id}`;
    mesh.userData.bannerId = doc.id;
    mesh.frustumCulled = false;
    group.add(mesh);

    const outline = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9, depthTest: false }),
    );
    outline.visible = false;
    outline.renderOrder = 6;
    outline.frustumCulled = false;
    (outline.geometry as THREE.BufferGeometry).setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array((SURF_COLS + SURF_ROWS) * 4 * 3), 3),
    );
    group.add(outline);

    // Rope for anything flown, a weighted bar for anything with one in the
    // hem. Both are geometry the eye uses to read how the sheet is held.
    let ropes: THREE.LineSegments | null = null;
    if (doc.kind === 'hanging') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 2 * 3), 3));
      ropes = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: ROPE_COLOR }));
      ropes.frustumCulled = false;
      group.add(ropes);
    }
    let bar: THREE.Mesh | null = null;
    if (doc.weightBar) {
      bar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 1, 6),
        new THREE.MeshBasicMaterial({ color: BAR_COLOR }),
      );
      bar.frustumCulled = false;
      group.add(bar);
    }

    root.add(group);
    const rig: Rig = {
      doc, standOf: doc.slot.stand, kindOf: doc.kind, barOf: doc.weightBar,
      slot, frame, group, mesh, geo, mat, pos, nrm,
      texKey: textureKey(doc), ropes, bar, outline,
      prog: 1, playing: false, t0: 0, durationS: revealSeconds(doc),
    };
    writeGeometry(rig);
    return rig;
  }

  /** One pass: vertices, normals, hardware, outline. */
  function writeGeometry(rig: Rig): void {
    if (!rig.frame.ok) return;
    buildSurface(rig.doc, rig.slot, envOf(rig), elapsed, rig.pos);
    buildNormals(rig.pos, rig.nrm);
    (rig.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (rig.geo.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
    rig.geo.computeBoundingSphere();
    updateHardware(rig);
    if (rig.outline.visible) updateOutline(rig);
  }

  function vert(rig: Rig, i: number, j: number, out: THREE.Vector3): THREE.Vector3 {
    const k = (j * SURF_COLS + i) * 3;
    return out.set(rig.pos[k], rig.pos[k + 1], rig.pos[k + 2]);
  }

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();

  function updateHardware(rig: Rig): void {
    if (rig.ropes) {
      // Two lines from the anchor up to the steel, at the sheet's top corners.
      const anchorY = hangAnchorY(rig.frame, rig.slot);
      const topY = Math.max(anchorY, rig.frame.roofY);
      const p = (rig.ropes.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      vert(rig, 0, 0, vA);
      vert(rig, SURF_COLS - 1, 0, vB);
      p[0] = vA.x; p[1] = vA.y; p[2] = vA.z;
      p[3] = vA.x; p[4] = topY; p[5] = vA.z;
      p[6] = vB.x; p[7] = vB.y; p[8] = vB.z;
      p[9] = vB.x; p[10] = topY; p[11] = vB.z;
      (rig.ropes.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      rig.ropes.visible = topY > anchorY + 0.2;
    }
    if (rig.bar) {
      vert(rig, 0, SURF_ROWS - 1, vA);
      vert(rig, SURF_COLS - 1, SURF_ROWS - 1, vB);
      const len = vA.distanceTo(vB);
      rig.bar.position.copy(vA).add(vB).multiplyScalar(0.5);
      rig.bar.scale.set(1, Math.max(0.1, len), 1);
      rig.bar.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        vB.clone().sub(vA).normalize(),
      );
      // A bar in a hem that is still rolled up has nothing to be straight
      // along, so it only appears once the sheet is most of the way out.
      rig.bar.visible = rig.prog > 0.35;
    }
  }

  function updateOutline(rig: Rig): void {
    const g = rig.outline.geometry as THREE.BufferGeometry;
    const p = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    let k = 0;
    const seg = (ai: number, aj: number, bi: number, bj: number): void => {
      vert(rig, ai, aj, vA);
      vert(rig, bi, bj, vB);
      p[k++] = vA.x; p[k++] = vA.y; p[k++] = vA.z;
      p[k++] = vB.x; p[k++] = vB.y; p[k++] = vB.z;
    };
    for (let i = 1; i < SURF_COLS; i++) {
      seg(i - 1, 0, i, 0);
      seg(i - 1, SURF_ROWS - 1, i, SURF_ROWS - 1);
    }
    for (let j = 1; j < SURF_ROWS; j++) {
      seg(0, j - 1, 0, j);
      seg(SURF_COLS - 1, j - 1, SURF_COLS - 1, j);
    }
    while (k < p.length) p[k++] = p[k - 3];
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
  }

  function disposeRig(r: Rig): void {
    root.remove(r.group);
    r.geo.dispose();
    r.mat.dispose();
    (r.outline.geometry as THREE.BufferGeometry).dispose();
    (r.outline.material as THREE.Material).dispose();
    if (r.ropes) {
      r.ropes.geometry.dispose();
      (r.ropes.material as THREE.Material).dispose();
    }
    if (r.bar) {
      r.bar.geometry.dispose();
      (r.bar.material as THREE.Material).dispose();
    }
  }

  function refresh(): void {
    const live = new Set(bannerStore.list().map((b) => b.id));
    for (const [id, r] of [...rigs]) {
      if (!live.has(id)) {
        disposeRig(r);
        rigs.delete(id);
      }
    }
    for (const doc of bannerStore.list()) {
      const existing = rigs.get(doc.id);
      if (!existing) {
        rigs.set(doc.id, makeRig(doc));
        continue;
      }
      // Nothing has to be rebuilt when a banner changes: the mesh has a fixed
      // topology and the shape is recomputed from the document every frame.
      // Moving a banner across the stand is a different `slot` and the same
      // vertices — which is why changing its size cannot break it any more.
      if (existing.standOf !== doc.slot.stand) {
        existing.frame = frameFor(doc.slot.stand);
        existing.standOf = doc.slot.stand;
      }
      const kindChanged = existing.kindOf !== doc.kind || existing.barOf !== doc.weightBar;
      if (kindChanged) {
        const prog = existing.prog;
        disposeRig(existing);
        const next = makeRig(doc);
        next.prog = prog;
        rigs.set(doc.id, next);
        continue;
      }
      existing.doc = doc;
      existing.slot = resolveSlot(doc, existing.frame);
      existing.durationS = revealSeconds(doc);
      existing.group.visible = doc.visible !== false;
      const key = textureKey(doc);
      if (key !== existing.texKey) {
        const t = texture(doc);
        existing.mat.map = t;
        existing.mat.emissiveMap = t;
        existing.mat.needsUpdate = true;
        existing.texKey = key;
      }
      writeGeometry(existing);
    }
    applySelection();
  }

  function applySelection(): void {
    for (const [id, r] of rigs) {
      r.outline.visible = id === selectedId;
      if (r.outline.visible) updateOutline(r);
    }
  }

  const unsub = bannerStore.onChange(refresh);
  const unsubImg = onBannerImageReady(() => {
    for (const [, t] of texCache) t.dispose();
    texCache.clear();
    for (const r of rigs.values()) {
      const t = texture(r.doc);
      r.mat.map = t;
      r.mat.emissiveMap = t;
      r.mat.needsUpdate = true;
      r.texKey = textureKey(r.doc);
    }
  });
  refresh();

  function advance(): void {
    for (const r of rigs.values()) {
      if (r.playing) {
        const raw = (elapsed - r.t0) / Math.max(0.2, r.durationS);
        r.prog = Math.max(0, Math.min(1, raw));
        if (raw >= 1) r.playing = false;
      }
      if (r.doc.visible === false) continue;
      writeGeometry(r);
    }
  }

  return {
    object: root,
    refresh,
    update(_elapsed, dt) {
      elapsed += dt;
      advance();
    },
    play(id) {
      for (const [rid, r] of rigs) {
        if (id && rid !== id) continue;
        r.playing = true;
        r.t0 = elapsed;
        r.prog = 0;
      }
      advance();
    },
    setProgress(id, p) {
      const r = rigs.get(id);
      if (!r) return;
      r.playing = false;
      r.prog = Math.max(0, Math.min(1, p));
      writeGeometry(r);
    },
    settle(seconds) {
      elapsed += Math.max(0, seconds);
      advance();
    },
    pick(raycaster) {
      const hits = raycaster.intersectObjects([...rigs.values()].map((r) => r.mesh), false);
      for (const h of hits) {
        const id = (h.object as THREE.Mesh).userData.bannerId as string | undefined;
        if (id) return id;
      }
      return null;
    },
    select(id) {
      selectedId = id;
      applySelection();
    },
    census() {
      let ropes = 0;
      let bars = 0;
      for (const r of rigs.values()) {
        if (r.ropes) ropes++;
        if (r.bar) bars++;
      }
      return { banners: rigs.size, ropes, nets: 0, bars, poles: 0, particles: rigs.size * SURF_VERTS };
    },
    worstPenetration() {
      let worst = 0;
      for (const r of rigs.values()) {
        if (r.doc.visible === false || r.doc.kind !== 'stand' || !r.frame.ok) continue;
        columnsU(r.slot, r.frame, colU);
        // The sheet's rows sit where the REVEAL has put them. Measuring them
        // against the fully-unrolled heights says a half-unrolled banner is
        // two metres inside the terracing when it is lying on it perfectly —
        // the same mistake as a test that recomputes what it is checking.
        const covered = Math.max(0.0001, Math.min(1, revealEase(r.doc.reveal, r.prog)));
        for (let j = 0; j < SURF_ROWS; j += 4) {
          const frac = (j / (SURF_ROWS - 1)) * covered;
          const sv = Math.max(0, Math.min(1, r.slot.v1 + (r.slot.vBottom - r.slot.v1) * frac));
          for (let i = 0; i < SURF_COLS; i += 5) {
            const k = (j * SURF_COLS + i) * 3;
            const p = r.frame.pointAt(colU[i], sv);
            const n = r.frame.normalAt(colU[i], sv);
            const d = (r.pos[k] - p.x) * n.nx + (r.pos[k + 1] - p.y) * n.ny + (r.pos[k + 2] - p.z) * n.nz;
            if (SOLID_CLEARANCE - d > worst) worst = SOLID_CLEARANCE - d;
          }
        }
      }
      return Math.max(0, worst);
    },
    worstSag() {
      return 0;
    },
    bounds(id) {
      const r = rigs.get(id);
      if (!r) return null;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < r.pos.length; k += 3) {
        if (r.pos[k] < x0) x0 = r.pos[k];
        if (r.pos[k] > x1) x1 = r.pos[k];
        if (r.pos[k + 1] < y0) y0 = r.pos[k + 1];
        if (r.pos[k + 1] > y1) y1 = r.pos[k + 1];
        if (r.pos[k + 2] < z0) z0 = r.pos[k + 2];
        if (r.pos[k + 2] > z1) z1 = r.pos[k + 2];
      }
      return isFinite(x0)
        ? { min: [x0, y0, z0] as [number, number, number], max: [x1, y1, z1] as [number, number, number] }
        : null;
    },
    dispose() {
      unsub();
      unsubImg();
      for (const r of rigs.values()) disposeRig(r);
      rigs.clear();
      for (const [, t] of texCache) t.dispose();
      texCache.clear();
    },
  };
}
