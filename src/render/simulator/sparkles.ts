import * as THREE from 'three';
import type { SeatMap } from '../../core/types';

export interface PhoneFlash {
  readonly object: THREE.Points;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Phone-flash sparkles — a sparse field of twinkling points across the seating
 * bowl, like fans holding up phone flashlights on match night. Sampled from real
 * seat positions and twinkled in a shader (most stay dim, a few flare bright), so
 * it reads as a living crowd rather than a uniform glow. One additive draw call.
 */
export function buildPhoneFlash(map: SeatMap, count = 1500): PhoneFlash {
  const n = Math.min(count, map.count);
  const stride = Math.max(1, Math.floor(map.count / n));
  const posAll: number[] = [];
  const rndAll: number[] = [];
  for (let i = 0; i < map.count && posAll.length < n * 3; i += stride) {
    posAll.push(map.pos3[i * 3], map.pos3[i * 3 + 1] + 1.2, map.pos3[i * 3 + 2]);
    rndAll.push(Math.random());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posAll, 3));
  geo.setAttribute('aRand', new THREE.Float32BufferAttribute(rndAll, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aRand;
      uniform float uTime;
      varying float vTw;
      void main() {
        float ph = aRand * 6.2831853;
        float tw = 0.5 + 0.5 * sin(uTime * (1.4 + aRand * 2.6) + ph);
        vTw = pow(tw, 6.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (1.5 + 8.0 * vTw) * (260.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vTw;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d)) * vTw;
        if (a < 0.01) discard;
        gl_FragColor = vec4(1.0, 0.96, 0.86, a);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  let t = 0;
  return {
    object: points,
    update(dt: number): void {
      t += dt;
      mat.uniforms.uTime.value = t;
    },
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
