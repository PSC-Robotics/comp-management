import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { registerSecurity } from './auth/security.js';
import { env, trustProxySetting } from './config.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChallengeRoutes } from './routes/challenges.js';
import { registerCompetitionRoutes } from './routes/competitions.js';
import { registerDelayRoutes } from './routes/delays.js';
import { registerDisplayAdminRoutes } from './routes/displays-admin.js';
import { registerDisplayPageRoutes } from './routes/display-page.js';
import { registerEventRoutes } from './routes/events.js';
import { registerLiveRoutes } from './routes/live.js';
import { registerPasskeyRoutes } from './routes/passkeys.js';
import { registerPlayoffRoutes } from './routes/playoffs.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerScoreRoutes } from './routes/scores.js';
import { registerSrcompRoutes } from './routes/srcomp.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerUserRoutes } from './routes/users.js';
import { registerChangeFeedRoutes } from './routes/changes.js';
import { notifyChangeForRequest } from './services/changes.js';

export type BuildAppOptions = {
  logger?: FastifyServerOptions['logger'];
  /** Filled with every registered route (used by the integration fuzz tests). */
  routes?: { method: string; url: string }[];
};

/** Builds the HTTP application without listening, so tests can drive it with `app.inject`. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? { level: env.LOG_LEVEL },
    trustProxy: trustProxySetting(),
    bodyLimit: 2 * 1024 * 1024,
    // Reject absurd URLs and parameters early instead of passing them to handlers.
    routerOptions: { maxParamLength: 200 }
  });
  if (options.routes) {
    const collected = options.routes;
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) collected.push({ method, url: route.url });
    });
  }
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  registerSecurity(app);

  registerSystemRoutes(app);
  registerAuthRoutes(app);
  registerPasskeyRoutes(app);
  registerUserRoutes(app);
  registerChangeFeedRoutes(app);
  registerCompetitionRoutes(app);
  registerDisplayAdminRoutes(app);
  registerTeamRoutes(app);
  registerChallengeRoutes(app);
  registerEventRoutes(app);
  registerScheduleRoutes(app);
  registerDelayRoutes(app);
  registerLiveRoutes(app);
  registerScoreRoutes(app);
  registerPlayoffRoutes(app);
  registerAuditRoutes(app);
  registerPublicRoutes(app);
  registerDisplayPageRoutes(app);
  registerSrcompRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    const sqlState = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const declared = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode) : NaN;
    // Map database errors caused by bad input (invalid text for a column, out-of-range numbers,
    // foreign keys, check constraints) to client errors instead of crashing with a 500.
    const status = error instanceof z.ZodError ? 400
      : sqlState === '23505' ? 409
        : ['22P02', '22003', '22007', '22008', '23503', '23514', '22001'].includes(sqlState) ? 400
          : sqlState === '40001' || sqlState === '40P01' ? 409
            : Number.isInteger(declared) && declared >= 400 && declared < 600 ? declared
              : 500;
    if (status >= 500) request.log.error(error);
    else request.log.info({ err: error }, 'request rejected');
    const message = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')
      : sqlState === '23505' ? 'A record with this identifier already exists'
        : sqlState === '40001' || sqlState === '40P01' ? 'Another change happened at the same time; please try again'
          : status >= 500 ? 'The request could not be completed'
            : ['22P02', '22003', '22007', '22008', '23503', '23514', '22001'].includes(sqlState) ? 'The request contained an invalid value'
              : error instanceof Error ? error.message : 'Request failed';
    if (reply.sent) return;
    return reply.code(status).send({ error: message });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: `No route for ${request.method} ${request.url.split('?')[0]}` }));

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-server-time', new Date().toISOString());
    return payload;
  });
  // Tell connected dashboards and displays that something changed, so they refresh at once.
  app.addHook('onResponse', async (request, reply) => notifyChangeForRequest(request, reply.statusCode));
  return app;
}
