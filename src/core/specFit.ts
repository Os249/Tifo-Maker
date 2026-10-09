/**
 * Fit a design to the stadium it is about to be painted on.
 *
 * Every generator — the model, the Quick Designer, Super offline, Shuffle —
 * plans in FRACTIONS: "the headline is 0.34 of the north stand's height, in the
 * bottom half". That is the right language on a 60-row bowl and the wrong one on
 * a 13-row ground. Measured on the catalogue (scripts/ai-fit.mts), the same spec
 * that reads at the Jewel comes out on Al-Majmaah as letters three seats tall,
 * crests one row high, and whole layers painted into a stand that does not
 * exist. A seat is the pixel, and the stadium decides how many there are.
 *
 * So this pass works in SEATS, on the real seat map, just before compiling:
 *
 *   1. Focal layers (text, symbols, pictures) aimed at a stand that is missing
 *      or a sliver move to a real stand that is free, or are dropped when there
 *      is none. 'all' centres on the west stand, so it moves too when west is
 *      the weak one.
 *   2. Each stand's focal layers must reach a minimum height in ROWS — Latin
 *      capitals about 8, Arabic about 12 (measured: scripts/ai-text-rows.mts).
 *      A stand that cannot hold everything at that size is re-laid out: the
 *      most important element first, stacked in bands sized in rows, and what
 *      does not fit moves to a free stand or is left out. A two-word headline
 *      too long for its stand's width goes on two lines when the rows allow.
 *      The headline itself moves to the deepest stand when its own is shallow.
 *   3. Outline and shadow copies are dropped below the size where their edge is
 *      thinner than a seat (drawn bigger first where the band has room); small
 *      Arabic is fattened instead; short words are not stretched across the
 *      aisles of a shallow stand.
 *   4. Stripes and patterns are coarsened so no band or cell is under ~3 seats,
 *      and a vertical gradient over a few rows is posterised into bands.
 *
 * Before any of it, words and symbols aimed at a split set ('sides', 'ends')
 * become one copy per stand, and the refiner's contrast panels are lifted; they
 * are laid again (repairContrast) under wherever the art ends up.
 *
 * A design that already reads is left exactly as it was: every rule only fires
 * when a measured size is under its floor, so big stadiums are untouched.
 *
 * Pure and DOM-free (text width comes from a `measure` callback; the default is
 * an estimate), so it runs in tests and in the harness as well as the editor.
 */

import type { SeatMap } from './types';
import type { TifoSpec, SpecLayer, Region, Stand, TextLayer, SymbolLayer } from './tifoSpec';
import { STAND_ORDER, standIndexOfU, standRun } from './tifoSpec';
import { seatExtent } from './specCompiler';
import { repairContrast } from './specRefine';

const ROW = 8; // editor units per seat row (seatmap ROW_PX)
const W = 4000; // editor units around the bowl (seatmap EDITOR_WIDTH)

/**
 * Glyph rows below which a word stops reading, by script — the measured
 * threshold (8 and 12) plus a row, because the top and bottom rows of a glyph
 * are partly covered seats and the raster drops about one of them.
 */
const MIN_ROWS_LATIN = 9;
const MIN_ROWS_ARABIC = 13;
/** A symbol's outline needs about this many rows to be recognisable. */
const MIN_ROWS_SYMBOL = 12;
/** Marks that are naturally wide, and keep their shape when widened a lot. */
const WIDE_SYMBOLS = new Set(['eagle', 'wings', 'chevron', 'bolt']);
/** Below these an outline/shadow edge is under a seat thick. */
const BACKING_MIN_ROWS_LATIN = 14;
const BACKING_MIN_ROWS_ARABIC = 24;
/** Smallest band or pattern cell, in seats. */
const MIN_BAND_ROWS = 3;
const MIN_BAND_COLS = 4;

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Canvas size of a rendered string, in units of its glyph height. */
export interface TextMetrics {
  width: number;
  height: number;
}
export type MeasureText = (text: string, fontId: string, arcDeg: number, outline: number) => TextMetrics | null;

/**
 * Estimate when no canvas is available: bold display capitals run about 0.62
 * of their height, Arabic words a little narrower, plus renderTextCanvas' pad.
 */
export const estimateText: MeasureText = (text, _font, _arc, outline) => {
  const t = text.trim();
  if (!t) return null;
  let w = 0;
  for (const ch of t) {
    if (ch === ' ') w += 0.3;
    else if (ARABIC_RE.test(ch)) w += 0.5;
    else if (/[0-9]/.test(ch)) w += 0.58;
    else w += 0.64;
  }
  const pad = (2 * (6 + outline)) / 115; // 128px font, ~115px glyph height
  return { width: w + pad, height: 1 + pad };
};

export interface FitResult {
  spec: TifoSpec;
  /** What was changed and why, for the console and the tests. */
  changes: string[];
}

interface Geo {
  seats: number;
  rows: number;
  minY: number;
  maxY: number;
  /** Distinct row fractions (v) present, ascending — for sizing bands in rows. */
  vs: number[];
}

const isArabic = (s: string): boolean => ARABIC_RE.test(s);
const minRowsFor = (t: string): number => (isArabic(t) ? MIN_ROWS_ARABIC : MIN_ROWS_LATIN);
const backingMinFor = (t: string): number => (isArabic(t) ? BACKING_MIN_ROWS_ARABIC : BACKING_MIN_ROWS_LATIN);

const STAND_IDX: Record<Stand, number> = { east: 0, north: 1, west: 2, south: 3 };
const STAND_CENTRE: Record<Stand, number> = { east: 0, north: 0.25, west: 0.5, south: 0.75 };

/** Seats a region accepts — the compiler's own rule (specCompiler.regionPredicate). */
function accepts(region: Region): (map: SeatMap, i: number) => boolean {
  const single = region.stand === 'all' ? -1 : STAND_IDX[region.stand as Stand];
  const set = region.stands?.length ? new Set(region.stands.map((s) => STAND_IDX[s])) : null;
  return (map, i) => {
    const su = standIndexOfU(map.uv[i * 2]);
    if (set) { if (!set.has(su)) return false; } else if (single >= 0 && su !== single) return false;
    if (region.tier !== 'all' && map.tierOf[i] !== region.tier) return false;
    if (region.rows) {
      const v = map.uv[i * 2 + 1];
      if (v < region.rows[0] - 1e-6 || v > region.rows[1] + 1e-6) return false;
    }
    return true;
  };
}

function geometry(map: SeatMap, region: Region, cache: Map<string, Geo>): Geo {
  const key = JSON.stringify(region);
  const hit = cache.get(key);
  if (hit) return hit;
  const acc = accepts(region);
  // Rows are counted where the art goes — the middle of the stand. A band that
  // only catches the corners of the neighbouring stands has seats, but none
  // under a centred word (Al-Hazem's south stand has no lower tier in its
  // middle: a number set in its front rows painted nothing at all).
  const single = region.stand !== 'all' && !(region.stands && region.stands.length);
  const centre = single ? STAND_CENTRE[region.stand as Stand] : 0;
  const core = (i: number): boolean => {
    if (!single) return true;
    let d = map.uv[i * 2] - centre;
    d -= Math.round(d);
    return Math.abs(d) <= 0.08;
  };
  let seats = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  const rows = new Set<number>();
  const vset = new Set<number>();
  const allRows = new Set<number>();
  const allV = new Set<number>();
  for (let i = 0; i < map.count; i++) {
    if (!acc(map, i)) continue;
    seats++;
    allRows.add(map.rowOf[i]);
    allV.add(map.uv[i * 2 + 1]);
    if (!core(i)) continue;
    const y = map.xy[i * 2 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    rows.add(map.rowOf[i]);
    vset.add(map.uv[i * 2 + 1]);
  }
  // No seats in the middle of a stand means no room for centred art, however
  // many corner seats the band catches. (Multi-stand regions count everything.)
  const useAll = !single;
  const g: Geo = { seats, rows: useAll ? allRows.size : rows.size, minY, maxY, vs: [...(useAll ? allV : vset)].sort((a, b) => a - b) };
  cache.set(key, g);
  return g;
}

/** The compiler's horizontal room for a region, in editor units. */
function standWidth(region: Region, map?: SeatMap): number {
  if (map) {
    const acc = accepts(region);
    const real = seatExtent(region, map, (i) => acc(map, i));
    if (real) return real.width;
  }
  if (!region.stands || region.stands.length === 0) return region.stand === 'all' ? W : W / 4;
  const run = standRun(region);
  return run ? run.len * (W / 4) : W;
}

/** Glyph height in seat rows a text layer will come out at — the compiler's own maths. */
function textRows(l: TextLayer, map: SeatMap, cache: Map<string, Geo>, measure: MeasureText): number {
  const g = geometry(map, l.region, cache);
  if (!g.seats || !g.rows) return 0;
  const regionH = Math.max(ROW, (g.rows - 1) * ROW);
  let glyph = l.heightFrac * regionH;
  const m = measure(l.text, l.fontId, l.arcDeg, l.outline ?? 0);
  if (!m) return 0;
  let rectW = glyph * m.width;
  const maxW = standWidth(l.region, map) * 0.96;
  const stretch = l.stretch ?? 1;
  if (stretch > 1) rectW = Math.min(maxW, rectW * stretch);
  if (rectW > maxW) glyph *= maxW / rectW;
  // Rows the glyph covers, never more than the region holds.
  return Math.min(g.rows, glyph / ROW);
}

function symbolRows(l: SymbolLayer, map: SeatMap, cache: Map<string, Geo>): number {
  const g = geometry(map, l.region, cache);
  if (!g.seats || !g.rows) return 0;
  const regionH = Math.max(ROW, (g.rows - 1) * ROW);
  const side = l.scaleFrac * Math.min(standWidth(l.region, map), regionH);
  return Math.min(g.rows, side / ROW);
}

/** The layer below `i` is its outline/shadow copy when it draws the same words in the same place. */
function backingOf(layers: SpecLayer[], i: number): number {
  const top = layers[i];
  const b = layers[i - 1];
  if (!b || top.kind !== 'text' || b.kind !== 'text') return -1;
  if (b.text !== top.text || JSON.stringify(b.region) !== JSON.stringify(top.region)) return -1;
  return (b.outline ?? 0) > 0 || (b.dx ?? 0) !== 0 || (b.dy ?? 0) !== 0 ? i - 1 : -1;
}

/** Stands a focal layer is aimed at; 'all' resolves to where the compiler centres it (west). */
function targetStands(r: Region): Stand[] {
  if (r.stands && r.stands.length) return [...r.stands];
  if (r.stand === 'all') return ['west'];
  return [r.stand as Stand];
}

/** A key for "the same place in the bowl" — stands and tier, ignoring row bands. */
function homeKey(r: Region): string {
  const s = r.stands && r.stands.length ? [...r.stands].sort().join('+') : r.stand;
  return `${s}|${r.tier}`;
}

interface Item {
  /** Index of the layer (the top copy, for an outlined pair). */
  idx: number;
  backing: number;
  kind: 'text' | 'symbol' | 'image';
  priority: number;
  dropped: boolean;
}

/** Fit a validated, refined spec to this stadium's seats. */
export function fitSpecToStadium(spec: TifoSpec, map: SeatMap, measure: MeasureText = estimateText): FitResult {
  const changes: string[] = [];
  // Panels the refiner laid under art (id "<art>-panel") belong to where the art
  // WAS. Take them out; repairContrast lays them again under where it ends up.
  const artIds = new Set(spec.layers.filter((l) => l.kind === 'text' || l.kind === 'symbol').map((l) => l.id));
  const isPanel = (l: SpecLayer): boolean => l.kind === 'fill' && l.id.endsWith('-panel') && artIds.has(l.id.slice(0, -6));
  const layers = splitSets(spec.layers.filter((l) => !isPanel(l)).map((l) => ({ ...l, region: { ...l.region } })) as SpecLayer[], changes);
  const cache = new Map<string, Geo>();
  const remove = new Set<number>();

  // ---- the stands as they really are ----
  const standGeo = STAND_ORDER.map((s) => geometry(map, { stand: s, tier: 'all' }, cache));
  const maxSeats = Math.max(1, ...standGeo.map((g) => g.seats));
  const usable = (s: Stand): boolean => {
    const g = standGeo[STAND_IDX[s]];
    return g.seats >= Math.max(150, maxSeats * 0.15) && g.rows >= 6;
  };
  let usableStands = STAND_ORDER.filter(usable);
  if (usableStands.length === 0) usableStands = STAND_ORDER.filter((s) => standGeo[STAND_IDX[s]].seats > 0);
  const byCapacity = [...usableStands].sort((a, b) => standGeo[STAND_IDX[b]].seats - standGeo[STAND_IDX[a]].seats);

  // ---- focal items, most important first ----
  const items: Item[] = [];
  let firstText = true;
  layers.forEach((l, i) => {
    if (l.kind !== 'text' && l.kind !== 'symbol' && l.kind !== 'image') return;
    if (l.kind === 'text' && i + 1 < layers.length && backingOf(layers, i + 1) === i) return; // a backing copy
    const backing = l.kind === 'text' ? backingOf(layers, i) : -1;
    let priority = 3;
    if (l.kind === 'text') {
      priority = firstText ? 0 : 3;
      firstText = false;
    } else if (l.kind === 'image') priority = 1;
    else priority = 2;
    items.push({ idx: i, backing, kind: l.kind, priority, dropped: false });
  });
  // The headline is the biggest text, not necessarily the first.
  const texts = items.filter((it) => it.kind === 'text');
  if (texts.length > 1) {
    const big = texts.reduce((a, b) => ((layers[b.idx] as TextLayer).heightFrac > (layers[a.idx] as TextLayer).heightFrac ? b : a));
    for (const t of texts) t.priority = t === big ? 0 : 3;
  }
  const ordered = [...items].sort((a, b) => a.priority - b.priority || a.idx - b.idx);

  const setRegion = (it: Item, region: Region): void => {
    layers[it.idx].region = region;
    if (it.backing >= 0) layers[it.backing].region = { ...region };
  };
  const drop = (it: Item, why: string): void => {
    it.dropped = true;
    remove.add(it.idx);
    if (it.backing >= 0) remove.add(it.backing);
    changes.push(why);
  };
  const label = (it: Item): string => {
    const l = layers[it.idx];
    return l.kind === 'text' ? `"${l.text}"` : l.kind === 'symbol' ? l.symbol : 'picture';
  };

  // ---- 1. aim every focal item at stands that exist ----
  const homesTaken = new Set<string>();
  const misplaced = (r: Region): boolean => {
    const want = targetStands(r);
    const westWeak = r.stand === 'all' && !(r.stands && r.stands.length) &&
      (!usable('west') || standGeo[2].seats < maxSeats * 0.6);
    return westWeak || want.some((s) => !usableStands.includes(s));
  };
  // Stands already well used are spoken for before anything is moved onto them.
  for (const it of ordered) {
    const r = layers[it.idx].region;
    if (!misplaced(r)) for (const s of targetStands(r)) homesTaken.add(s);
  }
  for (const it of ordered) {
    const r = layers[it.idx].region;
    if (!misplaced(r)) continue;
    const want = targetStands(r);
    const good = want.filter((s) => usableStands.includes(s));
    if (good.length > 0 && r.stands && r.stands.length) {
      const next: Region = good.length === 1 ? { stand: good[0], tier: r.tier, ...(r.rows ? { rows: r.rows } : {}) } : { ...r, stands: good };
      setRegion(it, next);
      for (const s of good) homesTaken.add(s);
      changes.push(`${label(it)}: left out the stands that have no seats (${want.filter((s) => !good.includes(s)).join(', ')})`);
      continue;
    }
    const free = byCapacity.find((s) => !homesTaken.has(s));
    // No free stand: words may still take one that holds only an ornament —
    // the stand's layout (step 2) then puts the words first and the symbol
    // goes if there is no room for both.
    const ornamentOnly = (s: Stand): boolean => items.every((o) => o === it || o.dropped || layers[o.idx].kind !== 'text' || !targetStands(layers[o.idx].region).includes(s));
    const displace = it.kind === 'text' ? byCapacity.find(ornamentOnly) : undefined;
    const to = free ?? displace ?? (it.priority === 0 ? byCapacity[0] : undefined);
    if (!to) {
      drop(it, `${label(it)}: no stand left with room for it here, left out`);
      continue;
    }
    setRegion(it, { stand: to, tier: r.tier, ...(r.rows ? { rows: r.rows } : {}) });
    homesTaken.add(to);
    changes.push(`${label(it)}: moved from ${r.stands?.join('+') ?? r.stand} to ${to}, which is where this ground has seats`);
  }

  // ---- 1b. the headline goes where the rows are ----
  // Rows are what text runs out of. When the main words sit on a shallow stand
  // and a deeper one exists, the two stands swap everything that is theirs.
  const head = ordered.find((it) => !it.dropped && it.kind === 'text' && it.priority === 0);
  if (head) {
    const r = layers[head.idx].region;
    if (r.stand !== 'all' && !(r.stands && r.stands.length)) {
      const here = r.stand as Stand;
      const rowsHere = standGeo[STAND_IDX[here]].rows;
      const want = minRowsFor((layers[head.idx] as TextLayer).text);
      const deeper = byCapacity
        .filter((s) => s !== here && standGeo[STAND_IDX[s]].rows >= rowsHere + 3)
        .sort((a, b) => standGeo[STAND_IDX[b]].rows - standGeo[STAND_IDX[a]].rows)[0];
      if (rowsHere < want + 4 && deeper) {
        // Everything that belongs to one of the two stands alone — its field,
        // its art, its pictures — changes places, so each stand's composition
        // stays whole and only its address changes.
        layers.forEach((l, i) => {
          if (remove.has(i) || (l.region.stands && l.region.stands.length)) return;
          if (l.region.stand === here) l.region = { ...l.region, stand: deeper };
          else if (l.region.stand === deeper) l.region = { ...l.region, stand: here };
        });
        changes.push(`"${(layers[head.idx] as TextLayer).text}": moved to ${deeper} (${standGeo[STAND_IDX[deeper]].rows} rows) from ${here} (${rowsHere} rows)`);
      }
    }
  }

  // ---- 2. size every stand's focal items in rows ----
  const need = (it: Item): number => {
    const l = layers[it.idx];
    return l.kind === 'text' ? minRowsFor(l.text) : l.kind === 'symbol' ? MIN_ROWS_SYMBOL : 0;
  };
  const rowsOf = (it: Item): number => {
    const l = layers[it.idx];
    if (l.kind === 'text') return textRows(l, map, cache, measure);
    if (l.kind === 'symbol') return symbolRows(l, map, cache);
    return Infinity;
  };
  const homes = new Map<string, Item[]>();
  for (const it of ordered) {
    if (it.dropped || it.kind === 'image') continue;
    const k = homeKey(layers[it.idx].region);
    homes.set(k, [...(homes.get(k) ?? []), it]);
  }
  const freeStands = (): Stand[] => byCapacity.filter((s) => ![...homes.keys()].some((k) => k.split('|')[0].split('+').includes(s)) && !homesTaken.has(s));

  for (const [key, group] of homes) {
    // Alone on a shallow stand, a word or a crest takes the stand's full height:
    // there are few rows, and every one of them is legibility.
    if (group.length === 1) {
      const only = group[0];
      const l = layers[only.idx];
      const g = geometry(map, l.region, cache);
      if (!l.region.rows && g.rows < 24 && ((l.kind === 'text' && l.heightFrac < 0.92) || (l.kind === 'symbol' && l.scaleFrac < 0.92))) {
        grow(only, true);
        changes.push(`${label(only)}: alone on a ${g.rows}-row stand, drawn at its full height`);
      }
    }
    if (group.every((it) => rowsOf(it) >= need(it) - 1e-6)) continue;
    // Within one stand the words come first: the brief's own text is what has to
    // read, and an ornament can go where a word cannot.
    group.sort((a, b) => rank(a) - rank(b));

    // a) Each item alone in its own band can simply be drawn bigger.
    const bandsDisjoint = group.length === 1 || group.every((a, ai) => group.every((b, bi) => {
      if (ai >= bi) return true;
      const ra = layers[a.idx].region.rows ?? [0, 1];
      const rb = layers[b.idx].region.rows ?? [0, 1];
      return ra[1] <= rb[0] + 1e-6 || rb[1] <= ra[0] + 1e-6;
    }));
    if (bandsDisjoint) {
      for (const it of group) if (rowsOf(it) < need(it)) grow(it);
      if (group.every((it) => rowsOf(it) >= need(it) - 1e-6)) continue;
    }

    // b) Re-lay the stand out in rows: most important first.
    const base: Region = { ...layers[group[0].idx].region };
    delete base.rows;
    let home = geometry(map, base, cache);
    // A tier-limited home that is too shallow gets the whole stand's height.
    if (base.tier !== 'all') {
      const whole = geometry(map, { ...base, tier: 'all' }, cache);
      const needAll = group.reduce((a, it) => a + need(it), 0);
      if (home.rows < needAll && whole.rows > home.rows) { base.tier = 'all'; home = whole; }
    }
    const R = home.vs.length;
    const kept: Item[] = [];
    let used = 0;
    for (const it of group) {
      const n = need(it) + (kept.length ? 1 : 0);
      // The first thing always stays — unless it is an ornament the stand can
      // never draw: a crest five rows tall is a smudge, better not there.
      const hopeless = it.kind === 'symbol' && R < need(it) - 2;
      if (!hopeless && (kept.length === 0 || used + n <= R)) { kept.push(it); used += n; continue; }
      const spare = placeAlone(it);
      if (spare) {
        changes.push(`${label(it)}: no room on ${key.split('|')[0]} (${R} rows), moved to ${spare}`);
      } else {
        drop(it, `${label(it)}: ${key.split('|')[0]} is ${R} rows deep, too shallow for it${kept.length ? ` and ${label(kept[0])} together` : ''}, left out`);
      }
    }
    if (kept.length === 0) continue;
    // Keep the original top-to-bottom order of what stays.
    const height = (it: Item): number => {
      const l = layers[it.idx];
      const r = l.region.rows ?? [0, 1];
      const al = (l as TextLayer).align ?? 'center';
      return (r[0] + r[1]) / 2 + (al === 'top' ? 0.2 : al === 'bottom' ? -0.2 : 0);
    };
    kept.sort((a, b) => height(b) - height(a));
    if (kept.length === 1) {
      setRegion(kept[0], { ...base });
      grow(kept[0], true);
      changes.push(`${label(kept[0])}: given the whole of ${key.split('|')[0]} (${R} rows)`);
    } else {
      // Rows by need; every spare row goes to the headline.
      const alloc = kept.map(need);
      const gaps = kept.length - 1;
      let spare = Math.max(0, R - gaps - alloc.reduce((a, b) => a + b, 0));
      const head = kept.indexOf(kept.reduce((a, b) => (a.priority <= b.priority ? a : b)));
      alloc[head] += spare;
      spare = 0;
      // Top of the stand is the highest v; hand rows out from the back.
      let cursor = R - 1;
      kept.forEach((it, k) => {
        const hi = cursor;
        const lo = Math.max(0, cursor - alloc[k] + 1);
        cursor = lo - 2; // one empty row between
        const rows: [number, number] = [k === kept.length - 1 ? 0 : home.vs[lo], k === 0 ? 1 : home.vs[hi]];
        setRegion(it, { ...base, rows });
        grow(it, true);
      });
      changes.push(`${key.split('|')[0]}: ${kept.map(label).join(' over ')} stacked in rows instead of overlapping (${R} rows)`);
    }

    // c) A headline too long for the stand's width goes on two lines.
    for (const it of kept) {
      const l = layers[it.idx];
      if (l.kind !== 'text' || rowsOf(it) >= need(it) - 1e-6) continue;
      const words = l.text.trim().split(/\s+/);
      const band = geometry(map, l.region, cache);
      if (words.length < 2 || band.vs.length < 2 * need(it) + 1) continue;
      const cut = splitWords(words, l.text, measure, l.fontId);
      const mid = Math.floor(band.vs.length / 2);
      const top: TextLayer = { ...l, text: cut[0], region: { ...l.region, rows: [band.vs[mid + 1] ?? band.vs[mid], l.region.rows?.[1] ?? 1] }, heightFrac: 0.9, align: 'center' };
      const bottom: TextLayer = { ...l, id: `${l.id}-2`, text: cut[1], region: { ...l.region, rows: [l.region.rows?.[0] ?? 0, band.vs[mid - 1] ?? band.vs[mid]] }, heightFrac: 0.9, align: 'center' };
      const twoRows = Math.min(textRows(top, map, cache, measure), textRows(bottom, map, cache, measure));
      if (twoRows <= rowsOf(it)) continue;
      if (it.backing >= 0) { remove.add(it.backing); it.backing = -1; } // far too small for an edge
      layers[it.idx] = top;
      layers.splice(it.idx + 1, 0, bottom);
      // Indices after this one moved; keep the bookkeeping honest.
      for (const o of items) {
        if (o.idx > it.idx) o.idx++;
        if (o.backing > it.idx) o.backing++;
      }
      for (const r of [...remove]) if (r > it.idx) { remove.delete(r); remove.add(r + 1); }
      changes.push(`"${l.text}": too long for one line here, set on two (${Math.round(twoRows)} rows each)`);
    }

    // d) A supporting line that still cannot reach a readable size — too many
    // letters for the stand's width — gets a stand of its own, or is left out.
    for (const it of kept) {
      const l = layers[it.idx];
      if (l.kind !== 'text' || it.priority === 0 || rowsOf(it) >= need(it) - 1.5) continue;
      const spare = placeAlone(it);
      if (spare) { changes.push(`"${l.text}": too long to read beside the headline, moved to ${spare}`); continue; }
      drop(it, `"${l.text}": too long for any stand here to show it at a readable size, left out`);
    }
  }
  /** Put an item alone on a free stand where it reads; the stand, or null. */
  function placeAlone(it: Item): Stand | null {
    const before = { ...layers[it.idx] } as SpecLayer;
    const beforeBacking = it.backing >= 0 ? ({ ...layers[it.backing] } as SpecLayer) : null;
    for (const s of freeStands()) {
      if (standGeo[STAND_IDX[s]].rows < need(it)) continue;
      setRegion(it, { stand: s, tier: 'all' });
      grow(it, true);
      if (rowsOf(it) >= need(it) - 1.5) { homesTaken.add(s); return s; }
      layers[it.idx] = { ...before } as SpecLayer;
      if (beforeBacking) layers[it.backing] = { ...beforeBacking } as SpecLayer;
    }
    return null;
  }
  function rank(it: Item): number {
    const l = layers[it.idx];
    if (l.kind === 'text') return 1 - l.heightFrac; // 0..1, biggest first
    return l.kind === 'image' ? 2 : 3;
  }
  function grow(it: Item, whole = false): void {
    const l = layers[it.idx];
    if (l.kind === 'text') {
      const before = l.heightFrac;
      // As tall as the band allows: rows are the scarce thing on a small ground.
      // In place, just enough (plus a little) to reach the floor.
      const g = geometry(map, l.region, cache);
      const enough = Math.min(1, ((need(it) + 1.5) * ROW) / Math.max(ROW, (g.rows - 1) * ROW));
      l.heightFrac = Math.max(l.heightFrac, whole ? 0.92 : enough);
      l.align = whole ? 'center' : l.align;
      if (it.backing >= 0) {
        const b = layers[it.backing] as TextLayer;
        b.heightFrac = l.heightFrac;
        b.align = l.align;
      }
      if (!whole && l.heightFrac !== before) changes.push(`"${l.text}": drawn bigger to reach ${need(it)} rows`);
    } else if (l.kind === 'symbol') {
      const g = geometry(map, l.region, cache);
      const enough = Math.min(1, ((MIN_ROWS_SYMBOL + 1) * ROW) / Math.max(ROW, Math.min(standWidth(l.region, map), (g.rows - 1) * ROW)));
      l.scaleFrac = Math.max(l.scaleFrac, whole ? 1 : enough);
      // A short stand has width to spare and no height: spend the width.
      if (g.vs.length < 30 && (l.wide ?? 1) < 1.4) l.wide = WIDE_SYMBOLS.has(l.symbol) ? 2.4 : 1.4;
      if (whole) l.align = 'center';
    }
  }

  // ---- 3. outlines and shadows thinner than a seat ----
  for (const it of items) {
    if (it.dropped || it.backing < 0 || remove.has(it.idx)) continue;
    const l = layers[it.idx] as TextLayer;
    let rows = textRows(l, map, cache, measure);
    // Where the band has rows to spare, keep the outline by drawing bigger.
    if (rows < backingMinFor(l.text) && l.heightFrac < 0.9) {
      const g = geometry(map, l.region, cache);
      const want = Math.min(0.9, ((backingMinFor(l.text) + 1) * ROW) / Math.max(ROW, (g.rows - 1) * ROW));
      if (want > l.heightFrac) {
        const before = l.heightFrac;
        l.heightFrac = want;
        const grown = textRows(l, map, cache, measure);
        if (grown >= backingMinFor(l.text)) {
          (layers[it.backing] as TextLayer).heightFrac = want;
          rows = grown;
          changes.push(`"${l.text}": drawn bigger so its outline is more than a seat thick`);
        } else l.heightFrac = before;
      }
    }
    if (rows < backingMinFor(l.text)) {
      remove.add(it.backing);
      changes.push(`"${l.text}": outline left off, at ${Math.round(rows)} rows its edge would be thinner than a seat`);
    }
  }

  // ---- 3b. Arabic a little heavier when it is small ----
  // Arabic carries its meaning in thin joining strokes and dots, and below
  // about 18 rows those fall between seats. Fattening the letters by a few
  // source pixels (the same "outline" the renderer uses for edges, in the
  // word's own colour) keeps the joins two seats thick. Measured on a 15-row
  // stand: outline 6 reads where 0 does not, and 12 welds the word shut. Under
  // about 24 rows an outlined Arabic headline loses its outline (step 3) and is
  // fattened here instead: the ring was the thinnest thing on it.
  for (const it of items) {
    if (it.dropped || remove.has(it.idx) || it.kind !== 'text') continue;
    const l = layers[it.idx] as TextLayer;
    if (!isArabic(l.text) || (it.backing >= 0 && !remove.has(it.backing))) continue;
    const rows = textRows(l, map, cache, measure);
    if (rows >= 24 || (l.outline ?? 0) >= 4) continue;
    l.outline = rows < 14 ? 6 : 4;
    changes.push(`"${l.text}": letters thickened, at ${Math.round(rows)} rows Arabic joins are thinner than a seat`);
  }

  // ---- 3c. no stretching a word across the aisles of a shallow stand ----
  // Stretch widens a short word to fill a 6.6:1 band. On a shallow stand the
  // word is already as tall as the stand, and stretching it further only lets
  // more aisles cut through each letter: "MESSI" read as "MESSSSI".
  for (const it of items) {
    if (it.dropped || remove.has(it.idx) || it.kind !== 'text') continue;
    const l = layers[it.idx] as TextLayer;
    if ((l.stretch ?? 1) <= 1.4) continue;
    const stand = { ...l.region };
    delete stand.rows;
    if (geometry(map, stand, cache).rows >= 24) continue;
    l.stretch = 1.4;
    if (it.backing >= 0) (layers[it.backing] as TextLayer).stretch = 1.4;
    changes.push(`"${l.text}": not stretched across a shallow stand's aisles`);
  }

  // ---- 4. bands and cells of at least a few seats ----
  layers.forEach((l, i) => {
    if (remove.has(i)) return;
    // A vertical gradient is dithered seat by seat: over a few rows that is not
    // a blend, it is static. Posterise it into its colours as horizontal bands.
    if (l.kind === 'gradient' && l.direction === 'vertical') {
      const g = geometry(map, l.region, cache);
      if (g.seats && g.rows < 24) {
        const cols = [...l.colors].reverse(); // gradient runs back→front, stripes front→back
        const bands = Math.max(2, Math.min(cols.length, Math.floor(g.rows / MIN_BAND_ROWS)));
        layers[i] = { kind: 'stripes', id: l.id, region: l.region, colors: cols, orientation: 'horizontal', bands } as SpecLayer;
        changes.push(`gradient: ${g.rows} rows is too few to blend, set as ${bands} bands`);
        return;
      }
    }
    if (l.kind !== 'stripes' && l.kind !== 'pattern') return;
    const g = geometry(map, l.region, cache);
    if (!g.seats) return;
    const cols = colsAcross(map, l.region);
    if (l.kind === 'stripes') {
      const across = l.orientation === 'horizontal' ? Math.floor(g.rows / MIN_BAND_ROWS) : l.orientation === 'vertical' ? Math.floor(cols / MIN_BAND_COLS) : Math.floor(Math.min(g.rows / MIN_BAND_ROWS, cols / MIN_BAND_COLS));
      const max = Math.max(2, across);
      if (l.bands > max) { changes.push(`stripes: ${l.bands} bands → ${max}, so no band is under ${MIN_BAND_ROWS} seats`); l.bands = max; }
    } else if (l.pattern !== 'flag') {
      const max = Math.max(4, Math.floor(Math.min(g.rows / MIN_BAND_ROWS, cols / MIN_BAND_COLS)));
      if (l.scale > max) { changes.push(`${l.pattern}: ${l.scale} cells → ${max}`); l.scale = max; }
    }
  });

  const out = layers.filter((_, i) => !remove.has(i));
  // Art that moved now sits on another field, and dropped outlines were doing
  // some of the separating: check every word and mark against what is under it.
  return { spec: repairContrast({ ...spec, layers: out }), changes: [...new Set(changes)] };
}

/**
 * Words and symbols aimed at a SPLIT set of stands ('sides', 'ends') become one
 * copy per stand. The compiler lays a split set out in whole-bowl coordinates,
 * centred on the west stand, so "a star on each side" came out as one star on
 * the west, and anything on 'ends' — centred on west, clipped to north and
 * south — painted nothing at all, on every stadium. Outlined pairs stay pairs.
 */
function splitSets(layers: SpecLayer[], changes: string[]): SpecLayer[] {
  const out: SpecLayer[] = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const r = l.region;
    const split = (l.kind === 'text' || l.kind === 'symbol') && r.stands && r.stands.length > 1 && !standRun(r);
    if (!split) { out.push(l); continue; }
    const next = layers[i + 1];
    const pair = l.kind === 'text' && next && next.kind === 'text' && next.text === l.text && JSON.stringify(next.region) === JSON.stringify(r);
    for (const s of r.stands!) {
      const region: Region = { stand: s, tier: r.tier, ...(r.rows ? { rows: r.rows } : {}) };
      out.push({ ...l, id: `${l.id}-${s}`, region } as SpecLayer);
      if (pair) out.push({ ...next, id: `${next.id}-${s}`, region: { ...region } } as SpecLayer);
    }
    if (pair) i++;
    changes.push(`${l.kind === 'text' ? `"${l.text}"` : (l as SymbolLayer).symbol}: one on each of ${r.stands!.join(' and ')}`);
  }
  return out;
}

/**
 * Every word and symbol of a spec with the rows it will be drawn at on this
 * map and the rows it needs — for tests and the harness, which ask "does every
 * piece of this design read here?".
 */
export function focalRows(spec: TifoSpec, map: SeatMap, measure: MeasureText = estimateText): Array<{ id: string; kind: 'text' | 'symbol'; rows: number; need: number; stand: string }> {
  const cache = new Map<string, Geo>();
  const out: Array<{ id: string; kind: 'text' | 'symbol'; rows: number; need: number; stand: string }> = [];
  spec.layers.forEach((l, i) => {
    if (l.kind === 'text') {
      const next = spec.layers[i + 1];
      if (next && next.kind === 'text' && backingOf(spec.layers, i + 1) === i) return; // an outline copy
      out.push({ id: l.id, kind: 'text', rows: textRows(l, map, cache, measure), need: minRowsFor(l.text), stand: l.region.stands?.join('+') ?? l.region.stand });
    } else if (l.kind === 'symbol') {
      out.push({ id: l.id, kind: 'symbol', rows: symbolRows(l, map, cache), need: MIN_ROWS_SYMBOL, stand: l.region.stands?.join('+') ?? l.region.stand });
    }
  });
  return out;
}

/** Widest row of a region, in seats (per stand for a multi-stand region). */
function colsAcross(map: SeatMap, region: Region): number {
  const acc = accepts(region);
  const per = new Map<number, number>();
  for (let i = 0; i < map.count; i++) {
    if (!acc(map, i)) continue;
    const key = map.rowOf[i] * 4 + standIndexOfU(map.uv[i * 2]);
    per.set(key, (per.get(key) ?? 0) + 1);
  }
  let best = 0;
  for (const n of per.values()) if (n > best) best = n;
  return best;
}

/** Split a phrase into two lines of about equal width (keeps word order; RTL is shaped per line). */
function splitWords(words: string[], _full: string, measure: MeasureText, font: string): [string, string] {
  let best: [string, string] = [words.slice(0, 1).join(' '), words.slice(1).join(' ')];
  let bestW = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ');
    const b = words.slice(k).join(' ');
    const w = Math.max(measure(a, font, 0, 0)?.width ?? 0, measure(b, font, 0, 0)?.width ?? 0);
    if (w < bestW) { bestW = w; best = [a, b]; }
  }
  return best;
}
