export type BracketSide = 'upper' | 'lower' | 'final';

export type PlannedPlayoffMatch = {
  key: string;
  side: BracketSide;
  round: number;
  sources: [string, string, string, string];
};

export type PlayoffMatchState = PlannedPlayoffMatch & {
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

export function buildDoubleEliminationPlan(teamCount: number): PlannedPlayoffMatch[] {
  if (!Number.isInteger(teamCount) || teamCount < 2) {
    throw new RangeError('A double-elimination bracket needs at least two teams');
  }

  const matches: PlannedPlayoffMatch[] = [];
  let nextMatch = 1;
  const addMatch = (side: BracketSide, round: number, sources: string[]): PlannedPlayoffMatch => {
    if (sources.length < 2 || sources.length > 4) {
      throw new Error('Every playoff heat must have two to four entrants');
    }
    const paddedSources = [...sources, ...Array<string>(4 - sources.length).fill('bye')];
    const match: PlannedPlayoffMatch = {
      key: `playoff-${nextMatch++}`,
      side,
      round,
      sources: [paddedSources[0]!, paddedSources[1]!, paddedSources[2]!, paddedSources[3]!]
    };
    matches.push(match);
    return match;
  };
  const place = (rank: number, match: PlannedPlayoffMatch) => `place:${rank}:${match.key}`;

  if (teamCount <= 4) {
    addMatch('final', 1, Array.from({ length: teamCount }, (_, index) => `seed:${index + 1}`));
    return matches;
  }

  let upperSources = Array.from({ length: teamCount }, (_, index) => `seed:${index + 1}`);
  let lowerSources: string[] = [];
  let upperRound = 1;
  let lowerRound = 1;

  const planHeats = (sources: string[], side: BracketSide, round: number) => {
    const advancing: string[] = [];
    const losing: string[] = [];
    let index = 0;
    while (sources.length - index >= 4) {
      const match = addMatch(side, round, sources.slice(index, index + 4));
      advancing.push(place(1, match), place(2, match));
      losing.push(place(3, match), place(4, match));
      index += 4;
    }
    const remainder = sources.slice(index);
    if (remainder.length >= 2) {
      const match = addMatch(side, round, remainder);
      const advanceCount = playoffAdvancingPlaces(remainder.length);
      advancing.push(...Array.from({ length: advanceCount }, (_, rank) => place(rank + 1, match)));
      losing.push(...Array.from({ length: remainder.length - advanceCount }, (_, rank) =>
        place(advanceCount + rank + 1, match)));
    } else {
      advancing.push(...remainder);
    }
    return { advancing, losing };
  };

  const drainLowerBracket = (sources: string[]): string[] => {
    let survivors = [...sources];
    while (survivors.length > 2) {
      survivors = planHeats(survivors, 'lower', lowerRound).advancing;
      lowerRound += 1;
    }
    return survivors;
  };

  while (upperSources.length > 2) {
    const round = planHeats(upperSources, 'upper', upperRound);
    upperSources = round.advancing;
    lowerSources = drainLowerBracket([...lowerSources, ...round.losing]);
    upperRound += 1;
  }
  lowerSources = drainLowerBracket([...lowerSources]);
  if (upperSources.length !== 2 || lowerSources.length !== 2) {
    throw new Error('Playoff plan must produce two undefeated and two lower-bracket finalists');
  }
  addMatch('final', 1, [...upperSources, ...lowerSources]);
  return matches;
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
