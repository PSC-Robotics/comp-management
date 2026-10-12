import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { calculateDelayReduction } from '../domain/scheduler.js';
import { findCompetition } from '../services/competitions.js';
import { delayNextMatchesAfterManualStart, reflowSchedule } from '../services/reflow.js';

export function registerDelayRoutes(app: FastifyInstance): void {
  app.post('/api/admin/matches/:matchId/delay', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      delaySeconds: z.number().int().positive().max(86400),
      reason: z.string().trim().min(1).max(500)
    }).parse(request.body);
    await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) {
        const error = new Error('Match not found');
        Object.assign(error, { statusCode: 404 });
        throw error;
      }
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
      const current = await client.query<{
        arena_name: string;
        state: string;
        match_number: number;
        effective_start: Date;
        duration_seconds: number;
        planned_gap_seconds: number;
      }>(
        `SELECT arena_name, state, match_number, effective_start, duration_seconds, planned_gap_seconds
         FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId]
      );
      const match = current.rows[0];
      if (!match) {
        const error = new Error('Match not found');
        Object.assign(error, { statusCode: 404 });
        throw error;
      }
      if (match.state === 'running' || match.state === 'paused' || match.state === 'complete' || match.state === 'cancelled') {
        const error = new Error(`Cannot delay a ${match.state} match`);
        Object.assign(error, { statusCode: 409 });
        throw error;
      }
      const moved = await client.query<{ effective_start: Date }>(
        `UPDATE matches
         SET effective_start = effective_start + ($2 * interval '1 second'),
             countdown_started_at = NULL,
             state = 'delayed', revision = revision + 1
         WHERE id = $1 RETURNING effective_start`,
        [matchId, body.delaySeconds]
      );
      await client.query(
        `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), matchId, adminEmail(request), body.reason, body.delaySeconds]
      );
      const shifted = await delayNextMatchesAfterManualStart(
        client,
        initial.rows[0].competition_id,
        match.arena_name,
        matchId,
        match.match_number,
        new Date(match.effective_start),
        new Date(moved.rows[0]!.effective_start),
        match.duration_seconds,
        adminEmail(request),
        `manual delay: ${body.reason}`
      );
      await audit(client, adminEmail(request), 'match.delayed', 'match', matchId, {
        ...body,
        shiftedMatchIds: shifted
      });
    });
    return reply.code(200).send({ ok: true });
  });

  app.post('/api/admin/matches/:matchId/undelay', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      delaySeconds: z.number().int().positive().max(86400).optional(),
      restoreScheduled: z.boolean().default(false),
      reason: z.string().trim().min(1).max(500)
    }).refine((value) => value.restoreScheduled
      ? value.delaySeconds === undefined
      : value.delaySeconds !== undefined, {
      message: 'Choose either a delay reduction or restoration to the scheduled time'
    }).parse(request.body);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        'SELECT competition_id FROM matches WHERE id = $1',
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404 as const, error: 'Match not found' };
      const competitionId = initial.rows[0].competition_id;
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
      const locked = await client.query<{
        arena_name: string;
        match_number: number;
        state: string;
        scheduled_start: Date;
        effective_start: Date;
        duration_seconds: number;
        planned_gap_seconds: number;
        countdown_started_at: Date | null;
      }>(
        `SELECT arena_name, match_number, state, scheduled_start, effective_start,
                duration_seconds, planned_gap_seconds, countdown_started_at
         FROM matches WHERE id = $1 FOR UPDATE`,
        [matchId]
      );
      const match = locked.rows[0];
      if (!match) return { status: 404 as const, error: 'Match not found' };
      if (!['scheduled', 'ready', 'delayed'].includes(match.state) ||
          match.countdown_started_at !== null) {
        return { status: 409 as const, error: 'Only an upcoming match without an active countdown can be undelayed' };
      }
      const scheduledStart = new Date(match.scheduled_start);
      const currentStart = new Date(match.effective_start);
      let reduction: ReturnType<typeof calculateDelayReduction>;
      try {
        reduction = calculateDelayReduction(
          scheduledStart.getTime(),
          currentStart.getTime(),
          body.delaySeconds,
          body.restoreScheduled
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { status: 409 as const, error: error.message };
      }
      const { reductionSeconds, remainingDelaySeconds } = reduction;
      const nextStart = new Date(reduction.effectiveStart);
      const conflicts = await client.query<{ match_number: number; starts_at: Date }>(
        `SELECT match_number, starts_at FROM (
           SELECT m.match_number,
                  CASE WHEN m.state IN ('running', 'paused')
                       THEN coalesce(m.actual_start, m.effective_start)
                       ELSE m.effective_start END AS starts_at,
                  m.duration_seconds, m.state
           FROM matches m
           WHERE m.competition_id = $1 AND m.arena_name = $2 AND m.id <> $3
             AND m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
           UNION ALL
           SELECT pm.match_number, pm.effective_start AS starts_at,
                  pm.duration_seconds, pm.timer_state AS state
           FROM playoff_matches pm
           JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1 AND pb.status = 'active' AND pm.arena_name = $2
             AND pm.schedule_state = 'scheduled'
         ) arena_matches
         WHERE (state = 'paused' AND starts_at < $4::timestamptz +
                   make_interval(secs => $5::int))
            OR (state <> 'paused'
                AND starts_at < $4::timestamptz + make_interval(secs => $5::int)
                AND starts_at + make_interval(secs => duration_seconds) > $4)
         ORDER BY starts_at`,
        [competitionId, match.arena_name, matchId, nextStart, match.duration_seconds]
      );
      if (conflicts.rows.length > 0) {
        const conflict = conflicts.rows[0]!;
        return {
          status: 409 as const,
          error: `Cannot move match #${match.match_number} earlier; it would conflict with match #${conflict.match_number} in ${match.arena_name}`
        };
      }
      const eventConflict = await client.query<{ title: string }>(
        `SELECT title FROM competition_events
         WHERE competition_id = $1
           AND starts_at < $2::timestamptz + make_interval(secs => $3::int)
           AND starts_at + make_interval(mins => duration_minutes) > $2
         ORDER BY starts_at LIMIT 1`,
        [competitionId, nextStart, match.duration_seconds]
      );
      if (eventConflict.rows[0]) {
        return {
          status: 409 as const,
          error: `Cannot move match #${match.match_number} earlier; it would overlap the scheduled event "${eventConflict.rows[0].title}"`
        };
      }
      await client.query(
        `UPDATE matches SET effective_start = $2,
           state = CASE WHEN $2 > scheduled_start THEN 'delayed' ELSE 'scheduled' END,
           revision = revision + 1
         WHERE id = $1`,
        [matchId, nextStart]
      );
      await audit(client, adminEmail(request), 'match.delay_reduced', 'match', matchId, {
        reason: body.reason,
        reductionSeconds,
        previousDelaySeconds: remainingDelaySeconds + reductionSeconds,
        remainingDelaySeconds,
        restoredToScheduledTime: body.restoreScheduled,
        effectiveStart: nextStart.toISOString()
      });
      return {
        status: 200 as const,
        ok: true,
        reductionSeconds,
        remainingDelaySeconds,
        effectiveStart: nextStart.toISOString()
      };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/competitions/:slug/delay-all', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      delaySeconds: z.number().int().min(60).max(86400),
      reason: z.string().trim().min(1).max(500),
      arenaName: z.string().trim().min(1).max(80).optional()
    }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      // Everything not yet started (and not counting down) moves by the same amount, so
      // their spacing is kept; timed events stay fixed and the re-flow moves matches around them.
      const league = await client.query<{ id: string }>(
        `UPDATE matches SET effective_start = effective_start + ($2 * interval '1 second'),
           state = 'delayed', revision = revision + 1
         WHERE competition_id = $1 AND state IN ('scheduled', 'ready', 'delayed')
           AND countdown_started_at IS NULL AND ($3::text IS NULL OR arena_name = $3)
         RETURNING id`,
        [competition.id, body.delaySeconds, body.arenaName ?? null]
      );
      for (const match of league.rows) {
        await client.query(
          `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), match.id, adminEmail(request), `Competition-wide delay: ${body.reason}`, body.delaySeconds]
        );
      }
      const heats = await client.query<{ id: string }>(
        `UPDATE playoff_matches pm SET effective_start = pm.effective_start + ($2 * interval '1 second')
         FROM playoff_brackets pb
         WHERE pb.id = pm.bracket_id AND pb.competition_id = $1 AND pb.status = 'active'
           AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
           AND pm.countdown_started_at IS NULL AND ($3::text IS NULL OR pm.arena_name = $3)
         RETURNING pm.id`,
        [competition.id, body.delaySeconds, body.arenaName ?? null]
      );
      const shiftedMatchIds = await reflowSchedule(
        client, competition.id, adminEmail(request), `competition-wide delay: ${body.reason}`
      );
      await audit(client, adminEmail(request), 'competition.delay_applied', 'competition', competition.id, {
        ...body,
        leagueMatchIds: league.rows.map((match) => match.id),
        playoffHeatIds: heats.rows.map((heat) => heat.id),
        shiftedMatchIds
      });
      return {
        status: 200 as const,
        delayedMatches: league.rowCount ?? 0,
        delayedHeats: heats.rowCount ?? 0,
        shiftedMatchIds
      };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/competitions/:slug/undelay-all', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });

    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const leagueTargets = await client.query<{
        id: string;
        match_number: number;
        arena_name: string;
        scheduled_start: Date;
        effective_start: Date;
        duration_seconds: number;
      }>(
        `SELECT id, match_number, arena_name, scheduled_start, effective_start, duration_seconds
         FROM matches
         WHERE competition_id = $1
           AND state IN ('scheduled', 'ready', 'delayed')
           AND countdown_started_at IS NULL
           AND effective_start > scheduled_start
           AND scheduled_start > now()
         ORDER BY scheduled_start, match_number
         FOR UPDATE`,
        [competition.id]
      );
      const playoffTargets = await client.query<{
        id: string;
        match_number: number;
        arena_name: string;
        scheduled_start: Date;
        effective_start: Date;
        duration_seconds: number;
      }>(
        `SELECT pm.id, pm.match_number, pm.arena_name, pm.scheduled_start,
                pm.effective_start, pm.duration_seconds
         FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1 AND pb.status = 'active'
           AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
           AND pm.countdown_started_at IS NULL
           AND pm.effective_start > pm.scheduled_start
           AND pm.scheduled_start > now()
         ORDER BY pm.scheduled_start, pm.match_number
         FOR UPDATE OF pm`,
        [competition.id]
      );
      type Target = {
        id: string;
        kind: 'league' | 'playoff';
        matchNumber: number;
        arenaName: string;
        scheduledStart: Date;
        previousStart: Date;
        durationSeconds: number;
      };
      const targets: Target[] = [
        ...leagueTargets.rows.map((match) => ({
          id: match.id,
          kind: 'league' as const,
          matchNumber: match.match_number,
          arenaName: match.arena_name,
          scheduledStart: new Date(match.scheduled_start),
          previousStart: new Date(match.effective_start),
          durationSeconds: match.duration_seconds
        })),
        ...playoffTargets.rows.map((match) => ({
          id: match.id,
          kind: 'playoff' as const,
          matchNumber: match.match_number,
          arenaName: match.arena_name,
          scheduledStart: new Date(match.scheduled_start),
          previousStart: new Date(match.effective_start),
          durationSeconds: match.duration_seconds
        }))
      ].sort((left, right) =>
        left.scheduledStart.getTime() - right.scheduledStart.getTime() ||
        left.arenaName.localeCompare(right.arenaName) ||
        left.matchNumber - right.matchNumber
      );
      if (targets.length === 0) {
        const past = await client.query<{ count: number }>(
          `SELECT (
             (SELECT count(*) FROM matches
              WHERE competition_id = $1 AND state IN ('scheduled', 'ready', 'delayed')
                AND countdown_started_at IS NULL
                AND effective_start > scheduled_start AND scheduled_start <= now())
             +
             (SELECT count(*) FROM playoff_matches pm
              JOIN playoff_brackets pb ON pb.id = pm.bracket_id
              WHERE pb.competition_id = $1 AND pb.status = 'active'
                AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
                AND pm.countdown_started_at IS NULL
                AND pm.effective_start > pm.scheduled_start AND pm.scheduled_start <= now())
           )::int AS count`,
          [competition.id]
        );
        return { status: 200 as const, restored: 0, skipped: [], skippedPast: past.rows[0]?.count ?? 0 };
      }

      const leagueTargetIds = leagueTargets.rows.map((match) => match.id);
      const playoffTargetIds = playoffTargets.rows.map((match) => match.id);
      const fixed = await client.query<{
        kind: 'league' | 'playoff';
        id: string;
        match_number: number;
        arena_name: string;
        starts_at: Date;
        duration_seconds: number;
        state: string;
      }>(
        `SELECT 'league'::text AS kind, m.id, m.match_number, m.arena_name,
                CASE WHEN m.state IN ('running', 'paused')
                     THEN coalesce(m.actual_start, m.effective_start)
                     ELSE m.effective_start END AS starts_at,
                m.duration_seconds, m.state
         FROM matches m
         WHERE m.competition_id = $1
           AND m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
           AND NOT (m.id = ANY($2::uuid[]))
         UNION ALL
         SELECT 'playoff'::text AS kind, pm.id, pm.match_number, pm.arena_name,
                CASE WHEN pm.timer_state IN ('running', 'paused')
                     THEN coalesce(pm.actual_start, pm.effective_start)
                     ELSE pm.effective_start END AS starts_at,
                pm.duration_seconds, pm.timer_state AS state
         FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1 AND pb.status = 'active'
           AND pm.schedule_state = 'scheduled'
           AND NOT (pm.id = ANY($3::uuid[]))`,
        [competition.id, leagueTargetIds, playoffTargetIds]
      );
      const events = await client.query<{ title: string; starts_at: Date; duration_minutes: number }>(
        'SELECT title, starts_at, duration_minutes FROM competition_events WHERE competition_id = $1',
        [competition.id]
      );
      const overlaps = (leftStart: number, leftDuration: number, rightStart: number, rightDuration: number) =>
        leftStart < rightStart + rightDuration && rightStart < leftStart + leftDuration;
      // A heat must still wait for the heats that feed it (as they will be after this restore).
      const heatTiming = await client.query<{
        id: string; match_number: number; effective_start: Date; duration_seconds: number; planned_gap_seconds: number;
        schedule_state: string; timer_state: string; actual_start: Date | null; actual_end: Date | null; sources: string[];
      }>(
        `SELECT pm.id, pm.match_number, pm.effective_start, pm.duration_seconds, pm.planned_gap_seconds,
                pm.schedule_state, pm.timer_state, pm.actual_start, pm.actual_end,
                ARRAY[pm.source_one, pm.source_two, pm.source_three, pm.source_four] AS sources
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1 AND pb.status = 'active'`,
        [competition.id]
      );
      const heatById = new Map(heatTiming.rows.map((heat) => [heat.id, heat]));
      const plannedHeatStart = new Map(heatTiming.rows.map((heat) => [heat.id, new Date(heat.effective_start).getTime()]));
      const heatReadyAt = (feederId: string): number => {
        const feeder = heatById.get(feederId);
        if (!feeder) return Number.NEGATIVE_INFINITY;
        if (feeder.actual_end) return new Date(feeder.actual_end).getTime();
        const start = feeder.actual_start ? new Date(feeder.actual_start).getTime() : plannedHeatStart.get(feederId)!;
        return start + feeder.duration_seconds * 1000;
      };
      const skipped: Array<{ kind: Target['kind']; matchNumber: number; reason: string }> = [];
      const restored: Target[] = [];
      const retained: Array<{ target: Target; start: number }> = [];
      const skip = (target: Target, reason: string) => {
        skipped.push({ kind: target.kind, matchNumber: target.matchNumber, reason });
        retained.push({ target, start: target.previousStart.getTime() });
      };
      for (const target of targets) {
        const proposedStart = target.scheduledStart.getTime();
        const activeConflict = fixed.rows.find((match) => {
          if (match.arena_name !== target.arenaName || !['running', 'paused'].includes(match.state)) {
            return false;
          }
          if (match.state === 'paused') return proposedStart + target.durationSeconds * 1000 > new Date(match.starts_at).getTime();
          return overlaps(
            proposedStart,
            target.durationSeconds * 1000,
            new Date(match.starts_at).getTime(),
            match.duration_seconds * 1000
          );
        });
        if (activeConflict) {
          skip(target, `Arena ${target.arenaName} has an active match`);
          continue;
        }
        const matchConflict = fixed.rows.find((match) =>
          match.arena_name === target.arenaName &&
          overlaps(
            proposedStart,
            target.durationSeconds * 1000,
            new Date(match.starts_at).getTime(),
            match.duration_seconds * 1000
          )
        );
        if (matchConflict) {
          skip(target, `Would overlap ${matchConflict.kind} match #${matchConflict.match_number} in ${target.arenaName}`);
          continue;
        }
        const restoredConflict = restored.find((match) =>
          match.arenaName === target.arenaName &&
          overlaps(
            proposedStart,
            target.durationSeconds * 1000,
            match.scheduledStart.getTime(),
            match.durationSeconds * 1000
          )
        );
        const retainedConflict = retained.find(({ target: match, start }) =>
          match.arenaName === target.arenaName &&
          overlaps(proposedStart, target.durationSeconds * 1000, start, match.durationSeconds * 1000)
        );
        if (restoredConflict || retainedConflict) {
          const conflict = restoredConflict
            ? { kind: restoredConflict.kind, matchNumber: restoredConflict.matchNumber }
            : { kind: retainedConflict!.target.kind, matchNumber: retainedConflict!.target.matchNumber };
          skip(target, `Would overlap ${conflict.kind} match #${conflict.matchNumber} in ${target.arenaName}`);
          continue;
        }
        const eventConflict = events.rows.find((event) =>
          overlaps(
            proposedStart,
            target.durationSeconds * 1000,
            new Date(event.starts_at).getTime(),
            event.duration_minutes * 60_000
          )
        );
        if (eventConflict) {
          skip(target, `Would overlap scheduled event "${eventConflict.title}"`);
          continue;
        }
        if (target.kind === 'playoff') {
          const heat = heatById.get(target.id)!;
          const blocking = heat.sources
            .map((source) => /^place:\d:(.+)$/.exec(source)?.[1])
            .filter((id): id is string => Boolean(id))
            .find((feederId) => heatReadyAt(feederId) + heat.planned_gap_seconds * 1000 > proposedStart);
          if (blocking) {
            skip(target, `Must still follow heat #${heatById.get(blocking)?.match_number}`);
            continue;
          }
          plannedHeatStart.set(target.id, proposedStart);
        }
        restored.push(target);
      }

      for (const target of restored) {
        if (target.kind === 'league') {
          await client.query(
            `UPDATE matches SET effective_start = scheduled_start, state = 'scheduled',
               revision = revision + 1 WHERE id = $1`,
            [target.id]
          );
        } else {
          await client.query(
            'UPDATE playoff_matches SET effective_start = scheduled_start WHERE id = $1',
            [target.id]
          );
        }
        await audit(client, adminEmail(request), 'match.delay_restored', target.kind === 'league' ? 'match' : 'playoff_match', target.id, {
          matchNumber: target.matchNumber,
          previousEffectiveStart: target.previousStart.toISOString(),
          restoredStart: target.scheduledStart.toISOString(),
          reason: 'Bulk restore to original scheduled time'
        });
      }
      // Safety net: re-flow only ever pushes later, so it is a no-op unless something above was missed.
      if (restored.length) await reflowSchedule(client, competition.id, adminEmail(request), 'delays restored');
      const past = await client.query<{ count: number }>(
        `SELECT (
           (SELECT count(*) FROM matches
            WHERE competition_id = $1 AND state IN ('scheduled', 'ready', 'delayed')
              AND countdown_started_at IS NULL
              AND effective_start > scheduled_start AND scheduled_start <= now())
           +
           (SELECT count(*) FROM playoff_matches pm
            JOIN playoff_brackets pb ON pb.id = pm.bracket_id
            WHERE pb.competition_id = $1 AND pb.status = 'active'
              AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
              AND pm.countdown_started_at IS NULL
              AND pm.effective_start > pm.scheduled_start AND pm.scheduled_start <= now())
         )::int AS count`,
        [competition.id]
      );
      await audit(client, adminEmail(request), 'competition.delays_restored', 'competition', competition.id, {
        restoredCount: restored.length,
        skippedCount: skipped.length,
        skippedPastCount: past.rows[0]?.count ?? 0
      });
      return {
        status: 200 as const,
        restored: restored.length,
        skipped,
        skippedPast: past.rows[0]?.count ?? 0
      };
    });
    return reply.code(result.status).send(result);
  });


}
