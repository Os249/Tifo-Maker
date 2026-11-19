/**
 * Pro's launch (19 Nov 2026): the launch price, the founders list, the one
 * founders email, and the founders bonus. docs/pro-launch.md has the whole of
 * it in plain words, with the legal reading behind the price display.
 *
 * NOTHING here does anything until Pro is on sale for real, which the code
 * calls paymentsPublic (payments.ts): PRO_PAYMENTS=on, a LIVE Moyasar key and
 * PRO_MODE=on. On a test key, in preview, in development and in the tests no
 * launch is recorded, nobody becomes a founder and no email is sent.
 *
 * ---------------------------------------------------------------------------
 * The price
 *
 *   Regular price   SAR 19.99 for 30 days (proPlan.ts OFFER.monthly.price).
 *   Launch price    SAR 13.99 (OFFER.monthly.launchPrice), charged for orders
 *                   made BEFORE the day in PRO_LAUNCH_PRICE_UNTIL.
 *
 *   PRO_LAUNCH_PRICE_UNTIL   the first day at the regular price, as a Riyadh
 *                            date: 2027-01-15 means 13.99 until 14 Jan 23:59
 *                            Riyadh time and 19.99 from 15 Jan 00:00. Unset
 *                            (or not a date): there is no launch price, and
 *                            Pro costs 19.99. So the launch price ends by
 *                            itself, and nobody touches the code.
 *
 *   PRO_PRICE_DISPLAY=strike  shows the regular price crossed out beside the
 *   PRO_DISCOUNT_LICENCE      launch price. ONLY with a discount licence
 *                            number in PRO_DISCOUNT_LICENCE, which the page
 *                            then prints. Anything else (the default) is the
 *                            plain wording: "Launch price SAR 13.99. From
 *                            <date> the price will be SAR 19.99", with no
 *                            crossed-out price and no word "discount". Pro
 *                            has never been sold at 19.99, so a crossed-out
 *                            19.99 is a "was" price that never was.
 *
 * An order's price is fixed when the order is made (pro_orders.amount): what
 * the fan was shown is what Moyasar charges, even if the launch price ends
 * between pressing "Get Pro" and paying. Auto-renew always renews at the
 * regular price, and says so before paying.
 *
 * ---------------------------------------------------------------------------
 * The founders
 *
 * A founder is a signed-in account with a verified email that pressed "Tell
 * me when Pro opens" or answered "what would you pay for Pro?" (which puts it
 * on the same list). Both places said they would hear first when Pro opens.
 *
 * The first time the server finds Pro on sale for real it records the launch
 * moment (pro_launch, one row, in the database) and, in the same transaction,
 * copies the founders into pro_founders. That copy is the list: answering the
 * question after the launch makes nobody a founder.
 *
 * Each founder gets ONE email (proLaunchMail.ts). At most once, never twice:
 * a row is claimed (mail_claimed_at) by a single UPDATE before the send and is
 * only given back when the mail service refused the message. A server that
 * stops between the claim and the send leaves that founder unsent and shown
 * as "not known" on /admin, rather than risk a second copy. Sends are paced
 * (a gap between messages, a batch per run, and a day's ceiling on the
 * existing SendBudget) so the launch does not spend the day's allowance that
 * verification and receipt emails need.
 *
 * The bonus. A founder's first purchase gets FOUNDER_BONUS_DAYS extra days on
 * the pass it buys (60 days for the price of 30), under this rule, decided by
 * the server's clock when the payment is confirmed:
 *
 *   - the payment is confirmed no later than the deadline, launch + 72 hours;
 *     OR the order was made by the deadline and is confirmed within
 *     FOUNDER_GRACE_HOURS after it (a fan who paid at 71:59, whose bank or
 *     whose webhook took its time, still gets it);
 *   - the order was made after the launch, with real money (never test mode),
 *     and is a purchase, not a renewal;
 *   - the account has not had the bonus before: once per account, ever. The
 *     store decides that in the same step that marks the order paid
 *     (payRepo.markPaid), so two confirmations at once give one bonus.
 *
 * The bonus is part of the order's one pass, so a refund ends it with the
 * pass, and it is never given for a gift or a month given by hand (neither is
 * an order). A refunded founder does not get it again on a later purchase.
 */
import type { PaymentRepository, ProOrder } from './payRepo';
import type { FounderMail, FounderSource, LaunchRepository } from './launchRepo';
import { OFFER } from './proPlan';

const RIYADH_MS = 3 * 3600_000;
const HOUR_MS = 3600_000;

// ---------------------------------------------------------------- price ---

/** The regular price of a month of Pro, in halalas. */
export const regularHalalas = (): number => Math.round(OFFER.monthly.price * 100);
/** The launch price, in halalas. */
export const launchHalalas = (): number => Math.round(OFFER.monthly.launchPrice * 100);

/**
 * When the launch price ends (PRO_LAUNCH_PRICE_UNTIL), or null when there is
 * none. A plain date is a Riyadh day: the instant that day begins there.
 */
export function launchPriceUntil(env: NodeJS.ProcessEnv = process.env): Date | null {
  const v = (env.PRO_LAUNCH_PRICE_UNTIL ?? '').trim();
  if (!v) return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const t = new Date(Date.UTC(y, m - 1, day));
    // 2027-02-31 is not a day: it is refused, not rolled over into March.
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== day) return null;
    return new Date(t.getTime() - RIYADH_MS);
  }
  if (/^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

/** PRO_LAUNCH_PRICE_UNTIL is set but is not a date the server can read. */
export function launchPriceUntilInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.PRO_LAUNCH_PRICE_UNTIL ?? '').trim() && launchPriceUntil(env) === null;
}

/** A discount licence number as the Ministry prints it: letters, digits and a few separators. */
const LICENCE = /^[A-Za-z0-9][A-Za-z0-9 /._-]{2,39}$/;

/**
 * How the launch price is shown. 'strike' (the regular price crossed out) only
 * when PRO_PRICE_DISPLAY=strike AND a licence number is given; otherwise
 * 'plain', which shows no crossed-out price at all.
 */
export function priceDisplay(env: NodeJS.ProcessEnv = process.env): { mode: 'plain' | 'strike'; licence: string | null } {
  const licence = (env.PRO_DISCOUNT_LICENCE ?? '').trim();
  const ok = LICENCE.test(licence);
  const strike = (env.PRO_PRICE_DISPLAY ?? '').trim().toLowerCase() === 'strike' && ok;
  return { mode: strike ? 'strike' : 'plain', licence: strike ? licence : null };
}

export interface PriceNow {
  /** What a month bought now costs, in halalas. */
  halalas: number;
  /** The regular price, in halalas: what auto-renew charges, and what the launch price gives way to. */
  regular: number;
  /** The launch price is what is charged now. */
  launch: boolean;
  /** When the launch price ends (only while it runs). */
  until: string | null;
  display: 'plain' | 'strike';
  licence: string | null;
}

/** The price of a month of Pro for an order made at `now`. */
export function priceAt(now: Date, env: NodeJS.ProcessEnv = process.env): PriceNow {
  const until = launchPriceUntil(env);
  const launch = until !== null && now.getTime() < until.getTime() && launchHalalas() < regularHalalas();
  const shown = priceDisplay(env);
  return {
    halalas: launch ? launchHalalas() : regularHalalas(),
    regular: regularHalalas(),
    launch,
    until: launch ? until.toISOString() : null,
    display: launch ? shown.mode : 'plain',
    licence: launch ? shown.licence : null,
  };
}

/** What /admin and the start-up log say about the price settings. Never anything secret: there is none here. */
export function priceStatus(now: Date, env: NodeJS.ProcessEnv = process.env) {
  const p = priceAt(now, env);
  const until = launchPriceUntil(env);
  return {
    now: p.halalas / 100,
    regular: p.regular / 100,
    launchPrice: launchHalalas() / 100,
    launch: p.launch,
    until: until ? until.toISOString() : null,
    /** The date was set but could not be read: Pro sells at the regular price. */
    untilInvalid: launchPriceUntilInvalid(env),
    /** The launch price's day has passed: the setting can be removed. */
    untilPassed: until !== null && !p.launch,
    display: priceDisplay(env).mode,
    /** PRO_PRICE_DISPLAY=strike was asked for without a licence number: the plain wording is shown. */
    strikeRefused: (env.PRO_PRICE_DISPLAY ?? '').trim().toLowerCase() === 'strike' && priceDisplay(env).mode !== 'strike',
    licence: priceDisplay(env).licence,
  };
}

// -------------------------------------------------------------- founders ---

/** The founders offer runs this long from the recorded launch moment. */
export const FOUNDER_WINDOW_HOURS = 72;
/** Extra days on a founder's first purchase. */
export const FOUNDER_BONUS_DAYS = 30;
/** An order made by the deadline still earns the bonus when its payment is confirmed up to this long after it. */
export const FOUNDER_GRACE_HOURS = 6;

/** The day's ceiling for founder emails on the shared send budget (Resend's free plan is 100 a day for everything). */
export const FOUNDER_MAILS_PER_DAY = 60;
/** Founder emails sent per run of the job. */
const MAIL_BATCH = 10;
/** A send the mail service refused is tried again this many times in all. */
export const MAIL_TRIES = 4;
/** Between two founder emails (Resend takes 2 requests a second). */
const MAIL_GAP_MS = 700;

export const founderDeadline = (launchedAt: Date): Date => new Date(launchedAt.getTime() + FOUNDER_WINDOW_HOURS * HOUR_MS);

/**
 * The founders offer starts by itself with the launch: the moment Pro is on
 * sale to everyone, the founders have 72 hours (Osamh's decision, 20 Nov
 * 2026). There is nothing to switch on.
 *
 * PRO_FOUNDERS_BONUS=off is the way out, should the Ministry of Commerce say
 * a time-limited "extra month free" needs its approval as a promotional offer
 * (docs/pro-launch.md, "Legal reading"). Off, the founders still get their
 * one email saying Pro is open, with no offer in it, and nobody gets extra
 * days. A bonus already given stays given whatever this says later.
 */
export const founderBonusOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.PRO_FOUNDERS_BONUS ?? '').trim().toLowerCase() !== 'off';

/** With no offer and so no deadline, the "Pro is open" email is still not sent later than this after the launch. */
const NEWS_MAIL_DAYS = 14;

/**
 * Whether a payment confirmed at `now` is in time for the founders bonus (the
 * rule in this file's note). Says nothing about whose order it is: the store
 * decides once-per-account when the order is marked paid.
 */
export function bonusInTime(order: Pick<ProOrder, 'createdAt' | 'kind' | 'testMode'>, launchedAt: Date, now: Date): boolean {
  if (order.testMode || order.kind === 'renewal') return false;
  const made = Date.parse(order.createdAt);
  const deadline = founderDeadline(launchedAt).getTime();
  if (made < launchedAt.getTime()) return false;
  if (now.getTime() <= deadline) return true;
  return made <= deadline && now.getTime() <= deadline + FOUNDER_GRACE_HOURS * HOUR_MS;
}

/** The founders offer as an account sees it. */
export type FounderView =
  /** Open: buy by `until` and the first month is `total` days. */
  | { state: 'open'; until: string; bonusDays: number; total: number }
  /** Taken: this account's first purchase got the extra days. */
  | { state: 'used'; until: string; bonusDays: number; total: number; order: string };

export interface LaunchRun {
  /** The launch was recorded by this run. */
  launched: boolean;
  sent: number;
  failed: number;
  skipped: number;
  /** Why nothing was sent, when nothing could be: 'off', 'mail', 'ended', 'budget'. */
  held: 'off' | 'mail' | 'ended' | 'budget' | null;
}

export interface LaunchServiceOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Pro is on sale to everyone for real (payments on, a live key, PRO_MODE=on). The only thing that starts a launch. */
  isPublic: () => boolean;
  /** Send one founder their email. Throws when the mail service refused it. Absent: nothing is ever sent. */
  send?: (to: FounderMail, launch: { launchedAt: string; deadline: string | null }) => Promise<void>;
  /** Whether email is really being delivered (a console sender delivers to nobody). */
  canSend?: () => boolean;
  /** Take one send from the day's budget; false: wait. And give it back when the send did not happen. */
  takeBudget?: () => boolean;
  giveBudget?: () => void;
  /** The pause between two sends (the tests pass 0). */
  gapMs?: number;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LaunchService {
  private readonly env: NodeJS.ProcessEnv;
  /** The launch moment never changes once recorded: remembered for good. "Not yet" is asked again after a moment. */
  private at: Date | null = null;
  private askedAt = -Infinity;
  private busy = false;

  constructor(
    readonly repo: LaunchRepository,
    /** Where the orders are, to see what became of the order a bonus went to. */
    private readonly orders: Pick<PaymentRepository, 'get'>,
    private readonly opts: LaunchServiceOptions,
  ) {
    this.env = opts.env ?? process.env;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** When Pro went on sale, or null while it has not. */
  async launchedAt(): Promise<Date | null> {
    if (this.at) return this.at;
    const t = Date.now();
    if (t - this.askedAt < 20_000) return null;
    this.askedAt = t;
    const l = await this.repo.launch();
    if (l) this.at = new Date(l.launchedAt);
    return this.at;
  }

  /**
   * Record the launch if Pro is on sale for real and it has not been
   * recorded: the moment, and the founders as they stand at it, in one step.
   * Safe from any number of servers at once: one of them records it.
   */
  async ensure(): Promise<{ at: Date; first: boolean } | null> {
    if (!this.opts.isPublic()) return null;
    if (this.at) return { at: this.at, first: false };
    const r = await this.repo.begin(this.now());
    this.at = new Date(r.launchedAt);
    if (r.first) console.log(`[tifo] launch: Pro is on sale. Recorded ${r.launchedAt} with ${r.founders} founder(s); their offer ends ${founderDeadline(this.at).toISOString()}`);
    return { at: this.at, first: r.first };
  }

  /** The founders offer for this account now, when it is still open to it. */
  async offerFor(userId: string, now: Date = this.now()): Promise<{ until: string; bonusDays: number } | null> {
    if (!founderBonusOn(this.env)) return null;
    const at = await this.launchedAt();
    if (!at) return null;
    const deadline = founderDeadline(at);
    if (now.getTime() > deadline.getTime()) return null;
    const f = await this.repo.founder(userId);
    if (!f || f.bonusOrderId) return null;
    return { until: deadline.toISOString(), bonusDays: FOUNDER_BONUS_DAYS };
  }

  /** The extra days a payment confirmed now may carry (0: none). payRepo.markPaid still decides once-per-account. */
  async bonusDays(order: ProOrder, now: Date): Promise<number> {
    if (!founderBonusOn(this.env) || !order.userId || order.testMode || order.kind === 'renewal') return 0;
    const at = await this.launchedAt();
    return at && bonusInTime(order, at, now) ? FOUNDER_BONUS_DAYS : 0;
  }

  /** The offer as the account's own pages show it: open, taken, or nothing to say. */
  async viewFor(userId: string, canBuy: boolean): Promise<FounderView | null> {
    const at = await this.launchedAt();
    if (!at) return null;
    const f = await this.repo.founder(userId);
    if (!f) return null;
    const until = founderDeadline(at).toISOString();
    if (f.bonusOrderId) {
      const o = await this.orders.get(f.bonusOrderId);
      // Refunded: the extra days went with the order, and there is nothing to show.
      if (!o || o.status !== 'paid' || o.bonusDays <= 0) return null;
      return { state: 'used', until, bonusDays: o.bonusDays, total: o.days + o.bonusDays, order: o.id };
    }
    if (!founderBonusOn(this.env) || !canBuy || this.now().getTime() > Date.parse(until)) return null;
    return { state: 'open', until, bonusDays: FOUNDER_BONUS_DAYS, total: OFFER.monthly.days + FOUNDER_BONUS_DAYS };
  }

  /**
   * The job: record the launch if it is time, then send the founders their
   * email, a batch at a run. Does nothing at all unless Pro is on sale for
   * real. `again` (the admin's "Send now") also gives the sends the mail
   * service refused another set of tries; it never touches one that was sent.
   */
  async tick(again = false): Promise<LaunchRun> {
    const out: LaunchRun = { launched: false, sent: 0, failed: 0, skipped: 0, held: null };
    if (this.busy) return out;
    this.busy = true;
    try {
      const l = await this.ensure();
      if (!l) {
        out.held = 'off';
        return out;
      }
      out.launched = l.first;
      const send = this.opts.send;
      if (!send || !(this.opts.canSend?.() ?? true)) {
        out.held = 'mail';
        return out;
      }
      const offer = founderBonusOn(this.env);
      // With the offer, the email is about a deadline: once that has passed it is not sent. Without it, it is
      // the news that Pro opened, which is not news for ever.
      const deadline = offer ? founderDeadline(l.at) : new Date(l.at.getTime() + NEWS_MAIL_DAYS * 24 * HOUR_MS);
      if (this.now().getTime() >= deadline.getTime()) {
        out.held = 'ended';
        return out;
      }
      if (again) await this.repo.retryFailed();
      const batch = await this.repo.unsent(MAIL_BATCH, MAIL_TRIES);
      const ctx = { launchedAt: l.at.toISOString(), deadline: offer ? deadline.toISOString() : null };
      for (const f of batch) {
        const now = this.now();
        if (now.getTime() >= deadline.getTime()) break;
        // The address went, or stopped being verified, or the fan asked for no such emails, since the list was made.
        if (!f.email || !f.verified) {
          if (await this.repo.mailSkipped(f.userId, 'no_email', now)) out.skipped++;
          continue;
        }
        if (await this.repo.mailStopped(f.userId)) {
          if (await this.repo.mailSkipped(f.userId, 'stopped', now)) out.skipped++;
          continue;
        }
        if (this.opts.takeBudget && !this.opts.takeBudget()) {
          out.held = 'budget';
          break;
        }
        // One caller gets the row; whoever does not, did not send.
        if (!(await this.repo.claimMail(f.userId, now))) {
          this.opts.giveBudget?.();
          continue;
        }
        try {
          await send(f, ctx);
          await this.repo.mailSent(f.userId, this.now());
          out.sent++;
        } catch (e) {
          // The mail service said no: nothing went out, so the row is owed again.
          this.opts.giveBudget?.();
          await this.repo.mailFailed(f.userId, String((e as Error)?.message ?? e).slice(0, 200));
          out.failed++;
        }
        const gap = this.opts.gapMs ?? MAIL_GAP_MS;
        if (gap > 0) await pause(gap);
      }
      if (out.sent || out.failed || out.skipped) console.log(`[tifo] launch: founder emails: ${out.sent} sent, ${out.failed} failed, ${out.skipped} skipped`);
      return out;
    } finally {
      this.busy = false;
    }
  }

  /** "Stop these emails", from the link in the founders email. True when the link is one of ours. */
  async stopMail(token: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return false;
    const f = await this.repo.founderByStopToken(token);
    if (!f) return false;
    await this.repo.stopMail(f.userId, this.now(), 'email link');
    return true;
  }

  /** Everything /admin shows: before the launch who would be a founder, after it how the emails and the offer went. */
  async admin(): Promise<{
    public: boolean;
    launchedAt: string | null;
    deadline: string | null;
    ended: boolean;
    price: ReturnType<typeof priceStatus>;
    window: { hours: number; bonusDays: number; graceHours: number; bonusOn: boolean };
    founders: { total: number; notify: number; price: number; both: number; rows: { username: string | null; source: FounderSource; mail: string; bought: boolean }[] };
    mail: { sent: number; waiting: number; failed: number; unknown: number; skipped: number } | null;
    bought: { inTime: number; refunded: number } | null;
  }> {
    const now = this.now();
    const at = await this.launchedAt();
    const base = {
      public: this.opts.isPublic(),
      price: priceStatus(now, this.env),
      window: { hours: FOUNDER_WINDOW_HOURS, bonusDays: FOUNDER_BONUS_DAYS, graceHours: FOUNDER_GRACE_HOURS, bonusOn: founderBonusOn(this.env) },
    };
    if (!at) {
      // Not launched: the list as it would be taken this minute.
      const c = await this.repo.candidates(300);
      return {
        ...base, launchedAt: null, deadline: null, ended: false,
        founders: { total: c.total, notify: c.notify, price: c.price, both: c.both, rows: c.rows.map((r) => ({ username: r.username, source: r.source, mail: 'not sent', bought: false })) },
        mail: null, bought: null,
      };
    }
    const deadline = founderDeadline(at);
    const rows = await this.repo.list(500);
    let inTime = 0;
    let refunded = 0;
    const view = await Promise.all(rows.map(async (f) => {
      const o = f.bonusOrderId ? await this.orders.get(f.bonusOrderId).catch(() => null) : null;
      const bought = !!o && o.status === 'paid' && o.bonusDays > 0;
      if (bought) inTime++;
      else if (f.bonusOrderId) refunded++;
      const mail = f.mailSentAt ? 'sent' : f.mailSkip ? (f.mailSkip === 'stopped' ? 'skipped: asked for no emails' : 'skipped: no verified email now')
        : f.mailClaimedAt ? 'not known' : f.mailTries > 0 ? `failed ${f.mailTries}x` : 'waiting';
      return { username: f.username, source: f.source, mail, bought };
    }));
    const count = (k: (m: string) => boolean): number => view.filter((v) => k(v.mail)).length;
    return {
      ...base, launchedAt: at.toISOString(), deadline: deadline.toISOString(), ended: now.getTime() >= deadline.getTime(),
      founders: {
        total: rows.length,
        notify: rows.filter((r) => r.source === 'notify').length,
        price: rows.filter((r) => r.source === 'price').length,
        both: rows.filter((r) => r.source === 'both').length,
        rows: view,
      },
      mail: {
        sent: count((m) => m === 'sent'), waiting: count((m) => m === 'waiting'), failed: count((m) => m.startsWith('failed')),
        unknown: count((m) => m === 'not known'), skipped: count((m) => m.startsWith('skipped')),
      },
      bought: { inTime, refunded },
    };
  }
}
