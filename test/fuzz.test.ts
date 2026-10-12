import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

// Streams never finish, so inject() would hang on them.
const STREAMING = [/\/changes$/, /^\/srcomp-stream\//];

const hostileStrings = [
  '', ' ', 'x', '0', '-1', '1e309', 'null', 'undefined', '00000000-0000-0000-0000-000000000000',
  "'; DROP TABLE matches; --", '../../../etc/passwd', '%00', '<script>alert(1)</script>',
  'ÄÖÜ💥', 'a'.repeat(5000), '{"a":1}', 'NaN', '9'.repeat(40)
];
const hostileValues: unknown[] = [
  null, true, false, 0, -1, 1.5, -1e308, 1e308, Number.MAX_SAFE_INTEGER, '', 'x'.repeat(10_000),
  [], [null], {}, { a: { b: { c: { d: [1, { e: 'f' }] } } } }, '2026-13-45T99:99:99Z', 'not-a-date'
];
const keys = [
  'name', 'slug', 'code', 'title', 'type', 'options', 'enabled', 'points', 'scores', 'teamCode', 'reason',
  'delaySeconds', 'restoreScheduled', 'matchCount', 'firstStart', 'intervalSeconds', 'arenas', 'positions',
  'scheduledStart', 'arenaName', 'fieldSize', 'format', 'finalSize', 'finalByes', 'startsAt', 'durationMinutes',
  'confirmation', 'theme', 'timezone', 'logoDataUrl', 'cornerColours', 'active', 'matchDurationSeconds',
  'challengeId', 'response', 'token', 'tieBreak', 'disabled', 'matchNumber', 'plannedGapMinutes'
];

function* bodies(seed: number) {
  yield undefined;
  yield {};
  yield [];
  yield 'plain string';
  for (let index = 0; index < 14; index += 1) {
    const body: Record<string, unknown> = {};
    for (let field = 0; field < 4; field += 1) {
      const key = keys[(seed * 31 + index * 7 + field * 13) % keys.length]!;
      body[key] = hostileValues[(seed + index * 3 + field * 5) % hostileValues.length];
    }
    yield body;
  }
}

function fill(url: string, values: Record<string, string>, fallback: string): string {
  return url.replace(/:([A-Za-z]+)/g, (_whole, name: string) => encodeURIComponent(values[name] ?? fallback))
    .replace('*', encodeURIComponent(fallback));
}

test('no route returns a server error for hostile input', { skip, timeout: 300_000 }, async () => {
  // Real ids so requests get past "not found" and into validation and business rules.
  const { slug, codes } = await h.createCompetition(8);
  const first = new Date(Date.now() + 3_600_000).toISOString();
  await h.api('POST', `/api/admin/competitions/${slug}/generate-schedule`, {
    matchCount: 4, firstStart: first, intervalSeconds: 180, arenas: ['A', 'B'],
    positions: [1, 2, 3, 4].map((n) => ({ label: `Position ${n - 1}` }))
  });
  await h.api('POST', `/api/admin/competitions/${slug}/playoffs`, { fieldSize: 8, intervalMinutes: 3, arenaNames: ['A'] });
  const matches = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`);
  const league = matches.find((match) => !match.isPlayoff);
  const heat = matches.find((match) => match.isPlayoff);
  const display = await h.api('POST', `/api/admin/competitions/${slug}/displays`, { slug: `${slug}-d`, title: 'D', type: 'schedule', options: {} });
  const challenge = await h.api('POST', `/api/admin/competitions/${slug}/challenges`, { name: 'C', points: 5, description: '' });
  const event = await h.api('POST', `/api/admin/competitions/${slug}/events`, { title: 'Lunch', startsAt: first, durationMinutes: 30, description: '', location: '' });
  const teams = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/teams`);
  const real: Record<string, string> = {
    slug, competitionSlug: slug, displaySlug: `${slug}-d`, matchId: league.id, teamId: teams[0].id,
    challengeId: challenge.id ?? challenge.challenge?.id ?? 'x', teamCode: codes[0]!, eventId: event.event?.id ?? event.id ?? 'x',
    displayId: display.id ?? display.display?.id ?? 'x', userId: h.admin.userId, id: 'x', arena: 'A', corner: '0',
    resource: 'matches', action: 'pause'
  };
  const heatParams = { ...real, matchId: heat.id };

  const failures: string[] = [];
  let requests = 0;
  const routes = h.routes.filter((route) => !['HEAD', 'OPTIONS'].includes(route.method) &&
    !STREAMING.some((pattern) => pattern.test(route.url)));
  assert.ok(routes.length > 60, `expected many routes, found ${routes.length}`);
  for (const [routeIndex, route] of routes.entries()) {
    const variants = [
      fill(route.url, route.url.includes('playoff-matches') ? heatParams : real, 'x'),
      ...hostileStrings.slice(0, 8).map((value) => fill(route.url, {}, value))
    ];
    for (const [variantIndex, url] of variants.entries()) {
      const payloads = route.method === 'GET' || route.method === 'DELETE' && variantIndex > 0
        ? [undefined] : [...bodies(routeIndex + variantIndex)];
      for (const payload of payloads) {
        // Destructive routes only receive hostile bodies against real ids, never valid ones.
        const response = await h.request({
          method: route.method as any, url: url + (variantIndex === 2 ? '?type=all&x=%ff' : ''),
          ...(payload === undefined ? {} : typeof payload === 'string'
            ? { payload, headers: { 'content-type': 'application/json' } } : { payload: payload as object })
        });
        requests += 1;
        if (response.statusCode >= 500) {
          failures.push(`${route.method} ${url.slice(0, 120)} ${JSON.stringify(payload)?.slice(0, 120)} -> ${response.statusCode} ${response.body.slice(0, 160)}`);
        }
      }
    }
  }
  // Also unauthenticated and with a forged cookie.
  for (const route of routes) {
    for (const as of [null, { cookie: 'competition_session=forged' }, { cookie: `competition_session=${'z'.repeat(5000)}` }]) {
      const response = await h.request({ method: route.method as any, url: fill(route.url, real, 'x'), as, payload: {} });
      requests += 1;
      if (response.statusCode >= 500) failures.push(`${route.method} ${route.url} as ${JSON.stringify(as)?.slice(0, 40)} -> ${response.statusCode}`);
      if (route.url.startsWith('/api/admin/') && ![401, 403, 404].includes(response.statusCode)) {
        failures.push(`${route.method} ${route.url} without a valid session -> ${response.statusCode}`);
      }
    }
  }
  console.log(`fuzzed ${routes.length} routes with ${requests} requests`);
  assert.deepEqual(failures, [], `${failures.length} failing requests:\n${failures.slice(0, 40).join('\n')}`);
});
