/**
 * The cost and per-mode figures in /admin → AI, built the same way for the
 * memory and the Postgres stores.
 *
 * Both stores reduce their rows to the same groups (one per day × mode ×
 * outcome × model) and this module turns those into the dashboard's numbers,
 * so the dev dashboard and production cannot drift apart.
 */
import type { AiCostStats, AiMode, AiModeOutcomes, AiOutcome } from './repo';

export const AI_MODES: AiMode[] = ['std', 'super', 'polish', 'photo'];
export const AI_OUTCOMES: AiOutcome[] = ['model', 'cache', 'quick', 'quota', 'busy', 'blocked', 'invalid'];

/** Modes whose 'model' outcome is a DESIGN (polish and photo are not). */
export const DESIGN_MODES: AiMode[] = ['std', 'super'];

export const zeroCounts = (): AiModeOutcomes => ({ model: 0, cache: 0, quick: 0, quota: 0, busy: 0, blocked: 0, invalid: 0, all: 0, limited: 0 });

/**
 * Failure reasons that are OUR limits, not the model failing: the daily
 * budget breaker (and an account's daily Polish/photo share, recorded the
 * same way) and no provider configured. Counted apart so a day the breaker
 * trips does not read as the model getting worse.
 */
export const LIMIT_REASONS = ['budget', 'no_provider'] as const;
export const isLimitReason = (r: string | null | undefined): boolean => !!r && (LIMIT_REASONS as readonly string[]).includes(r);

/** One group of requests: same UTC day, mode, outcome and model. */
export interface AiGroup {
  day: string;
  mode: AiMode;
  outcome: AiOutcome;
  model: string | null;
  /** Requests in the group. */
  n: number;
  /** Of those, how many were refused by our own limits (LIMIT_REASONS). */
  limited: number;
  /** Of those, how many carried token counts (recorded from October 2026). */
  measured: number;
  /** Measured requests whose cost could not be priced. */
  unpriced: number;
  costMicros: number;
  tokensIn: number;
  tokensOut: number;
  tokensThought: number;
  tokensCached: number;
  pictures: number;
  latencySum: number;
  latencyN: number;
}

export function modeOutcomes(groups: AiGroup[]): Record<AiMode, AiModeOutcomes> {
  const out = { std: zeroCounts(), super: zeroCounts(), polish: zeroCounts(), photo: zeroCounts() } as Record<AiMode, AiModeOutcomes>;
  for (const g of groups) {
    const c = out[g.mode];
    if (!c || !(AI_OUTCOMES as string[]).includes(g.outcome)) continue;
    c[g.outcome] += g.n;
    c.all += g.n;
    c.limited += g.limited;
  }
  return out;
}

export function costStats(groups: AiGroup[], measuredSince: string | null): AiCostStats {
  const byMode = {} as AiCostStats['byMode'];
  const latency = {} as AiCostStats['latencyMs'];
  for (const m of AI_MODES) { byMode[m] = { measured: 0, delivered: 0, usd: 0, perDelivered: null }; latency[m] = null; }
  const lat: Record<string, { sum: number; n: number }> = {};
  const perDay = new Map<string, number>();
  const models = new Map<string, { requests: number; micros: number; unpriced: number }>();
  const unpricedDelivered: Record<string, number> = {};
  const tokens = { in: 0, out: 0, thought: 0, cached: 0 };
  let measured = 0;
  let micros = 0;
  let unpriced = 0;
  let pictures = 0;

  for (const g of groups) {
    if (!g.measured) continue;
    measured += g.measured;
    micros += g.costMicros;
    unpriced += g.unpriced;
    pictures += g.pictures;
    tokens.in += g.tokensIn;
    tokens.out += g.tokensOut;
    tokens.thought += g.tokensThought;
    tokens.cached += g.tokensCached;
    perDay.set(g.day, (perDay.get(g.day) ?? 0) + g.costMicros);
    const bm = byMode[g.mode];
    if (bm) {
      bm.measured += g.measured;
      bm.usd += g.costMicros / 1e6;
      if (g.outcome === 'model') {
        bm.delivered += g.measured;
        unpricedDelivered[g.mode] = (unpricedDelivered[g.mode] ?? 0) + g.unpriced;
      }
    }
    if (g.outcome === 'model') {
      const l = lat[g.mode] ?? { sum: 0, n: 0 };
      l.sum += g.latencySum; l.n += g.latencyN;
      lat[g.mode] = l;
      if (g.model) {
        const mm = models.get(g.model) ?? { requests: 0, micros: 0, unpriced: 0 };
        mm.requests += g.measured; mm.micros += g.costMicros; mm.unpriced += g.unpriced;
        models.set(g.model, mm);
      }
    }
  }
  for (const m of AI_MODES) {
    const bm = byMode[m];
    // Failed calls cost money too, so the average is all spend over what was
    // delivered. Only PRICED deliveries divide it: a result with no price
    // added nothing to the spend, and counting it would drag the average
    // toward $0 (none priced at all reads "—", never "$0").
    const priced = bm.delivered - (unpricedDelivered[m] ?? 0);
    bm.perDelivered = priced > 0 ? bm.usd / priced : null;
    const l = lat[m];
    latency[m] = l && l.n ? Math.round(l.sum / l.n) : null;
  }
  return {
    measuredSince,
    measured,
    usd: micros / 1e6,
    unpriced,
    perDay: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, m]) => ({ day, usd: m / 1e6 })),
    byMode,
    tokens,
    pictures,
    models: [...models.entries()]
      .map(([model, v]) => ({ model, requests: v.requests, usd: v.unpriced >= v.requests ? null : v.micros / 1e6 }))
      .sort((a, b) => b.requests - a.requests),
    latencyMs: latency,
  };
}
