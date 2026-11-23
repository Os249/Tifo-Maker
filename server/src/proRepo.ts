/**
 * Where Pro is kept: passes, the 7-day gift, the allowance counters and the
 * "tell me when Pro opens" list. In memory for development and tests, in
 * Postgres in production (tables in schema.sql, "Pro" at the end).
 *
 * Two promises every implementation keeps, because money and fairness rest on
 * them:
 *  - take() is all-or-nothing and safe under concurrent calls: two requests
 *    racing for the last Super design cannot both get it, and a request that
 *    passes the day's ceiling but not the month's takes neither.
 *  - acceptGift() succeeds once per account, ever. The gift row is keyed by
 *    the account and only moves from offered to accepted.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AllowanceKind, PassPlan } from './proPlan';
import { CROWN_PLANS, LEGACY_PAID_PLANS, PASS_PLANS, normalizePlan } from './proPlan';
import type { PriceCounted, PriceCurrency, PriceSource } from './proPrice';

export interface ProPass {
  id: string;
  userId: string;
  plan: PassPlan;
  startsAt: string;
  endsAt: string;
  /** 'gift' (accepted gift), 'admin' (granted by hand), 'payment' (bought). */
  source: 'gift' | 'admin' | 'payment';
  createdAt: string;
  revokedAt: string | null;
}

/** The 7-day gift. It has no claim-by date: an offer waits until it is started. */
export interface ProGift {
  userId: string;
  offeredAt: string;
  /** When the offer was first shown to its holder; null if never, or shown before this was recorded. */
  seenAt: string | null;
  acceptedAt: string | null;
  passId: string | null;
  /** It started by itself (PRO_AUTO_GIFT), not from the Accept button. */
  auto: boolean;
  /** The language its holder was reading when it started, when the browser said (the emails are in both anyway). */
  lang: 'en' | 'ar' | null;
  /** When its holder was shown that Pro is on (the welcome), and the end card. */
  welcomeAt: string | null;
  endSeenAt: string | null;
  /** Pro items its holder's exports carried while it ran, by the interface's key, with how many times. */
  uses: Record<string, number>;
  /** When its holder ticked "email me Pro's news and offers" (null: never, or unticked since). */
  offersOkAt: string | null;
}

/** The gift's three emails (proGift.ts): it started, it ends in about a day, it ended. */
export type GiftMailKind = 'start' | 'soon' | 'end';
export const GIFT_MAIL_KINDS: GiftMailKind[] = ['start', 'soon', 'end'];

/** A gift one of the emails is due for. */
export interface GiftDue {
  userId: string;
  lang: 'en' | 'ar' | null;
  /** For the email's "stop these emails" link. */
  stopToken: string;
  startsAt: string;
  endsAt: string;
  uses: Record<string, number>;
  /** Its holder asked for Pro's news and offers by email: the email after the gift may then carry a price. */
  offersOk: boolean;
}

/** A started gift as /admin counts it. */
export interface GiftRow {
  userId: string;
  auto: boolean;
  startedAt: string;
  /** When its pass ends or ended (null: the pass is gone). */
  endsAt: string | null;
}

const newStopToken = (): string => randomBytes(24).toString('base64url');

/** A pass as /admin's Members tab lists it: whose it is, who gave it, how much of Pro it has used. */
export interface ProMemberPass extends ProPass {
  /** null when the account has been renamed away or deleted. */
  username: string | null;
  /** A pass given by hand: the admin account that gave it, when the admin was signed in. */
  givenBy: string | null;
  /** What its months have spent of Pro's allowances (passUse). */
  used: number;
}

/** One counter to bump: the stored key of a period and its ceiling. */
export interface AllowanceSlot {
  key: string;
  limit: number;
}

export interface ProStats {
  /**
   * offered: accounts the server found eligible (a row exists). seen: of those,
   * the ones the offer was shown to, or who started it. seenSince: the first
   * time a showing was recorded (null: never), since offers shown earlier have no mark.
   */
  gifts: { offered: number; seen: number; seenSince: string | null; accepted: number; active: number };
  passes: Record<PassPlan, number>;
  /** Accounts on the "tell me when Pro opens" list. */
  notify: number;
  /** Of those, the ones with an answer to the price question (answering adds the account to the list), and how many of them said "not for me". */
  notifyVia: { price: number; wontPay: number };
}

/** One answer to "what would you pay for a month of Pro?" (proPrice.ts). */
export interface PriceAnswer {
  amount: number;
  currency: PriceCurrency;
  lang: 'en' | 'ar';
  comment: string | null;
  /** "Not for me" (amount 0). */
  wontPay: boolean;
  /** Where it was given: the /pro page or the editor's card. */
  source: PriceSource;
  createdAt: string;
  updatedAt: string;
}

/** An answer as /admin lists it: whose it was, if anyone's. */
export interface PriceAnswerRow extends PriceAnswer {
  /** The account that answered; null for a visitor who was signed out (or an account since renamed away). */
  username: string | null;
}

export interface PriceAnswerPut {
  /** proPrice accountVoter() or deviceVoter(). */
  voter: string;
  userId: string | null;
  amount: number;
  currency: PriceCurrency;
  lang: 'en' | 'ar';
  comment: string | null;
  wontPay: boolean;
  source: PriceSource;
  /** A browser's voter whose answer this one replaces too: answered signed out, then signed in. */
  absorb: string | null;
  /** Answers kept at most: a new voter past it is turned away ('full'). */
  max: number;
}

export interface ProRepository {
  /**
   * Add `n` to every slot, or to none. ok=false when any slot would pass its
   * limit; `used` is what each slot holds after (or still holds, on refusal).
   */
  take(userId: string, kind: AllowanceKind, slots: AllowanceSlot[], n: number): Promise<{ ok: boolean; used: number[] }>;
  /** Hand back what take() added (the result was not delivered). Never below 0. */
  give(userId: string, kind: AllowanceKind, keys: string[], n: number): Promise<void>;
  used(userId: string, kind: AllowanceKind, keys: string[]): Promise<number[]>;

  activePasses(userId: string, now: Date): Promise<ProPass[]>;
  allPasses(userId: string): Promise<ProPass[]>;
  grantPass(p: { userId: string; plan: PassPlan; startsAt: Date; endsAt: Date; source: ProPass['source']; createdBy: string | null }): Promise<ProPass>;
  revokePass(passId: string, now: Date): Promise<boolean>;
  /** Of these accounts, the ones holding a paid pass right now. */
  supporters(userIds: string[], now: Date): Promise<Set<string>>;

  gift(userId: string): Promise<ProGift | null>;
  /** Create the offer if there is none; return whatever is there. */
  offerGift(userId: string, now: Date): Promise<ProGift>;
  /** The offer was shown to its holder: kept the first time only. False when there is no offer or it was already marked. */
  giftSeen(userId: string, now: Date): Promise<boolean>;
  /**
   * Turn an offered gift into a pass of `days` days starting now. Refused when
   * there is no offer or it was already accepted.
   */
  acceptGift(userId: string, now: Date, days: number, how?: { auto?: boolean; lang?: 'en' | 'ar' | null }): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' }>;
  /** The welcome or the end card was shown: kept the first time only. False when there is no started gift or it was marked already. */
  giftMark(userId: string, which: 'welcome' | 'end', now: Date): Promise<boolean>;
  /** Count one more use of each of these Pro items on the account's gift. At most `maxKeys` different items are kept. */
  giftUse(userId: string, keys: string[], maxKeys: number): Promise<boolean>;
  /** "Email me Pro's news and offers", ticked or unticked by the gift's holder. False when there is no started gift. */
  giftOffersOk(userId: string, ok: boolean, now: Date): Promise<boolean>;
  /**
   * Automatic gifts one of the emails is due for and has not had:
   *   start  started in the last day, still running;
   *   soon   ends between `soonFrom` and `soonTo` from now (about a day);
   *   end    ended in the last two days, by running out (not taken back).
   */
  giftsDue(kind: GiftMailKind, now: Date, limit: number): Promise<GiftDue[]>;
  /** Take a gift's email to send it: one caller gets it, ever. And give it back when the mail service refused the message. */
  claimGiftMail(userId: string, kind: GiftMailKind, now: Date): Promise<boolean>;
  unclaimGiftMail(userId: string, kind: GiftMailKind): Promise<void>;
  /** Whose gift a "stop these emails" link belongs to. */
  giftByStopToken(token: string): Promise<string | null>;
  /** "Stop these emails": the account gets no more of Pro's news and offers (the same list the founders email keeps). */
  stopMail(userId: string, now: Date, via: string): Promise<void>;
  mailStopped(userId: string): Promise<boolean>;
  /** Every gift that was started, for /admin's counts. */
  giftRows(limit: number): Promise<GiftRow[]>;

  /** Record "tell me when Pro opens". Returns false when already recorded. */
  notify(userId: string): Promise<boolean>;
  notified(userId: string): Promise<boolean>;

  /**
   * Keep a voter's answer to the price question, replacing any earlier one
   * of theirs (and the absorbed browser's). 'full' when `max` answers are
   * kept already and this voter has none: nobody's answer is pushed out.
   */
  putPriceAnswer(a: PriceAnswerPut): Promise<'saved' | 'full'>;
  priceAnswer(voter: string): Promise<PriceAnswer | null>;
  /** Every answer's amount (for the summary) and the newest `limit` in full, newest first. */
  priceAnswers(limit: number): Promise<{ all: PriceCounted[]; newest: PriceAnswerRow[] }>;
  /** How many answers there are (the page's "N fans have answered"). */
  priceCount(): Promise<number>;

  stats(now: Date): Promise<ProStats>;
  /** Every pass ever given, the newest first, for /admin's Members tab. */
  members(limit: number): Promise<ProMemberPass[]>;
  /** How much of any allowance one pass's months have used (a refund asks: was Pro used?). */
  passUse(userId: string, passId: string): Promise<number>;
  /** Drop allowance counters nobody has touched for this long. */
  purgeAllowances(before: Date): Promise<number>;
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

// ---------------------------------------------------------------- memory ---

export class MemoryProRepository implements ProRepository {
  private counters = new Map<string, { used: number; at: number }>();
  private passes: ProPass[] = [];
  /** Who gave each pass that was given by hand (pass id to admin account id). */
  private givers = new Map<string, string>();
  private gifts = new Map<string, ProGift>();
  private giftMails = new Map<string, Partial<Record<GiftMailKind, string>>>();
  private stopTokens = new Map<string, string>();
  private mailStops = new Set<string>();
  private notifies = new Set<string>();
  private prices = new Map<string, PriceAnswer & { userId: string | null; seq: number }>();
  private priceSeq = 0;

  /** `nameOf` names an account for /admin's list (the memory auth store's usernameOf). */
  constructor(private readonly nameOf: (userId: string) => string | null = () => null) {}

  private ck(userId: string, kind: AllowanceKind, key: string): string {
    return `${userId}|${kind}|${key}`;
  }

  async take(userId: string, kind: AllowanceKind, slots: AllowanceSlot[], n: number): Promise<{ ok: boolean; used: number[] }> {
    // Synchronous from here on: nothing can interleave inside one call.
    const now = slots.map((s) => this.counters.get(this.ck(userId, kind, s.key))?.used ?? 0);
    const fits = slots.every((s, i) => n >= 0 && now[i] + n <= s.limit);
    if (!fits) return { ok: false, used: now };
    const after = now.map((u, i) => {
      const v = u + n;
      this.counters.set(this.ck(userId, kind, slots[i].key), { used: v, at: Date.now() });
      return v;
    });
    return { ok: true, used: after };
  }

  async give(userId: string, kind: AllowanceKind, keys: string[], n: number): Promise<void> {
    for (const key of keys) {
      const k = this.ck(userId, kind, key);
      const c = this.counters.get(k);
      if (c) c.used = Math.max(0, c.used - n);
    }
  }

  async used(userId: string, kind: AllowanceKind, keys: string[]): Promise<number[]> {
    return keys.map((key) => this.counters.get(this.ck(userId, kind, key))?.used ?? 0);
  }

  async activePasses(userId: string, now: Date): Promise<ProPass[]> {
    const t = now.getTime();
    return this.passes.filter(
      (p) => p.userId === userId && !p.revokedAt && Date.parse(p.startsAt) <= t && Date.parse(p.endsAt) > t,
    );
  }

  async allPasses(userId: string): Promise<ProPass[]> {
    return this.passes.filter((p) => p.userId === userId);
  }

  async grantPass(p: { userId: string; plan: PassPlan; startsAt: Date; endsAt: Date; source: ProPass['source']; createdBy: string | null }): Promise<ProPass> {
    const pass: ProPass = {
      id: randomUUID(),
      userId: p.userId,
      plan: p.plan,
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      source: p.source,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.passes.push(pass);
    if (p.createdBy) this.givers.set(pass.id, p.createdBy);
    return pass;
  }

  async revokePass(passId: string, now: Date): Promise<boolean> {
    const p = this.passes.find((x) => x.id === passId);
    if (!p || p.revokedAt) return false;
    p.revokedAt = now.toISOString();
    return true;
  }

  async supporters(userIds: string[], now: Date): Promise<Set<string>> {
    const out = new Set<string>();
    const want = new Set(userIds);
    const t = now.getTime();
    for (const p of this.passes) {
      if (want.has(p.userId) && !p.revokedAt && CROWN_PLANS.includes(p.plan) && Date.parse(p.startsAt) <= t && Date.parse(p.endsAt) > t) {
        out.add(p.userId);
      }
    }
    return out;
  }

  async gift(userId: string): Promise<ProGift | null> {
    const g = this.gifts.get(userId);
    return g ? { ...g } : null;
  }

  async offerGift(userId: string, now: Date): Promise<ProGift> {
    const have = this.gifts.get(userId);
    if (have) return { ...have };
    const g: ProGift = { userId, offeredAt: now.toISOString(), seenAt: null, acceptedAt: null, passId: null, auto: false, lang: null, welcomeAt: null, endSeenAt: null, uses: {}, offersOkAt: null };
    this.gifts.set(userId, g);
    this.stopTokens.set(userId, newStopToken());
    return { ...g };
  }

  async giftSeen(userId: string, now: Date): Promise<boolean> {
    const g = this.gifts.get(userId);
    if (!g || g.seenAt) return false;
    g.seenAt = now.toISOString();
    return true;
  }

  async acceptGift(userId: string, now: Date, days: number, how: { auto?: boolean; lang?: 'en' | 'ar' | null } = {}): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' }> {
    const g = this.gifts.get(userId);
    if (!g) return { ok: false, reason: 'none' };
    if (g.acceptedAt) return { ok: false, reason: 'used' };
    // Marked before the pass exists, so a second call in the same tick is refused.
    g.acceptedAt = now.toISOString();
    g.auto = how.auto === true;
    g.lang = how.lang ?? null;
    const pass = await this.grantPass({
      userId, plan: 'gift', startsAt: now, endsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000), source: 'gift', createdBy: null,
    });
    g.passId = pass.id;
    return { ok: true, pass };
  }

  async giftMark(userId: string, which: 'welcome' | 'end', now: Date): Promise<boolean> {
    const g = this.gifts.get(userId);
    if (!g || !g.acceptedAt) return false;
    if (which === 'welcome') {
      if (g.welcomeAt) return false;
      g.welcomeAt = now.toISOString();
    } else {
      if (g.endSeenAt) return false;
      g.endSeenAt = now.toISOString();
    }
    return true;
  }

  async giftUse(userId: string, keys: string[], maxKeys: number): Promise<boolean> {
    const g = this.gifts.get(userId);
    if (!g || !g.acceptedAt) return false;
    let any = false;
    for (const k of keys) {
      if (!(k in g.uses) && Object.keys(g.uses).length >= maxKeys) continue;
      g.uses[k] = Math.min(999, (g.uses[k] ?? 0) + 1);
      any = true;
    }
    return any;
  }

  async giftOffersOk(userId: string, ok: boolean, now: Date): Promise<boolean> {
    const g = this.gifts.get(userId);
    if (!g || !g.acceptedAt) return false;
    g.offersOkAt = ok ? now.toISOString() : null;
    return true;
  }

  async giftsDue(kind: GiftMailKind, now: Date, limit: number): Promise<GiftDue[]> {
    const t = now.getTime();
    const out: GiftDue[] = [];
    for (const g of this.gifts.values()) {
      if (!g.auto || !g.acceptedAt || !g.passId || this.giftMails.get(g.userId)?.[kind]) continue;
      const p = this.passes.find((x) => x.id === g.passId);
      if (!p || p.revokedAt) continue;
      if (!giftMailDue(kind, Date.parse(g.acceptedAt), Date.parse(p.endsAt), t)) continue;
      out.push({ userId: g.userId, lang: g.lang, stopToken: this.stopTokens.get(g.userId) ?? '', startsAt: p.startsAt, endsAt: p.endsAt, uses: { ...g.uses }, offersOk: !!g.offersOkAt });
      if (out.length >= limit) break;
    }
    return out;
  }

  async claimGiftMail(userId: string, kind: GiftMailKind, now: Date): Promise<boolean> {
    const m = this.giftMails.get(userId) ?? {};
    if (m[kind] || !this.gifts.has(userId)) return false;
    m[kind] = now.toISOString();
    this.giftMails.set(userId, m);
    return true;
  }

  async unclaimGiftMail(userId: string, kind: GiftMailKind): Promise<void> {
    const m = this.giftMails.get(userId);
    if (m) delete m[kind];
  }

  /** When each of a gift's emails was taken to be sent (the tests read it). */
  giftMailsOf(userId: string): Partial<Record<GiftMailKind, string>> {
    return { ...(this.giftMails.get(userId) ?? {}) };
  }

  async giftByStopToken(token: string): Promise<string | null> {
    for (const [userId, tok] of this.stopTokens) if (tok === token) return userId;
    return null;
  }

  async stopMail(userId: string): Promise<void> {
    this.mailStops.add(userId);
  }

  async mailStopped(userId: string): Promise<boolean> {
    return this.mailStops.has(userId);
  }

  async giftRows(limit: number): Promise<GiftRow[]> {
    const out: GiftRow[] = [];
    for (const g of this.gifts.values()) {
      if (!g.acceptedAt) continue;
      const p = g.passId ? this.passes.find((x) => x.id === g.passId) : undefined;
      out.push({ userId: g.userId, auto: g.auto, startedAt: g.acceptedAt, endsAt: p ? (p.revokedAt ?? p.endsAt) : null });
      if (out.length >= limit) break;
    }
    return out;
  }

  async notify(userId: string): Promise<boolean> {
    if (this.notifies.has(userId)) return false;
    this.notifies.add(userId);
    return true;
  }

  async notified(userId: string): Promise<boolean> {
    return this.notifies.has(userId);
  }

  /** The accounts on the "tell me when Pro opens" list (the memory launch store reads the founders from here). */
  notifyIds(): string[] {
    return [...this.notifies];
  }

  /** The accounts that answered the price question while signed in. */
  priceUserIds(): string[] {
    return [...new Set([...this.prices.values()].map((p) => p.userId).filter((id): id is string => !!id))];
  }

  async putPriceAnswer(a: PriceAnswerPut): Promise<'saved' | 'full'> {
    const had = this.prices.get(a.voter);
    const absorbed = a.absorb && a.absorb !== a.voter ? this.prices.get(a.absorb) : undefined;
    if (!had && !absorbed && this.prices.size >= a.max) return 'full';
    if (absorbed) this.prices.delete(a.absorb!);
    const now = new Date().toISOString();
    this.prices.set(a.voter, {
      amount: a.amount, currency: a.currency, lang: a.lang, comment: a.comment, wontPay: a.wontPay, source: a.source, userId: a.userId,
      createdAt: had?.createdAt ?? absorbed?.createdAt ?? now, updatedAt: now, seq: ++this.priceSeq,
    });
    return 'saved';
  }

  async priceAnswer(voter: string): Promise<PriceAnswer | null> {
    const p = this.prices.get(voter);
    return p ? { amount: p.amount, currency: p.currency, lang: p.lang, comment: p.comment, wontPay: p.wontPay, source: p.source, createdAt: p.createdAt, updatedAt: p.updatedAt } : null;
  }

  async priceCount(): Promise<number> {
    return this.prices.size;
  }

  async priceAnswers(limit: number): Promise<{ all: PriceCounted[]; newest: PriceAnswerRow[] }> {
    const rows = [...this.prices.values()].sort((x, y) => y.seq - x.seq);
    return {
      all: rows.map((p) => ({ amount: p.amount, currency: p.currency, account: !!p.userId, wontPay: p.wontPay, source: p.source })),
      newest: rows.slice(0, limit).map((p) => ({
        amount: p.amount, currency: p.currency, lang: p.lang, comment: p.comment, wontPay: p.wontPay, source: p.source, createdAt: p.createdAt, updatedAt: p.updatedAt,
        username: p.userId ? this.nameOf(p.userId) : null,
      })),
    };
  }

  async stats(now: Date): Promise<ProStats> {
    const t = now.getTime();
    const live = this.passes.filter((p) => !p.revokedAt && Date.parse(p.startsAt) <= t && Date.parse(p.endsAt) > t);
    const passes = Object.fromEntries(PASS_PLANS.map((pl) => [pl, live.filter((p) => p.plan === pl).length])) as Record<PassPlan, number>;
    const gifts = [...this.gifts.values()];
    const marks = gifts.map((g) => g.seenAt).filter((x): x is string => !!x).sort();
    const answered = [...this.prices.values()].filter((a) => a.userId && this.notifies.has(a.userId));
    return {
      gifts: {
        offered: gifts.length,
        seen: gifts.filter((g) => g.seenAt || g.acceptedAt).length,
        seenSince: marks[0] ?? null,
        accepted: gifts.filter((g) => g.acceptedAt).length,
        active: passes.gift,
      },
      passes,
      notify: this.notifies.size,
      notifyVia: { price: new Set(answered.map((a) => a.userId)).size, wontPay: new Set(answered.filter((a) => a.wontPay).map((a) => a.userId)).size },
    };
  }

  async members(limit: number): Promise<ProMemberPass[]> {
    const rows = [...this.passes].reverse().slice(0, limit);
    return Promise.all(rows.map(async (p) => ({
      ...p,
      username: this.nameOf(p.userId) || null,
      givenBy: this.givers.has(p.id) ? this.nameOf(this.givers.get(p.id)!) || null : null,
      used: await this.passUse(p.userId, p.id),
    })));
  }

  async passUse(userId: string, passId: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.counters) {
      const [u, , key] = k.split('|');
      if (u === userId && key?.startsWith(`c:${passId}:`)) n += v.used;
    }
    return n;
  }

  async purgeAllowances(before: Date): Promise<number> {
    let n = 0;
    for (const [k, v] of this.counters) {
      if (v.at < before.getTime()) {
        this.counters.delete(k);
        n++;
      }
    }
    return n;
  }
}

// -------------------------------------------------------------- postgres ---

export function rowToPass(r: Record<string, unknown>): ProPass {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    // A pass granted before Pro became one plan reads as a month of Pro.
    plan: normalizePlan(String(r.plan)),
    startsAt: iso(r.starts_at as string)!,
    endsAt: iso(r.ends_at as string)!,
    source: String(r.source) as ProPass['source'],
    createdAt: iso(r.created_at as string)!,
    revokedAt: iso(r.revoked_at as string | null),
  };
}

/** The items a gift's holder used, as stored: a flat object of small counts. Anything else reads as none. */
function usesOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = Math.min(999, Math.floor(n));
  }
  return out;
}

function rowToGift(r: Record<string, unknown>): ProGift {
  return {
    userId: String(r.user_id),
    offeredAt: iso(r.offered_at as string)!,
    seenAt: iso((r.seen_at ?? null) as string | null),
    acceptedAt: iso(r.accepted_at as string | null),
    passId: r.pass_id ? String(r.pass_id) : null,
    auto: r.auto === true,
    lang: r.lang === 'ar' ? 'ar' : r.lang === 'en' ? 'en' : null,
    welcomeAt: iso((r.welcome_at ?? null) as string | null),
    endSeenAt: iso((r.end_seen_at ?? null) as string | null),
    uses: usesOf(r.uses),
    offersOkAt: iso((r.offers_ok_at ?? null) as string | null),
  };
}

const GIFT_COLS = 'user_id, offered_at, seen_at, accepted_at, pass_id, auto, lang, welcome_at, end_seen_at, uses, offers_ok_at';

const HOUR_MS = 3600_000;
/** The start email is for a gift no older than this. */
export const GIFT_START_MAIL_HOURS = 24;
/** The "ends soon" email goes out when this much or less is left, and not with less than GIFT_SOON_MIN_HOURS. */
export const GIFT_SOON_HOURS = 26;
export const GIFT_SOON_MIN_HOURS = 6;
/** The "it ended" email is for a gift that ended no longer ago than this. */
export const GIFT_END_MAIL_HOURS = 48;

/** Whether a gift that started at `started` and ends at `ends` is due its `kind` of email at `t` (all ms). */
export function giftMailDue(kind: GiftMailKind, started: number, ends: number, t: number): boolean {
  if (kind === 'start') return ends > t && t - started <= GIFT_START_MAIL_HOURS * HOUR_MS;
  if (kind === 'soon') return ends - t <= GIFT_SOON_HOURS * HOUR_MS && ends - t >= GIFT_SOON_MIN_HOURS * HOUR_MS;
  return ends <= t && t - ends <= GIFT_END_MAIL_HOURS * HOUR_MS;
}

const MAIL_COL: Record<GiftMailKind, string> = { start: 'mail_start_at', soon: 'mail_soon_at', end: 'mail_end_at' };

export const PASS_COLS = 'id, user_id, plan, starts_at, ends_at, source, created_at, revoked_at';

function rowToPrice(r: Record<string, unknown>): PriceAnswer {
  return {
    // NUMERIC arrives as a string ("15.50"): a number again here.
    amount: Number(r.amount),
    currency: String(r.currency) as PriceCurrency,
    lang: r.lang === 'ar' ? 'ar' : 'en',
    comment: r.comment == null ? null : String(r.comment),
    wontPay: r.wont_pay === true,
    source: r.source === 'editor' ? 'editor' : 'page',
    createdAt: iso(r.created_at as string)!,
    updatedAt: iso(r.updated_at as string)!,
  };
}

export class PgProRepository implements ProRepository {
  constructor(private readonly pool: pg.Pool) {}

  async take(userId: string, kind: AllowanceKind, slots: AllowanceSlot[], n: number): Promise<{ ok: boolean; used: number[] }> {
    if (!slots.length) return { ok: true, used: [] };
    if (n < 0 || slots.some((s) => n > s.limit)) return { ok: false, used: await this.used(userId, kind, slots.map((s) => s.key)) };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const used: number[] = [];
      for (const s of slots) {
        // Insert at n (n <= limit was checked above) or add n while it fits.
        // A row that would pass its limit is left alone and returns nothing.
        const r = await client.query(
          `INSERT INTO pro_allowance (user_id, kind, period, used) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, kind, period) DO UPDATE
             SET used = pro_allowance.used + EXCLUDED.used, updated_at = now()
             WHERE pro_allowance.used + EXCLUDED.used <= $5
           RETURNING used`,
          [userId, kind, s.key, n, s.limit],
        );
        if (!r.rows[0]) {
          await client.query('ROLLBACK');
          return { ok: false, used: await this.used(userId, kind, slots.map((x) => x.key)) };
        }
        used.push(Number(r.rows[0].used));
      }
      await client.query('COMMIT');
      return { ok: true, used };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async give(userId: string, kind: AllowanceKind, keys: string[], n: number): Promise<void> {
    if (!keys.length || n <= 0) return;
    await this.pool.query(
      `UPDATE pro_allowance SET used = GREATEST(0, used - $4), updated_at = now()
       WHERE user_id = $1 AND kind = $2 AND period = ANY($3::text[])`,
      [userId, kind, keys, n],
    );
  }

  async used(userId: string, kind: AllowanceKind, keys: string[]): Promise<number[]> {
    if (!keys.length) return [];
    const r = await this.pool.query(
      'SELECT period, used FROM pro_allowance WHERE user_id = $1 AND kind = $2 AND period = ANY($3::text[])',
      [userId, kind, keys],
    );
    const by = new Map<string, number>(r.rows.map((x) => [String(x.period), Number(x.used)]));
    return keys.map((k) => by.get(k) ?? 0);
  }

  async activePasses(userId: string, now: Date): Promise<ProPass[]> {
    const r = await this.pool.query(
      `SELECT ${PASS_COLS} FROM pro_passes
       WHERE user_id = $1 AND revoked_at IS NULL AND starts_at <= $2 AND ends_at > $2
       ORDER BY ends_at DESC`,
      [userId, now],
    );
    return r.rows.map(rowToPass);
  }

  async allPasses(userId: string): Promise<ProPass[]> {
    const r = await this.pool.query(`SELECT ${PASS_COLS} FROM pro_passes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]);
    return r.rows.map(rowToPass);
  }

  async grantPass(p: { userId: string; plan: PassPlan; startsAt: Date; endsAt: Date; source: ProPass['source']; createdBy: string | null }): Promise<ProPass> {
    const r = await this.pool.query(
      `INSERT INTO pro_passes (user_id, plan, starts_at, ends_at, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PASS_COLS}`,
      [p.userId, p.plan, p.startsAt, p.endsAt, p.source, p.createdBy],
    );
    return rowToPass(r.rows[0]);
  }

  async revokePass(passId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query('UPDATE pro_passes SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [passId, now]);
    return (r.rowCount ?? 0) > 0;
  }

  async supporters(userIds: string[], now: Date): Promise<Set<string>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return new Set();
    const r = await this.pool.query(
      `SELECT DISTINCT user_id FROM pro_passes
       WHERE user_id = ANY($1::uuid[]) AND plan = ANY($2::text[])
         AND revoked_at IS NULL AND starts_at <= $3 AND ends_at > $3`,
      [ids, [...CROWN_PLANS, ...LEGACY_PAID_PLANS], now],
    );
    return new Set(r.rows.map((x) => String(x.user_id)));
  }

  async gift(userId: string): Promise<ProGift | null> {
    const r = await this.pool.query(`SELECT ${GIFT_COLS} FROM pro_gifts WHERE user_id = $1`, [userId]);
    return r.rows[0] ? rowToGift(r.rows[0]) : null;
  }

  async offerGift(userId: string, now: Date): Promise<ProGift> {
    // claim_by stays empty: the gift never expires (schema.sql, "Pro becomes one monthly plan").
    await this.pool.query(
      'INSERT INTO pro_gifts (user_id, offered_at, stop_token) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
      [userId, now, newStopToken()],
    );
    return (await this.gift(userId))!;
  }

  async giftSeen(userId: string, now: Date): Promise<boolean> {
    const r = await this.pool.query('UPDATE pro_gifts SET seen_at = $2 WHERE user_id = $1 AND seen_at IS NULL', [userId, now]);
    return (r.rowCount ?? 0) > 0;
  }

  async acceptGift(userId: string, now: Date, days: number, how: { auto?: boolean; lang?: 'en' | 'ar' | null } = {}): Promise<{ ok: true; pass: ProPass } | { ok: false; reason: 'none' | 'used' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row lock makes a second Accept wait for the first, then see it accepted.
      const g = await client.query('SELECT accepted_at FROM pro_gifts WHERE user_id = $1 FOR UPDATE', [userId]);
      const row = g.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'none' };
      }
      if (row.accepted_at) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'used' };
      }
      const ends = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const p = await client.query(
        `INSERT INTO pro_passes (user_id, plan, starts_at, ends_at, source) VALUES ($1, 'gift', $2, $3, 'gift') RETURNING ${PASS_COLS}`,
        [userId, now, ends],
      );
      const pass = rowToPass(p.rows[0]);
      // An offer made before stop tokens existed gets its own here, for the emails' "stop these emails" link.
      await client.query(
        'UPDATE pro_gifts SET accepted_at = $2, pass_id = $3, auto = $4, lang = $5, stop_token = COALESCE(stop_token, $6) WHERE user_id = $1',
        [userId, now, pass.id, how.auto === true, how.lang ?? null, newStopToken()],
      );
      await client.query('COMMIT');
      return { ok: true, pass };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async giftMark(userId: string, which: 'welcome' | 'end', now: Date): Promise<boolean> {
    const col = which === 'welcome' ? 'welcome_at' : 'end_seen_at';
    const r = await this.pool.query(`UPDATE pro_gifts SET ${col} = $2 WHERE user_id = $1 AND accepted_at IS NOT NULL AND ${col} IS NULL`, [userId, now]);
    return (r.rowCount ?? 0) > 0;
  }

  async giftUse(userId: string, keys: string[], maxKeys: number): Promise<boolean> {
    let any = false;
    for (const k of keys) {
      // One more of an item already kept, or a new item while there is room for one.
      const r = await this.pool.query(
        `UPDATE pro_gifts SET uses = jsonb_set(uses, ARRAY[$2::text], to_jsonb(LEAST(999, COALESCE((uses->>$2)::int, 0) + 1)))
         WHERE user_id = $1 AND accepted_at IS NOT NULL
           AND (uses ? $2 OR (SELECT count(*) FROM jsonb_object_keys(uses)) < $3)`,
        [userId, k, maxKeys],
      );
      if ((r.rowCount ?? 0) > 0) any = true;
    }
    return any;
  }

  async giftOffersOk(userId: string, ok: boolean, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      'UPDATE pro_gifts SET offers_ok_at = CASE WHEN $2 THEN $3::timestamptz ELSE NULL END WHERE user_id = $1 AND accepted_at IS NOT NULL',
      [userId, ok, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async giftsDue(kind: GiftMailKind, now: Date, limit: number): Promise<GiftDue[]> {
    const col = MAIL_COL[kind];
    const t = now.getTime();
    const when =
      kind === 'start' ? 'p.ends_at > $1 AND g.accepted_at >= $2'
        : kind === 'soon' ? 'p.ends_at <= $2 AND p.ends_at >= $3'
          : 'p.ends_at <= $1 AND p.ends_at >= $2';
    const args: unknown[] =
      kind === 'start' ? [now, new Date(t - GIFT_START_MAIL_HOURS * HOUR_MS)]
        : kind === 'soon' ? [now, new Date(t + GIFT_SOON_HOURS * HOUR_MS), new Date(t + GIFT_SOON_MIN_HOURS * HOUR_MS)]
          : [now, new Date(t - GIFT_END_MAIL_HOURS * HOUR_MS)];
    // $1 is always passed; the 'soon' window does not read it, so it is named in a harmless comparison.
    const r = await this.pool.query(
      `SELECT g.user_id, g.lang, g.stop_token, g.uses, g.offers_ok_at, p.starts_at, p.ends_at
       FROM pro_gifts g JOIN pro_passes p ON p.id = g.pass_id
       WHERE g.auto AND g.accepted_at IS NOT NULL AND g.${col} IS NULL AND g.stop_token IS NOT NULL
         AND p.revoked_at IS NULL AND $1::timestamptz IS NOT NULL AND ${when}
       ORDER BY g.accepted_at LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
      args,
    );
    return r.rows.map((x) => ({
      userId: String(x.user_id), lang: x.lang === 'ar' ? 'ar' as const : x.lang === 'en' ? 'en' as const : null, stopToken: String(x.stop_token),
      startsAt: iso(x.starts_at as string)!, endsAt: iso(x.ends_at as string)!, uses: usesOf(x.uses), offersOk: !!x.offers_ok_at,
    }));
  }

  async claimGiftMail(userId: string, kind: GiftMailKind, now: Date): Promise<boolean> {
    const col = MAIL_COL[kind];
    const r = await this.pool.query(`UPDATE pro_gifts SET ${col} = $2 WHERE user_id = $1 AND ${col} IS NULL`, [userId, now]);
    return (r.rowCount ?? 0) > 0;
  }

  async unclaimGiftMail(userId: string, kind: GiftMailKind): Promise<void> {
    await this.pool.query(`UPDATE pro_gifts SET ${MAIL_COL[kind]} = NULL WHERE user_id = $1`, [userId]);
  }

  async giftByStopToken(token: string): Promise<string | null> {
    const r = await this.pool.query('SELECT user_id FROM pro_gifts WHERE stop_token = $1', [token]);
    return r.rows[0] ? String(r.rows[0].user_id) : null;
  }

  async stopMail(userId: string, now: Date, via: string): Promise<void> {
    await this.pool.query('INSERT INTO pro_mail_stops (user_id, created_at, via) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING', [userId, now, via.slice(0, 40)]);
  }

  async mailStopped(userId: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM pro_mail_stops WHERE user_id = $1', [userId]);
    return r.rows.length > 0;
  }

  async giftRows(limit: number): Promise<GiftRow[]> {
    const r = await this.pool.query(
      `SELECT g.user_id, g.auto, g.accepted_at, COALESCE(p.revoked_at, p.ends_at) AS ends_at
       FROM pro_gifts g LEFT JOIN pro_passes p ON p.id = g.pass_id
       WHERE g.accepted_at IS NOT NULL ORDER BY g.accepted_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ userId: String(x.user_id), auto: x.auto === true, startedAt: iso(x.accepted_at as string)!, endsAt: iso((x.ends_at ?? null) as string | null) }));
  }

  async notify(userId: string): Promise<boolean> {
    const r = await this.pool.query('INSERT INTO pro_notify (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async notified(userId: string): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM pro_notify WHERE user_id = $1', [userId]);
    return r.rows.length > 0;
  }

  async putPriceAnswer(a: PriceAnswerPut): Promise<'saved' | 'full'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The browser's answer goes first, so taking it over never meets the ceiling.
      const absorbed = a.absorb && a.absorb !== a.voter
        ? await client.query('DELETE FROM pro_price_answers WHERE voter = $1 RETURNING created_at', [a.absorb])
        : null;
      const since = absorbed?.rows[0]?.created_at ?? null;
      // Insert only under the ceiling, or over one's own answer. The count is
      // not locked: two racing new voters can pass it by one, which is fine
      // for a ceiling that only exists to stop the table growing for ever.
      const r = await client.query(
        `INSERT INTO pro_price_answers (voter, user_id, amount, currency, lang, comment, wont_pay, source, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $9, $10, COALESCE($8::timestamptz, now())
         WHERE (SELECT count(*) FROM pro_price_answers) < $7
            OR EXISTS (SELECT 1 FROM pro_price_answers WHERE voter = $1)
         ON CONFLICT (voter) DO UPDATE
           SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, lang = EXCLUDED.lang,
               comment = EXCLUDED.comment, user_id = EXCLUDED.user_id, wont_pay = EXCLUDED.wont_pay,
               source = EXCLUDED.source, updated_at = now()`,
        [a.voter, a.userId, a.amount, a.currency, a.lang, a.comment, a.max, since, a.wontPay, a.source],
      );
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return 'full';
      }
      await client.query('COMMIT');
      return 'saved';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async priceAnswer(voter: string): Promise<PriceAnswer | null> {
    const r = await this.pool.query('SELECT amount, currency, lang, comment, wont_pay, source, created_at, updated_at FROM pro_price_answers WHERE voter = $1', [voter]);
    const x = r.rows[0];
    return x ? rowToPrice(x) : null;
  }

  async priceCount(): Promise<number> {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM pro_price_answers');
    return Number(r.rows[0]?.n ?? 0);
  }

  async priceAnswers(limit: number): Promise<{ all: PriceCounted[]; newest: PriceAnswerRow[] }> {
    const [all, newest] = await Promise.all([
      this.pool.query('SELECT amount, currency, user_id IS NOT NULL AS account, wont_pay, source FROM pro_price_answers'),
      this.pool.query(
        `SELECT p.amount, p.currency, p.lang, p.comment, p.wont_pay, p.source, p.created_at, p.updated_at, u.username
         FROM pro_price_answers p LEFT JOIN users u ON u.id = p.user_id
         ORDER BY p.updated_at DESC, p.id DESC LIMIT $1`,
        [limit],
      ),
    ]);
    return {
      all: all.rows.map((x) => ({
        amount: Number(x.amount), currency: x.currency as PriceCurrency, account: !!x.account,
        wontPay: x.wont_pay === true, source: x.source === 'editor' ? 'editor' as const : 'page' as const,
      })),
      newest: newest.rows.map((x) => ({ ...rowToPrice(x), username: x.username ? String(x.username) : null })),
    };
  }

  async stats(now: Date): Promise<ProStats> {
    const [g, p, n, v] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::int AS offered, count(accepted_at)::int AS accepted,
                count(*) FILTER (WHERE seen_at IS NOT NULL OR accepted_at IS NOT NULL)::int AS seen, min(seen_at) AS seen_since
         FROM pro_gifts`,
      ),
      this.pool.query(
        `SELECT plan, count(*)::int AS n FROM pro_passes
         WHERE revoked_at IS NULL AND starts_at <= $1 AND ends_at > $1 GROUP BY plan`,
        [now],
      ),
      this.pool.query('SELECT count(*)::int AS n FROM pro_notify'),
      // Each account once, however its answer row is keyed; "not for me" is the answer's own flag.
      this.pool.query(
        `SELECT count(*)::int AS price, count(*) FILTER (WHERE a.wont)::int AS wont
         FROM pro_notify n
         JOIN (SELECT user_id, bool_or(wont_pay) AS wont FROM pro_price_answers WHERE user_id IS NOT NULL GROUP BY user_id) a ON a.user_id = n.user_id`,
      ),
    ]);
    const passes = Object.fromEntries(PASS_PLANS.map((pl) => [pl, 0])) as Record<PassPlan, number>;
    for (const r of p.rows) passes[normalizePlan(String(r.plan))] += Number(r.n);
    return {
      gifts: {
        offered: Number(g.rows[0]?.offered ?? 0), seen: Number(g.rows[0]?.seen ?? 0), seenSince: iso((g.rows[0]?.seen_since ?? null) as string | null),
        accepted: Number(g.rows[0]?.accepted ?? 0), active: passes.gift,
      },
      passes,
      notify: Number(n.rows[0]?.n ?? 0),
      notifyVia: { price: Number(v.rows[0]?.price ?? 0), wontPay: Number(v.rows[0]?.wont ?? 0) },
    };
  }

  async members(limit: number): Promise<ProMemberPass[]> {
    // The use is summed the way passUse does it: the pass's own months, keyed 'c:<pass id>:<n>'.
    const r = await this.pool.query(
      `SELECT p.id, p.user_id, p.plan, p.starts_at, p.ends_at, p.source, p.created_at, p.revoked_at,
              u.username, g.username AS given_by,
              (SELECT COALESCE(sum(a.used), 0)::int FROM pro_allowance a
                WHERE a.user_id = p.user_id AND a.period LIKE 'c:' || p.id::text || ':%') AS used
       FROM pro_passes p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN users g ON g.id = p.created_by
       ORDER BY p.created_at DESC, p.id DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      ...rowToPass(x),
      username: x.username ? String(x.username) : null,
      givenBy: x.given_by ? String(x.given_by) : null,
      used: Number(x.used ?? 0),
    }));
  }

  async passUse(userId: string, passId: string): Promise<number> {
    // A pass's own months are keyed 'c:<pass id>:<n>' (proPlan cycleOf). The id is a UUID, so no LIKE wildcard can be in it.
    const r = await this.pool.query(
      `SELECT COALESCE(sum(used), 0)::int AS n FROM pro_allowance WHERE user_id = $1 AND period LIKE $2`,
      [userId, `c:${passId}:%`],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async purgeAllowances(before: Date): Promise<number> {
    const r = await this.pool.query('DELETE FROM pro_allowance WHERE updated_at < $1', [before]);
    return r.rowCount ?? 0;
  }
}
