import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { findCompetition } from '../services/competitions.js';
import { reflowSchedule } from '../services/reflow.js';

export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions/:slug/events', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query(
      `SELECT id, title, description, location, starts_at, duration_minutes, created_at
       FROM competition_events WHERE competition_id = $1 ORDER BY starts_at, title`,
      [competition.id]
    );
    return result.rows;
  });

  app.post('/api/admin/competitions/:slug/events', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).default(''),
      location: z.string().trim().max(120).default(''),
      startsAt: z.string().datetime({ offset: true }),
      durationMinutes: z.number().int().min(1).max(1440)
    }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const id = randomUUID();
    const shiftedMatchIds = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      await client.query(
        `INSERT INTO competition_events
         (id, competition_id, title, description, location, starts_at, duration_minutes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, competition.id, body.title, body.description, body.location, body.startsAt, body.durationMinutes, adminEmail(request)]
      );
      await audit(client, adminEmail(request), 'competition_event.created', 'competition_event', id, body);
      return reflowSchedule(client, competition.id, adminEmail(request), `event "${body.title}" added`, { strictEvents: true });
    });
    return reply.code(201).send({ id, ...body, shiftedMatchIds });
  });

  app.patch('/api/admin/events/:eventId', { preHandler: requireAdmin }, async (request, reply) => {
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).default(''),
      location: z.string().trim().max(120).default(''),
      startsAt: z.string().datetime({ offset: true }),
      durationMinutes: z.number().int().min(1).max(1440)
    }).parse(request.body);
    const result = await transaction(async (client) => {
      const existing = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM competition_events WHERE id = $1',
        [eventId]
      );
      const event = existing.rows[0];
      if (!event) return { status: 404 as const, error: 'Scheduled event not found' };
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [event.competition_id]);
      const updated = await client.query(
        `UPDATE competition_events SET title = $2, description = $3, location = $4,
           starts_at = $5, duration_minutes = $6 WHERE id = $1
         RETURNING id, title, description, location, starts_at, duration_minutes`,
        [eventId, body.title, body.description, body.location, body.startsAt, body.durationMinutes]
      );
      const shiftedMatchIds = await reflowSchedule(
        client, event.competition_id, adminEmail(request), `event "${body.title}" updated`, { strictEvents: true }
      );
      await audit(client, adminEmail(request), 'competition_event.updated', 'competition_event', eventId, {
        ...body,
        shiftedMatchIds
      });
      return { status: 200 as const, event: updated.rows[0], shiftedMatchIds };
    });
    return reply.code(result.status).send(result);
  });

  app.delete('/api/admin/events/:eventId', { preHandler: requireAdmin }, async (request, reply) => {
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const deleted = await client.query<{ id: string; title: string }>(
        'DELETE FROM competition_events WHERE id = $1 RETURNING id, title',
        [eventId]
      );
      if (!deleted.rows[0]) return undefined;
      await audit(client, adminEmail(request), 'competition_event.deleted', 'competition_event', eventId, {
        title: deleted.rows[0].title
      });
      return deleted.rows[0];
    });
    if (!result) return reply.code(404).send({ error: 'Scheduled event not found' });
    return reply.code(204).send();
  });


}
