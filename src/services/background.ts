import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../db/pool.js';
import { processMatchClocks } from './clock.js';

/** Starts the match clock (every second) and housekeeping (every ten minutes). Returns a stop function. */
export function startBackgroundJobs(log: FastifyBaseLogger): () => void {
  let clockRunning = false;
  let consecutiveFailures = 0;
  const clock = setInterval(() => {
    if (clockRunning) return;
    clockRunning = true;
    void processMatchClocks().then(() => {
      if (consecutiveFailures) log.info('Match clock processing recovered');
      consecutiveFailures = 0;
    }).catch((error: unknown) => {
      consecutiveFailures += 1;
      // Log the first failure and then every minute, so a database outage does not flood the log.
      if (consecutiveFailures === 1 || consecutiveFailures % 60 === 0) {
        log.error({ err: error, consecutiveFailures }, 'Match clock processing failed');
      }
    }).finally(() => {
      clockRunning = false;
    });
  }, 1000);

  const housekeeping = setInterval(() => {
    void pool.query(
      `DELETE FROM admin_sessions WHERE expires_at < now();
       DELETE FROM oidc_flows WHERE expires_at < now();
       DELETE FROM webauthn_challenges WHERE expires_at < now();
       DELETE FROM passkey_enrollments WHERE expires_at < now();`
    ).catch((error: unknown) => log.warn({ err: error }, 'Session housekeeping failed'));
  }, 10 * 60 * 1000);
  housekeeping.unref();

  return () => {
    clearInterval(clock);
    clearInterval(housekeeping);
  };
}
