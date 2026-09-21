import type { StandFrame } from './standFrame';

/**
 * The stand, as something cloth can collide with.
 *
 * The banner rig used to keep itself out of the terracing by sitting a fixed
 * number of metres off the stand's surface along its normal. That is not a
 * collision, it is a hope: the surface is raked and stepped, the offset is
 * constant, and the moment a sheet hangs vertically — which is what a sheet
 * hung from a top edge actually does — the two diverge and the fabric goes
 * through the seats. That is the bug in the screenshot.
 *
 * A heightfield fixes it by construction. Terracing is single-valued over the
 * ground plane: for any (x, z) there is exactly one surface height. So the
 * whole stand bakes into a grid of heights, and the collision test for a cloth
 * particle is two array reads and a compare — cheap enough to run on every
 * particle of every substep, which is what makes it a guarantee rather than an
 * approximation.
 *
 * Modelled as a HALF-SPACE, not a shell: everything below the height is
 * inside. A particle that tunnels through in one step is simply pushed back
 * out on the next, where a thin shell would lose it for good.
 */

export interface Heightfield {
  /** Grid origin and spacing, in world metres. */
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** Surface height per cell. `-Infinity` where the stand does not reach. */
  h: Float32Array;
  /** Surface normal, x and z components (y follows from them). */
  nxs: Float32Array;
  nzs: Float32Array;
  /** Highest point, so a particle above it can skip the test with one compare. */
  top: number;
}

export interface Hit {
  /** Penetration depth in metres; 0 or less means clear. */
  depth: number;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Bake a stand's seating surface into a heightfield.
 *
 * Sampled from the frame's own `pointAt`, so the collider and the geometry the
 * user is looking at are the same surface by construction — they cannot drift
 * apart the way two independent descriptions of a stand would.
 *
 * `cell` is deliberately coarser than a row: a 0.85 m tread and a 0.4 m riser
 * are below the resolution a banner drapes at, and baking the steps would
 * make the cloth chatter over each nosing. The smooth ramp is what the fabric
 * actually rests on once it is over more than a couple of rows.
 */
export function bakeStandHeightfield(frame: StandFrame, cell = 1.0, pad = 3): Heightfield {
  // Extent of the stand in the ground plane.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const NU = 96;
  const NV = 28;
  for (let i = 0; i <= NU; i++) {
    for (let j = 0; j <= NV; j++) {
      const p = frame.pointAt(i / NU, j / NV);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  if (!isFinite(minX)) {
    return { x0: 0, z0: 0, cell, nx: 1, nz: 1, h: new Float32Array([-Infinity]), nxs: new Float32Array(1), nzs: new Float32Array(1), top: -Infinity };
  }
  const x0 = minX - pad * cell;
  const z0 = minZ - pad * cell;
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell) + pad * 2 + 1);
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / cell) + pad * 2 + 1);
  const h = new Float32Array(nx * nz).fill(-Infinity);

  // Splat the surface in. Sampled finely enough that no cell is missed: the
  // step between samples has to be smaller than a cell in both directions.
  const su = Math.max(NU, Math.ceil((maxX - minX + maxZ - minZ) / cell) * 2);
  const sv = Math.max(NV, Math.ceil(frame.slopeM / cell) * 2);
  let top = -Infinity;
  for (let i = 0; i <= su; i++) {
    for (let j = 0; j <= sv; j++) {
      const p = frame.pointAt(i / su, j / sv);
      const cx = Math.round((p.x - x0) / cell);
      const cz = Math.round((p.z - z0) / cell);
      if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) continue;
      const k = cz * nx + cx;
      // The HIGHEST sample wins. A stand is single-valued over the ground, but
      // the sampling is not exact, and letting a low sample win would open a
      // notch for the cloth to fall into.
      if (p.y > h[k]) h[k] = p.y;
      if (p.y > top) top = p.y;
    }
  }

  // Fill the holes left between splats, then grow the field outward a little
  // so a particle just off the edge of the stand still resolves sanely.
  fillHoles(h, nx, nz);

  // Normals by central difference on the filled field.
  const nxs = new Float32Array(nx * nz);
  const nzs = new Float32Array(nx * nz);
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      const k = cz * nx + cx;
      if (!isFinite(h[k])) continue;
      const hx0 = at(h, nx, nz, cx - 1, cz, h[k]);
      const hx1 = at(h, nx, nz, cx + 1, cz, h[k]);
      const hz0 = at(h, nx, nz, cx, cz - 1, h[k]);
      const hz1 = at(h, nx, nz, cx, cz + 1, h[k]);
      // Gradient of the height field; the surface normal is (-dh/dx, 1, -dh/dz).
      const gx = (hx1 - hx0) / (2 * cell);
      const gz = (hz1 - hz0) / (2 * cell);
      const len = Math.sqrt(gx * gx + 1 + gz * gz);
      nxs[k] = -gx / len;
      nzs[k] = -gz / len;
    }
  }
  return { x0, z0, cell, nx, nz, h, nxs, nzs, top };
}

function at(h: Float32Array, nx: number, nz: number, cx: number, cz: number, fallback: number): number {
  if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return fallback;
  const v = h[cz * nx + cx];
  return isFinite(v) ? v : fallback;
}

/**
 * Close the gaps between splatted samples.
 *
 * A few passes of "take the highest finite neighbour" is enough: the holes are
 * single cells between samples, not regions. Taking the highest rather than
 * the average keeps the field conservative — a collider that errs high pushes
 * the cloth out, which is the safe direction.
 */
function fillHoles(h: Float32Array, nx: number, nz: number): void {
  for (let pass = 0; pass < 4; pass++) {
    let filled = 0;
    for (let cz = 0; cz < nz; cz++) {
      for (let cx = 0; cx < nx; cx++) {
        const k = cz * nx + cx;
        if (isFinite(h[k])) continue;
        let best = -Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = cx + dx;
            const qz = cz + dz;
            if (qx < 0 || qz < 0 || qx >= nx || qz >= nz) continue;
            const v = h[qz * nx + qx];
            if (isFinite(v) && v > best) best = v;
          }
        }
        if (isFinite(best)) {
          h[k] = best;
          filled++;
        }
      }
    }
    if (filled === 0) break;
  }
}

/**
 * Test a point against the surface.
 *
 * `clearance` is how far off the concrete the fabric is held — a couple of
 * centimetres for a sheet lying on the seats, two metres for a banner carried
 * over the crowd's heads. Writes into `out` rather than returning an object,
 * because this runs a few hundred thousand times a second and an allocation
 * per call is a dropped frame.
 */
export function probe(f: Heightfield, x: number, y: number, z: number, clearance: number, out: Hit): void {
  out.depth = 0;
  out.nx = 0;
  out.ny = 1;
  out.nz = 0;
  // One compare skips most of the banner, most of the time.
  if (y > f.top + clearance) return;
  const fx = (x - f.x0) / f.cell;
  const fz = (z - f.z0) / f.cell;
  if (fx < 0 || fz < 0 || fx >= f.nx - 1 || fz >= f.nz - 1) return;
  const i = fx | 0;
  const j = fz | 0;
  const s = fx - i;
  const t = fz - j;
  const k00 = j * f.nx + i;
  const h00 = f.h[k00];
  const h10 = f.h[k00 + 1];
  const h01 = f.h[k00 + f.nx];
  const h11 = f.h[k00 + f.nx + 1];
  if (!isFinite(h00) || !isFinite(h10) || !isFinite(h01) || !isFinite(h11)) return;
  const hs = (h00 * (1 - s) + h10 * s) * (1 - t) + (h01 * (1 - s) + h11 * s) * t;
  const surface = hs + clearance;
  if (y >= surface) return;

  const nxv = bil(f.nxs, k00, f.nx, s, t);
  const nzv = bil(f.nzs, k00, f.nx, s, t);
  const nyv = Math.sqrt(Math.max(1e-6, 1 - nxv * nxv - nzv * nzv));
  // Vertical gap converted to a distance along the normal. Exact for a plane,
  // and under 2% out at the rakes a stand is built to.
  out.depth = (surface - y) * nyv;
  out.nx = nxv;
  out.ny = nyv;
  out.nz = nzv;
}

function bil(a: Float32Array, k00: number, nx: number, s: number, t: number): number {
  return (a[k00] * (1 - s) + a[k00 + 1] * s) * (1 - t) + (a[k00 + nx] * (1 - s) + a[k00 + nx + 1] * s) * t;
}
