import type { StadiumTemplate } from './types';
import { LIMITS, inRange } from './templateLimits';
import { validBlocks } from './blocks';

/**
 * The template check custom and community grounds are held to, in a module of
 * its own (performance plan P2.7): the seat-map client runs it on every page
 * that builds a seat map, and it used to come with core/customStadiums.ts,
 * which brought the whole stadium catalogue with it. customStadiums.ts and the
 * server still import it under the same name.
 */

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Strict structural + range validation — protects the generator from bad input.
 *
 * The ranges come from `templateLimits` rather than being written out here. They
 * used to be literals, and `stadiumFit` had its own, different literals: the two
 * disagreed about the minimum bowl width and the maximum row count, so the
 * estimator could build a stadium this function would then quietly reject.
 */
export function isValidTemplate(t: unknown): t is StadiumTemplate {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false;
  const plan = o.plan as Record<string, unknown> | undefined;
  if (!plan || !num(plan.a) || !num(plan.b) || !num(plan.exponent)) return false;
  if (!inRange(plan.a, LIMITS.planA) || !inRange(plan.b, LIMITS.planB) || !inRange(plan.exponent, LIMITS.exponent)) return false;
  if (!Array.isArray(o.tiers) || !inRange(o.tiers.length, LIMITS.tierCount)) return false;
  for (const tier of o.tiers as Record<string, unknown>[]) {
    if (!tier || !num(tier.rows) || !inRange(tier.rows, LIMITS.rows)) return false;
    if (!num(tier.rowDepth) || !inRange(tier.rowDepth, LIMITS.rowDepth)) return false;
    if (!num(tier.rakeDeg) || !inRange(tier.rakeDeg, LIMITS.rakeDeg)) return false;
    if (!num(tier.baseElevation) || !num(tier.baseOffset)) return false;
    if (!num(tier.seatPitch) || !inRange(tier.seatPitch, LIMITS.seatPitch)) return false;
    // A real block layout reaches the server's seat generator, so it is held
    // to bounds (core/blocks), on an even-rows tier as the generator needs (a
    // straight tier with its stands).
    if (tier.blocks !== undefined && (o.evenRows !== true || (tier.straight && !Array.isArray(tier.stands)) || !validBlocks(tier.blocks, tier.rows))) return false;
  }
  const aisles = o.aisles as Record<string, unknown> | undefined;
  if (!aisles || !num(aisles.count) || !inRange(aisles.count, LIMITS.aisleCount) || !num(aisles.widthMeters) || !inRange(aisles.widthMeters, LIMITS.aisleWidth)) return false;
  if (!num(o.sectionsPerTier) || !inRange(o.sectionsPerTier, LIMITS.sectionsPerTier)) return false;
  return true;
}
