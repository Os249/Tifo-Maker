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
