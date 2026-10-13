import assert from 'node:assert/strict';
import test from 'node:test';
import { computeStagingWindows } from './staging.js';

const minute = 60_000;
const match = (key: string, arena: string, start: number, extra: Partial<Parameters<typeof computeStagingWindows>[0][number]> = {}) =>
  ({ key, arena, state: 'scheduled', effectiveStart: start * minute, actualStart: null, countdownStartedAt: null, ...extra });

test('staging opens when the previous match starts and closes after the configured minutes', () => {
  const windows = computeStagingWindows([match('m1', 'A', 0), match('m2', 'A', 10), match('m3', 'A', 20)],
    { closeAfterPreviousStartMinutes: 5, firstMatchLeadMinutes: 10 });
  assert.deepEqual(windows.get('m1'), { opens: -10 * minute, closes: -5 * minute, signalShepherds: -10 * minute });
  assert.deepEqual(windows.get('m2'), { opens: 0, closes: 5 * minute, signalShepherds: 0 });
  assert.deepEqual(windows.get('m3'), { opens: 10 * minute, closes: 15 * minute, signalShepherds: 10 * minute });
});

test('staging never stays open after the match itself starts (short slots, long setting)', () => {
  const windows = computeStagingWindows([match('m1', 'A', 0), match('m2', 'A', 4)], { closeAfterPreviousStartMinutes: 5, firstMatchLeadMinutes: 10 });
  assert.equal(windows.get('m2')!.closes, 4 * minute);
});

test('uses the real start of the previous match, including a late start or a countdown', () => {
  const late = computeStagingWindows([match('m1', 'A', 0, { state: 'running', actualStart: 3 * minute }), match('m2', 'A', 10)]);
  assert.equal(late.get('m2')!.opens, 3 * minute);
  assert.equal(late.get('m2')!.closes, 8 * minute);
  const countingDown = computeStagingWindows([match('m1', 'A', 0, { countdownStartedAt: 2 * minute }), match('m2', 'A', 10)]);
  assert.equal(countingDown.get('m2')!.opens, 2 * minute + 5_000);
});

test('arenas are independent and cancelled matches are ignored', () => {
  const windows = computeStagingWindows([match('a1', 'A', 0), match('b1', 'B', 0), match('a2', 'A', 10), match('x', 'A', 5, { state: 'cancelled' })]);
  assert.equal(windows.get('a2')!.opens, 0);
  assert.equal(windows.get('b1')!.opens, -10 * minute);
  assert.equal(windows.has('x'), false);
});
