import * as THREE from 'three';
import type { SeatMap } from '../core/types';

/**
 * The seats themselves, for the Stadium view: one small chair on every seat,
 * in the ground's own colour, facing the pitch.
 *
 * Chairs never move and never change colour (a tifo is a card held up above
 * them, drawn separately), so they are not instanced: they are baked into a
 * few big static meshes, chunked by where they are so a camera inside the bowl
 * skips the stands behind it. Tiny instanced meshes (8 vertices each) waste
 * most of a GPU's vertex batch; one merged mesh per chunk does not.
 *
 * Lighting is baked into the vertex colours from the same key light the view
 * uses, so the material is the cheapest one three.js has (MeshBasicMaterial):
 * the stand facing the sun is brighter than the one in its shadow, the seat
 * pan (facing up) brighter than the back, and no shader does any of it per
 * frame. That is the whole trick that makes 80,000 chairs cheap on a phone.
 */

/** Where the key light comes from (normalised in use) — keep in step with Preview3D's. */
export const KEY_LIGHT_DIR: [number, number, number] = [90, 140, 60];

/** Max chairs per chunk: 8 vertices each keeps every index under 65,536 (Uint16). */
const CHUNK = 8000;

export interface ChairBuild {
  object: THREE.Group;
  dispose(): void;
  /** Triangles drawn when every chunk is in view. */
  triangles: number;
}

/**
 * Which way each seat faces, in the ground plane: (fx, fz) per seat, a unit
 * vector from the seat towards the pitch, square to its row.
 *
 * From the seat's neighbours along its row rather than from the bowl's plan
 * curve, so a straight stand, a corner and a stand that is its own block all
 * come out square to their own rows. A seat alone in its row (no neighbours)
 * faces the nearest point of the pitch.
 */
export function seatFacing(map: SeatMap): Float32Array {
  const n = map.count;
  const out = new Float32Array(n * 2);
  const P = map.pos3;
  const nb = map.neighbors;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3];
    const z = P[i * 3 + 2];
    // The nearest point of the pitch: which side "inwards" is.
    const cx = Math.max(-52.5, Math.min(52.5, x)) - x;
    const cz = Math.max(-34, Math.min(34, z)) - z;
    const l = nb[i * 4];
    const r = nb[i * 4 + 1];
    let tx = 0;
    let tz = 0;
    if (l >= 0 || r >= 0) {
      const a = l >= 0 ? l : i;
      const b = r >= 0 ? r : i;
      tx = P[b * 3] - P[a * 3];
      tz = P[b * 3 + 2] - P[a * 3 + 2];
    }
    let fx: number;
    let fz: number;
    const tl = Math.hypot(tx, tz);
    if (tl > 1e-4) {
      fx = -tz / tl;
      fz = tx / tl;
      if (fx * cx + fz * cz < 0 || (Math.abs(cx) + Math.abs(cz) < 1e-6 && fx * -x + fz * -z < 0)) {
        fx = -fx;
        fz = -fz;
      }
    } else {
      // No row to be square to: face the pitch (or the centre spot, from on it).
      let dx = cx;
      let dz = cz;
      if (Math.abs(dx) + Math.abs(dz) < 1e-6) {
        dx = -x;
        dz = -z;
      }
      const dl = Math.hypot(dx, dz) || 1;
      fx = dx / dl;
      fz = dz / dl;
    }
    out[i * 2] = fx;
    out[i * 2 + 1] = fz;
  }
  return out;
}

function hash(i: number): number {
  let x = Math.imul(i ^ 0x5bd1e995, 2654435761) >>> 0;
  x ^= x >>> 15;
  return (Math.imul(x, 2246822519) >>> 0) / 4294967296;
}

/** sRGB 0..255 -> linear 0..1, the space vertex colours are read in. */
const LIN = new Float32Array(256);
for (let k = 0; k < 256; k++) {
  const c = k / 255;
  LIN[k] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Linear 0..1 -> gamma-encoded 0..255 (the attribute is decoded with pow 2.2 in the shader). */
function toByte(lin: number): number {
  const c = Math.max(0, Math.min(1, lin));
  return Math.round(c ** (1 / 2.2) * 255);
}

/**
 * Build the chairs.
 *
 *   - `colours`: sRGB bytes per seat (render/seatColours.ts);
 *   - `skip`: seats that already have a chair of their own (premium seating,
 *     render/simulator/premium.ts) or none at all;
 *   - `detail`: 'full' is a seat pan and a back (4 triangles); 'low' is the
 *     back alone, leaning over the pan (2 triangles) — at the distance a
 *     phone's whole-bowl view sees a seat from, the two are the same pixels.
 */
/** Width of the per-seat state texture (see `cardUp`). */
export const SEAT_TEX_W = 1024;

/**
 * One byte per seat, 255 where that seat's card is up: the chairs read it in
 * their vertex shader and go dark under a raised card — that seat's fan is
 * standing in front of it, holding the card. Without this the bare chairs
 * between the rows of cards tint the whole tifo with the seat colour from
 * above (a blue design on red seats read as purple).
 */
export function seatStateTexture(count: number): THREE.DataTexture {
  const h = Math.max(1, Math.ceil(count / SEAT_TEX_W));
  const t = new THREE.DataTexture(new Uint8Array(SEAT_TEX_W * h), SEAT_TEX_W, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function buildChairs(
  map: SeatMap,
  colours: Uint8Array,
  facing: Float32Array,
  opts: { skip?: Uint8Array | null; detail?: 'full' | 'low'; cardUp?: THREE.DataTexture | null } = {},
): ChairBuild {
  const group = new THREE.Group();
  group.name = 'chairs';
  const detail = opts.detail ?? 'full';
  const skip = opts.skip ?? null;
  const vPer = detail === 'full' ? 8 : 4;
  const iPer = detail === 'full' ? 12 : 6;
  const L = new THREE.Vector3(...KEY_LIGHT_DIR).normalize();
  // A flat-lit chair: sky ambient plus the key's cosine. Measured off the
  // preview: these keep a red seat red in the shade and unblown in the sun.
  const AMB = 0.6;
  const KEY = 0.48;
  const shadeOf = (nx: number, ny: number, nz: number): number => AMB + KEY * Math.max(0, nx * L.x + ny * L.y + nz * L.z);
  const panShade = shadeOf(0, 1, 0);

  // Chunk the seats by where they are: a slice of the bowl (by u). Eight
  // slices is enough for a camera inside the bowl to skip what is behind it,
  // and few enough to keep the chairs a dozen or so draw calls.
  const SLICES = 8;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < map.count; i++) {
    if (skip && skip[i]) continue;
    const u = map.uv[i * 2];
    const key = Math.min(SLICES - 1, Math.floor((((u % 1) + 1) % 1) * SLICES));
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(i);
  }
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false });
  // The colours are stored as sRGB bytes — linear values in 8 bits band the
  // dark seats (navy, black) badly — and decoded per vertex here.
  const cardUp = opts.cardUp ?? null;
  material.onBeforeCompile = (shader) => {
    let decode = '#include <color_vertex>\n  vColor.rgb = pow( vColor.rgb, vec3( 2.2 ) );';
    if (cardUp) {
      shader.uniforms.uCardUp = { value: cardUp };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\nattribute float aSeat;\nuniform sampler2D uCardUp;`);
      // Under a raised card: the fan standing there, in dark clothes.
      decode += `\n  float seatUp = texelFetch( uCardUp, ivec2( int( mod( aSeat, ${SEAT_TEX_W}.0 ) ), int( aSeat / ${SEAT_TEX_W}.0 ) ), 0 ).r;\n  vColor.rgb = mix( vColor.rgb, vec3( 0.016, 0.017, 0.02 ), seatUp );`;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', decode);
  };
  material.customProgramCacheKey = () => (cardUp ? 'tifo-chairs-srgb-up' : 'tifo-chairs-srgb');
  const geos: THREE.BufferGeometry[] = [];
  let triangles = 0;
  const P = map.pos3;
  for (const all of buckets.values()) {
    for (let start = 0; start < all.length; start += CHUNK) {
      const seats = all.slice(start, start + CHUNK);
      const m = seats.length;
      const pos = new Float32Array(m * vPer * 3);
      const col = new Uint8Array(m * vPer * 3);
      const seatOf = cardUp ? new Float32Array(m * vPer) : null;
      const idx = new Uint16Array(m * iPer);
      let v = 0;
      let k = 0;
      const vert = (x: number, y: number, z: number, r: number, g: number, b: number): void => {
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        col[v * 3] = r;
        col[v * 3 + 1] = g;
        col[v * 3 + 2] = b;
        if (seatOf) seatOf[v] = cur;
        v++;
      };
      let cur = 0;
      const quad = (a: number): void => {
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = a + 2;
        idx[k++] = a;
        idx[k++] = a + 2;
        idx[k++] = a + 3;
      };
      for (const i of seats) {
        cur = i;
        const px = P[i * 3];
        const py = P[i * 3 + 1];
        const pz = P[i * 3 + 2];
        const fx = facing[i * 2];
        const fz = facing[i * 2 + 1];
        // Across the seat (right as you sit in it).
        const rx = -fz;
        const rz = fx;
        const w = 0.21;
        // A little fading in the sun: no two seats in a stand are quite the same.
        const fade = 0.94 + hash(i) * 0.1;
        const cr = LIN[colours[i * 3]] * fade;
        const cg = LIN[colours[i * 3 + 1]] * fade;
        const cb = LIN[colours[i * 3 + 2]] * fade;
        // The back faces the pitch, leaning back a touch.
        const nl = Math.hypot(fx, 0.18, fz);
        const backShade = shadeOf(fx / nl, 0.18 / nl, fz / nl);
        const br = toByte(cr * backShade);
        const bg = toByte(cg * backShade);
        const bb = toByte(cb * backShade);
        // Backrest: bottom edge at the back of the pan, top leaning back.
        const b0x = px - fx * 0.13;
        const b0z = pz - fz * 0.13;
        const b1x = px - fx * 0.2;
        const b1z = pz - fz * 0.2;
        const yb = py + (detail === 'full' ? 0.44 : 0.4);
        const yt = py + 0.84;
        const base = v;
        if (detail === 'full') {
          vert(b0x - rx * w, yb, b0z - rz * w, br, bg, bb);
          vert(b0x + rx * w, yb, b0z + rz * w, br, bg, bb);
          vert(b1x + rx * w, yt, b1z + rz * w, br, bg, bb);
          vert(b1x - rx * w, yt, b1z - rz * w, br, bg, bb);
          quad(base);
          // Seat pan: from the back of the seat to its front edge, the front a little higher.
          const pr = toByte(cr * panShade);
          const pg = toByte(cg * panShade);
          const pb = toByte(cb * panShade);
          const f0x = px + fx * 0.25;
          const f0z = pz + fz * 0.25;
          vert(f0x - rx * w, py + 0.46, f0z - rz * w, pr, pg, pb);
          vert(f0x + rx * w, py + 0.46, f0z + rz * w, pr, pg, pb);
          vert(b0x + rx * w, yb, b0z + rz * w, pr, pg, pb);
          vert(b0x - rx * w, yb, b0z - rz * w, pr, pg, pb);
          quad(base + 4);
          triangles += 4;
        } else {
          // One panel from the front of the pan up to the top of the back.
          const f0x = px + fx * 0.22;
          const f0z = pz + fz * 0.22;
          const sr = toByte(cr * (backShade + panShade) * 0.5);
          const sg = toByte(cg * (backShade + panShade) * 0.5);
          const sb = toByte(cb * (backShade + panShade) * 0.5);
          vert(f0x - rx * w, yb, f0z - rz * w, sr, sg, sb);
          vert(f0x + rx * w, yb, f0z + rz * w, sr, sg, sb);
          vert(b1x + rx * w, yt, b1z + rz * w, br, bg, bb);
          vert(b1x - rx * w, yt, b1z - rz * w, br, bg, bb);
          quad(base);
          triangles += 2;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const ca = new THREE.BufferAttribute(col, 3, true);
      geo.setAttribute('color', ca);
      if (seatOf) geo.setAttribute('aSeat', new THREE.BufferAttribute(seatOf, 1));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      geos.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.matrixAutoUpdate = false;
      mesh.name = 'chairs-chunk';
      group.add(mesh);
    }
  }
  group.matrixAutoUpdate = false;
  return {
    object: group,
    triangles,
    dispose(): void {
      for (const g of geos) g.dispose();
      material.dispose();
    },
  };
}
