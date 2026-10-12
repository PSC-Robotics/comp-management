import { randomUUID } from 'node:crypto';
import { markChanged } from './pool.js';
import { type PoolClient } from 'pg';

export async function audit(
  client: PoolClient,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actor, action, entityType, entityId, JSON.stringify(details)]
  );
  markChanged(client);
}
