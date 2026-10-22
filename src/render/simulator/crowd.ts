import * as THREE from 'three';
import type { SeatMap } from '../../core/types';
import type { DesignStore } from '../../core/design';

/**
 * Match Day Simulator — crowd (Phase 2).
 *
 * One InstancedMesh of camera-card-style spectator billboards, one slot per seat,
 * placed on seats that are NOT part of the tifo (or everywhere, if "show on tifo"
 * is on). Density hides a deterministic fraction; colours come from the design's
 * palette split into home/away supporter sections by stand. Only the people who
 * are there are drawn: they are packed to the front of the instance buffer, in
 * seat order, and the mesh draws that many — still one draw call for the whole
 * crowd, and none for the seats under the tifo, which on a full design is
 * nearly all of them (performance plan P1.21).
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
  // Head in skin and hair, body in white. The shader tints only the white:
  // a crowd whose faces are the colour of its shirts reads as a colour field,
  // not as people — which is the difference between a stand and a crowd.
  g.fillStyle = '#c49774';
  g.beginPath();
  g.arc(16, 13, 7, 0, Math.PI * 2);
  g.fill(); // face
  g.fillStyle = '#2a1d16';
  g.beginPath();
  g.arc(16, 11, 7, Math.PI, Math.PI * 2);
  g.fill(); // hair
  g.fillStyle = '#ffffff';
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
const THOBE = new THREE.Color(0xf4f1ea);
const BISHT = new THREE.Color(0x1c1814);

/**
 * `dressed`: seats whose occupants wear their own clothes rather than the
 * club's colours — the royal box, in white thobes with the odd black bisht.
 */
export function buildCrowd(map: SeatMap, store: DesignStore, dressed: Uint8Array | null = null): CrowdController {
  const tex = personTexture();
  const geo = new THREE.PlaneGeometry(0.62, 1.25);
  // Drawn in ONE pass (performance plan P1.21). three draws a transparent
  // double-sided material twice, back faces then front faces, so every fan
  // cost two triangles' worth of every instance; a flat billboard shows only
  // one face to the camera, so a single pass draws the same pixels. It stays
  // transparent rather than opaque: the soft edge of a distant fan is
  // blended, and drawn opaque those edges went hard — 2.5% of the picture
  // changed by up to 96 levels in a full Kingdom Arena — where a single pass
  // changes nothing.
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, forceSinglePass: true });
  // Tint the shirt, not the head: the head is the only part of the texture
  // with a low blue channel (skin and hair), so it keeps its own colour.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      // vColor is a vec4 in three r184 (color_pars_fragment), so take .rgb:
      // mixing a vec4 with a vec3 fails to compile and the crowd vanishes.
      `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        float isHead = step( texture2D( map, vMapUv ).b, 0.8 );
        vec3 shirt = vColor.rgb;
        diffuseColor.rgb *= mix( shirt, vec3( 0.55 + 0.45 * shirt.g ), isHead );
        diffuseColor.a *= vColor.a;
      #endif`,
    );
  };
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
    if (dressed && dressed[i]) {
      tmp.copy(hash(i * 13) < 0.12 ? BISHT : THOBE);
      tmp.multiplyScalar(0.9 + hash(i * 5) * 0.15);
      return tmp;
    }
    const stand = standOf(map.uv[i * 2]);
    let base: THREE.Color;
    if (preset === 'away-end') base = stand === 3 ? away : home;
    else if (preset === 'sellout') base = stand === 3 && hash(i * 7) < 0.5 ? away : home;
    else base = home;
    tmp.copy(hash(i * 3) < 0.12 ? NEUTRAL : base);
    tmp.multiplyScalar(0.72 + hash(i * 5) * 0.5);
    return tmp;
  };

  /** Who is in which seat at the last refresh. */
  const present = new Uint8Array(map.count);
  /** A fan's placement: on the seat, a little taller or shorter, facing the pitch. */
  const place = (i: number): THREE.Matrix4 => {
    const x = map.pos3[i * 3];
    const y = map.pos3[i * 3 + 1] + 0.62;
    const z = map.pos3[i * 3 + 2];
    dummy.position.set(x, y, z);
    dummy.scale.set(1, 0.92 + hash(i * 11) * 0.18, 1);
    dummy.lookAt(0, y, 0);
    dummy.updateMatrix();
    return dummy.matrix;
  };

  const refresh = (): void => {
    let n = 0;
    for (let i = 0; i < map.count; i++) {
      const isTifo = store.cells[i] !== 0;
      const allowed = (showOnTifo || !isTifo) && hash(i) < density;
      present[i] = allowed ? 1 : 0;
      if (!allowed) continue;
      mesh.setMatrixAt(n, place(i));
      mesh.setColorAt(n, colorFor(i));
      n++;
    }
    mesh.count = n;
    // Only the part that is drawn goes to the GPU. (Nothing at all for an
    // empty ground: a zero-length range would mean "to the end" to WebGL.)
    if (n === 0) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  };

  /**
   * Where three sorts the crowd among the transparent things, kept where it
   * was. three places a transparent mesh by the centre of its bounding
   * sphere, worked out over the instances it draws, and the empty seats used
   * to be in that buffer as zero-size fans at (0, -9999, 0). Packing them out
   * moved the sphere, and with it the order the crowd and the floodlights'
   * haze are blended in: up to 13 levels in the haze over the far stand. So
   * the sphere is still the one the whole buffer gave — every seat in order,
   * through float32 as the buffer stored it — and the picture is the same.
   */
  const SCRATCH = new Float32Array(16);
  const seatMatrix = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  mesh.computeBoundingSphere = (): void => {
    const bs = (mesh.boundingSphere ??= new THREE.Sphere());
    if (geo.boundingSphere === null) geo.computeBoundingSphere();
    bs.makeEmpty();
    for (let i = 0; i < map.count; i++) {
      let m: THREE.Matrix4;
      if (present[i]) m = place(i);
      else {
        dummy.position.set(0, -9999, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        m = dummy.matrix;
      }
      m.toArray(SCRATCH);
      seatMatrix.fromArray(SCRATCH);
      sphere.copy(geo.boundingSphere!).applyMatrix4(seatMatrix);
      bs.union(sphere);
    }
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
