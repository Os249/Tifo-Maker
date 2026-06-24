import * as THREE from 'three';

/**
 * Weather (Wave D) — rain or snow as a recycled THREE.Points field around the
 * bowl. One particle system, reconfigured per mode (rain = small fast streaks,
 * snow = soft slow drift). Cheap and self-contained; cleared on 'clear'.
 */

export type Weather = 'clear' | 'rain' | 'snow';

export interface WeatherController {
  setWeather(w: Weather): void;
  update(dt: number): void;
  dispose(): void;
}

const BOX = { w: 300, h: 180, d: 300 };

function streakTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(3, 2, 2, 28);
  return new THREE.CanvasTexture(c);
}
function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export function buildWeather(scene: THREE.Scene): WeatherController {
  const N = 1400;
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * BOX.w;
    pos[i * 3 + 1] = Math.random() * BOX.h;
    pos[i * 3 + 2] = (Math.random() - 0.5) * BOX.d;
    vel[i] = 0.5 + Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const rainTex = streakTexture();
  const snowTex = dotTexture();
  const mat = new THREE.PointsMaterial({
    size: 1.4,
    map: rainTex,
    transparent: true,
    depthWrite: false,
    color: 0xaecbe6,
    opacity: 0.55,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  let mode: Weather = 'clear';

  return {
    setWeather(w) {
      mode = w;
      points.visible = w !== 'clear';
      if (w === 'rain') {
        mat.map = rainTex;
        mat.size = 1.6;
        mat.color.set(0xaecbe6);
        mat.opacity = 0.55;
      } else if (w === 'snow') {
        mat.map = snowTex;
        mat.size = 2.8;
        mat.color.set(0xffffff);
        mat.opacity = 0.9;
      }
      mat.needsUpdate = true;
    },
    update(dt) {
      if (mode === 'clear') return;
      const speed = mode === 'rain' ? 130 : 14;
      const drift = mode === 'snow';
      const arr = geo.attributes.position.array as Float32Array;
      const d = Math.min(0.05, dt);
      for (let i = 0; i < N; i++) {
        arr[i * 3 + 1] -= speed * vel[i] * d;
        if (drift) arr[i * 3] += Math.sin(arr[i * 3 + 1] * 0.1 + i) * 4 * d;
        if (arr[i * 3 + 1] < 0) {
          arr[i * 3] = (Math.random() - 0.5) * BOX.w;
          arr[i * 3 + 1] = BOX.h;
          arr[i * 3 + 2] = (Math.random() - 0.5) * BOX.d;
        }
      }
      geo.attributes.position.needsUpdate = true;
    },
    dispose() {
      scene.remove(points);
      geo.dispose();
      mat.dispose();
      rainTex.dispose();
      snowTex.dispose();
    },
  };
}
