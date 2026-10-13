import { type PoolClient } from 'pg';
import { MATCH_COUNTDOWN_TOTAL_SECONDS } from '../domain/display.js';

export async function hasTeamInActiveMatch(
  client: PoolClient,
  competitionId: string,
  matchId: string
): Promise<boolean> {
  const active = await client.query(
    `SELECT 1
     FROM match_positions requested
     JOIN match_positions occupied ON occupied.team_id = requested.team_id
       AND occupied.match_id <> requested.match_id
     JOIN matches running ON running.id = occupied.match_id
     WHERE requested.match_id = $1 AND running.competition_id = $2
       AND (
         running.state IN ('running', 'paused')
         OR (running.countdown_started_at > now() - ($3 * interval '1 second')
             AND running.state IN ('scheduled', 'ready', 'delayed'))
       )
     LIMIT 1`,
    [matchId, competitionId, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
  );
  return Boolean(active.rowCount);
}

/** True when any of the heat's teams, or its arena, is already in a running, paused or counting-down match. */
export async function playoffHeatHasActiveConflict(
  client: PoolClient,
  competitionId: string,
  heatId: string,
  teamIds: string[],
  arenaName: string
): Promise<boolean> {
  const conflict = await client.query(
    `SELECT 1 FROM matches m JOIN match_positions mp ON mp.match_id = m.id
     WHERE m.competition_id = $1 AND mp.team_id = ANY($2::uuid[])
       AND (m.state IN ('running', 'paused') OR
         (m.countdown_started_at > now() - ($5 * interval '1 second')
          AND m.state IN ('scheduled', 'ready', 'delayed')))
     UNION ALL
     SELECT 1 FROM playoff_matches other JOIN playoff_brackets ob ON ob.id = other.bracket_id
     WHERE ob.competition_id = $1 AND other.id <> $3
       AND (other.timer_state IN ('running', 'paused')
         OR other.countdown_started_at > now() - ($5 * interval '1 second'))
       AND ARRAY[other.team_one_id,other.team_two_id,other.team_three_id,other.team_four_id]
         && $2::uuid[]
     UNION ALL
     SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $4
       AND (state IN ('running', 'paused') OR
         (countdown_started_at > now() - ($5 * interval '1 second')
          AND state IN ('scheduled', 'ready', 'delayed')))
     UNION ALL
     SELECT 1 FROM playoff_matches other JOIN playoff_brackets ob ON ob.id = other.bracket_id
     WHERE ob.competition_id = $1 AND other.id <> $3 AND other.arena_name = $4
       AND (other.timer_state IN ('running', 'paused')
         OR other.countdown_started_at > now() - ($5 * interval '1 second'))
     LIMIT 1`,
    [competitionId, teamIds, heatId, arenaName, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
  );
  return Boolean(conflict.rowCount);
}

/**
 * The number of an earlier heat in the same arena that has not been played yet, if any. Heats run in
 * schedule order: a later heat waits until the earlier one is played (its teams are not ready either).
 */
export async function earlierUnplayedHeat(
  client: PoolClient,
  heatId: string
): Promise<number | null> {
  const result = await client.query<{ match_number: number }>(
    `SELECT other.match_number
     FROM playoff_matches heat
     JOIN playoff_matches other ON other.bracket_id = heat.bracket_id AND other.id <> heat.id
       AND other.arena_name = heat.arena_name
     WHERE heat.id = $1
       AND other.status <> 'complete' AND other.schedule_state = 'scheduled' AND other.timer_state = 'scheduled'
       AND other.countdown_started_at IS NULL
       AND (other.effective_start, other.match_number) < (heat.effective_start, heat.match_number)
     ORDER BY other.effective_start, other.match_number
     LIMIT 1`,
    [heatId]
  );
  return result.rows[0]?.match_number ?? null;
}
