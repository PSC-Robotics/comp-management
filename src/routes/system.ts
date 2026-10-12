import { join } from 'node:path';
import { publicDir } from '../lib/paths.js';
import { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/', async (_request, reply) => {
    const html = await readFile(join(publicDir, 'index.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });


}
