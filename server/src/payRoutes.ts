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
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REFUND_DAYS, paymentsStatus, type PaymentService } from './payments';
import type { ProOrder } from './payRepo';
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

/** An order as its owner sees it. */
const ownView = (o: ProOrder, endsAt: string | null) => ({ id: o.id, status: o.status === 'review' ? 'pending' : o.status, endsAt });

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
    if (r.ok) return { ok: true, order: r.orderId, url: r.url };
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
    return ownView(o, pass && !pass.revokedAt ? pass.endsAt : null);
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
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        refundedAt: o.refundedAt,
        refunded: o.refunded / 100,
        // How much of Pro's allowances the bought pass has used: 0 is "not used" for the refund promise.
        used: o.userId && o.passId ? await pay.pro.repo.passUse(o.userId, o.passId).catch(() => null) : null,
        refundable: o.status === 'paid' && !!o.paidAt && now - Date.parse(o.paidAt) <= REFUND_DAYS * 24 * 3600_000,
      })),
    );
    return { status: paymentsStatus(), stats: await pay.repo.stats(), refundDays: REFUND_DAYS, orders };
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

}
