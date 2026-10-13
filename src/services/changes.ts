import { EventEmitter } from 'node:events';
import type { FastifyRequest } from 'fastify';

/**
 * A single, monotonically increasing revision that bumps whenever competition
 * data changes (admin edits, match clock transitions). Dashboards and displays
 * subscribe over Server-Sent Events and refetch straight away instead of
 * waiting for their next poll. Notifications are coalesced so a burst of
 * changes produces one event.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let revision = Date.now();
let pending: NodeJS.Timeout | undefined;

export function currentRevision(): number {
  return revision;
}

export function notifyChange(): void {
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    revision += 1;
    emitter.emit('change', revision);
  }, 75);
  pending.unref?.();
}

export function onChange(listener: (revision: number) => void): () => void {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}

/** Successful admin writes change data even when they do not write an audit record. */
export function notifyChangeForRequest(request: FastifyRequest, statusCode: number): void {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
  if (statusCode >= 400) return;
  if (!request.url.startsWith('/api/admin/')) return;
  // Live-audio signalling is not competition data; it must not make every screen refetch.
  if (request.url.startsWith('/api/admin/audio-live/')) return;
  notifyChange();
}
