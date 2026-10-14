/**
 * Synchronised playlist playback. The server stores only when position 0 of the playlist
 * played (startedAt); every screen derives the current track and offset from its server
 * clock, so all screens agree without anything being streamed.
 */
export type AudioTrack = { id: string; durationMs: number };

/** How far ahead a play/skip is scheduled so every screen hears about it before it starts. */
export const AUDIO_START_LEAD_MS = 1500;

export function playlistDuration(tracks: AudioTrack[]): number {
  return tracks.reduce((total, track) => total + track.durationMs, 0);
}

/**
 * The track playing at `nowMs` and how far into it. A negative offset means the first track
 * starts in that many milliseconds. Null when nothing should play (empty playlist, or the
 * end of a non-looping playlist has passed).
 */
export function playlistPosition(
  tracks: AudioTrack[],
  startedAtMs: number,
  nowMs: number,
  loop: boolean
): { index: number; offsetMs: number } | null {
  const total = playlistDuration(tracks);
  if (!tracks.length || total <= 0) return null;
  let position = nowMs - startedAtMs;
  if (position < 0) return { index: 0, offsetMs: position };
  if (position >= total) {
    if (!loop) return null;
    position %= total;
  }
  for (let index = 0; index < tracks.length; index++) {
    const duration = tracks[index]!.durationMs;
    if (position < duration) return { index, offsetMs: position };
    position -= duration;
  }
  return null;
}

/** startedAt that makes track `index` begin at `startMs`. */
export function startedAtForTrack(tracks: AudioTrack[], index: number, startMs: number): number {
  return startMs - playlistDuration(tracks.slice(0, index));
}

/** Live audio: shortest and longest shared delay, the margin over the slowest screen, the step down. */
export const LIVE_DELAY_LIMITS = { min: 120, max: 3000, start: 500, margin: 80, step: 20, stepEveryMs: 3000 } as const;

/**
 * The shared live-audio delay (capture to speaker) for every screen. `needs` are the screens'
 * recent reports of how much delay they need. It rises at once when any screen needs more (so
 * nothing drops out) and falls one 20 ms chunk at a time once every screen has room to spare.
 */
export function nextLiveDelay(current: number, needs: number[], nowMs: number, lastChangeMs: number): number {
  if (!needs.length) return current;
  const { min, max, margin, step, stepEveryMs } = LIVE_DELAY_LIMITS;
  const target = Math.min(max, Math.max(min, Math.ceil((Math.max(...needs) + margin) / step) * step));
  if (target > current) return target;
  if (target <= current - step && nowMs - lastChangeMs >= stepEveryMs) return current - step;
  return current;
}
