import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { refreshUnstartedPlayoffSeeds } from '../services/playoffs.js';

export function registerScoreRoutes(app: FastifyInstance): void {
  app.get('/api/admin/matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const match = await pool.query('SELECT id FROM matches WHERE id = $1', [matchId]);
    if (!match.rowCount) return reply.code(404).send({ error: 'Match not found' });
    const scores = await pool.query(
      `SELECT t.code AS team_code, ms.result, ms.league_points, ms.revision, ms.updated_at, ms.updated_by
       FROM match_scores ms JOIN teams t ON t.id = ms.team_id
       WHERE ms.match_id = $1 ORDER BY t.code`,
      [matchId]
    );
    return scores.rows;
  });

  app.post('/api/admin/matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      reason: z.string().trim().min(1).max(500).optional(),
      scores: z.array(z.object({
        teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
        result: z.record(z.unknown()).optional(),
        leaguePoints: z.number().finite()
      })).min(1).max(4)
    }).parse(request.body);
    const result = await transaction(async (client) => {
      const match = await client.query<{ competition_id: string; state: string }>(
        `SELECT competition_id, state FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId]
      );
      const row = match.rows[0];
      if (!row) return { status: 404, error: 'Match not found' };
      if (row.state !== 'awaiting_score' && row.state !== 'complete') {
        return { status: 409, error: 'Finish the match before entering scores' };
      }
      const seen = new Set<string>();
      const assignments = await client.query<{ id: string; code: string }>(
        `SELECT t.id, t.code FROM match_positions mp JOIN teams t ON t.id = mp.team_id
         WHERE mp.match_id = $1`,
        [matchId]
      );
      const teamByCode = new Map(assignments.rows.map((team) => [team.code, team.id]));
      if (body.scores.length !== assignments.rowCount) {
        return { status: 400, error: 'Enter exactly one score for every team assigned to the match' };
      }
      const existingScores = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM match_scores WHERE match_id = $1',
        [matchId]
      );
      if ((existingScores.rows[0]?.count ?? 0) > 0 && !body.reason) {
        return { status: 400, error: 'A reason is required when correcting existing scores' };
      }
      for (const score of body.scores) {
        if (seen.has(score.teamCode)) return { status: 400, error: `Duplicate score for ${score.teamCode}` };
        if (!teamByCode.has(score.teamCode)) {
          return { status: 400, error: `${score.teamCode} is not assigned to this match` };
        }
        seen.add(score.teamCode);
      }
      for (const score of body.scores) {
        const teamId = teamByCode.get(score.teamCode);
        if (!teamId) throw new Error(`Validated match team ${score.teamCode} disappeared`);
        const prior = await client.query<{ result: unknown; league_points: string }>(
          'SELECT result, league_points FROM match_scores WHERE match_id = $1 AND team_id = $2',
          [matchId, teamId]
        );
        if (prior.rows[0]) {
          await client.query(
            `INSERT INTO score_revisions (id, match_id, team_id, result, league_points, reason, actor_email)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
            [randomUUID(), matchId, teamId, JSON.stringify(prior.rows[0].result), prior.rows[0].league_points, body.reason ?? 'Score correction', adminEmail(request)]
          );
        }
        await client.query(
          `INSERT INTO match_scores (match_id, team_id, result, league_points, updated_by)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (match_id, team_id) DO UPDATE
           SET result = EXCLUDED.result, league_points = EXCLUDED.league_points,
               updated_by = EXCLUDED.updated_by, updated_at = now(),
               revision = match_scores.revision + 1`,
          [matchId, teamId, JSON.stringify(score.result ?? prior.rows[0]?.result ?? {}), score.leaguePoints, adminEmail(request)]
        );
      }
      await client.query(
        `UPDATE matches SET state = 'complete', revision = revision + 1 WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'match.scored', 'match', matchId, { entries: body.scores.length });
      await refreshUnstartedPlayoffSeeds(client, row.competition_id, adminEmail(request));
      return { status: 200, ok: true };
    });
    return reply.code(result.status).send(result);
  });


}
