/**
 * Buying Pro (payments v1, 12 Nov 2026): a month of Pro for one payment on
 * Moyasar's hosted page, no renewal, refunds by hand within 7 days.
 *
 * OFF until Osamh turns it on. Three switches, all on the server:
 *
 *   PRO_PAYMENTS=on          the switch. Anything else (unset) is off: no
 *                            price, no buy button, /pro stays the coming-soon
 *                            page, and none of these routes do anything.
 *   MOYASAR_SECRET_KEY       sk_test_... or sk_live_... from Moyasar's
 *                            dashboard. Without one, payments stay off.
 *   MOYASAR_WEBHOOK_SECRET   the secret typed into Moyasar's webhook settings
 *                            (Settings -> Webhooks), so a webhook can be told
 *                            from a stranger's POST. Optional: without it the
 *                            webhook route is closed and a payment is still
 *                            seen through the invoice's own callback and the
 *                            fan's return.
 *
 * Who may buy also follows PRO_MODE: only an account Pro is on for. And a
 * TEST key only ever sells to the accounts in PRO_PREVIEW_USERS, whatever
 * PRO_MODE says, because Moyasar's test cards are public: on the live site
 * with a test key, anyone else could get Pro with a test card number. So the
 * order of switching on is:
 *
 *   1. PRO_MODE=preview, PRO_PREVIEW_USERS=<you>, PRO_PAYMENTS=on and the test
 *      keys: you buy Pro on tifomaker.org with a test card; nobody else sees
 *      anything.
 *   2. The live keys once Moyasar approves the account: you buy it for real
 *      once and refund yourself from /admin.
 *   3. PRO_MODE=on: everyone.
 *
 * How a payment becomes Pro: "Get Pro" makes an order and a Moyasar invoice
 * (POST /api/pro/pay/checkout) and the page goes to the invoice's URL. When
 * the fan has paid, three things can tell the server, in any order and any
 * number of times: the fan coming back to /pro?order=..., Moyasar's POST to
 * the invoice's callback_url, and Moyasar's webhook. Each one only says "look
 * at this order": reconcile() reads the invoice from Moyasar's API with the
 * secret key and gives the pass if, and only if, Moyasar says it is paid in
 * full, in riyals, for this order's amount. payRepo.markPaid() gives one pass
 * per order however many times that happens.
 *
 * ---------------------------------------------------------------------------
 * Payments v2 (16 Nov 2026). Everything below is OFF until its own variable is
 * set; with none of them set, the code above is all that runs, exactly as v1.
 *
 *   MOYASAR_PROXY_URL        (1a) the server's calls to Moyasar, and only
 *                            those, go through this fixed-IP proxy
 *                            (moyasarProxy.ts), for a live secret key locked
 *                            to "Allowed IPs". Wired in routes.ts.
 *
 *   PRO_CHECKOUT=form        (2) "Get Pro" opens Moyasar's payment form on
 *   MOYASAR_PUBLISHABLE_KEY  /pro instead of going to the hosted page. The
 *                            form is Moyasar's own script; the card goes from
 *                            the browser straight to Moyasar. The server
 *                            chooses the payment's id beforehand (given_id),
 *                            and gives Pro only after reading that payment
 *                            back with the secret key: paid, in riyals, for
 *                            the order's amount, naming the order. The
 *                            publishable key must be the same kind (test or
 *                            live) as the secret key, or the form is not used.
 *   MOYASAR_METHODS          what the form offers: creditcard (default),
 *                            applepay, stcpay, samsungpay.
 *
 *   MOYASAR_VERIFY=webhook   (1b) no secret key on the server at all. The
 *                            form is the checkout (the publishable key is all
 *                            it needs), and Pro is given from Moyasar's
 *                            webhook alone: its secret must match, it must be
 *                            for the payment id this server chose for the
 *                            order, paid, in riyals, for the order's amount,
 *                            naming the order, in the right mode (test/live).
 *                            Refunds are made in Moyasar's dashboard and seen
 *                            through the webhook. What this trusts that the
 *                            other modes do not: the webhook's body. Whoever
 *                            holds MOYASAR_WEBHOOK_SECRET can forge a "paid"
 *                            event; nothing is read back from Moyasar.
 *
 *   PRO_AUTORENEW=on         (3) "Keep Pro on": an unticked choice at the
 *                            form to renew every 30 days. Needs the form and
 *                            the secret key (not the webhook-only mode). See
 *                            "auto-renew" below.
 *   PRO_AUTORENEW_MADA=off   mada cards renew like any other card (Osamh's
 *                            choice, 17 Nov 2026) unless this is set to off.
 *                            Moyasar's docs do not say whether a mada token can
 *                            be charged with no fan present. If it cannot, a
 *                            mada renewal simply fails: nothing is charged, the
 *                            fan is emailed, and after the retries auto-renew
 *                            ends. Set to off, a mada payment stays a one-time
 *                            pass, its token is deleted at once, and the form
 *                            says so before paying.
 *
 * ---------------------------------------------------------------------------
 * Refunds, told and asked for (19 Nov 2026). See the section of that name in
 * the class below. A refund, wherever it is made, emails the fan once and
 * shows on the site once; a fan can ask for the refund the terms promise from
 * the account page, and the request waits for the owner in /admin.
 *
 * ---------------------------------------------------------------------------
 * The match pass (22 Nov 2026). A second thing to buy: a few days of the same
 * Pro (PRO_MATCH_DAYS, 3 by default) for one small payment (PRO_MATCH_PRICE).
 * Off until PRO_MATCH_PASS=on. It is an order like any other, so every
 * guarantee above holds for it unchanged: one pass per paid order, the amount
 * and the currency checked against Moyasar's own answer, a refund ends the
 * pass, nothing believed from the browser (the browser names the product;
 * the server sets its price and its length). What is different:
 *   - it never renews: "Keep Pro on" is not offered with it, a tick for it is
 *     refused, and a card saved with it is deleted at once;
 *   - it never carries the founders bonus;
 *   - its pass starts when the Pro the account holds ends, like a month bought
 *     early, so nothing paid for overlaps.
 *
 * The year (22 Nov 2026). A third thing to buy: 365 days of the same Pro for
 * one payment (PRO_YEAR_PRICE, SAR 89.99 by default). Off until PRO_YEAR=on.
 * An order like any other, with the match pass's three differences (never
 * renews, no founders bonus, starts when the Pro held ends) and one of its
 * own: it can be bought over a month still running (YEAR_WITHIN_DAYS), where
 * a month or a match pass waits for the last week.
 *
 *   PRO_AUTO_REFUND=on       refund such a request at once, with no person
 *                            looking, when the order was paid within
 *                            REFUND_DAYS, its pass shows no use, and the
 *                            account has never been refunded before. Anything
 *                            else still waits for the owner. Needs the secret
 *                            key (not the webhook-only mode). Off by default:
 *                            it moves money by itself.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { MoyasarError, failReason, isMoyasarId, readPayment, type MoyasarApi, type MoyasarInvoice, type MoyasarPayment } from './moyasar';
import type { PaymentRepository, ProOrder, ProSubscription, ProSubscriptionRow, RefundRequest, RefundRequestRow } from './payRepo';
import { OFFER, YEAR_WITHIN_DAYS, asProduct, liveFor, matchPass, previewUsers, proMode, yearPlan, type MatchPass, type Product, type YearPlan } from './proPlan';
import { priceAt, regularHalalas } from './proLaunch';
import type { ProService } from './pro';
import type { ProPass } from './proRepo';

// ------------------------------------------------------------- switches ---

export type KeyKind = 'live' | 'test';

/** The key's kind from its prefix, or null when there is none (or it is not a secret key). */
export function moyasarKeyKind(env: NodeJS.ProcessEnv = process.env): KeyKind | null {
  const k = (env.MOYASAR_SECRET_KEY ?? '').trim();
  if (/^sk_live_[A-Za-z0-9]{8,}$/.test(k)) return 'live';
  if (/^sk_test_[A-Za-z0-9]{8,}$/.test(k)) return 'test';
  return null;
}

/** The publishable key's kind (the one the payment form uses in the browser), or null. */
export function publishableKeyKind(env: NodeJS.ProcessEnv = process.env): KeyKind | null {
  const k = (env.MOYASAR_PUBLISHABLE_KEY ?? '').trim();
  if (/^pk_live_[A-Za-z0-9]{8,}$/.test(k)) return 'live';
  if (/^pk_test_[A-Za-z0-9]{8,}$/.test(k)) return 'test';
  return null;
}

/** 'api': the server reads every payment back with the secret key (the default). 'webhook': no secret key, Moyasar's webhook is believed. */
export type VerifyMode = 'api' | 'webhook';
export function verifyMode(env: NodeJS.ProcessEnv = process.env): VerifyMode {
  return (env.MOYASAR_VERIFY ?? '').trim().toLowerCase() === 'webhook' ? 'webhook' : 'api';
}

/** Test or live money: the secret key's kind, or in the webhook-only mode the publishable key's. */
export function payKeyKind(env: NodeJS.ProcessEnv = process.env): KeyKind | null {
  return verifyMode(env) === 'webhook' ? publishableKeyKind(env) : moyasarKeyKind(env);
}

/** The webhook's shared secret, when one is set (at least 16 characters, or it is not used). */
function webhookSecret(env: NodeJS.ProcessEnv): string | null {
  const s = (env.MOYASAR_WEBHOOK_SECRET ?? '').trim();
  return s.length >= 16 ? s : null;
}

const isOn = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'on';

/**
 * PRO_PAYMENTS=on and the keys its mode needs: a secret key, or in the
 * webhook-only mode a publishable key and the webhook's secret (without the
 * secret nothing could ever be paid).
 */
export function paymentsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isOn(env.PRO_PAYMENTS)) return false;
  if (verifyMode(env) === 'webhook') return publishableKeyKind(env) !== null && webhookSecret(env) !== null;
  return moyasarKeyKind(env) !== null;
}

/**
 * Where "Get Pro" pays: Moyasar's hosted invoice page (v1, the default), or
 * its payment form on /pro. The form needs a publishable key of the same kind
 * as the secret key; anything short of that falls back to the invoice.
 */
export type CheckoutKind = 'invoice' | 'form';
export function checkoutKind(env: NodeJS.ProcessEnv = process.env): CheckoutKind {
  if (verifyMode(env) === 'webhook') return 'form';
  const pk = publishableKeyKind(env);
  return (env.PRO_CHECKOUT ?? '').trim().toLowerCase() === 'form' && pk !== null && pk === moyasarKeyKind(env) ? 'form' : 'invoice';
}

/** "Keep Pro on" is offered and renewals are charged: its switch, the form, and a secret key to charge with. */
export function autoRenewOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.PRO_AUTORENEW) && paymentsOn(env) && verifyMode(env) === 'api' && checkoutKind(env) === 'form';
}

/**
 * PRO_AUTO_REFUND=on: a refund request that plainly meets the promise is
 * refunded without waiting for the owner (see the file's note). Only with a
 * secret key: the webhook-only mode cannot refund from here at all.
 */
export function autoRefundOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.PRO_AUTO_REFUND) && paymentsOn(env) && verifyMode(env) === 'api';
}

/** mada cards renew like any other, unless PRO_AUTORENEW_MADA=off (see the file's note). */
export const renewMada = (env: NodeJS.ProcessEnv = process.env): boolean => (env.PRO_AUTORENEW_MADA ?? '').trim().toLowerCase() !== 'off';

export type FormMethod = 'creditcard' | 'applepay' | 'stcpay' | 'samsungpay';
const FORM_METHODS: readonly FormMethod[] = ['creditcard', 'applepay', 'stcpay', 'samsungpay'];
/** The methods a saved card can come from. STC Pay has no card to save. */
const RENEWABLE: readonly string[] = ['creditcard', 'applepay', 'samsungpay'];

/**
 * What the form offers (MOYASAR_METHODS, comma-separated; cards alone by
 * default). Apple Pay only once its domain file is being served, Samsung Pay
 * only with its service id: a button that cannot work is not shown.
 */
export function formMethods(env: NodeJS.ProcessEnv = process.env, applePayReady = false): FormMethod[] {
  const asked = (env.MOYASAR_METHODS ?? 'creditcard').split(',').map((x) => x.trim().toLowerCase());
  const out = FORM_METHODS.filter((m) => asked.includes(m)).filter((m) =>
    m === 'applepay' ? applePayReady : m === 'samsungpay' ? !!(env.MOYASAR_SAMSUNG_SERVICE_ID ?? '').trim() : true);
  return out.length ? out : ['creditcard'];
}

/**
 * Whether this account sees a price and a buy button: payments on, Pro on for
 * the account, and with a test key only the preview's own accounts.
 */
export function paymentsOpenFor(username: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!paymentsOn(env) || !username || !liveFor(username, env)) return false;
  if (payKeyKind(env) === 'test') return previewUsers(env).has(username.toLowerCase());
  return true;
}

/**
 * Pro is on sale to everyone, for real: live key, PRO_MODE=on. The signed-out
 * /pro shows the price, and the legal page shows the payment terms.
 */
export function paymentsPublic(env: NodeJS.ProcessEnv = process.env): boolean {
  return paymentsOn(env) && payKeyKind(env) === 'live' && proMode(env) === 'on';
}

/** Two secrets compared in constant time. */
function sameSecret(given: string, secret: string): boolean {
  const x = Buffer.from(given);
  const y = Buffer.from(secret);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What /admin shows about the switches. Never a key, and never the proxy's address. */
export function paymentsStatus(env: NodeJS.ProcessEnv = process.env, applePayReady = false) {
  return {
    switch: isOn(env.PRO_PAYMENTS),
    key: payKeyKind(env),
    keySet: !!(env.MOYASAR_SECRET_KEY ?? '').trim(),
    webhook: !!webhookSecret(env),
    on: paymentsOn(env),
    public: paymentsPublic(env),
    verify: verifyMode(env),
    checkout: checkoutKind(env),
    /** PRO_CHECKOUT=form was asked for but the publishable key is missing or of the other kind. */
    formRefused: verifyMode(env) === 'api' && (env.PRO_CHECKOUT ?? '').trim().toLowerCase() === 'form' && checkoutKind(env) !== 'form',
    methods: formMethods(env, applePayReady),
    applePayFile: applePayReady,
    proxy: !!(env.MOYASAR_PROXY_URL ?? '').trim(),
    autoRenew: autoRenewOn(env),
    autoRenewAsked: isOn(env.PRO_AUTORENEW),
    autoRenewMada: renewMada(env),
    autoRefund: autoRefundOn(env),
    autoRefundAsked: isOn(env.PRO_AUTO_REFUND),
  };
}

// ---------------------------------------------------------------- rules ---

/**
 * One month of Pro bought at `now`, in halalas: the launch price while it
 * runs, the regular price otherwise (proLaunch.ts priceAt). An order keeps
 * the price it was made at.
 */
export const priceHalalas = (now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): number => priceAt(now, env).halalas;

/** Within this long of a pass's end, another month can be bought (it starts when the first ends). */
export const RENEW_WITHIN_DAYS = 7;
/** A refund is given within this long of paying (the terms say so). */
export const REFUND_DAYS = 7;
/** How long Moyasar's page takes payment. */
const INVOICE_MINUTES = 60;
/** An open order is sent back to its own page for this long, rather than making another invoice. */
const REUSE_MINUTES = 45;
/** "Get Pro" presses one account may make in a day. */
const ORDERS_PER_DAY = 10;

/** A renewal is announced by email this long before it is charged. The terms promise it. */
export const REMIND_DAYS = 3;
/**
 * The reminder goes out up to this much earlier than that, so that a job that
 * runs hourly sends it a little over three days ahead rather than a little
 * under, and the renewal date does not have to move.
 */
const REMIND_EARLY_MS = 6 * 3600_000;
/** A renewal charged within this long of its month ending starts the new month where the old one ended. */
const RENEWAL_GRACE_MS = 2 * 3600_000;
/** After a renewal fails: try again after 1 day, then 2 more, then 3 more; after that, auto-renew ends. */
export const RETRY_DAYS: readonly number[] = [1, 2, 3];
/** A reminder that cannot be sent for this long past the renewal date ends auto-renew: nobody is charged unannounced. */
const UNREACHABLE_DAYS = 7;

const DAY_MS = 24 * 3600_000;

/** The site's one-time "your Pro was refunded" notice is for refunds no older than this. */
const NOTICE_DAYS = 30;
/** A refund email that could not be sent is tried again by the job for this long. */
const REFUND_MAIL_RETRY_DAYS = 3;
/** An order that did not go through stays in the account's purchase list for this long. */
const FAILED_SHOWN_DAYS = 30;
/** A receipt can be sent again once in this long, per order. */
const RECEIPT_AGAIN_MS = 5 * 60_000;

export interface Buyer {
  id: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
}

/** What the page needs to open Moyasar's form for an order. The publishable key is public by design. */
export interface FormConfig {
  publishableKey: string;
  /** Halalas. */
  amount: number;
  currency: 'SAR';
  description: string;
  /** Where Moyasar sends the fan after 3-D Secure (it adds the payment's id, status and message). */
  callbackUrl: string;
  /** The id the payment is created under: the server's choice, so it knows which payment to look for. */
  givenId: string;
  methods: FormMethod[];
  networks: string[];
  applePay: { label: string; country: string } | null;
  samsungPay: { serviceId: string; orderNumber: string } | null;
  /**
   * "Keep Pro on", when it is offered: what to show before paying, and what
   * can renew. `price` is what each renewal charges (the regular price, never
   * the launch price), `days` how long each renewal is, `nextAt` the first
   * renewal's date (after the founders bonus, when there is one).
   */
  renew: { price: number; days: number; nextAt: string; methods: string[]; mada: boolean } | null;
  /** The founders offer, when this order's account can still take it: paid by `until`, the pass is `total` days. */
  founder: { until: string; bonusDays: number; total: number } | null;
  /** What this order buys, and for how many days: the page's words follow it. */
  product: Product;
  days: number;
}

/**
 * The founders offer, as the payment code needs it (proLaunch.ts LaunchService
 * is the one implementation). Absent: nobody is a founder.
 */
export interface FounderRules {
  /** The offer for this account right now, while it can still take it. */
  offerFor(userId: string, now: Date): Promise<{ until: string; bonusDays: number } | null>;
  /** The extra days a payment confirmed at `now` is in time for (0: none). The store decides once-per-account. */
  bonusDays(order: ProOrder, now: Date): Promise<number>;
}

export type CheckoutResult =
  | { ok: true; orderId: string; url: string }
  | { ok: true; orderId: string; form: FormConfig }
  | { ok: false; reason: 'off' | 'verify' | 'held' | 'busy' | 'unavailable'; endsAt?: string };

export type RefundResult =
  | { ok: true; order: ProOrder }
  | { ok: false; reason: 'none' | 'not_paid' | 'late' | 'no_payment' | 'failed' | 'off' | 'dashboard' };

/**
 * Whether an order can still be refunded on request, as its owner sees it:
 *   open       paid within REFUND_DAYS and not asked for yet
 *   late       paid longer ago than that
 *   requested  asked for, waiting for the owner
 *   declined   asked for and declined (with the reason)
 *   refunded   the money went back
 *   none       nothing to refund (it was never paid)
 */
export type RefundState = 'open' | 'late' | 'requested' | 'declined' | 'refunded' | 'none';

/** An order as the account page lists it. */
export interface Purchase {
  order: ProOrder;
  /** When the pass it paid for ends (null: none, or it was taken back). */
  endsAt: string | null;
  refund: {
    state: RefundState;
    /** Until when a refund can be asked for (paid orders). */
    until: string | null;
    /** Whether the pass shows any use: only looked up while a refund can still be asked for. */
    used: boolean | null;
    /** Why a request was declined. */
    reason: string | null;
    askedAt: string | null;
  };
}

export type RefundAskResult =
  | { ok: true; state: 'requested' | 'refunded' }
  | { ok: false; reason: 'none' | 'not_paid' | 'refunded' | 'late' | 'already' };

export type RefundDecision =
  | { ok: true; status: 'approved' | 'declined' }
  | { ok: false; reason: 'none' | 'decided' | 'reason' | Exclude<RefundResult, { ok: true }>['reason'] };

/** An email a refund request owes: to the fan and the owner when it arrives, to the fan when it is declined. */
export type RefundRequestNotice = { kind: 'received' | 'declined'; request: RefundRequest; order: ProOrder };

/** An email the renewals owe a fan. `endsAt` is when the Pro they hold ends. */
export type RenewNotice =
  /** `firstDays`: this is the first renewal after a founder's longer first month of that many days; the email says so. */
  | { kind: 'reminder'; sub: ProSubscription; chargeAt: string; firstDays?: number }
  | { kind: 'failed'; sub: ProSubscription; retryAt: string; endsAt: string | null }
  | { kind: 'ended'; sub: ProSubscription; why: 'payment_failed' | 'card_expired' | 'unreachable'; endsAt: string | null }
  | { kind: 'cancelled'; sub: ProSubscription; endsAt: string | null };

export interface PaymentServiceOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Told once, when an order is first paid (the receipt), and again when its
   * owner asks for the receipt to be sent again. `sub` is the auto-renew it
   * started or belongs to, when there is one; `nextAt` the next renewal's
   * date when it is not the day this order's pass ends (a receipt sent again
   * later). Failures are logged, never thrown.
   */
  onPaid?: (order: ProOrder, endsAt: string | null, sub: ProSubscription | null, nextAt?: string | null) => Promise<void>;
  /**
   * An order was refunded: tell its fan by email. Called once per refund
   * (payRepo.claimRefundMail), whoever noticed it. Resolves false only when
   * the email should be tried again (the mail service refused it).
   */
  onRefunded?: (order: ProOrder) => Promise<boolean>;
  /** A refund request arrived, or was declined: the emails it owes. Failures are logged, never thrown. */
  onRequest?: (n: RefundRequestNotice) => Promise<void>;
  /** Send a renewal email. Resolves true only when it was really handed to the mail service. */
  notify?: (n: RenewNotice) => Promise<boolean>;
  /** Whether Apple Pay's domain file is being served (routes.ts). */
  applePayReady?: () => boolean;
  /** The site's own origin, for the address Moyasar requires on a token charge. */
  base?: string;
  /** The founders offer (proLaunch.ts). Absent: there is none. */
  founders?: FounderRules;
}

export interface RenewRun {
  reminded: number;
  charged: number;
  failed: number;
  ended: number;
  postponed: number;
}

export class PaymentService {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly repo: PaymentRepository,
    readonly pro: ProService,
    /** Null when there is no secret key: every route then answers as if payments were off, unless the webhook-only mode is set. */
    private readonly api: MoyasarApi | null,
    private readonly opts: PaymentServiceOptions = {},
  ) {
    this.env = opts.env ?? process.env;
  }

  private get mode(): VerifyMode {
    return verifyMode(this.env);
  }

  on(): boolean {
    return paymentsOn(this.env) && (this.mode === 'webhook' || !!this.api);
  }

  openFor(username: string | null | undefined): boolean {
    return this.on() && paymentsOpenFor(username, this.env);
  }

  testMode(): boolean {
    return payKeyKind(this.env) !== 'live';
  }

  /** How "Get Pro" pays right now. */
  checkoutKind(): CheckoutKind {
    return checkoutKind(this.env);
  }

  /** The match pass as it is sold now: its price and length, and whether it is on sale at all. */
  match(): MatchPass {
    const m = matchPass(this.env);
    return { ...m, on: m.on && this.on() };
  }

  /** The year as it is sold now: its price and length, and whether it is on sale at all. */
  year(): YearPlan {
    const y = yearPlan(this.env);
    return { ...y, on: y.on && this.on() };
  }

  /** "Keep Pro on" is offered, and renewals are charged. Never while Pro itself is switched off (PRO_MODE=off). */
  renewOn(): boolean {
    return this.on() && proMode(this.env) !== 'off' && autoRenewOn(this.env) && !!this.api?.chargeToken && !!this.api.payment;
  }

  private applePayReady(): boolean {
    return this.opts.applePayReady?.() ?? false;
  }

  status() {
    return paymentsStatus(this.env, this.applePayReady());
  }

  /**
   * When a new month would start for this account, or null when it already
   * holds Pro for longer than RENEW_WITHIN_DAYS: a bought month starts when
   * the Pro it holds (paid or given by hand) ends, so nothing is lost by
   * buying early. A running gift does not push it back: the paid month starts
   * now, and the gift's days run beside it.
   */
  async startFor(userId: string, now: Date, product: Product = 'monthly'): Promise<{ start: Date } | { held: string }> {
    const end = await this.monthEnd(userId, now);
    if (end === null) return { start: now };
    // A year may be bought over a month still running (it starts when the month ends); a year over a year waits for its end.
    const within = product === 'year' ? YEAR_WITHIN_DAYS : RENEW_WITHIN_DAYS;
    if (end - now.getTime() > within * DAY_MS) return { held: new Date(end).toISOString() };
    return { start: new Date(end) };
  }

  /**
   * When the Pro this account holds runs out (ms), or null when it holds none.
   * A pass bought to follow the one running (a month added in the last week, a
   * year bought over a month) counts too, though it has not started: otherwise
   * a second purchase would start at the same moment as the first and the two
   * would overlap (22 Nov 2026; before, only a pass running now was counted).
   */
  private async monthEnd(userId: string, now: Date): Promise<number | null> {
    return this.heldUntil(userId, now);
  }

  /**
   * Until when this account has Pro by the month, counting a month that has
   * not started yet (one given by hand to follow the current one): what a
   * renewal must not charge for again. Null when it holds none.
   */
  private async heldUntil(userId: string, now: Date): Promise<number | null> {
    const ends = (await this.pro.repo.allPasses(userId))
      .filter((p) => p.plan === 'monthly' && !p.revokedAt && Date.parse(p.endsAt) > now.getTime())
      .map((p) => Date.parse(p.endsAt));
    return ends.length ? Math.max(...ends) : null;
  }

  private description(lang: 'en' | 'ar', days: number, product: Product = 'monthly'): string {
    if (product === 'match') return lang === 'ar' ? `تيفو ميكر برو، باقة المباراة: ${days * 24} ساعة` : `TifoMaker Pro match pass: ${days * 24} hours`;
    if (product === 'year') return lang === 'ar' ? `تيفو ميكر برو، سنة: ${days} يوم` : `TifoMaker Pro, a year: ${days} days`;
    return lang === 'ar' ? `تيفو ميكر برو: ${days} يوم` : `TifoMaker Pro: ${days} days`;
  }

  /** What the page needs to open the form for this order. */
  private formConfig(order: ProOrder, lang: 'en' | 'ar', base: string, start: Date, fo: { until: string; bonusDays: number } | null): FormConfig {
    const first = order.days + (fo?.bonusDays ?? 0);
    const methods = formMethods(this.env, this.applePayReady());
    const samsung = (this.env.MOYASAR_SAMSUNG_SERVICE_ID ?? '').trim();
    return {
      publishableKey: (this.env.MOYASAR_PUBLISHABLE_KEY ?? '').trim(),
      amount: order.amount,
      currency: 'SAR',
      description: this.description(lang, order.days, order.product),
      callbackUrl: `${base}${lang === 'ar' ? '/ar/pro' : '/pro'}?order=${order.id}`,
      givenId: order.paymentId ?? '',
      methods,
      networks: ['mada', 'visa', 'mastercard'],
      applePay: methods.includes('applepay') ? { label: 'TifoMaker', country: 'SA' } : null,
      samsungPay: methods.includes('samsungpay') ? { serviceId: samsung, orderNumber: order.id } : null,
      // A match pass never renews: the box is not offered with it.
      renew: this.renewOn() && order.product === 'monthly'
        ? {
          // Renewals are always at the regular price, whatever this first month cost.
          price: regularHalalas(this.env) / 100,
          days: order.days,
          nextAt: new Date(start.getTime() + first * DAY_MS).toISOString(),
          methods: methods.filter((m) => RENEWABLE.includes(m)),
          mada: renewMada(this.env),
        }
        : null,
      founder: fo ? { until: fo.until, bonusDays: fo.bonusDays, total: first } : null,
      product: order.product,
      days: order.days,
    };
  }

  /** "Get Pro": an order and a Moyasar invoice (or the form for one), or the open one this account already has. */
  async checkout(b: Buyer, lang: 'en' | 'ar', base: string, what: { product?: Product; src?: string | null } = {}): Promise<CheckoutResult> {
    if (!this.openFor(b.username)) return { ok: false, reason: 'off' };
    const product: Product = asProduct(what.product);
    const pass = this.match();
    const year = this.year();
    // The match pass and the year are each sold only while their own switch is on.
    if (product === 'match' && !pass.on) return { ok: false, reason: 'off' };
    if (product === 'year' && !year.on) return { ok: false, reason: 'off' };
    // The receipt goes to the email, and a verified one is the account's proof of being a person.
    if (!b.emailVerified || !b.email) return { ok: false, reason: 'verify' };
    const now = this.pro.now();
    const since = new Date(now.getTime() - DAY_MS);
    let recent = await this.repo.recentFor(b.id, since);
    // This account's open orders first, as Moyasar has them now: one paid without
    // its fan coming back gives its Pro here (and "held" below then says so), and
    // one Moyasar has closed (a failed card, a lapsed page) is not sent back to.
    const unsettled = recent.filter((o) => o.status === 'pending' && (o.invoiceId || (o.kind === 'form' && o.attemptedAt))).slice(0, 3);
    if (unsettled.length) {
      for (const o of unsettled) await this.reconcile(o);
      recent = await this.repo.recentFor(b.id, since);
    }
    const when = await this.startFor(b.id, now, product);
    // The founders offer, while this account can still take it (never with test money, never on a match pass).
    const fo = this.testMode() || product !== 'monthly' ? null : (await this.opts.founders?.offerFor(b.id, now).catch(() => null)) ?? null;
    // Holding Pro for longer than a week normally means "come back later". A founder's offer has a deadline,
    // so they may buy now: the month starts when the Pro they hold ends, as any month bought early does.
    if ('held' in when && !fo) return { ok: false, reason: 'held', endsAt: when.held };
    const start = 'held' in when ? new Date(when.held) : when.start;
    // The server's price and length for the product named: the browser chooses which, never how much.
    const amount = product === 'match' ? pass.halalas : product === 'year' ? year.halalas : priceHalalas(now, this.env);
    const days = product === 'match' ? pass.days : product === 'year' ? year.days : OFFER.monthly.days;
    const src = what.src ?? null;
    const kind = this.checkoutKind();
    const fresh = (o: ProOrder): boolean =>
      o.status === 'pending' && o.product === product && o.days === days && o.amount === amount && o.testMode === this.testMode() && now.getTime() - Date.parse(o.createdAt) < REUSE_MINUTES * 60_000;

    if (kind === 'form') {
      // An order whose form was opened but never sent is the same order again: nothing exists at Moyasar for it yet.
      const open = recent.find((o) => o.kind === 'form' && fresh(o) && !o.attemptedAt && o.paymentId);
      if (open) {
        // "Keep Pro on" starts unticked every time the form opens.
        if (open.keep) await this.repo.setKeep(open.id, b.id, false, now);
        return { ok: true, orderId: open.id, form: this.formConfig({ ...open, keep: false }, lang, base, start, fo) };
      }
      if (recent.length >= ORDERS_PER_DAY) return { ok: false, reason: 'busy' };
      const givenId = randomUUID();
      if (this.mode === 'api') {
        // Before a card is typed: can the payment be read back afterwards? A key
        // Moyasar refuses, or a proxy that is down, is found here, with nothing charged.
        try {
          if (!this.api?.payment || (await this.api.payment(givenId)) !== null) throw new MoyasarError(0, 'bad_payment');
        } catch (e) {
          console.error(`[tifo] payments: Moyasar could not be reached before a form checkout (${(e as Error).message})`);
          return { ok: false, reason: 'unavailable' };
        }
      }
      const order = await this.repo.create({ userId: b.id, amount, days, lang, testMode: this.testMode(), now, kind: 'form', paymentId: givenId, product, src });
      return { ok: true, orderId: order.id, form: this.formConfig(order, lang, base, start, fo) };
    }

    if (!this.api) return { ok: false, reason: 'off' };
    // Still pending after that: Moyasar's page still takes payment, so the fan goes back to it.
    const open = recent.find((o) => o.kind === 'invoice' && o.invoiceUrl && fresh(o));
    if (open?.invoiceUrl) return { ok: true, orderId: open.id, url: open.invoiceUrl };
    if (recent.length >= ORDERS_PER_DAY) return { ok: false, reason: 'busy' };

    const order = await this.repo.create({ userId: b.id, amount, days, lang, testMode: this.testMode(), now, product, src });
    const page = lang === 'ar' ? '/ar/pro' : '/pro';
    try {
      const inv = await this.api.createInvoice({
        amount,
        currency: 'SAR',
        description: this.description(lang, days, product),
        callbackUrl: `${base}/api/pro/pay/invoice`,
        successUrl: `${base}${page}?order=${order.id}`,
        // "Back" on Moyasar's page: /pro says nothing was charged (or that it was paid after all).
        backUrl: `${base}${page}?order=${order.id}&back=1`,
        expiresAt: new Date(now.getTime() + INVOICE_MINUTES * 60_000),
        metadata: { order_id: order.id },
      });
      if (inv.amount !== amount || inv.currency !== 'SAR') throw new MoyasarError(0, 'bad_invoice');
      await this.repo.attachInvoice(order.id, inv.id, inv.url);
      return { ok: true, orderId: order.id, url: inv.url };
    } catch (e) {
      await this.repo.settle(order.id, 'failed', `the invoice could not be made: ${(e as Error).message}`.slice(0, 300)).catch(() => {});
      console.error(`[tifo] payments: an invoice could not be made (${(e as Error).message})`);
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * "Keep Pro on", ticked or unticked on an order the form is open for. The
   * only way an order ever comes to ask for auto-renew: this account, this
   * pending order, saying so now.
   */
  async setKeep(userId: string, orderId: string, keep: boolean): Promise<boolean> {
    if (keep && !this.renewOn()) return false;
    // A match pass is bought outright: it cannot be asked to renew.
    if (keep && (await this.repo.get(orderId))?.product !== 'monthly') return false;
    return this.repo.setKeep(orderId, userId, keep, this.pro.now());
  }

  /** The form sent a payment for this order: it is not offered again (the browser's word; it gives nothing). */
  async attempted(userId: string, orderId: string): Promise<boolean> {
    if (!this.on()) return false;
    return this.repo.markAttempted(orderId, userId, this.pro.now());
  }

  /** Paid: the pass, once, then the auto-renew it asked for and the receipt. */
  private async grant(order: ProOrder, paymentId: string, method: string | null, now: Date, p: MoyasarPayment | null, brand: string | null = p?.company ?? null): Promise<ProOrder> {
    const when = order.userId ? await this.startFor(order.userId, now) : { start: now };
    // Paid is paid: a month bought while holding a long pass starts when that pass ends.
    let start = 'start' in when ? when.start : new Date(when.held);
    if (order.kind === 'renewal' && order.userId && start.getTime() === now.getTime()) {
      // A renewal is charged by a job that runs every few minutes, so it lands a little after the
      // month it renews has ended. The new month starts where that one ended: the dates do not creep.
      const justEnded = (await this.pro.repo.allPasses(order.userId))
        .filter((x) => x.plan === 'monthly' && !x.revokedAt)
        .map((x) => Date.parse(x.endsAt))
        .filter((t) => t <= now.getTime() && now.getTime() - t <= RENEWAL_GRACE_MS);
      if (justEnded.length) start = new Date(Math.max(...justEnded));
    }
    // The founders bonus this confirmation is in time for (proLaunch.ts has the rule). Whether this account may
    // have it, once and never again, is decided by the store in the step that marks the order paid.
    const bonusDays = order.product === 'monthly' ? (await this.opts.founders?.bonusDays(order, now).catch(() => 0)) ?? 0 : 0;
    const r = await this.repo.markPaid(order.id, { paymentId, method, brand, now, startsAt: start, endsAt: new Date(start.getTime() + order.days * DAY_MS), bonusDays });
    if (!r.ok) return (await this.repo.get(order.id)) ?? order;
    if (r.first) {
      console.log(`[tifo] payments: order ${order.id} paid${order.testMode ? ' (test)' : ''}${r.order.bonusDays ? ` (founders bonus: ${r.order.bonusDays} more days)` : ''}`);
      const sub = await this.afterPaid(r.order, p, r.pass, now).catch((e) => {
        console.error(`[tifo] payments: auto-renew for order ${order.id} could not be set up (${(e as Error).message})`);
        return null;
      });
      await this.opts.onPaid?.(r.order, r.pass?.endsAt ?? null, sub).catch((e) => console.error(`[tifo] payments: the receipt for ${order.id} failed (${(e as Error).message})`));
    }
    return r.order;
  }

  /**
   * Bring an order in line with what Moyasar says about it. The only place a
   * pass is given for money, and (outside the webhook-only mode) the only
   * input it trusts is Moyasar's API answering this server's own key.
   */
  async reconcile(order: ProOrder): Promise<ProOrder> {
    if (order.kind !== 'invoice') return this.reconcilePayment(order);
    if (!this.api || !order.invoiceId) return order;
    if (order.status === 'refunded' || order.status === 'review') return order;
    let inv: MoyasarInvoice;
    try {
      inv = await this.api.invoice(order.invoiceId);
    } catch (e) {
      console.error(`[tifo] payments: invoice ${order.invoiceId} could not be read (${(e as Error).message})`);
      return order;
    }
    const now = this.pro.now();
    if (inv.status === 'paid') {
      const paid = inv.payments.find((p) => p.status === 'paid' || p.status === 'captured');
      // Paid, but not what was asked: a person looks before anyone gets anything.
      const wrong =
        inv.amount !== order.amount ? `the invoice is for ${inv.amount} halalas, the order for ${order.amount}` :
        inv.currency !== 'SAR' ? `the invoice is in ${inv.currency}` :
        inv.metadata.order_id && inv.metadata.order_id !== order.id ? 'the invoice names another order' :
        paid && (paid.amount !== order.amount || paid.currency !== 'SAR') ? `the payment is ${paid.amount} ${paid.currency}` :
        null;
      if (wrong) {
        console.error(`[tifo] payments: order ${order.id} needs a look: ${wrong}`);
        await this.repo.settle(order.id, 'review', wrong);
        return (await this.repo.get(order.id)) ?? order;
      }
      if (order.status === 'paid') return order;
      return this.grant(order, paid?.id ?? '', paid?.sourceType ?? null, now, null, paid?.company ?? null);
    }
    if ((inv.status === 'refunded' || inv.status === 'voided') && order.status === 'paid') {
      // Refunded in Moyasar's dashboard rather than from /admin: the pass goes with the money.
      const refunded = inv.payments.reduce((s, p) => s + p.refunded, 0) || order.amount;
      await this.markRefunded(order, Math.min(refunded, order.amount), now);
      return (await this.repo.get(order.id)) ?? order;
    }
    if (order.status === 'pending' && ['expired', 'canceled', 'failed', 'voided', 'refunded'].includes(inv.status)) {
      await this.repo.settle(order.id, inv.status === 'expired' || inv.status === 'canceled' ? 'expired' : 'failed', `the invoice is ${inv.status}`);
      return (await this.repo.get(order.id)) ?? order;
    }
    return order;
  }

  /** A form or renewal order: read its payment (the id this server chose) and act on what Moyasar says. */
  private async reconcilePayment(order: ProOrder): Promise<ProOrder> {
    // The webhook-only mode has no key to ask with: such an order moves only when Moyasar's webhook says so.
    if (!this.api?.payment || !isMoyasarId(order.paymentId)) return order;
    if (order.status === 'refunded' || order.status === 'review') return order;
    let p: MoyasarPayment | null;
    try {
      p = await this.api.payment(order.paymentId);
    } catch (e) {
      console.error(`[tifo] payments: payment ${order.paymentId} could not be read (${(e as Error).message})`);
      return order;
    }
    // Nothing by that id: the form was never sent.
    return p ? this.applyPayment(order, p, false) : order;
  }

  /**
   * What a payment says about its order. `p` came from Moyasar's API under the
   * secret key or, in the webhook-only mode (`strict`), from a webhook whose
   * secret matched; either way it must be this order's own payment, paid in
   * full, in riyals, before anyone gets anything.
   */
  private async applyPayment(order: ProOrder, p: MoyasarPayment, strict: boolean): Promise<ProOrder> {
    if (order.status === 'refunded' || order.status === 'review') return order;
    const now = this.pro.now();
    const again = async (): Promise<ProOrder> => (await this.repo.get(order.id)) ?? order;
    const paid = p.status === 'paid' || p.status === 'captured';
    if (p.status === 'refunded' || p.status === 'voided' || (paid && p.refunded > 0)) {
      // Refunded (in /admin, or in Moyasar's dashboard), in full or in part: the pass goes with the money, and so does auto-renew.
      if (order.status === 'paid') {
        await this.markRefunded(order, Math.min(p.refunded || order.amount, order.amount), now);
        if (order.userId) await this.stopRenewing(order.userId, 'refunded', false);
      } else if (order.status === 'pending') {
        await this.repo.settle(order.id, 'failed', `the payment is ${p.status === 'paid' || p.status === 'captured' ? 'refunded' : p.status}`);
      }
      return again();
    }
    if (paid) {
      // Paid, but not what was asked: a person looks before anyone gets anything.
      const named = p.metadata?.order_id;
      const wrong =
        p.id.toLowerCase() !== (order.paymentId ?? '').toLowerCase() ? 'the payment is not the one this order waits for' :
        p.amount !== order.amount ? `the payment is for ${p.amount} halalas, the order for ${order.amount}` :
        p.currency !== 'SAR' ? `the payment is in ${p.currency}` :
        named && named !== order.id ? 'the payment names another order' :
        strict && named !== order.id ? 'the payment does not name this order' :
        null;
      if (wrong) {
        console.error(`[tifo] payments: order ${order.id} needs a look: ${wrong}`);
        await this.repo.settle(order.id, 'review', wrong);
        return again();
      }
      if (order.status === 'paid') return order;
      return this.grant(order, p.id, p.sourceType, now, p);
    }
    if (p.status === 'failed' && order.status === 'pending') {
      // A renewal's failed try is settled by the renewals job, together with its subscription's
      // retry date (failTry): settled alone here, the cycle would look free for another try.
      if (order.kind === 'renewal') return order;
      await this.repo.settle(order.id, 'failed', 'the payment failed', failReason(p));
      return again();
    }
    // 'initiated' (3-D Secure not finished), 'authorized', 'verified': still waiting.
    return order;
  }

  /** An order, as its owner asks after it (the return from Moyasar's page or form). */
  async orderFor(userId: string, orderId: string): Promise<ProOrder | null> {
    const o = await this.repo.get(orderId);
    if (!o || o.userId !== userId) return null;
    return o.status === 'pending' ? this.reconcile(o) : o;
  }

  /** Moyasar's POST to the invoice's callback_url: the invoice, untrusted. Only its id is used. */
  async invoiceNudge(body: unknown): Promise<void> {
    if (!this.on()) return;
    const id = (body && typeof body === 'object' ? (body as Record<string, unknown>).id : null);
    if (!isMoyasarId(id)) return;
    const o = await this.repo.byInvoice(id);
    if (o && o.status === 'pending') await this.reconcile(o);
  }

  /**
   * The code Moyasar sends when a webhook is added (Settings -> Webhooks):
   * it has to be typed back into Moyasar's dashboard within 30 minutes
   * before the webhook works. Shown on /admin and in the server's log. It
   * opens nothing here: a wrong one only means Moyasar asks again.
   */
  verification: { code: string; at: string } | null = null;

  /**
   * Moyasar's webhook. 'ignored' for anything that is not ours or not for
   * this key's mode; 'refused' when the secret does not match. Every event
   * that names one of our orders reconciles that order: a payment, a
   * failure, a refund made in Moyasar's dashboard.
   *
   * With a secret key (the default), the event is only a nudge: the order is
   * read back from Moyasar. In the webhook-only mode there is nothing to read
   * back with, so the event's own payment is what is acted on (applyPayment,
   * strict), and it must say outright which mode it is for.
   */
  async webhook(body: unknown): Promise<'done' | 'ignored' | 'refused' | 'closed'> {
    const secret = webhookSecret(this.env);
    if (!this.on() || !secret) return 'closed';
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (b.type === 'webhook_verification') {
      // Moyasar may send it before the secret is in use: a secret that is there must still match.
      if (typeof b.secret_token === 'string' && !sameSecret(b.secret_token, secret)) return 'refused';
      const code = (b.data && typeof b.data === 'object' ? (b.data as Record<string, unknown>).verification_code : null);
      const text = typeof code === 'number' ? String(code) : code;
      if (typeof text !== 'string' || !/^\d{4,8}$/.test(text)) return 'ignored';
      this.verification = { code: text, at: this.pro.now().toISOString() };
      console.log(`[tifo] payments: Moyasar's webhook verification code is ${text} (type it in Moyasar's dashboard, Settings -> Webhooks -> Verify)`);
      return 'done';
    }
    const given = typeof b.secret_token === 'string' ? b.secret_token : '';
    if (!sameSecret(given, secret)) return 'refused';
    const live = payKeyKind(this.env) === 'live';
    const data = (b.data && typeof b.data === 'object' ? b.data : {}) as Record<string, unknown>;
    const meta = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, unknown>;

    if (this.mode === 'webhook') {
      // Test money never counts on a live key, nor live on a test key: here the event has to say which it is.
      if (b.live !== live) return 'ignored';
      if (typeof b.type !== 'string' || !/^payment_/.test(b.type) || !isMoyasarId(data.id)) return 'ignored';
      const order = await this.repo.byPayment(data.id);
      if (!order || order.kind === 'invoice' || order.testMode === live) return 'ignored';
      await this.applyPayment(order, readPayment(data), true);
      return 'done';
    }

    if (typeof b.live === 'boolean' && b.live !== live) return 'ignored';
    let order: ProOrder | null = null;
    if (isMoyasarId(data.invoice_id)) order = await this.repo.byInvoice(data.invoice_id);
    if (!order && isMoyasarId(meta.order_id)) order = await this.repo.get(meta.order_id);
    if (!order && isMoyasarId(data.id)) order = await this.repo.byPayment(data.id);
    if (!order) return 'ignored';
    await this.reconcile(order);
    return 'done';
  }

  /**
   * Refund an order in full and end its pass (/admin). Within REFUND_DAYS of
   * paying unless `late` says the owner chose to anyway. Whether Pro was
   * used is shown to the owner beside the button (passUse); the server does
   * not decide that, because "used" is a judgement (a design exported with
   * the Pro mark is a use the counters do not see). A refund also turns
   * auto-renew off: nobody who asked for their money back is charged again.
   * The fan is told by email, once, wherever the refund was made (afterRefund).
   */
  async refund(orderId: string, late = false): Promise<RefundResult> {
    if (!this.on()) return { ok: false, reason: 'off' };
    // No secret key here: the refund is made in Moyasar's dashboard, and its webhook ends the pass.
    if (this.mode === 'webhook') return { ok: false, reason: 'dashboard' };
    if (!this.api) return { ok: false, reason: 'off' };
    let o = await this.repo.get(orderId);
    if (!o) return { ok: false, reason: 'none' };
    if (o.status === 'pending') o = await this.reconcile(o);
    if (o.status !== 'paid') return { ok: false, reason: 'not_paid' };
    const now = this.pro.now();
    if (!late && o.paidAt && now.getTime() - Date.parse(o.paidAt) > REFUND_DAYS * DAY_MS) return { ok: false, reason: 'late' };
    if (!isMoyasarId(o.paymentId)) return { ok: false, reason: 'no_payment' };
    try {
      const p = await this.api.refund(o.paymentId);
      if (p.status !== 'refunded') throw new MoyasarError(0, `status_${p.status}`);
      await this.markRefunded(o, p.refunded || o.amount, now);
    } catch (e) {
      console.error(`[tifo] payments: refunding order ${o.id} failed (${(e as Error).message})`);
      // Moyasar says to read the payment back before trying again: reconcile does.
      const again = await this.reconcile(o);
      if (again.status !== 'refunded') return { ok: false, reason: 'failed' };
    }
    if (o.userId) await this.stopRenewing(o.userId, 'refunded', false).catch(() => false);
    return { ok: true, order: (await this.repo.get(o.id)) ?? o };
  }

  // ------------------------------------------- refunds, told and asked for ---
  //
  // (19 Nov 2026.) The whole of it:
  //
  //  1. Every refund, from /admin or from Moyasar's dashboard (seen through
  //     the webhook or the next look at the order), goes through
  //     markRefunded() below. The store ends the pass in the same step as
  //     before; afterRefund() then answers an open request for that order
  //     and sends the refund email. One caller sends it (claimRefundMail),
  //     and one that could not be sent is tried again by the job.
  //  2. The site shows the refund once (refundNotice, seenRefund).
  //  3. A fan asks for a refund from the account page (requestRefund): only
  //     for their own order, paid within REFUND_DAYS, once. It waits for the
  //     owner (decideRequest), unless PRO_AUTO_REFUND is on and the request
  //     plainly meets the promise.
  //
  // None of this gives or takes money except through refund() above, which
  // asks Moyasar and believes only its answer.

  /** Orders the auto-refund switch is refunding right now, so the request each answers is marked as its doing. */
  private readonly autoRefunding = new Set<string>();
  private readonly receiptSent = new Map<string, number>();

  /** An order is refunded: the pass goes with it (the store), then the fan is told. */
  private async markRefunded(order: ProOrder, amount: number, now: Date): Promise<void> {
    await this.repo.markRefunded(order.id, amount, now);
    await this.afterRefund(order.id, now);
  }

  /**
   * What a refund owes besides ending the pass: the request it answers is
   * closed as approved, and the fan gets the email, once. Safe to call any
   * number of times for the same order; never throws.
   */
  private async afterRefund(orderId: string, now: Date): Promise<void> {
    try {
      const o = await this.repo.get(orderId);
      if (!o || o.status !== 'refunded') return;
      const rq = await this.repo.requestForOrder(o.id);
      if (rq?.status === 'pending') await this.repo.decideRequest(rq.id, 'approved', { reason: null, auto: this.autoRefunding.has(o.id) }, now);
      if (!o.userId || !this.opts.onRefunded) return;
      if (!(await this.repo.claimRefundMail(o.id, now))) return;
      const sent = await this.opts.onRefunded(o).catch((e) => {
        console.error(`[tifo] payments: the refund email for ${o.id} failed (${(e as Error).message})`);
        return false;
      });
      // Owed again: the job tries for a few days (sweepRefundMails).
      if (!sent) await this.repo.unclaimRefundMail(o.id);
    } catch (e) {
      console.error(`[tifo] payments: telling the fan about the refund of ${orderId} failed (${(e as Error).message})`);
    }
  }

  /** Refund emails that could not be sent when the refund was made. */
  private async sweepRefundMails(): Promise<void> {
    if (!this.opts.onRefunded) return;
    const now = this.pro.now();
    for (const o of await this.repo.unmailedRefunds(new Date(now.getTime() - REFUND_MAIL_RETRY_DAYS * DAY_MS), 20)) await this.afterRefund(o.id, now);
  }

  /** The newest refund this account has not been shown on the site yet, if any. */
  async refundNotice(userId: string): Promise<ProOrder | null> {
    const now = this.pro.now();
    return (await this.repo.unseenRefunds(userId, new Date(now.getTime() - NOTICE_DAYS * DAY_MS)))[0] ?? null;
  }

  /** The notice was shown: it is not shown again. An account's unseen refunds all go with it (one card, not one per order). */
  async seenRefund(userId: string, orderId: string): Promise<boolean> {
    const now = this.pro.now();
    const unseen = await this.repo.unseenRefunds(userId, new Date(0));
    if (!unseen.some((o) => o.id === orderId)) return false;
    for (const o of unseen) await this.repo.markRefundSeen(userId, o.id, now);
    return true;
  }

  private refundUntil(o: ProOrder): number | null {
    return o.paidAt ? Date.parse(o.paidAt) + REFUND_DAYS * DAY_MS : null;
  }

  /**
   * What an account bought, newest first: paid and refunded orders, ones
   * being checked, and (for a month) ones that did not go through. An order
   * that was opened and never sent is not a purchase and is left out.
   */
  async purchases(userId: string): Promise<Purchase[]> {
    const now = this.pro.now();
    const orders = (await this.repo.recentFor(userId, new Date(0))).filter((o) =>
      o.status === 'paid' || o.status === 'refunded' || o.status === 'review' ||
      (o.status === 'failed' && (o.kind !== 'invoice' || !!o.invoiceId) && now.getTime() - Date.parse(o.createdAt) < FAILED_SHOWN_DAYS * DAY_MS));
    if (!orders.length) return [];
    const [requests, passes] = await Promise.all([this.repo.requestsFor(userId), this.pro.repo.allPasses(userId)]);
    return Promise.all(orders.map(async (o): Promise<Purchase> => {
      const pass = o.passId ? passes.find((p) => p.id === o.passId) ?? null : null;
      const rq = requests.find((r) => r.orderId === o.id) ?? null;
      const until = this.refundUntil(o);
      const state: RefundState =
        o.status === 'refunded' ? 'refunded' :
        o.status !== 'paid' ? 'none' :
        rq?.status === 'pending' ? 'requested' :
        rq?.status === 'declined' ? 'declined' :
        until !== null && now.getTime() <= until ? 'open' : 'late';
      return {
        order: o,
        endsAt: pass && !pass.revokedAt ? pass.endsAt : null,
        refund: {
          state,
          until: o.status === 'paid' && until !== null ? new Date(until).toISOString() : null,
          used: state === 'open' && o.passId ? (await this.pro.repo.passUse(userId, o.passId).catch(() => 0)) > 0 : null,
          reason: state === 'declined' ? rq?.declineReason ?? null : null,
          askedAt: rq?.createdAt ?? null,
        },
      };
    }));
  }

  /**
   * A fan asks for a refund of an order, from the account page. Only their
   * own order, paid, within REFUND_DAYS, and once per order. By default it
   * waits for the owner: the fan and the owner are both emailed. With
   * PRO_AUTO_REFUND=on it is refunded at once when the pass shows no use and
   * the account has never been refunded before (so buying and refunding in a
   * loop, each one costing a fee, is not on offer); anything else still waits.
   */
  async requestRefund(userId: string, orderId: string, note: string | null): Promise<RefundAskResult> {
    const o = await this.repo.get(orderId);
    // Someone else's order is no order at all.
    if (!o || o.userId !== userId) return { ok: false, reason: 'none' };
    if (o.status === 'refunded') return { ok: false, reason: 'refunded' };
    if (o.status !== 'paid') return { ok: false, reason: 'not_paid' };
    const now = this.pro.now();
    const until = this.refundUntil(o);
    if (until === null || now.getTime() > until) return { ok: false, reason: 'late' };
    const used = o.passId ? await this.pro.repo.passUse(userId, o.passId).catch(() => -1) : 0;
    const text = (note ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    // A count that could not be read is not "not used": such a request waits for a person.
    const rq = await this.repo.createRequest({ orderId: o.id, userId, note: text, used: Math.max(0, used), now });
    if (!rq) return { ok: false, reason: 'already' };

    if (autoRefundOn(this.env) && this.on() && this.api && used === 0 && o.passId) {
      const before = (await this.repo.recentFor(userId, new Date(0))).some((x) => x.status === 'refunded');
      if (!before) {
        this.autoRefunding.add(o.id);
        try {
          const r = await this.refund(o.id);
          if (r.ok) {
            console.log(`[tifo] payments: order ${o.id} refunded on request (PRO_AUTO_REFUND)`);
            return { ok: true, state: 'refunded' };
          }
          console.error(`[tifo] payments: the automatic refund of ${o.id} did not go through (${r.reason}); the request waits in /admin`);
        } finally {
          this.autoRefunding.delete(o.id);
        }
      }
    }
    await this.opts.onRequest?.({ kind: 'received', request: rq, order: o }).catch((e) => console.error(`[tifo] payments: the emails for refund request ${rq.id} failed (${(e as Error).message})`));
    return { ok: true, state: 'requested' };
  }

  /**
   * The owner answers a request (/admin). Approve: the order is refunded
   * through refund() (late or not: the request was made in time), which ends
   * the pass, closes the request and emails the fan. If the refund does not
   * go through, the request stays open and the reason is given back. Decline:
   * needs a reason, which is emailed to the fan.
   */
  async decideRequest(id: string, action: 'approve' | 'decline', reason: string | null): Promise<RefundDecision> {
    const rq = await this.repo.requestById(id);
    if (!rq) return { ok: false, reason: 'none' };
    if (rq.status !== 'pending') return { ok: false, reason: 'decided' };
    if (action === 'approve') {
      const r = await this.refund(rq.orderId, true);
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, status: 'approved' };
    }
    const why = (reason ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (why.length < 3) return { ok: false, reason: 'reason' };
    const now = this.pro.now();
    if (!(await this.repo.decideRequest(rq.id, 'declined', { reason: why, auto: false }, now))) return { ok: false, reason: 'decided' };
    const order = await this.repo.get(rq.orderId);
    if (order) {
      await this.opts.onRequest?.({ kind: 'declined', request: { ...rq, status: 'declined', declineReason: why, decidedAt: now.toISOString() }, order })
        .catch((e) => console.error(`[tifo] payments: the email for declined request ${rq.id} failed (${(e as Error).message})`));
    }
    return { ok: true, status: 'declined' };
  }

  /** /admin: the refund requests, the open ones first. */
  async refundRequests(): Promise<RefundRequestRow[]> {
    return this.repo.listRequests(100);
  }

  /**
   * Send an order's receipt to its owner again. 'wait' when it was sent a
   * few minutes ago; 'none' for anything that is not this account's paid (or
   * refunded) order.
   */
  async resendReceipt(userId: string, orderId: string): Promise<'sent' | 'wait' | 'none'> {
    const o = await this.repo.get(orderId);
    if (!o || o.userId !== userId || (o.status !== 'paid' && o.status !== 'refunded') || !this.opts.onPaid) return 'none';
    const now = this.pro.now().getTime();
    const last = this.receiptSent.get(o.id);
    if (last !== undefined && Math.abs(now - last) < RECEIPT_AGAIN_MS) return 'wait';
    this.receiptSent.set(o.id, now);
    if (this.receiptSent.size > 5000) this.receiptSent.clear();
    const pass = o.passId ? (await this.pro.repo.allPasses(userId)).find((p) => p.id === o.passId) ?? null : null;
    const sub = o.status === 'paid' ? await this.repo.subFor(userId) : null;
    const renewing = sub && sub.status === 'active' ? sub : null;
    try {
      await this.opts.onPaid(o, pass && !pass.revokedAt ? pass.endsAt : null, renewing, renewing?.nextChargeAt ?? null);
    } catch (e) {
      console.error(`[tifo] payments: sending the receipt for ${o.id} again failed (${(e as Error).message})`);
      this.receiptSent.delete(o.id);
      return 'none';
    }
    return 'sent';
  }

  // ----------------------------------------------------------- auto-renew ---
  //
  // "Keep Pro on" (PRO_AUTORENEW=on). The whole of it, in order:
  //
  //  1. The form shows an unticked box with the price and the next renewal
  //     date. Ticking it tells the server (setKeep) and only then does the
  //     form ask Moyasar to save the card with the payment.
  //  2. When that order is paid, afterPaid() starts the subscription, if and
  //     only if the order asked (keep), Moyasar returned a token, the method
  //     can renew, and the token is active. Otherwise any token is deleted
  //     and the month is a one-time pass.
  //  3. runRenewals() (every 15 minutes) walks the subscriptions that are due within
  //     REMIND_DAYS: it emails the reminder, and no earlier than REMIND_DAYS
  //     after that reminder, charges the token. One live order per cycle
  //     (payRepo.claimCharge) and one payment per order id (Moyasar's
  //     given_id) keep that to one charge whatever runs twice.
  //  4. A failed charge is retried RETRY_DAYS later, the fan is emailed once,
  //     and after the last retry auto-renew ends by itself. An expired card
  //     ends it at once, with an email to add a card.
  //  5. Cancelling (the account page, the email's link, /admin, a refund,
  //     deleting the account) takes the token off the subscription and
  //     deletes it at Moyasar. The Pro already paid for runs to its end.
  //
  // Switched off (PRO_AUTORENEW unset), nothing is offered and nothing is
  // charged, and cancelling still works.

  /** Ask Moyasar to delete every token in the trash. One that cannot be deleted now stays for the next run. */
  async emptyTrash(): Promise<number> {
    if (!this.api?.deleteToken) return 0;
    let n = 0;
    for (const token of await this.repo.trashed(50)) {
      try {
        if (await this.api.deleteToken(token)) {
          await this.repo.untrash(token);
          n++;
        }
      } catch (e) {
        console.error(`[tifo] payments: a saved card could not be deleted at Moyasar yet (${(e as Error).message})`);
      }
    }
    return n;
  }

  private async dropToken(token: string, now: Date): Promise<void> {
    await this.repo.trash(token, now);
    await this.emptyTrash();
  }

  /** The order is paid: start the auto-renew it asked for, or make sure no card stays saved. */
  private async afterPaid(order: ProOrder, p: MoyasarPayment | null, pass: ProPass | null, now: Date): Promise<ProSubscription | null> {
    if (order.kind === 'renewal') return order.subscriptionId ? this.repo.subById(order.subscriptionId) : null;
    const token = p?.token ?? null;
    const asked = order.kind === 'form' && order.product === 'monthly' && order.keep && !!order.userId && !!pass && this.renewOn();
    const mada = p?.company === 'mada';
    const canRenew = !!p && RENEWABLE.includes(p.sourceType ?? '') && (!mada || renewMada(this.env));
    if (!asked || !token || !canRenew || !order.userId || !pass) {
      // A card saved that nobody asked to keep, or that cannot renew: gone at once.
      if (token) await this.dropToken(token, now);
      return null;
    }
    // Moyasar: a token can be charged once it is 'active' (the cardholder was verified).
    const t = await this.api?.token?.(token).catch(() => null);
    if (!t || t.status !== 'active') {
      await this.dropToken(token, now);
      return null;
    }
    const sub = await this.repo.saveSub({
      userId: order.userId, token, method: p.sourceType, brand: t.brand ?? p.company ?? null, lastFour: t.lastFour, expMonth: t.month, expYear: t.year,
      // Each renewal is the regular price for the plan's days, whatever the first month cost or however long a
      // founder's first month ran: what the box said before the fan ticked it.
      amount: regularHalalas(this.env), days: order.days, lang: order.lang, testMode: order.testMode,
      optedInAt: new Date(order.keepAt ?? now), nextChargeAt: new Date(pass.endsAt), now,
    });
    console.log(`[tifo] payments: auto-renew started with order ${order.id}`);
    // A card this one replaced.
    await this.emptyTrash();
    return sub;
  }

  /** Whether an account's auto-renew is running, for its own pages. */
  async renewalFor(userId: string): Promise<ProSubscription | null> {
    return this.repo.subFor(userId);
  }

  /**
   * Turn auto-renew off for an account. The token is deleted; the Pro already
   * paid for stays until its days end. True when it was on.
   */
  async stopRenewing(userId: string, reason: string, tell = true): Promise<boolean> {
    const sub = await this.repo.subFor(userId);
    if (!sub) return false;
    return this.stopSub(sub, reason, tell);
  }

  private async stopSub(sub: ProSubscription, reason: string, tell: boolean): Promise<boolean> {
    const now = this.pro.now();
    if (!(await this.repo.endSub(sub.id, 'cancelled', reason, now))) return false;
    console.log(`[tifo] payments: auto-renew cancelled (${reason})`);
    await this.emptyTrash();
    if (tell) {
      const end = await this.monthEnd(sub.userId, now);
      await this.opts.notify?.({ kind: 'cancelled', sub, endsAt: end === null ? null : new Date(end).toISOString() }).catch(() => false);
    }
    return true;
  }

  /** The one-click link in the emails. Only ever turns renewal off, so the link itself is the permission. */
  async cancelByLink(token: string): Promise<{ ok: true; endsAt: string | null; was: boolean } | { ok: false }> {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return { ok: false };
    const sub = await this.repo.subByCancelToken(token);
    if (!sub) return { ok: false };
    const was = await this.stopSub(sub, 'email link', true);
    const end = await this.monthEnd(sub.userId, this.pro.now());
    return { ok: true, endsAt: end === null ? null : new Date(end).toISOString(), was };
  }

  /** /admin: switch one subscription off. */
  async adminCancel(subId: string): Promise<boolean> {
    const sub = await this.repo.subById(subId);
    return sub ? this.stopSub(sub, 'admin', true) : false;
  }

  /** The account is being deleted: its saved card goes first, at Moyasar too. */
  async forgetAccount(userId: string): Promise<void> {
    await this.repo.dropSubFor(userId, this.pro.now());
    await this.emptyTrash();
  }

  /** /admin: the subscriptions, and the tokens still waiting to be deleted at Moyasar. */
  async subscriptions(): Promise<{ rows: ProSubscriptionRow[]; trash: number }> {
    return { rows: await this.repo.listSubs(300), trash: (await this.repo.trashed(200)).length };
  }

  private running = false;

  /**
   * The renewals job: reminders, charges, retries, endings. Safe to run as
   * often as wanted and from two places at once (see the note above). Does
   * nothing at all while auto-renew is switched off.
   */
  async runRenewals(): Promise<RenewRun> {
    const out: RenewRun = { reminded: 0, charged: 0, failed: 0, ended: 0, postponed: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      await this.emptyTrash().catch(() => 0);
      // A refund email the mail service refused earlier (nothing to do while payments are off).
      if (this.on()) await this.sweepRefundMails().catch(() => {});
      if (!this.renewOn()) return out;
      const now = this.pro.now();
      const due = await this.repo.subsDue(new Date(now.getTime() + REMIND_DAYS * DAY_MS + REMIND_EARLY_MS), 500);
      for (const sub of due) {
        try {
          await this.renewOne(sub, now, out);
        } catch (e) {
          console.error(`[tifo] payments: a renewal step failed and will be tried again (${(e as Error).message})`);
        }
      }
      if (out.reminded || out.charged || out.failed || out.ended) {
        console.log(`[tifo] payments: renewals: ${out.reminded} reminded, ${out.charged} charged, ${out.failed} failed, ${out.ended} ended`);
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  private async endRenewal(sub: ProSubscription, why: 'payment_failed' | 'card_expired' | 'unreachable', now: Date, out: RenewRun): Promise<void> {
    if (!(await this.repo.endSub(sub.id, 'ended', why, now))) return;
    out.ended++;
    await this.emptyTrash();
    const end = await this.monthEnd(sub.userId, now);
    await this.opts.notify?.({ kind: 'ended', sub, why, endsAt: end === null ? null : new Date(end).toISOString() }).catch(() => false);
  }

  /** A renewal was paid: the next one is due when the Pro now held ends. */
  private async advance(sub: ProSubscription, now: Date): Promise<boolean> {
    const end = await this.heldUntil(sub.userId, now);
    // Only from the cycle that was paid: a second job with the same news moves nothing.
    return this.repo.patchSub(sub.id, {
      status: 'active', cycle: sub.cycle + 1, attempts: 0, lastError: null, clearReminder: true, ifCycle: sub.cycle,
      nextChargeAt: new Date(end ?? now.getTime() + sub.days * DAY_MS),
    }, now);
  }

  /**
   * A renewal try did not go through (declined, 3-D Secure wanted, refused by
   * Moyasar). Nothing was charged. The order is settled and the subscription
   * moved to its retry date in one step (payRepo.failAttempt), so that between
   * the two no other job can start another try; the last retry, or an expired
   * card, ends auto-renew instead.
   */
  private async failTry(sub: ProSubscription, order: ProOrder, why: string, note: string, now: Date, out: RenewRun): Promise<void> {
    const attempts = sub.attempts + 1;
    // An expired card will not start working: say so now rather than after a week of tries.
    if (why === 'expired_card' || attempts > RETRY_DAYS.length) {
      // Auto-renew ends first (it is then never due again), the order after.
      await this.endRenewal(sub, why === 'expired_card' ? 'card_expired' : 'payment_failed', now, out);
      await this.repo.settle(order.id, 'failed', note.slice(0, 300), why.slice(0, 24));
      return;
    }
    const retryAt = new Date(now.getTime() + RETRY_DAYS[attempts - 1] * DAY_MS);
    const mine = await this.repo.failAttempt(sub.id, order.id, {
      ifAttempts: sub.attempts, ifCycle: sub.cycle, attempts, lastError: why.slice(0, 60), nextChargeAt: retryAt, note, fail: why.slice(0, 24),
    }, now);
    // Another job counted this same failed try first.
    if (!mine) return;
    out.failed++;
    if (attempts === 1) {
      const end = await this.monthEnd(sub.userId, now);
      await this.opts.notify?.({ kind: 'failed', sub, retryAt: retryAt.toISOString(), endsAt: end === null ? null : new Date(end).toISOString() }).catch(() => false);
    }
  }

  private async renewOne(sub: ProSubscription, now: Date, out: RenewRun): Promise<void> {
    if (!sub.token || !sub.nextChargeAt || !this.api?.chargeToken || !this.api.payment) return;
    // The price of a month came down since this fan ticked the box: they renew at the price the page shows
    // now, never at more than it. (It only ever goes down here: a price that rose is not passed on.)
    const regular = regularHalalas(this.env);
    if (regular < sub.amount && (await this.repo.lowerSubAmount(sub.id, regular, now))) sub.amount = regular;
    // Real money and test money never mix: a subscription made on the other kind of key waits.
    if (sub.testMode !== this.testMode()) return;
    const due = Date.parse(sub.nextChargeAt);

    // This cycle's order, if an earlier run (or a webhook) already got somewhere with it.
    const there = await this.repo.cycleOrder(sub.id, sub.cycle);
    if (there) {
      if (there.status === 'pending') return this.settleCharge(sub, there, true, now, out);
      if (there.status === 'paid' && (await this.advance(sub, now))) out.charged++;
      // Refunded: the refund turned auto-renew off already. In review: a person looks first.
      return;
    } else {
      // Holding Pro past the renewal date (a month given by hand, or bought): nothing is charged for days already held.
      const end = await this.heldUntil(sub.userId, now);
      if (end !== null && end - due > 3600_000) {
        await this.repo.patchSub(sub.id, { nextChargeAt: new Date(end), clearReminder: true }, now);
        out.postponed++;
        return;
      }
      if (sub.status === 'active') {
        // A card that will have expired by then is not charged: the fan is told now, and auto-renew ends.
        if (sub.expYear && sub.expMonth && Math.max(due, now.getTime()) >= Date.UTC(sub.expYear, sub.expMonth, 1)) return this.endRenewal(sub, 'card_expired', now, out);
        if (sub.remindedFor !== sub.nextChargeAt) {
          // The promise: an email REMIND_DAYS before every renewal. Late with it, the renewal moves, never the promise.
          const forDate = new Date(Math.max(due, now.getTime() + REMIND_DAYS * DAY_MS));
          if (!(await this.repo.claimReminder(sub.id, forDate, now))) return;
          // The first renewal after a founder's longer first month says so: 60 days went by, not 30.
          const opened = sub.cycle === 1
            ? (await this.repo.recentFor(sub.userId, new Date(0)).catch(() => [])).find((o) => o.status === 'paid' && o.kind !== 'renewal' && o.bonusDays > 0)
            : undefined;
          const sent = await this.opts.notify?.({
            kind: 'reminder', sub: { ...sub, nextChargeAt: forDate.toISOString() }, chargeAt: forDate.toISOString(),
            ...(opened ? { firstDays: opened.days + opened.bonusDays } : {}),
          }).catch(() => false);
          if (sent) {
            out.reminded++;
          } else {
            await this.repo.unclaimReminder(sub.id, new Date(due));
            if (now.getTime() - due > UNREACHABLE_DAYS * DAY_MS) await this.endRenewal(sub, 'unreachable', now, out);
          }
          return;
        }
        // Reminded less than REMIND_DAYS ago (it cannot be, by the line above; checked all the same).
        if (sub.remindedAt && now.getTime() - Date.parse(sub.remindedAt) < (REMIND_DAYS - 0.5) * DAY_MS) return;
      }
    }
    if (now.getTime() < due) return;

    const claim = await this.repo.claimCharge(sub.id, now, randomUUID());
    if (!claim || claim.order.status !== 'pending') return;
    return this.settleCharge(sub, claim.order, claim.resumed, now, out);
  }

  /**
   * Charge a renewal order, or finish one an earlier run began. With `resumed`
   * the payment is looked for first (the order's id is the payment's id): a
   * time-out may have left one behind, and it is never asked for twice.
   */
  private async settleCharge(sub: ProSubscription, order: ProOrder, resumed: boolean, now: Date, out: RenewRun): Promise<void> {
    if (!sub.token || !this.api?.chargeToken || !this.api.payment || !isMoyasarId(order.paymentId)) return;
    let p = resumed ? await this.api.payment(order.paymentId) : null;
    if (!p) {
      // Nothing exists at Moyasar for this order. Charging is only for a renewal that is due.
      if (!sub.nextChargeAt || now.getTime() < Date.parse(sub.nextChargeAt)) return;
      try {
        p = await this.api.chargeToken({
          givenId: order.paymentId,
          amount: order.amount,
          currency: 'SAR',
          description: this.description(sub.lang, sub.days),
          token: sub.token,
          callbackUrl: `${(this.opts.base ?? 'https://tifomaker.org').replace(/\/+$/, '')}/pro`,
          metadata: { order_id: order.id, renewal: String(sub.cycle) },
        });
      } catch (e) {
        const status = e instanceof MoyasarError ? e.status : 0;
        // Moyasar refused the request itself (a token it no longer takes): no payment exists, and this try is spent.
        if (status === 400 || status === 404 || status === 422) {
          return this.failTry(sub, order, 'declined', `the charge was refused (${(e as Error).message})`, now, out);
        }
        // Anything else (no answer, the proxy, Moyasar down, a key problem) leaves it unknown whether a payment was
        // made: the order stays, and the next run asks about this same payment id before doing anything.
        console.error(`[tifo] payments: a renewal charge got no clear answer; it will be looked at again (${(e as Error).message})`);
        return;
      }
    }
    if (p.status === 'failed') return this.failTry(sub, order, failReason(p), 'the payment failed', now, out);
    // The bank wants 3-D Secure, and nobody is here to do it: nothing was charged.
    if (p.status === 'initiated' || p.status === 'authorized' || p.status === 'verified') {
      return this.failTry(sub, order, 'auth', 'the bank asked for 3-D Secure, which a renewal cannot do', now, out);
    }
    const after = await this.applyPayment(order, p, false);
    if (after.status === 'paid' && (await this.advance(sub, now))) out.charged++;
  }
}

/**
 * The legal page's payment terms (legal.html, `data-pay`): the coming-soon
 * paragraph until Pro is on sale to everyone, then the terms in its
 * <template data-pay="sale"> blocks instead. Off, the sale terms are taken out
 * of the page altogether, so nothing about them is served.
 *
 * Payments v2: <template data-pay="renew"> blocks are the auto-renew terms,
 * shown only when Pro is on sale and auto-renew is on; <template
 * data-pay="once"> blocks say there is no renewal, shown on sale without it.
 *
 * The launch (proLaunch.ts): <template data-pay="launch"> blocks are the
 * launch price's terms, shown on sale while the launch price runs, with the
 * two prices and the date written in ({{launchPrice}}, {{regularPrice}},
 * {{launchUntil:en}}, {{launchUntil:ar}}); <template data-pay="founders">
 * blocks are the founders offer's terms, shown on sale while that offer is on.
 */
export interface PayLegalMore {
  /** The launch price as it runs now: both prices in halalas and the day it ends. Null or absent: none. */
  launch?: { price: number; regular: number; until: string } | null;
  /** The founders offer is on (it is, unless PRO_FOUNDERS_BONUS=off). */
  founders?: boolean;
  /** The match pass, while it is sold: its price in halalas and its length in hours. <template data-pay="match">, {{matchPrice}}, {{matchHours}}. */
  match?: { price: number; hours: number } | null;
  /** The year, while it is sold: its price in halalas and its length in days. <template data-pay="year">, {{yearPrice}}, {{yearDays}}, {{yearPerMonth}}. */
  year?: { price: number; days: number } | null;
  /**
   * The automatic gift, while it is on (it needs no sale: shown whenever Pro
   * is on): <template data-pay="gift"> with {{giftDays}}; and, when its emails
   * are on too, <template data-pay="giftmail">.
   */
  gift?: { days: number; mails: boolean } | null;
}

export function payLegal(html: string, onSale: boolean, renew = false, more: PayLegalMore = {}): string {
  const block = (name: string): RegExp => new RegExp(`<template data-pay="${name}">([\\s\\S]*?)<\\/template>\\n?`, 'g');
  const soon = /<p data-pay="soon">[\s\S]*?<\/p>\n?/g;
  const keep = (h: string, name: string, show: boolean): string => h.replace(block(name), show ? '$1' : '');
  let out = onSale ? html.replace(soon, '') : html;
  out = keep(out, 'sale', onSale);
  out = keep(out, 'renew', onSale && renew);
  out = keep(out, 'once', onSale && !renew);
  const l = onSale ? more.launch ?? null : null;
  out = keep(out, 'launch', !!l);
  out = keep(out, 'founders', onSale && more.founders === true);
  const sar = (h: number): string => (h % 100 === 0 ? String(h / 100) : (h / 100).toFixed(2));
  const mp = onSale ? more.match ?? null : null;
  out = keep(out, 'match', !!mp);
  if (mp) out = out.replace(/\{\{matchPrice\}\}/g, sar(mp.price)).replace(/\{\{matchHours\}\}/g, String(mp.hours));
  const yr = onSale ? more.year ?? null : null;
  out = keep(out, 'year', !!yr);
  if (yr) {
    out = out
      .replace(/\{\{yearPrice\}\}/g, sar(yr.price))
      .replace(/\{\{yearDays\}\}/g, String(yr.days))
      // A twelfth of the price, to the nearest halala, as /pro shows it.
      .replace(/\{\{yearPerMonth\}\}/g, (Math.round(yr.price / 12) / 100).toFixed(2));
  }
  const gift = more.gift ?? null;
  out = keep(out, 'gift', !!gift);
  out = keep(out, 'giftmail', !!gift?.mails);
  if (gift) out = out.replace(/\{\{giftDays\}\}/g, String(gift.days));
  if (l) {
    const day = (lang: string): string =>
      new Intl.DateTimeFormat(lang, { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(l.until));
    out = out
      .replace(/\{\{launchPrice\}\}/g, sar(l.price))
      .replace(/\{\{regularPrice\}\}/g, sar(l.regular))
      .replace(/\{\{launchUntil:en\}\}/g, day('en-GB'))
      .replace(/\{\{launchUntil:ar\}\}/g, day('ar-SA-u-ca-gregory-nu-latn'));
  }
  return out;
}
