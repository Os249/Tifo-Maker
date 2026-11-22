/**
 * Pro, decided on the server: who it is on for, which plan an account holds,
 * what each allowance has left, and whether the 7-day gift is theirs.
 *
 * Everything the browser shows about Pro comes from here through /api/pro,
 * and every limit the AI routes enforce goes through take()/giveBack(). The
 * browser is never asked what plan it is on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWANCE_KINDS, FREE_WINDOWS, OFFER, PAID_PLANS, PLAN_RANK, PLAN_WINDOWS, autoGiftOn, cycleOf, liveFor, periodEnd, periodKey,
  type AllowanceKind, type PassPlan, type PlanKind, type Window,
} from './proPlan';
import type { ProGift, ProPass, ProRepository } from './proRepo';

// ----------------------------------------------------- throwaway domains ---

let disposable: Set<string> | null = null;
let disposableError: string | null = null;

/** Load the list once. A failure is remembered and reported; see giftEligible. */
function disposableDomains(): Set<string> | null {
  if (disposable || disposableError) return disposable;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '../data/disposable-domains.txt');
    const set = new Set<string>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const d = line.trim().toLowerCase();
      if (d && !d.startsWith('#')) set.add(d);
    }
    if (set.size < 1000) throw new Error(`only ${set.size} domains`);
    disposable = set;
  } catch (e) {
    disposableError = (e as Error).message;
    console.error(`[tifo] throwaway email list not loaded (${disposableError}): no 7-day gifts will be offered until it is`);
  }
  return disposable;
}

/** The throwaway list's state, for the boot report and the admin Pro panel. */
export function disposableListStatus(): { loaded: boolean; domains: number; error: string | null } {
  const d = disposableDomains();
  return { loaded: !!d, domains: d?.size ?? 0, error: disposableError };
}

/**
 * Whether an address belongs to a throwaway service: its domain or any parent
 * of it is on the list (mail.yopmail.com counts as yopmail.com). Null when the
 * list could not be read, so the caller can refuse rather than guess.
 */
export function isThrowawayEmail(email: string): boolean | null {
  const list = disposableDomains();
  if (!list) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return true;
  const parts = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (list.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- service ---

export interface ProAccount {
  id: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
}

export interface Allowance {
  kind: AllowanceKind;
  used: number;
  limit: number;
  remaining: number;
  /** The window that binds: the one with the least left. A pass's own month is 'month' here. */
  period: 'day' | 'week' | 'month';
  /** When that window starts again (a pass's month: 30 days on, or the pass's end). */
  resetAt: string;
}

/** The plan an account holds now, and the pass that gives it (its month is counted from it). */
export interface Holding {
  plan: PlanKind;
  pass: ProPass | null;
}

/** What take() hands back, so a refund touches exactly the counters it bumped. */
export interface Ticket {
  kind: AllowanceKind;
  keys: string[];
  n: number;
}

/**
 * The gift never expires unclaimed: offered stays offered until its holder starts it.
 *
 * The automatic gift (22 Nov 2026, PRO_AUTO_GIFT) adds, for a gift that
 * started by itself: `auto`; `welcome` while its holder has not been shown
 * that it is on; and once it has ended, `endCard` until its holder has been
 * shown the end card, with `made`: what they did with Pro during it.
 */
export type GiftState =
  | { state: 'none' }
  | { state: 'offered'; days: number }
  | { state: 'active'; endsAt: string; days: number; auto?: true; welcome?: true; offersOk?: boolean }
  | { state: 'used'; endedAt: string | null; auto?: true; endCard?: true; made?: GiftMade };

/** What a gift's holder did with Pro while it ran: the Pro items their exports carried, and the allowances they used. */
export interface GiftMade {
  /** Pro items that left the site in an export, by the item's own key (src/ui/proUse.ts), with how many times. */
  items: Record<string, number>;
  /** How many AI results (designs, reviews, cut-outs) the gift's own allowance gave. */
  ai: number;
}

/** The end card is offered for this long after an automatic gift ends. */
export const GIFT_END_CARD_DAYS = 14;
/** Pro items a gift remembers at most (they are a handful: this only bounds what a browser can send). */
export const GIFT_USE_KEYS = 12;
/** An item's key as the browser names it: one of the interface's own string keys. */
const USE_KEY = /^[a-z][A-Za-z0-9.]{1,39}$/;

export interface ProServiceOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** How many designs the account has saved (the gift waits for the first). */
  savedDesigns: (userId: string) => Promise<number>;
}

export class ProService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => Date;

  constructor(readonly repo: ProRepository, private readonly opts: ProServiceOptions) {
    this.env = opts.env ?? process.env;
    this.clock = opts.now ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  /** Whether the new rules apply to this account (PRO_MODE, PRO_PREVIEW_USERS). */
  live(username: string | null | undefined): boolean {
    return liveFor(username, this.env);
  }

  /** The plan an account holds now, and the pass that gives it. */
  async plan(userId: string): Promise<Holding> {
    const passes = await this.repo.activePasses(userId, this.now());
    if (!passes.length) return { plan: 'free', pass: null };
    const best = [...passes].sort((a, b) => PLAN_RANK[b.plan] - PLAN_RANK[a.plan] || Date.parse(b.endsAt) - Date.parse(a.endsAt))[0];
    return { plan: best.plan, pass: best };
  }

  windows(kind: AllowanceKind, plan: PlanKind): Window[] {
    return plan === 'free' ? FREE_WINDOWS[kind] : PLAN_WINDOWS[plan][kind];
  }

  /**
   * Where each window's count is kept and when it starts again. A pass's own
   * month ('cycle') is keyed by the pass; without one (a plan named with no
   * pass, which only a test does) it falls back to the calendar month.
   */
  private slots(wins: Window[], h: Holding, now: Date): { key: string; limit: number; end: Date; period: Allowance['period'] }[] {
    return wins.map((w) => {
      if (w.period === 'cycle') {
        if (h.pass) {
          const c = cycleOf(h.pass, now);
          return { key: c.key, limit: w.limit, end: c.end, period: 'month' };
        }
        return { key: periodKey('month', now), limit: w.limit, end: periodEnd('month', now), period: 'month' };
      }
      return { key: periodKey(w.period, now), limit: w.limit, end: periodEnd(w.period, now), period: w.period };
    });
  }

  private holding(h: Holding | PlanKind): Holding {
    return typeof h === 'string' ? { plan: h, pass: null } : h;
  }

  /** Spend `n` of an allowance, all windows or none. */
  async take(userId: string, kind: AllowanceKind, holding: Holding | PlanKind, n = 1): Promise<{ ok: boolean; ticket: Ticket; allowance: Allowance }> {
    const now = this.now();
    const h = this.holding(holding);
    const slots = this.slots(this.windows(kind, h.plan), h, now);
    const r = await this.repo.take(userId, kind, slots.map((s) => ({ key: s.key, limit: s.limit })), n);
    const ticket: Ticket = { kind, keys: r.ok ? slots.map((s) => s.key) : [], n: r.ok ? n : 0 };
    return { ok: r.ok, ticket, allowance: this.binding(kind, slots, r.used) };
  }

  /** Undo a take(): the result never reached the person. */
  async giveBack(userId: string, ticket: Ticket | null | undefined): Promise<void> {
    if (!ticket || !ticket.n || !ticket.keys.length) return;
    await this.repo.give(userId, ticket.kind, ticket.keys, ticket.n);
  }

  async allowance(userId: string, kind: AllowanceKind, holding: Holding | PlanKind): Promise<Allowance> {
    const now = this.now();
    const h = this.holding(holding);
    const slots = this.slots(this.windows(kind, h.plan), h, now);
    const used = await this.repo.used(userId, kind, slots.map((s) => s.key));
    return this.binding(kind, slots, used);
  }

  async allowances(userId: string, holding: Holding | PlanKind): Promise<Record<AllowanceKind, Allowance>> {
    const all = await Promise.all(ALLOWANCE_KINDS.map((k) => this.allowance(userId, k, holding)));
    return Object.fromEntries(all.map((a) => [a.kind, a])) as Record<AllowanceKind, Allowance>;
  }

  /**
   * The window that binds: the one with the least left; of two with as little
   * left, the one that starts again last (the day's ceiling and the month's
   * both at 0 is "back when the month is").
   */
  private binding(kind: AllowanceKind, slots: { limit: number; end: Date; period: Allowance['period'] }[], used: number[]): Allowance {
    const left = (i: number): number => slots[i].limit - (used[i] ?? 0);
    let best = 0;
    for (let i = 1; i < slots.length; i++) {
      if (left(i) < left(best) || (left(i) === left(best) && left(i) <= 0 && slots[i].end > slots[best].end)) best = i;
    }
    const w = slots[best];
    const u = Math.min(used[best] ?? 0, w.limit);
    return { kind, used: u, limit: w.limit, remaining: Math.max(0, w.limit - u), period: w.period, resetAt: w.end.toISOString() };
  }

  // ------------------------------------------------------------------ gift ---

  /**
   * Who may have the gift: a verified email that is not a throwaway address,
   * an account that has never held a paid or granted pass, and at least one
   * saved design. Refused when the throwaway list could not be read: one
   * person collecting a gift per throwaway address is the abuse this guards.
   *
   * With the automatic gift on (PRO_AUTO_GIFT), the saved design is not asked
   * for: that rule shut out all but 16 of 496 accounts (22 Nov 2026). The
   * verified email, the throwaway list and "never held Pro" all stay.
   */
  async giftEligible(acct: ProAccount): Promise<boolean> {
    if (!acct.emailVerified || !acct.email) return false;
    const throwaway = isThrowawayEmail(acct.email);
    if (throwaway !== false) return false;
    const passes = await this.repo.allPasses(acct.id);
    if (passes.some((p) => p.source !== 'gift')) return false;
    if (this.autoGift()) return true;
    return (await this.opts.savedDesigns(acct.id).catch(() => 0)) > 0;
  }

  /** The 7-day gift starts by itself (PRO_AUTO_GIFT=on). */
  autoGift(): boolean {
    return autoGiftOn(this.env);
  }

  /**
   * The gift as this account sees it, offering it first when they qualify.
   * Only for accounts the new rules apply to. An offer never lapses: it waits
   * until its holder starts it, however long that is.
   */
  async giftFor(acct: ProAccount, lang: 'en' | 'ar' | null = null): Promise<GiftState> {
    if (!this.live(acct.username)) return { state: 'none' };
    const now = this.now();
    let g: ProGift | null = await this.repo.gift(acct.id);
    if (!g) {
      if (!(await this.giftEligible(acct))) return { state: 'none' };
      g = await this.repo.offerGift(acct.id, now);
    }
    if (!g.acceptedAt) {
      // The automatic gift: it starts here, the first time its holder is on the site with a verified email
      // (a new account: as soon as the email is verified; an old one: its next visit, never unseen). An
      // offer made before the switch (the old Accept card) starts the same way, if its holder still qualifies.
      if (!this.autoGift() || !(await this.giftEligible(acct))) return { state: 'offered', days: OFFER.gift.days };
      const r = await this.repo.acceptGift(acct.id, now, OFFER.gift.days, { auto: true, lang });
      if (r.ok) console.log('[tifo] pro: a 7-day gift started by itself');
      g = (await this.repo.gift(acct.id)) ?? g;
      if (!g.acceptedAt) return { state: 'offered', days: OFFER.gift.days };
    }
    const pass = g.passId ? (await this.repo.allPasses(acct.id)).find((p) => p.id === g!.passId) ?? null : null;
    if (pass && !pass.revokedAt && Date.parse(pass.endsAt) > now.getTime()) {
      return {
        state: 'active', endsAt: pass.endsAt, days: OFFER.gift.days,
        ...(g.auto ? { auto: true as const, offersOk: !!g.offersOkAt } : {}), ...(g.auto && !g.welcomeAt ? { welcome: true as const } : {}),
      };
    }
    const endedAt = pass ? (pass.revokedAt ?? pass.endsAt) : null;
    const out: GiftState = { state: 'used', endedAt, ...(g.auto ? { auto: true as const } : {}) };
    // The end card: once, for a gift that started by itself and ran to its end in the last fortnight.
    if (g.auto && !g.endSeenAt && pass && !pass.revokedAt && endedAt && now.getTime() - Date.parse(endedAt) < GIFT_END_CARD_DAYS * 24 * 3600_000) {
      out.endCard = true;
      out.made = { items: g.uses, ai: await this.repo.passUse(acct.id, pass.id).catch(() => 0) };
    }
    return out;
  }

  /** The welcome ("Pro is on for 7 days") was shown: it is not shown again, on this device or another. */
  async giftWelcomed(acct: ProAccount): Promise<boolean> {
    if (!this.live(acct.username)) return false;
    return this.repo.giftMark(acct.id, 'welcome', this.now());
  }

  /** "Email me Pro's news and offers", ticked or unticked on the welcome or the account page. Never set for anyone. */
  async giftOffersOk(acct: ProAccount, ok: boolean): Promise<boolean> {
    if (!this.live(acct.username)) return false;
    return this.repo.giftOffersOk(acct.id, ok, this.now());
  }

  /** The end card was shown: once per gift. */
  async giftEndSeen(acct: ProAccount): Promise<boolean> {
    if (!this.live(acct.username)) return false;
    return this.repo.giftMark(acct.id, 'end', this.now());
  }

  /**
   * An export carrying these Pro items left the site while the gift ran: kept
   * for the end card ("what you made with Pro"). The browser's word, and it
   * gives nothing: it is only ever shown back to the same account. Counted
   * only while that account's gift is the Pro it holds.
   */
  async giftUsed(acct: ProAccount, keys: unknown): Promise<boolean> {
    if (!this.live(acct.username) || !Array.isArray(keys)) return false;
    const clean = [...new Set(keys.filter((k): k is string => typeof k === 'string' && USE_KEY.test(k)))].slice(0, GIFT_USE_KEYS);
    if (!clean.length) return false;
    const { plan, pass } = await this.plan(acct.id);
    if (plan !== 'gift' || !pass) return false;
    return this.repo.giftUse(acct.id, clean, GIFT_USE_KEYS);
  }

  /**
   * The offer was put in front of its holder (the card on My projects, or the
   * gift sheet). Only an offer that exists and is waiting is marked; it makes
   * no offer and changes nothing the account can do.
   */
  async giftShown(acct: ProAccount): Promise<boolean> {
    if (!this.live(acct.username)) return false;
    const g = await this.repo.gift(acct.id);
    if (!g || g.acceptedAt || g.seenAt) return false;
    return this.repo.giftSeen(acct.id, this.now());
  }

  /** Accept the gift. Every rule is checked again here; the browser decides nothing. */
  async acceptGift(acct: ProAccount): Promise<{ ok: true; endsAt: string } | { ok: false; reason: 'off' | 'not_eligible' | 'used' }> {
    if (!this.live(acct.username)) return { ok: false, reason: 'off' };
    const state = await this.giftFor(acct);
    if (state.state === 'none') return { ok: false, reason: 'not_eligible' };
    if (state.state !== 'offered') return { ok: false, reason: 'used' };
    // Eligibility can change after the offer (a pass bought, the email changed).
    if (!(await this.giftEligible(acct))) return { ok: false, reason: 'not_eligible' };
    const r = await this.repo.acceptGift(acct.id, this.now(), OFFER.gift.days);
    if (!r.ok) return { ok: false, reason: r.reason === 'none' ? 'not_eligible' : 'used' };
    return { ok: true, endsAt: r.pass.endsAt };
  }

  /** Accounts showing the Supporter crown (a paid pass, now). Empty while Pro is off. */
  async supporters(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    return this.repo.supporters(userIds, this.now());
  }

  isPaid(plan: PlanKind): boolean {
    return (PAID_PLANS as string[]).includes(plan);
  }
}

export type { PassPlan };
