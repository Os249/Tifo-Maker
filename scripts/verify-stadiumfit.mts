/**
 * Can the estimator rebuild the stadiums it was never shown?
 *   npx tsx scripts/verify-stadiumfit.mts
 *
 * There is no scanned stadium to check against, so the only honest accuracy
 * figure available is a round trip: take a template we shipped, synthesise the
 * evidence a real ground would have left — a seating ring visible from above, a
 * stated capacity — hand that back to the estimator, and see what comes out.
 *
 * This cannot prove the estimator is right about a real stadium. It proves it is
 * self-consistent, which is the necessary half, and it is the same test that
 * caught the vertex-centroid bug in the footprint fitter.
 */
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { generateSeatMap } from '../src/core/seatmap';
import {
  buildStadium,
  outerBowlFromFootprint,
  planFromOuter,
  solveRows,
  fitRing,
  measureRing,
  stackTiers,
  suggestFacade,
  suggestLighting,
  suggestTierCount,
  type Pt,
  type RadialProbe,
} from '../src/core/stadiumFit';
import { TEMPLATES } from '../src/core/template';
import {
  DEFAULT_MIN_AGREEMENT,
  aggregateFacts,
  factsToKnown,
  parsePhotoFacts,
  PHOTO_FACTS_PROMPT,
  type PhotoFacts,
} from '../src/core/photoFacts';
import type { StadiumTemplate } from '../src/core/types';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The estimator's own source, for checking that its stated figures are true. */
const fitSource = (): string =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/core/stadiumFit.ts'), 'utf8');

let failures = 0;
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

const se = (a: number, b: number, p: number, t: number): Pt => {
  const e = 2 / p;
  const c = Math.cos(t), s = Math.sin(t);
  return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e];
};

/** The row-0 ring a perfect overhead sampler would return for this template. */
function trueRing(t: StadiumTemplate, n = 160): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push(se(t.plan.a, t.plan.b, t.plan.exponent, (i / n) * Math.PI * 2));
  return out;
}

console.log('--- ring fitting -------------------------------------------------');
{
  // Clean rings first: if this cannot recover geometry it generated itself,
  // nothing downstream is worth reading.
  let worst = 0;
  for (const s of STADIUM_CATALOG) {
    const { a, b, exponent } = s.template.plan;
    const f = fitRing(trueRing(s.template));
    const e = Math.max(Math.abs(f.a - a) / a, Math.abs(f.b - b) / b, Math.abs(f.exponent - exponent) / exponent);
    worst = Math.max(worst, e);
  }
  check(worst < 0.05, 'clean rings refit to their own geometry', `worst ${(worst * 100).toFixed(1)}%`);

  // Now with the noise a real sampler has: the imagery read of Amman used 175 of
  // 360 bearings, so drop half of them, and jitter each radius by a metre.
  let worstNoisy = 0;
  let rng = 12345;
  const rand = (): number => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const s of STADIUM_CATALOG) {
    const { a, b } = s.template.plan;
    const noisy = trueRing(s.template, 360)
      .filter(() => rand() > 0.5)
      .map(([x, y]) => {
        const r = Math.hypot(x, y) || 1;
        const j = 1 + (rand() - 0.5) * 2 * (1 / r);
        return [x * j, y * j] as Pt;
      });
    const f = fitRing(noisy);
    worstNoisy = Math.max(worstNoisy, Math.max(Math.abs(f.a - a) / a, Math.abs(f.b - b) / b));
  }
  check(worstNoisy < 0.08, 'half the bearings missing and +/-1 m jitter', `worst half-axis ${(worstNoisy * 100).toFixed(1)}%`);
}

console.log('\n--- radial probes -> ring ----------------------------------------');
{
  // A probe set with aisle gaps in it, which is what broke the first, run-based
  // version of this measurement on Amman.
  const probes: RadialProbe[] = [];
  for (let i = 0; i < 360; i++) {
    const theta = (i / 360) * Math.PI * 2;
    const hits: number[] = [];
    // Seating from 72 m to 81 m at a 0.2 m step, with a 2 m aisle gap punched
    // through the middle. The step matters: at 0.3 m this band yields 23 hits
    // after the gap, under the 25-hit floor, and every bearing is discarded.
    for (let r = 72; r < 81; r += 0.2) {
      if (r > 75.5 && r < 77.5) continue;
      hits.push(r);
    }
    probes.push({ theta, hits });
  }
  const m = measureRing(probes);
  const gotDepth = m.depth.median;
  check(m.used === 360, 'every clean bearing used', `${m.used}/${m.offered}`);
  check(Math.abs(gotDepth - 9) < 1.5, 'band depth survives an aisle gap', `${gotDepth.toFixed(1)} m of a true 9 m`);
  const fitted = fitRing(m.points);
  check(Math.abs(fitted.a - 72) < 2 && Math.abs(fitted.b - 72) < 2, 'circular probe set fits a circle', `a=${fitted.a} b=${fitted.b}`);

  // A bearing with almost nothing on it — a roofed main stand reads as no-data —
  // must be dropped, not averaged in as a seat at radius zero.
  const sparse: RadialProbe[] = [{ theta: 0.001, hits: [70, 70.3, 70.6] }, ...probes.slice(0, 10)];
  const ms = measureRing(sparse);
  check(ms.used === 10, 'a bearing with too few hits is dropped, not guessed', `${ms.used} used of ${ms.offered}`);
}

console.log('\n--- tier split ---------------------------------------------------');
{
  let right = 0;
  const misses: string[] = [];
  for (const s of STADIUM_CATALOG) {
    const rows = s.template.tiers.reduce((n, t) => n + t.rows, 0);
    const got = suggestTierCount(rows);
    if (got === s.template.tiers.length) right++;
    else misses.push(`${s.meta?.name ?? s.id} (${rows} rows: said ${got}, is ${s.template.tiers.length})`);
  }
  // Locked at 10, not ">= 8": this number is quoted in the provenance note the
  // user reads, so it must not drift without someone noticing.
  check(right === 10, 'tier-count rule scores 10 of 13', `misses: ${misses.join('; ')}`);

  const st = stackTiers(50, 2);
  const stacked = st[1].baseOffset > st[0].baseOffset + st[0].rows * st[0].rowDepth
    && st[1].baseElevation > st[0].baseElevation;
  check(stacked, 'upper tier starts behind and above the one below');
  check(st[1].rakeDeg > st[0].rakeDeg, 'rake steepens going up');
  check(stackTiers(40, 1).length === 1 && stackTiers(60, 3).length === 3, 'tier count is honoured');
}

console.log('\n--- the whole estimator, round-tripped ---------------------------');
{
  console.log('\nstadium'.padEnd(25) + 'seats'.padStart(8) + 'rebuilt'.padStart(9) + 'err'.padStart(7) +
    '   plan a/b err   tiers');
  let worstCap = 0;
  let worstPlan = 0;
  let tiersRight = 0;
  for (const s of STADIUM_CATALOG) {
    const truth = s.template;
    const cap = generateSeatMap(truth).count;
    const r = buildStadium({
      id: 'rt-' + s.id,
      name: s.meta?.name,
      innerRing: trueRing(truth),
      capacity: cap,
      known: { aisles: truth.aisles.count, seatPitch: truth.tiers[0].seatPitch, tiers: truth.tiers.length },
    });
    const capErr = Math.abs(r.built - cap) / cap;
    const planErr = Math.max(
      Math.abs(r.template.plan.a - truth.plan.a) / truth.plan.a,
      Math.abs(r.template.plan.b - truth.plan.b) / truth.plan.b,
    );
    worstCap = Math.max(worstCap, capErr);
    worstPlan = Math.max(worstPlan, planErr);
    if (r.template.tiers.length === truth.tiers.length) tiersRight++;
    console.log(
      String(s.meta?.name ?? s.id).slice(0, 24).padEnd(25) +
      String(cap).padStart(8) + String(r.built).padStart(9) +
      `${(capErr * 100).toFixed(1)}%`.padStart(7) +
      `${(planErr * 100).toFixed(1)}%`.padStart(14) +
      String(r.template.tiers.length).padStart(8),
    );
  }
  console.log();
  check(worstPlan < 0.05, 'plan curve recovered', `worst ${(worstPlan * 100).toFixed(1)}%`);
  check(worstCap < 0.05, 'capacity recovered', `worst ${(worstCap * 100).toFixed(1)}%`);
  check(tiersRight === STADIUM_CATALOG.length, 'a told tier count is honoured', `${tiersRight}/${STADIUM_CATALOG.length}`);
}

console.log('\n--- provenance ---------------------------------------------------');
{
  const truth = STADIUM_CATALOG[0].template;
  const measured = buildStadium({ innerRing: trueRing(truth), capacity: 60000 });
  check(measured.provenance['plan.a'].confidence === 'measured', 'a measured ring is reported as measured');
  check(measured.provenance['tiers.rows'].confidence === 'derived', 'rows from a capacity are derived, not measured');
  check(measured.confirm.includes('tiers.length'), 'an unconfirmed tier guess is flagged for a human');
  check(measured.confirm.includes('roof.coverage'), 'roof coverage is flagged when nobody said');

  // The footprint path must never quietly pass itself off as a measurement: it
  // is the outer wall, and using it as the plan curve is the bug that rendered
  // Amman as a velodrome.
  const ring = trueRing(truth);
  const lonlat = ring.map(([x, y]) => [35.9 + x / 94000, 32 + y / 111132] as Pt);
  const guessed = buildStadium({ footprint: lonlat, capacity: 60000 });
  check(guessed.provenance['plan.a'].confidence === 'suggested', 'a footprint is reported as suggested, not measured');
  check(guessed.warnings.some((w) => w.key === 'si.warn.noRing'), 'and it warns that the outline is not row 0');
  check(guessed.confirm.includes('plan.a'), 'and asks a human to check the plan');

  const nocap = buildStadium({ innerRing: trueRing(truth) });
  check(nocap.warnings.some((w) => w.key === 'si.warn.noCapacity'), 'no capacity is reported as a guess');

  let threw = false;
  try { buildStadium({}); } catch { threw = true; }
  check(threw, 'nothing in, nothing out — it refuses rather than inventing a stadium');
}

console.log('\n--- the two rules with no data behind them ------------------------');
{
  // suggestLighting claims a hit rate in its own doc comment. Print the real one
  // rather than trusting the comment, and fail if the comment has drifted from
  // the measurement — a stale accuracy claim is worse than none, because it is
  // the number the UI uses to decide how loudly to hedge.
  // Deduped by id: the catalogue re-exports the three built-in templates, and
  // counting them twice would quietly change the score.
  const all = [...new Map([...TEMPLATES, ...STADIUM_CATALOG.map((s) => s.template)].map((t2) => [t2.id, t2])).values()];
  let hits = 0;
  const misses: string[] = [];
  for (const tpl of all) {
    const want = tpl.lighting?.style ?? 'corner-masts';
    const got = suggestLighting(tpl.roof?.coverage);
    if (got === want) hits++;
    else misses.push(`${tpl.id} wanted ${want}, rule said ${got}`);
  }
  console.log(`      lighting rule agrees with the hand-set answer ${hits}/${all.length}`);
  for (const m of misses) console.log(`        - ${m}`);
  check(hits >= Math.ceil(all.length * 0.55), 'the lighting rule beats a coin flip', `${hits}/${all.length}`);

  // The docstring quotes that score. A comment that says "8 of 13" while the
  // code scores 5 is worse than a comment that says nothing, because the UI
  // hedges by that number. So the claim is read back out of the source and
  // checked against what was just measured.
  const src = fitSource();
  const claimed = /agrees with the hand-set answer (\d+) times? out of (\d+)/.exec(src);
  check(!!claimed, 'the docstring states its own hit rate');
  check(!!claimed && Number(claimed[1]) === hits && Number(claimed[2]) === all.length,
    'and the stated hit rate is the measured one', claimed ? `says ${claimed[1]}/${claimed[2]}` : '');

  // The panel quotes it too, in English and in Arabic. Same drift, same check —
  // the user-facing number is the one it actually matters to get right.
  const i18nSrc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui/i18n.ts'), 'utf8');
  const line = /'si\.note\.lighting':.*$/m.exec(i18nSrc)?.[0] ?? '';
  const AR = '٠١٢٣٤٥٦٧٨٩';
  const enNum = /right on (\d+) of our (\d+)/.exec(line);
  // Arabic-Indic digits, read as whole runs: ٨ and ١٣ are one digit and two, and
  // filtering character by character turns "13" into a 1 and a 3.
  const arNums = (line.match(new RegExp(`[${AR}]+`, 'g')) ?? [])
    .map((run) => Number([...run].map((c) => AR.indexOf(c)).join('')));
  check(!!enNum && Number(enNum[1]) === hits && Number(enNum[2]) === all.length,
    'the English hedge in the panel quotes the measured rate', line ? `says ${enNum?.[1]}/${enNum?.[2]}` : 'no string');
  check(arNums.length === 2 && arNums[0] === hits && arNums[1] === all.length,
    'and so does the Arabic one', arNums.join('/'));

  // The tier rule quotes a score in the panel too, and it was measured once, a
  // while ago, before the catalogue grew. Same treatment: measure it now and
  // check the string still says what is true.
  let tierHits = 0;
  for (const tpl of all) {
    const rows = tpl.tiers.reduce((n, t2) => n + t2.rows, 0);
    if (suggestTierCount(rows) === tpl.tiers.length) tierHits++;
  }
  console.log(`      tier-count rule agrees with the shipped split ${tierHits}/${all.length}`);
  const tierLine = /'si\.note\.tiers':.*$/m.exec(i18nSrc)?.[0] ?? '';
  const tierEn = /right on (\d+) of our (\d+)/.exec(tierLine);
  check(!!tierEn && Number(tierEn[1]) === tierHits && Number(tierEn[2]) === all.length,
    'the tier hedge in the panel quotes the measured rate', tierEn ? `says ${tierEn[1]}/${tierEn[2]}` : 'no string');
  const tierAr = (tierLine.match(new RegExp(`[${AR}]+`, 'g')) ?? [])
    .map((run) => Number([...run].map((c) => AR.indexOf(c)).join('')));
  check(tierAr.length >= 2 && tierAr[0] === tierHits && tierAr[1] === all.length,
    'and so does its Arabic', tierAr.join('/'));

  // The facade rule only has to be sane, and its own docstring says so. What it
  // must never do is claim a bank on a bowl too tall to bank.
  check(suggestFacade({ hasTrack: true, bowlHeight: 8 }) === 'berm', 'a low ground with a track reads as an earth bank');
  check(suggestFacade({ hasTrack: true, bowlHeight: 30 }) === 'truss', 'a tall ground with a track does not');
  check(suggestFacade({ capacity: 70000, roof: 'ring', bowlHeight: 32 }) === 'cladding', 'a big roofed bowl reads as clad');
  check(suggestFacade({ capacity: 20000, bowlHeight: 18 }) === 'concrete', 'and anything else falls back to concrete');
}

console.log('\n--- reading a photo ----------------------------------------------');
{
  // None of this needs a key: the parsing, the vote and the threshold are the
  // parts that can be wrong in a way nobody would notice, and they are pure.
  check(/unsure/.test(PHOTO_FACTS_PROMPT), 'the prompt offers "unsure" as an answer');
  check(/not that\s*\n?\s*stadium|describing this picture/.test(PHOTO_FACTS_PROMPT),
    'and tells the model to describe the picture, not a stadium it recognises');

  // Anything that is not exactly a legal answer must not vote. A model that
  // replies "two" has not answered; coercing it is how a guess becomes data.
  const junk = parsePhotoFacts({ tiers: 'two', roof: 'half', track: 'yes', lighting: 'floodlights', facade: 'glass', seatColours: ['blue', '#123456'] });
  check(junk.tiers === undefined && junk.roof === undefined, 'a near-miss answer is dropped, not coerced');
  check(junk.track === undefined, 'a string where a boolean was asked for is dropped');
  check(junk.seatColours?.length === 1 && junk.seatColours[0] === '#123456', 'only real hex colours survive');
  const one = parsePhotoFacts({ tiers: 2, roof: 'one', track: true, lighting: 'roof-rim', facade: 'brick', openCorners: false });
  check(one.roof === 'west', '"one roofed stand" becomes the main stand the compiler knows');
  check(one.tiers === 2 && one.track === true && one.facade === 'brick', 'legal answers come through intact');

  // The vote. Three readings, two of which agree.
  const samples: PhotoFacts[] = [
    { tiers: 2, roof: 'ring', track: false, facade: 'cladding' },
    { tiers: 2, roof: 'ring', track: false, facade: 'membrane' },
    { tiers: 3, roof: 'sides', track: false, facade: 'concrete' },
  ];
  const vote = aggregateFacts(samples);
  check(vote.tiers?.value === 2 && Math.abs((vote.tiers?.agreement ?? 0) - 2 / 3) < 1e-9, 'the majority wins, and its share is reported');
  check(vote.track?.agreement === 1, 'unanimity reads as unanimous');
  check(vote.facade?.agreement === 1 / 3, 'three different answers report as a third each');

  const { known, used, dropped } = factsToKnown(vote);
  check(known.tiers === 2 && used.includes('tiers'), 'a 2-of-3 answer is firm enough to use');
  check(known.facade === undefined && dropped.some((d) => d.field === 'facade'), 'a 1-of-3 answer is dropped and says so');
  check(DEFAULT_MIN_AGREEMENT > 0.5, 'the threshold is above a coin flip');

  // The trap this whole arrangement exists to avoid: one lone reading agrees
  // with itself 100% of the time. That is not confidence, it is an n of 1.
  const lonely = aggregateFacts([{ facade: 'lattice' }, {}, {}, {}, {}]);
  check(lonely.facade?.agreement === 1, 'one answer out of five scores 100% agreement with itself');
  check(factsToKnown(lonely).known.facade === undefined, 'and is refused anyway, because one reading is not agreement');

  // A single sample IS allowed when only one was asked for — otherwise asking
  // for one reading would always return nothing, which is a trap of its own.
  const single = factsToKnown(aggregateFacts([{ facade: 'brick' }]));
  check(single.known.facade === 'brick', 'but a single requested reading is still usable');

  // And the facts have to actually reach a template.
  const truth2 = STADIUM_CATALOG[0].template;
  const photo = factsToKnown(aggregateFacts([
    { tiers: 1, roof: 'west', track: true, lighting: 'corner-masts', facade: 'berm' },
    { tiers: 1, roof: 'west', track: true, lighting: 'corner-masts', facade: 'berm' },
  ]));
  const built = buildStadium({ innerRing: trueRing(truth2), capacity: 30000, known: photo.known });
  check(built.template.tiers.length === 1, 'a photo-read tier count reaches the template');
  check(built.template.track !== undefined, 'so does the track');
  check(built.template.lighting?.style === 'corner-masts' && built.template.facade?.style === 'berm', 'so do the lights and the facade');
  check(built.provenance['lighting.style'].confidence === 'given', 'and they are recorded as told to us, not guessed');
  check(!built.confirm.includes('facade.style'), 'and no longer asked about');
}

// ---- a bowl from a building outline, on real grounds ----------------------
//
// The footprint path used to be checked only for its PROVENANCE — that it
// admitted to guessing — and never for whether the bowl it drew was a stadium.
// It was not. On Anfield's real outline it put row 0 100.3 m from the centre
// against a touchline at 52.5 m: a 47.8 m gap, which is what shipped.
//
// These are the real fits and footprint areas of ten grounds, measured from
// OpenStreetMap. They are frozen here as numbers rather than fetched, so this
// section is offline and deterministic; scripts/verify-osm.mts is the one that
// talks to the network.
{
  console.log('\n--- a bowl from a building outline ---------------------------------');

  const PITCH_A = 52.5;
  const PITCH_B = 34;

  // name, fit a, fit b, fit exponent, footprint m², capacity, has a track
  const GROUNDS: [string, number, number, number, number, number, boolean][] = [
    ['Anfield',        122.3, 105.8, 1.60, 34193, 54074, false],
    ['Old Trafford',   126.5, 103.8, 2.10, 41779, 75765, false],
    ['Camp Nou',       104.5,  81.3, 2.95, 29626, 99354, false],
    ['King Fahd Intl', 147.3, 147.2, 2.00, 67890, 58000, true ],
    ['Amman Intl',     112.7,  91.0, 2.05, 31747, 17619, true ],
    ['Al-Awwal Park',  105.4, 104.8, 1.60, 28370, 25000, false],
    ['San Siro',       155.0, 154.0, 1.60, 45634, 75923, false],
    ['Maracana',       264.0, 160.9, 1.60, 83555, 78838, false],
    ['Allianz Arena',  130.4, 113.7, 2.85, 51494, 75021, false],
    ['Wembley',        148.5, 144.0, 2.00, 66591, 90000, false],
  ];

  let worstCap = 0;
  let pitchEscapes = 0;
  let ovalFootballGrounds = 0;
  let absurdGaps = 0;

  for (const [name, fa, fb, fp, area, cap, track] of GROUNDS) {
    const outer = outerBowlFromFootprint(area, { a: fa, b: fb, exponent: fp }, track);
    let plan = planFromOuter(outer, 26, track);
    let tiers = suggestTierCount(30);
    const mk = (pl: typeof plan, rows: number, n: number) => ({
      id: 'x', name: 'x', version: 1, plan: pl,
      tiers: stackTiers(rows, n, 0.5),
      aisles: { count: 28, widthMeters: 1.2 }, sectionsPerTier: 28, evenRows: true,
      ...(track ? { track: {} } : {}),
    });
    let base = mk(plan, 30, tiers);
    let solved = solveRows(base, cap);
    for (let i = 0; i < 4; i++) {
      const rows = solved.template.tiers.reduce((n, t) => n + t.rows, 0);
      const band = solved.template.tiers.reduce((d, t) => d + t.rows * t.rowDepth, 0);
      const nt = suggestTierCount(rows);
      const np = planFromOuter(outer, band, track);
      if (nt === tiers && Math.abs(np.a - base.plan.a) < 0.5 && Math.abs(np.b - base.plan.b) < 0.5) break;
      tiers = nt; plan = np; base = mk(plan, rows, tiers); solved = solveRows(base, cap);
    }
    const t = solved.template;

    // The pitch has to be INSIDE the bowl, corners included. A superellipse
    // reads 1 on its own curve, so anything at or above 1 is a bowl drawn
    // through the pitch.
    const corner = (PITCH_A / t.plan.a) ** t.plan.exponent + (PITCH_B / t.plan.b) ** t.plan.exponent;
    if (corner >= 0.95) pitchEscapes++;

    const capErr = Math.abs(solved.built - cap) / cap;
    worstCap = Math.max(worstCap, capErr);

    // A football ground is a rounded rectangle. 2.0 is a pure ellipse, which is
    // the shape the first Anfield render came out as.
    if (!track && t.plan.exponent < 2.3) ovalFootballGrounds++;

    // Row 0 more than 75 m behind the touchline, with no track to explain it.
    if (!track && t.plan.a - PITCH_A > 75) absurdGaps++;

    console.log(
      `      ${name.padEnd(15)} ${t.plan.a.toFixed(0).padStart(3)} x ${t.plan.b.toFixed(0).padStart(3)} m  p=${t.plan.exponent.toFixed(2)}  ` +
      `${t.tiers.length} tier${t.tiers.length === 1 ? ' ' : 's'}  setback ${(t.plan.a - PITCH_A).toFixed(0).padStart(3)}/${(t.plan.b - PITCH_B).toFixed(0).padStart(2)} m  ` +
      `pitch ${corner.toFixed(2)}  ${solved.built.toLocaleString().padStart(7)} vs ${cap.toLocaleString()}`,
    );
  }

  check(pitchEscapes === 0, 'the pitch stays inside the bowl on every ground', `${pitchEscapes} escaped`);
  check(worstCap <= 0.03, 'every capacity lands within 3%', `worst ${(worstCap * 100).toFixed(1)}%`);
  check(ovalFootballGrounds === 0, 'no football ground is drawn as a pure ellipse', `${ovalFootballGrounds} were`);
  check(absurdGaps === 0, 'no trackless ground puts row 0 more than 75 m back', `${absurdGaps} did`);

  // The specific regression: Anfield's old numbers must not come back.
  const anfield = outerBowlFromFootprint(34193, { a: 122.3, b: 105.8, exponent: 1.6 }, false);
  const anfieldPlan = planFromOuter(anfield, 40, false);
  check(anfieldPlan.a - PITCH_A < 35, 'Anfield row 0 is near the pitch, not 47.8 m from it', `${(anfieldPlan.a - PITCH_A).toFixed(1)} m`);

  // And an outline covering half a city block is reported rather than drawn.
  const huge = outerBowlFromFootprint(83555, { a: 264, b: 160.9, exponent: 1.6 }, false);
  check(planFromOuter(huge, 40, false).capped, "an oversized outline is capped and flagged");
  check(!planFromOuter(anfield, 40, false).capped, 'a normal one is not');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
