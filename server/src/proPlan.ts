/**
 * Tifo Maker Pro: every number in one place.
 *
 * The free allowances, what each plan may use, the prices and the dates all
 * live here, so changing an offer is one edit in one file (and the tests that
 * read these constants follow it). The plan is written up in the project doc
 * "AI limits and the paid plan" (19 Oct 2026; Pro, crowns and the gift added
 * 25 Oct) and "Tifo Maker Pro: monthly plan brief" (30 Oct: one SAR 19 plan,
 * monthly ceilings on every kind, a gift that never expires).
 *
 * Periods are Riyadh time (UTC+3, no daylight saving): a day starts at 00:00
 * in Riyadh and the week starts on Sunday 00:00, which is Saturday 21:00 UTC.
 * Fans design around the weekend's matches, so a weekly allowance refills
 * after them.
 *
 * Nothing in this file decides anything on its own: the server reads it, the
 * browser is only told the results. A browser cannot change a limit or turn
 * Pro on; it can only display what /api/pro says.
 */

/**
 * What is metered. 'std' is an AI design: since 29 Oct 2026 every AI design
 * runs the one whole-stadium pipeline (the director), so there is no separate
 * Super allowance any more; a request that still says mode: "super" is
 * metered as a design like any other (aiRoutes).
 */
export type AllowanceKind = 'std' | 'polish' | 'photo' | 'cutout';
export const ALLOWANCE_KINDS: AllowanceKind[] = ['std', 'polish', 'photo', 'cutout'];

/**
 * day, week and month are Riyadh calendar periods. 'cycle' is a pass's own
 * 30 days, counted from the moment it started: a month of Pro bought on the
 * 20th gets one month of allowance, not the rest of this one and the next.
 * The browser is told 'month' for a cycle (with the cycle's own reset time).
 */
export type Period = 'day' | 'week' | 'month' | 'cycle';

/** A plan someone can hold. 'free' is nobody's row: it is what no pass means. */
export type PassPlan = 'monthly' | 'gift';
export const PASS_PLANS: PassPlan[] = ['monthly', 'gift'];
export type PlanKind = 'free' | PassPlan;

/** Plans that are paid for (the Supporter crown). The gift is not. */
export const PAID_PLANS: PassPlan[] = ['monthly'];

/**
 * The plans of the first build (28 Oct 2026), before Pro became one monthly
 * plan. A pass granted under one of them is read as a month of Pro until the
 * schema migration (schema.sql, "Pro becomes one monthly plan") has renamed it.
 */
export const LEGACY_PAID_PLANS = ['match', 'season', 'group'] as const;

/** A stored plan name as today's plan: the legacy names are the monthly plan. */
export function normalizePlan(plan: string): PassPlan {
  return plan === 'gift' ? 'gift' : 'monthly';
}

/** A pass's allowance month. */
export const CYCLE_DAYS = 30;

export interface Window {
  period: Period;
  limit: number;
}

/**
 * What a free account gets. Only delivered results count (see aiRoutes).
 * The month's ceiling keeps a heavy free account below what Pro gives (at
 * 10 a day, a month could otherwise hold 300 designs, more than Pro's 70).
 */
export const FREE_WINDOWS: Record<AllowanceKind, Window[]> = {
  std: [{ period: 'day', limit: 10 }, { period: 'month', limit: 40 }],
  polish: [{ period: 'week', limit: 3 }],
  photo: [{ period: 'week', limit: 2 }],
  cutout: [{ period: 'week', limit: 1 }],
};

/**
 * Pro is generous, not unlimited: every kind has a day's ceiling and a
 * month's (the pass's own 30 days), because each use costs money and a month
 * of Pro costs the same whoever holds it. Measured on /admin -> AI (30 days to
 * 30 Oct 2026, list prices): a design about $0.022 with its picture, a Polish
 * $0.013, a smart cut-out $0.018, a stadium photo read about $0.04 (estimated:
 * never used yet). One member who uses every last one costs at most about
 * $2.47 a month (70 x 0.022 + 20 x 0.013 + 10 x 0.04 + 15 x 0.018), against
 * SAR 19 (about $5).
 *
 * The 7-day gift has the same ceilings; its month is the gift itself.
 */
const PRO_WINDOWS: Record<AllowanceKind, Window[]> = {
  std: [{ period: 'day', limit: 15 }, { period: 'cycle', limit: 70 }],
  polish: [{ period: 'day', limit: 10 }, { period: 'cycle', limit: 20 }],
  photo: [{ period: 'day', limit: 3 }, { period: 'cycle', limit: 10 }],
  cutout: [{ period: 'day', limit: 5 }, { period: 'cycle', limit: 15 }],
};

export const PLAN_WINDOWS: Record<PassPlan, Record<AllowanceKind, Window[]>> = {
  monthly: PRO_WINDOWS,
  gift: PRO_WINDOWS,
};

/** When several passes overlap, the paid one is used, then the one that ends last. */
export const PLAN_RANK: Record<PassPlan, number> = { gift: 1, monthly: 2 };

/** Prices and dates, as the Pro page shows them. */
export const OFFER = {
  currency: 'SAR',
  /** One plan: 30 days of Pro. Version 1 of payments sells it outright, with no renewal. */
  monthly: { price: 19, days: CYCLE_DAYS },
  /** Once per account, started whenever its holder likes: it never expires unclaimed. */
  gift: { days: 7 },
  /**
   * There is no payment provider yet (Moyasar needs the freelance document
   * first). Until there is, every buy button asks to be told when Pro opens
   * instead. This is a constant on purpose: turning it on without the
   * payment code behind it would put buttons on the page that go nowhere.
   */
  paymentsOpen: false,
} as const;

// --------------------------------------------------------------- periods ---

const RIYADH_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function local(now: Date): { y: number; m: number; d: number; dow: number } {
  const t = new Date(now.getTime() + RIYADH_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** The instant the period containing `now` began. */
export function periodStart(period: Exclude<Period, 'cycle'>, now: Date): Date {
  const { y, m, d, dow } = local(now);
  if (period === 'day') return new Date(Date.UTC(y, m, d) - RIYADH_MS);
  if (period === 'week') return new Date(Date.UTC(y, m, d - dow) - RIYADH_MS);
  return new Date(Date.UTC(y, m, 1) - RIYADH_MS);
}

/** The instant the period containing `now` ends (and the next one begins). */
export function periodEnd(period: Exclude<Period, 'cycle'>, now: Date): Date {
  const start = periodStart(period, now);
  if (period === 'day') return new Date(start.getTime() + DAY_MS);
  if (period === 'week') return new Date(start.getTime() + 7 * DAY_MS);
  const { y, m } = local(now);
  return new Date(Date.UTC(y, m + 1, 1) - RIYADH_MS);
}

/** The key a period's count is stored under: d:2026-10-28, w:2026-10-25, m:2026-10. */
export function periodKey(period: Exclude<Period, 'cycle'>, now: Date): string {
  const s = new Date(periodStart(period, now).getTime() + RIYADH_MS).toISOString();
  if (period === 'month') return `m:${s.slice(0, 7)}`;
  return `${period === 'day' ? 'd' : 'w'}:${s.slice(0, 10)}`;
}

/**
 * A pass's allowance month containing `now`: the n-th run of CYCLE_DAYS from
 * the pass's start, keyed by the pass ('c:<pass id>:<n>'), ending after 30
 * days or when the pass does, whichever comes first.
 */
export function cycleOf(pass: { id: string; startsAt: string; endsAt: string }, now: Date): { key: string; end: Date } {
  const start = Date.parse(pass.startsAt);
  const len = CYCLE_DAYS * DAY_MS;
  const n = Math.max(0, Math.floor((now.getTime() - start) / len));
  const end = Math.min(start + (n + 1) * len, Date.parse(pass.endsAt));
  return { key: `c:${pass.id}:${n}`, end: new Date(end) };
}

// ------------------------------------------------------------------ mode ---

/**
 * Whether the new rules apply to an account.
 *
 *   PRO_MODE=off      (the default) nobody: everyone keeps today's rules.
 *   PRO_MODE=preview  only the accounts named in PRO_PREVIEW_USERS.
 *   PRO_MODE=on       everyone.
 *
 * Preview is how the owner tries the whole thing on the live site, as a fan
 * would, before anyone else sees it. Usernames are matched ignoring case.
 */
export type ProMode = 'off' | 'preview' | 'on';

export function proMode(env: NodeJS.ProcessEnv = process.env): ProMode {
  const v = (env.PRO_MODE ?? '').trim().toLowerCase();
  return v === 'on' || v === 'preview' ? v : 'off';
}

export function previewUsers(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.PRO_PREVIEW_USERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function liveFor(username: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = proMode(env);
  if (mode === 'on') return true;
  if (mode === 'off' || !username) return false;
  return previewUsers(env).has(username.toLowerCase());
}
