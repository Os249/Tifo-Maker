/**
 * A subject's matte (its alpha), cleaned up for a tifo: the smart cut-out's
 * answer, the browser's own person mask (ui/portraitVision.ts) and anything
 * else that hands back "how much of this pixel is the subject".
 *
 * Pure and DOM-free: Float32 alpha in 0..1 and RGBA bytes in, the same out.
 * scripts/verify-portrait.mts checks it in Node.
 *
 * What a model's matte gets wrong, and what each step here is for:
 *  - specks of background it kept (a bright window, a hand in the crowd):
 *    islands far smaller than the subject are dropped;
 *  - pinholes it punched in the subject (a white shirt button, an eye
 *    highlight against a white wall): small enclosed holes are filled, while a
 *    real gap (between an arm and the body, a trophy's handle) is larger and
 *    is kept;
 *  - a stair-stepped edge from a small mask scaled up: the edge band is
 *    smoothed and then tightened again, so it is soft for one pixel and no
 *    wider, which is what keeps it from growing a halo;
 *  - the old background bleeding into the edge pixels (a green fringe from a
 *    pitch, a white rim from a studio wall): edge colours are worked back to
 *    the subject's own (decontaminate).
 */

/** Mean of `src` over a (2r+1) square around each pixel, over the pixels inside the picture only. */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(w * h);
  if (r <= 0) {
    out.set(src);
    return out;
  }
  // Summed-area table, one row and column larger, in doubles: a 2-megapixel sum in floats drifts.
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Bilinear resize of a one-channel image (pixel centres aligned). */
export function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  const kx = sw / dw;
  const ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Luma (Rec. 601), 0..1, of RGBA bytes. */
export function lumaOf(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = (0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2]) / 255;
  return out;
}

/**
 * The guided filter (He, Sun and Tang 2010): `p` smoothed, but only along the
 * guide's flat areas, so a coarse mask scaled up to the photo snaps to the
 * photo's own edges (the outline of a shoulder, the hair against the sky).
 * O(pixels) whatever the radius.
 */
export function guidedFilter(guide: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const N = w * h;
  const ip = new Float32Array(N);
  const ii = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    ip[k] = guide[k] * p[k];
    ii[k] = guide[k] * guide[k];
  }
  const mI = boxMean(guide, w, h, r);
  const mP = boxMean(p, w, h, r);
  const mIP = boxMean(ip, w, h, r);
  const mII = boxMean(ii, w, h, r);
  const a = new Float32Array(N);
  const b = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const cov = mIP[k] - mI[k] * mP[k];
    const v = mII[k] - mI[k] * mI[k];
    a[k] = cov / (v + eps);
    b[k] = mP[k] - a[k] * mI[k];
  }
  const mA = boxMean(a, w, h, r);
  const mB = boxMean(b, w, h, r);
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) out[k] = Math.max(0, Math.min(1, mA[k] * guide[k] + mB[k]));
  return out;
}

/** 4-connected components of `on` cells; returns each cell's component (-1 off) and the components' sizes and whether they touch the frame. */
function components(on: Uint8Array, w: number, h: number): { id: Int32Array; size: number[]; edge: boolean[] } {
  const id = new Int32Array(w * h).fill(-1);
  const size: number[] = [];
  const edge: boolean[] = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!on[s] || id[s] >= 0) continue;
    const c = size.length;
    let n = 0;
    let touches = false;
    let top = 0;
    stack[top++] = s;
    id[s] = c;
    while (top > 0) {
      const p = stack[--top];
      n++;
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      if (x > 0 && on[p - 1] && id[p - 1] < 0) { id[p - 1] = c; stack[top++] = p - 1; }
      if (x < w - 1 && on[p + 1] && id[p + 1] < 0) { id[p + 1] = c; stack[top++] = p + 1; }
      if (y > 0 && on[p - w] && id[p - w] < 0) { id[p - w] = c; stack[top++] = p - w; }
      if (y < h - 1 && on[p + w] && id[p + w] < 0) { id[p + w] = c; stack[top++] = p + w; }
    }
    size.push(n);
    edge.push(touches);
  }
  return { id, size, edge };
}

export interface MatteOptions {
  /** Islands smaller than this share of the biggest piece of the subject are dropped. */
  islandShare?: number;
  /** Enclosed holes smaller than this share of the subject are filled. */
  holeShare?: number;
}

export interface MatteReport {
  /** Pixels of dropped islands. */
  dropped: number;
  /** Pixels of filled holes. */
  filled: number;
  /** The subject's share of the picture, after. */
  coverage: number;
}

/**
 * Clean a matte in place: drop islands, fill pinholes, and smooth the edge
 * without widening it. Returns what it did, for the tests and the shots.
 */
export function refineMatte(alpha: Float32Array, w: number, h: number, opts: MatteOptions = {}): MatteReport {
  const N = w * h;
  const islandShare = opts.islandShare ?? 0.06;
  const holeShare = opts.holeShare ?? 0.004;
  const fg = new Uint8Array(N);
  for (let k = 0; k < N; k++) fg[k] = alpha[k] >= 0.5 ? 1 : 0;
  // Islands: every piece of the subject far smaller than its biggest piece.
  const parts = components(fg, w, h);
  const biggest = parts.size.reduce((m, s) => Math.max(m, s), 0);
  let dropped = 0;
  if (biggest > 0) {
    const keep = parts.size.map((s) => s >= biggest * islandShare);
    for (let k = 0; k < N; k++) {
      const c = parts.id[k];
      if (c >= 0 && !keep[c]) {
        fg[k] = 0;
        dropped++;
      }
    }
  }
  // Holes: background that does not reach the frame and is small next to the subject.
  let area = 0;
  for (let k = 0; k < N; k++) area += fg[k];
  const bgOn = new Uint8Array(N);
  for (let k = 0; k < N; k++) bgOn[k] = fg[k] ? 0 : 1;
  const holes = components(bgOn, w, h);
  let filled = 0;
  const fill = holes.size.map((s, c) => !holes.edge[c] && s < area * holeShare);
  for (let k = 0; k < N; k++) {
    const c = holes.id[k];
    if (c >= 0 && fill[c]) {
      fg[k] = 1;
      filled++;
    }
  }
  // The edge: the model's soft alpha where it agrees with the cleaned shape,
  // the cleaned shape where it does not (a dropped island, a filled hole). Then
  // a small blur and a tightening curve over the edge band only: stair steps
  // from an upscaled mask go, and the edge stays one or two pixels soft.
  const r = Math.max(1, Math.round(Math.min(w, h) / 400));
  const base = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const soft = alpha[k];
    base[k] = fg[k] ? (soft >= 0.5 ? soft : 1) : soft < 0.5 ? soft : 0;
  }
  const blurred = boxMean(base, w, h, r);
  let cover = 0;
  for (let k = 0; k < N; k++) {
    const b = blurred[k];
    // smoothstep(0.25, 0.75): the edge's middle stays where it was; its tails go.
    const t = Math.max(0, Math.min(1, (b - 0.25) / 0.5));
    const v = b <= 0.02 ? 0 : b >= 0.98 ? 1 : t * t * (3 - 2 * t);
    alpha[k] = v;
    cover += v;
  }
  return { dropped, filled, coverage: cover / Math.max(1, N) };
}

/**
 * Take the old background out of the edge pixels' colour. Where a pixel is
 * part subject and part background (0 < alpha < 1), its colour is a mix of
 * both; the background's share is worked back out with the background's
 * colour nearby (I = aF + (1 - a)B, solved for F), and steadied with the
 * subject's own colour just inside. Pixels that are wholly subject or wholly
 * background keep their colour. In place, on RGBA bytes; alpha is written
 * from `alpha`.
 */
export function decontaminate(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number): void {
  const N = w * h;
  const r = Math.max(4, Math.round(Math.min(w, h) / 80));
  const sure = new Float32Array(N);
  const away = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    sure[k] = alpha[k] >= 0.95 ? 1 : 0;
    away[k] = alpha[k] <= 0.05 ? 1 : 0;
  }
  const mSure = boxMean(sure, w, h, r);
  const mAway = boxMean(away, w, h, r);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(N);
    const chF = new Float32Array(N);
    const chB = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      ch[k] = rgba[k * 4 + c];
      chF[k] = ch[k] * sure[k];
      chB[k] = ch[k] * away[k];
    }
    const mF = boxMean(chF, w, h, r);
    const mB = boxMean(chB, w, h, r);
    for (let k = 0; k < N; k++) {
      const a = alpha[k];
      if (a <= 0.05 || a >= 0.95) continue;
      // The subject's own colour just inside, and the colour solved with the background just outside.
      const inner = mSure[k] > 1e-4 ? mF[k] / mSure[k] : -1;
      const solved = mAway[k] > 1e-4 ? Math.max(0, Math.min(255, (ch[k] - (1 - a) * (mB[k] / mAway[k])) / Math.max(a, 0.15))) : -1;
      const f = inner >= 0 && solved >= 0 ? 0.5 * (inner + solved) : inner >= 0 ? inner : solved >= 0 ? solved : ch[k];
      rgba[k * 4 + c] = Math.round(f);
    }
  }
  for (let k = 0; k < N; k++) rgba[k * 4 + 3] = Math.round(Math.max(0, Math.min(1, alpha[k])) * 255);
}

/** The bounding box of the subject (alpha >= thr), or null when there is none. */
export function alphaBounds(alpha: Float32Array, w: number, h: number, thr = 0.5): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] < thr) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Alpha 0..1 of RGBA bytes. */
export function alphaOf(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = rgba[k * 4 + 3] / 255;
  return out;
}

/** True when a picture already carries a real cut-out: a good share of it transparent, and not a stray pixel or two. */
export function hasMatte(rgba: Uint8ClampedArray, w: number, h: number): boolean {
  let clear = 0;
  for (let k = 0; k < w * h; k++) if (rgba[k * 4 + 3] < 128) clear++;
  const share = clear / Math.max(1, w * h);
  return share > 0.03 && share < 0.97;
}
