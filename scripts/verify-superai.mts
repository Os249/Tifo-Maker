/**
 * Phase 1 + 2 (Super AI) verification - runs against the REAL seat map.
 *   npm run verify:superai      (or: npx tsx scripts/verify-superai.mts)
 * Throws on any failed invariant; prints a summary otherwise.
 */
import { generateSeatMap } from '../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../src/core/template';
import { buildStadiumContext, describeStadiumContext } from '../src/core/stadiumContext';
import { normalizeRegion, standIndexOfU, STAND_ORDER, validateSpec, narrowToSingleStand } from '../src/core/tifoSpec';
import { regionPredicate } from '../src/core/specCompiler';
import { SUPER_AI_EXEMPLARS, fewShotBlock } from '../src/core/exemplars';
import { critiqueDesign, repairSpec } from '../src/core/critique';
import { quantizePixels } from '../src/core/importImage';
import { buildDirectorPrompt } from '../server/src/aiProvider';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
  if (!cond) failures++;
}

const map = generateSeatMap(DEFAULT_TEMPLATE);
console.log('seats:', map.count);

// ---- 1. stadium context ----
const ctx = buildStadiumContext(map);
check('context total === map.count', ctx.total === map.count, `${ctx.total}`);
const sumStands = ctx.stands.reduce((a, s) => a + s.seats, 0);
check('per-stand seats sum to total', sumStands === map.count, `${sumStands} vs ${map.count}`);
const distinctTiers = new Set(map.tierOf).size;
check('tier count matches map', ctx.tiers === distinctTiers, `${ctx.tiers} vs ${distinctTiers}`);
check('four stands, perimeter order', ctx.stands.length === 4 && ctx.stands.every((s, i) => s.stand === STAND_ORDER[i]));
check('every stand non-empty with sane aspect', ctx.stands.every((s) => s.seats > 0 && s.rows > 0 && s.cols > 0 && isFinite(s.aspect)));
check('shares sum to ~1', Math.abs(ctx.stands.reduce((a, s) => a + s.share, 0) - 1) < 0.02);
const desc = describeStadiumContext(ctx);
check('describe() is multi-line and mentions seats', desc.split('\n').length >= 5 && desc.includes('seats'));
console.log('\n--- describeStadiumContext ---\n' + desc + '\n');

// ---- 2. normalizeRegion: multi-stand scaffolding ----
const sides = normalizeRegion('sides');
check('sides -> east+west', !!sides && JSON.stringify(sides.stands) === JSON.stringify(['east', 'west']) && sides.stand === 'all');
const ends = normalizeRegion('ends');
check('ends -> north+south', !!ends && JSON.stringify(ends.stands) === JSON.stringify(['north', 'south']));
const single = normalizeRegion({ stands: ['north'] });
check('single-entry stands[] collapses to single stand', !!single && single.stand === 'north' && single.stands === undefined);
const allFour = normalizeRegion({ stands: ['north', 'south', 'east', 'west'] });
check('all-four stands[] -> whole bowl (no stands)', !!allFour && allFour.stand === 'all' && allFour.stands === undefined);
const dup = normalizeRegion({ stands: ['east', 'east', 'west'] });
check('duplicate stands deduped', !!dup && JSON.stringify(dup.stands) === JSON.stringify(['east', 'west']));
check('invalid stands[] rejected', normalizeRegion({ stands: ['nope'] }) === null);
check('backward compat: plain north unchanged', JSON.stringify(normalizeRegion('north')) === JSON.stringify({ stand: 'north', tier: 'all' }));

// ---- 3. regionPredicate: coverage matches the stand buckets ----
function seatsMatching(pred: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.count; i++) if (pred(i)) out.push(i);
  return out;
}
const idx = { east: 0, north: 1, west: 2, south: 3 } as const;
const sideSeats = seatsMatching(regionPredicate(sides!, map));
const sideOk = sideSeats.every((i) => {
  const si = standIndexOfU(map.uv[i * 2]);
  return si === idx.east || si === idx.west;
});
const expectedSides = ctx.stands[idx.east].seats + ctx.stands[idx.west].seats;
check('sides predicate covers only east+west', sideOk && sideSeats.length === expectedSides, `${sideSeats.length} vs ${expectedSides}`);
const endSeats = seatsMatching(regionPredicate(ends!, map));
const expectedEnds = ctx.stands[idx.north].seats + ctx.stands[idx.south].seats;
check('ends predicate covers only north+south', endSeats.length === expectedEnds, `${endSeats.length} vs ${expectedEnds}`);
const northSeats = seatsMatching(regionPredicate(normalizeRegion('north')!, map));
check('single north predicate matches context count', northSeats.length === ctx.stands[idx.north].seats, `${northSeats.length}`);
const allSeats = seatsMatching(regionPredicate(normalizeRegion('all')!, map));
check('all predicate covers the whole bowl', allSeats.length === map.count);

// ---- 4. few-shot exemplar gallery (Phase 2) ----
for (const ex of SUPER_AI_EXEMPLARS) {
  const r = validateSpec(ex.spec);
  check(`exemplar "${ex.spec.title}" validates`, r.valid, r.valid ? '' : JSON.stringify(r.errors));
}
const fsblk = fewShotBlock();
check('fewShotBlock includes every brief', SUPER_AI_EXEMPLARS.every((e) => fsblk.includes(e.brief)));
const usesMulti = SUPER_AI_EXEMPLARS.some((e) => {
  const j = JSON.stringify(e.spec);
  return j.includes('"sides"') || j.includes('"ends"');
});
check('exemplars exercise sides/ends regions', usesMulti);

// ---- 5. director prompt (Phase 2) ----
const dp = buildDirectorPrompt();
check('director prompt offers sides/ends regions', dp.includes('"sides"') && dp.includes('"ends"'));
check('director prompt embeds the few-shot gallery', SUPER_AI_EXEMPLARS.every((e) => dp.includes(e.brief)));
check('director prompt is whole-bowl framed', dp.toLowerCase().includes('whole bowl') || dp.includes('each stand'));

// ---- 6. narrowToSingleStand: hero-image placement (Phase 3) ----
check('narrow sides -> single east stand', JSON.stringify(narrowToSingleStand(normalizeRegion('sides')!)) === JSON.stringify({ stand: 'east', tier: 'all' }));
check('narrow all -> north', narrowToSingleStand({ stand: 'all', tier: 'all' }).stand === 'north');
check('narrow single stand unchanged', JSON.stringify(narrowToSingleStand({ stand: 'south', tier: 'all' })) === JSON.stringify({ stand: 'south', tier: 'all' }));
const narrowed = narrowToSingleStand({ stand: 'all', tier: 1, rows: [0, 0.5] });
check('narrow preserves tier and rows, drops stands', narrowed.stand === 'north' && narrowed.tier === 1 && !!narrowed.rows && narrowed.stands === undefined);

// ---- 7. deterministic critique + repair (Phase 4) ----
const fillSpec = validateSpec({ palette: ['#262a33', '#c8102e'], layers: [{ kind: 'fill', region: 'all', colorIndex: 1 }] }).spec!;
const solid = new Uint8Array(map.count).fill(1);
const cSolid = critiqueDesign(solid, map, fillSpec);
check('solid fill: no fragile detail, high score', cSolid.fragileSeats === 0 && cSolid.score >= 90, `score ${cSolid.score}`);

const line = new Uint8Array(map.count);
for (let i = 0; i < map.count; i++) if (map.rowOf[i] === 10 && map.uv[i * 2] > 0.2 && map.uv[i * 2] < 0.25) line[i] = 1;
const cLine = critiqueDesign(line, map, fillSpec);
check('1-seat-tall line flagged as fragile', cLine.fragileSeats > 0 && cLine.issues.some((s) => s.includes('Fine detail')), `fragile ${cLine.fragileSeats}`);

const textSpec = validateSpec({ palette: ['#262a33', '#ffffff'], layers: [{ kind: 'text', region: 'north', text: 'HELLO', colorIndex: 1, fontId: 'impact', heightFrac: 0.3, arcDeg: 0, align: 'center' }] }).spec!;
const rep = repairSpec(textSpec, { score: 40, issues: ['x'], fragileSeats: 100, paintedSeats: 200, perStandFill: { north: 0.5, south: 0, east: 0, west: 0 } });
const before = textSpec.layers[0];
const after = rep.spec.layers[0];
check('repair enlarges fragile text', rep.changed && before.kind === 'text' && after.kind === 'text' && after.heightFrac > before.heightFrac);
const rep2 = repairSpec(textSpec, { score: 95, issues: [], fragileSeats: 5, paintedSeats: 1000, perStandFill: { north: 0.5, south: 0.5, east: 0.5, west: 0.5 } });
check('repair is a no-op when legible', rep2.changed === false);

// ---- 8. halftone quantization is more legible than dither (Phase 5) ----
{
  const gc = 30, gr = 30;
  const px = new Uint8ClampedArray(gc * gr * 4);
  for (let y = 0; y < gr; y++) for (let x = 0; x < gc; x++) { const p = y * gc + x; const t = Math.round((y / (gr - 1)) * 255); px[p * 4] = t; px[p * 4 + 1] = t; px[p * 4 + 2] = t; px[p * 4 + 3] = 255; }
  const pal = ['#262a33', '#000000', '#555555', '#aaaaaa', '#ffffff'];
  const dith = quantizePixels(px, gc, gr, pal, { dither: true, alphaThreshold: 128 });
  const half = quantizePixels(px, gc, gr, pal, { dither: false, halftone: true, halftoneCell: 3, alphaThreshold: 128 });
  const gridFragile = (g: Int16Array): number => {
    const run = (x: number, y: number, dx: number, dy: number): number => {
      const v = g[y * gc + x]; let r = 1; let xx = x - dx, yy = y - dy;
      while (xx >= 0 && yy >= 0 && xx < gc && yy < gr && g[yy * gc + xx] === v && r < 3) { r++; xx -= dx; yy -= dy; }
      xx = x + dx; yy = y + dy;
      while (xx >= 0 && yy >= 0 && xx < gc && yy < gr && g[yy * gc + xx] === v && r < 3) { r++; xx += dx; yy += dy; }
      return r;
    };
    let c = 0; for (let y = 0; y < gr; y++) for (let x = 0; x < gc; x++) { if (g[y * gc + x] < 0) continue; if (run(x, y, 1, 0) < 3 || run(x, y, 0, 1) < 3) c++; } return c;
  };
  const fD = gridFragile(dith), fH = gridFragile(half);
  const tones = new Set([...half].filter((v) => v > 0)).size;
  check('halftone far less fragile than dither', fH < fD * 0.25, `halftone ${fH} vs dither ${fD}`);
  check('halftone preserves multiple tones', tones >= 2, `${tones} tones`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
if (failures > 0) process.exit(1);
