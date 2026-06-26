import * as THREE from 'three';

/**
 * Match Day Simulator — pitch-side realism (Phase 3).
 *
 * Mown pitch stripes, an LED advertising ring just outside the touchlines,
 * dugouts at the halfway line, and a players' tunnel mouth. Pitch is the standard
 * 105 x 68 m, so positions are fixed regardless of the bowl. All meshes are cheap
 * boxes/planes; the LED boards use an emissive material so they read at dusk.
 */

export interface PitchsideController {
  readonly object: THREE.Object3D;
  setWet(on: boolean): void;
  dispose(): void;
}

const HALF_X = 52.5;
const HALF_Z = 34;

function stripeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#1d7437' : '#236f3a';
    g.fillRect(0, i * 32, 16, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildPitchside(shadows: boolean): PitchsideController {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];

  // Mown stripes overlaid on the base pitch.
  const stex = stripeTexture();
  const stripeGeo = new THREE.PlaneGeometry(105, 68);
  const stripeMat = new THREE.MeshStandardMaterial({ map: stex, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.55 });
  const stripes = new THREE.Mesh(stripeGeo, stripeMat);
  stripes.rotation.x = -Math.PI / 2;
  stripes.position.y = 0.02;
  stripes.receiveShadow = shadows;
  group.add(stripes);
  trash.push(stripeGeo, stripeMat, stex);

  // LED advertising ring just outside the touchlines.
  const adMat = new THREE.MeshStandardMaterial({ color: 0x0e1118, emissive: 0x2b3a63, emissiveIntensity: 0.7, roughness: 0.5, metalness: 0.1 });
  const boardH = 0.9;
  const m = 2.4;
  const board = (w: number, x: number, z: number, ry: number): void => {
    const g = new THREE.BoxGeometry(w, boardH, 0.2);
    const mesh = new THREE.Mesh(g, adMat);
    mesh.position.set(x, boardH / 2, z);
    mesh.rotation.y = ry;
    group.add(mesh);
    trash.push(g);
  };
  board(2 * HALF_X + 6, 0, HALF_Z + m, 0);
  board(2 * HALF_X + 6, 0, -(HALF_Z + m), 0);
  board(2 * HALF_Z + 6, HALF_X + m, 0, Math.PI / 2);
  board(2 * HALF_Z + 6, -(HALF_X + m), 0, Math.PI / 2);
  trash.push(adMat);

  // Dugouts near halfway (+z touchline).
  const dugMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.85 });
  const dugout = (x: number): void => {
    const g = new THREE.BoxGeometry(7, 1.6, 2);
    const d = new THREE.Mesh(g, dugMat);
    d.position.set(x, 0.8, HALF_Z + m + 2.4);
    d.castShadow = shadows;
    group.add(d);
    trash.push(g);
  };
  dugout(-9);
  dugout(9);
  trash.push(dugMat);

  // Players' tunnel mouth behind the dugouts.
  const tunMat = new THREE.MeshStandardMaterial({ color: 0x04060a, roughness: 1 });
  const tunGeo = new THREE.BoxGeometry(4, 3, 3);
  const tunnel = new THREE.Mesh(tunGeo, tunMat);
  tunnel.position.set(0, 1.5, HALF_Z + m + 5.5);
  group.add(tunnel);
  trash.push(tunGeo, tunMat);

  return {
    object: group,
    setWet(on) {
      // The visible turf surface is these stripes, so the wet sheen must live here.
      stripeMat.roughness = on ? 0.12 : 0.95;
      stripeMat.metalness = on ? 0.5 : 0;
      stripeMat.opacity = on ? 0.72 : 0.55;
      stripeMat.needsUpdate = true;
    },
    dispose() {
      for (const d of trash) d.dispose();
    },
  };
}
