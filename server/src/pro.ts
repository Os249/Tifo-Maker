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
  ALLOWANCE_KINDS, FREE_WINDOWS, OFFER, PAID_PLANS, PLAN_RANK, PLAN_WINDOWS, liveFor, periodEnd, periodKey,
  type AllowanceKind, type PassPlan, type Period, type PlanKind, type Window,
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
  /** The window that binds: the one with the least left. */
  period: Period;
  /** When that window starts again. */
  resetAt: string;
}

/** What take() hands back, so a refund touches exactly the counters it bumped. */
export interface Ticket {
  kind: AllowanceKind;
  keys: string[];
  n: number;
}

export type GiftState =
  | { state: 'none' }
  | { state: 'offered'; claimBy: string; days: number }
  | { state: 'active'; endsAt: string; days: number }
  | { state: 'used'; endedAt: string | null }
  | { state: 'expired' };

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
  async plan(userId: string): Promise<{ plan: PlanKind; pass: ProPass | null }> {
    const passes = await this.repo.activePasses(userId, this.now());
    if (!passes.length) return { plan: 'free', pass: null };
    const best = [...passes].sort((a, b) => PLAN_RANK[b.plan] - PLAN_RANK[a.plan] || Date.parse(b.endsAt) - Date.parse(a.endsAt))[0];
    return { plan: best.plan, pass: best };
  }

  windows(kind: AllowanceKind, plan: PlanKind): Window[] {
    return plan === 'free' ? FREE_WINDOWS[kind] : PLAN_WINDOWS[plan][kind];
  }

  /** Spend `n` of an allowance, all windows or none. */
  async take(userId: string, kind: AllowanceKind, plan: PlanKind, n = 1): Promise<{ ok: boolean; ticket: Ticket; allowance: Allowance }> {
    const now = this.now();
    const wins = this.windows(kind, plan);
    const slots = wins.map((w) => ({ key: periodKey(w.period, now), limit: w.limit }));
    const r = await this.repo.take(userId, kind, slots, n);
    const ticket: Ticket = { kind, keys: r.ok ? slots.map((s) => s.key) : [], n: r.ok ? n : 0 };
    return { ok: r.ok, ticket, allowance: this.binding(kind, wins, r.used, now) };
  }

  /** Undo a take(): the result never reached the person. */
  async giveBack(userId: string, ticket: Ticket | null | undefined): Promise<void> {
    if (!ticket || !ticket.n || !ticket.keys.length) return;
    await this.repo.give(userId, ticket.kind, ticket.keys, ticket.n);
  }

  async allowance(userId: string, kind: AllowanceKind, plan: PlanKind): Promise<Allowance> {
    const now = this.now();
    const wins = this.windows(kind, plan);
    const used = await this.repo.used(userId, kind, wins.map((w) => periodKey(w.period, now)));
    return this.binding(kind, wins, used, now);
  }

  async allowances(userId: string, plan: PlanKind): Promise<Record<AllowanceKind, Allowance>> {
    const all = await Promise.all(ALLOWANCE_KINDS.map((k) => this.allowance(userId, k, plan)));
    return Object.fromEntries(all.map((a) => [a.kind, a])) as Record<AllowanceKind, Allowance>;
  }

  private binding(kind: AllowanceKind, wins: Window[], used: number[], now: Date): Allowance {
    let best = 0;
    for (let i = 1; i < wins.length; i++) {
      if (wins[i].limit - (used[i] ?? 0) < wins[best].limit - (used[best] ?? 0)) best = i;
    }
    const w = wins[best];
    const u = Math.min(used[best] ?? 0, w.limit);
    return { kind, used: u, limit: w.limit, remaining: Math.max(0, w.limit - u), period: w.period, resetAt: periodEnd(w.period, now).toISOString() };
  }

  // ------------------------------------------------------------------ gift ---

  /**
   * Who may have the gift: a verified email that is not a throwaway address,
   * an account that has never held a paid or granted pass, and at least one
   * saved design. Refused when the throwaway list could not be read: one
   * person collecting a gift per throwaway address is the abuse this guards.
   */
  async giftEligible(acct: ProAccount): Promise<boolean> {
    if (!acct.emailVerified || !acct.email) return false;
    const throwaway = isThrowawayEmail(acct.email);
    if (throwaway !== false) return false;
    const passes = await this.repo.allPasses(acct.id);
    if (passes.some((p) => p.source !== 'gift')) return false;
    return (await this.opts.savedDesigns(acct.id).catch(() => 0)) > 0;
  }

  /**
   * The gift as this account sees it, offering it first when they qualify.
   * Only for accounts the new rules apply to.
   */
  async giftFor(acct: ProAccount): Promise<GiftState> {
    if (!this.live(acct.username)) return { state: 'none' };
    const now = this.now();
    let g: ProGift | null = await this.repo.gift(acct.id);
    if (!g) {
      if (Date.parse(OFFER.gift.claimBy) <= now.getTime()) return { state: 'none' };
      if (!(await this.giftEligible(acct))) return { state: 'none' };
      g = await this.repo.offerGift(acct.id, new Date(OFFER.gift.claimBy), now);
    }
    if (!g.acceptedAt) {
      if (Date.parse(g.claimBy) <= now.getTime()) return { state: 'expired' };
      return { state: 'offered', claimBy: g.claimBy, days: OFFER.gift.days };
    }
    const pass = g.passId ? (await this.repo.allPasses(acct.id)).find((p) => p.id === g!.passId) ?? null : null;
    if (pass && !pass.revokedAt && Date.parse(pass.endsAt) > now.getTime()) {
      return { state: 'active', endsAt: pass.endsAt, days: OFFER.gift.days };
    }
    return { state: 'used', endedAt: pass ? (pass.revokedAt ?? pass.endsAt) : null };
  }

  /** Accept the gift. Every rule is checked again here; the browser decides nothing. */
  async acceptGift(acct: ProAccount): Promise<{ ok: true; endsAt: string } | { ok: false; reason: 'off' | 'not_eligible' | 'used' | 'expired' }> {
    if (!this.live(acct.username)) return { ok: false, reason: 'off' };
    const state = await this.giftFor(acct);
    if (state.state === 'none') return { ok: false, reason: 'not_eligible' };
    if (state.state === 'expired') return { ok: false, reason: 'expired' };
    if (state.state !== 'offered') return { ok: false, reason: 'used' };
    // Eligibility can change after the offer (a pass bought, the email changed).
    if (!(await this.giftEligible(acct))) return { ok: false, reason: 'not_eligible' };
    const r = await this.repo.acceptGift(acct.id, this.now(), OFFER.gift.days);
    if (!r.ok) return { ok: false, reason: r.reason === 'expired' ? 'expired' : r.reason === 'none' ? 'not_eligible' : 'used' };
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
