import { generateSeatMap } from '../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../src/core/template';
import { DesignStore } from '../src/core/design';
import { floodFill } from '../src/core/tools';

const t0 = performance.now();
const map = generateSeatMap(DEFAULT_TEMPLATE);
console.log('seats:', map.count, '| gen ms:', (performance.now() - t0).toFixed(1));

let withL = 0, withR = 0, withU = 0, withD = 0, badRef = 0;
for (let i = 0; i < map.count; i++) {
  const [l, r, d, u] = [map.neighbors[i*4], map.neighbors[i*4+1], map.neighbors[i*4+2], map.neighbors[i*4+3]];
  if (l >= 0) withL++; if (r >= 0) withR++; if (d >= 0) withD++; if (u >= 0) withU++;
  for (const n of [l, r, d, u]) if (n >= map.count) badRef++;
}
console.log('neighbor coverage L/R/D/U %:',
  (100*withL/map.count).toFixed(1), (100*withR/map.count).toFixed(1),
  (100*withD/map.count).toFixed(1), (100*withU/map.count).toFixed(1), '| bad refs:', badRef);

const sections = new Set<number>();
for (let i = 0; i < map.count; i++) sections.add(map.sectionOf[i]);
console.log('sections:', sections.size, '| tiers:', new Set(map.tierOf).size);

const store = new DesignStore(map, ['#262a33','#1c5fd9','#f2f1ec','#e8b73a']);
store.cells.fill(1);
const t1 = performance.now();
store.beginStroke();
const dirtySec = floodFill(store, map, 0, 2, 'section');
store.commitStroke();
console.log('section fill: changed', dirtySec.length, 'seats in', (performance.now()-t1).toFixed(2), 'ms');

const t2 = performance.now();
store.beginStroke();
const dirtyAll = floodFill(store, map, map.count >> 1, 3, 'global');
store.commitStroke();
console.log('global fill (tier-bounded): changed', dirtyAll.length, 'seats in', (performance.now()-t2).toFixed(2), 'ms');

console.log('undo works:', (store.undo(), store.cells[map.count >> 1] === 1));
const bytes = store.toState().cells.byteLength;
console.log('design state bytes:', bytes);

// --- Phase 2 geometry sanity: pos3 must describe a plausible bowl ---
let minEl = Infinity, maxEl = -Infinity, minR = Infinity, maxR = -Infinity;
for (let i = 0; i < map.count; i++) {
  const x = map.pos3[i*3], y = map.pos3[i*3+1], z = map.pos3[i*3+2];
  const r = Math.hypot(x, z);
  if (y < minEl) minEl = y; if (y > maxEl) maxEl = y;
  if (r < minR) minR = r; if (r > maxR) maxR = r;
}
console.log('elevation m:', minEl.toFixed(1), '→', maxEl.toFixed(1),
  '| radial m:', minR.toFixed(1), '→', maxR.toFixed(1));
const lowerFrontOk = minEl > 0.5 && minEl < 3;
const upperTopOk = maxEl > 20 && maxEl < 35;
const pitchClearOk = minR > Math.hypot(52.5, 34); // first row outside pitch corner
console.log('bowl plausibility: front row:', lowerFrontOk, '| top row:', upperTopOk, '| pitch clearance:', pitchClearOk);

// --- Image import: pure quantizer + seat application ---
import { applyGridToSeats, fitRect, quantizePixels } from '../src/core/importImage';

// 50% gray against a white/black palette: dithering must produce a MIX,
// plain quantization must collapse to a single index.
const gw = 64, gh = 16;
const gray = new Uint8ClampedArray(gw * gh * 4);
for (let p = 0; p < gw * gh; p++) { gray.set([128,128,128,255], p*4); }
const pal = ['#262a33', '#f2f1ec', '#16161a'];
const dithered = quantizePixels(gray, gw, gh, pal, { dither: true, alphaThreshold: 128 });
const flat = quantizePixels(gray, gw, gh, pal, { dither: false, alphaThreshold: 128 });
const counts = (a: Int16Array) => { const m = new Map<number, number>(); for (const v of a) m.set(v, (m.get(v)??0)+1); return m; };
const dc = counts(dithered), fc = counts(flat);
const mixOk = (dc.get(1)??0) > gw*gh*0.2 && (dc.get(2)??0) > gw*gh*0.2;
console.log('dither mixes 50% gray:', mixOk, [...dc.entries()].map(([k,v])=>`${k}:${v}`).join(' '), '| flat collapses:', fc.size === 1);

// Transparent pixels are skipped, never painted.
const half = new Uint8ClampedArray(gw * gh * 4);
for (let p = 0; p < gw * gh; p++) half.set([200,40,40, p % gw < gw/2 ? 255 : 0], p*4);
const hq = quantizePixels(half, gw, gh, pal, { dither: true, alphaThreshold: 128 });
let alphaOk = true;
for (let p = 0; p < gw * gh; p++) if ((p % gw >= gw/2) !== (hq[p] === -1)) alphaOk = false;
console.log('alpha skip respected:', alphaOk);

// Stamp a left/right split grid onto the bowl and verify placement + undo.
store.cells.fill(1);
const vp = { x: 0, y: map.bounds.minY, width: 4000, height: map.bounds.maxY - map.bounds.minY };
const target = fitRect(2, 1, { ...vp, x: 1000, width: 800, height: 200, y: 100 });
const split = new Int16Array([2, 3]);
store.beginStroke();
const stamped = applyGridToSeats(store, map, split, 2, 1, target);
store.commitStroke();
let placeOk = stamped.length > 0;
for (const i of stamped) {
  const x = map.xy[i*2];
  const expect = x < target.x + target.width/2 ? 2 : 3;
  if (store.cells[i] !== expect) { placeOk = false; break; }
}
store.undo();
const undoOk = stamped.every(i => store.cells[i] === 1);
console.log('grid stamped onto', stamped.length, 'seats correctly:', placeOk, '| import undo:', undoOk);

// --- Mirror map: coverage and involution (mirror of mirror = self) ---
let mirrored = 0, involutionFail = 0, rowFail = 0;
for (let i = 0; i < map.count; i++) {
  const m = map.mirrorOf[i];
  if (m < 0) continue;
  mirrored++;
  if (map.mirrorOf[m] !== i) involutionFail++;
  if (map.rowOf[m] !== map.rowOf[i]) rowFail++;
}
console.log('mirror coverage:', (100*mirrored/map.count).toFixed(1) + '%',
  '| involution failures:', involutionFail, '| cross-row failures:', rowFail);

// --- Legibility: thin strokes flagged, thick blocks pass ---
import { findFragileSeats } from '../src/core/analysis';
store.cells.fill(1);
console.log('uniform base fragile count:', findFragileSeats(store.cells, map).length);

// Paint a 1-seat-tall horizontal line: every painted seat should be fragile.
const lineRow = 10;
const lineSeats: number[] = [];
for (let i = 0; i < map.count; i++) {
  if (map.rowOf[i] === lineRow && map.uv[i*2] > 0.2 && map.uv[i*2] < 0.23) {
    store.cells[i] = 2; lineSeats.push(i);
  }
}
const fragLine = findFragileSeats(store.cells, map);
const lineAllFlagged = lineSeats.every(i => fragLine.includes(i));
console.log('1-tall line:', lineSeats.length, 'seats, all flagged:', lineAllFlagged);

// Thicken to 5 rows: interior must pass, fragile count must collapse.
for (let i = 0; i < map.count; i++) {
  const r = map.rowOf[i];
  if (r >= 8 && r <= 12 && map.uv[i*2] > 0.2 && map.uv[i*2] < 0.23) store.cells[i] = 2;
}
const fragBlock = findFragileSeats(store.cells, map);
console.log('after thickening to 5 rows, fragile count:', fragBlock.length,
  '(was', fragLine.length + ')');

// --- Pattern presets: deterministic, valid indices, real color mixes ---
import { PATTERN_PRESETS } from '../src/core/patterns';
for (const preset of PATTERN_PRESETS) {
  const fn1 = preset.cellAt(map);
  const fn2 = preset.cellAt(map);
  const counts = new Map<number, number>();
  let deterministic = true;
  for (let i = 0; i < map.count; i++) {
    const v = fn1(i);
    if (fn2(i) !== v) deterministic = false;
    if (v < 0 || v > 3) throw new Error(`${preset.id}: index ${v} out of palette`);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const twoColor = !['solid', 'border'].includes(preset.id);
  const mixOk = !twoColor || ((counts.get(1) ?? 0) > map.count * 0.2 && (counts.get(2) ?? 0) > map.count * 0.2);
  if (!deterministic || !mixOk) throw new Error(`${preset.id} failed (det=${deterministic}, mix=${mixOk})`);
}
const tiersFn = PATTERN_PRESETS.find(p => p.id === 'tiers')!.cellAt(map);
let tiersOk = true;
for (let i = 0; i < map.count; i++) if (tiersFn(i) !== (map.tierOf[i] === 0 ? 1 : 2)) tiersOk = false;
console.log('patterns:', PATTERN_PRESETS.length, 'presets deterministic + balanced | tier split matches tierOf:', tiersOk);

// --- maskFromAlpha + seam wrap-around stamping ---
import { maskFromAlpha } from '../src/core/importImage';
const mp = new Uint8ClampedArray(4 * 4); // 2x2: opaque, transparent, opaque, transparent
mp.set([255,255,255,255], 0); mp.set([255,255,255, 40], 4);
mp.set([255,255,255,200], 8); mp.set([255,255,255,  0], 12);
const mask = maskFromAlpha(mp, 2, 2, 5);
console.log('alpha mask:', mask[0] === 5 && mask[1] === -1 && mask[2] === 5 && mask[3] === -1);

// Target rect crossing the bowl seam (x: 3900..4100 with width 4000 wrap):
store.cells.fill(1);
const seamTarget = { x: 3900, y: map.bounds.minY, width: 200, height: map.bounds.maxY - map.bounds.minY + 1 };
const solidGrid = new Int16Array([2]);
store.beginStroke();
const seamDirty = applyGridToSeats(store, map, solidGrid, 1, 1, seamTarget, 4000);
store.commitStroke();
let leftOfSeam = 0, rightOfSeam = 0, outside = 0;
for (const i of seamDirty) {
  const x = map.xy[i*2];
  if (x >= 3900) rightOfSeam++;
  else if (x < 100) leftOfSeam++;
  else outside++;
}
console.log('seam wrap: painted', seamDirty.length, 'seats | before seam:', rightOfSeam,
  '| wrapped past u=0:', leftOfSeam, '| leaked outside:', outside);

// --- Arc layout (pure geometry behind arched text) ---
import { arcLayout } from '../src/core/text';
const widths = [10, 10, 10];
const up = arcLayout(widths, 20, Math.PI / 2);
const apx = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
// Symmetry: middle glyph level and unrotated, outer pair mirrored.
const symOk =
  apx(up.glyphs[1].rotation, 0) &&
  apx(up.glyphs[0].rotation, -up.glyphs[2].rotation) &&
  apx(up.glyphs[0].y, up.glyphs[2].y) &&
  apx(up.glyphs[0].x + up.glyphs[2].x, up.width);
// Arch up: ends sit LOWER (larger canvas y) than the middle.
const archUpOk = up.glyphs[0].y > up.glyphs[1].y;
// Bow down mirrors vertically.
const down = arcLayout(widths, 20, -Math.PI / 2);
const bowDownOk = down.glyphs[0].y < down.glyphs[1].y;
// Arc-length preservation: R * delta-phi between neighbors == advance width.
const R = 30 / (Math.PI / 2);
const spacingOk = apx(R * (up.glyphs[1].rotation - up.glyphs[0].rotation), 10, 1e-9);
// Chord is shorter than the flat run for a bent arc.
const chordOk = up.width - 2 * 15 < 30;
console.log('arc layout - symmetry:', symOk, '| arch up:', archUpOk, '| bow down:', bowDownOk,
  '| spacing preserved:', spacingOk, '| chord < flat:', chordOk);

// --- Multi-template generation + tier-limited stamping ---
import { TEMPLATES } from '../src/core/template';
for (const tpl of TEMPLATES) {
  const m2 = generateSeatMap(tpl);
  const tiers = new Set(m2.tierOf).size;
  if (m2.count < 1000 || tiers !== tpl.tiers.length) throw new Error(`${tpl.id} bad generation`);
  console.log(`template ${tpl.id}: ${m2.count.toLocaleString()} seats, ${tiers} tier(s)`);
}

// accept predicate: stamp a full-bowl rect limited to the upper tier only
store.cells.fill(1);
const fullRect = { x: 0, y: map.bounds.minY, width: 4000, height: map.bounds.maxY - map.bounds.minY + 1 };
store.beginStroke();
const tierDirty = applyGridToSeats(
  store, map, new Int16Array([2]), 1, 1, fullRect, undefined, (i) => map.tierOf[i] === 1,
);
store.commitStroke();
let upperPainted = 0, lowerTouched = 0;
for (const i of tierDirty) (map.tierOf[i] === 1 ? upperPainted++ : lowerTouched++);
const upperTotal = Array.from(map.tierOf).filter(t => t === 1).length;
console.log('tier-limited stamp: painted', upperPainted, '/', upperTotal, 'upper seats | lower touched:', lowerTouched);

// --- Reveal orderings + GIF encoder ---
import { buildReveal, REVEAL_PRESETS } from '../src/core/reveal';
import { encodeGif, renderRevealFrames } from '../src/core/gif';
import { DesignStore as DS2 } from '../src/core/design';

for (const preset of REVEAL_PRESETS) {
  const d = buildReveal(map, preset.id);
  let lo = Infinity, hi = -Infinity;
  for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (preset.id !== 'instant' && (lo < 0 || hi > 1 || hi - lo < 0.5))
    throw new Error(`reveal ${preset.id} bad range ${lo}..${hi}`);
}
console.log('reveals:', REVEAL_PRESETS.length, 'orderings span [0,1]');

// sweep-lr must monotonically increase with u
const dl = buildReveal(map, 'sweep-lr');
let mono = true;
for (let i = 1; i < map.count; i++) {
  if (map.uv[i*2] > map.uv[(i-1)*2] + 0.01 && dl[i] < dl[i-1] - 0.01) { mono = false; break; }
}
console.log('sweep-lr tracks u:', mono);

// GIF: encode a few frames, check header/trailer and non-trivial size
const gstore = new DS2(map, ['#262a33','#1c5fd9','#f2f1ec','#e8b73a']);
gstore.cells.fill(1);
for (let i = 0; i < map.count; i += 3) gstore.cells[i] = 2;
const { frames, w, h, table } = renderRevealFrames(map, gstore, { reveal:'sweep-lr', width:240, frames:8, fps:16, fade:0.08 });
const gif = encodeGif(frames, w, h, table, 6);
const headerOk = gif[0]===0x47 && gif[1]===0x49 && gif[2]===0x46; // "GIF"
const trailerOk = gif[gif.length-1]===0x3b;
const f0Gray = frames[0].filter(x => x===0).length, fLastGray = frames[frames.length-1].filter(x => x===0).length;
console.log('gif:', w+'x'+h, frames.length, 'frames,', gif.length, 'bytes | header:', headerOk, '| trailer:', trailerOk,
  '| frame0 gray', f0Gray, '> last gray', fLastGray, '=', f0Gray > fLastGray);

// --- Production logistics computations ---
import { productionSummary as prodSum, seatManifestCsv as manifestCsv, colorFamily as cFamily } from '../src/core/production';
{
  const pal = ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a'];
  const c = new Uint8Array(map.count);
  for (let i = 0; i < map.count; i++) c[i] = i % 2 === 0 ? 1 : i % 4 === 1 ? 2 : 0;
  const s = prodSum(c, pal, { cardsPerBag: 100 });
  const consistent = s.totalCards + s.emptySeats === s.seatCount;
  const bagsOk = s.colors.reduce((a, x) => a + x.bags, 0) === s.totalBags;
  const csv = manifestCsv(c, pal, map, { includeEmpty: false });
  const csvRows = csv.split('\n').length - 1;
  console.log('production: cards+empty=seats', consistent, '| bag sum', bagsOk,
    '| csv rows', csvRows, '=== totalCards', csvRows === s.totalCards,
    '| families', cFamily('#1c5fd9'), cFamily('#f2f1ec'));
  if (!consistent || !bagsOk || csvRows !== s.totalCards) throw new Error('production computation invariant failed');
}

// --- Roof geometry, and the sparkle default ---------------------------------
// The roof is shell-only, so the invariant that matters most is a negative one:
// it must not have moved a single seat. The rest is coverage behaving the way
// a tifo region of the same name behaves.
import { readFileSync as roofRead } from 'node:fs';
import { STADIUM_CATALOG as ROOF_CATALOG } from '../src/core/stadiumCatalog';
import { arcU, coverageMask, ROOF_DEFAULTS } from '../src/render/simulator/roof';
{
  const VALID = ['none', 'ring', 'sides', 'ends', 'north', 'south', 'east', 'west'];
  for (const s of ROOF_CATALOG) {
    const r = s.template.roof;
    if (!r) continue;
    if (r.coverage && !VALID.includes(r.coverage)) throw new Error(`${s.id}: bad roof coverage ${r.coverage}`);
    if (r.reach !== undefined && (r.reach < 0 || r.reach > 1)) throw new Error(`${s.id}: roof reach out of 0..1`);
  }

  // Coverage must partition the bowl the way the stand names do: one stand is a
  // quarter of the PERIMETER, 'sides' and 'ends' are halves, 'ring' is all of it.
  // Measured by arc length, not by counting kept samples — samples are uniform in
  // the angle parameter, which runs fast down the flat sides of a superellipse
  // and slow round the ends, so a sample count says east is 28% of a bowl where
  // it is exactly 25% of the perimeter.
  const { a, b, exponent: p } = ROOF_CATALOG[0].template.plan;
  const us = arcU(a, b, p);
  const share = (c: Parameters<typeof coverageMask>[3]): number => {
    const m = coverageMask(a, b, p, c);
    let len = 0;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const next = us[(i + 1) % us.length] + (i + 1 === us.length ? 1 : 0);
      len += next - us[i];
    }
    return len;
  };
  const near = (x: number, want: number): boolean => Math.abs(x - want) < 0.01;
  const covOk = near(share('ring'), 1) && share('none') === 0 &&
    near(share('sides'), 0.5) && near(share('ends'), 0.5) &&
    near(share('west'), 0.25) && near(share('north'), 0.25);
  const masks = (['north', 'south', 'east', 'west'] as const).map((c) => coverageMask(a, b, p, c));
  const partitions = masks[0].every((_, i) => masks.filter((m) => m[i]).length === 1);
  const sides = coverageMask(a, b, p, 'sides');
  const [n, so, e, w] = masks;
  const groupsOk = sides.every((v, i) => v === (e[i] || w[i])) &&
    coverageMask(a, b, p, 'ends').every((v, i) => v === (n[i] || so[i]));
  // East straddles the seam, exactly as the tifo compiler has it.
  const seamOk = e[0] === true;
  console.log('roof coverage: quarters/halves by arc length', covOk,
    '| four stands partition the ring', partitions, '| groups agree', groupsOk, '| east owns the seam', seamOk);
  if (!covOk || !partitions || !groupsOk || !seamOk) throw new Error('roof coverage masks do not match the stand split');

  // Seat maps must be untouched by roofs. These counts were measured before the
  // roof existed; a roof that changes one of them is a roof that moved a seat.
  const EXPECT: Record<string, number> = {
    'generic-bowl-60k': 60832, 'single-kop-40k': 39700, 'grand-oval-76k': 75984,
    'community-grand-national-80k': 90990, 'community-steep-cauldron-55k': 60834,
    'community-compact-wall-30k': 38756, 'community-desert-arena-68k': 74008,
    'community-roaring-terraces-48k': 48044, 'community-cauldron-dome-62k': 78648,
    'community-wide-oval-72k': 91284, 'community-jewel-jeddah-62k': 61572,
    'community-alawwal-park-25k': 24652, 'community-kingdom-arena-28k': 26052,
  };
  let moved = 0;
  for (const s of ROOF_CATALOG) {
    const want = EXPECT[s.id];
    if (want === undefined) continue;
    if (generateSeatMap(s.template).count !== want) moved++;
  }
  console.log('roofs moved no seats:', moved === 0, `(${Object.keys(EXPECT).length} templates)`);
  if (moved) throw new Error(`${moved} template(s) changed seat count after the roof change`);

  // Phone flashes must start OFF, every time. Three separate places have to agree,
  // and any one of them drifting quietly turns the default back on.
  const overlaySrc = roofRead('src/render/simulator/overlay.ts', 'utf8');
  const simSrc = roofRead('src/render/simulator/index.ts', 'utf8');
  const offByDefault = /\n\s*sparkles:\s*false,/.test(overlaySrc);
  const hiddenAtBuild = /this\.sparkles\.object\.visible\s*=\s*false/.test(simSrc);
  const applied = /sim\.setSparkles\(state\.sparkles\)/.test(overlaySrc);
  const toggleable = /setSparkles\(b: boolean\)/.test(simSrc);
  const noPersist = !/sparkles[^\n]*localStorage|localStorage[^\n]*sparkles/.test(overlaySrc);
  console.log('phone flashes: default off', offByDefault, '| hidden at build', hiddenAtBuild,
    '| applied', applied, '| toggle', toggleable, '| never persisted', noPersist);
  if (!offByDefault || !hiddenAtBuild || !applied || !toggleable || !noPersist) {
    throw new Error('phone-flash sparkles must start off and stay toggleable');
  }

  // Both languages, like every other label in that panel.
  for (const k of ['phoneFlashes', 'tip.sparkles']) {
    const row = new RegExp(`'?${k.replace('.', '\\.')}'?\\s*:\\s*\\{[^}]*\\}`).exec(overlaySrc)?.[0] ?? '';
    if (!/en:/.test(row) || !/ar:/.test(row)) throw new Error(`${k} is missing an en/ar translation`);
  }
  console.log('sparkle strings carry en + ar: true | roof defaults reach', ROOF_DEFAULTS.reach);
}

// --- The stadium import panel -----------------------------------------------
// Its notes come from src/core/stadiumFit, which has no i18n, so they reach the
// user only if core emits a key and the panel looks it up. That wiring shipped
// broken once — English prose in the middle of the Arabic panel — and a
// screenshot caught it rather than a test, which is the wrong way round.
import { readFileSync as siRead } from 'node:fs';
import { buildStadium as siBuild } from '../src/core/stadiumFit';
{
  const i18n = siRead('src/ui/i18n.ts', 'utf8');
  const panel = siRead('src/ui/stadiumImport.ts', 'utf8');

  // Every si.* string carries both languages.
  //
  // Matched to end-of-line, NOT with [^}]*: a string containing a {placeholder}
  // has a closing brace in the middle of it, so the lazy version stops early and
  // reports six perfectly good translations as missing. That regex has now been
  // written wrong twice in this codebase; one entry per line is the invariant
  // that makes the simple match correct.
  const rows = (i18n.match(/^\s*'si\.[a-zA-Z.]+':.*$/gm) ?? []).map((r) => r.trim());
  const missing = rows.filter((r) => !/\ben:/.test(r) || !/\bar:/.test(r));
  console.log('stadium import: si.* strings', rows.length, '| missing a translation', missing.length);
  if (rows.length < 30 || missing.length) throw new Error(`stadium import strings incomplete: ${missing.join(' ')}`);

  // Every key core can emit has a string, or the panel prints the key at the user.
  const core = siRead('src/core/stadiumFit.ts', 'utf8');
  const emitted = [...core.matchAll(/'(si\.(?:note|warn)\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  const unstranslated = [...new Set(emitted)].filter((k) => !i18n.includes(`'${k}'`));
  console.log('stadium import: keys core emits', new Set(emitted).size, '| without a string', unstranslated.length);
  if (unstranslated.length) throw new Error(`stadiumFit emits untranslated keys: ${unstranslated.join(', ')}`);

  // The panel must actually look them up rather than printing the English.
  const looksUp = /p\.noteKey\s*\?\s*tv\(p\.noteKey/.test(panel) && /tv\(w\.key/.test(panel);
  console.log('stadium import: panel translates notes and warnings', looksUp);
  if (!looksUp) throw new Error('stadiumImport must render noteKey/warning keys through tv()');

  // And the confidence of every field must be reachable as a label.
  const fit = siBuild({
    footprint: Array.from({ length: 24 }, (_, i) => {
      const t2 = (i / 24) * Math.PI * 2;
      return [35.9 + (Math.cos(t2) * 110) / 94000, 32 + (Math.sin(t2) * 85) / 111132] as [number, number];
    }),
    capacity: 40000,
  });
  const confs = new Set(Object.values(fit.provenance).map((p) => p.confidence));
  const unlabelled = [...confs].filter((c) => !i18n.includes(`'si.conf.${c}'`));
  console.log('stadium import: confidence levels in use', [...confs].join('/'), '| unlabelled', unlabelled.length);
  if (unlabelled.length) throw new Error(`no label for confidence: ${unlabelled.join(', ')}`);

  // The provenance must distinguish, not decorate: a footprint-only build has to
  // report at least one guess and at least one non-guess, which is the whole
  // reason the table exists.
  const hasGuess = [...confs].includes('suggested');
  const hasSolid = [...confs].some((c) => c === 'derived' || c === 'measured');
  console.log('stadium import: separates guesses from measurements', hasGuess && hasSolid);
  if (!hasGuess || !hasSolid) throw new Error('provenance is not distinguishing guesses from measurements');
}
