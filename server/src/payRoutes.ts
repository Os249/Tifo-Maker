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
 * Refunds, told and asked for (19 Nov 2026):
 *
 *   GET  /api/pro/purchases           signed in: what this account bought, and what can still be refunded
 *   POST /api/pro/purchases/refund    signed in: ask for a refund of one's own order
 *   POST /api/pro/purchases/receipt   signed in: send an order's receipt again
 *   POST /api/pro/refund-notice/seen  signed in: the one-time refund notice was shown
 *   GET  /api/admin/pro/refund-requests   admin: the queue
 *   POST /api/admin/pro/refund-request    admin: approve (refund) or decline (with a reason)
 *
 * An account that never had an order gets 404 from the first while payments
 * are off, as from a route that does not exist. Asking for a refund of an
 * order one already paid for works whatever the switches say, like stopping
 * a renewal: the promise was made when it was sold.
 *
 * Turning auto-renew OFF works whatever the switches say, for as long as a
 * subscription exists: nobody is ever left unable to stop a charge.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REFUND_DAYS, type PaymentService, type Purchase } from './payments';
import { ORDER_SRC, type ProOrder, type ProSubscription } from './payRepo';
import { asProduct } from './proPlan';
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
  why: o.status === 'failed' ? o.fail : null, kept: o.keep, renews, product: o.product,
  // The founders bonus this order's pass was given, when it was (proLaunch.ts).
  ...(o.status === 'paid' && o.bonusDays > 0 ? { bonusDays: o.bonusDays, days: o.days } : {}),
});

/**
 * A purchase as its owner sees it on the account page: what, when, how much,
 * how it was paid (the method and the card's scheme; never a number), where
 * it stands, and whether a refund can still be asked for. 'review' (paid at
 * an amount that does not match, a person is looking) shows as 'checking'.
 */
const purchaseView = (p: Purchase) => ({
  id: p.order.id,
  reference: p.order.invoiceId ?? p.order.paymentId ?? p.order.id,
  status: p.order.status === 'review' ? 'checking' : p.order.status,
  amount: p.order.amount / 100,
  days: p.order.days,
  product: p.order.product,
  bonusDays: p.order.bonusDays,
  method: p.order.method,
  brand: p.order.brand,
  test: p.order.testMode,
  renewal: p.order.kind === 'renewal',
  createdAt: p.order.createdAt,
  paidAt: p.order.paidAt,
  endsAt: p.endsAt,
  refundedAt: p.order.refundedAt,
  refunded: p.order.refunded / 100,
  refund: p.refund,
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
    const body = (req.body ?? {}) as { lang?: unknown; product?: unknown; src?: unknown };
    const lang = body.lang === 'ar' ? 'ar' : 'en';
    // Which of the things on sale: the month when nothing is said. The price is the server's.
    if (body.product !== undefined && body.product !== 'monthly' && body.product !== 'match' && body.product !== 'year') return reply.code(400).send({ error: 'product must be monthly, match or year' });
    const r = await pay.checkout(
      { id: user.id, username: user.username, email: user.email, emailVerified: !!user.emailVerifiedAt },
      lang,
      deps.baseOf(req),
      { product: asProduct(body.product), src: typeof body.src === 'string' && ORDER_SRC.test(body.src) ? body.src : null },
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

  // ------------------------------------------------ purchases and refunds ---

  app.get('/api/pro/purchases', deps.hookConfig ?? {}, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const list = await pay.purchases(userId);
    // Nothing to say to an account that never bought anything while payments are off.
    if (!list.length && !pay.on()) return notFound(reply);
    return { refundDays: REFUND_DAYS, orders: list.map(purchaseView) };
  });

  // Ask for a refund. The order must be this account's own, paid, and within
  // the refund days; the server decides all three from its own records.
  app.post('/api/pro/purchases/refund', deps.checkoutConfig ?? {}, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const b = (req.body ?? {}) as { order?: unknown; note?: unknown };
    if (typeof b.order !== 'string' || !UUID.test(b.order)) return reply.code(400).send({ error: 'an order is required' });
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 2000)) return reply.code(400).send({ error: 'the note is too long' });
    const r = await pay.requestRefund(userId, b.order, typeof b.note === 'string' ? b.note : null);
    if (r.ok) return { ok: true, state: r.state };
    // Someone else's order is no order at all.
    const status = r.reason === 'none' ? 404 : 409;
    return reply.code(status).send({ error: 'a refund cannot be requested for this order', reason: r.reason });
  });

  app.post('/api/pro/purchases/receipt', deps.checkoutConfig ?? {}, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const id = (req.body as { order?: unknown } | null)?.order;
    if (typeof id !== 'string' || !UUID.test(id)) return reply.code(400).send({ error: 'an order is required' });
    const user = await deps.accountOf(req, userId).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'authentication required' });
    // The receipt goes to the account's address, never to one typed here.
    if (!user.email) return reply.code(409).send({ error: 'this account has no email address', reason: 'no_email' });
    const r = await pay.resendReceipt(userId, id);
    if (r === 'none') return notFound(reply);
    if (r === 'wait') return reply.code(429).send({ error: 'the receipt was sent a moment ago', reason: 'wait' });
    return { ok: true };
  });

  app.post('/api/pro/refund-notice/seen', deps.hookConfig ?? {}, async (req, reply) => {
    const userId = await deps.requireUser(req, reply);
    if (!userId) return;
    const id = (req.body as { order?: unknown } | null)?.order;
    if (typeof id !== 'string' || !UUID.test(id)) return reply.code(400).send({ error: 'an order is required' });
    return { ok: true, seen: await pay.seenRefund(userId, id) };
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
        product: o.product,
        days: o.days,
        src: o.src,
        bonusDays: o.bonusDays,
        // The pass this order bought: /admin's Members tab says "bought for SAR 13.99" from it.
        passId: o.passId,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        refundedAt: o.refundedAt,
        refunded: o.refunded / 100,
        // Whether the fan was emailed about the refund (once; a failed send is tried again for a few days).
        told: o.status === 'refunded' ? o.refundMailAt !== null : null,
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

  app.get('/api/admin/pro/refund-requests', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    const now = Date.now();
    const rows = await pay.refundRequests();
    return {
      auto: pay.status().autoRefund,
      refundDays: REFUND_DAYS,
      requests: await Promise.all(rows.map(async (q) => ({
        id: q.id, username: q.username, status: q.status, note: q.note, askedAt: q.createdAt, answeredAt: q.decidedAt,
        declineReason: q.declineReason, auto: q.auto,
        // Counted when they asked, and as it stands now: a fan may use Pro while a request waits.
        usedThen: q.used,
        usedNow: q.status === 'pending' && q.userId && q.order?.passId ? await pay.pro.repo.passUse(q.userId, q.order.passId).catch(() => null) : null,
        order: q.order
          ? {
            id: q.order.id, amount: q.order.amount / 100, status: q.order.status, test: q.order.testMode, method: q.order.method, brand: q.order.brand,
            kind: q.order.kind, paidAt: q.order.paidAt,
            inTime: !!q.order.paidAt && Date.parse(q.createdAt) - Date.parse(q.order.paidAt) <= REFUND_DAYS * 24 * 3600_000,
            daysSincePaid: q.order.paidAt ? Math.floor((now - Date.parse(q.order.paidAt)) / (24 * 3600_000)) : null,
          }
          : null,
      }))),
    };
  });

  app.post('/api/admin/pro/refund-request', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const b = (req.body ?? {}) as { id?: unknown; action?: unknown; reason?: unknown };
    if (typeof b.id !== 'string' || !UUID.test(b.id)) return reply.code(400).send({ error: 'a request id is required' });
    if (b.action !== 'approve' && b.action !== 'decline') return reply.code(400).send({ error: 'approve or decline' });
    const r = await pay.decideRequest(b.id, b.action, typeof b.reason === 'string' ? b.reason : null);
    if (r.ok) return { ok: true, status: r.status };
    const status = r.reason === 'none' ? 404 : r.reason === 'reason' ? 400 : r.reason === 'failed' ? 502 : 409;
    return reply.code(status).send({ error: b.action === 'approve' ? 'not refunded' : 'not declined', reason: r.reason });
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
