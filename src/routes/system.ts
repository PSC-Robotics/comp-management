import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicDir } from '../lib/paths.js';

const assetTypes: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/', async (_request, reply) => {
    const html = await readFile(join(publicDir, 'index.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Branding images (logo, favicon). Plain file names only, so nothing outside public/assets is reachable.
  app.get('/assets/:file', async (request, reply) => {
    const parsed = z.object({ file: z.string().max(100).regex(/^[a-z0-9][a-z0-9_-]*\.[a-z0-9]+$/i) }).safeParse(request.params);
    const type = parsed.success ? assetTypes[extname(parsed.data.file).toLowerCase()] : undefined;
    if (!parsed.success || !type) return reply.code(404).send({ error: 'Asset not found' });
    try {
      const body = await readFile(join(publicDir, 'assets', parsed.data.file));
      return reply.type(type).header('cache-control', 'public, max-age=86400').send(body);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return reply.code(404).send({ error: 'Asset not found' });
      }
      throw error;
    }
  });
}
