import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { JUST_FINISHED_SECONDS, MATCH_COUNTDOWN_TOTAL_SECONDS } from '../domain/display.js';
import { escapeHtml } from '../lib/html.js';
import { findCompetition } from '../services/competitions.js';
import { fetchStandings } from '../services/league.js';
import { customPanelKinds, displayConfigHash, loadCustomPanel, loadDisplayConfig, loadPublicDisplay } from '../services/public-display.js';

export function registerPublicRoutes(app: FastifyInstance): void {
  app.get('/api/public/display/:slug/panel/:kind', async (request, reply) => {
    const params = z.object({ slug: z.string(), kind: z.enum(customPanelKinds) }).safeParse(request.params);
    const panel = params.success ? await loadCustomPanel(params.data.slug, params.data.kind) : undefined;
    if (!panel) return reply.code(404).send({ error: 'Panel not found' });
    reply.header('cache-control', 'no-store');
    return panel.display;
  });

  // Lightweight: lets an open screen notice that its settings changed and reload itself.
  app.get('/api/public/display/:slug/config', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const config = await loadDisplayConfig(slug);
    if (!config) return reply.code(404).send({ error: 'Public display not found' });
    reply.header('cache-control', 'no-store');
    return { hash: displayConfigHash(config) };
  });

  app.get('/api/public/display/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const display = await loadPublicDisplay(slug);
    if (!display) return reply.code(404).send({ error: 'Public display not found' });
    reply.header('cache-control',
      ['timer', 'arena', 'corner', 'sr-arena', 'sr-producer'].includes(display.type)
        ? 'no-store' : 'public, max-age=2, stale-while-revalidate=3');
    return display;
  });


  app.get('/public/v1/:slug/league', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
      return reply.code(404).send({ error: 'Competition not found' });
    }
    const result = { rows: await fetchStandings(pool, competition.id) };
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=10');
    return { competition: competition.name, updatedAt: new Date().toISOString(), standings: result.rows };
  });

  app.get('/embed/:slug/league', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
      return reply.code(404).send('Competition not found');
    }
    const result = { rows: await fetchStandings(pool, competition.id) };
    const rows = result.rows.map((team, index) =>
      `<tr><td>${index + 1}</td><th scope="row"><span class="code">${escapeHtml(team.code)}</span> ${escapeHtml(team.name)}</th><td>${escapeHtml(team.league_points)}</td></tr>`
    ).join('');
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=10');
    reply.header('x-content-type-options', 'nosniff');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(competition.name)} — league table</title>
  <style>
    :root{color-scheme:light;font:15px/1.45 Inter,"Helvetica Neue",Arial,sans-serif;color:#17242b;background:#fffefa}
    *{box-sizing:border-box}body{margin:0;padding:12px}header{border-bottom:2px solid #d94f2b;padding:4px 8px 10px;margin-bottom:8px}
    h1{font-size:1rem;margin:0;font-weight:700}table{border-collapse:collapse;width:100%;text-align:left}
    th,td{padding:8px;border-bottom:1px solid #d8dcd7}thead{background:#e8ebe6;color:#42525a;font:700 .7rem/1.3 monospace;text-transform:uppercase;letter-spacing:.04em}
    .code{display:inline-block;min-width:3ch;font:700 .8rem/1.4 monospace;color:#a9361d}
    td:last-child{text-align:right;font-variant-numeric:tabular-nums}tbody tr:nth-child(even){background:#f4f4ef}
  </style></head><body><header><h1>${escapeHtml(competition.name)} — League table</h1></header>
  <table><thead><tr><th scope="col">Rank</th><th scope="col">Team</th><th scope="col">Points</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`);
  });

  app.get('/public/v1/:slug/schedule', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
      return reply.code(404).send({ error: 'Competition not found' });
    }
    const result = await pool.query(
      `SELECT m.id, m.match_number, m.arena_name, m.scheduled_start, m.effective_start,
              m.duration_seconds, m.state, m.countdown_started_at, count(mp.team_id)::int AS team_count,
              (SELECT count(*)::int FROM match_delays d WHERE d.match_id = m.id) AS delay_count,
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
    const events = await pool.query(
      `SELECT id, title, description, location, starts_at, duration_minutes
       FROM competition_events WHERE competition_id = $1 ORDER BY starts_at, title`,
      [competition.id]
    );
    const playoffs = await pool.query(
      `SELECT pm.id, pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start,
              pm.duration_seconds, pm.status, pm.bracket_side, pm.round_number, pm.schedule_state,
              ((pm.source_one <> 'bye')::int + (pm.source_two <> 'bye')::int +
               (pm.source_three <> 'bye')::int + (pm.source_four <> 'bye')::int) AS entrant_count,
              jsonb_build_array(
                jsonb_build_object('position',1,'spot',0,'teamCode',t1.code,'teamName',t1.name),
                jsonb_build_object('position',2,'spot',1,'teamCode',t2.code,'teamName',t2.name),
                jsonb_build_object('position',3,'spot',2,'teamCode',t3.code,'teamName',t3.name),
                jsonb_build_object('position',4,'spot',3,'teamCode',t4.code,'teamName',t4.name)
              ) AS positions
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
       ORDER BY pm.effective_start, pm.match_number`,
      [competition.id]
    );
    const matchItems = result.rows.map((match) => ({
      ...match,
      type: 'match' as const,
      underfilled: Number(match.team_count) < 4,
      warning: Number(match.team_count) < 4 ? `UNDERFILLED (${match.team_count}/4)` : null,
      positions: match.positions.map((position: { teamCode: string | null }) => ({
        ...position,
        vacant: position.teamCode === null
      }))
    }));
    const eventItems = events.rows.map((event) => ({ ...event, type: 'event' as const }));
    const playoffItems = playoffs.rows.map((match) => ({
      ...match,
      type: 'playoff' as const,
      state: match.schedule_state === 'complete' ? 'complete' : match.status,
      team_count: (match.positions as { teamCode: string | null }[]).filter((position) => position.teamCode).length,
      entrant_count: Number(match.entrant_count),
      underfilled: Number(match.entrant_count) < 4,
      warning: Number(match.entrant_count) < 4 ? `${match.entrant_count}/4 TEAM HEAT` : null
    }));
    reply.header('cache-control', 'public, max-age=2');
    return {
      competition: competition.name,
      updatedAt: new Date().toISOString(),
      matches: [...matchItems, ...playoffItems],
      events: eventItems,
      items: [...matchItems, ...playoffItems, ...eventItems].sort((a, b) => {
        const aStart = new Date('effective_start' in a ? a.effective_start : a.starts_at).getTime();
        const bStart = new Date('effective_start' in b ? b.effective_start : b.starts_at).getTime();
        return aStart - bStart || Number(a.match_number ?? 0) - Number(b.match_number ?? 0);
      })
    };
  });

  app.get('/public/v1/:slug/arena/:matchId', async (request, reply) => {
    const { slug, matchId } = z.object({ slug: z.string(), matchId: z.string().uuid() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
      return reply.code(404).send({ error: 'Competition not found' });
    }
    const result = await pool.query(
      `SELECT m.id, m.match_number, m.arena_name, m.state, m.scheduled_start, m.effective_start,
              count(mp.team_id)::int AS team_count,
              jsonb_agg(jsonb_build_object(
                'position', mp.position_number, 'spot', mp.position_number - 1,
                'label', mp.position_label, 'colour', mp.colour,
                'teamCode', t.code, 'teamName', t.name,
                'vacant', (mp.team_id IS NULL)
              ) ORDER BY mp.position_number) AS positions
       FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1 AND m.id = $2
       GROUP BY m.id`,
      [competition.id, matchId]
    );
    const match = result.rows[0];
    if (!match) return reply.code(404).send({ error: 'Match not found' });
    const count = Number(match.team_count);
    reply.header('cache-control', 'public, max-age=2');
    return { ...match, underfilled: count < 4, warning: count < 4 ? `UNDERFILLED (${count}/4)` : null };
  });

  app.get('/public/v1/:slug/timer', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
      return reply.code(404).send({ error: 'Competition not found' });
    }
    const result = await pool.query(
      `WITH timer_matches AS (
         SELECT m.id, m.match_number, m.arena_name, m.state, m.effective_start,
                m.actual_start, m.actual_end, m.countdown_started_at, m.duration_seconds, m.paused_at, m.paused_seconds,
                CASE
                  WHEN m.state = 'running' THEN greatest(
                    m.duration_seconds - floor(extract(epoch FROM (now() - m.actual_start)))::int + m.paused_seconds, 0
                  )
                  WHEN m.state = 'paused' THEN greatest(
                    m.duration_seconds - floor(extract(epoch FROM (m.paused_at - m.actual_start)))::int + m.paused_seconds, 0
                  )
                  WHEN m.countdown_started_at IS NOT NULL THEN greatest(
                    ceil(extract(epoch FROM (m.countdown_started_at + ($2 * interval '1 second') - now())))::int, 0
                  )
                  WHEN m.state IN ('scheduled', 'ready', 'delayed') THEN greatest(
                    floor(extract(epoch FROM (m.effective_start - now())))::int, 0
                  )
                  ELSE 0
                END AS seconds_remaining,
                count(mp.team_id)::int AS team_count,
                jsonb_agg(jsonb_build_object(
                  'position', mp.position_number, 'spot', mp.position_number - 1,
                  'label', mp.position_label, 'colour', mp.colour,
                  'teamCode', t.code, 'teamName', t.name, 'vacant', mp.team_id IS NULL
                ) ORDER BY mp.position_number) AS positions
         FROM matches m
         LEFT JOIN match_positions mp ON mp.match_id = m.id
         LEFT JOIN teams t ON t.id = mp.team_id
         WHERE m.competition_id = $1
           AND (m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
                OR (m.state IN ('awaiting_score', 'complete')
                    AND m.actual_end >= now() - make_interval(secs => $3::int)))
         GROUP BY m.id
         UNION ALL
         SELECT pm.id, pm.match_number, pm.arena_name,
                CASE WHEN pm.schedule_state = 'complete' THEN 'complete'
                     WHEN pm.timer_state = 'awaiting_score' THEN 'awaiting_score'
                     WHEN pm.timer_state IN ('running', 'paused') THEN pm.timer_state
                     ELSE pm.status END AS state,
                pm.effective_start, pm.actual_start, pm.actual_end, pm.countdown_started_at,
                pm.duration_seconds, pm.paused_at, pm.paused_seconds,
                CASE
                  WHEN pm.timer_state = 'running' THEN greatest(
                    pm.duration_seconds - floor(extract(epoch FROM (now() - pm.actual_start)))::int + pm.paused_seconds, 0
                  )
                  WHEN pm.timer_state = 'paused' THEN greatest(
                    pm.duration_seconds - floor(extract(epoch FROM (pm.paused_at - pm.actual_start)))::int + pm.paused_seconds, 0
                  )
                  WHEN pm.countdown_started_at IS NOT NULL THEN greatest(
                    ceil(extract(epoch FROM (pm.countdown_started_at + ($2 * interval '1 second') - now())))::int, 0
                  )
                  WHEN pm.timer_state = 'scheduled' THEN greatest(
                    floor(extract(epoch FROM (pm.effective_start - now())))::int, 0
                  )
                  ELSE 0
                END AS seconds_remaining,
                (pm.team_one_id IS NOT NULL)::int + (pm.team_two_id IS NOT NULL)::int +
                  (pm.team_three_id IS NOT NULL)::int + (pm.team_four_id IS NOT NULL)::int AS team_count,
                jsonb_build_array(
                  jsonb_build_object('position',1,'spot',0,'label','Position 0','colour',coalesce(settings.corner_colours ->> 0,'#d1495b'),'teamCode',t1.code,'teamName',t1.name,'vacant',pm.team_one_id IS NULL),
                  jsonb_build_object('position',2,'spot',1,'label','Position 1','colour',coalesce(settings.corner_colours ->> 1,'#00798c'),'teamCode',t2.code,'teamName',t2.name,'vacant',pm.team_two_id IS NULL),
                  jsonb_build_object('position',3,'spot',2,'label','Position 2','colour',coalesce(settings.corner_colours ->> 2,'#edae49'),'teamCode',t3.code,'teamName',t3.name,'vacant',pm.team_three_id IS NULL),
                  jsonb_build_object('position',4,'spot',3,'label','Position 3','colour',coalesce(settings.corner_colours ->> 3,'#30638e'),'teamCode',t4.code,'teamName',t4.name,'vacant',pm.team_four_id IS NULL)
                ) AS positions
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         LEFT JOIN competition_settings settings ON settings.competition_id = pb.competition_id
         LEFT JOIN teams t1 ON t1.id = pm.team_one_id
         LEFT JOIN teams t2 ON t2.id = pm.team_two_id
         LEFT JOIN teams t3 ON t3.id = pm.team_three_id
         LEFT JOIN teams t4 ON t4.id = pm.team_four_id
         WHERE pb.competition_id = $1 AND pb.status = 'active'
           AND (pm.schedule_state = 'scheduled'
                OR (pm.actual_end >= now() - make_interval(secs => $3::int)
                    AND (pm.schedule_state = 'complete' OR pm.timer_state = 'awaiting_score')))
       )
       SELECT * FROM timer_matches
       ORDER BY CASE WHEN countdown_started_at IS NOT NULL AND state IN ('scheduled', 'ready', 'delayed') THEN 0
                     WHEN state = 'running' THEN 1
                     WHEN state = 'paused' THEN 2
                     WHEN state IN ('awaiting_score', 'complete') THEN 3 ELSE 4 END,
                CASE WHEN state IN ('awaiting_score', 'complete') THEN -extract(epoch FROM actual_end)
                     ELSE extract(epoch FROM coalesce(countdown_started_at, actual_start, effective_start)) END,
                match_number LIMIT 1`,
      [competition.id, MATCH_COUNTDOWN_TOTAL_SECONDS, JUST_FINISHED_SECONDS]
    );
    reply.header('cache-control', 'no-store');
    const timer = result.rows[0];
    return {
      competition: competition.name,
      updatedAt: new Date().toISOString(),
      timer: timer ? {
        ...timer,
        underfilled: Number(timer.team_count) < 4,
        warning: Number(timer.team_count) < 4 ? `UNDERFILLED (${timer.team_count}/4)` : null
      } : null
    };
  });

}
