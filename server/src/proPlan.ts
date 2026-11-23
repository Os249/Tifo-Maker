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
 *
 * 'critique' is one AI Critique run on the design in hand and 'chat' one
 * follow-up message to it (18 Nov 2026). Each has a counter of its own:
 * neither ever draws from 'std', whatever a run costs.
 */
export type AllowanceKind = 'std' | 'polish' | 'photo' | 'cutout' | 'critique' | 'chat';
export const ALLOWANCE_KINDS: AllowanceKind[] = ['std', 'polish', 'photo', 'cutout', 'critique', 'chat'];

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
 *
 * AI designs: 3 a day, 40 a month (Osamh's decision, 20 Nov 2026, the day Pro
 * went on sale; it was 10 a day). At 10 a day against Pro's 15, the day's
 * difference was not worth paying for; at 3 against 15 it is. The month's 40
 * stays, so a fan who designs a few times a week loses nothing.
 *
 * AI reviews: one a day, with no week's or month's ceiling (the same day; it
 * was 3 a week). A review every day, where Pro gives 6 a day.
 */
export const FREE_WINDOWS: Record<AllowanceKind, Window[]> = {
  std: [{ period: 'day', limit: 3 }, { period: 'month', limit: 40 }],
  polish: [{ period: 'week', limit: 3 }],
  photo: [{ period: 'week', limit: 2 }],
  cutout: [{ period: 'week', limit: 1 }],
  critique: [{ period: 'day', limit: 1 }],
  chat: [{ period: 'week', limit: 20 }],
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
/**
 * pq-photo: whether "Stadium from a photo" is sold as part of Pro.
 *
 * Measured on 1 Nov 2026 on 35 real photos of 18 grounds the site models
 * (docs/pro-quality/photo.md), the stadium it builds rates 6 of 10: the seats'
 * colour, box or bowl, tiers, roof and track now come out right most of the
 * time, but every stand is drawn the same, and the photo only works after the
 * ground has been found on the map. Osamh's rule is that a perk under 8 comes
 * off the list, so it is off: Pro holders get the free allowance for it, and
 * /pro and the Pro sheets do not offer it as something Pro adds. The feature
 * itself stays, free, for everyone. true puts it back on sale.
 */
export const PHOTO_ON_PRO = false;

/**
 * Whether more AI designs and more Polish are sold as part of Pro.
 *
 * Measured on 1 Nov 2026 with an eval of 20 designs (10 briefs, mostly Saudi
 * clubs, half in Arabic, on Kingdom Arena and the Jewel), each rendered at
 * seat resolution and from the TV camera and graded by Claude Opus 5.5
 * against a written rubric (legibility from the TV camera, club identity,
 * composition, hero, use of the bowl, phrase, Arabic, "would a curva hold
 * this up"): today's designs average 3 to 6 of 10, and a dearer pipeline
 * (a stronger director plus a critique round at seat resolution) moved them
 * by under a point. More of a design that rates 4 is not worth paying for,
 * so, under the same rule as the photo, they are off the list: Pro holders
 * get the free allowances, /pro and the Pro sheets do not offer them, and
 * the AI panel does not sell Pro when one runs out. The AI itself stays,
 * free, for everyone. true puts them back on sale at the ceilings below.
 *
 * Back on the list on 8 Nov 2026, Osamh's decision: Pro holders get more
 * designs and Polishes (the ceilings below), /pro and the Pro sheets list
 * them again, and running out offers Pro or the gift.
 */
export const AI_ON_PRO = true;

/**
 * Kinds Pro gives more of that /pro and the Pro sheets do not list (19 Nov
 * 2026, the day before Pro went on sale).
 *
 * The smart cut-out was failing on the live site, and a page that takes money
 * must not promise it. Unlisted is narrower than PHOTO_ON_PRO above: nothing
 * about the allowance changes (a Pro member still gets Pro's cut-outs once it
 * works again), it is only not advertised. /api/pro names these kinds
 * (`unlisted`), and the page and the sheets leave them out. An empty list
 * puts the cut-out back on /pro.
 */
export const UNLISTED: AllowanceKind[] = ['cutout'];

const PRO_WINDOWS: Record<AllowanceKind, Window[]> = {
  std: AI_ON_PRO ? [{ period: 'day', limit: 15 }, { period: 'cycle', limit: 70 }] : FREE_WINDOWS.std,
  polish: AI_ON_PRO ? [{ period: 'day', limit: 10 }, { period: 'cycle', limit: 20 }] : FREE_WINDOWS.polish,
  photo: PHOTO_ON_PRO ? [{ period: 'day', limit: 3 }, { period: 'cycle', limit: 10 }] : FREE_WINDOWS.photo,
  cutout: [{ period: 'day', limit: 5 }, { period: 'cycle', limit: 15 }],
  // Measured on 18 Nov 2026 (scripts/measure-critique.mts): a review $0.018 on
  // Sonnet 5.5 with a cold cache, a chat message $0.0007 on Haiku 5.5. A
  // member at both ceilings costs 40 x 0.018 + 300 x 0.0007 = $0.93 a month.
  critique: AI_ON_PRO ? [{ period: 'day', limit: 6 }, { period: 'cycle', limit: 40 }] : FREE_WINDOWS.critique,
  chat: AI_ON_PRO ? [{ period: 'day', limit: 40 }, { period: 'cycle', limit: 300 }] : FREE_WINDOWS.chat,
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
  /**
   * One plan: 30 days of Pro. `price` is the regular price, SAR 19.99 (set
   * from the fans' answers to the price question, 19 Nov 2026; it was a
   * planned SAR 19 before anything was sold). `launchPrice` is what an order
   * costs while the launch price runs (proLaunch.ts priceAt, until the day in
   * PRO_LAUNCH_PRICE_UNTIL); with no such day set, Pro costs `price`.
   * Auto-renew always renews at `price`. Halalas: 1999 and 1399.
   */
  monthly: { price: 19.99, launchPrice: 13.99, days: CYCLE_DAYS },
  /**
   * The match pass (22 Nov 2026): Pro for one match week, bought outright,
   * never renewed. These are its numbers when PRO_MATCH_PRICE and
   * PRO_MATCH_DAYS do not say otherwise; nothing is sold until PRO_MATCH_PASS
   * is on (matchPass, below). Halalas: 499.
   */
  match: { price: 4.99, days: 3 },
  /**
   * The year (22 Nov 2026): 365 days of the same Pro, one payment, never
   * renewed. SAR 89.99 is Osamh's decision of that day (12 months at SAR 9.99
   * are SAR 119.88; this is SAR 7.50 a month). PRO_YEAR_PRICE says otherwise;
   * nothing is sold until PRO_YEAR is on (yearPlan, below). Halalas: 8999.
   */
  year: { price: 89.99, days: 365 },
  /** Once per account, started whenever its holder likes: it never expires unclaimed. */
  gift: { days: 7 },
  /*
   * Whether the month can be bought is no longer a constant here (it was
   * `paymentsOpen: false` until 12 Nov 2026): it is payments.ts's switches,
   * PRO_PAYMENTS and the Moyasar key, all off by default. monthly.price above
   * is what Moyasar charges once they are on.
   */
} as const;

// -------------------------------------------------------------- settings ---
//
// (22 Nov 2026.) Everything below is OFF until its own variable is set, so a
// deploy changes nothing by itself. docs/pro-turnaround.md has the order to
// switch them on.
//
//   PRO_MONTHLY_PRICE=9.99   what 30 days of Pro cost, in riyals. Set, it IS
//                            the price: there is no launch price beside it,
//                            and auto-renew renews at it. Unset, the prices
//                            above and PRO_LAUNCH_PRICE_UNTIL decide, as before.
//   PRO_MATCH_PASS=on        the match pass is sold.
//   PRO_MATCH_PRICE=4.99     its price in riyals (default OFFER.match.price).
//   PRO_MATCH_DAYS=3         its length in whole days (default OFFER.match.days).
//   PRO_AUTO_GIFT=on         the 7-day gift starts by itself (pro.ts giftFor).
//   PRO_GIFT_MAILS=on        the gift's three emails are sent (proGift.ts).
//   PRO_POST_OFFERS=on       Pro and the account offer show on Post it and share.
//   PRO_YEAR=on              the year is sold (365 days, one payment, never renews).
//   PRO_YEAR_PRICE=89.99     its price in riyals (default OFFER.year.price).
//   PRO_THREE_PLANS=on       /pro is the three-plan page (the price list), and the
//                            sheets name every plan on sale beside the month.

const settingOn = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';

/**
 * One payment may not pass this (Moyasar's limit on the account is SAR 100 a
 * payment): a price setting above it is refused rather than sold and declined.
 */
export const PRICE_MAX_HALALAS = 100_00;

/** A price in riyals as typed into a variable ("9.99", "10") as halalas, or null when it is not one. */
export function readPrice(v: string | undefined): number | null {
  const s = (v ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const h = Math.round(Number(s) * 100);
  return h >= 100 && h <= PRICE_MAX_HALALAS ? h : null;
}

/** PRO_MONTHLY_PRICE in halalas, or null when it is unset (or not a price: then it is ignored, and /admin says so). */
export function monthlyPriceSetting(env: NodeJS.ProcessEnv = process.env): number | null {
  return readPrice(env.PRO_MONTHLY_PRICE);
}

/** PRO_MONTHLY_PRICE is set but cannot be read as a price from SAR 1 to SAR 100. */
export function monthlyPriceInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.PRO_MONTHLY_PRICE ?? '').trim() && monthlyPriceSetting(env) === null;
}

export interface MatchPass {
  /** Sold: PRO_MATCH_PASS=on (and, like everything paid, only where payments are open). */
  on: boolean;
  halalas: number;
  days: number;
}

/** The match pass as the settings have it. A price or a length that cannot be read falls back to OFFER.match. */
export function matchPass(env: NodeJS.ProcessEnv = process.env): MatchPass {
  const d = (env.PRO_MATCH_DAYS ?? '').trim();
  const days = /^\d{1,2}$/.test(d) && Number(d) >= 1 && Number(d) <= 14 ? Number(d) : OFFER.match.days;
  return { on: settingOn(env.PRO_MATCH_PASS), halalas: readPrice(env.PRO_MATCH_PRICE) ?? Math.round(OFFER.match.price * 100), days };
}

export interface YearPlan {
  /** Sold: PRO_YEAR=on (and, like everything paid, only where payments are open). */
  on: boolean;
  halalas: number;
  days: number;
}

/**
 * The year as the settings have it. Its length is not a setting: a year is 365
 * days. A price that cannot be read (or is over the ceiling) falls back to
 * OFFER.year, and /admin says so (yearPriceInvalid).
 */
export function yearPlan(env: NodeJS.ProcessEnv = process.env): YearPlan {
  return { on: settingOn(env.PRO_YEAR), halalas: readPrice(env.PRO_YEAR_PRICE) ?? Math.round(OFFER.year.price * 100), days: OFFER.year.days };
}

/** PRO_YEAR_PRICE is set but cannot be read as a price from SAR 1 to SAR 100. */
export function yearPriceInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.PRO_YEAR_PRICE ?? '').trim() && readPrice(env.PRO_YEAR_PRICE) === null;
}

/**
 * A year can be bought by someone who holds Pro for up to this long: a month
 * (30 days) bought in the last week of another (7). The year then starts when
 * that Pro ends, so no day is lost. Longer than this is a year already held:
 * come back near its end, as with a month.
 */
export const YEAR_WITHIN_DAYS = CYCLE_DAYS + 7;

/** What an order buys: 30 days of Pro, the match pass, or the year. All three are the same Pro. */
export type Product = 'monthly' | 'match' | 'year';
export const PRODUCTS: Product[] = ['monthly', 'match', 'year'];
/** A product name as stored or sent, as a Product: anything unknown is the month. */
export const asProduct = (v: unknown): Product => (v === 'match' || v === 'year' ? v : 'monthly');

/** /pro is the three-plan page, and the sheets name every plan on sale. */
export const threePlansOn = (env: NodeJS.ProcessEnv = process.env): boolean => settingOn(env.PRO_THREE_PLANS);

/** The 7-day gift starts by itself for every account that qualifies (pro.ts). */
export const autoGiftOn = (env: NodeJS.ProcessEnv = process.env): boolean => settingOn(env.PRO_AUTO_GIFT);
/** The gift's emails are sent. Only with the automatic gift: the old Accept gift never had emails. */
export const giftMailsOn = (env: NodeJS.ProcessEnv = process.env): boolean => settingOn(env.PRO_GIFT_MAILS) && autoGiftOn(env);
/** Pro's versions and the account offer show on the Post it sheet and the share dialog. */
export const postOffersOn = (env: NodeJS.ProcessEnv = process.env): boolean => settingOn(env.PRO_POST_OFFERS);

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
