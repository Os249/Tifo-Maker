import * as THREE from 'three';
import type { SeatMap } from '../../core/types';
import type { DesignStore } from '../../core/design';

/**
 * Match Day Simulator — gap-fill "rail banners".
 *
 * Rail banners no longer hang over the seats. Their real job (straight from the
 * ultras' playbook) is to FILL the dark empty spaces that break up a tifo — the
 * walkway between tiers and the vertical aisles between sections — so the design
 * reads as one continuous picture. We build thin ribbons that follow the bowl
 * and sit in those gaps, vertex-coloured from the painted seats on either side
 * so they blend into the design automatically.
 *
 * The four flags that used to fly on poles along the back row are gone from the
 * engine altogether (October 2026): a flat two-colour sheet on a stick at every
 * ground read as clutter on the skyline, not as a stadium.
 *
 * Anchors come from the seat map, so everything adapts to any bowl. Rail banners
 * and stair cover toggle independently.
 */
/* gap-fill rail banners v2 */

export interface BannerController {
  readonly object: THREE.Object3D;
  setVisible(b: boolean): void;
  setStairsVisible(b: boolean): void;
  update(elapsed: number): void;
  dispose(): void;
}

type RGB = [number, number, number];

/** Shortest distance between two u values on the [0,1) ring. */
function uDist(a: number, b: number): number {
  let d = Math.abs(a - b);
  if (d > 0.5) d = 1 - d;
  return d;
}

function nearestInSet(map: SeatMap, set: number[], targetU: number): number {
  let best = -1;
  let bd = Infinity;
  for (const i of set) {
    const du = uDist(map.uv[i * 2], targetU);
    if (du < bd) {
      bd = du;
      best = i;
    }
  }
  return best;
}

export function buildBanners(map: SeatMap, store: DesignStore): BannerController {
  const group = new THREE.Group(); // container, always visible
  const bannerGroup = new THREE.Group(); // inter-tier walkway fill ("Rail banners")
  const stairGroup = new THREE.Group(); // aisle / stair fill ("Cover stairs")
  group.add(bannerGroup, stairGroup);
  stairGroup.visible = false; // unorthodox — off by default
  const trash: { dispose(): void }[] = [];

  // Per-seat colour in the renderer's working space (matches how seats are lit).
  const tmp = new THREE.Color();
  const seatColor = (i: number): RGB => {
    tmp.set(store.palette[store.cells[i]] ?? '#0e1b12');
    return [tmp.r, tmp.g, tmp.b];
  };
  const P = (i: number, lift: number): number[] => [
    map.pos3[i * 3],
    map.pos3[i * 3 + 1] + lift,
    map.pos3[i * 3 + 2],
  ];

  // ---- Gap-fill ribbons (vertex-coloured) -------------------------------
  const wPos: number[] = []; // walkway (inter-tier) fill
  const wCol: number[] = [];
  const sPos: number[] = []; // stair (aisle) fill
  const sCol: number[] = [];
  const pushQuad = (
    pos: number[], col: number[],
    A: number[], B: number[], C: number[], D: number[],
    ca: RGB, cb: RGB, cc: RGB, cd: RGB,
  ): void => {
    pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    col.push(...ca, ...cb, ...cc, ...ca, ...cc, ...cd);
  };

  const tiers = Array.from(new Set(Array.from(map.tierOf))).sort((a, b) => a - b);

  // 1) Horizontal band filling each inter-tier walkway: bridge the back row of
  //    the lower tier to the front row of the tier above it, all the way round.
  for (let ti = 0; ti < tiers.length - 1; ti++) {
    const tLo = tiers[ti];
    const tHi = tiers[ti + 1];
    let backRow = -Infinity;
    let frontRow = Infinity;
    for (let i = 0; i < map.count; i++) {
      if (map.tierOf[i] === tLo && map.rowOf[i] > backRow) backRow = map.rowOf[i];
      if (map.tierOf[i] === tHi && map.rowOf[i] < frontRow) frontRow = map.rowOf[i];
    }
    const backSet: number[] = [];
    const frontSet: number[] = [];
    for (let i = 0; i < map.count; i++) {
      if (map.tierOf[i] === tLo && map.rowOf[i] === backRow) backSet.push(i);
      if (map.tierOf[i] === tHi && map.rowOf[i] === frontRow) frontSet.push(i);
    }
    if (!backSet.length || !frontSet.length) continue;
    const N = 180;
    let prev: { Pb: number[]; Pf: number[]; cb: RGB; cf: RGB } | null = null;
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      const bi = nearestInSet(map, backSet, u);
      const fi = nearestInSet(map, frontSet, u);
      // Only fill where the stand actually exists at this u (breaks at corners).
      if (bi < 0 || fi < 0 || uDist(map.uv[bi * 2], u) > 0.045 || uDist(map.uv[fi * 2], u) > 0.045) {
        prev = null;
        continue;
      }
      const cur = { Pb: P(bi, 0.3), Pf: P(fi, 0.3), cb: seatColor(bi), cf: seatColor(fi) };
      if (prev) pushQuad(wPos, wCol, prev.Pb, cur.Pb, cur.Pf, prev.Pf, prev.cb, cur.cb, cur.cf, prev.cf);
      prev = cur;
    }
  }

  // 2) Vertical strips filling the aisles between sections, tier by tier.
  for (const t of tiers) {
    const byRow = new Map<number, number[]>();
    for (let i = 0; i < map.count; i++) {
      if (map.tierOf[i] !== t) continue;
      const arr = byRow.get(map.rowOf[i]);
      if (arr) arr.push(i);
      else byRow.set(map.rowOf[i], [i]);
    }
    const rowsAsc = Array.from(byRow.keys()).sort((a, b) => a - b);
    if (rowsAsc.length < 2) continue;
    for (const arr of byRow.values()) arr.sort((a, b) => map.uv[a * 2] - map.uv[b * 2]);
    // Typical seat spacing from the most populated row.
    let dense = byRow.get(rowsAsc[0])!;
    for (const arr of byRow.values()) if (arr.length > dense.length) dense = arr;
    const sp: number[] = [];
    for (let j = 1; j < dense.length; j++) sp.push(uDist(map.uv[dense[j] * 2], map.uv[dense[j - 1] * 2]));
    sp.sort((a, b) => a - b);
    const typical = sp.length ? sp[Math.floor(sp.length / 2)] : 0.01;
    const gapTh = typical * 1.8;
    // Aisle centres detected on the dense row (ignore the big corner voids).
    const aisleU: number[] = [];
    for (let j = 1; j < dense.length; j++) {
      const d = uDist(map.uv[dense[j] * 2], map.uv[dense[j - 1] * 2]);
      if (d > gapTh && d < 0.15) aisleU.push((map.uv[dense[j] * 2] + map.uv[dense[j - 1] * 2]) / 2);
    }
    for (const ac of aisleU) {
      let prev: { L: number[]; R: number[]; cL: RGB; cR: RGB } | null = null;
      for (const r of rowsAsc) {
        const arr = byRow.get(r)!;
        let li = -1;
        let ri = -1;
        for (let j = 1; j < arr.length; j++) {
          if (map.uv[arr[j - 1] * 2] <= ac && ac <= map.uv[arr[j] * 2]) {
            li = arr[j - 1];
            ri = arr[j];
            break;
          }
        }
        if (li < 0 || ri < 0 || uDist(map.uv[li * 2], map.uv[ri * 2]) < gapTh) {
          prev = null;
          continue;
        }
        const cur = { L: P(li, 0.25), R: P(ri, 0.25), cL: seatColor(li), cR: seatColor(ri) };
        if (prev) pushQuad(sPos, sCol, prev.L, prev.R, cur.R, cur.L, prev.cL, prev.cR, cur.cR, cur.cL);
        prev = cur;
      }
    }
  }

  const buildFill = (pos: number[], col: number[], parent: THREE.Group): void => {
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    parent.add(new THREE.Mesh(geo, mat));
    trash.push(geo, mat);
  };
  buildFill(wPos, wCol, bannerGroup);
  buildFill(sPos, sCol, stairGroup);

  return {
    object: group,
    setVisible(b) {
      bannerGroup.visible = b;
    },
    setStairsVisible(b) {
      stairGroup.visible = b;
    },
    update() {
      /* nothing moves: the ribbons are static */
    },
    dispose() {
      for (const d of trash) d.dispose();
    },
  };
}
