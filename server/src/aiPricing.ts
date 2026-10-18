/**
 * What an AI call costs, at list price, so /admin → AI can show spend.
 *
 * Every Gemini reply carries `usageMetadata` (input, output, thinking and cached
 * tokens). Until October 2026 nothing read it, so the only cost figures anyone
 * had were estimates from prompt sizes. This table turns measured tokens into
 * dollars at the moment of the call, and the event row keeps that figure — a
 * price change later (3.6 Flash doubles on 1 January 2027) must not rewrite
 * what last month cost.
 *
 * LIST PRICE, paid tier. A project on Google's free tier pays nothing, so the
 * dashboard labels these as estimates. Thinking tokens are billed as output.
 * Sources (checked 17 Oct 2026): ai.google.dev/gemini-api/docs/pricing,
 * the Pollinations image registry (shared/registry/image.ts).
 *
 * A model missing here costs `null`, not 0: an unknown price must read as
 * "unknown" in the dashboard rather than as free.
 */

export interface TokenUsage {
  /** Prompt tokens, cached ones included. */
  in: number;
  /** Answer tokens, NOT including thinking. */
  out: number;
  /** Thinking tokens (billed as output). */
  thought: number;
  /** Prompt tokens served from Google's cache (a subset of `in`). */
  cached: number;
  /** Provider HTTP calls made, failed ones included. */
  calls: number;
  /** Estimated cost in millionths of a dollar; null when any call's price is unknown. */
  costMicros: number | null;
}

export const zeroUsage = (): TokenUsage => ({ in: 0, out: 0, thought: 0, cached: 0, calls: 0, costMicros: 0 });

/** USD per million tokens. `cached` defaults to the input price. */
interface TextPrice { in: number; out: number; cached?: number }

/** 3.6 Flash list price changes on this date (Google pricing page). */
const FLASH_REPRICE = Date.UTC(2027, 0, 1);

function flashPrice(at: Date): TextPrice {
  return at.getTime() >= FLASH_REPRICE ? { in: 1.5, out: 7.5, cached: 0.15 } : { in: 0.75, out: 3.75, cached: 0.075 };
}

/**
 * Text models. `gemini-3.5-flash` is deprecated and routed to 3.6 Flash by
 * Google; billing it at 3.6 rates is an assumption Google has not confirmed.
 */
const TEXT: Array<[RegExp, (at: Date) => TextPrice]> = [
  [/^gemini-3\.(?:5|6|8)-flash$/, flashPrice],
  [/^gemini-3\.1-flash-lite$/, () => ({ in: 0.25, out: 1.5, cached: 0.025 })],
  [/^gemini-3\.5-flash-lite$/, () => ({ in: 0.3, out: 2.5, cached: 0.03 })],
  [/^gemini-2\.5-flash$/, () => ({ in: 0.3, out: 2.5, cached: 0.03 })],
];

export function textPrice(model: string | undefined, at: Date = new Date()): TextPrice | null {
  if (!model) return null;
  const m = model.trim().toLowerCase().replace(/^models\//, '');
  for (const [re, price] of TEXT) if (re.test(m)) return price(at);
  return null;
}

/** Cost of one text call in micro-dollars, or null when the model's price is unknown. */
export function textCostMicros(model: string | undefined, u: Pick<TokenUsage, 'in' | 'out' | 'thought' | 'cached'>, at: Date = new Date()): number | null {
  if (u.in === 0 && u.out === 0 && u.thought === 0) return 0; // nothing billed (a refused call)
  const p = textPrice(model, at);
  if (!p) return null;
  const cached = Math.min(u.cached, u.in);
  const usd = ((u.in - cached) * p.in + cached * (p.cached ?? p.in) + (u.out + u.thought) * p.out) / 1e6;
  return Math.round(usd * 1e6);
}

/** Pictures: flat per delivered image. Pollinations prices are in pollen (1 pollen ≈ $1). */
const PICTURES: Record<string, number> = {
  'pollinations:flux': 0.002,
  'pollinations:zimage': 0.004,
  'pollinations:klein': 0.005,
  'gemini:gemini-2.5-flash-image': 0.039,
  'gemini:gemini-3.1-flash-lite-image': 0.0336,
  'gemini:gemini-3.1-flash-image': 0.067,
};

export function pictureCostMicros(provider: string | undefined, model: string | undefined): number | null {
  if (!provider) return null;
  const usd = PICTURES[`${provider}:${(model ?? '').trim().toLowerCase()}`];
  return usd === undefined ? null : Math.round(usd * 1e6);
}

/** Sum two usages. An unknown cost on either side keeps the total unknown. */
export function addUsage(a: TokenUsage, b: TokenUsage | undefined | null): TokenUsage {
  if (!b) return a;
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    thought: a.thought + b.thought,
    cached: a.cached + b.cached,
    calls: a.calls + b.calls,
    costMicros: a.costMicros === null || b.costMicros === null ? null : a.costMicros + b.costMicros,
  };
}

/** Add a picture's cost to a usage. */
export function addCostMicros(u: TokenUsage, micros: number | null): TokenUsage {
  return { ...u, costMicros: u.costMicros === null || micros === null ? null : u.costMicros + micros };
}
