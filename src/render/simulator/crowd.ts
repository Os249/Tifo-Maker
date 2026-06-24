import * as THREE from 'three';
import type { SeatMap } from '../../core/types';
import type { DesignStore } from '../../core/design';

/**
 * Match Day Simulator — crowd (Phase 2).
 *
 * One InstancedMesh of camera-card-style spectator billboards, one slot per seat,
 * placed on seats that are NOT part of the tifo (or everywhere, if "show on tifo"
 * is on). Density hides a deterministic fraction; colours come from the design's
 * palette split into home/away supporter sections by stand. Hidden instances are
 * scaled to zero — still one draw call for the whole crowd.
 */

export type CrowdPreset = 'sellout' | 'home' | 'away-end' | 'half' | 'empty';

export interface CrowdController {
  readonly object: THREE.Object3D;
  setDensity(f: number): void;
  setPreset(p: CrowdPreset): void;
  setShowOnTifo(b: boolean): void;
  refresh(): void;
  dispose(): void;
}

const PRESET_DENSITY: Record<CrowdPreset, number> = {
  sellout: 0.97,
  home: 0.9,
  'away-end': 0.88,
  half: 0.5,
  empty: 0,
};

function hash(i: number): number {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

function personTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 32, 64);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(16, 13, 7, 0, Math.PI * 2);
  g.fill(); // head
  g.beginPath();
  g.moveTo(5, 64);
  g.lineTo(7, 29);
  g.quadraticCurveTo(16, 19, 25, 29);
  g.lineTo(27, 64);
  g.closePath();
  g.fill(); // shoulders + torso
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const HOME = new THREE.Color(0x9a1f2b);
const AWAY = new THREE.Color(0x16386e);
const NEUTRAL = new THREE.Color(0x8a8f98);

export function buildCrowd(map: SeatMap, store: DesignStore): CrowdController {
  const tex = personTexture();
  const geo = new THREE.PlaneGeometry(0.62, 1.25);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, map.count);
  mesh.frustumCulled = false;

  const home = store.palette[1] ? new THREE.Color(store.palette[1]) : HOME;
  const away = store.palette[2] ? new THREE.Color(store.palette[2]) : AWAY;

  let density = PRESET_DENSITY.sellout;
  let preset: CrowdPreset = 'sellout';
  let showOnTifo = false;

  const dummy = new THREE.Object3D();
  const tmp = new THREE.Color();
  const standOf = (u: number): number => Math.floor(((u + 0.125) % 1) * 4); // 0 E,1 N,2 W,3 S

  const colorFor = (i: number): THREE.Color => {
    const stand = standOf(map.uv[i * 2]);
    let base: THREE.Color;
    if (preset === 'away-end') base = stand === 3 ? away : home;
    else if (preset === 'sellout') base = stand === 3 && hash(i * 7) < 0.5 ? away : home;
    else base = home;
    tmp.copy(hash(i * 3) < 0.12 ? NEUTRAL : base);
    tmp.multiplyScalar(0.72 + hash(i * 5) * 0.5);
    return tmp;
  };

  const refresh = (): void => {
    for (let i = 0; i < map.count; i++) {
      const isTifo = store.cells[i] !== 0;
      const allowed = (showOnTifo || !isTifo) && hash(i) < density;
      if (!allowed) {
        dummy.position.set(0, -9999, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const x = map.pos3[i * 3];
      const y = map.pos3[i * 3 + 1] + 0.62;
      const z = map.pos3[i * 3 + 2];
      dummy.position.set(x, y, z);
      dummy.scale.set(1, 0.92 + hash(i * 11) * 0.18, 1);
      dummy.lookAt(0, y, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, colorFor(i));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  refresh();

  return {
    object: mesh,
    setDensity(f) {
      density = Math.max(0, Math.min(1, f));
      refresh();
    },
    setPreset(p) {
      preset = p;
      density = PRESET_DENSITY[p];
      refresh();
    },
    setShowOnTifo(b) {
      showOnTifo = b;
      refresh();
    },
    refresh,
    dispose() {
      geo.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
