/**
 * Portrait styles (core/portraitStyles.ts), the AI pictures' rank
 * posterisation, the matte clean-up (core/matte.ts) and a portrait's geometry
 * (core/portraitPipeline.ts), checked on synthetic pictures in Node:
 *   npx tsx scripts/verify-portrait.mts
 *
 * Every style, on every picture and palette below:
 *  - hands back palette cards only: -1 (leave the seat) or 1..n-1, never slot
 *    0 (the empty seat);
 *  - keeps the transparent transparent (alpha under the threshold: -1; pop
 *    art paints it with its field), and with two cards or more, paints every
 *    opaque cell;
 *  - leaves no card in a run of fewer than three seats, across or down: the
 *    rule core/analysis.ts calls a seat fragile by, since an empty seat on the
 *    day erases anything thinner;
 *  - is deterministic, and changes neither the pixels nor the palette;
 *  - reads with a two-colour palette (both cards used) and does something
 *    sensible with one.
 * And on a drawn face at stand size (48 rows): the eyes and the mouth land on
 * the dark side and the cheek on the light side, which is what makes it a face
 * from the far end; with the face's landmarks, even on a face lit so flat the
 * tone alone loses them, and each is at least three seats by three rows. The
 * layer keeps its style, face and seats through saving (anything unknown is
 * dropped, the retired halftone is read as a stencil) and they are part of
 * what makes the picture re-draw.
 */
import { BANNER_STYLES, PORTRAIT_STYLES, RANK_TONES, SEAT_STYLES, duotoneRamp, rankTonesFor, isPortraitStyle, portraitStyleOf, posterizeByRank, stylePortrait, type PortraitStyle } from '../src/core/portraitStyles';
import { gridKeyFor, gridSize, objectFromJSON, objectToJSON, type ImageObject } from '../src/core/objects';
import type { TifoFont } from '../src/core/text';
import {
  FACE_POINTS, ROWS_FACE, ROWS_SHOULDERS, cropKindFor, faceFrame, faceInCrop, isFaceInfo, pictureAspectFor, plausibleFace, portraitCrop,
  portraitFootprint, seatShapeAt, type FaceInfo,
} from '../src/core/portraitPipeline';
import { alphaBounds, decontaminate, guidedFilter, hasMatte, refineMatte, resizeBilinear } from '../src/core/matte';
import { generateSeatMap } from '../src/core/seatmap';
import { spanFrameCache } from '../src/render/simulator/standFrame';
import { tvShot } from '../src/render/simulator/tvShot';
import { templateById } from '../src/core/stadiumCatalog';
import { regionPredicate, regionRect } from '../src/core/specCompiler';

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
  /** The face's 68 landmarks, as the browser would find them. */
  face?: FaceInfo;
}

/**
 * A head-and-shoulders portrait 48 rows tall, as a stand would hold it: cells
 * 3 units wide and 8 tall. `flat`: lit from the front and low in contrast,
 * the photo where tone alone loses the eyes.
 */
function face(cols = 128, rows = 48, seed = 1, cut = false, flat = false): Pic {
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
        const lit = flat ? 0.5 : 0.5 - (u - cx) / (fr * 2);
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
  // Flat light: the features barely darker than the skin (a soft, front-lit photo).
  const tint = (c: [number, number, number]): [number, number, number] => (flat ? [c[0] * 0.25 + 150, c[1] * 0.25 + 118, c[2] * 0.25 + 92] : c);
  for (const side of [-1, 1]) {
    const eu = cx + side * fr * 0.36;
    const ev = cy - fr * 0.12;
    ink(eu, ev, fr * 0.16, fr * 0.07, tint([52, 40, 34]));
    ink(eu, ev - fr * 0.2, fr * 0.2, fr * 0.045, tint([70, 52, 40]));
    eyes.push([Math.round(eu / aspect - 0.5), Math.round(ev - 0.5)]);
  }
  ink(cx + fr * 0.06, cy + fr * 0.2, fr * 0.06, fr * 0.1, tint([118, 84, 62]));
  ink(cx, cy + fr * 0.48, fr * 0.3, fr * 0.06, tint([96, 40, 44]));
  // The 68 landmarks a detector finds on this face (iBUG order), in shares of the picture.
  const pts: number[] = [];
  const pt = (u: number, v: number): void => { pts.push(u / aspect / cols, v / rows); };
  for (let k = 0; k <= 16; k++) { const t = Math.PI - (k * Math.PI) / 16; pt(cx + fr * 0.82 * Math.cos(t), cy + fr * Math.sin(t)); }
  for (const side of [-1, 1]) for (let k = 0; k < 5; k++) pt(cx + side * fr * 0.36 + (k - 2) * fr * 0.1, cy - fr * 0.32);
  for (let k = 0; k < 4; k++) pt(cx, cy - fr * 0.12 + k * fr * 0.1);
  for (let k = 0; k < 5; k++) pt(cx + (k - 2) * fr * 0.05, cy + fr * 0.27);
  for (const side of [-1, 1]) for (let k = 0; k < 6; k++) { const t = Math.PI - (k * Math.PI) / 3; pt(cx + side * fr * 0.36 + fr * 0.16 * Math.cos(t), cy - fr * 0.12 - fr * 0.07 * Math.sin(t)); }
  for (let k = 0; k < 12; k++) { const t = Math.PI - (k * Math.PI) / 6; pt(cx + fr * 0.3 * Math.cos(t), cy + fr * 0.48 - fr * 0.06 * Math.sin(t)); }
  for (let k = 0; k < 8; k++) { const t = Math.PI - (k * Math.PI) / 4; pt(cx + fr * 0.2 * Math.cos(t), cy + fr * 0.48 - fr * 0.02 * Math.sin(t)); }
  return {
    name: `face ${cols}x${rows}${cut ? ' cut out' : ''}${flat ? ' flat-lit' : ''}`, cols, rows, px,
    face: { box: [(cx - fr) / aspect / cols, (cy - fr) / rows, (2 * fr) / aspect / cols, (2 * fr) / rows], pts },
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

/**
 * Painted cells in a run of fewer than three of their own card across or
 * down (a transparent cell or the frame ends a run), as a share of the
 * painted cells: core/analysis.ts calls such a seat fragile.
 */
function thinShare(out: Int16Array, cols: number, rows: number): number {
  let thin = 0;
  let painted = 0;
  const run = (x: number, y: number, dx: number, dy: number): number => {
    const v = out[y * cols + x];
    let n = 1;
    for (const sgn of [1, -1]) {
      let xx = x + sgn * dx;
      let yy = y + sgn * dy;
      while (n < 3 && xx >= 0 && yy >= 0 && xx < cols && yy < rows && out[yy * cols + xx] === v) {
        n++;
        xx += sgn * dx;
        yy += sgn * dy;
      }
    }
    return n;
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (out[y * cols + x] < 0) continue;
      painted++;
      if (run(x, y, 1, 0) < 3 || run(x, y, 0, 1) < 3) thin++;
    }
  }
  return painted ? thin / painted : 0;
}

const lightness = (hex: string): number => {
  const h = hex.toLowerCase().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3');
  const v = parseInt(h.slice(1), 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
};

// ----------------------------------------------------------------- runs ---

console.log('portrait styles: palette cards only, transparent kept, nothing under three seats, deterministic');
const pictures: Pic[] = [face(), face(128, 48, 3, true), face(213, 80, 5), face(128, 48, 7, false, true), noise(96, 40), ramp(120, 44), flat(40, 20), flat(2, 2), noise(3, 1)];
const timings: Record<string, number> = {};
for (const pic of pictures) {
  for (const [pname, palette] of Object.entries(PALETTES)) {
    const paletteBefore = palette.slice();
    for (const style of PORTRAIT_STYLES) {
      const before = pic.px.slice();
      const t0 = performance.now();
      const opts = { alphaThreshold: THRESHOLD, aspect: ASPECT, face: pic.face };
      const out = stylePortrait(style, pic.px, pic.cols, pic.rows, palette, opts);
      timings[style] = (timings[style] ?? 0) + performance.now() - t0;
      const again = stylePortrait(style, pic.px, pic.cols, pic.rows, palette, opts);
      const tag = `${style} · ${pic.name} · ${pname}`;
      let badIdx = 0;
      let leaked = 0;
      let unpainted = 0;
      const used = new Set<number>();
      // The outline is cleaned at seat scale too: a gap in the picture
      // thinner than three seats is closed, a sliver of it that thin is
      // dropped. Both only ever next to the other side.
      const clearAt = (x: number, y: number): boolean => x < 0 || y < 0 || x >= pic.cols || y >= pic.rows || pic.px[(y * pic.cols + x) * 4 + 3] < THRESHOLD;
      const beside = (p: number, clear: boolean): boolean => {
        const x = p % pic.cols;
        const y = (p - x) / pic.cols;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (clearAt(x + dx, y + dy) === clear && (dx || dy)) return true;
        return false;
      };
      let farLeak = 0;
      let farHole = 0;
      for (let p = 0; p < out.length; p++) {
        const v = out[p];
        if (v !== -1 && (v < 1 || v >= palette.length)) badIdx++;
        const transparent = pic.px[p * 4 + 3] < THRESHOLD;
        // Pop art's field and the Hope poster's split field are the only things painted where the picture is not.
        if (transparent && v !== -1 && style !== 'pop' && style !== 'poster3') { leaked++; if (!beside(p, false)) farLeak++; }
        if (!transparent && v === -1) { unpainted++; if (!beside(p, true)) farHole++; }
        if (v >= 0) used.add(v);
      }
      const opaqueCells = pic.px.filter((_, i) => i % 4 === 3 && pic.px[i] >= THRESHOLD).length;
      const cards = new Set(palette.slice(1).map((c) => c.toLowerCase().replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3')).filter((c) => /^#[0-9a-f]{6}$/.test(c))).size;
      // One card: the tones on its other side are left to the seats beneath, on purpose.
      const holesOk = cards === 1 || (farHole === 0 && leaked + unpainted <= Math.max(2, opaqueCells * 0.05));
      const ok =
        out.length === pic.cols * pic.rows &&
        badIdx === 0 &&
        farLeak === 0 &&
        holesOk &&
        out.every((v, i) => v === again[i]) &&
        before.every((v, i) => v === pic.px[i]) &&
        palette.every((c, i) => c === paletteBefore[i]);
      check(`${tag}: cards only, transparent kept, deterministic, nothing changed`, ok, `bad ${badIdx}, leaked ${leaked} (${farLeak} far), dropped ${unpainted} (${farHole} far)`);
      // Three cards or more: pop art has a field of its own to paint the outside with.
      if (style === 'pop' && pic.name.includes('cut out') && cards >= 3) check(`${tag}: the field paints the transparent cells`, out.every((v) => v >= 0));
      if (cards >= 2) check(`${tag}: every opaque cell painted but the outline's slivers`, farHole === 0 && unpainted <= opaqueCells * 0.05, `${unpainted} left`);
      if (pic.cols * pic.rows >= 400) {
        const thin = thinShare(out, pic.cols, pic.rows);
        // Pure noise is the worst case there is; a picture should leave nothing thin at all.
        // A corner where three areas meet can leave a cell or two in ten thousand that no change of card fixes.
        const allowed = pic.name.startsWith('noise') ? 0.006 : 0.001;
        check(`${tag}: no card in a run under three seats`, thin <= allowed, `${(thin * 100).toFixed(2)}%`);
      }
      // A two-colour palette: a face uses both.
      if (pic.marks && cards === 2) check(`${tag}: both colours used`, used.size === 2, [...used].join(','));
      // One colour: that card, and the seats beneath for the other tone.
      if (pic.marks && cards === 1) check(`${tag}: one colour and the seats beneath`, used.size === 1 && unpainted > 0 && unpainted < out.length);
    }
  }
}

console.log('a drawn face at 48 rows reads: eyes and mouth dark, cheek light (by tone, and with its landmarks even when lit flat)');
for (const [pic, withFace] of [[face(), false], [face(), true], [face(128, 48, 7, false, true), true]] as const) {
  const m = pic.marks!;
  for (const [pname, palette] of Object.entries(PALETTES)) {
    if (palette.length < 3 || pname.startsWith('many') || pname.startsWith('messy')) continue;
    for (const style of PORTRAIT_STYLES) {
      const out = stylePortrait(style, pic.px, pic.cols, pic.rows, palette, { alphaThreshold: THRESHOLD, aspect: ASPECT, face: withFace ? pic.face : null });
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
        `${style} · ${pname} · ${pic.name}${withFace ? ' with landmarks' : ''}: both eyes and the mouth darker than the cheek`,
        eyes.every((e) => e < cheek) && mouth < cheek,
        `eyes ${eyes.map((e) => e.toFixed(0)).join('/')}, mouth ${mouth.toFixed(0)}, cheek ${cheek.toFixed(0)}`,
      );
    }
  }
}
{
  const pic = face();
  // The stencil cuts somewhere sensible: neither nearly all ink nor nearly all paper.
  const out = stylePortrait('stencil', pic.px, pic.cols, pic.rows, PALETTES['Red / white / black'], { alphaThreshold: THRESHOLD, aspect: ASPECT, face: pic.face });
  const ink = out.filter((v) => v === 3).length / out.length;
  check('stencil: ink is between a quarter and two thirds of the picture', ink >= 0.25 && ink <= 0.67, `${(ink * 100).toFixed(0)}%`);
  const cardsOf = (style: PortraitStyle, pal: string[], p: Pic = pic): Set<number> =>
    new Set([...stylePortrait(style, p.px, p.cols, p.rows, pal, { alphaThreshold: THRESHOLD, aspect: ASPECT, face: p.face })].filter((v) => v >= 0));
  const rwb = PALETTES['Red / white / black'];
  check('stencil: two cards, the darkest and the lightest', JSON.stringify([...cardsOf('stencil', rwb)].sort()) === JSON.stringify([2, 3]), [...cardsOf('stencil', rwb)].join(','));
  check('poster 2: two cards, poster 3: three', cardsOf('poster2', rwb).size === 2 && cardsOf('poster3', rwb).size === 3);
  // The duotone is two club colours: the club's own and the colourful card
  // furthest from it in lightness, or the paper when there is none.
  const green = PALETTES['Green / white'];
  const duo = [...cardsOf('duotone', green)].sort();
  check('duotone: green and white (the dark green is too close to the green to tell apart)', JSON.stringify(duo) === JSON.stringify([1, 2]), duo.join(','));
  const blue = [...cardsOf('duotone', PALETTES['Royal blue / white'])].sort();
  check('duotone: blue and gold, two club colours, when the palette has both', JSON.stringify(blue) === JSON.stringify([1, 3]), blue.join(','));
  check('duotone: two cards from a two-colour palette', cardsOf('duotone', PALETTES['two colours (red, white)']).size === 2);
  // Pop art: the subject in its tones and the field in a colour of its own.
  const cut = face(128, 48, 3, true);
  const popOut = stylePortrait('pop', cut.px, cut.cols, cut.rows, rwb, { alphaThreshold: THRESHOLD, aspect: ASPECT, face: cut.face });
  const fieldCards = new Set<number>();
  const subjectCards = new Set<number>();
  for (let p = 0; p < popOut.length; p++) (cut.px[p * 4 + 3] < THRESHOLD ? fieldCards : subjectCards).add(popOut[p]);
  const counts = new Map<number, number>();
  for (let p = 0; p < popOut.length; p++) if (cut.px[p * 4 + 3] < THRESHOLD) counts.set(popOut[p], (counts.get(popOut[p]) ?? 0) + 1);
  const [field, fieldN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const clearN = [...counts.values()].reduce((a, b) => a + b, 0);
  check('pop art: a flat field of one colour behind the subject', field >= 1 && fieldN >= clearN * 0.97, `${fieldN} of ${clearN}`);
  // The field is folded only where the subject's own outline is cleaned up: it stays mostly its own.
  check('pop art: the field is a colour the subject does not wear', !subjectCards.has(field) || [...popOut].filter((v, p) => v === field && cut.px[p * 4 + 3] >= THRESHOLD).length < popOut.length * 0.01, `field ${field}, subject ${[...subjectCards].join(',')}`);
}

console.log('the landmarks: each feature at least three seats by three rows, on a face lit flat');
{
  const pic = face(128, 48, 7, false, true);
  const m = pic.marks!;
  for (const style of ['stencil', 'poster3', 'duotone'] as PortraitStyle[]) {
    const pal = PALETTES['Red / white / black'];
    const out = stylePortrait(style, pic.px, pic.cols, pic.rows, pal, { alphaThreshold: THRESHOLD, aspect: ASPECT, face: pic.face });
    const darkest = [...new Set(out)].filter((v) => v >= 0).sort((a, b) => lightness(pal[a]) - lightness(pal[b]))[0];
    // A 3 x 3 block of the darkest card within two cells of the landmark.
    const block = (x: number, y: number): boolean => {
      for (let oy = -3; oy <= 1; oy++) for (let ox = -3; ox <= 1; ox++) {
        let all = true;
        for (let dy = 0; dy < 3 && all; dy++) for (let dx = 0; dx < 3 && all; dx++) {
          const xx = x + ox + dx;
          const yy = y + oy + dy;
          if (xx < 0 || yy < 0 || xx >= pic.cols || yy >= pic.rows || out[yy * pic.cols + xx] !== darkest) all = false;
        }
        if (all) return true;
      }
      return false;
    };
    check(`${style}: both eyes and the mouth are a 3 x 3 block of ink at least`, m.eyes.every(([x, y]) => block(x, y)) && block(m.mouth[0], m.mouth[1]));
  }
  // Without the landmarks, the same flat face keeps its eyes only by luck: the landmarks are what make it reliable.
  const out = stylePortrait('stencil', pic.px, pic.cols, pic.rows, PALETTES['Red / white / black'], { alphaThreshold: THRESHOLD, aspect: ASPECT, face: pic.face });
  const plain = stylePortrait('stencil', pic.px, pic.cols, pic.rows, PALETTES['Red / white / black'], { alphaThreshold: THRESHOLD, aspect: ASPECT });
  check('the landmarks change the drawing (they are used)', out.some((v, i) => v !== plain[i]));
}

console.log('the retired halftone, and the six styles');
{
  check('isPortraitStyle knows exactly the six', PORTRAIT_STYLES.length === 6 && PORTRAIT_STYLES.every((s) => isPortraitStyle(s)) && !isPortraitStyle('halftone') && !isPortraitStyle('original') && !isPortraitStyle(undefined));
  check('a design saved with halftone is read as a stencil', portraitStyleOf('halftone') === 'stencil' && portraitStyleOf('pop') === 'pop' && portraitStyleOf('sepia') === undefined);
}

console.log('styles that differ in look: outlines, a split field, a soft duotone, painted for banners');
{
  check('the seat picker offers four looks, not Poster 2 or Painted', SEAT_STYLES.join() === 'stencil,poster3,duotone,pop');
  check('a banner adds Painted', BANNER_STYLES.includes('painted') && !BANNER_STYLES.includes('poster2'));
  // A cut-out head on a transparent field, 60 rows: room for an outline.
  const pic = face(160, 60, 11, true);
  const pal = PALETTES['Green / white'];
  const L = pal.map((h) => lightness(h));
  const darkest = L.slice(1).indexOf(Math.min(...L.slice(1))) + 1;
  const opts = { alphaThreshold: THRESHOLD, aspect: ASPECT, face: pic.face };
  const clear = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < pic.cols && y < pic.rows && pic.px[(y * pic.cols + x) * 4 + 3] < THRESHOLD;
  /** Share of the subject's cells next to its outside that hold `card`. */
  const rimShare = (out: Int16Array, card: (v: number) => boolean): number => {
    let n = 0, hit = 0;
    for (let y = 0; y < pic.rows; y++) for (let x = 0; x < pic.cols; x++) {
      const p = y * pic.cols + x;
      if (clear(x, y) || out[p] < 0) continue;
      if (!(clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1))) continue;
      n++;
      if (card(out[p])) hit++;
    }
    return n ? hit / n : 0;
  };
  for (const st of ['stencil', 'poster3', 'painted'] as const) {
    const out = stylePortrait(st, pic.px, pic.cols, pic.rows, pal, opts);
    const share = rimShare(out, (v) => v === darkest);
    check(`${st}: a hard dark outline round the subject (${(share * 100).toFixed(0)}% of its edge)`, share >= 0.9);
    check(`${st}: the outline still leaves nothing under three seats`, thinShare(out, pic.cols, pic.rows) <= 0.001, `${(thinShare(out, pic.cols, pic.rows) * 100).toFixed(2)}%`);
  }
  {
    const out = stylePortrait('duotone', pic.px, pic.cols, pic.rows, pal, opts);
    check('duotone: no outline', rimShare(out, (v) => v === darkest) < 0.5);
    const used = new Set([...out].filter((v) => v >= 0));
    check('duotone: two club colours, not black and white', used.has(1) && ![...used].every((v) => v === darkest || pal[v] === '#f2f1ec'), [...used].map((v) => pal[v]).join(' '));
  }
  {
    const out = stylePortrait('poster3', pic.px, pic.cols, pic.rows, pal, opts);
    const at = (x: number, y: number): number => out[y * pic.cols + x];
    check('poster3: the field is split down the middle into two tones', at(1, 1) >= 0 && at(pic.cols - 2, 1) >= 0 && at(1, 1) !== at(pic.cols - 2, 1));
  }
  {
    const rgba = duotoneRamp(pic.px, pic.cols, pic.rows, pal, opts);
    const seen = new Set<number>();
    let leak = 0;
    for (let p = 0; p < pic.cols * pic.rows; p++) {
      const a = rgba[p * 4 + 3];
      if (pic.px[p * 4 + 3] < THRESHOLD) { if (a) leak++; continue; }
      seen.add((rgba[p * 4] << 16) | (rgba[p * 4 + 1] << 8) | rgba[p * 4 + 2]);
    }
    check(`the banner duotone is a smooth ramp (${seen.size} shades), transparent kept`, seen.size >= 24 && leak === 0);
  }
  check('AI tones follow the rows: 2 under 16, 3 under 30, 4 from 30', rankTonesFor(12) === 2 && rankTonesFor(24) === 3 && rankTonesFor(40) === 4 && rankTonesFor(80) === RANK_TONES);
  {
    const small = face(60, 12, 4, true);
    const out = posterizeByRank(small.px, small.cols, small.rows, PALETTES['Red / white / black'], { alphaThreshold: THRESHOLD, aspect: ASPECT });
    const used = new Set([...out].filter((v) => v >= 0));
    check(`a 12-row AI picture is cut into two tones (${used.size})`, used.size <= 2 && used.size >= 1);
  }
}

console.log('AI pictures: posterised by brightness rank into the palette, cleaned at seat scale');
{
  // A grey ramp on a palette of club colours: the tones keep their order, whatever the hues.
  const pic = ramp(160, 50);
  for (const [pname, palette] of Object.entries(PALETTES)) {
    const out = posterizeByRank(pic.px, pic.cols, pic.rows, palette, { alphaThreshold: THRESHOLD, aspect: ASPECT });
    const again = posterizeByRank(pic.px, pic.cols, pic.rows, palette, { alphaThreshold: THRESHOLD, aspect: ASPECT });
    // Along the middle row, lightness never goes up as the ramp goes darker (left white, right black).
    const y = Math.floor(pic.rows / 2);
    let monotone = true;
    let prev = Infinity;
    for (let x = 0; x < pic.cols; x++) {
      const v = out[y * pic.cols + x];
      if (v < 0) continue;
      const L = lightness(palette[v]);
      if (L > prev + 0.5) monotone = false;
      prev = L;
    }
    const used = new Set([...out].filter((v) => v >= 0));
    const cards = new Set(palette.slice(1).filter((c) => /^#([0-9a-f]{3}){1,2}$/i.test(c)).map((c) => c.toLowerCase())).size;
    check(`rank · ${pname}: tones in order of lightness, deterministic, slot 0 never`, monotone && out.every((v, i) => v === again[i]) && !used.has(0), [...used].join(','));
    if (cards >= 2) check(`rank · ${pname}: two to ${RANK_TONES} tones`, used.size >= 2 && used.size <= RANK_TONES, String(used.size));
    check(`rank · ${pname}: no card in a run under three seats`, thinShare(out, pic.cols, pic.rows) === 0);
  }
  // A face in the wrong colours (green skin, a magenta backdrop) still lands as tones, not as a nearest-colour mush.
  const pic2 = face(128, 48, 11);
  for (let p = 0; p < pic2.px.length; p += 4) { const g = pic2.px[p + 1]; pic2.px[p] = g * 0.3; pic2.px[p + 2] = g * 0.5; }
  const pal = PALETTES['Royal blue / white'];
  const out = posterizeByRank(pic2.px, pic2.cols, pic2.rows, pal, { alphaThreshold: THRESHOLD, aspect: ASPECT });
  const m = pic2.marks!;
  const L = (x: number, y: number): number => lightness(pal[out[y * pic2.cols + x]]);
  check('rank: a green-tinted face still has dark eyes and a light cheek', m.eyes.every(([x, y]) => Math.min(L(x, y), L(x - 1, y), L(x + 1, y)) < L(m.cheek[0], m.cheek[1])));
}

console.log('the matte: islands dropped, pinholes filled, real gaps kept, no halo, edge colour cleaned');
{
  const W = 200;
  const H = 160;
  const alpha = new Float32Array(W * H);
  const disc = (cx: number, cy: number, r: number, v: number): void => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) alpha[y * W + x] = v;
  };
  disc(100, 80, 60, 1); // the subject
  disc(100, 80, 18, 0); // a real gap: a trophy's handle, an arm against the body (a share of 9%)
  disc(70, 60, 2, 0); // a pinhole the model punched
  disc(130, 100, 1.5, 0.1); // another, half-sure
  disc(15, 15, 3, 0.9); // a speck of background it kept
  disc(185, 140, 4, 1); // another
  const before = alpha.slice();
  const rep = refineMatte(alpha, W, H);
  check('the specks of background are dropped', alpha[15 * W + 15] < 0.05 && alpha[140 * W + 185] < 0.05, `${alpha[15 * W + 15]}, ${alpha[140 * W + 185]}`);
  check('the pinholes are filled', alpha[60 * W + 70] > 0.95 && alpha[100 * W + 130] > 0.95, `${alpha[60 * W + 70]}, ${alpha[100 * W + 130]}`);
  check('the real gap is kept', alpha[80 * W + 100] < 0.05);
  check('it says what it did', rep.dropped > 0 && rep.filled > 0, JSON.stringify(rep));
  // No halo: the edge does not move out, and is at most two pixels soft.
  let grown = 0;
  let soft = 0;
  for (let k = 0; k < W * H; k++) {
    if (before[k] < 0.5 && alpha[k] > 0.5 && !(((k % W) - 70) ** 2 + (Math.floor(k / W) - 60) ** 2 < 9) && !(((k % W) - 130) ** 2 + (Math.floor(k / W) - 100) ** 2 < 9)) grown++;
    if (alpha[k] > 0.05 && alpha[k] < 0.95) soft++;
  }
  const rim = 2 * Math.PI * (60 + 18);
  check('no halo: the subject does not grow', grown < rim * 0.05, `${grown} px`);
  check('the edge is soft for at most two pixels', soft < rim * 2.2, `${soft} px over a ${rim.toFixed(0)} px rim`);
  // Decontaminate: a red subject shot on green, with a half-and-half edge.
  const w = 40;
  const h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    const t = x < 18 ? 1 : x > 21 ? 0 : (21 - x) / 4;
    a[k] = t;
    rgba.set([Math.round(220 * t + 30 * (1 - t)), Math.round(30 * t + 200 * (1 - t)), 40, 255], k * 4);
  }
  decontaminate(rgba, a, w, h);
  const edge = (5 * w + 20) * 4;
  check('decontaminate: the edge pixel is the subject\'s red, not the pitch\'s green', rgba[edge] > 150 && rgba[edge + 1] < 90, `rgb ${rgba[edge]},${rgba[edge + 1]},${rgba[edge + 2]}`);
  check('decontaminate: alpha is written from the matte', rgba[edge + 3] === Math.round(a[5 * w + 20] * 255));
  // Bounds and the "does it already have a cut-out" test.
  const b = alphaBounds(alpha, W, H)!;
  check('the subject\'s box', b.x0 >= 38 && b.x0 <= 42 && b.x1 >= 158 && b.x1 <= 162, JSON.stringify(b));
  const opaque = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  const cutPng = opaque.slice();
  for (let k = 0; k < 64; k++) cutPng[k * 4 + 3] = 0;
  check('a picture with no transparency has no matte; one a quarter clear has', !hasMatte(opaque, 16, 16) && hasMatte(cutPng, 16, 16));
  // The guided filter snaps a coarse mask to the picture's own edge.
  const gw = 64;
  const guide = new Float32Array(gw * gw);
  for (let k = 0; k < gw * gw; k++) guide[k] = (k % gw) < 29 ? 0.9 : 0.1;
  const coarse = resizeBilinear(Float32Array.from({ length: 64 }, (_, k) => ((k % 8) < 4 ? 1 : 0)), 8, 8, gw, gw);
  const snapped = guidedFilter(guide, coarse, gw, gw, 4, 1e-3);
  // The coarse mask's edge is at 32, the picture's at 29: the half-way point moves towards 29.
  let cross = 0;
  while (cross < gw - 1 && snapped[32 * gw + cross] >= 0.5) cross++;
  check('the guided filter moves the mask\'s edge towards the picture\'s', cross <= 31 && snapped[32 * gw + 26] > 0.8 && snapped[32 * gw + 34] < 0.3, `half-way at ${cross}, ${snapped[32 * gw + 26].toFixed(2)} ${snapped[32 * gw + 34].toFixed(2)}`);
}

console.log('a portrait\'s geometry: crop, rows, the stand\'s real seats');
{
  const pic = face(200, 200);
  const W = 400;
  const H = 400;
  const f = pic.face!;
  check('a face has 68 points and passes the check; junk does not', f.pts.length === FACE_POINTS * 2 && isFaceInfo(f) && !isFaceInfo({ box: [0, 0, 1, 1], pts: [1, 2] }) && !isFaceInfo({ ...f, pts: f.pts.map((v, i) => (i === 3 ? NaN : v)) }));
  const fr = faceFrame(f, W, H);
  const shoulders = portraitCrop(f, W, H, 'shoulders');
  const tight = portraitCrop(f, W, H, 'face');
  check('head and shoulders: about 3.1 face-heights tall, starting above the brow', Math.abs(shoulders.h / fr.F - 3.1) < 0.05 && shoulders.y < fr.brow - 0.9 * fr.F, `${(shoulders.h / fr.F).toFixed(2)} F`);
  check('the face alone: about 2.1 face-heights, tighter', Math.abs(tight.h / fr.F - 2.1) < 0.05 && tight.w < shoulders.w);
  check('centred on the eyes', Math.abs(shoulders.x + shoulders.w / 2 - fr.cx) < 1);
  const inCrop = faceInCrop(f, W, H, tight);
  check('the face re-measured in its crop', isFaceInfo(inCrop) && Math.abs(faceFrame(inCrop, tight.w, tight.h).F - fr.F) < 1e-6, `${isFaceInfo(inCrop)} ${faceFrame(inCrop, tight.w, tight.h).F} ${fr.F} ${JSON.stringify(inCrop.box)}`);
  check(`the rows: head and shoulders from ${ROWS_SHOULDERS}, the face alone from ${ROWS_FACE}, else a silhouette`,
    cropKindFor(60) === 'shoulders' && cropKindFor(ROWS_SHOULDERS) === 'shoulders' && cropKindFor(ROWS_SHOULDERS - 1) === 'face' && cropKindFor(ROWS_FACE) === 'face' && cropKindFor(12) === 'silhouette');
  check('a face in proportion passes; a tiny one or a muddled one does not', plausibleFace(f, W, H)
    && !plausibleFace({ box: [0.5, 0.5, 0.02, 0.02], pts: f.pts.map((v) => 0.5 + v * 0.02) }, W, H)
    && !plausibleFace({ ...f, pts: f.pts.map((v, i) => (i % 2 ? 1 - v : v)) }, W, H));
  // A real stand: Kingdom Arena's south stand, 12 rows.
  const map = generateSeatMap(templateById('kingdom-arena-26k-rb')!);
  const region = { stand: 'south' as const, tier: 'all' as const };
  const rect = regionRect(region, map);
  const shape = seatShapeAt(map, rect, regionPredicate(region, map), 4000)!;
  check('Kingdom Arena south: 12 rows, 156 seats', shape.rows === 12 && shape.seats === 156, JSON.stringify(shape));
  check('…a seat card half to two thirds as wide as a row is tall, as the far side sees it', shape.cell > 0.45 && shape.cell < 0.75, shape.cell.toFixed(2));
  const foot = portraitFootprint(1, 12, shape);
  check('a square portrait on it: as many seats across as the cards\' shape needs, 12 rows tall', Math.abs(foot.seats - Math.round(12 / shape.cell)) <= 1 && foot.height === 96, JSON.stringify(foot));
  check('…and never wider than the stand', portraitFootprint(40, 12, shape).seats === shape.seats);
  // The TV gantry's view of that stand: the yardstick a face banner is sized to.
  {
    const frames = spanFrameCache(map);
    const tv = tvShot(frames, 3)!;
    const mid = frames(3, 1).pointAt(0.5, 0.5);
    const d = tv.distanceTo(mid);
    check('TV gantry: across the pitch from the south stand, above its top', !!tv && Math.sign(tv.position[2]) === -Math.sign(mid.z) && tv.position[1] > frames(3, 1).maxY, JSON.stringify(tv?.position));
    check('…zoomed so the stand\'s width fills a 16:9 picture (a lens between 12 and 46 degrees)', tv.fov >= 12 && tv.fov <= 46 && Math.abs(tv.frameHeightAt(d) * 16 / 9 - frames(3, 1).widthM) < frames(3, 1).widthM * 0.02, `${tv.fov.toFixed(1)} deg, ${tv.frameHeightAt(d).toFixed(1)} m tall at ${d.toFixed(0)} m`);
    check('…and the picture is taller further away', tv.frameHeightAt(2 * d) > 1.99 * tv.frameHeightAt(d));
  }
  check('the stand\'s widest picture shape', Math.abs(pictureAspectFor(shape.seats, 12, shape.cell) - (shape.seats * shape.cell) / 12) < 1e-9);
  // The object drawn one cell per seat once its seats are known.
  const o = { id: 'i1', kind: 'image', cx: rect.cx, cy: rect.cy, width: foot.width, height: foot.height, rotation: 0, colorIndex: 0, tier: null, bitmap: null, name: 'p', dither: false, alphaThreshold: 128, style: 'stencil', seat: { pitch: shape.pitch, cell: shape.cell } } as ImageObject;
  const gs = gridSize(o);
  check('a styled picture is drawn one cell per seat', Math.abs(gs.cols - foot.seats) <= 1 && gs.rows === 12, JSON.stringify(gs));
  check('…an unstyled one the old way', gridSize({ ...o, style: undefined }).cols === Math.round(foot.width / 3));
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
  check('a saved halftone comes back as a stencil', objectFromJSON({ ...j, style: 'halftone' }, fonts, 5)?.kind === 'image' && (objectFromJSON({ ...j, style: 'halftone' }, fonts, 5) as ImageObject).style === 'stencil');
  // The face, the rank and the seats: saved, restored, part of the key, junk refused.
  const pic = face();
  const full: ImageObject = { ...styled, face: pic.face, seat: { pitch: 3.71, cell: 0.55 } };
  check('the face and the seats are part of what re-draws a styled picture', gridKeyFor(full) !== gridKeyFor(styled) && gridKeyFor({ ...full, seat: { pitch: 3.71, cell: 0.6 } }) !== gridKeyFor(full));
  const fj = JSON.parse(JSON.stringify(objectToJSON(full)));
  const fb = objectFromJSON(fj, fonts, 5) as ImageObject;
  check('the face and the seats are saved and restored', isFaceInfo(fb.face) && fb.face!.pts.length === 136 && fb.seat?.pitch === 3.71 && fb.seat?.cell === 0.55);
  check('…a junk face or seat is dropped, the picture kept', (() => {
    const r = objectFromJSON({ ...fj, face: { box: [0, 0, 1, 1], pts: ['x'] }, seat: { pitch: -1, cell: 'a' } }, fonts, 5) as ImageObject;
    return r?.kind === 'image' && !r.face && !r.seat && r.style === 'stencil';
  })());
  const ranked: ImageObject = { ...base, tones: 'rank' };
  check('rank is saved, restored and part of the key', objectFromJSON(JSON.parse(JSON.stringify(objectToJSON(ranked))), fonts, 5)?.kind === 'image' && (objectFromJSON(objectToJSON(ranked), fonts, 5) as ImageObject).tones === 'rank' && gridKeyFor(ranked) !== gridKeyFor(base));
  check('…anything else is not', !('tones' in (objectFromJSON({ ...objectToJSON(base), tones: 'nearest' }, fonts, 5) as ImageObject)));
}

console.log(`  time per style, all ${pictures.length} pictures x ${Object.keys(PALETTES).length} palettes: ${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ')}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
