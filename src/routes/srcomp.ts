import { publicDir } from '../lib/paths.js';
import { onChange } from '../services/changes.js';
import { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { buildSrDisplayConfig, selectSrDisplayMatches, selectSrMatchFeed, toSrMatches } from '../domain/srcomp.js';
import { loadPublicDisplay } from '../services/public-display.js';
import { getPublishedSrCompetition, loadSrCompetitionData } from '../services/srcomp-data.js';

const SR_SCREEN_PING_PERIOD_MS = 5_000;


export function registerSrcompRoutes(app: FastifyInstance): void {
  app.get('/srcomp-api/:competitionSlug/arenas/:arena', async (request, reply) => {
    const { competitionSlug, arena } = z.object({
      competitionSlug: z.string(),
      arena: z.string()
    }).parse(request.params);
    const competition = await getPublishedSrCompetition(competitionSlug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const data = await loadSrCompetitionData(competition.id);
    return data.arenas[arena] ?? null;
  });

  app.get('/srcomp-api/:competitionSlug/corners/:corner', async (request, reply) => {
    const { competitionSlug, corner } = z.object({
      competitionSlug: z.string(),
      corner: z.string()
    }).parse(request.params);
    const competition = await getPublishedSrCompetition(competitionSlug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const data = await loadSrCompetitionData(competition.id);
    return data.corners[corner] ?? null;
  });

  app.get('/srcomp-api/:competitionSlug/knockout/structure', async (request, reply) => {
    const { competitionSlug } = z.object({ competitionSlug: z.string() }).parse(request.params);
    const competition = await getPublishedSrCompetition(competitionSlug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const data = await loadSrCompetitionData(competition.id);
    return { brackets: data.brackets };
  });

  app.get('/srcomp-api/:competitionSlug/:resource', async (request, reply) => {
    const { competitionSlug, resource } = z.object({
      competitionSlug: z.string(),
      resource: z.string()
    }).parse(request.params);
    const competition = await getPublishedSrCompetition(competitionSlug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const query = request.query as Record<string, unknown>;
    if (resource === 'time') {
      reply.header('cache-control', 'no-store');
      return { serverTime: Date.now() };
    }
    const data = await loadSrCompetitionData(competition.id);
    const queryText = (name: string) => typeof query[name] === 'string' ? query[name] as string : '';
    const arenaFilter = queryText('arena');
    const numberFilter = queryText('num');
    const typeFilter = queryText('type');
    const startFilter = queryText('slot_start_time').split('..')[0];
    const startAfter = startFilter ? new Date(startFilter).getTime() : Number.NaN;
    const matchEntries = selectSrMatchFeed(
      data.matches.map((match, index) => ({ match, srMatch: data.srMatches[index]! })),
      data.playoffMatches.map((match, index) => ({
        match,
        srMatch: data.srPlayoffMatches[index]!
      })),
      typeFilter
    ).sort((left, right) =>
      new Date(left.match.effective_start).getTime() - new Date(right.match.effective_start).getTime() ||
      left.match.match_number - right.match.match_number
    );

    if (resource === 'config') {
      return { config: { ping_period: 5 } };
    }
    if (resource === 'arenas') return { arenas: data.arenas };
    if (resource === 'corners') return { corners: data.corners };
    if (resource === 'current') {
      const now = Date.now();
      const current = selectSrDisplayMatches([...data.matches, ...data.playoffMatches], new Date(now));
      const currentMatches = toSrMatches(current);
      return {
        delay: current.find((match) => match.state === 'delayed')?.delay_seconds ?? 0,
        matches: currentMatches,
        shepherding_matches: toSrMatches([...data.matches, ...data.playoffMatches]
          .filter((match) => match.state !== 'cancelled')
        )
      };
    }
    if (resource === 'locations') {
      return { locations: { competition: { shepherds: { colour: '#ffffff' } } } };
    }
    if (resource === 'teams') return { teams: data.teams };
    if (resource === 'knockout') return { rounds: data.knockoutRounds };
    if (resource === 'tiebreaker') return { tiebreaker: null };
    if (resource === 'periods') {
      const events = await pool.query<{
        title: string;
        starts_at: Date;
        ends_at: Date;
      }>(
        `SELECT title, starts_at,
                starts_at + make_interval(mins => duration_minutes) AS ends_at
         FROM competition_events WHERE competition_id = $1 ORDER BY starts_at, title`,
        [competition.id]
      );
      return {
        periods: events.rows.map((event) => ({
          description: event.title,
          type: 'event',
          start_time: event.starts_at.toISOString(),
          end_time: event.ends_at.toISOString(),
          max_end_time: event.ends_at.toISOString()
        }))
      };
    }
    if (resource === 'matches') {
      const filtered = matchEntries
        .filter(({ match }) => !arenaFilter || match.arena_name === arenaFilter)
        .filter(({ match }) => !numberFilter || String(match.match_number) === numberFilter)
        .filter(({ match }) => !Number.isFinite(startAfter) ||
          new Date(match.effective_start).getTime() >= startAfter)
        .map(({ srMatch }) => srMatch);
      if (typeFilter !== 'knockout') {
        const lastScored = [...data.matches]
          .filter((match) => match.scores && Object.keys(match.scores).length > 0)
          .sort((left, right) =>
            new Date(right.effective_start).getTime() - new Date(left.effective_start).getTime() ||
            right.match_number - left.match_number
          )[0]?.match_number ?? null;
        return { matches: filtered, last_scored_match: lastScored };
      }
      return { matches: filtered };
    }
    return reply.code(404).send({ error: 'SRComp API resource not found' });
  });

  app.get('/srcomp-stream/:competitionSlug', async (request, reply) => {
    const { competitionSlug } = z.object({ competitionSlug: z.string() }).parse(request.params);
    const competition = await getPublishedSrCompetition(competitionSlug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });

    const initialData = await loadSrCompetitionData(competition.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    let lastTeams = '';
    let lastStructure = '';
    let lastCurrentMatches = '';
    let lastStagingMatches = '';
    let lastShepherdingMatches = '';
    let lastKnockoutRounds = '';
    let lastDelay: number | undefined;
    let lastScoredMatch: number | null | undefined;
    const sendEvent = (event: string, data: unknown) => {
      if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const sendSnapshot = async (snapshot?: Awaited<ReturnType<typeof loadSrCompetitionData>>) => {
      const currentSnapshot = snapshot ?? await loadSrCompetitionData(competition.id);
      const allMatches = [...currentSnapshot.matches, ...currentSnapshot.playoffMatches];
      const now = new Date();
      const current = toSrMatches(selectSrDisplayMatches(allMatches, now));
      const schedule = allMatches
        .filter((match) => match.state !== 'cancelled')
      const srSchedule = toSrMatches(schedule);
      const teamState = JSON.stringify(currentSnapshot.teams);
      const structure = JSON.stringify({ brackets: currentSnapshot.brackets });
      const lastScored = [...currentSnapshot.matches]
        .filter((match) => match.scores && Object.keys(match.scores).length > 0)
        .sort((left, right) =>
          new Date(right.effective_start).getTime() - new Date(left.effective_start).getTime() ||
          right.match_number - left.match_number
        )[0]?.match_number ?? null;
      sendEvent('ping', SR_SCREEN_PING_PERIOD_MS);
      const currentDelay = selectSrDisplayMatches(allMatches, now)
        .find((match) => match.state === 'delayed')?.delay_seconds ?? 0;
      if (currentDelay !== lastDelay) {
        sendEvent('current-delay', currentDelay);
        lastDelay = currentDelay;
      }
      const currentMatchesState = JSON.stringify(current);
      if (currentMatchesState !== lastCurrentMatches) {
        sendEvent('match', current);
        lastCurrentMatches = currentMatchesState;
      }
      const scheduleState = JSON.stringify(srSchedule);
      if (scheduleState !== lastStagingMatches) {
        sendEvent('current-staging-matches', srSchedule);
        lastStagingMatches = scheduleState;
      }
      if (scheduleState !== lastShepherdingMatches) {
        sendEvent('current-shepherding-matches', srSchedule);
        lastShepherdingMatches = scheduleState;
      }
      const knockoutRoundsState = JSON.stringify(currentSnapshot.knockoutRounds);
      if (knockoutRoundsState !== lastKnockoutRounds) {
        sendEvent('knockouts', currentSnapshot.knockoutRounds);
        lastKnockoutRounds = knockoutRoundsState;
      }
      if (lastScored !== lastScoredMatch) {
        sendEvent('last-scored-match', lastScored);
        lastScoredMatch = lastScored;
      }
      if (teamState !== lastTeams) {
        sendEvent('team', {});
        lastTeams = teamState;
      }
      if (structure !== lastStructure) {
        sendEvent('knockout-structure', { brackets: currentSnapshot.brackets });
        lastStructure = structure;
      }
    };

    let closed = false;
    let updating = false;
    let again = false;
    // Refresh straight away when anything changes (a start countdown is only five seconds long),
    // and every few seconds for time-based changes such as the next match becoming due.
    const refresh = () => {
      if (closed) return;
      if (updating) {
        again = true;
        return;
      }
      updating = true;
      void sendSnapshot().catch((error: unknown) => {
        request.log.warn({ err: error }, 'Failed to refresh SRComp display stream');
        stop();
        reply.raw.end();
      }).finally(() => {
        updating = false;
        if (again) {
          again = false;
          refresh();
        }
      });
    };
    const interval = setInterval(refresh, 3000);
    const unsubscribe = onChange(refresh);
    const stop = () => {
      closed = true;
      clearInterval(interval);
      unsubscribe();
    };
    request.raw.on('close', stop);
    reply.raw.on('error', stop);
    await sendSnapshot(initialData);
  });

  app.get('/srcomp/:displaySlug/config.json', async (request, reply) => {
    const { displaySlug } = z.object({ displaySlug: z.string() }).parse(request.params);
    const display = await loadPublicDisplay(displaySlug);
    if (!display || !display.type.startsWith('sr-')) {
      return reply.code(404).send({ error: 'SRComp display not found' });
    }
    const apiRoot = `/srcomp-api/${encodeURIComponent(display.competitionSlug)}`;
    return {
      apiurl: apiRoot,
      streamurl: `/srcomp-stream/${encodeURIComponent(display.competitionSlug)}`,
      displayConfig: buildSrDisplayConfig(display.options),
      serverTime: Date.now()
    };
  });

  app.get('/srcomp/:displaySlug/*', async (request, reply) => {
    const { '*': requestedPath } = z.object({
      '*': z.string().min(1)
    }).parse(request.params);
    const root = join(publicDir, 'srcomp') + sep;
    const filename = resolve(root, requestedPath);
    const localPath = relative(root, filename);
    if (!localPath || localPath.startsWith(`..${sep}`) || localPath === '..' ||
        isAbsolute(localPath)) {
      return reply.code(404).send({ error: 'SRComp asset not found' });
    }
    try {
      const body = await readFile(filename);
      const contentTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject'
      };
      return reply.type(contentTypes[extname(filename).toLowerCase()] ?? 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        .send(body);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return reply.code(404).send({ error: 'SRComp asset not found' });
      }
      throw error;
    }
  });


}
