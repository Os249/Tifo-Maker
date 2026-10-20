import pg from 'pg';

/**
 * The server's Postgres pool.
 *
 * node-postgres emits 'error' when a connection dies: the database restarts,
 * Railway moves it, a network blip drops the socket. An EventEmitter 'error'
 * with no listener is thrown, so with no listener that one event killed the
 * whole process, every request in flight with it, followed by a 20-30 s reboot
 * (audit round six).
 *
 * Two listeners, because there are two emitters. The pool reports a client
 * that dies while idle in it. A client that dies while checked out (in the
 * middle of a transaction) reports on itself, and the pool does not listen to
 * it then. With both, the query in flight fails with an error, the dead client
 * is dropped when it is released, and the next query opens a new one.
 *
 * Only the message is logged: the error can carry connection details, and the
 * connection string carries the password.
 */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      console.error('[tifo] database connection lost (it will reconnect):', err.message);
    });
  });
  // The pool passes on what its idle client already reported to the listener
  // above, so this one only has to exist.
  pool.on('error', () => {});
  return pool;
}
