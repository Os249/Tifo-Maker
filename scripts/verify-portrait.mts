/**
 * Portrait styles (core/portraitStyles.ts), checked on synthetic pictures in
 * Node: npx tsx scripts/verify-portrait.mts
 *
 * Every style, on every picture and palette below:
 *  - hands back palette cards only: -1 (leave the seat) or 1..n-1, never slot
 *    0 (the empty seat);
 *  - keeps the transparent transparent (alpha under the threshold: -1), and
 *    with two cards or more, paints every opaque cell;
 *  - leaves no card on its own (a cell none of whose neighbours shares its
 *    card) beyond a small fraction: a lone card is what an empty seat erases;
 *  - is deterministic, and changes neither the pixels nor the palette;
 *  - reads with a two-colour palette (both cards used) and does something
 *    sensible with one.
 * And on a drawn face at stand size (48 rows): the eyes and the mouth land on
 * the dark side and the cheek on the light side, which is what makes it a face
 * from the far end. The halftone's dots each span several seats. The layer
 * keeps its style through saving (an unknown one is dropped) and the style is
 * part of what makes the picture re-draw.
 */
import { PORTRAIT_STYLES, isPortraitStyle, stylePortrait, type PortraitStyle } from '../src/core/portraitStyles';
import { gridKeyFor, objectFromJSON, objectToJSON, type ImageObject } from '../src/core/objects';
import type { TifoFont } from '../src/core/text';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  if (ok) pass++;
  else fail++;
  if (!ok || process.env.VERBOSE) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

// ------------------------------------------------------------- pictures ---

/** A deterministic random number, so every run sees the same pictures. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Pic {
  name: string;
  cols: number;
  rows: number;
  px: Uint8ClampedArray;
  /** The places a face is read by (cells), when it is a face. */
  marks?: { eyes: [number, number][]; mouth: [number, number]; cheek: [number, number] };
}

/** A head-and-shoulders portrait 48 rows tall, as a stand would hold it: cells 3 units wide and 8 tall. */
function face(cols = 128, rows = 48, seed = 1, cut = false): Pic {
  const px = new Uint8ClampedArray(cols * rows * 4);
  const r = rng(seed);
  const aspect = 3 / 8;
  // In rows (the cell's width scaled to rows), so the face is round on the stand.
  const W = cols * aspect;
  const cx = W / 2;
  const cy = rows * 0.52;
  const fr = rows * 0.3;
  const eyes: [number, number][] = [];
  const set = (x: number, y: number, c: [number, number, number], a = 255): void => {
    const p = (y * cols + x) * 4;
    px[p] = c[0];
    px[p + 1] = c[1];
    px[p + 2] = c[2];
    px[p + 3] = a;
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const u = (x + 0.5) * aspect;
      const v = y + 0.5;
      const n = (r() - 0.5) * 18; // photo grain
      // A studio backdrop, lighter at the top.
      let c: [number, number, number] = [205 - y * 0.8 + n, 208 - y * 0.8 + n, 212 - y * 0.8 + n];
      let a = 255;
      const dx = (u - cx) / (fr * 0.82);
      const dy = (v - cy) / fr;
      const inFace = dx * dx + dy * dy < 1;
      // Shoulders: a dark shirt across the bottom.
      if (v > rows * 0.84 && Math.abs(u - cx) < W * 0.42) c = [38 + n, 40 + n, 52 + n];
      if (cut && !inFace && v < rows * 0.84) a = 0;
      // Hair: a dark cap over the top of the head.
      const hx = (u - cx) / (fr * 0.95);
      const hy = (v - (cy - fr * 0.25)) / (fr * 0.95);
      if (hx * hx + hy * hy < 1 && v < cy - fr * 0.35) c = [62 + n, 44 + n, 30 + n];
      if (inFace && v >= cy - fr * 0.35) {
        // Skin, lit from the left: lighter on the left cheek, a shadow down the right.
        const lit = 0.5 - (u - cx) / (fr * 2);
        const k = 150 + lit * 80 + n;
        c = [k + 30, k + 5, k - 20];
      }
      set(x, y, c, a);
    }
  }
  // Eyes (with brows), nose shadow, mouth: the landmarks.
  const ink = (u0: number, v0: number, ru: number, rv: number, c: [number, number, number]): void => {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const du = ((x + 0.5) * aspect - u0) / ru;
        const dv = (y + 0.5 - v0) / rv;
        if (du * du + dv * dv < 1) set(x, y, c);
      }
    }
  };
  for (const side of [-1, 1]) {
    const eu = cx + side * fr * 0.36;
    const ev = cy - fr * 0.12;
    ink(eu, ev, fr * 0.16, fr * 0.07, [52, 40, 34]);
    ink(eu, ev - fr * 0.2, fr * 0.2, fr * 0.045, [70, 52, 40]);
    eyes.push([Math.round(eu / aspect - 0.5), Math.round(ev - 0.5)]);
  }
  ink(cx + fr * 0.06, cy + fr * 0.2, fr * 0.06, fr * 0.1, [118, 84, 62]);
  ink(cx, cy + fr * 0.48, fr * 0.3, fr * 0.06, [96, 40, 44]);
  return {
    name: `face ${cols}x${rows}${cut ? ' cut out' : ''}`, cols, rows, px,
    marks: {
      eyes,
      mouth: [Math.round(cx / aspect - 0.5), Math.round(cy + fr * 0.48 - 0.5)],
      cheek: [Math.round((cx - fr * 0.45) / aspect - 0.5), Math.round(cy + fr * 0.15 - 0.5)],
    },
  };
}

/** Pure noise: the worst case for lone cards. */
function noise(cols: number, rows: number, seed = 9): Pic {
  const px = new Uint8ClampedArray(cols * rows * 4);
  const r = rng(seed);
  for (let p = 0; p < cols * rows; p++) {
    px[p * 4] = r() * 256;
    px[p * 4 + 1] = r() * 256;
    px[p * 4 + 2] = r() * 256;
    px[p * 4 + 3] = 255;
  }
  return { name: `noise ${cols}x${rows}`, cols, rows, px };
}

/** A smooth left-to-right ramp, white to black, with see-through corners (some just under the threshold). */
function ramp(cols: number, rows: number): Pic {
  const px = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = (y * cols + x) * 4;
      const k = 255 - (x / (cols - 1)) * 255;
      px[p] = k;
      px[p + 1] = k;
      px[p + 2] = k;
      const corner = (x < cols * 0.1 || x > cols * 0.9) && (y < rows * 0.15 || y > rows * 0.85);
      px[p + 3] = corner ? (x % 2 ? 0 : 127) : 255;
    }
  }
  return { name: `ramp ${cols}x${rows}`, cols, rows, px };
}

/** One flat colour. */
function flat(cols: number, rows: number): Pic {
  const px = new Uint8ClampedArray(cols * rows * 4);
  for (let p = 0; p < cols * rows; p++) px.set([120, 90, 60, 255], p * 4);
  return { name: `flat ${cols}x${rows}`, cols, rows, px };
}

// -------------------------------------------------------------- palettes ---

const PALETTES: Record<string, string[]> = {
  'Royal blue / white': ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a', '#10539e'],
  'Black / gold': ['#262a33', '#16161a', '#e8b73a', '#f2f1ec', '#7a5c12'],
  'Green / white': ['#262a33', '#0f7a3d', '#f2f1ec', '#16161a', '#0a4f28'],
  'Red / white / black': ['#262a33', '#c8242c', '#f2f1ec', '#16161a', '#7c1218'],
  'two colours (red, white)': ['#262a33', '#c8242c', '#f2f1ec'],
  'two colours (navy, gold)': ['#262a33', '#14213d', '#fca311'],
  'one colour (black)': ['#262a33', '#16161a'],
  'one colour (white)': ['#262a33', '#f2f1ec'],
  'messy (repeats, short hex, junk)': ['#262a33', '#C8242C', '#c8242c', '#fff', 'nope', '#16161a'],
  'many (real colours added)': ['#262a33', ...Array.from({ length: 40 }, (_, i) => {
    const h = (i * 47) % 360;
    const l = 20 + ((i * 13) % 65);
    const c = (n: number): string => {
      const k = (n + h / 30) % 12;
      const a = 0.6 * Math.min(l / 100, 1 - l / 100);
      const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    return `#${c(0)}${c(8)}${c(4)}`;
  })],
};

const ASPECT = 3 / 8;
const THRESHOLD = 128;

/** Opaque cells none of whose opaque 4-neighbours shares their card, as a share of the opaque cells. */
function loneShare(out: Int16Array, cols: number, rows: number): number {
  let lone = 0;
  let opaque = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = out[y * cols + x];
      if (v < 0) continue;
      opaque++;
      let seen = 0;
      let same = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const w = out[yy * cols + xx];
        if (w < 0) continue;
        seen++;
        if (w === v) same++;
      }
      if (seen > 0 && same === 0) lone++;
    }
  }
  return opaque ? lone / opaque : 0;
}

const lightness = (hex: string): number => {
  const v = parseInt(hex.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
};

// ----------------------------------------------------------------- runs ---

console.log('portrait styles: palette cards only, transparent kept, no lone cards, deterministic');
const pictures: Pic[] = [face(), face(128, 48, 3, true), face(213, 80, 5), noise(96, 40), ramp(120, 44), flat(40, 20), flat(2, 2), noise(3, 1)];
const timings: Record<string, number> = {};
for (const pic of pictures) {
  for (const [pname, palette] of Object.entries(PALETTES)) {
    const paletteBefore = palette.slice();
    for (const style of PORTRAIT_STYLES) {
      const before = pic.px.slice();
      const t0 = performance.now();
      const out = stylePortrait(style, pic.px, pic.cols, pic.rows, palette, { alphaThreshold: THRESHOLD, aspect: ASPECT });
      timings[style] = (timings[style] ?? 0) + performance.now() - t0;
      const again = stylePortrait(style, pic.px, pic.cols, pic.rows, palette, { alphaThreshold: THRESHOLD, aspect: ASPECT });
      const tag = `${style} · ${pic.name} · ${pname}`;
      let badIdx = 0;
      let leaked = 0;
      let unpainted = 0;
      const used = new Set<number>();
      for (let p = 0; p < out.length; p++) {
        const v = out[p];
        if (v !== -1 && (v < 1 || v >= palette.length)) badIdx++;
        const transparent = pic.px[p * 4 + 3] < THRESHOLD;
        if (transparent && v !== -1) leaked++;
        if (!transparent && v === -1) unpainted++;
        if (v >= 0) used.add(v);
      }
      const ok =
        out.length === pic.cols * pic.rows &&
        badIdx === 0 &&
        leaked === 0 &&
        out.every((v, i) => v === again[i]) &&
        before.every((v, i) => v === pic.px[i]) &&
        palette.every((c, i) => c === paletteBefore[i]);
      check(`${tag}: cards only, transparent kept, deterministic, nothing changed`, ok, `bad ${badIdx}, leaked ${leaked}`);
      const cards = new Set(palette.slice(1).map((c) => c.toLowerCase().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3')).filter((c) => /^#[0-9a-f]{6}$/.test(c))).size;
      if (cards >= 2) check(`${tag}: every opaque cell painted`, unpainted === 0, `${unpainted} left`);
      if (pic.cols * pic.rows >= 400) {
        const lone = loneShare(out, pic.cols, pic.rows);
        check(`${tag}: lone cards at most 0.5%`, lone <= 0.005, `${(lone * 100).toFixed(2)}%`);
      }
      // A two-colour palette: a face uses both.
      if (pic.marks && cards === 2) check(`${tag}: both colours used`, used.size === 2, [...used].join(','));
      // One colour: that card, and the seats beneath for the other tone.
      if (pic.marks && cards === 1) check(`${tag}: one colour and the seats beneath`, used.size === 1 && unpainted > 0 && unpainted < out.length);
    }
  }
}

console.log('a drawn face at 48 rows reads: eyes and mouth dark, cheek light');
{
  const pic = face();
  const m = pic.marks!;
  for (const [pname, palette] of Object.entries(PALETTES)) {
    if (palette.length < 3 || pname.startsWith('many') || pname.startsWith('messy')) continue;
    for (const style of PORTRAIT_STYLES) {
      const out = stylePortrait(style, pic.px, pic.cols, pic.rows, palette, { alphaThreshold: THRESHOLD, aspect: ASPECT });
      const L = (x: number, y: number): number => lightness(palette[out[y * pic.cols + x]]);
      // The darkest card within a cell of the landmark (a halftone dot or an edge may sit beside it).
      const darkNear = (x: number, y: number): number => {
        let best = Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) best = Math.min(best, L(x + dx, y + dy));
        return best;
      };
      const cheek = L(m.cheek[0], m.cheek[1]);
      const eyes = m.eyes.map(([x, y]) => darkNear(x, y));
      const mouth = darkNear(m.mouth[0], m.mouth[1]);
      check(
        `${style} · ${pname}: both eyes and the mouth darker than the cheek`,
        eyes.every((e) => e < cheek) && mouth < cheek,
        `eyes ${eyes.map((e) => e.toFixed(0)).join('/')}, mouth ${mouth.toFixed(0)}, cheek ${cheek.toFixed(0)}`,
      );
    }
  }
  // The stencil cuts somewhere sensible: neither nearly all ink nor nearly all paper.
  const out = stylePortrait('stencil', pic.px, pic.cols, pic.rows, PALETTES['Red / white / black'], { alphaThreshold: THRESHOLD, aspect: ASPECT });
  const ink = out.filter((v) => v === 3).length / out.length;
  check('stencil: ink is between a quarter and two thirds of the picture', ink >= 0.25 && ink <= 0.67, `${(ink * 100).toFixed(0)}%`);
  const colours = (style: PortraitStyle, pal: string[]): number => new Set(stylePortrait(style, pic.px, pic.cols, pic.rows, pal, { alphaThreshold: THRESHOLD, aspect: ASPECT })).size;
  check('stencil and halftone: two cards', colours('stencil', PALETTES['Red / white / black']) === 2 && colours('halftone', PALETTES['Red / white / black']) === 2);
  check('poster 2: two cards, poster 3: three', colours('poster2', PALETTES['Red / white / black']) === 2 && colours('poster3', PALETTES['Red / white / black']) === 3);
  check('pop art: three cards from a four-colour palette', colours('pop', PALETTES['Red / white / black']) === 3);
}

console.log('halftone: dots that span several seats');
{
  const pic = ramp(160, 60);
  const out = stylePortrait('halftone', pic.px, pic.cols, pic.rows, PALETTES['Black / gold'], { alphaThreshold: THRESHOLD, aspect: ASPECT });
  // Ink patches in the light half (dots on paper), by size.
  const seen = new Uint8Array(out.length);
  const sizes: number[] = [];
  const ink = 1; // #16161a, the darkest
  for (let s = 0; s < out.length; s++) {
    const sx = s % pic.cols;
    if (seen[s] || out[s] !== ink || sx < pic.cols * 0.15 || sx > pic.cols * 0.45) continue;
    let n = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % pic.cols;
      for (const q of [x > 0 ? p - 1 : -1, x < pic.cols - 1 ? p + 1 : -1, p - pic.cols, p + pic.cols]) {
        if (q < 0 || q >= out.length || seen[q] || out[q] !== ink) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  check('halftone: a screen of separate dots in the light half', sizes.length >= 8, `${sizes.length} dots`);
  // The smallest are a row of 4 or 5 cards (a dot just over the size that is left out), the usual ones far more.
  check('halftone: every dot is several seats (at least 4), the median one 8 or more', (sizes[0] ?? 0) >= 4 && median >= 8, `smallest ${sizes[0]}, median ${median}`);
}

console.log('the layer keeps its style');
{
  const fonts = [{ id: 'f', name: 'F', css: '700 10px sans-serif' }] as unknown as TifoFont[];
  const base: ImageObject = {
    id: 'i1', kind: 'image', cx: 10, cy: 20, width: 384, height: 384, rotation: 0, colorIndex: 0, tier: null,
    bitmap: null, name: 'captain.png', src: 'data:image/png;base64,AAAA', dither: false, alphaThreshold: 128,
  };
  const styled: ImageObject = { ...base, style: 'stencil' };
  check('the style is part of what re-draws the picture', gridKeyFor(base) !== gridKeyFor(styled) && gridKeyFor(styled) !== gridKeyFor({ ...base, style: 'pop' }));
  check('a picture without one keeps the key it was saved with', gridKeyFor(base) === 'i|128x48|000|128', gridKeyFor(base));
  const j = objectToJSON(styled);
  check('saved with the layer', j.style === 'stencil');
  check('and without, nothing is saved', !('style' in objectToJSON(base)));
  const back = objectFromJSON(JSON.parse(JSON.stringify(j)), fonts, 5);
  check('restored with the layer', back?.kind === 'image' && back.style === 'stencil');
  for (const bad of ['sepia', 'STENCIL', '', 42, { x: 1 }, ['pop'], null]) {
    const r = objectFromJSON({ ...j, style: bad }, fonts, 5);
    check(`an unknown style (${JSON.stringify(bad)}) is dropped, the picture kept`, r?.kind === 'image' && !('style' in r) && r.name === 'captain.png');
  }
  check('isPortraitStyle knows exactly the five', PORTRAIT_STYLES.every((s) => isPortraitStyle(s)) && !isPortraitStyle('original') && !isPortraitStyle(undefined));
}

console.log(`  time per style, all ${pictures.length} pictures x ${Object.keys(PALETTES).length} palettes: ${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ')}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
