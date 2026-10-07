import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlayoffSeedRanks, buildDoubleEliminationPlan, playoffAdvancingPlaces, playoffSeedSnapshotMatchesRanks, rankPlayoffScores, resolvePlayoffAdvancements } from './playoffs.js';
function createBracket(teamCount) {
    const plan = buildDoubleEliminationPlan(teamCount);
    const seedTeams = new Map(Array.from({ length: teamCount }, (_, index) => [index + 1, `team-${index + 1}`]));
    const matches = plan.map((match) => ({
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
        assert.equal(plan.at(-1)?.sources.filter((source) => source !== 'bye').length, teamCount <= 4 ? teamCount : 4);
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
        const expected = [...scores].sort((left, right) => right.points - left.points || seedRanks[left.teamId] -
            seedRanks[right.teamId]).map((score) => score.teamId);
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
    const initial = plan.map((match) => ({
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
    assert.equal(playoffSeedSnapshotMatchesRanks([{ id: 'team-a' }, { id: 'team-a' }], 2, { 'team-a': 1, 'team-b': 2 }), false);
    assert.equal(playoffSeedSnapshotMatchesRanks(standings, 2, { 'team-a': 1, 'team-b': 2, 'team-c': 3 }), false);
});
test('seed-based tie breaking remains deterministic across every entrant order', () => {
    for (let entrantCount = 2; entrantCount <= 4; entrantCount += 1) {
        const teamIds = Array.from({ length: entrantCount }, (_, index) => `team-${index + 1}`);
        const seedRanks = Object.fromEntries(teamIds.map((id, index) => [id, index + 1]));
        const points = teamIds.map((teamId) => ({ teamId, points: 10 }));
        const expected = [...teamIds].sort((left, right) => seedRanks[left] - seedRanks[right]);
        for (let offset = 0; offset < entrantCount; offset += 1) {
            const reordered = [...points.slice(offset), ...points.slice(0, offset)].reverse();
            assert.deepEqual(rankPlayoffScores(reordered, seedRanks), expected);
        }
    }
});
test('supports two- and three-team finals without adding empty score slots', () => {
    for (const teamCount of [2, 3]) {
        const { matches, seedTeams } = createBracket(teamCount);
        const final = matches[0];
        const participants = final.teamIds.filter((teamId) => teamId !== null);
        assert.equal(final.status, 'ready');
        assert.equal(participants.length, teamCount);
        const seedRanks = Object.fromEntries([...seedTeams].map(([seed, teamId]) => [teamId, seed]));
        const placements = rankPlayoffScores(participants.map((teamId, index) => ({ teamId, points: teamCount - index })), seedRanks);
        assert.equal(placements.length, teamCount);
    }
});
test('simulates two-loss elimination and a four-team final for arbitrary field sizes', () => {
    for (let teamCount = 5; teamCount <= 64; teamCount += 1) {
        const { plan, seedTeams, matches: initial } = createBracket(teamCount);
        let matches = initial;
        const losses = new Map([...seedTeams.values()].map((teamId) => [teamId, 0]));
        let finalPlacements = null;
        for (let turn = 0; turn < plan.length; turn += 1) {
            const ready = matches.find((candidate) => candidate.status === 'ready');
            if (!ready)
                break;
            const participants = ready.teamIds.filter((teamId) => teamId !== null);
            assert.ok(participants.length >= 2 && participants.length <= 4);
            assert.equal(new Set(participants).size, participants.length);
            const seedsByTeam = new Map([...seedTeams].map(([seed, teamId]) => [teamId, seed]));
            const placements = participants.sort((left, right) => {
                const points = (teamId) => (Number(teamId.slice(5)) * 37 + turn * 19) % 101;
                return points(right) - points(left) || seedsByTeam.get(left) - seedsByTeam.get(right);
            });
            ready.placements = placements;
            ready.status = 'complete';
            if (ready.side === 'final') {
                finalPlacements = placements;
            }
            else {
                for (const teamId of placements.slice(playoffAdvancingPlaces(placements.length))) {
                    losses.set(teamId, losses.get(teamId) + 1);
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
            if (!finalPlacements.includes(teamId))
                assert.equal(lossCount, 2, `${teamId} in a ${teamCount}-team bracket`);
        }
    }
});
