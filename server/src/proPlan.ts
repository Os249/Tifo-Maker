/**
 * Tifo Maker Pro: every number in one place.
 *
 * The free allowances, what each plan may use, the prices and the dates all
 * live here, so changing an offer is one edit in one file (and the tests that
 * read these constants follow it). The plan is written up in the project doc
 * "AI limits and the paid plan" (19 Oct 2026; Pro, crowns and the gift added
 * 25 Oct).
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

export type AllowanceKind = 'std' | 'super' | 'polish' | 'photo' | 'cutout';
export const ALLOWANCE_KINDS: AllowanceKind[] = ['std', 'super', 'polish', 'photo', 'cutout'];

export type Period = 'day' | 'week' | 'month';

/** A plan someone can hold. 'free' is nobody's row: it is what no pass means. */
export type PassPlan = 'match' | 'season' | 'gift' | 'group';
export const PASS_PLANS: PassPlan[] = ['match', 'season', 'gift', 'group'];
export type PlanKind = 'free' | PassPlan;

/** Plans that are paid for (the Supporter badge). The gift is not. */
export const PAID_PLANS: PassPlan[] = ['match', 'season', 'group'];

export interface Window {
  period: Period;
  limit: number;
}

/** What a free account gets. Only delivered results count (see aiRoutes). */
export const FREE_WINDOWS: Record<AllowanceKind, Window[]> = {
  std: [{ period: 'day', limit: 10 }],
  super: [{ period: 'week', limit: 3 }],
  polish: [{ period: 'week', limit: 3 }],
  photo: [{ period: 'week', limit: 2 }],
  cutout: [{ period: 'week', limit: 1 }],
};

/**
 * Pro is generous, not unlimited: every kind still has a ceiling, because each
 * one costs money per use and a pass costs the same whoever holds it. Standard
 * designs, Polish and photo reading keep the per-day ceilings paid accounts
 * were already held to; Super and the cut-out have the plan's own.
 */
const PRO_STD: Window[] = [{ period: 'day', limit: 50 }];
const PRO_POLISH: Window[] = [{ period: 'day', limit: 30 }];
const PRO_PHOTO: Window[] = [{ period: 'day', limit: 24 }];

export const PLAN_WINDOWS: Record<PassPlan, Record<AllowanceKind, Window[]>> = {
  match: {
    std: PRO_STD,
    super: [{ period: 'day', limit: 15 }],
    polish: PRO_POLISH,
    photo: PRO_PHOTO,
    cutout: [{ period: 'day', limit: 10 }],
  },
  season: {
    std: PRO_STD,
    super: [{ period: 'day', limit: 10 }, { period: 'month', limit: 150 }],
    polish: PRO_POLISH,
    photo: PRO_PHOTO,
    cutout: [{ period: 'day', limit: 10 }, { period: 'month', limit: 60 }],
  },
  gift: {
    std: PRO_STD,
    super: [{ period: 'day', limit: 10 }],
    polish: PRO_POLISH,
    photo: PRO_PHOTO,
    cutout: [{ period: 'day', limit: 10 }],
  },
  group: {
    std: PRO_STD,
    super: [{ period: 'day', limit: 10 }, { period: 'month', limit: 150 }],
    polish: PRO_POLISH,
    photo: PRO_PHOTO,
    cutout: [{ period: 'day', limit: 10 }, { period: 'month', limit: 60 }],
  },
};

/** When several passes overlap, the one whose ceilings are the most generous is used. */
export const PLAN_RANK: Record<PassPlan, number> = { gift: 1, match: 2, season: 3, group: 4 };

/** 23:59:59 on 31 May 2027 in Riyadh: the season's end. */
export const SEASON_END = '2027-05-31T20:59:59.000Z';

/** Prices and dates, as the Pro page shows them. */
export const OFFER = {
  currency: 'SAR',
  match: { price: 9, hours: 72 },
  season: { price: 99, endsAt: SEASON_END },
  /** The Match Pass's price comes off a Season Pass bought within this many days. */
  matchCreditDays: 7,
  gift: { days: 7, claimBy: SEASON_END },
  /** Offered for this many hours after a gift ends. */
  giftEndOffer: { price: 79, hours: 48 },
  group: { from: 499 },
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
export function periodStart(period: Period, now: Date): Date {
  const { y, m, d, dow } = local(now);
  if (period === 'day') return new Date(Date.UTC(y, m, d) - RIYADH_MS);
  if (period === 'week') return new Date(Date.UTC(y, m, d - dow) - RIYADH_MS);
  return new Date(Date.UTC(y, m, 1) - RIYADH_MS);
}

/** The instant the period containing `now` ends (and the next one begins). */
export function periodEnd(period: Period, now: Date): Date {
  const start = periodStart(period, now);
  if (period === 'day') return new Date(start.getTime() + DAY_MS);
  if (period === 'week') return new Date(start.getTime() + 7 * DAY_MS);
  const { y, m } = local(now);
  return new Date(Date.UTC(y, m + 1, 1) - RIYADH_MS);
}

/** The key a period's count is stored under: d:2026-10-28, w:2026-10-25, m:2026-10. */
export function periodKey(period: Period, now: Date): string {
  const s = new Date(periodStart(period, now).getTime() + RIYADH_MS).toISOString();
  if (period === 'month') return `m:${s.slice(0, 7)}`;
  return `${period === 'day' ? 'd' : 'w'}:${s.slice(0, 10)}`;
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
