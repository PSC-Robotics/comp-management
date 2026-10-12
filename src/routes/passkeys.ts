import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse,
  verifyRegistrationResponse, type AuthenticatorTransportFuture, type RegistrationResponseJSON
} from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { passkeyRelyingParty, type RelyingParty } from '../auth/passkey-config.js';
import { rateLimitSignIn } from '../auth/security.js';
import {
  adminIdentity, createSession, emailAllowed, hashToken, requireAdmin, upsertAdminUser, type AdminUser
} from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';

const CHALLENGE_MINUTES = 5;
// WebAuthn response bodies are opaque JSON from the browser; the library validates their contents.
const credentialResponse = z.object({ id: z.string().min(1).max(1024), rawId: z.string().max(1024), type: z.literal('public-key') }).passthrough();

function relyingParty(request: FastifyRequest, reply: FastifyReply): RelyingParty | undefined {
  const rp = passkeyRelyingParty(request);
  if (!rp) {
    void reply.code(400).send({ error: 'Passkeys need the site to be served over HTTPS at PUBLIC_BASE_URL' });
  }
  return rp;
}

async function storeChallenge(purpose: 'register' | 'login' | 'enroll', challenge: string, userId: string | null) {
  const id = randomBytes(18).toString('base64url');
  await pool.query(
    `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'))`,
    [id, challenge, purpose, userId, CHALLENGE_MINUTES]
  );
  return id;
}

/** Each challenge can be used once, for its own purpose, before it expires. */
async function consumeChallenge(id: string, purpose: string, userId: string | null): Promise<string | undefined> {
  const result = await pool.query<{ challenge: string }>(
    `DELETE FROM webauthn_challenges
     WHERE id = $1 AND purpose = $2 AND expires_at > now() AND user_id IS NOT DISTINCT FROM $3
     RETURNING challenge`,
    [id, purpose, userId]
  );
  return result.rows[0]?.challenge;
}

async function savePasskey(
  userId: string,
  name: string,
  info: NonNullable<Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo']>
) {
  await pool.query(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [info.credential.id, userId, Buffer.from(info.credential.publicKey), info.credential.counter,
      info.credential.transports ?? [], info.credentialDeviceType, info.credentialBackedUp, name]
  );
}

async function registrationOptions(rp: RelyingParty, user: { id: string; email: string; display_name?: string }) {
  const existing = await pool.query<{ id: string; transports: string[] }>(
    'SELECT id, transports FROM passkeys WHERE user_id = $1', [user.id]
  );
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.display_name || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.rows.map((passkey) => ({
      id: passkey.id, transports: passkey.transports as AuthenticatorTransportFuture[]
    })),
    // Discoverable credentials let you sign in without typing an email; verification means
    // the device checked a PIN, fingerprint or face.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
  });
}

async function verifyRegistration(rp: RelyingParty, response: unknown, expectedChallenge: string) {
  try {
    return await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true
    });
  } catch {
    return undefined;
  }
}

export function registerPasskeyRoutes(app: FastifyInstance): void {
  // Adding a passkey to your own account (while signed in).
  app.post('/api/admin/passkeys/register/options', { preHandler: requireAdmin }, async (request, reply) => {
    const rp = relyingParty(request, reply);
    if (!rp) return;
    const identity = adminIdentity(request);
    const options = await registrationOptions(rp, { id: identity.userId, email: identity.email });
    const challengeId = await storeChallenge('register', options.challenge, identity.userId);
    return { challengeId, options };
  });

  app.post('/api/admin/passkeys/register/verify', { preHandler: requireAdmin }, async (request, reply) => {
    const body = z.object({
      challengeId: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(80).default('Passkey'),
      response: credentialResponse
    }).parse(request.body);
    const rp = relyingParty(request, reply);
    if (!rp) return;
    const identity = adminIdentity(request);
    const challenge = await consumeChallenge(body.challengeId, 'register', identity.userId);
    if (!challenge) return reply.code(400).send({ error: 'This passkey request expired. Try again.' });
    const verification = await verifyRegistration(rp, body.response, challenge);
    if (!verification?.verified) return reply.code(400).send({ error: 'The passkey could not be verified' });
    await savePasskey(identity.userId, body.name, verification.registrationInfo);
    await transaction((db) => audit(db, identity.email, 'passkey.registered', 'admin_user', identity.userId, { name: body.name }));
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/admin/passkeys', { preHandler: requireAdmin }, async (request) => {
    const result = await pool.query(
      `SELECT id, name, device_type, backed_up, created_at, last_used_at
       FROM passkeys WHERE user_id = $1 ORDER BY created_at`,
      [adminIdentity(request).userId]
    );
    return result.rows;
  });

  app.patch('/api/admin/passkeys/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(1024) }).parse(request.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const result = await pool.query('UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2',
      [id, adminIdentity(request).userId, name]);
    if (!result.rowCount) return reply.code(404).send({ error: 'Passkey not found' });
    return { ok: true };
  });

  app.delete('/api/admin/passkeys/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(1024) }).parse(request.params);
    const identity = adminIdentity(request);
    const result = await pool.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [id, identity.userId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'Passkey not found' });
    await transaction((db) => audit(db, identity.email, 'passkey.removed', 'admin_user', identity.userId, {}));
    return reply.code(204).send();
  });

  // Signing in with a passkey: works even when the identity provider is down.
  app.post('/auth/passkey/options', { preHandler: rateLimitSignIn }, async (request, reply) => {
    const rp = relyingParty(request, reply);
    if (!rp) return;
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' });
    const challengeId = await storeChallenge('login', options.challenge, null);
    return { challengeId, options };
  });

  app.post('/auth/passkey/verify', { preHandler: rateLimitSignIn }, async (request, reply) => {
    const body = z.object({ challengeId: z.string().min(1).max(64), response: credentialResponse }).parse(request.body);
    const rp = relyingParty(request, reply);
    if (!rp) return;
    const challenge = await consumeChallenge(body.challengeId, 'login', null);
    if (!challenge) return reply.code(400).send({ error: 'This sign-in request expired. Try again.' });
    const stored = await pool.query<{
      id: string; public_key: Buffer; counter: string; transports: string[];
      user_id: string; email: string; disabled: boolean; display_name: string;
    }>(
      `SELECT p.id, p.public_key, p.counter, p.transports, u.id AS user_id, u.email, u.disabled, u.display_name
       FROM passkeys p JOIN admin_users u ON u.id = p.user_id WHERE p.id = $1`,
      [body.response.id]
    );
    const passkey = stored.rows[0];
    // The same message for every failure, so the endpoint does not reveal which passkeys exist.
    const rejected = () => reply.code(401).send({ error: 'Passkey sign-in failed' });
    if (!passkey || passkey.disabled || !emailAllowed(passkey.email)) return rejected();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response as unknown as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[]
        },
        requireUserVerification: true
      });
    } catch {
      return rejected();
    }
    if (!verification.verified) return rejected();
    await pool.query('UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1',
      [passkey.id, verification.authenticationInfo.newCounter]);
    const user: AdminUser = { id: passkey.user_id, email: passkey.email, disabled: false, display_name: passkey.display_name };
    await createSession(reply, user, 'passkey');
    await transaction((db) => audit(db, user.email, 'auth.signed_in', 'admin_user', user.id, { method: 'passkey', ip: request.ip }));
    return { ok: true };
  });

  // Break-glass enrollment: a one-time link created on the server with `npm run admin -- invite <email>`.
  app.post('/auth/passkey/enroll/options', { preHandler: rateLimitSignIn }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.body);
    const rp = relyingParty(request, reply);
    if (!rp) return;
    const invite = await pool.query<{ email: string }>(
      'SELECT email FROM passkey_enrollments WHERE token_hash = $1 AND expires_at > now()', [hashToken(token)]
    );
    const email = invite.rows[0]?.email;
    if (!email) return reply.code(400).send({ error: 'This enrollment link is invalid or has expired' });
    const user = await upsertAdminUser(pool, email);
    if (user.disabled) return reply.code(403).send({ error: 'This account is disabled' });
    const options = await registrationOptions(rp, user);
    const challengeId = await storeChallenge('enroll', options.challenge, user.id);
    return { challengeId, options, email };
  });

  app.post('/auth/passkey/enroll/verify', { preHandler: rateLimitSignIn }, async (request, reply) => {
    const body = z.object({
      token: z.string().min(20).max(200),
      challengeId: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(80).default('Passkey'),
      response: credentialResponse
    }).parse(request.body);
    const rp = relyingParty(request, reply);
    if (!rp) return;
    const invite = await pool.query<{ email: string }>(
      'DELETE FROM passkey_enrollments WHERE token_hash = $1 AND expires_at > now() RETURNING email',
      [hashToken(body.token)]
    );
    const email = invite.rows[0]?.email;
    if (!email) return reply.code(400).send({ error: 'This enrollment link is invalid or has expired' });
    const user = await upsertAdminUser(pool, email);
    const challenge = await consumeChallenge(body.challengeId, 'enroll', user.id);
    if (!challenge || user.disabled) return reply.code(400).send({ error: 'This passkey request expired. Ask for a new link.' });
    const verification = await verifyRegistration(rp, body.response, challenge);
    if (!verification?.verified) return reply.code(400).send({ error: 'The passkey could not be verified' });
    await savePasskey(user.id, body.name, verification.registrationInfo);
    await createSession(reply, user, 'passkey');
    await transaction((db) => audit(db, user.email, 'passkey.enrolled_by_invite', 'admin_user', user.id, { name: body.name }));
    return reply.code(201).send({ ok: true });
  });
}

/** Creates a one-time passkey enrollment link (used by the admin CLI). */
export async function createEnrollmentInvite(email: string, minutes: number, createdBy: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO passkey_enrollments (token_hash, email, created_by, expires_at)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 minute'))`,
    [hashToken(token), email.toLowerCase(), createdBy, minutes]
  );
  return token;
}

