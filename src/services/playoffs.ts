import { type PoolClient } from 'pg';
import { audit } from '../db/audit.js';
import { type DiagramHeat } from '../domain/bracket-diagram.js';
import { formatCompetitionTime } from '../domain/display.js';
import { type PlayoffMatchState, buildPlayoffSeedRanks, resolvePlayoffAdvancements } from '../domain/playoffs.js';
import { fetchPlayoffSeedSnapshot } from './league.js';

export async function persistPlayoffAdvancements(
  client: PoolClient,
  bracketId: string,
  seedTeams: ReadonlyMap<number, string>
): Promise<void> {
  const result = await client.query<{
    key: string; side: PlayoffMatchState['side']; round: number;
    source_one: string; source_two: string; source_three: string; source_four: string;
    team_one_id: string | null; team_two_id: string | null;
    team_three_id: string | null; team_four_id: string | null;
    placements: PlayoffMatchState['placements']; status: PlayoffMatchState['status'];
  }>(
    `SELECT id AS key, bracket_side AS side, round_number AS round,
            source_one, source_two, source_three, source_four,
            team_one_id, team_two_id, team_three_id, team_four_id, placements, status
     FROM playoff_matches WHERE bracket_id = $1 ORDER BY match_number`,
    [bracketId]
  );
  const current: PlayoffMatchState[] = result.rows.map((match) => ({
    key: match.key,
    side: match.side,
    round: match.round,
    sources: [match.source_one, match.source_two, match.source_three, match.source_four],
    teamIds: [match.team_one_id, match.team_two_id, match.team_three_id, match.team_four_id],
    placements: match.placements,
    status: match.status
  }));
  const resolved = resolvePlayoffAdvancements(current, seedTeams);
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = resolved[index]!;
    if (before.teamIds.every((teamId, teamIndex) => teamId === after.teamIds[teamIndex]) &&
        before.status === after.status) continue;
    await client.query(
      `UPDATE playoff_matches SET team_one_id = $2, team_two_id = $3,
         team_three_id = $4, team_four_id = $5, status = $6 WHERE id = $1`,
      [before.key, ...after.teamIds, after.status]
    );
  }
}

export async function refreshUnstartedPlayoffSeeds(
  client: PoolClient,
  competitionId: string,
  actor: string
): Promise<void> {
  const brackets = await client.query<{ id: string; field_size: number }>(
    `SELECT id, field_size FROM playoff_brackets
     WHERE competition_id = $1 AND status = 'active' AND seed_frozen_at IS NULL
     ORDER BY created_at FOR UPDATE`,
    [competitionId]
  );
  if (!brackets.rowCount) return;
  const snapshot = await fetchPlayoffSeedSnapshot(client, competitionId);
  const standings = snapshot.standings;
  for (const bracket of brackets.rows) {
    if (standings.length < bracket.field_size) continue;
    const selectedTeams = standings.slice(0, bracket.field_size);
    const { seedRanks, seedTeams } = buildPlayoffSeedRanks(
      selectedTeams.map((team) => team.id), bracket.field_size
    );
    const current = await client.query<{ seed_ranks: Record<string, number> }>(
      'SELECT seed_ranks FROM playoff_brackets WHERE id = $1',
      [bracket.id]
    );
    const currentRanks = current.rows[0]?.seed_ranks;
    const normalizeRanks = (ranks: Record<string, number> | undefined) =>
      JSON.stringify(Object.entries(ranks ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    const ranksChanged = normalizeRanks(currentRanks) !== normalizeRanks(seedRanks);
    await client.query(
      `UPDATE playoff_brackets SET seed_ranks = $2::jsonb,
         seed_standings_snapshot = $3::jsonb, seed_match_number = $4, seed_snapshot_at = $5
       WHERE id = $1 AND seed_frozen_at IS NULL`,
      [
        bracket.id,
        JSON.stringify(seedRanks),
        JSON.stringify(standings),
        snapshot.latestScoredMatchNumber,
        snapshot.capturedAt
      ]
    );
    if (ranksChanged) {
      await persistPlayoffAdvancements(client, bracket.id, seedTeams);
      await audit(client, actor, 'playoffs.seeds_refreshed', 'playoff_bracket', bracket.id, {
        fieldSize: bracket.field_size,
        seeds: selectedTeams.map((team, index) => ({ seed: index + 1, teamCode: team.code }))
      });
    }
  }
}


export function heatStatusLabel(scheduleState: string, timerState: string, effectiveStart: Date | string, timeZone: string): string {
  if (scheduleState === 'complete') return 'Result';
  if (timerState === 'running' || timerState === 'paused') return 'Live';
  if (timerState === 'awaiting_score') return 'Scoring';
  return formatCompetitionTime(new Date(effectiveStart), timeZone);
}

export function heatForDiagram(match: Record<string, any>, timeZone: string): DiagramHeat {
  const scores = Array.isArray(match.scores) ? match.scores as { teamCode: string; points: number }[] : [];
  return {
    id: match.id,
    number: match.match_number,
    side: match.bracket_side,
    sources: match.sources,
    teams: [match.team_one_code, match.team_two_code, match.team_three_code, match.team_four_code],
    results: match.status === 'complete' ? scores.map((score) => ({ team: score.teamCode, points: score.points })) : null,
    advancing: match.advancing_places,
    status: heatStatusLabel(match.schedule_state, match.timer_state, match.effective_start, timeZone),
    arena: match.arena_name,
    live: ['running', 'paused'].includes(match.timer_state)
  };
}


export async function lockUpcomingPlayoffHeat(client: PoolClient, matchId: string) {
  const initial = await client.query<{ competition_id: string }>(
    `SELECT pb.competition_id FROM playoff_matches pm
     JOIN playoff_brackets pb ON pb.id = pm.bracket_id WHERE pm.id = $1`,
    [matchId]
  );
  if (!initial.rows[0]) return { error: { status: 404 as const, error: 'Playoff heat not found' } };
  const competitionId = initial.rows[0].competition_id;
  await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
  const heatResult = await client.query<{
    match_number: number; arena_name: string; scheduled_start: Date; effective_start: Date;
    duration_seconds: number; planned_gap_seconds: number; schedule_state: string; timer_state: string;
    countdown_started_at: Date | null; sources: string[];
  }>(
    `SELECT pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start, pm.duration_seconds,
            pm.planned_gap_seconds, pm.schedule_state, pm.timer_state, pm.countdown_started_at,
            ARRAY[pm.source_one, pm.source_two, pm.source_three, pm.source_four] AS sources
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
    [matchId]
  );
  const heat = heatResult.rows[0];
  if (!heat) return { error: { status: 409 as const, error: 'This playoff bracket is no longer active' } };
  if (heat.schedule_state !== 'scheduled' || heat.timer_state !== 'scheduled' || heat.countdown_started_at) {
    return { error: { status: 409 as const, error: 'Only an upcoming playoff heat without an active countdown can be delayed or undelayed' } };
  }
  return { competitionId, heat };
}
