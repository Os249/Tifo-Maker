/**
 * The routes for buying Pro (payments.ts has the rules and the switches).
 * While payments are off, every one of them answers 404, exactly as a route
 * that does not exist, so nothing about them shows on the live site.
 *
 *   POST /api/pro/pay/checkout        signed in: an invoice to pay, or why not
 *   GET  /api/pro/pay/order/:id       signed in, the order's owner: is it paid?
 *   POST /api/pro/pay/invoice         Moyasar: an invoice was paid (a nudge)
 *   POST /api/pro/pay/webhook         Moyasar: an event (checked by its secret)
 *   GET  /api/admin/pro/orders        admin: the orders, newest first
 *   POST /api/admin/pro/refund        admin: refund an order in full
 *
 * Payments v2 (the payment form, auto-renew; each off until its variable is set):
 *
 *   POST /api/pro/pay/keep            signed in: "Keep Pro on" ticked or unticked on an open order
 *   POST /api/pro/pay/attempt         signed in: the form sent a payment for an order
 *   GET  /api/pro/renew               signed in: this account's auto-renew, if any
 *   POST /api/pro/renew/cancel        signed in: turn auto-renew off
 *   POST /api/pro/renew/stop          the email's one-click link: turn auto-renew off
 *   GET  /api/admin/pro/subscriptions admin: who renews, who is failing, who stopped
 *   POST /api/admin/pro/subscription/cancel   admin: switch one off
 *
 * Turning auto-renew OFF works whatever the switches say, for as long as a
 * subscription exists: nobody is ever left unable to stop a charge.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REFUND_DAYS, type PaymentService } from './payments';
import type { ProOrder, ProSubscription } from './payRepo';
import type { UserRow } from './repo';

export interface PayRouteDeps {
  pay: PaymentService;
  requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
  accountOf: (req: FastifyRequest, userId: string) => Promise<UserRow | null>;
  adminAccess: (req: FastifyRequest) => Promise<boolean>;
  /** The site's own origin for the URLs given to Moyasar (PUBLIC_URL, or a Host we know). */
  baseOf: (req: FastifyRequest) => string;
  /** The buyer's pace: a few presses a minute. */
  checkoutConfig?: object;
  /** Moyasar's calls and the return page's checks. */
  hookConfig?: object;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An order as its owner sees it. `why` is the kind of failure, for the page's
 * words; `kept` whether "Keep Pro on" was asked with it and `renews` whether
 * that took (a method that cannot renew leaves a one-time pass).
 */
const ownView = (o: ProOrder, endsAt: string | null, renews: boolean) => ({
  id: o.id, status: o.status === 'review' ? 'pending' : o.status, endsAt,
  why: o.status === 'failed' ? o.fail : null, kept: o.keep, renews,
});

/** Auto-renew as its owner sees it: never the token. */
const subView = (s: ProSubscription) => ({
  status: s.status,
  amount: s.amount / 100,
  days: s.days,
  nextAt: s.status === 'active' || s.status === 'failing' ? s.nextChargeAt : null,
  method: s.method,
  brand: s.brand,
  lastFour: s.lastFour,
  since: s.optedInAt,
  stoppedAt: s.cancelledAt,
});

export function registerPayRoutes(app: FastifyInstance, deps: PayRouteDeps): void {
  const { pay } = deps;
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });

  app.post('/api/pro/pay/checkout', deps.checkoutConfig ?? {}, async (req, reply) => {
    if (!pay.on()) return notFound(reply);
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    if (!pay.openFor(user.username)) return notFound(reply);
    const lang = (req.body as { lang?: unknown } | null)?.lang === 'ar' ? 'ar' : 'en';
    const r = await pay.checkout(
      { id: user.id, username: user.username, email: user.email, emailVerified: !!user.emailVerifiedAt },
      lang,
      deps.baseOf(req),
    );
    if (r.ok) return 'url' in r ? { ok: true, order: r.orderId, url: r.url } : { ok: true, order: r.orderId, form: r.form };
    const status = r.reason === 'off' ? 404 : r.reason === 'verify' ? 403 : r.reason === 'held' ? 409 : r.reason === 'busy' ? 429 : 503;
    return reply.code(status).send({ error: 'Pro cannot be bought right now', reason: r.reason, endsAt: r.endsAt });
  });

  app.get('/api/pro/pay/order/:id', deps.hookConfig ?? {}, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    if (!pay.on()) return notFound(reply);
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const id = (req.params as { id?: string }).id ?? '';
    if (!UUID.test(id)) return notFound(reply);
    const o = await pay.orderFor(userId, id);
    // Someone else's order is no order at all.
    if (!o) return notFound(reply);
    const pass = o.passId ? (await pay.pro.repo.allPasses(userId)).find((p) => p.id === o.passId) ?? null : null;
    const sub = o.keep && o.status === 'paid' ? await pay.renewalFor(userId).catch(() => null) : null;
    return ownView(o, pass && !pass.revokedAt ? pass.endsAt : null, sub?.status === 'active');
  });

  // "Keep Pro on": the box on the form, ticked or unticked. Nothing asks for
  // auto-renew but this, from the order's own account, while the order is open.
  app.post('/api/pro/pay/keep', deps.hookConfig ?? {}, async (req, reply) => {
    if (!pay.on()) return notFound(reply);
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const b = (req.body ?? {}) as { order?: unknown; keep?: unknown };
    if (typeof b.order !== 'string' || !UUID.test(b.order) || typeof b.keep !== 'boolean') return reply.code(400).send({ error: 'an order and a choice are required' });
    if (!(await pay.setKeep(userId, b.order, b.keep))) return reply.code(409).send({ error: 'not changed' });
    return { ok: true, keep: b.keep };
  });

  // The form sent a payment for this order (its on_completed). The browser's
  // word, and it gives nothing: the order is simply not offered again.
  app.post('/api/pro/pay/attempt', deps.hookConfig ?? {}, async (req, reply) => {
    if (!pay.on()) return notFound(reply);
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const id = (req.body as { order?: unknown } | null)?.order;
    if (typeof id !== 'string' || !UUID.test(id)) return notFound(reply);
    await pay.attempted(userId, id);
    return { ok: true };
  });

  // ----------------------------------------------------------- auto-renew ---

  app.get('/api/pro/renew', deps.hookConfig ?? {}, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const sub = await pay.renewalFor(userId);
    // Nothing to say to an account that never had it while it is switched off.
    if (!sub && !pay.renewOn()) return notFound(reply);
    const renewing = !!sub && (sub.status === 'active' || sub.status === 'failing');
    return { offered: pay.renewOn(), paused: renewing && !pay.renewOn(), sub: sub ? subView(sub) : null };
  });

  app.post('/api/pro/renew/cancel', deps.checkoutConfig ?? {}, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    await pay.stopRenewing(userId, 'account page');
    const sub = await pay.renewalFor(userId);
    return { ok: true, sub: sub ? subView(sub) : null };
  });

  // The link in the reminder: no sign-in, because the link can only turn
  // renewal off. A POST from the page it opens, never the GET itself, so a
  // mail scanner that follows links does not cancel anything.
  app.post('/api/pro/renew/stop', deps.checkoutConfig ?? {}, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const t = (req.body as { t?: unknown } | null)?.t;
    const r = typeof t === 'string' ? await pay.cancelByLink(t) : { ok: false as const };
    if (!r.ok) return notFound(reply);
    return { ok: true, endsAt: r.endsAt };
  });

  // Moyasar's POST when an invoice is paid. Nothing in it is believed: only
  // the invoice's id is read, and the invoice is fetched from Moyasar.
  app.post('/api/pro/pay/invoice', deps.hookConfig ?? {}, async (req, reply) => {
    if (!pay.on()) return notFound(reply);
    await pay.invoiceNudge(req.body).catch((e) => console.error(`[tifo] payments: invoice callback failed (${(e as Error).message})`));
    return { ok: true };
  });

  app.post('/api/pro/pay/webhook', deps.hookConfig ?? {}, async (req, reply) => {
    const r = await pay.webhook(req.body).catch((e) => {
      console.error(`[tifo] payments: webhook failed (${(e as Error).message})`);
      // Moyasar tries again on anything but a 2xx: let it.
      return 'error' as const;
    });
    if (r === 'closed') return notFound(reply);
    if (r === 'refused') return reply.code(401).send({ error: 'unauthorized' });
    if (r === 'error') return reply.code(500).send({ error: 'try again' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- admin ---

  app.get('/api/admin/pro/orders', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    const now = Date.now();
    const rows = await pay.repo.list(200);
    const orders = await Promise.all(
      rows.map(async (o) => ({
        id: o.id,
        username: o.username,
        amount: o.amount / 100,
        currency: o.currency,
        status: o.status,
        test: o.testMode,
        method: o.method,
        invoiceId: o.invoiceId,
        note: o.note,
        kind: o.kind,
        keep: o.keep,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        refundedAt: o.refundedAt,
        refunded: o.refunded / 100,
        // How much of Pro's allowances the bought pass has used: 0 is "not used" for the refund promise.
        used: o.userId && o.passId ? await pay.pro.repo.passUse(o.userId, o.passId).catch(() => null) : null,
        refundable: o.status === 'paid' && !!o.paidAt && now - Date.parse(o.paidAt) <= REFUND_DAYS * 24 * 3600_000,
      })),
    );
    // The webhook's verification code, while Moyasar still takes it (30 minutes).
    const v = pay.verification && now - Date.parse(pay.verification.at) < 30 * 60_000 ? pay.verification : null;
    return { status: pay.status(), stats: await pay.repo.stats(), refundDays: REFUND_DAYS, verification: v, orders };
  });

  app.post('/api/admin/pro/refund', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const b = (req.body ?? {}) as { orderId?: unknown; late?: unknown };
    if (typeof b.orderId !== 'string' || !UUID.test(b.orderId)) return reply.code(400).send({ error: 'an order id is required' });
    const r = await pay.refund(b.orderId, b.late === true);
    if (r.ok) return { ok: true, status: r.order.status };
    const status = r.reason === 'none' ? 404 : r.reason === 'off' ? 409 : r.reason === 'failed' ? 502 : 409;
    return reply.code(status).send({ error: 'not refunded', reason: r.reason });
  });

  app.get('/api/admin/pro/subscriptions', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    const { rows, trash } = await pay.subscriptions();
    return {
      on: pay.renewOn(),
      // Saved cards still waiting to be deleted at Moyasar (it could not be reached yet).
      tokensToDelete: trash,
      subscriptions: rows.map((x) => ({
        id: x.id, username: x.username, status: x.status, amount: x.amount / 100, days: x.days, test: x.testMode,
        method: x.method, brand: x.brand, lastFour: x.lastFour, cycle: x.cycle, since: x.optedInAt,
        nextAt: x.nextChargeAt, remindedAt: x.remindedFor && x.remindedFor === x.nextChargeAt ? x.remindedAt : null,
        attempts: x.attempts, lastError: x.lastError, stoppedAt: x.cancelledAt, reason: x.endReason,
      })),
    };
  });

  app.post('/api/admin/pro/subscription/cancel', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const id = (req.body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !UUID.test(id)) return reply.code(400).send({ error: 'a subscription id is required' });
    if (!(await pay.adminCancel(id))) return reply.code(409).send({ error: 'it was not renewing' });
    return { ok: true };
  });

}
