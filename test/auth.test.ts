import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
// Only these accounts may sign in; everyone else is turned away even with a session.
before(async () => { if (!skip) h = await startHarness({ ADMIN_EMAILS: 'boss@test.local, Second@Test.Local' }); });
after(async () => { if (h) await h.close(); });

test('admin API requires a valid, unexpired session for an allowed, enabled user', { skip }, async () => {
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/competitions', as: null })).statusCode, 401);
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/competitions', as: { cookie: 'competition_session=nope' } })).statusCode, 401);

  const boss = await h.createAdmin('boss@test.local');
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/me', as: boss })).statusCode, 200);
  const second = await h.createAdmin('second@test.local');
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/me', as: second })).statusCode, 200, 'allowlist is case-insensitive');

  // The harness's default admin is not on the allowlist.
  const outsider = await h.request({ method: 'GET', url: '/api/admin/me' });
  assert.equal(outsider.statusCode, 401);
  assert.match(outsider.body, /not allowed/);

  const token = boss.cookie.split('=')[1]!;
  await h.pool.query(`UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
    [createHash('sha256').update(token).digest('hex')]);
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/me', as: boss })).statusCode, 401, 'expired session');
});

test('disabling a user signs them out everywhere; you cannot disable yourself', { skip }, async () => {
  const boss = await h.createAdmin('boss@test.local');
  const second = await h.createAdmin('second@test.local');
  const self = await h.request({ method: 'PATCH', url: `/api/admin/users/${boss.userId}`, as: boss, payload: { disabled: true } });
  assert.equal(self.statusCode, 409);
  const disabled = await h.request({ method: 'PATCH', url: `/api/admin/users/${second.userId}`, as: boss, payload: { disabled: true } });
  assert.equal(disabled.statusCode, 200);
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/me', as: second })).statusCode, 401);
  const users = JSON.parse((await h.request({ method: 'GET', url: '/api/admin/users', as: boss })).body);
  assert.ok(users.some((user: any) => user.email === 'second@test.local' && user.disabled && user.active_sessions === 0));
  await h.request({ method: 'PATCH', url: `/api/admin/users/${second.userId}`, as: boss, payload: { disabled: false } });
});

test('state-changing requests from another site are blocked', { skip }, async () => {
  const boss = await h.createAdmin('boss@test.local');
  const crossSite = await h.request({
    method: 'POST', url: '/api/admin/competitions', as: boss,
    headers: { origin: 'https://evil.example' }, payload: { name: 'X', slug: 'evil-x', matchDurationSeconds: 60 }
  });
  assert.equal(crossSite.statusCode, 403);
  const refererOnly = await h.request({
    method: 'POST', url: '/api/admin/competitions', as: boss,
    headers: { referer: 'https://evil.example/page' }, payload: { name: 'X', slug: 'evil-y', matchDurationSeconds: 60 }
  });
  assert.equal(refererOnly.statusCode, 403);
  const sameSite = await h.request({
    method: 'POST', url: '/api/admin/competitions', as: boss,
    headers: { origin: 'http://localhost:80', host: 'localhost:80' }, payload: { name: 'X', slug: `same-${Date.now()}`, matchDurationSeconds: 60 }
  });
  assert.equal(sameSite.statusCode, 201);
  const logout = await h.request({ method: 'POST', url: '/auth/logout', as: null, headers: { origin: 'https://evil.example' } });
  assert.equal(logout.statusCode, 403, 'logout CSRF is also blocked');
});

test('admin pages cannot be framed; displays can', { skip }, async () => {
  const page = await h.request({ method: 'GET', url: '/', as: null });
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  const api = await h.request({ method: 'GET', url: '/api/admin/me', as: null });
  assert.equal(api.headers['x-frame-options'], 'DENY');
  const display = await h.request({ method: 'GET', url: '/display/does-not-exist', as: null });
  assert.equal(display.headers['x-frame-options'], undefined);
});

test('logout works without a session and clears the cookie', { skip }, async () => {
  const response = await h.request({ method: 'POST', url: '/auth/logout', as: null });
  assert.equal(response.statusCode, 204);
  const boss = await h.createAdmin('boss@test.local');
  const out = await h.request({ method: 'POST', url: '/auth/logout', as: boss });
  assert.equal(out.statusCode, 204);
  assert.match(String(out.headers['set-cookie']), /competition_session=;/);
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/me', as: boss })).statusCode, 401);
});

test('OIDC sign-in degrades gracefully when the provider is not available', { skip }, async () => {
  const status = JSON.parse((await h.request({ method: 'GET', url: '/auth/status', as: null })).body);
  assert.equal(status.oidcAvailable, false);
  const login = await h.request({ method: 'GET', url: '/auth/login', as: null });
  assert.equal(login.statusCode, 302);
  assert.match(String(login.headers.location), /auth_error=idp_unavailable/);
  const callback = await h.request({ method: 'GET', url: '/auth/callback?state=x&code=y', as: null });
  assert.equal(callback.statusCode, 302);
});

test('passkey endpoints reject forged or replayed input without errors', { skip }, async () => {
  // Without HTTPS (PUBLIC_BASE_URL) passkeys only work on localhost.
  const remote = await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: { host: 'example.com' }, payload: {} });
  assert.equal(remote.statusCode, 400);
  const options = await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: { host: 'localhost:8080' }, payload: {} });
  assert.equal(options.statusCode, 200);
  const { challengeId, options: publicKey } = JSON.parse(options.body);
  assert.equal(publicKey.rpId, 'localhost');
  assert.equal(publicKey.userVerification, 'required');
  const forged = { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' } };
  const verify = await h.request({ method: 'POST', url: '/auth/passkey/verify', as: null, headers: { host: 'localhost:8080' }, payload: { challengeId, response: forged } });
  assert.equal(verify.statusCode, 401);
  const replay = await h.request({ method: 'POST', url: '/auth/passkey/verify', as: null, headers: { host: 'localhost:8080' }, payload: { challengeId, response: forged } });
  assert.equal(replay.statusCode, 400, 'a challenge can only be used once');
  const enroll = await h.request({ method: 'POST', url: '/auth/passkey/enroll/options', as: null, headers: { host: 'localhost:8080' }, payload: { token: 'x'.repeat(43) } });
  assert.equal(enroll.statusCode, 400);

  const boss = await h.createAdmin('boss@test.local');
  const register = await h.request({ method: 'POST', url: '/api/admin/passkeys/register/options', as: boss, headers: { host: 'localhost:8080' }, payload: {} });
  assert.equal(register.statusCode, 200);
  const registration = JSON.parse(register.body);
  assert.equal(registration.options.authenticatorSelection.residentKey, 'required');
  const bad = await h.request({
    method: 'POST', url: '/api/admin/passkeys/register/verify', as: boss, headers: { host: 'localhost:8080' },
    payload: { challengeId: registration.challengeId, response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }
  });
  assert.equal(bad.statusCode, 400);
  // Another user's challenge cannot be used.
  const second = await h.createAdmin('second@test.local');
  const otherOptions = JSON.parse((await h.request({ method: 'POST', url: '/api/admin/passkeys/register/options', as: second, headers: { host: 'localhost:8080' }, payload: {} })).body);
  const stolen = await h.request({
    method: 'POST', url: '/api/admin/passkeys/register/verify', as: boss, headers: { host: 'localhost:8080' },
    payload: { challengeId: otherOptions.challengeId, response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }
  });
  assert.equal(stolen.statusCode, 400);
});

test('enrollment links work once and only before they expire', { skip }, async () => {
  const { createEnrollmentInvite } = await import('../src/routes/passkeys.js');
  const token = await createEnrollmentInvite('boss@test.local', 30, 'test');
  const first = await h.request({ method: 'POST', url: '/auth/passkey/enroll/options', as: null, headers: { host: 'localhost:8080' }, payload: { token } });
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).email, 'boss@test.local');
  await h.pool.query(`UPDATE passkey_enrollments SET expires_at = now() - interval '1 second'`);
  const expired = await h.request({ method: 'POST', url: '/auth/passkey/enroll/options', as: null, headers: { host: 'localhost:8080' }, payload: { token } });
  assert.equal(expired.statusCode, 400);
});

test('sign-in endpoints are rate limited per client', { skip }, async () => {
  let limited = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: { host: 'localhost:8080' }, payload: {}, remoteAddress: '203.0.113.9' });
    if (response.statusCode === 429) limited += 1;
  }
  assert.ok(limited >= 10, `expected rate limiting, got ${limited} limited responses`);
  const other = await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: { host: 'localhost:8080' }, payload: {}, remoteAddress: '203.0.113.10' });
  assert.equal(other.statusCode, 200, 'other clients are unaffected');
});
