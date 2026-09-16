/**
 * The security monitor behind the Security tab on /admin.
 *
 * WHAT IT WATCHES
 *   Attacks on sign-in   failed logins, guessed verification codes, refused
 *                        password changes, registration conflicts (the way
 *                        someone tests which emails have accounts), reset
 *                        requests, and emails the per-address limits refused.
 *   Blocked and abusive  rate-limited requests, oversized bodies, vulnerability
 *   traffic              scanners (/.env, /wp-login.php), bot traps, uploads that
 *                        were not images, and requests to admin endpoints
 *                        without admin rights.
 *   Admin audit trail    every admin sign-in and action: who (the @account, or
 *                        which admin-password session), what, on what, from
 *                        which hashed address.
 *   Security posture     computed on request, in posture.ts.
 *
 * HOW
 *   A Fastify onResponse hook classifies each finished request from its route,
 *   status and, where the status alone is ambiguous, a note the handler left on
 *   the request (req.socNote). Nothing here runs before the response is sent,
 *   and nothing here can throw into a request.
 *
 *   Events are counted in memory and written every FLUSH_MS as one aggregated
 *   row per minute per (kind, source, route, account). Distinct keys per flush
 *   are capped, so a flood from a million addresses costs a bounded number of
 *   rows and a bounded amount of memory.
 *
 * ADDRESSES
 *   Never stored. `source` is HMAC-SHA256(key, ip), 12 hex characters. The key
 *   comes from SOC_IP_KEY, or when that is unset from random bytes held only in
 *   memory, so it is regenerated on every restart. Either way it is never
 *   written to the database: reading the tables does not let anyone recover an
 *   address, which an unkeyed or database-stored salt would (there are only
 *   four billion IPv4 addresses to try). With SOC_IP_KEY set, the same address
 *   has the same tag across restarts, so a returning attacker is recognisable.
 *
 * ALERTS
 *   Rules below are checked on every flush against the last hour of counts.
 *   When one crosses its threshold, an email goes to SECURITY_ALERT_TO: at most
 *   one per rule per hour and ALERT_DAILY_CAP a day in total, both remembered in
 *   soc_alerts so a restart does not reset them.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EmailSender } from './email';
import {
  type SocAlertRow,
  type SocAuditInput,
  type SocAuditRow,
  type SocEventRow,
  type SocKind,
  type SocRepository,
  type SocSummary,
} from './socRepo';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Left by a handler when the status code alone does not say what happened:
     * a wrong verification code and a malformed one are both 400, a honeypot hit
     * answers 200 on purpose. `subject` names the account a request was about.
     * `ignore` marks an answer that looks like a refusal but is ordinary use,
     * such as pressing "resend" twice.
     */
    socNote: { kind?: SocKind; subject?: string; ignore?: boolean } | null;
    /** Who performed an admin request, set by the admin gate that let it through. */
    socActor: string | null;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FLUSH_MS = 15_000;
/** Distinct (minute, kind, source, route, account) keys held between flushes. */
const MAX_PENDING_KEYS = 5_000;
/** Distinct (kind, source) keys per minute for the alert windows. */
const MAX_WINDOW_KEYS = 5_000;
const RECENT_MAX = 200;
export const ALERT_DAILY_CAP = 12;
const MANY = '(many)';

// ---------------------------------------------------------------------------
// Rules

export interface AlertRule {
  id: string;
  title: string;
  kinds: SocKind[];
  windowMin: number;
  threshold: number;
  /** Count per hashed address instead of site-wide. */
  perSource?: boolean;
  /** What the person reading the email should do. */
  advice: string;
}

export const ALERT_RULES: readonly AlertRule[] = [
  {
    id: 'admin-password',
    title: 'Someone is guessing the admin password',
    kinds: ['admin_unlock_failed'],
    windowMin: 15,
    threshold: 3,
    advice:
      'If this was not you mistyping it, change AI_ADMIN_PASSWORD in Railway now (it signs out every admin session) and make it long: 20+ random characters. The unlock route allows 10 tries a minute per address.',
  },
  {
    id: 'account-takeover',
    title: 'Possible account takeover: many failures, then a successful sign-in',
    kinds: ['login_failed'],
    windowMin: 60,
    threshold: 10,
    perSource: true,
    advice:
      'One address failed repeatedly and then signed in. If the account is not the owner\'s own, reset its password and end its sessions. Check the Security tab for which account.',
  },
  {
    id: 'signin-attack',
    title: 'Sign-in attack: many failed logins',
    kinds: ['login_failed'],
    windowMin: 10,
    threshold: 40,
    advice:
      'Password guessing or credential stuffing. Each address is limited to 10 tries a minute; if it is spread over many addresses, turn on a Cloudflare rate-limiting rule for POST /api/auth/login.',
  },
  {
    id: 'signin-attack-source',
    title: 'One address is guessing passwords or codes',
    kinds: ['login_failed', 'code_failed', 'password_change_failed'],
    windowMin: 10,
    threshold: 15,
    perSource: true,
    advice:
      'A single address keeps failing. The per-address limits are holding it; if it continues for hours, block it at Cloudflare (find the address in the Railway logs at the times shown).',
  },
  {
    id: 'mail-abuse',
    title: 'Someone is trying to flood mailboxes through the site',
    kinds: ['mail_refused'],
    windowMin: 60,
    threshold: 20,
    advice:
      'The per-address email limits refused these sends, so nothing went out. If it keeps up, check the Resend dashboard for bounces and the daily quota.',
  },
  {
    id: 'enumeration',
    title: 'Someone is testing which emails have accounts',
    kinds: ['register_conflict', 'reset_requested'],
    windowMin: 10,
    threshold: 50,
    advice:
      'Many registrations hit existing accounts, or many reset requests arrived. Answers do not reveal which addresses exist; watch for a sign-in attack that follows.',
  },
  {
    id: 'abuse-flood',
    title: 'Flood of blocked requests',
    kinds: ['rate_limited', 'oversized_body'],
    windowMin: 10,
    threshold: 500,
    advice:
      'The rate limits are refusing a lot of traffic. If the site feels slow for real visitors, enable Cloudflare\'s "Under Attack" mode for an hour.',
  },
  {
    id: 'server-errors',
    title: 'Server errors are spiking',
    kinds: ['server_error'],
    windowMin: 10,
    threshold: 20,
    advice:
      'Something is failing for many requests: the database, an upstream provider, or an attack triggering a bug. Railway logs show the stack traces ("level":50).',
  },
];

export interface RuleState {
  id: string;
  title: string;
  windowMin: number;
  threshold: number;
  perSource: boolean;
  /** The current count in the window (the busiest address for per-source rules). */
  count: number;
  firing: boolean;
  lastAlertAt: string | null;
}

// ---------------------------------------------------------------------------
// Keys and tags

export interface SocKey {
  key: Buffer;
  /** Whether a tag means the same address after a restart. */
  stable: boolean;
  source: 'SOC_IP_KEY' | 'random';
}

export function socKeyFrom(env: NodeJS.ProcessEnv = process.env): SocKey {
  const configured = env.SOC_IP_KEY?.trim();
  if (configured && configured.length >= 16) {
    return { key: createHash('sha256').update('tifomaker/soc-ip/v1|').update(configured).digest(), stable: true, source: 'SOC_IP_KEY' };
  }
  return { key: randomBytes(32), stable: false, source: 'random' };
}

/** "o•••@gmail.com": enough to recognise your own address, not to harvest one. */
export function maskEmail(addr: unknown): string {
  const s = String(addr ?? '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? '•••' : '';
  return `${s[0]}•••@${s.slice(at + 1).slice(0, 60)}`;
}

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');

// ---------------------------------------------------------------------------
// The monitor

export interface RecentEvent {
  at: string;
  kind: SocKind;
  route: string;
  status: number | null;
  source: string;
  subject: string;
  reqId: string;
}

export interface SocMonitorOptions {
  repo: SocRepository;
  key?: SocKey;
  sender?: EmailSender;
  /** Where spike alerts go. Unset: alerts are recorded, not emailed. */
  alertTo?: string;
  /** For the link in alert emails. */
  publicUrl?: string;
  now?: () => number;
  /** 0 disables the timer; tests call flush() themselves. */
  flushMs?: number;
  log?: (message: string) => void;
}

export class SocMonitor {
  readonly repo: SocRepository;
  readonly keyInfo: { stable: boolean; source: SocKey['source'] };
  readonly alertTo: string | null;
  private readonly key: Buffer;
  private readonly sender?: EmailSender;
  private readonly publicUrl: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly timer: NodeJS.Timeout | null;

  private pending = new Map<string, SocEventRow>();
  /** minute -> "kind|source" -> count, the last hour, for the rules. */
  private windows = new Map<number, Map<string, number>>();
  /** Successful sign-ins in the last hour: which address, which account. */
  private logins: { t: number; source: string; subject: string }[] = [];
  private ring: RecentEvent[] = [];
  private lastAlert = new Map<string, number>();
  private alertTimes: number[] = [];
  private alertsLoaded: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private dashboardOpens = new Map<string, number>();
  private writeFailures = 0;
  lastWriteError: string | null = null;
  startedAt: number;

  constructor(opts: SocMonitorOptions) {
    const k = opts.key ?? socKeyFrom();
    this.repo = opts.repo;
    this.key = k.key;
    this.keyInfo = { stable: k.stable, source: k.source };
    this.sender = opts.sender;
    const to = opts.alertTo?.trim() ?? '';
    // Same shape the preflight check accepts; anything else is not sent to.
    this.alertTo = /^[^\s@<>()[\],;:"\\?&#%]+@[^\s@<>()[\],;:"\\?&#%]+\.[^\s@<>()[\],;:"\\?&#%]+$/.test(to) ? to : null;
    this.publicUrl = (opts.publicUrl ?? 'https://tifomaker.org').replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.startedAt = this.now();
    const every = opts.flushMs ?? FLUSH_MS;
    this.timer = every > 0 ? setInterval(() => void this.flush(), every) : null;
    this.timer?.unref();
  }

  /** The tag for an address. Same key, same address, same tag. */
  tag(ip: string | undefined): string {
    if (!ip) return '';
    return createHmac('sha256', this.key).update(ip).digest('hex').slice(0, 12);
  }

  record(kind: SocKind, ctx: { ip?: string; route?: string; subject?: string; status?: number; reqId?: string } = {}): void {
    try {
      const t = this.now();
      const minute = Math.floor(t / MINUTE) * MINUTE;
      let source = this.tag(ctx.ip);
      let route = clip(ctx.route, 80);
      let subject = clip(ctx.subject, 40);

      let key = `${minute}|${kind}|${source}|${route}|${subject}`;
      if (!this.pending.has(key) && this.pending.size >= MAX_PENDING_KEYS) {
        source = MANY;
        route = '';
        subject = '';
        key = `${minute}|${kind}|${MANY}||`;
      }
      const row = this.pending.get(key);
      if (row) row.count++;
      else this.pending.set(key, { minute, kind, source, route, subject, count: 1 });

      let w = this.windows.get(minute);
      if (!w) {
        w = new Map();
        this.windows.set(minute, w);
      }
      let wkey = `${kind}|${source}`;
      if (!w.has(wkey) && w.size >= MAX_WINDOW_KEYS) wkey = `${kind}|${MANY}`;
      w.set(wkey, (w.get(wkey) ?? 0) + 1);

      if (kind === 'login_ok' && source) {
        this.logins.push({ t, source, subject });
        if (this.logins.length > 5_000) this.logins.splice(0, this.logins.length - 5_000);
      }

      this.ring.push({ at: new Date(t).toISOString(), kind, route, status: ctx.status ?? null, source, subject, reqId: clip(ctx.reqId, 24) });
      if (this.ring.length > RECENT_MAX) this.ring.splice(0, this.ring.length - RECENT_MAX);
    } catch {
      /* monitoring must never become the outage */
    }
  }

  /** Admin actions are rare, so each is written straight away. */
  audit(entry: Omit<SocAuditInput, 'source' | 'at'> & { ip?: string }): void {
    const { ip, ...rest } = entry;
    void this.repo
      .addAudit({ ...rest, source: this.tag(ip), at: new Date(this.now()) })
      .catch((e) => this.noteWriteError(e));
  }

  /**
   * "Opened the dashboard" once per actor and address per half hour: the page
   * loads its panels together and again on every refresh, and a trail full of
   * the same line hides the lines that matter.
   */
  auditDashboardOpen(actor: string, ip: string | undefined): void {
    const k = `${actor}|${this.tag(ip)}`;
    const t = this.now();
    const last = this.dashboardOpens.get(k) ?? 0;
    if (t - last < 30 * MINUTE) return;
    this.dashboardOpens.set(k, t);
    if (this.dashboardOpens.size > 500) {
      for (const [key, at] of this.dashboardOpens) if (t - at >= 30 * MINUTE) this.dashboardOpens.delete(key);
    }
    this.audit({ actor, action: 'opened the dashboard', target: null, outcome: 'ok', detail: null, ip });
  }

  recent(limit = 60): RecentEvent[] {
    return this.ring.slice(-limit).reverse();
  }

  /** Write what has been counted and check the rules. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        const rows = [...this.pending.values()];
        this.pending.clear();
        this.prune();
        await this.checkRules();
        if (rows.length) {
          await this.repo.addEvents(rows).catch((e) => this.noteWriteError(e));
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  status(): RuleState[] {
    return ALERT_RULES.map((rule) => {
      const { count } = this.measure(rule);
      const last = this.lastAlert.get(rule.id);
      return {
        id: rule.id,
        title: rule.title,
        windowMin: rule.windowMin,
        threshold: rule.threshold,
        perSource: !!rule.perSource,
        count,
        firing: count >= rule.threshold,
        lastAlertAt: last ? new Date(last).toISOString() : null,
      };
    });
  }

  summary(): Promise<SocSummary> {
    return this.repo.summary(new Date(this.now()));
  }

  auditTrail(limit = 50): Promise<SocAuditRow[]> {
    return this.repo.listAudit(limit);
  }

  alerts(limit = 20): Promise<SocAlertRow[]> {
    return this.repo.listAlerts(limit);
  }

  /** One real alert email, so the address and the provider are proven before an attack. */
  async sendTestAlert(): Promise<{ ok: boolean; error?: string }> {
    if (!this.alertTo) return { ok: false, error: 'SECURITY_ALERT_TO is not set, so alerts have nowhere to go' };
    if (!this.sender) return { ok: false, error: 'no email sender is configured' };
    const stamp = new Date(this.now()).toISOString();
    try {
      await this.sender.send({
        to: this.alertTo,
        subject: 'TifoMaker security: test alert',
        html: this.alertHtml('Test alert', ['This is a test from the Security tab. Real alerts look like this and arrive here.'], []),
        text: `Test alert\n\nThis is a test from the Security tab. Real alerts look like this and arrive here.\n\nSent ${stamp}.`,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }

  // ---- internals ----

  private noteWriteError(e: unknown): void {
    this.writeFailures++;
    this.lastWriteError = String((e as Error)?.message ?? e).slice(0, 200);
    // Once, then every hundredth: a dead database must not flood the log too.
    if (this.writeFailures === 1 || this.writeFailures % 100 === 0) {
      this.log(`[tifo] security log write failed (${this.writeFailures}x): ${this.lastWriteError}`);
    }
  }

  private prune(): void {
    const oldest = Math.floor((this.now() - HOUR) / MINUTE) * MINUTE;
    for (const m of this.windows.keys()) if (m < oldest) this.windows.delete(m);
    const since = this.now() - HOUR;
    if (this.logins.length && this.logins[0].t < since) this.logins = this.logins.filter((l) => l.t >= since);
  }

  /** Count for a rule over its window, and the top contributors. */
  private measure(rule: AlertRule): { count: number; bySource: Map<string, number> } {
    const t = this.now();
    const since = Math.floor(t / MINUTE) * MINUTE - (rule.windowMin - 1) * MINUTE;
    // For account takeover, only failures up to an address's latest successful
    // sign-in count: failing ten times AFTER signing in is someone else's problem.
    let lastOk: Map<string, number> | null = null;
    if (rule.id === 'account-takeover') {
      lastOk = new Map();
      for (const l of this.logins) if (l.t >= since && l.t > (lastOk.get(l.source) ?? 0)) lastOk.set(l.source, l.t);
      if (!lastOk.size) return { count: 0, bySource: new Map() };
    }
    const bySource = new Map<string, number>();
    let total = 0;
    for (const [minute, w] of this.windows) {
      if (minute < since) continue;
      for (const [k, n] of w) {
        const bar = k.indexOf('|');
        const kind = k.slice(0, bar) as SocKind;
        if (!rule.kinds.includes(kind)) continue;
        const source = k.slice(bar + 1);
        if (lastOk) {
          const ok = lastOk.get(source);
          if (ok === undefined || minute > ok) continue;
        }
        total += n;
        bySource.set(source, (bySource.get(source) ?? 0) + n);
      }
    }
    if (!rule.perSource) return { count: total, bySource };
    let max = 0;
    for (const [source, n] of bySource) {
      if (source === '' || source === MANY) continue;
      if (n > max) max = n;
    }
    return { count: max, bySource };
  }

  private loadAlertHistory(): Promise<void> {
    if (!this.alertsLoaded) {
      this.alertsLoaded = (async () => {
        try {
          const rows = await this.repo.alertsSince(new Date(this.now() - 24 * HOUR));
          for (const r of rows) {
            const at = new Date(r.at).getTime();
            if (at > (this.lastAlert.get(r.rule) ?? 0)) this.lastAlert.set(r.rule, at);
            if (r.delivered) this.alertTimes.push(at);
          }
        } catch (e) {
          this.noteWriteError(e);
        }
      })();
    }
    return this.alertsLoaded;
  }

  private async checkRules(): Promise<void> {
    const firing = ALERT_RULES.map((rule) => ({ rule, ...this.measure(rule) })).filter((r) => r.count >= r.rule.threshold);
    if (!firing.length) return;
    await this.loadAlertHistory();
    for (const { rule, count, bySource } of firing) {
      const t = this.now();
      if (t - (this.lastAlert.get(rule.id) ?? 0) < HOUR) continue;
      this.lastAlert.set(rule.id, t);
      this.alertTimes = this.alertTimes.filter((a) => t - a < 24 * HOUR);

      const top = [...bySource.entries()]
        .filter(([s]) => s)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      const accounts = this.topAccounts(rule);
      const lines = [
        `${count} in the last ${rule.windowMin} minutes${rule.perSource ? ' from one address' : ''} (alert threshold ${rule.threshold}).`,
        top.length ? `Busiest addresses (hashed): ${top.map(([s, n]) => `${s} ×${n}`).join(', ')}` : '',
        accounts.length ? `Accounts involved: ${accounts.map(([a, n]) => `@${a} ×${n}`).join(', ')}` : '',
      ].filter(Boolean);
      const summary = lines.join(' ');

      let delivered = false;
      let error: string | null = null;
      if (!this.alertTo || !this.sender) {
        error = 'SECURITY_ALERT_TO is not set';
      } else if (this.alertTimes.length >= ALERT_DAILY_CAP) {
        error = `daily cap of ${ALERT_DAILY_CAP} alert emails reached`;
      } else {
        try {
          await this.sender.send({
            to: this.alertTo,
            subject: `TifoMaker security: ${rule.title} (${count} in ${rule.windowMin} min)`,
            html: this.alertHtml(rule.title, lines, [rule.advice]),
            text: `${rule.title}\n\n${lines.join('\n')}\n\nWhat to do: ${rule.advice}\n\nLive view: ${this.publicUrl}/admin#security\n\nAt most one email per alert type per hour. Sent ${new Date(t).toISOString()}.`,
          });
          delivered = true;
          this.alertTimes.push(t);
        } catch (e) {
          error = String((e as Error)?.message ?? e).slice(0, 300);
        }
      }
      await this.repo
        .addAlert({ at: new Date(t), rule: rule.id, count, windowMin: rule.windowMin, delivered, error, summary })
        .catch((e) => this.noteWriteError(e));
    }
  }

  private topAccounts(rule: AlertRule): [string, number][] {
    const since = this.now() - rule.windowMin * MINUTE;
    const counts = new Map<string, number>();
    for (const e of this.ring) {
      if (!e.subject || !rule.kinds.includes(e.kind) || new Date(e.at).getTime() < since) continue;
      counts.set(e.subject, (counts.get(e.subject) ?? 0) + 1);
    }
    if (rule.id === 'account-takeover') {
      for (const l of this.logins) if (l.subject && l.t >= since) counts.set(l.subject, (counts.get(l.subject) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }

  private alertHtml(title: string, lines: string[], advice: string[]): string {
    const e = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return (
      `<!doctype html><html><body style="margin:0;padding:24px;background-color:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2328">` +
      `<div style="max-width:560px;margin:0 auto;background-color:#ffffff;border:1px solid #d0d7de;border-radius:10px;padding:22px">` +
      `<p style="margin:0 0 6px;font-size:12px;color:#57606a;text-transform:uppercase;letter-spacing:.06em">TifoMaker security</p>` +
      `<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3">${e(title)}</h1>` +
      lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.55">${e(l)}</p>`).join('') +
      advice.map((a) => `<p style="margin:14px 0 0;font-size:14px;line-height:1.55"><b>What to do:</b> ${e(a)}</p>`).join('') +
      `<p style="margin:18px 0 0"><a href="${e(this.publicUrl)}/admin#security" style="color:#0969da">Open the Security tab</a></p>` +
      `<p style="margin:18px 0 0;font-size:12px;color:#57606a">At most one email per alert type per hour, and ${ALERT_DAILY_CAP} a day. Addresses are shown as hashes; the server never stores them.</p>` +
      `</div></body></html>`
    );
  }
}

// ---------------------------------------------------------------------------
// Classifying requests

/** Paths only vulnerability scanners ask for. A 404 on one of these is a probe. */
const SCANNER_PATH =
  /(?:^|\/)(?:\.env|\.git|\.svn|\.hg|\.DS_Store|\.aws|\.ssh|\.htaccess|\.htpasswd|wp-(?:login|admin|content|includes|config)|xmlrpc\.php|phpmyadmin|pma|adminer|cgi-bin|vendor\/phpunit|actuator|server-status|boaform|HNAP1|owa|solr|manager\/html|console|telescope|debug|config\.(?:json|php|yml|yaml)|web\.config|id_rsa|backup|dump\.sql|database\.sql)(?:$|[/.?])|\.(?:php\d?|asp|aspx|jsp|cgi|env|bak|sql|swp)$/i;

const ADMIN_ROUTE = /^\/api\/(?:admin\/|funnel$|stadiums\/pending$|stadiums\/:id\/review$)/;

/** What a finished request was, from the security point of view, or null. */
export function classifyRequest(req: FastifyRequest, reply: FastifyReply): { kind: SocKind; subject?: string } | null {
  const note = req.socNote;
  if (note?.ignore) return null;
  if (note?.kind) return { kind: note.kind, subject: note.subject };
  const status = reply.statusCode;
  const route = req.routeOptions?.url ?? '';
  const method = req.method;
  if (status >= 500) return { kind: 'server_error' };
  if (status === 413) return { kind: 'oversized_body' };
  if (status === 429) return { kind: 'rate_limited' };
  if (method === 'POST') {
    if (route === '/api/auth/login') {
      if (status === 401) return { kind: 'login_failed', subject: note?.subject };
      if (status === 200) return { kind: 'login_ok', subject: note?.subject };
    }
    if (route === '/api/auth/register' && status === 409) return { kind: 'register_conflict' };
    if (route === '/api/auth/forgot' && status < 400) return { kind: 'reset_requested' };
    if (route === '/api/ai/unlock' && status === 401) return { kind: 'admin_unlock_failed' };
  }
  if ((status === 401 || status === 403) && ADMIN_ROUTE.test(route)) return { kind: 'admin_denied' };
  if (status === 404) {
    const path = (req.url.split('?')[0] ?? '').slice(0, 200);
    if (path === '/admin.js') return { kind: 'admin_denied' };
    if (SCANNER_PATH.test(path)) return { kind: 'scanner_probe' };
  }
  return null;
}

/** The route to store with an event: the pattern, or a clipped path for a 404. */
function routeOf(req: FastifyRequest, kind: SocKind): string {
  const pattern = req.routeOptions?.url;
  if (pattern) return `${req.method} ${pattern}`;
  const path = (req.url.split('?')[0] ?? '').slice(0, 60);
  return kind === 'scanner_probe' || kind === 'admin_denied' ? `${req.method} ${path}` : req.method;
}

/** Admin actions that go in the audit trail when they succeed. */
const ADMIN_ACTIONS: Record<string, (req: FastifyRequest) => { action: string; target: string | null; detail: SocAuditInput['detail'] }> = {
  'POST /api/ai/unlock': () => ({ action: 'signed in with the admin password', target: null, detail: null }),
  'POST /api/admin/reports/:id/dismiss': (req) => ({ action: 'dismissed a report', target: param(req, 'id'), detail: null }),
  'POST /api/admin/designs/:id/takedown': (req) => ({ action: 'took down a design', target: param(req, 'id'), detail: null }),
  'POST /api/admin/photos/:photoId/verify': (req) => ({
    action: (req.body as { verified?: unknown } | null)?.verified === false ? 'marked a photo unverified' : 'verified a photo',
    target: param(req, 'photoId'),
    detail: null,
  }),
  'DELETE /api/admin/photos/:photoId': (req) => ({ action: 'deleted a photo', target: param(req, 'photoId'), detail: null }),
  'POST /api/stadiums/:id/review': (req) => ({
    action: (req.body as { approve?: unknown } | null)?.approve === true ? 'approved a community stadium' : 'rejected a community stadium',
    target: param(req, 'id'),
    detail: null,
  }),
  'POST /api/admin/email/test': (req) => ({
    action: 'sent a test email',
    target: null,
    detail: { to: maskEmail((req.body as { to?: unknown } | null)?.to) },
  }),
  'POST /api/admin/soc/test-alert': () => ({ action: 'sent a test security alert', target: null, detail: null }),
};

function param(req: FastifyRequest, name: string): string | null {
  const v = (req.params as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v.slice(0, 64) : null;
}

/**
 * Wire the monitor into an app: request decorations, the classifying hook, and
 * a final flush on close. Call before any route is registered.
 */
export function attachSecurityMonitor(app: FastifyInstance, soc: SocMonitor | undefined): void {
  if (!soc) return;
  app.addHook('onResponse', async (req, reply) => {
    try {
      const event = classifyRequest(req, reply);
      if (event) {
        soc.record(event.kind, {
          ip: req.ip,
          route: routeOf(req, event.kind),
          subject: event.subject,
          status: reply.statusCode,
          reqId: String(req.id ?? ''),
        });
      }
      if (reply.statusCode < 400) {
        const key = `${req.method} ${req.routeOptions?.url ?? ''}`;
        if (key === 'GET /api/admin/overview' && req.socActor) {
          soc.auditDashboardOpen(req.socActor, req.ip);
        } else if (ADMIN_ACTIONS[key] && req.socActor) {
          // socActor is set only by a gate that let the request through, so an
          // action with no actor was refused or did nothing, and is not audited.
          const a = ADMIN_ACTIONS[key](req);
          soc.audit({ actor: req.socActor, action: a.action, target: a.target, outcome: 'ok', detail: a.detail, ip: req.ip });
        }
      }
    } catch {
      /* never into a request */
    }
  });
  app.addHook('onClose', async () => {
    await soc.close();
  });
}
