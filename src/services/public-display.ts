import { pool } from '../db/pool.js';
import { renderBracketDiagram } from '../domain/bracket-diagram.js';
import { displayOptionsSchema, publicMatchPriority } from '../domain/display.js';
import { playoffStages, summarisePlayoffLosses } from '../domain/playoffs.js';
import { fetchStandings } from './league.js';
import { heatStatusLabel } from './playoffs.js';

export async function loadPublicDisplay(slug: string) {
  const result = await pool.query<{
    display_slug: string; title: string; display_type: string; options: Record<string, unknown>;
    competition_id: string; competition_name: string; competition_slug: string; status: string;
    theme: string; logo_data_url: string | null; competition_timezone: string;
  }>(
    `SELECT d.slug AS display_slug, d.title, d.display_type, d.options,
            c.id AS competition_id, c.name AS competition_name, c.slug AS competition_slug,
            c.timezone AS competition_timezone,
            c.status, coalesce(s.theme, 'paper') AS theme, s.logo_data_url
     FROM public_displays d
     JOIN competitions c ON c.id = d.competition_id
     LEFT JOIN competition_settings s ON s.competition_id = c.id
     WHERE d.slug = $1 AND d.enabled = true`,
    [slug]
  );
  const display = result.rows[0];
  if (!display || !['published', 'live', 'complete'].includes(display.status)) return undefined;
  const options = displayOptionsSchema.parse(display.options ?? {});
  let data: unknown;
  let previousResults: unknown = null;
  if (display.display_type === 'league') {
    data = (await fetchStandings(pool, display.competition_id)).map(({ id: _id, ...team }) => team);
  } else if (display.display_type === 'sr-outside') {
    const [standings, schedule, results, knockout] = await Promise.all([
      fetchStandings(pool, display.competition_id),
      pool.query(
        `SELECT m.match_number, m.arena_name, m.effective_start, m.state,
                count(mp.team_id)::int AS team_count,
                jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name)
                  ORDER BY mp.position_number) FILTER (WHERE mp.position_number IS NOT NULL) AS teams
         FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
         LEFT JOIN teams t ON t.id = mp.team_id
         WHERE m.competition_id = $1 AND m.state NOT IN ('complete', 'cancelled')
         GROUP BY m.id ORDER BY m.effective_start, m.match_number LIMIT 12`,
        [display.competition_id]
      ),
      pool.query(
        `SELECT m.match_number, m.effective_start,
                jsonb_agg(jsonb_build_object('code', t.code, 'points', ms.league_points)
                  ORDER BY mp.position_number) AS scores
         FROM matches m JOIN match_scores ms ON ms.match_id = m.id
         JOIN teams t ON t.id = ms.team_id
         JOIN match_positions mp ON mp.match_id = m.id AND mp.team_id = t.id
         WHERE m.competition_id = $1 AND m.state = 'complete'
         GROUP BY m.id ORDER BY m.effective_start DESC, m.match_number DESC LIMIT 6`,
        [display.competition_id]
      ),
      pool.query(
        `SELECT pm.match_number, pm.round_number, pm.bracket_side, pm.status,
                winner.code AS winner,
                jsonb_agg(jsonb_build_object('code', t.code, 'points', pms.points)
                  ORDER BY (SELECT p.idx FROM jsonb_array_elements_text(coalesce(pm.placements, '[]'::jsonb)) WITH ORDINALITY AS p(team_id, idx) WHERE p.team_id = t.id::text) NULLS LAST, pms.points DESC) FILTER (WHERE t.code IS NOT NULL) AS scores
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         LEFT JOIN teams winner ON winner.id = pm.winner_team_id
         LEFT JOIN playoff_match_scores pms ON pms.playoff_match_id = pm.id
         LEFT JOIN teams t ON t.id = pms.team_id
         WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
         GROUP BY pm.id, winner.code
         ORDER BY pm.round_number, pm.match_number`,
        [display.competition_id]
      )
    ]);
    data = {
      standings: standings.map(({ id: _id, ...team }) => team),
      schedule: schedule.rows,
      results: results.rows,
      knockout: knockout.rows
    };
  } else if (display.display_type === 'results') {
    const results = await pool.query(
      `SELECT * FROM (
         SELECT 'League'::text AS match_type, m.match_number, m.effective_start, m.arena_name,
                jsonb_agg(jsonb_build_object(
                  'code', t.code, 'name', t.name, 'points', ms.league_points,
                  'position', mp.position_number, 'colour', mp.colour
                ) ORDER BY mp.position_number) AS scores
         FROM matches m
         JOIN match_scores ms ON ms.match_id = m.id
         JOIN teams t ON t.id = ms.team_id
         JOIN match_positions mp ON mp.match_id = m.id AND mp.team_id = t.id
         WHERE m.competition_id = $1 AND m.state = 'complete'
         GROUP BY m.id
         UNION ALL
         SELECT 'Playoff'::text AS match_type, pm.match_number, pm.effective_start, pm.arena_name,
                jsonb_agg(jsonb_build_object(
                  'code', t.code, 'name', t.name, 'points', pms.points,
                  'position', slots.position, 'colour', coalesce(
                    cs.corner_colours ->> (slots.position::int - 1),
                    (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[slots.position::int]
                  )
                ) ORDER BY slots.position) AS scores
         FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         JOIN playoff_match_scores pms ON pms.playoff_match_id = pm.id
         JOIN teams t ON t.id = pms.team_id
         CROSS JOIN LATERAL unnest(ARRAY[
           pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id
         ]) WITH ORDINALITY AS slots(team_id, position)
         LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
         WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
           AND pm.schedule_state = 'complete' AND slots.team_id = t.id
         GROUP BY pm.id
       ) completed_matches
       ORDER BY effective_start, match_number, match_type`,
      [display.competition_id]
    );
    data = results.rows;
  } else if (['schedule', 'arena', 'timer', 'corner', 'sr-arena', 'sr-producer',
      'sr-shepherding', 'sr-staging'].includes(display.display_type)) {
    // A match that just ended stays on screen long enough for its END cue, whether or not it has scores.
    // A finished match stays only while its END cue shows; then the next match takes over.
    const justFinishedWindow = options.showEndCue ? options.endCueDurationSeconds + 1 : 1;
    const match = await pool.query(
      `SELECT m.id, m.match_number, m.arena_name, m.effective_start, m.duration_seconds,
              m.state, m.actual_start, m.actual_end, m.countdown_started_at, m.paused_at, m.paused_seconds,
              jsonb_agg(jsonb_build_object(
                'position', mp.position_number, 'spot', mp.position_number - 1,
                'label', mp.position_label, 'colour', mp.colour,
                'teamCode', t.code, 'teamName', t.name
              ) ORDER BY mp.position_number) AS positions,
              count(mp.team_id)::int AS team_count
       FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1
         AND ($3::text = '' OR m.arena_name = $3)
         AND (
           m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
           OR (m.state IN ('awaiting_score', 'complete') AND m.actual_end >= now() - make_interval(secs => $2::int))
         )
       GROUP BY m.id
       ORDER BY CASE WHEN m.countdown_started_at IS NOT NULL AND m.state IN ('scheduled', 'ready', 'delayed') THEN 0
                     WHEN m.state = 'running' THEN 1
                     WHEN m.state = 'paused' THEN 2
                     WHEN m.state IN ('awaiting_score', 'complete') THEN 3
                     ELSE 4 END,
                CASE WHEN m.state IN ('awaiting_score', 'complete') THEN -extract(epoch FROM m.actual_end)
                     ELSE extract(epoch FROM coalesce(m.countdown_started_at, m.actual_start, m.effective_start)) END,
                m.match_number
       LIMIT 1`,
      [display.competition_id, justFinishedWindow, options.srArenaName]
    );
    const playoffTimer = await pool.query(
      `SELECT pm.id, pm.match_number, pm.arena_name, pm.effective_start, pm.duration_seconds,
              CASE WHEN pm.schedule_state = 'complete' THEN 'complete'
                   WHEN pm.timer_state = 'awaiting_score' THEN 'awaiting_score'
                   WHEN pm.timer_state IN ('running', 'paused') THEN pm.timer_state
                   ELSE pm.status END AS state,
              pm.actual_start, pm.actual_end, pm.countdown_started_at, pm.paused_at, pm.paused_seconds,
              jsonb_build_array(
                jsonb_build_object('position',1,'spot',0,'label','Position 0','colour',coalesce(cs.corner_colours ->> 0,'#d1495b'),'teamCode',t1.code,'teamName',t1.name),
                jsonb_build_object('position',2,'spot',1,'label','Position 1','colour',coalesce(cs.corner_colours ->> 1,'#00798c'),'teamCode',t2.code,'teamName',t2.name),
                jsonb_build_object('position',3,'spot',2,'label','Position 2','colour',coalesce(cs.corner_colours ->> 2,'#edae49'),'teamCode',t3.code,'teamName',t3.name),
                jsonb_build_object('position',4,'spot',3,'label','Position 3','colour',coalesce(cs.corner_colours ->> 3,'#30638e'),'teamCode',t4.code,'teamName',t4.name)
              ) AS positions,
              (pm.team_one_id IS NOT NULL)::int + (pm.team_two_id IS NOT NULL)::int +
                (pm.team_three_id IS NOT NULL)::int + (pm.team_four_id IS NOT NULL)::int AS team_count,
              true AS is_playoff
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       WHERE pb.competition_id = $1 AND pb.status = 'active'
         AND ($2::text = '' OR pm.arena_name = $2)
         AND (
           -- Heats waiting for earlier results count too: heats run in order, so screens show that one next.
           pm.schedule_state = 'scheduled'
           OR (pm.actual_end IS NOT NULL AND pm.actual_end >= now() - make_interval(secs => $3::int)
               AND (pm.schedule_state = 'complete' OR pm.timer_state = 'awaiting_score'))
         )
       ORDER BY CASE WHEN pm.countdown_started_at IS NOT NULL AND pm.timer_state = 'scheduled' THEN 0
            WHEN pm.timer_state = 'running' THEN 1
            WHEN pm.timer_state = 'paused' THEN 2
            WHEN pm.schedule_state = 'complete' OR pm.timer_state = 'awaiting_score' THEN 3
            ELSE 4 END,
                CASE WHEN pm.schedule_state = 'complete' OR pm.timer_state = 'awaiting_score'
                     THEN -extract(epoch FROM pm.actual_end)
                     ELSE extract(epoch FROM coalesce(pm.countdown_started_at, pm.actual_start, pm.effective_start)) END,
                pm.match_number LIMIT 1`,
      [display.competition_id, options.srArenaName, justFinishedWindow]
    );
    const displayMatches = [...match.rows, ...playoffTimer.rows];
    displayMatches.sort((left, right) => {
      const priority = (candidate: (typeof displayMatches)[number]) =>
        publicMatchPriority(
          candidate.state,
          ['scheduled', 'ready', 'delayed'].includes(candidate.state) && candidate.countdown_started_at !== null,
          candidate.actual_end,
          Date.now(),
          justFinishedWindow
        );
      return priority(left) - priority(right) ||
        new Date(left.effective_start).getTime() - new Date(right.effective_start).getTime() ||
        left.match_number - right.match_number;
    });
    const selectedMatch = displayMatches[0] ?? null;
    if (['schedule', 'sr-staging', 'sr-shepherding'].includes(display.display_type)) {
      const schedule = await pool.query(
        `SELECT 'match' AS item_type, m.match_number, m.arena_name, m.effective_start, m.state,
                m.countdown_started_at, m.scheduled_start, false AS is_playoff,
                count(mp.team_id)::int AS team_count,
                count(mp.team_id)::int AS entrant_count,
                jsonb_agg(jsonb_build_object(
                  'code', t.code, 'name', t.name, 'colour', mp.colour, 'position', mp.position_number,
                  'spot', mp.position_number - 1
                )
                  ORDER BY mp.position_number) FILTER (WHERE mp.position_number IS NOT NULL) AS teams
         FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
         LEFT JOIN teams t ON t.id = mp.team_id
         WHERE m.competition_id = $1 AND m.state <> 'cancelled'
           AND ($4::text = '' OR m.arena_name = $4)
           AND (NOT $3::boolean OR m.state <> 'complete')
         GROUP BY m.id
         UNION ALL
         SELECT 'match' AS item_type, pm.match_number, pm.arena_name, pm.effective_start,
                CASE WHEN pm.schedule_state = 'complete' THEN 'complete'
                     WHEN pm.timer_state <> 'scheduled' THEN pm.timer_state
                     ELSE pm.status END AS state,
                pm.countdown_started_at, pm.scheduled_start, true AS is_playoff,
                count(pt.id)::int AS team_count,
                ((pm.source_one <> 'bye')::int + (pm.source_two <> 'bye')::int +
                 (pm.source_three <> 'bye')::int + (pm.source_four <> 'bye')::int) AS entrant_count,
                jsonb_agg(jsonb_build_object(
                   'code', pt.code, 'name', pt.name,
                   'colour', coalesce(cs.corner_colours ->> ((slots.position::int) - 1),
                     (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[slots.position::int]),
                   'position', slots.position, 'spot', slots.position - 1
                 ) ORDER BY slots.position) AS teams
          FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
          LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
         CROSS JOIN LATERAL unnest(ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id])
           WITH ORDINALITY AS slots(team_id, position)
         LEFT JOIN teams pt ON pt.id = slots.team_id
         WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
           AND ($4::text = '' OR pm.arena_name = $4)
           AND (NOT $3::boolean OR pm.schedule_state <> 'complete')
         GROUP BY pm.id
         UNION ALL
         SELECT 'event' AS item_type, NULL::integer AS match_number, ce.location AS arena_name,
                ce.starts_at AS effective_start, ce.title AS state, NULL::timestamptz AS countdown_started_at,
                ce.starts_at AS scheduled_start, false AS is_playoff,
                NULL::integer AS team_count, NULL::integer AS entrant_count,
                jsonb_build_array(jsonb_build_object(
                  'title', ce.title, 'description', ce.description,
                  'location', ce.location, 'durationMinutes', ce.duration_minutes
                )) AS teams
         FROM competition_events ce WHERE ce.competition_id = $1
           AND (NOT $2::boolean OR ce.starts_at + make_interval(mins => ce.duration_minutes) > now())
         ORDER BY effective_start, match_number NULLS LAST`,
        [display.competition_id, options.hideCompletedEvents, options.hideCompletedMatches, options.srArenaName]
      );
      data = schedule.rows;
    } else {
      data = selectedMatch;
    }
    if (['timer', 'arena'].includes(display.display_type) && options.showPreviousResults) {
      const previousMatch = await pool.query(
        `SELECT * FROM (
           SELECT 'League'::text AS match_type, m.match_number, max(ms.updated_at) AS completed_at,
                  jsonb_agg(jsonb_build_object(
                    'code', t.code, 'name', t.name, 'points', ms.league_points,
                    'spot', mp.position_number - 1, 'colour', mp.colour
                  ) ORDER BY mp.position_number) AS scores
           FROM matches m
           JOIN match_scores ms ON ms.match_id = m.id
           JOIN teams t ON t.id = ms.team_id
           JOIN match_positions mp ON mp.match_id = m.id AND mp.team_id = t.id
           WHERE m.competition_id = $1 AND m.state = 'complete'
           GROUP BY m.id
           UNION ALL
           SELECT 'Playoff'::text AS match_type, pm.match_number, max(pms.updated_at) AS completed_at,
                  jsonb_agg(jsonb_build_object(
                    'code', t.code, 'name', t.name, 'points', pms.points,
                    'spot', slots.position::int - 1, 'colour', coalesce(
                      cs.corner_colours ->> (slots.position::int - 1),
                      (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[slots.position::int]
                    )
                  ) ORDER BY slots.position) AS scores
           FROM playoff_matches pm
           JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           JOIN playoff_match_scores pms ON pms.playoff_match_id = pm.id
           JOIN teams t ON t.id = pms.team_id
           CROSS JOIN LATERAL unnest(ARRAY[
             pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id
           ]) WITH ORDINALITY AS slots(team_id, position)
           LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
           WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
             AND pm.schedule_state = 'complete' AND slots.team_id = t.id
           GROUP BY pm.id
         ) completed_matches
         ORDER BY completed_at DESC, match_number DESC
         LIMIT 1`,
        [display.competition_id]
      );
      previousResults = previousMatch.rows[0] ?? null;
    }
  } else if (display.display_type === 'playoffs') {
    const bracket = await pool.query<{
      id: string; match_number: number; bracket_side: 'upper' | 'lower' | 'final'; round_number: number;
      status: string; schedule_state: string; timer_state: string; placements: string[] | null;
      advancing_places: number | null; arena_name: string; effective_start: Date; delay_seconds: number;
      format: string; sources: string[]; teams: (string | null)[];
      scores: { team: string; points: number }[] | null;
    }>(
      `SELECT pm.id, pm.match_number, pm.bracket_side, pm.round_number, pm.status, pm.schedule_state,
              pm.timer_state, pm.placements, pm.advancing_places, pm.arena_name, pm.effective_start,
              greatest(0, ceil(extract(epoch FROM (pm.effective_start - pm.scheduled_start))))::int AS delay_seconds,
              pb.format,
              ARRAY[pm.source_one, pm.source_two, pm.source_three, pm.source_four] AS sources,
              ARRAY[a.code, b.code, c.code, d.code] AS teams,
              (SELECT jsonb_agg(jsonb_build_object('team', t.code, 'points', pms.points)
                 ORDER BY (SELECT p.idx FROM jsonb_array_elements_text(coalesce(pm.placements, '[]'::jsonb)) WITH ORDINALITY AS p(team_id, idx) WHERE p.team_id = t.id::text) NULLS LAST, pms.points DESC, (pb.seed_ranks ->> t.id::text)::integer)
               FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
               WHERE pms.playoff_match_id = pm.id) AS scores
       FROM playoff_brackets pb JOIN playoff_matches pm ON pm.bracket_id = pb.id
       LEFT JOIN teams a ON a.id = pm.team_one_id
       LEFT JOIN teams b ON b.id = pm.team_two_id
       LEFT JOIN teams c ON c.id = pm.team_three_id
       LEFT JOIN teams d ON d.id = pm.team_four_id
       WHERE pb.id = (
         SELECT id FROM playoff_brackets WHERE competition_id = $1 AND status IN ('active', 'complete')
         ORDER BY created_at DESC LIMIT 1
       )
       ORDER BY pm.match_number`,
      [display.competition_id]
    );
    const stages = playoffStages(bracket.rows.map((heat) => ({ key: heat.id, sources: heat.sources })));
    const numberById = new Map(bracket.rows.map((heat) => [heat.id, heat.match_number]));
    const teamCodes = await pool.query<{ id: string; code: string }>(
      'SELECT id, code FROM teams WHERE competition_id = $1', [display.competition_id]
    );
    const codeById = new Map(teamCodes.rows.map((team) => [team.id, team.code]));
    const record = summarisePlayoffLosses(bracket.rows.map((heat) => ({
      key: heat.id, side: heat.bracket_side, sources: heat.sources,
      placements: heat.status === 'complete' ? heat.placements : null, advancing: heat.advancing_places
    })));
    const eliminatedCodes = [...record].filter(([, entry]) => entry.eliminated)
      .map(([teamId]) => codeById.get(teamId)).filter((code): code is string => Boolean(code));
    data = {
      diagram: renderBracketDiagram(bracket.rows.map((heat) => ({
        id: heat.id,
        number: heat.match_number,
        side: heat.bracket_side,
        sources: heat.sources,
        teams: heat.teams,
        results: heat.status === 'complete' ? heat.scores : null,
        advancing: heat.advancing_places,
        status: heatStatusLabel(heat.schedule_state, heat.timer_state, heat.effective_start, display.competition_timezone),
        arena: heat.arena_name,
        live: ['running', 'paused'].includes(heat.timer_state)
      })), { format: bracket.rows[0]?.format ?? null, eliminated: eliminatedCodes }),
      format: bracket.rows[0]?.format ?? null,
      heats: bracket.rows.map(({ id, sources, placements: _placements, ...heat }) => ({
        ...heat,
        stage: stages.get(id) ?? 1,
        sources: sources.map((source) => source.replace(/^place:(\d):(.+)$/,
          (_whole, place: string, key: string) => `place:${place}:${numberById.get(key) ?? '?'}`))
      })),
      eliminated: eliminatedCodes
    };
  }
  return {
    slug: display.display_slug,
    title: display.title,
    type: display.display_type,
    competition: display.competition_name,
    competitionSlug: display.competition_slug,
    competitionTimezone: display.competition_timezone,
    theme: display.theme,
    logoDataUrl: display.logo_data_url,
    options,
    data,
    previousResults,
    updatedAt: new Date().toISOString()
  };
}
