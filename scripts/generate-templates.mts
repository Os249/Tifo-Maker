/**
 * Generate the starter-template library.
 *
 * Compositions come from src/core/templateArchetypes.ts — authored layouts, not
 * prompt output — instantiated across club palettes, stands, words and symbols.
 * Every candidate is rendered by the REAL compiler inside headless Chromium
 * (the text and symbol layers need a DOM), then put through quality gates:
 *
 *   contrast   every pair of colours actually used must clear a perceptual gap,
 *              so nothing ships as navy-on-black
 *   coverage   at least 55% of seats painted — a mostly-empty bowl is not a
 *              design, it is a mistake
 *   dominance  no single colour above 92%, which is how "flat wall" slips
 *              through a coverage check
 *   warnings   the compiler must not report a failed or empty layer
 *   distinct   rendered cells are hashed; near-duplicates are dropped, because
 *              a library of copies is worse than a small library
 *
 * Output: server/data/templates.jsonl, one line per surviving design, each
 * carrying its palette, gzipped cells, bilingual title, tags and the card
 * strip — about 4 KB a template, so the whole library is ~2.5 MB of repo.
 *
 * --shots writes the 3D stadium render of every keeper to a separate folder.
 * Those are for eyeballing a run on a contact sheet, not for shipping: they are
 * 170 KB each and the gallery card is a 5:1 strip that would contain one down
 * to a sliver. The design modal renders live 3D, so the library needs no bitmap.
 *
 *   npx tsx scripts/generate-templates.mts [--limit N] [--sample] [--out FILE] [--shots DIR]
 */
import { chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { stripPng, packCells, serialize, LIBRARY_FILE, type TemplateRecord } from './lib/strip.mjs';
import { generateSeatMap } from '../src/core/seatmap';
import { templateById } from '../src/core/stadiumCatalog';
import type { SeatMap } from '../src/core/types';

import {
  ARCHETYPES, CLUBS, NEUTRAL_PALETTES, SYMBOLS_BOLD, FONTS, WORDS_EN, WORDS_AR,
  NUMBERS, clubPalette, neutralPalette, OPPOSITE, type BuildContext,
} from '../src/core/templateArchetypes';
import type { TifoSpec, SymbolName, SpecFontId, SpecLayer } from '../src/core/tifoSpec';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(opt('--limit', flag('--sample') ? '40' : '0')) || 0;
const outArg = opt('--out', LIBRARY_FILE);
const OUT = outArg.startsWith('/') ? outArg : join(ROOT, outArg);
const shotsArg = opt('--shots', '');
const SHOTS = shotsArg ? (shotsArg.startsWith('/') ? shotsArg : join(ROOT, shotsArg)) : '';

/**
 * East straddles the u=0 seam of the unrolled bowl, so a word or a symbol placed
 * there wraps: "TOGETHER" rendered as "THER ... TOGE" with the halves at
 * opposite ends of the stand. Compositions that place something centred pick
 * from the three stands that do not cross the seam.
 */
const STANDS = ['north', 'south', 'west'] as const;

/**
 * Compositions whose subject is a word. These get a second instance per club
 * with the word in Arabic.
 *
 * Most of the clubs in this list are Arab clubs and most of the people opening
 * this library read Arabic first, and yet every word in it was English, because
 * the generator only ever handed the builders WORDS_EN. Seat text goes through
 * a canvas, which shapes and joins Arabic correctly, so this costs nothing but
 * asking for it.
 */
const WORD_ARCHETYPES = new Set([
  'banner', 'banner-framed', 'banner-arched', 'crest-and-word', 'mosaic-word', 'goalline-band',
]);

/** Stands carrying text or a symbol — the parts a seam would cut in half. */
function inkStands(layers: SpecLayer[]): string[] {
  const out = new Set<string>();
  for (const l of layers) {
    if (l.kind !== 'text' && l.kind !== 'symbol') continue;
    const r = l.region as { stand?: string; stands?: string[] };
    for (const st of r.stands ?? [r.stand ?? 'all']) out.add(st);
  }
  return [...out];
}

/**
 * Build a composition with nothing legible sitting on the seam.
 *
 * Picking the stand from north/south/west is not enough on its own: a
 * composition that spans the bowl puts its second element on the OPPOSITE
 * stand, and the opposite of west is east — the stand that straddles u=0. A
 * word placed there unrolls as "الد … ربي", one half at each end of the strip.
 * So the build is checked, and if anything readable landed on east it is built
 * again facing north/south instead.
 */
function buildOffSeam(
  arch: (typeof ARCHETYPES)[number],
  ctxFor: (stand: (typeof STANDS)[number]) => BuildContext,
  stand: (typeof STANDS)[number],
  colors: number,
): { stand: (typeof STANDS)[number]; built: ReturnType<(typeof ARCHETYPES)[number]['build']> } {
  const onSeam = (b: { layers: SpecLayer[] }) => b.layers.some(
    (l) => (l.kind === 'text' || l.kind === 'symbol')
      && (l.region as { stand?: string }).stand === 'east',
  );
  let built = arch.build({ ...ctxFor(stand), n: colors });
  if (!onSeam(built)) return { stand, built };
  for (const alt of ['north', 'south'] as const) {
    built = arch.build({ ...ctxFor(alt), n: colors });
    if (!onSeam(built)) return { stand: alt, built };
  }
  return { stand, built };
}
const STADIUMS = ['generic-bowl-60k', 'single-kop-40k', 'grand-oval-76k'];

// ---- deterministic PRNG so a rebuild produces the same library ----
function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// ---- colour maths for the contrast gate ----
const srgb = (hex: string) => {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
};
const lum = (hex: string) => {
  const [r, g, b] = srgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

interface Instance {
  spec: TifoSpec;
  stadiumId: string;
  archetype: string;
  family: string;
  club: string | null;
  paletteName: string;
  tags: string[];
  titleEn: string;
  titleAr: string;
}

/** Build every candidate instance. Deterministic and independent of rendering. */
function buildInstances(): Instance[] {
  const out: Instance[] = [];
  const push = (i: Instance) => out.push(i);

  const mkCtx = (seed: number, stand: (typeof STANDS)[number], word: string, word2: string, symbol: SymbolName, fontId: SpecFontId): BuildContext => {
    const rnd = mulberry(seed);
    const rolls = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
    return { n: 3, stand, opposite: OPPOSITE[stand], word, word2, symbol, fontId, jitter: (k) => rolls[k % rolls.length] };
  };

  for (const arch of ARCHETYPES) {
    // --- club-coloured instances: the reason someone opens the library ---
    for (const club of CLUBS) {
      const palette = clubPalette(club);
      if (palette.length - 1 < arch.minColors) continue;
      const name = club.aliases[0].replace(/\b\w/g, (c) => c.toUpperCase());
      const nameAr = club.aliases.find((a) => /[؀-ۿ]/.test(a)) ?? name;
      const seed = hashStr(arch.id + club.aliases[0]);
      const rnd = mulberry(seed);
      const stand = STANDS[Math.floor(rnd() * STANDS.length)];
      const word = WORDS_EN[Math.floor(rnd() * WORDS_EN.length)];
      const num = NUMBERS[Math.floor(rnd() * NUMBERS.length)];
      const symbol = (club.crest as SymbolName) ?? SYMBOLS_BOLD[Math.floor(rnd() * SYMBOLS_BOLD.length)];
      const font = FONTS[Math.floor(rnd() * FONTS.length)];
      const { built } = buildOffSeam(
        arch, (st) => mkCtx(seed, st, word, num, symbol, font), stand, palette.length - 1,
      );
      push({
        spec: { version: 1, title: `${name} — ${arch.id}`, palette, background: built.background, layers: built.layers },
        stadiumId: STADIUMS[Math.floor(rnd() * STADIUMS.length)],
        archetype: arch.id, family: arch.family, club: name, paletteName: name,
        tags: ['club', arch.family, arch.id],
        titleEn: `${name} · ${archTitleEn(arch.id, word, num)}`,
        // The word in the title is the word ON the tifo. The Arabic title used
        // to pick its own from WORDS_AR, so a banner reading "LOYAL" was
        // captioned «المجد» — a caption for a design that does not exist. Seat
        // text is drawn in Latin today; when it can be drawn in Arabic, the
        // word and the caption change together.
        titleAr: `${nameAr} · ${archTitleAr(arch.id, word, num)}`,
      });

      // The same composition, in Arabic. Same palette, same stand, same font —
      // only the word changes, so it is a real alternative rather than a
      // different design that happens to be labelled Arabic.
      if (WORD_ARCHETYPES.has(arch.id)) {
        const arWord = WORDS_AR[Math.floor(rnd() * WORDS_AR.length)];
        const { built: arBuilt } = buildOffSeam(
          arch, (st) => mkCtx(seed + 1, st, arWord, num, symbol, font), stand, palette.length - 1,
        );
        push({
          spec: { version: 1, title: `${name} — ${arch.id} (ar)`, palette, background: arBuilt.background, layers: arBuilt.layers },
          stadiumId: STADIUMS[Math.floor(rnd() * STADIUMS.length)],
          archetype: arch.id, family: arch.family, club: name, paletteName: name,
          tags: ['club', 'arabic', arch.family, arch.id],
          titleEn: `${name} · ${archTitleEn(arch.id, arWord, num)}`,
          titleAr: `${nameAr} · ${archTitleAr(arch.id, arWord, num)}`,
        });
      }
    }
    // --- neutral palettes: the starting points with no club attached ---
    for (const pal of NEUTRAL_PALETTES) {
      const palette = neutralPalette(pal.colors);
      if (palette.length - 1 < arch.minColors) continue;
      const pair: Instance[] = [];
      for (const wi of [0, 1]) {
        const seed = hashStr(arch.id + pal.name + wi);
        const rnd = mulberry(seed);
        const stand = STANDS[Math.floor(rnd() * STANDS.length)];
        // Variant 1 of a word composition carries the Arabic word. That also
        // settles the naming problem these pairs had: two variants of "LOYAL,
        // framed" were the same title twice, and now they are not even the
        // same design.
        const word = wi === 1 && WORD_ARCHETYPES.has(arch.id)
          ? WORDS_AR[Math.floor(rnd() * WORDS_AR.length)]
          : WORDS_EN[Math.floor(rnd() * WORDS_EN.length)];
        const num = NUMBERS[Math.floor(rnd() * NUMBERS.length)];
        const symbol = SYMBOLS_BOLD[Math.floor(rnd() * SYMBOLS_BOLD.length)];
        const font = FONTS[Math.floor(rnd() * FONTS.length)];
        const { built } = buildOffSeam(
          arch, (st) => mkCtx(seed, st, word, num, symbol, font), stand, palette.length - 1,
        );
        pair.push({
          spec: { version: 1, title: `${pal.name} — ${arch.id}`, palette, background: built.background, layers: built.layers },
          stadiumId: STADIUMS[Math.floor(rnd() * STADIUMS.length)],
          archetype: arch.id, family: arch.family, club: null, paletteName: pal.name,
          tags: [...(wi === 1 && WORD_ARCHETYPES.has(arch.id) ? ['arabic'] : []), arch.family, arch.id],
          titleEn: `${archTitleEn(arch.id, word, num)} · ${pal.name}`,
          titleAr: `${archTitleAr(arch.id, word, num)} · ${palNameAr(pal.name)}`,
        });
      }
      // The two neutral variants differ in seed, so for a composition whose
      // title names its word ("Mosaic with ONE CLUB") they already read as two
      // designs. For one whose title does not — hoops, checkerboard, a scarf —
      // both come out with the same name, and the gallery shows what looks like
      // the same template twice. They are not the same: the seed changes the
      // band count. So say so, and say which is which, from the built layers.
      if (pair.length === 2 && pair[0].titleEn === pair[1].titleEn) {
        const [a, b] = pair;
        const wide = bandCount(a) <= bandCount(b) ? a : b;
        const tight = wide === a ? b : a;
        wide.titleEn += ' · wide';
        wide.titleAr += ' · عريض';
        tight.titleEn += ' · tight';
        tight.titleAr += ' · ضيّق';
      }
      for (const inst of pair) push(inst);
    }
  }
  return out;
}

const EN_TITLES: Record<string, (w: string, n: string) => string> = {
  hoops: () => 'Hoops', scarf: () => 'Scarf stripes', halves: () => 'Split in half',
  'tier-split': () => 'Tier split', 'ends-and-sides': () => 'Ends and sides',
  banner: (w) => `"${w}" banner`, 'banner-framed': (w) => `"${w}", framed`,
  'banner-arched': (w) => `"${w}", arched`, crest: () => 'Crest wall',
  'crest-on-stripes': () => 'Crest on stripes', 'crest-and-word': (w) => `Crest and "${w}"`,
  number: (_w, n) => `Number ${n}`, checker: () => 'Checkerboard', chevron: () => 'Chevrons',
  sash: () => 'Diagonal sash', 'gradient-wall': () => 'Gradient wall',
  'mosaic-word': (w) => `Mosaic with "${w}"`, 'block-ends': () => 'Both ends',
  'goalline-band': (w) => `Goal-line band, "${w}"`, flag: () => 'Flag bands',
};
const AR_TITLES: Record<string, (w: string, n: string) => string> = {
  hoops: () => 'حلقات', scarf: () => 'خطوط الشال', halves: () => 'مقسوم نصفين',
  'tier-split': () => 'تقسيم الطوابق', 'ends-and-sides': () => 'الأطراف والجوانب',
  banner: (w) => `لافتة «${w}»`, 'banner-framed': (w) => `«${w}» بإطار`,
  'banner-arched': (w) => `«${w}» مقوّسة`, crest: () => 'جدار الشعار',
  'crest-on-stripes': () => 'شعار على خطوط', 'crest-and-word': (w) => `شعار و«${w}»`,
  number: (_w, n) => `الرقم ${n}`, checker: () => 'رقعة شطرنج', chevron: () => 'أسهم',
  sash: () => 'وشاح مائل', 'gradient-wall': () => 'جدار متدرّج',
  'mosaic-word': (w) => `فسيفساء مع «${w}»`, 'block-ends': () => 'الطرفان',
  'goalline-band': (w) => `شريط أمامي «${w}»`, flag: () => 'ألوان العلم',
};
const PAL_AR: Record<string, string> = {
  'Red & white': 'أحمر وأبيض', 'Blue & white': 'أزرق وأبيض', 'Black & gold': 'أسود وذهبي',
  'Green & white': 'أخضر وأبيض', 'Claret & blue': 'عنابي وأزرق', Monochrome: 'أبيض وأسود',
  'Red, white & black': 'أحمر وأبيض وأسود', 'Blue, white & gold': 'أزرق وأبيض وذهبي',
  'Green, white & black': 'أخضر وأبيض وأسود', 'Sky & navy': 'سماوي وكحلي',
  'Orange & black': 'برتقالي وأسود', 'Purple & gold': 'بنفسجي وذهبي',
};
const archTitleEn = (id: string, w: string, n: string) => (EN_TITLES[id] ?? (() => id))(w, n);
const archTitleAr = (id: string, w: string, n: string) => (AR_TITLES[id] ?? (() => id))(w, n);
const palNameAr = (n: string) => PAL_AR[n] ?? n;

/** Run-length encode, matching the .tifo v2 cells encoding. */
/** How finely a composition is divided — band count for stripes, cell count for
 *  a pattern. Used only to tell two otherwise identically-named variants apart. */
function bandCount(inst: Instance): number {
  let n = 0;
  for (const l of inst.spec.layers) {
    if (l.kind === 'stripes') n += l.bands;
    else if (l.kind === 'pattern') n += l.scale;
  }
  return n;
}

const maps = new Map<string, SeatMap>();
const mapFor = (id: string): SeatMap => {
  let m = maps.get(id);
  if (!m) { m = generateSeatMap(templateById(id)!); maps.set(id, m); }
  return m;
};

async function main(): Promise<void> {
  const instances = buildInstances();
  // Interleave by archetype. Built in archetype order, a capped sample run
  // would take its whole quota from the first composition and look like 48
  // versions of one idea — which is precisely the failure mode a template
  // library has to avoid, so the sample must be representative by construction.
  const byArch = new Map<string, Instance[]>();
  for (const inst of instances) {
    const a = byArch.get(inst.archetype) ?? [];
    a.push(inst);
    byArch.set(inst.archetype, a);
  }
  const lanes = [...byArch.values()];
  const interleaved: Instance[] = [];
  for (let k = 0; interleaved.length < instances.length; k++) {
    for (const lane of lanes) if (lane[k]) interleaved.push(lane[k]);
  }
  console.log(`candidates: ${instances.length} across ${lanes.length} compositions`);

  const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5199 }, logLevel: 'error' });
  await vite.listen(5199);
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  }).catch(() => chromium.launch());
  const page: Page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message.slice(0, 120)));
  await page.goto('http://127.0.0.1:5199/scripts/template-harness.html', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true, { timeout: 120000 });

  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) rmSync(OUT);
  writeFileSync(OUT, '');
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  const seen = new Set<string>();
  const titles = new Set<string>();
  const rejects: Record<string, number> = {};
  const kept: string[] = [];
  const reject = (why: string) => { rejects[why] = (rejects[why] ?? 0) + 1; };

  let i = 0;
  for (const inst of interleaved) {
    i++;
    if (LIMIT && kept.length >= LIMIT) break;
    const res = await page.evaluate(
      ([spec, stadiumId]) => (window as never as { __render: (s: unknown, t: unknown, w: boolean) => unknown }).__render(spec, stadiumId, false),
      [inst.spec, inst.stadiumId] as [TifoSpec, string],
    ) as {
      ok: boolean; why?: string; errors?: unknown; cells?: number[]; hist?: number[];
      seatCount?: number; warnings?: string[]; templateVersion?: number;
    };

    if (!res.ok) { reject(res.why ?? 'render failed'); continue; }
    const { cells = [], hist = [], seatCount = 1, warnings = [], templateVersion = 1 } = res;

    // --- gates ---
    const hard = warnings.filter((w) => /failed/.test(w));
    if (hard.length) { reject('layer failed'); continue; }

    const painted = seatCount - (hist[0] ?? 0);
    if (painted / seatCount < 0.55) { reject('coverage < 55%'); continue; }

    const used = hist.map((n, idx) => ({ n, idx })).filter((x) => x.idx > 0 && x.n / seatCount > 0.02);
    if (used.length < 2) { reject('fewer than 2 real colours'); continue; }
    const top = Math.max(...used.map((u) => u.n));
    if (top / seatCount > 0.92) { reject('one colour > 92%'); continue; }
    // A second colour covering almost nothing is the signature of a lone symbol
    // adrift in a flat field — technically two colours, visually an empty stand.
    const second = used.map((u) => u.n).sort((a, b) => b - a)[1] ?? 0;
    if (second / seatCount < 0.04) { reject('ink colour under 4%'); continue; }

    let worst = Infinity;
    for (let a = 0; a < used.length; a++) {
      for (let b = a + 1; b < used.length; b++) {
        worst = Math.min(worst, ratio(inst.spec.palette[used[a].idx], inst.spec.palette[used[b].idx]));
      }
    }
    if (worst < 1.6) { reject('colours too close'); continue; }

    // Duplicate signature = layout AND colour. Hashing the cell indices alone
    // called every two-colour club running the same composition a duplicate,
    // because the indices match and only the palette differs — which is exactly
    // the variation the library exists to provide. The palette goes in the hash.
    // buildOffSeam should have moved it, but a composition that pins its text
    // to east regardless must not ship rather than ship cut in half.
    if (inkStands(inst.spec.layers).includes('east')) { reject('readable element on the seam'); continue; }

    let sig = inst.spec.palette.join('');
    for (let k = 0; k < cells.length; k += Math.max(1, Math.floor(cells.length / 900))) sig += cells[k];
    const key = String(hashStr(sig));
    if (seen.has(key)) { reject('duplicate render'); continue; }
    seen.add(key);

    // Last resort. The seeder is idempotent by title and the gallery shows the
    // title, so two designs must never share one. Anything the variant
    // labelling above did not separate gets numbered rather than shipped twice.
    let titleEn = inst.titleEn;
    let titleAr = inst.titleAr;
    for (let k = 2; titles.has(titleEn); k++) {
      titleEn = `${inst.titleEn} ${k}`;
      titleAr = `${inst.titleAr} ${k}`;
    }
    titles.add(titleEn);

    const id = `${inst.archetype}-${(inst.club ?? inst.paletteName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${kept.length}`;
    const buf = Uint8Array.from(cells);
    const rec: TemplateRecord = {
      id,
      titleEn, titleAr,
      stadiumId: inst.stadiumId, templateVersion,
      palette: inst.spec.palette,
      cellsGzB64: packCells(buf),
      tags: [...new Set(inst.tags)],
      archetype: inst.archetype, family: inst.family, club: inst.club,
      thumbnailPng: stripPng(mapFor(inst.stadiumId), buf, inst.spec.palette).toString('base64'),
      inkStands: inkStands(inst.spec.layers),
      coverage: Math.round((painted / seatCount) * 100),
      contrast: Math.round(worst * 100) / 100,
    };
    appendFileSync(OUT, `${serialize(rec)}\n`);

    // Contact-sheet renders for review only — never shipped (see the header).
    if (SHOTS) {
      const shot = await page.evaluate(
        ([spec, stadiumId]) => (window as never as { __render3d: (s: unknown, t: unknown) => Promise<string | null> }).__render3d(spec, stadiumId),
        [inst.spec, inst.stadiumId] as [TifoSpec, string],
      ) as string | null;
      if (shot) writeFileSync(join(SHOTS, `${id}.png`), Buffer.from(shot.split(',')[1], 'base64'));
    }
    kept.push(id);
    if (kept.length % 25 === 0) console.log(`  kept ${kept.length} / seen ${i}`);
  }

  await browser.close();
  await vite.close();

  console.log(`\nkept ${kept.length} of ${LIMIT ? 'capped run' : instances.length}`);
  console.log('rejected:');
  for (const [why, n] of Object.entries(rejects).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);
  console.log(`wrote ${OUT}`);
}

await main();
