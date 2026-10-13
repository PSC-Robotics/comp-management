import {
  JUST_FINISHED_SECONDS,
  MATCH_COUNTDOWN_TOTAL_SECONDS,
  type DisplayOptions
} from './display.js';

export type SrPosition = {
  position_number: number;
  team_code: string | null;
  colour: string;
};

export type SrMatchInput = {
  match_number: number;
  arena_name: string;
  scheduled_start: Date | string;
  effective_start: Date | string;
  duration_seconds: number;
  planned_gap_seconds: number;
  actual_start: Date | string | null;
  actual_end: Date | string | null;
  countdown_started_at: Date | string | null;
  paused_at: Date | string | null;
  paused_seconds: number;
  state: string;
  positions: SrPosition[];
  scores?: Record<string, number> | null;
  bracket_side?: string;
  round_number?: number;
  /** Staging window computed on the server (see domain/staging.ts); the same for every screen. */
  staging?: { opens: number; closes: number; signalShepherds: number };
};

function date(value: Date | string): Date {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new RangeError('SRComp match time must be a valid date');
  }
  return result;
}

export function toSrMatch(input: SrMatchInput): Record<string, unknown> {
  const slotStart = date(input.effective_start);
  const gameStart = input.countdown_started_at
    ? new Date(date(input.countdown_started_at).getTime() + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000)
    : input.actual_start
      ? date(input.actual_start)
      : slotStart;
  const estimatedGameEnd = new Date(gameStart.getTime() + input.duration_seconds * 1000);
  estimatedGameEnd.setTime(estimatedGameEnd.getTime() + input.paused_seconds * 1000);
  const gameEnd = input.actual_end ? date(input.actual_end) : estimatedGameEnd;
  const slotEnd = new Date(
    slotStart.getTime() + (input.duration_seconds + input.planned_gap_seconds) * 1000
  );
  const teams: Record<string, string | null> = {};
  for (let position = 0; position < 4; position += 1) teams[String(position)] = null;
  for (const entry of input.positions) {
    teams[String(entry.position_number - 1)] = entry.team_code;
  }

  return {
    num: input.match_number,
    display_name: `Match ${input.match_number}`,
    arena: input.arena_name,
    teams,
    scores: input.scores && Object.keys(input.scores).length > 0 ? input.scores : null,
    state: input.state,
    paused_at: input.paused_at ? date(input.paused_at).toISOString() : null,
    countdown_started_at: input.countdown_started_at
      ? date(input.countdown_started_at).toISOString()
      : null,
    actual_end: input.actual_end ? date(input.actual_end).toISOString() : null,
    team_count: input.positions.filter((entry) => entry.team_code !== null).length,
    ...(input.bracket_side === undefined ? {} : { knockout_bracket: input.bracket_side }),
    ...(input.round_number === undefined ? {} : { round_number: input.round_number }),
    times: {
      slot: { start: slotStart.toISOString(), end: slotEnd.toISOString() },
      game: { start: gameStart.toISOString(), end: gameEnd.toISOString() },
      staging: input.staging
        ? {
          opens: new Date(input.staging.opens).toISOString(),
          closes: new Date(input.staging.closes).toISOString(),
          signal_shepherds: { [input.arena_name]: new Date(input.staging.signalShepherds).toISOString() }
        }
        : {
          opens: new Date(slotStart.getTime() - 10 * 60 * 1000).toISOString(),
          closes: slotStart.toISOString(),
          signal_shepherds: {
            [input.arena_name]: new Date(slotStart.getTime() - 5 * 60 * 1000).toISOString()
          }
        }
    }
  };
}

export function toSrMatches(inputs: SrMatchInput[]): Record<string, unknown>[] {
  return inputs.map((input) => toSrMatch(input));
}

export function selectSrMatchFeed<T>(
  leagueMatches: T[],
  playoffMatches: T[],
  type: string
): T[] {
  if (type === 'knockout') return playoffMatches;
  if (type === 'all') return [...leagueMatches, ...playoffMatches];
  return leagueMatches;
}

export function selectSrDisplayMatches<T extends SrMatchInput>(
  matches: T[],
  now = new Date()
): T[] {
  const nowMs = now.getTime();
  const selected = new Map<string, { match: T; priority: number }>();

  for (const match of matches) {
    if (match.state === 'cancelled') continue;
    const effectiveStart = date(match.effective_start).getTime();
    const countdownStart = match.countdown_started_at
      ? date(match.countdown_started_at).getTime()
      : null;
    const countdownActive = countdownStart !== null &&
      nowMs >= countdownStart &&
      nowMs < countdownStart + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000 &&
      ['scheduled', 'ready', 'delayed'].includes(match.state);
    // A match whose time has come stays the current one until it is started, however late.
    // A heat waiting for earlier results ('pending') still runs in its turn, so it is shown in its place.
    const due = ['scheduled', 'ready', 'delayed', 'pending'].includes(match.state) && nowMs >= effectiveStart;
    const upcoming = ['scheduled', 'ready', 'delayed', 'pending'].includes(match.state) &&
      effectiveStart > nowMs;
    // Unscored matches count as finished too, so the screen does not skip their END.
    const completed = ['complete', 'awaiting_score'].includes(match.state) && match.actual_end !== null;
    const justFinished = completed && nowMs - date(match.actual_end!).getTime() < JUST_FINISHED_SECONDS * 1000;

    const priority = countdownActive ? 0
      : match.state === 'running' ? 1
        : match.state === 'paused' ? 2
          : justFinished ? 2.5
            : due ? 3
              : upcoming ? 4
                : completed ? 5
                : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(priority)) continue;

    const current = selected.get(match.arena_name);
    const byEnd = priority === 5 || priority === 2.5;
    const matchTime = byEnd ? date(match.actual_end!).getTime() : effectiveStart;
    const currentTime = current
      ? current.priority === 5 || current.priority === 2.5
        ? date(current.match.actual_end!).getTime()
        : date(current.match.effective_start).getTime()
      : Number.POSITIVE_INFINITY;
    if (!current || priority < current.priority ||
        (priority === current.priority &&
          (byEnd ? matchTime > currentTime : matchTime < currentTime))) {
      selected.set(match.arena_name, { match, priority });
    }
  }

  return [...selected.values()]
    .sort((left, right) =>
      left.match.arena_name.localeCompare(right.match.arena_name) ||
      left.priority - right.priority
    )
    .map(({ match }) => match);
}

export function buildSrDisplayConfig(options: DisplayOptions) {
  const outsideTagNames: Record<string, string> = {
    leaderboard: 'sr-leaderboard',
    schedule: 'sr-competitor-schedule',
    knockout: 'sr-knockout-diagram'
  };
  return {
    hideOutsidePages: options.srHideOutsidePages
      .filter((page) => page !== 'results')
      .map((page) => outsideTagNames[page]),
    externalUrl: options.srExternalUrl || '',
    maxTeams: options.srMaxTeams,
    maxKnockoutRounds: options.srMaxKnockoutRounds,
    shepherdingPastMatches: options.srShepherdingPastMatches,
    stagingCornersList: options.srStagingCornerOrder.map(String),
    rotationSeconds: options.srRotationSeconds,
    displayOptions: {
      showStartCue: options.showStartCue,
      showEndCue: options.showEndCue,
      showEndCountdown: options.showEndCountdown,
      flashCountdownNumbers: options.flashCountdownNumbers,
      countdownBackgroundColor: options.countdownBackgroundColor,
      countdownFlashColor: options.countdownFlashColor,
      goBackgroundColor: options.goBackgroundColor,
      endBackgroundColor: options.endBackgroundColor,
      endCountdownSeconds: options.endCountdownSeconds,
      cueDurationSeconds: options.cueDurationSeconds,
      endCueDurationSeconds: options.endCueDurationSeconds,
      clockOffsetMs: 0
    }
  };
}

export function groupSrKnockoutMatches(
  matches: Array<Record<string, unknown> & { round_number: number }>
): Array<Array<Record<string, unknown>>> {
  const rounds = new Map<number, Array<Record<string, unknown>>>();
  for (const match of matches) {
    const round = rounds.get(match.round_number) ?? [];
    round.push(match);
    rounds.set(match.round_number, round);
  }
  return [...rounds.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, round]) => round);
}
