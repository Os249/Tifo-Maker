import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SeatMap } from '../../core/types';

/**
 * Match Day Simulator — camera director (Phase 6).
 *
 * Named broadcast/cinematic shots plus two shots derived from the seat map at
 * runtime (a seat in the crowd, and the top of the painted "ultra" end), and a
 * looping cinematic flyover that orbits and pushes in. The simulator applies a
 * shot on selection and, while the flyover is active, calls flyover() each frame.
 */

export interface SimShot {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const SIM_SHOTS: SimShot[] = [
  { name: 'TV Broadcast', position: [0, 40, -120], target: [0, 8, 8], fov: 38 },
  { name: 'Main Camera', position: [0, 28, -92], target: [0, 6, 6], fov: 42 },
  { name: 'Pitch Level', position: [36, 1.8, 30], target: [-50, 14, -40], fov: 55 },
  { name: 'Behind Goal', position: [106, 9, 0], target: [-40, 14, 0], fov: 45 },
  { name: 'Tunnel', position: [0, 2.2, 48], target: [0, 9, -20], fov: 62 },
  { name: 'Drone', position: [72, 92, 92], target: [0, 0, 0], fov: 50 },
];

export function applyShot(camera: THREE.PerspectiveCamera, controls: OrbitControls, s: SimShot): void {
  camera.position.set(s.position[0], s.position[1], s.position[2]);
  controls.target.set(s.target[0], s.target[1], s.target[2]);
  camera.fov = s.fov;
  camera.updateProjectionMatrix();
  controls.update();
}

/** A shot placed at a real seat: 'crowd' = high north stand, 'ultra' = high south (often the painted end). */
export function seatShot(map: SeatMap, which: 'crowd' | 'ultra'): SimShot {
  const wantStand = which === 'crowd' ? 1 : 3;
  let best = -1;
  let bestY = -Infinity;
  for (let i = 0; i < map.count; i++) {
    const stand = Math.floor(((map.uv[i * 2] + 0.125) % 1) * 4);
    if (stand !== wantStand) continue;
    const y = map.pos3[i * 3 + 1];
    if (y > bestY) {
      bestY = y;
      best = i;
    }
  }
  if (best < 0) return SIM_SHOTS[0];
  return {
    name: which === 'crowd' ? 'Crowd View' : 'Ultra View',
    position: [map.pos3[best * 3], map.pos3[best * 3 + 1] + 1.2, map.pos3[best * 3 + 2]],
    target: [0, 6, 0],
    fov: 62,
  };
}

const FLY_DURATION = 18; // seconds per loop

/** Camera state for the cinematic flyover at a given elapsed time (loops). */
export function flyover(elapsed: number): SimShot {
  const t = (elapsed % FLY_DURATION) / FLY_DURATION;
  const ang = t * Math.PI * 2;
  const ease = Math.sin(t * Math.PI); // 0 -> 1 -> 0
  const radius = 165 - 80 * ease;
  const height = 130 - 85 * ease;
  return {
    name: 'Flyover',
    position: [Math.cos(ang) * radius, Math.max(5, height), Math.sin(ang) * radius],
    target: [0, 9, 0],
    fov: 46,
  };
}
