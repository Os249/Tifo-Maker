/**
 * Dev-only: is the banner behaving like fabric, or like a flag in a hurricane?
 *   npm run probe:banner              → every kind, at the wind the panel defaults to
 *   WIND=1 npm run probe:banner       → every kind at the top of the slider
 *   KIND=lift DEV=1 npm run probe:banner
 *
 * This exists because "it's too jittery" is not something a screenshot can
 * answer and not something a census can either. It measures three things:
 *
 *   flat   RMS distance of the fabric from its own best-fit plane, in metres.
 *          Large means the sheet is bellying or crumpling. For the two types
 *          that drape over a rake it is large by definition and means nothing.
 *   buzz   Mean per-FRAME movement of a vertex, in metres. THIS is jitter.
 *          A rigged banner should be in the tenths of a millimetre.
 *   drift  Net movement over a second. This is sway, and a banner should have
 *          some — a number here is not a fault.
 *
 * Separating buzz from drift is the whole point. They were one number to
 * begin with, and that number could not tell a banner swaying on its ropes
 * from a banner vibrating.
 */
// Minimal DOM so the rig's texture path can run headlessly.
const g = globalThis as unknown as { document?: unknown; HTMLCanvasElement?: unknown; Image?: unknown };
if (!g.document) {
  const ctx = new Proxy({}, { get: () => () => ctx });
  g.document = {
    createElement: () => ({ width: 8, height: 8, getContext: () => ctx, style: {} }),
  };
}

import { generateSeatMap } from '../src/core/seatmap';
import { templateById } from '../src/core/stadiumCatalog';
import { buildStandFrame } from '../src/render/simulator/standFrame';
import { buildBannerRigs } from '../src/render/simulator/bannerRig';
import { BannerStore, newBanner, BANNER_KINDS, type BannerKind } from '../src/core/banner';

const tpl = templateById('generic-bowl-60k')!;
const map = generateSeatMap(tpl);
const frames = [0, 1, 2, 3].map((s) => buildStandFrame(map, s as 0 | 1 | 2 | 3));

const WIND = Number(process.env.WIND ?? '0.25');
const OUT = process.env.OUT === undefined ? undefined : Number(process.env.OUT);
const UP = process.env.UP === undefined ? undefined : Number(process.env.UP);
const FILL = Number(process.env.FILL ?? '0.97');
const KINDS = (process.env.KIND ? [process.env.KIND as BannerKind] : BANNER_KINDS);

/**
 * How much per-frame movement is fabric, and how much is the solver talking.
 *
 * Half a millimetre a frame is 3 cm a second of path length on a forty-metre
 * sheet — under the width of the seam it is sewn with, and well under what
 * anyone can see at a hundred metres.
 */
const BUZZ_MAX_M = 0.0008;
let bad = 0;

console.log(`every banner kind, wind slider ${WIND}, crowd ${FILL}`);
console.log('kind             flat     buzz    drift   span/diag   pen   notes');
for (const kind of KINDS) {
  const store = new BannerStore();
  const doc = newBanner(kind, kind);
  doc.wind = WIND;
  if (OUT !== undefined) doc.place.outM = OUT;
  if (process.env.NET) doc.netBacked = process.env.NET === '1';
  if (process.env.BAR) doc.weightBar = process.env.BAR === '1';
  if (UP !== undefined) doc.place.heightV = UP;
  doc.place.stand = 1;
  store.add(doc);
  const layer = buildBannerRigs(store, (s) => frames[s], () => FILL);
  layer.setProgress(doc.id, 1);
  // Settle, then measure over a second of running.
  layer.settle(4);
  const stats: number[][] = [];
  let prev: Float64Array | null = null;
  for (let f = 0; f < 60; f++) {
    layer.update(4 + f / 60, 1 / 60);
    const m = (layer as unknown as { __probe?: unknown });
    void m;
    const b = layer.bounds(doc.id);
    if (!b) continue;
    void b;
  }
  // Pull the cloth out through bounds + the census; for flatness we need the
  // vertices, so read them off the mesh geometry the layer publishes.
  const obj = layer.object;
  let pos: Float32Array | null = null;
  obj.traverse((o) => {
    const anyO = o as unknown as { isMesh?: boolean; userData?: { bannerId?: string }; geometry?: { attributes: { position: { array: Float32Array } } } };
    if (anyO.isMesh && anyO.userData?.bannerId === doc.id && anyO.geometry) pos = anyO.geometry.attributes.position.array;
  });
  if (!pos) { console.log(`${kind.padEnd(15)}  no mesh`); layer.dispose(); continue; }
  const P: Float32Array = pos;
  const n = P.length / 3;
  const flat = flatness(P, n);
  // Two different things, and they were being confused.
  //   buzz  = mean per-FRAME vertex movement. This is what reads as jitter.
  //   drift = net movement over a second. This is sway, and a banner should
  //           have some.
  const before = Float32Array.from(P);
  let prevF = Float32Array.from(P);
  let buzz = 0;
  for (let f = 0; f < 60; f++) {
    layer.update(8 + f / 60, 1 / 60);
    for (let k = 0; k < n; k++) buzz += Math.hypot(P[k*3]-prevF[k*3], P[k*3+1]-prevF[k*3+1], P[k*3+2]-prevF[k*3+2]);
    prevF = Float32Array.from(P);
  }
  buzz /= n * 60;
  let jit = 0;
  for (let k = 0; k < n; k++) jit += Math.hypot(P[k*3]-before[k*3], P[k*3+1]-before[k*3+1], P[k*3+2]-before[k*3+2]);
  jit /= n;
  const b = layer.bounds(doc.id)!;
  const span = Math.hypot(b.max[0]-b.min[0], b.max[1]-b.min[1], b.max[2]-b.min[2]);
  const diag = Math.hypot(doc.widthM, doc.heightM);
  const flags: string[] = [];
  if (!(buzz <= BUZZ_MAX_M)) flags.push(`BUZZ=${(buzz * 1000).toFixed(1)}mm/frame`);
  if (span < diag * 0.5) flags.push(`CRUMPLED=${span.toFixed(1)}m`);
  if (layer.worstPenetration() > 0.05) flags.push('IN-STAND');
  if (process.env.ROWS) {
    // Per-row buzz, to find where the movement actually is.
    const cc = Math.round(Math.sqrt(n * (doc.widthM / doc.heightM)));
    const rr = Math.round(n / cc);
    if (cc * rr === n) {
      const rowBuzz = new Float64Array(rr);
      let pf = Float32Array.from(P);
      for (let f = 0; f < 60; f++) {
        layer.update(20 + f / 60, 1 / 60);
        for (let j = 0; j < rr; j++) for (let i = 0; i < cc; i++) {
          const k = j * cc + i;
          rowBuzz[j] += Math.hypot(P[k*3]-pf[k*3], P[k*3+1]-pf[k*3+1], P[k*3+2]-pf[k*3+2]);
        }
        pf = Float32Array.from(P);
      }
      const out: string[] = [];
      for (let j = 0; j < rr; j += Math.max(1, Math.floor(rr / 10))) out.push(`r${j}:${(rowBuzz[j]/(cc*60)).toFixed(4)}`);
      console.log('    ' + out.join(' '));
    }
  }
  if (process.env.DEV) {
    const gAny = obj.children as unknown[];
    void gAny;
    const cc = Math.round(Math.sqrt(n * (doc.widthM / doc.heightM)));
    const rr = Math.round(n / cc);
    if (cc * rr === n) {
      console.log(`    ${profileDev(P, n, cc, rr)}  grid ${cc}x${rr}`);
      // A coarse map of out-of-plane deviation, in decimetres.
      for (let j = 0; j < rr; j += Math.max(1, Math.floor(rr / 9))) {
        let line = '     ';
        for (let i = 0; i < cc; i += Math.max(1, Math.floor(cc / 16))) {
          const k = j * cc + i;
          const d = devAt(P, n, k);
          const v = Math.round(d * 10);
          line += (v === 0 ? '  .' : String(v).padStart(3));
        }
        console.log(line);
      }
    }
    else console.log(`    grid guess failed (${n})`);
  }
  console.log(
    `${kind.padEnd(15)} ${flat.toFixed(3).padStart(6)} ${buzz.toFixed(5).padStart(8)} ${jit.toFixed(4).padStart(8)} ${(span/diag).toFixed(2).padStart(9)} ${layer.worstPenetration().toFixed(3).padStart(6)}` +
      (flags.length ? '   <- ' + flags.join(' ') : ''),
  );
  if (flags.length) bad++;
  layer.dispose();
  void stats; void prev;
}

function flatness(P: Float32Array, n: number): number {
  let mx=0,my=0,mz=0;
  for (let k=0;k<n;k++){ mx+=P[k*3]; my+=P[k*3+1]; mz+=P[k*3+2]; }
  mx/=n; my/=n; mz/=n;
  const C=[[0,0,0],[0,0,0],[0,0,0]];
  for (let k=0;k<n;k++){ const d=[P[k*3]-mx,P[k*3+1]-my,P[k*3+2]-mz]; for(let r=0;r<3;r++) for(let s=0;s<3;s++) C[r][s]+=d[r]*d[s]; }
  const V=[[1,0,0],[0,1,0],[0,0,1]];
  for (let sw=0; sw<24; sw++) for (let p=0;p<2;p++) for (let q=p+1;q<3;q++){
    if (Math.abs(C[p][q])<1e-12) continue;
    const th=0.5*Math.atan2(2*C[p][q], C[q][q]-C[p][p]); const cs=Math.cos(th), sn=Math.sin(th);
    for (let r=0;r<3;r++){ const a=C[r][p], b2=C[r][q]; C[r][p]=cs*a-sn*b2; C[r][q]=sn*a+cs*b2; }
    for (let r=0;r<3;r++){ const a=C[p][r], b2=C[q][r]; C[p][r]=cs*a-sn*b2; C[q][r]=sn*a+cs*b2;
      const v1=V[r][p], v2=V[r][q]; V[r][p]=cs*v1-sn*v2; V[r][q]=sn*v1+cs*v2; }
  }
  let best=0; for(let i=1;i<3;i++) if (C[i][i]<C[best][best]) best=i;
  const nrm=[V[0][best],V[1][best],V[2][best]];
  let s=0; for(let k=0;k<n;k++){ const d=(P[k*3]-mx)*nrm[0]+(P[k*3+1]-my)*nrm[1]+(P[k*3+2]-mz)*nrm[2]; s+=d*d; }
  return Math.sqrt(s/n);
}

var PLANE: { m: number[]; n: number[] } | null = null;
function devAt(P: Float32Array, _n: number, k: number): number {
  if (!PLANE) return 0;
  return (P[k*3]-PLANE.m[0])*PLANE.n[0] + (P[k*3+1]-PLANE.m[1])*PLANE.n[1] + (P[k*3+2]-PLANE.m[2])*PLANE.n[2];
}
export function profileDev(P: Float32Array, n: number, cols: number, rows: number): string {
  let mx=0,my=0,mz=0;
  for (let k=0;k<n;k++){ mx+=P[k*3]; my+=P[k*3+1]; mz+=P[k*3+2]; }
  mx/=n; my/=n; mz/=n;
  const C=[[0,0,0],[0,0,0],[0,0,0]];
  for (let k=0;k<n;k++){ const d=[P[k*3]-mx,P[k*3+1]-my,P[k*3+2]-mz]; for(let r=0;r<3;r++) for(let s2=0;s2<3;s2++) C[r][s2]+=d[r]*d[s2]; }
  const V=[[1,0,0],[0,1,0],[0,0,1]];
  for (let sw=0; sw<24; sw++) for (let p2=0;p2<2;p2++) for (let q=p2+1;q<3;q++){
    if (Math.abs(C[p2][q])<1e-12) continue;
    const th=0.5*Math.atan2(2*C[p2][q], C[q][q]-C[p2][p2]); const cs=Math.cos(th), sn=Math.sin(th);
    for (let r=0;r<3;r++){ const a=C[r][p2], b2=C[r][q]; C[r][p2]=cs*a-sn*b2; C[r][q]=sn*a+cs*b2; }
    for (let r=0;r<3;r++){ const a=C[p2][r], b2=C[q][r]; C[p2][r]=cs*a-sn*b2; C[q][r]=sn*a+cs*b2;
      const v1=V[r][p2], v2=V[r][q]; V[r][p2]=cs*v1-sn*v2; V[r][q]=sn*v1+cs*v2; }
  }
  let best=0; for(let i=1;i<3;i++) if (C[i][i]<C[best][best]) best=i;
  const nrm=[V[0][best],V[1][best],V[2][best]];
  PLANE = { m: [mx, my, mz], n: nrm };
  const dev = (k: number) => (P[k*3]-mx)*nrm[0] + (P[k*3+1]-my)*nrm[1] + (P[k*3+2]-mz)*nrm[2];
  let edgeMax = 0, midMax = 0;
  for (let j=0;j<rows;j++) for (let i=0;i<cols;i++) {
    const k = j*cols+i; const d = Math.abs(dev(k));
    const onEdge = i===0 || j===0 || i===cols-1 || j===rows-1;
    if (onEdge) { if (d>edgeMax) edgeMax=d; } else if (d>midMax) midMax=d;
  }
  const centre = dev((rows>>1)*cols + (cols>>1));
  return `edgeMax=${edgeMax.toFixed(2)} interiorMax=${midMax.toFixed(2)} centre=${centre.toFixed(2)}`;
}

if (bad) {
  console.error(`\n${bad} kind(s) flagged`);
  process.exitCode = 1;
} else {
  console.log('\nall kinds steady');
}
