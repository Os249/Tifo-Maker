/**
 * The routes of Pro's launch (proLaunch.ts has the rules):
 *
 *   POST /api/pro/mail/stop             the founders email's "stop these emails" link, and the
 *                                       mail client's one-click unsubscribe: no sign-in, because
 *                                       the link can only turn such emails off
 *   GET  /api/admin/pro/launch          admin: the founders list before the launch; after it, how
 *                                       the emails went and who bought in time
 *   GET  /api/admin/pro/launch/email    admin: the founders email as it would go out now (HTML)
 *   POST /api/admin/pro/launch/send     admin: run the send now (the fallback; still once per account)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EmailMessage } from './email';
import type { LaunchService } from './proLaunch';

export interface LaunchRouteDeps {
  launch: LaunchService;
  adminAccess: (req: FastifyRequest) => Promise<boolean>;
  /** The founders email as it would be written now, to a made-up address. `offer` forces it with or without the offer. */
  preview: (offer: boolean | null) => EmailMessage;
  /** Whether email is really being delivered. */
  mailLive: () => boolean;
  stopConfig?: object;
  /** Another kind of email whose link stops the same thing (the gift's emails, proGift.ts): tried when the token is not a founder's. */
  alsoStop?: (token: string) => Promise<boolean>;
}

export function registerLaunchRoutes(app: FastifyInstance, deps: LaunchRouteDeps): void {
  const { launch } = deps;

  // A POST, never the GET itself, so a mail scanner that follows links stops nothing. The token comes in the
  // body (the page it opens) or in the address (a mail client's List-Unsubscribe-Post, which posts a form).
  app.post('/api/pro/mail/stop', deps.stopConfig ?? {}, async (req, reply) => {
    void reply.header('cache-control', 'no-store');
    const b = req.body as { t?: unknown } | null;
    const q = req.query as { t?: unknown };
    const t = typeof b?.t === 'string' ? b.t : typeof q.t === 'string' ? q.t : '';
    if (!(await launch.stopMail(t)) && !(await deps.alsoStop?.(t).catch(() => false))) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.get('/api/admin/pro/launch', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    void reply.header('cache-control', 'no-store');
    const a = await launch.admin();
    const mail = deps.preview(null);
    return { ...a, mailLive: deps.mailLive(), email: { subject: mail.subject, text: mail.text ?? '', html: mail.html } };
  });

  app.get('/api/admin/pro/launch/email', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const q = (req.query as { offer?: string }).offer;
    const mail = deps.preview(q === '1' ? true : q === '0' ? false : null);
    // The email's own HTML, alone on a page that can run nothing and load nothing.
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'")
      .header('x-robots-tag', 'noindex')
      .type('text/html; charset=utf-8')
      .send(mail.html);
  });

  app.post('/api/admin/pro/launch/send', async (req, reply) => {
    if (!(await deps.adminAccess(req))) return reply.code(403).send({ error: 'admin access required' });
    const r = await launch.tick(true);
    return { ok: true, ...r };
  });
}
