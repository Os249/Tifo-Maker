/**
 * How much of a tifo falls where its stand has no seats: the gap between two
 * tiers where the boxes are (Kingdom Arena's north stand), which a design's
 * rows run straight across. No camera can show that band, so the film and
 * the poster show the tifo split there, as the stand does; the UI says so
 * before filming (ui/proFilm.ts, ui/proExport.ts).
 *
 * Pure: the seat map's uv (u round the bowl, v up the stand) and which seats
 * are painted. Returns the share of the tifo's height, over the columns it
 * covers, that sits inside such a jump in the stand's rows; 0 for none.
 */
export function tifoSplit(uv: ArrayLike<number>, count: number, painted: (i: number) => boolean): number {
  // u wraps at 0/1 (a stand behind a goal straddles it): measured from the tifo's own middle.
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (!painted(i)) continue;
    const a = uv[i * 2] * 2 * Math.PI;
    sx += Math.cos(a);
    sy += Math.sin(a);
    n++;
  }
  if (n < 20) return 0;
  const mid = Math.atan2(sy, sx) / (2 * Math.PI);
  const rel = (u: number): number => ((((u - mid) % 1) + 1.5) % 1) - 0.5;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    if (!painted(i)) continue;
    const r = rel(uv[i * 2]);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  const BINS = 24;
  const w = (hi - lo) / BINS || 1;
  const bin = (r: number): number => Math.min(BINS - 1, Math.max(0, Math.floor((r - lo) / w)));
  const v0 = new Array<number>(BINS).fill(Infinity);
  const v1 = new Array<number>(BINS).fill(-Infinity);
  const cnt = new Array<number>(BINS).fill(0);
  for (let i = 0; i < count; i++) {
    if (!painted(i)) continue;
    const b = bin(rel(uv[i * 2]));
    const v = uv[i * 2 + 1];
    v0[b] = Math.min(v0[b], v);
    v1[b] = Math.max(v1[b], v);
    cnt[b]++;
  }
  // Every seat of the stand (painted or not) in each column, over the tifo's rows there.
  const rows: number[][] = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < count; i++) {
    const r = rel(uv[i * 2]);
    if (r < lo || r > hi) continue;
    const b = bin(r);
    const v = uv[i * 2 + 1];
    if (cnt[b] >= 6 && v >= v0[b] && v <= v1[b]) rows[b].push(v);
  }
  let total = 0;
  let used = 0;
  for (let b = 0; b < BINS; b++) {
    if (cnt[b] < 6 || v1[b] <= v0[b]) continue;
    used++;
    const vs = rows[b].sort((x, y) => x - y);
    let gap = 0;
    for (let k = 1; k < vs.length; k++) gap = Math.max(gap, vs[k] - vs[k - 1]);
    // A row's own step is a few hundredths: only a real hole in the stand counts.
    if (gap > 0.05) total += gap / (v1[b] - v0[b]);
  }
  return used ? total / used : 0;
}

/** A split worth telling the fan about: a tenth of the tifo's height or more. */
export const SPLIT_TELLS = 0.1;
