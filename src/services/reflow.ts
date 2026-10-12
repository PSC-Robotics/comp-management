import { randomUUID } from 'node:crypto';
import { type PoolClient } from 'pg';
import { audit } from '../db/audit.js';
import { MATCH_COUNTDOWN_TOTAL_SECONDS } from '../domain/display.js';
import { playoffDependencies } from '../domain/playoffs.js';
import { calculateEventScheduleShifts, calculatePlayoffHeatCascade, calculateScheduleCascade } from '../domain/scheduler.js';

export async function delayNextMatchesAfterManualStart(
  client: PoolClient,
  competitionId: string,
  arenaName: string,
  matchId: string,
  matchNumber: number,
  priorEffectiveStart: Date,
  actualStart: Date,
  durationSeconds: number,
  actor: string,
  trigger = 'manual start'
): Promise<string[]> {
  // Playoff heats queued in the same arena keep their place behind the league match.
  const later = await client.query<{
    id: string;
    kind: 'league' | 'playoff';
    effective_start: Date;
    duration_seconds: number;
    planned_gap_seconds: number;
    match_number: number;
  }>(
    `SELECT id, 'league' AS kind, effective_start, duration_seconds, planned_gap_seconds, match_number
     FROM matches
     WHERE competition_id = $1 AND arena_name = $2 AND id <> $3
       AND (effective_start, match_number) > ($4, $5)
       AND state IN ('scheduled', 'ready', 'delayed')
       AND countdown_started_at IS NULL
     UNION ALL
     SELECT pm.id, 'playoff', pm.effective_start, pm.duration_seconds, pm.planned_gap_seconds, pm.match_number
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.competition_id = $1 AND pb.status = 'active' AND pm.arena_name = $2 AND pm.id <> $3
       AND (pm.effective_start, pm.match_number) > ($4, $5)
       AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
       AND pm.countdown_started_at IS NULL
     ORDER BY effective_start, match_number`,
    [competitionId, arenaName, matchId, priorEffectiveStart, matchNumber]
  );
  const kindById = new Map(later.rows.map((next) => [next.id, next.kind]));
  const shifts = calculateScheduleCascade(
    later.rows.map((next) => ({
      id: next.id,
      effectiveStart: new Date(next.effective_start).getTime(),
      durationSeconds: next.duration_seconds,
      plannedGapSeconds: next.planned_gap_seconds
    })),
    actualStart.getTime() + durationSeconds * 1000
  );
  for (const shift of shifts) {
    const effectiveStart = new Date(shift.effectiveStart);
    if (kindById.get(shift.id) === 'playoff') {
      await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1', [shift.id, effectiveStart]);
      await audit(client, actor, 'playoff.schedule_cascaded', 'playoff_match', shift.id, {
        causedByMatchId: matchId, trigger, effectiveStart: effectiveStart.toISOString(), delaySeconds: shift.delaySeconds
      });
      continue;
    }
    await client.query(
      `UPDATE matches SET effective_start = $2, state = 'delayed', revision = revision + 1
       WHERE id = $1`,
      [shift.id, effectiveStart]
    );
    await client.query(
      `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), shift.id, actor, `Delayed after match #${matchNumber} (${trigger})`, shift.delaySeconds]
    );
    await audit(client, actor, 'match.schedule_cascaded', 'match', shift.id, {
      causedByMatchId: matchId,
      trigger,
      effectiveStart: effectiveStart.toISOString(),
      delaySeconds: shift.delaySeconds
    });
  }
  // Later league matches have moved; playoff heats and timed events may now need to follow.
  const reflowed = await reflowSchedule(client, competitionId, actor, trigger);
  return [...new Set([...shifts.map((shift) => shift.id), ...reflowed])];
}

export class ScheduleCollisionError extends Error {
  readonly statusCode = 409;
}

export type ReflowOptions = {
  /** Event edits must not overlap a running match or force a counting-down match to move. */
  strictEvents?: boolean;
};

export async function shiftScheduledMatchesAroundEvents(
  client: PoolClient,
  competitionId: string,
  actor: string,
  cause: string,
  { strictEvents = false }: ReflowOptions = {}
): Promise<string[]> {
  const eventRows = await client.query<{ title: string; starts_at: Date; duration_minutes: number }>(
    `SELECT title, starts_at, duration_minutes FROM competition_events
     WHERE competition_id = $1 ORDER BY starts_at`,
    [competitionId]
  );
  const events = eventRows.rows.map((event) => ({
    title: event.title,
    startsAt: new Date(event.starts_at).getTime(),
    durationMinutes: event.duration_minutes
  }));
  const active = await client.query<{
    id: string; arena_name: string; state: string; actual_start: Date; duration_seconds: number; paused_seconds: number;
  }>(
    `SELECT id, arena_name, state, actual_start, duration_seconds, paused_seconds FROM matches
     WHERE competition_id = $1 AND state IN ('running', 'paused') FOR UPDATE`,
    [competitionId]
  );
  for (const match of strictEvents ? active.rows : []) {
    if (!match.actual_start) continue;
    const start = new Date(match.actual_start).getTime();
    const end = start + (match.duration_seconds + match.paused_seconds) * 1000;
    if (events.some((event) => event.startsAt < end &&
        event.startsAt + event.durationMinutes * 60_000 > start)) {
      throw new ScheduleCollisionError(`Cannot place an event during an active match in ${match.arena_name}`);
    }
  }
  // Unstarted league matches and playoff heats can move; running or paused ones
  // stay put but keep their arena busy until their projected end.
  const scheduled = await client.query<{
    id: string; match_number: number; arena_name: string; effective_start: Date;
    duration_seconds: number; planned_gap_seconds: number;
    state: string; countdown_started_at: Date | null; fixed: boolean;
  }>(
    `SELECT id, match_number, arena_name,
            CASE WHEN state IN ('running', 'paused') THEN actual_start ELSE effective_start END AS effective_start,
            CASE WHEN state = 'running' THEN duration_seconds + paused_seconds
                 WHEN state = 'paused' THEN duration_seconds + paused_seconds +
                   greatest(0, ceil(extract(epoch FROM (now() - paused_at))))::int
                 ELSE duration_seconds END AS duration_seconds,
            planned_gap_seconds, state, countdown_started_at,
            state IN ('running', 'paused') AS fixed
     FROM matches WHERE competition_id = $1
       AND (state IN ('scheduled', 'ready', 'delayed') OR (state IN ('running', 'paused') AND actual_start IS NOT NULL))
     UNION ALL
     SELECT pm.id, pm.match_number, pm.arena_name,
            CASE WHEN pm.timer_state IN ('running', 'paused') THEN pm.actual_start ELSE pm.effective_start END,
            CASE WHEN pm.timer_state = 'running' THEN pm.duration_seconds + pm.paused_seconds
                 WHEN pm.timer_state = 'paused' THEN pm.duration_seconds + pm.paused_seconds +
                   greatest(0, ceil(extract(epoch FROM (now() - pm.paused_at))))::int
                 ELSE pm.duration_seconds END,
            pm.planned_gap_seconds, pm.timer_state AS state, pm.countdown_started_at,
            pm.timer_state IN ('running', 'paused') AS fixed
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.competition_id = $1 AND pb.status = 'active' AND pm.schedule_state = 'scheduled'
       AND (pm.timer_state = 'scheduled' OR (pm.timer_state IN ('running', 'paused') AND pm.actual_start IS NOT NULL))
     ORDER BY arena_name, effective_start, match_number`,
    [competitionId]
  );
  const plan = calculateEventScheduleShifts(
    scheduled.rows.map((match) => ({
      id: match.id,
      matchNumber: match.match_number,
      arenaName: match.arena_name,
      effectiveStart: new Date(match.effective_start).getTime(),
      durationSeconds: Math.max(1, match.duration_seconds),
      hasCountdown: strictEvents && match.countdown_started_at !== null,
      plannedGapSeconds: match.planned_gap_seconds,
      // Outside event edits a counting-down match simply holds its slot.
      fixed: match.fixed || (!strictEvents && match.countdown_started_at !== null)
    })),
    events,
    cause
  );
  if (plan.error) throw new ScheduleCollisionError(plan.error);
  const matchById = new Map(scheduled.rows.map((match) => [match.id, match]));
  for (const change of plan.shifts) {
    const match = matchById.get(change.id);
    if (!match) throw new Error(`Shifted match ${change.id} disappeared`);
    const effectiveStart = new Date(change.effectiveStart);
    const isPlayoff = await client.query(
      'SELECT 1 FROM playoff_matches WHERE id = $1',
      [change.id]
    );
    if (isPlayoff.rowCount) {
      await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1',
        [change.id, effectiveStart]);
    } else {
      await client.query(
        `UPDATE matches SET effective_start = $2, revision = revision + 1
         WHERE id = $1`,
        [change.id, effectiveStart]
      );
    }
    await audit(client, actor, 'match.schedule_shifted_around_event', isPlayoff.rowCount ? 'playoff_match' : 'match', change.id, {
      cause,
      matchNumber: match.match_number,
      effectiveStart: effectiveStart.toISOString(),
      delaySeconds: change.delaySeconds
    });
  }
  return plan.shifts.map((change) => change.id);
}

/**
 * Pushes unstarted heats of the active playoff bracket later so each starts
 * its planned gap after the heats that feed it and the previous heat in its
 * arena. Started heats are anchored at their real or projected times.
 */
export async function cascadePlayoffHeats(
  client: PoolClient,
  competitionId: string,
  actor: string,
  cause: string
): Promise<string[]> {
  const heats = await client.query<{
    id: string; match_number: number; arena_name: string; effective_start: Date;
    duration_seconds: number; planned_gap_seconds: number; schedule_state: string; timer_state: string;
    countdown_started_at: Date | null; actual_start: Date | null; actual_end: Date | null;
    paused_at: Date | null; paused_seconds: number; scored_at: Date | null; sources: string[];
  }>(
    `SELECT pm.id, pm.match_number, pm.arena_name, pm.effective_start, pm.duration_seconds,
            pm.planned_gap_seconds, pm.schedule_state, pm.timer_state, pm.countdown_started_at,
            pm.actual_start, pm.actual_end, pm.paused_at, pm.paused_seconds, pm.scored_at,
            ARRAY[pm.source_one, pm.source_two, pm.source_three, pm.source_four] AS sources
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.competition_id = $1 AND pb.status = 'active'
     ORDER BY pm.match_number FOR UPDATE OF pm`,
    [competitionId]
  );
  if (!heats.rowCount) return [];
  const now = Date.now();
  const dependencies = playoffDependencies(heats.rows.map((heat) => ({ key: heat.id, sources: heat.sources })));
  const time = (value: Date | null) => value === null ? null : new Date(value).getTime();
  const shifts = calculatePlayoffHeatCascade(heats.rows.map((heat) => {
    const durationMs = heat.duration_seconds * 1000;
    const base = {
      id: heat.id,
      matchNumber: heat.match_number,
      arenaName: heat.arena_name,
      effectiveStart: new Date(heat.effective_start).getTime(),
      durationSeconds: heat.duration_seconds,
      plannedGapSeconds: heat.planned_gap_seconds,
      dependsOn: dependencies.get(heat.id) ?? []
    };
    const actualStart = time(heat.actual_start);
    const actualEnd = time(heat.actual_end);
    if (heat.schedule_state === 'complete') {
      const end = actualEnd ?? base.effectiveStart + durationMs;
      return { ...base, fixedEnd: end, resultAvailableAt: Math.max(end, time(heat.scored_at) ?? end) };
    }
    if (heat.timer_state === 'awaiting_score') {
      const end = actualEnd ?? now;
      return { ...base, fixedEnd: end, resultAvailableAt: Math.max(end, now) };
    }
    if (heat.timer_state === 'running' && actualStart !== null) {
      return { ...base, fixedEnd: Math.max(now, actualStart + durationMs + heat.paused_seconds * 1000) };
    }
    if (heat.timer_state === 'paused' && actualStart !== null) {
      const elapsed = (time(heat.paused_at) ?? now) - actualStart - heat.paused_seconds * 1000;
      return { ...base, fixedEnd: now + Math.max(0, durationMs - elapsed) };
    }
    const countdown = time(heat.countdown_started_at);
    if (countdown !== null) {
      return { ...base, fixedEnd: countdown + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000 + durationMs };
    }
    return base;
  }));
  for (const shift of shifts) {
    const effectiveStart = new Date(shift.effectiveStart);
    await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1', [shift.id, effectiveStart]);
    await audit(client, actor, 'playoff.schedule_cascaded', 'playoff_match', shift.id, {
      trigger: cause,
      effectiveStart: effectiveStart.toISOString(),
      delaySeconds: shift.delaySeconds
    });
  }
  return shifts.map((shift) => shift.id);
}

/**
 * Re-flows everything after a schedule-changing action: playoff heats follow
 * their feeder heats and arenas, then all unstarted matches and heats move
 * around timed events and arena overlaps. Repeats until nothing moves.
 */
export async function reflowSchedule(
  client: PoolClient,
  competitionId: string,
  actor: string,
  cause: string,
  options: ReflowOptions = {}
): Promise<string[]> {
  const moved = new Set<string>();
  for (let pass = 0; pass < 6; pass += 1) {
    const heatShifts = await cascadePlayoffHeats(client, competitionId, actor, cause);
    const eventShifts = await shiftScheduledMatchesAroundEvents(client, competitionId, actor, cause, options);
    for (const id of [...heatShifts, ...eventShifts]) moved.add(id);
    if (!heatShifts.length && !eventShifts.length) break;
  }
  return [...moved];
}
