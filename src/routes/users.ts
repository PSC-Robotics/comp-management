import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminIdentity, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';

export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async (request) => {
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.disabled, u.created_at, u.last_login_at, u.last_login_method,
              (SELECT count(*)::int FROM passkeys p WHERE p.user_id = u.id) AS passkey_count,
              (SELECT count(*)::int FROM admin_sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions
       FROM admin_users u ORDER BY u.disabled, lower(u.email)`
    );
    const self = adminIdentity(request).userId;
    return result.rows.map((user) => ({ ...user, is_you: user.id === self }));
  });

  app.patch('/api/admin/users/:userId', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { disabled } = z.object({ disabled: z.boolean() }).parse(request.body);
    const identity = adminIdentity(request);
    if (userId === identity.userId && disabled) {
      return reply.code(409).send({ error: 'You cannot disable your own account' });
    }
    const result = await transaction(async (client) => {
      const updated = await client.query<{ email: string }>(
        'UPDATE admin_users SET disabled = $2 WHERE id = $1 RETURNING email', [userId, disabled]
      );
      if (!updated.rows[0]) return undefined;
      // Disabling signs the account out everywhere straight away.
      if (disabled) await client.query('DELETE FROM admin_sessions WHERE user_id = $1', [userId]);
      await audit(client, identity.email, disabled ? 'admin_user.disabled' : 'admin_user.enabled', 'admin_user', userId,
        { email: updated.rows[0].email });
      return updated.rows[0];
    });
    if (!result) return reply.code(404).send({ error: 'User not found' });
    return { ok: true };
  });

  app.delete('/api/admin/users/:userId/sessions', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const identity = adminIdentity(request);
    const removed = await transaction(async (client) => {
      const result = await client.query(
        'DELETE FROM admin_sessions WHERE user_id = $1 AND token_hash <> $2', [userId, identity.tokenHash]
      );
      await audit(client, identity.email, 'admin_user.signed_out_everywhere', 'admin_user', userId, { sessions: result.rowCount });
      return result.rowCount ?? 0;
    });
    return reply.send({ removed });
  });
}
