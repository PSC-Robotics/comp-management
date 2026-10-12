export type IdentityClaims = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  preferred_username?: unknown;
};

export type IdentityResult =
  | { ok: true; identity: string; viaEmail: boolean }
  | { ok: false; reason: 'email_unverified' };

/**
 * Turns ID-token claims into the administrator identity. The email is used when
 * present (lower-cased), otherwise the username, otherwise the subject.
 *
 * Many identity providers (Authentik's default mapping among them) report
 * `email_verified: false` even for accounts their administrators created, so
 * requiring verification is opt-in. Turn it on when the provider lets people
 * register themselves with an email address they might not own.
 */
export function identityFromClaims(claims: IdentityClaims, requireVerifiedEmail: boolean): IdentityResult {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (requireVerifiedEmail && (!email || claims.email_verified !== true)) {
    return { ok: false, reason: 'email_unverified' };
  }
  if (email) return { ok: true, identity: email, viaEmail: true };
  const username = typeof claims.preferred_username === 'string' ? claims.preferred_username.trim().toLowerCase() : '';
  if (username) return { ok: true, identity: username, viaEmail: false };
  return { ok: true, identity: `oidc:${String(claims.sub ?? 'unknown')}`, viaEmail: false };
}
