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

/** Live audio: shortest, longest and starting shared delay; margin over the slowest screen; timings. */
export const LIVE_DELAY_LIMITS = {
  min: 120, max: 3000, start: 600, margin: 120, step: 20,
  /** After a screen joins or leaves, wait this long for its measurements, then change once. */
  settleMs: 8000,
  /** Emergency increases (a screen would drop sound) happen at most this often. */
  raiseEveryMs: 30_000
} as const;

/** The shared delay that suits every screen: the slowest screen's need plus a safety margin. */
export function liveDelayFor(needs: number[]): number {
  const { min, max, margin, step } = LIVE_DELAY_LIMITS;
  return Math.min(max, Math.max(min, Math.ceil((Math.max(...needs) + margin) / step) * step));
}

/**
 * Whether to change the shared live-audio delay now, and to what. Every change makes a small
 * audible blip, so it changes rarely: once after a screen joins or leaves (when `settleDue`),
 * or straight away when a screen would otherwise drop sound (no more than every 30 seconds).
 */
export function nextLiveDelay(
  current: number, needs: number[], settleDue: boolean, nowMs: number, lastRaiseMs: number
): number {
  if (!needs.length) return current;
  const target = liveDelayFor(needs);
  if (settleDue) return target;
  if (Math.max(...needs) > current && target > current && nowMs - lastRaiseMs >= LIVE_DELAY_LIMITS.raiseEveryMs) return target;
  return current;
}
