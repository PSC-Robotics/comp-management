import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

/** A published competition with `matchSize` teams per match. */
async function competition(matchSize: number, teamCount = 6) {
  const slug = `f-${randomBytes(5).toString('hex')}`;
  await h.api('POST', '/api/admin/competitions', { name: `Test ${slug}`, slug, matchDurationSeconds: 60, matchSize }, 201);
  const codes = Array.from({ length: teamCount }, (_, index) => `T${String.fromCharCode(65 + index)}${String.fromCharCode(65 + index)}`);
  for (const code of codes) await h.api('POST', `/api/admin/competitions/${slug}/teams`, { code, name: `Team ${code}` });
  await h.api('POST', `/api/admin/competitions/${slug}/publish`, {});
  return { slug, codes };
}

test('two-team competitions schedule head-to-head matches and brackets', { skip }, async () => {
  const { slug } = await competition(2);
  const first = new Date(Date.now() + 3_600_000); first.setSeconds(0, 0);
  const wrongLabels = await h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/generate-schedule`, payload: {
    matchCount: 6, firstStart: first.toISOString(), intervalSeconds: 120, arenas: ['A'], positions: [{ label: 'L' }, { label: 'R' }, { label: 'X' }]
  } });
  assert.equal(wrongLabels.statusCode, 400, 'labels must match the teams per match');
  await h.api('POST', `/api/admin/competitions/${slug}/generate-schedule`, {
    matchCount: 6, firstStart: first.toISOString(), intervalSeconds: 120, arenas: ['A'], positions: [{ label: 'Left' }, { label: 'Right' }]
  }, 201);
  const matches = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`);
  assert.equal(matches.length, 6);
  for (const match of matches) assert.equal(match.positions.filter((position: any) => position.teamCode).length, 2);
  assert.equal((await h.request({ method: 'PUT', url: `/api/admin/competitions/${slug}/match-size`, payload: { matchSize: 4 } })).statusCode, 409,
    'teams per match cannot change once matches exist');
  await h.api('POST', `/api/admin/competitions/${slug}/playoffs`, { fieldSize: 4, format: 'single-elimination', intervalMinutes: 2, arenaNames: ['A'] }, 201);
  const playoffs = await h.api<any>('GET', `/api/admin/competitions/${slug}/playoffs`);
  for (const heat of playoffs.matches) {
    assert.ok(heat.sources.filter((source: string) => source !== 'bye').length <= 2, 'heats have at most two teams');
  }
  const timer = `${slug}-timer`;
  await h.api('POST', `/api/admin/competitions/${slug}/displays`, { slug: timer, title: 'timer', type: 'timer', options: {} });
  const shown = await h.api<any>('GET', `/api/public/display/${timer}`);
  assert.equal(shown.matchSize, 2);
  assert.equal(shown.data.positions.length, 2, 'screens show two positions');
});

test('custom brackets are built from drawn connections and can be timed by hand', { skip }, async () => {
  const { slug } = await competition(2, 4);
  const heats = [
    { key: 'semi-1', side: 'upper', sources: ['seed:1', 'seed:4'] },
    { key: 'semi-2', side: 'upper', sources: ['seed:2', 'seed:3'] },
    { key: 'bronze', side: 'lower', sources: ['place:2:semi-1', 'place:2:semi-2'] },
    { key: 'final', side: 'final', sources: ['place:1:semi-1', 'place:1:semi-2'] }
  ];
  const preview = await h.api<any>('POST', `/api/admin/competitions/${slug}/playoffs/custom-preview`, { heats });
  assert.equal(preview.valid, true);
  assert.equal(preview.numbers.final, 4, 'the final is the last heat');
  const broken = await h.api<any>('POST', `/api/admin/competitions/${slug}/playoffs/custom-preview`, { heats: heats.slice(0, 3) });
  assert.equal(broken.valid, false);
  const base = Date.now() + 2 * 3_600_000;
  const at = (minutes: number) => new Date(Math.ceil((base + minutes * 60_000) / 60_000) * 60_000).toISOString();
  const missingTime = await h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/playoffs`, payload: { format: 'custom', heats, scheduleMode: 'manual' } });
  assert.equal(missingTime.statusCode, 400);
  await h.api('POST', `/api/admin/competitions/${slug}/playoffs`, {
    format: 'custom', scheduleMode: 'manual',
    heats: heats.map((heat, index) => ({ ...heat, start: at(index * 10), arenaName: index % 2 ? 'B' : 'A' }))
  }, 201);
  const playoffs = await h.api<any>('GET', `/api/admin/competitions/${slug}/playoffs`);
  assert.equal(playoffs.bracket.format, 'custom');
  assert.equal(playoffs.matches.length, 4);
  const final = playoffs.matches.find((heat: any) => heat.bracket_side === 'final');
  assert.equal(new Date(final.effective_start).toISOString(), at(30), 'manual times are kept');
  assert.equal(final.arena_name, 'B');
});

test('kit is checked out to a team, checked back in with its condition, and keeps its history', { skip }, async () => {
  const { slug, codes } = await competition(4, 4);
  const { ids } = await h.api<any>('POST', `/api/admin/competitions/${slug}/kit`, { name: 'Brain board', category: 'Electronics', assetTag: 'BB', quantity: 2 }, 201);
  assert.equal(ids.length, 2);
  let kit = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/kit`);
  assert.deepEqual(kit.map((item) => item.asset_tag).sort(), ['BB-1', 'BB-2']);
  const [item] = ids;
  await h.api('POST', `/api/admin/kit/${item}/checkout`, { teamCode: codes[0], dueBackAt: new Date(Date.now() - 60_000).toISOString() }, 200);
  assert.equal((await h.request({ method: 'POST', url: `/api/admin/kit/${item}/checkout`, payload: { teamCode: codes[1] } })).statusCode, 409,
    'an item can only be with one team');
  assert.equal((await h.request({ method: 'DELETE', url: `/api/admin/kit/${item}` })).statusCode, 409, 'cannot delete kit that is out');
  kit = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/kit`);
  const out = kit.find((entry) => entry.id === item);
  assert.equal(out.status, 'checked_out');
  assert.equal(out.team_code, codes[0]);
  assert.equal(out.overdue, true);
  await h.api('POST', `/api/admin/kit/${item}/checkin`, { condition: 'damaged', notes: 'bent pin' }, 200);
  kit = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/kit`);
  assert.equal(kit.find((entry) => entry.id === item).status, 'needs_repair');
  const history = await h.api<any[]>('GET', `/api/admin/kit/${item}/history`);
  assert.equal(history.length, 1);
  assert.equal(history[0].return_condition, 'damaged');
  await h.api('PATCH', `/api/admin/kit/${item}`, { condition: 'lost' }, 200);
  assert.equal((await h.request({ method: 'POST', url: `/api/admin/kit/${item}/checkout`, payload: { teamCode: codes[1] } })).statusCode, 409,
    'lost kit cannot be lent');
  assert.equal((await h.request({ method: 'DELETE', url: `/api/admin/kit/${item}` })).statusCode, 204);
});

test('the kiosk picker lists enabled displays of published competitions only', { skip }, async () => {
  const { slug } = await competition(2, 2);
  const shown = await h.api<any>('POST', `/api/admin/competitions/${slug}/displays`, { slug: `${slug}-board`, title: 'Main <board>', type: 'schedule', options: {} });
  const hidden = await h.api<any>('POST', `/api/admin/competitions/${slug}/displays`, { slug: `${slug}-off`, title: 'Switched off', type: 'league', options: {} });
  await h.api('PATCH', `/api/admin/displays/${hidden.id}`, { enabled: false });
  const draft = `d-${randomBytes(5).toString('hex')}`;
  await h.api('POST', '/api/admin/competitions', { name: `Draft ${draft}`, slug: draft, matchDurationSeconds: 60, matchSize: 2 }, 201);
  await h.api('POST', `/api/admin/competitions/${draft}/displays`, { slug: `${draft}-board`, title: 'Draft board', type: 'league', options: {} });

  const page = await h.request({ method: 'GET', url: '/kiosk', as: null });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(`href="/display/${shown.slug}"`), 'enabled display is listed');
  assert.ok(page.body.includes('Main &lt;board&gt;'), 'titles are escaped');
  assert.ok(!page.body.includes(`${slug}-off`), 'disabled displays are not listed');
  assert.ok(!page.body.includes(`${draft}-board`), 'draft competitions are not listed');
});
