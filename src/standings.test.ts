import assert from 'node:assert/strict';
import test from 'node:test';
import { rankStandings } from './standings.js';
import { findDecisivePlayoffTies, validateTieBreakOrder } from './playoffs.js';

const team = (code: string, leaguePoints: number, matchPoints = leaguePoints) =>
  ({ id: code, code, leaguePoints, matchPoints });

test('breaks league ties by match points, head-to-head, then best match, and flags the rest', () => {
  const ranked = rankStandings([
    team('AAA', 20, 10), team('BBB', 20, 20), team('CCC', 15), team('DDD', 15), team('EEE', 12), team('FFF', 12),
    team('GGG', 5), team('HHH', 5)
  ], [
    // CCC beat DDD where they met
    { matchId: 'm1', teamId: 'CCC', points: 9 }, { matchId: 'm1', teamId: 'DDD', points: 4 },
    { matchId: 'm2', teamId: 'CCC', points: 6 }, { matchId: 'm3', teamId: 'DDD', points: 11 },
    // EEE and FFF never met; FFF has the best single match
    { matchId: 'm4', teamId: 'EEE', points: 6 }, { matchId: 'm5', teamId: 'EEE', points: 6 },
    { matchId: 'm6', teamId: 'FFF', points: 10 }, { matchId: 'm7', teamId: 'FFF', points: 2 },
    // GGG and HHH identical in every respect
    { matchId: 'm8', teamId: 'GGG', points: 5 }, { matchId: 'm9', teamId: 'HHH', points: 5 }
  ]);
  assert.deepEqual(ranked.map((entry) => entry.code), ['BBB', 'AAA', 'CCC', 'DDD', 'FFF', 'EEE', 'GGG', 'HHH']);
  assert.deepEqual(ranked.filter((entry) => entry.tiedWith.length).map((entry) => [entry.code, entry.tiedWith]),
    [['GGG', ['HHH']], ['HHH', ['GGG']]]);
});

test('only reports heat ties that change where teams go', () => {
  const points = new Map([['A', 9], ['B', 5], ['C', 5], ['D', 1]]);
  const placement = ['A', 'B', 'C', 'D'];
  // Top two advance: B and C tie across the boundary.
  assert.deepEqual(findDecisivePlayoffTies(placement, points, (place) => place <= 2 ? 'next' : 'lower'),
    [{ places: [2, 3], teamIds: ['B', 'C'] }]);
  // Places 2 and 3 both drop to the same heat: the tie does not matter.
  assert.deepEqual(findDecisivePlayoffTies(placement, points, (place) => place === 1 ? 'next' : 'lower'), []);
  // In a final every place is distinct.
  assert.equal(findDecisivePlayoffTies(placement, points, (place) => `final:${place}`).length, 1);
});

test('a judge may only reorder teams on equal points', () => {
  const points = new Map([['A', 9], ['B', 5], ['C', 5]]);
  assert.equal(validateTieBreakOrder(['A', 'C', 'B'], points), null);
  assert.match(validateTieBreakOrder(['B', 'A', 'C'], points) ?? '', /equal points/);
  assert.match(validateTieBreakOrder(['A', 'B'], points) ?? '', /every team/);
  assert.match(validateTieBreakOrder(['A', 'B', 'B'], points) ?? '', /every team/);
});
