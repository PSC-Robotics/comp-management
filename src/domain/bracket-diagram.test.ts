import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBracketDiagram } from './bracket-diagram.js';
import { buildPlayoffPlan } from './playoffs.js';

const heatsFor = (teamCount: number, options = {}) => buildPlayoffPlan(teamCount, options).map((match, index) => ({
  id: match.key,
  number: index + 1,
  side: match.side,
  sources: [...match.sources],
  advancing: match.side === 'final' ? null : match.advancing
}));

test('draws one box per heat and one line per fed entrant slot', () => {
  for (const [teamCount, options] of [[12, {}], [9, { format: 'single-elimination' }], [10, { finalByes: 2 }]] as const) {
    const heats = heatsFor(teamCount, options);
    const svg = renderBracketDiagram(heats, { format: (options as { format?: string }).format ?? 'double-elimination' });
    const fedSlots = heats.flatMap((heat) => heat.sources).filter((source) => source.startsWith('place:')).length;
    assert.equal((svg.match(/class="bd-heat /g) ?? []).length, heats.length);
    assert.equal((svg.match(/class="bd-edge /g) ?? []).length, fedSlots);
    assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
    assert.doesNotMatch(svg, /NaN|undefined/);
  }
});

test('marks drops to the lower bracket and only shows bands for double elimination', () => {
  const double = renderBracketDiagram(heatsFor(8), { format: 'double-elimination' });
  assert.match(double, /class="bd-edge bd-edge-drop"/);
  assert.match(double, /LOWER BRACKET/);
  const single = renderBracketDiagram(heatsFor(8, { format: 'single-elimination' }), { format: 'single-elimination' });
  assert.doesNotMatch(single, /class="bd-edge bd-edge-drop"|LOWER BRACKET/);
});

test('shows results with advancing places and escapes text', () => {
  const svg = renderBracketDiagram([{
    id: 'h1', number: 1, side: 'upper', sources: ['seed:1', 'seed:2', 'seed:3', 'seed:4'], advancing: 2,
    results: [{ team: 'AAA', points: 9 }, { team: 'B<B', points: 7 }, { team: 'CCC', points: 3 }, { team: 'DDD', points: 1 }],
    status: '<b>', arena: 'A & B'
  }], { format: 'double-elimination' });
  assert.equal((svg.match(/class="bd-row bd-row-advance"/g) ?? []).length, 2);
  assert.equal((svg.match(/class="bd-row bd-row-drop"/g) ?? []).length, 2);
  assert.match(svg, /B&lt;B/);
  assert.match(svg, /A &amp; B/);
  assert.doesNotMatch(svg, /<b>/);
  assert.equal(renderBracketDiagram([]), '');
});
