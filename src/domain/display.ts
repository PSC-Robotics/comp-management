import { z } from 'zod';

export const displayTypeSchema = z.enum([
  'league', 'schedule', 'arena', 'timer', 'corner', 'results', 'playoffs', 'knockout', 'custom',
  'sr-arena', 'sr-outside', 'sr-producer', 'sr-shepherding', 'sr-staging'
]);

const srOutsidePageSchema = z.enum(['leaderboard', 'schedule', 'results', 'knockout']);

/** What a custom screen can show in each of its areas. */
export const customPanelSchema = z.enum(['schedule', 'league', 'knockout', 'results', 'timer', 'message', 'images']);
export type CustomPanel = z.infer<typeof customPanelSchema>;
/** How many areas each custom layout has. */
export const customLayoutAreas = { full: 1, split: 2, 'main-side': 2, grid: 4 } as const;

export const displayOptionsSchema = z.object({
  showTitle: z.boolean().default(true),
  showArena: z.boolean().default(true),
  fillCorners: z.boolean().default(false),
  showTeamNames: z.boolean().default(true),
  showPositionNumbers: z.boolean().default(true),
  fillCornerDisplay: z.boolean().default(true),
  showCornerTeamName: z.boolean().default(true),
  showCornerPositionNumber: z.boolean().default(true),
  // Retained for older saved display records; clocks are no longer rendered inside arena cells.
  showCornerTimers: z.boolean().default(false),
  showStartCue: z.boolean().default(false),
  showEndCue: z.boolean().default(false),
  showEndCountdown: z.boolean().default(false),
  showPreviousResults: z.boolean().default(false),
  flashCountdownNumbers: z.boolean().default(false),
  darkTheme: z.boolean().default(false),
  hideCompletedEvents: z.boolean().default(false),
  hideCompletedMatches: z.boolean().default(false),
  enableTeamFilter: z.boolean().default(false),
  relativeTime: z.boolean().default(false),
  // Retained for older saved displays: now folded into showArena (see the admin form).
  hideScheduleArena: z.boolean().default(false),
  cornerPosition: z.number().int().min(0).max(3).default(0),
  countdownBackgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#a21f24'),
  countdownFlashColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
  goBackgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#167847'),
  endBackgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#b3131b'),
  endCountdownSeconds: z.number().int().min(1).max(60).default(10),
  cueDurationSeconds: z.number().int().min(1).max(5).default(2),
  endCueDurationSeconds: z.number().int().min(1).max(10).default(3),
  srArenaName: z.string().trim().max(120).default(''),
  srMaxTeams: z.number().int().min(1).max(32).default(6),
  srMaxKnockoutRounds: z.number().int().min(1).max(12).default(5),
  srShepherdingPastMatches: z.number().int().min(0).max(5).default(1),
  // Retained for older saved displays: staging windows are now a competition setting (Arena page).
  srStagingCloseOffsetMinutes: z.number().int().min(0).max(30).default(5),
  srHideOutsidePages: z.array(srOutsidePageSchema).max(3).default([]),
  srStagingCornerOrder: z.array(z.number().int().min(0).max(3)).length(4)
    .refine((positions) => new Set(positions).size === 4).default([0, 3, 2, 1]),
  srRotationSeconds: z.number().int().min(5).max(120).default(15),
  srExternalUrl: z.string().trim().max(500).refine((url) => {
    if (!url) return true;
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  }, 'External URL must use HTTP or HTTPS').default(''),
  // Race-style beeps for 3, 2, 1, GO (and a horn at END) on live screens.
  countdownBeeps: z.boolean().default(false),
  beepVolume: z.number().int().min(0).max(100).default(80),
  // This screen plays the competition's music / live audio.
  playAudio: z.boolean().default(false),
  audioVolume: z.number().int().min(0).max(100).default(100),
  // How late this screen's speaker (TV, soundbar, Bluetooth) plays sound; the screen plays that much early.
  speakerDelayMs: z.number().int().min(0).max(1000).default(0),
  // Custom screen: a layout of areas, each rotating through its panels.
  customLayout: z.enum(['full', 'split', 'main-side', 'grid']).default('full'),
  customAreas: z.array(z.array(customPanelSchema).max(7)).max(4).default([['schedule', 'league']]),
  customRotateSeconds: z.number().int().min(5).max(600).default(20),
  customMessageTitle: z.string().trim().max(120).default(''),
  customMessageBody: z.string().trim().max(2000).default(''),
  customImageIds: z.array(z.string().uuid()).max(50).default([]),
  customImageSeconds: z.number().int().min(3).max(300).default(8)
}).strict();

export const MATCH_COUNTDOWN_PREPARATION_SECONDS = 2;
export const MATCH_COUNTDOWN_SECONDS = 3;
export const MATCH_COUNTDOWN_TOTAL_SECONDS =
  MATCH_COUNTDOWN_PREPARATION_SECONDS + MATCH_COUNTDOWN_SECONDS;

export const defaultCornerColours = ['#d1495b', '#00798c', '#edae49', '#30638e'] as const;

export const cornerColoursSchema = z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).length(4)
  .superRefine((colours, context) => {
    if (new Set(colours.map((colour) => colour.toLowerCase())).size !== 4) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Each arena position must have a different colour' });
    }
  });

export type DisplayOptions = z.infer<typeof displayOptionsSchema>;

/**
 * How long a match that just finished stays on live screens: long enough for the default END cue, then
 * the screens move straight on to the next match (they never sit on "awaiting score").
 */
export const JUST_FINISHED_SECONDS = 4;

/**
 * Which match a live screen shows, lowest first: a start countdown, then a
 * running or paused match, then one that finished moments ago (scored or not,
 * so the END cue always shows), then the next scheduled match. Older finished
 * matches come last. Every live screen uses this order so they never disagree.
 */
export function publicMatchPriority(
  state: string,
  hasCountdown: boolean,
  actualEnd: Date | string | number | null = null,
  now = Date.now(),
  justFinishedSeconds = JUST_FINISHED_SECONDS
): number {
  if (hasCountdown) return 0;
  if (state === 'running') return 1;
  if (state === 'paused') return 2;
  if (state === 'awaiting_score' || state === 'complete') {
    const ended = actualEnd === null ? Number.NaN : new Date(actualEnd).getTime();
    return Number.isFinite(ended) && now - ended < justFinishedSeconds * 1000 ? 3 : 5;
  }
  return 4;
}

export function formatCompetitionTime(value: Date | string | number, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Schedule time must be a valid date');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

export function formatCompetitionDateTime(value: Date | string | number, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Schedule time must be a valid date');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function readableTextColour(colour: string): '#111111' | '#ffffff' {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return '#111111';
  const red = Number.parseInt(colour.slice(1, 3), 16);
  const green = Number.parseInt(colour.slice(3, 5), 16);
  const blue = Number.parseInt(colour.slice(5, 7), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.58 ? '#111111' : '#ffffff';
}

export function getEndCountdownCue(
  remainingMilliseconds: number,
  enabled: boolean,
  durationSeconds: number
): string | null {
  if (!enabled || !Number.isFinite(remainingMilliseconds) ||
      !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60 ||
      remainingMilliseconds <= 0 || remainingMilliseconds > durationSeconds * 1000) {
    return null;
  }
  return String(Math.ceil(remainingMilliseconds / 1000));
}

export type StartCue = {
  text: string | null;
  colour: 'ready' | 'red' | 'flash' | 'green' | 'end' | null;
};

export function getStartCue(
  countdownStartedAt: number | null,
  actualStartedAt: number | null,
  now: number,
  enabled: boolean,
  durationSeconds: number,
  actualEndedAt: number | null = null,
  endCueEnabled = false,
  endCueDurationSeconds = 3,
  flashNumbers = false
): StartCue {
  if (!Number.isFinite(now)) return { text: null, colour: null };
  if (endCueEnabled && actualEndedAt !== null && Number.isFinite(actualEndedAt) &&
      Number.isInteger(endCueDurationSeconds) && endCueDurationSeconds >= 1 &&
      endCueDurationSeconds <= 10 && now >= actualEndedAt &&
      now < actualEndedAt + endCueDurationSeconds * 1000) {
    return { text: 'END', colour: 'end' };
  }
  if (!enabled || !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 5) {
    return { text: null, colour: null };
  }
  const countdownAt = countdownStartedAt !== null && Number.isFinite(countdownStartedAt)
    ? countdownStartedAt
    : null;
  const goAt = countdownAt !== null
    ? countdownAt + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000
    : actualStartedAt !== null && Number.isFinite(actualStartedAt)
      ? actualStartedAt
      : null;
  if (countdownAt !== null && goAt !== null) {
    const elapsed = now - countdownAt;
    if (elapsed >= 0 && elapsed < MATCH_COUNTDOWN_PREPARATION_SECONDS * 1000) {
      return { text: 'GET READY', colour: 'ready' };
    }
    const millisecondsToGo = goAt - now;
    if (millisecondsToGo > 0) {
      const secondsRemaining = Math.ceil(millisecondsToGo / 1000);
      const colour = flashNumbers && secondsRemaining % 2 === 0 ? 'flash' : 'red';
      return { text: String(secondsRemaining), colour };
    }
  }
  if (goAt !== null && now >= goAt && now < goAt + durationSeconds * 1000) {
    return { text: 'GO', colour: 'green' };
  }
  return { text: null, colour: null };
}

/** How long before a countdown begins that it is announced, so every screen has it in time. */
export const COUNTDOWN_LEAD_MS = 1000;
/** Auto-run arms a countdown this long before it begins, for the same reason. */
export const COUNTDOWN_PREARM_SECONDS = 2;

/**
 * When a countdown should begin. Countdowns start on a whole server second at
 * least COUNTDOWN_LEAD_MS ahead: SR screens redraw on whole server seconds and
 * every screen needs the start time before it happens, so all of them show
 * GET READY, 3, 2, 1 and GO at the same instant. A scheduled start (auto-run)
 * counts down to its slot when there is still time, otherwise starts promptly.
 */
export function countdownStartTime(now: number, scheduledStart?: number): number {
  const earliest = Math.ceil((now + COUNTDOWN_LEAD_MS) / 1000) * 1000;
  if (scheduledStart === undefined) return earliest;
  const toSlot = Math.ceil(scheduledStart / 1000) * 1000 - MATCH_COUNTDOWN_TOTAL_SECONDS * 1000;
  return Math.max(toSlot, earliest);
}
