import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

const tone = Buffer.alloc(4000, 1);

async function upload(slug: string, query: string, type: string, body: Buffer) {
  return h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/media?${query}`, headers: { 'content-type': type }, payload: body });
}

test('every display type can be stored and schema setup still runs afterwards', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const { displayTypeSchema } = await import('../src/domain/display.js');
  for (const type of displayTypeSchema.options) {
    await h.api('POST', `/api/admin/competitions/${slug}/displays`, { slug: `${slug}-${type}`, title: type, type }, 201);
  }
  const { migrate } = await import('../src/db/schema.js');
  await migrate(h.pool);
});

test('audio and images upload, are served with byte ranges, and stay private until published', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  assert.equal((await upload(slug, 'name=Track', 'audio/wav', tone)).statusCode, 400, 'length is required');
  assert.equal((await upload(slug, 'name=Page', 'text/html', tone)).statusCode, 415);
  const created = await upload(slug, 'name=Track&durationMs=30000', 'audio/wav', tone);
  assert.equal(created.statusCode, 201);
  const { id } = created.json();
  const ranged = await h.request({ method: 'GET', url: `/media/${id}`, headers: { range: 'bytes=10-19' }, as: null });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.headers['content-range'], `bytes 10-19/${tone.length}`);
  assert.equal(ranged.rawPayload.length, 10);
  assert.equal((await h.request({ method: 'GET', url: `/media/${id}`, headers: { range: 'bytes=9999-' }, as: null })).statusCode, 416);
  await h.api('POST', `/api/admin/competitions/${slug}/unpublish`, {}).catch(() => undefined);
  await h.pool.query(`UPDATE competitions SET status = 'draft' WHERE slug = $1`, [slug]);
  assert.equal((await h.request({ method: 'GET', url: `/media/${id}`, as: null })).statusCode, 404, 'drafts stay private');
  assert.equal((await h.request({ method: 'GET', url: `/api/admin/media/${id}` })).statusCode, 200, 'admins can still preview');
});

test('the shared playlist plays, pauses, resumes and skips from server time', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const first = (await upload(slug, 'name=One&durationMs=60000', 'audio/mpeg', tone)).json();
  const second = (await upload(slug, 'name=Two&durationMs=30000', 'audio/mpeg', tone)).json();
  const before = Date.now();
  let state = await h.api('POST', `/api/admin/competitions/${slug}/audio`, { action: 'play' }, 200);
  assert.equal(state.mode, 'playing');
  assert.deepEqual(state.tracks.map((track: { id: string }) => track.id), [first.id, second.id], 'uploads join the playlist');
  assert.ok(state.startedAt >= before + 1000 && state.startedAt <= Date.now() + 1600, 'starts shortly ahead so every screen is ready');

  await h.pool.query(`UPDATE audio_playback SET started_at = now() - interval '10 seconds' WHERE competition_id = (SELECT id FROM competitions WHERE slug = $1)`, [slug]);
  state = await h.api('POST', `/api/admin/competitions/${slug}/audio`, { action: 'pause' }, 200);
  assert.equal(state.mode, 'paused');
  assert.ok(state.pausedPositionMs >= 10_000 && state.pausedPositionMs < 12_000);
  state = await h.api('POST', `/api/admin/competitions/${slug}/audio`, { action: 'next' }, 200);
  assert.equal(state.pausedPositionMs, 60_000, 'skipping while paused moves to the next track');
  state = await h.api('POST', `/api/admin/competitions/${slug}/audio`, { action: 'play' }, 200);
  assert.equal(state.mode, 'playing');
  assert.ok(Math.abs(state.startedAt - (Date.now() + 1500 - 60_000)) < 1000, 'resumes from the paused position');

  const publicState = await h.request({ method: 'GET', url: `/api/public/audio/${slug}`, as: null });
  assert.equal(publicState.statusCode, 200);
  assert.equal(publicState.json().tracks[0].url, `/media/${first.id}`);

  await h.api('DELETE', `/api/admin/media/${second.id}`, undefined, 204);
  state = await h.api('GET', `/api/admin/competitions/${slug}/audio`);
  assert.equal(state.mode, 'stopped', 'deleting a playing track stops the playlist');
  assert.equal(state.tracks.length, 1);
});

test('live audio is relayed through the server and stopping it returns to silence', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const state = await h.api('POST', `/api/admin/competitions/${slug}/audio`, { action: 'live-start' }, 200);
  assert.equal(state.mode, 'live');
  assert.ok(state.live.session.length >= 16);
  const audioUrl = `/api/admin/audio-live/${state.live.session}/audio`;
  assert.equal((await h.request({ method: 'POST', url: audioUrl, payload: { chunks: [{ t: Date.now() * 1000, d: 'AAEC' }] } })).statusCode, 204);
  assert.equal((await h.request({ method: 'POST', url: audioUrl, payload: { chunks: [{ t: 1, d: '<script>' }] } })).statusCode, 400, 'chunks must be base64');
  assert.equal((await h.request({ method: 'POST', url: audioUrl, payload: { chunks: [{ t: 1, d: 'AAEC' }] }, as: null })).statusCode, 401, 'only admins broadcast');
  const stopped = await h.api('POST', `/api/admin/competitions/${slug}/audio`, { action: 'live-stop' }, 200);
  assert.equal(stopped.mode, 'stopped');
  assert.equal(stopped.live, null);
  const ended = await h.request({ method: 'GET', url: `/api/public/audio-live/${state.live.session}/listen?listener=listener-0001`, as: null });
  assert.equal(ended.statusCode, 404);
  assert.equal((await h.request({ method: 'POST', url: audioUrl, payload: { chunks: [{ t: 1, d: 'AAEC' }] } })).statusCode, 404, 'the session has ended');
});

test('custom screens serve their panels and change fingerprint when edited', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const display = await h.api('POST', `/api/admin/competitions/${slug}/displays`, {
    slug: `${slug}-custom`, title: 'Hall', type: 'custom',
    options: { customLayout: 'split', customAreas: [['schedule'], ['timer', 'message']] }
  }, 201);
  const page = await h.request({ method: 'GET', url: `/display/${slug}-custom`, as: null });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /layout-split/);
  assert.match(page.body, new RegExp(`/display/${slug}-custom/panel/timer`));
  assert.equal((await h.request({ method: 'GET', url: `/display/${slug}-custom/panel/timer`, as: null })).statusCode, 200);
  assert.equal((await h.request({ method: 'GET', url: `/api/public/display/${slug}-custom/panel/schedule`, as: null })).json().type, 'schedule');
  assert.equal((await h.request({ method: 'GET', url: `/display/${slug}-custom/panel/nope`, as: null })).statusCode, 404);
  const before = (await h.request({ method: 'GET', url: `/api/public/display/${slug}-custom/config`, as: null })).json().hash;
  await h.api('PATCH', `/api/admin/displays/${display.id}`, { options: { customLayout: 'grid', customAreas: [['league']] } }, 200);
  const afterEdit = (await h.request({ method: 'GET', url: `/api/public/display/${slug}-custom/config`, as: null })).json().hash;
  assert.notEqual(before, afterEdit, 'open screens notice the edit and reload');
});
