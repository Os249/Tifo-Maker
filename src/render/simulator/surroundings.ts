import * as THREE from 'three';

/**
 * Surroundings — the living world the stadium sits in. A dark ground plane, an
 * instanced city-skyline ring (glowing windows), a warm lamp-post plaza ring at
 * the stadium base, and streams of instanced pedestrians walking in toward the
 * ground on match night. Pedestrians are cross-quad billboards (read from any
 * angle) animated in update(dt). All instanced — a handful of draw calls.
 */

export interface Surroundings {
  readonly object: THREE.Group;
  update(dt: number): void;
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

/** A dark person silhouette with a warm rim light, on a transparent canvas. */
function personTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 32, 64);
  g.fillStyle = '#0a0c11';
  g.beginPath();
  g.ellipse(16, 46, 7, 17, 0, 0, Math.PI * 2); // torso + legs
  g.fill();
  g.beginPath();
  g.arc(16, 22, 6, 0, Math.PI * 2); // head
  g.fill();
  g.strokeStyle = 'rgba(255,196,120,0.5)'; // warm rim light down one side
  g.lineWidth = 2.5;
  g.beginPath();
  g.ellipse(16, 46, 7, 17, 0, -Math.PI / 2, Math.PI / 2);
  g.stroke();
  g.beginPath();
  g.arc(16, 22, 6, -Math.PI / 2, Math.PI / 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function crossQuad(w: number, h: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  const positions = new Float32Array([
    -hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, -hh, 0, hw, hh, 0, -hw, hh, 0,
    0, -hh, -hw, 0, -hh, hw, 0, hh, hw, 0, -hh, -hw, 0, hh, hw, 0, hh, -hw,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
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

  // Warm lamp-post plaza ring at the stadium base.
  const postGeo = new THREE.CylinderGeometry(0.35, 0.5, 15, 6);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x161a22, roughness: 0.6, metalness: 0.6, envMapIntensity: 0.6 });
  const bulbGeo = new THREE.SphereGeometry(1.2, 10, 10);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff2d4, emissive: 0xffcf87, emissiveIntensity: 2.4 });
  const LAMPS = 52;
  const posts = new THREE.InstancedMesh(postGeo, postMat, LAMPS);
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, LAMPS);
  posts.frustumCulled = false;
  bulbs.frustumCulled = false;
  const lm = new THREE.Object3D();
  for (let i = 0; i < LAMPS; i++) {
    const ang = (i / LAMPS) * Math.PI * 2;
    const x = Math.cos(ang) * 202;
    const z = Math.sin(ang) * 202;
    lm.position.set(x, 7.3, z);
    lm.updateMatrix();
    posts.setMatrixAt(i, lm.matrix);
    lm.position.set(x, 15.4, z);
    lm.updateMatrix();
    bulbs.setMatrixAt(i, lm.matrix);
  }
  posts.instanceMatrix.needsUpdate = true;
  bulbs.instanceMatrix.needsUpdate = true;
  group.add(posts, bulbs);
  trash.push(postGeo, postMat, bulbGeo, bulbMat);

  // Pedestrians — streams of fans converging on the stadium (cross-quad billboards).
  const personTex = personTexture();
  const personGeo = crossQuad(3.4, 7.2);
  const personMat = new THREE.MeshBasicMaterial({
    map: personTex,
    transparent: true,
    alphaTest: 0.4,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  const PEOPLE = 360;
  const people = new THREE.InstancedMesh(personGeo, personMat, PEOPLE);
  people.frustumCulled = false;
  const pAng = new Float32Array(PEOPLE);
  const pRad = new Float32Array(PEOPLE);
  const pSpd = new Float32Array(PEOPLE);
  const pPhase = new Float32Array(PEOPLE);
  const spawn = (i: number, near: boolean): void => {
    pAng[i] = Math.random() * Math.PI * 2;
    pRad[i] = near ? 200 + Math.random() * 170 : 345 + Math.random() * 45;
    pSpd[i] = 6 + Math.random() * 9;
    pPhase[i] = Math.random() * Math.PI * 2;
  };
  for (let i = 0; i < PEOPLE; i++) spawn(i, true);
  const pd = new THREE.Object3D();
  const writePeople = (t: number): void => {
    for (let i = 0; i < PEOPLE; i++) {
      const x = Math.cos(pAng[i]) * pRad[i];
      const z = Math.sin(pAng[i]) * pRad[i];
      const y = 3.7 + Math.sin(t * (pSpd[i] * 0.6) + pPhase[i]) * 0.35; // walking bob
      pd.position.set(x, y, z);
      pd.lookAt(0, y, 0); // face (and walk toward) the stadium
      pd.updateMatrix();
      people.setMatrixAt(i, pd.matrix);
    }
    people.instanceMatrix.needsUpdate = true;
  };
  writePeople(0);
  group.add(people);
  trash.push(personGeo, personMat, personTex);

  let clock = 0;
  return {
    object: group,
    update(dt: number): void {
      clock += dt;
      for (let i = 0; i < PEOPLE; i++) {
        pRad[i] -= pSpd[i] * dt;
        if (pRad[i] < 196) spawn(i, false); // reached the ground — loop back out
      }
      writePeople(clock);
    },
    dispose(): void {
      for (const t of trash) t.dispose();
    },
  };
}
