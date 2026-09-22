/**
 * The one place that says what a buildable stadium template may contain.
 *
 * This file exists because two others disagreed. `core/stadiumFit` could emit a
 * bowl half-width as small as 15 m and, through `solveRows`, up to 400 rows in a
 * single tier; `core/customStadiums.isValidTemplate` rejects anything under 20 m
 * or over 80 rows. Nothing checked the two against each other, so the estimator
 * was free to produce a stadium the store would not keep:
 *
 *   buildStadium() → panel says "Added 'X'" → addCustomTemplate() writes it to
 *   localStorage → registerCustom() reads it straight back → isValidTemplate()
 *   drops it → the stadium is gone, and nothing anywhere said so.
 *
 * Both files now import these ranges, and `clampTemplate` is the only way to
 * make a fitted template safe. Widening a range here widens it for the validator
 * and the fitter in the same commit, which is the property that was missing.
 */

import type { StadiumTemplate, TierSpec } from './types';

export interface Range { min: number; max: number }

export const LIMITS = {
  /** Bowl half-length and half-width, metres, measured to row 0. */
  planA: { min: 20, max: 200 } as Range,
  planB: { min: 20, max: 200 } as Range,
  /** Superellipse exponent: 2 is an ellipse, 4 is nearly a rounded rectangle. */
  exponent: { min: 1.5, max: 4 } as Range,
  /** Rows in one tier. */
  rows: { min: 1, max: 80 } as Range,
  rowDepth: { min: 0.4, max: 2 } as Range,
  rakeDeg: { min: 0, max: 60 } as Range,
  seatPitch: { min: 0.3, max: 1 } as Range,
  aisleCount: { min: 0, max: 80 } as Range,
  aisleWidth: { min: 0.5, max: 4 } as Range,
  sectionsPerTier: { min: 4, max: 80 } as Range,
  tierCount: { min: 1, max: 4 } as Range,
} as const;

export const clamp = (x: number, r: Range): number => Math.max(r.min, Math.min(r.max, x));

export const inRange = (x: number, r: Range): boolean => x >= r.min && x <= r.max;

/** Total rows a template may hold across every tier — the ceiling `solveRows` must respect. */
export const MAX_TOTAL_ROWS = LIMITS.rows.max * LIMITS.tierCount.max;

/**
 * Force a template inside the ranges above.
 *
 * Called at the end of the fit so a template can never leave `buildStadium` in a
 * state the store will silently refuse. Clamping changes the numbers, which is
 * why `buildStadium` also reports when it had to: a bowl pinned at its limit is
 * a fit that did not really converge, and the panel says so rather than quietly
 * handing back a stadium that is not the one asked for.
 */
export function clampTemplate(t: StadiumTemplate): StadiumTemplate {
  const tiers: TierSpec[] = t.tiers.slice(0, LIMITS.tierCount.max).map((tier) => ({
    ...tier,
    rows: Math.round(clamp(tier.rows, LIMITS.rows)),
    rowDepth: clamp(tier.rowDepth, LIMITS.rowDepth),
    rakeDeg: clamp(tier.rakeDeg, LIMITS.rakeDeg),
    seatPitch: clamp(tier.seatPitch, LIMITS.seatPitch),
  }));
  return {
    ...t,
    plan: {
      a: clamp(t.plan.a, LIMITS.planA),
      b: clamp(t.plan.b, LIMITS.planB),
      exponent: clamp(t.plan.exponent, LIMITS.exponent),
    },
    tiers: tiers.length ? tiers : t.tiers,
    aisles: {
      count: Math.round(clamp(t.aisles.count, LIMITS.aisleCount)),
      widthMeters: clamp(t.aisles.widthMeters, LIMITS.aisleWidth),
    },
    sectionsPerTier: Math.round(clamp(t.sectionsPerTier, LIMITS.sectionsPerTier)),
  };
}

/** Which fields `clampTemplate` would have to move — empty means the fit fits. */
export function outOfRange(t: StadiumTemplate): string[] {
  const out: string[] = [];
  if (!inRange(t.plan.a, LIMITS.planA)) out.push('plan.a');
  if (!inRange(t.plan.b, LIMITS.planB)) out.push('plan.b');
  if (!inRange(t.plan.exponent, LIMITS.exponent)) out.push('plan.exponent');
  if (t.tiers.some((x) => !inRange(x.rows, LIMITS.rows))) out.push('tiers.rows');
  if (!inRange(t.tiers.length, LIMITS.tierCount)) out.push('tiers.length');
  if (!inRange(t.aisles.count, LIMITS.aisleCount)) out.push('aisles.count');
  if (!inRange(t.sectionsPerTier, LIMITS.sectionsPerTier)) out.push('sectionsPerTier');
  return out;
}
