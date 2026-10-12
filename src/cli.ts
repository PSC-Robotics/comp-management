/**
 * Administrative commands, run on the server:
 *   docker compose exec app node dist/cli.js invite someone@example.com [minutes]
 *   docker compose exec app node dist/cli.js users
 */
import { env } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/schema.js';
import { createEnrollmentInvite } from './routes/passkeys.js';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  await migrate(pool);
  if (command === 'invite') {
    const email = args[0]?.trim().toLowerCase();
    const minutes = Number(args[1] ?? 30);
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      console.error('Usage: invite <email> [minutes 1-1440, default 30]');
      return 2;
    }
    const token = await createEnrollmentInvite(email, minutes, 'cli');
    const base = env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`;
    console.log(`One-time passkey enrollment link for ${email} (valid ${minutes} minutes):`);
    console.log(`${base.replace(/\/$/, '')}/#enroll=${token}`);
    return 0;
  }
  if (command === 'users') {
    const users = await pool.query(
      `SELECT u.email, u.disabled, u.last_login_at, count(p.id)::int AS passkeys
       FROM admin_users u LEFT JOIN passkeys p ON p.user_id = u.id GROUP BY u.id ORDER BY u.email`
    );
    console.table(users.rows);
    return 0;
  }
  console.error('Commands: invite <email> [minutes] | users');
  return 2;
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
}
