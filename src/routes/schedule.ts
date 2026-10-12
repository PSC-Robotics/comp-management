import { type FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { assignMatchesToWaves, calculateWaveStartTime, generateBalancedMatches, greatestCommonDivisor } from '../domain/scheduler.js';
import { findCompetition, getCornerColours } from '../services/competitions.js';
import { reflowSchedule } from '../services/reflow.js';

export function registerScheduleRoutes(app: FastifyInstance): void {
  app.post('/api/admin/competitions/:slug/clear-schedule', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({ confirmation: z.literal('CLEAR SCHEDULE') }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const active = await client.query(
        `SELECT 1 FROM matches
         WHERE competition_id = $1
           AND (state IN ('running', 'paused') OR countdown_started_at IS NOT NULL)
         LIMIT 1`,
        [competition.id]
      );
      if (active.rowCount) {
        return { status: 409 as const, error: 'Stop or finish active matches and cancel start countdowns before clearing the schedule' };
      }
      const counts = await client.query<{
        matches: number; playoff_matches: number; events: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM matches WHERE competition_id = $1) AS matches,
           (SELECT count(*)::int FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
             WHERE pb.competition_id = $1) AS playoff_matches,
           (SELECT count(*)::int FROM competition_events WHERE competition_id = $1) AS events`,
        [competition.id]
      );
      await client.query(
        `DELETE FROM score_revisions WHERE match_id IN (
           SELECT id FROM matches WHERE competition_id = $1
         )`,
        [competition.id]
      );
      await client.query(
        `DELETE FROM playoff_score_revisions WHERE playoff_match_id IN (
           SELECT pm.id FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1
         )`,
        [competition.id]
      );
      await client.query('DELETE FROM matches WHERE competition_id = $1', [competition.id]);
      await client.query('DELETE FROM playoff_brackets WHERE competition_id = $1', [competition.id]);
      await client.query('DELETE FROM competition_events WHERE competition_id = $1', [competition.id]);
      const deletedCounts = counts.rows[0]!;
      await audit(client, adminEmail(request), 'competition.schedule_cleared', 'competition', competition.id, {
        ...deletedCounts,
        confirmation: body.confirmation
      });
      return { status: 200 as const, ...deletedCounts };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/competitions/:slug/clear-matches', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({ confirmation: z.literal('CLEAR MATCHES') }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const active = await client.query(
        `SELECT 1 FROM matches
         WHERE competition_id = $1
           AND (state IN ('running', 'paused') OR countdown_started_at IS NOT NULL)
         UNION ALL
         SELECT 1 FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1
           AND (pm.timer_state IN ('running', 'paused')
                OR pm.countdown_started_at IS NOT NULL)
         LIMIT 1`,
        [competition.id]
      );
      if (active.rowCount) {
        return { status: 409 as const, error: 'Stop or finish active matches and cancel start countdowns before clearing matches' };
      }
      const counts = await client.query<{
        matches: number; playoff_matches: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM matches WHERE competition_id = $1) AS matches,
           (SELECT count(*)::int FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
             WHERE pb.competition_id = $1) AS playoff_matches`,
        [competition.id]
      );
      await client.query(
        `DELETE FROM score_revisions WHERE match_id IN (
           SELECT id FROM matches WHERE competition_id = $1
         )`,
        [competition.id]
      );
      await client.query(
        `DELETE FROM playoff_score_revisions WHERE playoff_match_id IN (
           SELECT pm.id FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1
         )`,
        [competition.id]
      );
      await client.query('DELETE FROM matches WHERE competition_id = $1', [competition.id]);
      await client.query('DELETE FROM playoff_brackets WHERE competition_id = $1', [competition.id]);
      const deletedCounts = counts.rows[0]!;
      await audit(client, adminEmail(request), 'competition.matches_cleared', 'competition', competition.id, {
        ...deletedCounts,
        eventsRetained: true,
        confirmation: body.confirmation
      });
      return { status: 200 as const, ...deletedCounts };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/competitions/:slug/generate-schedule', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      matchCount: z.number().int().min(1).max(400),
      firstStart: z.string().datetime({ offset: true }),
      intervalSeconds: z.number().int().min(60).max(86400),
      arenas: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
      durationSeconds: z.number().int().positive().max(7200).optional(),
      seed: z.number().int().nonnegative().max(0xffffffff).optional(),
      positions: z.array(z.object({
        label: z.string().trim().min(1).max(80)
      })).length(4)
    }).parse(request.body);
    if (new Set(body.arenas).size !== body.arenas.length) {
      return reply.code(400).send({ error: 'Arena names must be unique' });
    }
    if (new Set(body.positions.map((position) => position.label)).size !== 4) {
      return reply.code(400).send({ error: 'Corner labels must be unique' });
    }
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const durationSeconds = body.durationSeconds ?? competition.match_duration_seconds;
    if (body.intervalSeconds < durationSeconds) {
      return reply.code(400).send({ error: 'Start-to-start interval must be at least as long as the match duration' });
    }
    const roster = await pool.query<{ id: string; code: string }>(
      'SELECT id, code FROM teams WHERE competition_id = $1 AND active = true ORDER BY code',
      [competition.id]
    );
    const teamCodes = roster.rows.map((team) => team.code);
    if (teamCodes.length < 4) {
      return reply.code(422).send({ error: 'At least four active teams are required for a balanced full-match schedule' });
    }
    if ((body.matchCount * 4) % teamCodes.length !== 0) {
      const step = teamCodes.length / greatestCommonDivisor(teamCodes.length, 4);
      const suggestedMatchCount = Math.ceil(body.matchCount / step) * step;
      return reply.code(422).send({
        error: `Equal appearances are impossible with ${body.matchCount} matches and ${teamCodes.length} teams`,
        suggestedMatchCount
      });
    }
    const seed = body.seed ?? randomBytes(4).readUInt32BE(0);
    const schedule = generateBalancedMatches(teamCodes, body.matchCount, seed);
    const waveAssignments = assignMatchesToWaves(schedule.matches, body.arenas.length);
    const waveCount = Math.max(...waveAssignments.map((assignment) => assignment.wave)) + 1;
    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const currentMatches = await client.query(
        'SELECT 1 FROM matches WHERE competition_id = $1 LIMIT 1',
        [competition.id]
      );
      if (currentMatches.rowCount) {
        return { status: 409 as const, error: 'Matches already exist; generating a second schedule is not supported yet' };
      }
      const currentTeams = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM teams WHERE competition_id = $1 AND active = true ORDER BY code',
        [competition.id]
      );
      if (currentTeams.rows.map((team) => team.code).join(',') !== teamCodes.join(',')) {
        return { status: 409 as const, error: 'Team roster changed during generation; retry with the current roster' };
      }
      const teamIds = new Map(currentTeams.rows.map((team) => [team.code, team.id]));
      const cornerColours = await getCornerColours(client, competition.id);
      const firstStart = new Date(body.firstStart);
      for (let index = 0; index < waveAssignments.length; index += 1) {
        const match = waveAssignments[index]!;
        const matchId = randomUUID();
        const arenaName = body.arenas[match.arenaIndex]!;
        const start = new Date(calculateWaveStartTime(
          firstStart.getTime(), match.wave, body.intervalSeconds, durationSeconds
        ));
        await client.query(
          `INSERT INTO matches
           (id, competition_id, match_number, arena_name, scheduled_start, effective_start,
            duration_seconds, planned_gap_seconds, start_mode, state)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'manual', 'scheduled')`,
          [
            matchId, competition.id, index + 1, arenaName, start, durationSeconds,
            body.intervalSeconds - durationSeconds
          ]
        );
        for (let position = 0; position < 4; position += 1) {
          await client.query(
            `INSERT INTO match_positions (match_id, position_number, position_label, colour, team_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [matchId, position + 1, body.positions[position]!.label, cornerColours[position]!,
              teamIds.get(match.positions[position]!)]
          );
        }
      }
      const shiftedMatchIds = await reflowSchedule(
        client, competition.id, adminEmail(request), 'balanced schedule generated'
      );
      await audit(client, adminEmail(request), 'schedule.generated', 'competition', competition.id, {
        matchCount: body.matchCount,
        teamCount: teamCodes.length,
        appearancesPerTeam: schedule.appearancesPerTeam,
        waveCount,
        restAfterMatchSeconds: body.intervalSeconds,
        seed,
        pairCountRange: schedule.pairRange,
        cornerCountRange: schedule.positionRange,
        arenas: body.arenas,
        shiftedMatchIds
      });
      return { status: 201 as const, ok: true, seed, waveCount, shiftedMatchIds, ...schedule };
    });
    return reply.code(result.status).send(result);
  });

  app.get('/api/admin/competitions/:slug/matches', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query(
      `SELECT m.id, m.match_number, m.arena_name, m.scheduled_start, m.effective_start, m.underfilled_reason,
              m.duration_seconds, m.state, m.actual_start, m.actual_end,
              m.paused_at, m.paused_seconds, m.countdown_started_at,
              count(mp.team_id)::int AS team_count,
              EXISTS (SELECT 1 FROM match_scores ms WHERE ms.match_id = m.id) AS has_scores,
              (SELECT jsonb_agg(jsonb_build_object('teamCode', scored.code, 'points', ms.league_points)
                 ORDER BY ms.league_points DESC, scored.code)
               FROM match_scores ms JOIN teams scored ON scored.id = ms.team_id WHERE ms.match_id = m.id) AS scores,
              (SELECT count(*)::int FROM match_delays d WHERE d.match_id = m.id) AS delay_count,
              greatest(0, ceil(extract(epoch FROM (m.effective_start - m.scheduled_start))))::int
                AS delay_seconds,
              (SELECT jsonb_agg(jsonb_build_object(
                'reason', d.reason, 'seconds', d.delay_seconds, 'createdAt', d.created_at
              ) ORDER BY d.created_at) FROM match_delays d WHERE d.match_id = m.id) AS delays,
              jsonb_agg(jsonb_build_object(
                'position', mp.position_number, 'spot', mp.position_number - 1,
                'label', mp.position_label, 'colour', mp.colour,
                'teamCode', t.code, 'teamName', t.name
              ) ORDER BY mp.position_number) AS positions
       FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1
       GROUP BY m.id ORDER BY m.scheduled_start, m.match_number`,
      [competition.id]
    );
    const cornerColours = await getCornerColours(pool, competition.id);
    const playoffs = await pool.query(
      `SELECT pm.id, pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start,
              pm.duration_seconds, pm.planned_gap_seconds, pm.status, pm.bracket_side, pm.round_number,
              pm.schedule_state, pm.timer_state, pm.countdown_started_at, pm.actual_start, pm.actual_end,
              pm.paused_at, pm.paused_seconds, pm.advancing_places, pb.format AS bracket_format,
              greatest(0, ceil(extract(epoch FROM (pm.effective_start - pm.scheduled_start))))::int
                AS delay_seconds,
              ((pm.source_one <> 'bye')::int + (pm.source_two <> 'bye')::int +
               (pm.source_three <> 'bye')::int + (pm.source_four <> 'bye')::int) AS entrant_count,
              (SELECT count(*)::int FROM playoff_match_scores pms WHERE pms.playoff_match_id = pm.id) AS score_count,
              (SELECT jsonb_agg(jsonb_build_object('teamCode', t.code, 'points', pms.points)
                 ORDER BY (SELECT p.idx FROM jsonb_array_elements_text(coalesce(pm.placements, '[]'::jsonb)) WITH ORDINALITY AS p(team_id, idx) WHERE p.team_id = t.id::text) NULLS LAST, pms.points DESC, (pb.seed_ranks ->> t.id::text)::integer)
               FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
               WHERE pms.playoff_match_id = pm.id) AS scores,
              jsonb_build_array(
                jsonb_build_object('position',1,'spot',0,'colour',$2::text,'teamCode',t1.code,'teamName',t1.name),
                jsonb_build_object('position',2,'spot',1,'colour',$3::text,'teamCode',t2.code,'teamName',t2.name),
                jsonb_build_object('position',3,'spot',2,'colour',$4::text,'teamCode',t3.code,'teamName',t3.name),
                jsonb_build_object('position',4,'spot',3,'colour',$5::text,'teamCode',t4.code,'teamName',t4.name)
              ) AS positions
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
       ORDER BY pm.effective_start, pm.match_number`,
      [competition.id, ...cornerColours]
    );
    const leagueMatches = result.rows.map((match) => ({ ...match, underfilled: Number(match.team_count) < 4 }));
    const playoffMatches = playoffs.rows.map((match) => ({
      ...match,
      state: match.schedule_state === 'complete' ? 'complete'
        : match.timer_state === 'awaiting_score' ? 'awaiting_score'
          : match.timer_state === 'running' || match.timer_state === 'paused' ? match.timer_state
            : match.status === 'ready' ? 'ready' : 'scheduled',
      team_count: (match.positions as { teamCode: string | null }[]).filter((position) => position.teamCode).length,
      entrant_count: Number(match.entrant_count),
      underfilled: false,
      has_scores: Number(match.score_count) > 0,
      isPlayoff: true
    }));
    return [...leagueMatches, ...playoffMatches].sort((left, right) =>
      new Date(left.effective_start).getTime() - new Date(right.effective_start).getTime() ||
      left.match_number - right.match_number
    );
  });

  app.post('/api/admin/competitions/:slug/matches', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      matchNumber: z.number().int().positive(),
      arenaName: z.string().trim().min(1).max(80).default('Arena 1'),
      scheduledStart: z.string().datetime({ offset: true }),
      durationSeconds: z.number().int().positive().max(7200).optional(),
      underfilledReason: z.string().trim().min(1).max(500).optional(),
      positions: z.array(z.object({
        number: z.number().int().min(1).max(4),
        label: z.string().trim().min(1).max(80),
        teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional()
      })).length(4),
    }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const numbers = new Set(body.positions.map((position) => position.number));
    if (numbers.size !== 4) return reply.code(400).send({ error: 'Each arena position 1–4 must appear exactly once' });
    const assigned = body.positions.filter((position) => position.teamCode);
    if (assigned.length < 4 && !body.underfilledReason) {
      return reply.code(400).send({ error: 'Matches with fewer than four teams require an underfilled reason' });
    }

    const matchId = randomUUID();
    const shiftedMatchIds = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const cornerColours = await getCornerColours(client, competition.id);
      await client.query(
        `INSERT INTO matches
         (id, competition_id, match_number, arena_name, scheduled_start, effective_start,
          duration_seconds, start_mode, state, underfilled_acknowledged_by, underfilled_reason)
         VALUES ($1, $2, $3, $4, $5, $5, $6, 'manual', 'scheduled', $7, $8)`,
        [matchId, competition.id, body.matchNumber, body.arenaName, body.scheduledStart,
          body.durationSeconds ?? competition.match_duration_seconds,
          assigned.length < 4 ? adminEmail(request) : null, body.underfilledReason ?? null]
      );
      for (const position of body.positions) {
        let teamId: string | null = null;
        if (position.teamCode) {
          const team = await client.query<{ id: string }>(
            'SELECT id FROM teams WHERE competition_id = $1 AND code = $2 AND active = true',
            [competition.id, position.teamCode]
          );
          if (!team.rows[0]) throw new Error(`Unknown or inactive team code: ${position.teamCode}`);
          teamId = team.rows[0].id;
        }
        await client.query(
          `INSERT INTO match_positions (match_id, position_number, position_label, colour, team_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [matchId, position.number, position.label, cornerColours[position.number - 1]!, teamId]
        );
      }
      const shifted = await reflowSchedule(
        client, competition.id, adminEmail(request), `match #${body.matchNumber} added`
      );
      await audit(client, adminEmail(request), 'match.created', 'match', matchId, {
        matchNumber: body.matchNumber,
        assignedTeams: assigned.length,
        underfilledReason: body.underfilledReason ?? null,
        shiftedMatchIds: shifted
      });
      return shifted;
    });
    return reply.code(201).send({
      id: matchId, matchNumber: body.matchNumber, teamCount: assigned.length,
      underfilled: assigned.length < 4, shiftedMatchIds
    });
  });

  app.patch('/api/admin/matches/:matchId/schedule', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      arenaName: z.string().trim().min(1).max(80),
      scheduledStart: z.string().datetime({ offset: true }),
      underfilledReason: z.string().trim().min(1).max(500).optional(),
      positions: z.array(z.object({
        number: z.number().int().min(1).max(4),
        label: z.string().trim().min(1).max(80),
        teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional()
      })).length(4)
    }).parse(request.body);
    if (new Set(body.positions.map((position) => position.number)).size !== 4) {
      return reply.code(400).send({ error: 'Each arena position must appear exactly once' });
    }
    const assigned = body.positions.filter((position) => position.teamCode);
    if (assigned.length === 0) return reply.code(400).send({ error: 'A match must have at least one team' });
    if (assigned.length < 4 && !body.underfilledReason) {
      return reply.code(400).send({ error: 'Matches with fewer than four teams require an underfilled reason' });
    }
    const outcome = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
      const competitionId = initial.rows[0].competition_id;
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
      const locked = await client.query<{
        state: string; match_number: number; duration_seconds: number; planned_gap_seconds: number;
      }>(
        'SELECT state, match_number, duration_seconds, planned_gap_seconds FROM matches WHERE id = $1 FOR UPDATE',
        [matchId]
      );
      const match = locked.rows[0];
      if (!match) return { status: 404, error: 'Match not found' };
      if (!['scheduled', 'ready', 'delayed'].includes(match.state)) {
        return { status: 409, error: `Cannot edit a ${match.state} match` };
      }
      const teamIds = new Map<string, string>();
      const cornerColours = await getCornerColours(client, competitionId);
      for (const position of assigned) {
        const team = await client.query<{ id: string }>(
          'SELECT id FROM teams WHERE competition_id = $1 AND code = $2 AND active = true',
          [competitionId, position.teamCode]
        );
        if (!team.rows[0]) return { status: 400, error: `Unknown or inactive team code: ${position.teamCode}` };
        if ([...teamIds.values()].includes(team.rows[0].id)) {
          return { status: 400, error: `Team ${position.teamCode} is assigned more than once` };
        }
        teamIds.set(position.teamCode!, team.rows[0].id);
      }
      const delayTotal = await client.query<{ seconds: number }>(
        `SELECT greatest(0, ceil(extract(epoch FROM (effective_start - scheduled_start))))::int AS seconds
         FROM matches WHERE id = $1`,
        [matchId]
      );
      const scheduledStart = new Date(body.scheduledStart);
      const effectiveStart = new Date(scheduledStart.getTime() + delayTotal.rows[0]!.seconds * 1000);
      await client.query(
        `UPDATE matches SET arena_name = $2, scheduled_start = $3, effective_start = $4,
           start_mode = 'manual', countdown_started_at = NULL,
           state = CASE WHEN $5::int > 0 THEN 'delayed' ELSE 'scheduled' END,
           underfilled_acknowledged_by = CASE WHEN $6::int < 4 THEN $7 ELSE NULL END,
           underfilled_reason = $8, revision = revision + 1
         WHERE id = $1`,
        [matchId, body.arenaName, scheduledStart, effectiveStart,
          delayTotal.rows[0]!.seconds, assigned.length, adminEmail(request),
          assigned.length < 4 ? body.underfilledReason : null]
      );
      await client.query('DELETE FROM match_positions WHERE match_id = $1', [matchId]);
      for (const position of body.positions) {
        await client.query(
          `INSERT INTO match_positions (match_id, position_number, position_label, colour, team_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [matchId, position.number, position.label, cornerColours[position.number - 1]!,
            position.teamCode ? teamIds.get(position.teamCode) : null]
        );
      }
      const later = await client.query<{
        id: string; effective_start: Date; duration_seconds: number; planned_gap_seconds: number;
      }>(
        `SELECT id, effective_start, duration_seconds, planned_gap_seconds FROM matches
         WHERE competition_id = $1 AND arena_name = $2 AND id <> $3
           AND (scheduled_start, match_number) > ($4, $5)
           AND state IN ('scheduled', 'ready', 'delayed')
         ORDER BY scheduled_start, match_number FOR UPDATE`,
        [competitionId, body.arenaName, matchId, scheduledStart, match.match_number]
      );
      let projectedStart = new Date(
        effectiveStart.getTime() + (match.duration_seconds + match.planned_gap_seconds) * 1000
      );
      const shiftedIds: string[] = [];
      for (const next of later.rows) {
        const priorStart = new Date(next.effective_start);
        const newStart = priorStart.getTime() < projectedStart.getTime() ? projectedStart : priorStart;
        if (newStart.getTime() > priorStart.getTime()) {
          await client.query(
            `UPDATE matches SET effective_start = $2, state = 'delayed', revision = revision + 1 WHERE id = $1`,
            [next.id, newStart]
          );
          shiftedIds.push(next.id);
          await audit(client, adminEmail(request), 'match.schedule_cascaded', 'match', next.id, {
            causedByMatchId: matchId,
            effectiveStart: newStart.toISOString()
          });
        }
        projectedStart = new Date(
          newStart.getTime() + (next.duration_seconds + next.planned_gap_seconds) * 1000
        );
      }
      const eventShiftedIds = await reflowSchedule(
        client, competitionId, adminEmail(request), `match #${match.match_number} edited`
      );
      const allShiftedIds = [...new Set([...shiftedIds, ...eventShiftedIds])];
      await audit(client, adminEmail(request), 'match.schedule_updated', 'match', matchId, {
        ...body,
        shiftedMatchIds: allShiftedIds
      });
      return { status: 200, ok: true, shiftedMatchIds: allShiftedIds };
    });
    return reply.code(outcome.status).send(outcome);
  });

  app.delete('/api/admin/matches/:matchId', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const { confirmation } = z.object({ confirmation: z.string().trim().regex(/^\d+$/) }).parse(request.body);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404 as const, error: 'Match not found' };
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
      const matchResult = await client.query<{ match_number: number; state: string; arena_name: string }>(
        'SELECT match_number, state, arena_name FROM matches WHERE id = $1 FOR UPDATE',
        [matchId]
      );
      const match = matchResult.rows[0];
      if (!match) return { status: 404 as const, error: 'Match not found' };
      if (String(match.match_number) !== confirmation) {
        return { status: 400 as const, error: 'Match number confirmation does not match' };
      }
      if (match.state === 'running' || match.state === 'paused') {
        return { status: 409 as const, error: 'Finish or reset the active match before deleting it' };
      }
      await client.query('DELETE FROM score_revisions WHERE match_id = $1', [matchId]);
      await audit(client, adminEmail(request), 'match.deleted', 'match', matchId, {
        matchNumber: match.match_number,
        arenaName: match.arena_name,
        priorState: match.state,
        scoresDeleted: true
      });
      await client.query('DELETE FROM matches WHERE id = $1', [matchId]);
      return { status: 204 as const };
    });
    if (result.status !== 204) return reply.code(result.status).send({ error: result.error });
    return reply.code(204).send();
  });


}
