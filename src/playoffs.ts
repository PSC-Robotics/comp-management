export type BracketSide = 'upper' | 'lower' | 'final';

export const playoffFormats = ['double-elimination', 'single-elimination', 'direct-final'] as const;
export type PlayoffFormat = (typeof playoffFormats)[number];

export type PlayoffPlanOptions = {
  format?: PlayoffFormat;
  /** Number of teams in the final heat (2-4). */
  finalSize?: number;
  /** Top league seeds that skip the knockout rounds and go straight to the final. */
  finalByes?: number;
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
 * Splits a round into heats of four where possible. A remainder of one is
 * never left as a bye: the last full heat and the single team become 3 + 2.
 */
export function playoffHeatSizes(entrantCount: number): number[] {
  if (!Number.isInteger(entrantCount) || entrantCount < 2) {
    throw new RangeError('A playoff round needs at least two entrants');
  }
  if (entrantCount <= 4) return [entrantCount];
  const fullHeats = Math.floor(entrantCount / 4);
  const remainder = entrantCount % 4;
  if (remainder === 0) return Array<number>(fullHeats).fill(4);
  if (remainder >= 2) return [...Array<number>(fullHeats).fill(4), remainder];
  return [...Array<number>(fullHeats - 1).fill(4), 3, 2];
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
  const finalSize = options.finalSize ?? 4;
  const finalByes = options.finalByes ?? 0;
  if (!Number.isInteger(teamCount) || teamCount < 2) {
    throw new RangeError('A playoff needs at least two teams');
  }
  if (!playoffFormats.includes(format)) throw new RangeError(`Unknown playoff format: ${format}`);
  if (!Number.isInteger(finalSize) || finalSize < 2 || finalSize > 4) {
    throw new RangeError('The final must have two to four teams');
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
    const sizes = playoffHeatSizes(entrants.length);
    const eliminations = entrants.length - target;
    if (eliminations < sizes.length) {
      // Too few places to lose for a full round (e.g. five teams into a four-team
      // final): the weakest entrants play one heat and the strongest pass through.
      const ordered = [...entrants].sort((left, right) => left.strength - right.strength);
      const heatSize = Math.min(4, entrants.length);
      const passing = ordered.slice(0, entrants.length - heatSize);
      const played = planRound(ordered.slice(entrants.length - heatSize), side, round, heatSize - eliminations);
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
