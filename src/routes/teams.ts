import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { findCompetition } from '../services/competitions.js';
import { fetchStandings } from '../services/league.js';
import { refreshUnstartedPlayoffSeeds } from '../services/playoffs.js';

export function registerTeamRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions/:slug/teams', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query(
      `SELECT id, code, name, active FROM teams WHERE competition_id = $1 ORDER BY code`,
      [competition.id]
    );
    return result.rows;
  });

  app.get('/api/admin/competitions/:slug/league', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const standings = (await fetchStandings(pool, competition.id)).map(({ id: _id, ...team }) => team);
    return { competition: competition.name, standings };
  });

  app.post('/api/admin/competitions/:slug/teams', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
      name: z.string().trim().min(1).max(160)
    }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const duplicate = await pool.query(
      'SELECT 1 FROM teams WHERE competition_id = $1 AND code = $2',
      [competition.id, body.code]
    );
    if (duplicate.rowCount) return reply.code(409).send({ error: `Team code ${body.code} already exists in this competition` });
    const id = randomUUID();
    await transaction(async (client) => {
      await client.query(
        'INSERT INTO teams (id, competition_id, code, name) VALUES ($1, $2, $3, $4)',
        [id, competition.id, body.code, body.name]
      );
      await audit(client, adminEmail(request), 'team.created', 'team', id, body);
      await refreshUnstartedPlayoffSeeds(client, competition.id, adminEmail(request));
    });
    return reply.code(201).send({ id, ...body, active: true });
  });

  app.patch('/api/admin/teams/:teamId', { preHandler: requireAdmin }, async (request, reply) => {
    const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      active: z.boolean().optional()
    }).refine((value) => Object.keys(value).length > 0).parse(request.body);
    const updated = await transaction(async (client) => {
      const teamResult = await client.query<{ id: string; competition_id: string; name: string; active: boolean }>(
        'SELECT id, competition_id, name, active FROM teams WHERE id = $1 FOR UPDATE',
        [teamId]
      );
      const team = teamResult.rows[0];
      if (!team) return { status: 404 as const, error: 'Team not found' };
      if (body.active !== undefined && body.active !== team.active) {
        const assigned = await client.query(
          `SELECT 1 FROM match_positions WHERE team_id = $1
           UNION ALL SELECT 1 FROM playoff_matches
             WHERE team_one_id = $1 OR team_two_id = $1 OR team_three_id = $1 OR team_four_id = $1
           LIMIT 1`,
          [teamId]
        );
        if (assigned.rowCount) {
          return { status: 409 as const, error: 'A team assigned to a match cannot be deactivated or reactivated' };
        }
      }
      const result = await client.query(
        `UPDATE teams SET name = coalesce($2, name), active = coalesce($3, active)
         WHERE id = $1 RETURNING id, code, name, active`,
        [teamId, body.name ?? null, body.active ?? null]
      );
      await audit(client, adminEmail(request), 'team.updated', 'team', teamId, body);
      return { status: 200 as const, team: result.rows[0] };
    });
    if (updated.status !== 200) return reply.code(updated.status).send({ error: updated.error });
    return updated.team;
  });

  app.delete('/api/admin/teams/:teamId', { preHandler: requireAdmin }, async (request, reply) => {
    const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
    const body = z.object({ confirmation: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/) }).parse(request.body);
    const result = await transaction(async (client) => {
      const teamResult = await client.query<{ id: string; competition_id: string; code: string; name: string }>(
        'SELECT id, competition_id, code, name FROM teams WHERE id = $1 FOR UPDATE',
        [teamId]
      );
      const team = teamResult.rows[0];
      if (!team) return { status: 404 as const, error: 'Team not found' };
      if (body.confirmation !== team.code) {
        return { status: 400 as const, error: 'Team code confirmation does not match' };
      }
      const references = await client.query(
        `SELECT 1 FROM match_positions WHERE team_id = $1
         UNION ALL SELECT 1 FROM match_scores WHERE team_id = $1
         UNION ALL SELECT 1 FROM challenge_completions WHERE team_id = $1
         UNION ALL SELECT 1 FROM playoff_match_scores WHERE team_id = $1
         UNION ALL SELECT 1 FROM playoff_matches
           WHERE team_one_id = $1 OR team_two_id = $1 OR team_three_id = $1
             OR team_four_id = $1 OR winner_team_id = $1
         LIMIT 1`,
        [teamId]
      );
      if (references.rowCount) {
        return { status: 409 as const, error: 'This team has match, score, challenge or playoff history. Deactivate it to preserve those records.' };
      }
      await client.query(
        `DELETE FROM audit_events WHERE entity_type = 'team' AND entity_id = $1`,
        [teamId]
      );
      await client.query('DELETE FROM teams WHERE id = $1', [teamId]);
      await audit(client, adminEmail(request), 'team.deleted', 'team', teamId, {
        code: team.code,
        name: team.name
      });
      return { status: 204 as const };
    });
    if (result.status !== 204) return reply.code(result.status).send({ error: result.error });
    return reply.code(204).send();
  });


}
