import { pool } from '../db/pool.js';
import { playoffStages } from '../domain/playoffs.js';
import { computeStagingWindows } from '../domain/staging.js';
import { type SrMatchInput, groupSrKnockoutMatches, toSrMatches } from '../domain/srcomp.js';
import { findCompetition, getCornerColours, getStagingSettings } from './competitions.js';
import { fetchStandings } from './league.js';

export type SrDbMatch = SrMatchInput & {
  id: string;
  scheduled_start: Date | string;
  delay_seconds: number;
  positions: SrMatchInput['positions'] | null;
};

export type SrDbKnockoutMatch = SrDbMatch & {
  id: string;
  bracket_side: string;
  round_number: number;
  format: string;
  sources: string[];
};

export type SrTeam = {
  id: string;
  code: string;
  name: string;
  match_points: string | number;
  league_points: string | number;
  scored_matches: number;
};

export async function loadSrCompetitionData(competitionId: string) {
  const [allCornerColours, standings, leagueResult, playoffResult, sizeResult] = await Promise.all([
    getCornerColours(pool, competitionId),
    fetchStandings(pool, competitionId),
    pool.query<SrDbMatch>(
      `SELECT m.id, m.match_number, m.arena_name, m.scheduled_start, m.effective_start,
              m.duration_seconds, m.planned_gap_seconds, m.actual_start, m.actual_end,
              m.countdown_started_at, m.paused_at, m.paused_seconds, m.state,
              greatest(0, ceil(extract(epoch FROM (m.effective_start - m.scheduled_start))))::int
                AS delay_seconds,
              coalesce(jsonb_agg(jsonb_build_object(
                'position_number', mp.position_number,
                'team_code', t.code,
                'colour', mp.colour
              ) ORDER BY mp.position_number)
                FILTER (WHERE mp.position_number IS NOT NULL), '[]'::jsonb) AS positions,
              coalesce((
                SELECT jsonb_object_agg(scored_team.code, score.league_points)
                FROM match_scores score
                JOIN teams scored_team ON scored_team.id = score.team_id
                WHERE score.match_id = m.id
              ), '{}'::jsonb) AS scores
       FROM matches m
       LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1
       GROUP BY m.id
       ORDER BY m.scheduled_start, m.match_number`,
      [competitionId]
    ),
    pool.query<SrDbKnockoutMatch>(
      `SELECT pm.id, pb.format, ARRAY[pm.source_one, pm.source_two, pm.source_three, pm.source_four] AS sources,
              pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start,
              pm.duration_seconds, pm.planned_gap_seconds, pm.actual_start, pm.actual_end,
              pm.countdown_started_at, pm.paused_at, pm.paused_seconds,
              CASE WHEN pm.timer_state = 'awaiting_score' THEN 'awaiting_score'
                   WHEN pm.timer_state IN ('running', 'paused') THEN pm.timer_state
                   ELSE pm.status END AS state,
              0::int AS delay_seconds, pm.bracket_side, pm.round_number,
              jsonb_build_array(
                jsonb_build_object('position_number', 1, 'team_code', t1.code,
                  'colour', coalesce(settings.corner_colours ->> 0, '#d1495b')),
                jsonb_build_object('position_number', 2, 'team_code', t2.code,
                  'colour', coalesce(settings.corner_colours ->> 1, '#00798c')),
                jsonb_build_object('position_number', 3, 'team_code', t3.code,
                  'colour', coalesce(settings.corner_colours ->> 2, '#edae49')),
                jsonb_build_object('position_number', 4, 'team_code', t4.code,
                  'colour', coalesce(settings.corner_colours ->> 3, '#30638e'))
              ) AS positions,
              coalesce((
                SELECT jsonb_object_agg(scored_team.code, score.points)
                FROM playoff_match_scores score
                JOIN teams scored_team ON scored_team.id = score.team_id
                WHERE score.playoff_match_id = pm.id
              ), '{}'::jsonb) AS scores
       FROM playoff_matches pm
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       LEFT JOIN competition_settings settings ON settings.competition_id = pb.competition_id
       WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
       ORDER BY pm.round_number, pm.match_number`,
      [competitionId]
    ),
    pool.query<{ match_size: number }>('SELECT match_size FROM competitions WHERE id = $1', [competitionId])
  ]);
  const matchSize = sizeResult.rows[0]?.match_size ?? 4;
  // SR screens show one corner per team in a match.
  const cornerColours = allCornerColours.slice(0, matchSize);

  // One set of staging windows for every screen, computed from the competition's staging settings.
  const stagingSettings = await getStagingSettings(pool, competitionId);
  const time = (value: Date | string | null) => value === null ? null : new Date(value).getTime();
  const staging = computeStagingWindows([
    ...leagueResult.rows.map((match) => ({ ...match, key: `league:${match.id}` })),
    ...playoffResult.rows.map((match) => ({ ...match, key: `playoff:${match.id}` }))
  ].map((match) => ({
    key: match.key,
    arena: match.arena_name,
    state: match.state,
    effectiveStart: new Date(match.effective_start).getTime(),
    actualStart: time(match.actual_start),
    countdownStartedAt: time(match.countdown_started_at)
  })), stagingSettings);
  const matches = leagueResult.rows.map(({ id, ...match }) => ({
    ...match,
    match_size: matchSize,
    positions: match.positions ?? [],
    ...(staging.has(`league:${id}`) ? { staging: staging.get(`league:${id}`)! } : {})
  }));
  const playoffMatches = playoffResult.rows.map(({ id, format: _format, sources: _sources, ...match }) => ({
    ...match,
    match_size: matchSize,
    positions: match.positions ?? [],
    ...(staging.has(`playoff:${id}`) ? { staging: staging.get(`playoff:${id}`)! } : {})
  }));
  // Knockout columns follow the bracket's dependency order, so the final is always the last column.
  const stages = playoffStages(playoffResult.rows.map((match) => ({ key: match.id, sources: match.sources })));
  const playoffFormat = playoffResult.rows[0]?.format;
  const arenas = [...new Set([
    ...matches.map((match) => match.arena_name),
    ...playoffMatches.map((match) => match.arena_name)
  ])].sort((left, right) => left.localeCompare(right));
  const arenaMap = Object.fromEntries(arenas.map((name, index) => [
    name,
    {
      name,
      display_name: name,
      colour: cornerColours[index % cornerColours.length] ?? '#777777'
    }
  ]));
  const corners = Object.fromEntries(cornerColours.map((colour, index) => [
    String(index),
    { number: index, colour }
  ]));
  const teamMap = Object.fromEntries((standings as SrTeam[]).map((team, index) => [
    team.code,
    {
      tla: team.code,
      name: team.name,
      image_url: null,
      location: { name: 'competition' },
      league_pos: index + 1,
      scores: {
        league: Number(team.league_points),
        game: Number(team.match_points)
      }
    }
  ]));
  const allScheduledMatches = [...matches, ...playoffMatches];
  const allSrMatches = toSrMatches(allScheduledMatches);
  const srMatchByInput = new Map(allScheduledMatches.map((match, index) => [
    match,
    allSrMatches[index]!
  ]));
  const srMatches = matches.map((match) => srMatchByInput.get(match)!);
  const srPlayoffMatches = playoffMatches.map((match) => srMatchByInput.get(match)!);
  const knockoutRounds = groupSrKnockoutMatches(
    srPlayoffMatches.map((match, index) => ({
      ...match,
      round_number: stages.get(playoffResult.rows[index]!.id) ?? 1
    }))
  );
  const bracketNames = ['upper', 'lower', 'final'];
  const bracketLabels: Record<string, string> = {
    upper: playoffFormat === 'double-elimination' || playoffMatches.some((match) => match.bracket_side === 'lower') ? 'Upper Bracket' : 'Knockout',
    lower: 'Lower Bracket',
    final: 'Final'
  };
  const brackets = [...new Set(playoffMatches.map((match) => match.bracket_side))]
    .sort((left, right) => bracketNames.indexOf(left) - bracketNames.indexOf(right))
    .map((name) => ({ name, display_name: bracketLabels[name] ?? name }));

  return {
    cornerColours,
    arenas: arenaMap,
    corners,
    teams: teamMap,
    matches,
    srMatches,
    playoffMatches,
    srPlayoffMatches,
    knockoutRounds,
    brackets
  };
}

export async function getPublishedSrCompetition(slug: string) {
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return undefined;
  }
  return competition;
}
