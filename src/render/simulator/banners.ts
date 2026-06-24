import * as THREE from 'three';
import type { SeatMap } from '../../core/types';
import type { DesignStore } from '../../core/design';

/**
 * Match Day Simulator — banners & flags (Phase 4).
 *
 * Tier banners hang on the front rail of the top tier; large flags fly on poles
 * at the corners and wave (one shared geometry animated on the CPU, reused by all
 * flag meshes). Colours come from the design palette so they match the club.
 * Anchors are found from the seat map, so they adapt to any bowl. Visibility of
 * banners and flags is independently toggleable (the "atmosphere in non-painted
 * areas" control).
 */

export interface BannerController {
  readonly object: THREE.Object3D;
  setVisible(b: boolean): void;
  setFlagsVisible(b: boolean): void;
  update(elapsed: number): void;
  dispose(): void;
}

function bannerTexture(c1: string, c2: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = c1;
  g.fillRect(0, 0, 128, 32);
  g.fillStyle = c2;
  g.fillRect(0, 12, 128, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function nearestInSet(map: SeatMap, set: number[], targetU: number): number {
  let best = set[0] ?? -1;
  let bd = Infinity;
  for (const i of set) {
    let du = Math.abs(map.uv[i * 2] - targetU);
    if (du > 0.5) du = 1 - du;
    if (du < bd) {
      bd = du;
      best = i;
    }
  }
  return best;
}

export function buildBanners(map: SeatMap, store: DesignStore): BannerController {
  const group = new THREE.Group();
  const flagGroup = new THREE.Group();
  group.add(flagGroup);
  const trash: { dispose(): void }[] = [];

  const c1 = store.palette[1] ?? '#b22234';
  const c2 = store.palette[2] ?? '#ffffff';

  // Find the top tier and its front/back rows.
  let topTier = 0;
  for (let i = 0; i < map.count; i++) if (map.tierOf[i] > topTier) topTier = map.tierOf[i];
  let frontRow = Infinity;
  let backRow = -Infinity;
  for (let i = 0; i < map.count; i++) {
    if (map.tierOf[i] !== topTier) continue;
    if (map.rowOf[i] < frontRow) frontRow = map.rowOf[i];
    if (map.rowOf[i] > backRow) backRow = map.rowOf[i];
  }
  const frontSet: number[] = [];
  const backSet: number[] = [];
  for (let i = 0; i < map.count; i++) {
    if (map.tierOf[i] !== topTier) continue;
    if (map.rowOf[i] === frontRow) frontSet.push(i);
    if (map.rowOf[i] === backRow) backSet.push(i);
  }

  // Tier banners on the front rail.
  const bTex = bannerTexture(c1, c2);
  const bMat = new THREE.MeshBasicMaterial({ map: bTex, side: THREE.DoubleSide });
  const bGeo = new THREE.PlaneGeometry(16, 3.6);
  trash.push(bTex, bMat, bGeo);
  for (let k = 0; k < 8; k++) {
    const i = nearestInSet(map, frontSet, k / 8);
    if (i < 0) continue;
    const mesh = new THREE.Mesh(bGeo, bMat);
    const x = map.pos3[i * 3];
    const y = map.pos3[i * 3 + 1] + 1.4;
    const z = map.pos3[i * 3 + 2];
    mesh.position.set(x, y, z);
    mesh.lookAt(0, y, 0);
    group.add(mesh);
  }

  // Corner flags on poles, sharing one animated geometry.
  const flagGeo = new THREE.PlaneGeometry(7, 4.4, 14, 6);
  const basePos = (flagGeo.attributes.position.array as Float32Array).slice();
  const flagMat = new THREE.MeshBasicMaterial({ map: bannerTexture(c1, c2), side: THREE.DoubleSide });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5, metalness: 0.4 });
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 12, 8);
  trash.push(flagGeo, flagMat, (flagMat.map as THREE.Texture), poleMat, poleGeo);

  for (const cu of [0.125, 0.375, 0.625, 0.875]) {
    const i = nearestInSet(map, backSet, cu);
    if (i < 0) continue;
    const x = map.pos3[i * 3];
    const y = map.pos3[i * 3 + 1];
    const z = map.pos3[i * 3 + 2];
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, y + 6, z);
    flagGroup.add(pole);
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(x + 3.5, y + 9.5, z);
    flag.lookAt(0, y + 9.5, 0);
    flagGroup.add(flag);
  }

  return {
    object: group,
    setVisible(b) {
      group.visible = b;
    },
    setFlagsVisible(b) {
      flagGroup.visible = b;
    },
    update(elapsed) {
      if (!flagGroup.visible) return;
      const pos = flagGeo.attributes.position;
      const arr = pos.array as Float32Array;
      for (let v = 0; v < arr.length; v += 3) {
        const bx = basePos[v];
        const by = basePos[v + 1];
        const amp = (bx + 3.5) / 7; // 0 at pole, 1 at free edge
        arr[v] = bx;
        arr[v + 1] = by;
        arr[v + 2] = basePos[v + 2] + Math.sin(bx * 1.6 + elapsed * 4) * 0.5 * amp;
      }
      pos.needsUpdate = true;
      flagGeo.computeVertexNormals();
    },
    dispose() {
      for (const d of trash) d.dispose();
    },
  };
}
