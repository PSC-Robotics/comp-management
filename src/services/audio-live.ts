import { randomBytes } from 'node:crypto';
import { LIVE_DELAY_LIMITS, nextLiveDelay } from '../domain/audio.js';

/**
 * Relays live audio: one broadcaster (an admin browser capturing a line-in, microphone or tab)
 * posts encoded chunks, and every listening screen receives them over its event stream. Going
 * through the server (over ordinary HTTPS) works on any network. Held in memory: a restart ends
 * the broadcast.
 */
type Send = (message: Record<string, unknown>) => void;
type Session = {
  competitionId: string;
  broadcaster?: Send | undefined;
  listeners: Map<string, Send>;
  orphanTimer?: NodeJS.Timeout | undefined;
  /** Shared capture-to-speaker delay, and the capture time (µs) of the first chunk it applies to. */
  delayMs: number;
  delayFrom: number;
  delayChangedAt: number;
  /** Each screen's latest report of the delay it needs. */
  needs: Map<string, { needMs: number; at: number }>;
};

const sessions = new Map<string, Session>();
const MAX_LISTENERS = 200;

export function createLiveSession(competitionId: string): string {
  for (const [id, session] of sessions) if (session.competitionId === competitionId) endLiveSession(id);
  const id = randomBytes(16).toString('base64url');
  sessions.set(id, {
    competitionId, listeners: new Map(), needs: new Map(),
    delayMs: LIVE_DELAY_LIMITS.start, delayFrom: 0, delayChangedAt: Date.now()
  });
  return id;
}

export function endLiveSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.orphanTimer);
  for (const send of session.listeners.values()) send({ type: 'ended' });
  session.broadcaster?.({ type: 'ended' });
  sessions.delete(id);
}

export function liveSessionExists(id: string): boolean {
  return sessions.has(id);
}

export function liveSessionCompetition(id: string): string | undefined {
  return sessions.get(id)?.competitionId;
}

/**
 * Attaches the broadcaster's event stream. Existing listeners are announced so it can call them.
 * `onOrphaned` runs if the broadcaster stays away (tab closed) for `graceMs`.
 */
export function attachBroadcaster(id: string, send: Send, onOrphaned: () => void, graceMs = 15_000): (() => void) | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  clearTimeout(session.orphanTimer);
  session.broadcaster = send;
  for (const listener of session.listeners.keys()) send({ type: 'join', from: listener });
  send({ type: 'delay', delayMs: session.delayMs });
  return () => {
    if (session.broadcaster !== send) return;
    session.broadcaster = undefined;
    session.orphanTimer = setTimeout(() => {
      if (!session.broadcaster && sessions.get(id) === session) onOrphaned();
    }, graceMs);
    session.orphanTimer.unref?.();
  };
}

export function attachListener(id: string, listenerId: string, send: Send): (() => void) | undefined {
  const session = sessions.get(id);
  if (!session || (session.listeners.size >= MAX_LISTENERS && !session.listeners.has(listenerId))) return undefined;
  session.listeners.set(listenerId, send);
  session.broadcaster?.({ type: 'join', from: listenerId });
  return () => {
    if (session.listeners.get(listenerId) !== send) return;
    session.listeners.delete(listenerId);
    session.needs.delete(listenerId);
    session.broadcaster?.({ type: 'leave', from: listenerId });
  };
}

/**
 * Sends audio chunks from the broadcaster to every screen. Each message carries the shared delay
 * and the chunk it took effect from, so every screen switches delay on exactly the same chunk.
 */
export function relayAudio(id: string, chunks: { t: number; d: string }[], now = Date.now()): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  for (const [listener, need] of session.needs) {
    if (now - need.at > 10_000 || !session.listeners.has(listener)) session.needs.delete(listener);
  }
  const next = nextLiveDelay(session.delayMs, [...session.needs.values()].map((need) => need.needMs), now, session.delayChangedAt);
  if (next !== session.delayMs) {
    session.delayMs = next;
    session.delayFrom = chunks[0]!.t;
    session.delayChangedAt = now;
    session.broadcaster?.({ type: 'delay', delayMs: next });
  }
  const message = { type: 'audio', chunks, delayMs: session.delayMs, delayFrom: session.delayFrom };
  for (const send of session.listeners.values()) send(message);
  return true;
}

/** A screen reports how much delay it needs (its slowest recent arrivals plus its own output delay). */
export function reportListenerNeed(id: string, listenerId: string, needMs: number, now = Date.now()): boolean {
  const session = sessions.get(id);
  if (!session?.listeners.has(listenerId)) return false;
  session.needs.set(listenerId, { needMs, at: now });
  return true;
}

export function liveDelay(id: string): number | undefined {
  return sessions.get(id)?.delayMs;
}

export function listenerCount(id: string): number {
  return sessions.get(id)?.listeners.size ?? 0;
}
