import { type FastifyInstance } from 'fastify';
import { countdownStartTime } from '../domain/display.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { renderBracketDiagram } from '../domain/bracket-diagram.js';
import { buildPlayoffPlan, buildPlayoffSeedRanks, findDecisivePlayoffTies, playoffDependencies, playoffFormats, playoffSeedSnapshotMatchesRanks, playoffStages, rankPlayoffScores, summarisePlayoffLosses, validateTieBreakOrder } from '../domain/playoffs.js';
import { calculateDelayReduction, planPlayoffHeatTimes } from '../domain/scheduler.js';
import { escapeHtml } from '../lib/html.js';
import { findCompetition } from '../services/competitions.js';
import { earlierUnplayedHeat, playoffHeatHasActiveConflict } from '../services/conflicts.js';
import { type PlayoffSeedStanding, fetchPlayoffSeedSnapshot } from '../services/league.js';
import { heatForDiagram, lockUpcomingPlayoffHeat, persistPlayoffAdvancements, refreshUnstartedPlayoffSeeds } from '../services/playoffs.js';
import { reflowSchedule } from '../services/reflow.js';

export function registerPlayoffRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions/:slug/playoffs', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    reply.header('cache-control', 'no-store');
    const bracket = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      await refreshUnstartedPlayoffSeeds(client, competition.id, adminEmail(request));
      return client.query(
        `SELECT id, field_size, seed_ranks, seed_standings_snapshot,
                seed_match_number, seed_snapshot_at, seed_frozen_at, status, created_at,
                format, final_size, final_byes
         FROM playoff_brackets WHERE competition_id = $1 AND status <> 'replaced'
         ORDER BY created_at DESC LIMIT 1`,
        [competition.id]
      );
    });
    if (!bracket.rows[0]) return { bracket: null, matches: [], teams: [] };
    const matches = await pool.query(
      `SELECT pm.id, pm.match_number, pm.bracket_side, pm.round_number, pm.status, pm.tied,
              pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id,
              ARRAY[pm.source_one, pm.source_two, pm.source_three, pm.source_four] AS sources,
              pm.advancing_places, pm.planned_gap_seconds, pm.tie_break,
              greatest(0, ceil(extract(epoch FROM (pm.effective_start - pm.scheduled_start))))::int AS delay_seconds,
              pm.scheduled_start, pm.effective_start, pm.arena_name, pm.duration_seconds,
              pm.schedule_state, pm.timer_state, pm.countdown_started_at, pm.placements,
              one_team.code AS team_one_code, one_team.name AS team_one_name,
              two_team.code AS team_two_code, two_team.name AS team_two_name,
              three_team.code AS team_three_code, three_team.name AS team_three_name,
              four_team.code AS team_four_code, four_team.name AS team_four_name,
              (SELECT jsonb_agg(jsonb_build_object(
                'teamCode', t.code, 'teamName', t.name, 'points', pms.points,
                'seed', (pb.seed_ranks ->> t.id::text)::integer
              ) ORDER BY (SELECT p.idx FROM jsonb_array_elements_text(coalesce(pm.placements, '[]'::jsonb)) WITH ORDINALITY AS p(team_id, idx) WHERE p.team_id = t.id::text) NULLS LAST, pms.points DESC, (pb.seed_ranks ->> t.id::text)::integer)
               FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
               WHERE pms.playoff_match_id = pm.id) AS scores
       FROM playoff_matches pm
       LEFT JOIN teams one_team ON one_team.id = pm.team_one_id
       LEFT JOIN teams two_team ON two_team.id = pm.team_two_id
       LEFT JOIN teams three_team ON three_team.id = pm.team_three_id
       LEFT JOIN teams four_team ON four_team.id = pm.team_four_id
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pm.bracket_id = $1 ORDER BY pm.match_number`,
      [bracket.rows[0].id]
    );
    const seedRanks = bracket.rows[0].seed_ranks as Record<string, number>;
    const participants = await pool.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM teams WHERE id = ANY($1::uuid[])',
      [Object.entries(seedRanks)
        .filter(([, rank]) => Number(rank) <= Number(bracket.rows[0].field_size))
        .map(([teamId]) => teamId)]
    );
    const structure = await pool.query<{
      id: string; bracket_side: 'upper' | 'lower' | 'final'; placements: string[] | null;
      advancing_places: number | null; status: string; sources: string[];
    }>(
      `SELECT id, bracket_side, placements, advancing_places, status,
              ARRAY[source_one, source_two, source_three, source_four] AS sources
       FROM playoff_matches WHERE bracket_id = $1 ORDER BY match_number`,
      [bracket.rows[0].id]
    );
    const record = summarisePlayoffLosses(structure.rows.map((match) => ({
      key: match.id,
      side: match.bracket_side,
      sources: match.sources,
      placements: match.status === 'complete' ? match.placements : null,
      advancing: match.advancing_places
    })));
    const stages = playoffStages(structure.rows.map((match) => ({ key: match.id, sources: match.sources })));
    const teams = participants.rows.map((team) => ({
      ...team,
      seed: seedRanks[team.id],
      losses: record.get(team.id)?.losses ?? 0,
      eliminated: record.get(team.id)?.eliminated ?? false
    })).sort((one, two) => Number(one.seed) - Number(two.seed));
    const diagram = renderBracketDiagram(matches.rows.map((match) => heatForDiagram(match, competition.timezone)), {
      format: bracket.rows[0].format,
      eliminated: teams.filter((team) => team.eliminated).map((team) => team.code)
    });
    return {
      bracket: bracket.rows[0],
      teams,
      diagram,
      matches: matches.rows.map((match) => ({ ...match, stage: stages.get(match.id) ?? 1 }))
    };
  });


  app.get('/api/admin/playoff-formats/preview', { preHandler: requireAdmin }, async (request, reply) => {
    const query = z.object({
      fieldSize: z.coerce.number().int().min(2).max(256),
      format: z.enum(playoffFormats).default('double-elimination'),
      finalSize: z.coerce.number().int().min(2).max(4).default(4),
      finalByes: z.coerce.number().int().min(0).max(3).default(0)
    }).parse(request.query);
    try {
      const plan = buildPlayoffPlan(query.fieldSize, query);
      const stages = playoffStages(plan);
      const number = new Map(plan.map((match, index) => [match.key, index + 1]));
      return {
        heats: plan.map((match) => ({
          number: number.get(match.key),
          side: match.side,
          round: match.round,
          stage: stages.get(match.key),
          advancing: match.side === 'final' ? null : match.advancing,
          sources: match.sources.filter((source) => source !== 'bye').map((source) =>
            source.replace(/^place:(\d):(.+)$/, (_whole, place: string, key: string) => `place:${place}:${number.get(key)}`))
        })),
        stages: Math.max(...stages.values()),
        diagram: renderBracketDiagram(plan.map((match, index) => ({
          id: match.key, number: index + 1, side: match.side, sources: [...match.sources],
          advancing: match.side === 'final' ? null : match.advancing
        })), { format: query.format })
      };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/admin/competitions/:slug/playoffs/seed-check', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    reply.header('cache-control', 'no-store');
    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      await refreshUnstartedPlayoffSeeds(client, competition.id, adminEmail(request));
      return client.query<{
        field_size: number;
        seed_ranks: Record<string, number>;
        seed_standings_snapshot: PlayoffSeedStanding[] | null;
        seed_match_number: number | null;
        seed_snapshot_at: Date | null;
        seed_frozen_at: Date | null;
        status: string;
      }>(
        `SELECT field_size, seed_ranks, seed_standings_snapshot,
                seed_match_number, seed_snapshot_at, seed_frozen_at, status
         FROM playoff_brackets WHERE competition_id = $1 AND status <> 'replaced'
         ORDER BY created_at DESC LIMIT 1`,
        [competition.id]
      );
    });
    const bracket = result.rows[0];
    if (!bracket) {
      return reply.code(404).type('text/plain; charset=utf-8')
        .send('No active playoff bracket has a seeding snapshot yet.');
    }

    const snapshot = bracket.seed_standings_snapshot;
    const hasSnapshot = Array.isArray(snapshot) && bracket.seed_snapshot_at !== null &&
      bracket.seed_match_number !== null;
    const integrityOk = hasSnapshot && playoffSeedSnapshotMatchesRanks(
      snapshot, Number(bracket.field_size), bracket.seed_ranks
    );
    const seedRankByTeam = new Map(
      Object.entries(bracket.seed_ranks).map(([teamId, rank]) => [teamId, Number(rank)])
    );
    const legacyTeams = hasSnapshot ? [] : (await pool.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM teams WHERE id = ANY($1::uuid[])',
      [Object.keys(bracket.seed_ranks)]
    )).rows;
    const legacyRows = legacyTeams
      .sort((left, right) => seedRankByTeam.get(left.id)! - seedRankByTeam.get(right.id)!)
      .map((team) => `<tr class="entrant"><td>Not recorded</td>
        <th scope="row">${escapeHtml(team.code)} · ${escapeHtml(team.name)}</th>
        <td>Not recorded</td><td>Not recorded</td><td>Not recorded</td><td>Not recorded</td>
        <td>Seed ${escapeHtml(seedRankByTeam.get(team.id))}</td></tr>`).join('');
    const standingsRows = (snapshot ?? []).map((team, index) => {
      const seed = seedRankByTeam.get(team.id);
      return `<tr${seed !== undefined ? ' class="entrant"' : ''}>
        <td>${index + 1}</td><th scope="row">${escapeHtml(team.code)} · ${escapeHtml(team.name)}</th>
        <td>${escapeHtml(team.matchPoints)}</td><td>${escapeHtml(team.challengePoints)}</td>
        <td><strong>${escapeHtml(team.leaguePoints)}</strong></td><td>${escapeHtml(team.scoredMatches)}</td>
        <td>${seed === undefined ? '—' : `Seed ${escapeHtml(seed)}`}${team.tiedWith?.length ? `<br><strong style="color:#a44b12">Level with ${escapeHtml(team.tiedWith.join(', '))} — judge to decide</strong>` : ''}</td></tr>`;
    }).join('') || legacyRows;
    const sourceDescription = !hasSnapshot
      ? 'This bracket predates stored standings snapshots. Its saved seed order is preserved, but the original points and match-number cutoff were not recorded; they cannot be verified retroactively.'
      : bracket.seed_match_number === 0
        ? 'No scored league matches were included. The snapshot includes the standings available at capture time, including challenge points.'
        : `The highest-numbered scored league match included was #${escapeHtml(bracket.seed_match_number)}. The timestamp and full standings below are the authoritative snapshot; corrections to earlier matches are reflected in that saved data.`;
    const integrityMessage = !hasSnapshot
      ? 'UNVERIFIABLE — historical source data is not available for this legacy bracket.'
      : integrityOk
        ? `PASS — the saved seed ranks match the top ${escapeHtml(bracket.field_size)} teams in this exact stored standings snapshot.`
        : 'FAIL — the saved seed ranks do not match this snapshot. Do not rely on this bracket until an administrator investigates.';
    reply.type('text/html; charset=utf-8');
    return reply.send(`<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Playoff seeding sanity check · ${escapeHtml(competition.name)}</title>
  <style>
  body{margin:0;padding:1rem;font:16px/1.5 system-ui,sans-serif;color:#17242b;background:#f4f6f5}
  main{max-width:1100px;margin:auto}.card{background:white;border:1px solid #ccd5d3;border-radius:.7rem;padding:1rem;margin:1rem 0}
  h1{font-size:1.5rem}.status{padding:.8rem 1rem;border-radius:.4rem;background:${integrityOk ? '#e4f5ed' : '#ffe5e2'};font-weight:700}
  .muted{color:#506168}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #dce3e1}
  thead{background:#edf1ef}.entrant{background:#eff9f3}
  @media(max-width:700px){.table-wrap{overflow-x:auto}table{min-width:760px}}
  </style></head><body><main>
  <p><a href="/">← Back to admin</a></p>
  <h1>Playoff seeding sanity check</h1>
  <div class="card"><p class="status">${integrityMessage}</p>
  <p>${sourceDescription}</p>
  <p><strong>Snapshot captured:</strong> ${bracket.seed_snapshot_at ? escapeHtml(new Date(bracket.seed_snapshot_at).toLocaleString()) : 'Not recorded'}</p>
  <p><strong>Seeding:</strong> ${bracket.seed_frozen_at
      ? `Frozen at first playoff countdown (${escapeHtml(new Date(bracket.seed_frozen_at).toLocaleString())})`
      : 'Live-updating until the first playoff countdown'}
   · <strong>Bracket:</strong> ${escapeHtml(bracket.status)}</p>
  <p class="muted">Match points and challenge points are shown separately. The bold league total determines standings order. Level teams are separated by match points, then head-to-head points in league matches where they met, then best single match; any still level are flagged for the judge.</p></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>League rank</th><th>Team</th>
  <th>Match points</th><th>Challenge points</th><th>Total points</th><th>Scored matches</th>
  <th>Playoff seed</th></tr></thead><tbody>${standingsRows || '<tr><td colspan="7">No snapshot standings were recorded.</td></tr>'}</tbody></table></div></div>
  <p class="muted">This report reads the persisted snapshot used by the bracket; it is not a recalculated live league table.</p>
  </main></body></html>`);
  });

  app.post('/api/admin/competitions/:slug/playoffs', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      fieldSize: z.number().int().min(2),
      format: z.enum(playoffFormats).default('double-elimination'),
      finalSize: z.number().int().min(2).max(4).default(4),
      finalByes: z.number().int().min(0).max(3).default(0),
      replaceExisting: z.boolean().default(false),
      scheduledStart: z.string().datetime({ offset: true }).optional(),
      intervalMinutes: z.number().int().min(1).max(1440).optional(),
      finalDelayMinutes: z.number().int().min(0).max(1440).default(0),
      arenaName: z.string().trim().min(1).max(80).default('Arena 1'),
      arenaNames: z.array(z.string().trim().min(1).max(80)).min(1).max(8).optional()
    }).parse(request.body);
    const arenaNames = [...new Set(body.arenaNames ?? [body.arenaName])];
    let plan: ReturnType<typeof buildPlayoffPlan>;
    try {
      plan = buildPlayoffPlan(body.fieldSize, {
        format: body.format, finalSize: body.finalSize, finalByes: body.finalByes
      });
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM playoff_brackets WHERE competition_id = $1 AND status <> 'replaced'`,
        [competition.id]
      );
      if (existing.rowCount && !body.replaceExisting) {
        return { status: 409, error: 'A bracket already exists; confirm replacement before generating another' };
      }
      const seedSnapshot = await fetchPlayoffSeedSnapshot(client, competition.id);
      const standings = seedSnapshot.standings;
      if (standings.length < body.fieldSize) {
        return { status: 400, error: `At least ${body.fieldSize} teams with standings are required` };
      }
      const selectedTeams = standings.slice(0, body.fieldSize);
      const { seedRanks, seedTeams } = buildPlayoffSeedRanks(
        selectedTeams.map((team) => team.id), body.fieldSize
      );
      const scheduleEnd = await client.query<{ last_match_end: Date | null }>(
        `SELECT max(match_end) AS last_match_end FROM (
           SELECT effective_start + make_interval(secs => duration_seconds) AS match_end
           FROM matches WHERE competition_id = $1 AND state <> 'cancelled'
           UNION ALL
           SELECT pm.effective_start + make_interval(secs => pm.duration_seconds) AS match_end
           FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1 AND pb.status = 'active' AND NOT (pb.id = ANY($2::uuid[]))
         ) scheduled`,
        [competition.id, existing.rows.map((bracket) => bracket.id)]
      );
      const latestMatchEnd = scheduleEnd.rows[0]?.last_match_end;
      const earliestStart = new Date(Date.now() + 60_000);
      earliestStart.setSeconds(0, 0);
      const scheduleEndStart = latestMatchEnd
        ? new Date(Math.ceil(new Date(latestMatchEnd).getTime() / 60_000) * 60_000)
        : earliestStart;
      const firstStart = body.scheduledStart
        ? new Date(body.scheduledStart)
        : new Date(Math.max(earliestStart.getTime(), scheduleEndStart.getTime()));
      const intervalMinutes = body.intervalMinutes ??
        Math.max(1, Math.ceil(Number(competition.match_duration_seconds) / 60));
      if (intervalMinutes * 60 < Number(competition.match_duration_seconds)) {
        return { status: 400, error: 'Minutes between heats must be at least the match duration' };
      }
      if (body.scheduledStart && latestMatchEnd &&
          firstStart.getTime() < new Date(latestMatchEnd).getTime()) {
        return {
          status: 409,
          error: `Playoff heats must start after the current schedule ends at ${new Date(latestMatchEnd).toISOString()}`
        };
      }
      if (existing.rowCount) {
        await client.query(
          `UPDATE playoff_brackets SET status = 'replaced'
           WHERE competition_id = $1 AND status <> 'replaced'`,
          [competition.id]
        );
      }
      const bracketId = randomUUID();
      await client.query(
        `INSERT INTO playoff_brackets
           (id, competition_id, field_size, seed_ranks, seed_standings_snapshot,
            seed_match_number, seed_snapshot_at, format, final_size, final_byes)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          bracketId, competition.id, body.fieldSize, JSON.stringify(seedRanks),
          JSON.stringify(standings), seedSnapshot.latestScoredMatchNumber, seedSnapshot.capturedAt,
          body.format, body.finalSize, body.finalByes
        ]
      );
      const ids = new Map(plan.map((match) => [match.key, randomUUID()]));
      const numberResult = await client.query<{ match_number: number }>(
        'SELECT coalesce(max(match_number), 0)::int AS match_number FROM matches WHERE competition_id = $1',
        [competition.id]
      );
      const firstMatchNumber = numberResult.rows[0]!.match_number + 1;
      const durationSeconds = Number(competition.match_duration_seconds);
      const dependencies = playoffDependencies(plan);
      const timings = new Map(planPlayoffHeatTimes(
        plan.map((match) => ({
          key: match.key, dependsOn: dependencies.get(match.key) ?? [], isFinal: match.side === 'final'
        })),
        arenaNames, firstStart.getTime(), intervalMinutes * 60, durationSeconds, body.finalDelayMinutes * 60
      ).map((timing) => [timing.key, timing]));
      for (const [index, match] of plan.entries()) {
        const id = ids.get(match.key)!;
        const timing = timings.get(match.key)!;
        const source = (value: string) => value.startsWith('seed:')
          ? value
          : value.replace(/:(playoff-\d+)$/, (_whole, key: string) => `:${ids.get(key)!}`);
        const initialTeam = (value: string) => value.startsWith('seed:')
          ? selectedTeams[Number(value.slice('seed:'.length)) - 1]?.id ?? null
          : null;
        await client.query(
          `INSERT INTO playoff_matches
           (id, bracket_id, match_number, bracket_side, round_number,
            source_one, source_two, source_three, source_four,
            team_one_id, team_two_id, team_three_id, team_four_id,
            scheduled_start, effective_start, arena_name, duration_seconds, planned_gap_seconds,
            advancing_places)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15, $16, $17, $18)`,
          [id, bracketId, firstMatchNumber + index, match.side, match.round,
            ...match.sources.map(source), ...match.sources.map(initialTeam),
            new Date(timing.start), timing.arenaName, durationSeconds, timing.plannedGapSeconds,
            match.side === 'final' ? null : match.advancing]
        );
      }
      await persistPlayoffAdvancements(client, bracketId, seedTeams);
      const shiftedMatchIds = await reflowSchedule(
        client, competition.id, adminEmail(request), 'playoff heats scheduled'
      );
      // Moves made while first placing the bracket are part of its plan, not delays.
      await client.query('UPDATE playoff_matches SET scheduled_start = effective_start WHERE bracket_id = $1', [bracketId]);
      await audit(client, adminEmail(request), 'playoffs.generated', 'playoff_bracket', bracketId, {
        fieldSize: body.fieldSize,
        format: body.format,
        finalSize: body.finalSize,
        finalByes: body.finalByes,
        seededTeams: selectedTeams.map((team) => team.code),
        replacedPreviousBrackets: Boolean(existing.rowCount),
        scheduledStart: firstStart.toISOString(),
        intervalMinutes,
        finalDelayMinutes: body.finalDelayMinutes,
        arenaNames,
        shiftedMatchIds
      });
      return { status: 201, bracketId, matchCount: plan.length, teamCount: selectedTeams.length, shiftedMatchIds };
    });
    return reply.code(result.status).send(result);
  });

  app.patch('/api/admin/playoff-matches/:matchId/schedule', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      arenaName: z.string().trim().min(1).max(80),
      scheduledStart: z.string().datetime({ offset: true }),
      plannedGapMinutes: z.number().int().min(0).max(1440).optional()
    }).parse(request.body);
    const requestedStart = new Date(body.scheduledStart);
    if (requestedStart.getTime() <= Date.now()) {
      return reply.code(400).send({ error: 'A playoff heat must be scheduled in the future' });
    }
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        `SELECT competition_id FROM playoff_brackets pb
         JOIN playoff_matches pm ON pm.bracket_id = pb.id WHERE pm.id = $1`,
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404 as const, error: 'Playoff heat not found' };
      const competitionId = initial.rows[0].competition_id;
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
      const matchResult = await client.query<{
        bracket_id: string; match_number: number; duration_seconds: number;
        planned_gap_seconds: number; status: string; schedule_state: string; arena_name: string;
        timer_state: string; countdown_started_at: Date | null;
      }>(
        `SELECT pm.bracket_id, pm.match_number, pm.duration_seconds, pm.planned_gap_seconds, pm.status,
                pm.schedule_state, pm.arena_name, pm.timer_state, pm.countdown_started_at
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
        [matchId]
      );
      const match = matchResult.rows[0];
      if (!match) return { status: 409 as const, error: 'This playoff bracket is no longer active' };
      if (match.status === 'complete' || match.schedule_state === 'complete') {
        return { status: 409 as const, error: 'A completed playoff heat cannot be rescheduled' };
      }
      if (match.timer_state !== 'scheduled' || match.countdown_started_at) {
        return { status: 409 as const, error: 'A started playoff heat cannot be rescheduled' };
      }
      const scores = await client.query(
        'SELECT 1 FROM playoff_match_scores WHERE playoff_match_id = $1 LIMIT 1',
        [matchId]
      );
      if (scores.rowCount) {
        return { status: 409 as const, error: 'A playoff heat with saved scores cannot be rescheduled' };
      }
      const plannedGapSeconds = body.plannedGapMinutes === undefined
        ? match.planned_gap_seconds
        : body.plannedGapMinutes * 60;
      await client.query(
        `UPDATE playoff_matches SET scheduled_start = $2, effective_start = $2, arena_name = $3,
           planned_gap_seconds = $4
         WHERE id = $1`,
        [matchId, requestedStart, body.arenaName, plannedGapSeconds]
      );
      // The heat itself moves later if its feeder heats or arena need it to; later heats follow.
      const rescheduledIds = new Set(await reflowSchedule(
        client, competitionId, adminEmail(request), `playoff heat #${match.match_number} rescheduled`
      ));
      const finalStartResult = await client.query<{ effective_start: Date }>(
        'UPDATE playoff_matches SET scheduled_start = effective_start WHERE id = $1 RETURNING effective_start',
        [matchId]
      );
      rescheduledIds.delete(matchId);
      const finalStart = new Date(finalStartResult.rows[0]!.effective_start);
      await audit(client, adminEmail(request), 'playoff_match.schedule_updated', 'playoff_match', matchId, {
        matchNumber: match.match_number,
        arenaName: body.arenaName,
        scheduledStart: finalStart.toISOString(),
        plannedGapSeconds,
        shiftedMatchIds: [...rescheduledIds]
      });
      return {
        status: 200 as const, ok: true, scheduledStart: finalStart.toISOString(),
        shiftedMatchIds: [...rescheduledIds]
      };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/playoff-matches/:matchId/control/:action', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId, action } = z.object({
      matchId: z.string().uuid(),
      action: z.enum(['start', 'cancel-countdown', 'pause', 'resume', 'finish', 'reset-timer'])
    }).parse(request.params);
    const result = await transaction(async (client) => {
      const initial = await client.query<{ competition_id: string }>(
        `SELECT pb.competition_id FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id WHERE pm.id = $1`,
        [matchId]
      );
      if (!initial.rows[0]) return { status: 404 as const, error: 'Playoff heat not found' };
      const competitionId = initial.rows[0].competition_id;
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
      if (action === 'start') {
        await refreshUnstartedPlayoffSeeds(client, competitionId, adminEmail(request));
      }
      const heatResult = await client.query<{
        bracket_id: string; match_number: number; arena_name: string; status: string;
        schedule_state: string; timer_state: string; team_ids: (string | null)[];
        countdown_started_at: Date | null; paused_at: Date | null;
      }>(
        `SELECT pm.bracket_id, pm.match_number, pm.arena_name, pm.status, pm.schedule_state,
                pm.timer_state,
                ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids,
                pm.countdown_started_at, pm.paused_at
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
        [matchId]
      );
      const heat = heatResult.rows[0];
      if (!heat) return { status: 409 as const, error: 'This playoff bracket is no longer active' };
      if (heat.schedule_state === 'complete' || heat.status === 'complete') {
        return { status: 409 as const, error: 'A completed playoff heat cannot be started' };
      }

      if (action === 'start') {
        if (heat.status !== 'ready' || heat.timer_state !== 'scheduled') {
          return { status: 409 as const, error: 'This heat is already started or waiting for prior results' };
        }
        const teamIds = heat.team_ids.filter((teamId): teamId is string => teamId !== null);
        if (teamIds.length < 2) {
          return { status: 409 as const, error: 'At least two assigned teams are required to start this heat' };
        }
        if (await playoffHeatHasActiveConflict(client, competitionId, matchId, teamIds, heat.arena_name)) {
          return { status: 409 as const, error: 'A team or the arena is already active in another match' };
        }
        const earlier = await earlierUnplayedHeat(client, matchId);
        if (earlier !== null) {
          return { status: 409 as const, error: `Heat #${earlier} in ${heat.arena_name} comes first. Play it (or delay it past this heat) before starting this one.` };
        }
        const now = new Date(countdownStartTime(Date.now()));
        await client.query(
          `UPDATE playoff_matches SET countdown_restore_start = effective_start,
             countdown_started_at = $2, effective_start = $2
           WHERE id = $1`,
          [matchId, now]
        );
        await client.query(
          'UPDATE playoff_brackets SET seed_frozen_at = coalesce(seed_frozen_at, $2) WHERE id = $1',
          [heat.bracket_id, now]
        );
        const shiftedMatchIds = await reflowSchedule(
          client, competitionId, adminEmail(request), `playoff heat #${heat.match_number} started`
        );
        await audit(client, adminEmail(request), 'playoff_match.countdown_started', 'playoff_match', matchId, {
          matchNumber: heat.match_number, countdownStartedAt: now.toISOString(), shiftedMatchIds
        });
        return { status: 200 as const, ok: true, shiftedMatchIds };
      }

      if (action === 'cancel-countdown') {
        if (!heat.countdown_started_at || heat.timer_state !== 'scheduled') {
          return { status: 409 as const, error: 'There is no active countdown to cancel' };
        }
        // Return to the slot the heat held before "Start now"; later heats already moved stay put.
        await client.query(
          `UPDATE playoff_matches SET countdown_started_at = NULL,
             effective_start = coalesce(countdown_restore_start, scheduled_start),
             countdown_restore_start = NULL
           WHERE id = $1`,
          [matchId]
        );
        await audit(client, adminEmail(request), 'playoff_match.countdown_cancelled', 'playoff_match', matchId);
      } else if (action === 'pause') {
        if (heat.timer_state !== 'running') return { status: 409 as const, error: 'Only a running heat can be paused' };
        await client.query(
          `UPDATE playoff_matches SET timer_state = 'paused', paused_at = now() WHERE id = $1`,
          [matchId]
        );
        await audit(client, adminEmail(request), 'playoff_match.paused', 'playoff_match', matchId);
      } else if (action === 'resume') {
        if (heat.timer_state !== 'paused' || !heat.paused_at) return { status: 409 as const, error: 'This heat is not paused' };
        await client.query(
          `UPDATE playoff_matches SET timer_state = 'running',
             paused_seconds = paused_seconds + greatest(floor(extract(epoch FROM (now() - paused_at)))::int, 0),
             paused_at = NULL WHERE id = $1`,
          [matchId]
        );
        await audit(client, adminEmail(request), 'playoff_match.resumed', 'playoff_match', matchId);
      } else if (action === 'finish') {
        if (!['running', 'paused'].includes(heat.timer_state)) {
          return { status: 409 as const, error: 'Only a running or paused heat can be finished' };
        }
        await client.query(
          `UPDATE playoff_matches SET timer_state = 'awaiting_score', actual_end = now(), paused_at = NULL
           WHERE id = $1`,
          [matchId]
        );
        await audit(client, adminEmail(request), 'playoff_match.finished', 'playoff_match', matchId);
      } else if (action === 'reset-timer') {
        if (!['running', 'paused', 'awaiting_score'].includes(heat.timer_state)) {
          return { status: 409 as const, error: `Cannot reset a ${heat.timer_state} playoff heat` };
        }
        const scores = await client.query(
          'SELECT 1 FROM playoff_match_scores WHERE playoff_match_id = $1 LIMIT 1',
          [matchId]
        );
        if (scores.rowCount) {
          return { status: 409 as const, error: 'A playoff heat with saved scores cannot be reset' };
        }
        const resetAt = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);
        await client.query(
          `UPDATE playoff_matches SET timer_state = 'scheduled', countdown_started_at = NULL,
             countdown_restore_start = NULL,
             actual_start = NULL, actual_end = NULL, paused_at = NULL, paused_seconds = 0,
             effective_start = $2 WHERE id = $1`,
          [matchId, resetAt]
        );
        const shiftedMatchIds = await reflowSchedule(
          client, competitionId, adminEmail(request), `playoff heat #${heat.match_number} timer reset`
        );
        await audit(client, adminEmail(request), 'playoff_match.timer_reset', 'playoff_match', matchId, {
          matchNumber: heat.match_number, resetAt: resetAt.toISOString(),
          shiftedMatchIds
        });
        return {
          status: 200 as const, ok: true, effectiveStart: resetAt.toISOString(),
          shiftedMatchIds
        };
      }
      return { status: 200 as const, ok: true };
    });
    return reply.code(result.status).send(result);
  });


  app.post('/api/admin/playoff-matches/:matchId/delay', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      delaySeconds: z.number().int().positive().max(86400),
      reason: z.string().trim().min(1).max(500)
    }).parse(request.body);
    const result = await transaction(async (client) => {
      const locked = await lockUpcomingPlayoffHeat(client, matchId);
      if ('error' in locked) return locked.error;
      const { competitionId, heat } = locked;
      const moved = await client.query<{ effective_start: Date }>(
        `UPDATE playoff_matches SET effective_start = effective_start + ($2 * interval '1 second')
         WHERE id = $1 RETURNING effective_start`,
        [matchId, body.delaySeconds]
      );
      const shiftedMatchIds = await reflowSchedule(
        client, competitionId, adminEmail(request), `playoff heat #${heat.match_number} delayed: ${body.reason}`
      );
      await audit(client, adminEmail(request), 'playoff_match.delayed', 'playoff_match', matchId, {
        ...body, matchNumber: heat.match_number,
        effectiveStart: new Date(moved.rows[0]!.effective_start).toISOString(), shiftedMatchIds
      });
      return { status: 200 as const, ok: true, shiftedMatchIds };
    });
    return reply.code(result.status).send(result);
  });

  app.post('/api/admin/playoff-matches/:matchId/undelay', { preHandler: requireAdmin }, async (request, reply) => {
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
      const locked = await lockUpcomingPlayoffHeat(client, matchId);
      if ('error' in locked) return locked.error;
      const { competitionId, heat } = locked;
      let reduction: ReturnType<typeof calculateDelayReduction>;
      try {
        reduction = calculateDelayReduction(
          new Date(heat.scheduled_start).getTime(), new Date(heat.effective_start).getTime(),
          body.delaySeconds, body.restoreScheduled
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { status: 409 as const, error: error.message };
      }
      const nextStart = new Date(reduction.effectiveStart);
      const feederIds = [...new Set(heat.sources
        .map((source) => /^place:[1-4]:(.+)$/.exec(source)?.[1])
        .filter((id): id is string => id !== undefined))];
      const feeder = await client.query<{ match_number: number }>(
        `SELECT match_number FROM playoff_matches
         WHERE id = ANY($1::uuid[])
           AND coalesce(actual_end, effective_start + make_interval(secs => duration_seconds))
               + make_interval(secs => $3::int) > $2
         ORDER BY match_number LIMIT 1`,
        [feederIds, nextStart, heat.planned_gap_seconds]
      );
      if (feeder.rows[0]) {
        return {
          status: 409 as const,
          error: `Cannot move heat #${heat.match_number} earlier; it must follow heat #${feeder.rows[0].match_number} by its planned gap`
        };
      }
      const arenaConflict = await client.query<{ match_number: number }>(
        `SELECT match_number FROM (
           SELECT m.match_number, coalesce(m.actual_start, m.effective_start) AS starts_at, m.duration_seconds
           FROM matches m WHERE m.competition_id = $1 AND m.arena_name = $2
             AND m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
           UNION ALL
           SELECT pm.match_number, coalesce(pm.actual_start, pm.effective_start), pm.duration_seconds
           FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1 AND pb.status = 'active' AND pm.arena_name = $2
             AND pm.id <> $3 AND pm.schedule_state = 'scheduled'
         ) arena_matches
         WHERE starts_at < $4::timestamptz + make_interval(secs => $5::int)
           AND starts_at + make_interval(secs => duration_seconds) > $4
         ORDER BY starts_at LIMIT 1`,
        [competitionId, heat.arena_name, matchId, nextStart, heat.duration_seconds]
      );
      if (arenaConflict.rows[0]) {
        return {
          status: 409 as const,
          error: `Cannot move heat #${heat.match_number} earlier; it would overlap match #${arenaConflict.rows[0].match_number} in ${heat.arena_name}`
        };
      }
      const eventConflict = await client.query<{ title: string }>(
        `SELECT title FROM competition_events
         WHERE competition_id = $1
           AND starts_at < $2::timestamptz + make_interval(secs => $3::int)
           AND starts_at + make_interval(mins => duration_minutes) > $2
         ORDER BY starts_at LIMIT 1`,
        [competitionId, nextStart, heat.duration_seconds]
      );
      if (eventConflict.rows[0]) {
        return {
          status: 409 as const,
          error: `Cannot move heat #${heat.match_number} earlier; it would overlap the scheduled event "${eventConflict.rows[0].title}"`
        };
      }
      await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1', [matchId, nextStart]);
      await audit(client, adminEmail(request), 'playoff_match.delay_reduced', 'playoff_match', matchId, {
        reason: body.reason,
        matchNumber: heat.match_number,
        reductionSeconds: reduction.reductionSeconds,
        remainingDelaySeconds: reduction.remainingDelaySeconds,
        restoredToScheduledTime: body.restoreScheduled,
        effectiveStart: nextStart.toISOString()
      });
      return {
        status: 200 as const, ok: true,
        reductionSeconds: reduction.reductionSeconds,
        remainingDelaySeconds: reduction.remainingDelaySeconds,
        effectiveStart: nextStart.toISOString()
      };
    });
    return reply.code(result.status).send(result);
  });

  app.get('/api/admin/playoff-matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const match = await pool.query('SELECT id FROM playoff_matches WHERE id = $1', [matchId]);
    if (!match.rowCount) return reply.code(404).send({ error: 'Playoff match not found' });
    const scores = await pool.query(
      `SELECT t.code AS team_code, pms.points, pms.revision, pms.updated_by, pms.updated_at
       FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
       WHERE pms.playoff_match_id = $1 ORDER BY t.code`,
      [matchId]
    );
    return scores.rows;
  });

  app.post('/api/admin/playoff-matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      reason: z.string().trim().min(1).max(500).optional(),
      scores: z.array(z.object({
        teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
        points: z.number().finite()
      })).min(2).max(4),
      /** The judge's full finishing order when teams on equal points would go to different places. */
      tieBreak: z.object({
        order: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)).min(2).max(4),
        reason: z.string().trim().min(1).max(500)
      }).optional()
    }).parse(request.body);
    const result = await transaction(async (client) => {
      const matchResult = await client.query<{
        id: string; bracket_id: string; competition_id: string; match_number: number;
        bracket_side: 'upper' | 'lower' | 'final';
        team_ids: (string | null)[]; status: string; seed_ranks: Record<string, number>;
        bracket_status: string; timer_state: string;
      }>(
        `SELECT pm.id, pm.bracket_id, pb.competition_id, pm.match_number, pm.bracket_side,
                ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids,
                pm.status, pb.seed_ranks, pb.status AS bracket_status, pm.timer_state
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pm.id = $1 FOR UPDATE OF pm, pb`,
        [matchId]
      );
      const match = matchResult.rows[0];
      if (!match) return { status: 404, error: 'Playoff match not found' };
      if (match.bracket_status !== 'active' &&
          !(match.bracket_status === 'complete' && match.bracket_side === 'final' && match.status === 'complete')) {
        return { status: 409, error: 'This playoff bracket is no longer active' };
      }
      if (match.status !== 'complete' && match.timer_state !== 'awaiting_score') {
        return { status: 409, error: 'Finish this playoff heat from Live Control before entering scores' };
      }
      const assignedTeamIds = match.team_ids.filter((teamId): teamId is string => teamId !== null);
      if (assignedTeamIds.length < 2 || assignedTeamIds.length > 4 ||
          (match.status !== 'ready' && match.status !== 'complete')) {
        return { status: 409, error: 'At least two and no more than four playoff teams must be assigned before recording a result' };
      }
      const teamResult = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM teams WHERE id = ANY($1::uuid[])',
        [assignedTeamIds]
      );
      const teamByCode = new Map(teamResult.rows.map((team) => [team.code, team.id]));
      const codeByTeam = new Map(teamResult.rows.map((team) => [team.id, team.code]));
      if (body.scores.length !== assignedTeamIds.length ||
          new Set(body.scores.map((score) => score.teamCode)).size !== assignedTeamIds.length ||
          body.scores.some((score) => !teamByCode.has(score.teamCode))) {
        return { status: 400, error: `Enter one score for each of the ${assignedTeamIds.length} teams assigned to this playoff heat` };
      }
      const existingScores = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM playoff_match_scores WHERE playoff_match_id = $1',
        [matchId]
      );
      const correcting = Number(existingScores.rows[0]?.count ?? 0) > 0;
      if (correcting && !body.reason) {
        return { status: 400, error: 'A reason is required when correcting existing playoff scores' };
      }
      const descendants = new Set<string>();
      if (correcting) {
        const allMatches = await client.query<{
          id: string; source_one: string; source_two: string; source_three: string; source_four: string;
        }>(
          'SELECT id, source_one, source_two, source_three, source_four FROM playoff_matches WHERE bracket_id = $1',
          [match.bracket_id]
        );
        const frontier = [matchId];
        while (frontier.length) {
          const parentId = frontier.pop()!;
          for (const candidate of allMatches.rows) {
            if (descendants.has(candidate.id)) continue;
            if ([candidate.source_one, candidate.source_two, candidate.source_three, candidate.source_four]
              .some((source) => source.endsWith(`:${parentId}`))) {
              descendants.add(candidate.id);
              frontier.push(candidate.id);
            }
          }
        }
        if (descendants.size) {
          const progressed = await client.query(
            `SELECT 1 FROM playoff_match_scores WHERE playoff_match_id = ANY($1::uuid[]) LIMIT 1`,
            [[...descendants]]
          );
          if (progressed.rowCount) {
            return { status: 409, error: 'A later playoff match has already been scored; this result can no longer be corrected safely' };
          }
        }
      }
      const scoreByTeam = new Map(body.scores.map((score) => [teamByCode.get(score.teamCode)!, score]));
      let placement = rankPlayoffScores(
        assignedTeamIds.map((teamId) => ({ teamId, points: scoreByTeam.get(teamId)!.points })),
        match.seed_ranks
      );
      // A tie that changes where teams go (advance vs drop, or final placings) is the judge's call.
      const pointsByTeam = new Map(assignedTeamIds.map((teamId) => [teamId, scoreByTeam.get(teamId)!.points]));
      const bracketSources = await client.query<{ id: string; sources: string[] }>(
        `SELECT id, ARRAY[source_one, source_two, source_three, source_four] AS sources
         FROM playoff_matches WHERE bracket_id = $1`,
        [match.bracket_id]
      );
      const destination = (place: number) => match.bracket_side === 'final'
        ? `final:${place}`
        : bracketSources.rows.find((heat) => heat.sources.includes(`place:${place}:${matchId}`))?.id ?? 'eliminated';
      const decisiveTies = findDecisivePlayoffTies(placement, pointsByTeam, destination);
      let tieBreak: { order: string[]; reason: string; decidedBy: string } | null = null;
      if (decisiveTies.length) {
        if (!body.tieBreak) {
          return {
            status: 409,
            error: 'Tied teams would finish in places that lead to different outcomes. The judge must decide the order.',
            tieBreakRequired: true,
            ties: decisiveTies.map((tie) => ({
              places: tie.places,
              teamCodes: tie.teamIds.map((teamId) => codeByTeam.get(teamId))
            }))
          };
        }
        const order = body.tieBreak.order.map((code) => teamByCode.get(code) ?? code);
        const invalid = validateTieBreakOrder(order, pointsByTeam);
        if (invalid) return { status: 400, error: invalid };
        placement = order;
        tieBreak = { order: body.tieBreak.order, reason: body.tieBreak.reason, decidedBy: adminEmail(request) };
      }
      const winner = placement[0];
      const tied = new Set(body.scores.map((score) => score.points)).size < body.scores.length;
      for (const [teamId, score] of scoreByTeam) {
        const prior = await client.query<{ points: string }>(
          'SELECT points FROM playoff_match_scores WHERE playoff_match_id = $1 AND team_id = $2',
          [matchId, teamId]
        );
        if (prior.rows[0]) {
          await client.query(
            `INSERT INTO playoff_score_revisions
             (id, playoff_match_id, team_id, points, reason, actor_email)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [randomUUID(), matchId, teamId, prior.rows[0].points, body.reason!, adminEmail(request)]
          );
        }
        await client.query(
          `INSERT INTO playoff_match_scores (playoff_match_id, team_id, points, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (playoff_match_id, team_id) DO UPDATE
           SET points = EXCLUDED.points, revision = playoff_match_scores.revision + 1,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [matchId, teamId, score.points, adminEmail(request)]
        );
      }
      if (correcting) {
        for (const descendantId of descendants) {
          await client.query(
            `UPDATE playoff_matches SET team_one_id = NULL, team_two_id = NULL,
               team_three_id = NULL, team_four_id = NULL, winner_team_id = NULL,
               tied = false, placements = NULL, status = 'pending'
             WHERE id = $1`,
            [descendantId]
          );
        }
      }
      await client.query(
        `UPDATE playoff_matches SET winner_team_id = $2, tied = $3, placements = $4::jsonb,
           status = 'complete', schedule_state = 'complete', tie_break = $5::jsonb,
           scored_at = coalesce(scored_at, now()) WHERE id = $1`,
        [matchId, winner, tied, JSON.stringify(placement), tieBreak ? JSON.stringify(tieBreak) : null]
      );
      if (match.bracket_side === 'final') {
        await client.query('UPDATE playoff_brackets SET status = $2 WHERE id = $1',
          [match.bracket_id, 'complete']);
      } else {
        await client.query('UPDATE playoff_brackets SET status = $2 WHERE id = $1',
          [match.bracket_id, 'active']);
      }
      const seedTeams = new Map(Object.entries(match.seed_ranks).map(([teamId, rank]) => [rank, teamId]));
      await persistPlayoffAdvancements(client, match.bracket_id, seedTeams);
      let rescheduledHeatIds: string[] = [];
      if (!correcting) {
        // Heats fed by this result cannot start before it was entered (plus their planned gap).
        rescheduledHeatIds = await reflowSchedule(
          client, match.competition_id, adminEmail(request), `playoff heat #${match.match_number} result entered`
        );
      }
      await audit(client, adminEmail(request), correcting ? 'playoff.score_corrected' : 'playoff.scored',
        'playoff_match', matchId, {
        winnerTeamId: winner,
        tied,
        placement: placement.map((teamId) => codeByTeam.get(teamId)),
        scores: body.scores.map((score) => ({ teamCode: score.teamCode, points: score.points })),
        rescheduledHeatIds,
        tieBreak,
        reason: body.reason ?? null
      });
      return {
        status: 200,
        winnerTeamId: winner,
        tied,
        placements: placement.map((teamId) => codeByTeam.get(teamId)),
        rescheduledHeatIds
      };
    });
    return reply.code(result.status).send(result);
  });


}
