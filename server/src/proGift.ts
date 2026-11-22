/**
 * The automatic gift's emails (22 Nov 2026): the job that sends them.
 *
 * The gift itself is pro.ts (giftFor starts it); the words are proGiftMail.ts.
 * This file only decides who is owed which email now, and sends each one at
 * most once.
 *
 * NOTHING is sent unless PRO_GIFT_MAILS=on AND PRO_AUTO_GIFT=on (proPlan.ts
 * giftMailsOn), and only for gifts that started by themselves: the old Accept
 * gift never had emails and gets none.
 *
 *   start   a gift that started in the last day and is still running
 *   soon    a gift with about a day left (26 hours down to 6)
 *   end     a gift that ran out in the last two days
 *
 * Never twice: a gift's email is claimed by a single UPDATE before the send
 * (proRepo.claimGiftMail) and given back only when the mail service refused
 * the message; then the next run tries again, for as long as the email is
 * still due. An email that is not owed is claimed and not sent: the address
 * went or stopped being verified, the fan pressed "stop these emails", or
 * (for soon and end) the fan has bought Pro meanwhile and has nothing ending.
 *
 * Paced like the founders email: a gap between messages, a batch per run and
 * a day's ceiling on the shared send budget, so verification and receipt
 * emails keep their share of the mail service's day.
 */
import type { EmailMessage } from './email';
import { giftMailsOn } from './proPlan';
import { GIFT_MAIL_KINDS, type GiftDue, type GiftMailKind, type ProRepository } from './proRepo';

/** Gift emails per run of the job, over the three kinds. */
const MAIL_BATCH = 12;
/** Between two gift emails (Resend takes 2 requests a second). */
const MAIL_GAP_MS = 700;
/** The day's ceiling for gift emails on the shared send budget (Resend's free plan is 100 a day for everything). */
export const GIFT_MAILS_PER_DAY = 40;

export interface GiftMailRun {
  sent: number;
  failed: number;
  skipped: number;
  /** Why nothing was sent, when nothing could be: 'off', 'mail', 'budget'. */
  held: 'off' | 'mail' | 'budget' | null;
}

export interface GiftMailOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Send one email. Throws when the mail service refused it. Absent: nothing is ever sent. */
  send?: (msg: EmailMessage) => Promise<void>;
  /** Whether email is really being delivered (a console sender delivers to nobody). */
  canSend?: () => boolean;
  takeBudget?: () => boolean;
  giveBudget?: () => void;
  /** The pause between two sends (the tests pass 0). */
  gapMs?: number;
  /** The account's address as it stands now. Null: the account is gone. */
  accountOf: (userId: string) => Promise<{ email: string | null; emailVerified: boolean } | null>;
  /** Whether the account holds Pro it paid for (or was given by hand) right now: it then has nothing ending. */
  holdsPro: (userId: string) => Promise<boolean>;
  /** Write the email. */
  compose: (kind: GiftMailKind, gift: GiftDue, to: string) => EmailMessage;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GiftMailService {
  private readonly env: NodeJS.ProcessEnv;
  private busy = false;

  constructor(private readonly repo: ProRepository, private readonly opts: GiftMailOptions) {
    this.env = opts.env ?? process.env;
  }

  on(): boolean {
    return giftMailsOn(this.env);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** "Stop these emails", from the link in a gift email. True when the link is one of ours. */
  async stopMail(token: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return false;
    const userId = await this.repo.giftByStopToken(token);
    if (!userId) return false;
    await this.repo.stopMail(userId, this.now(), 'gift email link');
    return true;
  }

  /** The job. Does nothing at all while the emails are switched off. */
  async tick(): Promise<GiftMailRun> {
    const out: GiftMailRun = { sent: 0, failed: 0, skipped: 0, held: null };
    if (this.busy) return out;
    if (!this.on()) {
      out.held = 'off';
      return out;
    }
    const send = this.opts.send;
    if (!send || !(this.opts.canSend?.() ?? true)) {
      out.held = 'mail';
      return out;
    }
    this.busy = true;
    try {
      let left = MAIL_BATCH;
      for (const kind of GIFT_MAIL_KINDS) {
        if (left <= 0 || out.held) break;
        for (const g of await this.repo.giftsDue(kind, this.now(), left)) {
          if (left <= 0) break;
          const now = this.now();
          const skip = async (): Promise<void> => {
            // Not owed: taken so it is never looked at again, and not sent.
            if (await this.repo.claimGiftMail(g.userId, kind, now)) out.skipped++;
          };
          const acct = await this.opts.accountOf(g.userId).catch(() => null);
          if (!acct?.email || !acct.emailVerified) {
            await skip();
            continue;
          }
          if (await this.repo.mailStopped(g.userId)) {
            await skip();
            continue;
          }
          if (kind !== 'start' && (await this.opts.holdsPro(g.userId).catch(() => false))) {
            await skip();
            continue;
          }
          if (this.opts.takeBudget && !this.opts.takeBudget()) {
            out.held = 'budget';
            break;
          }
          // One caller gets the row; whoever does not, did not send.
          if (!(await this.repo.claimGiftMail(g.userId, kind, now))) {
            this.opts.giveBudget?.();
            continue;
          }
          left--;
          try {
            await send(this.opts.compose(kind, g, acct.email));
            out.sent++;
          } catch (e) {
            // The mail service said no: nothing went out, so the email is owed again while it is still due.
            this.opts.giveBudget?.();
            await this.repo.unclaimGiftMail(g.userId, kind);
            out.failed++;
            console.error(`[tifo] gift: an email was refused and will be tried again (${String((e as Error)?.message ?? e).slice(0, 120)})`);
          }
          const gap = this.opts.gapMs ?? MAIL_GAP_MS;
          if (gap > 0) await pause(gap);
        }
      }
      if (out.sent || out.failed || out.skipped) console.log(`[tifo] gift: emails: ${out.sent} sent, ${out.failed} failed, ${out.skipped} skipped`);
      return out;
    } finally {
      this.busy = false;
    }
  }
}
