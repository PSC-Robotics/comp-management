import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../auth/sessions.js';
import { currentRevision, onChange } from '../services/changes.js';

/**
 * Server-Sent Events: emits `revision` whenever competition data changes. It
 * carries no data, only a signal to refetch, so the public variant leaks nothing.
 */
function changeStream(request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  const send = (revision: number) => {
    if (!response.writableEnded) response.write(`event: revision\ndata: ${revision}\n\n`);
  };
  response.write('retry: 3000\n\n');
  send(currentRevision());
  const unsubscribe = onChange(send);
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(': keep-alive\n\n');
  }, 20_000);
  const close = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  request.raw.on('close', close);
  response.on('error', close);
}

export function registerChangeFeedRoutes(app: FastifyInstance): void {
  app.get('/api/admin/changes', { preHandler: requireAdmin }, async (request, reply) => changeStream(request, reply));
  app.get('/api/public/changes', async (request, reply) => changeStream(request, reply));
}
