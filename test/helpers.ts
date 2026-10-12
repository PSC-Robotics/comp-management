/**
 * Integration test harness: boots the real application against a real
 * PostgreSQL database (TEST_DATABASE_URL) and talks to it with `app.inject`.
 * Each test file runs in its own process; data is isolated by unique slugs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const skip = testDatabaseUrl ? false : 'TEST_DATABASE_URL is not set';

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness(extraEnv: Record<string, string> = {}) {
  Object.assign(process.env, {
    DATABASE_URL: testDatabaseUrl,
    COOKIE_SECRET: 'integration-test-cookie-secret-0123456789',
    COOKIE_SECURE: 'false',
    PUBLIC_BASE_URL: '',
    OIDC_ISSUER: '',
    LOG_LEVEL: 'silent',
    ...extraEnv
  });
  const { buildApp } = await import('../src/app.js');
  const { pool } = await import('../src/db/pool.js');
  const { migrate } = await import('../src/db/schema.js');
  const { processMatchClocks } = await import('../src/services/clock.js');
  await migrate(pool);
  const routes: { method: string; url: string }[] = [];
  const app: FastifyInstance = await buildApp({ logger: false, routes });
  await app.ready();

  async function createAdmin(email = `admin-${randomUUID()}@test.local`) {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (id, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET disabled = false RETURNING id`, [randomUUID(), email]
    );
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO admin_sessions (token_hash, email, user_id, method, expires_at)
       VALUES ($1, $2, $3, 'oidc', now() + interval '1 hour')`,
      [createHash('sha256').update(token).digest('hex'), email, user.rows[0]!.id]
    );
    return { email, userId: user.rows[0]!.id, cookie: `competition_session=${token}` };
  }

  const admin = await createAdmin();

  async function request(options: InjectOptions & { as?: { cookie: string } | null }) {
    const { as, ...rest } = options;
    const headers = { ...(rest.headers ?? {}) } as Record<string, string>;
    const cookie = as === undefined ? admin.cookie : as?.cookie;
    if (cookie) headers.cookie = cookie;
    return app.inject({ ...rest, headers });
  }

  async function api<T = any>(method: string, url: string, payload?: unknown, expected?: number): Promise<T> {
    const response = await request({ method: method as InjectOptions['method'], url, ...(payload === undefined ? {} : { payload: payload as object }) });
    if (expected !== undefined && response.statusCode !== expected) {
      throw new Error(`${method} ${url} -> ${response.statusCode} (expected ${expected}): ${response.body.slice(0, 400)}`);
    }
    if (response.statusCode >= 500) throw new Error(`${method} ${url} -> ${response.statusCode}: ${response.body.slice(0, 400)}`);
    return (response.body ? (() => { try { return JSON.parse(response.body); } catch { return response.body; } })() : null) as T;
  }

  /** Creates a published competition with teams; returns its slug. */
  async function createCompetition(teamCount = 8, matchDurationSeconds = 60) {
    const slug = `t-${randomBytes(5).toString('hex')}`;
    await api('POST', '/api/admin/competitions', { name: `Test ${slug}`, slug, matchDurationSeconds }, 201);
    const codes = Array.from({ length: teamCount }, (_, index) =>
      String.fromCharCode(65 + Math.floor(index / 26) % 26, 65 + index % 26, 65 + (index * 7) % 26));
    for (const code of codes) await api('POST', `/api/admin/competitions/${slug}/teams`, { code, name: `Team ${code}` });
    await api('POST', `/api/admin/competitions/${slug}/publish`, {});
    return { slug, codes };
  }

  /** Moves a counting-down match/heat past its countdown, then runs the clock once. */
  async function fastForwardCountdowns() {
    await pool.query(`UPDATE matches SET countdown_started_at = countdown_started_at - interval '10 seconds' WHERE countdown_started_at IS NOT NULL`);
    await pool.query(`UPDATE playoff_matches SET countdown_started_at = countdown_started_at - interval '10 seconds' WHERE countdown_started_at IS NOT NULL`);
    await processMatchClocks();
  }

  async function close() {
    await app.close();
    await pool.end();
  }

  return { app, pool, admin, createAdmin, request, api, createCompetition, fastForwardCountdowns, processMatchClocks, routes, close };
}
