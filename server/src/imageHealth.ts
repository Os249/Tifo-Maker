/**
 * How the picture providers are doing, and who hears about it when they stop.
 *
 * WHY THIS EXISTS
 *   On 28 Sep 2026 the Pollinations account ran out of credit. Every AI picture
 *   after that came back as HTTP 402, every Super AI design shipped with a bare
 *   stand, and the only sign anywhere was a row per failure on /admin → AI —
 *   which nobody reads until something else sends them there. There was also
 *   no second provider to fall back on, although a Gemini key was sitting in
 *   the environment the whole time.
 *
 * WHAT IT DOES
 *   1. Classifies each provider failure into what a person would do about it:
 *      credit (top up), auth (fix the key), rate (wait / raise quota), down
 *      (outage or timeout), refused (the prompt, not the account), other.
 *   2. Pauses a provider for BREAKER_MS after a credit or auth failure. Those
 *      do not fix themselves between two requests, so asking again only adds
 *      a round trip before the backup is tried. After the pause the provider
 *      is tried again, so a top-up heals on its own within minutes.
 *   3. Emails the operator: once when a provider runs out of credit or its key
 *      is refused, and once when pictures are failing end to end. Each alert
 *      at most once per ALERT_COOLDOWN_MS, ALERT_DAILY_CAP a day in total.
 *   4. Keeps a snapshot for /admin → AI → Pictures.
 *
 * Everything here is in memory and resets on restart. That is deliberate: a
 * deploy is exactly when someone would want to hear again that the credit is
 * still gone, and nothing here is worth a table.
 */
import type { EmailSender } from './email';
import { sanitizeDetail } from './aiFailure';
import { maskEmail } from './soc';

export type PictureProvider = 'pollinations' | 'gemini';

/** What a person would do about a failure. */
export type ImageFailureKind = 'credit' | 'auth' | 'rate' | 'down' | 'refused' | 'other';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const BREAKER_MS_DEFAULT = 10 * MINUTE;
export const ALERT_COOLDOWN_MS = 6 * HOUR;
export const ALERT_DAILY_CAP = 6;
/** End-to-end failures (every provider tried, no picture) that make an alert. */
export const FAILING_THRESHOLD = 4;
export const FAILING_WINDOW_MS = 30 * MINUTE;

export const PROVIDER_LABEL: Record<PictureProvider, string> = {
  pollinations: 'Pollinations',
  gemini: 'Gemini',
};

/**
 * Classify one failed picture request.
 *
 * The status wins when there is one; the body is read only where the status is
 * ambiguous. Two cases matter most because they trip the breaker:
 * - Pollinations answers 402 with "Insufficient balance ... Top up".
 * - Gemini's image models answer 429 RESOURCE_EXHAUSTED with "limit: 0" on a
 *   key without billing: that is not a busy minute, it will never work.
 * A 403 counts as a key problem only when the body says so, because some
 * providers use 403 for a refused prompt, and pausing a working provider for
 * ten minutes over one user's prompt would be far worse than one extra call.
 */
export function classifyImageFailure(status: number | undefined, error: string | undefined): ImageFailureKind {
  const text = String(error ?? '');
  const creditText = /insufficient (balance|funds|credit)|top ?up|out of (credit|pollen)|billing|payment required|limit: ?0\b/i;
  if (status === 402) return 'credit';
  // Gemini answers a bad key with 400 INVALID_ARGUMENT, not 401.
  if (/api[ _]?key[ _]?(not valid|invalid)|API_KEY_INVALID/i.test(text)) return 'auth';
  if (status === 401) return 'auth';
  if (status === 403) return /key|token|auth|unauthori[sz]ed|permission|access denied|forbidden: ?(api|access)/i.test(text) ? 'auth' : 'refused';
  if (status === 429) return creditText.test(text) ? 'credit' : 'rate';
  if (status === 400 || status === 422) return creditText.test(text) ? 'credit' : 'refused';
  if (status !== undefined && status >= 500) return 'down';
  if (/needs a (free )?key|no GEMINI_API_KEY/i.test(text)) return 'auth';
  if (creditText.test(text)) return 'credit';
  if (/timed out|network error|empty image|ECONN|ENOTFOUND|fetch failed/i.test(text)) return 'down';
  if (/returned no image|safety|blocked/i.test(text)) return 'refused';
  return 'other';
}

/** Plain words for the dashboard and the emails. */
export const KIND_LABEL: Record<ImageFailureKind, string> = {
  credit: 'out of credit',
  auth: 'key refused',
  rate: 'rate limited',
  down: 'not answering',
  refused: 'refused the prompt',
  other: 'failed',
};

export interface ProviderSnapshot {
  provider: PictureProvider;
  label: string;
  role: 'main' | 'backup';
  delivered: number;
  failed: number;
  failedByKind: Partial<Record<ImageFailureKind, number>>;
  lastOk: string | null;
  lastFailure: { at: string; kind: ImageFailureKind; status: number | null; detail: string } | null;
  /** Set while the breaker is holding this provider back. */
  pausedUntil: string | null;
  pausedFor: ImageFailureKind | null;
}

export interface PicturesSnapshot {
  since: string;
  main: PictureProvider | null;
  backup: PictureProvider | null;
  providers: ProviderSnapshot[];
  /** Pictures the backup delivered because the main provider could not. */
  servedByBackup: number;
  /** Requests where every provider was tried and no picture came back. */
  failedEverywhere: number;
  /** End-to-end failures in the last FAILING_WINDOW_MS. */
  recentFailures: number;
  alerts: {
    to: string | null;
    sent: { at: string; subject: string; delivered: boolean; error: string | null }[];
  };
}

interface ProviderState {
  delivered: number;
  failed: number;
  failedByKind: Partial<Record<ImageFailureKind, number>>;
  lastOk: number | null;
  lastFailure: { at: number; kind: ImageFailureKind; status: number | null; detail: string } | null;
  pausedUntil: number;
  pausedFor: ImageFailureKind | null;
}

export interface ImageAlertConfig {
  sender?: EmailSender;
  /** Where alerts go. Anything that is not an email address is ignored. */
  to?: string;
  publicUrl?: string;
  log?: (message: string) => void;
}

const EMAIL_RE = /^[^\s@<>()[\],;:"\\?&#%]+@[^\s@<>()[\],;:"\\?&#%]+\.[^\s@<>()[\],;:"\\?&#%]+$/;

const blank = (): ProviderState => ({
  delivered: 0,
  failed: 0,
  failedByKind: {},
  lastOk: null,
  lastFailure: null,
  pausedUntil: 0,
  pausedFor: null,
});

export class ImageHealth {
  private now: () => number;
  private since: number;
  private state = new Map<PictureProvider, ProviderState>();
  private servedByBackup = 0;
  private failedEverywhere = 0;
  private failureTimes: number[] = [];
  private lastAlert = new Map<string, number>();
  private alertTimes: number[] = [];
  private sent: { at: number; subject: string; delivered: boolean; error: string | null }[] = [];
  private sender?: EmailSender;
  private to: string | null = null;
  private publicUrl = 'https://tifomaker.org';
  private log: (message: string) => void = (m) => console.warn(m);
  /** Emails in flight, so tests (and shutdown) can wait for them. */
  private pending = new Set<Promise<void>>();

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.since = now();
  }

  configure(cfg: ImageAlertConfig): void {
    this.sender = cfg.sender;
    const to = cfg.to?.trim() ?? '';
    this.to = EMAIL_RE.test(to) ? to : null;
    this.publicUrl = (cfg.publicUrl ?? 'https://tifomaker.org').replace(/\/+$/, '');
    if (cfg.log) this.log = cfg.log;
  }

  /** Forget everything. For tests; a restart does the same in production. */
  reset(now: () => number = this.now): void {
    this.now = now;
    this.since = now();
    this.state.clear();
    this.servedByBackup = 0;
    this.failedEverywhere = 0;
    this.failureTimes = [];
    this.lastAlert.clear();
    this.alertTimes = [];
    this.sent = [];
  }

  private of(p: PictureProvider): ProviderState {
    let s = this.state.get(p);
    if (!s) this.state.set(p, (s = blank()));
    return s;
  }

  /** True while the breaker is holding this provider back. */
  isPaused(p: PictureProvider): boolean {
    return this.of(p).pausedUntil > this.now();
  }

  recordOk(p: PictureProvider, viaBackup: boolean): void {
    const s = this.of(p);
    s.delivered++;
    s.lastOk = this.now();
    // It answered, so whatever paused it is over (a top-up, a new key).
    s.pausedUntil = 0;
    s.pausedFor = null;
    if (viaBackup) this.servedByBackup++;
  }

  /**
   * One failed request to one provider. Returns the kind, so the caller can
   * decide whether trying again could possibly help. Credit and key failures
   * pause the provider; the email about them waits for finish(), which knows
   * whether the backup covered for it.
   */
  recordFailure(p: PictureProvider, status: number | undefined, error: string | undefined, breakerMs: number): ImageFailureKind {
    const kind = classifyImageFailure(status, error);
    const s = this.of(p);
    const t = this.now();
    s.failed++;
    s.failedByKind[kind] = (s.failedByKind[kind] ?? 0) + 1;
    s.lastFailure = { at: t, kind, status: status ?? null, detail: sanitizeDetail(error) };
    if (kind === 'credit' || kind === 'auth') {
      s.pausedUntil = t + breakerMs;
      s.pausedFor = kind;
    }
    return kind;
  }

  /**
   * The end of one picture request: which provider delivered (or none), and
   * which account-level problems were met on the way. This is where the emails
   * are decided, because only now is it known whether people were affected.
   */
  finish(r: {
    deliveredBy: PictureProvider | null;
    main: PictureProvider;
    backup: PictureProvider | null;
    problems: { provider: PictureProvider; kind: ImageFailureKind; detail: string }[];
    breakerMs: number;
    lastError?: string;
  }): void {
    for (const pr of r.problems) {
      if (pr.kind === 'credit' || pr.kind === 'auth') this.alertAccount(pr.provider, pr.kind, sanitizeDetail(pr.detail), r);
    }
    if (!r.deliveredBy) this.recordFailedEverywhere(r.lastError ?? '');
  }

  private recordFailedEverywhere(summary: string): void {
    const t = this.now();
    this.failedEverywhere++;
    this.failureTimes = this.failureTimes.filter((x) => t - x < FAILING_WINDOW_MS);
    this.failureTimes.push(t);
    if (this.failureTimes.length >= FAILING_THRESHOLD) {
      const n = this.failureTimes.length;
      this.alert(
        'failing',
        `TifoMaker: AI pictures are failing (${n} in ${FAILING_WINDOW_MS / MINUTE} min)`,
        'AI pictures are failing',
        [
          `${n} picture requests in the last ${FAILING_WINDOW_MS / MINUTE} minutes came back with no picture from any provider.`,
          'People still get their design, without its picture, and are not charged for it.',
          `Last error: ${sanitizeDetail(summary) || 'unknown'}`,
        ],
        'Open /admin → AI → Pictures to see which provider is failing and why. Credit and key problems are fixed in the provider\'s dashboard or in Railway\'s variables; an outage passes on its own.',
      );
    }
  }

  private alertAccount(
    p: PictureProvider,
    kind: 'credit' | 'auth',
    detail: string,
    r: { deliveredBy: PictureProvider | null; main: PictureProvider; backup: PictureProvider | null; breakerMs: number },
  ): void {
    const label = PROVIDER_LABEL[p];
    const what =
      kind === 'credit'
        ? `${label} refused a picture because the account has no credit left.`
        : `${label} refused the API key.`;
    let impact: string;
    if (p !== r.main) {
      impact = `${label} is the backup, so this matters only when ${PROVIDER_LABEL[r.main]} fails too.`;
    } else if (r.backup && r.deliveredBy === r.backup) {
      impact = `Pictures are being made by ${PROVIDER_LABEL[r.backup]} instead, so people are not affected for now.` +
        (r.backup === 'gemini' ? ' Gemini pictures cost more per picture than Pollinations.' : '');
    } else if (r.backup) {
      impact = `The backup, ${PROVIDER_LABEL[r.backup]}, did not produce the picture either, so AI designs are arriving without their picture (people are not charged for those).`;
    } else {
      impact = 'No backup provider is set up, so AI designs are arriving without their picture (people are not charged for those).';
    }
    const fix =
      p === 'pollinations'
        ? kind === 'credit'
          ? 'Top up the pollen balance at https://enter.pollinations.ai. The key in Railway stays the same and nothing needs redeploying.'
          : 'Create a key at https://enter.pollinations.ai and put it in AI_POLLINATIONS_KEY in Railway.'
        : kind === 'credit'
          ? 'Turn on billing for the Google AI Studio project that owns GEMINI_API_KEY (image models have no free quota), or set AI_IMAGE_FALLBACK=none in Railway to stop using Gemini for pictures.'
          : 'Check GEMINI_API_KEY in Railway: it is wrong, expired, or has no access to the image model in AI_IMAGE_MODEL.';
    this.alert(
      `${p}:${kind}`,
      `TifoMaker: AI pictures — ${label} is ${KIND_LABEL[kind]}`,
      `${label} is ${KIND_LABEL[kind]}`,
      [
        what,
        impact,
        `${label} is paused and tried again automatically every ${Math.round(r.breakerMs / MINUTE)} minutes, so it comes back on its own once this is fixed.`,
        detail ? `What ${label} said: ${detail}` : '',
      ].filter(Boolean),
      fix,
    );
  }

  private alert(id: string, subject: string, title: string, lines: string[], advice: string): void {
    const t = this.now();
    if (t - (this.lastAlert.get(id) ?? -Infinity) < ALERT_COOLDOWN_MS) return;
    this.lastAlert.set(id, t);
    this.alertTimes = this.alertTimes.filter((x) => t - x < 24 * HOUR);
    const text = `${title}\n\n${lines.join('\n\n')}\n\nWhat to do: ${advice}\n\nLive view: ${this.publicUrl}/admin#ai\n\nAt most one email per alert type every ${ALERT_COOLDOWN_MS / HOUR} hours. Sent ${new Date(t).toISOString()}.`;
    this.log(`[tifo] pictures: ${title}. ${lines[0]}`);
    const entry = { at: t, subject, delivered: false, error: null as string | null };
    this.sent.unshift(entry);
    this.sent = this.sent.slice(0, 10);
    if (!this.to || !this.sender) {
      entry.error = 'no alert address: set AI_ALERT_TO or SECURITY_ALERT_TO';
      return;
    }
    if (this.alertTimes.length >= ALERT_DAILY_CAP) {
      entry.error = `daily cap of ${ALERT_DAILY_CAP} picture alerts reached`;
      return;
    }
    this.alertTimes.push(t);
    const job = this.sender
      .send({ to: this.to, subject, html: this.html(title, lines, advice), text })
      .then(() => { entry.delivered = true; })
      .catch((e) => {
        entry.error = String((e as Error)?.message ?? e).slice(0, 300);
        this.log(`[tifo] pictures: alert email failed: ${entry.error}`);
      });
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Wait for alert emails in flight. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private html(title: string, lines: string[], advice: string): string {
    const e = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return (
      `<!doctype html><html><body style="margin:0;padding:24px;background-color:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2328">` +
      `<div style="max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #d0d7de;border-radius:10px;padding:22px">` +
      `<p style="margin:0 0 6px;font-size:12px;color:#57606a;text-transform:uppercase;letter-spacing:.06em">TifoMaker AI pictures</p>` +
      `<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3">${e(title)}</h1>` +
      lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.55">${e(l)}</p>`).join('') +
      `<p style="margin:14px 0 0;font-size:14px;line-height:1.55"><b>What to do:</b> ${e(advice)}</p>` +
      `<p style="margin:18px 0 0"><a href="${e(this.publicUrl)}/admin#ai" style="color:#0969da">Open the AI tab</a></p>` +
      `<p style="margin:18px 0 0;font-size:12px;color:#57606a">At most one email per alert type every ${ALERT_COOLDOWN_MS / HOUR} hours, and ${ALERT_DAILY_CAP} a day.</p>` +
      `</div></body></html>`
    );
  }

  snapshot(main: PictureProvider | null, backup: PictureProvider | null): PicturesSnapshot {
    const t = this.now();
    const iso = (n: number | null): string | null => (n ? new Date(n).toISOString() : null);
    const order = [main, backup].filter((p): p is PictureProvider => !!p);
    // A provider that is no longer configured but failed earlier is still shown,
    // so the reason for a past alert does not vanish from the page.
    for (const p of this.state.keys()) if (!order.includes(p)) order.push(p);
    return {
      since: new Date(this.since).toISOString(),
      main,
      backup,
      providers: order.map((p) => {
        const s = this.of(p);
        const paused = s.pausedUntil > t;
        return {
          provider: p,
          label: PROVIDER_LABEL[p],
          role: p === main ? 'main' : 'backup',
          delivered: s.delivered,
          failed: s.failed,
          failedByKind: { ...s.failedByKind },
          lastOk: iso(s.lastOk),
          lastFailure: s.lastFailure ? { ...s.lastFailure, at: new Date(s.lastFailure.at).toISOString() } : null,
          pausedUntil: paused ? iso(s.pausedUntil) : null,
          pausedFor: paused ? s.pausedFor : null,
        };
      }),
      servedByBackup: this.servedByBackup,
      failedEverywhere: this.failedEverywhere,
      recentFailures: this.failureTimes.filter((x) => t - x < FAILING_WINDOW_MS).length,
      alerts: {
        to: this.to ? maskEmail(this.to) : null,
        sent: this.sent.map((s) => ({ at: new Date(s.at).toISOString(), subject: s.subject, delivered: s.delivered, error: s.error })),
      },
    };
  }
}

/** The one the server uses. */
export const imageHealth = new ImageHealth();
