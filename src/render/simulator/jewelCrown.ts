import * as THREE from 'three';

/** A diamond-lattice (mashrabiya) texture — cream lines on transparent. */
function latticeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(235,225,205,0.95)';
  g.lineWidth = 5;
  for (let k = -128; k < 128; k += 24) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 128, 128);
    g.stroke();
    g.beginPath();
    g.moveTo(k + 128, 0);
    g.lineTo(k, 128);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(54, 5);
  return t;
}

/**
 * The Jewel's roof — King Abdullah Sports City's signature crown, done properly:
 * a ring of broad CURVED membrane panels ("petals") that spring from the outer
 * roof edge, bow upward, and fold inward over the seats toward a large oval
 * opening above the pitch. Cream/white, softly lit from beneath so it glows gold
 * at night. Plus a white steel-lattice skirt wrapping the base of the bowl.
 * Jewel template only.
 */
export function buildJewelCrown(): { object: THREE.Group; disposables: { dispose(): void }[] } {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];

  const N = 22; // petals
  const R_OUT = 126;
  const R_IN = 76; // oval opening radius (clears the 105x68 pitch)
  const Y_OUT = 37;
  const Y_IN = 43;
  const BOW = 8; // how much each panel bows upward mid-span
  const RAD = 14; // radial segments
  const COVER = 0.985; // slight seams for panel definition

  // One petal built along local +X (radial), curving up in Y, tapering width in Z.
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RAD; i++) {
    const t = i / RAD;
    const r = R_OUT + (R_IN - R_OUT) * t;
    const y = Y_OUT + (Y_IN - Y_OUT) * t + Math.sin(t * Math.PI) * BOW;
    const hw = (COVER * Math.PI * r) / N; // tangential half-width shrinks with r
    verts.push(r, y, -hw, r, y, hw);
  }
  for (let i = 0; i < RAD; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const petalGeo = new THREE.BufferGeometry();
  petalGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  petalGeo.setIndex(idx);
  petalGeo.computeVertexNormals();
  const petalMat = new THREE.MeshStandardMaterial({
    color: 0xece5d5,
    emissive: 0xd0a24a,
    emissiveIntensity: 0.17,
    roughness: 0.5,
    metalness: 0.12,
    side: THREE.DoubleSide,
  });
  const petals = new THREE.InstancedMesh(petalGeo, petalMat, N);
  petals.frustumCulled = false;
  const d = new THREE.Object3D();
  for (let i = 0; i < N; i++) {
    d.position.set(0, 0, 0);
    d.rotation.set(0, (i / N) * Math.PI * 2, 0);
    d.updateMatrix();
    petals.setMatrixAt(i, d.matrix);
  }
  petals.instanceMatrix.needsUpdate = true;
  group.add(petals);
  trash.push(petalGeo, petalMat);

  // White outer roof-fascia ring at the springing line.
  const fasciaGeo = new THREE.CylinderGeometry(R_OUT + 1, R_OUT + 5, 5, 80, 1, true);
  const fasciaMat = new THREE.MeshStandardMaterial({ color: 0xe7e0d0, emissive: 0x2a2416, emissiveIntensity: 0.14, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide });
  const fascia = new THREE.Mesh(fasciaGeo, fasciaMat);
  fascia.position.y = Y_OUT - 1;
  group.add(fascia);
  trash.push(fasciaGeo, fasciaMat);

  // Inner oval-opening rim (thin bright ring around the hole).
  const rimGeo = new THREE.TorusGeometry(R_IN, 0.9, 8, 80);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xf2ecdd, emissive: 0xd8b06a, emissiveIntensity: 0.32, roughness: 0.4, metalness: 0.3 });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = Y_IN;
  group.add(rim);
  trash.push(rimGeo, rimMat);

  // White steel-lattice skirt wrapping the base of the bowl.
  const latTex = latticeTexture();
  const skirtGeo = new THREE.CylinderGeometry(R_OUT + 2, R_OUT + 7, 40, 108, 1, true);
  const skirtMat = new THREE.MeshStandardMaterial({
    map: latTex,
    alphaMap: latTex,
    transparent: true,
    color: 0xf0ead9,
    emissive: 0xc9a455,
    emissiveIntensity: 0.32,
    emissiveMap: latTex,
    roughness: 0.5,
    metalness: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const skirt = new THREE.Mesh(skirtGeo, skirtMat);
  skirt.position.y = 20;
  group.add(skirt);
  trash.push(skirtGeo, skirtMat, latTex);

  return { object: group, disposables: trash };
}
