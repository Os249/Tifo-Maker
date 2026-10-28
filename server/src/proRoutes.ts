/**
 * The Pro routes: what an account's Pro looks like (/api/pro), accepting the
 * 7-day gift, "tell me when Pro opens", and the admin's grant and revoke.
 *
 * Every answer is computed here from the server's own records. Nothing a
 * browser sends can raise a limit, choose a plan or start a pass: the only
 * inputs are who is asking (their session) and, for the admin, which account
 * and which plan.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ALLOWANCE_KINDS, FREE_WINDOWS, OFFER, PASS_PLANS, PLAN_WINDOWS, SEASON_END, proMode, previewUsers, type AllowanceKind, type PassPlan, type Window } from './proPlan';
import { disposableListStatus, type ProAccount, type ProService } from './pro';
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
}

const acctOf = (u: UserRow): ProAccount => ({ id: u.id, username: u.username, email: u.email, emailVerified: !!u.emailVerifiedAt });

/** Each plan's allowances, as the Pro page's table shows them. */
function limitsOf(w: Record<AllowanceKind, Window[]>): Record<AllowanceKind, { period: string; limit: number }[]> {
  const out = {} as Record<AllowanceKind, { period: string; limit: number }[]>;
  for (const k of ALLOWANCE_KINDS) out[k] = w[k].map((x) => ({ period: x.period, limit: x.limit }));
  return out;
}

/** The parts of the offer the Pro page shows. */
function publicOffer() {
  return {
    limits: { free: limitsOf(FREE_WINDOWS), match: limitsOf(PLAN_WINDOWS.match), season: limitsOf(PLAN_WINDOWS.season) },
    currency: OFFER.currency,
    match: { price: OFFER.match.price, hours: OFFER.match.hours },
    season: { price: OFFER.season.price, endsAt: OFFER.season.endsAt },
    matchCreditDays: OFFER.matchCreditDays,
    gift: { days: OFFER.gift.days },
    giftEndOffer: { price: OFFER.giftEndOffer.price, hours: OFFER.giftEndOffer.hours },
    group: { from: OFFER.group.from },
    paymentsOpen: OFFER.paymentsOpen,
  };
}

const USERNAME = /^[A-Za-z0-9_.-]{1,32}$/;

export function registerProRoutes(app: FastifyInstance, deps: ProRouteDeps): void {
  const { pro } = deps;
  const cfg = deps.routeConfig ?? {};

  /**
   * Pro as the caller sees it. Signed out, only whether Pro is open to
   * everyone and the prices (the Pro page shows them with a sign-in button).
   * Signed in but not covered by PRO_MODE: { live: false } and nothing else,
   * so nobody learns about a preview by reading the API.
   */
  app.get('/api/pro', async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = await deps.userOf(req).catch(() => null);
    if (!userId) {
      const open = proMode() === 'on';
      return open ? { live: true, signedIn: false, offer: publicOffer() } : { live: false, signedIn: false };
    }
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user || !pro.live(user.username)) return { live: false, signedIn: true };
    const acct = acctOf(user);
    const [{ plan, pass }, gift, notified] = await Promise.all([
      pro.plan(user.id),
      pro.giftFor(acct),
      pro.repo.notified(user.id),
    ]);
    const allowances = await pro.allowances(user.id, plan);
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

  app.post('/api/pro/notify', cfg, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user || !pro.live(user.username)) return reply.code(404).send({ error: 'not found' });
    const added = await pro.repo.notify(user.id);
    return { ok: true, already: !added };
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

  /**
   * Give an account a pass by hand: a prize, a supporter group's members, a
   * refund made good, or the owner trying Pro on himself. Days from now; the
   * season plan without days runs to the season's end.
   */
  app.post('/api/admin/pro/grant', cfg, async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const b = (req.body ?? {}) as { username?: unknown; plan?: unknown; days?: unknown };
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const plan = typeof b.plan === 'string' ? b.plan : '';
    if (!USERNAME.test(username)) return reply.code(400).send({ error: 'a username is required' });
    if (!(PASS_PLANS as string[]).includes(plan) || plan === 'gift') {
      return reply.code(400).send({ error: 'plan must be match, season or group' });
    }
    const u = await deps.getUserByName(username).catch(() => null);
    if (!u) return reply.code(404).send({ error: 'no such account' });
    const now = pro.now();
    let ends: Date;
    if (b.days === undefined || b.days === null || b.days === '') {
      ends = plan === 'match' ? new Date(now.getTime() + OFFER.match.hours * 3600_000) : new Date(SEASON_END);
    } else {
      const days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 400) return reply.code(400).send({ error: 'days must be a whole number from 1 to 400' });
      ends = new Date(now.getTime() + days * 24 * 3600_000);
    }
    if (ends.getTime() <= now.getTime()) return reply.code(400).send({ error: 'that pass would already be over' });
    const actor = await deps.userOf(req).catch(() => null);
    const pass = await pro.repo.grantPass({ userId: u.id, plan: plan as PassPlan, startsAt: now, endsAt: ends, source: 'admin', createdBy: actor });
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
