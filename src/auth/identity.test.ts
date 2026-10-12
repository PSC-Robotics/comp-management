import assert from 'node:assert/strict';
import test from 'node:test';
import { identityFromClaims } from './identity.js';

test('accepts the provider email even when it is not marked verified (Authentik default)', () => {
  assert.deepEqual(identityFromClaims({ sub: '1', email: ' Person@Example.ORG ', email_verified: false }, false),
    { ok: true, identity: 'person@example.org', viaEmail: true });
});

test('falls back to the username, then the subject, when there is no email', () => {
  assert.deepEqual(identityFromClaims({ sub: '1', preferred_username: 'Akadmin' }, false),
    { ok: true, identity: 'akadmin', viaEmail: false });
  assert.deepEqual(identityFromClaims({ sub: 'abc' }, false), { ok: true, identity: 'oidc:abc', viaEmail: false });
});

test('optionally insists on a verified email', () => {
  assert.equal(identityFromClaims({ sub: '1', email: 'a@b.c', email_verified: false }, true).ok, false);
  assert.equal(identityFromClaims({ sub: '1', email: 'a@b.c' }, true).ok, false);
  assert.equal(identityFromClaims({ sub: '1', preferred_username: 'x' }, true).ok, false);
  assert.deepEqual(identityFromClaims({ sub: '1', email: 'a@b.c', email_verified: true }, true),
    { ok: true, identity: 'a@b.c', viaEmail: true });
});
