import type { SeatGrain, SeatMap, SeatPaint, SeatRegion, StadiumTemplate } from '../../core/types';
import { alongOf, seatSide } from '../../core/standSpans';

/**
 * What a ground's empty seats look like (StadiumTemplate.seatLook): the
 * club's colour, a mosaic of two or three, a block in another colour, and the
 * letters some grounds pick out in their seats. Worked out once per ground,
 * as an index into a small list of colours, so recolouring a seat is a lookup.
 */
export interface SeatLookMap {
  /** The distinct colours, as hex strings. */
  colors: string[];
  /** Per seat: index into `colors`. */
  index: Uint16Array;
}

function hash(i: number): number {
  return (Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 0) / 4294967296;
}

function pick(paint: SeatPaint, i: number): string {
  if (paint.length === 1) return typeof paint[0] === 'string' ? paint[0] : paint[0].c;
  let total = 0;
  for (const p of paint) total += typeof p === 'string' ? 1 : p.w;
  let r = hash(i) * total;
  for (const p of paint) {
    r -= typeof p === 'string' ? 1 : p.w;
    if (r <= 0) return typeof p === 'string' ? p : p.c;
  }
  const last = paint[paint.length - 1];
  return typeof last === 'string' ? last : last.c;
}

/** Is perimeter position u within half-width h of c, round the seam? */
function nearU(u: number, c: number, h: number): boolean {
  let d = Math.abs(u - c);
  if (d > 0.5) d = 1 - d;
  return d <= h;
}

export function seatLookMap(template: StadiumTemplate, map: SeatMap): SeatLookMap | null {
  const look = template.seatLook;
  if (!look) return null;
  const before: number[] = [];
  let acc = 0;
  for (const t of template.tiers) {
    before.push(acc);
    acc += t.rows;
  }
  const colors: string[] = [];
  const slot = new Map<string, number>();
  const idOf = (hex: string): number => {
    let k = slot.get(hex);
    if (k === undefined) {
      k = colors.length;
      colors.push(hex);
      slot.set(hex, k);
    }
    return k;
  };
  const index = new Uint16Array(map.count);
  const regionHit = (r: SeatRegion, i: number, tier: number, row: number): boolean => {
    if (r.tiers && !r.tiers.includes(tier)) return false;
    if (r.rows && (row < r.rows[0] || row > r.rows[1])) return false;
    if (r.centerU !== undefined && !nearU(map.uv[i * 2], r.centerU, r.halfU ?? 0)) return false;
    if (r.side) {
      const t = template.tiers[tier];
      const radial = t.baseOffset + row * t.rowDepth;
      const x = map.pos3[i * 3];
      const z = map.pos3[i * 3 + 2];
      if (seatSide(template, tier, radial, x, z) !== r.side) return false;
      const a = alongOf(r.side, x, z);
      if (a < (r.from ?? -1e9) || a > (r.to ?? 1e9)) return false;
    }
    return true;
  };
  // A clump: the cell of a grid laid over the plan, a few metres by a few rows.
  const clump = (g: SeatGrain | undefined, i: number, tier: number, row: number): number => {
    if (!g) return i;
    const gx = Math.floor(map.pos3[i * 3] / g.along);
    const gz = Math.floor(map.pos3[i * 3 + 2] / g.along);
    const gr = Math.floor(row / Math.max(1, g.rows));
    return (Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663) ^ Math.imul(gr * 8 + tier, 83492791)) >>> 0;
  };
  for (let i = 0; i < map.count; i++) {
    const tier = map.tierOf[i];
    const row = map.rowOf[i] - before[tier];
    const reg = look.regions?.find((r) => regionHit(r, i, tier, row));
    if (reg?.alternate) {
      const c = reg.colors[map.sectionOf[i] % reg.colors.length];
      index[i] = idOf(typeof c === 'string' ? c : c.c);
    } else if (reg) index[i] = idOf(pick(reg.colors, clump(reg.grain, i, tier, row)));
    else index[i] = idOf(pick(look.colors, clump(look.grain, i, tier, row)));
  }
  // Letters in the seats: drawn on a canvas the shape of the block, in metres,
  // and read back at each seat's place in it.
  if (look.text?.length && typeof document !== 'undefined') {
    for (const tx of look.text) {
      const t = template.tiers[tx.tier];
      if (!t) continue;
      const rows = tx.rows[1] - tx.rows[0] + 1;
      // How long the block is, measured on its middle row.
      let minU = Infinity;
      let maxU = -Infinity;
      const members: number[] = [];
      for (let i = 0; i < map.count; i++) {
        if (map.tierOf[i] !== tx.tier) continue;
        const row = map.rowOf[i] - before[tx.tier];
        if (row < tx.rows[0] || row > tx.rows[1]) continue;
        const u = map.uv[i * 2];
        if (!nearU(u, tx.centerU, tx.halfU)) continue;
        let du = u - tx.centerU;
        if (du > 0.5) du -= 1;
        if (du < -0.5) du += 1;
        minU = Math.min(minU, du);
        maxU = Math.max(maxU, du);
        members.push(i);
      }
      if (!members.length) continue;
      // Physical size: seats are seatPitch apart along a row; a raked row reads
      // about rowDepth / cos(rake) tall.
      const perU = (2 * tx.halfU) / Math.max(1e-6, maxU - minU);
      void perU;
      const rowH = t.rowDepth / Math.cos((t.rakeDeg * Math.PI) / 180);
      // Seats along the middle row of the block.
      const midRow = Math.round((tx.rows[0] + tx.rows[1]) / 2);
      const across = members.filter((i) => map.rowOf[i] - before[tx.tier] === midRow).length;
      const Wm = Math.max(1, across * t.seatPitch);
      const Hm = rows * rowH;
      const PX = 8; // pixels a metre
      const cv = document.createElement('canvas');
      cv.width = Math.max(8, Math.round(Wm * PX));
      cv.height = Math.max(8, Math.round(Hm * PX));
      // Read back below: a CPU canvas, so the read does not wait on the GPU.
      const g = cv.getContext('2d', { willReadFrequently: true });
      if (!g) continue;
      g.fillStyle = '#000';
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const size = cv.height * 0.8;
      g.font = tx.font ? tx.font.replace('{px}', String(Math.round(size))) : `900 ${Math.round(size)}px Arial, sans-serif`;
      // Squeeze it to fit the width if it is too long.
      const w = g.measureText(tx.text).width;
      const sx = Math.min(1, (cv.width * 0.94) / Math.max(1, w));
      if (tx.shape === 'heart') {
        // Two lobes and a point, filling the block's height.
        const H = cv.height * 0.92;
        const Wd = Math.min(cv.width * 0.96, H * 1.15);
        const x0 = (cv.width - Wd) / 2;
        const y0 = (cv.height - H) / 2;
        g.beginPath();
        g.moveTo(x0 + Wd / 2, y0 + H);
        g.bezierCurveTo(x0 - Wd * 0.05, y0 + H * 0.55, x0 + Wd * 0.02, y0 - H * 0.05, x0 + Wd * 0.27, y0 + H * 0.02);
        g.bezierCurveTo(x0 + Wd * 0.42, y0 + H * 0.06, x0 + Wd / 2, y0 + H * 0.2, x0 + Wd / 2, y0 + H * 0.24);
        g.bezierCurveTo(x0 + Wd / 2, y0 + H * 0.2, x0 + Wd * 0.58, y0 + H * 0.06, x0 + Wd * 0.73, y0 + H * 0.02);
        g.bezierCurveTo(x0 + Wd * 0.98, y0 - H * 0.05, x0 + Wd * 1.05, y0 + H * 0.55, x0 + Wd / 2, y0 + H);
        g.fill();
      } else {
        g.save();
        g.translate(cv.width / 2, cv.height / 2);
        g.scale(sx * (tx.mirror ? -1 : 1), 1);
        g.fillText(tx.text, 0, cv.height * 0.03);
        g.restore();
      }
      const data = g.getImageData(0, 0, cv.width, cv.height).data;
      const fg = idOf(tx.color);
      const bg = tx.ground ? idOf(tx.ground) : -1;
      for (const i of members) {
        let du = map.uv[i * 2] - tx.centerU;
        if (du > 0.5) du -= 1;
        if (du < -0.5) du += 1;
        // Seats count along u from the left as you look at the stand from the pitch.
        // u runs anticlockwise seen from above, which is left-to-right seen from the pitch.
        const fx = (du - minU) / Math.max(1e-6, maxU - minU);
        const row = map.rowOf[i] - before[tx.tier];
        const fy = 1 - (row - tx.rows[0] + 0.5) / rows; // the back row is the top of the letters
        const px = Math.min(cv.width - 1, Math.max(0, Math.round(fx * (cv.width - 1))));
        const py = Math.min(cv.height - 1, Math.max(0, Math.round(fy * (cv.height - 1))));
        const on = data[(py * cv.width + px) * 4] > 127;
        if (on) index[i] = fg;
        else if (bg >= 0) index[i] = bg;
      }
    }
  }
  return { colors, index };
}
