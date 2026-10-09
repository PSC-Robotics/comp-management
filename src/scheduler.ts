export type GeneratedMatch = {
  codes: string[];
  positions: string[];
};

export type WaveAssignment = GeneratedMatch & {
  wave: number;
  arenaIndex: number;
};

export type ScheduleCascadeCandidate = {
  id: string;
  effectiveStart: number;
  durationSeconds: number;
  plannedGapSeconds?: number;
};

export type ScheduleCascadeShift = {
  id: string;
  effectiveStart: number;
  delaySeconds: number;
};

export type EventScheduleMatch = ScheduleCascadeCandidate & {
  matchNumber: number;
  arenaName: string;
  hasCountdown: boolean;
  plannedGapSeconds?: number;
  /** A running or paused match: it cannot move but occupies its arena until `effectiveStart + durationSeconds`. */
  fixed?: boolean;
};

export type ScheduleEventBlock = {
  title: string;
  startsAt: number;
  durationMinutes: number;
};

export type EventScheduleShift = ScheduleCascadeShift & {
  reason: string;
};

export type EventSchedulePlan = {
  shifts: EventScheduleShift[];
  error?: string;
};

export function calculateEventScheduleShifts(
  matches: EventScheduleMatch[],
  events: ScheduleEventBlock[],
  cause: string
): EventSchedulePlan {
  for (const event of events) {
    if (!Number.isFinite(event.startsAt) || !Number.isInteger(event.durationMinutes) ||
        event.durationMinutes < 1) {
      throw new RangeError('Scheduled events need a valid start and positive duration');
    }
  }
  const ordered = [...matches].sort((left, right) =>
    left.arenaName.localeCompare(right.arenaName) ||
    left.effectiveStart - right.effectiveStart ||
    left.matchNumber - right.matchNumber
  );
  const eventsByTime = [...events].sort((left, right) => left.startsAt - right.startsAt);
  const nextByArena = new Map<string, number>();
  const shifts: EventScheduleShift[] = [];
  for (const match of ordered) {
    if (!Number.isFinite(match.effectiveStart) || !Number.isInteger(match.durationSeconds) ||
        match.durationSeconds < 1 || !Number.isInteger(match.matchNumber) || match.matchNumber < 1 ||
        (match.plannedGapSeconds !== undefined &&
          (!Number.isInteger(match.plannedGapSeconds) || match.plannedGapSeconds < 0))) {
      throw new RangeError('Scheduled matches need valid start, duration and match number');
    }
    const priorStart = match.effectiveStart;
    const priorArenaEnd = nextByArena.get(match.arenaName);
    if (match.fixed) {
      nextByArena.set(match.arenaName, Math.max(priorArenaEnd ?? Number.NEGATIVE_INFINITY,
        priorStart + match.durationSeconds * 1000));
      continue;
    }
    const gapMilliseconds = priorArenaEnd === undefined ? 0 : (match.plannedGapSeconds ?? 0) * 1000;
    let start = Math.max(priorStart, (priorArenaEnd ?? priorStart) + gapMilliseconds);
    if (start > priorStart) start = Math.ceil(start / 60_000) * 60_000;
    let causeEvent: string | null = null;
    for (let index = 0; index < eventsByTime.length; index += 1) {
      const event = eventsByTime[index]!;
      const eventEnd = event.startsAt + event.durationMinutes * 60_000;
      if (event.startsAt < start + match.durationSeconds * 1000 && eventEnd > start) {
        if (match.hasCountdown) {
          return {
            shifts: [],
            error: `Cancel the active start countdown before moving match #${match.matchNumber} around ${event.title}`
          };
        }
        start = Math.ceil(eventEnd / 60_000) * 60_000;
        causeEvent = event.title;
        index = -1;
      }
    }
    nextByArena.set(match.arenaName, start + match.durationSeconds * 1000);
    if (start > priorStart) {
      shifts.push({
        id: match.id,
        effectiveStart: start,
        delaySeconds: Math.ceil((start - priorStart) / 1000),
        reason: causeEvent
          ? `Moved around scheduled event: ${causeEvent} (${cause})`
          : `Delayed to avoid an arena overlap (${cause})`
      });
    }
  }
  return { shifts };
}

export class ScheduleGenerationError extends Error {
  statusCode = 422;
}

export function roundedDelaySeconds(overlapMilliseconds: number): number {
  if (!Number.isFinite(overlapMilliseconds)) {
    throw new RangeError('Schedule overlap must be a finite number');
  }
  return overlapMilliseconds <= 0 ? 0 : Math.ceil(overlapMilliseconds / 60_000) * 60;
}

export function calculateDelayReduction(
  scheduledStart: number,
  effectiveStart: number,
  reductionSeconds: number | undefined,
  restoreScheduled: boolean
): { effectiveStart: number; reductionSeconds: number; remainingDelaySeconds: number } {
  if (!Number.isFinite(scheduledStart) || !Number.isFinite(effectiveStart) ||
      effectiveStart < scheduledStart ||
      (restoreScheduled ? reductionSeconds !== undefined
        : !Number.isInteger(reductionSeconds) || reductionSeconds! < 1)) {
    throw new RangeError('Delay reduction needs valid schedule times and exactly one reduction mode');
  }
  const currentDelaySeconds = Math.ceil((effectiveStart - scheduledStart) / 1000);
  if (currentDelaySeconds === 0) {
    throw new RangeError('This match is already at its scheduled start time');
  }
  const requestedSeconds = restoreScheduled
    ? currentDelaySeconds
    : Math.min(reductionSeconds!, currentDelaySeconds);
  const nextStart = restoreScheduled
    ? scheduledStart
    : Math.max(scheduledStart, effectiveStart - requestedSeconds * 1000);
  const actualReduction = Math.ceil((effectiveStart - nextStart) / 1000);
  return {
    effectiveStart: nextStart,
    reductionSeconds: actualReduction,
    remainingDelaySeconds: Math.max(0, Math.ceil((nextStart - scheduledStart) / 1000))
  };
}

export function calculateTimerResetStart(
  scheduledStart: number,
  effectiveStart: number,
  now: number
): number {
  if (!Number.isFinite(scheduledStart) || !Number.isFinite(effectiveStart) ||
      !Number.isFinite(now) || effectiveStart < scheduledStart) {
    throw new RangeError('Timer reset needs valid scheduled, effective, and current times');
  }
  const nextMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
  return Math.max(effectiveStart, nextMinute);
}

export function calculateScheduleCascade(
  candidates: ScheduleCascadeCandidate[],
  firstMatchEnd: number,
  firstPlannedGapSeconds = 0
): ScheduleCascadeShift[] {
  if (!Number.isFinite(firstMatchEnd) || !Number.isInteger(firstPlannedGapSeconds) ||
      firstPlannedGapSeconds < 0) {
    throw new RangeError('First match end and planned gap must be valid');
  }
  let projectedStart = firstMatchEnd + firstPlannedGapSeconds * 1000;
  let previousStart = Number.NEGATIVE_INFINITY;
  const shifts: ScheduleCascadeShift[] = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.effectiveStart) ||
        !Number.isInteger(candidate.durationSeconds) || candidate.durationSeconds < 1 ||
        (candidate.plannedGapSeconds !== undefined &&
          (!Number.isInteger(candidate.plannedGapSeconds) || candidate.plannedGapSeconds < 0)) ||
        candidate.effectiveStart < previousStart) {
      throw new RangeError('Schedule cascade candidates must be valid and ordered by start time');
    }
    previousStart = candidate.effectiveStart;
    const delaySeconds = roundedDelaySeconds(projectedStart - candidate.effectiveStart);
    const effectiveStart = candidate.effectiveStart + delaySeconds * 1000;
    if (delaySeconds > 0) {
      shifts.push({ id: candidate.id, effectiveStart, delaySeconds });
    }
    projectedStart = effectiveStart + candidate.durationSeconds * 1000 +
      (candidate.plannedGapSeconds ?? 0) * 1000;
  }
  return shifts;
}

export function calculateWaveStartTime(
  firstStart: number,
  wave: number,
  intervalSeconds: number,
  durationSeconds: number
): number {
  if (!Number.isFinite(firstStart) || !Number.isInteger(wave) || wave < 0 ||
      !Number.isInteger(intervalSeconds) || intervalSeconds < 1 ||
      !Number.isInteger(durationSeconds) || durationSeconds < 1 ||
      intervalSeconds < durationSeconds) {
    throw new RangeError('Wave schedule inputs must be valid');
  }
  return firstStart + wave * intervalSeconds * 1000;
}

export type PlayoffScheduleHeat = {
  id: string;
  matchNumber: number;
  arenaName: string;
  effectiveStart: number;
  durationSeconds: number;
  /** Minimum gap after the previous heat in the arena and after every heat that feeds this one. */
  plannedGapSeconds: number;
  /** Ids of heats whose placings decide this heat's entrants. */
  dependsOn: string[];
  /** Set for started, finished or scored heats: they keep their time and free the arena at this instant. */
  fixedEnd?: number;
  /** For fixed heats, when the result is known (defaults to `fixedEnd`). Unscored heats are later than their end. */
  resultAvailableAt?: number;
};

/**
 * Moves unstarted playoff heats later so that each one starts no earlier than
 * its planned gap after (a) the previous heat in the same arena and (b) every
 * heat that feeds it. Heats in different arenas with no dependency between
 * them can run side by side. Heats are never moved earlier.
 */
export function calculatePlayoffHeatCascade(heats: PlayoffScheduleHeat[]): ScheduleCascadeShift[] {
  for (const heat of heats) {
    if (!Number.isFinite(heat.effectiveStart) || !Number.isInteger(heat.durationSeconds) ||
        heat.durationSeconds < 1 || !Number.isInteger(heat.plannedGapSeconds) || heat.plannedGapSeconds < 0 ||
        (heat.fixedEnd !== undefined && !Number.isFinite(heat.fixedEnd)) ||
        (heat.resultAvailableAt !== undefined && !Number.isFinite(heat.resultAvailableAt))) {
      throw new RangeError('Playoff heat schedule data must contain valid times, durations and gaps');
    }
  }
  const ordered = [...heats].sort((left, right) => left.matchNumber - right.matchNumber);
  const endById = new Map<string, number>();
  const resultById = new Map<string, number>();
  const arenaEnd = new Map<string, number>();
  const shifts: ScheduleCascadeShift[] = [];
  for (const heat of ordered) {
    let start = heat.effectiveStart;
    if (heat.fixedEnd === undefined) {
      const gap = heat.plannedGapSeconds * 1000;
      const constraints = heat.dependsOn
        .map((id) => resultById.get(id))
        .filter((value): value is number => value !== undefined);
      const previousInArena = arenaEnd.get(heat.arenaName);
      if (previousInArena !== undefined) constraints.push(previousInArena);
      const delaySeconds = constraints.length
        ? roundedDelaySeconds(Math.max(...constraints) + gap - start)
        : 0;
      if (delaySeconds > 0) {
        start += delaySeconds * 1000;
        shifts.push({ id: heat.id, effectiveStart: start, delaySeconds });
      }
    }
    const end = heat.fixedEnd ?? start + heat.durationSeconds * 1000;
    endById.set(heat.id, end);
    resultById.set(heat.id, Math.max(end, heat.resultAvailableAt ?? end));
    arenaEnd.set(heat.arenaName, Math.max(arenaEnd.get(heat.arenaName) ?? Number.NEGATIVE_INFINITY, end));
  }
  return shifts;
}

export type PlayoffHeatTimingInput = {
  key: string;
  dependsOn: string[];
  isFinal: boolean;
};

export type PlayoffHeatTiming = {
  key: string;
  arenaName: string;
  start: number;
  plannedGapSeconds: number;
};

/**
 * Assigns each heat (in dependency order) to the arena that lets it start
 * soonest. A heat starts at least one heat slot after any heat feeding it and
 * after the previous heat in its arena; the final can have an extra buffer.
 * With one arena this gives the classic back-to-back slots.
 */
export function planPlayoffHeatTimes(
  heats: PlayoffHeatTimingInput[],
  arenaNames: string[],
  firstStart: number,
  intervalSeconds: number,
  durationSeconds: number,
  finalBufferSeconds = 0
): PlayoffHeatTiming[] {
  if (!arenaNames.length || new Set(arenaNames).size !== arenaNames.length ||
      !Number.isFinite(firstStart) || !Number.isInteger(intervalSeconds) || intervalSeconds < 1 ||
      !Number.isInteger(durationSeconds) || durationSeconds < 1 || intervalSeconds < durationSeconds ||
      !Number.isInteger(finalBufferSeconds) || finalBufferSeconds < 0) {
    throw new RangeError('Playoff timing needs arenas, a valid first start, and an interval at least as long as a match');
  }
  const interval = intervalSeconds * 1000;
  const startByKey = new Map<string, number>();
  const arenaFree = new Map(arenaNames.map((name) => [name, firstStart]));
  const timings: PlayoffHeatTiming[] = [];
  heats.forEach((heat, index) => {
    const ready = Math.max(firstStart, ...heat.dependsOn.map((key) => {
      const dependencyStart = startByKey.get(key);
      if (dependencyStart === undefined) throw new RangeError('Playoff heats must be listed after the heats that feed them');
      return dependencyStart + interval;
    }));
    let arenaName = arenaNames[0]!;
    let start = Number.POSITIVE_INFINITY;
    for (const name of arenaNames) {
      const candidate = Math.max(ready, arenaFree.get(name)!);
      if (candidate < start) {
        start = candidate;
        arenaName = name;
      }
    }
    // The final (and anything after it) waits for every other heat, so all arenas close first.
    if (heat.isFinal && index > 0) {
      start = Math.max(start, ...timings.map((timing) => timing.start + interval)) + finalBufferSeconds * 1000;
    }
    startByKey.set(heat.key, start);
    arenaFree.set(arenaName, start + interval);
    timings.push({
      key: heat.key,
      arenaName,
      start,
      plannedGapSeconds: intervalSeconds - durationSeconds + (heat.isFinal && index > 0 ? finalBufferSeconds : 0)
    });
  });
  return timings;
}

export function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!];
  }
  return items;
}

export function generateBalancedMatches(codes: string[], matchCount: number, seed: number): {
  matches: GeneratedMatch[];
  pairRange: [number, number];
  appearancesPerTeam: number;
  positionRange: [number, number];
} {
  if (codes.length < 4 || new Set(codes).size !== codes.length) {
    throw new ScheduleGenerationError('A balanced schedule needs at least four distinct teams');
  }
  if (!Number.isInteger(matchCount) || matchCount < 1 ||
      (matchCount * 4) % codes.length !== 0) {
    throw new ScheduleGenerationError('The match count cannot give every team equal appearances');
  }

  const appearancesPerTeam = (matchCount * 4) / codes.length;
  const cycleCount = appearancesPerTeam;
  let bestGroups: string[][] | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  const random = createRandom(seed);

  for (let attempt = 0; attempt < 160; attempt += 1) {
    const baseOrder = [...codes];
    const sequence: string[] = [];
    let trailingTeams: string[] = [];
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      if (cycle === 0) {
        sequence.push(...shuffle(baseOrder, random));
      } else {
        const prefixLength = 4 - trailingTeams.length;
        const prefix = shuffle(codes.filter((code) => !trailingTeams.includes(code)), random).slice(0, prefixLength);
        const remainder = shuffle(codes.filter((code) => !prefix.includes(code)), random);
        sequence.push(...prefix, ...remainder);
      }
      const trailingLength = sequence.length % 4;
      trailingTeams = trailingLength === 0 ? [] : sequence.slice(-trailingLength);
    }

    const groups: string[][] = [];
    let valid = true;
    for (let index = 0; index < sequence.length; index += 4) {
      const group = sequence.slice(index, index + 4);
      if (group.length !== 4 || new Set(group).size !== 4) {
        valid = false;
        break;
      }
      groups.push(group);
    }
    if (!valid || groups.length !== matchCount) continue;

    const pairs = new Map<string, number>();
    for (let left = 0; left < codes.length; left += 1) {
      for (let right = left + 1; right < codes.length; right += 1) {
        pairs.set([codes[left]!, codes[right]!].sort().join(':'), 0);
      }
    }
    for (const group of groups) {
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          const pair = [group[left]!, group[right]!].sort().join(':');
          pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
        }
      }
    }
    const cost = [...pairs.values()].reduce((sum, count) => sum + count * count, 0);
    if (cost < bestCost) {
      bestCost = cost;
      bestGroups = groups;
    }
  }

  if (!bestGroups) {
    throw new ScheduleGenerationError('Could not construct a full schedule for this team and match count');
  }

  const positionCounts = Array.from({ length: 4 }, () => new Map<string, number>());
  const permutations = [
    [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1],
    [0, 3, 1, 2], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2],
    [1, 2, 0, 3], [1, 2, 3, 0], [1, 3, 0, 2], [1, 3, 2, 0],
    [2, 0, 1, 3], [2, 0, 3, 1], [2, 1, 0, 3], [2, 1, 3, 0],
    [2, 3, 0, 1], [2, 3, 1, 0], [3, 0, 1, 2], [3, 0, 2, 1],
    [3, 1, 0, 2], [3, 1, 2, 0], [3, 2, 0, 1], [3, 2, 1, 0]
  ];
  const matches: GeneratedMatch[] = [];
  for (const group of bestGroups) {
    let bestCostForPositions = Number.POSITIVE_INFINITY;
    let bestPositions: string[] | undefined;
    const options = shuffle([...permutations], random);
    for (const permutation of options) {
      const ordered = permutation.map((teamIndex) => group[teamIndex]!);
      const cost = ordered.reduce(
        (sum, code, position) => sum + (positionCounts[position]!.get(code) ?? 0),
        0
      );
      if (cost < bestCostForPositions) {
        bestCostForPositions = cost;
        bestPositions = ordered;
      }
    }
    const ordered = bestPositions!;
    ordered.forEach((code, position) => {
      const counts = positionCounts[position]!;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    });
    matches.push({ codes: group, positions: ordered });
  }

  const pairCounts = new Map<string, number>();
  for (let left = 0; left < codes.length; left += 1) {
    for (let right = left + 1; right < codes.length; right += 1) {
      pairCounts.set([codes[left]!, codes[right]!].sort().join(':'), 0);
    }
  }
  for (const match of bestGroups) {
    for (let left = 0; left < match.length; left += 1) {
      for (let right = left + 1; right < match.length; right += 1) {
        const key = [match[left]!, match[right]!].sort().join(':');
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const allPairs = [...pairCounts.values()];
  const positions = [...positionCounts.flatMap((counts) => [...counts.values()])];
  return {
    matches,
    pairRange: [Math.min(...allPairs), Math.max(...allPairs)],
    appearancesPerTeam,
    positionRange: [Math.min(...positions), Math.max(...positions)]
  };
}

export function assignMatchesToWaves(matches: GeneratedMatch[], arenaCount: number): WaveAssignment[] {
  if (!Number.isInteger(arenaCount) || arenaCount < 1) {
    throw new ScheduleGenerationError('At least one arena is required');
  }
  const waves: Array<{ teams: Set<string>; matches: number }> = [];
  return matches.map((match) => {
    let wave = waves.findIndex((candidate) =>
      candidate.matches < arenaCount && match.codes.every((code) => !candidate.teams.has(code))
    );
    if (wave < 0) {
      wave = waves.length;
      waves.push({ teams: new Set(), matches: 0 });
    }
    const assignment = waves[wave]!;
    const arenaIndex = assignment.matches;
    for (const code of match.codes) assignment.teams.add(code);
    assignment.matches += 1;
    return { ...match, wave, arenaIndex };
  });
}
