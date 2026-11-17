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
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { MoyasarError, failReason, isMoyasarId, readPayment, type MoyasarApi, type MoyasarInvoice, type MoyasarPayment } from './moyasar';
import type { PaymentRepository, ProOrder, ProSubscription, ProSubscriptionRow } from './payRepo';
import { OFFER, liveFor, previewUsers, proMode } from './proPlan';
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
  };
}

// ---------------------------------------------------------------- rules ---

/** One month of Pro, in halalas. */
export const priceHalalas = (): number => Math.round(OFFER.monthly.price * 100);

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
  /** "Keep Pro on", when it is offered: the price and date to show before paying, and what can renew. */
  renew: { price: number; days: number; nextAt: string; methods: string[]; mada: boolean } | null;
}

export type CheckoutResult =
  | { ok: true; orderId: string; url: string }
  | { ok: true; orderId: string; form: FormConfig }
  | { ok: false; reason: 'off' | 'verify' | 'held' | 'busy' | 'unavailable'; endsAt?: string };

export type RefundResult =
  | { ok: true; order: ProOrder }
  | { ok: false; reason: 'none' | 'not_paid' | 'late' | 'no_payment' | 'failed' | 'off' | 'dashboard' };

/** An email the renewals owe a fan. `endsAt` is when the Pro they hold ends. */
export type RenewNotice =
  | { kind: 'reminder'; sub: ProSubscription; chargeAt: string }
  | { kind: 'failed'; sub: ProSubscription; retryAt: string; endsAt: string | null }
  | { kind: 'ended'; sub: ProSubscription; why: 'payment_failed' | 'card_expired' | 'unreachable'; endsAt: string | null }
  | { kind: 'cancelled'; sub: ProSubscription; endsAt: string | null };

export interface PaymentServiceOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Told once, when an order is first paid (the receipt). `sub` is the
   * auto-renew it started or belongs to, when there is one. Failures are
   * logged, never thrown.
   */
  onPaid?: (order: ProOrder, endsAt: string | null, sub: ProSubscription | null) => Promise<void>;
  /** Send a renewal email. Resolves true only when it was really handed to the mail service. */
  notify?: (n: RenewNotice) => Promise<boolean>;
  /** Whether Apple Pay's domain file is being served (routes.ts). */
  applePayReady?: () => boolean;
  /** The site's own origin, for the address Moyasar requires on a token charge. */
  base?: string;
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
  async startFor(userId: string, now: Date): Promise<{ start: Date } | { held: string }> {
    const end = await this.monthEnd(userId, now);
    if (end === null) return { start: now };
    if (end - now.getTime() > RENEW_WITHIN_DAYS * DAY_MS) return { held: new Date(end).toISOString() };
    return { start: new Date(end) };
  }

  /** When the months of Pro this account holds now run out (ms), or null when it holds none. */
  private async monthEnd(userId: string, now: Date): Promise<number | null> {
    const passes = (await this.pro.repo.activePasses(userId, now)).filter((p) => p.plan === 'monthly');
    return passes.length ? Math.max(...passes.map((p) => Date.parse(p.endsAt))) : null;
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

  private description(lang: 'en' | 'ar', days: number): string {
    return lang === 'ar' ? `تيفو ميكر برو: ${days} يوم` : `TifoMaker Pro: ${days} days`;
  }

  /** What the page needs to open the form for this order. */
  private formConfig(order: ProOrder, lang: 'en' | 'ar', base: string, start: Date): FormConfig {
    const methods = formMethods(this.env, this.applePayReady());
    const samsung = (this.env.MOYASAR_SAMSUNG_SERVICE_ID ?? '').trim();
    return {
      publishableKey: (this.env.MOYASAR_PUBLISHABLE_KEY ?? '').trim(),
      amount: order.amount,
      currency: 'SAR',
      description: this.description(lang, order.days),
      callbackUrl: `${base}${lang === 'ar' ? '/ar/pro' : '/pro'}?order=${order.id}`,
      givenId: order.paymentId ?? '',
      methods,
      networks: ['mada', 'visa', 'mastercard'],
      applePay: methods.includes('applepay') ? { label: 'TifoMaker', country: 'SA' } : null,
      samsungPay: methods.includes('samsungpay') ? { serviceId: samsung, orderNumber: order.id } : null,
      renew: this.renewOn()
        ? {
          price: order.amount / 100,
          days: order.days,
          nextAt: new Date(start.getTime() + order.days * DAY_MS).toISOString(),
          methods: methods.filter((m) => RENEWABLE.includes(m)),
          mada: renewMada(this.env),
        }
        : null,
    };
  }

  /** "Get Pro": an order and a Moyasar invoice (or the form for one), or the open one this account already has. */
  async checkout(b: Buyer, lang: 'en' | 'ar', base: string): Promise<CheckoutResult> {
    if (!this.openFor(b.username)) return { ok: false, reason: 'off' };
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
    const when = await this.startFor(b.id, now);
    if ('held' in when) return { ok: false, reason: 'held', endsAt: when.held };
    const amount = priceHalalas();
    const kind = this.checkoutKind();
    const fresh = (o: ProOrder): boolean =>
      o.status === 'pending' && o.amount === amount && o.testMode === this.testMode() && now.getTime() - Date.parse(o.createdAt) < REUSE_MINUTES * 60_000;

    if (kind === 'form') {
      // An order whose form was opened but never sent is the same order again: nothing exists at Moyasar for it yet.
      const open = recent.find((o) => o.kind === 'form' && fresh(o) && !o.attemptedAt && o.paymentId);
      if (open) {
        // "Keep Pro on" starts unticked every time the form opens.
        if (open.keep) await this.repo.setKeep(open.id, b.id, false, now);
        return { ok: true, orderId: open.id, form: this.formConfig({ ...open, keep: false }, lang, base, when.start) };
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
      const order = await this.repo.create({ userId: b.id, amount, days: OFFER.monthly.days, lang, testMode: this.testMode(), now, kind: 'form', paymentId: givenId });
      return { ok: true, orderId: order.id, form: this.formConfig(order, lang, base, when.start) };
    }

    if (!this.api) return { ok: false, reason: 'off' };
    // Still pending after that: Moyasar's page still takes payment, so the fan goes back to it.
    const open = recent.find((o) => o.kind === 'invoice' && o.invoiceUrl && fresh(o));
    if (open?.invoiceUrl) return { ok: true, orderId: open.id, url: open.invoiceUrl };
    if (recent.length >= ORDERS_PER_DAY) return { ok: false, reason: 'busy' };

    const order = await this.repo.create({ userId: b.id, amount, days: OFFER.monthly.days, lang, testMode: this.testMode(), now });
    const page = lang === 'ar' ? '/ar/pro' : '/pro';
    try {
      const inv = await this.api.createInvoice({
        amount,
        currency: 'SAR',
        description: this.description(lang, OFFER.monthly.days),
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
    return this.repo.setKeep(orderId, userId, keep, this.pro.now());
  }

  /** The form sent a payment for this order: it is not offered again (the browser's word; it gives nothing). */
  async attempted(userId: string, orderId: string): Promise<boolean> {
    if (!this.on()) return false;
    return this.repo.markAttempted(orderId, userId, this.pro.now());
  }

  /** Paid: the pass, once, then the auto-renew it asked for and the receipt. */
  private async grant(order: ProOrder, paymentId: string, method: string | null, now: Date, p: MoyasarPayment | null): Promise<ProOrder> {
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
    const r = await this.repo.markPaid(order.id, { paymentId, method, now, startsAt: start, endsAt: new Date(start.getTime() + order.days * DAY_MS) });
    if (!r.ok) return (await this.repo.get(order.id)) ?? order;
    if (r.first) {
      console.log(`[tifo] payments: order ${order.id} paid${order.testMode ? ' (test)' : ''}`);
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
      return this.grant(order, paid?.id ?? '', paid?.sourceType ?? null, now, null);
    }
    if ((inv.status === 'refunded' || inv.status === 'voided') && order.status === 'paid') {
      // Refunded in Moyasar's dashboard rather than from /admin: the pass goes with the money.
      const refunded = inv.payments.reduce((s, p) => s + p.refunded, 0) || order.amount;
      await this.repo.markRefunded(order.id, Math.min(refunded, order.amount), now);
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
        await this.repo.markRefunded(order.id, Math.min(p.refunded || order.amount, order.amount), now);
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
      await this.repo.markRefunded(o.id, p.refunded || o.amount, now);
    } catch (e) {
      console.error(`[tifo] payments: refunding order ${o.id} failed (${(e as Error).message})`);
      // Moyasar says to read the payment back before trying again: reconcile does.
      const again = await this.reconcile(o);
      if (again.status !== 'refunded') return { ok: false, reason: 'failed' };
    }
    if (o.userId) await this.stopRenewing(o.userId, 'refunded', false).catch(() => false);
    return { ok: true, order: (await this.repo.get(o.id)) ?? o };
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
    const asked = order.kind === 'form' && order.keep && !!order.userId && !!pass && this.renewOn();
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
      amount: order.amount, days: order.days, lang: order.lang, testMode: order.testMode,
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
          const sent = await this.opts.notify?.({ kind: 'reminder', sub: { ...sub, nextChargeAt: forDate.toISOString() }, chargeAt: forDate.toISOString() }).catch(() => false);
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
 */
export function payLegal(html: string, onSale: boolean, renew = false): string {
  const block = (name: string): RegExp => new RegExp(`<template data-pay="${name}">([\\s\\S]*?)<\\/template>\\n?`, 'g');
  const soon = /<p data-pay="soon">[\s\S]*?<\/p>\n?/g;
  const keep = (h: string, name: string, show: boolean): string => h.replace(block(name), show ? '$1' : '');
  let out = onSale ? html.replace(soon, '') : html;
  out = keep(out, 'sale', onSale);
  out = keep(out, 'renew', onSale && renew);
  out = keep(out, 'once', onSale && !renew);
  return out;
}
