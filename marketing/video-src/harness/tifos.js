/**
 * Showcase tifos for the marketing videos: designs drawn here, then laid on
 * one stand's seats the way scripts/pro-shots-tifo.js lays its test tifo, and
 * rendered by the site's real Match Day, film and poster code.
 *
 * A design is a picture (canvas) in a few flat colours; each seat takes the
 * palette colour nearest to the picture under it.
 */
import { loadTifoFonts, loadProFonts } from '/src/core/tifoFonts.ts';
import { fontCssOf } from '/src/core/text.ts';
import { PRO_FONTS } from '/src/core/proVoices.ts';

const W = 960, H = 400;
const EMPTY = '#1a1d24';

const star = (g, cx, cy, r, fill) => {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.42 : r;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
};
const rays = (g, cx, cy, n, a, b) => {
  g.fillStyle = a;
  g.fillRect(0, 0, W, H);
  g.fillStyle = b;
  for (let i = 0; i < n; i += 2) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a0) * 2000, cy + Math.sin(a0) * 2000);
    g.lineTo(cx + Math.cos(a1) * 2000, cy + Math.sin(a1) * 2000);
    g.closePath();
    g.fill();
  }
};
const shield = (g, cx, cy, w, h, fill, line, lw) => {
  g.beginPath();
  g.moveTo(cx - w / 2, cy - h / 2);
  g.lineTo(cx + w / 2, cy - h / 2);
  g.lineTo(cx + w / 2, cy + h * 0.08);
  g.quadraticCurveTo(cx + w / 2, cy + h * 0.38, cx, cy + h / 2);
  g.quadraticCurveTo(cx - w / 2, cy + h * 0.38, cx - w / 2, cy + h * 0.08);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = line;
  g.stroke();
};
/** A word, fitted to a box, with a thick outline so it reads off the seats. */
const word = (g, text, font, cx, cy, maxW, maxH, fill, line, lw, stretch = 1) => {
  if (stretch !== 1) {
    g.save(); g.translate(cx, cy); g.scale(stretch, 1);
    word(g, text, font, 0, 0, maxW / stretch, maxH, fill, line, lw);
    g.restore();
    return;
  }
  let px = maxH;
  g.font = `${px}px ${font}`;
  const m = g.measureText(text).width;
  if (m > maxW) px = Math.floor((px * maxW) / m);
  g.font = `${px}px ${font}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  if (lw) { g.lineWidth = lw; g.strokeStyle = line; g.strokeText(text, cx, cy); }
  g.fillStyle = fill;
  g.fillText(text, cx, cy);
};
const band = (g, y, h, c) => { g.fillStyle = c; g.fillRect(0, y, W, h); };

export const DESIGNS = {
  /** Yellow and black: a sunburst, a crest with a star and the year, a word each side. */
  ittihad: {
    palette: [EMPTY, '#101010', '#f9d71c', '#f4f2ea', '#c99a06'],
    draw(g, f) {
      rays(g, W / 2, H * 0.56, 28, '#101010', '#f9d71c');
      band(g, 0, 26, '#101010'); band(g, 26, 12, '#f4f2ea');
      band(g, H - 26, 26, '#101010'); band(g, H - 38, 12, '#f4f2ea');
      // Dark plates behind the words, so the rays do not cut the letters.
      g.fillStyle = '#101010';
      g.fillRect(40, 110, 300, 190); g.fillRect(W - 340, 110, 300, 190);
      g.strokeStyle = '#f9d71c'; g.lineWidth = 10;
      g.strokeRect(40, 110, 300, 190); g.strokeRect(W - 340, 110, 300, 190);
      word(g, 'الاتحاد', f.block, W - 190, 205, 260, 170, '#f9d71c', '#101010', 0);
      word(g, 'قوة', f.block, 190, 205, 260, 170, '#f4f2ea', '#101010', 0);
      shield(g, W / 2, H * 0.5, 230, 320, '#101010', '#f4f2ea', 16);
      shield(g, W / 2, H * 0.5, 180, 262, '#f9d71c', '#101010', 0);
      star(g, W / 2, H * 0.36, 66, '#101010');
      word(g, '1927', f.latin, W / 2, H * 0.66, 150, 78, '#101010', '#101010', 0);
    },
  },
  /** Green and white: a wide sash, the word across it. */
  ahli: {
    palette: [EMPTY, '#0c6b3a', '#f4f2ea', '#0a3d22', '#d8b24a'],
    draw(g, f) {
      band(g, 0, H, '#0c6b3a');
      for (let i = -6; i < 16; i += 2) {
        g.fillStyle = '#0a3d22';
        g.beginPath();
        g.moveTo(i * 90, H); g.lineTo(i * 90 + 90, H); g.lineTo(i * 90 + 90 + 260, 0); g.lineTo(i * 90 + 260, 0);
        g.closePath(); g.fill();
      }
      band(g, 0, 22, '#d8b24a'); band(g, H - 22, 22, '#d8b24a');
      band(g, 96, 208, '#f4f2ea');
      band(g, 96, 12, '#d8b24a'); band(g, 292, 12, '#d8b24a');
      word(g, 'الراقي', f.block, W * 0.6, 204, 520, 190, '#0c6b3a', '#f4f2ea', 0);
      star(g, 150, 200, 78, '#d8b24a');
      word(g, '1937', f.latin, 320, 204, 170, 96, '#0a3d22', '#f4f2ea', 0);
    },
  },
  /** Yellow and blue: rays, the word big in a Pro face, blue bands above and below. */
  nassr: {
    palette: [EMPTY, '#0b3aa0', '#f9d21a', '#f4f2ea', '#e2a900'],
    draw(g, f) {
      rays(g, W / 2, H * 0.5, 40, '#f9d21a', '#e2a900');
      band(g, 0, 70, '#0b3aa0'); band(g, 70, 16, '#f4f2ea');
      band(g, H - 80, 80, '#0b3aa0'); band(g, H - 96, 16, '#f4f2ea');
      word(g, 'العالمي', f.block, W / 2, 196, 800, 240, '#0b3aa0', '#f4f2ea', 18);
    },
  },
  /** Red and white on a kop: an English chant in the Latin Pro face. */
  kop: {
    palette: [EMPTY, '#c8102e', '#f4f2ea', '#7d0a1c', '#f6c945'],
    draw(g, f) {
      rays(g, W / 2, H * 1.05, 34, '#c8102e', '#7d0a1c');
      band(g, H - 30, 30, '#f6c945');
      word(g, 'ALLEZ', f.block, W / 2, 250, 820, 250, '#f4f2ea', '#7d0a1c', 18);
    },
  },
  /** Blue and white: the word alone, in the stencil Pro face. */
  hilal: {
    palette: [EMPTY, '#0b4ea2', '#f4f2ea', '#06265a', '#7fb3ea'],
    draw(g, f) {
      rays(g, W / 2, H * 1.2, 36, '#0b4ea2', '#06265a');
      band(g, 0, 24, '#f4f2ea'); band(g, H - 24, 24, '#f4f2ea');
      word(g, 'الزعيم', f.stencil, W / 2, 200, 800, 260, '#f4f2ea', '#06265a', 22);
    },
  },
  /**
   * For King Abdullah Sports City's end stands, which have three tiers with
   * ribbon boards between them: stripes on the upper tier (canvas y 0-95), the
   * year on the middle one (105-210), the word on the lower one (220-400).
   */
  amid: {
    palette: [EMPTY, '#101010', '#f9d71c', '#f4f2ea', '#c99a06'],
    draw(g, f) {
      band(g, 0, H, '#101010');
      // Upper tier: tiger stripes.
      for (let i = -4; i < 30; i++) {
        g.fillStyle = '#f9d71c';
        g.beginPath();
        g.moveTo(i * 64, 0); g.lineTo(i * 64 + 34, 0); g.lineTo(i * 64 + 34 - 46, 100); g.lineTo(i * 64 - 46, 100);
        g.closePath(); g.fill();
      }
      // Middle tier: the year between stars, on yellow.
      band(g, 100, 115, '#f9d71c');
      word(g, '1927', f.block, W / 2, 162, 260, 104, '#101010', '#101010', 0);
      for (const x of [150, 290, W - 290, W - 150]) star(g, x, 158, 40, '#101010');
      // Lower tier: the word.
      band(g, 215, 185, '#101010');
      band(g, 215, 12, '#f4f2ea'); band(g, H - 14, 14, '#f9d71c');
      word(g, 'العميد', f.block, W / 2, 312, 860, 190, '#f9d71c', '#101010', 0, 1.3);
    },
  },
  raqi: {
    palette: [EMPTY, '#0c6b3a', '#f4f2ea', '#0a3d22', '#d8b24a'],
    draw(g, f) {
      band(g, 0, H, '#0c6b3a');
      for (let x = 0; x < W; x += 96) { g.fillStyle = '#f4f2ea'; g.fillRect(x, 0, 48, 100); }
      band(g, 100, 115, '#f4f2ea');
      word(g, '1937', f.block, W / 2, 162, 260, 104, '#0c6b3a', '#0c6b3a', 0);
      for (const x of [150, 290, W - 290, W - 150]) star(g, x, 158, 40, '#d8b24a');
      band(g, 215, 185, '#0c6b3a');
      band(g, 215, 12, '#d8b24a'); band(g, H - 14, 14, '#d8b24a');
      word(g, 'الراقي', f.block, W / 2, 312, 860, 190, '#f4f2ea', '#0a3d22', 0, 1.3);
    },
  },
  /** A steep single-tier kop: one word, kept well inside the stand. */
  ynwa: {
    palette: [EMPTY, '#c8102e', '#f4f2ea', '#7d0a1c', '#f6c945'],
    draw(g, f) {
      rays(g, W / 2, H * 0.55, 36, '#c8102e', '#7d0a1c');
      band(g, 0, 24, '#f6c945'); band(g, H - 24, 24, '#f6c945');
      word(g, 'YNWA', f.block, W / 2, 205, 560, 190, '#f4f2ea', '#7d0a1c', 14);
    },
  },
};

let canvas = null;
/** The cells of a published tifo, when one is being filmed. */
let community = null;
/** Draw a design once the fonts are in; call before the harness's __boot. */
export async function useDesign(name) {
  // A tifo published on the site (run.mts puts its palette and cells on the window): filmed as it is.
  if (name.startsWith('community:')) {
    const c = window.__community;
    window.__tifoPalette = c.palette;
    const bin = atob(c.cellsB64);
    community = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return { palette: c.palette, png: '' };
  }
  community = null;
  await Promise.all([loadTifoFonts(), loadProFonts()]);
  const f = {
    block: fontCssOf('block', PRO_FONTS), stencil: fontCssOf('stencil', PRO_FONTS), latin: fontCssOf('block', PRO_FONTS),
  };
  await Promise.all(Object.values(f).map((font) => document.fonts.load(`80px ${font}`, 'الاتحاد 1927')));
  const d = DESIGNS[name];
  canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  d.draw(g, f);
  window.__tifoPalette = d.palette;
  return { palette: d.palette, png: canvas.toDataURL('image/png') };
}

const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export function paintTifo(map, stand, size) {
  if (community) return community.length === map.count ? community : Uint8Array.from({ length: map.count }, (_, i) => community[i] ?? 0);
  const span = size === 'small' ? [0.34, 0.66] : size === 'medium' ? [0.17, 0.83] : [0.02, 0.98];
  const px = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const pal = window.__tifoPalette.map(rgb);
  const where = (i) => {
    const x = map.pos3[i * 3];
    const z = map.pos3[i * 3 + 2];
    if (Math.abs(x) > 54 && Math.abs(z) < 38) return stand === 0 && x > 0 ? z : stand === 2 && x < 0 ? -z : null;
    if (Math.abs(z) > 35 && Math.abs(x) < 52) return stand === 1 && z > 0 ? -x : stand === 3 && z < 0 ? x : null;
    return null;
  };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < map.count; i++) {
    const a = where(i);
    if (a === null) continue;
    lo = Math.min(lo, a); hi = Math.max(hi, a);
  }
  const cells = new Uint8Array(map.count);
  for (let i = 0; i < map.count; i++) {
    const a = where(i);
    if (a === null) continue;
    const across = (a - lo) / (hi - lo);
    if (across < span[0] || across > span[1]) continue;
    const x = (across - span[0]) / (span[1] - span[0]);
    const y = 1 - map.uv[i * 2 + 1];
    const o = (Math.min(H - 1, Math.floor(y * H)) * W + Math.min(W - 1, Math.floor(x * W))) * 4;
    let best = 1, bd = Infinity;
    for (let c = 1; c < pal.length; c++) {
      const d = (px[o] - pal[c][0]) ** 2 + (px[o + 1] - pal[c][1]) ** 2 + (px[o + 2] - pal[c][2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    cells[i] = best;
  }
  return cells;
}
