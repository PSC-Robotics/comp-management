import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

async function scheduleTwo(slug: string, minutesFromNow = 30) {
  const first = new Date(Date.now() + minutesFromNow * 60_000);
  first.setSeconds(0, 0);
  await h.api('POST', `/api/admin/competitions/${slug}/generate-schedule`, {
    matchCount: 2, firstStart: first.toISOString(), intervalSeconds: 180, arenas: ['A'],
    positions: [1, 2, 3, 4].map((n) => ({ label: `Position ${n - 1}` }))
  }, 201);
  return (await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`)).sort((a, b) => a.match_number - b.match_number);
}

async function display(slug: string, type: string) {
  const displaySlug = `${slug}-${type}`;
  await h.api('POST', `/api/admin/competitions/${slug}/displays`, { slug: displaySlug, title: type, type, options: { showEndCue: true } });
  return displaySlug;
}

test('a match run without scores shows END, then the next match, and can be closed', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const [first, second] = await scheduleTwo(slug);
  const timerSlug = await display(slug, 'timer');
  const current = async () => (await h.api<any>('GET', `/api/public/display/${timerSlug}`)).data?.match_number;
  const timerFeed = async () => (await h.api<any>('GET', `/public/v1/${slug}/timer`)).timer?.match_number;

  assert.equal(await current(), first.match_number);
  await h.api('POST', `/api/admin/matches/${first.id}/start`, {}, 200);
  await h.fastForwardCountdowns();
  let state = (await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`)).find((m) => m.id === first.id).state;
  assert.equal(state, 'running');
  // The timer runs out without anyone entering scores.
  await h.pool.query(`UPDATE matches SET actual_start = now() - interval '61 seconds' WHERE id = $1`, [first.id]);
  await h.processMatchClocks();
  state = (await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`)).find((m) => m.id === first.id).state;
  assert.equal(state, 'awaiting_score');
  assert.equal(await current(), first.match_number, 'the finished match stays for its END cue');
  assert.equal(await timerFeed(), first.match_number);
  await h.pool.query(`UPDATE matches SET actual_end = now() - interval '30 seconds' WHERE id = $1`, [first.id]);
  assert.equal(await current(), second.match_number, 'then the next match takes over, unscored or not');
  assert.equal(await timerFeed(), second.match_number);

  // Clearing is no longer blocked by matches that only lack scores.
  const closed = await h.request({ method: 'POST', url: `/api/admin/matches/${first.id}/close-without-score`, payload: { reason: 'Practice run' } });
  assert.equal(closed.statusCode, 200, closed.body);
  state = (await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`)).find((m) => m.id === first.id).state;
  assert.equal(state, 'complete');
  // Scores can still be added afterwards.
  const codes = first.positions.filter((p: any) => p.teamCode).map((p: any) => p.teamCode);
  const scored = await h.request({ method: 'POST', url: `/api/admin/matches/${first.id}/scores`, payload: { scores: codes.map((teamCode: string) => ({ teamCode, leaguePoints: 3 })) } });
  assert.equal(scored.statusCode, 200, scored.body);
});

test('clearing matches works while some only await scores, but not while one is running', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const [first, second] = await scheduleTwo(slug);
  await h.api('POST', `/api/admin/matches/${first.id}/start`, {}, 200);
  await h.fastForwardCountdowns();
  await h.api('POST', `/api/admin/matches/${first.id}/finish`, {}, 200);
  await h.api('POST', `/api/admin/matches/${second.id}/start`, {}, 200);
  await h.fastForwardCountdowns();
  const blocked = await h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/clear-matches`, payload: { confirmation: 'CLEAR MATCHES' } });
  assert.equal(blocked.statusCode, 409);
  await h.api('POST', `/api/admin/matches/${second.id}/finish`, {}, 200);
  const cleared = await h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/clear-matches`, payload: { confirmation: 'CLEAR MATCHES' } });
  assert.equal(cleared.statusCode, 200, cleared.body);
});

test('only one of many simultaneous starts wins; the rest are refused cleanly', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const [first] = await scheduleTwo(slug);
  const responses = await Promise.all(Array.from({ length: 15 }, () =>
    h.request({ method: 'POST', url: `/api/admin/matches/${first.id}/start`, payload: {} })));
  const codes = responses.map((response) => response.statusCode).sort();
  assert.equal(codes.filter((code) => code === 200).length, 1, codes.join(','));
  assert.ok(codes.every((code) => code === 200 || code === 409), codes.join(','));
});

test('simultaneous delays, pauses and score entries never corrupt a match', { skip }, async () => {
  const { slug } = await h.createCompetition(4);
  const [first, second] = await scheduleTwo(slug);
  const before = new Date((await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`)).find((m) => m.id === second.id).effective_start).getTime();
  const delays = await Promise.all(Array.from({ length: 8 }, () =>
    h.request({ method: 'POST', url: `/api/admin/matches/${second.id}/delay`, payload: { delaySeconds: 60, reason: 'parallel' } })));
  assert.ok(delays.every((response) => response.statusCode === 200));
  const after = new Date((await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`)).find((m) => m.id === second.id).effective_start).getTime();
  assert.equal(after - before, 8 * 60_000, 'every delay applied exactly once');

  await h.api('POST', `/api/admin/matches/${first.id}/start`, {}, 200);
  await h.fastForwardCountdowns();
  const pauses = await Promise.all(Array.from({ length: 6 }, () =>
    h.request({ method: 'POST', url: `/api/admin/matches/${first.id}/pause`, payload: {} })));
  assert.equal(pauses.filter((response) => response.statusCode === 200).length, 1);
  await h.api('POST', `/api/admin/matches/${first.id}/finish`, {}, 200);
  const codes = first.positions.filter((p: any) => p.teamCode).map((p: any) => p.teamCode);
  const scores = await Promise.all([1, 2, 3, 4].map((points) => h.request({
    method: 'POST', url: `/api/admin/matches/${first.id}/scores`,
    payload: { scores: codes.map((teamCode: string) => ({ teamCode, leaguePoints: points })), reason: 'parallel correction' }
  })));
  assert.ok(scores.every((response) => response.statusCode === 200 || response.statusCode === 400), scores.map((r) => r.statusCode).join(','));
  const stored = await h.pool.query('SELECT count(*)::int AS count, count(DISTINCT league_points)::int AS distinct FROM match_scores WHERE match_id = $1', [first.id]);
  assert.equal(stored.rows[0].count, codes.length);
  assert.equal(stored.rows[0].distinct, 1, 'one submission wins completely; no mixed rows');
});

test('the change feed announces updates to dashboards and displays', { skip }, async () => {
  const { currentRevision } = await import('../src/services/changes.js');
  const { slug } = await h.createCompetition(4);
  const before = currentRevision();
  await h.api('POST', `/api/admin/competitions/${slug}/events`, { title: 'Talk', startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 10, description: '', location: '' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(currentRevision() > before);
});

test('playoff heats run in order: a later heat cannot jump ahead of an earlier one', { skip }, async () => {
  const { slug } = await h.createCompetition(8);
  await h.api('POST', `/api/admin/competitions/${slug}/playoffs`, {
    fieldSize: 8, format: 'single-elimination', intervalMinutes: 3, arenaNames: ['A']
  });
  const playoffs = await h.api<any>('GET', `/api/admin/competitions/${slug}/playoffs`);
  const heats = (playoffs.matches as any[]).sort((a, b) => a.match_number - b.match_number);
  const [first, second] = heats;
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');

  const blocked = await h.request({ method: 'POST', url: `/api/admin/playoff-matches/${second.id}/control/start`, payload: {} });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.body, new RegExp(`Heat #${first.match_number} in A comes first`));

  // The timer screen shows the earlier heat next, not the later one.
  const timer = `${slug}-timer`;
  await h.api('POST', `/api/admin/competitions/${slug}/displays`, { slug: timer, title: 'timer', type: 'timer', options: {} });
  const shown = await h.api<any>('GET', `/api/public/display/${timer}`);
  assert.equal(shown.data.match_number, first.match_number);

  await h.api('POST', `/api/admin/playoff-matches/${first.id}/control/start`, {}, 200);
});
