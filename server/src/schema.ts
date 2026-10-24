import { createHash } from 'node:crypto';

/**
 * Turning schema.sql into the statements the server applies at boot.
 *
 * This lived inside `applySchema` in server.ts, which meant the one piece of
 * code that runs against the production database on every deploy was the one
 * piece no test could reach — server.ts starts listening the moment it is
 * imported. It is three lines; it is also three lines that decide whether a
 * migration lands, so they belong somewhere a test can call.
 */

/**
 * Split on a semicolon that ends a line.
 *
 * Statements are applied one at a time rather than as a single query, so that
 * one failure on a database that has already seen most of this file cannot
 * abort the rest. That mattered once already: running the whole file as one
 * query meant an early error skipped the email / is_pro / accepted_terms
 * columns, and sign-up then answered 500.
 *
 * The rule is deliberately simple, which means schema.sql has to stay simple
 * too — no `;` inside a string literal, no PL/pgSQL body with its own
 * semicolons. Both are worth avoiding here anyway.
 */
export function schemaStatements(sql: string): string[] {
  return sql
    // A semicolon that ends a line, a trailing `-- comment` allowed after it:
    // `... thumbnail BYTEA;  -- client-rendered PNG` used to glue the next
    // statement onto this one (found by the ledger's tests, P2.15).
    .split(/;[ \t]*(?:--[^\n]*)?(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The statement without its comments, for recognising what it is. Most of
 * schema.sql's statements open with a comment explaining why they exist, so a
 * pattern anchored at the start of the raw text matched almost none of them
 * (P2.15). `--` inside a string literal is kept. The ledger's hash is of the
 * text as written, comments included.
 */
export function statementBody(stmt: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quoted) {
      out += ch;
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") {
      quoted = true;
      out += ch;
      continue;
    }
    if (ch === '-' && stmt[i + 1] === '-') {
      while (i < stmt.length && stmt[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .join('\n')
    .trim();
}

/**
 * The schema at boot (performance plan P2.15).
 *
 * Every boot used to run all of schema.sql, about a hundred statements, and
 * most of them take a lock even when there is nothing to do:
 * `ALTER TABLE designs ADD COLUMN IF NOT EXISTS` takes the table's exclusive
 * lock before it finds the column there, `CREATE INDEX IF NOT EXISTS` waits
 * for every write in flight. During a deploy the old instance is still
 * serving, so each of them queued behind whatever was running on designs and
 * held every request behind itself: 2.76 s with no design answering, measured.
 *
 * Now each statement's sha-256 is recorded in `schema_ledger` once it has
 * taken effect, and a boot skips what is recorded. A statement not recorded
 * yet whose object is already there (an index, a column, a table: the three
 * IF NOT EXISTS shapes) is recorded without being run, since it would change
 * nothing; anything else runs in a transaction of its own with
 * `lock_timeout = 3s`, so it gives up rather than stall the site, and is tried
 * again at the next boot. A statement that changes is a new hash, so it runs.
 *
 * The statements a security control rests on (SECURITY_STATEMENTS) are not
 * trusted to the ledger alone: each names what the catalogue must show when it
 * is in force (an index that is valid and unique, a column, a table, a
 * function's body, an enabled row trigger), that is looked up at every boot
 * (lock-free), and the statement is run again if it is not there. After the
 * run every one of them is looked up again, so one that ran without error but
 * left nothing in force (an invalid index under the right name) is reported
 * too. While one is not in force, the posture panel says "bad" (posture.ts).
 *
 * schema.sql itself is unchanged in kind: it still runs as one query (psql -f
 * in CI, and the tests), and the ledger is created by this code, not by it.
 */
export const SCHEMA_LEDGER = 'schema_ledger';
export const SCHEMA_LOCK_TIMEOUT_MS = 3_000;

/**
 * What the catalogue shows when a security statement is in force. Required on
 * every entry, and a test checks each names what its statement makes, so a
 * constraint or a trigger added later cannot be recorded once and then never
 * looked at again.
 */
export type CatalogueCheck =
  | { kind: 'index'; name: string; unique: boolean }
  | { kind: 'column'; table: string; column: string }
  | { kind: 'table'; name: string }
  /** A function whose source holds `body` (so an old or emptied one does not count). */
  | { kind: 'function'; name: string; body: string }
  /** A BEFORE INSERT OR UPDATE row trigger calling `fn`, fired by `column`, that fires in ordinary sessions. */
  | { kind: 'trigger'; table: string; name: string; fn: string; column: string };

/** A statement a security control relies on, and how to see that it is in force. */
export interface SecurityStatement {
  id: string;
  /** What breaks while it is missing (shown on the posture panel). */
  why: string;
  /** Picks the statement out of schema.sql, by its text without comments (statementBody). */
  match: RegExp;
  check: CatalogueCheck;
}

/**
 * Indexes, constraints, columns and triggers that a security control relies
 * on. A test checks every one matches exactly one statement of schema.sql, so
 * a rename cannot drop a control from this list without failing.
 */
export const SECURITY_STATEMENTS: readonly SecurityStatement[] = [
  { id: 'username-unique-ci', why: 'usernames unique ignoring case: without it "Admin" can be registered beside "admin" (audit round four)', match: /^CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx\b/, check: { kind: 'index', name: 'users_username_lower_idx', unique: true } },
  { id: 'email-unique-ci', why: 'one account per address, ignoring case: sign-in linking and password resets go by the address', match: /^CREATE UNIQUE INDEX IF NOT EXISTS users_email_key\b/, check: { kind: 'index', name: 'users_email_key', unique: true } },
  { id: 'identity-owner', why: 'a Google sign-in belongs to at most one account (its primary key), and goes with the account', match: /^CREATE TABLE IF NOT EXISTS oauth_identities\b/, check: { kind: 'table', name: 'oauth_identities' } },
  { id: 'session-tokens', why: 'sessions stored only as hashes, and deleted with their account', match: /^CREATE TABLE IF NOT EXISTS auth_tokens\b/, check: { kind: 'table', name: 'auth_tokens' } },
  { id: 'email-tokens', why: 'verification and reset links stored only as hashes, single use, deleted with their account', match: /^CREATE TABLE IF NOT EXISTS email_tokens\b/, check: { kind: 'table', name: 'email_tokens' } },
  { id: 'username-wall', why: 'the choose-a-username wall for accounts made by Google sign-in', match: /^ALTER TABLE users ADD COLUMN IF NOT EXISTS username_chosen\b/, check: { kind: 'column', table: 'users', column: 'username_chosen' } },
  { id: 'design-visibility', why: 'designs are private until published', match: /^ALTER TABLE designs ADD COLUMN IF NOT EXISTS is_public\b/, check: { kind: 'column', table: 'designs', column: 'is_public' } },
  { id: 'design-owner', why: 'who owns a design, which every owner-only route checks', match: /^ALTER TABLE designs ADD COLUMN IF NOT EXISTS owner_id\b/, check: { kind: 'column', table: 'designs', column: 'owner_id' } },
  { id: 'takedown', why: 'a moderator’s takedown is permanent: its owner cannot publish it again (audit round four)', match: /^ALTER TABLE designs ADD COLUMN IF NOT EXISTS taken_down_at\b/, check: { kind: 'column', table: 'designs', column: 'taken_down_at' } },
  { id: 'trash', why: 'a design in the Trash is private, and a restore puts back only what it was', match: /^ALTER TABLE designs ADD COLUMN IF NOT EXISTS deleted_at\b/, check: { kind: 'column', table: 'designs', column: 'deleted_at' } },
  // The content hashes, kept by the database for every writer (stage 2
  // review): a stale one serves a replaced picture as a 304 and keeps showing
  // anonymous viewers a banner the owner removed (the stripped-scene cache).
  { id: 'thumbnail-hash-fn', why: 'the picture’s hash is computed by the database from the bytes, whichever release wrote them', match: /^CREATE OR REPLACE FUNCTION tifo_thumbnail_hash\(\)/, check: { kind: 'function', name: 'tifo_thumbnail_hash', body: "NEW.thumbnail_hash := CASE WHEN NEW.thumbnail IS NULL THEN NULL ELSE encode(sha256(NEW.thumbnail), 'hex') END" } },
  { id: 'thumbnail-hash', why: 'a replaced picture is never answered 304 to its old ETag, whichever release wrote it', match: /^DO \$\$ BEGIN DROP TRIGGER IF EXISTS designs_thumbnail_hash\b/, check: { kind: 'trigger', table: 'designs', name: 'designs_thumbnail_hash', fn: 'tifo_thumbnail_hash', column: 'thumbnail' } },
  { id: 'scene-hash-fn', why: 'the scene’s hash is computed by the database from the bytes, whichever release wrote them', match: /^CREATE OR REPLACE FUNCTION tifo_scene_hash\(\)/, check: { kind: 'function', name: 'tifo_scene_hash', body: "NEW.scene_hash := CASE WHEN NEW.scene IS NULL THEN NULL ELSE encode(sha256(NEW.scene), 'hex') END" } },
  { id: 'scene-hash', why: 'anonymous viewers never keep seeing a banner the owner removed, whichever release saved the scene', match: /^DO \$\$ BEGIN DROP TRIGGER IF EXISTS design_scenes_scene_hash\b/, check: { kind: 'trigger', table: 'design_scenes', name: 'design_scenes_scene_hash', fn: 'tifo_scene_hash', column: 'scene' } },
];

/** The security statements that keep the stored content hashes right (see trustedHashes in server.ts). */
export const HASH_STATEMENT_IDS: readonly string[] = ['thumbnail-hash-fn', 'thumbnail-hash', 'scene-hash-fn', 'scene-hash'];

/** What a boot did with the schema (for the boot line, the tests and the posture panel). */
export interface SchemaReport {
  total: number;
  /** Recorded already: not run. */
  skipped: number;
  /** Not recorded, but already in force: recorded, not run. */
  present: number;
  /** Run and recorded. */
  applied: number;
  /** Not in force; tried again at the next boot. */
  failed: { head: string; error: string }[];
  /** Security statements not in force after this boot. */
  pendingSecurity: { id: string; why: string }[];
  /**
   * Security statements this boot ran (first applied, or run again because
   * what they make was missing, disabled or changed). See hashTrustAfterBoot.
   */
  ran: string[];
}

const statementHash = (stmt: string): string => createHash('sha256').update(stmt).digest('hex');
const headOf = (stmt: string): string => stmt.replace(/\s+/g, ' ').slice(0, 90);

/** A client that can run queries and be handed back. */
export interface LedgerClient extends SqlRunner {
  release(destroy?: boolean): void;
}

/**
 * Is what this statement would make already there? Only for the three shapes
 * where IF NOT EXISTS means running it again changes nothing; undefined for
 * anything else (the ledger decides). Catalogue reads take no table lock.
 */
async function alreadyThere(db: SqlRunner, stmt: string): Promise<boolean | undefined> {
  const body = statementBody(stmt).replace(/;\s*$/, '');
  // Two statements in one text: one being there says nothing about the other.
  if (withoutDollarQuotes(body).includes(';')) return undefined;
  let m = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/i.exec(body);
  if (m) {
    const r = await db.query(
      `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = current_schema()`,
      [m[1].toLowerCase()],
    );
    return r.rows[0]?.valid === true;
  }
  m = /^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/i.exec(body);
  if (m) {
    const r = await db.query(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
      [m[1].toLowerCase(), m[2].toLowerCase()],
    );
    return r.rows.length > 0;
  }
  m = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(body);
  if (m) {
    const r = await db.query('SELECT to_regclass($1) IS NOT NULL AS there', [m[1].toLowerCase()]);
    return r.rows[0]?.there === true;
  }
  return undefined;
}

/** A statement's text with its $$-quoted bodies (functions, DO blocks) left out. */
export function withoutDollarQuotes(sql: string): string {
  return sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$$$');
}

/** Is this security statement in force, as the catalogue has it? Lock-free reads only. */
export async function inForce(db: SqlRunner, check: CatalogueCheck): Promise<boolean> {
  switch (check.kind) {
    case 'index': {
      const r = await db.query(
        `SELECT i.indisvalid AND (i.indisunique OR NOT $2::boolean) AS ok FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = current_schema()`,
        [check.name, check.unique],
      );
      return r.rows[0]?.ok === true;
    }
    case 'column': {
      const r = await db.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
        [check.table, check.column],
      );
      return r.rows.length > 0;
    }
    case 'table': {
      const r = await db.query(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND c.relkind IN ('r', 'p') AND n.nspname = current_schema()",
        [check.name],
      );
      return r.rows.length > 0;
    }
    case 'function': {
      const r = await db.query(
        'SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = $1 AND n.nspname = current_schema()',
        [check.name],
      );
      const squash = (x: string): string => x.replace(/\s+/g, ' ');
      return r.rows.some((row) => squash(String(row.prosrc)).includes(squash(check.body)));
    }
    case 'trigger': {
      // Fires in an ordinary session: tgenabled 'O' (origin) or 'A' (always);
      // 'D' is disabled and 'R' fires only under session_replication_role =
      // replica, never for the server's writes (stage 2 review).
      // tgtype bits: 1 row, 2 before, 4 insert, 16 update. An UPDATE OF list
      // (tgattr) must include the bytes column; an empty list fires on any update.
      const r = await db.query(
        `SELECT 1 FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = $4
          WHERE c.relname = $1 AND t.tgname = $2 AND p.proname = $3 AND n.nspname = current_schema()
            AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND (t.tgtype & 23) = 23
            AND (cardinality(t.tgattr::int2[]) = 0 OR a.attnum = ANY (t.tgattr::int2[]))`,
        [check.table, check.name, check.fn, check.column],
      );
      return r.rows.length > 0;
    }
  }
}

/**
 * Runs schema statements through the ledger, on one connection of the
 * maintenance pool. `run` is also what the repositories' own init() take, so
 * their tables go through the same rules.
 */
export class SchemaLedger {
  private done = new Set<string>();

  constructor(
    private readonly pool: { connect(): Promise<LedgerClient> },
    private readonly opts: { ledger?: string; lockTimeoutMs?: number; security?: readonly SecurityStatement[]; log?: (m: string) => void } = {},
  ) {}

  private get table(): string {
    return this.opts.ledger ?? SCHEMA_LEDGER;
  }

  /** Create the ledger if there is none, and read what it holds. */
  async load(): Promise<void> {
    await this.withClient(async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
        hash       TEXT PRIMARY KEY,
        head       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const rows = await c.query(`SELECT hash FROM ${this.table}`);
      this.done = new Set(rows.rows.map((r) => String(r.hash)));
    });
  }

  private async withClient<T>(f: (c: LedgerClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken = false;
    try {
      return await f(c);
    } catch (e) {
      broken = isBrokenConnection(e);
      throw e;
    } finally {
      c.release(broken);
    }
  }

  private get rules(): readonly SecurityStatement[] {
    return this.opts.security ?? SECURITY_STATEMENTS;
  }

  private ruleFor(stmt: string): SecurityStatement | undefined {
    const body = statementBody(stmt);
    return this.rules.find((s) => s.match.test(body));
  }

  /**
   * One statement. 'skipped' (recorded), 'present' (already in force, now
   * recorded) or 'applied'; throws when it could not be made to take effect.
   */
  async run(stmt: string): Promise<'skipped' | 'present' | 'applied'> {
    const sql = stmt.trim();
    const hash = statementHash(sql);
    const rule = this.ruleFor(sql);
    return this.withClient(async (c) => {
      const recorded = this.done.has(hash);
      if (recorded) {
        if (!rule) return 'skipped';
        // A security statement is checked against the catalogue every boot,
        // and run again when what it makes is not in force.
        if (await inForce(c, rule.check)) return 'skipped';
      }
      // Recorded without running only for the IF NOT EXISTS shapes, where
      // running it would change nothing (a function or a trigger would).
      const there = recorded ? false : await alreadyThere(c, sql);
      if (there === true && (!rule || (await inForce(c, rule.check)))) {
        await c.query(`INSERT INTO ${this.table} (hash, head) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [hash, headOf(sql)]);
        this.done.add(hash);
        return 'present';
      }
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.round((this.opts.lockTimeoutMs ?? SCHEMA_LOCK_TIMEOUT_MS)))}ms'`);
        await c.query(sql);
        await c.query(`INSERT INTO ${this.table} (hash, head) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [hash, headOf(sql)]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
      this.done.add(hash);
      return 'applied';
    });
  }

  /**
   * A whole file's statements, each on its own: one that fails (a lock not
   * granted within 3 s, an existing database it does not fit) is reported and
   * left for the next boot, and the rest still run.
   */
  async applyAll(statements: string[]): Promise<SchemaReport> {
    const report: SchemaReport = { total: statements.length, skipped: 0, present: 0, applied: 0, failed: [], pendingSecurity: [], ran: [] };
    for (const stmt of statements) {
      try {
        const done = await this.run(stmt);
        report[done]++;
        const rule = done === 'applied' ? this.ruleFor(stmt) : undefined;
        if (rule) report.ran.push(rule.id);
      } catch (e) {
        report.failed.push({ head: headOf(stmt), error: (e as Error).message });
        (this.opts.log ?? ((m) => console.error(m)))(`[tifo] schema statement not applied (tried again at the next boot): ${(e as Error).message} :: ${headOf(stmt)}`);
      }
    }
    report.pendingSecurity = await this.pendingSecurity(statements);
    return report;
  }

  /**
   * Every security statement among these, looked up in the catalogue now:
   * not only the ones that threw. One that ran cleanly but left nothing in
   * force (`CREATE UNIQUE INDEX IF NOT EXISTS` finding an invalid index under
   * its name, a trigger someone disabled) is pending too.
   */
  async pendingSecurity(statements: string[]): Promise<{ id: string; why: string }[]> {
    const bodies = statements.map((s) => statementBody(s));
    const rules = this.rules.filter((rule) => bodies.some((b) => rule.match.test(b)));
    return this.withClient(async (c) => {
      const out: { id: string; why: string }[] = [];
      for (const rule of rules) {
        let ok = false;
        try {
          ok = await inForce(c, rule.check);
        } catch {
          ok = false;
        }
        if (!ok) out.push({ id: rule.id, why: rule.why });
      }
      return out;
    });
  }

  /** Has this one-off task (not a statement) been done? See mark(). */
  has(task: string): boolean {
    return this.done.has(`task:${task}`);
  }

  /** Record a one-off task as done, in the ledger beside the statements. */
  async mark(task: string): Promise<void> {
    await this.withClient(async (c) => {
      await c.query(`INSERT INTO ${this.table} (hash, head) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [`task:${task}`, `task: ${task}`.slice(0, 90)]);
    });
    this.done.add(`task:${task}`);
  }

  /** Forget a one-off task, so it runs again. */
  async unmark(task: string): Promise<void> {
    await this.withClient(async (c) => {
      await c.query(`DELETE FROM ${this.table} WHERE hash = $1`, [`task:${task}`]);
    });
    this.done.delete(`task:${task}`);
  }
}

/** The ledger's record that every stored content hash was recomputed from its bytes. */
export const HASH_RECOMPUTE_TASK = 'content-hashes-recomputed-v1';

/**
 * After a boot: may the stored content hashes be believed, and must the
 * one-time recompute run (stage 2 review)?
 *
 * Only while the hash triggers and their functions are in force, and only once
 * every hash stored before them has been recomputed from its bytes. A boot
 * that had to run any of those statements (the first time, or again because a
 * trigger was missing, disabled, replica-only or its function changed) cannot
 * know what was written while they were not in force, so the recompute is
 * forgotten and runs again before anything stored is believed.
 */
export async function hashTrustAfterBoot(ledger: SchemaLedger, report: SchemaReport): Promise<{ inForce: boolean; trusted: boolean; recompute: boolean }> {
  const inForce = !report.pendingSecurity.some((p) => HASH_STATEMENT_IDS.includes(p.id));
  if (report.ran.some((id) => HASH_STATEMENT_IDS.includes(id)) && ledger.has(HASH_RECOMPUTE_TASK)) await ledger.unmark(HASH_RECOMPUTE_TASK);
  const done = ledger.has(HASH_RECOMPUTE_TASK);
  return { inForce, trusted: inForce && done, recompute: inForce && !done };
}

function isBrokenConnection(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && (code.startsWith('08') || code === '57P01');
}

/**
 * Indexes on foreign keys that had none (performance plan P1.25).
 *
 * Postgres indexes the referenced side of a foreign key (a primary key) but
 * not the referencing column, and every ON DELETE CASCADE / SET NULL looks the
 * referencing rows up by that column. Without these, deleting one design with
 * 44 comments scanned the whole notifications table once per comment (1.5 s on
 * a database of 50k notifications), the Trash sweep took 2 s, and an account
 * deletion scanned comments, votes, reports and feedback in full.
 * `auth_tokens (user_id)` was added in audit round six and is in schema.sql.
 *
 * Built CONCURRENTLY, so a build never blocks the writes it waits for, which
 * is also why they are not in schema.sql: CONCURRENTLY cannot run inside a
 * transaction, and schema.sql is applied as a single multi-statement query in
 * places (tests), which Postgres runs as one. They change no result, only how
 * a row is found.
 */
export const FOREIGN_KEY_INDEXES: readonly { name: string; table: string; column: string }[] = [
  { name: 'comments_author_idx', table: 'comments', column: 'author_id' },
  { name: 'comments_parent_idx', table: 'comments', column: 'parent_id' },
  { name: 'notifications_actor_idx', table: 'notifications', column: 'actor_id' },
  { name: 'notifications_design_idx', table: 'notifications', column: 'design_id' },
  { name: 'notifications_comment_idx', table: 'notifications', column: 'comment_id' },
  { name: 'design_votes_user_idx', table: 'design_votes', column: 'user_id' },
  { name: 'moderation_reports_reporter_idx', table: 'moderation_reports', column: 'reporter_id' },
  { name: 'feedback_user_idx', table: 'feedback', column: 'user_id' },
];

/** Enough of a pg client or pool to run the statements below. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Make sure every index above exists and is usable. Safe to run on every
 * boot, on a running site and from two instances at once:
 *
 *  - an index that is there and valid costs one catalogue read;
 *  - one a previous build left INVALID (a CONCURRENTLY build that was
 *    interrupted leaves its half-built index behind, and IF NOT EXISTS would
 *    then skip it for ever while every write kept maintaining it) is dropped,
 *    concurrently, and built again;
 *  - a failure (a table that does not exist yet, a lock not granted within the
 *    lock timeout, a statement timeout) is logged and the next index tried.
 *    Nothing here can stop the server: it runs after the port is open.
 *
 * Each statement is its own query, on a connection of its own, outside any
 * transaction, as CONCURRENTLY requires; the session's timeouts are set for the
 * build and put back before the connection returns to its pool.
 */
export async function applyForeignKeyIndexes(
  pool: { connect(): Promise<SqlRunner & { release(destroy?: boolean): void }> },
  log: (msg: string) => void = (m) => console.error(m),
): Promise<{ built: string[]; failed: string[] }> {
  const built: string[] = [];
  const failed: string[] = [];
  const client = await pool.connect();
  let broken = false;
  try {
    // A build reads its table twice and waits for older transactions; on a
    // large table that can take minutes, which is fine here (nothing waits on
    // it) but not under a request's 10 s. A lock that cannot be had quickly is
    // left for the next boot rather than queued behind.
    await client.query("SET statement_timeout = '15min'");
    await client.query("SET lock_timeout = '10s'");
    for (const ix of FOREIGN_KEY_INDEXES) {
      try {
        const found = await client.query(
          `SELECT i.indisvalid AS valid FROM pg_class c
             JOIN pg_index i ON i.indexrelid = c.oid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = current_schema()`,
          [ix.name],
        );
        if (found.rows[0]?.valid === true) continue;
        if (found.rows.length) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${ix.name}`);
        await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix.name} ON ${ix.table} (${ix.column})`);
        built.push(ix.name);
      } catch (e) {
        failed.push(ix.name);
        log(`[tifo] index ${ix.name} not built (it will be tried again at the next boot): ${(e as Error).message}`);
      }
    }
  } catch (e) {
    broken = true;
    log(`[tifo] foreign-key indexes skipped: ${(e as Error).message}`);
  } finally {
    try {
      if (!broken) await client.query('RESET statement_timeout; RESET lock_timeout');
    } catch {
      broken = true;
    }
    // A connection whose settings could not be put back is not returned to the pool.
    client.release(broken);
  }
  return { built, failed };
}
