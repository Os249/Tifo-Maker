import type { SeatMap } from './types';

/**
 * Match Day accessories — what the fans bring into the stand.
 *
 * A user asked for "flags, flares, pyro, smoke bombs, strobe lights, all that
 * sort of stuff", each set to how much of it they want. So every accessory has
 * a LEVEL, not an on/off switch, and a level means what it means on a real
 * terrace (DFB Glossar Fan-Utensilien; SGSA pyrotechnics guidance; ultras
 * suppliers' product sheets):
 *
 *   1 Light   a handful of fans at the front of the middle of the stand
 *   2 Medium  a line of them along the front of the whole stand
 *   3 Heavy   the lower half of the stand
 *   4 Full    the whole end, top to bottom
 *
 * The numbers that make it look right come from the same sources: a bengal
 * burns 60–90 s at 1,600 °C+ in a narrow colour band (strontium red 617–646 nm,
 * barium green, sodium yellow…); a smoke pot pours for 60–90 s; a strobe pot
 * flashes white at roughly 4–10 Hz, each one out of step with the next; a
 * waving flag is up to 2×2 m, a big one on a long pole bigger than that.
 *
 * This file is pure (no three.js, no DOM) so the planner can be tested in Node.
 */

export type AccessoryKind = 'flags' | 'flares' | 'smoke' | 'strobes' | 'paper' | 'phones';
/** 0 Off, 1 Light, 2 Medium, 3 Heavy, 4 Full. */
export type AccessoryLevel = 0 | 1 | 2 | 3 | 4;
export type AccessoryLevels = Record<AccessoryKind, AccessoryLevel>;

/** In the order the panel lists them: the everyday ones first, the loud ones after. */
export const ACCESSORY_KINDS: AccessoryKind[] = ['flags', 'flares', 'smoke', 'strobes', 'paper', 'phones'];
export const MAX_LEVEL: AccessoryLevel = 4;
export const LEVEL_KEYS = ['lvl.off', 'lvl.light', 'lvl.medium', 'lvl.heavy', 'lvl.full'] as const;

export function noAccessories(): AccessoryLevels {
  return { flags: 0, flares: 0, smoke: 0, strobes: 0, paper: 0, phones: 0 };
}

export function clampLevel(v: unknown): AccessoryLevel {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return (n < 0 ? 0 : n > 4 ? 4 : n) as AccessoryLevel;
}

// ---------------------------------------------------------------------------
// Where the fans with them are standing
// ---------------------------------------------------------------------------

export type AccessoryWhere = 'north' | 'east' | 'south' | 'west' | 'north-south' | 'east-west' | 'all';
export const ACCESSORY_WHERE: AccessoryWhere[] = ['north', 'south', 'east', 'west', 'north-south', 'east-west', 'all'];

/**
 * Stand indices, in the app's own convention (`standOfU`): 0 East, 1 North,
 * 2 West, 3 South. The pairs are named by their stands, not "ends" and
 * "sides": in the bowl East and West are the ones behind the goals, while the
 * tifo planner's STAND_GROUPS calls them the sides — a pair spelt out cannot
 * be read the wrong way round.
 */
export function standsFor(where: AccessoryWhere): (0 | 1 | 2 | 3)[] {
  switch (where) {
    case 'east': return [0];
    case 'north': return [1];
    case 'west': return [2];
    case 'south': return [3];
    case 'north-south': return [1, 3];
    case 'east-west': return [0, 2];
    default: return [0, 1, 2, 3];
  }
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/**
 * A flare's flame is a narrow emission band, not a warm white — which is why a
 * red bengal paints a whole stand red. The white one is burning metal powder,
 * close to ordinary hot-body light. Blue is the hard one to make, and it shows:
 * it burns paler than the rest.
 */
export const FLARE_COLOURS: Record<string, string> = {
  red: '#ff2a14',
  orange: '#ff7a14',
  yellow: '#ffd21e',
  green: '#28ff5c',
  blue: '#5c7cff',
  purple: '#c04dff',
  white: '#fff3dc',
};
export const SMOKE_COLOURS: Record<string, string> = {
  red: '#d8231c',
  white: '#e9ecef',
  black: '#1d1f24',
  green: '#1f9e46',
  blue: '#2458c8',
  yellow: '#f2c418',
  orange: '#f07418',
  purple: '#7b2fbf',
  pink: '#f25aa8',
};
/** 'club' = the design's own palette, first. */
export const FLARE_COLOUR_IDS = ['red', 'club', 'orange', 'yellow', 'green', 'blue', 'purple', 'white'];
export const SMOKE_COLOUR_IDS = ['club', 'red', 'white', 'black', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink'];

/**
 * The club's colours, out of a design palette: index 0 is "empty seat", so the
 * colours are 1.. — and an empty palette falls back to red and white, which is
 * what a curva with no design in front of it most often burns.
 */
export function clubColours(palette: readonly string[]): string[] {
  const out = palette.slice(1).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  return out.length ? out.slice(0, 3) : ['#d8231c', '#f4f4f4'];
}

// ---------------------------------------------------------------------------
// Presets — one press for a whole mood
// ---------------------------------------------------------------------------

export type AccessoryPreset = 'off' | 'terrace' | 'ultras' | 'inferno' | 'lightshow';
export const ACCESSORY_PRESETS: Record<AccessoryPreset, AccessoryLevels> = {
  off: noAccessories(),
  // An ordinary big game: flags going, a couple of flares at the front.
  terrace: { flags: 2, flares: 1, smoke: 1, strobes: 0, paper: 0, phones: 0 },
  // The curva's own show.
  ultras: { flags: 3, flares: 3, smoke: 2, strobes: 2, paper: 2, phones: 0 },
  // The one where the referee stops the match.
  inferno: { flags: 4, flares: 4, smoke: 4, strobes: 3, paper: 3, phones: 0 },
  // The legal one: phones and a few strobes, at night.
  lightshow: { flags: 0, flares: 0, smoke: 0, strobes: 1, paper: 0, phones: 4 },
};
export const PRESET_ORDER: AccessoryPreset[] = ['off', 'terrace', 'ultras', 'inferno', 'lightshow'];

// ---------------------------------------------------------------------------
// The planner: which seats hold one
// ---------------------------------------------------------------------------

/**
 * One level of one accessory, per stand.
 *
 * - `vMax`     how far back from the front row it reaches (0 front … 1 back)
 * - `uSpan`    how much of the stand's width, centred
 * - `density`  holders per seat in that zone
 * - `min/max`  per stand, before the quality budget
 * - `front`    how strongly it hugs the front row (a flare line is ON the fence)
 * - `even`     spread evenly along the stand (a line), or scattered by chance
 */
interface LevelSpec { vMax: number; uSpan: number; density: number; min: number; max: number; front: number; even: boolean }

const L = (vMax: number, uSpan: number, density: number, min: number, max: number, front = 0, even = true): LevelSpec =>
  ({ vMax, uSpan, density, min, max, front, even });

/** Index 0 is Off and never read. */
export const LEVEL_SPECS: Record<AccessoryKind, LevelSpec[]> = {
  flags: [
    L(0, 0, 0, 0, 0),
    L(0.4, 0.5, 0.012, 10, 30, 0.5),
    L(0.45, 1, 0.02, 30, 90, 0.4),
    L(0.7, 1, 0.035, 80, 260, 0.2),
    L(1, 1, 0.05, 160, 560, 0, false),
  ],
  flares: [
    L(0, 0, 0, 0, 0),
    L(0.22, 0.34, 0.01, 4, 9, 2),
    L(0.14, 1, 0.012, 12, 40, 4),
    L(0.55, 0.85, 0.02, 40, 130, 1),
    L(1, 1, 0.026, 90, 320, 0, false),
  ],
  smoke: [
    L(0, 0, 0, 0, 0),
    L(0.2, 0.3, 0.0015, 1, 2, 2),
    L(0.16, 1, 0.0022, 3, 6, 3),
    L(0.6, 0.9, 0.0028, 6, 12, 1),
    L(1, 1, 0.0035, 10, 22, 0),
  ],
  strobes: [
    L(0, 0, 0, 0, 0),
    L(0.25, 0.4, 0.004, 2, 4, 2),
    L(0.15, 1, 0.006, 6, 14, 3),
    L(0.6, 0.9, 0.009, 14, 36, 1),
    L(1, 1, 0.012, 28, 80, 0, false),
  ],
  paper: [
    L(0, 0, 0, 0, 0),
    L(0.3, 0.45, 0.01, 12, 24, 1),
    L(0.4, 1, 0.02, 30, 70, 0.5),
    L(0.7, 1, 0.03, 70, 150, 0.2),
    L(1, 1, 0.04, 120, 280, 0, false),
  ],
  phones: [
    L(0, 0, 0, 0, 0),
    L(1, 1, 0.02, 60, 220, 0, false),
    L(1, 1, 0.06, 160, 700, 0, false),
    L(1, 1, 0.1, 400, 1300, 0, false),
    L(1, 1, 0.2, 900, 2600, 0, false),
  ],
};

/**
 * How much of the plan a quality tier can afford. LOW is a three-year-old
 * phone: a third of the flares still reads as a pyro show, and a phone that
 * holds 30 fps is worth more than the last hundred sparks.
 */
export const ACCESSORY_BUDGET: Record<'low' | 'medium' | 'high' | 'ultra', number> = {
  low: 0.35,
  medium: 0.6,
  high: 1,
  ultra: 1.25,
};

function hash(i: number): number {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

const SALT: Record<AccessoryKind, number> = { flags: 11, flares: 23, smoke: 37, strobes: 53, paper: 71, phones: 97 };

/** Stand of a perimeter fraction — `standOfU`, restated so this file stays pure. */
export function standOfSeatU(u: number): 0 | 1 | 2 | 3 {
  return Math.floor(((u + 0.125) % 1) * 4) as 0 | 1 | 2 | 3;
}

/** Seats of one stand with their position ACROSS that stand (0..1) and depth (0 front..1 back). */
export interface StandSeats { idx: Int32Array; across: Float32Array; depth: Float32Array }

/**
 * Index a seat map by stand once. `across` runs 0..1 over the seats the stand
 * actually has (not the nominal quarter of the perimeter), so "the middle of
 * the stand" is the middle of its seats; `depth` is 0 at that stand's front
 * row and 1 at its back row.
 */
export function indexStands(map: SeatMap): StandSeats[] {
  const lists: number[][] = [[], [], [], []];
  for (let i = 0; i < map.count; i++) lists[standOfSeatU(map.uv[i * 2])].push(i);
  return lists.map((ids, s) => {
    const n = ids.length;
    const idx = Int32Array.from(ids);
    const across = new Float32Array(n);
    const depth = new Float32Array(n);
    if (!n) return { idx, across, depth };
    // Unwrap u around the stand's own centre (East straddles u = 0).
    const centre = s * 0.25;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    const us = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let du = map.uv[ids[k] * 2] - centre;
      if (du > 0.5) du -= 1;
      if (du < -0.5) du += 1;
      us[k] = du;
      if (du < uMin) uMin = du;
      if (du > uMax) uMax = du;
      const v = map.uv[ids[k] * 2 + 1];
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const uw = Math.max(1e-6, uMax - uMin);
    const vw = Math.max(1e-6, vMax - vMin);
    for (let k = 0; k < n; k++) {
      across[k] = (us[k] - uMin) / uw;
      depth[k] = (map.uv[ids[k] * 2 + 1] - vMin) / vw;
    }
    return { idx, across, depth };
  });
}

/**
 * The seats holding one accessory, for one stand, at one level.
 *
 * NESTED: level n is level n-1 plus more fans, never a reshuffle. Turning the
 * flares from Medium to Heavy adds the second half of the stand; it does not
 * make the front line jump to different seats. That is what a slider has to do
 * to feel like "more of the same", and it is checked in verify.
 */
export function planStand(stand: StandSeats, kind: AccessoryKind, level: AccessoryLevel, budget = 1): number[] {
  const chosen: number[] = [];
  const taken = new Set<number>();
  const salt = SALT[kind];
  const n = stand.idx.length;
  if (!n || level <= 0) return chosen;
  for (let lv = 1; lv <= level; lv++) {
    const spec = LEVEL_SPECS[kind][lv];
    const a0 = 0.5 - spec.uSpan / 2;
    const a1 = 0.5 + spec.uSpan / 2;
    const zone: number[] = [];
    for (let k = 0; k < n; k++) {
      if (stand.depth[k] <= spec.vMax + 1e-6 && stand.across[k] >= a0 - 1e-6 && stand.across[k] <= a1 + 1e-6) zone.push(k);
    }
    if (!zone.length) continue;
    const want = Math.round(Math.min(spec.max, Math.max(spec.min, zone.length * spec.density)) * budget);
    const target = Math.max(chosen.length, Math.max(lv === 1 ? 1 : 0, want));
    const add = target - chosen.length;
    if (add <= 0) continue;
    const score = (k: number): number => hash(stand.idx[k] * 31 + salt) + spec.front * stand.depth[k];
    if (spec.even) {
      // Stratified along the stand: one per slice, the best-placed seat in it.
      const bins: number[][] = Array.from({ length: add }, () => []);
      for (const k of zone) {
        if (taken.has(k)) continue;
        const t = (stand.across[k] - a0) / Math.max(1e-6, a1 - a0);
        bins[Math.min(add - 1, Math.max(0, Math.floor(t * add)))].push(k);
      }
      for (const bin of bins) {
        let best = -1, bs = Infinity;
        for (const k of bin) {
          const sc = score(k);
          if (sc < bs) { bs = sc; best = k; }
        }
        if (best >= 0) { taken.add(best); chosen.push(stand.idx[best]); }
      }
    } else {
      const free = zone.filter((k) => !taken.has(k)).sort((x, y) => score(x) - score(y));
      for (let j = 0; j < add && j < free.length; j++) {
        taken.add(free[j]);
        chosen.push(stand.idx[free[j]]);
      }
    }
  }
  return chosen;
}

/** Every holder of one accessory, across the chosen stands. */
export function planHolders(
  stands: StandSeats[],
  kind: AccessoryKind,
  level: AccessoryLevel,
  where: AccessoryWhere,
  budget = 1,
): number[] {
  const out: number[] = [];
  for (const s of standsFor(where)) {
    const st = stands[s];
    if (st) out.push(...planStand(st, kind, level, budget));
  }
  return out;
}

/**
 * How loud all of it is, 0..1 — what the crackle bed and the crowd follow.
 * Flares and strobes are what you hear; flags and paper are silent.
 */
export function pyroLoudness(lv: AccessoryLevels): number {
  return Math.min(1, (lv.flares / 4) * 0.65 + (lv.strobes / 4) * 0.35 + (lv.smoke / 4) * 0.12);
}
