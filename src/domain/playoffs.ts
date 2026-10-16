export type BracketSide = 'upper' | 'lower' | 'final';

export const playoffFormats = ['double-elimination', 'single-elimination', 'direct-final'] as const;
export type PlayoffFormat = (typeof playoffFormats)[number];

export type PlayoffPlanOptions = {
  format?: PlayoffFormat;
  /** Number of teams in the final heat (2-4). */
  finalSize?: number;
  /** Top league seeds that skip the knockout rounds and go straight to the final. */
  finalByes?: number;
  /** Most teams in any heat: the competition's teams per match (2-4). */
  heatSize?: number;
};

export type PlannedPlayoffMatch = {
  key: string;
  side: BracketSide;
  round: number;
  sources: [string, string, string, string];
  /** Places (from 1st) that progress along the winning path; lower places drop down or are eliminated. */
  advancing: number;
};

export type PlayoffMatchState = Omit<PlannedPlayoffMatch, 'advancing'> & {
  teamIds: [string | null, string | null, string | null, string | null];
  placements: string[] | null;
  status: 'pending' | 'ready' | 'complete';
};

export function playoffAdvancingPlaces(teamCount: number): number {
  if (!Number.isInteger(teamCount) || teamCount < 2 || teamCount > 4) {
    throw new RangeError('A playoff heat needs two to four teams');
  }
  return teamCount === 2 ? 1 : 2;
}

export function buildPlayoffSeedRanks(
  standingTeamIds: readonly string[],
  fieldSize: number
): { seedRanks: Record<string, number>; seedTeams: Map<number, string> } {
  if (!Number.isInteger(fieldSize) || fieldSize < 2 || standingTeamIds.length < fieldSize ||
      standingTeamIds.some((teamId) => !teamId) ||
      new Set(standingTeamIds).size !== standingTeamIds.length) {
    throw new RangeError('Playoff seeds require a field size of at least two and enough unique teams');
  }
  const selected = standingTeamIds.slice(0, fieldSize);
  const seedTeams = new Map(selected.map((teamId, index) => [index + 1, teamId]));
  return {
    seedRanks: Object.fromEntries(selected.map((teamId, index) => [teamId, index + 1])),
    seedTeams
  };
}

export function playoffSeedSnapshotMatchesRanks(
  standings: readonly { id: string }[],
  fieldSize: number,
  seedRanks: Readonly<Record<string, number>>
): boolean {
  if (!Number.isInteger(fieldSize) || fieldSize < 2 || standings.length < fieldSize ||
      standings.some((team) => !team.id) ||
      new Set(standings.map((team) => team.id)).size !== standings.length) {
    return false;
  }
  const selected = standings.slice(0, fieldSize);
  const actualTeamIds = Object.keys(seedRanks);
  return actualTeamIds.length === fieldSize &&
    selected.every((team, index) => seedRanks[team.id] === index + 1);
}

export function rankPlayoffScores(
  scores: { teamId: string; points: number }[],
  seedRanks: Readonly<Record<string, number>>
): string[] {
  if (scores.length < 2 || scores.length > 4 ||
      new Set(scores.map((score) => score.teamId)).size !== scores.length ||
      scores.some((score) => !Number.isFinite(score.points) || seedRanks[score.teamId] === undefined)) {
    throw new RangeError('A playoff heat needs two to four uniquely seeded teams with finite scores');
  }
  return [...scores]
    .sort((left, right) => right.points - left.points || seedRanks[left.teamId]! - seedRanks[right.teamId]!)
    .map((score) => score.teamId);
}

/**
 * Splits a round into heats of `heatSize` where possible. A remainder of one is
 * never a heat on its own: with heats of three or four the last full heat and the
 * single team are split into two smaller heats (4+1 → 3+2, 3+1 → 2+2). Heats of
 * two cannot be split, so the odd team out is left for planRound to pass through.
 */
export function playoffHeatSizes(entrantCount: number, heatSize = 4): number[] {
  if (!Number.isInteger(entrantCount) || entrantCount < 2) {
    throw new RangeError('A playoff round needs at least two entrants');
  }
  if (!Number.isInteger(heatSize) || heatSize < 2 || heatSize > 4) {
    throw new RangeError('Heats must have two to four teams');
  }
  if (entrantCount <= heatSize) return [entrantCount];
  const fullHeats = Math.floor(entrantCount / heatSize);
  const remainder = entrantCount % heatSize;
  if (remainder === 0) return Array<number>(fullHeats).fill(heatSize);
  if (remainder >= 2) return [...Array<number>(fullHeats).fill(heatSize), remainder];
  if (heatSize === 2) return Array<number>(fullHeats).fill(2);
  const joined = heatSize + 1;
  return [...Array<number>(fullHeats - 1).fill(heatSize), Math.ceil(joined / 2), Math.floor(joined / 2)];
}

type PlannedEntrant = {
  source: string;
  /** Lower is stronger: league seed, or finishing place within the previous round. */
  strength: number;
  /** The heat (or seed) the entrant comes from; used to avoid immediate rematches. */
  origin: string;
};

/**
 * Deals entrants into heats strongest-first in a serpentine order so the top
 * seeds are spread across heats, while keeping entrants from the same previous
 * heat apart wherever the heat sizes allow it.
 */
function distributeEntrants(entrants: PlannedEntrant[], sizes: number[]): PlannedEntrant[][] {
  const ordered = [...entrants].sort((left, right) =>
    left.strength - right.strength || left.source.localeCompare(right.source));
  const heats: PlannedEntrant[][] = sizes.map(() => []);
  ordered.forEach((entrant, index) => {
    const pass = Math.floor(index / sizes.length);
    const offset = index % sizes.length;
    const preferred = pass % 2 === 0 ? offset : sizes.length - 1 - offset;
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    heats.forEach((heat, heatIndex) => {
      if (heat.length >= sizes[heatIndex]!) return;
      const rematches = heat.filter((other) => other.origin === entrant.origin).length;
      const cost = rematches * 1000 + Math.abs(heatIndex - preferred);
      if (cost < bestCost) {
        bestCost = cost;
        best = heatIndex;
      }
    });
    heats[best]!.push(entrant);
  });
  return heats;
}

/**
 * Builds the heat plan for a playoff. All formats use heats of two to four
 * teams and finish with a single final heat of `finalSize` teams.
 *
 * - double-elimination: losing once drops a team to the lower bracket; a second
 *   loss eliminates it. The final takes the upper- and lower-bracket survivors.
 * - single-elimination: the bottom places of each heat are eliminated.
 * - direct-final: the top seeds go straight into the final.
 *
 * `finalByes` sends that many top seeds straight into the final; the remaining
 * final places are earned through the knockout rounds.
 */
export function buildPlayoffPlan(teamCount: number, options: PlayoffPlanOptions = {}): PlannedPlayoffMatch[] {
  const format = options.format ?? 'double-elimination';
  const heatSize = options.heatSize ?? 4;
  const finalSize = options.finalSize ?? heatSize;
  const finalByes = options.finalByes ?? 0;
  if (!Number.isInteger(heatSize) || heatSize < 2 || heatSize > 4) {
    throw new RangeError('Heats must have two to four teams');
  }
  if (!Number.isInteger(teamCount) || teamCount < 2) {
    throw new RangeError('A playoff needs at least two teams');
  }
  if (!playoffFormats.includes(format)) throw new RangeError(`Unknown playoff format: ${format}`);
  if (!Number.isInteger(finalSize) || finalSize < 2 || finalSize > heatSize) {
    throw new RangeError(`The final must have two to ${heatSize} teams`);
  }
  if (!Number.isInteger(finalByes) || finalByes < 0 || finalByes >= finalSize) {
    throw new RangeError('Final byes must leave at least one final place to be earned');
  }
  if (format === 'direct-final' && teamCount > finalSize) {
    throw new RangeError(`A direct final takes at most ${finalSize} teams; choose a smaller field or a knockout format`);
  }

  const matches: PlannedPlayoffMatch[] = [];
  let nextMatch = 1;
  const addMatch = (side: BracketSide, round: number, sources: string[], advancing: number): PlannedPlayoffMatch => {
    if (sources.length < 2 || sources.length > 4) {
      throw new Error('Every playoff heat must have two to four entrants');
    }
    const paddedSources = [...sources, ...Array<string>(4 - sources.length).fill('bye')];
    const match: PlannedPlayoffMatch = {
      key: `playoff-${nextMatch++}`,
      side,
      round,
      sources: [paddedSources[0]!, paddedSources[1]!, paddedSources[2]!, paddedSources[3]!],
      advancing
    };
    matches.push(match);
    return match;
  };
  const seed = (rank: number): PlannedEntrant => ({ source: `seed:${rank}`, strength: rank, origin: `seed:${rank}` });

  if (teamCount <= finalSize) {
    addMatch('final', 1, Array.from({ length: teamCount }, (_, index) => `seed:${index + 1}`), 0);
    return matches;
  }

  const qualifyingPlaces = finalSize - finalByes;
  if (format === 'double-elimination' && qualifyingPlaces < 2) {
    throw new RangeError('Double elimination needs at least two final places to be earned; reduce the final byes');
  }

  /**
   * Plans one round. When `target` is given the round never advances fewer
   * than `target` entrants, and a single-heat round advances exactly `target`,
   * so the side finishes with precisely the number of final places it feeds.
   */
  const planRound = (
    entrants: PlannedEntrant[], side: BracketSide, round: number, target: number
  ): { advancing: PlannedEntrant[]; losing: PlannedEntrant[] } => {
    const sizes = playoffHeatSizes(entrants.length, heatSize);
    const seated = sizes.reduce((sum, size) => sum + size, 0);
    if (seated < entrants.length) {
      // Heats of two with an odd number of entrants: the strongest gets a bye this round.
      const ordered = [...entrants].sort((left, right) => left.strength - right.strength);
      const passing = ordered.slice(0, entrants.length - seated);
      const played = planRound(ordered.slice(entrants.length - seated), side, round, Math.max(1, target - passing.length));
      return { advancing: [...passing, ...played.advancing], losing: played.losing };
    }
    const eliminations = entrants.length - target;
    if (eliminations < sizes.length) {
      // Too few places to lose for a full round (e.g. five teams into a four-team
      // final): the weakest entrants play one heat and the strongest pass through.
      const ordered = [...entrants].sort((left, right) => left.strength - right.strength);
      const playing = Math.min(heatSize, entrants.length);
      const passing = ordered.slice(0, entrants.length - playing);
      const played = planRound(ordered.slice(entrants.length - playing), side, round, playing - eliminations);
      return { advancing: [...passing, ...played.advancing], losing: played.losing };
    }
    const heats = distributeEntrants(entrants, sizes);
    const advancingCounts = sizes.map((size) => playoffAdvancingPlaces(size));
    if (sizes.length === 1) {
      advancingCounts[0] = target;
    } else {
      let total = advancingCounts.reduce((sum, count) => sum + count, 0);
      while (total < target) {
        const heatIndex = advancingCounts.findIndex((count, index) => count < sizes[index]! - 1);
        advancingCounts[heatIndex]! += 1;
        total += 1;
      }
    }
    const advancing: PlannedEntrant[] = [];
    const losing: PlannedEntrant[] = [];
    heats.forEach((heat, heatIndex) => {
      const advanceCount = advancingCounts[heatIndex]!;
      const match = addMatch(side, round, heat.map((entrant) => entrant.source), advanceCount);
      for (let rank = 1; rank <= heat.length; rank += 1) {
        const entrant = { source: `place:${rank}:${match.key}`, strength: rank * 1000 + heatIndex, origin: match.key };
        (rank <= advanceCount ? advancing : losing).push(entrant);
      }
    });
    return { advancing, losing };
  };

  const byes = Array.from({ length: finalByes }, (_, index) => seed(index + 1));
  let upper = Array.from({ length: teamCount - finalByes }, (_, index) => seed(finalByes + index + 1));
  let lower: PlannedEntrant[] = [];
  let upperRound = 1;
  let lowerRound = 1;

  if (format === 'single-elimination') {
    while (upper.length > qualifyingPlaces) {
      upper = planRound(upper, 'upper', upperRound, qualifyingPlaces).advancing;
      upperRound += 1;
    }
  } else {
    const upperPlaces = Math.ceil(qualifyingPlaces / 2);
    const lowerPlaces = qualifyingPlaces - upperPlaces;
    const drainLower = (target: number) => {
      while (lower.length > target) {
        lower = planRound(lower, 'lower', lowerRound, target).advancing;
        lowerRound += 1;
      }
    };
    while (upper.length > upperPlaces) {
      const round = planRound(upper, 'upper', upperRound, upperPlaces);
      upper = round.advancing;
      lower = [...lower, ...round.losing];
      drainLower(Math.max(2, lowerPlaces));
      upperRound += 1;
    }
    drainLower(lowerPlaces);
  }

  const finalists = [...byes, ...upper, ...lower];
  if (finalists.length !== finalSize) {
    throw new Error(`Playoff plan produced ${finalists.length} finalists instead of ${finalSize}`);
  }
  addMatch('final', 1, finalists.map((entrant) => entrant.source), 0);
  return matches;
}

export function buildDoubleEliminationPlan(teamCount: number): PlannedPlayoffMatch[] {
  return buildPlayoffPlan(teamCount, { format: 'double-elimination' });
}

/** Keys of the heats whose placings feed each heat. */
export function playoffDependencies(
  matches: readonly { key: string; sources: readonly string[] }[]
): Map<string, string[]> {
  return new Map(matches.map((match) => [match.key, [...new Set(match.sources
    .map((source) => /^place:[1-4]:(.+)$/.exec(source)?.[1])
    .filter((key): key is string => key !== undefined))]]));
}

/**
 * Column index for drawing a bracket: seeded heats are stage 1 and every other
 * heat is one stage after the latest heat that feeds it.
 */
export function playoffStages(
  matches: readonly { key: string; sources: readonly string[] }[]
): Map<string, number> {
  const dependencies = playoffDependencies(matches);
  const stages = new Map<string, number>();
  const stageOf = (key: string, visiting: Set<string>): number => {
    const known = stages.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) throw new Error('Playoff heats contain a dependency cycle');
    visiting.add(key);
    const parents = (dependencies.get(key) ?? []).filter((parent) => dependencies.has(parent));
    const stage = parents.length ? Math.max(...parents.map((parent) => stageOf(parent, visiting))) + 1 : 1;
    visiting.delete(key);
    stages.set(key, stage);
    return stage;
  };
  for (const match of matches) stageOf(match.key, new Set());
  return stages;
}

/**
 * Loss and elimination tally for a bracket. A team takes a loss when it places
 * below a heat's advancing places, and is eliminated when that placing does
 * not feed any later heat.
 */
export function summarisePlayoffLosses(
  matches: readonly {
    key: string; side: BracketSide; sources: readonly string[];
    placements: readonly string[] | null; advancing: number | null;
  }[]
): Map<string, { losses: number; eliminated: boolean }> {
  const consumed = new Set(matches.flatMap((match) => match.sources));
  const summary = new Map<string, { losses: number; eliminated: boolean }>();
  for (const match of matches) {
    if (match.side === 'final' || !match.placements || match.placements.length < 2) continue;
    const advancing = match.advancing ?? playoffAdvancingPlaces(match.placements.length);
    match.placements.forEach((teamId, index) => {
      const entry = summary.get(teamId) ?? { losses: 0, eliminated: false };
      if (index + 1 > advancing) entry.losses += 1;
      if (!consumed.has(`place:${index + 1}:${match.key}`)) entry.eliminated = true;
      summary.set(teamId, entry);
    });
  }
  return summary;
}

export function resolvePlayoffAdvancements(
  initialMatches: PlayoffMatchState[],
  seedTeams: ReadonlyMap<number, string>
): PlayoffMatchState[] {
  const matches = initialMatches.map((match) => ({ ...match }));
  const byId = new Map(matches.map((match) => [match.key, match]));
  const resolveSource = (source: string): { resolved: boolean; teamId: string | null } => {
    if (source === 'bye') return { resolved: true, teamId: null };
    if (source.startsWith('seed:')) {
      const seed = Number(source.slice('seed:'.length));
      return { resolved: Number.isInteger(seed), teamId: seedTeams.get(seed) ?? null };
    }
    const match = /^place:([1-4]):(.+)$/.exec(source);
    if (!match) return { resolved: false, teamId: null };
    const prior = byId.get(match[2]!);
    if (!prior || prior.status !== 'complete' || !prior.placements) return { resolved: false, teamId: null };
    return { resolved: true, teamId: prior.placements[Number(match[1]) - 1] ?? null };
  };

  for (let pass = 0; pass <= matches.length; pass += 1) {
    let changed = false;
    for (const match of matches) {
      if (match.status === 'complete') continue;
      const resolved = match.sources.map(resolveSource);
      const teamIds = match.teamIds.map((teamId, index) =>
        resolved[index]!.resolved ? resolved[index]!.teamId : teamId
      ) as PlayoffMatchState['teamIds'];
      const allResolved = resolved.every((source) => source.resolved);
      const status = allResolved && teamIds.filter((teamId) => teamId !== null).length >= 2
        ? 'ready'
        : 'pending';
      if (teamIds.some((teamId, index) => teamId !== match.teamIds[index]) || status !== match.status) {
        match.teamIds = teamIds;
        match.status = status;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return matches;
}

export type PlayoffTie = {
  /** Places (1-based) shared by the tied teams. */
  places: number[];
  teamIds: string[];
};

/**
 * Ties that change an outcome: teams on equal points whose places lead to
 * different destinations (e.g. one advances and one drops, or different
 * final placings). `destination(place)` names where a place leads.
 * `placement` is the best-first order already computed for the heat.
 */
export function findDecisivePlayoffTies(
  placement: readonly string[],
  points: ReadonlyMap<string, number>,
  destination: (place: number) => string
): PlayoffTie[] {
  const ties: PlayoffTie[] = [];
  let start = 0;
  while (start < placement.length) {
    let end = start + 1;
    while (end < placement.length && points.get(placement[end]!) === points.get(placement[start]!)) end += 1;
    if (end - start > 1) {
      const places = Array.from({ length: end - start }, (_, index) => start + index + 1);
      if (new Set(places.map(destination)).size > 1) {
        ties.push({ places, teamIds: placement.slice(start, end) });
      }
    }
    start = end;
  }
  return ties;
}

/**
 * Validates a judge's full finishing order: it must contain exactly the heat's
 * teams and may only reorder teams on equal points.
 */
export function validateTieBreakOrder(
  order: readonly string[],
  points: ReadonlyMap<string, number>
): string | null {
  if (order.length !== points.size || new Set(order).size !== order.length ||
      order.some((teamId) => !points.has(teamId))) {
    return 'The tie-break order must list every team in the heat exactly once';
  }
  for (let index = 1; index < order.length; index += 1) {
    if (points.get(order[index]!)! > points.get(order[index - 1]!)!) {
      return 'The tie-break order can only reorder teams on equal points';
    }
  }
  return null;
}

/** One heat as drawn in the custom playoff builder. */
export type CustomPlayoffHeat = {
  /** The builder's own id for the heat (letters, digits and dashes). */
  key: string;
  side: BracketSide;
  /** Where each slot's team comes from: `seed:N` or `place:P:<key of another heat>`. */
  sources: string[];
};

/**
 * Checks a hand-drawn bracket and turns it into a playoff plan: every league seed 1..N is used
 * exactly once, each finishing place feeds at most one slot, heats have two to `heatSize`
 * entrants, there are no loops, and exactly one final that feeds nothing. Heats come back in
 * playing order (feeders first) with plan keys, and each heat's advancing places are the
 * finishing places that go on to a non-lower heat (the rest drop to the lower bracket or out).
 */
export function buildCustomPlayoffPlan(
  heats: CustomPlayoffHeat[], heatSize = 4
): { plan: PlannedPlayoffMatch[]; fieldSize: number; order: string[] } {
  if (!heats.length || heats.length > 64) throw new RangeError('A custom bracket needs between one and 64 heats');
  const byKey = new Map<string, CustomPlayoffHeat>();
  for (const heat of heats) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(heat.key)) throw new RangeError('Heat ids may only use letters, digits and dashes');
    if (byKey.has(heat.key)) throw new RangeError(`Heat ${heat.key} appears twice`);
    byKey.set(heat.key, heat);
  }
  const finals = heats.filter((heat) => heat.side === 'final');
  if (finals.length !== 1) throw new RangeError('Mark exactly one heat as the final');
  const seeds = new Set<number>();
  const usedPlaces = new Set<string>();
  const label = (key: string) => `heat ${heats.findIndex((heat) => heat.key === key) + 1}`;
  for (const heat of heats) {
    if (heat.sources.length < 2 || heat.sources.length > heatSize) {
      throw new RangeError(`${label(heat.key)} needs two to ${heatSize} teams`);
    }
    for (const source of heat.sources) {
      const seed = /^seed:(\d{1,3})$/.exec(source);
      const place = /^place:([1-4]):([A-Za-z0-9-]{1,40})$/.exec(source);
      if (seed) {
        const rank = Number(seed[1]);
        if (rank < 1) throw new RangeError('Seeds start at 1');
        if (seeds.has(rank)) throw new RangeError(`Seed ${rank} is used more than once`);
        seeds.add(rank);
      } else if (place) {
        const feeder = byKey.get(place[2]!);
        if (!feeder) throw new RangeError(`${label(heat.key)} takes a place from a heat that does not exist`);
        if (feeder.key === heat.key) throw new RangeError(`${label(heat.key)} cannot feed itself`);
        if (feeder.side === 'final') throw new RangeError('The final cannot feed another heat');
        if (Number(place[1]) > feeder.sources.length) {
          throw new RangeError(`${label(feeder.key)} has only ${feeder.sources.length} teams, so it has no place ${place[1]}`);
        }
        if (usedPlaces.has(`${place[1]}:${feeder.key}`)) {
          throw new RangeError(`Place ${place[1]} of ${label(feeder.key)} is sent to more than one slot`);
        }
        usedPlaces.add(`${place[1]}:${feeder.key}`);
      } else {
        throw new RangeError(`${label(heat.key)} has a slot with no team source`);
      }
    }
  }
  const fieldSize = seeds.size;
  if (fieldSize < 2) throw new RangeError('A bracket needs at least two league seeds');
  for (let rank = 1; rank <= fieldSize; rank += 1) {
    if (!seeds.has(rank)) throw new RangeError(`Seeds must run from 1 to ${fieldSize} with none skipped (seed ${rank} is missing)`);
  }
  // Playing order: a heat comes after every heat that feeds it (and loops are refused).
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string) => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') throw new RangeError('The bracket has a loop: a heat feeds into itself through other heats');
    state.set(key, 'visiting');
    for (const source of byKey.get(key)!.sources) {
      const place = /^place:[1-4]:(.+)$/.exec(source);
      if (place) visit(place[1]!);
    }
    state.set(key, 'done');
    order.push(key);
  };
  for (const heat of heats) visit(heat.key);
  // The final is played last.
  const finalKey = finals[0]!.key;
  order.splice(order.indexOf(finalKey), 1);
  order.push(finalKey);
  const planKey = new Map(order.map((key, index) => [key, `playoff-${index + 1}`]));
  const stages = playoffStages(heats.map((heat) => ({ key: heat.key, sources: heat.sources })));
  const plan = order.map((key) => {
    const heat = byKey.get(key)!;
    const sources = heat.sources.map((source) =>
      source.replace(/^place:([1-4]):(.+)$/, (_whole, place: string, feeder: string) => `place:${place}:${planKey.get(feeder)}`));
    const padded = [...sources, ...Array<string>(4 - sources.length).fill('bye')];
    // Places that carry on along the winning path (into upper heats or the final).
    let advancing = 0;
    for (let place = 1; place <= heat.sources.length; place += 1) {
      const target = heats.find((other) => other.sources.includes(`place:${place}:${key}`));
      if (target && (target.side !== 'lower' || heat.side === 'lower')) advancing = place; else break;
    }
    return {
      key: planKey.get(key)!,
      side: heat.side,
      round: stages.get(key) ?? 1,
      sources: [padded[0]!, padded[1]!, padded[2]!, padded[3]!] as [string, string, string, string],
      advancing: heat.side === 'final' ? 0 : Math.max(1, advancing)
    };
  });
  return { plan, fieldSize, order };
}
