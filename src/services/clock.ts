import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { MATCH_COUNTDOWN_TOTAL_SECONDS } from '../domain/display.js';
import { hasTeamInActiveMatch, playoffHeatHasActiveConflict } from './conflicts.js';
import { refreshUnstartedPlayoffSeeds } from './playoffs.js';
import { delayNextMatchesAfterManualStart, reflowSchedule } from './reflow.js';

export async function processMatchClocks(): Promise<void> {
  const due = await pool.query<{ id: string; competition_id: string }>(
    `SELECT m.id, m.competition_id FROM matches m
     LEFT JOIN competition_settings settings ON settings.competition_id = m.competition_id
     WHERE m.state IN ('scheduled', 'ready', 'delayed')
       AND (
         (m.countdown_started_at IS NOT NULL
          AND m.countdown_started_at + ($1 * interval '1 second') <= now())
         OR (coalesce(settings.auto_run_enabled, false)
             AND m.countdown_started_at IS NULL
             AND m.effective_start <= now() + ($1 * interval '1 second'))
       )
     ORDER BY m.effective_start, m.match_number LIMIT 25`,
    [MATCH_COUNTDOWN_TOTAL_SECONDS]
  );
  for (const candidate of due.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const matchResult = await client.query<{
        arena_name: string;
        state: string;
        effective_start: Date;
        match_number: number;
        duration_seconds: number;
        planned_gap_seconds: number;
        countdown_started_at: Date | null;
      }>(
        `SELECT arena_name, state, effective_start, match_number, duration_seconds,
                planned_gap_seconds, countdown_started_at
         FROM matches WHERE id = $1 FOR UPDATE`,
        [candidate.id]
      );
      const match = matchResult.rows[0];
      if (!match || !['scheduled', 'ready', 'delayed'].includes(match.state) ||
          (match.countdown_started_at !== null &&
           new Date(match.countdown_started_at).getTime() + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000 > Date.now())) return;
      if (match.countdown_started_at === null) {
        await client.query(
          `UPDATE matches SET countdown_started_at = effective_start - ($2 * interval '1 second'),
             revision = revision + 1 WHERE id = $1`,
          [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
        );
        await audit(client, 'system:auto-start', 'match.countdown_started', 'match', candidate.id, {
          trigger: 'competition_auto_run',
          countdownStartedAt: new Date(match.effective_start.getTime() - MATCH_COUNTDOWN_TOTAL_SECONDS * 1000).toISOString()
        });
        if (match.effective_start.getTime() > Date.now()) return;
      }
      const teams = await client.query<{ count: number }>(
        'SELECT count(team_id)::int AS count FROM match_positions WHERE match_id = $1',
        [candidate.id]
      );
      if ((teams.rows[0]?.count ?? 0) < 1) return;
      const active = await client.query(
        `SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $2
         AND id <> $3 AND (
           state IN ('running', 'paused')
           OR (countdown_started_at > now() - ($4 * interval '1 second')
               AND state IN ('scheduled', 'ready', 'delayed'))
         ) LIMIT 1`,
        [candidate.competition_id, match.arena_name, candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      if (active.rowCount) return;
      if (await hasTeamInActiveMatch(client, candidate.competition_id, candidate.id)) return;
      const started = await client.query<{ actual_start: Date }>(
        `UPDATE matches SET state = 'running',
           actual_start = coalesce(countdown_started_at + ($2 * interval '1 second'), now()),
           countdown_started_at = NULL,
           revision = revision + 1
         WHERE id = $1 RETURNING actual_start`,
        [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
      );
      const delayedMatchIds = await delayNextMatchesAfterManualStart(
        client,
        candidate.competition_id,
        match.arena_name,
        candidate.id,
        match.match_number,
        new Date(match.effective_start),
        new Date(started.rows[0]!.actual_start),
        match.duration_seconds,
        'system:auto-start',
        'automatic start'
      );
      await audit(client, 'system:auto-start', 'match.started', 'match', candidate.id, {
        trigger: 'competition_auto_run',
        delayedMatchIds
      });
    });
  }

  const completed = await pool.query<{ id: string; competition_id: string }>(
    `SELECT id, competition_id FROM matches
     WHERE state = 'running' AND actual_start + (duration_seconds + paused_seconds) * interval '1 second' <= now()
     ORDER BY actual_start LIMIT 25`
  );
  for (const candidate of completed.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const match = await client.query<{ state: string; duration_seconds: number; paused_seconds: number; actual_start: Date }>(
        'SELECT state, duration_seconds, paused_seconds, actual_start FROM matches WHERE id = $1 FOR UPDATE',
        [candidate.id]
      );
      const row = match.rows[0];
      if (!row || row.state !== 'running' || !row.actual_start) return;
      const dueAt = new Date(row.actual_start).getTime() +
        (row.duration_seconds + row.paused_seconds) * 1000;
      if (dueAt > Date.now()) return;
      await client.query(
        `UPDATE matches SET state = 'awaiting_score', actual_end = now(), revision = revision + 1 WHERE id = $1`,
        [candidate.id]
      );
      await audit(client, 'system:timer', 'match.timer_finished', 'match', candidate.id);
    });
  }

  // Competition auto-run also starts ready playoff heats at their effective time.
  const autoHeats = await pool.query<{ id: string; competition_id: string }>(
    `SELECT pm.id, pb.competition_id
     FROM playoff_matches pm
     JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     JOIN competition_settings settings ON settings.competition_id = pb.competition_id
     WHERE settings.auto_run_enabled AND pb.status = 'active' AND pm.status = 'ready'
       AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
       AND pm.countdown_started_at IS NULL
       AND pm.effective_start <= now() + ($1 * interval '1 second')
     ORDER BY pm.effective_start, pm.match_number LIMIT 25`,
    [MATCH_COUNTDOWN_TOTAL_SECONDS]
  );
  for (const candidate of autoHeats.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      await refreshUnstartedPlayoffSeeds(client, candidate.competition_id, 'system:auto-start');
      const heatResult = await client.query<{
        bracket_id: string; match_number: number; arena_name: string; team_ids: (string | null)[];
        status: string; timer_state: string; countdown_started_at: Date | null;
      }>(
        `SELECT pm.bracket_id, pm.match_number, pm.arena_name, pm.status, pm.timer_state,
                pm.countdown_started_at,
                ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
        [candidate.id]
      );
      const heat = heatResult.rows[0];
      if (!heat || heat.status !== 'ready' || heat.timer_state !== 'scheduled' || heat.countdown_started_at) return;
      const teamIds = heat.team_ids.filter((teamId): teamId is string => teamId !== null);
      if (teamIds.length < 2) return;
      // Wait (without logging every tick) until the arena and teams are free.
      if (await playoffHeatHasActiveConflict(client, candidate.competition_id, candidate.id, teamIds, heat.arena_name)) return;
      const started = await client.query<{ countdown_started_at: Date }>(
        `UPDATE playoff_matches SET countdown_restore_start = effective_start,
           countdown_started_at = greatest(effective_start - ($2 * interval '1 second'), now())
         WHERE id = $1 RETURNING countdown_started_at`,
        [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
      );
      await client.query(
        'UPDATE playoff_brackets SET seed_frozen_at = coalesce(seed_frozen_at, now()) WHERE id = $1',
        [heat.bracket_id]
      );
      await audit(client, 'system:auto-start', 'playoff_match.countdown_started', 'playoff_match', candidate.id, {
        trigger: 'competition_auto_run',
        matchNumber: heat.match_number,
        countdownStartedAt: new Date(started.rows[0]!.countdown_started_at).toISOString()
      });
      await reflowSchedule(client, candidate.competition_id, 'system:auto-start',
        `playoff heat #${heat.match_number} automatic start`);
    });
  }

  const playoffStarts = await pool.query<{ id: string; competition_id: string }>(
    `SELECT pm.id, pb.competition_id
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.status = 'active' AND pm.schedule_state = 'scheduled'
       AND pm.timer_state = 'scheduled' AND pm.countdown_started_at IS NOT NULL
       AND pm.countdown_started_at + ($1 * interval '1 second') <= now()
     ORDER BY pm.countdown_started_at LIMIT 25`
    , [MATCH_COUNTDOWN_TOTAL_SECONDS]
  );
  for (const candidate of playoffStarts.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const heatResult = await client.query<{
        bracket_id: string; match_number: number; arena_name: string; team_ids: (string | null)[];
        duration_seconds: number; countdown_started_at: Date; timer_state: string;
      }>(
        `SELECT pm.bracket_id, pm.match_number, pm.arena_name,
                ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids,
                pm.duration_seconds, pm.countdown_started_at, pm.timer_state
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
        [candidate.id]
      );
      const heat = heatResult.rows[0];
      if (!heat || heat.timer_state !== 'scheduled' || !heat.countdown_started_at ||
          new Date(heat.countdown_started_at).getTime() + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000 > Date.now()) return;
      const teamIds = heat.team_ids.filter((teamId): teamId is string => teamId !== null);
      if (teamIds.length < 2) return;
      const conflict = await client.query(
        `SELECT 1 FROM matches m JOIN match_positions mp ON mp.match_id = m.id
         WHERE m.competition_id = $1 AND mp.team_id = ANY($2::uuid[])
           AND (m.state IN ('running', 'paused') OR
             (m.countdown_started_at > now() - ($4 * interval '1 second')
              AND m.state IN ('scheduled', 'ready', 'delayed')))
         UNION ALL
         SELECT 1 FROM playoff_matches other
         JOIN playoff_brackets ob ON ob.id = other.bracket_id
         WHERE ob.competition_id = $1 AND other.id <> $3
           AND (other.timer_state IN ('running', 'paused')
             OR other.countdown_started_at > now() - ($4 * interval '1 second'))
           AND ARRAY[other.team_one_id,other.team_two_id,other.team_three_id,other.team_four_id]
             && $2::uuid[]
         LIMIT 1`,
        [candidate.competition_id, teamIds, candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      const arenaConflict = await client.query(
        `SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $2
           AND (state IN ('running', 'paused') OR
             (countdown_started_at > now() - ($4 * interval '1 second')
              AND state IN ('scheduled', 'ready', 'delayed')))
         UNION ALL
         SELECT 1 FROM playoff_matches other JOIN playoff_brackets ob ON ob.id = other.bracket_id
         WHERE ob.competition_id = $1 AND other.id <> $3 AND other.arena_name = $2
           AND (other.timer_state IN ('running', 'paused')
             OR other.countdown_started_at > now() - ($4 * interval '1 second'))
         LIMIT 1`,
        [candidate.competition_id, heat.arena_name, candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      if (conflict.rowCount || arenaConflict.rowCount) {
        await client.query(
          `UPDATE playoff_matches SET countdown_started_at = NULL, timer_state = 'scheduled'
           WHERE id = $1`,
          [candidate.id]
        );
        await audit(client, 'system:timer', 'playoff_match.start_blocked', 'playoff_match', candidate.id, {
          reason: conflict.rowCount ? 'assigned team already active' : 'arena already active'
        });
        return;
      }
      await client.query(
        `UPDATE playoff_matches SET timer_state = 'running',
           actual_start = countdown_started_at + ($2 * interval '1 second'),
           countdown_started_at = NULL
         WHERE id = $1`,
        [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
      );
      await audit(client, 'system:timer', 'playoff_match.started', 'playoff_match', candidate.id, {
        matchNumber: heat.match_number
      });
    });
  }

  const completedHeats = await pool.query<{ id: string; competition_id: string }>(
    `SELECT pm.id, pb.competition_id FROM playoff_matches pm
     JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pm.timer_state = 'running'
       AND pm.actual_start + (pm.duration_seconds + pm.paused_seconds) * interval '1 second' <= now()
     ORDER BY pm.actual_start LIMIT 25`
  );
  for (const candidate of completedHeats.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const result = await client.query(
        `UPDATE playoff_matches SET timer_state = 'awaiting_score', actual_end = now()
         WHERE id = $1 AND timer_state = 'running'
           AND actual_start + (duration_seconds + paused_seconds) * interval '1 second' <= now()`,
        [candidate.id]
      );
      if (result.rowCount) {
        await audit(client, 'system:timer', 'playoff_match.timer_finished', 'playoff_match', candidate.id);
      }
    });
  }
}
