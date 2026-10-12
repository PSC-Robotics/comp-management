import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { findCompetition } from '../services/competitions.js';
import { refreshUnstartedPlayoffSeeds } from '../services/playoffs.js';

export function registerChallengeRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions/:slug/challenges', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query(
      `SELECT challenge.id, challenge.name, challenge.description, challenge.points, challenge.created_at,
              jsonb_agg(jsonb_build_object(
                'teamId', team.id, 'code', team.code, 'name', team.name,
                'completedAt', completion.completed_at
              ) ORDER BY team.code) FILTER (WHERE team.id IS NOT NULL) AS teams
       FROM challenges challenge
       LEFT JOIN challenge_completions completion ON completion.challenge_id = challenge.id
       LEFT JOIN teams team ON team.id = completion.team_id
       WHERE challenge.competition_id = $1
       GROUP BY challenge.id ORDER BY challenge.created_at, challenge.name`,
      [competition.id]
    );
    return result.rows;
  });

  app.post('/api/admin/competitions/:slug/challenges', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).default(''),
      points: z.number().finite().min(0).max(1_000_000)
    }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const id = randomUUID();
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO challenges (id, competition_id, name, description, points, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, competition.id, body.name, body.description, body.points, adminEmail(request)]
      );
      await audit(client, adminEmail(request), 'challenge.created', 'challenge', id, body);
    });
    return reply.code(201).send({ id, ...body, teams: [] });
  });

  app.post('/api/admin/challenges/:challengeId/completions', { preHandler: requireAdmin }, async (request, reply) => {
    const { challengeId } = z.object({ challengeId: z.string().uuid() }).parse(request.params);
    const body = z.object({ teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/) }).parse(request.body);
    const result = await transaction(async (client) => {
      const challengeResult = await client.query<{ competition_id: string; name: string; points: string }>(
        'SELECT competition_id, name, points FROM challenges WHERE id = $1 FOR UPDATE',
        [challengeId]
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) return { status: 404 as const, error: 'Challenge not found' };
      const teamResult = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM teams WHERE competition_id = $1 AND code = $2 AND active = true',
        [challenge.competition_id, body.teamCode]
      );
      const team = teamResult.rows[0];
      if (!team) return { status: 404 as const, error: 'Active team not found in this competition' };
      const inserted = await client.query(
        `INSERT INTO challenge_completions (challenge_id, team_id, completed_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING challenge_id`,
        [challengeId, team.id, adminEmail(request)]
      );
      if (!inserted.rowCount) return { status: 409 as const, error: 'This team has already completed this challenge' };
      await audit(client, adminEmail(request), 'challenge.completed', 'challenge', challengeId, {
        challengeName: challenge.name,
        teamCode: body.teamCode,
        points: challenge.points
      });
      await refreshUnstartedPlayoffSeeds(client, challenge.competition_id, adminEmail(request));
      return { status: 201 as const, ok: true, teamCode: body.teamCode, points: challenge.points };
    });
    return reply.code(result.status).send(result);
  });

  app.delete('/api/admin/challenges/:challengeId/completions/:teamCode', { preHandler: requireAdmin }, async (request, reply) => {
    const params = z.object({
      challengeId: z.string().uuid(),
      teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
    }).parse(request.params);
    const result = await transaction(async (client) => {
      const challengeResult = await client.query<{ competition_id: string; name: string; points: string }>(
        'SELECT competition_id, name, points FROM challenges WHERE id = $1 FOR UPDATE',
        [params.challengeId]
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) return { status: 404 as const, error: 'Challenge not found' };
      const completion = await client.query<{ team_id: string; name: string; points: string }>(
        `SELECT completion.team_id, $4::text AS name, $5::numeric AS points
         FROM challenge_completions completion
         JOIN teams team ON team.id = completion.team_id
         WHERE completion.challenge_id = $1 AND team.code = $2 AND team.competition_id = $3
         FOR UPDATE OF completion`,
        [params.challengeId, params.teamCode, challenge.competition_id, challenge.name, challenge.points]
      );
      const row = completion.rows[0];
      if (!row) return { status: 404 as const, error: 'Challenge completion not found' };
      await client.query(
        'DELETE FROM challenge_completions WHERE challenge_id = $1 AND team_id = $2',
        [params.challengeId, row.team_id]
      );
      await audit(client, adminEmail(request), 'challenge.completion_undone', 'challenge', params.challengeId, {
        challengeName: row.name,
        teamCode: params.teamCode,
        points: challenge.points
      });
      await refreshUnstartedPlayoffSeeds(client, challenge.competition_id, adminEmail(request));
      return { status: 200 as const, ok: true, teamCode: params.teamCode, points: challenge.points };
    });
    return reply.code(result.status).send(result);
  });


}
