import type { StadiumTemplate } from './types';

/**
 * Generic two-tier 60,000-seat bowl, dimensioned from the reference stadiums:
 * superellipse plan (rounded rectangle, like King Abdullah Sports City / Berlin),
 * a shallower lower tier and a steeper upper tier separated by a walkway.
 *
 * With these numbers the generator emits ≈60k seats:
 * perimeter ≈ 630 m → ~1,250 seats/row at 0.5 m pitch × 48 rows, minus aisles.
 */
export const DEFAULT_TEMPLATE: StadiumTemplate = {
  id: 'generic-bowl-60k',
  name: 'Generic 60k bowl',
  version: 1,
  plan: { a: 92, b: 70, exponent: 2.6 },
  tiers: [
    { rows: 26, rowDepth: 0.85, rakeDeg: 24, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5 },
    { rows: 22, rowDepth: 0.8, rakeDeg: 33, baseElevation: 14.5, baseOffset: 24.5, seatPitch: 0.5 },
  ],
  aisles: { count: 28, widthMeters: 1.2 },
  sectionsPerTier: 28,
  roof: { coverage: 'ring', reach: 0.5, rise: 7, slope: 2.2 },
  // A modern all-seater: panel skin, lights along the roof rim. UEFA notes
  // four corner towers 'will not generally meet' its requirements, so a ground
  // of this size and age would not have them.
  facade: { style: 'cladding' },
  lighting: { style: 'roof-rim' },
};

/** Steep single-tier kop bowl — the Tottenham-style high-resolution wall. */
export const KOP_TEMPLATE: StadiumTemplate = {
  id: 'single-kop-40k',
  name: 'Single-tier kop 40k',
  version: 1,
  plan: { a: 78, b: 60, exponent: 2.7 },
  tiers: [{ rows: 38, rowDepth: 0.8, rakeDeg: 33, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5 }],
  aisles: { count: 24, widthMeters: 1.2 },
  sectionsPerTier: 24,
  // English cantilever: covers most of the stand and sits close over it.
  roof: { coverage: 'ring', reach: 0.62, rise: 5.5, slope: 2.6 },
  // An old British club ground: brick between piers, and the corner pylons
  // that came with it. 4200 K is metal halide, which is what it would still have.
  facade: { style: 'brick' },
  lighting: { style: 'corner-masts', kelvin: 4200 },
};

/**
 * Big shallow oval (p=2.0), Berlin-style continuous wrap. Roofed down the two
 * long sides only, ends open — what an athletics oval usually looks like, and
 * the case that proves partial coverage really works.
 */
export const OVAL_TEMPLATE: StadiumTemplate = {
  id: 'grand-oval-76k',
  name: 'Grand oval 76k',
  version: 1,
  plan: { a: 118, b: 92, exponent: 2.0 },
  tiers: [
    { rows: 30, rowDepth: 0.85, rakeDeg: 22, baseElevation: 1.5, baseOffset: 0, seatPitch: 0.5 },
    { rows: 20, rowDepth: 0.8, rakeDeg: 31, baseElevation: 15.0, baseOffset: 28.0, seatPitch: 0.5 },
  ],
  aisles: { count: 32, widthMeters: 1.2 },
  sectionsPerTier: 32,
  roof: { coverage: 'sides', reach: 0.55, rise: 8, slope: 1.4 },
  // A municipal athletics bowl: open steel behind the stands, and banks of
  // lights along the two covered sides only — nothing over the ends.
  facade: { style: 'truss' },
  lighting: { style: 'side-banks', kelvin: 4800 },
  // An athletics oval: 118 x 92 m of plan comfortably holds a 400 m track.
  track: {},
};

/** All known stadiums. New bowls are data entries here — no code changes. */
export const TEMPLATES: StadiumTemplate[] = [DEFAULT_TEMPLATE, KOP_TEMPLATE, OVAL_TEMPLATE];

/** Club palette presets. Index 0 (empty seat) is implicit and rendered as stadium gray. */
export const PALETTE_PRESETS: Record<string, string[]> = {
  'Royal blue / white': ['#262a33', '#1c5fd9', '#f2f1ec', '#e8b73a', '#10539e'],
  'Black / gold': ['#262a33', '#16161a', '#e8b73a', '#f2f1ec', '#7a5c12'],
  'Green / white': ['#262a33', '#0f7a3d', '#f2f1ec', '#16161a', '#0a4f28'],
  'Red / white / black': ['#262a33', '#c8242c', '#f2f1ec', '#16161a', '#7c1218'],
};

export const DEFAULT_PALETTE = PALETTE_PRESETS['Royal blue / white'];

/** Color used to render index 0 (no card / empty seat). */
export const EMPTY_SEAT_COLOR = 0x262a33;
