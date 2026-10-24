import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SeatMap, StadiumTemplate } from '../core/types';
import { buildStands } from './simulator/stands';
import { buildGround } from './simulator/grounds';
import { buildVenueDetails } from './simulator/venue';
import { buildPremium } from './simulator/premium';
import { buildJewel } from './simulator/jewel';
import { buildKingdom } from './simulator/kingdom';
import { buildJewelCrown } from './simulator/jewelCrown';
import { buildAlAwwalExtras, buildKingdomArenaExtras } from './simulator/stadiumExtras';
import { buildTrack } from './simulator/track';
import { buildPitchDetail } from './simulator/pitchDetail';
import { kelvinToRgb, layOutLights } from './simulator/lighting';
import { paintScreen } from './simulator/screenPicture';
import { baseGroundId } from '../core/realBlocks';
import { bakeColour, bakeMatrix, batchLines, madeAt, materialKey as drawKey, normaliseForMerge, singlePass } from './simulator/merge';

/**
 * The building, for the Stadium view: the ground's real stands, roofs,
 * facade, floodlights, screens and pitch — the same builders Match Day uses,
 * so the editor shows the same stadium, without Match Day's neighbourhood,
 * crowd, sky or effects.
 *
 * Then it is made cheap. The builders make hundreds of small meshes (a
 * building per stand, a box per column, a goal post at a time), which is
 * hundreds of draw calls a frame; a phone's budget is about a hundred for the
 * whole picture. Everything that never moves is baked into world space and
 * merged by material, so the building is a few dozen draw calls whatever the
 * ground. On the low tier the lit materials also become Lambert, the cheapest
 * lit material three.js has.
 */

export type ShellTier = 'low' | 'medium' | 'high';

export interface ShellBuild {
  object: THREE.Group;
  /** Roofs, roof trusses and ceilings: the parts that can be hidden for a look at the seats. */
  roofs: THREE.Object3D[];
  /** The roofs' own materials (see Preview3D: faded when seen from above). */
  roofMaterials: THREE.Material[];
  /** The lowest and highest any roof reaches, in metres. */
  roofSpan: { bottom: number; top: number } | null;
  /** Seats that have a chair of their own here (premium seating). */
  chairMask: Uint8Array | null;
  /** How many draw calls the building takes, before and after merging. */
  stats: { meshesBefore: number; meshesAfter: number; triangles: number; ms: number; steps: Record<string, number> };
  /** Pick the premium armchairs' detail for a camera, before each frame (premium.ts, performance plan P2.13). */
  lod(camera: THREE.PerspectiveCamera, heightPx: number): void;
  dispose(): void;
}

const OLD_JEWEL_ID = 'community-jewel-jeddah-62k';
const OLD_ALAWWAL_ID = 'community-alawwal-park-25k';
const OLD_KINGDOM_ID = 'community-kingdom-arena-28k';
const JEWEL_ID = 'jewel-jeddah-60k';
const KINGDOM_ID = 'kingdom-arena-26k';

/** Is this part of a roof? (Named by the builders that make them.) */
function isRoofName(name: string): boolean {
  return /^roof|roof$|-roof|ceiling|crown|truss/i.test(name);
}

function bowlExtent(map: SeatMap): { ax: number; bz: number; ty: number } {
  let ax = 1;
  let bz = 1;
  let ty = 1;
  for (let k = 0; k < map.count; k++) {
    ax = Math.max(ax, Math.abs(map.pos3[k * 3]));
    ty = Math.max(ty, map.pos3[k * 3 + 1]);
    bz = Math.max(bz, Math.abs(map.pos3[k * 3 + 2]));
  }
  return { ax, bz, ty };
}

/**
 * Mowing stripes as a 2 x 1 texture, repeated down the pitch. Made from bytes,
 * not drawn on a canvas and read back: a canvas read-back waits for the GPU,
 * and on a slow device that wait was most of the time the building took.
 */
function stripeTexture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255, 226, 230, 226, 255]), 2, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.repeat.set(10, 1);
  t.needsUpdate = true;
  return t;
}

/** The pitch, its run-off and the ground the stadium stands on. */
function buildPitch(template: StadiumTemplate, group: THREE.Group, extent: { ax: number; bz: number }, ground: boolean): void {
  const reach = Math.max(extent.ax, extent.bz);
  // The concourse round the building…
  const apronGeo = new THREE.CircleGeometry(reach + (ground ? 45 : 10), 72);
  const apron = new THREE.Mesh(apronGeo, new THREE.MeshStandardMaterial({ color: 0x8a8c8e, roughness: 0.95, metalness: 0 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.08;
  apron.name = 'apron';
  group.add(apron);
  if (ground) {
    // …and the town beyond it, out to where the haze takes over.
    const land = new THREE.Mesh(new THREE.CircleGeometry(3000, 48), new THREE.MeshStandardMaterial({ color: 0x5d6656, roughness: 1, metalness: 0 }));
    land.rotation.x = -Math.PI / 2;
    land.position.y = -0.14;
    land.name = 'apron';
    group.add(land);
  }
  if (template.id === OLD_JEWEL_ID) {
    const ro = new THREE.Mesh(new THREE.CircleGeometry(58, 64), new THREE.MeshStandardMaterial({ color: 0x5f5540, roughness: 0.9, metalness: 0 }));
    ro.rotation.x = -Math.PI / 2;
    ro.scale.set(1.2, 1, 1);
    ro.position.y = -0.03;
    group.add(ro);
  }
  if (template.runoff) {
    const r = template.runoff;
    const e = 2 / (r.exponent ?? 8);
    const shape = new THREE.Shape();
    for (let k = 0; k <= 128; k++) {
      const t = (k / 128) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const x = r.a * Math.sign(c) * Math.abs(c) ** e;
      const z = r.b * Math.sign(s) * Math.abs(s) ** e;
      if (k === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    }
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape, 1), new THREE.MeshStandardMaterial({ color: r.color, roughness: 0.85, metalness: 0 }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.03;
    group.add(m);
  } else if (!template.indoor && baseGroundId(template.id) !== JEWEL_ID) {
    // Grass from the pitch to the front of the stands, as almost every ground
    // has: the plan curve itself, which is where the front row starts.
    const { a, b, exponent: p } = template.plan;
    const e = 2 / p;
    const shape = new THREE.Shape();
    for (let k = 0; k <= 160; k++) {
      const t = (k / 160) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const x = a * Math.sign(c) * Math.abs(c) ** e;
      const z = b * Math.sign(sn) * Math.abs(sn) ** e;
      if (k === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    }
    const g = new THREE.Mesh(new THREE.ShapeGeometry(shape, 1), new THREE.MeshStandardMaterial({ color: 0x24622f, roughness: 0.9, metalness: 0 }));
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.035;
    group.add(g);
  }
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(105, 68),
    new THREE.MeshStandardMaterial({ color: 0x23853f, map: stripeTexture(), roughness: 0.75, metalness: 0 }),
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.name = 'pitch';
  group.add(pitch);
  // The touchlines, halfway line and centre circle as thin strips (real
  // geometry, so they survive merging and read at any pixel ratio).
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xe9efe9 });
  const W = 0.12;
  const y = 0.02;
  const bar = (x: number, z: number, w: number, d: number): void => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    group.add(m);
  };
  bar(0, -34, 105, W);
  bar(0, 34, 105, W);
  bar(-52.5, 0, W, 68);
  bar(52.5, 0, W, 68);
  bar(0, 0, W, 68);
  const ring = new THREE.Mesh(new THREE.RingGeometry(9.15 - W / 2, 9.15 + W / 2, 64), lineMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = y;
  group.add(ring);
  group.add(buildPitchDetail(false));
}

/** The floodlights as structure: masts and lamp heads (no light is cast here). */
function buildFloodlightHeads(template: StadiumTemplate, group: THREE.Group): void {
  const plan = layOutLights(template);
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x5b616b, roughness: 0.6, metalness: 0.3 });
  const lampHex = kelvinToRgb(plan.kelvin);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xd9dde3, emissive: lampHex, emissiveIntensity: 0.25, roughness: 0.4, metalness: 0.2 });
  // A rim array is drawn only on the generated roof it is fixed to: a real
  // ground's own roofs (grounds.ts) carry their own lamps, and a bank of
  // lamps with nothing under it is a row of dashes in the sky.
  const onGeneratedRoof = template.roof?.coverage !== 'none';
  for (const lum of plan.luminaires) {
    const [x, y, z] = lum.pos;
    if (!lum.mast && !onGeneratedRoof) continue;
    if (lum.mast && !template.lighting?.masts?.style) {
      const mast = new THREE.Mesh(new THREE.BoxGeometry(1.4, y, 1.4), mastMat);
      mast.position.set(x, y / 2, z);
      group.add(mast);
    }
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(lum.width, lum.mast ? 3.2 : 1.1, 0.9), lampMat);
    lamp.position.set(x, y, z);
    lamp.lookAt(0, 0, 0);
    group.add(lamp);
  }
}

/** A cheap stand-in for a lit material, keeping what it looks like. */
function toLambert(m: THREE.MeshStandardMaterial): THREE.MeshLambertMaterial {
  const l = new THREE.MeshLambertMaterial({
    color: m.color,
    map: m.map,
    emissive: m.emissive,
    emissiveMap: m.emissiveMap,
    emissiveIntensity: m.emissiveIntensity,
    transparent: m.transparent,
    opacity: m.opacity,
    side: m.side,
    vertexColors: m.vertexColors,
    alphaTest: m.alphaTest,
    alphaMap: m.alphaMap,
    depthWrite: m.depthWrite,
    flatShading: m.flatShading,
  });
  l.forceSinglePass = m.forceSinglePass;
  l.userData = { ...m.userData };
  l.name = m.name;
  return l;
}

/** Identical-looking materials made separately by the builders, as one key. */
function materialKey(m: THREE.Material): string {
  const a = m as THREE.MeshStandardMaterial;
  // A material with its own shader code or textures is only ever itself.
  if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') || a.map || a.emissiveMap || a.alphaMap || a.normalMap || a.roughnessMap) return m.uuid;
  const c = a.color ? a.color.getHexString() : '';
  const e = a.emissive ? a.emissive.getHexString() + ':' + a.emissiveIntensity : '';
  return [m.type, c, e, a.roughness, a.metalness, m.transparent, m.opacity, m.side, m.vertexColors, m.depthWrite, a.flatShading, m.alphaTest].join('|');
}

/**
 * Bake every static mesh into world space and merge by material. Instanced
 * meshes are already one draw call and stay as they are, as do points,
 * transparent surfaces (merging them would break their sorting) and anything
 * with more than one material.
 *
 * Materials that differ only in colour merge too (performance plan P2.13):
 * the colour goes into the vertices and the merged mesh draws with a white
 * copy of the material, which three multiplies by the vertex colour — the
 * same colour as before, one draw call instead of one per colour. Lines that
 * share a material go in one batch, and flat see-through panels are drawn in
 * one pass instead of two (see simulator/merge.ts).
 */
function mergeStatic(root: THREE.Group, tier: ShellTier, roofs: Set<THREE.Object3D>, roofLine: number): { object: THREE.Group; roofs: THREE.Object3D[]; roofMaterials: THREE.Material[]; before: number; after: number; triangles: number } {
  root.updateMatrixWorld(true);
  const out = new THREE.Group();
  out.name = 'stadium-shell';
  const roofOut = new THREE.Group();
  roofOut.name = 'roofs';
  const lambert = new Map<THREE.Material, THREE.Material>();
  const shared = new Map<string, THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    let mat = m;
    if (tier === 'low' && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      let l = lambert.get(m);
      if (!l) lambert.set(m, (l = toLambert(m as THREE.MeshStandardMaterial)));
      mat = l;
    }
    const key = materialKey(mat);
    const hit = shared.get(key);
    if (hit) return hit;
    shared.set(key, mat);
    return mat;
  };
  // Roofs get materials of their own, so they can be faded from above
  // without fading the stands that share a colour with them.
  const roofMats = new Map<THREE.Material, THREE.Material>();
  const roofMat = (m: THREE.Material): THREE.Material => {
    let r = roofMats.get(m);
    if (!r) {
      r = m.clone();
      r.name = (m.name || m.type) + ':roof';
      roofMats.set(m, r);
    }
    return r;
  };
  /** A piece in world space, with the material it was drawn with. */
  interface Piece { g: THREE.BufferGeometry; mat: THREE.Material }
  // By what the material draws, colour aside.
  const buckets = new Map<string, { roof: Piece[]; rest: Piece[] }>();
  /** When each material was first met, in the order the pieces were built. */
  const seen = new Map<THREE.Material, number>();
  const keep: THREE.Object3D[] = [];
  let before = 0;
  const underRoof = (o: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (roofs.has(p) || isRoofName(p.name)) return true;
    return false;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints) return;
    if (!o.visible) return;
    for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) if (!p.visible) return;
    before++;
    const mat = mesh.material as THREE.Material | THREE.Material[];
    // (A see-through material is merged only when it blends the same in any
    // order: see mergeInPlace in simulator/merge.ts.)
    const plain = mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh && !(mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh && !Array.isArray(mat) && (!mat.transparent || !!mat.userData?.mergeTransparent) && mesh.geometry.attributes.position;
    if (!plain) {
      keep.push(o);
      return;
    }
    const m = swap(mat as THREE.Material);
    if (!seen.has(m)) seen.set(m, seen.size);
    const wantUv = !!((m as THREE.MeshStandardMaterial).map || (m as THREE.MeshStandardMaterial).emissiveMap || (m as THREE.MeshStandardMaterial).alphaMap);
    const g = normaliseForMerge(mesh.geometry.clone(), wantUv, !!m.vertexColors);
    bakeMatrix(g, mesh.matrixWorld);
    g.computeBoundingBox();
    const key = drawKey(m, false);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { roof: [], rest: [] }));
    // A roof is anything a builder called one, or anything wholly above the
    // top row of seats (the Jewel's crown, a hall's ceiling, a hung screen).
    (underRoof(o) || g.boundingBox!.min.y > roofLine ? b.roof : b.rest).push({ g, mat: m });
  });
  let triangles = 0;
  let after = 0;
  /** The colour-agnostic copies, one per material they stand in for. */
  const white = new Map<THREE.Material, THREE.Material>();
  // Made and drawn in the order the merge by material drew them before
  // (performance plan P2.13). three draws solid meshes in the order their
  // materials were made, and the roofs' copies are made here — so they are
  // made as that merge made them: every stand before any roof, and the roofs
  // in the order their materials were first met. Where two pieces lie in one
  // plane (a roof's fascia and the front edge of its deck), the one drawn
  // second wins; grouped by colour-agnostic key and taken in the key's order,
  // a roof's deck came out over its fascia on the low tier.
  const jobs: { list: Piece[]; into: THREE.Group; at: number }[] = [];
  for (const b of buckets.values()) {
    for (const [list, into] of [[b.rest, out], [b.roof, roofOut]] as const) {
      if (list.length) jobs.push({ list, into, at: list.reduce((n, p) => Math.min(n, seen.get(p.mat)!), Infinity) });
    }
  }
  jobs.sort((x, y) => Number(x.into === roofOut) - Number(y.into === roofOut) || x.at - y.at);
  for (const { list: unordered, into } of jobs) {
    const one = unordered.every((p) => p.mat === unordered[0].mat);
    // And inside one merged mesh too: its pieces in the order their own
    // meshes were drawn (stands by material, roofs by first meeting), so a
    // coplanar pair inside it still resolves the same way.
    const list = one ? unordered : [...unordered].sort((x, y) => (into === roofOut ? seen.get(x.mat)! - seen.get(y.mat)! : madeAt(x.mat) - madeAt(y.mat)));
    const first = list[0].mat;
    let m0 = first;
    if (!one) {
      let w = white.get(first);
      if (!w) {
        w = first.clone();
        (w as THREE.MeshStandardMaterial).color?.setRGB(1, 1, 1);
        w.vertexColors = true;
        w.name = (first.name || first.type) + ':colours';
        white.set(first, w);
      }
      m0 = w;
    }
    const m = into === roofOut ? roofMat(m0) : m0;
    const a = m as THREE.MeshStandardMaterial;
    const wantUv = !!(a.map || a.emissiveMap || a.alphaMap);
    // Colours into the vertices (a white one where a piece had none).
    const parts = one
      ? list.map((p) => p.g)
      : list.map((p) => {
        const g = normaliseForMerge(p.g, wantUv, true);
        bakeColour(g, (p.mat as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1));
        return g;
      });
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!merged) {
      // Should not happen after normaliseForMerge; keep the pieces rather than lose them.
      list.forEach((p, i) => into.add(new THREE.Mesh(parts[i], one ? m : into === roofOut ? roofMat(p.mat) : p.mat)));
      after += list.length;
      continue;
    }
    if (merged !== parts[0]) for (const g of parts) g.dispose();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, m);
    mesh.matrixAutoUpdate = false;
    into.add(mesh);
    triangles += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
    after++;
  }
  // What could not be merged keeps its place in the world.
  // (Decided while every piece is still in its builder's tree: the names that
  // say "roof" are on the parents.)
  const keptRoof = new Map(keep.map((o) => [o, underRoof(o) || new THREE.Box3().setFromObject(o).min.y > roofLine]));
  for (const o of keep) {
    const clone = o as THREE.Object3D;
    const world = clone.matrixWorld.clone();
    clone.removeFromParent();
    world.decompose(clone.position, clone.quaternion, clone.scale);
    clone.updateMatrix();
    clone.matrixAutoUpdate = false;
    const mesh = clone as THREE.Mesh;
    const roofed = keptRoof.get(o)!;
    if (mesh.isMesh && !Array.isArray(mesh.material)) mesh.material = roofed ? roofMat(swap(mesh.material)) : swap(mesh.material);
    (roofed ? roofOut : out).add(clone);
    after++;
    const g = (clone as THREE.Mesh).geometry;
    if (g?.index) triangles += (g.index.count / 3) * ((clone as THREE.InstancedMesh).count ?? 1);
  }
  // Lines that share a material, one batch each; the roof's apart, so that
  // hiding the roofs still hides theirs.
  const lr = batchLines(roofOut, { transparent: true });
  const lo = batchLines(out, { transparent: true });
  after -= lr.before - lr.after + (lo.before - lo.after);
  singlePass(out);
  singlePass(roofOut);
  if (roofOut.children.length) out.add(roofOut);
  out.matrixAutoUpdate = false;
  return { object: out, roofs: roofOut.children.length ? [roofOut] : [], roofMaterials: [...roofMats.values()], before, after, triangles };
}

export function buildStadiumShell(template: StadiumTemplate, map: SeatMap, opts: { tier: ShellTier; palette?: string[]; ground?: boolean }): ShellBuild {
  const t0 = performance.now();
  const steps: Record<string, number> = {};
  let tick = t0;
  const lap = (name: string): void => {
    const now = performance.now();
    steps[name] = Math.round(now - tick);
    tick = now;
  };
  const raw = new THREE.Group();
  const roofs = new Set<THREE.Object3D>();
  const extent = bowlExtent(map);
  const stands = buildStands(template, false);
  raw.add(stands);
  lap('stands');
  // The generated roof (roof.ts) is the stands group's last child.
  const genRoof = stands.children[stands.children.length - 1];
  if (genRoof && !(genRoof as THREE.Mesh).isMesh) roofs.add(genRoof);
  buildPitch(template, raw, extent, opts.ground !== false);
  const track = buildTrack(template, false);
  raw.add(track.object);
  buildFloodlightHeads(template, raw);
  lap('pitch+track+lights');
  let chairMask: Uint8Array | null = null;
  let lod: ShellBuild['lod'] = () => {};
  if (template.details) {
    const venue = buildVenueDetails(template, map, false);
    if (venue.screen) {
      paintScreen(venue.screen.canvas, { mode: 'stadium', nameEn: template.name, nameAr: template.name, palette: opts.palette ?? ['#262a33', '#1c5fd9', '#ffffff'] });
      venue.screensChanged();
    }
    raw.add(venue.object);
    const premium = buildPremium(template, map, false);
    raw.add(premium.object);
    chairMask = premium.chairMask;
    lod = premium.lod;
  }
  lap('venue+premium');
  if (template.roofs?.length || template.lighting?.masts?.style || template.details?.buildings?.length || template.details?.skins?.length || template.details?.ribbons || template.details?.girders?.length || template.details?.cranes?.length) {
    raw.add(buildGround(template, false).object);
  }
  lap('ground');
  if (baseGroundId(template.id) === JEWEL_ID) raw.add(buildJewel(template, false).object);
  if (baseGroundId(template.id) === KINGDOM_ID) {
    const k = buildKingdom(template, false).object;
    raw.add(k);
  }
  if (template.id === OLD_JEWEL_ID) {
    const crown = buildJewelCrown().object;
    roofs.add(crown);
    raw.add(crown);
  }
  if (template.id === OLD_ALAWWAL_ID) raw.add(buildAlAwwalExtras(extent.ax, extent.bz, extent.ty).object);
  if (template.id === OLD_KINGDOM_ID) raw.add(buildKingdomArenaExtras(extent.ax, extent.bz, extent.ty).object);

  lap('special');
  const merged = mergeStatic(raw, opts.tier, roofs, extent.ty + 1.5);
  lap('merge');
  // The originals' geometries were cloned into the merge; free them now.
  const kept = new Set<THREE.BufferGeometry>();
  merged.object.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) kept.add(g);
  });
  raw.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g && !kept.has(g)) g.dispose();
  });
  const ms = performance.now() - t0;
  let roofSpan: { bottom: number; top: number } | null = null;
  if (merged.roofs.length) {
    const box = new THREE.Box3();
    for (const r of merged.roofs) box.expandByObject(r);
    if (!box.isEmpty()) roofSpan = { bottom: box.min.y, top: box.max.y };
  }
  return {
    object: merged.object,
    roofs: merged.roofs,
    roofMaterials: merged.roofMaterials,
    roofSpan,
    chairMask,
    stats: { meshesBefore: merged.before, meshesAfter: merged.after, triangles: Math.round(merged.triangles), ms: Math.round(ms), steps },
    lod,
    dispose(): void {
      const mats = new Set<THREE.Material>();
      const texs = new Set<THREE.Texture>();
      merged.object.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const list = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mt of list) {
          mats.add(mt);
          for (const v of Object.values(mt)) if ((v as THREE.Texture)?.isTexture) texs.add(v as THREE.Texture);
        }
      });
      for (const m of mats) m.dispose();
      for (const t of texs) t.dispose();
    },
  };
}
