import assert from 'node:assert/strict';
import { test } from 'node:test';
import { playlistPosition, startedAtForTrack } from './audio.js';

const tracks = [{ id: 'a', durationMs: 60_000 }, { id: 'b', durationMs: 30_000 }];

test('every screen works out the same track and offset from the start time', () => {
  assert.deepEqual(playlistPosition(tracks, 1_000, 1_000, true), { index: 0, offsetMs: 0 });
  assert.deepEqual(playlistPosition(tracks, 1_000, 61_500, true), { index: 1, offsetMs: 500 });
  assert.deepEqual(playlistPosition(tracks, 1_000, 500, true), { index: 0, offsetMs: -500 }, 'waiting to start');
});

test('a looping playlist wraps; a non-looping one ends', () => {
  assert.deepEqual(playlistPosition(tracks, 0, 95_000, true), { index: 0, offsetMs: 5_000 });
  assert.equal(playlistPosition(tracks, 0, 95_000, false), null);
  assert.equal(playlistPosition([], 0, 10, true), null);
});

test('starting a given track sets the playlist start so that track begins on time', () => {
  const startedAt = startedAtForTrack(tracks, 1, 100_000);
  assert.equal(startedAt, 40_000);
  assert.deepEqual(playlistPosition(tracks, startedAt, 100_000, true), { index: 1, offsetMs: 0 });
});

test('the live delay changes rarely: once after a screen joins or leaves, or to stop dropouts', async () => {
  const { LIVE_DELAY_LIMITS, nextLiveDelay } = await import('./audio.js');
  assert.equal(nextLiveDelay(600, [], true, 100_000, 0), 600, 'no reports: unchanged');
  assert.equal(nextLiveDelay(600, [150], false, 100_000, 0), 600, 'no join or leave: never creeps down');
  assert.equal(nextLiveDelay(600, [150, 210], true, 100_000, 0), 340, 'settles once to the slowest need plus margin');
  assert.equal(nextLiveDelay(340, [400], false, 100_000, 90_000), 340, 'emergency raises are rate-limited');
  assert.equal(nextLiveDelay(340, [400], false, 100_000, 60_000), 520, 'a screen that would drop sound raises it');
  assert.equal(nextLiveDelay(340, [300], false, 100_000, 0), 340, 'a need inside the current delay does not raise it');
  assert.equal(nextLiveDelay(600, [0], true, 100_000, 0), LIVE_DELAY_LIMITS.min, 'never below the minimum');
  assert.equal(nextLiveDelay(600, [99_999], true, 100_000, 0), LIVE_DELAY_LIMITS.max, 'never beyond the maximum');
});
