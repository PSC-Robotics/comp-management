import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { transaction } from '../db/pool.js';
import { MATCH_COUNTDOWN_TOTAL_SECONDS, countdownStartTime } from '../domain/display.js';
import { calculateTimerResetStart } from '../domain/scheduler.js';
import { hasTeamInActiveMatch } from '../services/conflicts.js';
import { delayNextMatchesAfterManualStart } from '../services/reflow.js';

export function registerLiveRoutes(app: FastifyInstance): void {
  app.post('/api/admin/matches/:matchId/start', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
      const matchResult = await client.query<{
        competition_id: string;
        arena_name: string;
        state: string;
        countdown_started_at: Date | null;
      }>(
        `SELECT competition_id, arena_name, state, countdown_started_at
         FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId]
      );
      const match = matchResult.rows[0];
      if (!match) return { status: 404, error: 'Match not found' };
      if (!['scheduled', 'ready', 'delayed'].includes(match.state)) {
        return { status: 409, error: `Cannot start a ${match.state} match` };
      }
      if (match.countdown_started_at) {
        return { status: 409, error: 'This match is already counting down' };
      }
      const populated = await client.query<{ team_count: number }>(
        'SELECT count(team_id)::int AS team_count FROM match_positions WHERE match_id = $1',
        [matchId]
      );
      if ((populated.rows[0]?.team_count ?? 0) === 0) {
        return { status: 409, error: 'Cannot start a match with no assigned teams' };
      }
      const active = await client.query(
        `SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $2
         AND id <> $3 AND (
           state IN ('running', 'paused')
           OR (countdown_started_at > now() - ($4 * interval '1 second')
               AND state IN ('scheduled', 'ready', 'delayed'))
         ) LIMIT 1`,
        [match.competition_id, match.arena_name, matchId, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      if (active.rowCount) return { status: 409, error: 'Another match is already active in this arena' };
      if (await hasTeamInActiveMatch(client, match.competition_id, matchId)) {
        return { status: 409, error: 'A team in this match is already active in another arena' };
      }
      const countdown = await client.query<{ countdown_started_at: Date }>(
        `UPDATE matches SET countdown_started_at = $2, revision = revision + 1
         WHERE id = $1 RETURNING countdown_started_at`,
        [matchId, new Date(countdownStartTime(Date.now()))]
      );
      await audit(client, adminEmail(request), 'match.countdown_started', 'match', matchId, {
        countdownStartedAt: new Date(countdown.rows[0]!.countdown_started_at).toISOString(),
        durationSeconds: MATCH_COUNTDOWN_TOTAL_SECONDS
      });
      return {
        status: 200,
        ok: true,
        countdownStartedAt: new Date(countdown.rows[0]!.countdown_started_at).toISOString()
      };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/matches/:matchId/cancel-countdown', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
      const cancelled = await client.query<{ state: string }>(
        `UPDATE matches SET countdown_started_at = NULL, revision = revision + 1
         WHERE id = $1 AND countdown_started_at IS NOT NULL
           AND state IN ('scheduled', 'ready', 'delayed')
         RETURNING state`,
        [matchId]
      );
      if (!cancelled.rows[0]) return { status: 409, error: 'There is no active countdown to cancel' };
      await audit(client, adminEmail(request), 'match.countdown_cancelled', 'match', matchId);
      return { status: 200, ok: true };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/matches/:matchId/finish', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const match = await client.query<{ state: string }>(
        'SELECT state FROM matches WHERE id = $1 FOR UPDATE',
        [matchId]
      );
      const row = match.rows[0];
      if (!row) return { status: 404, error: 'Match not found' };
      if (row.state !== 'running' && row.state !== 'paused') {
        return { status: 409, error: `Cannot finish a ${row.state} match` };
      }
      await client.query(
        `UPDATE matches SET state = 'awaiting_score', actual_end = now(),
           paused_seconds = paused_seconds + CASE WHEN state = 'paused' AND paused_at IS NOT NULL
             THEN greatest(floor(extract(epoch FROM (now() - paused_at)))::int, 0) ELSE 0 END,
           paused_at = NULL, revision = revision + 1
         WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'match.finished', 'match', matchId);
      return { status: 200, ok: true };
    });
    return reply.code(result.status).send(result);
  });

  // For matches that will not be scored (friendlies, practice, a void match): close them so they
  // leave the scoring queue. Scores can still be added later.
  app.post('/api/admin/matches/:matchId/close-without-score', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(request.body);
    const result = await transaction(async (client) => {
      const match = await client.query<{ state: string; match_number: number }>(
        'SELECT state, match_number FROM matches WHERE id = $1 FOR UPDATE', [matchId]
      );
      const row = match.rows[0];
      if (!row) return { status: 404, error: 'Match not found' };
      if (row.state !== 'awaiting_score') {
        return { status: 409, error: 'Only a finished match that is waiting for scores can be closed without them' };
      }
      await client.query(`UPDATE matches SET state = 'complete', revision = revision + 1 WHERE id = $1`, [matchId]);
      await audit(client, adminEmail(request), 'match.closed_without_score', 'match', matchId, { reason, matchNumber: row.match_number });
      return { status: 200, ok: true };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/matches/:matchId/pause', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const match = await client.query<{ state: string }>(
        'SELECT state FROM matches WHERE id = $1 FOR UPDATE',
        [matchId]
      );
      const row = match.rows[0];
      if (!row) return { status: 404, error: 'Match not found' };
      if (row.state !== 'running') return { status: 409, error: `Cannot pause a ${row.state} match` };
      await client.query(
        `UPDATE matches SET state = 'paused', paused_at = now(), revision = revision + 1 WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'match.paused', 'match', matchId);
      return { status: 200, ok: true };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/matches/:matchId/resume', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
      const match = await client.query<{
        state: string;
        arena_name: string;
        match_number: number;
        effective_start: Date;
        actual_start: Date;
        duration_seconds: number;
        planned_gap_seconds: number;
        paused_seconds: number;
        paused_at: Date;
      }>(
        `SELECT state, arena_name, match_number, effective_start, actual_start,
                duration_seconds, planned_gap_seconds, paused_seconds, paused_at
         FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId]
      );
      const row = match.rows[0];
      if (!row) return { status: 404, error: 'Match not found' };
      if (row.state !== 'paused') return { status: 409, error: `Cannot resume a ${row.state} match` };
      const resumed = await client.query<{ paused_seconds: number }>(
        `UPDATE matches
         SET state = 'running', paused_seconds = paused_seconds + floor(extract(epoch FROM (now() - paused_at)))::int,
             paused_at = NULL, revision = revision + 1
         WHERE id = $1 RETURNING paused_seconds`,
        [matchId]
      );
      const actualActiveStart = new Date(new Date(row.actual_start).getTime() + resumed.rows[0]!.paused_seconds * 1000);
      const shiftedMatchIds = await delayNextMatchesAfterManualStart(
        client, initial.rows[0].competition_id, row.arena_name, matchId, row.match_number,
        new Date(row.effective_start), actualActiveStart, row.duration_seconds,
        adminEmail(request), 'resume'
      );
      await audit(client, adminEmail(request), 'match.resumed', 'match', matchId, { shiftedMatchIds });
      return { status: 200, ok: true, shiftedMatchIds };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/matches/:matchId/reset', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404 as const, error: 'Match not found' };
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
      const matchResult = await client.query<{
        match_number: number;
        arena_name: string;
        state: string;
        scheduled_start: Date;
        effective_start: Date;
        duration_seconds: number;
      }>(
        `SELECT match_number, arena_name, state, scheduled_start, effective_start, duration_seconds
         FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId]
      );
      const match = matchResult.rows[0];
      if (!match) return { status: 404 as const, error: 'Match not found' };
      if (!['running', 'paused', 'awaiting_score'].includes(match.state)) {
        return { status: 409 as const, error: `Cannot reset a ${match.state} match` };
      }
      const scores = await client.query('SELECT 1 FROM match_scores WHERE match_id = $1 LIMIT 1', [matchId]);
      if (scores.rowCount) return { status: 409 as const, error: 'A match with saved scores cannot be reset' };
      const resetAt = new Date(calculateTimerResetStart(
        new Date(match.scheduled_start).getTime(),
        new Date(match.effective_start).getTime(),
        Date.now()
      ));
      const nextState = resetAt.getTime() > new Date(match.scheduled_start).getTime()
        ? 'delayed' : 'scheduled';
      const reset = await client.query<{ effective_start: Date }>(
        `UPDATE matches
         SET state = $2,
             effective_start = $3,
             actual_start = NULL, actual_end = NULL, paused_at = NULL, paused_seconds = 0,
             countdown_started_at = NULL,
             revision = revision + 1
         WHERE id = $1
         RETURNING effective_start`,
        [matchId, nextState, resetAt]
      );
      const effectiveStart = new Date(reset.rows[0]!.effective_start);
      const delaySeconds = Math.max(0, Math.ceil(
        (effectiveStart.getTime() - new Date(match.effective_start).getTime()) / 1000
      ));
      if (delaySeconds > 0) {
        await client.query(
          `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), matchId, adminEmail(request), 'Timer reset; match rescheduled only as needed', delaySeconds]
        );
      }
      const shiftedMatchIds = await delayNextMatchesAfterManualStart(
        client, initial.rows[0].competition_id, match.arena_name, matchId, match.match_number,
        new Date(match.effective_start), effectiveStart, match.duration_seconds,
        adminEmail(request), 'timer reset'
      );
      await audit(client, adminEmail(request), 'match.timer_reset', 'match', matchId, {
        matchNumber: match.match_number,
        resetAt: effectiveStart.toISOString(),
        preservedExistingSlot: effectiveStart.getTime() === new Date(match.effective_start).getTime(),
        shiftedMatchIds
      });
      return {
        status: 200 as const,
        ok: true,
        effectiveStart: effectiveStart.toISOString(),
        preservedExistingSlot: effectiveStart.getTime() === new Date(match.effective_start).getTime(),
        shiftedMatchIds
      };
    });
    return reply.code(result.status).send(result);
  });


}
