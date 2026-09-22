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

// ---------------------------------------------------------------------------
// Floodlights, the track and the facade: the three things that make one ground
// look unlike another. Each one is checked against the rule that produced it,
// not against a screenshot, because the whole point of driving them from the
// template is that the rule is the thing being claimed.
{
  const { layOutLights, structureTop, kelvinToRgb } = await import('../src/render/simulator/lighting');
  const { buildFacade } = await import('../src/render/simulator/facade');
  const { trackFits, trackExtent } = await import('../src/render/simulator/track');
  const { STADIUM_CATALOG: LC } = await import('../src/core/stadiumCatalog');
  const { TEMPLATES: LT } = await import('../src/core/template');
  const all = [...LT, ...LC.map((s) => s.template)];

  // The angle rules. Corner towers are measured from the PITCH CENTRE and must
  // clear 25 degrees; a roof-rim array is measured from the nearest point of the
  // PITCH EDGE and must clear 20. Reading the first rule onto the second is what
  // once pushed rim lights 25 m above their own roof, so both are checked here
  // with their own reference point.
  let angleFails = 0;
  let floaters = 0;
  let wedgeFails = 0;
  for (const tpl of all) {
    const plan = layOutLights(tpl);
    if (!plan.luminaires.length) continue;
    const floor = plan.angleRef === 'centre' ? 24.9 : 19.9;
    if (plan.minAngleDeg < floor) angleFails++;
    if (plan.style === 'corner-masts') {
      // Nothing inside 15 degrees either side of the goal line.
      for (const l of plan.luminaires) {
        const deg = (Math.atan2(Math.abs(l.pos[2]), Math.abs(l.pos[0])) * 180) / Math.PI;
        if (deg < 14.9) wedgeFails++;
      }
    } else {
      // A rim luminaire is bolted to the structure. If it is metres above the
      // top of the building it is not a luminaire, it is a floating dot.
      const top = structureTop(tpl);
      if (plan.luminaires.some((l) => l.pos[1] > top + 4)) floaters++;
    }
  }
  console.log('floodlights: angle rule broken', angleFails, '| in the goal-line wedge', wedgeFails,
    '| rim lights floating above the roof', floaters, `(${all.length} templates)`);
  if (angleFails || wedgeFails || floaters) throw new Error('floodlight layout breaks its own rules');

  // A bowl too low to be lit from its roof must SAY so by falling back, not by
  // lifting the lights into the sky. Same shape as trackFits.
  const flat = { ...LT[0], tiers: [{ rows: 6, rowDepth: 0.8, rakeDeg: 20, baseElevation: 1, baseOffset: 0, seatPitch: 0.5 }], roof: { coverage: 'none' as const }, lighting: { style: 'roof-rim' as const } };
  const fell = layOutLights(flat);
  console.log('floodlights: a bowl too low for a rim array falls back to', fell.style, '|', fell.note ? 'and says why' : 'SILENTLY');
  if (fell.style !== 'corner-masts' || !fell.note) throw new Error('a rim array on a flat bowl must fall back with a reason');

  // Colour temperature: 5700 K is near-white, 4200 K is visibly warm. If these
  // come out the same, every ground is lit by the same lamp again.
  const warm = kelvinToRgb(4200);
  const cool = kelvinToRgb(5700);
  const blueDiff = (cool & 0xff) - (warm & 0xff);
  console.log('floodlights: 4200 K reads warmer than 5700 K by', blueDiff, 'of blue');
  if (blueDiff < 15) throw new Error('colour temperature is not reaching the lamp colour');

  // Every facade style has to produce geometry, and produce DIFFERENT geometry.
  // A vocabulary of eight where three are the same object is a vocabulary of six
  // with a longer menu.
  const STYLES = ['plain', 'berm', 'truss', 'concrete', 'brick', 'cladding', 'membrane', 'lattice'] as const;
  const tris = new Map<string, number>();
  for (const style of STYLES) {
    const f = buildFacade({ ...LT[0], facade: { style } }, 30, 26, false);
    let n = 0;
    f.object.traverse((o) => {
      const m = o as unknown as { geometry?: { getIndex(): { count: number } | null }; count?: number; isInstancedMesh?: boolean };
      if (!m.geometry) return;
      const idx = m.geometry.getIndex();
      n += ((idx ? idx.count : 0) / 3) * (m.isInstancedMesh ? (m.count ?? 1) : 1);
    });
    tris.set(style, Math.round(n));
    f.dispose();
  }
  const empties = [...tris].filter(([, n]) => n < 200).map(([s]) => s);
  const distinct = new Set(tris.values()).size;
  console.log('facades:', [...tris].map(([s, n]) => `${s} ${n}`).join(', '));
  console.log('facades: empty', empties.length, '| distinct geometries', distinct, 'of', STYLES.length);
  if (empties.length) throw new Error(`facade style(s) produce nothing: ${empties.join(', ')}`);
  if (distinct < STYLES.length - 1) throw new Error('facade styles are not producing distinct geometry');

  // The track has to refuse a bowl it cannot fit into. An 8-lane oval is
  // 176.9 x 92.5 m to the outside of lane 8, so a 128 x 100 m football ground
  // has no room for one and must not be allowed to claim it.
  const ext = trackExtent(8);
  const okOval = trackFits(LT[2], 8);
  const small = LC.find((s) => s.id === 'community-alawwal-park-25k')!.template;
  const badFit = trackFits(small, 8);
  console.log(`track: 8 lanes need ${(ext.halfLength * 2).toFixed(1)} x ${(ext.halfWidth * 2).toFixed(1)} m | oval fits`, okOval, '| 25k football ground refused', !badFit);
  if (!okOval || badFit) throw new Error('trackFits is not gating on the real oval size');

  // Every template that claims a track must have room for it. A template that
  // says `track: {}` and gets nothing drawn is a lie the renderer swallows.
  const claiming = all.filter((t2) => t2.track);
  const roomless = claiming.filter((t2) => !trackFits(t2, t2.track?.lanes ?? 8));
  console.log('track: templates claiming one', claiming.length, '| without room for it', roomless.length);
  if (roomless.length) throw new Error(`template(s) claim a track that does not fit: ${roomless.map((t2) => t2.id).join(', ')}`);
}

// ---------------------------------------------------------------------------
// The recorded reveal's size budget.
//
// A clip that will not go through WhatsApp without being re-encoded is a clip
// nobody shares intact, so the recorder is sized to a byte budget rather than to
// a bitrate someone picked. Duration times bitrate IS the file, near enough, so
// this arithmetic decides the answer — and it is checked here rather than in the
// browser harness, because under software rendering the canvas barely repaints
// and every recorded clip comes out 20x smaller than it would on real hardware.
{
  const { recordingPlan, RECORD_MAX_BYTES } = await import('../src/render/simulator/recordPlan');
  const MB = 1024 * 1024;

  // Every combination the overlay's selects can produce.
  const DURATIONS = [6, 9, 12, 15];
  const FPS = [24, 30, 60];
  let over = 0;
  let worst = 0;
  for (const seconds of DURATIONS) {
    for (const fps of FPS) {
      const p = recordingPlan({ seconds, fps });
      worst = Math.max(worst, p.estimatedBytes);
      if (p.estimatedBytes > RECORD_MAX_BYTES) over++;
    }
  }
  console.log(`reveal video: budget ${(RECORD_MAX_BYTES / MB).toFixed(1)} MB | worst of ${DURATIONS.length * FPS.length} settings ${(worst / MB).toFixed(2)} MB | over budget ${over}`);
  if (over) throw new Error(`${over} recording setting(s) exceed the size budget`);

  // MP4, and specifically H.264 MP4, is what "a video" means outside a browser.
  // The order has to name the codec: isTypeSupported('video/mp4') answers true
  // in browsers that then hand back VP9 INSIDE an MP4 — a real MP4 container
  // that QuickTime and iOS still will not play, which is the same problem
  // wearing a different extension.
  const { pickRecordingFormat, describeRecording } = await import('../src/render/simulator/recordPlan');
  const only = (...supported: string[]) => (m: string): boolean => supported.includes(m);
  const everything = pickRecordingFormat(() => true);
  console.log(`reveal video: a browser that supports everything records ${everything?.mimeType}`);
  if (everything?.extension !== 'mp4' || !everything.universal) throw new Error('H.264 MP4 must be the first choice');

  const noH264 = pickRecordingFormat(only('video/mp4', 'video/webm;codecs=vp9', 'video/webm'));
  if (noH264?.mimeType !== 'video/mp4') throw new Error('a browser with MP4 but no named H.264 should still take MP4 over WebM');
  const webmOnly = pickRecordingFormat(only('video/webm;codecs=vp9', 'video/webm'));
  if (webmOnly?.extension !== 'webm') throw new Error('WebM is still the fallback');
  if (pickRecordingFormat(() => false) !== null) throw new Error('a browser that can record nothing must say so, not guess');

  // And the reply is believed over the request, because Chromium answers
  // "video/mp4" and then hands back VP9 inside it.
  const asked = { mimeType: 'video/mp4', extension: 'mp4' as const, universal: false };
  const gotVp9 = describeRecording('video/mp4;codecs=vp9', asked);
  const gotH264 = describeRecording('video/mp4;codecs=avc1.42E01E', asked);
  console.log(`reveal video: mp4+vp9 reads as universal=${gotVp9.universal}, mp4+avc1 as universal=${gotH264.universal}`);
  if (gotVp9.extension !== 'mp4' || gotVp9.universal) throw new Error('VP9 inside MP4 must not be called universal');
  if (!gotH264.universal) throw new Error('H.264 inside MP4 is the universal case');
  if (describeRecording('video/webm;codecs=vp9', asked).extension !== 'webm') throw new Error('the extension must follow the negotiated container, not the request');

  // The clip carries the crowd. A mime naming a video codec and no audio codec
  // records the picture and silently drops the sound, which is a file that
  // looks right and plays silent — and is what every Match Day clip was until
  // the audio track was added to the recorder's stream.
  const av = pickRecordingFormat(() => true, true);
  console.log(`reveal video: with an audio track, a browser that supports everything records ${av?.mimeType}`);
  if (!/mp4a/.test(av?.mimeType ?? '')) throw new Error('an audio-bearing clip must name an audio codec when the browser has one');
  if (av?.extension !== 'mp4' || !av.universal) throw new Error('audio must not change the container preference');
  const webmAv = pickRecordingFormat(only('video/webm;codecs=vp9,opus', 'video/webm'), true);
  if (!/opus/.test(webmAv?.mimeType ?? '')) throw new Error('WebM takes Opus, not AAC');
  // A browser with H.264 but no AAC records the picture rather than refusing
  // the clip or dropping to WebM over one codec.
  const noAac = pickRecordingFormat(only('video/mp4;codecs=avc1.42E01E'), true);
  if (noAac?.mimeType !== 'video/mp4;codecs=avc1.42E01E') throw new Error('a missing audio codec must fall back to video-only in the same container');
  // And the silent path is byte-for-byte what it was.
  if (pickRecordingFormat(() => true)?.mimeType !== 'video/mp4;codecs=avc1.42E01E') throw new Error('asking without audio must be unchanged');

  // The old behaviour, as a regression. A flat 8 Mbps made a 9-second clip 9 MB
  // and a 15-second one 15, whatever was in it.
  const before = (9 * 8_000_000) / 8;
  const after = recordingPlan({ seconds: 9 }).estimatedBytes;
  console.log(`reveal video: a 9s clip was ${(before / MB).toFixed(1)} MB at the old flat 8 Mbps, now ${(after / MB).toFixed(2)} MB`);
  if (after >= before) throw new Error('the budget did not make the default clip smaller');

  // Longer clip, thinner bitrate — otherwise the budget is not a budget.
  const bits = DURATIONS.map((s) => recordingPlan({ seconds: s }).bitsPerSecond);
  const monotonic = bits.every((b, i) => i === 0 || b <= bits[i - 1]);
  console.log(`reveal video: bitrate falls with length ${bits.map((b) => (b / 1e6).toFixed(2)).join(' -> ')} Mbps`);
  if (!monotonic) throw new Error('bitrate does not fall as the clip gets longer');

  // Resolution is never the thing that gives way — the user asked for a smaller
  // file at the SAME resolution. recordReveal's only resolution input is
  // `opts.height`, which comes straight from the overlay's select; the plan must
  // not have an opinion about it at all.
  const planKeys = Object.keys(recordingPlan({ seconds: 15, fps: 60 }));
  const touchesRes = planKeys.some((k) => /height|width|res|scale/i.test(k));
  console.log('reveal video: the size plan has no opinion about resolution', !touchesRes, `(${planKeys.join(', ')})`);
  if (touchesRes) throw new Error('the size budget must never reduce resolution');

  // When the per-frame budget gets thin, the frame rate steps down instead.
  const thin = recordingPlan({ seconds: 15, fps: 60 });
  const roomy = recordingPlan({ seconds: 6, fps: 60 });
  console.log(`reveal video: 60 fps kept at 6s (${roomy.fps}) and stepped down at 15s (${thin.fps})`);
  if (roomy.fps !== 60 || thin.fps !== 24) throw new Error('frame rate is not the lever that gives way');

  // And it never asks for more than it used to, however generous the budget.
  const generous = recordingPlan({ seconds: 2, maxBytes: 500 * MB });
  if (generous.bitsPerSecond > 8_000_000) throw new Error('a large budget must not exceed the old 8 Mbps ceiling');
  // Nor below the rate where the crowd turns to blocks; it reports the overshoot
  // instead of quietly shipping something unwatchable.
  const squeezed = recordingPlan({ seconds: 60, maxBytes: 1 * MB });
  console.log('reveal video: an impossible budget holds the quality floor and admits it', squeezed.bitsPerSecond === 1_200_000 && squeezed.overBudget);
  if (squeezed.bitsPerSecond !== 1_200_000 || !squeezed.overBudget) throw new Error('the quality floor or its overBudget flag is wrong');
}

// ---------------------------------------------------------------------------
// Community filters: what a design "is", derived rather than typed.
{
  const { COLOUR_FAMILIES, clubFilterOptions, clubId, colourSlug, designFacets, paletteColours } =
    await import('../src/core/facets');
  const { CLUBS } = await import('../src/core/clubs');

  // Two clubs sharing an id would merge silently in every filter that uses one.
  const ids = CLUBS.map((c) => clubId(c.aliases));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  console.log(`facets: ${ids.length} clubs filterable | duplicate ids ${dupes.length}${dupes.length ? ' (' + dupes.join(', ') + ')' : ''}`);
  if (dupes.length) throw new Error(`club ids collide: ${dupes.join(', ')}`);
  if (clubFilterOptions().length !== CLUBS.length) throw new Error('not every club is offered as a filter');

  // Shade is dropped, hue is kept: somebody filtering for blue wants the dark
  // navy and the sky blue, and a manifest's 'Dark blue' is the wrong grain here.
  const shades = ['Dark blue', 'Blue', 'Light blue'].map(colourSlug);
  console.log(`facets: 'Dark blue' / 'Blue' / 'Light blue' -> ${shades.join(', ')}`);
  if (new Set(shades).size !== 1 || shades[0] !== 'blue') throw new Error('colour shades must collapse to one family');
  if (colourSlug('Chartreuse') !== null) throw new Error('an unknown family must be dropped, not guessed');

  // Index 0 is the empty seat, not a colour anyone chose. Counting it would tag
  // every design in the catalogue dark grey and make the filter useless.
  const withEmpty = paletteColours(['#262a33', '#0033a0', '#ffffff']);
  console.log(`facets: palette #262a33/#0033a0/#ffffff -> ${withEmpty.join(', ')}`);
  if (withEmpty.includes('grey')) throw new Error('the empty-seat colour must not become a filter facet');
  if (!withEmpty.includes('blue') || !withEmpty.includes('white')) throw new Error('real palette colours are missing');
  if (paletteColours(['#262a33', 'not-a-colour', '#zzzzzz']).length !== 0) throw new Error('malformed palette entries must be ignored');

  // The club comes off the title, in either language, and matching nothing is a
  // correct answer — half the clubs in the list are blue and white, so guessing
  // from the palette would be worse than saying nothing.
  const cases: [string, string | null][] = [
    ['الهلال · أسهم', 'al-hilal'],
    ['Al Ittihad stripes', 'al-ittihad'],
    ['مانشستر سيتي · حلقات', 'manchester-city'],
    ['ThaiPort FC Ultras', null],
    ['', null],
  ];
  for (const [title, want] of cases) {
    const got = designFacets({ title, palette: ['#262a33', '#0033a0'] }).clubId;
    if (got !== want) throw new Error(`club from "${title}": expected ${want}, got ${got}`);
  }
  console.log(`facets: club from title right on ${cases.length}/${cases.length} (including two that should match nothing)`);

  // An Arabic title on a design whose English title names no club still finds it.
  const ar = designFacets({ title: 'Untitled tifo', titleAr: 'النصر · نصفان', palette: ['#262a33', '#f9d616'] });
  console.log('facets: an Arabic title is read when the English one says nothing:', ar.clubId);
  if (ar.clubId !== 'al-nassr') throw new Error('titleAr is not being consulted');

  // The filter panel's own invariants, from the markup.
  const commHtml = roofRead('community.html', 'utf8');
  const oneButton = /id="filter-btn"/.test(commHtml) && !/id="tag-row"|id="club-select"|class="filter-row"/.test(commHtml);
  // The Apply button's label is the live result count. data-i18n on it would let
  // applyDom overwrite "Show 47 tifos" with "Apply" on every language switch —
  // which is exactly what it did until a screenshot caught it.
  const applyLine = /<button class="fp-apply"[^>]*>/.exec(commHtml)?.[0] ?? '';
  const applyFree = !!applyLine && !/data-i18n/.test(applyLine);
  console.log('filters: one button, no loose controls', oneButton, '| Apply label left to the live count', applyFree);
  if (!oneButton) throw new Error('the filters must stay behind one button');
  if (!applyFree) throw new Error('the Apply button must not carry data-i18n: its label is the live count');

  // Every family a chip can show must have a label in both languages, or the
  // chip row comes out half in English.
  const i18nSrc2 = roofRead('src/ui/i18n.ts', 'utf8');
  const missing = COLOUR_FAMILIES.filter((c) => !new RegExp(`'cm\\.colour\\.${c}':[^\\n]*\\bar:`).test(i18nSrc2));
  console.log(`facets: colour labels ${COLOUR_FAMILIES.length} | without Arabic ${missing.length}`);
  if (missing.length) throw new Error(`no Arabic for colour chip(s): ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Crowd sound. The module needs an AudioContext, so what can be checked here is
// the part that matters anyway: that it never starts by itself.
{
  const overlaySrc2 = roofRead('src/render/simulator/overlay.ts', 'utf8');
  const atmoSrc = roofRead('src/render/simulator/atmosphere.ts', 'utf8');
  const simSrc2 = roofRead('src/render/simulator/index.ts', 'utf8');

  const offByDefault = /\n\s*sound:\s*false,/.test(overlaySrc2);
  // The AudioContext must be built inside the toggle. One created at
  // construction sits suspended and silently does nothing, which reads as a
  // broken feature rather than a refused one.
  const lazyCtx = /if \(!ctx\) \{\s*\n\s*ctx = new AudioCtor\(\)/.test(atmoSrc);
  const refused = /soundBlocked/.test(overlaySrc2);
  // The mix is remembered; the on/off is not. Whether a page starts making
  // noise is not a decision to make on someone's behalf a second time.
  const mixKept = /localStorage\.setItem\(SOUND_KEY/.test(overlaySrc2);
  const saved = /localStorage\.setItem\(SOUND_KEY, JSON\.stringify\(\{([\s\S]*?)\}\s*satisfies/.exec(overlaySrc2)?.[1] ?? '';
  const onNotKept = saved !== '' && !/\bsound\s*:/.test(saved);
  /**
   * The regression that made this whole pass necessary.
   *
   * `Number(localStorage.getItem('mds_volume'))` is `0` when nothing is stored,
   * and `0` satisfied `Number.isFinite(v) && v >= 0 && v <= 1` — so the master
   * gain was set to zero for every visitor who had never dragged the slider,
   * and the entire sound system was correctly wired and completely silent.
   * Nothing may go from getItem straight into Number() again.
   */
  // Comments stripped first: the docblock that explains the bug quotes the
  // exact expression it is banning, and a guard that its own explanation trips
  // is a guard nobody can keep.
  const overlayCode = overlaySrc2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const noRawNumber = !/Number\(\s*localStorage\.getItem/.test(overlayCode);
  // And nothing may default to zero, either.
  const defaults = /DEFAULT_LEVELS[\s\S]*?\};/.exec(atmoSrc)?.[0] ?? '';
  const loudDefaults = defaults !== '' && !/:\s*0\s*,/.test(defaults);
  console.log('crowd sound: off by default', offByDefault, '| context built in the gesture', lazyCtx,
    '| says so when the browser refuses', refused, '| mix remembered', mixKept,
    '| on-state never remembered', onNotKept, '| no getItem straight into Number', noRawNumber,
    '| no level defaults to zero', loudDefaults);
  if (!offByDefault || !lazyCtx || !refused || !mixKept || !onNotKept || !noRawNumber || !loudDefaults) {
    throw new Error('crowd sound must stay opt-in, gesture-started, honest when blocked, and audible out of the box');
  }

  // Four buses and a master, each reachable from the panel. "Louder" is several
  // different requests and one fader answered none of them.
  const buses = ['master', 'crowd', 'sfx', 'amb', 'drum'];
  const missingBus = buses.filter((b) => !new RegExp(`\\b${b}\\s*:\\s*rng\\(0, 1,`).test(overlaySrc2));
  if (missingBus.length) throw new Error(`no fader for sound bus: ${missingBus.join(', ')}`);
  // A range input sanitises against the step it has at assignment time, so a
  // fractional default with the step set afterwards silently becomes the max.
  const stepFirst = /r\.step = String\(step\);\s*\n\s*r\.value = String\(val\);/.test(overlaySrc2);
  if (!stepFirst) throw new Error('rng() must set step before value, or every fractional slider opens at 100%');
  // The effects that used to happen in silence.
  for (const [name, call] of [['confetti', 'atmosphere.confetti'], ['pyro', 'atmosphere.pyro'], ['floodlights', 'atmosphere.floodlights']] as [string, string][]) {
    if (!simSrc2.includes(call)) throw new Error(`${name} still fires without a sound`);
  }
  console.log(`crowd sound: ${buses.length} faders, and confetti/pyro/floodlights all make a noise`);

  // The roar is a choreography cue, not a setting: it has to land on the
  // finished tifo. A roar at the start of the reveal is a crowd cheering at
  // nothing.
  const revealAt = /\{ kind: 'reveal', start: ([\d.]+), dur: ([\d.]+)/.exec(simSrc2);
  const roarAt = /\{ kind: 'effect', start: ([\d.]+), effect: 'roar' \}/.exec(simSrc2);
  const revealEnds = revealAt ? Number(revealAt[1]) + Number(revealAt[2]) : NaN;
  console.log(`crowd sound: reveal finishes at ${revealEnds}s, the crowd roars at ${roarAt?.[1]}s`);
  if (!roarAt || !revealAt || Number(roarAt[1]) < revealEnds - 0.6 || Number(roarAt[1]) > revealEnds + 1.5) {
    throw new Error('the roar must land on the finished tifo, not during the reveal');
  }

  // Both languages, like every other label on that panel.
  for (const k of ['sound', 'soundOn', 'mute', 'crowdNoise', 'volume', 'volMaster', 'volCrowd', 'volSfx',
    'volAmb', 'volDrum', 'reactive', 'weatherSound', 'drum', 'tryApplause', 'tryHorn', 'tryChant',
    'soundBlocked', 'tip.crowdNoise', 'tip.soundOn', 'tip.volCrowd', 'tip.reactive']) {
    const row2 = new RegExp(`'?${k.replace('.', '\\.')}'?\\s*:\\s*\\{.*$`, 'm').exec(overlaySrc2)?.[0] ?? '';
    if (!/\ben:/.test(row2) || !/\bar:/.test(row2)) throw new Error(`sound string "${k}" is missing a translation`);
  }
  console.log('crowd sound: every new label carries en + ar');
}

// ---------------------------------------------------------------------------
// Adding a picture.
//
// The bug this guards against was invisible in every DOM assertion we had: the
// object was in the layer, the panel showed it, the bake was correct — and the
// canvas was empty, because the cursor ghost and the placed object shared one
// cached Pixi texture and the ghost's destroy() took the GPU source with it.
// The live proof lives in scripts/image-ux.mts, which decodes a screenshot and
// counts the picture's own colours. These are the cheap invariants behind it.
{
  const overlaySrc3 = roofRead('src/render/objectOverlay.ts', 'utf8');
  const editorSrc = roofRead('src/render/editor.ts', 'utf8');
  const ownSrc = roofRead('src/render/ownTexture.ts', 'utf8');
  const importSrc = roofRead('src/core/importImage.ts', 'utf8');
  const toolbarSrc = roofRead('src/ui/toolbar.ts', 'utf8');
  const shellSrc = roofRead('src/ui/mobileShell.ts', 'utf8');
  const i18nSrc3 = roofRead('src/ui/i18n.ts', 'utf8');

  // Texture.from() caches by resource identity, so anything that later calls
  // destroy({ textureSource: true }) must NOT use it. Texture.EMPTY is a shared
  // singleton pixi itself protects, and ownTexture is where the skipCache lives.
  const strayFrom = [overlaySrc3, editorSrc]
    .flatMap((src) => src.split('\n'))
    .filter((l) => /Texture\.from\(/.test(l) && !/skipCache|^\s*\*/.test(l));
  console.log('image: shared-texture call sites', strayFrom.length, '| ownTexture uses skipCache',
    /Texture\.from\(source, true\)/.test(ownSrc));
  if (strayFrom.length) throw new Error(`Texture.from() shares a cached texture — use ownTexture(): ${strayFrom[0].trim()}`);
  if (!/Texture\.from\(source, true\)/.test(ownSrc)) throw new Error('ownTexture must skip the cache');

  // Every WebGL device accepts 2048; plenty of phones stop at 4096, and a
  // modern camera hands you more than that on the long edge.
  const cap = Number(/IMPORT_MAX_EDGE = (\d+)/.exec(importSrc)?.[1] ?? 0);
  const capped = /decodeImportBitmap\(file\)/.test(toolbarSrc) && !/createImageBitmap\(file\), name/.test(toolbarSrc);
  console.log(`image: decode capped at ${cap}px on the long edge | the picker uses it`, capped);
  if (!(cap > 0 && cap <= 2048)) throw new Error('IMPORT_MAX_EDGE must stay at or under 2048 — the WebGL floor');
  if (!capped) throw new Error('the image picker must decode through decodeImportBitmap');

  // The cap is only free while the widest possible import still fits inside it.
  // A seat is 3.2 editor units and bake() samples one cell per 3, so the widest
  // grid the editor can ask for is sliderMax * 3.2 / 3 cells.
  const sliderMax = Number(/id="import-width"[^>]*max="(\d+)"/.exec(roofRead('index.html', 'utf8'))?.[1] ?? 0);
  const widestGrid = Math.round((sliderMax * 3.2) / 3);
  console.log(`image: widest import is ${sliderMax} seats = ${widestGrid} cells, fed from ${cap}px`);
  if (!sliderMax || widestGrid > cap) {
    throw new Error(`a ${sliderMax}-seat import wants ${widestGrid} cells but the decode caps at ${cap}px — raise IMPORT_MAX_EDGE or lower the slider`);
  }

  // Place is the only way to put a picture down on a touch screen, because
  // there is no hover and therefore no ghost to aim with. It must never be
  // disabled for a mode, only for "no file yet".
  const placeAlive = /importApply\.disabled = !pendingImport;/.test(toolbarSrc);
  console.log('image: Place stays live in every mode', placeAlive);
  if (!placeAlive) throw new Error('Place must not switch off for the click-on-canvas mode');

  // `body.m-shell .tool-bar { display:none }` hides the import row on a phone,
  // so the shell has to be told when a file has decoded — only the toolbar
  // knows — and it has to cancel the import when that sheet is dismissed.
  const announces = /tifo:import-armed/.test(toolbarSrc) && /tifo:import-done/.test(toolbarSrc);
  const listens = /tifo:import-armed/.test(shellSrc) && /proxy\('#import-cancel'\)/.test(shellSrc);
  console.log('image: the picker announces itself', announces, '| the phone shell answers', listens);
  if (!announces || !listens) throw new Error('a phone must be told when an import arms, and must cancel it on dismiss');

  // The status line is what the user reads after every step of this flow, and
  // it was the one part still hard-coded in English inside an Arabic editor.
  for (const k of ['ed.import.size', 'ed.import.reading', 'ed.import.armed', 'ed.import.failed',
    'ed.import.placed', 'ed.obj.added', 'ed.obj.shapeAdded', 'ed.obj.baked', 'ed.obj.bakedAll',
    'mb.bake', 'mb.objOptions']) {
    const row3 = new RegExp(`'${k.replace(/\./g, '\\.')}':\\s*\\{.*$`, 'm').exec(i18nSrc3)?.[0] ?? '';
    if (!/\ben:/.test(row3) || !/\bar:/.test(row3)) throw new Error(`image-flow string "${k}" is missing a translation`);
  }
  const stillEnglish = toolbarSrc
    .split('\n')
    .filter((l) => /message\.textContent = `/.test(l) && /added|baked|image load|configure the import/.test(l));
  console.log('image: flow strings translated | hard-coded sentences left', stillEnglish.length);
  if (stillEnglish.length) throw new Error(`hard-coded status sentence: ${stillEnglish[0].trim()}`);
}

// ---------------------------------------------------------------------------
// The painting experience.
//
// Five defects the end-to-end audit (scripts/editor-audit.mts) found by
// driving the editor rather than reading it. These are the cheap invariants
// that keep each of them from coming back.
{
  const designSrc = roofRead('src/core/design.ts', 'utf8');
  const editorSrc2 = roofRead('src/render/editor.ts', 'utf8');
  const objectsSrc = roofRead('src/core/objects.ts', 'utf8');
  const toolbarSrc2 = roofRead('src/ui/toolbar.ts', 'utf8');
  const i18nSrc4 = roofRead('src/ui/i18n.ts', 'utf8');

  // 1. The Undo button. onDirty cannot answer "can I undo yet": a brush stroke
  // flushes on every pointer event and COMMITS on pointerup, so the button's
  // last refresh happened before the stroke reached the undo stack. It sat
  // greyed out after the stroke that created something to undo, and lit up
  // during the next one — always exactly one behind.
  const historyHook = /onHistoryChange\(fn: \(\) => void\)/.test(designSrc)
    && /store\.onHistoryChange\(refreshHistory\)/.test(toolbarSrc2);
  const firesOnCommit = /this\.notifyHistory\(\);\n\s*return diff;/.test(designSrc);
  console.log('painting: undo button tracks the stacks', historyHook, '| commitStroke announces it', firesOnCommit);
  if (!historyHook || !firesOnCommit) throw new Error('the Undo button must follow the undo stack, not the dirty set');

  // 2. The canvas has to follow its container. Pixi's resizeTo only listens to
  // WINDOW resize, and the Text/Image/Shape bars resize the host on their own:
  // measured at 1500x900, opening the Text bar left an 818px canvas in a 723px
  // host, so 95px of drawing surface hung out the bottom AND every click landed
  // higher than it was aimed — text placed at the visible centre came down 18
  // rows ABOVE the bowl and baked nothing.
  const watches = /new ResizeObserver\(/.test(editorSrc2) && /watchHost\(canvasHost\)/.test(editorSrc2);
  console.log('painting: the canvas follows its container', watches);
  if (!watches) throw new Error('the editor canvas must be resized by a ResizeObserver, not only by window resize');

  // 3. A bake has to reach the screen. Eight of the nine bake call sites never
  // flushed, so "Bake all" — and the implicit bake before every save and export
  // — wrote the art into the cells and left the bowl showing the old design.
  const bakeFlushes = /store\.commitStroke\(\);\n\s*store\.flush\(dirty\);\n\s*return dirty;/.test(objectsSrc);
  const noDoubleFlush = !/objects\.bake\(sel[^\n]*\n\s*store\.flush\(dirty\)/.test(toolbarSrc2);
  console.log('painting: bake() flushes its own dirty set', bakeFlushes, '| callers no longer have to', noDoubleFlush);
  if (!bakeFlushes) throw new Error('ObjectLayer.bake must flush — nine call sites cannot each be trusted to');

  // 4. The first finger of a two-finger gesture has always already painted a
  // dab. Committing it meant the two-finger-tap undo spent itself undoing the
  // accident: the toast said "Undone" and nothing the user recognised changed.
  const cancels = /cancelStroke\(\): number\[\]/.test(designSrc)
    && /const wasADab =/.test(editorSrc2) && /cancelStroke\(\)/.test(editorSrc2);
  console.log('painting: an accidental first-finger dab is rolled back, not committed', cancels);
  if (!cancels) throw new Error('a second finger must cancel a dab, not commit it');

  // 5. Everything the editor says while you paint. These were hard-coded
  // English, so an Arabic editor answered in English the moment anything
  // happened — and the palette-preset modal was English end to end.
  const stray = toolbarSrc2
    .split('\n')
    .filter((l) => /message\.textContent = [`']/.test(l) && !/i18nT\(|tv\(|= ''/.test(l));
  const dialogs = toolbarSrc2
    .split('\n')
    .filter((l) => /^\s*(title|message|placeholder|confirmLabel|cancelLabel|defaultValue|hint|label):\s*['`]/.test(l));
  console.log(`painting: hard-coded status sentences ${stray.length} | hard-coded dialog copy ${dialogs.length}`);
  if (stray.length) throw new Error(`hard-coded status sentence: ${stray[0].trim()}`);
  if (dialogs.length) throw new Error(`hard-coded dialog copy: ${dialogs[0].trim()}`);
  for (const k of ['ed.msg.legibleOk', 'ed.msg.legibleThin', 'ed.msg.patternApplied', 'ed.msg.signedOut',
    'ed.dlg.applyPalette', 'ed.dlg.remap', 'ed.dlg.namePalette', 'ed.dlg.addCaption']) {
    const row4 = new RegExp(`'${k.replace(/\./g, '\\.')}':\\s*\\{.*$`, 'm').exec(i18nSrc4)?.[0] ?? '';
    if (!/\ben:/.test(row4) || !/\bar:/.test(row4)) throw new Error(`editor string "${k}" is missing a translation`);
  }
  // A pattern's NAME has no string-table entry; its id does, and the id is also
  // what the <option> labels use, so the menu and the message cannot drift.
  if (/tl\(preset\.name\)/.test(toolbarSrc2)) throw new Error('translate the pattern by id, not by name');
  console.log('painting: every status sentence and dialog carries en + ar');
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------
//
// Everything a banner asserts about the physical world is arithmetic, and
// arithmetic can be checked without a browser. These gates hold the numbers the
// Banner view PRINTS — the seam count, the weight, the legible cap height —
// against the rules they came from, in the same posture `verify-stadiumfit`
// takes with the estimator: a stale figure is worse than no figure, because it
// is the number the panel hedges by.
//
// The GEOMETRY is not here. It has its own test — `npm run sweep:banner` —
// which enumerates every slot on every ground for both kinds and checks eight
// properties of each. That is the difference between this round and the four
// before it: the space a banner can be in is finite now, so it is proved
// rather than sampled.
{
  const {
    BANNER_KINDS, KIND_PROFILE, PANEL_MAX_M, KG_PER_CARRIER,
    applyKind, bannerFacts, newBanner, normalise, revealEase, occludesCrowd,
    estimateSize, physicalRevealMs, TYPICAL_BLOCK_M, BANNER_PRESETS, presetOf,
  } = await import('../src/core/banner');

  // 1. A reveal runs from nothing to done. An easing that starts above zero
  // shows the banner already up; one that does not finish at one leaves it
  // forever short.
  {
    for (const mode of ['unroll', 'hoist', 'cut'] as const) {
      if (Math.abs(revealEase(mode, 0)) > 1e-6) throw new Error(`reveal "${mode}" does not start at 0`);
      if (Math.abs(revealEase(mode, 1) - 1) > 1e-6) throw new Error(`reveal "${mode}" does not finish at 1`);
      for (let k = 0; k <= 20; k++) {
        const e = revealEase(mode, k / 20);
        // A banner may overshoot its rig — that is weight on a rope — but not
        // by a quarter of its own length.
        if (e < -0.25 || e > 1.25) throw new Error(`reveal "${mode}" leaves the sheet at ${e.toFixed(2)}`);
      }
    }
    console.log('banners: every reveal runs 0 -> 1 and stays in range');
  }

  // 2. Seams. The hardest constraint in tifo design, and the one the app has
  // to show: fabric comes in 3 m panels.
  {
    const d = newBanner('stand');
    const f = bannerFacts(d, { widthM: 2.9, heightM: 1.5 });
    if (f.seamsM.length !== 0) throw new Error('a banner inside one panel has no seams');
    const g = bannerFacts(d, { widthM: 70, heightM: 35 });
    if (g.seamsM.length !== Math.ceil(70 / PANEL_MAX_M) - 1) throw new Error(`70 m of fabric is ${g.seamsM.length} seams`);
    console.log('banners: seam count follows the 3 m panel, from 2.9 m to 70 m');
  }

  // 3. Weight, against a published flag: 70 x 120 m at 90 g/m² is 756 kg.
  {
    const d = { ...newBanner('stand'), fabricGsm: 90 };
    const f = bannerFacts(d, { widthM: 120, heightM: 70 });
    if (Math.abs(f.weightKg - 756) > 20) throw new Error(`a 70x120 m flag weighs ${f.weightKg.toFixed(0)} kg, not 756`);
    if (f.carriers !== Math.ceil(f.weightKg / KG_PER_CARRIER)) throw new Error('carriers must follow the mass');
    console.log('banners: weight matches the published 70x120 m / 760 kg flag');
  }

  // 4. Legibility. A letter has to subtend enough angle to read from the far
  // side of the ground, which is 1/200 of the viewing distance as a floor.
  {
    const f = bannerFacts(newBanner('stand'), { widthM: 37, heightM: 18 }, 100);
    // 1:40, not signage's 1:120: a tifo is glanced at for two minutes across
    // a moving crowd, and the letters have to survive a broadcast crop.
    if (Math.abs(f.headlineCapM - 2.5) > 0.2) throw new Error(`100 m asks for ${f.headlineCapM.toFixed(2)} m of cap height, not 2.5`);
    console.log('banners: 100 m of viewing distance asks for 2.5 m of headline');
  }

  // 5. Two kinds, both profiled, and the occlusion split between them. A sheet
  // over the terracing hides the mosaic under it; one flown in the air does
  // not, and the panel says so before anyone spends a choreo on it.
  {
    if (BANNER_KINDS.length !== 2) throw new Error(`there should be two banner kinds, not ${BANNER_KINDS.length}`);
    for (const k of BANNER_KINDS) {
      if (!KIND_PROFILE[k]) throw new Error(`banner kind "${k}" has no profile`);
    }
    if (!occludesCrowd(newBanner('stand'))) throw new Error('a stand banner lies on the seats; that is what it IS');
    if (occludesCrowd(newBanner('hanging'))) throw new Error('a hanging banner is in the air — it must not hide the mosaic');
    console.log('banners: two kinds, and the occlusion split holds');
  }

  // 5b. The presets are real places on a real stand, and each one is distinct.
  //
  // A preset that resolves to the same sheet as the one above it is a menu
  // entry that does nothing, which is exactly the complaint the span picker
  // earned. These are checked against a built bowl rather than against their
  // own numbers.
  {
    const { generateSeatMap } = await import('../src/core/seatmap');
    const { STADIUM_CATALOG } = await import('../src/core/stadiumCatalog');
    const { buildStandFrame } = await import('../src/render/simulator/standFrame');
    const { resolveSlot } = await import('../src/render/simulator/bannerSlot');
    const frame = buildStandFrame(generateSeatMap(STADIUM_CATALOG[0].template), 1);
    const seen: string[] = [];
    for (const b of BANNER_PRESETS) {
      const doc = { ...newBanner('stand'), aspect: b.aspect, slot: { ...newBanner('stand').slot, blockSpan: b.blockSpan } };
      if (presetOf(doc) !== b.id) throw new Error(`preset "${b.id}" does not recognise itself`);
      const r = resolveSlot(doc, frame);
      const key = `${r.size.widthM.toFixed(0)}x${r.size.heightM.toFixed(0)}`;
      if (seen.includes(key)) throw new Error(`preset "${b.id}" draws the same ${key} m sheet as another`);
      seen.push(key);
      if (!(r.size.widthM > 1) || !(r.size.heightM > 1)) throw new Error(`preset "${b.id}" is not a banner`);
    }
    // And the shape slider can sit between them, which is what "custom" means.
    if (presetOf({ ...newBanner('stand'), aspect: 0.77 }) !== null) {
      throw new Error('a shape between the presets must read as custom');
    }
    console.log(`banners: ${BANNER_PRESETS.length} presets, each a different sheet on a real stand`);
  }

  // 6. Changing type re-rigs the banner but keeps a shape the user chose.
  {
    const a = applyKind(newBanner('stand'), 'hanging');
    if (a.reveal !== KIND_PROFILE.hanging.reveal) throw new Error('a type change must bring its own reveal');
    const custom = { ...newBanner('stand'), aspect: 0.31 };
    const moved = applyKind(custom, 'hanging');
    if (Math.abs(moved.aspect - 0.31) > 1e-9) throw new Error('a shape the user chose must survive a type change');
    if (moved.slot.stand !== custom.slot.stand) throw new Error('a type change must not move the banner to another stand');
    console.log('banners: a type change re-rigs without discarding a chosen shape');
  }

  // 7. Anything stored is filled in and clamped on the way back.
  {
    const junk = {
      id: 'x', name: 'n', kind: 'nonsense', aspect: 99, material: 'nope', fabricGsm: -5,
      items: [{ kind: 'text', text: 'hi' }], slot: { stand: 9, blockFrom: -4, blockSpan: 0, tier: 77 },
      reveal: 'teleport', revealMs: -1, wind: 5,
    } as unknown as Parameters<typeof normalise>[0];
    const n = normalise(junk);
    if (!BANNER_KINDS.includes(n.kind)) throw new Error('an unknown kind must come back as a real one');
    if (n.aspect > 6 || n.aspect < 0.05) throw new Error('aspect must be clamped to something a banner can be');
    if (n.slot.stand < 0 || n.slot.stand > 3) throw new Error('a banner must be on one of the four stands');
    if (n.slot.blockSpan < 1) throw new Error('a banner covers at least one block');
    if (n.wind < 0 || n.wind > 1) throw new Error('wind is a fraction');
    console.log('banners: a stored banner is filled in and clamped on the way back');
  }

  // 8. The reveal duration is a physical time, not a constant.
  //
  // A twenty-metre sheet hauled up on ropes at half a metre a second takes
  // forty seconds, and a rolled cover paid out over a block takes a few. The
  // first version of this gave everything 4.2 seconds, which is why the very
  // first thing Osamah said about a reveal was that it was too fast.
  {
    const small = physicalRevealMs('stand', { widthM: 10, heightM: 5 });
    const big = physicalRevealMs('stand', { widthM: 80, heightM: 40 });
    if (!(big > small * 2)) throw new Error(`a 40 m drop (${big} ms) must take far longer than a 5 m one (${small} ms)`);
    const d = newBanner('stand');
    const s = estimateSize(d);
    if (Math.abs(s.widthM - KIND_PROFILE.stand.blockSpan * TYPICAL_BLOCK_M) > 1e-6) {
      throw new Error('a new banner is as wide as the blocks its profile covers');
    }
    console.log('banners: a reveal takes the time the physical thing takes');
  }

  // 9. The slot model, on real grounds.
  //
  // The whole space is swept by `npm run sweep:banner`; what is checked here
  // is the CONTRACT the rest of the app leans on — that a slot resolves to
  // something inside the stand, that the size comes out of the blocks rather
  // than out of a text field, and that the enumeration the panel's pickers
  // are built from agrees with the resolver.
  {
    const { generateSeatMap } = await import('../src/core/seatmap');
    const { STADIUM_CATALOG } = await import('../src/core/stadiumCatalog');
    const { buildStandFrame } = await import('../src/render/simulator/standFrame');
    const { resolveSlot, slotsOf, slotCount } = await import('../src/render/simulator/bannerSlot');

    for (const entry of STADIUM_CATALOG.slice(0, 4)) {
      const map = generateSeatMap(entry.template);
      const id = entry.template.id;
      for (const stand of [0, 1, 2, 3] as const) {
        const frame = buildStandFrame(map, stand);
        if (!frame.ok) continue;

        // The blocks are real places, in order, and none of them is a corner
        // curl: a stand's ends are where its parameterisation is worst, and a
        // four-metre doubled-back fragment is not somewhere a banner goes.
        let prev = -1;
        for (const b of frame.blocks) {
          if (b.u0 < prev - 1e-9) throw new Error(`${id}/${stand}: blocks are out of order`);
          if (b.u1 <= b.u0) throw new Error(`${id}/${stand}: a block with no width`);
          if (b.widthM < 6) throw new Error(`${id}/${stand}: a ${b.widthM.toFixed(1)} m block is a corner curl, not a place`);
          prev = b.u1;
        }

        const slots = slotsOf(frame, stand);
        if (slots.length !== slotCount(frame)) {
          throw new Error(`${id}/${stand}: ${slots.length} slots enumerated, ${slotCount(frame)} counted`);
        }

        for (const kind of BANNER_KINDS) {
          for (const slot of slots) {
            const res = resolveSlot({ ...newBanner(kind), slot }, frame);
            if (!(res.size.widthM > 0) || !(res.size.heightM > 0)) {
              throw new Error(`${id}/${stand}/${kind}: a slot with no size`);
            }
            if (res.u0 < -1e-9 || res.u1 > 1 + 1e-9 || res.u1 <= res.u0) {
              throw new Error(`${id}/${stand}/${kind}: a banner off the end of its stand`);
            }
            if (res.vBottom < res.v0 - 1e-6 || res.vBottom > res.v1 + 1e-6) {
              throw new Error(`${id}/${stand}/${kind}: the bottom edge is outside the band it belongs to`);
            }
            if (res.size.heightM > res.maxHeightM + 1e-6) {
              throw new Error(`${id}/${stand}/${kind}: ${res.size.heightM.toFixed(1)} m of sheet in a ${res.maxHeightM.toFixed(1)} m slot`);
            }
            // The size follows the blocks. This is the answer to "I can pick
            // any size in the editor and it breaks in Match Day": there is no
            // size to pick any more.
            if (res.size.widthM > res.maxWidthM + 1e-6) {
              throw new Error(`${id}/${stand}/${kind}: a banner wider than the blocks it covers`);
            }
          }
        }

        // The artwork's shape drives the depth, and a slot that cannot take it
        // scales both together rather than squashing one.
        const tall = resolveSlot({ ...newBanner('stand'), aspect: 6 }, frame);
        if (Math.abs(tall.size.heightM / tall.size.widthM - 6) > 0.01 && !tall.heightLimited) {
          throw new Error(`${id}/${stand}: a 6:1 design came out at ${(tall.size.heightM / tall.size.widthM).toFixed(2)}:1`);
        }
        if (tall.heightLimited && Math.abs(tall.size.heightM / tall.size.widthM - 6) > 0.01) {
          throw new Error(`${id}/${stand}: a cut banner must keep its proportions`);
        }
      }
    }
    console.log('banners: every slot on four grounds resolves inside its stand, at a size the blocks decide');
  }

  // 10. Every banner string carries both languages. The two original phone bug
  // reports were both written in Arabic; an English-only sentence in this view
  // is the same failure in a new place.
  {
    // A window after the key, not a braces match: a sentence with a named
    // placeholder ("Banner {n}") closes a brace inside its own value, and the
    // obvious `\{([^}]*)\}` stops there and declares the Arabic missing.
    const { readFileSync: bnRead } = await import('node:fs');
    const i18nBn = bnRead('src/ui/i18n.ts', 'utf8');
    const keys = [...i18nBn.matchAll(/^\s*'((?:bn|ed\.view)\.[\w.]+)':/gm)];
    if (keys.length < 40) throw new Error(`only ${keys.length} banner strings found — the scan is not finding the table`);
    for (const m of keys) {
      const body = i18nBn.slice(m.index ?? 0, (m.index ?? 0) + 420);
      if (!/\ben:/.test(body) || !/\bar:/.test(body)) throw new Error(`banner string "${m[1]}" is missing a translation`);
    }
    // Every note the facts function can emit has to have a sentence.
    for (const note of ['seams', 'carry', 'mesh', 'wind', 'net', 'occludes', 'fire']) {
      if (!i18nBn.includes(`'bn.note.${note}'`)) throw new Error(`the note "${note}" has no sentence`);
    }
    console.log(`banners: ${keys.length} strings, all with en + ar`);
  }
}
