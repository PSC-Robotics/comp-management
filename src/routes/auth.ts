import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { identityFromClaims } from '../auth/identity.js';
import { getOidcClient, oidcState } from '../auth/oidc.js';
import { passkeyRelyingParty } from '../auth/passkey-config.js';
import { rateLimitSignIn } from '../auth/security.js';
import {
  adminIdentity, createSession, destroySession, emailAllowed, requireAdmin, upsertAdminUser
} from '../auth/sessions.js';
import { env } from '../config.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';

const signInError = (code: string) => `/?auth_error=${encodeURIComponent(code)}`;

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/auth/status', async (request) => {
    const state = oidcState();
    return {
      oidcConfigured: state.configured,
      oidcAvailable: state.available,
      passkeysAvailable: Boolean(passkeyRelyingParty(request))
    };
  });

  app.get('/auth/login', { preHandler: rateLimitSignIn }, async (_request, reply) => {
    const client = await getOidcClient();
    if (!client || !env.OIDC_REDIRECT_URI) return reply.redirect(signInError('idp_unavailable'));
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    await pool.query(
      `INSERT INTO oidc_flows (state, nonce, verifier, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [state, nonce, verifier]
    );
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: env.OIDC_REDIRECT_URI,
      scope: 'openid profile email',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce
    });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', { preHandler: rateLimitSignIn }, async (request, reply) => {
    const client = await getOidcClient();
    if (!client || !env.OIDC_REDIRECT_URI) return reply.redirect(signInError('idp_unavailable'));
    const callbackUrl = new URL(request.url, env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`);
    if (callbackUrl.searchParams.get('error')) return reply.redirect(signInError('idp_denied'));
    const state = callbackUrl.searchParams.get('state');
    if (!state || state.length > 200) return reply.redirect(signInError('invalid_state'));
    // Each sign-in attempt can be completed once, within ten minutes.
    const flow = await pool.query<{ nonce: string; verifier: string }>(
      'DELETE FROM oidc_flows WHERE state = $1 AND expires_at > now() RETURNING nonce, verifier',
      [state]
    );
    const storedFlow = flow.rows[0];
    if (!storedFlow) return reply.redirect(signInError('invalid_state'));

    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
        pkceCodeVerifier: storedFlow.verifier,
        expectedState: state,
        expectedNonce: storedFlow.nonce,
        idTokenExpected: true
      });
      claims = tokens.claims();
    } catch (error) {
      request.log.warn({ err: error }, 'OIDC code exchange failed');
      return reply.redirect(signInError('idp_error'));
    }
    if (!claims) return reply.redirect(signInError('idp_error'));
    const result = identityFromClaims(claims, env.OIDC_REQUIRE_VERIFIED_EMAIL === 'true');
    if (!result.ok) {
      request.log.warn({ emailVerified: claims.email_verified ?? null }, 'OIDC sign-in refused: verified email required');
      return reply.redirect(signInError(result.reason));
    }
    const email = result.identity;
    if (!emailAllowed(email)) return reply.redirect(signInError('not_allowed'));
    const displayName = typeof claims.name === 'string' ? claims.name : '';
    const user = await upsertAdminUser(pool, email, displayName);
    if (user.disabled) return reply.redirect(signInError('account_disabled'));
    await createSession(reply, user, 'oidc');
    await transaction((db) => audit(db, email, 'auth.signed_in', 'admin_user', user.id, { method: 'oidc', ip: request.ip }));
    return reply.redirect('/');
  });

  // Logging out must work even when the session has already expired.
  app.post('/auth/logout', async (request, reply) => {
    await destroySession(request, reply);
    return reply.code(204).send();
  });

  app.get('/api/admin/me', { preHandler: requireAdmin }, async (request) => {
    const identity = adminIdentity(request);
    const passkeys = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM passkeys WHERE user_id = $1', [identity.userId]
    );
    return {
      email: identity.email,
      userId: identity.userId,
      signedInWith: identity.method,
      passkeyCount: passkeys.rows[0]?.count ?? 0,
      passkeysAvailable: Boolean(passkeyRelyingParty(request))
    };
  });
}
