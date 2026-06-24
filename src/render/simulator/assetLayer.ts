import * as THREE from 'three';
import type { AssetStore, SceneAsset } from '../../core/sceneAssets';
import { textureFromUrl, stripeTexture, textTexture } from './textures';

/**
 * Asset layer (Wave A) — renders the AssetStore's scene assets as meshes.
 *
 * Banners / text / floor are flat textured planes. Cloth assets (surface tifos,
 * mega-flags, scarf walls) use a subdivided plane that waves on the CPU each
 * frame, and surfaces can "unfurl" — drop down from a top pivot over a few
 * seconds (the classic overhead tifo reveal). Textures are cached so transform
 * edits never reload images; cloth/unfurl animate the mesh directly (never via
 * the store) so they don't trigger material rebuilds.
 */

export interface AssetLayer {
  readonly object: THREE.Group;
  refresh(): void;
  update(elapsed: number): void;
  unfurl(id: string, durMs?: number): void;
  setOpacity(id: string, o: number): void;
  dispose(): void;
}

interface Anim {
  base: Float32Array | null; // flat cloth positions, for re-waving
  unfurl: number; // current 0..1
  target: number;
  t0: number;
  dur: number;
}

function isCloth(a: SceneAsset): boolean {
  return a.cloth === true;
}

export function buildAssetLayer(store: AssetStore, paletteHex: () => string[]): AssetLayer {
  const group = new THREE.Group();
  const meshes = new Map<string, THREE.Mesh>();
  const anim = new Map<string, Anim>();
  const texCache = new Map<string, THREE.Texture>();
  let lastElapsed = 0;

  const tex = (key: string, make: () => THREE.Texture): THREE.Texture => {
    let t = texCache.get(key);
    if (!t) {
      t = make();
      texCache.set(key, t);
    }
    return t;
  };

  function materialFor(a: SceneAsset): THREE.MeshBasicMaterial {
    const pal = paletteHex();
    let map: THREE.Texture;
    if (a.imageRef) {
      map = tex('img:' + a.imageRef, () => textureFromUrl(a.imageRef as string));
    } else if (a.text) {
      const bg = a.color ?? pal[1] ?? '#15294e';
      map = tex('text:' + a.text + ':' + bg, () => textTexture(a.text as string, '#ffffff', bg));
    } else {
      const c1 = a.color ?? pal[1] ?? '#b22234';
      const c2 = pal[2] ?? '#ffffff';
      map = tex('stripe:' + c1 + ':' + c2, () => stripeTexture(c1, c2));
    }
    return new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide, transparent: true });
  }

  function placeMesh(mesh: THREE.Mesh, a: SceneAsset): void {
    const u = anim.get(a.id)?.unfurl ?? 1;
    const fullH = Math.max(0.1, a.scale.y);
    const sy = fullH * u;
    mesh.position.set(a.position.x, a.position.y + (fullH - sy) / 2, a.position.z);
    mesh.scale.set(Math.max(0.1, a.scale.x), sy, 1);
    mesh.rotation.set(a.type === 'floor' ? -Math.PI / 2 : 0, a.rotationY, 0);
    mesh.visible = a.visible !== false;
    mesh.renderOrder = a.order ?? 0;
  }

  function makeMesh(a: SceneAsset): THREE.Mesh {
    const cloth = isCloth(a);
    const geo = cloth ? new THREE.PlaneGeometry(1, 1, 14, 8) : new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geo, materialFor(a));
    mesh.userData.assetId = a.id;
    const u = a.unfurl ?? 1;
    anim.set(a.id, {
      base: cloth ? (geo.attributes.position.array as Float32Array).slice() : null,
      unfurl: u,
      target: u,
      t0: 0,
      dur: 1,
    });
    placeMesh(mesh, a);
    return mesh;
  }

  function refresh(): void {
    const ids = new Set(store.list().map((a) => a.id));
    for (const [id, mesh] of [...meshes]) {
      if (!ids.has(id)) {
        group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        meshes.delete(id);
        anim.delete(id);
      }
    }
    for (const a of store.list()) {
      let mesh = meshes.get(a.id);
      if (!mesh) {
        mesh = makeMesh(a);
        meshes.set(a.id, mesh);
        group.add(mesh);
      } else {
        (mesh.material as THREE.Material).dispose();
        mesh.material = materialFor(a);
        placeMesh(mesh, a);
      }
    }
  }

  function update(elapsed: number): void {
    lastElapsed = elapsed;
    for (const a of store.list()) {
      const mesh = meshes.get(a.id);
      if (!mesh) continue;
      const st = anim.get(a.id);
      if (st && st.unfurl < st.target) {
        st.unfurl = Math.min(st.target, st.dur > 0 ? (elapsed - st.t0) / st.dur : 1);
        placeMesh(mesh, a);
      }
      if (a.cloth && st?.base) {
        const arr = mesh.geometry.attributes.position.array as Float32Array;
        const base = st.base;
        for (let v = 0; v < arr.length; v += 3) {
          const bx = base[v];
          const by = base[v + 1];
          arr[v] = bx;
          arr[v + 1] = by;
          arr[v + 2] = base[v + 2] + Math.sin(bx * 12 + by * 5 + elapsed * 3) * 0.3 * (0.6 + bx + 0.5);
        }
        mesh.geometry.attributes.position.needsUpdate = true;
      }
    }
  }

  function unfurl(id: string, durMs = 3000): void {
    const st = anim.get(id);
    const mesh = meshes.get(id);
    const a = store.get(id);
    if (!st || !mesh || !a) return;
    st.unfurl = 0;
    st.target = 1;
    st.t0 = lastElapsed;
    st.dur = Math.max(0.3, durMs / 1000);
    placeMesh(mesh, a);
  }

  const unsub = store.onChange(refresh);
  refresh();

  return {
    object: group,
    refresh,
    update,
    unfurl,
    setOpacity(id, o) {
      const mesh = meshes.get(id);
      if (mesh) (mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.min(1, o));
    },
    dispose() {
      unsub();
      for (const [, mesh] of meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      for (const [, t] of texCache) t.dispose();
      meshes.clear();
      anim.clear();
      texCache.clear();
    },
  };
}
