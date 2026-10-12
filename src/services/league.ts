import { Pool, type PoolClient } from 'pg';
import { type StandingScore, rankStandings } from '../domain/standings.js';

export async function fetchStandings(client: Pool | PoolClient, competitionId: string) {
  const result = await client.query(
    `SELECT t.id, t.code, t.name,
            coalesce(ms.match_points, 0)::numeric AS match_points,
            coalesce(cc.challenge_points, 0)::numeric AS challenge_points,
            (coalesce(ms.match_points, 0) + coalesce(cc.challenge_points, 0))::numeric AS league_points,
            coalesce(ms.scored_matches, 0)::int AS scored_matches
     FROM teams t
     LEFT JOIN (
       SELECT team_id, sum(league_points) AS match_points, count(*)::int AS scored_matches
       FROM match_scores GROUP BY team_id
     ) ms ON ms.team_id = t.id
     LEFT JOIN (
       SELECT completion.team_id, sum(challenge.points) AS challenge_points
       FROM challenge_completions completion
       JOIN challenges challenge ON challenge.id = completion.challenge_id
       GROUP BY completion.team_id
     ) cc ON cc.team_id = t.id
     WHERE t.competition_id = $1 AND t.active = true
     ORDER BY league_points DESC, t.code ASC`,
    [competitionId]
  );
  const ranked = rankStandings(result.rows.map((row) => ({
    ...row, leaguePoints: Number(row.league_points), matchPoints: Number(row.match_points)
  })), await fetchLeagueScores(client, competitionId));
  return ranked.map(({ leaguePoints: _league, matchPoints: _match, tiedWith, ...row }) => ({ ...row, tied_with: tiedWith }));
}

/** Every league score, for head-to-head and best-match tie-breaks. */
export async function fetchLeagueScores(client: Pool | PoolClient, competitionId: string): Promise<StandingScore[]> {
  const scores = await client.query<{ match_id: string; team_id: string; league_points: string }>(
    `SELECT ms.match_id, ms.team_id, ms.league_points
     FROM match_scores ms JOIN matches m ON m.id = ms.match_id WHERE m.competition_id = $1`,
    [competitionId]
  );
  return scores.rows.map((score) => ({
    matchId: score.match_id, teamId: score.team_id, points: Number(score.league_points)
  }));
}

export type PlayoffSeedStanding = {
  id: string;
  rank: number;
  code: string;
  name: string;
  matchPoints: number;
  challengePoints: number;
  leaguePoints: number;
  scoredMatches: number;
  /** Teams still level after every tie-break (the judge decides). */
  tiedWith?: string[];
};

export async function fetchPlayoffSeedSnapshot(client: PoolClient, competitionId: string) {
  const result = await client.query<{
    id: string;
    code: string;
    name: string;
    match_points: string | number;
    challenge_points: string | number;
    league_points: string | number;
    scored_matches: number;
    seed_match_number: number;
    snapshot_at: Date;
  }>(
    `WITH scored_match_cutoff AS (
       SELECT coalesce(max(m.match_number), 0)::int AS seed_match_number
       FROM match_scores ms JOIN matches m ON m.id = ms.match_id
       WHERE m.competition_id = $1
     ), team_standings AS (
       SELECT t.id, t.code, t.name,
              coalesce(ms.match_points, 0)::numeric AS match_points,
              coalesce(cc.challenge_points, 0)::numeric AS challenge_points,
              (coalesce(ms.match_points, 0) + coalesce(cc.challenge_points, 0))::numeric AS league_points,
              coalesce(ms.scored_matches, 0)::int AS scored_matches
       FROM teams t
       LEFT JOIN (
         SELECT team_id, sum(league_points) AS match_points, count(*)::int AS scored_matches
         FROM match_scores GROUP BY team_id
       ) ms ON ms.team_id = t.id
       LEFT JOIN (
         SELECT completion.team_id, sum(challenge.points) AS challenge_points
         FROM challenge_completions completion
         JOIN challenges challenge ON challenge.id = completion.challenge_id
         GROUP BY completion.team_id
       ) cc ON cc.team_id = t.id
       WHERE t.competition_id = $1 AND t.active = true
     )
     SELECT standings.*, cutoff.seed_match_number, clock_timestamp() AS snapshot_at
     FROM team_standings standings CROSS JOIN scored_match_cutoff cutoff
     ORDER BY standings.league_points DESC, standings.code ASC`,
    [competitionId]
  );
  const ranked = rankStandings(result.rows.map((team) => ({
    ...team, leaguePoints: Number(team.league_points), matchPoints: Number(team.match_points)
  })), await fetchLeagueScores(client, competitionId));
  return {
    standings: ranked.map((team, index): PlayoffSeedStanding => ({
      id: team.id,
      rank: index + 1,
      code: team.code,
      name: team.name,
      matchPoints: team.matchPoints,
      challengePoints: Number(team.challenge_points),
      leaguePoints: team.leaguePoints,
      scoredMatches: Number(team.scored_matches),
      tiedWith: team.tiedWith
    })),
    latestScoredMatchNumber: Number(result.rows[0]?.seed_match_number ?? 0),
    capturedAt: result.rows[0]?.snapshot_at ?? new Date()
  };
}
