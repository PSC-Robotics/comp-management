import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';
import { VirtualAuthenticator } from './virtual-authenticator.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

const host = { host: 'localhost:8080' };
const run = Date.now().toString(36);
const cookieFrom = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0]!;

test('register a passkey while signed in, then sign in with it alone', { skip }, async () => {
  const admin = await h.createAdmin(`passkey-user-${run}@test.local`);
  const device = new VirtualAuthenticator('http://localhost:8080', 'localhost');

  const begin = JSON.parse((await h.request({ method: 'POST', url: '/api/admin/passkeys/register/options', as: admin, headers: host, payload: {} })).body);
  const finish = await h.request({
    method: 'POST', url: '/api/admin/passkeys/register/verify', as: admin, headers: host,
    payload: { challengeId: begin.challengeId, name: 'Test laptop', response: device.create(begin.options) }
  });
  assert.equal(finish.statusCode, 201, finish.body);
  const list = JSON.parse((await h.request({ method: 'GET', url: '/api/admin/passkeys', as: admin })).body);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Test laptop');

  // Registering the same authenticator twice is prevented by excludeCredentials.
  const again = JSON.parse((await h.request({ method: 'POST', url: '/api/admin/passkeys/register/options', as: admin, headers: host, payload: {} })).body);
  assert.equal(again.options.excludeCredentials.length, 1);

  // Sign in with no cookie at all — as if the identity provider were down.
  const options = JSON.parse((await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: host, payload: {} })).body);
  const signIn = await h.request({
    method: 'POST', url: '/auth/passkey/verify', as: null, headers: host,
    payload: { challengeId: options.challengeId, response: device.get(options.options) }
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const session = { cookie: cookieFrom(signIn) };
  const me = JSON.parse((await h.request({ method: 'GET', url: '/api/admin/me', as: session })).body);
  assert.equal(me.email, `passkey-user-${run}@test.local`);
  assert.equal(me.signedInWith, 'passkey');

  // A tampered signature is rejected.
  const second = JSON.parse((await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: host, payload: {} })).body);
  const tampered = await h.request({
    method: 'POST', url: '/auth/passkey/verify', as: null, headers: host,
    payload: { challengeId: second.challengeId, response: device.get(second.options, { tamper: true }) }
  });
  assert.equal(tampered.statusCode, 401);

  // A response signed for one challenge cannot be replayed against another.
  const third = JSON.parse((await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: host, payload: {} })).body);
  const replay = await h.request({
    method: 'POST', url: '/auth/passkey/verify', as: null, headers: host,
    payload: { challengeId: third.challengeId, response: device.get(options.options) }
  });
  assert.equal(replay.statusCode, 401);

  // Disabled accounts cannot sign in with their passkeys either.
  await h.pool.query('UPDATE admin_users SET disabled = true WHERE email = $1', [`passkey-user-${run}@test.local`]);
  const fourth = JSON.parse((await h.request({ method: 'POST', url: '/auth/passkey/options', as: null, headers: host, payload: {} })).body);
  const blocked = await h.request({
    method: 'POST', url: '/auth/passkey/verify', as: null, headers: host,
    payload: { challengeId: fourth.challengeId, response: device.get(fourth.options) }
  });
  assert.equal(blocked.statusCode, 401);
  assert.equal((await h.request({ method: 'GET', url: '/api/admin/me', as: session })).statusCode, 401);
  await h.pool.query('UPDATE admin_users SET disabled = false WHERE email = $1', [`passkey-user-${run}@test.local`]);
});

test('a passkey from the wrong site is rejected', { skip }, async () => {
  const admin = await h.createAdmin(`phish-${run}@test.local`);
  const phishing = new VirtualAuthenticator('https://evil.example', 'evil.example');
  const begin = JSON.parse((await h.request({ method: 'POST', url: '/api/admin/passkeys/register/options', as: admin, headers: host, payload: {} })).body);
  const finish = await h.request({
    method: 'POST', url: '/api/admin/passkeys/register/verify', as: admin, headers: host,
    payload: { challengeId: begin.challengeId, response: phishing.create(begin.options) }
  });
  assert.equal(finish.statusCode, 400);
});

test('a one-time enrollment link adds a passkey and signs in without OIDC', { skip }, async () => {
  const { createEnrollmentInvite } = await import('../src/routes/passkeys.js');
  const token = await createEnrollmentInvite(`new-admin-${run}@test.local`, 30, 'test');
  const device = new VirtualAuthenticator('http://localhost:8080', 'localhost');
  const begin = JSON.parse((await h.request({ method: 'POST', url: '/auth/passkey/enroll/options', as: null, headers: host, payload: { token } })).body);
  const finish = await h.request({
    method: 'POST', url: '/auth/passkey/enroll/verify', as: null, headers: host,
    payload: { token, challengeId: begin.challengeId, name: 'Phone', response: device.create(begin.options) }
  });
  assert.equal(finish.statusCode, 201, finish.body);
  const me = JSON.parse((await h.request({ method: 'GET', url: '/api/admin/me', as: { cookie: cookieFrom(finish) } })).body);
  assert.equal(me.email, `new-admin-${run}@test.local`);
  assert.equal(me.passkeyCount, 1);
  const reuse = await h.request({ method: 'POST', url: '/auth/passkey/enroll/options', as: null, headers: host, payload: { token } });
  assert.equal(reuse.statusCode, 400, 'the link works only once');
});
