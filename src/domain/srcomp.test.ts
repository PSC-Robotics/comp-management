import assert from 'node:assert/strict';
import test from 'node:test';
import { displayOptionsSchema } from './display.js';
import {
  buildSrDisplayConfig,
  groupSrKnockoutMatches,
  selectSrMatchFeed,
  selectSrDisplayMatches,
  toSrMatch,
  toSrMatches,
  type SrMatchInput
} from './srcomp.js';

const baseMatch: SrMatchInput = {
  match_number: 7,
  arena_name: 'Arena 1',
  scheduled_start: '2026-04-10T10:00:00.000Z',
  effective_start: '2026-04-10T10:05:00.000Z',
  duration_seconds: 120,
  planned_gap_seconds: 180,
  actual_start: null,
  actual_end: null,
  countdown_started_at: null,
  paused_at: null,
  paused_seconds: 0,
  state: 'scheduled',
  positions: [
    { position_number: 1, team_code: 'AAA', colour: '#d1495b' },
    { position_number: 2, team_code: null, colour: '#00798c' },
    { position_number: 3, team_code: 'CCC', colour: '#edae49' },
    { position_number: 4, team_code: null, colour: '#30638e' }
  ]
};

test('maps schedule matches into the SR screen timing, team, and vacancy shape', () => {
  const match = toSrMatch(baseMatch);
  assert.equal(match.num, 7);
  assert.equal(match.display_name, 'Match 7');
  assert.equal(match.team_count, 2);
  assert.deepEqual(match.teams, { '0': 'AAA', '1': null, '2': 'CCC', '3': null });
  assert.deepEqual(match.times, {
    slot: {
      start: '2026-04-10T10:05:00.000Z',
      end: '2026-04-10T10:10:00.000Z'
    },
    game: {
      start: '2026-04-10T10:05:00.000Z',
      end: '2026-04-10T10:07:00.000Z'
    },
    staging: {
      opens: '2026-04-10T09:55:00.000Z',
      closes: '2026-04-10T10:05:00.000Z',
      signal_shepherds: { 'Arena 1': '2026-04-10T10:00:00.000Z' }
    }
  });
});

test('uses actual and countdown starts plus pauses when mapping running timers', () => {
  const countdown = toSrMatch({
    ...baseMatch,
    actual_start: '2026-04-10T10:05:01.000Z',
    countdown_started_at: '2026-04-10T10:04:55.000Z'
  });
  assert.equal(
    (countdown.times as { game: { start: string } }).game.start,
    '2026-04-10T10:05:00.000Z'
  );

  const paused = toSrMatch({
    ...baseMatch,
    actual_start: '2026-04-10T10:00:00.000Z',
    paused_at: '2026-04-10T10:01:00.000Z',
    paused_seconds: 5,
    state: 'paused'
  });
  assert.equal(
    (paused.times as { game: { end: string } }).game.end,
    '2026-04-10T10:02:05.000Z'
  );
});

test('keeps native SR staging windows anchored to each match slot', () => {
  const first = { ...baseMatch, match_number: 1, effective_start: '2026-04-10T10:00:00.000Z' };
  const next = { ...baseMatch, match_number: 2, effective_start: '2026-04-10T10:08:00.000Z' };
  const [firstSr, nextSr] = toSrMatches([first, next]) as Array<{
    times: { staging: { opens: string; closes: string; signal_shepherds: Record<string, string> } };
  }>;

  assert.equal(firstSr!.times.staging.opens, '2026-04-10T09:50:00.000Z');
  assert.equal(firstSr!.times.staging.closes, '2026-04-10T10:00:00.000Z');
  assert.equal(nextSr!.times.staging.opens, '2026-04-10T09:58:00.000Z');
  assert.equal(nextSr!.times.staging.closes, '2026-04-10T10:08:00.000Z');
  assert.equal(nextSr!.times.staging.signal_shepherds['Arena 1'], '2026-04-10T10:03:00.000Z');
});

test('keeps native staging windows independent of other matches and arenas', () => {
  const first = {
    ...baseMatch,
    match_number: 1,
    state: 'running',
    effective_start: '2026-04-10T10:00:00.000Z',
    actual_start: '2026-04-10T10:00:02.000Z',
    countdown_started_at: '2026-04-10T09:59:57.000Z'
  };
  const sameArena = {
    ...baseMatch,
    match_number: 2,
    effective_start: '2026-04-10T10:08:00.000Z'
  };
  const otherArena = {
    ...baseMatch,
    match_number: 3,
    arena_name: 'Arena 2',
    effective_start: '2026-04-10T10:08:00.000Z'
  };
  const mapped = toSrMatches([sameArena, first, otherArena]) as Array<{
    times: { staging: { opens: string } };
  }>;

  assert.equal(mapped[0]!.times.staging.opens, '2026-04-10T09:58:00.000Z');
  assert.equal(mapped[1]!.times.staging.opens, '2026-04-10T09:50:00.000Z');
  assert.equal(mapped[2]!.times.staging.opens, '2026-04-10T09:58:00.000Z');
});

test('keeps league and playoff schedules in separate SR match feeds', () => {
  const league = [{ num: 1, source: 'league' }];
  const playoffs = [{ num: 1, source: 'playoff' }];
  assert.deepEqual(selectSrMatchFeed(league, playoffs, ''), league);
  assert.deepEqual(selectSrMatchFeed(league, playoffs, 'league'), league);
  assert.deepEqual(selectSrMatchFeed(league, playoffs, 'knockout'), playoffs);
  assert.deepEqual(selectSrMatchFeed(league, playoffs, 'all'), [...league, ...playoffs]);
});

test('selects one stable next-or-active SR match per arena and ignores old awaiting-score matches', () => {
  const now = new Date('2026-04-10T10:00:00.000Z');
  const matches = [
    { ...baseMatch, match_number: 1, state: 'awaiting_score', actual_end: '2026-04-10T09:00:00Z' },
    { ...baseMatch, match_number: 2, effective_start: '2026-04-10T10:05:00Z' },
    { ...baseMatch, match_number: 3, effective_start: '2026-04-10T10:10:00Z' },
    { ...baseMatch, match_number: 4, arena_name: 'Arena 2', state: 'running' }
  ];

  assert.deepEqual(
    selectSrDisplayMatches(matches, now).map((match) => [match.arena_name, match.match_number]),
    [['Arena 1', 2], ['Arena 2', 4]]
  );
});

test('shows the most recently completed match only when no active or upcoming match exists', () => {
  const now = new Date('2026-04-10T10:00:00.000Z');
  const earlier = {
    ...baseMatch,
    match_number: 1,
    state: 'complete',
    actual_end: '2026-04-10T09:00:00.000Z'
  };
  const latest = {
    ...baseMatch,
    match_number: 2,
    state: 'complete',
    actual_end: '2026-04-10T09:30:00.000Z'
  };
  const upcoming = { ...baseMatch, match_number: 3 };

  assert.deepEqual(
    selectSrDisplayMatches([earlier, latest], now).map((match) => match.match_number),
    [2]
  );
  assert.deepEqual(
    selectSrDisplayMatches([earlier, latest, upcoming], now).map((match) => match.match_number),
    [3]
  );
});

test('selects a manual start countdown before its scheduled start time', () => {
  const now = new Date('2026-04-10T10:04:56.000Z');
  const scheduled = {
    ...baseMatch,
    countdown_started_at: '2026-04-10T10:04:55.000Z'
  };
  assert.deepEqual(
    selectSrDisplayMatches([scheduled], now).map((match) => match.match_number),
    [7]
  );
});

test('does not configure an external competition URL by default', () => {
  assert.equal(buildSrDisplayConfig(displayOptionsSchema.parse({})).externalUrl, '');
});

test('passes SR display settings in the names and shapes expected by upstream pages', () => {
  const options = displayOptionsSchema.parse({
    srHideOutsidePages: ['schedule', 'results'],
    srMaxTeams: 8,
    srMaxKnockoutRounds: 4,
    srShepherdingPastMatches: 2,
    srStagingCloseOffsetMinutes: 7,
    srStagingCornerOrder: [3, 2, 1, 0],
    srRotationSeconds: 20,
    srExternalUrl: 'https://example.org/comp/',
    showStartCue: true,
    goBackgroundColor: '#123456'
  });

  assert.deepEqual(buildSrDisplayConfig(options), {
    hideOutsidePages: ['sr-competitor-schedule'],
    externalUrl: 'https://example.org/comp/',
    maxTeams: 8,
    maxKnockoutRounds: 4,
    shepherdingPastMatches: 2,
    stagingCloseOffsetMinutes: 7,
    stagingCornersList: ['3', '2', '1', '0'],
    rotationSeconds: 20,
    displayOptions: {
      showStartCue: true,
      showEndCue: false,
      showEndCountdown: false,
      flashCountdownNumbers: false,
      countdownBackgroundColor: '#a21f24',
      countdownFlashColor: '#ffffff',
      goBackgroundColor: '#123456',
      endBackgroundColor: '#b3131b',
      endCountdownSeconds: 10,
      cueDurationSeconds: 2,
      endCueDurationSeconds: 3,
      clockOffsetMs: 0
    }
  });
});

test('groups playoff games in numeric round order without merging distinct rounds', () => {
  const grouped = groupSrKnockoutMatches([
    { num: 5, round_number: 2 },
    { num: 2, round_number: 1 },
    { num: 6, round_number: 2 }
  ]);
  assert.deepEqual(grouped, [
    [{ num: 2, round_number: 1 }],
    [{ num: 5, round_number: 2 }, { num: 6, round_number: 2 }]
  ]);
});

test('rejects malformed scheduled times rather than emitting a broken public match', () => {
  assert.throws(() => toSrMatch({
    ...baseMatch,
    effective_start: 'invalid-time'
  }), RangeError);
});

test('keeps a just-finished match on screen even without scores, then moves on', () => {
  const ended = new Date('2026-04-10T10:00:00.000Z');
  const finished = { ...baseMatch, match_number: 1, state: 'awaiting_score', actual_end: ended.toISOString() };
  const next = { ...baseMatch, match_number: 2, effective_start: '2026-04-10T10:01:00Z' };
  const at = (seconds: number) => selectSrDisplayMatches([finished, next], new Date(ended.getTime() + seconds * 1000))
    .map((match) => match.match_number);
  assert.deepEqual(at(5), [1], 'END is shown');
  assert.deepEqual(at(30), [2], 'then the next match');
});

test('an overdue match stays current until someone starts it', () => {
  const overdue = { ...baseMatch, match_number: 5, effective_start: '2026-04-10T09:00:00Z' };
  const later = { ...baseMatch, match_number: 6, effective_start: '2026-04-10T10:30:00Z' };
  assert.deepEqual(
    selectSrDisplayMatches([later, overdue], new Date('2026-04-10T10:00:00Z')).map((match) => match.match_number),
    [5]
  );
});
