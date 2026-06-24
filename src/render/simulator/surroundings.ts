import * as THREE from 'three';

/**
 * Surroundings — the world the stadium sits in (so it isn't floating in a void).
 * A large dark ground plane plus an instanced city‑skyline ring of buildings with
 * a window texture that glows at night (emissiveMap). One instanced draw for the
 * whole skyline, so it's cheap. Purely decorative backdrop; no shadows.
 */

export interface Surroundings {
  readonly object: THREE.Group;
  dispose(): void;
}

function windowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e1118';
  g.fillRect(0, 0, 64, 128);
  for (let y = 6; y < 128; y += 10) {
    for (let x = 6; x < 64; x += 12) {
      g.fillStyle = Math.random() < 0.45 ? '#ffd98a' : '#161d2a';
      g.fillRect(x, y, 7, 6);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 6);
  return t;
}

export function buildSurroundings(): Surroundings {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];

  // Far ground plane (asphalt-dark), well below the apron.
  const groundGeo = new THREE.PlaneGeometry(1600, 1600);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 1, metalness: 0 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.2;
  group.add(ground);
  trash.push(groundGeo, groundMat);

  // City skyline ring (instanced buildings).
  const winTex = windowTexture();
  const bGeo = new THREE.BoxGeometry(1, 1, 1);
  const bMat = new THREE.MeshStandardMaterial({
    color: 0x232a36,
    map: winTex,
    emissive: 0xffe6b0,
    emissiveMap: winTex,
    emissiveIntensity: 0.5,
    roughness: 0.85,
    metalness: 0.1,
  });
  const COUNT = 170;
  const mesh = new THREE.InstancedMesh(bGeo, bMat, COUNT);
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < COUNT; i++) {
    const ang = (i / COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
    const r = 240 + Math.random() * 240;
    const w = 8 + Math.random() * 22;
    const h = 14 + Math.random() * 92;
    const d = 8 + Math.random() * 22;
    dummy.position.set(Math.cos(ang) * r, h / 2 - 0.2, Math.sin(ang) * r);
    dummy.scale.set(w, h, d);
    dummy.rotation.y = ang + Math.PI / 2 + (Math.random() - 0.5);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const v = 0.6 + Math.random() * 0.6;
    mesh.setColorAt(i, tint.setRGB(v * 0.7, v * 0.74, v * 0.85));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  trash.push(bGeo, bMat, winTex);

  return {
    object: group,
    dispose() {
      for (const t of trash) t.dispose();
    },
  };
}
