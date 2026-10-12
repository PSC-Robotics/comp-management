import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { skip, startHarness, type Harness } from './helpers.js';

let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (h) await h.close(); });

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Item = { id: string; kind: string; number: number; arena: string; start: number; end: number; deps: string[]; gap: number; done: boolean };

/** Checks the schedule invariants that the re-flow must always restore. */
async function checkInvariants(slug: string, context: string) {
  const matches = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`);
  const events = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/events`);
  const playoffs = await h.api<any>('GET', `/api/admin/competitions/${slug}/playoffs`);
  const unstarted: Item[] = matches
    .filter((match) => ['scheduled', 'ready', 'delayed'].includes(match.state) && !match.countdown_started_at)
    .map((match) => ({
      id: match.id, kind: match.isPlayoff ? 'heat' : 'match', number: match.match_number, arena: match.arena_name,
      start: Date.parse(match.effective_start), end: Date.parse(match.effective_start) + match.duration_seconds * 1000,
      deps: [], gap: Number(match.planned_gap_seconds ?? 0), done: false
    }));
  const problems: string[] = [];
  const byArena = new Map<string, Item[]>();
  for (const item of unstarted) byArena.set(item.arena, [...(byArena.get(item.arena) ?? []), item]);
  for (const [arena, items] of byArena) {
    items.sort((a, b) => a.start - b.start);
    for (let index = 1; index < items.length; index += 1) {
      if (items[index]!.start < items[index - 1]!.end) {
        problems.push(`${arena}: ${items[index - 1]!.kind} #${items[index - 1]!.number} overlaps ${items[index]!.kind} #${items[index]!.number}`);
      }
    }
  }
  for (const event of events) {
    const start = Date.parse(event.starts_at);
    const end = start + event.duration_minutes * 60_000;
    for (const item of unstarted) {
      if (item.start < end && start < item.end) problems.push(`${item.kind} #${item.number} is inside event "${event.title}"`);
    }
  }
  // Every unstarted heat waits for the unstarted heats that feed it, plus its gap.
  const heats = new Map<string, any>((playoffs.matches ?? []).map((heat: any) => [heat.id, heat]));
  for (const heat of heats.values()) {
    if (heat.schedule_state !== 'scheduled' || heat.timer_state !== 'scheduled' || heat.countdown_started_at) continue;
    for (const source of heat.sources ?? []) {
      const feeder = heats.get(/^place:\d:(.+)$/.exec(source)?.[1] ?? '');
      if (!feeder || feeder.schedule_state !== 'scheduled' || feeder.timer_state !== 'scheduled') continue;
      const ready = Date.parse(feeder.effective_start) + feeder.duration_seconds * 1000 + Number(heat.planned_gap_seconds) * 1000;
      if (Date.parse(heat.effective_start) < ready) problems.push(`heat #${heat.match_number} starts before feeder heat #${feeder.match_number} finishes`);
    }
  }
  assert.deepEqual(problems, [], `after ${context}`);
}

for (const seed of [1, 7, 42, 99, 1234, 2026]) {
  test(`random operations keep the schedule consistent (seed ${seed})`, { skip, timeout: 600_000 }, async () => {
    const random = rng(seed);
    const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
    const { slug } = await h.createCompetition(12, 120);
    const first = new Date(Date.now() + 2 * 3600_000);
    first.setSeconds(0, 0);
    await h.api('POST', `/api/admin/competitions/${slug}/generate-schedule`, {
      matchCount: 9, firstStart: first.toISOString(), intervalSeconds: 180, arenas: ['A', 'B'],
      positions: [1, 2, 3, 4].map((n) => ({ label: `Position ${n - 1}` }))
    }, 201);
    let playoffsMade = false;
    const log: string[] = [];
    for (let step = 0; step < 70; step += 1) {
      const matches = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/matches`);
      const events = await h.api<any[]>('GET', `/api/admin/competitions/${slug}/events`);
      const upcoming = matches.filter((m) => ['scheduled', 'ready', 'delayed'].includes(m.state) && !m.countdown_started_at);
      const league = upcoming.filter((m) => !m.isPlayoff);
      const heats = upcoming.filter((m) => m.isPlayoff && m.state === 'ready');
      const running = matches.filter((m) => !m.isPlayoff && ['running', 'paused'].includes(m.state));
      const awaiting = matches.filter((m) => !m.isPlayoff && m.state === 'awaiting_score');
      const latest = Math.max(first.getTime(), ...matches.map((m) => Date.parse(m.effective_start)));
      const operations: Array<[string, () => Promise<unknown>]> = [];
      const target = pick(league);
      if (target) {
        operations.push(['delay', () => h.request({ method: 'POST', url: `/api/admin/matches/${target.id}/delay`, payload: { delaySeconds: 60 * (1 + Math.floor(random() * 15)), reason: 'chaos' } })]);
        operations.push(['undelay', () => h.request({ method: 'POST', url: `/api/admin/matches/${target.id}/undelay`, payload: random() < 0.5 ? { restoreScheduled: true, reason: 'chaos' } : { delaySeconds: 120, reason: 'chaos' } })]);
        operations.push(['edit', () => h.request({ method: 'PATCH', url: `/api/admin/matches/${target.id}/schedule`, payload: {
          arenaName: pick(['A', 'B']), scheduledStart: new Date(first.getTime() + Math.floor(random() * 40) * 60_000).toISOString(),
          positions: target.positions.map((p: any) => ({ number: p.position, label: p.label ?? `Position ${p.spot}`, ...(p.teamCode ? { teamCode: p.teamCode } : {}) })),
          ...(target.team_count < 4 ? { underfilledReason: 'chaos' } : {})
        } })]);
        if (!running.some((m) => m.arena_name === target.arena_name)) {
          operations.push(['start', async () => {
            const response = await h.request({ method: 'POST', url: `/api/admin/matches/${target.id}/start`, payload: {} });
            await h.fastForwardCountdowns();
            return response;
          }]);
        }
      }
      operations.push(['event', () => h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/events`, payload: {
        title: `Break ${step}`, startsAt: new Date(first.getTime() + Math.floor(random() * Math.max(30, (latest - first.getTime()) / 60_000)) * 60_000).toISOString(),
        durationMinutes: 5 + Math.floor(random() * 40), description: '', location: ''
      } })]);
      const event = pick(events);
      if (event) operations.push(['remove event', () => h.request({ method: 'DELETE', url: `/api/admin/events/${event.id}` })]);
      operations.push(['delay all', () => h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/delay-all`, payload: { delaySeconds: 60 * (1 + Math.floor(random() * 10)), reason: 'chaos', ...(random() < 0.5 ? { arenaName: pick(['A', 'B']) } : {}) } })]);
      operations.push(['undelay all', () => h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/undelay-all`, payload: {} })]);
      const live = pick(running);
      if (live) {
        operations.push(['finish', () => h.request({ method: 'POST', url: `/api/admin/matches/${live.id}/finish`, payload: {} })]);
        operations.push(['pause/resume', () => h.request({ method: 'POST', url: `/api/admin/matches/${live.id}/${live.state === 'paused' ? 'resume' : 'pause'}`, payload: {} })]);
        operations.push(['reset', () => h.request({ method: 'POST', url: `/api/admin/matches/${live.id}/reset`, payload: {} })]);
      }
      const done = pick(awaiting);
      if (done) {
        const codes = done.positions.filter((p: any) => p.teamCode).map((p: any) => p.teamCode);
        operations.push(['score', () => h.request({ method: 'POST', url: `/api/admin/matches/${done.id}/scores`, payload: { scores: codes.map((teamCode: string) => ({ teamCode, leaguePoints: Math.floor(random() * 10) })) } })]);
      }
      if (!playoffsMade && step > 10) {
        operations.push(['playoffs', async () => {
          playoffsMade = true;
          return h.request({ method: 'POST', url: `/api/admin/competitions/${slug}/playoffs`, payload: { fieldSize: 8 + Math.floor(random() * 5), format: pick(['double-elimination', 'single-elimination']), intervalMinutes: 3, arenaNames: ['A', 'B'] } });
        }]);
      }
      const heat = pick(heats);
      if (heat) {
        operations.push(['heat delay', () => h.request({ method: 'POST', url: `/api/admin/playoff-matches/${heat.id}/delay`, payload: { delaySeconds: 60 * (1 + Math.floor(random() * 8)), reason: 'chaos' } })]);
      }
      const [name, run] = pick(operations)!;
      const response = await run() as { statusCode: number; body: string };
      log.push(`${step}: ${name} -> ${response.statusCode}`);
      assert.ok(response.statusCode < 500, `step ${step} ${name} -> ${response.statusCode}: ${response.body}\n${log.slice(-10).join('\n')}`);
      await checkInvariants(slug, `step ${step} (${name})\n${log.slice(-8).join('\n')}`);
    }
  });
}
