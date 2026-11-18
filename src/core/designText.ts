/**
 * The design in hand, as a few hundred words: what AI Critique is sent.
 *
 * A review costs what it reads, so the critic is not sent the seats. It is
 * sent this (the project's name, the ground, the palette with each colour's
 * share, every layer with what it says and where it sits, how full each stand
 * is) and one small picture. The facts a model is bad at reading off a picture
 * are measured here and written down: the contrast between words and what is
 * behind them, how much of a layer hangs outside its stand, which colours are
 * too close to tell apart. The critic's job is then to judge and to word, not
 * to measure.
 *
 * No DOM: it runs on the store and the layer stack as they are.
 */
import type { DesignStore } from './design';
import type { ObjectLayer, TifoObject } from './objects';
import { isProVoice } from './proVoices';
import { EDITOR_UNITS } from './seatmap';
import { regionPredicate, regionRect } from './specCompiler';
import { contrastRatio } from './specRefine';
import { buildStadiumContext, describeStadiumContext } from './stadiumContext';
import { STANDS, STAND_GEOMETRY, type Stand } from './tifoSpec';
import type { SeatMap } from './types';

export interface DesignTextInput {
  store: DesignStore;
  objects: ObjectLayer;
  map: SeatMap;
  /** The project's name as the person typed it; empty when it has none. */
  title?: string;
  /** The ground's name. */
  stadium?: string;
}

const W = EDITOR_UNITS.width;
const pct = (n: number): string => `${Math.round(n * 100)}%`;
/** One line of the person's own words, safe to put inside quotes. */
const quote = (s: string, max: number): string => s.replace(/["\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** How far two colours are apart, 0 to about 441. Under 24, a fan across the ground sees one colour. */
export function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}
export const SAME_COLOUR_DISTANCE = 24;

/** The stand an x on the unrolled bowl belongs to. */
function standOf(x: number): Stand {
  const u = (((x / W) % 1) + 1) % 1;
  return (['east', 'north', 'west', 'south'] as const)[Math.floor(((u + 0.125) % 1) * 4) % 4];
}

/** How much of a layer's width lies outside the quarter of the bowl its centre is in, 0 to 1. */
function outsideStand(o: TifoObject, stand: Stand): number {
  const centre = STAND_GEOMETRY[stand].centerU * W;
  const half = STAND_GEOMETRY[stand].halfU * W;
  // The layer's centre measured from the stand's, by the short way round the bowl.
  const dx = ((((o.cx - centre) % W) + W + W / 2) % W) - W / 2;
  const left = dx - o.width / 2;
  const right = dx + o.width / 2;
  const inside = Math.max(0, Math.min(right, half) - Math.max(left, -half));
  return o.width > 0 ? Math.max(0, 1 - inside / o.width) : 0;
}

/** The text of a design and how many seats it found painted. */
export function describeDesign(input: DesignTextInput): { text: string; painted: number; layers: number } {
  const { store, objects, map } = input;
  const palette = store.palette;
  const lines: string[] = [];
  const title = quote(input.title ?? '', 80);
  if (title) lines.push(`project: "${title}"`);
  const ground = describeStadiumContext(buildStadiumContext(map)).replace(/\s+/g, ' ').trim().slice(0, 900);
  lines.push(`stadium: ${input.stadium ? `${quote(input.stadium, 80)}. ` : ''}${ground}`);

  // Seats by colour, over the whole bowl and per stand (what is showing, layers included).
  const inStand = STANDS.map((s) => regionPredicate({ stand: s, tier: 'all' }, map));
  const total = new Uint32Array(256);
  const byStand = STANDS.map(() => new Uint32Array(256));
  const seatsIn = STANDS.map(() => 0);
  for (let i = 0; i < map.count; i++) {
    const v = store.cells[i];
    total[v]++;
    for (let s = 0; s < STANDS.length; s++) {
      if (inStand[s](i)) { byStand[s][v]++; seatsIn[s]++; break; }
    }
  }
  const painted = map.count - total[0];
  const share = (n: number): string => (painted ? pct(n / painted) : '0%');
  lines.push(`palette: ${palette.map((hex, i) => (i === 0 ? `0 ${hex} unpainted` : `${i} ${hex} ${total[i] ? `${share(total[i])} of painted seats` : 'unused'}`)).join(' | ')}`);

  // The Paint layer's colour most seats under a box show: what a layer sits on.
  const behind = (o: TifoObject): number => {
    const counts = new Uint32Array(256);
    const half = o.width / 2;
    for (let i = 0; i < map.count; i++) {
      const y = map.xy[i * 2 + 1];
      if (Math.abs(y - o.cy) > o.height / 2) continue;
      const dx = ((((map.xy[i * 2] - o.cx) % W) + W + W / 2) % W) - W / 2;
      if (Math.abs(dx) <= half) counts[store.base[i]]++;
    }
    let best = 0;
    for (let k = 1; k < 256; k++) if (counts[k] > counts[best]) best = k;
    return best;
  };

  const list = [...objects.list()].filter((o) => !o.hidden).reverse();
  if (list.length === 0) {
    lines.push('layers: none. Everything is painted straight onto the seats, so only colour fixes (paint.replaceColor, palette.merge) can be applied.');
  } else {
    lines.push('layers (front first):');
    for (const o of list) {
      const stand = o.keep && o.keep.stand !== 'all' ? (o.keep.stand as Stand) : standOf(o.cx);
      const box = regionRect({ stand, tier: 'all' }, map);
      const up = box.height > 0 ? Math.max(0, Math.min(1, (o.cy - (box.cy - box.height / 2)) / box.height)) : 0.5;
      const out = outsideStand(o, stand);
      const where = `stand=${stand} top-to-bottom=${pct(up)}${out > 0.02 ? ` outside-its-stand=${pct(out)}` : ''}${o.locked ? ' locked' : ''}`;
      const widthSeats = Math.round(o.width / EDITOR_UNITS.colPx);
      const rows = Math.round(o.height / EDITOR_UNITS.rowPx);
      if (o.kind === 'text') {
        const under = behind(o);
        const on = palette[under] ?? palette[0];
        const ratio = contrastRatio(palette[o.colorIndex] ?? '#ffffff', on).toFixed(1);
        const outline = o.outline && !isProVoice(o.fontId) ? `${o.outline.seats} seats in colour ${o.outline.colorIndex}` : isProVoice(o.fontId) ? 'none (this font takes no outline)' : 'none';
        lines.push(`  ${o.id} text "${quote(o.text, 120)}" font=${o.fontId} rows=${Math.round(o.heightSeats)} ${where} color=${o.colorIndex} behind=${under} contrast=${ratio}:1 outline=${outline}`);
      } else if (o.kind === 'image') {
        lines.push(`  ${o.id} image "${quote(o.label || o.name || 'picture', 60)}" ${widthSeats} x ${rows} seats ${where}`);
      } else if (o.kind === 'shape') {
        const under = behind(o);
        lines.push(`  ${o.id} shape ${quote(o.shape, 30)} ${widthSeats} x ${rows} seats ${where} color=${o.colorIndex} behind=${under} contrast=${contrastRatio(palette[o.colorIndex] ?? '#ffffff', palette[under] ?? palette[0]).toFixed(1)}:1`);
      } else {
        lines.push(`  ${o.id} moved area ${widthSeats} x ${rows} seats ${where}`);
      }
    }
  }

  const fills = STANDS.map((s, k) => {
    if (!seatsIn[k]) return `${s} has no seats`;
    const filled = seatsIn[k] - byStand[k][0];
    if (!filled) return `${s} empty`;
    const top = [...byStand[k].entries()].filter(([c, n]) => c > 0 && n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} ${pct(n / filled)}`);
    return `${s} ${pct(filled / seatsIn[k])} filled (colours ${top.join(', ')})`;
  });
  lines.push(`seats: ${fills.join('; ')}`);

  // Colours in use that a fan could not tell apart.
  const close: string[] = [];
  for (let a = 1; a < palette.length; a++) {
    if (!total[a]) continue;
    for (let b = a + 1; b < palette.length; b++) {
      if (total[b] && colourDistance(palette[a], palette[b]) < SAME_COLOUR_DISTANCE) close.push(`${a} and ${b}`);
    }
  }
  if (close.length) lines.push(`measured: colours ${close.slice(0, 6).join(', ')} are too close to tell apart from across the ground.`);
  if (!painted) lines.push('measured: nothing is painted yet.');

  return { text: lines.join('\n'), painted, layers: list.length };
}
