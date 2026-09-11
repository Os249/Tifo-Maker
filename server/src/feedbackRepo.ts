/**
 * Bug reports and feature requests from inside the product.
 *
 * WHY THIS EXISTS
 * Until now the only way to tell the developer something was broken was to
 * leave the site and message @OS99GameDev, or find an email address buried in
 * the legal page. Almost nobody does that, so a bug that stopped someone
 * finishing a tifo simply cost a user and was never heard about.
 *
 * WHAT IS STORED
 * What the person typed, the kind of report, an optional reply address, and a
 * small diagnostic snapshot. Deliberately NOT stored: the IP address, the raw
 * user agent, and any page query string. The snapshot is the coarse facts that
 * make a bug reproducible - browser family, OS, device class, viewport bucket,
 * the path they were on - and the person is shown it and can drop it before
 * sending. The same rule as the traffic table: keep what explains behaviour,
 * never what identifies a person.
 *
 * SPAM
 * An open, unauthenticated write endpoint is a spam magnet, and CAPTCHAs are
 * both hostile and unnecessary here. The research-backed stack is a hidden
 * honeypot field plus a time-trap (nothing typed by a human is submitted in
 * under two seconds) plus a per-IP rate limit. That combination stops the
 * cheap, high-volume bots that make up nearly all form spam, and it is
 * completely invisible to a real person.
 */

import type pg from 'pg';
import { randomUUID } from 'node:crypto';

export const FEEDBACK_KINDS = ['bug', 'idea', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export function isFeedbackKind(v: unknown): v is FeedbackKind {
  return typeof v === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(v);
}

/** The coarse, non-identifying snapshot attached to a report. */
export interface FeedbackContext {
  /** Path only - the query string is dropped before it reaches here. */
  path: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  /** Bucketed ("1440x900"), not a precise fingerprintable size. */
  viewport: string | null;
  language: string | null;
  signedIn: boolean;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  /** Optional: only so the developer can reply. */
  email: string | null;
  /** Optional: what they were doing, for a bug. */
  steps: string | null;
  /** Null when the person chose not to attach it. */
  context: FeedbackContext | null;
  userId: string | null;
}

export interface FeedbackRow extends FeedbackInput {
  id: string;
  createdAt: string;
  handled: boolean;
}

export interface FeedbackRepository {
  create(input: FeedbackInput): Promise<{ id: string }>;
  list(limit: number): Promise<FeedbackRow[]>;
  counts(): Promise<{ total: number; open: number; bugs: number; ideas: number }>;
}

const MAX_MESSAGE = 4000;
const MAX_STEPS = 2000;

/** Trim to what we agreed to keep, so oversized input cannot reach storage. */
export function normalizeFeedback(input: FeedbackInput): FeedbackInput {
  return {
    kind: input.kind,
    message: input.message.trim().slice(0, MAX_MESSAGE),
    email: input.email ? input.email.trim().slice(0, 200) : null,
    steps: input.steps ? input.steps.trim().slice(0, MAX_STEPS) : null,
    context: input.context,
    userId: input.userId,
  };
}

export class MemoryFeedbackRepository implements FeedbackRepository {
  private rows: FeedbackRow[] = [];

  async create(input: FeedbackInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.rows.push({ ...normalizeFeedback(input), id, createdAt: new Date().toISOString(), handled: false });
    return { id };
  }

  async list(limit: number): Promise<FeedbackRow[]> {
    return this.rows.slice().reverse().slice(0, limit);
  }

  async counts(): Promise<{ total: number; open: number; bugs: number; ideas: number }> {
    return {
      total: this.rows.length,
      open: this.rows.filter((r) => !r.handled).length,
      bugs: this.rows.filter((r) => r.kind === 'bug').length,
      ideas: this.rows.filter((r) => r.kind === 'idea').length,
    };
  }
}

export class PgFeedbackRepository implements FeedbackRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent creation, matching how the other tables bootstrap on boot. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind       TEXT NOT NULL,
        message    TEXT NOT NULL,
        email      TEXT,
        steps      TEXT,
        context    JSONB,
        user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
        handled    BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC)');
  }

  async create(input: FeedbackInput): Promise<{ id: string }> {
    const f = normalizeFeedback(input);
    const res = await this.pool.query(
      `INSERT INTO feedback (kind, message, email, steps, context, user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [f.kind, f.message, f.email, f.steps, f.context ? JSON.stringify(f.context) : null, f.userId],
    );
    return { id: String(res.rows[0].id) };
  }

  async list(limit: number): Promise<FeedbackRow[]> {
    try {
      const res = await this.pool.query(
        `SELECT id, kind, message, email, steps, context, user_id, handled, created_at
           FROM feedback ORDER BY created_at DESC LIMIT $1`,
        [Math.min(200, Math.max(1, limit))],
      );
      return res.rows.map((r) => ({
        id: String(r.id),
        kind: r.kind as FeedbackKind,
        message: String(r.message ?? ''),
        email: r.email == null ? null : String(r.email),
        steps: r.steps == null ? null : String(r.steps),
        context: (r.context as FeedbackContext | null) ?? null,
        userId: r.user_id == null ? null : String(r.user_id),
        handled: Boolean(r.handled),
        createdAt: new Date(r.created_at as string).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async counts(): Promise<{ total: number; open: number; bugs: number; ideas: number }> {
    try {
      const res = await this.pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE NOT handled)::int AS open,
                count(*) FILTER (WHERE kind = 'bug')::int AS bugs,
                count(*) FILTER (WHERE kind = 'idea')::int AS ideas
           FROM feedback`,
      );
      const x = res.rows[0] ?? {};
      return {
        total: Number(x.total) || 0,
        open: Number(x.open) || 0,
        bugs: Number(x.bugs) || 0,
        ideas: Number(x.ideas) || 0,
      };
    } catch {
      return { total: 0, open: 0, bugs: 0, ideas: 0 };
    }
  }
}
