import * as THREE from 'three';

/** A repeating white net texture on transparent canvas. */
function netTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= 64; i += 8) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 64);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(64, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2);
  return t;
}

/**
 * Mowing stripes + faint grass mottle as a near-white multiply map, so it tints
 * the pitch material's green (and survives the wet-pitch colour swap). Repeats
 * ~20 bands goal-to-goal.
 */
export function pitchStripeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#e6e6e6';
  g.fillRect(64, 0, 64, 128);
  const img = g.getImageData(0, 0, 128, 128);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 1);
  t.anisotropy = 4;
  return t;
}

/**
 * Real goals (frame + net) at both ends and the full set of pitch markings that
 * the base pitch was missing (penalty & goal boxes, penalty/centre spots, corner
 * arcs). The pitch is 105 x 68 with its long axis on X, at y ~= 0, so the goal
 * lines are x = +/-52.5. Added to the scene as one group.
 */
export function buildPitchDetail(shadows: boolean): THREE.Group {
  const group = new THREE.Group();
  const HALF_L = 52.5;
  const HALF_W = 34;
  const GW = 7.32;
  const GH = 2.44;
  const GD = 2.0;

  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf4f7f4, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.8 });
  const netMat = new THREE.MeshBasicMaterial({ map: netTexture(), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  const postGeo = new THREE.CylinderGeometry(0.08, 0.08, GH, 8);
  const barGeo = new THREE.CylinderGeometry(0.08, 0.08, GW, 8);

  const buildGoal = (sign: number): void => {
    const x = sign * HALF_L;
    for (const z of [-GW / 2, GW / 2]) {
      const p = new THREE.Mesh(postGeo, frameMat);
      p.position.set(x, GH / 2, z);
      p.castShadow = shadows;
      group.add(p);
    }
    const bar = new THREE.Mesh(barGeo, frameMat);
    bar.position.set(x, GH, 0);
    bar.rotation.x = Math.PI / 2;
    bar.castShadow = shadows;
    group.add(bar);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(GW, GH), netMat);
    back.position.set(x + sign * GD, GH / 2, 0);
    back.rotation.y = Math.PI / 2;
    group.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(GD, GW), netMat);
    top.position.set(x + (sign * GD) / 2, GH, 0);
    top.rotation.x = -Math.PI / 2;
    group.add(top);
    for (const z of [-GW / 2, GW / 2]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(GD, GH), netMat);
      side.position.set(x + (sign * GD) / 2, GH / 2, z);
      group.add(side);
    }
  };
  buildGoal(1);
  buildGoal(-1);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xe7eee7, transparent: true, opacity: 0.8 });
  const y = 0.04;
  const line = (pts: [number, number][]): void => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([px, pz]) => new THREE.Vector3(px, y, pz)));
    group.add(new THREE.Line(geo, lineMat));
  };
  const circle = (cx: number, cz: number, r: number): void => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    line(pts);
  };
  for (const s of [1, -1]) {
    const gl = s * HALF_L;
    line([[gl, -20.16], [gl - s * 16.5, -20.16], [gl - s * 16.5, 20.16], [gl, 20.16]]); // penalty area
    line([[gl, -9.16], [gl - s * 5.5, -9.16], [gl - s * 5.5, 9.16], [gl, 9.16]]); // goal area
    circle(gl - s * 11, 0, 0.3); // penalty spot
    circle(gl, -HALF_W, 1); // corner arc
    circle(gl, HALF_W, 1); // corner arc
  }
  circle(0, 0, 0.3); // centre spot

  return group;
}
