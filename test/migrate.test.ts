import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

test('schema setup is idempotent and safe to run concurrently', { skip }, async () => {
  const { migrate } = await import('../src/db/schema.js');
  await Promise.all([migrate(h.pool), migrate(h.pool), migrate(h.pool)]);
  await migrate(h.pool);
  const tables = await h.pool.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.ok(tables.rows[0].count >= 22);
});

test('a broken database connection inside a transaction is discarded, not reused', { skip }, async () => {
  const { transaction, pool } = await import('../src/db/pool.js');
  await assert.rejects(transaction(async (client) => {
    await client.query('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => undefined);
    await client.query('SELECT 1');
  }));
  // The pool still works afterwards.
  const ok = await pool.query('SELECT 1 AS ok');
  assert.equal(ok.rows[0].ok, 1);
});
