import { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { type CustomPanel, type DisplayOptions, MATCH_COUNTDOWN_PREPARATION_SECONDS, customLayoutAreas, MATCH_COUNTDOWN_TOTAL_SECONDS, displayOptionsSchema, formatCompetitionDateTime, formatCompetitionTime, readableTextColour } from '../domain/display.js';
import { clockSyncScript } from '../lib/clock-sync.js';
import { audioPlayerScript, beepScript, customScreenScript, revisionScript, soundSupportScript } from '../lib/display-client.js';
import { escapeHtml, safeDisplayColour } from '../lib/html.js';
import { findCompetition, listArenaNames } from '../services/competitions.js';
import { customPanelKinds, displayConfigHash, loadCustomPanel, loadPublicDisplay } from '../services/public-display.js';

export function registerDisplayPageRoutes(app: FastifyInstance): void {
  app.get('/display/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const display = await loadPublicDisplay(slug);
    if (!display) return reply.code(404).send('Public display not found');
    const options = displayOptionsSchema.parse(display.options ?? {});
    const srScreenFiles: Record<string, string> = {
      'sr-arena': 'arena.html',
      'sr-outside': 'outside.html',
      'sr-producer': 'producer.html',
      'sr-shepherding': 'shepherding.html',
      'sr-staging': 'staging.html'
    };
    const srScreenFile = srScreenFiles[display.type];
    if (srScreenFile) {
      const displayPath = `/srcomp/${encodeURIComponent(display.slug)}/${srScreenFile}`;
      let arena = options.srArenaName.trim();
      if (['sr-arena', 'sr-producer'].includes(display.type) && !arena) {
        // These SR screens need one arena; without one they would show a picker on the TV.
        const competition = await findCompetition(pool, display.competitionSlug);
        arena = competition ? (await listArenaNames(pool, competition.id))[0] ?? '' : '';
      }
      const query = display.type === 'sr-arena' && arena
        ? `?${encodeURIComponent(arena)},${options.cornerPosition}`
        : ['sr-producer', 'sr-shepherding', 'sr-staging'].includes(display.type) && arena
          ? `?${encodeURIComponent(arena)}`
          : '';
      return reply.code(302).redirect(`${displayPath}${query}`);
    }
    return sendDisplayPage(reply, display, options, false);
  });

  // One panel of a custom screen: a standard display rendered for the custom screen's competition.
  app.get('/display/:slug/panel/:kind', async (request, reply) => {
    const params = z.object({ slug: z.string(), kind: z.enum(customPanelKinds) }).safeParse(request.params);
    const panel = params.success ? await loadCustomPanel(params.data.slug, params.data.kind) : undefined;
    if (!panel) return reply.code(404).send('Panel not found');
    return sendDisplayPage(reply, panel.display, panel.options, true);
  });
}

type LoadedDisplay = NonNullable<Awaited<ReturnType<typeof loadPublicDisplay>>>;

function sendDisplayPage(reply: FastifyReply, display: LoadedDisplay, options: DisplayOptions, panel: boolean) {
  const darkTheme = display.type !== 'corner' &&
    (options.darkTheme || display.theme === 'night');
  const displayBackground = darkTheme ? '#111820' : display.theme === 'field' ? '#edf3ec' : '#fffefa';
  const theme = darkTheme
    ? 'background:#111820;color:#edf3f4;border-color:#45525c'
    : display.theme === 'field'
      ? 'background:#edf3ec;color:#18332b;border-color:#adc4b4'
      : 'background:#fffefa;color:#17242b;border-color:#c9ceca';
  const data = display.data as Array<Record<string, unknown>> | Record<string, unknown> | null;
  let content = '';
  if (display.type === 'league') {
    const rows = (Array.isArray(data) ? data : []).map((team, index) =>
      `<tr><td>${index + 1}</td><th>${escapeHtml(team.code)} — ${escapeHtml(team.name)}</th><td>${escapeHtml(team.league_points)}</td><td>${escapeHtml(team.scored_matches)}</td></tr>`
    ).join('');
    content = rows
      ? `<table><thead><tr><th>Rank</th><th>Team</th><th>Points</th><th>Matches</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty-board">No teams yet.</p>';
  } else if (display.type === 'results') {
    const rows = (Array.isArray(data) ? data : []).map((match) => {
      const scores = Array.isArray(match.scores) ? match.scores as Array<Record<string, unknown>> : [];
      const positions = Array.from({ length: 4 }, (_, index) =>
        scores.find((score) => Number(score.position) === index + 1)
      );
      const cells = positions.map((score) => score
        ? `<td><strong style="color:${safeDisplayColour(String(score.colour))}">${escapeHtml(score.code)}</strong><br>${escapeHtml(score.points)} pts</td>`
        : '<td>—</td>').join('');
      return `<tr><th scope="row">${escapeHtml(match.match_type)} ${escapeHtml(match.match_number)}</th><td>${escapeHtml(formatCompetitionDateTime(String(match.effective_start), display.competitionTimezone))}</td><td>${escapeHtml(match.arena_name)}</td>${cells}</tr>`;
    }).join('');
    content = rows
      ? `<table><thead><tr><th>Match</th><th>Time</th><th>Arena</th>${[0,1,2,3].map((position) => `<th><span class="long-label">Position </span><span class="short-label">P</span>${position}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty-board">No completed matches yet. Scores appear here as matches finish.</p>';
  } else if (display.type === 'schedule') {
    const showArena = options.showArena && !options.hideScheduleArena;
    const timeContent = (value: unknown) => {
      const date = new Date(String(value));
      const formattedTime = formatCompetitionTime(date, display.competitionTimezone);
      return options.relativeTime
        ? `<time data-relative-time="${escapeHtml(date.getTime())}" aria-label="${escapeHtml(formatCompetitionDateTime(date, display.competitionTimezone))}"></time>`
        : escapeHtml(formattedTime);
    };
    const scheduleItems = Array.isArray(data) ? data : [];
    const statusLabel = (match: Record<string, unknown>, delayMinutes: number) => {
      const state = String(match.state);
      if (state === 'complete') return 'Complete';
      if (state === 'running') return 'In progress';
      if (state === 'paused') return 'Paused';
      if (state === 'awaiting_score') return 'Finished';
      if (match.countdown_started_at) return 'Starting';
      if (state === 'pending') return 'Waiting for results';
      return delayMinutes > 0 ? `Delayed ${delayMinutes} min` : 'Scheduled';
    };
    const minutesLate = (match: Record<string, unknown>) => Math.max(0, Math.round(
      (new Date(String(match.effective_start)).getTime() - new Date(String(match.scheduled_start ?? match.effective_start)).getTime()) / 60_000
    ));
    const nextUp = scheduleItems.find((match) => match.item_type === 'match' &&
      ['scheduled', 'ready', 'delayed', 'pending'].includes(String(match.state)) && !match.countdown_started_at);
    const behindMinutes = nextUp ? minutesLate(nextUp) : 0;
    const behindBanner = behindMinutes > 0
      ? `<p class="schedule-banner">Running about ${escapeHtml(behindMinutes)} minute${behindMinutes === 1 ? '' : 's'} behind schedule · times shown are the latest expected starts</p>`
      : '';
    const rows = scheduleItems.map((match) => {
      const teams = Array.isArray(match.teams) ? match.teams as Array<Record<string, unknown>> : [];
      if (match.item_type === 'event') {
        const event = teams[0] ?? {};
        return `<tr data-schedule-event="true"><td colspan="${showArena ? 8 : 7}"><strong>${timeContent(match.effective_start)} · ${escapeHtml(event.title)}</strong>${showArena ? ` · ${escapeHtml(event.location || '—')}` : ''} · ${escapeHtml(event.durationMinutes)} minutes${event.description ? ` · ${escapeHtml(event.description)}` : ''}</td></tr>`;
      }
      const teamCodes = teams.map((team) => String(team.code ?? '')).filter(Boolean);
      const positions = [0, 1, 2, 3].map((spot) =>
        teams.find((team) => Number(team.position) === spot + 1)
      );
      const positionCells = positions.map((team, index) => {
        if (!team) return '<td><span class="schedule-position-team">VACANT</span></td>';
        const code = escapeHtml(team.code);
        const colour = safeDisplayColour(team.colour);
        return `<td><strong class="schedule-position-team" style="color:${colour}">${code}</strong></td>`;
      }).join('');
      const expectedTeams = Number(match.entrant_count ?? match.team_count);
      const lateMinutes = minutesLate(match);
      const status = statusLabel(match, lateMinutes);
      const fillStatus = `${match.is_playoff ? '<span class="tag">Playoff</span> ' : ''}${escapeHtml(status)}${expectedTeams < 4
        ? ` <strong class="warning">${escapeHtml(expectedTeams)}/4 TEAM HEAT</strong>` : ''}`;
      const wasTime = lateMinutes > 0 && !options.relativeTime && !['complete', 'running', 'paused', 'awaiting_score'].includes(String(match.state))
        ? `<s class="muted">${escapeHtml(formatCompetitionTime(new Date(String(match.scheduled_start)), display.competitionTimezone))}</s> `
        : '';
      const rowState = ['running', 'paused'].includes(String(match.state)) || match.countdown_started_at
        ? ' class="row-live"' : match === nextUp ? ' class="row-next"' : String(match.state) === 'complete' ? ' class="row-done"' : '';
      const mobileStatus = status === 'Scheduled' && expectedTeams >= 4
        ? (match.is_playoff ? '<span class="tag">Playoff</span>' : '')
        : fillStatus;
      return `<tr${rowState} data-team-codes="${escapeHtml(teamCodes.join(','))}"><td><strong>${escapeHtml(match.match_number)}</strong>${showArena ? `<div class="mobile-only muted">${escapeHtml(match.arena_name)}</div>` : ''}</td>${showArena ? `<td class="arena-col">${escapeHtml(match.arena_name)}</td>` : ''}<td>${wasTime}${timeContent(match.effective_start)}${mobileStatus ? `<div class="mobile-status">${mobileStatus}</div>` : ''}</td>${positionCells}<td class="status-cell">${fillStatus}</td></tr>`;
    }).join('');
    content = rows
      ? `${behindBanner}<table><thead><tr><th>Match</th>${showArena ? '<th class="arena-col">Arena</th>' : ''}<th>${options.relativeTime ? 'Starts in / elapsed' : 'Time'}</th>${[0, 1, 2, 3].map((position) => `<th><span class="long-label">Position </span><span class="short-label">P</span>${position}</th>`).join('')}<th class="status-cell">Status</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty-board">Nothing scheduled yet.</p>';
    if (options.enableTeamFilter) {
      const teams = new Map<string, string>();
      for (const match of Array.isArray(data) ? data : []) {
        if (!Array.isArray(match.teams)) continue;
        for (const team of match.teams as Array<Record<string, unknown>>) {
          if (team.code) teams.set(String(team.code), String(team.name ?? team.code));
        }
      }
      const teamOptions = [...teams].sort(([left], [right]) => left.localeCompare(right))
        .map(([code, name]) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`).join('');
      content = `<label class="team-filter">Filter by team<select id="schedule-team-filter"><option value="">All teams</option>${teamOptions}</select></label>${content}`;
    }
  } else if (display.type === 'corner') {
    const match = data && !Array.isArray(data) ? data as Record<string, unknown> : null;
    const positions = match && Array.isArray(match.positions) ? match.positions as Array<Record<string, unknown>> : [];
    const position = positions.find((item) => Number(item.spot) === options.cornerPosition);
    const colour = safeDisplayColour(String(position?.colour ?? '#777777'));
    const teamCode = position?.teamCode ? escapeHtml(position.teamCode) : 'VACANT';
    const teamName = position?.teamName ? escapeHtml(position.teamName) : '';
    const cornerBackground = options.fillCornerDisplay ? colour : displayBackground;
    const cornerTextColour = options.fillCornerDisplay ? readableTextColour(colour) : darkTheme ? '#edf3f4' : '#17242b';
    content = `<section id="corner-display" style="background-color:${cornerBackground};color:${cornerTextColour}">
      ${options.showCornerPositionNumber ? `<span class="corner-position-number" id="corner-position-number">${options.cornerPosition}</span>` : ''}
      <div class="corner-team-code" id="corner-team-code">${teamCode}</div>
      ${options.showCornerTeamName ? `<div class="corner-team-name" id="corner-team-name">${teamName}</div>` : ''}
      <div class="timer corner-timer" id="timer-display">--:--.-</div>
      <p id="timer-label" class="corner-state">STARTS IN</p>
    </section>`;
  } else if (['timer', 'arena'].includes(display.type)) {
    content = `<h2 id="timer-match">Connecting to live match...</h2><p id="timer-state" class="muted" style="text-align:center">Waiting for live data</p>
      <div class="timer" id="timer-display">--:--.-</div><p id="timer-label" class="muted" style="text-align:center">SYNCING CLOCK</p>
      <div id="timer-arena" class="arena-square" aria-label="Current match arena positions"></div>
      <p id="timer-warning" class="warning" style="text-align:center"></p><p id="timer-connection" class="muted" role="status" style="text-align:center">Connecting...</p>
      ${options.showPreviousResults ? '<section id="timer-previous-results" class="previous-results" aria-live="polite" hidden></section>' : ''}`;
  } else if (['playoffs', 'knockout'].includes(display.type)) {
    const bracket = data && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const heats = Array.isArray(bracket.heats) ? bracket.heats as Array<Record<string, unknown>> : [];
    const eliminated = new Set(Array.isArray(bracket.eliminated) ? bracket.eliminated.map(String) : []);
    const sideLabel = (side: unknown) => side === 'final' ? 'Final' : side === 'lower' ? 'Lower bracket'
      : bracket.format === 'double-elimination' ? 'Upper bracket' : 'Knockout';
    const ordinalPlace = (place: string) => `${place}${({ '1': 'st', '2': 'nd', '3': 'rd' } as Record<string, string>)[place] ?? 'th'}`;
    const describe = (source: string) => source.startsWith('seed:')
      ? `Seed ${source.slice(5)}`
      : source.replace(/^place:(\d):(.+)$/, (_whole, place: string, heat: string) => `${ordinalPlace(place)} of heat ${heat}`);
    const stageCount = Math.max(0, ...heats.map((heat) => Number(heat.stage) || 1));
    const card = (heat: Record<string, unknown>) => {
      const scores = Array.isArray(heat.scores) ? heat.scores as Array<Record<string, unknown>> : [];
      const teams = Array.isArray(heat.teams) ? heat.teams as Array<string | null> : [];
      const sources = Array.isArray(heat.sources) ? heat.sources as string[] : [];
      const entries = scores.length
        ? scores.map((score, index) => `<li class="${index < Number(heat.advancing_places ?? 0) || heat.bracket_side === 'final' ? 'through' : eliminated.has(String(score.team)) ? 'out' : ''}"><strong>${escapeHtml(score.team)}</strong><span>${escapeHtml(score.points)}</span></li>`).join('')
        : sources.map((source, index) => source === 'bye' ? '' : teams[index]
          ? `<li><strong>${escapeHtml(teams[index])}</strong></li>`
          : `<li class="tbd">${escapeHtml(describe(source))}</li>`).join('');
      const state = String(heat.schedule_state) === 'complete' ? 'Result'
        : ['running', 'paused'].includes(String(heat.timer_state)) ? 'Live'
          : String(heat.timer_state) === 'awaiting_score' ? 'Finished'
            : formatCompetitionTime(new Date(String(heat.effective_start)), display.competitionTimezone);
      return `<article class="heat heat-${escapeHtml(heat.bracket_side)}"><header><span>Heat ${escapeHtml(heat.match_number)}</span><span>${escapeHtml(state)}</span></header><div class="muted heat-meta">${escapeHtml(sideLabel(heat.bracket_side))} · ${escapeHtml(heat.arena_name)}</div><ol>${entries}</ol></article>`;
    };
    const columns = Array.from({ length: stageCount }, (_, index) => {
      const stageHeats = heats.filter((heat) => (Number(heat.stage) || 1) === index + 1);
      const title = stageHeats.every((heat) => heat.bracket_side === 'final') ? 'Final' : `Stage ${index + 1}`;
      return `<section class="stage"><h2>${title}</h2>${stageHeats.map(card).join('')}</section>`;
    }).join('');
    content = heats.length && display.type === 'knockout'
      ? `<div class="bracket-diagram-wrap knockout-fit">${String(bracket.diagram ?? '')}</div>`
      : heats.length
      ? `<div class="bracket-diagram-wrap">${String(bracket.diagram ?? '')}</div>
        <p class="bracket-legend muted"><span class="legend-line win"></span>Winners progress <span class="legend-line drop"></span>Drops to lower bracket <span class="legend-line final"></span>Into the final</p>
        <details class="bracket-list"><summary>Heat list</summary><div class="bracket">${columns}</div></details>`
      : '<p class="muted" style="text-align:center;margin-top:3rem">The playoff bracket will appear here once it has been scheduled.</p>';
  } else if (display.type === 'custom') {
    const panelLabels: Record<CustomPanel, string> = {
      schedule: 'Schedule', league: 'League table', knockout: 'Knockout', results: 'Latest scores',
      timer: 'Live match', message: 'Announcement', images: 'Sponsors'
    };
    const images = data && !Array.isArray(data) && Array.isArray((data as Record<string, unknown>).images)
      ? (data as { images: Array<{ url: string; name: string }> }).images : [];
    const areaCount = customLayoutAreas[options.customLayout];
    const areas = Array.from({ length: areaCount }, (_, index) => options.customAreas[index] ?? []);
    const panelHtml = (kind: CustomPanel) => {
      if (kind === 'message') {
        return `<div class="custom-panel custom-message" data-panel="message"><div>${options.customMessageTitle ? `<h2>${escapeHtml(options.customMessageTitle)}</h2>` : ''}${options.customMessageBody ? `<p>${escapeHtml(options.customMessageBody).replaceAll('\n', '<br>')}</p>` : ''}${!options.customMessageTitle && !options.customMessageBody ? '<p class="muted">No announcement set.</p>' : ''}</div></div>`;
      }
      if (kind === 'images') {
        return `<div class="custom-panel custom-images" data-panel="images">${images.length
          ? images.map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}">`).join('')
          : '<p class="muted">No images chosen.</p>'}</div>`;
      }
      return `<div class="custom-panel" data-panel="${kind}"><div class="panel-caption">${panelLabels[kind]}</div><iframe src="/display/${encodeURIComponent(display.slug)}/panel/${kind}" title="${panelLabels[kind]}"></iframe></div>`;
    };
    content = `<div class="custom-screen layout-${options.customLayout}">${areas.map((panels, index) =>
      `<section class="custom-area" data-area="${index}">${panels.length ? panels.map(panelHtml).join('') : '<div class="custom-panel active"><p class="muted">Nothing chosen for this area.</p></div>'}</section>`
    ).join('')}</div>`;
  }
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; frame-src 'self'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors *");
  const liveTimerDisplay = ['timer', 'arena', 'corner'].includes(display.type);
  const beeps = liveTimerDisplay && options.countdownBeeps;
  const audio = options.playAudio && !panel;
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(display.title)}</title><script>${clockSyncScript}</script>
    <script>${revisionScript({ panel, configUrl: `/api/public/display/${encodeURIComponent(display.slug)}/config`, hash: displayConfigHash(display) })}</script>
    ${beeps || audio ? `<script>${soundSupportScript}</script>` : ''}${beeps ? `<script>${beepScript({ volume: options.beepVolume })}</script>` : ''}<style>
      *{box-sizing:border-box}body{font:16px/1.45 system-ui,sans-serif;margin:0;padding:clamp(1rem,4vw,3rem);${theme}}
      main{max-width:1100px;margin:auto}header{display:flex;align-items:center;gap:1rem;border-bottom:1px solid currentColor;padding-bottom:1rem}
      header img{max-height:64px;max-width:180px;object-fit:contain}h1{font-size:clamp(1.5rem,4vw,2.5rem);margin:.2rem 0}
      .muted{opacity:.68}table{width:100%;border-collapse:collapse;margin-top:1.5rem}td,th{text-align:left;padding:.8rem;border-bottom:1px solid ${darkTheme ? '#45525c' : '#c9ceca'}}
      thead th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;opacity:.75}tbody th{font-weight:700}
      .empty-board{text-align:center;margin-top:3rem;opacity:.7}
      ${liveTimerDisplay ? '' : '@media(min-width:1200px){html{font-size:clamp(16px,1.25vw,34px)}main,.board-footer{max-width:72rem}}'}
      .arena-square{width:min(100%,640px);aspect-ratio:1;margin:1.5rem auto;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3px;background:currentColor;border:3px solid currentColor}
      .arena-cell{min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:clamp(.4rem,2vw,1.2rem);border:6px solid}
      .arena-cell[data-spot="1"],.arena-cell[data-spot="2"]{grid-row:1}.arena-cell[data-spot="0"],.arena-cell[data-spot="3"]{grid-row:2}
      .arena-cell[data-spot="1"],.arena-cell[data-spot="0"]{grid-column:1}.arena-cell[data-spot="2"],.arena-cell[data-spot="3"]{grid-column:2}
      .arena-cell{position:relative;isolation:isolate}.arena-spot{position:absolute;top:.45rem;left:.55rem;transform:none;font:900 clamp(2rem,7vw,5rem)/1 ui-monospace,monospace;opacity:.4;z-index:0}.arena-code{position:relative;z-index:1;font:800 clamp(1.5rem,5vw,3.5rem)/1 ui-monospace,monospace;margin:.35rem 0}
      .arena-team{position:relative;z-index:1;font-weight:650}.warning{font-weight:800;color:#b33}.timer{font:800 clamp(3rem,14vw,10rem)/1 ui-monospace,monospace;text-align:center;padding:1.4rem 0 .4rem;font-variant-numeric:tabular-nums}.timer-label{text-align:center;font-weight:800;letter-spacing:.08em}
      body.timer-board{height:100vh;height:100dvh;overflow:hidden;padding:clamp(.35rem,1.2vmin,1rem)}
      body.timer-board main{width:100%;max-width:none;height:100%;margin:0;display:grid;grid-template-rows:auto auto auto auto auto minmax(0,1fr) auto auto auto;gap:clamp(.1rem,.45vh,.4rem);min-height:0}
      body.timer-board main>*{min-width:0}
      body.timer-board-no-title main{grid-template-rows:auto auto auto auto minmax(0,1fr) auto auto auto}
      body.timer-board header{padding-bottom:.35rem;min-width:0}
      body.timer-board header img{max-height:clamp(28px,6vh,56px)}
      body.timer-board h1{font-size:clamp(1rem,2.5vh,1.8rem)}
      body.timer-board #timer-match{font-size:clamp(1rem,2.5vh,1.8rem);text-align:center;margin:.1rem 0}
      body.timer-board #timer-state,body.timer-board #timer-label{margin:.1rem 0;font-size:clamp(.7rem,1.6vh,1rem)}
      body.timer-board #timer-display{font-size:clamp(2rem,min(16vh,14vw),12rem);padding:0;line-height:.95}
      body.timer-board #timer-arena{width:min(100%,70dvh);height:auto;max-width:100%;max-height:100%;aspect-ratio:1;margin:0 auto;min-height:0}
      body.timer-board .arena-cell{padding:clamp(.15rem,1vh,.8rem);border-width:clamp(2px,.6vh,6px)}
      body.timer-board .arena-spot{top:50%;left:50%;transform:translate(-50%,-50%);font-size:clamp(4rem,min(24vw,24vh),14rem);opacity:.24}
      body.timer-board .arena-code{font-size:clamp(1.25rem,5vh,3.5rem);margin:.15rem 0}
      body.timer-board .arena-team{font-size:clamp(.65rem,1.8vh,1rem)}
      body.timer-board #timer-warning,body.timer-board #timer-connection{margin:0;font-size:clamp(.65rem,1.5vh,.9rem);line-height:1.15}
      body.timer-board main>p:last-child{display:none}
      .previous-results{display:grid;grid-template-columns:auto repeat(4,minmax(0,1fr));align-items:center;gap:.4rem;border-top:1px solid currentColor;padding-top:.35rem;min-width:0}
      .previous-results[hidden]{display:none}
      .previous-results-heading{font-size:clamp(.65rem,1.5vh,.9rem);font-weight:800;line-height:1.15}
      .previous-result-team{text-align:center;min-width:0;line-height:1.1}
      .previous-result-team strong{display:block;font:800 clamp(.8rem,2vh,1.15rem)/1.1 ui-monospace,monospace}
      .previous-result-team span{display:block;font-size:clamp(.6rem,1.35vh,.8rem);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      body.timer-board .previous-results{gap:.2rem;padding-top:.2rem}
      body.arena-board #timer-display{font-size:clamp(1.8rem,min(10vh,9vw),7rem)}
      body.arena-board #timer-arena{width:min(100%,82dvh)}
      body.arena-board .arena-code{font-size:clamp(1.5rem,7vh,5rem)}
      body.arena-board .arena-team{font-size:clamp(.8rem,2.4vh,1.4rem)}
      body.timer-board-with-results.timer-board-has-title main{grid-template-rows:auto auto auto auto auto minmax(0,1fr) auto auto auto auto}
      @media(max-width:480px){body.timer-board .previous-results{grid-template-columns:repeat(4,minmax(0,1fr))}body.timer-board .previous-results-heading{grid-column:1/-1;text-align:center}}
      body.corner-board{padding:0;min-height:100dvh}body.corner-board main{width:100%;max-width:none;min-height:100dvh;margin:0}
      body.corner-board header,body.corner-board main>p{display:none}
      #corner-display{position:relative;isolation:isolate;overflow:hidden;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:5vw}
      .corner-position-number{position:absolute;z-index:0;inset:50% auto auto 50%;transform:translate(-50%,-55%);font:900 min(88vw,88vh)/.8 ui-monospace,monospace;opacity:.14;pointer-events:none}
      .corner-team-code{position:relative;font:900 clamp(5rem,30vw,28rem)/.85 ui-monospace,monospace;letter-spacing:-.07em}
      .corner-team-name{position:relative;font-size:clamp(1.5rem,5vw,4rem);font-weight:700;line-height:1.05;overflow-wrap:anywhere;margin-top:.5em}
      .corner-timer{position:relative;font-size:clamp(3rem,14vw,12rem);padding:.2em 0 0}
      .corner-state{position:relative;margin:0;font-size:clamp(1.1rem,3vw,2.5rem);font-weight:850;letter-spacing:.1em}
      .countdown-overlay{position:fixed;inset:0;z-index:1000;width:100vw;height:100dvh;overflow:hidden;padding:4vw;display:none;place-items:center;text-align:center;background:inherit;font:900 min(65vw,82vh,36rem)/.9 ui-monospace,monospace;font-variant-numeric:tabular-nums}
      .countdown-overlay.visible{display:grid}
      .countdown-overlay.ready{font-size:clamp(2rem,10vw,8rem);letter-spacing:.04em}
      .countdown-overlay.end{font-size:min(45vw,72vh,36rem);line-height:1;overflow-wrap:anywhere}
      #countdown-overlay{color:#fff}
      .schedule-position-team{font:900 1.15rem/1 ui-monospace,monospace}
      body.cue-red{background:${options.countdownBackgroundColor}!important;color:${readableTextColour(options.countdownBackgroundColor)}!important;transition:background-color .15s linear}
      .board-footer{max-width:1100px;margin:1rem auto 0;font-size:.85rem}
      .short-label{display:none}.mobile-status{display:none}.mobile-only{display:none}
      @media(max-width:700px){
        body{padding:.75rem}
        main table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:1rem;font-size:.9rem}
        main td,main th{padding:.5rem .4rem}
        .long-label{display:none}.short-label{display:inline}
        .status-cell,.arena-col{display:none}.mobile-only{display:block;font-size:.75rem}.mobile-status{display:block;font-size:.75rem;line-height:1.2;margin-top:.15rem;opacity:.85;white-space:normal}
        .schedule-position-team{font-size:1rem}
        .team-filter select{width:100%;font-size:1rem;min-height:2.5rem}
        h1{font-size:1.4rem}
      }
      .schedule-banner{margin:1rem 0 0;padding:.6rem .9rem;border-left:5px solid #c76a10;background:${darkTheme ? '#3a2a14' : '#fff3e3'};font-weight:700}
      tr.row-live td{background:${darkTheme ? '#16341f' : '#e6f6ec'}}tr.row-next td{background:${darkTheme ? '#1d2a3a' : '#eef3ff'}}tr.row-done{opacity:.6}
      .tag{display:inline-block;font-size:.7rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;border:1px solid currentColor;padding:0 .3rem;margin-right:.2rem}
      .bracket{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);gap:1rem;overflow-x:auto;margin-top:1.5rem;align-items:start}
      .stage h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;opacity:.7;margin:0 0 .6rem}
      .bracket-diagram-wrap{margin-top:1rem;overflow:auto;--bd-surface:${darkTheme ? '#1b2732' : '#ffffff'};--bd-ink:${darkTheme ? '#edf3f4' : '#19212c'};--bd-muted:${darkTheme ? '#a6b4c2' : '#687384'};--bd-line:${darkTheme ? '#45525c' : '#c9d0d8'};--bd-advance-bg:${darkTheme ? '#163a26' : '#e5f5ec'};--bd-drop-bg:${darkTheme ? '#3a2a14' : '#fff0e2'}}
      .bracket-diagram-wrap svg{display:block;width:100%;height:auto;min-width:min(100%,640px);max-height:80vh}
      @media(max-width:700px){.bracket-diagram-wrap svg{width:auto;max-width:none;max-height:none}}
      .bracket-legend{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1rem;font-size:.85rem;margin:.6rem 0 0}
      .legend-line{display:inline-block;width:26px;border-top:2px solid #3267d5;margin-right:-.6rem}.legend-line.drop{border-top:2px dashed #c76a10}.legend-line.final{border-top-color:#19875b}
      .bracket-list{margin-top:1rem}.bracket-list summary{cursor:pointer;font-weight:700}
      .heat{border:1px solid ${darkTheme ? '#45525c' : '#c9ceca'};border-left:5px solid #3267d5;padding:.55rem .7rem;margin-bottom:.7rem;break-inside:avoid}
      .heat-lower{border-left-color:#c76a10}.heat-final{border-left-color:#19875b}
      .heat header{display:flex;justify-content:space-between;font-weight:800;border:0;padding:0;gap:.5rem}.heat-meta{font-size:.8rem}
      .heat ol{list-style:none;margin:.4rem 0 0;padding:0}.heat li{display:flex;justify-content:space-between;gap:.5rem;padding:.12rem 0;font:700 1.05rem/1.3 ui-monospace,monospace}
      .heat li.tbd{font:500 .85rem/1.3 system-ui,sans-serif;opacity:.65}.heat li.through strong{color:#19875b}.heat li.out{opacity:.5;text-decoration:line-through}
      body.cue-green{background:${options.goBackgroundColor}!important;color:${readableTextColour(options.goBackgroundColor)}!important;transition:background-color .15s linear}
      body.cue-end{background:${options.endBackgroundColor}!important;color:${readableTextColour(options.endBackgroundColor)}!important;transition:background-color .15s linear}
      body.panel{padding:clamp(.4rem,1.5vmin,1rem)}body.panel main{max-width:none}body.panel main>table:first-child,body.panel .schedule-banner{margin-top:0}
      body.knockout-board,body.custom-board{height:100vh;height:100dvh;overflow:hidden;padding:clamp(.4rem,1.5vmin,1.25rem)}
      body.knockout-board main,body.custom-board main{max-width:none;height:100%;display:flex;flex-direction:column;gap:.6rem;min-height:0}
      .knockout-fit{flex:1;min-height:0;margin:0;display:flex;align-items:center;justify-content:center}
      .knockout-fit svg{width:100%;height:100%;min-width:0;max-height:none}
      .custom-screen{flex:1;min-height:0;display:grid;gap:clamp(.4rem,1vmin,.9rem)}
      .custom-screen.layout-split{grid-template-columns:1fr 1fr}.custom-screen.layout-main-side{grid-template-columns:2fr 1fr}
      .custom-screen.layout-grid{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
      .custom-area{position:relative;min-width:0;min-height:0;overflow:hidden;border:1px solid ${darkTheme ? '#45525c' : '#c9ceca'};border-radius:12px}
      .custom-panel{position:absolute;inset:0;display:flex;flex-direction:column;visibility:hidden;opacity:0;transition:opacity .6s ease}
      .custom-panel.active{visibility:visible;opacity:1}
      .custom-panel iframe{flex:1;width:100%;border:0;background:transparent}
      .panel-caption{padding:.35rem .8rem;font-size:clamp(.7rem,1.4vmin,1rem);font-weight:800;letter-spacing:.1em;text-transform:uppercase;opacity:.7;border-bottom:1px solid ${darkTheme ? '#45525c' : '#c9ceca'}}
      .custom-message{align-items:center;justify-content:center;text-align:center;padding:5%}
      .custom-message h2{font-size:clamp(1.6rem,6vmin,5rem);line-height:1.05;margin:0 0 .4em}
      .custom-message p{font-size:clamp(1.1rem,3.4vmin,2.6rem);line-height:1.3;margin:0;white-space:normal}
      .custom-images{align-items:center;justify-content:center;padding:4%}
      .custom-images img{position:absolute;inset:6%;width:88%;height:88%;object-fit:contain;opacity:0;transition:opacity .8s ease}
      .custom-images img.active{opacity:1}
      .sound-unlock{position:fixed;z-index:2000;right:1rem;bottom:1rem;padding:.7rem 1rem;border:0;border-radius:999px;background:#17242b;color:#fff;font:700 1rem system-ui,sans-serif;box-shadow:0 6px 20px rgb(0 0 0/.35);cursor:pointer}
    </style></head><body class="${display.type === 'corner' ? 'corner-board' : ['timer','arena'].includes(display.type) ? `timer-board${display.type === 'arena' ? ' arena-board' : ''}${options.showTitle ? ' timer-board-has-title' : ' timer-board-no-title'}${options.showPreviousResults ? ' timer-board-with-results' : ''}` : display.type === 'custom' ? 'custom-board' : display.type === 'knockout' ? 'knockout-board' : ''}${panel ? ' panel' : ''}" style="${theme}"><main>${options.showTitle && display.type !== 'corner' ? `<header>${display.logoDataUrl ? `<img src="${escapeHtml(display.logoDataUrl)}" alt="">` : ''}<div><div class="muted">${escapeHtml(display.competition)}</div><h1>${escapeHtml(display.title)}</h1></div></header>` : ''}
    ${content}</main>${liveTimerDisplay || panel || display.type === 'custom' ? '' : `<p class="muted board-footer" id="board-updated">Updated ${escapeHtml(formatCompetitionTime(new Date(display.updatedAt), display.competitionTimezone))}</p>`}
    ${liveTimerDisplay ? `<div id="countdown-overlay" class="countdown-overlay" aria-live="assertive" style="background-color:${displayBackground}"></div>` : ''}
    ${liveTimerDisplay ? `<script>
      const timerEndpoint=${JSON.stringify(panel ? `/api/public/display/${display.slug}/panel/${display.type}` : `/api/public/display/${display.slug}`)};
      const timerNode=document.getElementById('timer-display');
      const stateNode=document.getElementById('timer-state');
      const labelNode=document.getElementById('timer-label');
      const matchNode=document.getElementById('timer-match');
      const arenaNode=document.getElementById('timer-arena');
      const warningNode=document.getElementById('timer-warning');
      const connectionNode=document.getElementById('timer-connection');
      const countdownOverlay=document.getElementById('countdown-overlay');
      const previousResultsNode=document.getElementById('timer-previous-results');
      const cornerDisplay=document.getElementById('corner-display');
      const cornerCodeNode=document.getElementById('corner-team-code');
      const cornerTeamNode=document.getElementById('corner-team-name');
      const cornerPositionNode=document.getElementById('corner-position-number');
      const displayOptions=${JSON.stringify(options)};
      const displayDarkTheme=${JSON.stringify(darkTheme)};
      const countdownPreparationMs=${MATCH_COUNTDOWN_PREPARATION_SECONDS * 1000};
      const countdownTotalMs=${MATCH_COUNTDOWN_TOTAL_SECONDS * 1000};
      let currentMatch=null,serverOffset=0;
      let bestClockRoundTrip=Infinity;
      let syncing=false;
      const renderArena=positions=>{
        if(!arenaNode)return;
        arenaNode.replaceChildren();
        for(const position of positions||[]){
          const cell=document.createElement('div');
          cell.className='arena-cell';
          cell.dataset.spot=String(Number(position.position)-1);
          const colour=/^#[0-9a-f]{6}$/i.test(position.colour||'')?position.colour:'#777777';
          cell.style.borderColor=colour;
          cell.style.backgroundColor=displayOptions.fillCorners?colour:'color-mix(in srgb, '+colour+' 18%, '+(displayDarkTheme?'#111820':'white')+')';
          if(displayOptions.fillCorners){
            const rgb=colour.match(/[0-9a-f]{2}/gi).map(part=>parseInt(part,16));
            cell.style.color=(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])/255>.58?'#111':'#fff';
          }
          if(displayOptions.showPositionNumbers){const spot=document.createElement('span');spot.className='arena-spot';spot.textContent=cell.dataset.spot;cell.append(spot);}
          const code=document.createElement('span');code.className='arena-code';code.textContent=position.teamCode||(currentMatch&&currentMatch.state==='pending'?'TBC':'VACANT');cell.append(code);
          if(displayOptions.showTeamNames&&position.teamName){const team=document.createElement('span');team.className='arena-team';team.textContent=position.teamName;cell.append(team);}
          arenaNode.append(cell);
        }
      };
      const renderPreviousResults=result=>{
        if(!previousResultsNode)return;
        previousResultsNode.replaceChildren();
        if(!result||!Array.isArray(result.scores)||result.scores.length===0){
          previousResultsNode.hidden=true;
          return;
        }
        const heading=document.createElement('div');
        heading.className='previous-results-heading';
        heading.textContent=(result.match_type==='Playoff'?'Previous heat ':'Previous match ')+result.match_number;
        previousResultsNode.append(heading);
        for(const score of result.scores){
          const team=document.createElement('div');
          team.className='previous-result-team';
          const code=document.createElement('strong');
          code.textContent=score.code||'—';
          const detail=document.createElement('span');
          detail.textContent=(score.name?score.name+' · ':'')+score.points+' pts';
          team.append(code,detail);
          previousResultsNode.append(team);
        }
        previousResultsNode.hidden=false;
      };
      const renderClock=()=>{
        const match=currentMatch;
        // Server time from the clock shared with every other screen (falls back to the data-feed estimate).
        const now=window.ServerClock&&window.ServerClock.synced?window.ServerClock.now():performance.timeOrigin+performance.now()+serverOffset;
        if(!match){
          if(timerNode)timerNode.textContent='--:--.-';
          if(labelNode)labelNode.textContent='NO MATCH SCHEDULED';
          if(stateNode)stateNode.textContent='WAITING FOR NEXT MATCH';
          if(countdownOverlay){countdownOverlay.classList.remove('visible');countdownOverlay.textContent='';}
          document.body.classList.remove('cue-red','cue-green','cue-end');
          return;
        }
        let remaining=0;
        let label='MATCH COMPLETE';
        let statusText=String(match.state).replaceAll('_',' ').toUpperCase();
        const countdownStartedAt=match.countdown_started_at?new Date(match.countdown_started_at).getTime():null;
        const actualStartedAt=countdownStartedAt!==null
          ?countdownStartedAt+countdownTotalMs
          :match.actual_start?new Date(match.actual_start).getTime():null;
        if(match.state==='running'){
          remaining=Number(match.duration_seconds)*1000-(now-actualStartedAt-Number(match.paused_seconds||0)*1000);
          label='TIME LEFT';
          statusText='MATCH IN PROGRESS';
        }else if(match.state==='paused'){
          remaining=Number(match.duration_seconds)*1000-(new Date(match.paused_at).getTime()-actualStartedAt-Number(match.paused_seconds||0)*1000);
          label='TIME LEFT · PAUSED';
          statusText='MATCH PAUSED';
        }else if(['scheduled','ready','delayed','pending'].includes(match.state)){
          remaining=new Date(match.effective_start).getTime()-now;
          label='STARTS IN';
          statusText='UP NEXT';
          if(remaining<=0&&!match.countdown_started_at){
            // Its time has come but nobody has started it: show the full match time, not a fake 00:00.
            remaining=Number(match.duration_seconds)*1000;
            label='MATCH LENGTH';
            statusText='WAITING TO START';
          }
          if(match.countdown_started_at){
            const goAt=new Date(match.countdown_started_at).getTime()+countdownTotalMs;
            remaining=goAt-now;
            label='STARTS IN';
            statusText=remaining>0?'STARTING IN '+Math.max(1,Math.ceil(remaining/1000)):'GO';
          }
        }else if(match.state==='awaiting_score'){
          label='MATCH OVER';
          statusText='MATCH OVER';
        }
        remaining=Math.max(0,remaining);
        const cueGoAt=countdownStartedAt!==null?countdownStartedAt+countdownTotalMs:actualStartedAt;
        const inGoCue=cueGoAt!==null&&now>=cueGoAt&&now<cueGoAt+displayOptions.cueDurationSeconds*1000;
        const inRedCue=countdownStartedAt!==null&&cueGoAt!==null&&now<cueGoAt;
        const timerEndAt=actualStartedAt===null?null:actualStartedAt+
          (Number(match.duration_seconds)+Number(match.paused_seconds||0))*1000;
        const reportedEndAt=match.actual_end?new Date(match.actual_end).getTime():null;
        const endCueAt=reportedEndAt!==null&&timerEndAt!==null?Math.min(reportedEndAt,timerEndAt):reportedEndAt??timerEndAt;
        if(window.ccScheduleBeep){
          if(countdownStartedAt!==null){
            for(let beep=0;beep<3;beep++)ccScheduleBeep(countdownStartedAt+countdownPreparationMs+beep*1000,'tick');
            ccScheduleBeep(countdownStartedAt+countdownTotalMs,'go');
          }
          if(match.state==='running'&&timerEndAt!==null)ccScheduleBeep(timerEndAt,'end');
        }
        const inEndCue=displayOptions.showEndCue&&match.state!=='paused'&&endCueAt!==null&&now>=endCueAt&&
          now<endCueAt+displayOptions.endCueDurationSeconds*1000;
        const tenths=Math.floor((remaining%1000)/100);
        document.body.classList.toggle('cue-red',displayOptions.showStartCue&&inRedCue);
        document.body.classList.toggle('cue-green',displayOptions.showStartCue&&inGoCue&&!inEndCue);
        document.body.classList.toggle('cue-end',inEndCue);
        const timerText=inEndCue?'END':statusText.startsWith('STARTING IN')?String(Math.max(1,Math.ceil(remaining/1000))):statusText==='GO'?'GO':
          String(Math.floor(remaining/60000)).padStart(2,'0')+':'+String(Math.floor(remaining/1000)%60).padStart(2,'0')+'.'+tenths;
        if(timerNode)timerNode.textContent=timerText;
        if(stateNode)stateNode.textContent=statusText;
        if(labelNode)labelNode.textContent=label;
        if(countdownOverlay){
          const goAt=countdownStartedAt!==null?countdownStartedAt+countdownTotalMs:actualStartedAt;
          let countdownText=null;
          let countdownBackground=displayOptions.countdownBackgroundColor;
          if(countdownStartedAt!==null){
            const elapsed=now-countdownStartedAt;
            if(elapsed>=0&&elapsed<countdownPreparationMs){
              countdownText='GET READY';
            }else if(elapsed>=countdownPreparationMs&&elapsed<countdownTotalMs){
              const secondsRemaining=Math.ceil((countdownTotalMs-elapsed)/1000);
              countdownText=String(secondsRemaining);
              if(displayOptions.flashCountdownNumbers&&secondsRemaining%2===0){
                countdownBackground=displayOptions.countdownFlashColor;
              }
            }else if(goAt!==null&&now>=goAt&&now<goAt+displayOptions.cueDurationSeconds*1000){
              countdownText='GO';
              countdownBackground=displayOptions.goBackgroundColor;
            }
          }else if(goAt!==null&&now>=goAt&&now<goAt+displayOptions.cueDurationSeconds*1000){
            countdownText='GO';
            countdownBackground=displayOptions.goBackgroundColor;
          }
          const endCountdownText=match.state==='running'&&displayOptions.showEndCountdown
            ?Math.max(0,Math.ceil(remaining/1000)):null;
          if(endCountdownText!==null&&remaining>0&&remaining<=displayOptions.endCountdownSeconds*1000){
            countdownText=endCountdownText;
            countdownBackground=${JSON.stringify(options.endBackgroundColor)};
          }
          if(inEndCue){
            countdownText='END';
            countdownBackground=${JSON.stringify(options.endBackgroundColor)};
          }
          countdownOverlay.textContent=inEndCue?'END':countdownText||'';
          countdownOverlay.style.backgroundColor=countdownBackground;
          countdownOverlay.style.color=(parseInt(countdownBackground.slice(1,3),16)*.2126+parseInt(countdownBackground.slice(3,5),16)*.7152+parseInt(countdownBackground.slice(5,7),16)*.0722>148?'#111':'#fff');
          countdownOverlay.classList.toggle('ready',countdownText==='GET READY');
          countdownOverlay.classList.toggle('end',countdownText==='END');
          countdownOverlay.classList.toggle('visible',countdownText!==null||inEndCue);
        }
      };
      const syncDisplay=async()=>{
        if(syncing)return;
        syncing=true;
        const started=performance.now();
        try{
          const response=await fetch(timerEndpoint,{cache:'no-store'});
          if(!response.ok)throw new Error('Live display request failed ('+response.status+')');
          const payload=await response.json();
          const finished=performance.now();
          const serverTime=response.headers.get('x-server-time');
          const roundTrip=finished-started;
          const measuredOffset=Date.parse(serverTime||payload.updatedAt)-(performance.timeOrigin+(started+finished)/2);
          if(roundTrip<bestClockRoundTrip){
            bestClockRoundTrip=roundTrip;
            serverOffset=measuredOffset;
          }else{
            const offsetError=Math.max(-10,Math.min(10,measuredOffset-serverOffset));
            serverOffset+=offsetError*.1;
          }
          currentMatch=payload.data&& !Array.isArray(payload.data)?payload.data:null;
          renderPreviousResults(payload.previousResults);
          if(cornerDisplay){
            const cornerPosition=currentMatch?.positions?.find(position=>Number(position.spot)===displayOptions.cornerPosition);
            const cornerColour=/^#[0-9a-f]{6}$/i.test(cornerPosition?.colour||'')?cornerPosition.colour:'#777777';
            if(cornerCodeNode)cornerCodeNode.textContent=cornerPosition?.teamCode||(currentMatch&&currentMatch.state==='pending'?'TBC':'VACANT');
            if(cornerTeamNode)cornerTeamNode.textContent=cornerPosition?.teamName||'';
            if(cornerPositionNode)cornerPositionNode.textContent=String(displayOptions.cornerPosition);
            cornerDisplay.style.backgroundColor=displayOptions.fillCornerDisplay?cornerColour:${JSON.stringify(displayBackground)};
            if(displayOptions.fillCornerDisplay){
              const rgb=cornerColour.match(/[0-9a-f]{2}/gi).map(part=>parseInt(part,16));
              cornerDisplay.style.color=(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])/255>.58?'#111111':'#ffffff';
            }else{
              cornerDisplay.style.color=${JSON.stringify(darkTheme ? '#edf3f4' : '#17242b')};
            }
            if(countdownOverlay){
              countdownOverlay.style.backgroundColor=displayOptions.fillCornerDisplay?cornerColour:${JSON.stringify(displayBackground)};
              countdownOverlay.style.color=cornerDisplay.style.color;
            }
          }
          if(matchNode)matchNode.textContent=currentMatch&&currentMatch.match_number
            ?'Match '+currentMatch.match_number+(displayOptions.showArena?' · '+currentMatch.arena_name:'')
            :'No upcoming match';
          if(stateNode)stateNode.textContent=currentMatch?String(currentMatch.state).replaceAll('_',' ').toUpperCase():'';
          if(warningNode)warningNode.textContent=currentMatch&&Number(currentMatch.team_count)<4
            ?'UNDERFILLED MATCH · '+currentMatch.team_count+'/4 POSITIONS':'';
          renderArena(currentMatch&&currentMatch.positions);
          if(connectionNode){connectionNode.textContent='Live · synchronized '+new Date(payload.updatedAt).toLocaleTimeString();connectionNode.style.color='';}
          renderClock();
        }catch(error){
          if(connectionNode){connectionNode.textContent='Live connection lost · retrying';connectionNode.style.color='#b33';}
          console.error(error);
        }finally{
          syncing=false;
        }
      };
      void syncDisplay();
      setInterval(()=>{void syncDisplay();},1000);
      // Changes (a start, a pause, a new match) arrive at once instead of on the next poll.
      ccOnRevision(()=>{void syncDisplay();});
      const renderClockFrame=()=>{renderClock();requestAnimationFrame(renderClockFrame);};
      requestAnimationFrame(renderClockFrame);
    </script>` : ''}
    ${liveTimerDisplay || display.type === 'custom' ? '' : `<script>
      // Boards refresh in place (no full-page reload) so they never flash, and keep the team filter.
      const filterStorageKey=${JSON.stringify(`schedule-team-filter:${display.slug}`)};
      const applyScheduleFilter=()=>{
        const filter=document.getElementById('schedule-team-filter');
        if(!filter)return;
        const selected=filter.value;
        for(const row of document.querySelectorAll('tbody tr[data-team-codes]')){
          row.hidden=Boolean(selected)&&!row.dataset.teamCodes.split(',').includes(selected);
        }
      };
      const restoreScheduleFilter=()=>{
        const filter=document.getElementById('schedule-team-filter');
        if(!filter)return;
        try{filter.value=sessionStorage.getItem(filterStorageKey)||'';}catch{}
        applyScheduleFilter();
      };
      document.addEventListener('change',event=>{
        if(event.target.id!=='schedule-team-filter')return;
        try{sessionStorage.setItem(filterStorageKey,event.target.value);}catch{}
        applyScheduleFilter();
      });
      const renderRelativeTimes=()=>{
        for(const node of document.querySelectorAll('[data-relative-time]')){
          const delta=Number(node.dataset.relativeTime)-(window.ServerClock?window.ServerClock.now():Date.now());
          const seconds=Math.floor(Math.abs(delta)/1000);
          let duration;
          if(seconds<60)duration=seconds<=1?'1 second':seconds+' seconds';
          else if(seconds<3600){const minutes=Math.floor(seconds/60);duration=minutes+' minute'+(minutes===1?'':'s');}
          else if(seconds<86400){const hours=Math.floor(seconds/3600);const minutes=Math.floor(seconds%3600/60);duration=hours+' hour'+(hours===1?'':'s')+(minutes?' '+minutes+' minute'+(minutes===1?'':'s'):'');}
          else{const days=Math.floor(seconds/86400);const hours=Math.floor(seconds%86400/3600);duration=days+' day'+(days===1?'':'s')+(hours?' '+hours+' hour'+(hours===1?'':'s'):'');}
          node.textContent=delta>=0?'in '+duration:duration+' ago';
        }
      };
      const refreshBoard=async()=>{
        if(document.activeElement&&document.activeElement.id==='schedule-team-filter')return;
        try{
          const response=await fetch(location.href,{cache:'no-store'});
          if(!response.ok)return;
          const next=new DOMParser().parseFromString(await response.text(),'text/html');
          const nextMain=next.querySelector('main');
          const main=document.querySelector('main');
          if(nextMain&&main&&nextMain.innerHTML!==main.innerHTML){
            main.innerHTML=nextMain.innerHTML;
            restoreScheduleFilter();
            renderRelativeTimes();
          }
          const updated=document.getElementById('board-updated');
          const nextUpdated=next.getElementById('board-updated');
          if(updated&&nextUpdated){updated.textContent=nextUpdated.textContent;updated.style.color='';}
        }catch{
          const updated=document.getElementById('board-updated');
          if(updated){updated.textContent='Connection lost · retrying';updated.style.color='#b33';}
        }
      };
      restoreScheduleFilter();
      renderRelativeTimes();
      setInterval(renderRelativeTimes,1000);
      setInterval(()=>{void refreshBoard();},5000);
      ccOnRevision(()=>{setTimeout(()=>void refreshBoard(),150);});
    </script>`}${audio ? `<script>${audioPlayerScript({ stateUrl: `/api/public/audio/${encodeURIComponent(display.competitionSlug)}`, volume: options.audioVolume, speakerDelayMs: options.speakerDelayMs })}</script>` : ''}${display.type === 'custom' ? `<script>${customScreenScript({ rotateMs: options.customRotateSeconds * 1000, imageMs: options.customImageSeconds * 1000 })}</script>` : ''}</body></html>`);
}
