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
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
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
