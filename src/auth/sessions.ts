import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { adminEmailAllowlist, env } from '../config.js';
import { pool } from '../db/pool.js';

export const sessionCookie = 'competition_session';
export const sessionHours = 12;

export type AdminIdentity = {
  userId: string;
  email: string;
  method: 'oidc' | 'passkey';
  tokenHash: string;
};

export type AdminRequest = FastifyRequest & { adminEmail: string; admin: AdminIdentity };

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function emailAllowed(email: string): boolean {
  return adminEmailAllowlist.size === 0 || adminEmailAllowlist.has(email.toLowerCase());
}

export type AdminUser = { id: string; email: string; disabled: boolean; display_name: string };

/** Finds or creates the administrator record for an identity-provider account. */
export async function upsertAdminUser(client: Pool | PoolClient, email: string, displayName = ''): Promise<AdminUser> {
  const result = await client.query<AdminUser>(
    `INSERT INTO admin_users (id, email, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET display_name = CASE
       WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE admin_users.display_name END
     RETURNING id, email, disabled, display_name`,
    [randomUUID(), email.toLowerCase(), displayName.slice(0, 120)]
  );
  return result.rows[0]!;
}

/** Issues a new session cookie. The token is random; only its hash is stored. */
export async function createSession(reply: FastifyReply, user: AdminUser, method: AdminIdentity['method']): Promise<void> {
  const rawToken = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, email, user_id, method, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 hour'))`,
    [hashToken(rawToken), user.email, user.id, method, sessionHours]
  );
  await pool.query(
    'UPDATE admin_users SET last_login_at = now(), last_login_method = $2 WHERE id = $1',
    [user.id, method]
  );
  reply.setCookie(sessionCookie, rawToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
    maxAge: sessionHours * 60 * 60
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawToken = request.cookies[sessionCookie];
  if (rawToken) await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(rawToken)]);
  reply.clearCookie(sessionCookie, { path: '/' });
}

/** Rejects the request unless it carries a live session for an enabled, permitted administrator. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawToken = request.cookies[sessionCookie];
  if (!rawToken || rawToken.length > 200) {
    await reply.code(401).send({ error: 'Administrator sign-in required' });
    return;
  }
  const tokenHash = hashToken(rawToken);
  const result = await pool.query<{
    email: string; user_id: string | null; method: string; disabled: boolean | null; stale: boolean;
  }>(
    `SELECT s.email, s.user_id, s.method, u.disabled,
            s.last_seen_at < now() - interval '5 minutes' AS stale
     FROM admin_sessions s LEFT JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash]
  );
  const session = result.rows[0];
  if (!session || session.disabled || !emailAllowed(session.email)) {
    if (session) await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash]);
    await reply.clearCookie(sessionCookie, { path: '/' }).code(401)
      .send({ error: session ? 'This account is not allowed to administer competitions' : 'Session expired' });
    return;
  }
  let userId = session.user_id;
  if (!userId) {
    // Sessions created before administrator accounts existed: attach them to an account.
    const user = await upsertAdminUser(pool, session.email);
    if (user.disabled) {
      await reply.clearCookie(sessionCookie, { path: '/' }).code(401).send({ error: 'This account is disabled' });
      return;
    }
    userId = user.id;
    await pool.query('UPDATE admin_sessions SET user_id = $2 WHERE token_hash = $1', [tokenHash, userId]);
  }
  if (session.stale) {
    await pool.query('UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]);
  }
  const admin: AdminIdentity = {
    userId, email: session.email, method: session.method === 'passkey' ? 'passkey' : 'oidc', tokenHash
  };
  Object.assign(request, { adminEmail: session.email, admin });
}

export function adminEmail(request: FastifyRequest): string {
  return (request as AdminRequest).adminEmail;
}

export function adminIdentity(request: FastifyRequest): AdminIdentity {
  return (request as AdminRequest).admin;
}
