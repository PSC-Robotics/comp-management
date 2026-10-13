import { randomBytes } from 'node:crypto';

/**
 * Relays WebRTC signalling for live audio: one broadcaster (an admin browser capturing a
 * line-in, microphone or tab) and the listening screens. Audio itself flows browser to browser;
 * this only passes offers, answers and ICE candidates. Held in memory: a restart ends the broadcast.
 */
type Send = (message: Record<string, unknown>) => void;
type Session = {
  competitionId: string;
  broadcaster?: Send | undefined;
  listeners: Map<string, Send>;
  orphanTimer?: NodeJS.Timeout | undefined;
};

const sessions = new Map<string, Session>();
const MAX_LISTENERS = 200;

export function createLiveSession(competitionId: string): string {
  for (const [id, session] of sessions) if (session.competitionId === competitionId) endLiveSession(id);
  const id = randomBytes(16).toString('base64url');
  sessions.set(id, { competitionId, listeners: new Map() });
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
    session.broadcaster?.({ type: 'leave', from: listenerId });
  };
}

export function sendToListener(id: string, listenerId: string, message: Record<string, unknown>): boolean {
  const target = sessions.get(id)?.listeners.get(listenerId);
  if (!target) return false;
  target(message);
  return true;
}

export function sendToBroadcaster(id: string, listenerId: string, message: Record<string, unknown>): boolean {
  const session = sessions.get(id);
  if (!session?.broadcaster || !session.listeners.has(listenerId)) return false;
  session.broadcaster({ ...message, from: listenerId });
  return true;
}

export function listenerCount(id: string): number {
  return sessions.get(id)?.listeners.size ?? 0;
}
