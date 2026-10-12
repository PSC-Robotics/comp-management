import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { cornerColoursSchema, isValidTimeZone } from '../domain/display.js';
import { findCompetition } from '../services/competitions.js';

export function registerCompetitionRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions', { preHandler: requireAdmin }, async () => {
    const result = await pool.query(
      `SELECT c.id, c.name, c.slug, c.status, c.timezone, c.match_duration_seconds,
              (SELECT count(*)::int FROM teams t WHERE t.competition_id = c.id AND t.active) AS team_count,
              (SELECT count(*)::int FROM matches m WHERE m.competition_id = c.id) AS match_count,
              (SELECT count(*)::int FROM challenges ch WHERE ch.competition_id = c.id) AS challenge_count,
              (SELECT count(*)::int FROM challenge_completions cc JOIN challenges ch ON ch.id = cc.challenge_id
               WHERE ch.competition_id = c.id) AS challenge_completion_count,
              (SELECT count(*)::int FROM competition_events ce WHERE ce.competition_id = c.id) AS event_count
       FROM competitions c ORDER BY c.created_at DESC`
    );
    return result.rows;
  });

  app.post('/api/admin/competitions', { preHandler: requireAdmin }, async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(120),
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
      timezone: z.string().trim().min(1).max(80).default('UTC'),
      matchDurationSeconds: z.number().int().min(1).max(7200).default(120)
    }).parse(request.body);
    const id = randomUUID();
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO competitions (id, name, slug, timezone, match_duration_seconds)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, body.name, body.slug, body.timezone, body.matchDurationSeconds]
      );
      await audit(client, adminEmail(request), 'competition.created', 'competition', id, body);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.delete('/api/admin/competitions/:slug', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({ confirmation: z.string() }).parse(request.body);
    if (body.confirmation !== slug) return reply.code(400).send({ error: 'Type the competition slug to confirm deletion' });
    const result = await transaction(async (client) => {
      const competition = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM competitions WHERE slug = $1 FOR UPDATE',
        [slug]
      );
      const row = competition.rows[0];
      if (!row) return undefined;
      await client.query(
        `DELETE FROM score_revisions
         WHERE match_id IN (SELECT id FROM matches WHERE competition_id = $1)
            OR team_id IN (SELECT id FROM teams WHERE competition_id = $1)`,
        [row.id]
      );
      await client.query(
        `DELETE FROM challenge_completions
         WHERE challenge_id IN (SELECT id FROM challenges WHERE competition_id = $1)`,
        [row.id]
      );
      await client.query(
        `DELETE FROM audit_events
         WHERE entity_type = 'playoff_match'
           AND entity_id IN (
             SELECT pm.id::text FROM playoff_matches pm
             JOIN playoff_brackets pb ON pb.id = pm.bracket_id
             WHERE pb.competition_id = $1
           )`,
        [row.id]
      );
      await client.query(
        `DELETE FROM audit_events
         WHERE (entity_type = 'team' AND entity_id IN (SELECT id::text FROM teams WHERE competition_id = $1))
            OR (entity_type = 'match' AND entity_id IN (SELECT id::text FROM matches WHERE competition_id = $1))
            OR (entity_type = 'playoff_bracket' AND entity_id IN (SELECT id::text FROM playoff_brackets WHERE competition_id = $1))
            OR (entity_type = 'public_display' AND entity_id IN (SELECT id::text FROM public_displays WHERE competition_id = $1))
            OR (entity_type = 'challenge' AND entity_id IN (SELECT id::text FROM challenges WHERE competition_id = $1))`,
        [row.id]
      );
      await client.query('DELETE FROM matches WHERE competition_id = $1', [row.id]);
      await client.query(
        `DELETE FROM playoff_matches
         WHERE bracket_id IN (SELECT id FROM playoff_brackets WHERE competition_id = $1)`,
        [row.id]
      );
      await client.query('DELETE FROM teams WHERE competition_id = $1', [row.id]);
      await client.query('DELETE FROM competitions WHERE id = $1', [row.id]);
      await audit(client, adminEmail(request), 'competition.deleted', 'competition', row.id, {
        name: row.name,
        slug
      });
      return row;
    });
    if (!result) return reply.code(404).send({ error: 'Competition not found' });
    return reply.code(204).send();
  });

  app.get('/api/admin/competitions/:slug/settings', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    await pool.query(
      'INSERT INTO competition_settings (competition_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [competition.id]
    );
    const settings = await pool.query(
      `SELECT theme, logo_data_url, auto_run_enabled, corner_colours, updated_at
       FROM competition_settings WHERE competition_id = $1`,
      [competition.id]
    );
    return { competition, settings: settings.rows[0] };
  });

  app.put('/api/admin/competitions/:slug/settings', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      theme: z.enum(['paper', 'field', 'night']),
      timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, 'Use a valid IANA timezone'),
      logoDataUrl: z.string().max(1_400_000).nullable()
    }).parse(request.body);
    if (body.logoDataUrl) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.logoDataUrl);
      if (!match) return reply.code(400).send({ error: 'Logo must be PNG, JPEG or WebP image data' });
      const bytes = Buffer.from(match[2]!, 'base64');
      const validSignature = match[1] === 'png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : match[1] === 'jpeg'
          ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (bytes.length > 1024 * 1024 || !validSignature) {
        return reply.code(400).send({ error: 'Logo file is invalid or exceeds 1 MB' });
      }
    }
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    await transaction(async (client) => {
      await client.query('UPDATE competitions SET timezone = $2 WHERE id = $1',
        [competition.id, body.timezone]);
      await client.query(
        `INSERT INTO competition_settings (competition_id, theme, logo_data_url, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (competition_id) DO UPDATE
         SET theme = EXCLUDED.theme, logo_data_url = EXCLUDED.logo_data_url, updated_at = now()`,
        [competition.id, body.theme, body.logoDataUrl]
      );
      await audit(client, adminEmail(request), 'settings.updated', 'competition', competition.id, {
        theme: body.theme,
        timezone: body.timezone,
        hasLogo: Boolean(body.logoDataUrl)
      });
    });
    return { ok: true };
  });

  app.put('/api/admin/competitions/:slug/arena-settings', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({ cornerColours: cornerColoursSchema }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      await client.query(
        `INSERT INTO competition_settings (competition_id, corner_colours, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (competition_id) DO UPDATE
         SET corner_colours = EXCLUDED.corner_colours, updated_at = now()`,
        [competition.id, JSON.stringify(body.cornerColours)]
      );
      await client.query(
        `UPDATE match_positions SET colour = CASE position_number
           WHEN 1 THEN $2 WHEN 2 THEN $3 WHEN 3 THEN $4 WHEN 4 THEN $5 END
         WHERE match_id IN (SELECT id FROM matches WHERE competition_id = $1)`,
        [competition.id, ...body.cornerColours]
      );
      await audit(client, adminEmail(request), 'arena.colours_updated', 'competition', competition.id, {
        cornerColours: body.cornerColours
      });
    });
    return { ok: true, cornerColours: body.cornerColours };
  });


  app.get('/api/admin/competitions/:slug/auto-run', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query<{ auto_run_enabled: boolean }>(
      'SELECT auto_run_enabled FROM competition_settings WHERE competition_id = $1',
      [competition.id]
    );
    return { enabled: result.rows[0]?.auto_run_enabled ?? false };
  });

  app.put('/api/admin/competitions/:slug/auto-run', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO competition_settings (competition_id, auto_run_enabled)
         VALUES ($1, $2)
         ON CONFLICT (competition_id) DO UPDATE
         SET auto_run_enabled = EXCLUDED.auto_run_enabled, updated_at = now()`,
        [competition.id, enabled]
      );
      await audit(client, adminEmail(request), enabled ? 'competition.auto_run_enabled' : 'competition.auto_run_disabled',
        'competition', competition.id, { enabled });
    });
    return { enabled };
  });

  app.post('/api/admin/competitions/:slug/publish', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    if (competition.status !== 'draft') {
      return reply.code(409).send({ error: `Cannot publish a competition in ${competition.status} state` });
    }
    await transaction(async (client) => {
      await client.query(`UPDATE competitions SET status = 'published' WHERE id = $1`, [competition.id]);
      await audit(client, adminEmail(request), 'competition.published', 'competition', competition.id);
    });
    return { ok: true, status: 'published' };
  });


}
