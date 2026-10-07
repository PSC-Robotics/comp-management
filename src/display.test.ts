import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cornerColoursSchema,
  defaultCornerColours,
  displayOptionsSchema,
  displayTypeSchema,
  formatCompetitionDateTime,
  formatCompetitionTime,
  getEndCountdownCue,
  getStartCue,
  isValidTimeZone,
  MATCH_COUNTDOWN_TOTAL_SECONDS,
  publicMatchPriority,
  readableTextColour
} from './display.js';

test('public current-match selection prioritizes running timers over awaiting-score matches', () => {
  assert.ok(publicMatchPriority('running', false) < publicMatchPriority('awaiting_score', false));
  assert.ok(publicMatchPriority('paused', false) < publicMatchPriority('awaiting_score', false));
  assert.ok(publicMatchPriority('scheduled', false) < publicMatchPriority('awaiting_score', false));
  assert.ok(publicMatchPriority('awaiting_score', false) < publicMatchPriority('complete', false));
  assert.ok(publicMatchPriority('running', true) < publicMatchPriority('running', false));
});

test('formats schedule timestamps in the competition timezone including daylight saving', () => {
  assert.equal(formatCompetitionTime('2026-10-05T08:00:00.000Z', 'Europe/London'), '09:00');
  assert.equal(formatCompetitionTime('2026-01-05T08:00:00.000Z', 'Europe/London'), '08:00');
  assert.equal(formatCompetitionDateTime('2026-10-05T08:00:00.000Z', 'Europe/London'), '05 Oct 2026, 09:00');
  assert.throws(() => formatCompetitionTime('not a date', 'Europe/London'), RangeError);
  assert.throws(() => formatCompetitionTime('2026-10-05T08:00:00.000Z', 'Invalid/Timezone'), RangeError);
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('Invalid/Timezone'), false);
});

test('fills public display options with backward-compatible defaults', () => {
  assert.deepEqual(displayOptionsSchema.parse({}), {
    showTitle: true,
    showArena: true,
    fillCorners: false,
    showTeamNames: true,
    showPositionNumbers: true,
    fillCornerDisplay: true,
    showCornerTeamName: true,
    showCornerPositionNumber: true,
    showCornerTimers: false,
    showStartCue: false,
    showEndCue: false,
    showEndCountdown: false,
    showPreviousResults: false,
    flashCountdownNumbers: false,
    darkTheme: false,
    hideCompletedEvents: false,
    hideCompletedMatches: false,
    enableTeamFilter: false,
    relativeTime: false,
    hideScheduleArena: false,
    cornerPosition: 0,
    countdownBackgroundColor: '#a21f24',
    countdownFlashColor: '#ffffff',
    goBackgroundColor: '#167847',
    endBackgroundColor: '#b3131b',
    endCountdownSeconds: 10,
    cueDurationSeconds: 2,
    endCueDurationSeconds: 3,
    srArenaName: '',
    srMaxTeams: 6,
    srMaxKnockoutRounds: 5,
    srShepherdingPastMatches: 1,
    srStagingCloseOffsetMinutes: 5,
    srHideOutsidePages: [],
    srStagingCornerOrder: [0, 3, 2, 1],
    srRotationSeconds: 15,
    srExternalUrl: ''
  });
  assert.deepEqual(displayOptionsSchema.parse({ cornerPosition: 3, darkTheme: true }), {
    showTitle: true,
    showArena: true,
    fillCorners: false,
    showTeamNames: true,
    showPositionNumbers: true,
    fillCornerDisplay: true,
    showCornerTeamName: true,
    showCornerPositionNumber: true,
    showCornerTimers: false,
    showStartCue: false,
    showEndCue: false,
    showEndCountdown: false,
    showPreviousResults: false,
    flashCountdownNumbers: false,
    darkTheme: true,
    hideCompletedEvents: false,
    hideCompletedMatches: false,
    enableTeamFilter: false,
    relativeTime: false,
    hideScheduleArena: false,
    cornerPosition: 3,
    countdownBackgroundColor: '#a21f24',
    countdownFlashColor: '#ffffff',
    goBackgroundColor: '#167847',
    endBackgroundColor: '#b3131b',
    endCountdownSeconds: 10,
    cueDurationSeconds: 2,
    endCueDurationSeconds: 3,
    srArenaName: '',
    srMaxTeams: 6,
    srMaxKnockoutRounds: 5,
    srShepherdingPastMatches: 1,
    srStagingCloseOffsetMinutes: 5,
    srHideOutsidePages: [],
    srStagingCornerOrder: [0, 3, 2, 1],
    srRotationSeconds: 15,
    srExternalUrl: ''
  });
  assert.throws(() => displayOptionsSchema.parse({ cornerPosition: 4 }));
  assert.throws(() => displayOptionsSchema.parse({ countdownBackgroundColor: 'red' }));
  assert.throws(() => displayOptionsSchema.parse({ cueDurationSeconds: 0 }));
  assert.throws(() => displayOptionsSchema.parse({ endCueDurationSeconds: 0 }));
  assert.throws(() => displayOptionsSchema.parse({ endCountdownSeconds: 61 }));
  assert.throws(() => displayOptionsSchema.parse({ goBackgroundColor: 'green' }));
  assert.throws(() => displayOptionsSchema.parse({ srStagingCornerOrder: [0, 1, 1, 3] }));
  assert.throws(() => displayOptionsSchema.parse({ srExternalUrl: 'javascript:alert(1)' }));
  assert.throws(() => displayOptionsSchema.parse({ srShepherdingPastMatches: 6 }));
  assert.throws(() => displayOptionsSchema.parse({ srStagingCloseOffsetMinutes: 31 }));
  assert.throws(() => displayOptionsSchema.parse({ unsupported: true }));
  assert.equal(displayOptionsSchema.parse({ showPreviousResults: true }).showPreviousResults, true);
  assert.deepEqual(displayOptionsSchema.parse({ relativeTime: true, hideScheduleArena: true }).relativeTime, true);
  assert.equal(displayOptionsSchema.parse({ relativeTime: true, hideScheduleArena: true }).hideScheduleArena, true);
});

test('accepts the SRComp screen display types', () => {
  for (const type of ['sr-arena', 'sr-outside', 'sr-producer', 'sr-shepherding', 'sr-staging']) {
    assert.equal(displayTypeSchema.parse(type), type);
  }
});

test('shows an optional end countdown for exactly the configured final seconds', () => {
  assert.equal(getEndCountdownCue(10_000, true, 10), '10');
  assert.equal(getEndCountdownCue(9_001, true, 10), '10');
  assert.equal(getEndCountdownCue(1_000, true, 10), '1');
  assert.equal(getEndCountdownCue(0, true, 10), null);
  assert.equal(getEndCountdownCue(10_001, true, 10), null);
  assert.equal(getEndCountdownCue(5_000, false, 10), null);
  assert.equal(getEndCountdownCue(5_000, true, 0), null);
});

test('calculates red countdown and green GO cue against the shared clock', () => {
  const startedAt = 100_000;
  assert.deepEqual(getStartCue(startedAt, null, 100_001, true, 2), { text: 'GET READY', colour: 'ready' });
  assert.deepEqual(getStartCue(startedAt, null, 102_001, true, 2), { text: '3', colour: 'red' });
  assert.deepEqual(getStartCue(startedAt, null, 103_000, true, 2), { text: '2', colour: 'red' });
  assert.deepEqual(getStartCue(startedAt, null, 103_000, true, 2, null, false, 3, true), { text: '2', colour: 'flash' });
  assert.deepEqual(getStartCue(startedAt, null, 104_000, true, 2), { text: '1', colour: 'red' });
  assert.deepEqual(getStartCue(startedAt, 105_500, 105_100, true, 2), { text: 'GO', colour: 'green' });
  assert.deepEqual(getStartCue(startedAt, 105_500, 106_999, true, 2), { text: 'GO', colour: 'green' });
  assert.deepEqual(getStartCue(startedAt, 105_500, 107_000, true, 2), { text: null, colour: null });
  assert.deepEqual(getStartCue(startedAt, null, 101_000, false, 2), { text: null, colour: null });
  assert.equal(MATCH_COUNTDOWN_TOTAL_SECONDS, 5);
});

test('shows an END cue for its configured duration and anchors GO to the countdown timestamp', () => {
  const countdownStartedAt = 100_000;
  assert.deepEqual(getStartCue(countdownStartedAt, 105_500, 106_999, true, 2), {
    text: 'GO', colour: 'green'
  });
  assert.deepEqual(getStartCue(null, 103_000, 223_500, true, 2, 223_000, true, 2), {
    text: 'END', colour: 'end'
  });
  assert.deepEqual(getStartCue(null, 103_000, 225_000, true, 2, 223_000, true, 2), {
    text: null, colour: null
  });
  assert.throws(() => displayOptionsSchema.parse({ endCueDurationSeconds: 11 }));
  assert.deepEqual(getStartCue(null, 103_000, 223_500, false, 2, 223_000, true, 2), {
    text: 'END', colour: 'end'
  });
});

test('selects readable text for filled position colours', () => {
  assert.equal(readableTextColour('#ffffff'), '#111111');
  assert.equal(readableTextColour('#112233'), '#ffffff');
  assert.equal(readableTextColour('red'), '#111111');
});

test('validates one unique colour for each of the four arena positions', () => {
  assert.deepEqual(cornerColoursSchema.parse([...defaultCornerColours]), [...defaultCornerColours]);
  assert.throws(() => cornerColoursSchema.parse(['#112233', '#112233', '#445566', '#778899']));
  assert.throws(() => cornerColoursSchema.parse(['#112233', '#445566', '#778899']));
  assert.throws(() => cornerColoursSchema.parse(['red', '#445566', '#778899', '#aabbcc']));
});
