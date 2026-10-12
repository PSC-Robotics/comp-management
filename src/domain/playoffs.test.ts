import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlayoffSeedRanks,
  buildDoubleEliminationPlan,
  buildPlayoffPlan,
  playoffHeatSizes,
  playoffStages,
  summarisePlayoffLosses,
  type PlayoffFormat,
  playoffAdvancingPlaces,
  playoffSeedSnapshotMatchesRanks,
  rankPlayoffScores,
  resolvePlayoffAdvancements,
  type PlayoffMatchState
} from './playoffs.js';

function createBracket(teamCount: number) {
  const plan = buildDoubleEliminationPlan(teamCount);
  const seedTeams = new Map(Array.from({ length: teamCount }, (_, index) => [index + 1, `team-${index + 1}`]));
  const matches: PlayoffMatchState[] = plan.map((match) => ({
    ...match,
    teamIds: [null, null, null, null],
    placements: null,
    status: 'pending'
  }));
  return { plan, seedTeams, matches: resolvePlayoffAdvancements(matches, seedTeams) };
}

test('plans variable-size heats for every entrant count from 2 through 32', () => {
  for (let teamCount = 2; teamCount <= 64; teamCount += 1) {
    const { plan } = createBracket(teamCount);
    assert.ok(plan.length > 0);
    assert.ok(plan.every((match) => {
      const sourceCount = match.sources.filter((source) => source !== 'bye').length;
      return sourceCount >= 2 && sourceCount <= 4;
    }));
    assert.equal(plan.at(-1)?.side, 'final');
    assert.equal(plan.at(-1)?.sources.filter((source) => source !== 'bye').length,
      teamCount <= 4 ? teamCount : 4);
  }
  for (const invalidCount of [0, 1, 16.5]) {
    assert.throws(() => buildDoubleEliminationPlan(invalidCount), RangeError);
  }
});

test('advances the top two in 3/4-team heats, one in 2-team heats, and breaks ties by league seed', () => {
  const seedRanks = { 'team-1': 1, 'team-2': 2, 'team-3': 3, 'team-4': 4 };
  assert.equal(playoffAdvancingPlaces(2), 1);
  assert.equal(playoffAdvancingPlaces(3), 2);
  assert.equal(playoffAdvancingPlaces(4), 2);
  assert.deepEqual(rankPlayoffScores([
    { teamId: 'team-4', points: 11 },
    { teamId: 'team-2', points: 11 },
    { teamId: 'team-3', points: 5 }
  ], seedRanks), ['team-2', 'team-4', 'team-3']);
  assert.deepEqual(rankPlayoffScores([
    { teamId: 'team-3', points: 9 },
    { teamId: 'team-1', points: 1 }
  ], seedRanks), ['team-3', 'team-1']);
  assert.throws(() => playoffAdvancingPlaces(1), RangeError);
});

test('ranks every four-team point combination by points then the current seed', () => {
  const teamIds = ['A', 'B', 'C', 'D'];
  const seedRanks = { A: 4, B: 2, C: 1, D: 3 };
  for (let encoded = 0; encoded < 625; encoded += 1) {
    let value = encoded;
    const scores = teamIds.map((teamId) => {
      const points = value % 5 - 2;
      value = Math.floor(value / 5);
      return { teamId, points };
    });
    const expected = [...scores].sort((left, right) =>
      right.points - left.points || seedRanks[left.teamId as keyof typeof seedRanks] -
        seedRanks[right.teamId as keyof typeof seedRanks]
    ).map((score) => score.teamId);
    for (let offset = 0; offset < teamIds.length; offset += 1) {
      const order = [...scores.slice(offset), ...scores.slice(0, offset)].reverse();
      assert.deepEqual(rankPlayoffScores(order, seedRanks), expected);
    }
  }
  assert.throws(() => rankPlayoffScores([
    { teamId: 'A', points: 1 }, { teamId: 'A', points: 2 }
  ], seedRanks), RangeError);
  assert.throws(() => rankPlayoffScores([
    { teamId: 'A', points: Number.NaN }, { teamId: 'B', points: 2 }
  ], seedRanks), RangeError);
  assert.throws(() => rankPlayoffScores([
    { teamId: 'A', points: 1 }, { teamId: 'missing', points: 2 }
  ], seedRanks), RangeError);
});

test('rebuilds pre-play seeds from the latest standings, including changed top-field membership', () => {
  const firstStandings = Array.from({ length: 10 }, (_, index) => `team-${index + 1}`);
  const secondStandings = ['team-8', 'team-4', 'team-10', 'team-2', 'team-6',
    'team-1', 'team-3', 'team-5', 'team-7', 'team-9'];
  const first = buildPlayoffSeedRanks(firstStandings, 8);
  const latest = buildPlayoffSeedRanks(secondStandings, 8);
  assert.deepEqual([...latest.seedTeams], [
    [1, 'team-8'], [2, 'team-4'], [3, 'team-10'], [4, 'team-2'],
    [5, 'team-6'], [6, 'team-1'], [7, 'team-3'], [8, 'team-5']
  ]);
  assert.equal(first.seedRanks['team-9'], undefined);
  assert.equal(latest.seedRanks['team-9'], undefined);
  assert.equal(latest.seedRanks['team-10'], 3);

  const plan = buildDoubleEliminationPlan(8);
  const initial: PlayoffMatchState[] = plan.map((match) => ({
    ...match, teamIds: [null, null, null, null], placements: null, status: 'pending'
  }));
  const oldAssignments = resolvePlayoffAdvancements(initial, first.seedTeams);
  const refreshedAssignments = resolvePlayoffAdvancements(oldAssignments, latest.seedTeams);
  const firstHeat = refreshedAssignments.find((match) => match.sources.includes('seed:1'));
  assert.ok(firstHeat);
  assert.ok(firstHeat.teamIds.includes('team-8'));
  assert.ok(!firstHeat.teamIds.includes('team-1'));
  assert.equal(new Set(refreshedAssignments.flatMap((match) => match.teamIds).filter(Boolean)).size, 8);
});

test('seed rank builder rejects incomplete, duplicate, or invalid participant fields', () => {
  assert.throws(() => buildPlayoffSeedRanks(['team-1'], 2), RangeError);
  assert.throws(() => buildPlayoffSeedRanks(['team-1', 'team-1'], 2), RangeError);
  assert.throws(() => buildPlayoffSeedRanks(['team-1', 'team-2'], 1), RangeError);
  assert.throws(() => buildPlayoffSeedRanks(['team-1', ''], 2), RangeError);
});

test('seed snapshot integrity check detects stale, incomplete, duplicate, or extra seed data', () => {
  const standings = [{ id: 'team-a' }, { id: 'team-b' }, { id: 'team-c' }];
  assert.equal(playoffSeedSnapshotMatchesRanks(standings, 2, { 'team-a': 1, 'team-b': 2 }), true);
  assert.equal(playoffSeedSnapshotMatchesRanks(standings, 2, { 'team-b': 1, 'team-a': 2 }), false);
  assert.equal(playoffSeedSnapshotMatchesRanks(standings.slice(0, 1), 2, { 'team-a': 1, 'team-b': 2 }), false);
  assert.equal(playoffSeedSnapshotMatchesRanks(
    [{ id: 'team-a' }, { id: 'team-a' }], 2, { 'team-a': 1, 'team-b': 2 }
  ), false);
  assert.equal(playoffSeedSnapshotMatchesRanks(
    standings, 2, { 'team-a': 1, 'team-b': 2, 'team-c': 3 }
  ), false);
});

test('seed-based tie breaking remains deterministic across every entrant order', () => {
  for (let entrantCount = 2; entrantCount <= 4; entrantCount += 1) {
    const teamIds = Array.from({ length: entrantCount }, (_, index) => `team-${index + 1}`);
    const seedRanks = Object.fromEntries(teamIds.map((id, index) => [id, index + 1]));
    const points = teamIds.map((teamId) => ({ teamId, points: 10 }));
    const expected = [...teamIds].sort((left, right) => seedRanks[left]! - seedRanks[right]!);
    for (let offset = 0; offset < entrantCount; offset += 1) {
      const reordered = [...points.slice(offset), ...points.slice(0, offset)].reverse();
      assert.deepEqual(rankPlayoffScores(reordered, seedRanks), expected);
    }
  }
});

test('supports two- and three-team finals without adding empty score slots', () => {
  for (const teamCount of [2, 3]) {
    const { matches, seedTeams } = createBracket(teamCount);
    const final = matches[0]!;
    const participants = final.teamIds.filter((teamId): teamId is string => teamId !== null);
    assert.equal(final.status, 'ready');
    assert.equal(participants.length, teamCount);
    const seedRanks = Object.fromEntries([...seedTeams].map(([seed, teamId]) => [teamId, seed]));
    const placements = rankPlayoffScores(
      participants.map((teamId, index) => ({ teamId, points: teamCount - index })),
      seedRanks
    );
    assert.equal(placements.length, teamCount);
  }
});

test('simulates two-loss elimination and a four-team final for arbitrary field sizes', () => {
  for (let teamCount = 5; teamCount <= 64; teamCount += 1) {
    const { plan, seedTeams, matches: initial } = createBracket(teamCount);
    let matches = initial;
    const losses = new Map([...seedTeams.values()].map((teamId) => [teamId, 0]));
    let finalPlacements: string[] | null = null;

    for (let turn = 0; turn < plan.length; turn += 1) {
      const ready = matches.find((candidate) => candidate.status === 'ready');
      if (!ready) break;
      const participants = ready.teamIds.filter((teamId): teamId is string => teamId !== null);
      assert.ok(participants.length >= 2 && participants.length <= 4);
      assert.equal(new Set(participants).size, participants.length);
      const seedsByTeam = new Map([...seedTeams].map(([seed, teamId]) => [teamId, seed]));
      const placements = participants.sort((left, right) => {
        const points = (teamId: string) => (Number(teamId.slice(5)) * 37 + turn * 19) % 101;
        return points(right) - points(left) || seedsByTeam.get(left)! - seedsByTeam.get(right)!;
      });
      ready.placements = placements;
      ready.status = 'complete';
      if (ready.side === 'final') {
        finalPlacements = placements;
      } else {
        for (const teamId of placements.slice(playoffAdvancingPlaces(placements.length))) {
          losses.set(teamId, losses.get(teamId)! + 1);
        }
      }
      matches = resolvePlayoffAdvancements(matches, seedTeams);
    }

    assert.ok(finalPlacements, `${teamCount}-team bracket should resolve a final four`);
    assert.equal(finalPlacements.length, 4);
    assert.equal(new Set(finalPlacements).size, 4);
    for (const match of matches.filter((candidate) => candidate.side !== 'final' && candidate.status === 'complete')) {
      assert.equal(match.placements?.length, match.teamIds.filter(Boolean).length);
    }
    for (const [teamId, lossCount] of losses) {
      if (!finalPlacements.includes(teamId)) assert.equal(lossCount, 2, `${teamId} in a ${teamCount}-team bracket`);
    }
  }
});

function simulate(teamCount: number, format: PlayoffFormat, finalSize: number, finalByes: number) {
  const plan = buildPlayoffPlan(teamCount, { format, finalSize, finalByes });
  const seedTeams = new Map(Array.from({ length: teamCount }, (_, index) => [index + 1, `team-${index + 1}`]));
  const seedsByTeam = new Map([...seedTeams].map(([seed, teamId]) => [teamId, seed]));
  let matches: PlayoffMatchState[] = resolvePlayoffAdvancements(plan.map((match) => ({
    ...match, teamIds: [null, null, null, null], placements: null, status: 'pending'
  })), seedTeams);
  const played = new Map<string, number>();
  for (let turn = 0; turn < plan.length; turn += 1) {
    const ready = matches.find((candidate) => candidate.status === 'ready');
    assert.ok(ready, `${format} ${teamCount}/${finalSize}/${finalByes}: a heat should be ready on turn ${turn}`);
    const participants = ready.teamIds.filter((teamId): teamId is string => teamId !== null);
    assert.ok(participants.length >= 2 && participants.length <= 4);
    assert.equal(new Set(participants).size, participants.length);
    for (const teamId of participants) played.set(teamId, (played.get(teamId) ?? 0) + 1);
    ready.placements = [...participants].sort((left, right) => {
      const points = (teamId: string) => (Number(teamId.slice(5)) * 37 + turn * 19) % 101;
      return points(right) - points(left) || seedsByTeam.get(left)! - seedsByTeam.get(right)!;
    });
    ready.status = 'complete';
    matches = resolvePlayoffAdvancements(matches, seedTeams);
  }
  const advancing = new Map(plan.map((match) => [match.key, match.advancing]));
  const summary = summarisePlayoffLosses(matches.map((match) => ({ ...match, advancing: advancing.get(match.key)! })));
  return { plan, matches, played, summary, final: matches.at(-1)! };
}

test('every playoff format resolves a full final for every field size, final size and bye count', () => {
  const formats: PlayoffFormat[] = ['double-elimination', 'single-elimination', 'direct-final'];
  for (const format of formats) {
    for (let finalSize = 2; finalSize <= 4; finalSize += 1) {
      for (let finalByes = 0; finalByes < finalSize; finalByes += 1) {
        const maxTeams = format === 'direct-final' ? finalSize : 40;
        for (let teamCount = 2; teamCount <= maxTeams; teamCount += 1) {
          const qualifying = finalSize - finalByes;
          if (format === 'double-elimination' && qualifying < 2 && teamCount > finalSize) {
            assert.throws(() => buildPlayoffPlan(teamCount, { format, finalSize, finalByes }), RangeError);
            continue;
          }
          const label = `${format} ${teamCount} teams, final of ${finalSize}, ${finalByes} byes`;
          const { plan, final, played, summary } = simulate(teamCount, format, finalSize, finalByes);
          assert.equal(plan.filter((match) => match.side === 'final').length, 1, label);
          assert.ok(plan.every((match) => {
            const entrants = match.sources.filter((source) => source !== 'bye').length;
            return entrants >= 2 && entrants <= 4 &&
              (match.side === 'final' || (match.advancing >= 1 && match.advancing < entrants));
          }), label);
          const finalists = final.placements!;
          assert.equal(finalists.length, Math.min(finalSize, teamCount), label);
          if (teamCount > finalSize) {
            for (let seed = 1; seed <= finalByes; seed += 1) {
              assert.ok(finalists.includes(`team-${seed}`), `${label}: seed ${seed} has a bye`);
              assert.equal(played.get(`team-${seed}`), 1, `${label}: seed ${seed} only plays the final`);
            }
          }
          for (let seed = 1; seed <= teamCount; seed += 1) {
            const teamId = `team-${seed}`;
            const record = summary.get(teamId) ?? { losses: 0, eliminated: false };
            if (finalists.includes(teamId)) {
              assert.equal(record.eliminated, false, `${label}: finalist ${teamId}`);
              assert.ok(record.losses <= (format === 'double-elimination' ? 1 : 0), `${label}: finalist ${teamId}`);
            } else {
              assert.equal(record.eliminated, true, `${label}: ${teamId} should be eliminated`);
              assert.equal(record.losses, format === 'double-elimination' ? 2 : 1, `${label}: ${teamId}`);
            }
          }
        }
      }
    }
  }
});

test('never leaves a single-team bye in a playoff round', () => {
  for (let entrants = 2; entrants <= 64; entrants += 1) {
    const sizes = playoffHeatSizes(entrants);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), entrants);
    assert.ok(sizes.every((size) => size >= 2 && size <= 4), `${entrants}: ${sizes.join(',')}`);
    assert.equal(sizes.filter((size) => size < 4).length <= 2, true);
  }
});

test('spreads top seeds across first-round heats and avoids immediate rematches', () => {
  for (let teamCount = 8; teamCount <= 32; teamCount += 1) {
    const plan = buildPlayoffPlan(teamCount, { format: 'single-elimination' });
    const firstRound = plan.filter((match) => match.side === 'upper' && match.round === 1);
    const heatOf = (seed: number) => firstRound.findIndex((match) => match.sources.includes(`seed:${seed}`));
    const topSeeds = Array.from({ length: firstRound.length }, (_, index) => heatOf(index + 1));
    assert.equal(new Set(topSeeds).size, firstRound.length, `${teamCount}: top seeds share a heat`);
    for (const match of plan.filter((candidate) => candidate.round > 1 && candidate.side === 'upper')) {
      const origins = match.sources.filter((source) => source.startsWith('place:')).map((source) => source.split(':')[2]);
      const firstRoundOrigins = origins.filter((origin) => firstRound.some((heat) => heat.key === origin));
      if (firstRound.length >= 4) {
        assert.equal(new Set(firstRoundOrigins).size, firstRoundOrigins.length, `${teamCount}: rematch in ${match.key}`);
      }
    }
  }
});

test('orders heats into bracket stages with the final last', () => {
  for (const teamCount of [5, 9, 16, 22]) {
    const plan = buildPlayoffPlan(teamCount);
    const stages = playoffStages(plan);
    const finalStage = stages.get(plan.at(-1)!.key)!;
    assert.ok(plan.every((match) => stages.get(match.key)! <= finalStage));
    assert.equal(Math.max(...stages.values()), finalStage);
    assert.equal(stages.get(plan[0]!.key), 1);
  }
});

test('rejects impossible playoff format options', () => {
  assert.throws(() => buildPlayoffPlan(6, { format: 'direct-final' }), RangeError);
  assert.throws(() => buildPlayoffPlan(8, { finalSize: 5 }), RangeError);
  assert.throws(() => buildPlayoffPlan(8, { finalSize: 4, finalByes: 4 }), RangeError);
  assert.throws(() => buildPlayoffPlan(8, { format: 'double-elimination', finalSize: 2, finalByes: 1 }), RangeError);
  assert.equal(buildPlayoffPlan(3, { format: 'direct-final', finalSize: 4 }).length, 1);
});
