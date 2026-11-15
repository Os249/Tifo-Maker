/**
 * Where tifo events are kept (server/src/eventRoutes.ts; the rules are in
 * tifoEvents.ts). In memory for development and tests, in Postgres in
 * production (schema.sql, "Tifo events").
 *
 * An event is a themed contest made by the admin: announced, open for
 * entries, in voting, then closed and confirmed by hand. Its stage is never
 * stored: it is worked out from the four times each time it is read, so
 * there is no timer to fall over at midnight.
 *
 * Promises every implementation keeps:
 *  - an account has at most one entry in an event (entering again replaces it);
 *  - a design is entered in an event at most once;
 *  - an account votes for an entry at most once;
 *  - entries and votes go with their event, their design and their account.
 * The repository stores; it decides nothing about who may enter or vote.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface TifoEvent {
  id: string;
  slug: string;
  titleEn: string;
  titleAr: string;
  lineEn: string;
  lineAr: string;
  /** ISO times, in order: announced <= open < voting < closed. */
  announceAt: string;
  openAt: string;
  voteAt: string;
  closeAt: string;
  /** Days of Pro the winner gets; 0 for none. */
  prizeDays: number;
  cancelledAt: string | null;
  /** The result, once the admin has confirmed it. */
  confirmedAt: string | null;
  winnerDesign: string | null;
  secondDesign: string | null;
  thirdDesign: string | null;
  /** Who won, kept apart from the design so "one prize per 90 days" outlives it. */
  winnerUser: string | null;
  /** The pass the prize made, when one was given. */
  prizePass: string | null;
  createdAt: string;
}

export type EventFields = Pick<TifoEvent, 'slug' | 'titleEn' | 'titleAr' | 'lineEn' | 'lineAr' | 'announceAt' | 'openAt' | 'voteAt' | 'closeAt' | 'prizeDays'>;

export interface EventEntry {
  eventId: string;
  designId: string;
  userId: string;
  enteredAt: string;
  /** Why the admin took it out, shown on the page; null while it stands. */
  disqualifiedReason: string | null;
}

export interface EventResult {
  confirmedAt: string;
  winnerDesign: string | null;
  secondDesign: string | null;
  thirdDesign: string | null;
  winnerUser: string | null;
  prizePass: string | null;
}

export interface EventRepository {
  /** Every event, newest opening first (at most 200). */
  list(): Promise<TifoEvent[]>;
  bySlug(slug: string): Promise<TifoEvent | null>;
  byId(id: string): Promise<TifoEvent | null>;
  /** Null when the slug is taken. */
  create(e: EventFields): Promise<TifoEvent | null>;
  /** Null when there is no such event, or the new slug is taken. */
  update(id: string, e: EventFields): Promise<TifoEvent | null>;
  /** Mark it cancelled (true) or bring it back (false). */
  setCancelled(id: string, cancelled: boolean, now: Date): Promise<boolean>;
  /** Delete it with its entries and votes. */
  remove(id: string): Promise<boolean>;
  setResult(id: string, r: EventResult): Promise<boolean>;

  /** In the order they were entered. */
  entries(eventId: string): Promise<EventEntry[]>;
  /** Enter, or replace this account's entry. 'taken': the design is another entry already. */
  putEntry(eventId: string, userId: string, designId: string, now: Date): Promise<'ok' | 'taken'>;
  removeEntry(eventId: string, userId: string): Promise<boolean>;
  /** Set or clear the reason an entry is out. */
  disqualify(eventId: string, designId: string, reason: string | null): Promise<boolean>;

  /** Record a vote; `counted` is whether it goes in the result. False when it was there already. */
  vote(eventId: string, designId: string, userId: string, counted: boolean, now: Date): Promise<boolean>;
  unvote(eventId: string, designId: string, userId: string): Promise<boolean>;
  /** The designs this account voted for in the event. */
  votesBy(eventId: string, userId: string): Promise<string[]>;
  /** Votes per design: the ones that count, and all of them. */
  tally(eventId: string): Promise<Map<string, { counted: number; all: number }>>;
}

// ---------------------------------------------------------------- memory ---

interface Vote { eventId: string; designId: string; userId: string; counted: boolean }

export class MemoryEventRepository implements EventRepository {
  private events = new Map<string, TifoEvent>();
  private entryRows: EventEntry[] = [];
  private votes: Vote[] = [];

  private slugTaken(slug: string, exceptId: string | null): boolean {
    for (const e of this.events.values()) if (e.slug === slug && e.id !== exceptId) return true;
    return false;
  }

  async list(): Promise<TifoEvent[]> {
    return [...this.events.values()].sort((a, b) => b.openAt.localeCompare(a.openAt)).slice(0, 200).map((e) => ({ ...e }));
  }

  async bySlug(slug: string): Promise<TifoEvent | null> {
    for (const e of this.events.values()) if (e.slug === slug) return { ...e };
    return null;
  }

  async byId(id: string): Promise<TifoEvent | null> {
    const e = this.events.get(id);
    return e ? { ...e } : null;
  }

  async create(f: EventFields): Promise<TifoEvent | null> {
    if (this.slugTaken(f.slug, null)) return null;
    const e: TifoEvent = {
      ...f, id: randomUUID(), cancelledAt: null, confirmedAt: null, winnerDesign: null, secondDesign: null, thirdDesign: null,
      winnerUser: null, prizePass: null, createdAt: new Date().toISOString(),
    };
    this.events.set(e.id, e);
    return { ...e };
  }

  async update(id: string, f: EventFields): Promise<TifoEvent | null> {
    const e = this.events.get(id);
    if (!e || this.slugTaken(f.slug, id)) return null;
    Object.assign(e, f);
    return { ...e };
  }

  async setCancelled(id: string, cancelled: boolean, now: Date): Promise<boolean> {
    const e = this.events.get(id);
    if (!e) return false;
    e.cancelledAt = cancelled ? now.toISOString() : null;
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.events.delete(id)) return false;
    this.entryRows = this.entryRows.filter((x) => x.eventId !== id);
    this.votes = this.votes.filter((x) => x.eventId !== id);
    return true;
  }

  async setResult(id: string, r: EventResult): Promise<boolean> {
    const e = this.events.get(id);
    if (!e) return false;
    Object.assign(e, r);
    return true;
  }

  async entries(eventId: string): Promise<EventEntry[]> {
    return this.entryRows.filter((x) => x.eventId === eventId).sort((a, b) => a.enteredAt.localeCompare(b.enteredAt)).map((x) => ({ ...x }));
  }

  async putEntry(eventId: string, userId: string, designId: string, now: Date): Promise<'ok' | 'taken'> {
    if (this.entryRows.some((x) => x.eventId === eventId && x.designId === designId && x.userId !== userId)) return 'taken';
    const mine = this.entryRows.find((x) => x.eventId === eventId && x.userId === userId);
    if (mine && mine.designId === designId) return 'ok';
    if (mine) {
      // A different tifo: the votes were for the old one.
      this.votes = this.votes.filter((v) => !(v.eventId === eventId && v.designId === mine.designId));
      this.entryRows = this.entryRows.filter((x) => x !== mine);
    }
    this.entryRows.push({ eventId, designId, userId, enteredAt: now.toISOString(), disqualifiedReason: null });
    return 'ok';
  }

  async removeEntry(eventId: string, userId: string): Promise<boolean> {
    const mine = this.entryRows.find((x) => x.eventId === eventId && x.userId === userId);
    if (!mine) return false;
    this.votes = this.votes.filter((v) => !(v.eventId === eventId && v.designId === mine.designId));
    this.entryRows = this.entryRows.filter((x) => x !== mine);
    return true;
  }

  async disqualify(eventId: string, designId: string, reason: string | null): Promise<boolean> {
    const row = this.entryRows.find((x) => x.eventId === eventId && x.designId === designId);
    if (!row) return false;
    row.disqualifiedReason = reason;
    return true;
  }

  async vote(eventId: string, designId: string, userId: string, counted: boolean): Promise<boolean> {
    if (this.votes.some((v) => v.eventId === eventId && v.designId === designId && v.userId === userId)) return false;
    this.votes.push({ eventId, designId, userId, counted });
    return true;
  }

  async unvote(eventId: string, designId: string, userId: string): Promise<boolean> {
    const n = this.votes.length;
    this.votes = this.votes.filter((v) => !(v.eventId === eventId && v.designId === designId && v.userId === userId));
    return this.votes.length < n;
  }

  async votesBy(eventId: string, userId: string): Promise<string[]> {
    return this.votes.filter((v) => v.eventId === eventId && v.userId === userId).map((v) => v.designId);
  }

  async tally(eventId: string): Promise<Map<string, { counted: number; all: number }>> {
    const out = new Map<string, { counted: number; all: number }>();
    for (const v of this.votes) {
      if (v.eventId !== eventId) continue;
      const t = out.get(v.designId) ?? { counted: 0, all: 0 };
      t.all++;
      if (v.counted) t.counted++;
      out.set(v.designId, t);
    }
    return out;
  }

  /** For tests: forget an account's rows, as ON DELETE CASCADE does. */
  forgetUser(userId: string): void {
    this.entryRows = this.entryRows.filter((x) => x.userId !== userId);
    this.votes = this.votes.filter((v) => v.userId !== userId);
  }
}

// -------------------------------------------------------------- postgres ---

const EVENT_COLS =
  'id, slug, title_en, title_ar, line_en, line_ar, announce_at, open_at, vote_at, close_at, prize_days, cancelled_at, confirmed_at, ' +
  'winner_design, second_design, third_design, winner_user, prize_pass, created_at';

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function rowToEvent(r: Record<string, unknown>): TifoEvent {
  return {
    id: String(r.id),
    slug: String(r.slug),
    titleEn: String(r.title_en),
    titleAr: String(r.title_ar),
    lineEn: String(r.line_en),
    lineAr: String(r.line_ar),
    announceAt: iso(r.announce_at),
    openAt: iso(r.open_at),
    voteAt: iso(r.vote_at),
    closeAt: iso(r.close_at),
    prizeDays: Number(r.prize_days),
    cancelledAt: isoOrNull(r.cancelled_at),
    confirmedAt: isoOrNull(r.confirmed_at),
    winnerDesign: strOrNull(r.winner_design),
    secondDesign: strOrNull(r.second_design),
    thirdDesign: strOrNull(r.third_design),
    winnerUser: strOrNull(r.winner_user),
    prizePass: strOrNull(r.prize_pass),
    createdAt: iso(r.created_at),
  };
}

/** Postgres's "that unique value is taken". */
const isUnique = (e: unknown): boolean => (e as { code?: string } | null)?.code === '23505';

export class PgEventRepository implements EventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<TifoEvent[]> {
    const r = await this.pool.query(`SELECT ${EVENT_COLS} FROM tifo_events ORDER BY open_at DESC LIMIT 200`);
    return r.rows.map(rowToEvent);
  }

  async bySlug(slug: string): Promise<TifoEvent | null> {
    const r = await this.pool.query(`SELECT ${EVENT_COLS} FROM tifo_events WHERE slug = $1`, [slug]);
    return r.rows[0] ? rowToEvent(r.rows[0]) : null;
  }

  async byId(id: string): Promise<TifoEvent | null> {
    const r = await this.pool.query(`SELECT ${EVENT_COLS} FROM tifo_events WHERE id = $1`, [id]);
    return r.rows[0] ? rowToEvent(r.rows[0]) : null;
  }

  async create(f: EventFields): Promise<TifoEvent | null> {
    try {
      const r = await this.pool.query(
        `INSERT INTO tifo_events (slug, title_en, title_ar, line_en, line_ar, announce_at, open_at, vote_at, close_at, prize_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${EVENT_COLS}`,
        [f.slug, f.titleEn, f.titleAr, f.lineEn, f.lineAr, f.announceAt, f.openAt, f.voteAt, f.closeAt, f.prizeDays],
      );
      return rowToEvent(r.rows[0]);
    } catch (e) {
      if (isUnique(e)) return null;
      throw e;
    }
  }

  async update(id: string, f: EventFields): Promise<TifoEvent | null> {
    try {
      const r = await this.pool.query(
        `UPDATE tifo_events SET slug = $2, title_en = $3, title_ar = $4, line_en = $5, line_ar = $6,
                announce_at = $7, open_at = $8, vote_at = $9, close_at = $10, prize_days = $11
         WHERE id = $1 RETURNING ${EVENT_COLS}`,
        [id, f.slug, f.titleEn, f.titleAr, f.lineEn, f.lineAr, f.announceAt, f.openAt, f.voteAt, f.closeAt, f.prizeDays],
      );
      return r.rows[0] ? rowToEvent(r.rows[0]) : null;
    } catch (e) {
      if (isUnique(e)) return null;
      throw e;
    }
  }

  async setCancelled(id: string, cancelled: boolean, now: Date): Promise<boolean> {
    const r = await this.pool.query('UPDATE tifo_events SET cancelled_at = $2 WHERE id = $1', [id, cancelled ? now : null]);
    return (r.rowCount ?? 0) > 0;
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM tifo_events WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async setResult(id: string, x: EventResult): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE tifo_events SET confirmed_at = $2, winner_design = $3, second_design = $4, third_design = $5, winner_user = $6, prize_pass = $7
       WHERE id = $1`,
      [id, x.confirmedAt, x.winnerDesign, x.secondDesign, x.thirdDesign, x.winnerUser, x.prizePass],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async entries(eventId: string): Promise<EventEntry[]> {
    const r = await this.pool.query(
      'SELECT event_id, design_id, user_id, entered_at, disqualified_reason FROM tifo_event_entries WHERE event_id = $1 ORDER BY entered_at, design_id',
      [eventId],
    );
    return r.rows.map((x) => ({
      eventId: String(x.event_id),
      designId: String(x.design_id),
      userId: String(x.user_id),
      enteredAt: iso(x.entered_at),
      disqualifiedReason: strOrNull(x.disqualified_reason),
    }));
  }

  async putEntry(eventId: string, userId: string, designId: string, now: Date): Promise<'ok' | 'taken'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const mine = await client.query('SELECT design_id FROM tifo_event_entries WHERE event_id = $1 AND user_id = $2 FOR UPDATE', [eventId, userId]);
      const old = mine.rows[0] ? String(mine.rows[0].design_id) : null;
      if (old === designId) {
        await client.query('COMMIT');
        return 'ok';
      }
      if (old !== null) {
        // A different tifo: the votes were for the old one.
        await client.query('DELETE FROM tifo_event_votes WHERE event_id = $1 AND design_id = $2', [eventId, old]);
        await client.query('DELETE FROM tifo_event_entries WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
      }
      await client.query('INSERT INTO tifo_event_entries (event_id, design_id, user_id, entered_at) VALUES ($1, $2, $3, $4)', [eventId, designId, userId, now]);
      await client.query('COMMIT');
      return 'ok';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (isUnique(e)) return 'taken';
      throw e;
    } finally {
      client.release();
    }
  }

  async removeEntry(eventId: string, userId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM tifo_event_entries WHERE event_id = $1 AND user_id = $2 RETURNING design_id', [eventId, userId]);
      if (r.rows[0]) await client.query('DELETE FROM tifo_event_votes WHERE event_id = $1 AND design_id = $2', [eventId, r.rows[0].design_id]);
      await client.query('COMMIT');
      return r.rows.length > 0;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async disqualify(eventId: string, designId: string, reason: string | null): Promise<boolean> {
    const r = await this.pool.query('UPDATE tifo_event_entries SET disqualified_reason = $3 WHERE event_id = $1 AND design_id = $2', [eventId, designId, reason]);
    return (r.rowCount ?? 0) > 0;
  }

  async vote(eventId: string, designId: string, userId: string, counted: boolean, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO tifo_event_votes (event_id, design_id, user_id, counted, voted_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, design_id, user_id) DO NOTHING`,
      [eventId, designId, userId, counted, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async unvote(eventId: string, designId: string, userId: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM tifo_event_votes WHERE event_id = $1 AND design_id = $2 AND user_id = $3', [eventId, designId, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async votesBy(eventId: string, userId: string): Promise<string[]> {
    const r = await this.pool.query('SELECT design_id FROM tifo_event_votes WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    return r.rows.map((x) => String(x.design_id));
  }

  async tally(eventId: string): Promise<Map<string, { counted: number; all: number }>> {
    const r = await this.pool.query(
      `SELECT design_id, count(*)::int AS n, (count(*) FILTER (WHERE counted))::int AS c
       FROM tifo_event_votes WHERE event_id = $1 GROUP BY design_id`,
      [eventId],
    );
    return new Map(r.rows.map((x) => [String(x.design_id), { counted: Number(x.c), all: Number(x.n) }]));
  }
}
