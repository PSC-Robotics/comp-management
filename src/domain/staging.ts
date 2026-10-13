import { MATCH_COUNTDOWN_TOTAL_SECONDS } from './display.js';

export type StagingInput = {
  key: string;
  arena: string;
  state: string;
  effectiveStart: number;
  actualStart: number | null;
  countdownStartedAt: number | null;
};

export type StagingWindow = {
  opens: number;
  closes: number;
  signalShepherds: number;
};

export type StagingSettings = {
  /** Staging for a match closes this many minutes after the previous match in its arena starts. */
  closeAfterPreviousStartMinutes: number;
  /** For the first match in an arena (no previous match), staging opens this long before it starts. */
  firstMatchLeadMinutes: number;
};

export const defaultStagingSettings: StagingSettings = { closeAfterPreviousStartMinutes: 5, firstMatchLeadMinutes: 10 };

/** When a match really starts (or is expected to): its actual start, its countdown's GO, or its slot. */
export function matchStartTime(match: Pick<StagingInput, 'actualStart' | 'countdownStartedAt' | 'effectiveStart'>): number {
  if (match.actualStart !== null) return match.actualStart;
  if (match.countdownStartedAt !== null) return match.countdownStartedAt + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000;
  return match.effectiveStart;
}

/**
 * Staging windows for every match, the single source of truth for SR staging,
 * shepherding and any other screen. In each arena, staging for a match opens
 * when the previous match starts (or `firstMatchLeadMinutes` before the first
 * match) and closes `closeAfterPreviousStartMinutes` later — but never after
 * the match itself starts, so a long setting with short slots cannot leave
 * staging open while the match is already running. Shepherds are signalled
 * when staging opens.
 */
export function computeStagingWindows(matches: StagingInput[], settings: StagingSettings = defaultStagingSettings): Map<string, StagingWindow> {
  const windows = new Map<string, StagingWindow>();
  const byArena = new Map<string, StagingInput[]>();
  for (const match of matches) {
    if (match.state === 'cancelled') continue;
    byArena.set(match.arena, [...(byArena.get(match.arena) ?? []), match]);
  }
  for (const arenaMatches of byArena.values()) {
    arenaMatches.sort((left, right) => left.effectiveStart - right.effectiveStart || left.key.localeCompare(right.key));
    arenaMatches.forEach((match, index) => {
      const start = matchStartTime(match);
      const previous = arenaMatches[index - 1];
      const opens = Math.min(
        previous ? matchStartTime(previous) : match.effectiveStart - settings.firstMatchLeadMinutes * 60_000,
        start
      );
      const closes = Math.max(opens, Math.min(opens + settings.closeAfterPreviousStartMinutes * 60_000, start));
      windows.set(match.key, { opens, closes, signalShepherds: opens });
    });
  }
  return windows;
}
