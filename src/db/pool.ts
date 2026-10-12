import { Pool, type PoolClient } from 'pg';
import { env } from '../config.js';
import { notifyChange } from '../services/changes.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  // A runaway query must not hold a connection (and the competition lock) forever.
  statement_timeout: 30_000
});

// Without listeners, a dropped connection (e.g. a database restart) emits an unhandled
// 'error' event that crashes Node. Idle connections report on the pool; connections in use
// report on the client itself, so every new client gets a listener too.
pool.on('error', (error) => {
  console.error('PostgreSQL idle client error', error.message);
});
pool.on('connect', (client) => {
  client.on('error', (error) => {
    console.error('PostgreSQL connection error', error.message);
  });
});

const changedClients = new WeakSet<PoolClient>();

/** Marks the transaction as having changed competition data, so clients are told after commit. */
export function markChanged(client: PoolClient): void {
  changedClients.add(client);
}

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    if (changedClients.has(client)) notifyChange();
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The connection is unusable; destroy it instead of returning it to the pool.
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    changedClients.delete(client);
    client.release(broken);
  }
}
