import { type FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/sessions.js';
import { pool } from '../db/pool.js';

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get('/api/admin/audit', { preHandler: requireAdmin }, async () => {
    const result = await pool.query(
      `SELECT id, actor_email, action, entity_type, entity_id, details, created_at
       FROM audit_events ORDER BY created_at DESC LIMIT 200`
    );
    return result.rows;
  });


}
