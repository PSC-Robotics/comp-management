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
