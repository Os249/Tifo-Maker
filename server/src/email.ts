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

/**
 * What has actually happened to the mail.
 *
 * This exists because a verification email that never arrives produced no
 * signal anywhere in the product: `sendVerifyEmail` caught every error, the API
 * answered 201/202 regardless, and the UI said "check your inbox". The only
 * trace was one line in the server log. Someone reported email verification
 * "stopped working" with nothing to go on but the time of day, and there was no
 * way to tell a refused API key from an exhausted quota from an unverified
 * sending domain without guessing.
 */
export interface EmailHealth {
  /** 'resend' when a key is configured, 'console' when nothing is. */
  provider: 'resend' | 'console';
  /** False means every message is being written to the log and delivered to nobody. */
  delivering: boolean;
  from: string;
  sent: number;
  failed: number;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const health: EmailHealth = {
  provider: 'console',
  delivering: false,
  from: '',
  sent: 0,
  failed: 0,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
};

/** A snapshot for the admin dashboard. Copied, so no caller can edit it. */
export function emailHealth(): EmailHealth {
  return { ...health };
}

/**
 * Counts every outcome and keeps the last failure's text.
 *
 * Wrapping rather than editing each sender keeps the providers ignorant of
 * bookkeeping, and means a provider added later is measured for free.
 */
class RecordingSender implements EmailSender {
  constructor(private readonly inner: EmailSender) {}

  async send(msg: EmailMessage): Promise<void> {
    try {
      await this.inner.send(msg);
      health.sent++;
      health.lastSentAt = new Date().toISOString();
    } catch (err) {
      health.failed++;
      health.lastError = String((err as Error)?.message ?? err).slice(0, 400);
      health.lastErrorAt = new Date().toISOString();
      throw err;
    }
  }
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
  health.from = from;
  health.provider = key ? 'resend' : 'console';
  health.delivering = !!key;
  return new RecordingSender(key ? new ResendEmailSender(key, from) : new ConsoleEmailSender());
}
