/**
 * Community stadium submissions — storage for user-submitted stadium templates
 * that flow submit → pending → (admin) approve/reject → public.
 *
 * Self-contained (memory + Postgres) so it doesn't touch the existing repos. The
 * Postgres table is created by init() which the bootstrap calls BEST-EFFORT: a
 * failure logs and disables the feature rather than crashing server boot. The
 * template column is jsonb; validation happens at the route layer (isValidTemplate)
 * before anything is stored.
 */

import type pg from 'pg';
import type { StadiumTemplate } from '../../src/core/types';

export type SubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface StadiumSubmission {
  id: string;
  template: StadiumTemplate;
  name: string;
  country: string | null;
  status: SubmissionStatus;
  submitterId: string | null;
  createdAt: string;
}

export interface SubmitInput {
  template: StadiumTemplate;
  name: string;
  country: string | null;
  submitterId: string | null;
}

export interface StadiumSubmissionRepository {
  submit(input: SubmitInput): Promise<{ id: string }>;
  /** Public: approved submissions, newest first. */
  listApproved(limit?: number): Promise<StadiumSubmission[]>;
  /** Admin: submissions awaiting review, newest first. */
  listPending(limit?: number): Promise<StadiumSubmission[]>;
  /** Admin: approve or reject a submission. Returns false if not found. */
  review(id: string, approve: boolean): Promise<boolean>;
}

let counter = 0;
function newId(): string {
  return `cs_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

export class MemoryStadiumRepository implements StadiumSubmissionRepository {
  private rows: StadiumSubmission[] = [];

  async submit(i: SubmitInput): Promise<{ id: string }> {
    const id = newId();
    this.rows.unshift({ id, template: i.template, name: i.name, country: i.country, status: 'pending', submitterId: i.submitterId, createdAt: new Date().toISOString() });
    return { id };
  }
  async listApproved(limit = 200): Promise<StadiumSubmission[]> {
    return this.rows.filter((r) => r.status === 'approved').slice(0, limit);
  }
  async listPending(limit = 200): Promise<StadiumSubmission[]> {
    return this.rows.filter((r) => r.status === 'pending').slice(0, limit);
  }
  async review(id: string, approve: boolean): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return false;
    r.status = approve ? 'approved' : 'rejected';
    return true;
  }
}

export class PgStadiumRepository implements StadiumSubmissionRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent table creation. Called best-effort at boot (must not throw boot). */
  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS community_stadiums (
         id          text PRIMARY KEY,
         name        text NOT NULL,
         country     text,
         template    jsonb NOT NULL,
         status      text NOT NULL DEFAULT 'pending',
         submitter_id text,
         created_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  private rowTo(r: Record<string, unknown>): StadiumSubmission {
    return {
      id: String(r.id),
      name: String(r.name),
      country: r.country ? String(r.country) : null,
      template: (typeof r.template === 'string' ? JSON.parse(r.template) : r.template) as StadiumTemplate,
      status: r.status as SubmissionStatus,
      submitterId: r.submitter_id ? String(r.submitter_id) : null,
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async submit(i: SubmitInput): Promise<{ id: string }> {
    const id = newId();
    await this.pool.query(
      `INSERT INTO community_stadiums (id, name, country, template, status, submitter_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [id, i.name, i.country, JSON.stringify(i.template), i.submitterId],
    );
    return { id };
  }
  async listApproved(limit = 200): Promise<StadiumSubmission[]> {
    const r = await this.pool.query(`SELECT * FROM community_stadiums WHERE status = 'approved' ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => this.rowTo(x));
  }
  async listPending(limit = 200): Promise<StadiumSubmission[]> {
    const r = await this.pool.query(`SELECT * FROM community_stadiums WHERE status = 'pending' ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => this.rowTo(x));
  }
  async review(id: string, approve: boolean): Promise<boolean> {
    const r = await this.pool.query(`UPDATE community_stadiums SET status = $2 WHERE id = $1`, [id, approve ? 'approved' : 'rejected']);
    return (r.rowCount ?? 0) > 0;
  }
}
