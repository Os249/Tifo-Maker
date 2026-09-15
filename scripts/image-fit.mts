/**
 * Wall 2 + 3 measurement: how much of its stand does an AI hero actually fill?
 *   npx tsx scripts/image-fit.mts
 *
 * The complaint was that AI portraits came out small. This measures it against
 * the REAL seat map, for the old sizing (height-driven with a shrink-only width
 * clamp, fed a hard-coded 768x768 image) and the new one (contain/cover fit, fed
 * an image generated at the region's own aspect).
 */
import { generateSeatMap } from '../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../src/core/template';
import { regionRect } from '../src/core/specCompiler';
import { narrowToSingleStand, regionAspectHint, type Region } from '../src/core/tifoSpec';
import { pollinationsSize, mosaicStyle } from '../server/src/imageAssets';

const map = generateSeatMap(DEFAULT_TEMPLATE);

/** Exactly the sizing that shipped before this change. */
function oldFit(rect: { width: number; height: number }, bw: number, bh: number, scaleFrac: number) {
  const aspect = bw / bh || 1;
  let h = scaleFrac * rect.height;
  let w = h * aspect;
  const maxW = rect.width * 0.98;
  if (w > maxW) { w = maxW; h = w / aspect; }
  return { w, h };
}

/** Exactly the sizing in aiPanel.ts now. */
function newFit(rect: { width: number; height: number }, bw: number, bh: number, scaleFrac: number, fit: 'cover' | 'contain') {
  const sx = rect.width / bw;
  const sy = rect.height / bh;
  const s = (fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy)) * scaleFrac;
  return { w: bw * s, h: bh * s };
}

const cases: Array<[string, Region]> = [
  ['north stand, both tiers', { stand: 'north', tier: 'all' }],
  ['north stand, lower tier', { stand: 'north', tier: 0 }],
  ['east stand (bowl seam)', { stand: 'east', tier: 'all' }],
  ['north+west mural', { stand: 'all', tier: 'all', stands: ['north', 'west'] }],
  ['back half of south', { stand: 'south', tier: 'all', rows: [0.5, 1] }],
];

console.log('region                      rect (w x h)   hint   asked for    OLD fill   NEW fill');
for (const [name, raw] of cases) {
  const region = narrowToSingleStand(raw);
  const rect = regionRect(region, map);
  const hint = regionAspectHint(region);
  const asked = pollinationsSize(hint);

  // OLD: the generator always returned 768x768, whatever the region looked like.
  const o = oldFit(rect, 768, 768, 1);
  // NEW: the generator is asked for the region's shape, and cover fills it.
  const n = newFit(rect, asked.width, asked.height, 1, 'cover');

  const pct = (a: { w: number; h: number }): string =>
    `${((Math.min(a.w, rect.width) * Math.min(a.h, rect.height)) / (rect.width * rect.height) * 100).toFixed(0)}%`;
  console.log(
    `${name.padEnd(26)} ${`${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`.padEnd(14)}` +
    ` ${hint.toFixed(2).padEnd(6)} ${`${asked.width}x${asked.height}`.padEnd(12)} ${pct(o).padStart(8)}   ${pct(n).padStart(8)}`,
  );
}

// A contained picture must never exceed its region; a covering one must reach both edges.
const r = regionRect({ stand: 'north', tier: 'all' }, map);
const c = newFit(r, 1536, 640, 1, 'contain');
const v = newFit(r, 1536, 640, 1, 'cover');
console.log(`\ncontain stays inside : ${(c.w <= r.width + 1e-6 && c.h <= r.height + 1e-6)}`);
console.log(`cover reaches both   : ${(v.w >= r.width - 1e-6 && v.h >= r.height - 1e-6)}`);
console.log(`scaleFrac scales     : ${Math.abs(newFit(r, 1536, 640, 0.5, 'cover').w - v.w / 2) < 1e-6}`);

console.log('\n--- what the generator is now told (north stand, club palette) ---');
console.log(mosaicStyle({ aspect: regionAspectHint({ stand: 'north', tier: 'all' }), palette: ['#262a33', '#0a3a8b', '#ffffff', '#d4af37', '#101820', '#4a6fb5'] }));
