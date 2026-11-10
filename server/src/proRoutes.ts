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
import { ALLOWANCE_KINDS, FREE_WINDOWS, OFFER, PLAN_WINDOWS, proMode, previewUsers, type AllowanceKind, type Window } from './proPlan';
import { disposableListStatus, type ProAccount, type ProService } from './pro';
import { GuestPace, PRICE_ANSWERS_MAX, PRICE_BANDS, accountVoter, deviceKey, deviceVoter, readPriceInput, summarizeAll } from './proPrice';
import type { PriceAnswer } from './proRepo';
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
}

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

/** The parts of the offer the Pro page shows: Free against Pro, one price. */
function publicOffer() {
  return {
    limits: { free: limitsOf(FREE_WINDOWS), pro: limitsOf(PLAN_WINDOWS.monthly) },
    currency: OFFER.currency,
    monthly: { price: OFFER.monthly.price, days: OFFER.monthly.days },
    gift: { days: OFFER.gift.days },
    paymentsOpen: OFFER.paymentsOpen,
  };
}

const USERNAME = /^[A-Za-z0-9_.-]{1,32}$/;

export function registerProRoutes(app: FastifyInstance, deps: ProRouteDeps): void {
  const { pro } = deps;
  const cfg = deps.routeConfig ?? {};

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
      return open ? { live: true, signedIn: false, offer: publicOffer(), soon: soonOffer() } : { live: false, signedIn: false, soon: soonOffer() };
    }
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return { live: false, signedIn: true, soon: soonOffer() };
    if (!pro.live(user.username)) return { live: false, signedIn: true, soon: soonOffer(), notified: await pro.repo.notified(user.id) };
    const acct = acctOf(user);
    const [holding, gift, notified] = await Promise.all([
      pro.plan(user.id),
      pro.giftFor(acct),
      pro.repo.notified(user.id),
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
      offer: publicOffer(),
      soon: soonOffer(),
      now: pro.now().toISOString(),
    };
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
      cutoutConfigured: deps.cutoutConfigured(),
      paymentsOpen: OFFER.paymentsOpen,
      account,
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
