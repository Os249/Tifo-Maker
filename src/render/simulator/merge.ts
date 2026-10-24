import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Fewer draw calls for the same picture (performance plan P2.13).
 *
 * The stadium builders make hundreds of small meshes — a box per lamp, a
 * cylinder per goal post, a ribbon per rail — and every one is a draw call
 * every frame, whatever it costs to draw. What never moves can be baked and
 * merged: meshes that share a material become one mesh with that material,
 * and meshes whose materials differ only in colour become one mesh whose
 * colour is in its vertices. A flat see-through panel is drawn in one pass
 * instead of two, and pitch lines that share a material go in one batch.
 *
 * Nothing here changes what is drawn, only how many calls it takes: the same
 * triangles in the same places, lit by the same material settings. The
 * picture differs only where float rounding moves an edge by a fraction of a
 * pixel, or where the order of two coplanar surfaces decided which one won.
 */

/** The material types whose every setting the key below reads; any other is only ever itself. */
const KEYED = new Set(['MeshStandardMaterial', 'MeshLambertMaterial', 'MeshBasicMaterial', 'MeshPhongMaterial']);

/**
 * Material settings that decide what a material draws; colour optional. Two
 * materials with the same key draw the same pixels for the same triangles.
 * The same texture object (map, glow map, alpha map) is the same picture,
 * so materials made separately around one texture share a key; any other
 * kind of map, a clipping plane or shader code of its own makes a material
 * only ever itself.
 */
export function materialKey(m: THREE.Material, colour = true): string {
  const a = m as THREE.MeshStandardMaterial & THREE.MeshPhongMaterial;
  if (!KEYED.has(m.type)) return m.uuid;
  if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') || a.normalMap || a.roughnessMap || a.metalnessMap || a.aoMap || a.lightMap || a.bumpMap || a.envMap || a.specularMap || a.displacementMap) return m.uuid;
  if (m.clippingPlanes?.length || m.userData?.keep) return m.uuid;
  const c = colour && a.color ? a.color.getHexString() : '';
  const e = a.emissive ? a.emissive.getHexString() + ':' + a.emissiveIntensity : '';
  return [
    m.type, c, e, a.map?.uuid ?? '', a.emissiveMap?.uuid ?? '', a.alphaMap?.uuid ?? '', a.roughness, a.metalness, a.envMapIntensity, a.shininess, a.specular?.getHexString?.(),
    m.transparent, m.opacity, m.side, m.shadowSide, m.vertexColors, m.depthWrite, m.depthTest, m.depthFunc, a.flatShading, a.wireframe, m.alphaTest, m.alphaToCoverage,
    m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.blending, m.toneMapped, a.fog, m.colorWrite, m.premultipliedAlpha, m.dithering, m.forceSinglePass, m.visible,
  ].join('|');
}

/**
 * Make a geometry mergeable with others of its material: the attributes the
 * material reads, all plain floats, an index, no groups or morphs.
 */
export function normaliseForMerge(g: THREE.BufferGeometry, wantUv: boolean, wantColor: boolean): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name === 'position' || name === 'normal' || (name === 'uv' && wantUv) || (name === 'color' && wantColor)) continue;
    g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (wantUv && !g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (wantColor && !g.attributes.color) {
    const c = new Float32Array(g.attributes.position.count * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  // The colour attribute's item size must agree across the merge.
  if (wantColor && g.attributes.color.itemSize !== 3) {
    const src = g.attributes.color;
    const c = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) {
      c[i * 3] = src.getX(i);
      c[i * 3 + 1] = src.getY(i);
      c[i * 3 + 2] = src.getZ(i);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  // Every attribute as plain float, so mixed sources merge.
  for (const name of Object.keys(g.attributes)) {
    const at = g.attributes[name] as THREE.BufferAttribute;
    if ((at as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute || !(at.array instanceof Float32Array) || at.normalized) {
      const out = new Float32Array(at.count * at.itemSize);
      for (let i = 0; i < at.count; i++) for (let k = 0; k < at.itemSize; k++) out[i * at.itemSize + k] = at.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(out, at.itemSize));
    }
  }
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.clearGroups();
  g.morphAttributes = {};
  return g;
}

/**
 * Multiply a geometry's vertex colours (white where it has none) by `c`, so a
 * white material with vertex colours draws exactly what `c` drew: three
 * multiplies the material's colour by the vertex colour, and 1 times a
 * colour is that colour.
 */
export function bakeColour(g: THREE.BufferGeometry, c: THREE.Color): void {
  const at = g.attributes.color as THREE.BufferAttribute;
  const a = at.array as Float32Array;
  for (let i = 0; i < at.count; i++) {
    a[i * 3] *= c.r;
    a[i * 3 + 1] *= c.g;
    a[i * 3 + 2] *= c.b;
  }
}

/**
 * Bake a transform into a geometry. A mirroring transform (negative
 * determinant) turns every triangle inside out once it is in the vertices —
 * three flips the winding for a mirrored object, not for its baked copy — so
 * each triangle is turned back.
 */
export function bakeMatrix(g: THREE.BufferGeometry, m: THREE.Matrix4): void {
  g.applyMatrix4(m);
  if (m.determinant() >= 0 || !g.index) return;
  const idx = g.index.array;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  g.index.needsUpdate = true;
}

function visibleUpTo(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}

/** A mesh that only ever draws as itself, with one opaque material, and can be baked. */
function plainMesh(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return false;
  const mat = m.material as THREE.Material | THREE.Material[];
  // See-through surfaces are blended in the order three sorts them, one
  // object at a time; merged, they would have one place in that order. Only a
  // material that says it blends the same in any order (one colour, unlit,
  // no depth written: a goal's nets) may be merged.
  if (Array.isArray(mat) || (mat.transparent && !mat.userData?.mergeTransparent) || !mat.visible) return false;
  const g = m.geometry;
  if (!g?.attributes.position || Object.keys(g.morphAttributes).length) return false;
  // A geometry drawn in part draws all of itself once merged.
  if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return false;
  if (m.customDepthMaterial || m.customDistanceMaterial || m.userData?.keep) return false;
  // three calls an object's onBeforeRender hook; a merged copy would not.
  if (m.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender || m.onAfterRender !== THREE.Object3D.prototype.onAfterRender) return false;
  return m.layers.mask === 1;
}

export interface MergeResult {
  /** Draw calls before and after (meshes and line objects counted, one each). */
  before: number;
  after: number;
  /** The new geometries and materials, freed with the scene. */
  disposables: { dispose(): void }[];
}

/**
 * When a material was made: three draws solid meshes in that order (its
 * `id`, which the type definitions leave out).
 */
export function madeAt(m: THREE.Material): number {
  return (m as unknown as { id: number }).id;
}

/**
 * Merge `root`'s static meshes in place. Meshes that share a material object
 * become one mesh with that material — safe for a material something changes
 * later (a floodlight's glow, a wet pitch), since the merged mesh draws with
 * the very same object. With `colourAgnostic`, meshes whose materials differ
 * only in colour also go together, their colour moved into the vertices:
 * only for a part of the scene whose materials nothing touches after it is
 * built. The merged meshes are children of `root`, in its frame, so anything
 * that casts rays at `root` hits the same triangles where they were.
 *
 * Anything else — instanced meshes, see-through surfaces (merging would
 * change the order they are blended in, unless their material says it
 * blends the same in any order: userData.mergeTransparent), lines, points,
 * a mesh with several materials or a hook of its own — is left exactly
 * where it is.
 */
export function mergeInPlace(root: THREE.Object3D, opts: { colourAgnostic: boolean }): MergeResult {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<string, THREE.Mesh[]>();
  let before = 0;
  root.traverse((o) => {
    const r = o as THREE.Mesh | THREE.Line | THREE.Points;
    if (!(r as THREE.Mesh).isMesh && !(r as THREE.Line).isLine && !(r as THREE.Points).isPoints) return;
    if (!visibleUpTo(o, root)) return;
    before++;
    if (!plainMesh(o)) return;
    const mat = o.material as THREE.Material;
    const mk = opts.colourAgnostic ? materialKey(mat, false) : 'id:' + mat.uuid;
    const key = [mk, o.castShadow, o.receiveShadow, o.renderOrder, o.frustumCulled].join('#');
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(o);
  });
  const disposables: { dispose(): void }[] = [];
  let removed = 0;
  let added = 0;
  const tmp = new THREE.Matrix4();
  // In the order three drew them apart: by material, as it sorts solid
  // meshes (and, for one material, as they were built). Where two pieces lie
  // in one plane the one drawn second wins, and merging must not change which.
  // So each merged mesh lists its pieces in that order and draws with the
  // earliest of their materials, and the colour-agnostic copies are made in
  // that order too.
  const at = (m: THREE.Mesh): number => madeAt(m.material as THREE.Material);
  const lists = [...buckets.values()]
    .filter((b) => b.length > 1)
    .map((b) => [...b].sort((x, y) => at(x) - at(y)))
    .sort((x, y) => at(x[0]) - at(y[0]));
  for (const meshes of lists) {
    const first = meshes[0].material as THREE.Material;
    // One colour (or one material) in the bucket: draw with it as it is.
    const colours = new Set(meshes.map((m) => ((m.material as THREE.MeshStandardMaterial).color?.getHexString?.() ?? '') + ':' + (m.material as THREE.Material).vertexColors));
    const shared = meshes.every((m) => m.material === first) || colours.size === 1;
    let mat = first;
    if (!shared) {
      mat = first.clone();
      (mat as THREE.MeshStandardMaterial).color?.setRGB(1, 1, 1);
      mat.vertexColors = true;
      mat.name = (first.name || first.type) + ':merged';
      disposables.push(mat);
    }
    const a = mat as THREE.MeshStandardMaterial;
    const wantUv = !!(a.map || a.emissiveMap || a.alphaMap || a.normalMap);
    const parts: THREE.BufferGeometry[] = [];
    for (const m of meshes) {
      const g = normaliseForMerge(m.geometry.clone(), wantUv, mat.vertexColors);
      if (!shared) bakeColour(g, (m.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1));
      bakeMatrix(g, tmp.multiplyMatrices(toRoot, m.matrixWorld));
      parts.push(g);
    }
    const merged = mergeGeometries(parts, false);
    if (!merged) {
      // Cannot happen after normaliseForMerge; if it does, leave the bucket as it was.
      for (const g of parts) g.dispose();
      if (mat !== first) mat.dispose();
      continue;
    }
    for (const g of parts) g.dispose();
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const out = new THREE.Mesh(merged, mat);
    out.castShadow = meshes[0].castShadow;
    out.receiveShadow = meshes[0].receiveShadow;
    out.renderOrder = meshes[0].renderOrder;
    out.frustumCulled = meshes[0].frustumCulled;
    // What it stands for, for a census that counts the parts (sceneCensus).
    out.userData.merged = meshes.length;
    out.name = 'merged';
    out.matrixAutoUpdate = false;
    for (const m of meshes) {
      out.userData.lamps = (out.userData.lamps ?? 0) + (((m.material as THREE.MeshStandardMaterial).emissiveIntensity ?? 0) >= 1 ? 1 : 0);
      m.removeFromParent();
    }
    root.add(out);
    out.updateMatrixWorld(true);
    disposables.push(merged);
    removed += meshes.length;
    added++;
  }
  return { before, after: before - removed + added, disposables };
}

/**
 * Lines that share a material, as one batch of segments in `root`'s frame
 * (a strip's corners drawn once, as before: each segment leaves out its last
 * pixel and the next one starts there). Only opaque lines unless
 * `transparent` is asked for: a see-through line is blended in the order
 * three sorts it, by its own position, and a batch has one position.
 */
export function batchLines(root: THREE.Object3D, opts: { transparent?: boolean } = {}): MergeResult {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, THREE.Line[]>();
  let before = 0;
  root.traverse((o) => {
    const l = o as THREE.Line;
    if (!(o as THREE.Mesh).isMesh && !l.isLine && !(o as THREE.Points).isPoints) return;
    if (!visibleUpTo(o, root)) return;
    before++;
    if (!l.isLine || Array.isArray(l.material) || l.layers.mask !== 1 || l.userData?.keep) return;
    const mat = l.material as THREE.Material;
    if (mat.transparent && !opts.transparent) return;
    if (!l.geometry.attributes.position || Object.keys(l.geometry.morphAttributes).length) return;
    const key = [mat.uuid, l.renderOrder, l.frustumCulled].join('#');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(l);
  });
  const disposables: { dispose(): void }[] = [];
  let removed = 0;
  let added = 0;
  const m4 = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const lines of groups.values()) {
    if (lines.length < 2) continue;
    const withColour = lines.every((l) => !!l.geometry.attributes.color);
    const pos: number[] = [];
    const col: number[] = [];
    for (const l of lines) {
      m4.multiplyMatrices(toRoot, l.matrixWorld);
      const p = l.geometry.attributes.position;
      const c = l.geometry.attributes.color;
      const idx = l.geometry.index;
      const n = idx ? idx.count : p.count;
      const at = (k: number): number => (idx ? idx.getX(k) : k);
      const push = (k: number): void => {
        v.fromBufferAttribute(p, at(k)).applyMatrix4(m4);
        pos.push(v.x, v.y, v.z);
        if (withColour) col.push(c.getX(at(k)), c.getY(at(k)), c.getZ(at(k)));
      };
      if ((l as THREE.LineSegments).isLineSegments) {
        for (let k = 0; k + 1 < n; k += 2) {
          push(k);
          push(k + 1);
        }
      } else {
        for (let k = 0; k + 1 < n; k++) {
          push(k);
          push(k + 1);
        }
        if ((l as THREE.LineLoop).isLineLoop && n > 2) {
          push(n - 1);
          push(0);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (withColour) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    const out = new THREE.LineSegments(g, lines[0].material);
    out.renderOrder = lines[0].renderOrder;
    out.frustumCulled = lines[0].frustumCulled;
    out.userData.merged = lines.length;
    out.name = 'lines';
    out.matrixAutoUpdate = false;
    for (const l of lines) l.removeFromParent();
    root.add(out);
    out.updateMatrixWorld(true);
    disposables.push(g);
    removed += lines.length;
    added++;
  }
  return { before, after: before - removed + added, disposables };
}

/** Is every vertex of `g` on one plane (within a millimetre)? */
export function isPlanar(g: THREE.BufferGeometry): boolean {
  const p = g.attributes.position;
  if (!p || p.count < 4) return true;
  const o = new THREE.Vector3().fromBufferAttribute(p, 0);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 1; i < p.count && n.lengthSq() < 1e-12; i++) {
    a.fromBufferAttribute(p, i).sub(o);
    for (let j = i + 1; j < p.count; j++) {
      b.fromBufferAttribute(p, j).sub(o);
      n.crossVectors(a, b);
      if (n.lengthSq() > 1e-12) break;
    }
  }
  if (n.lengthSq() < 1e-12) return true;
  n.normalize();
  for (let i = 0; i < p.count; i++) {
    a.fromBufferAttribute(p, i).sub(o);
    if (Math.abs(a.dot(n)) > 1e-3) return false;
  }
  return true;
}

/**
 * See-through surfaces drawn in one pass where two passes draw the same
 * picture (performance plan P2.13). three draws a transparent double-sided
 * material twice, back faces then front faces, so that a closed shape
 * blends its far side first. One pass is the same picture:
 *
 *   - for a FLAT panel (a net, a pane of glass, a sign): it shows the camera
 *     only one of its faces from anywhere, so one of the two passes drew
 *     nothing;
 *   - for an ADDITIVE surface that writes no depth (a floodlight's haze):
 *     light added in either order is the same light.
 *
 * A material is switched only when every mesh under `root` drawing with it
 * qualifies — a curved glass ribbon can show both faces at once, lit
 * differently, and keeps its two passes. Returns the materials switched.
 */
export function singlePass(root: THREE.Object3D): number {
  const users = new Map<THREE.Material, boolean>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const mat = m.material as THREE.Material;
    if (!mat.transparent || mat.side !== THREE.DoubleSide || mat.forceSinglePass) return;
    const additive = mat.blending === THREE.AdditiveBlending && !mat.depthWrite;
    const ok = additive || (!(m as THREE.InstancedMesh).isInstancedMesh && isPlanar(m.geometry));
    users.set(mat, (users.get(mat) ?? true) && ok);
  });
  let n = 0;
  for (const [mat, ok] of users) {
    if (!ok) continue;
    mat.forceSinglePass = true;
    n++;
  }
  return n;
}

/**
 * Run `fn` with Math.random answered by a generator of its own. Every three.js
 * object takes four draws of Math.random for its id, and some textures are
 * drawn from Math.random after the scene is built (a neighbourhood's lit
 * windows); objects this module makes would shift those draws. With their
 * ids from elsewhere, everything random comes out as it would have without
 * the merge, which keeps a seeded before/after comparison honest.
 */
let ownSeed = 0x2545f491;
export function withoutRandom<T>(fn: () => T): T {
  const real = Math.random;
  let s = (ownSeed ^ (Date.now() & 0x7fffffff)) >>> 0 || 1;
  ownSeed = (ownSeed * 1103515245 + 12345) >>> 0;
  Math.random = (): number => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}
