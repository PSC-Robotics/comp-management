import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { displayOptionsSchema, displayTypeSchema } from '../domain/display.js';
import { findCompetition } from '../services/competitions.js';

export function registerDisplayAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions/:slug/displays', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query(
      `SELECT id, slug, title, display_type, enabled, options, created_at, updated_at
       FROM public_displays WHERE competition_id = $1 ORDER BY created_at DESC`,
      [competition.id]
    );
    return result.rows;
  });

  app.post('/api/admin/competitions/:slug/displays', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug: competitionSlug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
      title: z.string().trim().min(1).max(120),
      type: displayTypeSchema,
      options: displayOptionsSchema.default(displayOptionsSchema.parse({}))
    }).parse(request.body);
    const competition = await findCompetition(pool, competitionSlug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const id = randomUUID();
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO public_displays (id, competition_id, slug, title, display_type, options)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [id, competition.id, body.slug, body.title, body.type, JSON.stringify(body.options)]
      );
      await audit(client, adminEmail(request), 'display.created', 'public_display', id, body);
    });
    return reply.code(201).send({
      id,
      ...body,
      enabled: true,
      htmlUrl: `/display/${body.slug}`,
      apiUrl: `/api/public/display/${body.slug}`
    });
  });

  app.patch('/api/admin/displays/:displayId', { preHandler: requireAdmin }, async (request, reply) => {
    const { displayId } = z.object({ displayId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      options: displayOptionsSchema.optional()
    }).refine((data) => Object.keys(data).length > 0).parse(request.body);
    const updated = await transaction(async (client) => {
      const result = await client.query<{ id: string; title: string; enabled: boolean; options: unknown }>(
        `UPDATE public_displays SET
           title = coalesce($2, title),
           enabled = coalesce($3, enabled),
           options = coalesce($4::jsonb, options),
           updated_at = now()
         WHERE id = $1
         RETURNING id, title, enabled, options`,
        [displayId, body.title ?? null, body.enabled ?? null,
          body.options === undefined ? null : JSON.stringify(body.options)]
      );
      if (!result.rows[0]) return undefined;
      await audit(client, adminEmail(request), 'display.updated', 'public_display', displayId, body);
      return result.rows[0];
    });
    if (!updated) return reply.code(404).send({ error: 'Public display not found' });
    return updated;
  });

  app.delete('/api/admin/displays/:displayId', { preHandler: requireAdmin }, async (request, reply) => {
    const { displayId } = z.object({ displayId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const deleted = await client.query(
        'DELETE FROM public_displays WHERE id = $1 RETURNING id',
        [displayId]
      );
      if (!deleted.rowCount) return false;
      await audit(client, adminEmail(request), 'display.deleted', 'public_display', displayId);
      return true;
    });
    if (!result) return reply.code(404).send({ error: 'Public display not found' });
    return reply.code(204).send();
  });


}
