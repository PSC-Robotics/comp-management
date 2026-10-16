import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignMatchesToWaves,
  calculateEventScheduleShifts,
  calculateDelayReduction,
  calculatePlayoffHeatCascade,
  planPlayoffHeatTimes,
  calculateScheduleCascade,
  calculateTimerResetStart,
  calculateWaveStartTime,
  generateBalancedMatches,
  roundedDelaySeconds,
  ScheduleGenerationError
} from './scheduler.js';

test('reduces a match delay by the requested amount and clamps at the scheduled time', () => {
  const scheduled = 1_000_000;
  const effective = scheduled + 17 * 60_000;
  assert.deepEqual(calculateDelayReduction(scheduled, effective, 5 * 60, false), {
    effectiveStart: scheduled + 12 * 60_000,
    reductionSeconds: 300,
    remainingDelaySeconds: 720
  });
  assert.deepEqual(calculateDelayReduction(scheduled, effective, 30 * 60, false), {
    effectiveStart: scheduled,
    reductionSeconds: 1020,
    remainingDelaySeconds: 0
  });
});

test('restores an adjusted match to its original scheduled time', () => {
  const scheduled = 1_000_000;
  assert.deepEqual(calculateDelayReduction(scheduled, scheduled + 9_000, undefined, true), {
    effectiveStart: scheduled,
    reductionSeconds: 9,
    remainingDelaySeconds: 0
  });
  assert.throws(() =>
    calculateDelayReduction(scheduled, scheduled, 60, false), /already at its scheduled/
  );
  assert.throws(() =>
    calculateDelayReduction(scheduled + 1, scheduled, 60, false), RangeError
  );
  assert.throws(() =>
    calculateDelayReduction(scheduled, scheduled + 60_000, 60, true), RangeError
  );
});

test('keeps an early timer reset at its existing slot and only moves past starts forward', () => {
  const scheduled = Date.parse('2026-10-06T10:05:00Z');
  assert.equal(
    calculateTimerResetStart(
      scheduled,
      scheduled,
      Date.parse('2026-10-06T10:00:20Z')
    ),
    scheduled
  );
  assert.equal(
    calculateTimerResetStart(
      scheduled,
      scheduled + 5 * 60_000,
      Date.parse('2026-10-06T10:01:20Z')
    ),
    scheduled + 5 * 60_000
  );
  assert.equal(
    calculateTimerResetStart(
      scheduled,
      scheduled,
      Date.parse('2026-10-06T10:06:20Z')
    ),
    Date.parse('2026-10-06T10:07:00Z')
  );
  assert.throws(() => calculateTimerResetStart(scheduled + 1, scheduled, Date.now()), RangeError);
});

test('rounds schedule overlap delays up to the next whole minute', () => {
  assert.equal(roundedDelaySeconds(-1), 0);
  assert.equal(roundedDelaySeconds(0), 0);
  assert.equal(roundedDelaySeconds(1), 60);
  assert.equal(roundedDelaySeconds(60_000), 60);
  assert.equal(roundedDelaySeconds(60_001), 120);
  assert.throws(() => roundedDelaySeconds(Number.NaN), RangeError);
});

test('cascades late matches in minute increments without leaving downstream overlaps', () => {
  const shifts = calculateScheduleCascade([
    { id: 'next', effectiveStart: 10_000, durationSeconds: 30 },
    { id: 'following', effectiveStart: 40_000, durationSeconds: 60 },
    { id: 'later', effectiveStart: 200_000, durationSeconds: 60 }
  ], 40_000);
  assert.deepEqual(shifts, [
    { id: 'next', effectiveStart: 70_000, delaySeconds: 60 },
    { id: 'following', effectiveStart: 100_000, delaySeconds: 60 }
  ]);
});

test('preserves generated start-to-start intervals when cascading late starts', () => {
  assert.deepEqual(calculateScheduleCascade([
    { id: 'next', effectiveStart: 180_000, durationSeconds: 120, plannedGapSeconds: 180 },
    { id: 'following', effectiveStart: 480_000, durationSeconds: 120, plannedGapSeconds: 180 }
  ], 120_000, 180), [
    { id: 'next', effectiveStart: 300_000, delaySeconds: 120 },
    { id: 'following', effectiveStart: 600_000, delaySeconds: 120 }
  ]);
});

test('does not shift the next match when a start or reset ends before its scheduled start', () => {
  const nextStart = Date.parse('2026-10-06T10:05:00Z');
  const earlyActualStart = Date.parse('2026-10-06T10:00:00Z');
  assert.deepEqual(
    calculateScheduleCascade(
      [{ id: 'next', effectiveStart: nextStart, durationSeconds: 120, plannedGapSeconds: 180 }],
      earlyActualStart + 120_000
    ),
    []
  );
});

test('treats the configured interval as exact start-to-start spacing', () => {
  const firstStart = Date.parse('2026-10-05T11:00:00Z');
  const nextStart = calculateWaveStartTime(firstStart, 1, 300, 120);
  assert.equal(nextStart - firstStart, 5 * 60_000);
  assert.equal(nextStart - (firstStart + 120_000), 3 * 60_000);
  assert.throws(() => calculateWaveStartTime(firstStart, -1, 300, 120), RangeError);
  assert.throws(() => calculateWaveStartTime(firstStart, 1, 60, 120), RangeError);
});

test('does not shift non-overlapping matches and rejects invalid cascade data', () => {
  assert.deepEqual(
    calculateScheduleCascade([{ id: 'later', effectiveStart: 120_000, durationSeconds: 60 }], 60_000),
    []
  );
  assert.throws(
    () => calculateScheduleCascade([{ id: 'invalid', effectiveStart: Number.NaN, durationSeconds: 60 }], 0),
    RangeError
  );
  assert.throws(
    () => calculateScheduleCascade([{ id: 'invalid', effectiveStart: 0, durationSeconds: 60 }], Number.NaN),
    RangeError
  );
});

test('shifts matches around event blocks and cascades same-arena delays', () => {
  const plan = calculateEventScheduleShifts([
    { id: 'first', matchNumber: 1, arenaName: 'A', effectiveStart: 100_000, durationSeconds: 40, hasCountdown: false },
    { id: 'later', matchNumber: 2, arenaName: 'A', effectiveStart: 150_000, durationSeconds: 30, hasCountdown: false, plannedGapSeconds: 60 },
    { id: 'other-arena', matchNumber: 3, arenaName: 'B', effectiveStart: 160_000, durationSeconds: 10, hasCountdown: false }
  ], [{ title: 'Lunch', startsAt: 120_000, durationMinutes: 2 }], 'event added');
  assert.deepEqual(plan.shifts.map(({ id, effectiveStart }) => ({ id, effectiveStart })), [
    { id: 'first', effectiveStart: 240_000 },
    { id: 'later', effectiveStart: 360_000 },
    { id: 'other-arena', effectiveStart: 240_000 }
  ]);
});

test('schedules league matches around lunch and an overnight break into the next day', () => {
  const dayOne = Date.parse('2026-10-05T11:00:00Z');
  const lunch = Date.parse('2026-10-05T13:30:00Z');
  const overnight = Date.parse('2026-10-05T17:00:00Z');
  const dayTwo = Date.parse('2026-10-06T11:00:00Z');
  const plan = calculateEventScheduleShifts([
    { id: 'before-lunch', matchNumber: 1, arenaName: 'Arena 1', effectiveStart: dayOne, durationSeconds: 1800, hasCountdown: false },
    { id: 'lunch-overlap', matchNumber: 2, arenaName: 'Arena 1', effectiveStart: lunch, durationSeconds: 1800, hasCountdown: false },
    { id: 'day-one-end', matchNumber: 3, arenaName: 'Arena 1', effectiveStart: overnight, durationSeconds: 1800, hasCountdown: false },
    { id: 'day-two', matchNumber: 4, arenaName: 'Arena 1', effectiveStart: dayTwo, durationSeconds: 1800, hasCountdown: false }
  ], [
    { title: 'Lunch', startsAt: lunch, durationMinutes: 120 },
    { title: 'Overnight break', startsAt: overnight, durationMinutes: 1080 }
  ], 'test multi-day schedule');

  assert.deepEqual(plan.shifts.map((shift) => [shift.id, shift.effectiveStart]), [
    ['lunch-overlap', Date.parse('2026-10-05T15:30:00Z')],
    ['day-one-end', dayTwo],
    ['day-two', Date.parse('2026-10-06T11:30:00Z')]
  ]);
});

test('protects a match countdown from an event-induced shift', () => {
  const plan = calculateEventScheduleShifts([
    { id: 'countdown', matchNumber: 8, arenaName: 'A', effectiveStart: 120_000, durationSeconds: 30, hasCountdown: true }
  ], [{ title: 'Lunch', startsAt: 120_000, durationMinutes: 30 }], 'event moved');
  assert.equal(plan.shifts.length, 0);
  assert.match(plan.error ?? '', /countdown/i);
});

test('generates valid schedules with equal appearances for feasible rosters', () => {
  const cases: Array<[number, number]> = [[4, 1], [5, 5], [6, 3], [8, 4], [9, 9], [30, 15]];
  for (const [teamCount, matchCount] of cases) {
    const teams = Array.from({ length: teamCount }, (_, index) => `T${String(index).padStart(2, '0')}`);
    const schedule = generateBalancedMatches(teams, matchCount, 123456);
    const appearances = new Map(teams.map((team) => [team, 0]));
    for (const match of schedule.matches) {
      assert.equal(match.codes.length, 4);
      assert.equal(new Set(match.codes).size, 4);
      assert.equal(match.positions.length, 4);
      assert.deepEqual([...match.positions].sort(), [...match.codes].sort());
      for (const team of match.codes) appearances.set(team, appearances.get(team)! + 1);
    }
    assert.equal(schedule.matches.length, matchCount);
    assert.ok([...appearances.values()].every((count) => count === schedule.appearancesPerTeam));
  }
});

test('schedule generation is reproducible for identical inputs and seed', () => {
  const teams = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  assert.deepEqual(
    generateBalancedMatches(teams, 3, 42),
    generateBalancedMatches(teams, 3, 42)
  );
});

test('balances every opponent pair equally when a five-team round robin permits it', () => {
  const teams = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
  const schedule = generateBalancedMatches(teams, 5, 654321);
  assert.deepEqual(schedule.pairRange, [3, 3]);
  assert.deepEqual(schedule.positionRange, [1, 1]);
});

test('stress-checks equal team appearances and valid four-team scores across roster sizes and seeds', () => {
  for (const teamCount of [4, 8, 12, 16, 20, 24]) {
    const teams = Array.from({ length: teamCount }, (_, index) => `R${String(index).padStart(2, '0')}`);
    for (let seed = 1; seed <= 5; seed += 1) {
      const matchCount = teamCount * 3 / 4;
      const schedule = generateBalancedMatches(teams, matchCount, seed * 7919 + teamCount);
      const appearances = new Map(teams.map((team) => [team, 0]));
      for (const match of schedule.matches) {
        assert.equal(match.codes.length, 4);
        assert.equal(new Set(match.codes).size, 4);
        assert.equal(new Set(match.positions).size, 4);
        for (const team of match.codes) {
          assert.ok(appearances.has(team));
          appearances.set(team, appearances.get(team)! + 1);
        }
      }
      assert.equal(schedule.matches.length, matchCount);
      assert.ok([...appearances.values()].every((count) => count === 3));
    }
  }
});

test('parallel arena waves never schedule a team twice at the same time', () => {
  const teams = Array.from({ length: 30 }, (_, index) => `T${String(index).padStart(2, '0')}`);
  const schedule = generateBalancedMatches(teams, 30, 98765);
  const assignments = assignMatchesToWaves(schedule.matches, 4);
  const waves = new Map<number, Set<string>>();
  const arenaSlots = new Map<number, Set<number>>();
  for (const assignment of assignments) {
    const waveTeams = waves.get(assignment.wave) ?? new Set<string>();
    for (const team of assignment.codes) {
      assert.equal(waveTeams.has(team), false, `${team} assigned twice in wave ${assignment.wave}`);
      waveTeams.add(team);
    }
    waves.set(assignment.wave, waveTeams);
    const slots = arenaSlots.get(assignment.wave) ?? new Set<number>();
    assert.equal(slots.has(assignment.arenaIndex), false);
    slots.add(assignment.arenaIndex);
    arenaSlots.set(assignment.wave, slots);
  }
});

test('rejects impossible appearance targets', () => {
  assert.throws(
    () => generateBalancedMatches(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'], 1, 9),
    ScheduleGenerationError
  );
});

test('playoff cascade follows dependencies and arenas, so parallel heats are not serialised', () => {
  const minute = 60_000;
  const heats = [
    { id: 'h1', matchNumber: 1, arenaName: 'A', effectiveStart: 0, durationSeconds: 120, plannedGapSeconds: 60, dependsOn: [] },
    { id: 'h2', matchNumber: 2, arenaName: 'B', effectiveStart: 0, durationSeconds: 120, plannedGapSeconds: 60, dependsOn: [] },
    { id: 'h3', matchNumber: 3, arenaName: 'A', effectiveStart: 3 * minute, durationSeconds: 120, plannedGapSeconds: 60, dependsOn: ['h1', 'h2'] }
  ];
  assert.deepEqual(calculatePlayoffHeatCascade(heats), []);
  // Heat 2 overruns in arena B: heat 3 depends on it, so it moves; heat 1 does not.
  const shifted = calculatePlayoffHeatCascade([
    heats[0]!, { ...heats[1]!, fixedEnd: 4 * minute + 10_000 }, heats[2]!
  ]);
  assert.deepEqual(shifted, [{ id: 'h3', effectiveStart: 6 * minute, delaySeconds: 180 }]);
  // An unscored heat holds back the heats it feeds until its result is known.
  const awaiting = calculatePlayoffHeatCascade([
    { ...heats[0]!, fixedEnd: 2 * minute, resultAvailableAt: 5 * minute }, heats[1]!, heats[2]!
  ]);
  assert.deepEqual(awaiting, [{ id: 'h3', effectiveStart: 6 * minute, delaySeconds: 180 }]);
  assert.throws(() => calculatePlayoffHeatCascade([{ ...heats[0]!, plannedGapSeconds: -1 }]), RangeError);
});

test('plans playoff heat slots across one or several arenas with a final buffer', () => {
  const minute = 60_000;
  const heats = [
    { key: 'h1', dependsOn: [], isFinal: false },
    { key: 'h2', dependsOn: [], isFinal: false },
    { key: 'h3', dependsOn: ['h1', 'h2'], isFinal: false },
    { key: 'final', dependsOn: ['h3'], isFinal: true }
  ];
  assert.deepEqual(planPlayoffHeatTimes(heats, ['A'], 0, 300, 180, 600).map((heat) => [heat.arenaName, heat.start / minute, heat.plannedGapSeconds]), [
    ['A', 0, 120], ['A', 5, 120], ['A', 10, 120], ['A', 25, 720]
  ]);
  assert.deepEqual(planPlayoffHeatTimes(heats, ['A', 'B'], 0, 300, 180).map((heat) => [heat.arenaName, heat.start / minute]), [
    ['A', 0], ['B', 0], ['A', 5], ['A', 10]
  ]);
  assert.throws(() => planPlayoffHeatTimes(heats, ['A'], 0, 60, 180), RangeError);
  assert.throws(() => planPlayoffHeatTimes([{ key: 'x', dependsOn: ['missing'], isFinal: false }], ['A'], 0, 300, 180), RangeError);
});

test('running matches occupy their arena when re-flowing the schedule', () => {
  const plan = calculateEventScheduleShifts([
    { id: 'running', matchNumber: 1, arenaName: 'A', effectiveStart: 0, durationSeconds: 300, hasCountdown: false, fixed: true },
    { id: 'heat', matchNumber: 2, arenaName: 'A', effectiveStart: 240_000, durationSeconds: 120, hasCountdown: false, plannedGapSeconds: 60 }
  ], [], 'league delay');
  assert.deepEqual(plan.shifts.map(({ id, effectiveStart }) => ({ id, effectiveStart })), [
    { id: 'heat', effectiveStart: 360_000 }
  ]);
});

test('balanced schedules work for two- and three-team matches', () => {
  const codes = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  for (const size of [2, 3]) {
    const result = generateBalancedMatches(codes, 6, 42, size);
    assert.equal(result.matches.length, 6);
    assert.equal(result.appearancesPerTeam, (6 * size) / codes.length);
    for (const match of result.matches) {
      assert.equal(match.positions.length, size);
      assert.equal(new Set(match.positions).size, size, 'no team twice in one match');
    }
    const appearances = new Map<string, number>();
    for (const match of result.matches) for (const code of match.codes) appearances.set(code, (appearances.get(code) ?? 0) + 1);
    assert.deepEqual([...new Set(appearances.values())], [result.appearancesPerTeam], 'every team plays equally often');
  }
  assert.throws(() => generateBalancedMatches(codes, 5, 1, 2), /equal appearances/, '5 two-team matches cannot share 6 teams evenly');
});
