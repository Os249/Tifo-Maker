/**
 * The Pro routes: what an account's Pro looks like (/api/pro), accepting the
 * 7-day gift, "tell me when Pro opens", the price question (/api/pro/price,
 * proPrice.ts), and the admin's grant, revoke and the price answers.
 *
 * Every answer is computed here from the server's own records. Nothing a
 * browser sends can raise a limit, choose a plan or start a pass: the only
 * inputs are who is asking (their session) and, for the admin, which account
 * and which plan.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ALLOWANCE_KINDS, FREE_WINDOWS, OFFER, PLAN_WINDOWS, UNLISTED, autoGiftOn, giftMailsOn, matchPass, monthlyPriceInvalid, monthlyPriceSetting, postOffersOn, proMode, previewUsers, type AllowanceKind, type MatchPass, type Window } from './proPlan';
import { disposableListStatus, type ProAccount, type ProService } from './pro';
import { GuestPace, PRICE_ANSWERS_MAX, PRICE_BANDS, accountVoter, deviceKey, deviceVoter, readPriceInput, summarizeAll } from './proPrice';
import type { PriceAnswer } from './proRepo';
import type { PaidOrder } from './payRepo';
import { priceAt, type FounderView, type PriceNow } from './proLaunch';
import type { UserRow } from './repo';

export interface ProRouteDeps {
  pro: ProService;
  userOf: (req: FastifyRequest) => Promise<string | null>;
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  accountOf: (req: FastifyRequest, userId: string) => Promise<UserRow | null>;
  getUserByName: (username: string) => Promise<UserRow | null>;
  adminAccess: (req: FastifyRequest) => Promise<boolean>;
  /** Whether the smart cut-out has a provider to call (for the admin panel). */
  cutoutConfigured: () => boolean;
  routeConfig?: object;
  /** The price question's own pace (POST /api/pro/price), tighter than the other routes'. */
  priceConfig?: object;
  /** The pace of "an export used these Pro items" (POST /api/pro/gift/used): one per export. */
  useConfig?: object;
  /**
   * Whether this account can buy Pro now (payments.ts paymentsOpenFor, and a
   * payment service to take the order). Absent: nobody can, as before.
   */
  paymentsOpenFor?: (username: string | null) => boolean;
  /** Whether Pro is on sale to everyone for real (payments.ts paymentsPublic): the signed-out page shows the price. */
  paymentsPublic?: () => boolean;
  /** Where "Get Pro" pays (payments v2): Moyasar's hosted page, or its form on /pro. */
  checkoutKind?: () => 'invoice' | 'form';
  /** Whether "Keep Pro on" is offered (payments v2). */
  autoRenew?: () => boolean;
  /** What a month costs now, and how the launch price is shown (proLaunch.ts priceAt). Absent: the server's clock decides. */
  price?: () => PriceNow;
  /**
   * The founders offer as this account sees it (proLaunch.ts): open to it, or
   * taken with its first purchase. Null for everyone else, so nobody's answer
   * changes unless they are a founder after the launch.
   */
  founderFor?: (userId: string, canBuy: boolean) => Promise<FounderView | null>;
  /** Whether this account has (or had) auto-renew: its account page then shows it (payments v2). */
  hasRenewal?: (userId: string) => Promise<boolean>;
  /**
   * What this account bought and a refund it has not been shown yet (19 Nov
   * 2026): the account page then lists the purchases, and the site says once
   * that a refund ended Pro. Null, or nothing in it, for everyone else.
   */
  payInfo?: (userId: string) => Promise<{ purchases: boolean; refundNotice: { order: string; amount: number; at: string; test: boolean } | null } | null>;
  /** The match pass as it is sold now (payments.ts match()). Absent: it is not sold. */
  match?: () => MatchPass;
  /** Real purchases paid since a day, for /admin's gift and funnel counts (payRepo.paidOrders). Absent: none. */
  paidOrders?: (since: Date) => Promise<PaidOrder[]>;
  /** How many sessions reached each of these funnel steps in the last `days` (the consent-gated events). Absent: none. */
  funnel?: (steps: string[], days: number) => Promise<{ name: string; sessions: number }[]>;
}

/** Where a Pro offer can be seen: the funnel's events and an order's `src` use these names (src/ui/proWhere.ts). */
export const OFFER_PLACES = ['post', 'share', 'export', 'page', 'giftend', 'limit', 'account'] as const;

const acctOf = (u: UserRow): ProAccount => ({ id: u.id, username: u.username, email: u.email, emailVerified: !!u.emailVerifiedAt });

/** Each plan's allowances, as the Pro page's table shows them (a pass's own month is "a month"). */
function limitsOf(w: Record<AllowanceKind, Window[]>): Record<AllowanceKind, { period: 'day' | 'week' | 'month'; limit: number }[]> {
  const out = {} as Record<AllowanceKind, { period: 'day' | 'week' | 'month'; limit: number }[]>;
  for (const k of ALLOWANCE_KINDS) out[k] = w[k].map((x) => ({ period: x.period === 'cycle' ? 'month' : x.period, limit: x.limit }));
  return out;
}

/**
 * What /pro shows to everyone while Pro is not on for them: the two plans'
 * allowances and the gift, and no price (the page asks what a month is worth
 * instead). The same for every visitor, so it says nothing about who is in a
 * preview.
 */
function soonOffer() {
  return {
    limits: { free: limitsOf(FREE_WINDOWS), pro: limitsOf(PLAN_WINDOWS.monthly) },
    // Kinds the page and the sheets do not list (proPlan.ts UNLISTED).
    unlisted: UNLISTED,
    monthly: { days: OFFER.monthly.days },
    gift: { days: OFFER.gift.days },
  };
}

/** An answer as its own voter sees it again. */
const ownAnswer = (a: PriceAnswer | null) => (a ? { amount: a.amount, currency: a.currency, comment: a.comment, wontPay: a.wontPay } : null);

/** How many answers there are, for "N fans have answered": counted at most once a minute. */
const COUNT_FOR_MS = 60_000;

/** The newest answers /admin lists in full (the summary counts them all; the CSV has every one). */
const ADMIN_PRICE_ROWS = 300;
/** Passes /admin's Members tab is sent, the newest first. */
const ADMIN_MEMBER_ROWS = 2000;

/** The parts of the offer the Pro page shows: Free against Pro, one price, and whether this visitor can buy it. */
function publicOffer(p: PriceNow, paymentsOpen: boolean, checkout: 'invoice' | 'form' = 'invoice', autoRenew = false, match: MatchPass | null = null) {
  return {
    // The match pass, where it is sold and can be bought: its price, its length, and that length in hours as the page says it.
    ...(paymentsOpen && match?.on ? { match: { price: match.halalas / 100, days: match.days, hours: match.days * 24 } } : {}),
    // Pro's versions and the account offer show on Post it and share (PRO_POST_OFFERS).
    ...(postOffersOn() ? { post: true } : {}),
    // The gift starts by itself for a new account with a verified email (PRO_AUTO_GIFT): the account offer may say so.
    ...(autoGiftOn() ? { autoGift: true } : {}),
    // Only said where Pro can be bought: the page's words follow them.
    ...(paymentsOpen && checkout === 'form' ? { checkout } : {}),
    // What every renewal costs: the regular price, whatever the first month costs.
    ...(paymentsOpen && autoRenew ? { autoRenew, renewPrice: p.regular / 100 } : {}),
    // The launch price, while it runs: the regular price it gives way to and the day it does. 'strike' (the
    // regular price crossed out) only with a discount licence, whose number then shows (proLaunch.ts priceDisplay).
    ...(p.launch && p.until ? { launch: { regular: p.regular / 100, until: p.until, display: p.display, ...(p.licence ? { licence: p.licence } : {}) } } : {}),
    limits: { free: limitsOf(FREE_WINDOWS), pro: limitsOf(PLAN_WINDOWS.monthly) },
    unlisted: UNLISTED,
    currency: OFFER.currency,
    // What Moyasar charges for an order made now.
    monthly: { price: p.halalas / 100, days: OFFER.monthly.days },
    gift: { days: OFFER.gift.days },
    paymentsOpen,
  };
}

const USERNAME = /^[A-Za-z0-9_.-]{1,32}$/;

export function registerProRoutes(app: FastifyInstance, deps: ProRouteDeps): void {
  const { pro } = deps;
  const cfg = deps.routeConfig ?? {};
  const canBuy = (username: string | null): boolean => deps.paymentsOpenFor?.(username) ?? false;
  const priceNow = (): PriceNow => deps.price?.() ?? priceAt(pro.now());
  const matchNow = (): MatchPass | null => deps.match?.() ?? null;
  /** The language the caller's browser asks for first, for the gift's record (its emails are in both anyway). */
  const langOf = (req: FastifyRequest): 'en' | 'ar' | null => {
    const h = String(req.headers['accept-language'] ?? '').trim().toLowerCase();
    return h.startsWith('ar') ? 'ar' : h.startsWith('en') ? 'en' : null;
  };

  /**
   * Pro as the caller sees it. Signed out, whether Pro is open to everyone
   * and the prices once it is. Not covered by PRO_MODE (signed in or out):
   * { live: false } with the coming-soon plans, which are the same for
   * everyone, so nobody learns about a preview by reading the API; signed
   * in, also whether they asked to hear when Pro opens.
   */
  app.get('/api/pro', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = await deps.userOf(req).catch(() => null);
    if (!userId) {
      const open = proMode() === 'on';
      return open ? { live: true, signedIn: false, offer: publicOffer(priceNow(), deps.paymentsPublic?.() ?? false, deps.checkoutKind?.(), deps.autoRenew?.(), matchNow()), soon: soonOffer() } : { live: false, signedIn: false, soon: soonOffer() };
    }
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return { live: false, signedIn: true, soon: soonOffer() };
    // Only said to an account that bought something: nobody else's answer changes.
    const info = deps.payInfo ? await deps.payInfo(user.id).catch(() => null) : null;
    const bought = { ...(info?.purchases ? { purchases: true } : {}), ...(info?.refundNotice ? { refundNotice: info.refundNotice } : {}) };
    if (!pro.live(user.username)) return { live: false, signedIn: true, soon: soonOffer(), notified: await pro.repo.notified(user.id), ...bought };
    const acct = acctOf(user);
    const buys = canBuy(user.username);
    // The gift first: it may start on this very request (the automatic gift), and the plan read after it must
    // already say so, or the page would be told "Pro is on" and "you are on Free" in one answer.
    const gift = await pro.giftFor(acct, langOf(req));
    const [holding, notified, renewal, founder] = await Promise.all([
      pro.plan(user.id),
      pro.repo.notified(user.id),
      deps.hasRenewal ? deps.hasRenewal(user.id).catch(() => false) : Promise.resolve(false),
      deps.founderFor ? deps.founderFor(user.id, buys).catch(() => null) : Promise.resolve(null),
    ]);
    const { plan, pass } = holding;
    const allowances = await pro.allowances(user.id, holding);
    return {
      live: true,
      signedIn: true,
      emailVerified: acct.emailVerified,
      plan,
      pass: pass ? { plan: pass.plan, startsAt: pass.startsAt, endsAt: pass.endsAt } : null,
      supporter: pro.isPaid(plan),
      allowances,
      gift,
      notified,
      offer: publicOffer(priceNow(), buys, deps.checkoutKind?.(), deps.autoRenew?.(), matchNow()),
      // Only said to an account that has it: nobody else's answer changes.
      ...(renewal ? { renewal: true } : {}),
      ...(founder ? { founder } : {}),
      ...bought,
      soon: soonOffer(),
      now: pro.now().toISOString(),
    };
  });

  // The gift offer was shown (the card or the sheet). Counted once per account,
  // for /admin: "eligible" and "saw the offer" are different numbers.
  app.post('/api/pro/gift/seen', cfg, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    await pro.giftShown(acctOf(user)).catch(() => false);
    return { ok: true };
  });

  app.post('/api/pro/gift/accept', cfg, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (!pro.live(user.username)) return reply.code(404).send({ error: 'not found' });
    if (!user.emailVerifiedAt) return reply.code(403).send({ error: 'verify your email first', reason: 'verify' });
    const r = await pro.acceptGift(acctOf(user));
    if (!r.ok) {
      const status = r.reason === 'off' ? 404 : 409;
      return reply.code(status).send({ error: 'the gift cannot be accepted', reason: r.reason });
    }
    return { ok: true, endsAt: r.endsAt };
  });

  // ------------------------------------------------- the automatic gift ---
  //
  // (22 Nov 2026.) The gift that starts by itself tells its holder once that
  // Pro is on (the welcome), once that it ended (the end card), and remembers
  // which Pro items their exports carried in between, to show them back on
  // that card. None of these gives or changes anything an account can do.

  /** The signed-in account for one of the gift's small routes, or null after answering. */
  const giftAccount = async (req: FastifyRequest, reply: FastifyReply): Promise<ProAccount | null> => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return null;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) {
      void reply.code(401).send({ error: 'authentication required' });
      return null;
    }
    return acctOf(user);
  };

  // The welcome was shown. With `offers` (the unticked box on it, or the account page), whether the
  // fan wants Pro's news and offers by email: only their own tick ever says yes.
  app.post('/api/pro/gift/welcomed', cfg, async (req, reply) => {
    const acct = await giftAccount(req, reply);
    if (!acct) return;
    const b = (req.body ?? {}) as { offers?: unknown };
    await pro.giftWelcomed(acct).catch(() => false);
    if (typeof b.offers === 'boolean') await pro.giftOffersOk(acct, b.offers).catch(() => false);
    return { ok: true };
  });

  app.post('/api/pro/gift/offers', cfg, async (req, reply) => {
    const acct = await giftAccount(req, reply);
    if (!acct) return;
    const ok = (req.body as { ok?: unknown } | null)?.ok;
    if (typeof ok !== 'boolean') return reply.code(400).send({ error: 'ok must be true or false' });
    return { ok: await pro.giftOffersOk(acct, ok).catch(() => false), offers: ok };
  });

  app.post('/api/pro/gift/end-seen', cfg, async (req, reply) => {
    const acct = await giftAccount(req, reply);
    if (!acct) return;
    await pro.giftEndSeen(acct).catch(() => false);
    return { ok: true };
  });

  // An export with Pro items left the site while the gift ran: remembered for the end card.
  app.post('/api/pro/gift/used', deps.useConfig ?? cfg, async (req, reply) => {
    const acct = await giftAccount(req, reply);
    if (!acct) return;
    await pro.giftUsed(acct, (req.body as { items?: unknown } | null)?.items).catch(() => false);
    return { ok: true };
  });

  // "Tell me when Pro opens": any account, now that /pro is open to everyone
  // as a coming-soon page (8 Nov 2026). One row per account.
  app.post('/api/pro/notify', cfg, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    const added = await pro.repo.notify(user.id);
    return { ok: true, already: !added };
  });

  // ------------------------------------------------------ price question ---

  /**
   * The caller's own answer, to show it again: the account's when signed
   * in, otherwise (or when the account has none yet) the browser's, named by
   * the key in x-price-device.
   */
  let counted = { n: 0, at: -Infinity };
  const answeredCount = async (): Promise<number> => {
    const now = Date.now();
    if (now - counted.at > COUNT_FOR_MS) counted = { n: await pro.repo.priceCount().catch(() => counted.n), at: now };
    return counted.n;
  };

  app.get('/api/pro/price', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = await deps.userOf(req).catch(() => null);
    const device = deviceKey(req.headers['x-price-device']);
    let a = userId ? await pro.repo.priceAnswer(accountVoter(userId)) : null;
    if (!a && device) a = await pro.repo.priceAnswer(deviceVoter(device));
    return { answer: ownAnswer(a), answered: await answeredCount() };
  });

  const guests = new GuestPace();
  app.post('/api/pro/price', deps.priceConfig ?? {}, async (req, reply) => {
    const read = readPriceInput(req.body);
    if (!read.ok) return reply.code(400).send({ error: read.error });
    const { amount, currency, lang, comment, device, wontPay, source } = read.input;
    const userId = await deps.userOf(req).catch(() => null);
    if (!userId && !device) return reply.code(400).send({ error: 'a browser key is required when signed out' });
    const voter = userId ? accountVoter(userId) : deviceVoter(device!);
    if (!userId && !(await pro.repo.priceAnswer(voter)) && !guests.take(req.ip, pro.now())) {
      return reply.code(429).send({ error: 'too many answers from here today', reason: 'pace' });
    }
    const r = await pro.repo.putPriceAnswer({
      voter, userId, amount, currency, lang, comment, wontPay, source,
      // Answered signed out in this browser, now signed in: one answer, the account's.
      absorb: userId && device ? deviceVoter(device) : null,
      max: PRICE_ANSWERS_MAX,
    });
    if (r === 'full') return reply.code(409).send({ error: 'the question has all the answers it needs', reason: 'full' });
    // The thank-you the question promises: a signed-in fan who answers hears
    // first when Pro opens (the same list as "Tell me when Pro opens").
    const told = userId ? (await pro.repo.notify(userId).catch(() => false), true) : false;
    return { ok: true, answer: { amount, currency, comment, wontPay }, told };
  });

  // ---------------------------------------------------------------- admin ---

  const DAY_MS = 24 * 3600_000;
  /** A purchase counts as "after the gift" when it is paid within this long of the gift's end. */
  const AFTER_GIFT_DAYS = 7;

  /**
   * Gifts that were started, for /admin: by themselves or from the old Accept
   * button, how many are running and how many have ended, and of each kind how
   * many of their holders bought Pro while it ran or within 7 days of its end
   * (real, paid orders; a refunded one is not counted).
   */
  const giftCounts = async () => {
    const zero = () => ({ started: 0, running: 0, ended: 0, boughtDuring: 0, boughtAfter: 0 });
    const out = { auto: zero(), accept: zero(), afterDays: AFTER_GIFT_DAYS };
    const rows = await pro.repo.giftRows(5000).catch(() => []);
    if (!rows.length) return out;
    const paid = deps.paidOrders ? await deps.paidOrders(new Date(0)).catch(() => []) : [];
    const firstPaid = new Map<string, number[]>();
    for (const o of paid) {
      if (!o.userId || o.refunded) continue;
      firstPaid.set(o.userId, [...(firstPaid.get(o.userId) ?? []), Date.parse(o.paidAt)]);
    }
    const now = pro.now().getTime();
    for (const g of rows) {
      const c = g.auto ? out.auto : out.accept;
      const start = Date.parse(g.startedAt);
      const end = g.endsAt ? Date.parse(g.endsAt) : start;
      c.started++;
      if (end > now) c.running++; else c.ended++;
      const times = firstPaid.get(g.userId) ?? [];
      if (times.some((t) => t >= start && t < end)) c.boughtDuring++;
      else if (times.some((t) => t >= end && t <= end + AFTER_GIFT_DAYS * DAY_MS)) c.boughtAfter++;
    }
    return out;
  };

  /**
   * The Pro funnel: saw a Pro offer, pressed Get Pro, paid; by where the offer
   * was seen and by what was bought. "Saw" and "pressed" are the consent-gated
   * funnel events (sessions that allowed counting); "paid" is the orders
   * themselves, each under the place its checkout named, or "not said" when
   * the browser did not say (no consent, or an order made before this).
   */
  app.get('/api/admin/pro/funnel', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    const days = Math.max(1, Math.min(365, Number((req.query as { days?: string }).days) || 30));
    const names = OFFER_PLACES.flatMap((p) => [`pro_offer_${p}`, `pro_get_${p}`]);
    const extra = ['pro_checkout', 'pro_paid', 'monthly_bought', 'match_bought', 'gift_auto', 'gift_welcome', 'gift_end_seen', 'bought_after_gift', 'pro_preview_post', 'signup_offer_post', 'signup_post'];
    const steps = deps.funnel ? await deps.funnel([...names, ...extra], days).catch(() => []) : [];
    const n = (name: string): number => steps.find((s) => s.name === name)?.sessions ?? 0;
    const since = new Date(pro.now().getTime() - days * DAY_MS);
    const paid = (deps.paidOrders ? await deps.paidOrders(since).catch(() => []) : []).filter((o) => !o.refunded);
    const paidAt = (place: string | null, product: 'monthly' | 'match'): number => paid.filter((o) => (o.src ?? null) === place && o.product === product).length;
    return {
      days,
      places: OFFER_PLACES.map((p) => ({ place: p, saw: n(`pro_offer_${p}`), pressed: n(`pro_get_${p}`), monthly: paidAt(p, 'monthly'), match: paidAt(p, 'match') })),
      notSaid: { monthly: paidAt(null, 'monthly'), match: paidAt(null, 'match') },
      paid: { monthly: paid.filter((o) => o.product === 'monthly').length, match: paid.filter((o) => o.product === 'match').length, revenue: paid.reduce((s, o) => s + o.amount, 0) / 100 },
      steps: Object.fromEntries(extra.map((e) => [e, n(e)])),
      counted: !!deps.funnel,
    };
  });

  app.get('/api/admin/pro', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const q = req.query as { username?: string };
    let account: unknown = null;
    if (typeof q.username === 'string' && USERNAME.test(q.username)) {
      const u = await deps.getUserByName(q.username).catch(() => null);
      if (u) {
        const passes = await pro.repo.allPasses(u.id);
        account = {
          username: u.username,
          emailVerified: !!u.emailVerifiedAt,
          live: pro.live(u.username),
          plan: (await pro.plan(u.id)).plan,
          gift: await pro.repo.gift(u.id),
          passes: passes.map((p) => ({ id: p.id, plan: p.plan, source: p.source, startsAt: p.startsAt, endsAt: p.endsAt, revokedAt: p.revokedAt })),
        };
      }
    }
    return {
      mode: proMode(),
      previewUsers: previewUsers().size,
      stats: await pro.repo.stats(pro.now()),
      throwawayList: disposableListStatus(),
      // The settings of 22 Nov 2026, as the server reads them: nothing secret is among them.
      settings: {
        autoGift: autoGiftOn(), giftMails: giftMailsOn(), postOffers: postOffersOn(),
        monthlyPrice: monthlyPriceSetting() === null ? null : monthlyPriceSetting()! / 100, monthlyPriceInvalid: monthlyPriceInvalid(),
        match: ((m) => ({ asked: m.on, price: m.halalas / 100, days: m.days }))(matchPass()),
      },
      giftsStarted: await giftCounts(),
      cutoutConfigured: deps.cutoutConfigured(),
      paymentsOpen: deps.paymentsPublic?.() ?? false,
      account,
    };
  });

  /**
   * Everyone who holds Pro or has held it: every pass, the newest first, with
   * whose it is, how it was got (bought, given by hand, the 7-day gift) and
   * how much of Pro it has used. Usernames only, never an address. The page
   * matches a bought pass to its order (/api/admin/pro/orders, passId).
   */
  app.get('/api/admin/pro/members', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    const rows = await pro.repo.members(ADMIN_MEMBER_ROWS);
    return {
      now: pro.now().toISOString(),
      max: ADMIN_MEMBER_ROWS,
      giftDays: OFFER.gift.days,
      passes: rows.map((p) => ({
        id: p.id, username: p.username, plan: p.plan, source: p.source, startsAt: p.startsAt, endsAt: p.endsAt,
        createdAt: p.createdAt, revokedAt: p.revokedAt, givenBy: p.givenBy, used: p.used,
      })),
    };
  });

  /** Every answer to the price question, summed up per currency, and the newest in full. */
  app.get('/api/admin/pro/prices', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    // ?all=1: every answer in full, for the CSV.
    const everything = (req.query as { all?: string }).all === '1';
    const { all, newest } = await pro.repo.priceAnswers(everything ? PRICE_ANSWERS_MAX : ADMIN_PRICE_ROWS);
    return {
      total: all.length,
      max: PRICE_ANSWERS_MAX,
      ...summarizeAll(all),
      bands: PRICE_BANDS,
      rows: newest.map((a) => ({
        at: a.updatedAt, amount: a.amount, currency: a.currency, wontPay: a.wontPay, source: a.source,
        lang: a.lang, username: a.username, comment: a.comment,
      })),
      shown: newest.length,
    };
  });

  /**
   * Give an account Pro by hand: a prize, a supporter group's members, a
   * refund made good, or the owner trying Pro on himself. Days from now; 30
   * (one month of Pro) when none are given. The only plan is "monthly".
   */
  app.post('/api/admin/pro/grant', cfg, async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const b = (req.body ?? {}) as { username?: unknown; plan?: unknown; days?: unknown };
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const plan = typeof b.plan === 'string' ? b.plan : '';
    if (!USERNAME.test(username)) return reply.code(400).send({ error: 'a username is required' });
    // "monthly" is the one plan; an empty plan means it too. The gift is never granted by hand.
    if (plan !== '' && plan !== 'monthly') return reply.code(400).send({ error: 'plan must be monthly' });
    const u = await deps.getUserByName(username).catch(() => null);
    if (!u) return reply.code(404).send({ error: 'no such account' });
    const now = pro.now();
    let days: number = OFFER.monthly.days;
    if (!(b.days === undefined || b.days === null || b.days === '')) {
      days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 400) return reply.code(400).send({ error: 'days must be a whole number from 1 to 400' });
    }
    const ends = new Date(now.getTime() + days * 24 * 3600_000);
    const actor = await deps.userOf(req).catch(() => null);
    const pass = await pro.repo.grantPass({ userId: u.id, plan: 'monthly', startsAt: now, endsAt: ends, source: 'admin', createdBy: actor });
    return { ok: true, pass: { id: pass.id, plan: pass.plan, endsAt: pass.endsAt } };
  });

  app.post('/api/admin/pro/revoke', cfg, async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const b = (req.body ?? {}) as { passId?: unknown };
    const id = typeof b.passId === 'string' ? b.passId : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: 'a pass id is required' });
    const ok = await pro.repo.revokePass(id, pro.now());
    return ok ? { ok: true } : reply.code(404).send({ error: 'no such active pass' });
  });
}
