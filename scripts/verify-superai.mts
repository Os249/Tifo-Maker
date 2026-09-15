/**
 * Phase 1 + 2 (Super AI) verification - runs against the REAL seat map.
 *   npm run verify:superai      (or: npx tsx scripts/verify-superai.mts)
 * Throws on any failed invariant; prints a summary otherwise.
 */
import { readFileSync } from 'node:fs';
import { generateSeatMap } from '../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../src/core/template';
import { buildStadiumContext, describeStadiumContext } from '../src/core/stadiumContext';
import { normalizeRegion, standIndexOfU, STAND_ORDER, validateSpec, narrowToSingleStand, standRun, isContiguousRegion, regionAspectHint, type SpecLayer } from '../src/core/tifoSpec';
import { regionPredicate } from '../src/core/specCompiler';
import { SUPER_AI_EXEMPLARS, fewShotBlock } from '../src/core/exemplars';
import { critiqueDesign, repairSpec } from '../src/core/critique';
import { composeSuperOffline, designFromPrompt, designShuffle } from '../src/core/promptDesigner';
import { matchClub, CLUBS } from '../src/core/clubs';
import { quantizePixels, halftoneCellFor, cutoutBackground } from '../src/core/importImage';
import { TtlCache, cacheKey } from '../server/src/aiCache';
import { aiPeriod, secondsToNextPeriod } from '../server/src/repo';
import { buildDirectorPrompt, buildSystemPrompt, buildCriticPrompt, clubHintLine, userMessage, criticUserMessage, buildCopywriterPrompt, copyLine, geminiText, whyNoJson, maxOutputTokens } from '../server/src/aiProvider';
import { TIFO_FONTS } from '../src/core/text';
import { envNum } from '../server/src/env';
import { mosaicStyle, colourName, pollinationsSize, geminiAspect } from '../server/src/imageAssets';
import { regionRowsHint } from '../src/core/tifoSpec';
import { TIFO_VOICES } from '../src/core/tifoVoices';
import { refineSpec, contrastRatio } from '../src/core/specRefine';
import { SPEC_FONT_IDS } from '../src/core/tifoSpec';

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

// ---- 9. offline multi-stand composer (Super AI fallback, no model call) ----
const offPlayer = composeSuperOffline('farewell to Ronaldo, red white and black, full stadium');
const offValid = validateSpec(offPlayer);
check('offline composer output validates', offValid.valid, offValid.valid ? '' : JSON.stringify(offValid.errors));
const offStands = new Set<string>();
for (const l of offPlayer.layers) { if (l.region.stands) l.region.stands.forEach((s) => offStands.add(s)); else offStands.add(l.region.stand); }
check('offline composer is multi-stand (all four)', ['north', 'south', 'east', 'west'].every((s) => offStands.has(s)), [...offStands].join(','));
check('offline composer: player brief yields a portrait image layer', offPlayer.layers.some((l) => l.kind === 'image'));
const offEagle = composeSuperOffline('giant eagle covering the stadium in black and gold');
check('offline composer: symbol brief yields a symbol layer', offEagle.layers.some((l) => l.kind === 'symbol'));

// ---- 10. occasion-aware composer variety (free path) ----
const derbySpec = composeSuperOffline('city derby vs united, red and black');
check('derby: validates + chevron pattern', validateSpec(derbySpec).valid && derbySpec.layers.some((l) => l.kind === 'pattern'));
const titleSpec = composeSuperOffline('champions of europe, gold and black');
check('title: validates + gradient field', validateSpec(titleSpec).valid && titleSpec.layers.some((l) => l.kind === 'gradient'));
const anniSpec = composeSuperOffline('100 years anniversary, green and white');
check('anniversary: validates + mosaic pattern', validateSpec(anniSpec).valid && anniSpec.layers.some((l) => l.kind === 'pattern'));
const genSpec = composeSuperOffline('blue and white full stadium');
check('occasions differ from the generic layout', derbySpec.summary !== genSpec.summary && titleSpec.summary !== genSpec.summary && anniSpec.summary !== genSpec.summary);

// ---- 11. result cache (Wave 1: tokens + fewer calls) ----
const cc = new TtlCache<number>(2, 60000);
cc.set('a', 1); cc.set('b', 2); cc.get('a'); cc.set('c', 3); // touch a, then overflow evicts b
check('cache: LRU evicts least-recently-used', cc.get('b') === undefined && cc.get('a') === 1 && cc.get('c') === 3);
check('cache: keys separate parts (no collision)', cacheKey('a', 'b') !== cacheKey('ab', ''));
check('cache: expired entry is dropped', (() => { const t = new TtlCache<number>(5, -1); t.set('x', 9); return t.get('x') === undefined; })());

// ---- 12. club-identity presets (Wave 3: free accuracy) ----
check('club: barcelona → blaugrana', matchClub('barcelona derby')?.palette[0] === '#a50044');
check('club: unknown brief → null', matchClub('a plain blue and white tifo') === null);
const clubSpec = composeSuperOffline('real madrid champions tifo');
check('club: composer adopts the club palette', clubSpec.palette.includes('#febe10'));

// ---- 13. offline variant / shuffle (Wave 4: free variety) ----
const v1 = composeSuperOffline('blue white and red full stadium', { variant: 1 });
const v2 = composeSuperOffline('blue white and red full stadium', { variant: 2 });
check('variant: different seeds produce different designs', JSON.stringify(v1.palette) !== JSON.stringify(v2.palette));
check('variant: still validates', validateSpec(v1).valid && validateSpec(v2).valid);


// ---- 14. shipped display voices + the new layer controls ----
const LEGACY_STACKS: Record<string, string> = {
  impact: 'Impact, "Arial Black", sans-serif',
  black: '"Arial Black", Arial, sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  courier: '"Courier New", Courier, monospace',
};
// REGRESSION GUARD: every design saved before the voices shipped names one of
// these ids. If a stack changes here, all of them silently re-render.
for (const [id, css] of Object.entries(LEGACY_STACKS)) {
  const f = TIFO_FONTS.find((x) => x.id === id);
  check(`legacy font "${id}" unchanged`, f?.css === css, f?.css ?? 'missing');
}
check('every voice has a spec id', TIFO_VOICES.every((v) => (SPEC_FONT_IDS as readonly string[]).includes(v.id)));
check('every voice id maps to its family', TIFO_VOICES.every((v) => TIFO_FONTS.some((f) => f.id === v.id && f.css.includes(v.family))));
check('every voice documents its face pair', TIFO_VOICES.every((v) => !!v.pair && !!v.note));
check('voice ids are unique', new Set(TIFO_VOICES.map((v) => v.id)).size === TIFO_VOICES.length);

check('contrastRatio: black vs white is 21:1', Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01);
check('contrastRatio: a colour against itself is 1:1', Math.abs(contrastRatio('#0033a0', '#0033a0') - 1) < 1e-9);

const withControls = validateSpec({
  title: 'controls', palette: ['#262a33', '#0d0d0f', '#f5c518'],
  layers: [
    { kind: 'fill', region: 'south', colorIndex: 2 },
    { kind: 'text', region: 'south', text: 'HELLO', colorIndex: 1, fontId: 'condensed', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: 6, stretch: 2, dx: 1, dy: 4 },
    { kind: 'symbol', region: 'north', symbol: 'eagle', colorIndex: 2, scaleFrac: 0.9, align: 'center', wide: 3 },
  ],
});
check('new layer controls validate', withControls.valid, JSON.stringify(withControls.errors ?? []));
const tl = withControls.spec?.layers[1] as { outline?: number; stretch?: number; dx?: number; dy?: number } | undefined;
const sl = withControls.spec?.layers[2] as { wide?: number } | undefined;
check('outline/stretch/dx/dy survive validation', tl?.outline === 6 && tl?.stretch === 2 && tl?.dx === 1 && tl?.dy === 4, JSON.stringify(tl));
check('symbol wide survives validation', sl?.wide === 3);

const clamped = validateSpec({
  title: 'clamp', palette: ['#262a33', '#111111', '#ffffff'],
  layers: [{ kind: 'text', region: 'south', text: 'X', colorIndex: 2, fontId: 'poster', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: 999, stretch: 99, dx: -999 }],
});
const cl = clamped.spec?.layers[0] as { outline?: number; stretch?: number; dx?: number } | undefined;
check('out-of-range controls are clamped, not rejected', clamped.valid && cl?.outline === 24 && cl?.stretch === 6 && cl?.dx === -20, JSON.stringify(cl));

// An outlined headline is two layers: a fattened backing copy, then the plain
// one. refineSpec must leave the backing copy alone — "repairing" its contrast
// recolours it to match the copy on top and erases the outline.
const outlined = validateSpec({
  title: 'outline pair', palette: ['#262a33', '#0d0d0f', '#f5c518'],
  layers: [
    { kind: 'fill', region: 'south', colorIndex: 2 },
    { kind: 'text', region: 'south', text: 'GRAZIE', colorIndex: 2, fontId: 'condensed', arcDeg: 0, heightFrac: 0.8, align: 'center', outline: 6 },
    { kind: 'text', region: 'south', text: 'GRAZIE', colorIndex: 1, fontId: 'condensed', arcDeg: 0, heightFrac: 0.8, align: 'center' },
  ],
});
check('outline pair validates', outlined.valid, JSON.stringify(outlined.errors ?? []));
const refinedPair = refineSpec(outlined.spec!);
check('backing layer keeps its colour', (refinedPair.layers[1] as { colorIndex: number }).colorIndex === 2, String((refinedPair.layers[1] as { colorIndex: number }).colorIndex));
check('top layer keeps its colour', (refinedPair.layers[2] as { colorIndex: number }).colorIndex === 1);

// A lone low-contrast headline still gets repaired.
const muddy = validateSpec({
  title: 'muddy', palette: ['#262a33', '#04341c', '#062a13', '#ffffff'],
  layers: [
    { kind: 'fill', region: 'south', colorIndex: 1 },
    { kind: 'text', region: 'south', text: 'MUD', colorIndex: 2, fontId: 'poster', arcDeg: 0, heightFrac: 0.8, align: 'center' },
  ],
});
const fixedMud = refineSpec(muddy.spec!);
check('1.12:1 headline is repaired away from the field', (fixedMud.layers[1] as { colorIndex: number }).colorIndex === 3, String((fixedMud.layers[1] as { colorIndex: number }).colorIndex));


// ---- 15. display voices and outline pairs on the free (offline) path ----
const VOICE_IDS = new Set(TIFO_VOICES.map((v) => v.id));

/**
 * Every text layer carrying an outline or an offset must be immediately followed
 * by its plain twin, agreeing on everything specRefine.isBacking keys off. A
 * lone or mismatched backing layer renders as a fat blob, or gets recoloured to
 * match the copy on top and vanishes — both silent.
 */
function pairsWellFormed(layers: SpecLayer[]): boolean {
  return layers.every((l, i) => {
    if (l.kind !== 'text') return true;
    if ((l.outline ?? 0) === 0 && (l.dx ?? 0) === 0 && (l.dy ?? 0) === 0) return true;
    const n = layers[i + 1];
    return !!n && n.kind === 'text' && n.text === l.text
      && JSON.stringify(n.region) === JSON.stringify(l.region)
      && n.fontId === l.fontId && n.heightFrac === l.heightFrac
      && n.arcDeg === l.arcDeg && n.align === l.align && (n.stretch ?? 1) === (l.stretch ?? 1);
  });
}

const OFFLINE_BRIEFS = [
  'city derby vs united, red and black',
  'farewell to Ronaldo, red white and black, full stadium',
  '100 years anniversary, green and white',
  'champions of europe, gold and black',
  'الهلال بطل آسيا، الملعب كامل',
  'heritage stripes for the whole bowl',
  'blue and white full stadium',
];
let offBad = 0;
let offPairs = 0;
for (const b of OFFLINE_BRIEFS) {
  for (const v of [0, 1, 2]) {
    const sp = composeSuperOffline(b, { variant: v });
    if (!validateSpec(sp).valid) offBad++;
    if (!sp.layers.every((l) => l.kind !== 'text' || VOICE_IDS.has(l.fontId))) offBad++;
    if (!pairsWellFormed(sp.layers)) offBad++;
    const refined = refineSpec(sp);
    for (let i = 0; i < sp.layers.length; i++) {
      const l = sp.layers[i];
      if (l.kind !== 'text' || (l.outline ?? 0) === 0) continue;
      offPairs++;
      const plain = sp.layers[i + 1] as { colorIndex: number };
      // An outline nobody can see is worse than no outline at all.
      if (contrastRatio(sp.palette[l.colorIndex], sp.palette[plain.colorIndex]) < 3) offBad++;
      // refineSpec must not "repair" the backing half back into the fill colour.
      if ((refined.layers[i] as { colorIndex: number }).colorIndex !== l.colorIndex) offBad++;
    }
  }
}
check('offline: 21 compositions are valid, voiced, paired and legible', offBad === 0, `${offBad} failures`);
check('offline: outline pairs are actually emitted', offPairs >= OFFLINE_BRIEFS.length, `${offPairs} pairs`);
check('offline: designFromPrompt uses display voices too',
  designFromPrompt('CHAMPIONS across the stadium in red and white').layers.every((l) => l.kind !== 'text' || VOICE_IDS.has(l.fontId)));
check('offline: a short squad number gets the widest stretch',
  composeSuperOffline('ronaldo 7 farewell in red and black').layers.some((l) => l.kind === 'text' && (l.stretch ?? 1) >= 2.2));

// designShuffle exists because the UI shuffle used to skip refineSpec entirely.
const shuf = designShuffle('blue white and red full stadium', 3);
check('designShuffle === refineSpec(composeSuperOffline)',
  JSON.stringify(shuf) === JSON.stringify(refineSpec(composeSuperOffline('blue white and red full stadium', { variant: 3 }))));
check('designShuffle output clears the legibility floors',
  shuf.layers.every((l) => (l.kind !== 'text' || l.heightFrac >= 0.22) && (l.kind !== 'symbol' || l.scaleFrac >= 0.45)));

// ---- 16. club matching is ranked, not first-club-wins ----
// The structural test: this fails on the old loop and no future club addition
// can break it silently.
const strays = CLUBS.flatMap((c) => c.aliases.filter((a) => matchClub(a) !== c));
check('every alias resolves to its own club', strays.length === 0, strays.join(', '));
check('collision fixed: inter milan is not AC Milan', matchClub('inter milan derby')?.palette[0] === '#0068a8');
check('collision fixed: atletico madrid is not Real', matchClub('atletico madrid at home')?.palette[0] === '#cb3524');
check('collision fixed: Egyptian Al Ahly is not Saudi', matchClub('الأهلي المصري')?.palette[0] === '#c8102e');
check('no regression: al ahli jeddah is still Saudi', matchClub('al ahli jeddah')?.palette[0] === '#0a7d3e');
check('no regression: ac milan', matchClub('ac milan tifo')?.palette[0] === '#fb090b');
check('short latin aliases need word boundaries', matchClub('an international friendly') === null);
check('arabic aliases still match with glued prefixes', matchClub('تيفو بالهلال') !== null);


// ---- 17. the prompts teach what the renderer can now draw ----
const PROMPTS = [
  ['system', buildSystemPrompt()],
  ['director', buildDirectorPrompt()],
  ['critic', buildCriticPrompt()],
] as const;
for (const [name, p] of PROMPTS) {
  check(`${name} prompt teaches the five controls`,
    ['outline', 'stretch', '"dx"', '"dy"', 'wide'].every((k) => p.includes(k)));
  check(`${name} prompt states the 3:1 floor`, p.includes('3:1'));
  check(`${name} prompt names every display voice`, TIFO_VOICES.every((v) => p.includes(v.id)));
  check(`${name} prompt warns off the legacy stacks`, p.includes('Legacy device fonts'));
}
// A white edge on a gold field is 1.43:1 — the fattened copy swallows the
// letterform instead of ringing it. The prompt has to say when NOT to outline.
check('prompts say an outline needs contrast against the field too',
  [PROMPTS[0][1], PROMPTS[1][1]].every((p) => p.includes('ONLY outline when') && p.includes('separate from BOTH')));
check('system + director show the two-layer outline pair',
  [PROMPTS[0][1], PROMPTS[1][1]].every((p) => p.includes('TWO LAYERS') && p.includes('immediately after')));
check('critic is told to preserve pairs and the new fields',
  PROMPTS[2][1].includes('keep BOTH') && PROMPTS[2][1].includes('Never drop'));
check('director carries whole-bowl rules that std does not',
  PROMPTS[1][1].includes('foreshortened') && !PROMPTS[0][1].includes('foreshortened'));
// Budgets: these are paid on EVERY generation, so a future edit that quietly
// adds 400 tokens should fail here rather than on the invoice. Raising a cap is
// allowed — deliberately, with the reason written down. The last raise (6500 →
// 7100, 10900 → 11600) bought three things the renderer could not be told about
// before: that a palette's headroom goes on TONES rather than more hues, that a
// picture is generated at its region's shape and in the design's own palette,
// and that "fit"/"stands" exist. The two duplicated portrait paragraphs each
// prompt used to carry were fused to pay for part of it. The raise after that
// (7100 -> 7900, 11600 -> 12400) bought the measured Arabic sizing rule and the
// instruction to make a PICTURE the hero rather than a flat vector symbol —
// the two things a rendered bowl showed were missing. The one after that
// (-> 8400, 12700) paid for the cutout contract and for spelling out WHY the
// index-0 margin must not be repeated across stands, since the short version
// of that rule is what produced a letterboxed bowl.
check('system prompt within budget', PROMPTS[0][1].length <= 8400, `${PROMPTS[0][1].length}`);
// The director is premium-only and capped by AI_DAILY_BUDGET, and ~40% of it is
// the few-shot gallery — the highest-leverage tokens in the whole system.
check('director prompt within budget', PROMPTS[1][1].length <= 12700, `${PROMPTS[1][1].length}`);
check('critic prompt within budget', PROMPTS[2][1].length <= 3000, `${PROMPTS[2][1].length}`);
check('few-shot gallery within budget', fewShotBlock().length <= 5000, `${fewShotBlock().length}`);

// ---- 18. the gallery is a design the product actually renders ----
let galBad = 0;
for (const ex of SUPER_AI_EXEMPLARS) {
  const r = validateSpec(ex.spec);
  if (!r.valid || !r.spec) { galBad++; continue; }
  const L = r.spec.layers;
  if (!L.every((l) => l.kind !== 'text' || VOICE_IDS.has(l.fontId))) galBad++;
  // "east" straddles the bowl seam, so text there breaks apart.
  if (!L.every((l) => l.kind !== 'text' || (l.region.stand !== 'east' && !l.region.stands?.includes('east')))) galBad++;
  if (!pairsWellFormed(L)) galBad++;
  // If refineSpec rewrites an exemplar, the gallery teaches a design we do not render.
  if (JSON.stringify(refineSpec(r.spec).layers) !== JSON.stringify(L)) galBad++;
}
check('every exemplar is valid, voiced, off the seam, paired and refiner-clean', galBad === 0, `${galBad} failures`);
const galleryKeys = new Set(SUPER_AI_EXEMPLARS.flatMap((e) => e.spec.layers.flatMap((l) => Object.keys(l))));
check('gallery demonstrates all five new controls',
  ['outline', 'stretch', 'dx', 'dy', 'wide'].every((k) => galleryKeys.has(k)));
check('gallery demonstrates index-0 negative space',
  SUPER_AI_EXEMPLARS.some((e) => e.spec.layers.some((l) => l.kind === 'fill' && l.colorIndex === 0)));
check('gallery includes an Arabic exemplar',
  SUPER_AI_EXEMPLARS.some((e) => /[\u0600-\u06FF]/.test(JSON.stringify(e.spec))));
check('gallery tells the model not to copy its content', fewShotBlock().includes('never reuse their words'));

// ---- 19. club colours reach the model, and never reach the critic ----
check('club hint carries the palette and the crest',
  clubHintLine('al hilal tifo').includes('#0033a0') && clubHintLine('al hilal tifo').includes('crescent'));
check('no club → no hint', clubHintLine('a plain blue and white tifo') === '');
check('club hint stays short', clubHintLine('manchester united derby').length <= 260, `${clubHintLine('manchester united derby').length}`);
check('hint lands in the user turn', userMessage('al hilal', undefined, clubHintLine('al hilal')).includes('#0033a0'));
check('no hint passed → no hint text', !userMessage('al hilal').includes('#0033a0'));
// THE HAZARD: the critic's "prompt" is a spec blob full of club words and hexes.
const baitSpec = {
  title: 'Inter Milan derby',
  palette: ['#262a33', '#0068a8'],
  layers: [{ kind: 'text', region: 'south', text: 'AL HILAL', colorIndex: 1, fontId: 'poster', arcDeg: 0, heightFrac: 0.8, align: 'center' }],
};
check('critic user turn never carries a club hint',
  !criticUserMessage(baitSpec, 'Stadium: 60,000 seats').includes('CLUB COLOURS') && clubHintLine(JSON.stringify(baitSpec)) !== '');


// ---- 20. the copywriter stage ----
const cw = buildCopywriterPrompt();
check('copywriter asks for words only', cw.includes('you do not design') || cw.includes('do not design anything'));
check('copywriter caps the word count', cw.includes('One to three words'));
check('copywriter prefers the terrace name', cw.toLowerCase().includes('nickname'));
check('copywriter offers every voice', TIFO_VOICES.every((v) => cw.includes(v.id)));
check('copywriter prompt stays cheap', cw.length <= 2200, `${cw.length}`);

const copied = copyLine({ phrase: 'زعيم آسيا', support: 'AFC 2026', language: 'ar', mood: 'triumphant', voice: 'poster' });
check('copy block carries the hero, the support and the voice',
  copied.includes('زعيم آسيا') && copied.includes('AFC 2026') && copied.includes('poster'));
check('copy block forbids paraphrasing', copied.includes('do not invent your own'));
check('no copy → no block', copyLine(null) === '');
check('director is told the COPY block is authoritative',
  PROMPTS[1][1].includes('COPY block') && PROMPTS[1][1].includes('do not translate'));

// ---- 21. the free-quota period is a switch, and hourly is still the default ----
const at2130 = new Date(Date.UTC(2026, 8, 14, 21, 30, 0));
delete process.env.AI_PERIOD;
check('default period is hourly', aiPeriod(at2130) === '2026-09-14T21' && secondsToNextPeriod(at2130) === 1800);
process.env.AI_PERIOD = 'day';
check('AI_PERIOD=day buckets by UTC day', aiPeriod(at2130) === '2026-09-14' && secondsToNextPeriod(at2130) === 9000);
delete process.env.AI_PERIOD;
check('period switch is reversible', aiPeriod(at2130) === '2026-09-14T21');

// ---- 22. stand runs: which regions one picture can span (Wall 2) ----
const runOf = (r: Parameters<typeof standRun>[0]): string => {
  const x = standRun(r);
  return x ? `${x.start}+${x.len}` : 'none';
};
check('a single stand is a run of one', runOf({ stand: 'west', tier: 'all' }) === '2+1');
check('the whole bowl is a run of four', runOf({ stand: 'all', tier: 'all' }) === '0+4');
check('sides (east|west) is NOT a run', !isContiguousRegion(normalizeRegion('sides')!));
check('ends (north|south) is NOT a run', !isContiguousRegion(normalizeRegion('ends')!));
check('adjacent stands are a run', runOf({ stand: 'all', tier: 'all', stands: ['north', 'west'] }) === '1+2');
check('a run may wrap the u=0 seam', isContiguousRegion({ stand: 'all', tier: 'all', stands: ['south', 'east'] }));
check('order within stands[] does not matter',
  runOf({ stand: 'all', tier: 'all', stands: ['west', 'north'] }) === runOf({ stand: 'all', tier: 'all', stands: ['north', 'west'] }));
// The run's extent must match what STAND_ORDER says, or a picture lands off its stands.
for (const [a, b] of [['east', 'north'], ['north', 'west'], ['west', 'south'], ['south', 'east']] as const) {
  const r = standRun({ stand: 'all', tier: 'all', stands: [a, b] });
  const ia = STAND_ORDER.indexOf(a);
  const expect = (ia + 1) % 4 === STAND_ORDER.indexOf(b) ? ia : STAND_ORDER.indexOf(b);
  check(`run ${a}+${b} starts at the earlier stand`, !!r && r.start === expect && r.len === 2, runOf({ stand: 'all', tier: 'all', stands: [a, b] }));
}
// narrowToSingleStand must now KEEP a run — that is the whole point of Wall 2.
const keptRun = narrowToSingleStand({ stand: 'all', tier: 'all', stands: ['north', 'west'] });
check('narrow keeps a contiguous run intact', keptRun.stands?.length === 2 && keptRun.stands[0] === 'north');
check('narrow still collapses a split set', narrowToSingleStand(normalizeRegion('ends')!).stand === 'north');

// ---- 23. the shape a picture is generated at (Wall 3) ----
const aspects: Array<[string, number]> = [
  ['one stand, both tiers', regionAspectHint({ stand: 'north', tier: 'all' })],
  ['one stand, one tier', regionAspectHint({ stand: 'north', tier: 0 })],
  ['whole bowl', regionAspectHint({ stand: 'all', tier: 'all' })],
  ['two stands', regionAspectHint({ stand: 'all', tier: 'all', stands: ['north', 'west'] })],
  ['a row band', regionAspectHint({ stand: 'north', tier: 'all', rows: [0.2, 0.5] })],
];
for (const [name, a] of aspects) check(`aspect hint in range: ${name}`, a >= 0.5 && a <= 4, a.toFixed(2));
check('a stand is wider than it is tall', regionAspectHint({ stand: 'north', tier: 'all' }) > 2);
check('two stands are wider than one',
  regionAspectHint({ stand: 'all', tier: 'all', stands: ['north', 'west'] }) >= regionAspectHint({ stand: 'north', tier: 'all' }));
check('a thin row band never asks for a sliver', regionAspectHint({ stand: 'north', tier: 'all', rows: [0.4, 0.42] }) <= 4);

check('colour names are human', colourName('#c8102e').includes('red') && colourName('#ffffff') === 'white' && colourName('#000000') === 'black');
check('gold reads as gold, not yellow', colourName('#d4af37').includes('gold'));
check('a near-grey is not given a hue', colourName('#7a7d80') === 'grey');
check('a bad hex degrades quietly', colourName('nonsense') === 'grey');

const style = mosaicStyle({ aspect: 2.4, palette: ['#262a33', '#c8102e', '#ffffff', '#111111'] });
check('style names the palette', style.includes('red') && style.includes('white'));
check('style states the shape', /wide/i.test(style));
check('style forbids text in the picture', /No text, letters, numbers/.test(style));
check('style asks for flat tones, not gradients', /FLAT hard-edged tones/.test(style) && /No gradients/.test(style));
check('style survives an empty request', mosaicStyle().length > 100 && !mosaicStyle().includes('undefined'));
check('a square brief still reads square', /square/i.test(mosaicStyle({ aspect: 1 })));

for (const a of [0.5, 1, 1.78, 2.4, 4]) {
  const { width, height } = pollinationsSize(a);
  const got = width / height;
  check(`image size tracks aspect ${a}`, Math.abs(Math.log(got / a)) < 0.35, `${width}x${height} = ${got.toFixed(2)}`);
  check(`image size stays sane at ${a}`, width % 64 === 0 && height % 64 === 0 && Math.max(width, height) <= 1536 && Math.min(width, height) >= 256);
}
check('gemini snaps a stand to its widest ratio', geminiAspect(2.4) === '21:9');
check('gemini snaps a square to 1:1', geminiAspect(1) === '1:1');
check('gemini snaps 16:9 to itself', geminiAspect(16 / 9) === '16:9');

// ---- 24. image layer fit (Wall 2) ----
const imgSpec = validateSpec({
  palette: ['#262a33', '#c8102e', '#ffffff'],
  layers: [
    { kind: 'image', region: 'north', prompt: 'a legend', scaleFrac: 1, dither: true },
    { kind: 'image', region: 'south', prompt: 'a crest', scaleFrac: 1, dither: true, fit: 'contain' },
  ],
}).spec!;
const [hero, crest] = imgSpec.layers as Array<Extract<SpecLayer, { kind: 'image' }>>;
check('image fit defaults to cover (the full-bleed hero)', hero.fit === 'cover');
check('image fit honours an explicit contain', crest.fit === 'contain');
check('a nonsense fit falls back to cover',
  (validateSpec({ palette: ['#262a33', '#c8102e'], layers: [{ kind: 'image', region: 'north', prompt: 'x', scaleFrac: 1, dither: true, fit: 'stretch' }] }).spec!
    .layers[0] as Extract<SpecLayer, { kind: 'image' }>).fit === 'cover');

// ---- 25. the palette ceiling is actually raised (Wall 1) ----
const tonal = Array.from({ length: 17 }, (_, i) => (i === 0 ? '#262a33' : `#${i.toString(16).repeat(6).slice(0, 6)}`));
check('a 17-tone palette validates', validateSpec({ palette: tonal, layers: [{ kind: 'fill', region: 'all', colorIndex: 1 }] }).valid);
check('the cap still bites somewhere',
  !validateSpec({ palette: Array.from({ length: 40 }, () => '#123456'), layers: [{ kind: 'fill', region: 'all', colorIndex: 1 }] }).valid);
check('the director is told to spend colours on tones, not hues',
  /TONES/.test(PROMPTS[1][1]) && /hues/i.test(PROMPTS[1][1]));
check('the prompts expose fit to the model', PROMPTS[1][1].includes('cover') && PROMPTS[0][1].includes('contain'));

// ---- 26. reading a model reply that did not go to plan ----
// A thinking model puts its thought summary in the FIRST part and the answer in
// a later one. Reading parts[0] threw the answer away and reported it as invalid
// JSON, which reaches the user as "premium is busy" — a quota-shaped message for
// a parsing bug.
const thought = {
  candidates: [{ content: { parts: [
    { text: 'Let me consider the palette...', thought: true },
    { text: '{"title":"X"}' },
  ] }, finishReason: 'STOP' }],
};
check('a thought part never masks the answer', geminiText(thought) === '{"title":"X"}');
check('answer parts are joined in order',
  geminiText({ candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] }) === '{"a":1}');
check('an empty reply reads as empty', geminiText({}) === '');

check('truncation is named, with the lever to pull',
  /MAX_TOKENS/.test(whyNoJson({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, '{"tit')) &&
  /AI_MAX_OUTPUT_TOKENS/.test(whyNoJson({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, '{"tit')));
check('a safety block is not reported as bad JSON',
  /safety/.test(whyNoJson({ promptFeedback: { blockReason: 'SAFETY' } }, '')));
check('an empty response says so', /empty response/.test(whyNoJson({ candidates: [{ finishReason: 'STOP' }] }, '   ')));
check('otherwise the text is quoted back', whyNoJson({ candidates: [{ finishReason: 'STOP' }] }, 'Sure! Here is your design').includes('Sure! Here is your design'));

check('output ceiling leaves room to think and answer', maxOutputTokens() >= 8192);
process.env.AI_MAX_OUTPUT_TOKENS = '"8192"'; // the quoted-env trap
check('a quoted output ceiling falls back instead of passing NaN', maxOutputTokens() === 8192);
process.env.AI_MAX_OUTPUT_TOKENS = '16000';
check('a real output ceiling is honoured', maxOutputTokens() === 16000);
process.env.AI_MAX_OUTPUT_TOKENS = '10';
check('an absurdly small ceiling is refused', maxOutputTokens() === 8192);
delete process.env.AI_MAX_OUTPUT_TOKENS;

// ---- 27. the quoted-env trap ----
// This is the bug that makes premium look permanently "busy": Railway's raw env
// editor invites quotes, Number('"45000"') is NaN, setTimeout(abort, NaN) fires
// on the next tick, and every model call aborts instantly and reports a timeout.
// Nothing in the logs says "bad config" — it just looks like the provider is down.
const ENV = 'TM_TEST_NUM';
const envCases: Array<[string, string | undefined, number]> = [
  ['unset', undefined, 45000],
  ['empty', '', 45000],
  ['plain', '30000', 30000],
  ['double-quoted', '"30000"', 30000],
  ['single-quoted', "'30000'", 30000],
  ['padded', '  30000  ', 30000],
  ['not a number', 'soon', 45000],
  ['below the floor', '5', 45000],
  ['negative', '-1', 45000],
];
for (const [name, val, want] of envCases) {
  if (val === undefined) delete process.env[ENV]; else process.env[ENV] = val;
  check(`env number: ${name}`, envNum(ENV, 45000, 1000) === want, `${envNum(ENV, 45000, 1000)}`);
}
delete process.env[ENV];
// The specific failure: a NaN timeout must never reach setTimeout.
process.env[ENV] = '"45000"';
check('a quoted timeout is a real number, not NaN', Number.isFinite(envNum(ENV, 45000, 1000)));
check('the raw parse it replaces really was NaN', Number.isNaN(Number(process.env[ENV])));
delete process.env[ENV];

// ---- 28. Arabic needs more room than Latin (measured, not guessed) ----
// scripts/arabic-legibility.mts renders these on the real seat map: at the Latin
// floor an Arabic headline loses 45% of itself to unreadable strokes, and 100%
// on a single tier. The floor has to know which script it is looking at.
const refinedHeight = (text: string, tier: number | 'all', asked: number): number => {
  const v = validateSpec({
    palette: ['#262a33', '#c8102e', '#ffffff'],
    layers: [
      { kind: 'fill', region: { stand: 'north', tier }, colorIndex: 1 },
      { kind: 'text', region: { stand: 'north', tier }, text, colorIndex: 2, fontId: 'poster', arcDeg: 0, heightFrac: asked, align: 'center' },
    ],
  });
  const l = refineSpec(v.spec!).layers[1] as Extract<SpecLayer, { kind: 'text' }>;
  return l.heightFrac;
};
check('Latin keeps the old floor', refinedHeight('CHAMPIONS', 'all', 0.1) === 0.22);
check('Arabic is lifted well above it', refinedHeight('نادي القرن', 'all', 0.1) >= 0.55);
check('Arabic on ONE tier is lifted further', refinedHeight('نادي القرن', 0, 0.1) >= 0.8);
check('a mixed AR+EN line counts as Arabic', refinedHeight('الأهلي 2026', 'all', 0.1) >= 0.55);
check('a design that already asked for more is left alone', refinedHeight('نادي القرن', 'all', 0.9) === 0.9);
check('Latin is never inflated by the Arabic floor', refinedHeight('GRAZIE CAPITANO', 'all', 0.3) === 0.3);
// An outline pair must stay a pair: both copies have to land on the same height,
// or the backing no longer sits behind the letterform it is backing.
const pairSpec = validateSpec({
  palette: ['#262a33', '#c8102e', '#ffffff', '#111111'],
  layers: [
    { kind: 'fill', region: 'north', colorIndex: 1 },
    { kind: 'text', region: 'north', text: 'نادي القرن', colorIndex: 3, fontId: 'poster', arcDeg: 0, heightFrac: 0.2, align: 'center', outline: 4 },
    { kind: 'text', region: 'north', text: 'نادي القرن', colorIndex: 2, fontId: 'poster', arcDeg: 0, heightFrac: 0.2, align: 'center' },
  ],
}).spec!;
const pl = refineSpec(pairSpec).layers as Array<Extract<SpecLayer, { kind: 'text' }>>;
check('both halves of an Arabic pair get the same floor', pl[1].heightFrac === pl[2].heightFrac && pl[1].heightFrac >= 0.55);

// ---- 29. the prompts carry what the render showed was missing ----
for (const [name, p] of PROMPTS.slice(0, 2)) {
  check(`${name} prompt states the Arabic size rule`, /ARABIC NEEDS ROOM/.test(p) && p.includes('0.55'));
  check(`${name} prompt makes a picture the hero`, /GIVE THE BOWL A PICTURE/.test(p));
  check(`${name} prompt says a symbol cannot shade`, /cannot shade/.test(p));
}
check('the image rule is no longer people-only', !PROMPTS[1][1].includes('image layers for real people'));

// ---- 30. a transient 503 is retried, a 429 is not ----
// A quota error retried is a second request spent on the limit that just
// refused you; an overload retried is usually a design the user does get.
const provSrc = readFileSync(new URL('../server/src/aiProvider.ts', import.meta.url), 'utf8');
check('the retry is keyed on status, not an error string', /r\.status !== 503/.test(provSrc));
check('429 is never retried', !/status === 429/.test(provSrc.split('async function callProvider')[0]));
check('every provider branch reports its status', (provSrc.match(/status: res\.status/g) ?? []).length >= 3);

// ---- 31. a picture must not be clustered below what it can afford ----
// Halftone averages BxB cells into one tone, so it DIVIDES tonal resolution by
// B. A hero on one stand is ~52 rows; a hard-coded cell of 3 left eighteen rows
// for a whole face. scripts/portrait-resolution.mts renders the difference.
check('one stand cannot afford clustering at all', halftoneCellFor(52) === 1);
check('a half-stand band certainly cannot', halftoneCellFor(25) === 1);
check('a big grid still clusters', halftoneCellFor(400) === 3);
check('clustering is capped at 3 however big the grid', halftoneCellFor(4000) === 3);
check('the cell never goes below 1', halftoneCellFor(1) === 1 && halftoneCellFor(0) === 1);
check('an explicit request is still bounded by the budget', halftoneCellFor(52, 3) === 1 && halftoneCellFor(400, 2) === 2);
check('tone rows never drop below what a face needs, when affordable',
  [120, 200, 400].every((r) => Math.ceil(r / halftoneCellFor(r)) >= 40));

// The row budget the generator is told about must match what the bake will give it.
check('one stand, both tiers is ~52 rows', Math.abs(regionRowsHint({ stand: 'north', tier: 'all' }) - 53) <= 2);
check('one tier is about half of that', regionRowsHint({ stand: 'north', tier: 0 }) < 30);
check('a row band is smaller still', regionRowsHint({ stand: 'north', tier: 'all', rows: [0.2, 0.5] }) < 25);
check('rows never reach zero', regionRowsHint({ stand: 'north', tier: 'all', rows: [0.5, 0.5] }) >= 4);

// ---- 32. the image prompt designs for that budget ----
const st = mosaicStyle({ aspect: 2.4, palette: ['#262a33', '#ffd400', '#ffffff', '#0a0a0a'], rows: 52 });
check('the image prompt states the row budget', st.includes('52 ROWS'));
check('the image prompt demands a tight crop', /CROP IN CLOSE/.test(st) && /head-and-shoulders/.test(st));
check('the image prompt rules out a full-length figure', /Never a full-length/.test(st));
check('the image prompt still bans text and gradients', /No text/.test(st) && /No gradients/.test(st));
check('the row budget has a sane default', mosaicStyle({}).includes('ROWS'));

// ---- 33. cutting the backdrop away ----
// A generated picture is a rectangle: subject on a flat field. Baked whole it
// lands as a block of card that reads as a photo pasted onto the stand.
const W = 60, H = 40;
/** A subject on a flat field, with an ENCLOSED patch the same colour as the field. */
const scene = (bgV: number, subjV: number, collar: boolean): Uint8ClampedArray => {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const inSubject = Math.abs(x - W / 2) < 12 && y > 6 && y < H - 4;
    // the collar is the background's colour but sealed inside the subject
    const inCollar = collar && Math.abs(x - W / 2) < 5 && y > H - 12 && y < H - 6;
    const v = inCollar ? bgV : inSubject ? subjV : bgV;
    px[p] = px[p + 1] = px[p + 2] = v;
    px[p + 3] = 255;
  }
  return px;
};
const clearFrac = (px: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 0; i < W * H; i++) if (px[i * 4 + 3] === 0) n++;
  return n / (W * H);
};
const light = scene(244, 40, true);
check('a flat backdrop is cut', cutoutBackground(light, W, H));
check('the subject survives the cut', clearFrac(light) > 0.3 && clearFrac(light) < 0.8, `${(clearFrac(light) * 100).toFixed(0)}% clear`);
// The whole reason for flooding from the edge rather than matching globally.
let collarKept = 0;
for (let y = H - 11; y < H - 7; y++) for (let x = (W >> 1) - 4; x < (W >> 1) + 4; x++) if (light[(y * W + x) * 4 + 3] !== 0) collarKept++;
check('an ENCLOSED patch of the backdrop colour is kept', collarKept > 0, `${collarKept} cells`);

const dark = scene(20, 230, false);
check('it works the other way round too', cutoutBackground(dark, W, H));

// It must refuse rather than mangle.
const noise = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { noise[i * 4] = (i * 37) % 256; noise[i * 4 + 1] = (i * 91) % 256; noise[i * 4 + 2] = (i * 17) % 256; noise[i * 4 + 3] = 255; }
check('a busy border is refused, not guessed at', !cutoutBackground(noise, W, H));
const flat = scene(200, 200, false); // subject IS the background colour
check('an all-one-colour frame is refused', !cutoutBackground(flat, W, H));
check('a tiny grid is refused', !cutoutBackground(new Uint8ClampedArray(2 * 2 * 4), 2, 2));
// A refused cut must leave every pixel opaque — a partial cut is worse than none.
check('a refusal changes nothing', clearFrac(noise) === 0 && clearFrac(flat) === 0);

const cutSpec = validateSpec({
  palette: ['#262a33', '#c8102e', '#ffffff'],
  layers: [
    { kind: 'image', region: 'north', prompt: 'a legend', scaleFrac: 1, dither: true },
    { kind: 'image', region: 'south', prompt: 'a full scene', scaleFrac: 1, dither: true, cutout: false },
  ],
}).spec!;
const [a, b] = cutSpec.layers as Array<Extract<SpecLayer, { kind: 'image' }>>;
check('cutout defaults on', a.cutout === true);
check('cutout can be turned off for a full scene', b.cutout === false);
for (const [name, p] of PROMPTS.slice(0, 2)) {
  check(`${name} prompt explains the backdrop is cut away`, /cut away/.test(p) && p.includes('"cutout"'));
}
const bgStyle = mosaicStyle({ aspect: 2.4, palette: ['#262a33', '#ffd400', '#0a0a0a'], rows: 52 });
check('the image prompt demands a separable backdrop',
  /ONE FLAT COLOUR/.test(bgStyle) && /CLEARLY DIFFERENT IN BRIGHTNESS/.test(bgStyle));

// ---- 34. an accidental letterbox is undone ----
// "Fill a stand with 0, re-fill rows [0.07,0.93]" is a real device on ONE stand.
// Applied to the whole bowl it is not a frame — a stand has no left or right
// edge of its own, so the only band it can make is horizontal, and every stand
// wearing the same one is a dark stripe across the top of the stadium and
// another across the bottom. 0.07 of ~50 rows is the three missing lines.
const band = (layers: unknown[]): ReturnType<typeof refineSpec> =>
  refineSpec(validateSpec({ palette: ['#262a33', '#006c35', '#ffffff'], layers }).spec!);
const rowsOf = (sp: ReturnType<typeof refineSpec>, i: number): string => {
  const r = sp.layers[i].region.rows;
  return r ? `${r[0]},${r[1]}` : 'full';
};
check('a whole-bowl band is widened to full height',
  rowsOf(band([{ kind: 'fill', region: { stand: 'all', tier: 'all', rows: [0.07, 0.93] }, colorIndex: 1 }]), 0) === '0,1');
check('the same band done stand-by-stand is caught too',
  rowsOf(band((['north', 'south', 'east', 'west'] as const).map((st) => ({ kind: 'fill', region: { stand: st, tier: 'all', rows: [0.07, 0.93] }, colorIndex: 1 }))), 0) === '0,1');
check('a margin on ONE stand is left alone',
  rowsOf(band([{ kind: 'fill', region: { stand: 'south', tier: 'all', rows: [0.07, 0.93] }, colorIndex: 1 }]), 0) === '0.07,0.93');
check('two stands is still a choice',
  rowsOf(band([
    { kind: 'fill', region: { stand: 'south', tier: 'all', rows: [0.07, 0.93] }, colorIndex: 1 },
    { kind: 'fill', region: { stand: 'north', tier: 'all', rows: [0.07, 0.93] }, colorIndex: 1 },
  ]), 0) === '0.07,0.93');
check('a genuine horizontal stripe survives',
  rowsOf(band([{ kind: 'fill', region: { stand: 'all', tier: 'all', rows: [0.4, 0.6] }, colorIndex: 1 }]), 0) === '0.4,0.6');
check('a text row band is not a field and is untouched',
  rowsOf(band([
    { kind: 'fill', region: 'all', colorIndex: 1 },
    { kind: 'text', region: { stand: 'north', tier: 'all', rows: [0.06, 0.6] }, text: 'X', colorIndex: 2, fontId: 'poster', arcDeg: 0, heightFrac: 0.8, align: 'center' },
  ]), 1) === '0.06,0.6');
check('the house rule now forbids repeating the margin',
  /NEVER on more/.test(PROMPTS[1][1]) && /cut off/.test(PROMPTS[1][1]));

// ---- 35. every string the AI panel can show exists in BOTH languages ----
// The panel is used in Arabic. A message added in English only does not fail a
// build, does not fail a type-check, and is invisible until an Arabic-speaking
// user hits exactly that state — which is how "Designed with Premium AI" ended
// up sitting in English inside an Arabic panel.
const i18nSrc = readFileSync(new URL('../src/ui/i18n.ts', import.meta.url), 'utf8');
const panelSrc = readFileSync(new URL('../src/ui/aiPanel.ts', import.meta.url), 'utf8');
const declared = new Set(Array.from(i18nSrc.matchAll(/^\s*'([\w.]+)':\s*\{\s*en:/gm), (m) => m[1]));
const used = Array.from(panelSrc.matchAll(/\bt[v]?\('([\w.]+)'/g), (m) => m[1]);
const missing = [...new Set(used)].filter((k) => !declared.has(k));
check('every key the AI panel asks for is declared', missing.length === 0, missing.join(', '));
// Both languages, non-empty, for every card key.
let arGaps = 0;
// Lazily to the entry's own "}," — a greedy or [^}] match stops at the closing
// brace of a {placeholder} and reports a perfectly good translation as missing.
for (const m of i18nSrc.matchAll(/'(ai\.card\.[\w.]+)':\s*\{([\s\S]*?)\},\n/g)) {
  const body = m[2];
  const ar = /ar:\s*'([^']*)'|ar:\s*"([^"]*)"/.exec(body);
  if (!ar || !(ar[1] ?? ar[2] ?? '').trim()) arGaps++;
}
check('every AI card string has a non-empty Arabic translation', arGaps === 0, `${arGaps} gaps`);
// Placeholders must survive translation, or a number lands nowhere.
let phGaps = 0;
for (const m of i18nSrc.matchAll(/'(ai\.card\.[\w.]+)':\s*\{\s*en:\s*(['"])([\s\S]*?)\2,\s*ar:\s*(['"])([\s\S]*?)\4,?\s*\}/g)) {
  const en = new Set(Array.from(m[3].matchAll(/\{(\w+)\}/g), (x) => x[1]));
  const ar = new Set(Array.from(m[5].matchAll(/\{(\w+)\}/g), (x) => x[1]));
  if (en.size !== ar.size || [...en].some((k) => !ar.has(k))) phGaps++;
}
check('placeholders match across languages', phGaps === 0, `${phGaps} mismatched`);
// The panel must not have gone back to hard-coded sentences.
check('no hard-coded card copy left in the panel',
  !/\b(?:title|body|label):\s*'[A-Z][a-z]+ [a-z]/.test(panelSrc));
check('the panel reports a degraded result as its own state', /outcome\?\.kind === 'degraded'/.test(panelSrc));
check('a stopped run is not reported as an error', /AbortError/.test(panelSrc) && /ai\.card\.stopped/.test(panelSrc));
check('every failure branch offers a way forward',
  (panelSrc.match(/actions: \[/g) ?? []).length >= 6);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
if (failures > 0) process.exit(1);
