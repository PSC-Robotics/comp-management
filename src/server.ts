import { buildApp } from './app.js';
import { startOidcDiscovery } from './auth/oidc.js';
import { env } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/schema.js';
import { startBackgroundJobs } from './services/background.js';

const app = await buildApp();

process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'Unhandled promise rejection'));
process.on('uncaughtException', (error) => app.log.fatal({ err: error }, 'Uncaught exception'));

// Wait for the database (it may still be starting) rather than exiting on the first failure.
for (let attempt = 1; ; attempt += 1) {
  try {
    await migrate(pool);
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    app.log.warn({ err: error, attempt }, 'Database not ready; retrying schema setup');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Live audio sessions are held in memory, so none survive a restart: stop any left marked live.
await pool.query(`UPDATE audio_playback SET mode = 'stopped', live_session = NULL, updated_at = now() WHERE mode = 'live'`);

// Sign-in via the identity provider is optional at start-up: if it is down, the app still
// starts (passkeys keep working) and discovery keeps retrying in the background.
startOidcDiscovery(app.log);
const stopJobs = startBackgroundJobs(app.log);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  stopJobs();
  await app.close().catch((error: unknown) => app.log.error({ err: error }, 'Error closing HTTP server'));
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (error) {
  app.log.error(error);
  stopJobs();
  await app.close();
  await pool.end();
  process.exitCode = 1;
}
