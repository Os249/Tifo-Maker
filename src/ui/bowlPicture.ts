/**
 * The stand picture: a tifo shown the way people judge one, in the bowl.
 *
 * Every card on the site (the community feed, the editor's gallery, the
 * Projects page, the home page's showcase) used to show the unrolled strip: a
 * 10:1 band of seats, a few dozen pixels tall at card size. It is accurate and
 * it is how the editor works, but nobody pictures a tifo that way, and a crest
 * or a word in it is a smudge.
 *
 * This draws the same strip wrapped round a stadium bowl seen from behind one
 * end: the far stand faces the camera (where a tifo is read from), the near
 * one is seen from behind, the pitch is in the middle. It is computed from the
 * strip thumbnail the server already has for every design, so it works for all
 * of them at once (the starter library, designs saved years ago) with no new
 * storage, no upload and no WebGL: one pass over a lookup table per card.
 *
 * Geometry, in the strip's terms (see the flat editor view): x runs round the
 * bowl East, North, West, South with x = 0 at the middle of East; y runs from
 * the top row (top of the strip) to the front row (bottom). Text in the strip
 * reads left to right when you face a stand from the pitch, which from above is
 * clockwise; so the picture wraps x clockwise, and the stand at x = 3/4 (South,
 * where most designs put their words) is the far one, facing the camera.
 *
 * The real 3D view is still the 3D view; this is a picture for a card.
 */

/** The size every card picture is drawn at: 16:10, sharp on a 2x screen at card width. */
export const BOWL_W = 640;
export const BOWL_H = 400;

/** The strip thumbnail's background (net/api.ts renderThumbnailB64): gaps between seats. */
const STRIP_BG: [number, number, number] = [0x14, 0x17, 0x1f];
const NEIGHBOURS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function isGap(d: Uint8ClampedArray, i: number): boolean {
  return Math.abs(d[i]! - STRIP_BG[0]) + Math.abs(d[i + 1]! - STRIP_BG[1]) + Math.abs(d[i + 2]! - STRIP_BG[2]) < 6;
}

interface Ellipse { a: number; b: number; cy: number }
interface Lut { U: Float32Array; T: Float32Array; inner: Ellipse; outer: Ellipse }

const luts = new Map<string, Lut>();

/**
 * For each pixel of a W x H picture: where round the bowl it is (u, 0..1) and
 * how far up the stand (t, 0 front row .. 1 top row), or u = -1 off the stands.
 * The inner and outer edges of the stands are ellipses with different centres,
 * which is what makes it a bowl seen at an angle rather than a flat ring.
 * Built once per size and shared by every card.
 */
function lutFor(W: number, H: number): Lut {
  const key = `${W}x${H}`;
  const hit = luts.get(key);
  if (hit) return hit;
  const cx = W / 2;
  const inner: Ellipse = { a: W * 0.25, b: H * 0.22, cy: H * 0.56 };
  const outer: Ellipse = { a: W * 0.495, b: H * 0.47, cy: H * 0.49 };
  const U = new Float32Array(W * H).fill(-1);
  const T = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const py = y + 0.5;
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const f = (t: number): number => {
        const a = inner.a + (outer.a - inner.a) * t;
        const b = inner.b + (outer.b - inner.b) * t;
        const cy = inner.cy + (outer.cy - inner.cy) * t;
        const dx = (px - cx) / a;
        const dy = (py - cy) / b;
        return dx * dx + dy * dy - 1;
      };
      if (f(0) < 0 || f(1) > 0) continue; // on the pitch, or outside the ground
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 14; i++) {
        const m = (lo + hi) / 2;
        if (f(m) > 0) lo = m;
        else hi = m;
      }
      const t = (lo + hi) / 2;
      const a = inner.a + (outer.a - inner.a) * t;
      const b = inner.b + (outer.b - inner.b) * t;
      const cy = inner.cy + (outer.cy - inner.cy) * t;
      let u = Math.atan2((py - cy) / b, (px - cx) / a) / (2 * Math.PI);
      if (u < 0) u += 1;
      U[y * W + x] = u;
      T[y * W + x] = t;
    }
  }
  const lut = { U, T, inner, outer };
  luts.set(key, lut);
  return lut;
}

/** Draw the stand picture of a strip (an image or canvas of the unrolled bowl). */
export function drawBowl(strip: CanvasImageSource & { width: number; height: number }, W = BOWL_W, H = BOWL_H): HTMLCanvasElement {
  const sw = (strip as HTMLImageElement).naturalWidth || strip.width;
  const sh = (strip as HTMLImageElement).naturalHeight || strip.height;
  const src = document.createElement('canvas');
  src.width = sw;
  src.height = sh;
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(strip, 0, 0);
  const sd = sctx.getImageData(0, 0, sw, sh).data;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const o = out.getContext('2d')!;
  const { U, T, inner, outer } = lutFor(W, H);
  const cx = W / 2;

  // Night, a little lighter where the floodlights fall.
  const glow = o.createRadialGradient(cx, H * 0.5, H * 0.1, cx, H * 0.5, W * 0.62);
  glow.addColorStop(0, '#16213a');
  glow.addColorStop(1, '#070B14');
  o.fillStyle = glow;
  o.fillRect(0, 0, W, H);

  // The pitch: mown stripes and the halfway line.
  const pw = 2 * inner.a * 0.74;
  const ph = 2 * inner.b * 0.68;
  const px0 = cx - pw / 2;
  const py0 = inner.cy - ph / 2;
  o.fillStyle = '#17652f';
  o.fillRect(px0, py0, pw, ph);
  o.fillStyle = 'rgba(255,255,255,.06)';
  for (let i = 0; i < 12; i += 2) o.fillRect(px0 + (pw / 12) * i, py0, pw / 12, ph);
  o.strokeStyle = 'rgba(255,255,255,.6)';
  o.lineWidth = Math.max(1, W / 480);
  o.strokeRect(px0, py0, pw, ph);
  o.beginPath();
  o.moveTo(cx, py0);
  o.lineTo(cx, py0 + ph);
  o.stroke();
  o.beginPath();
  o.ellipse(cx, inner.cy, ph * 0.17, ph * 0.17, 0, 0, Math.PI * 2);
  o.stroke();

  // The stands: every pixel looks up its seat in the strip.
  const img = o.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    const u = U[i];
    if (u < 0) continue;
    const t = T[i];
    const sx = Math.min(sw - 1, (u * sw) | 0);
    const sy = Math.min(sh - 1, Math.max(0, ((1 - t) * sh) | 0));
    let si = (sy * sw + sx) * 4;
    // The strip draws each seat as a small block with a gap round it, which at
    // card size is a picture made mostly of gaps. A gap a pixel wide takes its
    // neighbour's colour, so the cards read as cards; a wider gap (an aisle,
    // the space above a short stand) stays a gap.
    if (isGap(sd, si)) {
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = sx + ox;
        const ny = sy + oy;
        if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
        const ni = (ny * sw + nx) * 4;
        if (!isGap(sd, ni)) {
          si = ni;
          break;
        }
      }
    }
    let r = sd[si];
    let g = sd[si + 1];
    let b = sd[si + 2];
    // A gap that stays one is the concrete of the stand, not the night sky.
    if (isGap(sd, si)) {
      r = 0x1c;
      g = 0x23;
      b = 0x33;
    }
    // Lit from the floodlights: the far stand bright, the near one in its own shadow.
    const y = (i / W) | 0;
    const k = 0.78 + 0.22 * (1 - y / H) + 0.08 * t;
    d[i * 4] = Math.min(255, r * k);
    d[i * 4 + 1] = Math.min(255, g * k);
    d[i * 4 + 2] = Math.min(255, b * k);
    d[i * 4 + 3] = 255;
  }
  o.putImageData(img, 0, 0);

  // The roof's edge, so the bowl has a rim.
  o.strokeStyle = 'rgba(7,11,20,.9)';
  o.lineWidth = W / 120;
  o.beginPath();
  o.ellipse(cx, outer.cy, outer.a, outer.b, 0, 0, Math.PI * 2);
  o.stroke();
  return out;
}

// ------------------------------------------------------------ on cards ---

const done = new Map<string, Promise<string | null>>();
/** Pictures already drawn, by strip URL: a list redrawn (a search, a rename) shows them at once. */
const drawn = new Map<string, string>();
const queue: (() => void)[] = [];
let running = false;

/** One picture at a time, in idle time, so a page of sixty cards never janks a scroll. */
function schedule(job: () => void): void {
  queue.push(job);
  if (running) return;
  running = true;
  const next = (): void => {
    const j = queue.shift();
    if (!j) {
      running = false;
      return;
    }
    j();
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(next, { timeout: 120 });
    else setTimeout(next, 16);
  };
  next();
}

/** The picture of the strip at `url`, as a data URL (cached for the page's life). */
export function bowlUrl(url: string): Promise<string | null> {
  const hit = done.get(url);
  if (hit) return hit;
  const p = new Promise<string | null>((resolve) => {
    const finish = (u: string | null): void => {
      if (u) drawn.set(url, u);
      resolve(u);
    };
    const im = new Image();
    im.decoding = 'async';
    im.onload = () =>
      schedule(() => {
        try {
          // A data: URL, not a blob: one: the site's Content-Security-Policy
          // allows images from 'self' and data: only.
          const pic = drawBowl(im).toDataURL('image/webp', 0.86);
          finish(pic.startsWith('data:image/') ? pic : null);
        } catch {
          finish(null);
        }
      });
    im.onerror = () => finish(null);
    im.src = url;
  });
  done.set(url, p);
  return p;
}

let io: IntersectionObserver | null = null;

/**
 * Turn every `img[data-bowl]` under `root` into its stand picture once it is
 * near the screen. The attribute holds the strip's URL; until the picture is
 * ready the box shows the card's own background, and if it cannot be made
 * (a strip that will not load) the strip itself is shown instead.
 */
export function hydrateBowls(root: ParentNode = document): void {
  const all = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-bowl]:not([data-bowl-state])'));
  // Already drawn on this page: straight in, no waiting for the observer.
  const imgs = all.filter((img) => {
    const pic = drawn.get(img.dataset.bowl!);
    if (!pic) return true;
    img.src = pic;
    img.dataset.bowlState = 'ready';
    return false;
  });
  if (!imgs.length) return;
  const start = (img: HTMLImageElement): void => {
    img.dataset.bowlState = 'loading';
    const strip = img.dataset.bowl!;
    void bowlUrl(strip).then((u) => {
      if (u) {
        img.src = u;
        img.dataset.bowlState = 'ready';
      } else {
        img.src = strip;
        img.dataset.bowlState = 'strip';
        img.closest('.is-bowl')?.classList.add('bowl-failed');
      }
    });
  };
  if (typeof IntersectionObserver === 'undefined') {
    imgs.forEach(start);
    return;
  }
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io!.unobserve(e.target);
        start(e.target as HTMLImageElement);
      }
    },
    { rootMargin: '400px 0px' },
  );
  for (const img of imgs) {
    img.dataset.bowlState = 'waiting';
    io.observe(img);
  }
}
