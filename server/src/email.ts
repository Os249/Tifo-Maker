/**
 * Provider-agnostic transactional email. The rest of the server depends only on
 * the EmailSender interface, so swapping providers (Resend ⇄ Postmark ⇄ SES) is a
 * one-class change with no call-site edits.
 *
 * Default provider: Resend (set RESEND_API_KEY + EMAIL_FROM). With no key, a
 * console sender is used so local/dev never breaks — it just logs the message
 * (including the verification/reset link) instead of sending it.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/** Dev/test fallback: logs instead of sending. Never throws. */
export class ConsoleEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[email:dev] to=${msg.to} | ${msg.subject}\n${msg.text ?? msg.html}`);
  }
}

/** Resend (https://resend.com) over its REST API — no SDK dependency. */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`resend send failed: ${res.status} ${body.slice(0, 300)}`);
    }
  }
}

/**
 * Pick a sender from the environment. Default is Resend when RESEND_API_KEY is
 * set; otherwise the console sender (so the app runs without email configured).
 * EMAIL_PROVIDER can force a provider later (e.g. 'postmark') as we add adapters.
 */
export function createEmailSender(): EmailSender {
  const from = process.env.EMAIL_FROM ?? 'TifoMaker <no-reply@tifomaker.org>';
  const key = process.env.RESEND_API_KEY;
  if (key) return new ResendEmailSender(key, from);
  return new ConsoleEmailSender();
}
