import pg from 'pg';

/**
 * The server's Postgres pools.
 *
 * Two of them (performance plan P1.26):
 *
 *  - `app`, for requests: 20 connections; a request waits at most 5 s for one
 *    and a statement runs at most 10 s, as does a transaction left idle. The
 *    pool used to be pg's defaults: 10 connections, an unbounded wait and no
 *    statement limit, so a burst queued 100+ requests behind ten connections
 *    with no end, and one slow query could hold a connection for as long as
 *    it liked. Now the burst gets fast 503s and the slow query an error.
 *  - `maintenance`, for the work that is slow by nature and must never take
 *    the requests' connections: the schema at boot, purges and the Trash
 *    sweep, the admin dashboard's aggregates, account erasure. Two
 *    connections and a minute per statement. The admin page could otherwise
 *    take every connection the site has.
 *
 * Every error a timeout produces goes through the routes' error handler (no
 * driver message reaches a caller), and every check that reads the database
 * refuses when the read fails (audit round six, and the fail-closed review
 * that came with these limits).
 *
 * node-postgres emits 'error' when a connection dies: the database restarts,
 * Railway moves it, a network blip drops the socket. An EventEmitter 'error'
 * with no listener is thrown, so with no listener that one event killed the
 * whole process, every request in flight with it, followed by a 20-30 s reboot
 * (audit round six). Two listeners per pool, because there are two emitters.
 * The pool reports a client that dies while idle in it. A client that dies
 * while checked out (in the middle of a transaction) reports on itself, and
 * the pool does not listen to it then. With both, the query in flight fails
 * with an error, the dead client is dropped when it is released, and the next
 * query opens a new one.
 *
 * Only the message is logged: the error can carry connection details, and the
 * connection string carries the password.
 */
export type PoolRole = 'app' | 'maintenance';

export const POOL_SETTINGS: Record<PoolRole, pg.PoolConfig> = {
  app: {
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
  },
  maintenance: {
    // Three, not two: on the first boot after a deploy the foreign-key index
    // build holds one for minutes, and erasure, the trash sweep and the admin
    // pages share the rest (found by the performance plan's security review).
    max: 3,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    statement_timeout: 60_000,
    idle_in_transaction_session_timeout: 60_000,
  },
};

export function createPool(connectionString: string, role: PoolRole = 'app'): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...POOL_SETTINGS[role] });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      console.error(`[tifo] database connection lost (${role} pool; it will reconnect):`, err.message);
    });
  });
  // The pool passes on what its idle client already reported to the listener
  // above, so this one only has to exist.
  pool.on('error', () => {});
  return pool;
}

/**
 * Is this the database being slow or unreachable, rather than a bug? Such an
 * error answers 503 "try again", never a guess at what the data said.
 *
 * Statement and idle-transaction timeouts, a pool with no free connection
 * within its wait, too many connections, the server shutting down or
 * restarting, and a connection that broke.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (['57014', '25P03', '53300', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006'].includes(code)) return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return msg === 'timeout exceeded when trying to connect'
    || msg.startsWith('Connection terminated')
    || msg === 'Client has encountered a connection error and is not queryable'
    || msg === 'Client was closed and is not queryable';
}
