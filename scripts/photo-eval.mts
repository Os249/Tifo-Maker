/**
 * Dev-only: how good is "Stadium from a photo", measured on photos of grounds
 * the site already models, so every answer can be checked.
 *
 *   ANTHROPIC_API_KEY=… npx tsx scripts/photo-eval.mts read <photos> <out> <label> [only,…]
 *   npx tsx scripts/photo-eval.mts score <out> <label>
 *
 * <photos> holds the test photos already downscaled the way the browser sends
 * them (1024 px on the longest edge, JPEG), named <ground>-<n>.jpg. Nothing of
 * them goes into the repo: they, the replies and the sheets live in <out>.
 *
 * `read` runs the REAL reader (server/src/photoRead, the premium model, the
 * real sample count) and keeps every reply as the model gave it, so `score`
 * can re-score a change to the parsing, the vote or the build without paying
 * for the readings again. Its cost goes on <out>/spend.md.
 *
 * `score` checks every field the facts cover against the site's own template
 * for that ground (the truth table below says how each is derived), then
 * builds the stadium from the facts as the Stadium panel does and writes the
 * templates for the renderer (scripts/photo-eval-render.mts).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readGroundPhoto } from '../server/src/photoRead';
import type { TokenUsage } from '../server/src/aiPricing';
import { STADIUM_CATALOG } from '../src/core/stadiumCatalog';
import { generateSeatMap } from '../src/core/seatmap';
import { buildStadium, type Pt } from '../src/core/stadiumFit';
import { aggregateFacts, deltaE, factsToKnown, parsePhotoFacts, type PhotoKnown } from '../src/core/photoFacts';
import type { FacadeStyle, LightingStyle, StadiumTemplate } from '../src/core/types';

const [cmd, ...rest] = process.argv.slice(2);

interface ReadRecord {
  file: string;
  label: string;
  raws: unknown[];
  errors: string[];
  usage: TokenUsage;
  model?: string;
  ms: number;
}

const usd = (micros: number | null | undefined): string => (micros == null ? '?' : `$${(micros / 1e6).toFixed(4)}`);

async function read(photos: string, out: string, label: string, only?: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  const file = resolve(out, `reads-${label}.json`);
  const done: Record<string, ReadRecord> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const want = only ? new Set(only.split(',')) : null;
  const names = readdirSync(photos).filter((f) => /\.jpe?g$/i.test(f) && (!want || want.has(f))).sort();
  const ledger = resolve(out, 'spend.md');
  if (!existsSync(ledger)) writeFileSync(ledger, '# Spend ledger (costs only)\n\n| when | run | photo | calls | cost |\n|---|---|---|---|---|\n');
  let total = 0;
  for (const name of names) {
    if (done[name]) continue;
    const b64 = readFileSync(resolve(photos, name)).toString('base64');
    const raws: unknown[] = [];
    const t0 = Date.now();
    const r = await readGroundPhoto(`data:image/jpeg;base64,${b64}`, undefined, { onReply: (x) => raws.push(x) });
    const rec: ReadRecord = { file: name, label, raws, errors: r.errors, usage: r.usage, model: r.model, ms: Date.now() - t0 };
    done[name] = rec;
    writeFileSync(file, JSON.stringify(done, null, 1));
    total += r.usage.costMicros ?? 0;
    appendFileSync(ledger, `| ${new Date().toISOString().slice(0, 19)} | ${label} | ${name} | ${r.usage.calls} | ${usd(r.usage.costMicros)} |\n`);
    console.log(`${name.padEnd(26)} ${raws.length}/${r.usage.calls} replies  ${usd(r.usage.costMicros)}  ${rec.ms} ms  in ${r.usage.in} out ${r.usage.out}${r.errors.length ? '  ERR ' + r.errors[0].slice(0, 120) : ''}`);
  }
  console.log(`run total ${usd(total)}`);
}

// ---- the truth -------------------------------------------------------------

type RoofTruth = 'none' | 'ring' | 'sides' | 'ends' | 'one';

interface Truth {
  /** A fan's tier count, capped at the 3 a built bowl can have. */
  tiers: number;
  roof: RoofTruth;
  track: boolean;
  lighting: LightingStyle;
  /** Four separate stands with gaps (or open space) at the corners. */
  openCorners: boolean;
  /** Stands squared up to the touchlines (plan exponent 6+), or a rounded bowl. */
  shape: 'box' | 'round';
  /** The seats' main colour, where the site sets one. */
  seat?: string;
  facade?: FacadeStyle;
  capacity: number;
  template?: StadiumTemplate;
}

/**
 * Each ground's facts, read off the site's own template for it: the one the
 * site renders, so "right" means "matches the stadium the site already draws".
 * The hand-built grounds describe their roofs as runs (`roofs`) rather than a
 * coverage, so coverage is derived from which sides have one.
 */
function truthOf(ground: string): Truth {
  if (ground === 'wembley') {
    // Three of the photos filed under Etihad and Tottenham were taken at
    // Wembley (the 2023 FA Cup final; Spurs' 2018 season there). The site does
    // not model Wembley, so these facts are general knowledge, not site data.
    return { tiers: 3, roof: 'ring', track: false, lighting: 'roof-rim', openCorners: false, shape: 'box', seat: '#c8102e', capacity: 90_000 };
  }
  const e = STADIUM_CATALOG.find((x) => x.template.site?.key === ground);
  if (!e) throw new Error(`no template for ${ground}`);
  const t = e.template;
  const sides = new Set<string>();
  let ring = !!t.indoor || ground === 'jewel'; // the Jewel's crown is built by hand (jewelCrown)
  for (const r of t.roofs ?? []) {
    if (r.side) sides.add(r.side);
    else ring = true;
  }
  let roof: RoofTruth;
  if (ring || sides.size >= 3) roof = 'ring';
  else if (sides.size === 2) roof = sides.has('north') && sides.has('south') ? 'sides' : sides.has('east') && sides.has('west') ? 'ends' : 'one';
  else if (sides.size === 1) roof = 'one';
  else roof = t.roof?.coverage === 'ring' || t.roof === undefined ? 'ring' : 'none';
  const t0 = t.tiers[0];
  const openCorners = (t.cornerCut ?? 0) > 0 || !!(t0.straight && t0.stands?.length);
  const look = t.seatLook?.colors[0];
  // The two grounds whose seats were coloured by hand before seatLook existed
  // (render/seatColours.ts): the Jewel's red-to-amber tiers, Kingdom's navy.
  const seat = look ? (typeof look === 'string' ? look : look.c) : ground === 'jewel' ? '#c8322a' : ground === 'kingdom' ? '#1b264f' : undefined;
  return {
    tiers: Math.min(3, t.levels ?? t.tiers.length),
    roof,
    track: !!t.track,
    lighting: t.lighting?.style ?? 'corner-masts',
    openCorners,
    shape: t.plan.exponent >= 6 ? 'box' : 'round',
    ...(seat ? { seat: seat.toLowerCase() } : {}),
    ...(t.facade?.style ? { facade: t.facade.style } : {}),
    capacity: e.meta?.capacity ?? 0,
    template: t,
  };
}

/**
 * What each photo actually shows. Labelled by eye, because the set is what
 * fans would really upload: wide shots from the stands, but also a dressing
 * room, a pub, a museum model, a radar satellite image and three photos of a
 * different ground. "seen" photos are scored for accuracy; "nothing" photos
 * are scored on whether they were left alone (no fact should be used).
 */
const PHOTOS: Record<string, { ground: string; view: 'seen' | 'nothing'; note?: string }> = {
  'kingdom-0.jpg': { ground: 'kingdom', view: 'seen' },
  'kingdom-1.jpg': { ground: 'kingdom', view: 'seen' },
  'jewel-0.jpg': { ground: 'jewel', view: 'seen' },
  'jewel-1.jpg': { ground: 'jewel', view: 'nothing', note: 'a radar satellite image of the Panama Canal' },
  'awwal-0.jpg': { ground: 'awwal', view: 'seen' },
  'awwal-1.jpg': { ground: 'awwal', view: 'seen' },
  'buraidah-0.jpg': { ground: 'buraidah', view: 'seen' },
  'buraidah-1.jpg': { ground: 'buraidah', view: 'seen' },
  'anfield-0.jpg': { ground: 'anfield', view: 'seen' },
  'old-trafford-0.jpg': { ground: 'old-trafford', view: 'seen', note: 'aerial' },
  'old-trafford-1.jpg': { ground: 'old-trafford', view: 'nothing', note: 'fans and a mascot, close up' },
  'emirates-0.jpg': { ground: 'emirates', view: 'seen' },
  'emirates-1.jpg': { ground: 'emirates', view: 'seen', note: 'June 2006, seats still going in' },
  'etihad-0.jpg': { ground: 'etihad', view: 'nothing', note: 'the dressing room' },
  'etihad-1.jpg': { ground: 'wembley', view: 'seen', note: 'filed as Etihad; the 2023 FA Cup final, at Wembley' },
  'tottenham-0.jpg': { ground: 'wembley', view: 'seen', note: "filed as Tottenham; Spurs' 2018 season at Wembley" },
  'tottenham-1.jpg': { ground: 'wembley', view: 'nothing', note: 'a line-up on the pitch at Wembley' },
  'stamford-bridge-0.jpg': { ground: 'stamford-bridge', view: 'seen', note: 'one side' },
  'stamford-bridge-1.jpg': { ground: 'stamford-bridge', view: 'seen' },
  'st-james-park-0.jpg': { ground: 'st-james-park', view: 'seen', note: 'night' },
  'st-james-park-1.jpg': { ground: 'st-james-park', view: 'nothing', note: 'the outside of a stand behind an old building' },
  'villa-park-0.jpg': { ground: 'villa-park', view: 'seen' },
  'villa-park-1.jpg': { ground: 'villa-park', view: 'nothing', note: 'the Holte pub' },
  'bernabeu-0.jpg': { ground: 'bernabeu', view: 'seen' },
  'bernabeu-1.jpg': { ground: 'bernabeu', view: 'seen', note: 'black and white, before the rebuild' },
  'camp-nou-0.jpg': { ground: 'camp-nou', view: 'seen' },
  'camp-nou-1.jpg': { ground: 'camp-nou', view: 'nothing', note: 'a museum display' },
  'mestalla-0.jpg': { ground: 'mestalla', view: 'nothing', note: 'a balcony over the street' },
  'mestalla-1.jpg': { ground: 'mestalla', view: 'nothing', note: 'the dressing room' },
  'san-mames-0.jpg': { ground: 'san-mames', view: 'seen' },
  'san-mames-1.jpg': { ground: 'san-mames', view: 'seen', note: 'looking up at the roof' },
  'parc-des-princes-0.jpg': { ground: 'parc-des-princes', view: 'seen' },
  'parc-des-princes-1.jpg': { ground: 'parc-des-princes', view: 'nothing', note: 'fans with megaphones, close up' },
  'sanchez-pizjuan-0.jpg': { ground: 'sanchez-pizjuan', view: 'seen', note: 'one stand, straight on' },
  'sanchez-pizjuan-1.jpg': { ground: 'sanchez-pizjuan', view: 'seen' },
};

// ---- colour ------------------------------------------------------------------

function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (v: number): number => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** White, grey or black; else the hue a fan would name. */
function family(hex: string): string {
  const [L, a, b] = lab(hex);
  if (Math.hypot(a, b) < 15) return L > 80 ? 'white' : L < 25 ? 'black' : 'grey';
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return h < 40 || h >= 330 ? 'red' : h < 70 ? 'orange' : h < 105 ? 'yellow' : h < 200 ? 'green' : h < 300 ? 'blue' : 'purple';
}

/**
 * Would a fan call these seats the same colour? Close in Lab, or the same
 * hue at much the same lightness: the Bernabéu's old mid-blue against its
 * navy is a no, Villa Park's two light blues a yes, and the charcoal a user's
 * stadium gets without a colour is no match for anybody's navy.
 */
function sameSeats(x: string, y: string): boolean {
  if (deltaE(x, y) <= 20) return true;
  const fx = family(x);
  return !['white', 'grey', 'black'].includes(fx) && fx === family(y) && Math.abs(lab(x)[0] - lab(y)[0]) <= 20;
}

// ---- the footprint OpenStreetMap would give --------------------------------

/**
 * The build machine cannot reach OpenStreetMap, so the outline the Stadium
 * panel would fetch is stood in for by the real ground's own seats: their
 * convex hull, pushed out by the 10 m of concourse and wall that stadiumFit
 * takes back off (STRUCTURE_M). Like an OSM way, it says how big and what
 * proportion; it says nothing about tiers, roofs or seats, which are the
 * photo's job.
 */
function footprintOf(t: StadiumTemplate): Pt[] {
  const map = generateSeatMap(t);
  const pts: Pt[] = [];
  for (let i = 0; i < map.count; i += 7) pts.push([map.pos3[i * 3], map.pos3[i * 3 + 2]]);
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const lat0 = 45;
  const kLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return hull.map(([x, z]) => {
    const r = Math.hypot(x, z) || 1;
    const k = (r + 10) / r;
    return [(x * k) / kLon, lat0 + (z * k) / 111_132] as Pt;
  });
}

// ---- score ---------------------------------------------------------------------

type Field = 'tiers' | 'roof' | 'track' | 'lighting' | 'facade' | 'openCorners' | 'shape' | 'seat';
const FIELDS: Field[] = ['tiers', 'roof', 'track', 'lighting', 'facade', 'openCorners', 'shape', 'seat'];

const roofClass = (r: unknown): string => (r === 'north' || r === 'south' || r === 'east' || r === 'west' ? 'one' : String(r));

function judge(field: Field, value: unknown, t: Truth): boolean | undefined {
  if (value === undefined) return undefined;
  switch (field) {
    case 'tiers': return value === t.tiers;
    case 'roof': return roofClass(value) === t.roof;
    case 'track': return value === t.track;
    case 'lighting': return value === t.lighting;
    case 'facade': return t.facade ? value === t.facade : undefined;
    case 'openCorners': return value === t.openCorners;
    case 'shape': return (value === 'square' ? 'box' : value) === t.shape;
    case 'seat': return t.seat && typeof value === 'string' ? sameSeats(value, t.seat) : undefined;
  }
}

/** A user's own stadium with no seat colour: render/seatColours.ts FALLBACK, charcoal. */
const CHARCOAL = '#3d424a';

/**
 * What a built stadium actually shows, field by field: read off the template
 * the renderer will draw, so the score is of the output, not of the reading.
 */
function shows(t: StadiumTemplate): Record<Field, unknown> {
  const c = t.seatLook?.colors[0];
  return {
    tiers: t.tiers.length,
    roof: roofClass(t.roof?.coverage ?? 'ring'),
    track: !!t.track,
    lighting: t.lighting?.style ?? 'corner-masts',
    facade: t.facade?.style ?? 'plain',
    openCorners: (t.cornerCut ?? 0) > 0,
    shape: t.plan.exponent >= 6 ? 'box' : 'round',
    seat: c ? (typeof c === 'string' ? c : c.c) : CHARCOAL,
  };
}

/**
 * The reader's firm answers for one photo, and what the Stadium panel hands
 * buildStadium from them: everything factsToKnown found firm.
 */
function answersOf(rec: ReadRecord): { firm: Partial<Record<Field, unknown>>; known: PhotoKnown; noGround: boolean } {
  const vote = aggregateFacts(rec.raws.map(parsePhotoFacts));
  const { known, used, noGround } = factsToKnown(vote);
  const ok = new Set(used);
  const firm: Partial<Record<Field, unknown>> = {};
  if (ok.has('tiers')) firm.tiers = vote.tiers!.value;
  if (ok.has('roof')) firm.roof = vote.roof!.value;
  if (ok.has('track')) firm.track = vote.track!.value;
  if (ok.has('lighting')) firm.lighting = vote.lighting!.value;
  if (ok.has('facade')) firm.facade = vote.facade!.value;
  if (ok.has('openCorners')) firm.openCorners = vote.openCorners!.value;
  if (ok.has('shape')) firm.shape = vote.shape!.value;
  if (ok.has('seatColours')) firm.seat = vote.seatColours!.value[0];
  return { firm, known, noGround };
}

function score(out: string, label: string): void {
  const reads: Record<string, ReadRecord> = JSON.parse(readFileSync(resolve(out, `reads-${label}.json`), 'utf8'));
  const rows: string[] = [];
  const builds: Record<string, { ground: string; template: StadiumTemplate; truthId?: string; facts: string }> = {};
  const z = () => ({ scored: 0, firm: 0, firmRight: 0, none: 0, photo: 0 });
  const tally = Object.fromEntries(FIELDS.map((f) => [f, z()])) as Record<Field, ReturnType<typeof z>>;
  let stray = 0, strayChanged = 0, nothing = 0, seen = 0, refused = 0, refusedSeen = 0;
  let costMicros = 0, nReads = 0;
  const mark = (ok: boolean | undefined): string => (ok === undefined ? '' : ok ? ' ✓' : ' ✗');
  for (const [file, meta] of Object.entries(PHOTOS)) {
    const rec = reads[file];
    if (!rec) continue;
    costMicros += rec.usage.costMicros ?? 0;
    nReads++;
    const t = truthOf(meta.ground);
    const { firm, known, noGround } = answersOf(rec);
    // Wembley is not modelled, so its outline is stood in for by a ground of
    // the same kind and size class (a three-tier rectangular bowl).
    const shape = t.template ?? truthOf('old-trafford').template!;
    const foot = footprintOf(shape);
    const base = buildStadium({ id: `nophoto-${file}`, name: file, footprint: foot, capacity: t.capacity, known: {} }).template;
    const built = buildStadium({ id: `photo-${file}`, name: file, footprint: foot, capacity: t.capacity, known }).template;
    const before = shows(base), after = shows(built);
    if (meta.view === 'nothing') {
      nothing++;
      if (noGround) refused++;
      stray += Object.keys(firm).length;
      if (JSON.stringify(before) !== JSON.stringify(after)) strayChanged++;
    } else {
      seen++;
      if (noGround) refusedSeen++;
      for (const f of FIELDS) {
        if (judge(f, f === 'seat' ? '#000000' : before[f], t) === undefined && f !== 'seat') continue;
        if (f === 'seat' && !t.seat) continue;
        const x = tally[f];
        x.scored++;
        if (firm[f] !== undefined) { x.firm++; if (judge(f, firm[f], t)) x.firmRight++; }
        if (judge(f, before[f], t)) x.none++;
        if (judge(f, after[f], t)) x.photo++;
      }
    }
    const cells = FIELDS.map((f) => {
      const r = firm[f] === undefined ? '·' : `${String(firm[f])}${mark(judge(f, firm[f], t))}`;
      return `${r} → ${String(after[f])}${mark(judge(f, after[f], t))}`;
    });
    rows.push(`| ${file}${meta.view === 'nothing' ? ' (no ground)' : ''} | ${meta.ground}: ${t.tiers}t ${t.roof}${t.openCorners ? ' open' : ''} ${t.shape} ${t.seat ?? ''} | ${cells.join(' | ')} |`);
    builds[file] = { ground: meta.ground, template: built, truthId: t.template?.id, facts: JSON.stringify(firm) };
  }
  const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const lines = [
    `## ${label}: on the ${seen} photos that show a ground`,
    '',
    'Read: how often the reader gave a firm answer, and how often that answer was right.',
    'In the stadium: what the built stadium shows, right against the site\'s own model, without a photo and with one.',
    '',
    '| field | firm answers | right when firm | in the stadium, no photo | in the stadium, with the photo |',
    '|---|---|---|---|---|',
    ...FIELDS.map((f) => {
      const x = tally[f];
      return `| ${f} | ${x.firm}/${x.scored} | ${x.firmRight}/${x.firm} (${pct(x.firmRight, x.firm)}) | ${x.none}/${x.scored} (${pct(x.none, x.scored)}) | ${x.photo}/${x.scored} (${pct(x.photo, x.scored)}) |`;
    }),
    '',
    `The ${nothing} photos that show no ground: ${refused} called "no ground"; ${stray} facts taken from them; the stadium changed for ${strayChanged}.`,
    `Photos that do show the ground but were called "no ground": ${refusedSeen}.`,
    `Cost: ${usd(costMicros)} for ${nReads} reads, ${usd(costMicros / Math.max(1, nReads))} a read.`,
    '',
    '| photo | truth | ' + FIELDS.join(' | ') + ' |',
    '|---|---|' + FIELDS.map(() => '---').join('|') + '|',
    ...rows,
  ];
  writeFileSync(resolve(out, `score-${label}.md`), lines.join('\n') + '\n');
  writeFileSync(resolve(out, `build-${label}.json`), JSON.stringify(builds));
  console.log(lines.slice(0, 19).join('\n'));
}

if (cmd === 'read') {
  const [photos, out, label, only] = rest;
  if (!photos || !out || !label) throw new Error('usage: read <photos> <out> <label> [only]');
  await read(photos, out, label, only);
} else if (cmd === 'score') {
  const [out, label] = rest;
  score(out, label);
} else {
  console.log('usage: read <photos> <out> <label> [only] | score <out> <label>');
}
