export type StandingTeam = {
  id: string;
  code: string;
  leaguePoints: number;
  matchPoints: number;
};

export type StandingScore = {
  matchId: string;
  teamId: string;
  points: number;
};

export type RankedStanding<T> = T & {
  /** Codes of other teams still level after every tie-break; empty when the place is decided. */
  tiedWith: string[];
};

/**
 * Orders the league table. Ties are broken, in turn, by:
 * 1. league points (match + challenge points);
 * 2. match points only;
 * 3. head-to-head: points scored in league matches where at least two of the tied teams met;
 * 4. best single match score.
 * Teams still level are listed by team code and reported in `tiedWith` so a
 * judge can decide them; the code order is never presented as a sporting result.
 */
export function rankStandings<T extends StandingTeam>(teams: T[], scores: StandingScore[]): RankedStanding<T>[] {
  const scoresByTeam = new Map<string, StandingScore[]>();
  for (const score of scores) {
    const list = scoresByTeam.get(score.teamId) ?? [];
    list.push(score);
    scoresByTeam.set(score.teamId, list);
  }
  const bestMatch = (team: T) => Math.max(Number.NEGATIVE_INFINITY, ...(scoresByTeam.get(team.id) ?? []).map((score) => score.points));
  const headToHead = (group: T[]) => {
    const ids = new Set(group.map((team) => team.id));
    const membersByMatch = new Map<string, number>();
    for (const score of scores) {
      if (ids.has(score.teamId)) membersByMatch.set(score.matchId, (membersByMatch.get(score.matchId) ?? 0) + 1);
    }
    return new Map(group.map((team) => [team.id, (scoresByTeam.get(team.id) ?? [])
      .filter((score) => (membersByMatch.get(score.matchId) ?? 0) >= 2)
      .reduce((sum, score) => sum + score.points, 0)]));
  };

  const keyed = (group: T[], key: (team: T) => number): T[][] => {
    const buckets = new Map<number, T[]>();
    for (const team of group) {
      const value = key(team);
      buckets.set(value, [...(buckets.get(value) ?? []), team]);
    }
    return [...buckets.entries()].sort(([left], [right]) => right - left).map(([, bucket]) => bucket);
  };

  const resolve = (group: T[], stage: number): RankedStanding<T>[] => {
    if (group.length === 1) return [{ ...group[0]!, tiedWith: [] }];
    if (stage === 4) {
      const ordered = [...group].sort((left, right) => left.code.localeCompare(right.code));
      return ordered.map((team) => ({
        ...team,
        tiedWith: ordered.filter((other) => other.id !== team.id).map((other) => other.code)
      }));
    }
    let buckets: T[][];
    if (stage === 0) buckets = keyed(group, (team) => team.leaguePoints);
    else if (stage === 1) buckets = keyed(group, (team) => team.matchPoints);
    else if (stage === 2) {
      const h2h = headToHead(group);
      buckets = keyed(group, (team) => h2h.get(team.id) ?? 0);
    } else buckets = keyed(group, bestMatch);
    return buckets.flatMap((bucket) => resolve(bucket, stage + 1));
  };
  return resolve(teams, 0);
}
