import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import * as oidc from 'openid-client';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import {
  cornerColoursSchema,
  defaultCornerColours,
  displayTypeSchema,
  displayOptionsSchema,
  formatCompetitionDateTime,
  formatCompetitionTime,
  isValidTimeZone,
  MATCH_COUNTDOWN_PREPARATION_SECONDS,
  MATCH_COUNTDOWN_TOTAL_SECONDS,
  publicMatchPriority,
  readableTextColour
} from './display.js';
import {
  buildPlayoffSeedRanks,
  buildDoubleEliminationPlan,
  playoffAdvancingPlaces,
  playoffSeedSnapshotMatchesRanks,
  rankPlayoffScores,
  resolvePlayoffAdvancements,
  type PlayoffMatchState
} from './playoffs.js';
import {
  buildSrDisplayConfig,
  groupSrKnockoutMatches,
  selectSrMatchFeed,
  selectSrDisplayMatches,
  toSrMatches,
  type SrMatchInput
} from './srcomp.js';
import {
  assignMatchesToWaves,
  calculateDelayReduction,
  calculateTimerResetStart,
  calculateScheduleCascade,
  calculateWaveStartTime,
  calculatePlannedHeatCascade,
  calculateEventScheduleShifts,
  generateBalancedMatches,
  greatestCommonDivisor,
  roundedDelaySeconds
} from './scheduler.js';

const env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional()
}).parse(process.env);

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
const sessionCookie = 'competition_session';
const sessionHours = 8;
const SR_SCREEN_PING_PERIOD_MS = 5_000;

let oidcClient: oidc.Configuration | undefined;

const schema = `
CREATE TABLE IF NOT EXISTS competitions (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'live', 'complete')),
  timezone text NOT NULL DEFAULT 'UTC',
  match_duration_seconds integer NOT NULL CHECK (match_duration_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  code char(3) NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, code)
);
CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  match_number integer NOT NULL CHECK (match_number > 0),
  arena_name text NOT NULL DEFAULT 'Arena 1',
  scheduled_start timestamptz NOT NULL,
  effective_start timestamptz NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds > 0),
  planned_gap_seconds integer NOT NULL DEFAULT 0 CHECK (planned_gap_seconds >= 0),
  start_mode text NOT NULL CHECK (start_mode IN ('automatic', 'manual')),
  state text NOT NULL CHECK (state IN ('scheduled', 'ready', 'delayed', 'running', 'paused', 'awaiting_score', 'complete', 'cancelled')),
  underfilled_acknowledged_by text,
  underfilled_reason text,
  actual_start timestamptz,
  actual_end timestamptz,
  countdown_started_at timestamptz,
  paused_at timestamptz,
  paused_seconds integer NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, match_number)
);
CREATE TABLE IF NOT EXISTS match_positions (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  position_number smallint NOT NULL CHECK (position_number BETWEEN 1 AND 4),
  position_label text NOT NULL,
  colour text NOT NULL DEFAULT '#777777',
  team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  PRIMARY KEY (match_id, position_number),
  UNIQUE (match_id, team_id)
);
CREATE TABLE IF NOT EXISTS match_delays (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  reason text NOT NULL,
  delay_seconds integer NOT NULL CHECK (delay_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS match_scores (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  league_points numeric NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, team_id)
);
CREATE TABLE IF NOT EXISTS score_revisions (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL,
  team_id uuid NOT NULL,
  result jsonb NOT NULL,
  league_points numeric NOT NULL,
  reason text NOT NULL,
  actor_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS oidc_flows (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  actor_email text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS competition_settings (
  competition_id uuid PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  theme text NOT NULL DEFAULT 'paper' CHECK (theme IN ('paper', 'field', 'night')),
  logo_data_url text,
  auto_run_enabled boolean NOT NULL DEFAULT false,
  corner_colours jsonb NOT NULL DEFAULT '["#d1495b","#00798c","#edae49","#30638e"]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE competition_settings ADD COLUMN IF NOT EXISTS auto_run_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE competition_settings ADD COLUMN IF NOT EXISTS corner_colours jsonb NOT NULL DEFAULT '["#d1495b","#00798c","#edae49","#30638e"]'::jsonb;
UPDATE match_positions mp
SET colour = coalesce(s.corner_colours ->> (mp.position_number - 1),
  (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[mp.position_number])
FROM matches m
LEFT JOIN competition_settings s ON s.competition_id = m.competition_id
WHERE mp.match_id = m.id
  AND mp.colour IS DISTINCT FROM coalesce(s.corner_colours ->> (mp.position_number - 1),
    (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[mp.position_number]);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS countdown_started_at timestamptz;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS planned_gap_seconds integer NOT NULL DEFAULT 0
  CHECK (planned_gap_seconds >= 0);
UPDATE matches SET start_mode = 'manual' WHERE start_mode <> 'manual';
CREATE TABLE IF NOT EXISTS public_displays (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  display_type text NOT NULL CHECK (display_type IN ('league', 'schedule', 'arena', 'timer', 'corner', 'results')),
  enabled boolean NOT NULL DEFAULT true,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public_displays DROP CONSTRAINT IF EXISTS public_displays_display_type_check;
UPDATE public_displays SET display_type = 'schedule' WHERE display_type = 'bracket';
ALTER TABLE public_displays ADD CONSTRAINT public_displays_display_type_check
  CHECK (display_type IN (
    'league', 'schedule', 'arena', 'timer', 'corner', 'results',
    'sr-arena', 'sr-outside', 'sr-producer', 'sr-shepherding', 'sr-staging'
  ));
CREATE TABLE IF NOT EXISTS playoff_brackets (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  field_size integer NOT NULL CHECK (field_size >= 2),
  seed_ranks jsonb NOT NULL,
  seed_standings_snapshot jsonb,
  seed_match_number integer,
  seed_snapshot_at timestamptz,
  seed_frozen_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS seed_standings_snapshot jsonb;
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS seed_match_number integer;
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS seed_snapshot_at timestamptz;
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS seed_frozen_at timestamptz;
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS playoff_brackets_field_size_check;
ALTER TABLE playoff_brackets ADD CONSTRAINT playoff_brackets_field_size_check CHECK (field_size >= 2);
CREATE TABLE IF NOT EXISTS playoff_matches (
  id uuid PRIMARY KEY,
  bracket_id uuid NOT NULL REFERENCES playoff_brackets(id) ON DELETE CASCADE,
  match_number integer NOT NULL,
  bracket_side text NOT NULL CHECK (bracket_side IN ('upper', 'lower', 'final')),
  round_number integer NOT NULL,
  source_one text NOT NULL,
  source_two text NOT NULL,
  source_three text NOT NULL DEFAULT 'pending',
  source_four text NOT NULL DEFAULT 'pending',
  team_one_id uuid REFERENCES teams(id),
  team_two_id uuid REFERENCES teams(id),
  team_three_id uuid REFERENCES teams(id),
  team_four_id uuid REFERENCES teams(id),
  winner_team_id uuid REFERENCES teams(id),
  tied boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'complete')),
  placements jsonb,
  scheduled_start timestamptz NOT NULL DEFAULT now(),
  effective_start timestamptz NOT NULL DEFAULT now(),
  arena_name text NOT NULL DEFAULT 'Arena 1',
  duration_seconds integer NOT NULL DEFAULT 120 CHECK (duration_seconds > 0),
  planned_gap_seconds integer NOT NULL DEFAULT 0 CHECK (planned_gap_seconds >= 0),
  schedule_state text NOT NULL DEFAULT 'scheduled' CHECK (schedule_state IN ('scheduled', 'complete')),
  timer_state text NOT NULL DEFAULT 'scheduled' CHECK (timer_state IN ('scheduled', 'running', 'paused', 'awaiting_score')),
  countdown_started_at timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  paused_at timestamptz,
  paused_seconds integer NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0),
  UNIQUE (bracket_id, match_number)
);
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS source_three text NOT NULL DEFAULT 'pending';
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS source_four text NOT NULL DEFAULT 'pending';
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS team_three_id uuid REFERENCES teams(id);
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS team_four_id uuid REFERENCES teams(id);
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS placements jsonb;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS scheduled_start timestamptz NOT NULL DEFAULT now();
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS effective_start timestamptz NOT NULL DEFAULT now();
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS arena_name text NOT NULL DEFAULT 'Arena 1';
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS duration_seconds integer NOT NULL DEFAULT 120;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS planned_gap_seconds integer NOT NULL DEFAULT 0 CHECK (planned_gap_seconds >= 0);
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS schedule_state text NOT NULL DEFAULT 'scheduled';
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS timer_state text NOT NULL DEFAULT 'scheduled';
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS countdown_started_at timestamptz;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS actual_start timestamptz;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS actual_end timestamptz;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS paused_seconds integer NOT NULL DEFAULT 0;
UPDATE playoff_brackets SET status = 'replaced'
WHERE status <> 'replaced' AND EXISTS (
  SELECT 1 FROM playoff_matches pm
  WHERE pm.bracket_id = playoff_brackets.id
    AND pm.source_three = 'pending' AND pm.source_four = 'pending'
);
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS playoff_brackets_status_check;
ALTER TABLE playoff_brackets ADD CONSTRAINT playoff_brackets_status_check
  CHECK (status IN ('active', 'complete', 'replaced'));
CREATE TABLE IF NOT EXISTS playoff_match_scores (
  playoff_match_id uuid NOT NULL REFERENCES playoff_matches(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  points numeric NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playoff_match_id, team_id)
);
UPDATE playoff_brackets pb SET seed_frozen_at = now()
WHERE pb.seed_frozen_at IS NULL AND EXISTS (
  SELECT 1 FROM playoff_matches pm
  WHERE pm.bracket_id = pb.id AND (
    pm.status = 'complete' OR pm.schedule_state = 'complete'
    OR pm.timer_state <> 'scheduled' OR pm.countdown_started_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM playoff_match_scores pms WHERE pms.playoff_match_id = pm.id)
  )
);
CREATE TABLE IF NOT EXISTS playoff_score_revisions (
  id uuid PRIMARY KEY,
  playoff_match_id uuid NOT NULL,
  team_id uuid NOT NULL,
  points numeric NOT NULL,
  reason text NOT NULL,
  actor_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS challenges (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  points numeric NOT NULL CHECK (points >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, name)
);
CREATE TABLE IF NOT EXISTS challenge_completions (
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  completed_by text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, team_id)
);
CREATE TABLE IF NOT EXISTS competition_events (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_schedule_idx ON matches (competition_id, scheduled_start);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS public_displays_competition_idx ON public_displays (competition_id, created_at);
CREATE INDEX IF NOT EXISTS challenges_competition_idx ON challenges (competition_id, created_at);
CREATE INDEX IF NOT EXISTS competition_events_schedule_idx ON competition_events (competition_id, starts_at);
`;

type AdminRequest = FastifyRequest & { adminEmail: string };

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]!);
}

function safeDisplayColour(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#777777';
}

async function audit(
  client: PoolClient,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_email, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), actor, action, entityType, entityId, JSON.stringify(details)]
  );
}

async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawToken = request.cookies[sessionCookie];
  if (!rawToken) {
    await reply.code(401).send({ error: 'Administrator sign-in required' });
    return;
  }
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const result = await pool.query<{ email: string }>(
    'SELECT email FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()',
    [tokenHash]
  );
  const session = result.rows[0];
  if (!session) {
    await reply.clearCookie(sessionCookie, { path: '/' }).code(401).send({ error: 'Session expired' });
    return;
  }
  (request as AdminRequest).adminEmail = session.email;
}

function adminEmail(request: FastifyRequest): string {
  return (request as AdminRequest).adminEmail;
}

async function findCompetition(client: Pool | PoolClient, slug: string) {
  const result = await client.query(
    'SELECT id, name, slug, status, timezone, match_duration_seconds FROM competitions WHERE slug = $1',
    [slug]
  );
  return result.rows[0] as {
    id: string;
    name: string;
    slug: string;
    status: string;
    timezone: string;
    match_duration_seconds: number;
  } | undefined;
}

async function getCornerColours(client: Pool | PoolClient, competitionId: string): Promise<string[]> {
  const result = await client.query<{ corner_colours: string[] }>(
    'SELECT corner_colours FROM competition_settings WHERE competition_id = $1',
    [competitionId]
  );
  return result.rows[0]?.corner_colours ?? [...defaultCornerColours];
}

async function fetchStandings(client: Pool | PoolClient, competitionId: string) {
  const result = await client.query(
    `SELECT t.id, t.code, t.name,
            coalesce(ms.match_points, 0)::numeric AS match_points,
            coalesce(cc.challenge_points, 0)::numeric AS challenge_points,
            (coalesce(ms.match_points, 0) + coalesce(cc.challenge_points, 0))::numeric AS league_points,
            coalesce(ms.scored_matches, 0)::int AS scored_matches
     FROM teams t
     LEFT JOIN (
       SELECT team_id, sum(league_points) AS match_points, count(*)::int AS scored_matches
       FROM match_scores GROUP BY team_id
     ) ms ON ms.team_id = t.id
     LEFT JOIN (
       SELECT completion.team_id, sum(challenge.points) AS challenge_points
       FROM challenge_completions completion
       JOIN challenges challenge ON challenge.id = completion.challenge_id
       GROUP BY completion.team_id
     ) cc ON cc.team_id = t.id
     WHERE t.competition_id = $1 AND t.active = true
     ORDER BY league_points DESC, t.code ASC`,
    [competitionId]
  );
  return result.rows;
}

type PlayoffSeedStanding = {
  id: string;
  rank: number;
  code: string;
  name: string;
  matchPoints: number;
  challengePoints: number;
  leaguePoints: number;
  scoredMatches: number;
};

async function fetchPlayoffSeedSnapshot(client: PoolClient, competitionId: string) {
  const result = await client.query<{
    id: string;
    code: string;
    name: string;
    match_points: string | number;
    challenge_points: string | number;
    league_points: string | number;
    scored_matches: number;
    seed_match_number: number;
    snapshot_at: Date;
  }>(
    `WITH scored_match_cutoff AS (
       SELECT coalesce(max(m.match_number), 0)::int AS seed_match_number
       FROM match_scores ms JOIN matches m ON m.id = ms.match_id
       WHERE m.competition_id = $1
     ), team_standings AS (
       SELECT t.id, t.code, t.name,
              coalesce(ms.match_points, 0)::numeric AS match_points,
              coalesce(cc.challenge_points, 0)::numeric AS challenge_points,
              (coalesce(ms.match_points, 0) + coalesce(cc.challenge_points, 0))::numeric AS league_points,
              coalesce(ms.scored_matches, 0)::int AS scored_matches
       FROM teams t
       LEFT JOIN (
         SELECT team_id, sum(league_points) AS match_points, count(*)::int AS scored_matches
         FROM match_scores GROUP BY team_id
       ) ms ON ms.team_id = t.id
       LEFT JOIN (
         SELECT completion.team_id, sum(challenge.points) AS challenge_points
         FROM challenge_completions completion
         JOIN challenges challenge ON challenge.id = completion.challenge_id
         GROUP BY completion.team_id
       ) cc ON cc.team_id = t.id
       WHERE t.competition_id = $1 AND t.active = true
     )
     SELECT standings.*, cutoff.seed_match_number, clock_timestamp() AS snapshot_at
     FROM team_standings standings CROSS JOIN scored_match_cutoff cutoff
     ORDER BY standings.league_points DESC, standings.code ASC`,
    [competitionId]
  );
  return {
    standings: result.rows.map((team, index): PlayoffSeedStanding => ({
      id: team.id,
      rank: index + 1,
      code: team.code,
      name: team.name,
      matchPoints: Number(team.match_points),
      challengePoints: Number(team.challenge_points),
      leaguePoints: Number(team.league_points),
      scoredMatches: Number(team.scored_matches)
    })),
    latestScoredMatchNumber: Number(result.rows[0]?.seed_match_number ?? 0),
    capturedAt: result.rows[0]?.snapshot_at ?? new Date()
  };
}

async function hasTeamInActiveMatch(
  client: PoolClient,
  competitionId: string,
  matchId: string
): Promise<boolean> {
  const active = await client.query(
    `SELECT 1
     FROM match_positions requested
     JOIN match_positions occupied ON occupied.team_id = requested.team_id
       AND occupied.match_id <> requested.match_id
     JOIN matches running ON running.id = occupied.match_id
     WHERE requested.match_id = $1 AND running.competition_id = $2
       AND (
         running.state IN ('running', 'paused')
         OR (running.countdown_started_at > now() - ($3 * interval '1 second')
             AND running.state IN ('scheduled', 'ready', 'delayed'))
       )
     LIMIT 1`,
    [matchId, competitionId, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
  );
  return Boolean(active.rowCount);
}

async function processMatchClocks(): Promise<void> {
  const due = await pool.query<{ id: string; competition_id: string }>(
    `SELECT m.id, m.competition_id FROM matches m
     LEFT JOIN competition_settings settings ON settings.competition_id = m.competition_id
     WHERE m.state IN ('scheduled', 'ready', 'delayed')
       AND (
         (m.countdown_started_at IS NOT NULL
          AND m.countdown_started_at + ($1 * interval '1 second') <= now())
         OR (coalesce(settings.auto_run_enabled, false)
             AND m.countdown_started_at IS NULL
             AND m.effective_start <= now() + ($1 * interval '1 second'))
       )
     ORDER BY m.effective_start, m.match_number LIMIT 25`,
    [MATCH_COUNTDOWN_TOTAL_SECONDS]
  );
  for (const candidate of due.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const matchResult = await client.query<{
        arena_name: string;
        state: string;
        effective_start: Date;
        match_number: number;
        duration_seconds: number;
        planned_gap_seconds: number;
        countdown_started_at: Date | null;
      }>(
        `SELECT arena_name, state, effective_start, match_number, duration_seconds,
                planned_gap_seconds, countdown_started_at
         FROM matches WHERE id = $1 FOR UPDATE`,
        [candidate.id]
      );
      const match = matchResult.rows[0];
      if (!match || !['scheduled', 'ready', 'delayed'].includes(match.state) ||
          (match.countdown_started_at !== null &&
           new Date(match.countdown_started_at).getTime() + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000 > Date.now())) return;
      if (match.countdown_started_at === null) {
        await client.query(
          `UPDATE matches SET countdown_started_at = effective_start - ($2 * interval '1 second'),
             revision = revision + 1 WHERE id = $1`,
          [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
        );
        await audit(client, 'system:auto-start', 'match.countdown_started', 'match', candidate.id, {
          trigger: 'competition_auto_run',
          countdownStartedAt: new Date(match.effective_start.getTime() - MATCH_COUNTDOWN_TOTAL_SECONDS * 1000).toISOString()
        });
        if (match.effective_start.getTime() > Date.now()) return;
      }
      const teams = await client.query<{ count: number }>(
        'SELECT count(team_id)::int AS count FROM match_positions WHERE match_id = $1',
        [candidate.id]
      );
      if ((teams.rows[0]?.count ?? 0) < 1) return;
      const active = await client.query(
        `SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $2
         AND id <> $3 AND (
           state IN ('running', 'paused')
           OR (countdown_started_at > now() - ($4 * interval '1 second')
               AND state IN ('scheduled', 'ready', 'delayed'))
         ) LIMIT 1`,
        [candidate.competition_id, match.arena_name, candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      if (active.rowCount) return;
      if (await hasTeamInActiveMatch(client, candidate.competition_id, candidate.id)) return;
      const started = await client.query<{ actual_start: Date }>(
        `UPDATE matches SET state = 'running',
           actual_start = coalesce(countdown_started_at + ($2 * interval '1 second'), now()),
           countdown_started_at = NULL,
           revision = revision + 1
         WHERE id = $1 RETURNING actual_start`,
        [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
      );
      const delayedMatchIds = await delayNextMatchesAfterManualStart(
        client,
        candidate.competition_id,
        match.arena_name,
        candidate.id,
        match.match_number,
        new Date(match.effective_start),
        new Date(started.rows[0]!.actual_start),
        match.duration_seconds,
        'system:auto-start',
        'automatic start'
      );
      await audit(client, 'system:auto-start', 'match.started', 'match', candidate.id, {
        trigger: 'competition_auto_run',
        delayedMatchIds
      });
    });
  }

  const completed = await pool.query<{ id: string; competition_id: string }>(
    `SELECT id, competition_id FROM matches
     WHERE state = 'running' AND actual_start + (duration_seconds + paused_seconds) * interval '1 second' <= now()
     ORDER BY actual_start LIMIT 25`
  );
  for (const candidate of completed.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const match = await client.query<{ state: string; duration_seconds: number; paused_seconds: number; actual_start: Date }>(
        'SELECT state, duration_seconds, paused_seconds, actual_start FROM matches WHERE id = $1 FOR UPDATE',
        [candidate.id]
      );
      const row = match.rows[0];
      if (!row || row.state !== 'running' || !row.actual_start) return;
      const dueAt = new Date(row.actual_start).getTime() +
        (row.duration_seconds + row.paused_seconds) * 1000;
      if (dueAt > Date.now()) return;
      await client.query(
        `UPDATE matches SET state = 'awaiting_score', actual_end = now(), revision = revision + 1 WHERE id = $1`,
        [candidate.id]
      );
      await audit(client, 'system:timer', 'match.timer_finished', 'match', candidate.id);
    });
  }

  const playoffStarts = await pool.query<{ id: string; competition_id: string }>(
    `SELECT pm.id, pb.competition_id
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.status = 'active' AND pm.schedule_state = 'scheduled'
       AND pm.timer_state = 'scheduled' AND pm.countdown_started_at IS NOT NULL
       AND pm.countdown_started_at + ($1 * interval '1 second') <= now()
     ORDER BY pm.countdown_started_at LIMIT 25`
    , [MATCH_COUNTDOWN_TOTAL_SECONDS]
  );
  for (const candidate of playoffStarts.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const heatResult = await client.query<{
        bracket_id: string; match_number: number; arena_name: string; team_ids: (string | null)[];
        duration_seconds: number; countdown_started_at: Date; timer_state: string;
      }>(
        `SELECT pm.bracket_id, pm.match_number, pm.arena_name,
                ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids,
                pm.duration_seconds, pm.countdown_started_at, pm.timer_state
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
        [candidate.id]
      );
      const heat = heatResult.rows[0];
      if (!heat || heat.timer_state !== 'scheduled' || !heat.countdown_started_at ||
          new Date(heat.countdown_started_at).getTime() + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000 > Date.now()) return;
      const teamIds = heat.team_ids.filter((teamId): teamId is string => teamId !== null);
      if (teamIds.length < 2) return;
      const conflict = await client.query(
        `SELECT 1 FROM matches m JOIN match_positions mp ON mp.match_id = m.id
         WHERE m.competition_id = $1 AND mp.team_id = ANY($2::uuid[])
           AND (m.state IN ('running', 'paused') OR
             (m.countdown_started_at > now() - ($4 * interval '1 second')
              AND m.state IN ('scheduled', 'ready', 'delayed')))
         UNION ALL
         SELECT 1 FROM playoff_matches other
         JOIN playoff_brackets ob ON ob.id = other.bracket_id
         WHERE ob.competition_id = $1 AND other.id <> $3
           AND (other.timer_state IN ('running', 'paused')
             OR other.countdown_started_at > now() - ($4 * interval '1 second'))
           AND ARRAY[other.team_one_id,other.team_two_id,other.team_three_id,other.team_four_id]
             && $2::uuid[]
         LIMIT 1`,
        [candidate.competition_id, teamIds, candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      const arenaConflict = await client.query(
        `SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $2
           AND (state IN ('running', 'paused') OR
             (countdown_started_at > now() - ($4 * interval '1 second')
              AND state IN ('scheduled', 'ready', 'delayed')))
         UNION ALL
         SELECT 1 FROM playoff_matches other JOIN playoff_brackets ob ON ob.id = other.bracket_id
         WHERE ob.competition_id = $1 AND other.id <> $3 AND other.arena_name = $2
           AND (other.timer_state IN ('running', 'paused')
             OR other.countdown_started_at > now() - ($4 * interval '1 second'))
         LIMIT 1`,
        [candidate.competition_id, heat.arena_name, candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      if (conflict.rowCount || arenaConflict.rowCount) {
        await client.query(
          `UPDATE playoff_matches SET countdown_started_at = NULL, timer_state = 'scheduled'
           WHERE id = $1`,
          [candidate.id]
        );
        await audit(client, 'system:timer', 'playoff_match.start_blocked', 'playoff_match', candidate.id, {
          reason: conflict.rowCount ? 'assigned team already active' : 'arena already active'
        });
        return;
      }
      await client.query(
        `UPDATE playoff_matches SET timer_state = 'running',
           actual_start = countdown_started_at + ($2 * interval '1 second'),
           countdown_started_at = NULL
         WHERE id = $1`,
        [candidate.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
      );
      await audit(client, 'system:timer', 'playoff_match.started', 'playoff_match', candidate.id, {
        matchNumber: heat.match_number
      });
    });
  }

  const completedHeats = await pool.query<{ id: string; competition_id: string }>(
    `SELECT pm.id, pb.competition_id FROM playoff_matches pm
     JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pm.timer_state = 'running'
       AND pm.actual_start + (pm.duration_seconds + pm.paused_seconds) * interval '1 second' <= now()
     ORDER BY pm.actual_start LIMIT 25`
  );
  for (const candidate of completedHeats.rows) {
    await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [candidate.competition_id]);
      const result = await client.query(
        `UPDATE playoff_matches SET timer_state = 'awaiting_score', actual_end = now()
         WHERE id = $1 AND timer_state = 'running'
           AND actual_start + (duration_seconds + paused_seconds) * interval '1 second' <= now()`,
        [candidate.id]
      );
      if (result.rowCount) {
        await audit(client, 'system:timer', 'playoff_match.timer_finished', 'playoff_match', candidate.id);
      }
    });
  }
}

async function delayNextMatchesAfterManualStart(
  client: PoolClient,
  competitionId: string,
  arenaName: string,
  matchId: string,
  matchNumber: number,
  priorEffectiveStart: Date,
  actualStart: Date,
  durationSeconds: number,
  actor: string,
  trigger = 'manual start'
): Promise<string[]> {
  const later = await client.query<{
    id: string;
    effective_start: Date;
    duration_seconds: number;
    planned_gap_seconds: number;
    match_number: number;
  }>(
    `SELECT id, effective_start, duration_seconds, planned_gap_seconds, match_number
     FROM matches
     WHERE competition_id = $1 AND arena_name = $2 AND id <> $3
       AND (effective_start, match_number) > ($4, $5)
       AND state IN ('scheduled', 'ready', 'delayed')
     ORDER BY effective_start, match_number
     FOR UPDATE`,
    [competitionId, arenaName, matchId, priorEffectiveStart, matchNumber]
  );
  const shifts = calculateScheduleCascade(
    later.rows.map((next) => ({
      id: next.id,
      effectiveStart: new Date(next.effective_start).getTime(),
      durationSeconds: next.duration_seconds,
      plannedGapSeconds: next.planned_gap_seconds
    })),
    actualStart.getTime() + durationSeconds * 1000
  );
  for (const shift of shifts) {
    const effectiveStart = new Date(shift.effectiveStart);
    await client.query(
      `UPDATE matches SET effective_start = $2, state = 'delayed', revision = revision + 1
       WHERE id = $1`,
      [shift.id, effectiveStart]
    );
    await client.query(
      `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), shift.id, actor, `Delayed after match #${matchNumber} (${trigger})`, shift.delaySeconds]
    );
    await audit(client, actor, 'match.schedule_cascaded', 'match', shift.id, {
      causedByMatchId: matchId,
      trigger,
      effectiveStart: effectiveStart.toISOString(),
      delaySeconds: shift.delaySeconds
    });
  }
  return shifts.map((shift) => shift.id);
}

class ScheduleCollisionError extends Error {
  readonly statusCode = 409;
}

async function shiftScheduledMatchesAroundEvents(
  client: PoolClient,
  competitionId: string,
  actor: string,
  cause: string
): Promise<string[]> {
  const eventRows = await client.query<{ title: string; starts_at: Date; duration_minutes: number }>(
    `SELECT title, starts_at, duration_minutes FROM competition_events
     WHERE competition_id = $1 ORDER BY starts_at`,
    [competitionId]
  );
  const events = eventRows.rows.map((event) => ({
    title: event.title,
    startsAt: new Date(event.starts_at).getTime(),
    durationMinutes: event.duration_minutes
  }));
  const active = await client.query<{
    id: string; arena_name: string; state: string; actual_start: Date; duration_seconds: number; paused_seconds: number;
  }>(
    `SELECT id, arena_name, state, actual_start, duration_seconds, paused_seconds FROM matches
     WHERE competition_id = $1 AND state IN ('running', 'paused') FOR UPDATE`,
    [competitionId]
  );
  for (const match of active.rows) {
    if (!match.actual_start) continue;
    const start = new Date(match.actual_start).getTime();
    const end = start + (match.duration_seconds + match.paused_seconds) * 1000;
    if (events.some((event) => event.startsAt < end &&
        event.startsAt + event.durationMinutes * 60_000 > start)) {
      throw new ScheduleCollisionError(`Cannot place an event during an active match in ${match.arena_name}`);
    }
  }
  const scheduled = await client.query<{
    id: string; match_number: number; arena_name: string; effective_start: Date;
    duration_seconds: number; planned_gap_seconds: number;
    state: string; countdown_started_at: Date | null;
  }>(
    `SELECT id, match_number, arena_name, effective_start, duration_seconds, planned_gap_seconds,
            state, countdown_started_at
     FROM matches WHERE competition_id = $1 AND state IN ('scheduled', 'ready', 'delayed')
     UNION ALL
     SELECT pm.id, pm.match_number, pm.arena_name, pm.effective_start, pm.duration_seconds,
            pm.planned_gap_seconds, pm.schedule_state AS state, NULL::timestamptz AS countdown_started_at
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.competition_id = $1 AND pb.status = 'active' AND pm.schedule_state = 'scheduled'
     ORDER BY arena_name, effective_start, match_number`,
    [competitionId]
  );
  const plan = calculateEventScheduleShifts(
    scheduled.rows.map((match) => ({
      id: match.id,
      matchNumber: match.match_number,
      arenaName: match.arena_name,
      effectiveStart: new Date(match.effective_start).getTime(),
      durationSeconds: match.duration_seconds,
      hasCountdown: match.countdown_started_at !== null,
      plannedGapSeconds: match.planned_gap_seconds
    })),
    events,
    cause
  );
  if (plan.error) throw new ScheduleCollisionError(plan.error);
  const matchById = new Map(scheduled.rows.map((match) => [match.id, match]));
  for (const change of plan.shifts) {
    const match = matchById.get(change.id);
    if (!match) throw new Error(`Shifted match ${change.id} disappeared`);
    const effectiveStart = new Date(change.effectiveStart);
    const isPlayoff = await client.query(
      'SELECT 1 FROM playoff_matches WHERE id = $1',
      [change.id]
    );
    if (isPlayoff.rowCount) {
      await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1',
        [change.id, effectiveStart]);
    } else {
      await client.query(
        `UPDATE matches SET effective_start = $2, revision = revision + 1
         WHERE id = $1`,
        [change.id, effectiveStart]
      );
    }
    await audit(client, actor, 'match.schedule_shifted_around_event', isPlayoff.rowCount ? 'playoff_match' : 'match', change.id, {
      cause,
      matchNumber: match.match_number,
      effectiveStart: effectiveStart.toISOString(),
      delaySeconds: change.delaySeconds
    });
  }
  return plan.shifts.map((change) => change.id);
}

await app.register(cookie, { secret: env.COOKIE_SECRET });
await pool.query(schema);
await pool.query(
  `WITH removed_delays AS (
     DELETE FROM match_delays
     WHERE reason LIKE 'Moved around scheduled event:%'
        OR reason LIKE 'Delayed to avoid an arena overlap (%'
     RETURNING match_id
   ),
   affected_matches AS (
     SELECT DISTINCT match_id FROM removed_delays
   )
   UPDATE matches m
   SET state = 'scheduled', revision = revision + 1
   FROM affected_matches affected
   WHERE m.id = affected.match_id
     AND m.state = 'delayed'
     AND NOT EXISTS (SELECT 1 FROM match_delays d WHERE d.match_id = m.id)`
);

if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_REDIRECT_URI) {
  oidcClient = await oidc.discovery(
    new URL(env.OIDC_ISSUER),
    env.OIDC_CLIENT_ID,
    env.OIDC_CLIENT_SECRET
  );
}

app.get('/health', async () => ({ status: 'ok' }));
app.get('/auth/status', async () => ({
  oidcConfigured: Boolean(oidcClient && env.OIDC_REDIRECT_URI)
}));

app.get('/', async (_request, reply) => {
  const html = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/auth/login', async (_request, reply) => {
  if (!oidcClient || !env.OIDC_REDIRECT_URI) {
    return reply.code(503).send('OIDC is not configured. Set the OIDC environment variables.');
  }
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  await pool.query(
    `INSERT INTO oidc_flows (state, nonce, verifier, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [state, nonce, verifier]
  );
  const url = oidc.buildAuthorizationUrl(oidcClient, {
    redirect_uri: env.OIDC_REDIRECT_URI,
    scope: 'openid profile email',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce
  });
  return reply.redirect(url.href);
});

app.get('/auth/callback', async (request, reply) => {
  if (!oidcClient || !env.OIDC_REDIRECT_URI || !request.url) {
    return reply.code(503).send({ error: 'OIDC is not configured' });
  }
  const callbackUrl = new URL(request.url, env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`);
  const state = callbackUrl.searchParams.get('state');
  if (!state) return reply.code(400).send({ error: 'Missing OIDC state' });
  const flow = await pool.query<{ nonce: string; verifier: string }>(
    `DELETE FROM oidc_flows WHERE state = $1 AND expires_at > now()
     RETURNING nonce, verifier`,
    [state]
  );
  const storedFlow = flow.rows[0];
  if (!storedFlow) return reply.code(400).send({ error: 'Invalid or expired OIDC state' });

  const tokens = await oidc.authorizationCodeGrant(oidcClient, callbackUrl, {
    pkceCodeVerifier: storedFlow.verifier,
    expectedState: state,
    expectedNonce: storedFlow.nonce
  });
  const claims = tokens.claims();
  if (!claims) return reply.code(401).send({ error: 'Identity provider did not return an ID token' });
  const identity = typeof claims.email === 'string'
    ? claims.email.toLowerCase()
    : typeof claims.preferred_username === 'string'
      ? claims.preferred_username
      : `authentik:${claims.sub}`;

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, email, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 hour'))`,
    [tokenHash, identity, sessionHours]
  );
  return reply
    .setCookie(sessionCookie, rawToken, {
      httpOnly: true,
      secure: env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      path: '/',
      maxAge: sessionHours * 60 * 60
    })
    .redirect('/');
});

app.post('/auth/logout', { preHandler: requireAdmin }, async (request, reply) => {
  const rawToken = request.cookies[sessionCookie];
  if (rawToken) {
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [
      createHash('sha256').update(rawToken).digest('hex')
    ]);
  }
  return reply.clearCookie(sessionCookie, { path: '/' }).code(204).send();
});

app.get('/api/admin/me', { preHandler: requireAdmin }, async (request) => ({
  email: adminEmail(request)
}));

app.get('/api/admin/competitions', { preHandler: requireAdmin }, async () => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.slug, c.status, c.timezone, c.match_duration_seconds,
            (SELECT count(*)::int FROM teams t WHERE t.competition_id = c.id AND t.active) AS team_count,
            (SELECT count(*)::int FROM matches m WHERE m.competition_id = c.id) AS match_count,
            (SELECT count(*)::int FROM challenges ch WHERE ch.competition_id = c.id) AS challenge_count,
            (SELECT count(*)::int FROM challenge_completions cc JOIN challenges ch ON ch.id = cc.challenge_id
             WHERE ch.competition_id = c.id) AS challenge_completion_count,
            (SELECT count(*)::int FROM competition_events ce WHERE ce.competition_id = c.id) AS event_count
     FROM competitions c ORDER BY c.created_at DESC`
  );
  return result.rows;
});

app.post('/api/admin/competitions', { preHandler: requireAdmin }, async (request, reply) => {
  const body = z.object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    timezone: z.string().trim().min(1).max(80).default('UTC'),
    matchDurationSeconds: z.number().int().min(1).max(7200).default(120)
  }).parse(request.body);
  const id = randomUUID();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO competitions (id, name, slug, timezone, match_duration_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, body.name, body.slug, body.timezone, body.matchDurationSeconds]
    );
    await audit(client, adminEmail(request), 'competition.created', 'competition', id, body);
  });
  return reply.code(201).send({ id, ...body });
});

app.delete('/api/admin/competitions/:slug', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({ confirmation: z.string() }).parse(request.body);
  if (body.confirmation !== slug) return reply.code(400).send({ error: 'Type the competition slug to confirm deletion' });
  const result = await transaction(async (client) => {
    const competition = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM competitions WHERE slug = $1 FOR UPDATE',
      [slug]
    );
    const row = competition.rows[0];
    if (!row) return undefined;
    await client.query(
      `DELETE FROM score_revisions
       WHERE match_id IN (SELECT id FROM matches WHERE competition_id = $1)
          OR team_id IN (SELECT id FROM teams WHERE competition_id = $1)`,
      [row.id]
    );
    await client.query(
      `DELETE FROM challenge_completions
       WHERE challenge_id IN (SELECT id FROM challenges WHERE competition_id = $1)`,
      [row.id]
    );
    await client.query(
      `DELETE FROM audit_events
       WHERE entity_type = 'playoff_match'
         AND entity_id IN (
           SELECT pm.id::text FROM playoff_matches pm
           JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1
         )`,
      [row.id]
    );
    await client.query(
      `DELETE FROM audit_events
       WHERE (entity_type = 'team' AND entity_id IN (SELECT id::text FROM teams WHERE competition_id = $1))
          OR (entity_type = 'match' AND entity_id IN (SELECT id::text FROM matches WHERE competition_id = $1))
          OR (entity_type = 'playoff_bracket' AND entity_id IN (SELECT id::text FROM playoff_brackets WHERE competition_id = $1))
          OR (entity_type = 'public_display' AND entity_id IN (SELECT id::text FROM public_displays WHERE competition_id = $1))
          OR (entity_type = 'challenge' AND entity_id IN (SELECT id::text FROM challenges WHERE competition_id = $1))`,
      [row.id]
    );
    await client.query('DELETE FROM matches WHERE competition_id = $1', [row.id]);
    await client.query(
      `DELETE FROM playoff_matches
       WHERE bracket_id IN (SELECT id FROM playoff_brackets WHERE competition_id = $1)`,
      [row.id]
    );
    await client.query('DELETE FROM teams WHERE competition_id = $1', [row.id]);
    await client.query('DELETE FROM competitions WHERE id = $1', [row.id]);
    await audit(client, adminEmail(request), 'competition.deleted', 'competition', row.id, {
      name: row.name,
      slug
    });
    return row;
  });
  if (!result) return reply.code(404).send({ error: 'Competition not found' });
  return reply.code(204).send();
});

app.get('/api/admin/competitions/:slug/settings', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  await pool.query(
    'INSERT INTO competition_settings (competition_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [competition.id]
  );
  const settings = await pool.query(
    `SELECT theme, logo_data_url, auto_run_enabled, corner_colours, updated_at
     FROM competition_settings WHERE competition_id = $1`,
    [competition.id]
  );
  return { competition, settings: settings.rows[0] };
});

app.put('/api/admin/competitions/:slug/settings', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    theme: z.enum(['paper', 'field', 'night']),
    timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, 'Use a valid IANA timezone'),
    logoDataUrl: z.string().max(1_400_000).nullable()
  }).parse(request.body);
  if (body.logoDataUrl) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.logoDataUrl);
    if (!match) return reply.code(400).send({ error: 'Logo must be PNG, JPEG or WebP image data' });
    const bytes = Buffer.from(match[2]!, 'base64');
    const validSignature = match[1] === 'png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'jpeg'
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (bytes.length > 1024 * 1024 || !validSignature) {
      return reply.code(400).send({ error: 'Logo file is invalid or exceeds 1 MB' });
    }
  }
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  await transaction(async (client) => {
    await client.query('UPDATE competitions SET timezone = $2 WHERE id = $1',
      [competition.id, body.timezone]);
    await client.query(
      `INSERT INTO competition_settings (competition_id, theme, logo_data_url, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (competition_id) DO UPDATE
       SET theme = EXCLUDED.theme, logo_data_url = EXCLUDED.logo_data_url, updated_at = now()`,
      [competition.id, body.theme, body.logoDataUrl]
    );
    await audit(client, adminEmail(request), 'settings.updated', 'competition', competition.id, {
      theme: body.theme,
      timezone: body.timezone,
      hasLogo: Boolean(body.logoDataUrl)
    });
  });
  return { ok: true };
});

app.put('/api/admin/competitions/:slug/arena-settings', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({ cornerColours: cornerColoursSchema }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    await client.query(
      `INSERT INTO competition_settings (competition_id, corner_colours, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (competition_id) DO UPDATE
       SET corner_colours = EXCLUDED.corner_colours, updated_at = now()`,
      [competition.id, JSON.stringify(body.cornerColours)]
    );
    await client.query(
      `UPDATE match_positions SET colour = CASE position_number
         WHEN 1 THEN $2 WHEN 2 THEN $3 WHEN 3 THEN $4 WHEN 4 THEN $5 END
       WHERE match_id IN (SELECT id FROM matches WHERE competition_id = $1)`,
      [competition.id, ...body.cornerColours]
    );
    await audit(client, adminEmail(request), 'arena.colours_updated', 'competition', competition.id, {
      cornerColours: body.cornerColours
    });
  });
  return { ok: true, cornerColours: body.cornerColours };
});

app.get('/api/admin/competitions/:slug/displays', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await pool.query(
    `SELECT id, slug, title, display_type, enabled, options, created_at, updated_at
     FROM public_displays WHERE competition_id = $1 ORDER BY created_at DESC`,
    [competition.id]
  );
  return result.rows;
});

app.post('/api/admin/competitions/:slug/displays', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug: competitionSlug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    title: z.string().trim().min(1).max(120),
    type: displayTypeSchema,
    options: displayOptionsSchema.default(displayOptionsSchema.parse({}))
  }).parse(request.body);
  const competition = await findCompetition(pool, competitionSlug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const id = randomUUID();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO public_displays (id, competition_id, slug, title, display_type, options)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [id, competition.id, body.slug, body.title, body.type, JSON.stringify(body.options)]
    );
    await audit(client, adminEmail(request), 'display.created', 'public_display', id, body);
  });
  return reply.code(201).send({
    id,
    ...body,
    enabled: true,
    htmlUrl: `/display/${body.slug}`,
    apiUrl: `/api/public/display/${body.slug}`
  });
});

app.patch('/api/admin/displays/:displayId', { preHandler: requireAdmin }, async (request, reply) => {
  const { displayId } = z.object({ displayId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    options: displayOptionsSchema.optional()
  }).refine((data) => Object.keys(data).length > 0).parse(request.body);
  const updated = await transaction(async (client) => {
    const result = await client.query<{ id: string; title: string; enabled: boolean; options: unknown }>(
      `UPDATE public_displays SET
         title = coalesce($2, title),
         enabled = coalesce($3, enabled),
         options = coalesce($4::jsonb, options),
         updated_at = now()
       WHERE id = $1
       RETURNING id, title, enabled, options`,
      [displayId, body.title ?? null, body.enabled ?? null,
        body.options === undefined ? null : JSON.stringify(body.options)]
    );
    if (!result.rows[0]) return undefined;
    await audit(client, adminEmail(request), 'display.updated', 'public_display', displayId, body);
    return result.rows[0];
  });
  if (!updated) return reply.code(404).send({ error: 'Public display not found' });
  return updated;
});

app.delete('/api/admin/displays/:displayId', { preHandler: requireAdmin }, async (request, reply) => {
  const { displayId } = z.object({ displayId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const deleted = await client.query(
      'DELETE FROM public_displays WHERE id = $1 RETURNING id',
      [displayId]
    );
    if (!deleted.rowCount) return false;
    await audit(client, adminEmail(request), 'display.deleted', 'public_display', displayId);
    return true;
  });
  if (!result) return reply.code(404).send({ error: 'Public display not found' });
  return reply.code(204).send();
});

async function persistPlayoffAdvancements(
  client: PoolClient,
  bracketId: string,
  seedTeams: ReadonlyMap<number, string>
): Promise<void> {
  const result = await client.query<{
    key: string; side: PlayoffMatchState['side']; round: number;
    source_one: string; source_two: string; source_three: string; source_four: string;
    team_one_id: string | null; team_two_id: string | null;
    team_three_id: string | null; team_four_id: string | null;
    placements: PlayoffMatchState['placements']; status: PlayoffMatchState['status'];
  }>(
    `SELECT id AS key, bracket_side AS side, round_number AS round,
            source_one, source_two, source_three, source_four,
            team_one_id, team_two_id, team_three_id, team_four_id, placements, status
     FROM playoff_matches WHERE bracket_id = $1 ORDER BY match_number`,
    [bracketId]
  );
  const current: PlayoffMatchState[] = result.rows.map((match) => ({
    key: match.key,
    side: match.side,
    round: match.round,
    sources: [match.source_one, match.source_two, match.source_three, match.source_four],
    teamIds: [match.team_one_id, match.team_two_id, match.team_three_id, match.team_four_id],
    placements: match.placements,
    status: match.status
  }));
  const resolved = resolvePlayoffAdvancements(current, seedTeams);
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = resolved[index]!;
    if (before.teamIds.every((teamId, teamIndex) => teamId === after.teamIds[teamIndex]) &&
        before.status === after.status) continue;
    await client.query(
      `UPDATE playoff_matches SET team_one_id = $2, team_two_id = $3,
         team_three_id = $4, team_four_id = $5, status = $6 WHERE id = $1`,
      [before.key, ...after.teamIds, after.status]
    );
  }
}

async function refreshUnstartedPlayoffSeeds(
  client: PoolClient,
  competitionId: string,
  actor: string
): Promise<void> {
  const brackets = await client.query<{ id: string; field_size: number }>(
    `SELECT id, field_size FROM playoff_brackets
     WHERE competition_id = $1 AND status = 'active' AND seed_frozen_at IS NULL
     ORDER BY created_at FOR UPDATE`,
    [competitionId]
  );
  if (!brackets.rowCount) return;
  const snapshot = await fetchPlayoffSeedSnapshot(client, competitionId);
  const standings = snapshot.standings;
  for (const bracket of brackets.rows) {
    if (standings.length < bracket.field_size) continue;
    const selectedTeams = standings.slice(0, bracket.field_size);
    const { seedRanks, seedTeams } = buildPlayoffSeedRanks(
      selectedTeams.map((team) => team.id), bracket.field_size
    );
    const current = await client.query<{ seed_ranks: Record<string, number> }>(
      'SELECT seed_ranks FROM playoff_brackets WHERE id = $1',
      [bracket.id]
    );
    const currentRanks = current.rows[0]?.seed_ranks;
    const normalizeRanks = (ranks: Record<string, number> | undefined) =>
      JSON.stringify(Object.entries(ranks ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    const ranksChanged = normalizeRanks(currentRanks) !== normalizeRanks(seedRanks);
    await client.query(
      `UPDATE playoff_brackets SET seed_ranks = $2::jsonb,
         seed_standings_snapshot = $3::jsonb, seed_match_number = $4, seed_snapshot_at = $5
       WHERE id = $1 AND seed_frozen_at IS NULL`,
      [
        bracket.id,
        JSON.stringify(seedRanks),
        JSON.stringify(standings),
        snapshot.latestScoredMatchNumber,
        snapshot.capturedAt
      ]
    );
    if (ranksChanged) {
      await persistPlayoffAdvancements(client, bracket.id, seedTeams);
      await audit(client, actor, 'playoffs.seeds_refreshed', 'playoff_bracket', bracket.id, {
        fieldSize: bracket.field_size,
        seeds: selectedTeams.map((team, index) => ({ seed: index + 1, teamCode: team.code }))
      });
    }
  }
}

app.get('/api/admin/competitions/:slug/playoffs', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  reply.header('cache-control', 'no-store');
  const bracket = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    await refreshUnstartedPlayoffSeeds(client, competition.id, adminEmail(request));
    return client.query(
      `SELECT id, field_size, seed_ranks, seed_standings_snapshot,
              seed_match_number, seed_snapshot_at, seed_frozen_at, status, created_at
       FROM playoff_brackets WHERE competition_id = $1 AND status <> 'replaced'
       ORDER BY created_at DESC LIMIT 1`,
      [competition.id]
    );
  });
  if (!bracket.rows[0]) return { bracket: null, matches: [] };
  const matches = await pool.query(
    `SELECT pm.id, pm.match_number, pm.bracket_side, pm.round_number, pm.status, pm.tied,
            pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id,
            pm.scheduled_start, pm.effective_start, pm.arena_name, pm.duration_seconds,
            pm.schedule_state, pm.timer_state, pm.countdown_started_at, pm.placements,
            one_team.code AS team_one_code, one_team.name AS team_one_name,
            two_team.code AS team_two_code, two_team.name AS team_two_name,
            three_team.code AS team_three_code, three_team.name AS team_three_name,
            four_team.code AS team_four_code, four_team.name AS team_four_name,
            (SELECT jsonb_agg(jsonb_build_object(
              'teamCode', t.code, 'teamName', t.name, 'points', pms.points,
              'seed', (pb.seed_ranks ->> t.id::text)::integer
            ) ORDER BY pms.points DESC, (pb.seed_ranks ->> t.id::text)::integer)
             FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
             WHERE pms.playoff_match_id = pm.id) AS scores
     FROM playoff_matches pm
     LEFT JOIN teams one_team ON one_team.id = pm.team_one_id
     LEFT JOIN teams two_team ON two_team.id = pm.team_two_id
     LEFT JOIN teams three_team ON three_team.id = pm.team_three_id
     LEFT JOIN teams four_team ON four_team.id = pm.team_four_id
     JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pm.bracket_id = $1 ORDER BY pm.match_number`,
    [bracket.rows[0].id]
  );
  const seedRanks = bracket.rows[0].seed_ranks as Record<string, number>;
  const participants = await pool.query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM teams WHERE id = ANY($1::uuid[])',
    [Object.entries(seedRanks)
      .filter(([, rank]) => Number(rank) <= Number(bracket.rows[0].field_size))
      .map(([teamId]) => teamId)]
  );
  const losses = new Map(participants.rows.map((team) => [team.id, 0]));
  const completed = await pool.query<{
    bracket_side: string; placements: string[] | null;
  }>(
    `SELECT bracket_side, placements FROM playoff_matches
     WHERE bracket_id = $1 AND status = 'complete' AND bracket_side <> 'final'`,
    [bracket.rows[0].id]
  );
  for (const match of completed.rows) {
    const placements = match.placements ?? [];
    if (placements.length < 2) continue;
    for (const teamId of placements.slice(playoffAdvancingPlaces(placements.length))) {
      losses.set(teamId, (losses.get(teamId) ?? 0) + 1);
    }
  }
  const teams = participants.rows.map((team) => ({
    ...team,
    seed: seedRanks[team.id],
    losses: losses.get(team.id) ?? 0,
    eliminated: (losses.get(team.id) ?? 0) >= 2
  })).sort((one, two) => Number(one.seed) - Number(two.seed));
  return { bracket: bracket.rows[0], teams, matches: matches.rows };
});

app.get('/api/admin/competitions/:slug/playoffs/seed-check', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  reply.header('cache-control', 'no-store');
  const result = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    await refreshUnstartedPlayoffSeeds(client, competition.id, adminEmail(request));
    return client.query<{
      field_size: number;
      seed_ranks: Record<string, number>;
      seed_standings_snapshot: PlayoffSeedStanding[] | null;
      seed_match_number: number | null;
      seed_snapshot_at: Date | null;
      seed_frozen_at: Date | null;
      status: string;
    }>(
      `SELECT field_size, seed_ranks, seed_standings_snapshot,
              seed_match_number, seed_snapshot_at, seed_frozen_at, status
       FROM playoff_brackets WHERE competition_id = $1 AND status <> 'replaced'
       ORDER BY created_at DESC LIMIT 1`,
      [competition.id]
    );
  });
  const bracket = result.rows[0];
  if (!bracket) {
    return reply.code(404).type('text/plain; charset=utf-8')
      .send('No active playoff bracket has a seeding snapshot yet.');
  }

  const snapshot = bracket.seed_standings_snapshot;
  const hasSnapshot = Array.isArray(snapshot) && bracket.seed_snapshot_at !== null &&
    bracket.seed_match_number !== null;
  const integrityOk = hasSnapshot && playoffSeedSnapshotMatchesRanks(
    snapshot, Number(bracket.field_size), bracket.seed_ranks
  );
  const seedRankByTeam = new Map(
    Object.entries(bracket.seed_ranks).map(([teamId, rank]) => [teamId, Number(rank)])
  );
  const legacyTeams = hasSnapshot ? [] : (await pool.query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM teams WHERE id = ANY($1::uuid[])',
    [Object.keys(bracket.seed_ranks)]
  )).rows;
  const legacyRows = legacyTeams
    .sort((left, right) => seedRankByTeam.get(left.id)! - seedRankByTeam.get(right.id)!)
    .map((team) => `<tr class="entrant"><td>Not recorded</td>
      <th scope="row">${escapeHtml(team.code)} · ${escapeHtml(team.name)}</th>
      <td>Not recorded</td><td>Not recorded</td><td>Not recorded</td><td>Not recorded</td>
      <td>Seed ${escapeHtml(seedRankByTeam.get(team.id))}</td></tr>`).join('');
  const standingsRows = (snapshot ?? []).map((team, index) => {
    const seed = seedRankByTeam.get(team.id);
    return `<tr${seed !== undefined ? ' class="entrant"' : ''}>
      <td>${index + 1}</td><th scope="row">${escapeHtml(team.code)} · ${escapeHtml(team.name)}</th>
      <td>${escapeHtml(team.matchPoints)}</td><td>${escapeHtml(team.challengePoints)}</td>
      <td><strong>${escapeHtml(team.leaguePoints)}</strong></td><td>${escapeHtml(team.scoredMatches)}</td>
      <td>${seed === undefined ? '—' : `Seed ${escapeHtml(seed)}`}</td></tr>`;
  }).join('') || legacyRows;
  const sourceDescription = !hasSnapshot
    ? 'This bracket predates stored standings snapshots. Its saved seed order is preserved, but the original points and match-number cutoff were not recorded; they cannot be verified retroactively.'
    : bracket.seed_match_number === 0
      ? 'No scored league matches were included. The snapshot includes the standings available at capture time, including challenge points.'
      : `The highest-numbered scored league match included was #${escapeHtml(bracket.seed_match_number)}. The timestamp and full standings below are the authoritative snapshot; corrections to earlier matches are reflected in that saved data.`;
  const integrityMessage = !hasSnapshot
    ? 'UNVERIFIABLE — historical source data is not available for this legacy bracket.'
    : integrityOk
      ? `PASS — the saved seed ranks match the top ${escapeHtml(bracket.field_size)} teams in this exact stored standings snapshot.`
      : 'FAIL — the saved seed ranks do not match this snapshot. Do not rely on this bracket until an administrator investigates.';
  reply.type('text/html; charset=utf-8');
  return reply.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playoff seeding sanity check · ${escapeHtml(competition.name)}</title>
<style>
body{margin:0;padding:1rem;font:16px/1.5 system-ui,sans-serif;color:#17242b;background:#f4f6f5}
main{max-width:1100px;margin:auto}.card{background:white;border:1px solid #ccd5d3;border-radius:.7rem;padding:1rem;margin:1rem 0}
h1{font-size:1.5rem}.status{padding:.8rem 1rem;border-radius:.4rem;background:${integrityOk ? '#e4f5ed' : '#ffe5e2'};font-weight:700}
.muted{color:#506168}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #dce3e1}
thead{background:#edf1ef}.entrant{background:#eff9f3}
@media(max-width:700px){.table-wrap{overflow-x:auto}table{min-width:760px}}
</style></head><body><main>
<p><a href="/">← Back to admin</a></p>
<h1>Playoff seeding sanity check</h1>
<div class="card"><p class="status">${integrityMessage}</p>
<p>${sourceDescription}</p>
<p><strong>Snapshot captured:</strong> ${bracket.seed_snapshot_at ? escapeHtml(new Date(bracket.seed_snapshot_at).toLocaleString()) : 'Not recorded'}</p>
<p><strong>Seeding:</strong> ${bracket.seed_frozen_at
    ? `Frozen at first playoff countdown (${escapeHtml(new Date(bracket.seed_frozen_at).toLocaleString())})`
    : 'Live-updating until the first playoff countdown'}
 · <strong>Bracket:</strong> ${escapeHtml(bracket.status)}</p>
<p class="muted">Match points and challenge points are shown separately. The bold league total determined standings order; ties are ordered by team code.</p></div>
<div class="card"><div class="table-wrap"><table><thead><tr><th>League rank</th><th>Team</th>
<th>Match points</th><th>Challenge points</th><th>Total points</th><th>Scored matches</th>
<th>Playoff seed</th></tr></thead><tbody>${standingsRows || '<tr><td colspan="7">No snapshot standings were recorded.</td></tr>'}</tbody></table></div></div>
<p class="muted">This report reads the persisted snapshot used by the bracket; it is not a recalculated live league table.</p>
</main></body></html>`);
});

app.post('/api/admin/competitions/:slug/playoffs', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    fieldSize: z.number().int().min(2),
    replaceExisting: z.boolean().default(false),
    scheduledStart: z.string().datetime({ offset: true }).optional(),
    intervalMinutes: z.number().int().min(1).max(1440).optional(),
    finalDelayMinutes: z.number().int().min(0).max(1440).default(0),
    arenaName: z.string().trim().min(1).max(80).default('Arena 1')
  }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM playoff_brackets WHERE competition_id = $1 AND status <> 'replaced'`,
      [competition.id]
    );
    if (existing.rowCount && !body.replaceExisting) {
      return { status: 409, error: 'A bracket already exists; confirm replacement before generating another' };
    }
    const seedSnapshot = await fetchPlayoffSeedSnapshot(client, competition.id);
    const standings = seedSnapshot.standings;
    if (standings.length < body.fieldSize) {
      return { status: 400, error: `At least ${body.fieldSize} teams with standings are required` };
    }
    const selectedTeams = standings.slice(0, body.fieldSize);
    const { seedRanks, seedTeams } = buildPlayoffSeedRanks(
      selectedTeams.map((team) => team.id), body.fieldSize
    );
    const scheduleEnd = await client.query<{ last_match_end: Date | null }>(
      `SELECT max(match_end) AS last_match_end FROM (
         SELECT effective_start + make_interval(secs => duration_seconds) AS match_end
         FROM matches WHERE competition_id = $1 AND state <> 'cancelled'
         UNION ALL
         SELECT pm.effective_start + make_interval(secs => pm.duration_seconds) AS match_end
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1 AND pb.status = 'active' AND NOT (pb.id = ANY($2::uuid[]))
       ) scheduled`,
      [competition.id, existing.rows.map((bracket) => bracket.id)]
    );
    const latestMatchEnd = scheduleEnd.rows[0]?.last_match_end;
    const earliestStart = new Date(Date.now() + 60_000);
    earliestStart.setSeconds(0, 0);
    const scheduleEndStart = latestMatchEnd
      ? new Date(Math.ceil(new Date(latestMatchEnd).getTime() / 60_000) * 60_000)
      : earliestStart;
    const firstStart = body.scheduledStart
      ? new Date(body.scheduledStart)
      : new Date(Math.max(earliestStart.getTime(), scheduleEndStart.getTime()));
    const intervalMinutes = body.intervalMinutes ??
      Math.max(1, Math.ceil(Number(competition.match_duration_seconds) / 60));
    if (body.scheduledStart && latestMatchEnd &&
        firstStart.getTime() < new Date(latestMatchEnd).getTime()) {
      return {
        status: 409,
        error: `Playoff heats must start after the current schedule ends at ${new Date(latestMatchEnd).toISOString()}`
      };
    }
    if (existing.rowCount) {
      await client.query(
        `UPDATE playoff_brackets SET status = 'replaced'
         WHERE competition_id = $1 AND status <> 'replaced'`,
        [competition.id]
      );
    }
    const bracketId = randomUUID();
    await client.query(
      `INSERT INTO playoff_brackets
         (id, competition_id, field_size, seed_ranks, seed_standings_snapshot,
          seed_match_number, seed_snapshot_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
      [
        bracketId, competition.id, body.fieldSize, JSON.stringify(seedRanks),
        JSON.stringify(standings), seedSnapshot.latestScoredMatchNumber, seedSnapshot.capturedAt
      ]
    );
    const plan = buildDoubleEliminationPlan(body.fieldSize);
    const ids = new Map(plan.map((match) => [match.key, randomUUID()]));
    const numberResult = await client.query<{ match_number: number }>(
      'SELECT coalesce(max(match_number), 0)::int AS match_number FROM matches WHERE competition_id = $1',
      [competition.id]
    );
    const firstMatchNumber = numberResult.rows[0]!.match_number + 1;
    const durationSeconds = Number(competition.match_duration_seconds);
    for (const match of plan) {
      const id = ids.get(match.key)!;
      const source = (value: string) => value.startsWith('seed:')
        ? value
        : value.replace(/:(playoff-\d+)$/, (_whole, key: string) => `:${ids.get(key)!}`);
      const initialTeam = (value: string) => value.startsWith('seed:')
        ? selectedTeams[Number(value.slice('seed:'.length)) - 1]?.id ?? null
        : null;
      const matchIndex = plan.indexOf(match);
      const hasFinalBuffer = match.side === 'final' && matchIndex > 0;
      const finalBufferMilliseconds = hasFinalBuffer ? body.finalDelayMinutes * 60_000 : 0;
      const scheduledStart = new Date(firstStart.getTime() +
        (matchIndex * intervalMinutes * 60_000) + finalBufferMilliseconds);
      const plannedGapSeconds = Math.max(0, intervalMinutes * 60 - durationSeconds) +
        (hasFinalBuffer ? body.finalDelayMinutes * 60 : 0);
      await client.query(
        `INSERT INTO playoff_matches
         (id, bracket_id, match_number, bracket_side, round_number,
          source_one, source_two, source_three, source_four,
          team_one_id, team_two_id, team_three_id, team_four_id,
          scheduled_start, effective_start, arena_name, duration_seconds, planned_gap_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15, $16, $17)`,
        [id, bracketId, firstMatchNumber + plan.indexOf(match), match.side, match.round,
          ...match.sources.map(source), ...match.sources.map(initialTeam),
          scheduledStart, body.arenaName, durationSeconds, plannedGapSeconds]
      );
    }
    await persistPlayoffAdvancements(client, bracketId, seedTeams);
    const shiftedMatchIds = await shiftScheduledMatchesAroundEvents(
      client, competition.id, adminEmail(request), 'four-robot playoff heats scheduled'
    );
    await audit(client, adminEmail(request), 'playoffs.generated', 'playoff_bracket', bracketId, {
      fieldSize: body.fieldSize,
      seededTeams: selectedTeams.map((team) => team.code),
      replacedPreviousBrackets: Boolean(existing.rowCount),
      scheduledStart: firstStart.toISOString(),
      intervalMinutes,
      finalDelayMinutes: body.finalDelayMinutes,
      arenaName: body.arenaName,
      shiftedMatchIds
    });
    return { status: 201, bracketId, matchCount: plan.length, teamCount: selectedTeams.length, shiftedMatchIds };
  });
  return reply.code(result.status).send(result);
});

app.patch('/api/admin/playoff-matches/:matchId/schedule', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    arenaName: z.string().trim().min(1).max(80),
    scheduledStart: z.string().datetime({ offset: true }),
    plannedGapMinutes: z.number().int().min(0).max(1440).optional()
  }).parse(request.body);
  let requestedStart = new Date(body.scheduledStart);
  if (requestedStart.getTime() <= Date.now()) {
    return reply.code(400).send({ error: 'A playoff heat must be scheduled in the future' });
  }
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      `SELECT competition_id FROM playoff_brackets pb
       JOIN playoff_matches pm ON pm.bracket_id = pb.id WHERE pm.id = $1`,
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404 as const, error: 'Playoff heat not found' };
    const competitionId = initial.rows[0].competition_id;
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
    const matchResult = await client.query<{
      bracket_id: string; match_number: number; duration_seconds: number;
      planned_gap_seconds: number; status: string; schedule_state: string; arena_name: string;
      timer_state: string; countdown_started_at: Date | null;
    }>(
      `SELECT pm.bracket_id, pm.match_number, pm.duration_seconds, pm.planned_gap_seconds, pm.status,
              pm.schedule_state, pm.arena_name, pm.timer_state, pm.countdown_started_at
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
      [matchId]
    );
    const match = matchResult.rows[0];
    if (!match) return { status: 409 as const, error: 'This playoff bracket is no longer active' };
    if (match.status === 'complete' || match.schedule_state === 'complete') {
      return { status: 409 as const, error: 'A completed playoff heat cannot be rescheduled' };
    }
    if (match.timer_state !== 'scheduled' || match.countdown_started_at) {
      return { status: 409 as const, error: 'A started playoff heat cannot be rescheduled' };
    }
    const scores = await client.query(
      'SELECT 1 FROM playoff_match_scores WHERE playoff_match_id = $1 LIMIT 1',
      [matchId]
    );
    if (scores.rowCount) {
      return { status: 409 as const, error: 'A playoff heat with saved scores cannot be rescheduled' };
    }
    const plannedGapSeconds = body.plannedGapMinutes === undefined
      ? match.planned_gap_seconds
      : body.plannedGapMinutes * 60;
    const previousHeat = await client.query<{ latest_end: Date | null }>(
      `SELECT max(effective_start + make_interval(secs => duration_seconds)) AS latest_end
       FROM playoff_matches WHERE bracket_id = $1 AND match_number < $2`,
      [match.bracket_id, match.match_number]
    );
    const previousEnd = previousHeat.rows[0]?.latest_end
      ? new Date(previousHeat.rows[0].latest_end).getTime()
      : null;
    if (previousEnd !== null) {
      const adjustment = calculatePlannedHeatCascade([{
        id: matchId,
        effectiveStart: requestedStart.getTime(),
        durationSeconds: match.duration_seconds,
        plannedGapSeconds
      }], previousEnd)[0];
      if (adjustment) requestedStart = new Date(adjustment.effectiveStart);
    }
    await client.query(
      `UPDATE playoff_matches SET scheduled_start = $2, effective_start = $2, arena_name = $3,
         planned_gap_seconds = $4
       WHERE id = $1`,
      [matchId, requestedStart, body.arenaName, plannedGapSeconds]
    );
    const laterHeats = await client.query<{
      id: string; effective_start: Date; duration_seconds: number; planned_gap_seconds: number;
    }>(
      `SELECT id, effective_start, duration_seconds, planned_gap_seconds
       FROM playoff_matches
       WHERE bracket_id = $1 AND schedule_state = 'scheduled' AND match_number > $2
       ORDER BY match_number FOR UPDATE`,
      [match.bracket_id, match.match_number]
    );
    const rescheduledIds = new Set<string>();
    const cascade = calculatePlannedHeatCascade(laterHeats.rows.map((heat) => ({
      id: heat.id,
      effectiveStart: new Date(heat.effective_start).getTime(),
      durationSeconds: heat.duration_seconds,
      plannedGapSeconds: heat.planned_gap_seconds
    })), requestedStart.getTime() + match.duration_seconds * 1000);
    const heatById = new Map(laterHeats.rows.map((heat) => [heat.id, heat]));
    for (const shift of cascade) {
      if (!heatById.has(shift.id)) throw new Error(`Rescheduled playoff heat ${shift.id} disappeared`);
      await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1',
        [shift.id, new Date(shift.effectiveStart)]);
      rescheduledIds.add(shift.id);
    }
    const shiftedMatchIds = await shiftScheduledMatchesAroundEvents(
      client, competitionId, adminEmail(request), `playoff heat #${match.match_number} rescheduled`
    );
    for (const shiftedId of shiftedMatchIds) rescheduledIds.add(shiftedId);
    const finalStartResult = await client.query<{ effective_start: Date }>(
      'SELECT effective_start FROM playoff_matches WHERE id = $1',
      [matchId]
    );
    const finalStart = new Date(finalStartResult.rows[0]!.effective_start);
    const dependent = await client.query(
      `SELECT 1 FROM playoff_matches
       WHERE bracket_id = $1 AND schedule_state = 'scheduled'
         AND (source_one = $2 OR source_two = $2 OR source_three = $2 OR source_four = $2)
         AND effective_start < (
           SELECT effective_start + make_interval(secs => duration_seconds)
           FROM playoff_matches WHERE id = $2
         ) + make_interval(secs => planned_gap_seconds)
       LIMIT 1`,
      [match.bracket_id, matchId]
    );
    if (dependent.rowCount) {
      throw new ScheduleCollisionError('Move dependent playoff heats later first; this heat must finish before its next scheduled heat begins');
    }
    await audit(client, adminEmail(request), 'playoff_match.schedule_updated', 'playoff_match', matchId, {
      matchNumber: match.match_number,
      arenaName: body.arenaName,
      scheduledStart: finalStart.toISOString(),
      plannedGapSeconds,
      shiftedMatchIds: [...rescheduledIds]
    });
    return {
      status: 200 as const, ok: true, scheduledStart: finalStart.toISOString(),
      shiftedMatchIds: [...rescheduledIds]
    };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/playoff-matches/:matchId/control/:action', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId, action } = z.object({
    matchId: z.string().uuid(),
    action: z.enum(['start', 'cancel-countdown', 'pause', 'resume', 'finish', 'reset-timer'])
  }).parse(request.params);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      `SELECT pb.competition_id FROM playoff_matches pm
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id WHERE pm.id = $1`,
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404 as const, error: 'Playoff heat not found' };
    const competitionId = initial.rows[0].competition_id;
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
    if (action === 'start') {
      await refreshUnstartedPlayoffSeeds(client, competitionId, adminEmail(request));
    }
    const heatResult = await client.query<{
      bracket_id: string; match_number: number; arena_name: string; status: string;
      schedule_state: string; timer_state: string; team_ids: (string | null)[];
      countdown_started_at: Date | null; paused_at: Date | null;
    }>(
      `SELECT pm.bracket_id, pm.match_number, pm.arena_name, pm.status, pm.schedule_state,
              pm.timer_state,
              ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids,
              pm.countdown_started_at, pm.paused_at
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pm.id = $1 AND pb.status = 'active' FOR UPDATE OF pm`,
      [matchId]
    );
    const heat = heatResult.rows[0];
    if (!heat) return { status: 409 as const, error: 'This playoff bracket is no longer active' };
    if (heat.schedule_state === 'complete' || heat.status === 'complete') {
      return { status: 409 as const, error: 'A completed playoff heat cannot be started' };
    }

    if (action === 'start') {
      if (heat.status !== 'ready' || heat.timer_state !== 'scheduled') {
        return { status: 409 as const, error: 'This heat is already started or waiting for prior results' };
      }
      const teamIds = heat.team_ids.filter((teamId): teamId is string => teamId !== null);
      if (teamIds.length < 2) {
        return { status: 409 as const, error: 'At least two assigned teams are required to start this heat' };
      }
      const activeConflict = await client.query(
        `SELECT 1 FROM matches m JOIN match_positions mp ON mp.match_id = m.id
         WHERE m.competition_id = $1 AND mp.team_id = ANY($2::uuid[])
           AND (m.state IN ('running', 'paused') OR
             (m.countdown_started_at > now() - ($5 * interval '1 second')
              AND m.state IN ('scheduled', 'ready', 'delayed')))
         UNION ALL
         SELECT 1 FROM playoff_matches other JOIN playoff_brackets ob ON ob.id = other.bracket_id
         WHERE ob.competition_id = $1 AND other.id <> $3
           AND (other.timer_state IN ('running', 'paused')
             OR other.countdown_started_at > now() - ($5 * interval '1 second'))
           AND ARRAY[other.team_one_id,other.team_two_id,other.team_three_id,other.team_four_id]
             && $2::uuid[]
         UNION ALL
         SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $4
           AND (state IN ('running', 'paused') OR
             (countdown_started_at > now() - ($5 * interval '1 second')
              AND state IN ('scheduled', 'ready', 'delayed')))
         UNION ALL
         SELECT 1 FROM playoff_matches other JOIN playoff_brackets ob ON ob.id = other.bracket_id
         WHERE ob.competition_id = $1 AND other.id <> $3 AND other.arena_name = $4
           AND (other.timer_state IN ('running', 'paused')
             OR other.countdown_started_at > now() - ($5 * interval '1 second'))
         LIMIT 1`,
        [competitionId, teamIds, matchId, heat.arena_name, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
      );
      if (activeConflict.rowCount) {
        return { status: 409 as const, error: 'A team or the arena is already active in another match' };
      }
      const now = new Date();
      await client.query(
        `UPDATE playoff_matches SET countdown_started_at = $2, effective_start = $2
         WHERE id = $1`,
        [matchId, now]
      );
      await client.query(
        'UPDATE playoff_brackets SET seed_frozen_at = coalesce(seed_frozen_at, $2) WHERE id = $1',
        [heat.bracket_id, now]
      );
      const laterHeats = await client.query<{
        id: string; effective_start: Date; duration_seconds: number; planned_gap_seconds: number;
      }>(
        `SELECT id, effective_start, duration_seconds, planned_gap_seconds FROM playoff_matches
         WHERE bracket_id = $1 AND schedule_state = 'scheduled' AND match_number > $2
         ORDER BY match_number FOR UPDATE`,
        [heat.bracket_id, heat.match_number]
      );
      const shifts = calculatePlannedHeatCascade(laterHeats.rows.map((item) => ({
        id: item.id, effectiveStart: new Date(item.effective_start).getTime(),
        durationSeconds: item.duration_seconds, plannedGapSeconds: item.planned_gap_seconds
      })), now.getTime() + MATCH_COUNTDOWN_TOTAL_SECONDS * 1000);
      for (const shift of shifts) {
        await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1',
          [shift.id, new Date(shift.effectiveStart)]);
      }
      await audit(client, adminEmail(request), 'playoff_match.countdown_started', 'playoff_match', matchId, {
        matchNumber: heat.match_number, countdownStartedAt: now.toISOString(), startedEarly: true
      });
      return { status: 200 as const, ok: true, shiftedMatchIds: shifts.map((shift) => shift.id) };
    }

    if (action === 'cancel-countdown') {
      if (!heat.countdown_started_at || heat.timer_state !== 'scheduled') {
        return { status: 409 as const, error: 'There is no active countdown to cancel' };
      }
      await client.query(
        `UPDATE playoff_matches SET countdown_started_at = NULL, effective_start = scheduled_start
         WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'playoff_match.countdown_cancelled', 'playoff_match', matchId);
    } else if (action === 'pause') {
      if (heat.timer_state !== 'running') return { status: 409 as const, error: 'Only a running heat can be paused' };
      await client.query(
        `UPDATE playoff_matches SET timer_state = 'paused', paused_at = now() WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'playoff_match.paused', 'playoff_match', matchId);
    } else if (action === 'resume') {
      if (heat.timer_state !== 'paused' || !heat.paused_at) return { status: 409 as const, error: 'This heat is not paused' };
      await client.query(
        `UPDATE playoff_matches SET timer_state = 'running',
           paused_seconds = paused_seconds + greatest(floor(extract(epoch FROM (now() - paused_at)))::int, 0),
           paused_at = NULL WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'playoff_match.resumed', 'playoff_match', matchId);
    } else if (action === 'finish') {
      if (!['running', 'paused'].includes(heat.timer_state)) {
        return { status: 409 as const, error: 'Only a running or paused heat can be finished' };
      }
      await client.query(
        `UPDATE playoff_matches SET timer_state = 'awaiting_score', actual_end = now(), paused_at = NULL
         WHERE id = $1`,
        [matchId]
      );
      await audit(client, adminEmail(request), 'playoff_match.finished', 'playoff_match', matchId);
    } else if (action === 'reset-timer') {
      if (!['running', 'paused', 'awaiting_score'].includes(heat.timer_state)) {
        return { status: 409 as const, error: `Cannot reset a ${heat.timer_state} playoff heat` };
      }
      const scores = await client.query(
        'SELECT 1 FROM playoff_match_scores WHERE playoff_match_id = $1 LIMIT 1',
        [matchId]
      );
      if (scores.rowCount) {
        return { status: 409 as const, error: 'A playoff heat with saved scores cannot be reset' };
      }
      const resetAt = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);
      await client.query(
        `UPDATE playoff_matches SET timer_state = 'scheduled', countdown_started_at = NULL,
           actual_start = NULL, actual_end = NULL, paused_at = NULL, paused_seconds = 0,
           effective_start = $2 WHERE id = $1`,
        [matchId, resetAt]
      );
      const laterHeats = await client.query<{
        id: string; effective_start: Date; duration_seconds: number; planned_gap_seconds: number;
      }>(
        `SELECT id, effective_start, duration_seconds, planned_gap_seconds FROM playoff_matches
         WHERE bracket_id = $1 AND schedule_state = 'scheduled' AND match_number > $2
         ORDER BY match_number FOR UPDATE`,
        [heat.bracket_id, heat.match_number]
      );
      const shifts = calculatePlannedHeatCascade(laterHeats.rows.map((item) => ({
        id: item.id, effectiveStart: new Date(item.effective_start).getTime(),
        durationSeconds: item.duration_seconds, plannedGapSeconds: item.planned_gap_seconds
      })), resetAt.getTime() + 120_000);
      for (const shift of shifts) {
        await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1',
          [shift.id, new Date(shift.effectiveStart)]);
      }
      const eventShiftIds = await shiftScheduledMatchesAroundEvents(
        client, competitionId, adminEmail(request), `playoff heat #${heat.match_number} timer reset`
      );
      const shiftedMatchIds = [...new Set([...shifts.map((shift) => shift.id), ...eventShiftIds])];
      await audit(client, adminEmail(request), 'playoff_match.timer_reset', 'playoff_match', matchId, {
        matchNumber: heat.match_number, resetAt: resetAt.toISOString(),
        shiftedMatchIds
      });
      return {
        status: 200 as const, ok: true, effectiveStart: resetAt.toISOString(),
        shiftedMatchIds
      };
    }
    return { status: 200 as const, ok: true };
  });
  return reply.code(result.status).send(result);
});

app.get('/api/admin/playoff-matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const match = await pool.query('SELECT id FROM playoff_matches WHERE id = $1', [matchId]);
  if (!match.rowCount) return reply.code(404).send({ error: 'Playoff match not found' });
  const scores = await pool.query(
    `SELECT t.code AS team_code, pms.points, pms.revision, pms.updated_by, pms.updated_at
     FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
     WHERE pms.playoff_match_id = $1 ORDER BY t.code`,
    [matchId]
  );
  return scores.rows;
});

app.post('/api/admin/playoff-matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    reason: z.string().trim().min(1).max(500).optional(),
    scores: z.array(z.object({
      teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
      points: z.number().finite()
    })).min(2).max(4)
  }).parse(request.body);
  const result = await transaction(async (client) => {
    const matchResult = await client.query<{
      id: string; bracket_id: string; competition_id: string; match_number: number;
      bracket_side: 'upper' | 'lower' | 'final';
      team_ids: (string | null)[]; status: string; seed_ranks: Record<string, number>;
      bracket_status: string; timer_state: string;
    }>(
      `SELECT pm.id, pm.bracket_id, pb.competition_id, pm.match_number, pm.bracket_side,
              ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id] AS team_ids,
              pm.status, pb.seed_ranks, pb.status AS bracket_status, pm.timer_state
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pm.id = $1 FOR UPDATE OF pm, pb`,
      [matchId]
    );
    const match = matchResult.rows[0];
    if (!match) return { status: 404, error: 'Playoff match not found' };
    if (match.bracket_status !== 'active' &&
        !(match.bracket_status === 'complete' && match.bracket_side === 'final' && match.status === 'complete')) {
      return { status: 409, error: 'This playoff bracket is no longer active' };
    }
    if (match.status !== 'complete' && match.timer_state !== 'awaiting_score') {
      return { status: 409, error: 'Finish this playoff heat from Live Control before entering scores' };
    }
    const assignedTeamIds = match.team_ids.filter((teamId): teamId is string => teamId !== null);
    if (assignedTeamIds.length < 2 || assignedTeamIds.length > 4 ||
        (match.status !== 'ready' && match.status !== 'complete')) {
      return { status: 409, error: 'At least two and no more than four playoff teams must be assigned before recording a result' };
    }
    const teamResult = await client.query<{ id: string; code: string }>(
      'SELECT id, code FROM teams WHERE id = ANY($1::uuid[])',
      [assignedTeamIds]
    );
    const teamByCode = new Map(teamResult.rows.map((team) => [team.code, team.id]));
    const codeByTeam = new Map(teamResult.rows.map((team) => [team.id, team.code]));
    if (body.scores.length !== assignedTeamIds.length ||
        new Set(body.scores.map((score) => score.teamCode)).size !== assignedTeamIds.length ||
        body.scores.some((score) => !teamByCode.has(score.teamCode))) {
      return { status: 400, error: `Enter one score for each of the ${assignedTeamIds.length} teams assigned to this playoff heat` };
    }
    const existingScores = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM playoff_match_scores WHERE playoff_match_id = $1',
      [matchId]
    );
    const correcting = Number(existingScores.rows[0]?.count ?? 0) > 0;
    if (correcting && !body.reason) {
      return { status: 400, error: 'A reason is required when correcting existing playoff scores' };
    }
    const descendants = new Set<string>();
    if (correcting) {
      const allMatches = await client.query<{
        id: string; source_one: string; source_two: string; source_three: string; source_four: string;
      }>(
        'SELECT id, source_one, source_two, source_three, source_four FROM playoff_matches WHERE bracket_id = $1',
        [match.bracket_id]
      );
      const frontier = [matchId];
      while (frontier.length) {
        const parentId = frontier.pop()!;
        for (const candidate of allMatches.rows) {
          if (descendants.has(candidate.id)) continue;
          if ([candidate.source_one, candidate.source_two, candidate.source_three, candidate.source_four]
            .some((source) => source.endsWith(`:${parentId}`))) {
            descendants.add(candidate.id);
            frontier.push(candidate.id);
          }
        }
      }
      if (descendants.size) {
        const progressed = await client.query(
          `SELECT 1 FROM playoff_match_scores WHERE playoff_match_id = ANY($1::uuid[]) LIMIT 1`,
          [[...descendants]]
        );
        if (progressed.rowCount) {
          return { status: 409, error: 'A later playoff match has already been scored; this result can no longer be corrected safely' };
        }
      }
    }
    const scoreByTeam = new Map(body.scores.map((score) => [teamByCode.get(score.teamCode)!, score]));
    const placement = rankPlayoffScores(
      assignedTeamIds.map((teamId) => ({ teamId, points: scoreByTeam.get(teamId)!.points })),
      match.seed_ranks
    );
    const winner = placement[0];
    const tied = new Set(body.scores.map((score) => score.points)).size < body.scores.length;
    for (const [teamId, score] of scoreByTeam) {
      const prior = await client.query<{ points: string }>(
        'SELECT points FROM playoff_match_scores WHERE playoff_match_id = $1 AND team_id = $2',
        [matchId, teamId]
      );
      if (prior.rows[0]) {
        await client.query(
          `INSERT INTO playoff_score_revisions
           (id, playoff_match_id, team_id, points, reason, actor_email)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), matchId, teamId, prior.rows[0].points, body.reason!, adminEmail(request)]
        );
      }
      await client.query(
        `INSERT INTO playoff_match_scores (playoff_match_id, team_id, points, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (playoff_match_id, team_id) DO UPDATE
         SET points = EXCLUDED.points, revision = playoff_match_scores.revision + 1,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [matchId, teamId, score.points, adminEmail(request)]
      );
    }
    if (correcting) {
      for (const descendantId of descendants) {
        await client.query(
          `UPDATE playoff_matches SET team_one_id = NULL, team_two_id = NULL,
             team_three_id = NULL, team_four_id = NULL, winner_team_id = NULL,
             tied = false, placements = NULL, status = 'pending'
           WHERE id = $1`,
          [descendantId]
        );
      }
    }
    await client.query(
      `UPDATE playoff_matches SET winner_team_id = $2, tied = $3, placements = $4::jsonb,
         status = 'complete', schedule_state = 'complete' WHERE id = $1`,
      [matchId, winner, tied, JSON.stringify(placement)]
    );
    if (match.bracket_side === 'final') {
      await client.query('UPDATE playoff_brackets SET status = $2 WHERE id = $1',
        [match.bracket_id, 'complete']);
    } else {
      await client.query('UPDATE playoff_brackets SET status = $2 WHERE id = $1',
        [match.bracket_id, 'active']);
    }
    const seedTeams = new Map(Object.entries(match.seed_ranks).map(([teamId, rank]) => [rank, teamId]));
    await persistPlayoffAdvancements(client, match.bracket_id, seedTeams);
    const rescheduledHeatIds: string[] = [];
    let eventShiftedIds: string[] = [];
    if (!correcting) {
      const timing = await client.query<{
        effective_start: Date;
        duration_seconds: number;
      }>(
        'SELECT effective_start, duration_seconds FROM playoff_matches WHERE id = $1',
        [matchId]
      );
      const projectedEnd = Math.max(
        Date.now(),
        new Date(timing.rows[0]!.effective_start).getTime() + timing.rows[0]!.duration_seconds * 1000
      );
      const laterHeats = await client.query<{
        id: string; match_number: number; effective_start: Date;
        duration_seconds: number; planned_gap_seconds: number;
      }>(
        `SELECT id, match_number, effective_start, duration_seconds, planned_gap_seconds
         FROM playoff_matches
         WHERE bracket_id = $1 AND schedule_state = 'scheduled' AND match_number > $2
         ORDER BY match_number FOR UPDATE`,
        [match.bracket_id, match.match_number]
      );
      const cascade = calculatePlannedHeatCascade(laterHeats.rows.map((heat) => ({
        id: heat.id,
        effectiveStart: new Date(heat.effective_start).getTime(),
        durationSeconds: heat.duration_seconds,
        plannedGapSeconds: heat.planned_gap_seconds
      })), projectedEnd);
      const heatById = new Map(laterHeats.rows.map((heat) => [heat.id, heat]));
      for (const shift of cascade) {
        const heat = heatById.get(shift.id);
        if (!heat) throw new Error(`Rescheduled playoff heat ${shift.id} disappeared`);
        const effectiveStart = new Date(shift.effectiveStart);
        await client.query('UPDATE playoff_matches SET effective_start = $2 WHERE id = $1',
          [shift.id, effectiveStart]);
        await audit(client, adminEmail(request), 'playoff.schedule_cascaded', 'playoff_match', shift.id, {
          causedByMatchId: matchId,
          trigger: 'previous heat result entered',
          effectiveStart: effectiveStart.toISOString(),
          delaySeconds: shift.delaySeconds
        });
        rescheduledHeatIds.push(shift.id);
      }
      eventShiftedIds = await shiftScheduledMatchesAroundEvents(
        client, match.competition_id, adminEmail(request), `playoff heat #${match.match_number} result entered`
      );
    }
    await audit(client, adminEmail(request), correcting ? 'playoff.score_corrected' : 'playoff.scored',
      'playoff_match', matchId, {
      winnerTeamId: winner,
      tied,
      placement: placement.map((teamId) => codeByTeam.get(teamId)),
      scores: body.scores.map((score) => ({ teamCode: score.teamCode, points: score.points })),
      rescheduledHeatIds,
      eventShiftedIds,
      reason: body.reason ?? null
    });
    return {
      status: 200,
      winnerTeamId: winner,
      tied,
      placements: placement.map((teamId) => codeByTeam.get(teamId)),
      rescheduledHeatIds,
      eventShiftedIds
    };
  });
  return reply.code(result.status).send(result);
});

async function loadPublicDisplay(slug: string) {
  const result = await pool.query<{
    display_slug: string; title: string; display_type: string; options: Record<string, unknown>;
    competition_id: string; competition_name: string; competition_slug: string; status: string;
    theme: string; logo_data_url: string | null; competition_timezone: string;
  }>(
    `SELECT d.slug AS display_slug, d.title, d.display_type, d.options,
            c.id AS competition_id, c.name AS competition_name, c.slug AS competition_slug,
            c.timezone AS competition_timezone,
            c.status, coalesce(s.theme, 'paper') AS theme, s.logo_data_url
     FROM public_displays d
     JOIN competitions c ON c.id = d.competition_id
     LEFT JOIN competition_settings s ON s.competition_id = c.id
     WHERE d.slug = $1 AND d.enabled = true`,
    [slug]
  );
  const display = result.rows[0];
  if (!display || !['published', 'live', 'complete'].includes(display.status)) return undefined;
  const options = displayOptionsSchema.parse(display.options ?? {});
  let data: unknown;
  let previousResults: unknown = null;
  if (display.display_type === 'league') {
    data = (await fetchStandings(pool, display.competition_id)).map(({ id: _id, ...team }) => team);
  } else if (display.display_type === 'sr-outside') {
    const [standings, schedule, results, knockout] = await Promise.all([
      fetchStandings(pool, display.competition_id),
      pool.query(
        `SELECT m.match_number, m.arena_name, m.effective_start, m.state,
                count(mp.team_id)::int AS team_count,
                jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name)
                  ORDER BY mp.position_number) FILTER (WHERE mp.position_number IS NOT NULL) AS teams
         FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
         LEFT JOIN teams t ON t.id = mp.team_id
         WHERE m.competition_id = $1 AND m.state NOT IN ('complete', 'cancelled')
         GROUP BY m.id ORDER BY m.effective_start, m.match_number LIMIT 12`,
        [display.competition_id]
      ),
      pool.query(
        `SELECT m.match_number, m.effective_start,
                jsonb_agg(jsonb_build_object('code', t.code, 'points', ms.league_points)
                  ORDER BY mp.position_number) AS scores
         FROM matches m JOIN match_scores ms ON ms.match_id = m.id
         JOIN teams t ON t.id = ms.team_id
         JOIN match_positions mp ON mp.match_id = m.id AND mp.team_id = t.id
         WHERE m.competition_id = $1 AND m.state = 'complete'
         GROUP BY m.id ORDER BY m.effective_start DESC, m.match_number DESC LIMIT 6`,
        [display.competition_id]
      ),
      pool.query(
        `SELECT pm.match_number, pm.round_number, pm.bracket_side, pm.status,
                winner.code AS winner,
                jsonb_agg(jsonb_build_object('code', t.code, 'points', pms.points)
                  ORDER BY pms.points DESC) FILTER (WHERE t.code IS NOT NULL) AS scores
         FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         LEFT JOIN teams winner ON winner.id = pm.winner_team_id
         LEFT JOIN playoff_match_scores pms ON pms.playoff_match_id = pm.id
         LEFT JOIN teams t ON t.id = pms.team_id
         WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
         GROUP BY pm.id, winner.code
         ORDER BY pm.round_number, pm.match_number`,
        [display.competition_id]
      )
    ]);
    data = {
      standings: standings.map(({ id: _id, ...team }) => team),
      schedule: schedule.rows,
      results: results.rows,
      knockout: knockout.rows
    };
  } else if (display.display_type === 'results') {
    const results = await pool.query(
      `SELECT * FROM (
         SELECT 'League'::text AS match_type, m.match_number, m.effective_start, m.arena_name,
                jsonb_agg(jsonb_build_object(
                  'code', t.code, 'name', t.name, 'points', ms.league_points,
                  'position', mp.position_number, 'colour', mp.colour
                ) ORDER BY mp.position_number) AS scores
         FROM matches m
         JOIN match_scores ms ON ms.match_id = m.id
         JOIN teams t ON t.id = ms.team_id
         JOIN match_positions mp ON mp.match_id = m.id AND mp.team_id = t.id
         WHERE m.competition_id = $1 AND m.state = 'complete'
         GROUP BY m.id
         UNION ALL
         SELECT 'Playoff'::text AS match_type, pm.match_number, pm.effective_start, pm.arena_name,
                jsonb_agg(jsonb_build_object(
                  'code', t.code, 'name', t.name, 'points', pms.points,
                  'position', slots.position, 'colour', coalesce(
                    cs.corner_colours ->> (slots.position::int - 1),
                    (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[slots.position::int]
                  )
                ) ORDER BY slots.position) AS scores
         FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         JOIN playoff_match_scores pms ON pms.playoff_match_id = pm.id
         JOIN teams t ON t.id = pms.team_id
         CROSS JOIN LATERAL unnest(ARRAY[
           pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id
         ]) WITH ORDINALITY AS slots(team_id, position)
         LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
         WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
           AND pm.schedule_state = 'complete' AND slots.team_id = t.id
         GROUP BY pm.id
       ) completed_matches
       ORDER BY effective_start, match_number, match_type`,
      [display.competition_id]
    );
    data = results.rows;
  } else if (['schedule', 'arena', 'timer', 'corner', 'sr-arena', 'sr-producer',
      'sr-shepherding', 'sr-staging'].includes(display.display_type)) {
    const match = await pool.query(
      `SELECT m.id, m.match_number, m.arena_name, m.effective_start, m.duration_seconds,
              m.state, m.actual_start, m.actual_end, m.countdown_started_at, m.paused_at, m.paused_seconds,
              jsonb_agg(jsonb_build_object(
                'position', mp.position_number, 'spot', mp.position_number - 1,
                'label', mp.position_label, 'colour', mp.colour,
                'teamCode', t.code, 'teamName', t.name
              ) ORDER BY mp.position_number) AS positions,
              count(mp.team_id)::int AS team_count
       FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1
         AND ($4::text = '' OR m.arena_name = $4)
         AND (
           m.state NOT IN ('complete', 'cancelled')
           AND (m.state <> 'awaiting_score'
                OR m.actual_end >= now() - interval '1 minute')
           OR ($2::boolean AND m.state = 'complete'
               AND m.actual_end >= now() - make_interval(secs => $3::int))
         )
       GROUP BY m.id
       ORDER BY CASE WHEN m.state = 'complete' AND $2::boolean
                          AND m.actual_end >= now() - make_interval(secs => $3::int) THEN 5
                     WHEN m.countdown_started_at >= now() - interval '8 seconds'
                          AND m.state IN ('scheduled', 'ready', 'delayed') THEN 0
                     WHEN m.state = 'running' THEN 1
                     WHEN m.state = 'paused' THEN 2
                     WHEN m.state = 'awaiting_score' THEN 4
                     WHEN m.state IN ('scheduled', 'ready', 'delayed') THEN 3
                     ELSE 6 END,
                CASE WHEN m.countdown_started_at >= now() - interval '8 seconds'
                               AND m.state IN ('scheduled', 'ready', 'delayed')
                          THEN m.countdown_started_at
                     WHEN m.state IN ('running', 'paused', 'awaiting_score') THEN m.actual_start
                     ELSE m.effective_start END,
                m.match_number
       LIMIT 1`,
      [display.competition_id, options.showEndCue, options.endCueDurationSeconds, options.srArenaName]
    );
    const playoffTimer = await pool.query(
      `SELECT pm.id, pm.match_number, pm.arena_name, pm.effective_start, pm.duration_seconds,
              CASE WHEN pm.timer_state = 'awaiting_score' THEN 'awaiting_score'
                   WHEN pm.timer_state IN ('running', 'paused') THEN pm.timer_state
                   ELSE pm.status END AS state,
              pm.actual_start, pm.actual_end, pm.countdown_started_at, pm.paused_at, pm.paused_seconds,
              jsonb_build_array(
                jsonb_build_object('position',1,'spot',0,'label','Position 0','colour',coalesce(cs.corner_colours ->> 0,'#d1495b'),'teamCode',t1.code,'teamName',t1.name),
                jsonb_build_object('position',2,'spot',1,'label','Position 1','colour',coalesce(cs.corner_colours ->> 1,'#00798c'),'teamCode',t2.code,'teamName',t2.name),
                jsonb_build_object('position',3,'spot',2,'label','Position 2','colour',coalesce(cs.corner_colours ->> 2,'#edae49'),'teamCode',t3.code,'teamName',t3.name),
                jsonb_build_object('position',4,'spot',3,'label','Position 3','colour',coalesce(cs.corner_colours ->> 3,'#30638e'),'teamCode',t4.code,'teamName',t4.name)
              ) AS positions,
              (pm.team_one_id IS NOT NULL)::int + (pm.team_two_id IS NOT NULL)::int +
                (pm.team_three_id IS NOT NULL)::int + (pm.team_four_id IS NOT NULL)::int AS team_count,
              true AS is_playoff
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       WHERE pb.competition_id = $1 AND pb.status = 'active'
         AND ($2::text = '' OR pm.arena_name = $2)
         AND pm.schedule_state = 'scheduled'
         AND (pm.status = 'ready' OR pm.timer_state IN ('running', 'paused', 'awaiting_score'))
         AND (pm.timer_state <> 'awaiting_score'
              OR pm.actual_end >= now() - interval '1 minute')
       ORDER BY CASE WHEN pm.countdown_started_at >= now() - interval '8 seconds'
                          AND pm.timer_state NOT IN ('running', 'paused', 'awaiting_score')
                         THEN 0
            WHEN pm.timer_state = 'running' THEN 1
            WHEN pm.timer_state = 'paused' THEN 2
            WHEN pm.status = 'ready' THEN 3
            WHEN pm.timer_state = 'awaiting_score' THEN 4 ELSE 5 END,
                CASE WHEN pm.countdown_started_at >= now() - interval '8 seconds'
                          AND pm.timer_state NOT IN ('running', 'paused', 'awaiting_score')
                          THEN pm.countdown_started_at
                     WHEN pm.timer_state IN ('running','paused','awaiting_score') THEN pm.actual_start
                     ELSE pm.effective_start END,
                pm.match_number LIMIT 1`,
      [display.competition_id, options.srArenaName]
    );
    const displayMatches = [...match.rows, ...playoffTimer.rows];
    displayMatches.sort((left, right) => {
      const priority = (candidate: (typeof displayMatches)[number]) =>
        publicMatchPriority(
          candidate.state,
          ['scheduled', 'ready', 'delayed'].includes(candidate.state) &&
            candidate.countdown_started_at !== null &&
            new Date(candidate.countdown_started_at).getTime() >= Date.now() - 8000
        );
      return priority(left) - priority(right) ||
        new Date(left.effective_start).getTime() - new Date(right.effective_start).getTime() ||
        left.match_number - right.match_number;
    });
    const selectedMatch = displayMatches[0] ?? null;
    if (['schedule', 'sr-staging', 'sr-shepherding'].includes(display.display_type)) {
      const schedule = await pool.query(
        `SELECT 'match' AS item_type, m.match_number, m.arena_name, m.effective_start, m.state,
                m.countdown_started_at,
                count(mp.team_id)::int AS team_count,
                count(mp.team_id)::int AS entrant_count,
                jsonb_agg(jsonb_build_object(
                  'code', t.code, 'name', t.name, 'colour', mp.colour, 'position', mp.position_number,
                  'spot', mp.position_number - 1
                )
                  ORDER BY mp.position_number) FILTER (WHERE mp.position_number IS NOT NULL) AS teams
         FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
         LEFT JOIN teams t ON t.id = mp.team_id
         WHERE m.competition_id = $1 AND m.state <> 'cancelled'
           AND ($4::text = '' OR m.arena_name = $4)
           AND (NOT $3::boolean OR m.state <> 'complete')
         GROUP BY m.id
         UNION ALL
         SELECT 'match' AS item_type, pm.match_number, pm.arena_name, pm.effective_start,
                CASE WHEN pm.schedule_state = 'complete' THEN 'complete' ELSE pm.status END AS state,
                NULL::timestamptz AS countdown_started_at,
                count(pt.id)::int AS team_count,
                ((pm.source_one <> 'bye')::int + (pm.source_two <> 'bye')::int +
                 (pm.source_three <> 'bye')::int + (pm.source_four <> 'bye')::int) AS entrant_count,
                jsonb_agg(jsonb_build_object(
                   'code', pt.code, 'name', pt.name,
                   'colour', coalesce(cs.corner_colours ->> ((slots.position::int) - 1),
                     (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[slots.position::int]),
                   'position', slots.position, 'spot', slots.position - 1
                 ) ORDER BY slots.position) AS teams
          FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
          LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
         CROSS JOIN LATERAL unnest(ARRAY[pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id])
           WITH ORDINALITY AS slots(team_id, position)
         LEFT JOIN teams pt ON pt.id = slots.team_id
         WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
           AND ($4::text = '' OR pm.arena_name = $4)
           AND (NOT $3::boolean OR pm.schedule_state <> 'complete')
         GROUP BY pm.id
         UNION ALL
         SELECT 'event' AS item_type, NULL::integer AS match_number, ce.location AS arena_name,
                ce.starts_at AS effective_start, ce.title AS state, NULL::timestamptz AS countdown_started_at,
                NULL::integer AS team_count, NULL::integer AS entrant_count,
                jsonb_build_array(jsonb_build_object(
                  'title', ce.title, 'description', ce.description,
                  'location', ce.location, 'durationMinutes', ce.duration_minutes
                )) AS teams
         FROM competition_events ce WHERE ce.competition_id = $1
           AND (NOT $2::boolean OR ce.starts_at + make_interval(mins => ce.duration_minutes) > now())
         ORDER BY effective_start, match_number NULLS LAST`,
        [display.competition_id, options.hideCompletedEvents, options.hideCompletedMatches, options.srArenaName]
      );
      data = schedule.rows;
    } else {
      data = selectedMatch;
    }
    if (['timer', 'sr-producer'].includes(display.display_type) && options.showPreviousResults) {
      const previousMatch = await pool.query(
        `SELECT * FROM (
           SELECT 'League'::text AS match_type, m.match_number, max(ms.updated_at) AS completed_at,
                  jsonb_agg(jsonb_build_object(
                    'code', t.code, 'name', t.name, 'points', ms.league_points,
                    'spot', mp.position_number - 1, 'colour', mp.colour
                  ) ORDER BY mp.position_number) AS scores
           FROM matches m
           JOIN match_scores ms ON ms.match_id = m.id
           JOIN teams t ON t.id = ms.team_id
           JOIN match_positions mp ON mp.match_id = m.id AND mp.team_id = t.id
           WHERE m.competition_id = $1 AND m.state = 'complete'
           GROUP BY m.id
           UNION ALL
           SELECT 'Playoff'::text AS match_type, pm.match_number, max(pms.updated_at) AS completed_at,
                  jsonb_agg(jsonb_build_object(
                    'code', t.code, 'name', t.name, 'points', pms.points,
                    'spot', slots.position::int - 1, 'colour', coalesce(
                      cs.corner_colours ->> (slots.position::int - 1),
                      (ARRAY['#d1495b', '#00798c', '#edae49', '#30638e'])[slots.position::int]
                    )
                  ) ORDER BY slots.position) AS scores
           FROM playoff_matches pm
           JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           JOIN playoff_match_scores pms ON pms.playoff_match_id = pm.id
           JOIN teams t ON t.id = pms.team_id
           CROSS JOIN LATERAL unnest(ARRAY[
             pm.team_one_id, pm.team_two_id, pm.team_three_id, pm.team_four_id
           ]) WITH ORDINALITY AS slots(team_id, position)
           LEFT JOIN competition_settings cs ON cs.competition_id = pb.competition_id
           WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
             AND pm.schedule_state = 'complete' AND slots.team_id = t.id
           GROUP BY pm.id
         ) completed_matches
         ORDER BY completed_at DESC, match_number DESC
         LIMIT 1`,
        [display.competition_id]
      );
      previousResults = previousMatch.rows[0] ?? null;
    }
  } else {
    const bracket = await pool.query(
      `SELECT pm.match_number, pm.bracket_side, pm.round_number, pm.status, pm.winner_team_id,
              pm.tied, pm.placements,
              jsonb_build_array(a.code,b.code,c.code,d.code) AS teams,
              w.code AS winner,
              (SELECT jsonb_agg(jsonb_build_object('team', t.code, 'points', pms.points)
                 ORDER BY pms.points DESC, (pb.seed_ranks ->> t.id::text)::integer)
               FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
               WHERE pms.playoff_match_id = pm.id) AS scores
       FROM playoff_brackets pb JOIN playoff_matches pm ON pm.bracket_id = pb.id
       LEFT JOIN teams a ON a.id = pm.team_one_id
       LEFT JOIN teams b ON b.id = pm.team_two_id
       LEFT JOIN teams c ON c.id = pm.team_three_id
       LEFT JOIN teams d ON d.id = pm.team_four_id
       LEFT JOIN teams w ON w.id = pm.winner_team_id
       WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
       ORDER BY pm.match_number`,
      [display.competition_id]
    );
    data = bracket.rows;
  }
  return {
    slug: display.display_slug,
    title: display.title,
    type: display.display_type,
    competition: display.competition_name,
    competitionSlug: display.competition_slug,
    competitionTimezone: display.competition_timezone,
    theme: display.theme,
    logoDataUrl: display.logo_data_url,
    options,
    data,
    previousResults,
    updatedAt: new Date().toISOString()
  };
}

type SrDbMatch = SrMatchInput & {
  scheduled_start: Date | string;
  delay_seconds: number;
  positions: SrMatchInput['positions'] | null;
};

type SrDbKnockoutMatch = SrDbMatch & {
  bracket_side: string;
  round_number: number;
};

type SrTeam = {
  id: string;
  code: string;
  name: string;
  match_points: string | number;
  league_points: string | number;
  scored_matches: number;
};

async function loadSrCompetitionData(competitionId: string) {
  const [cornerColours, standings, leagueResult, playoffResult] = await Promise.all([
    getCornerColours(pool, competitionId),
    fetchStandings(pool, competitionId),
    pool.query<SrDbMatch>(
      `SELECT m.match_number, m.arena_name, m.scheduled_start, m.effective_start,
              m.duration_seconds, m.planned_gap_seconds, m.actual_start, m.actual_end,
              m.countdown_started_at, m.paused_at, m.paused_seconds, m.state,
              greatest(0, ceil(extract(epoch FROM (m.effective_start - m.scheduled_start))))::int
                AS delay_seconds,
              coalesce(jsonb_agg(jsonb_build_object(
                'position_number', mp.position_number,
                'team_code', t.code,
                'colour', mp.colour
              ) ORDER BY mp.position_number)
                FILTER (WHERE mp.position_number IS NOT NULL), '[]'::jsonb) AS positions,
              coalesce((
                SELECT jsonb_object_agg(scored_team.code, score.league_points)
                FROM match_scores score
                JOIN teams scored_team ON scored_team.id = score.team_id
                WHERE score.match_id = m.id
              ), '{}'::jsonb) AS scores
       FROM matches m
       LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1
       GROUP BY m.id
       ORDER BY m.scheduled_start, m.match_number`,
      [competitionId]
    ),
    pool.query<SrDbKnockoutMatch>(
      `SELECT pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start,
              pm.duration_seconds, pm.planned_gap_seconds, pm.actual_start, pm.actual_end,
              pm.countdown_started_at, pm.paused_at, pm.paused_seconds,
              CASE WHEN pm.timer_state = 'awaiting_score' THEN 'awaiting_score'
                   WHEN pm.timer_state IN ('running', 'paused') THEN pm.timer_state
                   ELSE pm.status END AS state,
              0::int AS delay_seconds, pm.bracket_side, pm.round_number,
              jsonb_build_array(
                jsonb_build_object('position_number', 1, 'team_code', t1.code,
                  'colour', coalesce(settings.corner_colours ->> 0, '#d1495b')),
                jsonb_build_object('position_number', 2, 'team_code', t2.code,
                  'colour', coalesce(settings.corner_colours ->> 1, '#00798c')),
                jsonb_build_object('position_number', 3, 'team_code', t3.code,
                  'colour', coalesce(settings.corner_colours ->> 2, '#edae49')),
                jsonb_build_object('position_number', 4, 'team_code', t4.code,
                  'colour', coalesce(settings.corner_colours ->> 3, '#30638e'))
              ) AS positions,
              coalesce((
                SELECT jsonb_object_agg(scored_team.code, score.points)
                FROM playoff_match_scores score
                JOIN teams scored_team ON scored_team.id = score.team_id
                WHERE score.playoff_match_id = pm.id
              ), '{}'::jsonb) AS scores
       FROM playoff_matches pm
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       LEFT JOIN competition_settings settings ON settings.competition_id = pb.competition_id
       WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
       ORDER BY pm.round_number, pm.match_number`,
      [competitionId]
    )
  ]);

  const matches = leagueResult.rows.map((match) => ({
    ...match,
    positions: match.positions ?? []
  }));
  const playoffMatches = playoffResult.rows.map((match) => ({
    ...match,
    positions: match.positions ?? []
  }));
  const arenas = [...new Set([
    ...matches.map((match) => match.arena_name),
    ...playoffMatches.map((match) => match.arena_name)
  ])].sort((left, right) => left.localeCompare(right));
  const arenaMap = Object.fromEntries(arenas.map((name, index) => [
    name,
    {
      name,
      display_name: name,
      colour: cornerColours[index % cornerColours.length] ?? '#777777'
    }
  ]));
  const corners = Object.fromEntries(cornerColours.map((colour, index) => [
    String(index),
    { number: index, colour }
  ]));
  const teamMap = Object.fromEntries((standings as SrTeam[]).map((team, index) => [
    team.code,
    {
      tla: team.code,
      name: team.name,
      image_url: null,
      location: { name: 'competition' },
      league_pos: index + 1,
      scores: {
        league: Number(team.league_points),
        game: Number(team.match_points)
      }
    }
  ]));
  const allScheduledMatches = [...matches, ...playoffMatches];
  const allSrMatches = toSrMatches(allScheduledMatches);
  const srMatchByInput = new Map(allScheduledMatches.map((match, index) => [
    match,
    allSrMatches[index]!
  ]));
  const srMatches = matches.map((match) => srMatchByInput.get(match)!);
  const srPlayoffMatches = playoffMatches.map((match) => srMatchByInput.get(match)!);
  const knockoutRounds = groupSrKnockoutMatches(
    srPlayoffMatches.map((match, index) => ({
      ...match,
      round_number: playoffMatches[index]!.round_number
    }))
  );
  const bracketNames = ['upper', 'lower', 'final'];
  const bracketLabels: Record<string, string> = {
    upper: 'Upper Bracket',
    lower: 'Lower Bracket',
    final: 'Final'
  };
  const brackets = [...new Set(playoffMatches.map((match) => match.bracket_side))]
    .sort((left, right) => bracketNames.indexOf(left) - bracketNames.indexOf(right))
    .map((name) => ({ name, display_name: bracketLabels[name] ?? name }));

  return {
    cornerColours,
    arenas: arenaMap,
    corners,
    teams: teamMap,
    matches,
    srMatches,
    playoffMatches,
    srPlayoffMatches,
    knockoutRounds,
    brackets
  };
}

async function getPublishedSrCompetition(slug: string) {
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return undefined;
  }
  return competition;
}

app.get('/srcomp-api/:competitionSlug/arenas/:arena', async (request, reply) => {
  const { competitionSlug, arena } = z.object({
    competitionSlug: z.string(),
    arena: z.string()
  }).parse(request.params);
  const competition = await getPublishedSrCompetition(competitionSlug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const data = await loadSrCompetitionData(competition.id);
  return data.arenas[arena] ?? null;
});

app.get('/srcomp-api/:competitionSlug/corners/:corner', async (request, reply) => {
  const { competitionSlug, corner } = z.object({
    competitionSlug: z.string(),
    corner: z.string()
  }).parse(request.params);
  const competition = await getPublishedSrCompetition(competitionSlug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const data = await loadSrCompetitionData(competition.id);
  return data.corners[corner] ?? null;
});

app.get('/srcomp-api/:competitionSlug/knockout/structure', async (request, reply) => {
  const { competitionSlug } = z.object({ competitionSlug: z.string() }).parse(request.params);
  const competition = await getPublishedSrCompetition(competitionSlug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const data = await loadSrCompetitionData(competition.id);
  return { brackets: data.brackets };
});

app.get('/srcomp-api/:competitionSlug/:resource', async (request, reply) => {
  const { competitionSlug, resource } = z.object({
    competitionSlug: z.string(),
    resource: z.string()
  }).parse(request.params);
  const competition = await getPublishedSrCompetition(competitionSlug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const query = request.query as Record<string, unknown>;
  if (resource === 'time') {
    reply.header('cache-control', 'no-store');
    return { serverTime: Date.now() };
  }
  const data = await loadSrCompetitionData(competition.id);
  const queryText = (name: string) => typeof query[name] === 'string' ? query[name] as string : '';
  const arenaFilter = queryText('arena');
  const numberFilter = queryText('num');
  const typeFilter = queryText('type');
  const startFilter = queryText('slot_start_time').split('..')[0];
  const startAfter = startFilter ? new Date(startFilter).getTime() : Number.NaN;
  const matchEntries = selectSrMatchFeed(
    data.matches.map((match, index) => ({ match, srMatch: data.srMatches[index]! })),
    data.playoffMatches.map((match, index) => ({
      match,
      srMatch: data.srPlayoffMatches[index]!
    })),
    typeFilter
  ).sort((left, right) =>
    new Date(left.match.effective_start).getTime() - new Date(right.match.effective_start).getTime() ||
    left.match.match_number - right.match.match_number
  );

  if (resource === 'config') {
    return { config: { ping_period: 5 } };
  }
  if (resource === 'arenas') return { arenas: data.arenas };
  if (resource === 'corners') return { corners: data.corners };
  if (resource === 'current') {
    const now = Date.now();
    const current = selectSrDisplayMatches([...data.matches, ...data.playoffMatches], new Date(now));
    const currentMatches = toSrMatches(current);
    return {
      delay: current.find((match) => match.state === 'delayed')?.delay_seconds ?? 0,
      matches: currentMatches,
      shepherding_matches: toSrMatches([...data.matches, ...data.playoffMatches]
        .filter((match) => match.state !== 'cancelled')
      )
    };
  }
  if (resource === 'locations') {
    return { locations: { competition: { shepherds: { colour: '#ffffff' } } } };
  }
  if (resource === 'teams') return { teams: data.teams };
  if (resource === 'knockout') return { rounds: data.knockoutRounds };
  if (resource === 'tiebreaker') return { tiebreaker: null };
  if (resource === 'periods') {
    const events = await pool.query<{
      title: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT title, starts_at,
              starts_at + make_interval(mins => duration_minutes) AS ends_at
       FROM competition_events WHERE competition_id = $1 ORDER BY starts_at, title`,
      [competition.id]
    );
    return {
      periods: events.rows.map((event) => ({
        description: event.title,
        type: 'event',
        start_time: event.starts_at.toISOString(),
        end_time: event.ends_at.toISOString(),
        max_end_time: event.ends_at.toISOString()
      }))
    };
  }
  if (resource === 'matches') {
    const filtered = matchEntries
      .filter(({ match }) => !arenaFilter || match.arena_name === arenaFilter)
      .filter(({ match }) => !numberFilter || String(match.match_number) === numberFilter)
      .filter(({ match }) => !Number.isFinite(startAfter) ||
        new Date(match.effective_start).getTime() >= startAfter)
      .map(({ srMatch }) => srMatch);
    if (typeFilter !== 'knockout') {
      const lastScored = [...data.matches]
        .filter((match) => match.scores && Object.keys(match.scores).length > 0)
        .sort((left, right) =>
          new Date(right.effective_start).getTime() - new Date(left.effective_start).getTime() ||
          right.match_number - left.match_number
        )[0]?.match_number ?? null;
      return { matches: filtered, last_scored_match: lastScored };
    }
    return { matches: filtered };
  }
  return reply.code(404).send({ error: 'SRComp API resource not found' });
});

app.get('/srcomp-stream/:competitionSlug', async (request, reply) => {
  const { competitionSlug } = z.object({ competitionSlug: z.string() }).parse(request.params);
  const competition = await getPublishedSrCompetition(competitionSlug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });

  const initialData = await loadSrCompetitionData(competition.id);
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  let lastTeams = '';
  let lastStructure = '';
  let lastCurrentMatches = '';
  let lastStagingMatches = '';
  let lastShepherdingMatches = '';
  let lastKnockoutRounds = '';
  let lastDelay: number | undefined;
  let lastScoredMatch: number | null | undefined;
  const sendEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const sendSnapshot = async (snapshot?: Awaited<ReturnType<typeof loadSrCompetitionData>>) => {
    const currentSnapshot = snapshot ?? await loadSrCompetitionData(competition.id);
    const allMatches = [...currentSnapshot.matches, ...currentSnapshot.playoffMatches];
    const now = new Date();
    const current = toSrMatches(selectSrDisplayMatches(allMatches, now));
    const schedule = allMatches
      .filter((match) => match.state !== 'cancelled')
    const srSchedule = toSrMatches(schedule);
    const teamState = JSON.stringify(currentSnapshot.teams);
    const structure = JSON.stringify({ brackets: currentSnapshot.brackets });
    const lastScored = [...currentSnapshot.matches]
      .filter((match) => match.scores && Object.keys(match.scores).length > 0)
      .sort((left, right) =>
        new Date(right.effective_start).getTime() - new Date(left.effective_start).getTime() ||
        right.match_number - left.match_number
      )[0]?.match_number ?? null;
    sendEvent('ping', SR_SCREEN_PING_PERIOD_MS);
    const currentDelay = selectSrDisplayMatches(allMatches, now)
      .find((match) => match.state === 'delayed')?.delay_seconds ?? 0;
    if (currentDelay !== lastDelay) {
      sendEvent('current-delay', currentDelay);
      lastDelay = currentDelay;
    }
    const currentMatchesState = JSON.stringify(current);
    if (currentMatchesState !== lastCurrentMatches) {
      sendEvent('match', current);
      lastCurrentMatches = currentMatchesState;
    }
    const scheduleState = JSON.stringify(srSchedule);
    if (scheduleState !== lastStagingMatches) {
      sendEvent('current-staging-matches', srSchedule);
      lastStagingMatches = scheduleState;
    }
    if (scheduleState !== lastShepherdingMatches) {
      sendEvent('current-shepherding-matches', srSchedule);
      lastShepherdingMatches = scheduleState;
    }
    const knockoutRoundsState = JSON.stringify(currentSnapshot.knockoutRounds);
    if (knockoutRoundsState !== lastKnockoutRounds) {
      sendEvent('knockouts', currentSnapshot.knockoutRounds);
      lastKnockoutRounds = knockoutRoundsState;
    }
    if (lastScored !== lastScoredMatch) {
      sendEvent('last-scored-match', lastScored);
      lastScoredMatch = lastScored;
    }
    if (teamState !== lastTeams) {
      sendEvent('team', {});
      lastTeams = teamState;
    }
    if (structure !== lastStructure) {
      sendEvent('knockout-structure', { brackets: currentSnapshot.brackets });
      lastStructure = structure;
    }
  };

  let closed = false;
  let updating = false;
  const interval = setInterval(() => {
    if (updating || closed) return;
    updating = true;
    void sendSnapshot().catch((error: unknown) => {
      request.log.error({ err: error }, 'Failed to refresh SRComp display stream');
      clearInterval(interval);
      reply.raw.end();
    }).finally(() => {
      updating = false;
    });
  }, 3000);
  request.raw.on('close', () => {
    closed = true;
    clearInterval(interval);
  });
  await sendSnapshot(initialData);
});

app.get('/srcomp/:displaySlug/config.json', async (request, reply) => {
  const { displaySlug } = z.object({ displaySlug: z.string() }).parse(request.params);
  const display = await loadPublicDisplay(displaySlug);
  if (!display || !display.type.startsWith('sr-')) {
    return reply.code(404).send({ error: 'SRComp display not found' });
  }
  const apiRoot = `/srcomp-api/${encodeURIComponent(display.competitionSlug)}`;
  return {
    apiurl: apiRoot,
    streamurl: `/srcomp-stream/${encodeURIComponent(display.competitionSlug)}`,
    displayConfig: buildSrDisplayConfig(display.options),
    serverTime: Date.now()
  };
});

app.get('/srcomp/:displaySlug/*', async (request, reply) => {
  const { '*': requestedPath } = z.object({
    '*': z.string().min(1)
  }).parse(request.params);
  const root = fileURLToPath(new URL('../public/srcomp/', import.meta.url));
  const filename = resolve(root, requestedPath);
  const localPath = relative(root, filename);
  if (!localPath || localPath.startsWith(`..${sep}`) || localPath === '..' ||
      isAbsolute(localPath)) {
    return reply.code(404).send({ error: 'SRComp asset not found' });
  }
  try {
    const body = await readFile(filename);
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.eot': 'application/vnd.ms-fontobject'
    };
    return reply.type(contentTypes[extname(filename).toLowerCase()] ?? 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return reply.code(404).send({ error: 'SRComp asset not found' });
    }
    throw error;
  }
});

app.get('/api/public/display/:slug', async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const display = await loadPublicDisplay(slug);
  if (!display) return reply.code(404).send({ error: 'Public display not found' });
  reply.header('cache-control',
    ['timer', 'arena', 'corner', 'sr-arena', 'sr-producer'].includes(display.type)
      ? 'no-store' : 'public, max-age=2, stale-while-revalidate=3');
  return display;
});

app.get('/display/:slug', async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const display = await loadPublicDisplay(slug);
  if (!display) return reply.code(404).send('Public display not found');
  const options = displayOptionsSchema.parse(display.options ?? {});
  const srScreenFiles: Record<string, string> = {
    'sr-arena': 'arena.html',
    'sr-outside': 'outside.html',
    'sr-producer': 'producer.html',
    'sr-shepherding': 'shepherding.html',
    'sr-staging': 'staging.html'
  };
  const srScreenFile = srScreenFiles[display.type];
  if (srScreenFile) {
    const displayPath = `/srcomp/${encodeURIComponent(display.slug)}/${srScreenFile}`;
    const arena = options.srArenaName.trim();
    const query = display.type === 'sr-arena' && arena
      ? `?${encodeURIComponent(arena)},${options.cornerPosition}`
      : ['sr-producer', 'sr-shepherding', 'sr-staging'].includes(display.type) && arena
        ? `?${encodeURIComponent(arena)}`
        : '';
    return reply.code(302).redirect(`${displayPath}${query}`);
  }
  const darkTheme = display.type !== 'corner' &&
    (options.darkTheme || display.theme === 'night');
  const displayBackground = darkTheme ? '#111820' : display.theme === 'field' ? '#edf3ec' : '#fffefa';
  const theme = darkTheme
    ? 'background:#111820;color:#edf3f4;border-color:#45525c'
    : display.theme === 'field'
      ? 'background:#edf3ec;color:#18332b;border-color:#adc4b4'
      : 'background:#fffefa;color:#17242b;border-color:#c9ceca';
  const data = display.data as Array<Record<string, unknown>> | Record<string, unknown> | null;
  let content = '';
  if (display.type === 'league') {
    const rows = (Array.isArray(data) ? data : []).map((team, index) =>
      `<tr><td>${index + 1}</td><th>${escapeHtml(team.code)} — ${escapeHtml(team.name)}</th><td>${escapeHtml(team.league_points)}</td><td>${escapeHtml(team.scored_matches)}</td></tr>`
    ).join('');
    content = `<table><thead><tr><th>Rank</th><th>Team</th><th>Points</th><th>Matches</th></tr></thead><tbody>${rows}</tbody></table>`;
  } else if (display.type === 'sr-outside' && data && !Array.isArray(data)) {
    const outside = data as Record<string, unknown>;
    const hiddenPages = new Set(options.srHideOutsidePages);
    const standings = Array.isArray(outside.standings)
      ? outside.standings as Array<Record<string, unknown>> : [];
    const schedule = Array.isArray(outside.schedule)
      ? outside.schedule as Array<Record<string, unknown>> : [];
    const results = Array.isArray(outside.results)
      ? outside.results as Array<Record<string, unknown>> : [];
    const knockout = Array.isArray(outside.knockout)
      ? outside.knockout as Array<Record<string, unknown>> : [];
    const pages: string[] = [];
    if (!hiddenPages.has('leaderboard')) {
      const rows = standings.slice(0, options.srMaxTeams).map((team, index) =>
        `<tr><td>${index + 1}</td><th>${escapeHtml(team.code)} — ${escapeHtml(team.name)}</th><td>${escapeHtml(team.league_points)}</td></tr>`
      ).join('');
      pages.push(`<section class="sr-outside-page" data-sr-outside-page="leaderboard"><h2>Leaderboard</h2><table><thead><tr><th>Rank</th><th>Team</th><th>League Points</th></tr></thead><tbody>${rows}</tbody></table></section>`);
    }
    if (!hiddenPages.has('schedule')) {
      const rows = schedule.map((match) => {
        const teams = Array.isArray(match.teams) ? match.teams as Array<Record<string, unknown>> : [];
        const codes = teams.map((team) => escapeHtml(team.code)).join(' · ');
        const fill = Number(match.team_count) < 4
          ? `<strong class="warning">${escapeHtml(match.team_count)}/4 TEAM HEAT</strong>` : '';
        return `<tr><th>Match ${escapeHtml(match.match_number)}</th><td>${escapeHtml(formatCompetitionDateTime(String(match.effective_start), display.competitionTimezone))}</td><td>${escapeHtml(match.arena_name)}</td><td>${codes}</td><td>${fill || escapeHtml(match.state)}</td></tr>`;
      }).join('');
      pages.push(`<section class="sr-outside-page" data-sr-outside-page="schedule"><h2>Schedule</h2><table><thead><tr><th>Match</th><th>Time</th><th>Arena</th><th>Teams</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></section>`);
    }
    if (!hiddenPages.has('results')) {
      const rows = results.map((match) => {
        const scores = Array.isArray(match.scores) ? match.scores as Array<Record<string, unknown>> : [];
        return `<tr><th>Match ${escapeHtml(match.match_number)}</th><td>${scores.map((score) => `${escapeHtml(score.code)}: ${escapeHtml(score.points)}`).join(' · ')}</td></tr>`;
      }).join('');
      pages.push(`<section class="sr-outside-page" data-sr-outside-page="results"><h2>Latest scores</h2><table><thead><tr><th>Match</th><th>Points by team</th></tr></thead><tbody>${rows}</tbody></table></section>`);
    }
    if (!hiddenPages.has('knockout')) {
      const limitedKnockout = knockout.filter((match) =>
        Number(match.round_number) <= options.srMaxKnockoutRounds);
      const rows = limitedKnockout.map((match) => {
        const scores = Array.isArray(match.scores) ? match.scores as Array<Record<string, unknown>> : [];
        return `<tr><th>${escapeHtml(match.bracket_side)} · Round ${escapeHtml(match.round_number)}</th><td>Match ${escapeHtml(match.match_number)}</td><td>${scores.map((score) => `${escapeHtml(score.code)}: ${escapeHtml(score.points)}`).join(' · ') || escapeHtml(match.status)}</td><td>${escapeHtml(match.winner || '—')}</td></tr>`;
      }).join('');
      pages.push(`<section class="sr-outside-page" data-sr-outside-page="knockout"><h2>Knockout</h2><table><thead><tr><th>Bracket</th><th>Match</th><th>Points</th><th>Winner</th></tr></thead><tbody>${rows}</tbody></table></section>`);
    }
    const externalLink = options.srExternalUrl
      ? `<a class="sr-external-link" href="${escapeHtml(options.srExternalUrl)}" target="_blank" rel="noopener noreferrer">Competition website</a>`
      : '';
    content = `<div class="sr-outside">${pages.join('') || '<p class="empty">No Outside Screen pages are enabled.</p>'}${externalLink}</div>`;
  } else if (display.type === 'results') {
    const rows = (Array.isArray(data) ? data : []).map((match) => {
      const scores = Array.isArray(match.scores) ? match.scores as Array<Record<string, unknown>> : [];
      const positions = Array.from({ length: 4 }, (_, index) =>
        scores.find((score) => Number(score.position) === index + 1)
      );
      const cells = positions.map((score) => score
        ? `<td><strong style="color:${safeDisplayColour(String(score.colour))}">${escapeHtml(score.code)}</strong><br>${escapeHtml(score.points)} pts</td>`
        : '<td>—</td>').join('');
      return `<tr><th scope="row">${escapeHtml(match.match_type)} ${escapeHtml(match.match_number)}</th><td>${escapeHtml(formatCompetitionDateTime(String(match.effective_start), display.competitionTimezone))}</td><td>${escapeHtml(match.arena_name)}</td>${cells}</tr>`;
    }).join('');
    content = `<table><thead><tr><th>Match</th><th>Time</th><th>Arena</th>${[0,1,2,3].map((position) => `<th>Position ${position}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  } else if (['schedule', 'sr-staging', 'sr-shepherding'].includes(display.type)) {
    const showArena = options.showArena && !options.hideScheduleArena;
    const timeContent = (value: unknown) => {
      const date = new Date(String(value));
      const formattedTime = formatCompetitionTime(date, display.competitionTimezone);
      return options.relativeTime
        ? `<time data-relative-time="${escapeHtml(date.getTime())}" aria-label="${escapeHtml(formatCompetitionDateTime(date, display.competitionTimezone))}"></time>`
        : escapeHtml(formattedTime);
    };
    const rows = (Array.isArray(data) ? data : []).map((match) => {
      const teams = Array.isArray(match.teams) ? match.teams as Array<Record<string, unknown>> : [];
      if (match.item_type === 'event') {
        const event = teams[0] ?? {};
        return `<tr data-schedule-event="true"><td colspan="${showArena ? 8 : 7}"><strong>${timeContent(match.effective_start)} · ${escapeHtml(event.title)}</strong>${showArena ? ` · ${escapeHtml(event.location || '—')}` : ''} · ${escapeHtml(event.durationMinutes)} minutes${event.description ? ` · ${escapeHtml(event.description)}` : ''}</td></tr>`;
      }
      const teamCodes = teams.map((team) => String(team.code ?? '')).filter(Boolean);
      const stagingOrder = display.type === 'sr-staging' ? options.srStagingCornerOrder : [0, 1, 2, 3];
      const positions = stagingOrder.map((spot) =>
        teams.find((team) => Number(team.position) === spot + 1)
      );
      const positionCells = positions.map((team, index) => {
        if (!team) return '<td><span class="schedule-position-team">VACANT</span></td>';
        const code = escapeHtml(team.code);
        const colour = safeDisplayColour(team.colour);
        return `<td><strong class="schedule-position-team" style="color:${colour}">${code}</strong></td>`;
      }).join('');
      const expectedTeams = Number(match.entrant_count ?? match.team_count);
      const fillStatus = expectedTeams < 4
        ? `<strong class="warning">${escapeHtml(expectedTeams)}/4 TEAM HEAT</strong>`
        : escapeHtml(match.state);
      return `<tr data-team-codes="${escapeHtml(teamCodes.join(','))}"><td><strong>${escapeHtml(match.match_number)}</strong></td>${showArena ? `<td>${escapeHtml(match.arena_name)}</td>` : ''}<td>${timeContent(match.effective_start)}</td>${positionCells}<td>${fillStatus}</td></tr>`;
    }).join('');
    const positionOrder = display.type === 'sr-staging' ? options.srStagingCornerOrder : [0, 1, 2, 3];
    content = `<table><thead><tr><th>Match</th>${showArena ? '<th>Arena</th>' : ''}<th>${options.relativeTime ? 'Starts in / elapsed' : 'Time'}</th>${positionOrder.map((position) => `<th>Position ${position}</th>`).join('')}<th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
    if (options.enableTeamFilter) {
      const teams = new Map<string, string>();
      for (const match of Array.isArray(data) ? data : []) {
        if (!Array.isArray(match.teams)) continue;
        for (const team of match.teams as Array<Record<string, unknown>>) {
          if (team.code) teams.set(String(team.code), String(team.name ?? team.code));
        }
      }
      const teamOptions = [...teams].sort(([left], [right]) => left.localeCompare(right))
        .map(([code, name]) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`).join('');
      content = `<label class="team-filter">Filter by team<select id="schedule-team-filter"><option value="">All teams</option>${teamOptions}</select></label>${content}`;
    }
  } else if (['arena', 'sr-arena'].includes(display.type)) {
    const match = data && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const positions = Array.isArray(match.positions) ? match.positions as Array<Record<string, unknown>> : [];
    content = `<h2>${match.match_number ? `Match ${escapeHtml(match.match_number)}${options.showArena ? ` · ${escapeHtml(match.arena_name)}` : ''}` : 'No scheduled matches'}</h2><p id="timer-state" class="timer-label">WAITING FOR NEXT MATCH</p><div class="timer" id="timer-display">--:--.-</div><p id="timer-label" class="muted timer-label">STARTS IN</p><div id="timer-arena" class="arena-square">${positions.map((position) => {
      const spot = Number(position.position) - 1;
      const colour = safeDisplayColour(position.colour);
      const background = options.fillCorners ? colour : `color-mix(in srgb, ${colour} 18%, ${darkTheme ? '#111820' : 'white'})`;
      const textColour = options.fillCorners ? readableTextColour(colour) : 'inherit';
      return `<div class="arena-cell" data-spot="${spot}" style="border-color:${colour};background-color:${background};color:${textColour}">
        ${options.showPositionNumbers ? `<span class="arena-spot">${spot}</span>` : ''}${position.teamCode
          ? `<span class="arena-code">${escapeHtml(position.teamCode)}</span>${options.showTeamNames ? `<span class="arena-team">${escapeHtml(position.teamName)}</span>` : ''}`
          : '<span class="arena-code">VACANT</span>'}
      </div>`;
    }).join('')}</div>${Number(match.team_count) < 4 && match.match_number ? `<p id="timer-warning" class="warning" style="text-align:center">UNDERFILLED MATCH · ${escapeHtml(match.team_count)}/4 positions</p>` : '<p id="timer-warning" class="warning" style="text-align:center"></p>'}`;
  } else if (display.type === 'corner') {
    const match = data && !Array.isArray(data) ? data as Record<string, unknown> : null;
    const positions = match && Array.isArray(match.positions) ? match.positions as Array<Record<string, unknown>> : [];
    const position = positions.find((item) => Number(item.spot) === options.cornerPosition);
    const colour = safeDisplayColour(String(position?.colour ?? '#777777'));
    const teamCode = position?.teamCode ? escapeHtml(position.teamCode) : 'VACANT';
    const teamName = position?.teamName ? escapeHtml(position.teamName) : '';
    const cornerBackground = options.fillCornerDisplay ? colour : displayBackground;
    const cornerTextColour = options.fillCornerDisplay ? readableTextColour(colour) : darkTheme ? '#edf3f4' : '#17242b';
    content = `<section id="corner-display" style="background-color:${cornerBackground};color:${cornerTextColour}">
      ${options.showCornerPositionNumber ? `<span class="corner-position-number" id="corner-position-number">${options.cornerPosition}</span>` : ''}
      <div class="corner-team-code" id="corner-team-code">${teamCode}</div>
      ${options.showCornerTeamName ? `<div class="corner-team-name" id="corner-team-name">${teamName}</div>` : ''}
      <div class="timer corner-timer" id="timer-display">--:--.-</div>
      <p id="timer-label" class="corner-state">STARTS IN</p>
    </section>`;
  } else if (['timer', 'sr-producer'].includes(display.type)) {
    content = `<h2 id="timer-match">Connecting to live match...</h2><p id="timer-state" class="muted" style="text-align:center">Waiting for live data</p>
      <div class="timer" id="timer-display">--:--.-</div><p id="timer-label" class="muted" style="text-align:center">SYNCING CLOCK</p>
      <div id="timer-arena" class="arena-square" aria-label="Current match arena positions"></div>
      <p id="timer-warning" class="warning" style="text-align:center"></p><p id="timer-connection" class="muted" role="status" style="text-align:center">Connecting...</p>
      ${options.showPreviousResults ? '<section id="timer-previous-results" class="previous-results" aria-live="polite" hidden></section>' : ''}`;
  } else {
    const rows = (Array.isArray(data) ? data : []).map((match) =>
      `<tr><td>${escapeHtml(match.match_number)}</td><td>${escapeHtml(match.bracket_side)} · round ${escapeHtml(match.round_number)}</td><td>${escapeHtml(Array.isArray(match.teams) ? match.teams.filter(Boolean).join(' · ') : 'TBD')}</td><td>${escapeHtml(Array.isArray(match.scores) ? match.scores.map((score) => `${score.team} ${score.points}`).join(' · ') : match.status)}</td></tr>`
    ).join('');
    content = `<table><thead><tr><th>Heat</th><th>Bracket</th><th>Four teams</th><th>Points / placing</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors *");
  const liveTimerDisplay = ['timer', 'arena', 'corner', 'sr-arena', 'sr-producer'].includes(display.type);
  const rotatingOutsideDisplay = display.type === 'sr-outside';
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${liveTimerDisplay || rotatingOutsideDisplay ? '' : '<meta http-equiv="refresh" content="4">'}
    <title>${escapeHtml(display.title)}</title><style>
      *{box-sizing:border-box}body{font:16px/1.45 system-ui,sans-serif;margin:0;padding:clamp(1rem,4vw,3rem);${theme}}
      main{max-width:1100px;margin:auto}header{display:flex;align-items:center;gap:1rem;border-bottom:1px solid currentColor;padding-bottom:1rem}
      header img{max-height:64px;max-width:180px;object-fit:contain}h1{font-size:clamp(1.5rem,4vw,2.5rem);margin:.2rem 0}
      .muted{opacity:.68}table{width:100%;border-collapse:collapse;margin-top:1.5rem}td,th{text-align:left;padding:.8rem;border-bottom:1px solid ${darkTheme ? '#45525c' : '#c9ceca'}}
      th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
      .arena-square{width:min(100%,640px);aspect-ratio:1;margin:1.5rem auto;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3px;background:currentColor;border:3px solid currentColor}
      .arena-cell{min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:clamp(.4rem,2vw,1.2rem);border:6px solid}
      .arena-cell[data-spot="1"],.arena-cell[data-spot="2"]{grid-row:1}.arena-cell[data-spot="0"],.arena-cell[data-spot="3"]{grid-row:2}
      .arena-cell[data-spot="1"],.arena-cell[data-spot="0"]{grid-column:1}.arena-cell[data-spot="2"],.arena-cell[data-spot="3"]{grid-column:2}
      .arena-cell{position:relative;isolation:isolate}.arena-spot{position:absolute;top:.45rem;left:.55rem;transform:none;font:900 clamp(2rem,7vw,5rem)/1 ui-monospace,monospace;opacity:.4;z-index:0}.arena-code{position:relative;z-index:1;font:800 clamp(1.5rem,5vw,3.5rem)/1 ui-monospace,monospace;margin:.35rem 0}
      .arena-team{position:relative;z-index:1;font-weight:650}.warning{font-weight:800;color:#b33}.timer{font:800 clamp(3rem,14vw,10rem)/1 ui-monospace,monospace;text-align:center;padding:1.4rem 0 .4rem;font-variant-numeric:tabular-nums}.timer-label{text-align:center;font-weight:800;letter-spacing:.08em}
      body.timer-board{height:100vh;height:100dvh;overflow:hidden;padding:clamp(.35rem,1.2vmin,1rem)}
      body.timer-board main{width:100%;max-width:none;height:100%;margin:0;display:grid;grid-template-rows:auto auto auto auto auto minmax(0,1fr) auto auto auto;gap:clamp(.1rem,.45vh,.4rem);min-height:0}
      body.timer-board main>*{min-width:0}
      body.timer-board-no-title main{grid-template-rows:auto auto auto auto minmax(0,1fr) auto auto auto}
      body.timer-board header{padding-bottom:.35rem;min-width:0}
      body.timer-board header img{max-height:clamp(28px,6vh,56px)}
      body.timer-board h1{font-size:clamp(1rem,2.5vh,1.8rem)}
      body.timer-board #timer-match{font-size:clamp(1rem,2.5vh,1.8rem);text-align:center;margin:.1rem 0}
      body.timer-board #timer-state,body.timer-board #timer-label{margin:.1rem 0;font-size:clamp(.7rem,1.6vh,1rem)}
      body.timer-board #timer-display{font-size:clamp(2rem,min(16vh,14vw),12rem);padding:0;line-height:.95}
      body.timer-board #timer-arena{width:min(100%,70dvh);height:auto;max-width:100%;max-height:100%;aspect-ratio:1;margin:0 auto;min-height:0}
      body.timer-board .arena-cell{padding:clamp(.15rem,1vh,.8rem);border-width:clamp(2px,.6vh,6px)}
      body.timer-board .arena-spot{top:50%;left:50%;transform:translate(-50%,-50%);font-size:clamp(4rem,min(24vw,24vh),14rem);opacity:.24}
      body.timer-board .arena-code{font-size:clamp(1.25rem,5vh,3.5rem);margin:.15rem 0}
      body.timer-board .arena-team{font-size:clamp(.65rem,1.8vh,1rem)}
      body.timer-board #timer-warning,body.timer-board #timer-connection{margin:0;font-size:clamp(.65rem,1.5vh,.9rem);line-height:1.15}
      body.timer-board main>p:last-child{display:none}
      .previous-results{display:grid;grid-template-columns:auto repeat(4,minmax(0,1fr));align-items:center;gap:.4rem;border-top:1px solid currentColor;padding-top:.35rem;min-width:0}
      .previous-results[hidden]{display:none}
      .previous-results-heading{font-size:clamp(.65rem,1.5vh,.9rem);font-weight:800;line-height:1.15}
      .previous-result-team{text-align:center;min-width:0;line-height:1.1}
      .previous-result-team strong{display:block;font:800 clamp(.8rem,2vh,1.15rem)/1.1 ui-monospace,monospace}
      .previous-result-team span{display:block;font-size:clamp(.6rem,1.35vh,.8rem);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      body.timer-board .previous-results{gap:.2rem;padding-top:.2rem}
      body.timer-board-with-results.timer-board-has-title main{grid-template-rows:auto auto auto auto auto minmax(0,1fr) auto auto auto auto}
      @media(max-width:480px){body.timer-board .previous-results{grid-template-columns:repeat(4,minmax(0,1fr))}body.timer-board .previous-results-heading{grid-column:1/-1;text-align:center}}
      body.corner-board{padding:0;min-height:100dvh}body.corner-board main{width:100%;max-width:none;min-height:100dvh;margin:0}
      body.corner-board header,body.corner-board main>p{display:none}
      #corner-display{position:relative;isolation:isolate;overflow:hidden;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:5vw}
      .corner-position-number{position:absolute;z-index:0;inset:50% auto auto 50%;transform:translate(-50%,-55%);font:900 min(88vw,88vh)/.8 ui-monospace,monospace;opacity:.14;pointer-events:none}
      .corner-team-code{position:relative;font:900 clamp(5rem,30vw,28rem)/.85 ui-monospace,monospace;letter-spacing:-.07em}
      .corner-team-name{position:relative;font-size:clamp(1.5rem,5vw,4rem);font-weight:700;line-height:1.05;overflow-wrap:anywhere;margin-top:.5em}
      .corner-timer{position:relative;font-size:clamp(3rem,14vw,12rem);padding:.2em 0 0}
      .corner-state{position:relative;margin:0;font-size:clamp(1.1rem,3vw,2.5rem);font-weight:850;letter-spacing:.1em}
      .countdown-overlay{position:fixed;inset:0;z-index:1000;width:100vw;height:100dvh;overflow:hidden;padding:4vw;display:none;place-items:center;text-align:center;background:inherit;font:900 min(65vw,82vh,36rem)/.9 ui-monospace,monospace;font-variant-numeric:tabular-nums}
      .countdown-overlay.visible{display:grid}
      .countdown-overlay.ready{font-size:clamp(2rem,10vw,8rem);letter-spacing:.04em}
      .countdown-overlay.end{font-size:min(45vw,72vh,36rem);line-height:1;overflow-wrap:anywhere}
      .sr-outside{display:grid;min-height:70vh;align-content:center}
      .sr-outside-page{display:none;max-height:78vh;overflow:auto}
      .sr-outside-page.active{display:block}
      .sr-outside-page h2{font-size:clamp(1.5rem,4vw,3rem);margin:0 0 .4em}
      .sr-outside-page table{font-size:clamp(.75rem,2vw,1.5rem);margin:0}
      .sr-outside-page td,.sr-outside-page th{padding:.35em .5em}
      .sr-external-link{position:fixed;right:1rem;bottom:1rem;color:inherit}
      #countdown-overlay{color:#fff}
      .schedule-position-team{font:900 1.15rem/1 ui-monospace,monospace}
      body.cue-red{background:#a21f24!important;color:#fff!important;transition:background-color .15s linear}
      body.cue-green{background:${options.goBackgroundColor}!important;color:${readableTextColour(options.goBackgroundColor)}!important;transition:background-color .15s linear}
      body.cue-end{background:${options.endBackgroundColor}!important;color:${readableTextColour(options.endBackgroundColor)}!important;transition:background-color .15s linear}
    </style></head><body class="${display.type === 'corner' ? 'corner-board' : ['timer','sr-producer'].includes(display.type) ? `timer-board${options.showTitle ? ' timer-board-has-title' : ' timer-board-no-title'}${options.showPreviousResults ? ' timer-board-with-results' : ''}` : display.type === 'sr-arena' ? 'sr-arena-board' : ''}" style="${theme}"><main>${options.showTitle && display.type !== 'corner' ? `<header>${display.logoDataUrl ? `<img src="${escapeHtml(display.logoDataUrl)}" alt="">` : ''}<div><div class="muted">${escapeHtml(display.competition)}</div><h1>${escapeHtml(display.title)}</h1></div></header>` : ''}
    ${content}<p class="muted">Updated ${escapeHtml(new Date(display.updatedAt).toLocaleTimeString())}</p></main>
    ${liveTimerDisplay ? `<div id="countdown-overlay" class="countdown-overlay" aria-live="assertive" style="background-color:${displayBackground}"></div>` : ''}
    ${rotatingOutsideDisplay ? `<script>
      const outsidePages=[...document.querySelectorAll('[data-sr-outside-page]')];
      let outsidePageIndex=0;
      const showOutsidePage=index=>{
        outsidePageIndex=index;
        outsidePages.forEach((page,pageIndex)=>page.classList.toggle('active',pageIndex===outsidePageIndex));
      };
      if(outsidePages.length){
        showOutsidePage(0);
        setInterval(()=>showOutsidePage((outsidePageIndex+1)%outsidePages.length),${options.srRotationSeconds * 1000});
        setInterval(()=>location.reload(),Math.max(30000,outsidePages.length*${options.srRotationSeconds * 1000}));
      }
    </script>` : ''}
    ${liveTimerDisplay ? `<script>
      const timerEndpoint=${JSON.stringify(`/api/public/display/${display.slug}`)};
      const timerNode=document.getElementById('timer-display');
      const stateNode=document.getElementById('timer-state');
      const labelNode=document.getElementById('timer-label');
      const matchNode=document.getElementById('timer-match');
      const arenaNode=document.getElementById('timer-arena');
      const warningNode=document.getElementById('timer-warning');
      const connectionNode=document.getElementById('timer-connection');
      const countdownOverlay=document.getElementById('countdown-overlay');
      const previousResultsNode=document.getElementById('timer-previous-results');
      const cornerDisplay=document.getElementById('corner-display');
      const cornerCodeNode=document.getElementById('corner-team-code');
      const cornerTeamNode=document.getElementById('corner-team-name');
      const cornerPositionNode=document.getElementById('corner-position-number');
      const displayOptions=${JSON.stringify(options)};
      const displayDarkTheme=${JSON.stringify(darkTheme)};
      const countdownPreparationMs=${MATCH_COUNTDOWN_PREPARATION_SECONDS * 1000};
      const countdownTotalMs=${MATCH_COUNTDOWN_TOTAL_SECONDS * 1000};
      let currentMatch=null,serverOffset=0;
      let bestClockRoundTrip=Infinity;
      let syncing=false;
      const renderArena=positions=>{
        if(!arenaNode)return;
        arenaNode.replaceChildren();
        for(const position of positions||[]){
          const cell=document.createElement('div');
          cell.className='arena-cell';
          cell.dataset.spot=String(Number(position.position)-1);
          const colour=/^#[0-9a-f]{6}$/i.test(position.colour||'')?position.colour:'#777777';
          cell.style.borderColor=colour;
          cell.style.backgroundColor=displayOptions.fillCorners?colour:'color-mix(in srgb, '+colour+' 18%, '+(displayDarkTheme?'#111820':'white')+')';
          if(displayOptions.fillCorners){
            const rgb=colour.match(/[0-9a-f]{2}/gi).map(part=>parseInt(part,16));
            cell.style.color=(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])/255>.58?'#111':'#fff';
          }
          if(displayOptions.showPositionNumbers){const spot=document.createElement('span');spot.className='arena-spot';spot.textContent=cell.dataset.spot;cell.append(spot);}
          const code=document.createElement('span');code.className='arena-code';code.textContent=position.teamCode||'VACANT';cell.append(code);
          if(displayOptions.showTeamNames&&position.teamName){const team=document.createElement('span');team.className='arena-team';team.textContent=position.teamName;cell.append(team);}
          arenaNode.append(cell);
        }
      };
      const renderPreviousResults=result=>{
        if(!previousResultsNode)return;
        previousResultsNode.replaceChildren();
        if(!result||!Array.isArray(result.scores)||result.scores.length===0){
          previousResultsNode.hidden=true;
          return;
        }
        const heading=document.createElement('div');
        heading.className='previous-results-heading';
        heading.textContent='Previous Match '+result.match_number;
        previousResultsNode.append(heading);
        for(const score of result.scores){
          const team=document.createElement('div');
          team.className='previous-result-team';
          const code=document.createElement('strong');
          code.textContent=score.code||'—';
          const detail=document.createElement('span');
          detail.textContent=(score.name?score.name+' · ':'')+score.points+' pts';
          team.append(code,detail);
          previousResultsNode.append(team);
        }
        previousResultsNode.hidden=false;
      };
      const renderClock=()=>{
        const match=currentMatch;
        const now=performance.timeOrigin+performance.now()+serverOffset;
        if(!match){
          if(timerNode)timerNode.textContent='--:--.-';
          if(labelNode)labelNode.textContent='NO MATCH SCHEDULED';
          if(stateNode)stateNode.textContent='WAITING FOR NEXT MATCH';
          if(countdownOverlay){countdownOverlay.classList.remove('visible');countdownOverlay.textContent='';}
          document.body.classList.remove('cue-red','cue-green','cue-end');
          return;
        }
        let remaining=0;
        let label='MATCH COMPLETE';
        let statusText=String(match.state).replaceAll('_',' ').toUpperCase();
        const countdownStartedAt=match.countdown_started_at?new Date(match.countdown_started_at).getTime():null;
        const actualStartedAt=countdownStartedAt!==null
          ?countdownStartedAt+countdownTotalMs
          :match.actual_start?new Date(match.actual_start).getTime():null;
        if(match.state==='running'){
          remaining=Number(match.duration_seconds)*1000-(now-actualStartedAt-Number(match.paused_seconds||0)*1000);
          label='TIME LEFT';
          statusText='MATCH IN PROGRESS';
        }else if(match.state==='paused'){
          remaining=Number(match.duration_seconds)*1000-(new Date(match.paused_at).getTime()-actualStartedAt-Number(match.paused_seconds||0)*1000);
          label='TIME LEFT · PAUSED';
          statusText='MATCH PAUSED';
        }else if(['scheduled','ready','delayed'].includes(match.state)){
          remaining=new Date(match.effective_start).getTime()-now;
          label='STARTS IN';
          statusText='UP NEXT';
          if(match.countdown_started_at){
            const goAt=new Date(match.countdown_started_at).getTime()+countdownTotalMs;
            remaining=goAt-now;
            label='STARTS IN';
            statusText=remaining>0?'STARTING IN '+Math.max(1,Math.ceil(remaining/1000)):'GO';
          }
        }else if(match.state==='awaiting_score'){
          label='AWAITING SCORE';
          statusText='AWAITING SCORE';
        }
        remaining=Math.max(0,remaining);
        const cueGoAt=countdownStartedAt!==null?countdownStartedAt+countdownTotalMs:actualStartedAt;
        const inGoCue=cueGoAt!==null&&now>=cueGoAt&&now<cueGoAt+displayOptions.cueDurationSeconds*1000;
        const inRedCue=countdownStartedAt!==null&&cueGoAt!==null&&now<cueGoAt;
        const timerEndAt=actualStartedAt===null?null:actualStartedAt+
          (Number(match.duration_seconds)+Number(match.paused_seconds||0))*1000;
        const reportedEndAt=match.actual_end?new Date(match.actual_end).getTime():null;
        const endCueAt=reportedEndAt!==null&&timerEndAt!==null?Math.min(reportedEndAt,timerEndAt):reportedEndAt??timerEndAt;
        const inEndCue=displayOptions.showEndCue&&match.state!=='paused'&&endCueAt!==null&&now>=endCueAt&&
          now<endCueAt+displayOptions.endCueDurationSeconds*1000;
        const tenths=Math.floor((remaining%1000)/100);
        document.body.classList.toggle('cue-red',displayOptions.showStartCue&&inRedCue);
        document.body.classList.toggle('cue-green',displayOptions.showStartCue&&inGoCue&&!inEndCue);
        document.body.classList.toggle('cue-end',inEndCue);
        const timerText=inEndCue?'END':statusText.startsWith('STARTING IN')?String(Math.max(1,Math.ceil(remaining/1000))):statusText==='GO'?'GO':
          String(Math.floor(remaining/60000)).padStart(2,'0')+':'+String(Math.floor(remaining/1000)%60).padStart(2,'0')+'.'+tenths;
        if(timerNode)timerNode.textContent=timerText;
        if(stateNode)stateNode.textContent=statusText;
        if(labelNode)labelNode.textContent=label;
        if(countdownOverlay){
          const goAt=countdownStartedAt!==null?countdownStartedAt+countdownTotalMs:actualStartedAt;
          let countdownText=null;
          let countdownBackground=displayOptions.countdownBackgroundColor;
          if(countdownStartedAt!==null){
            const elapsed=now-countdownStartedAt;
            if(elapsed>=0&&elapsed<countdownPreparationMs){
              countdownText='GET READY';
            }else if(elapsed>=countdownPreparationMs&&elapsed<countdownTotalMs){
              const secondsRemaining=Math.ceil((countdownTotalMs-elapsed)/1000);
              countdownText=String(secondsRemaining);
              if(displayOptions.flashCountdownNumbers&&secondsRemaining%2===0){
                countdownBackground=displayOptions.countdownFlashColor;
              }
            }else if(goAt!==null&&now>=goAt&&now<goAt+displayOptions.cueDurationSeconds*1000){
              countdownText='GO';
              countdownBackground=displayOptions.goBackgroundColor;
            }
          }else if(goAt!==null&&now>=goAt&&now<goAt+displayOptions.cueDurationSeconds*1000){
            countdownText='GO';
            countdownBackground=displayOptions.goBackgroundColor;
          }
          const endCountdownText=match.state==='running'&&displayOptions.showEndCountdown
            ?Math.max(0,Math.ceil(remaining/1000)):null;
          if(endCountdownText!==null&&remaining>0&&remaining<=displayOptions.endCountdownSeconds*1000){
            countdownText=endCountdownText;
            countdownBackground=${JSON.stringify(options.endBackgroundColor)};
          }
          if(inEndCue){
            countdownText='END';
            countdownBackground=${JSON.stringify(options.endBackgroundColor)};
          }
          countdownOverlay.textContent=inEndCue?'END':countdownText||'';
          countdownOverlay.style.backgroundColor=countdownBackground;
          countdownOverlay.style.color=(parseInt(countdownBackground.slice(1,3),16)*.2126+parseInt(countdownBackground.slice(3,5),16)*.7152+parseInt(countdownBackground.slice(5,7),16)*.0722>148?'#111':'#fff');
          countdownOverlay.classList.toggle('ready',countdownText==='GET READY');
          countdownOverlay.classList.toggle('end',countdownText==='END');
          countdownOverlay.classList.toggle('visible',countdownText!==null||inEndCue);
        }
      };
      const syncDisplay=async()=>{
        if(syncing)return;
        syncing=true;
        const started=performance.now();
        try{
          const response=await fetch(timerEndpoint,{cache:'no-store'});
          if(!response.ok)throw new Error('Live display request failed ('+response.status+')');
          const payload=await response.json();
          const finished=performance.now();
          const serverTime=response.headers.get('x-server-time');
          const roundTrip=finished-started;
          const measuredOffset=Date.parse(serverTime||payload.updatedAt)-(performance.timeOrigin+(started+finished)/2);
          if(roundTrip<bestClockRoundTrip){
            bestClockRoundTrip=roundTrip;
            serverOffset=measuredOffset;
          }else{
            const offsetError=Math.max(-10,Math.min(10,measuredOffset-serverOffset));
            serverOffset+=offsetError*.1;
          }
          currentMatch=payload.data&& !Array.isArray(payload.data)?payload.data:null;
          renderPreviousResults(payload.previousResults);
          if(cornerDisplay){
            const cornerPosition=currentMatch?.positions?.find(position=>Number(position.spot)===displayOptions.cornerPosition);
            const cornerColour=/^#[0-9a-f]{6}$/i.test(cornerPosition?.colour||'')?cornerPosition.colour:'#777777';
            if(cornerCodeNode)cornerCodeNode.textContent=cornerPosition?.teamCode||'VACANT';
            if(cornerTeamNode)cornerTeamNode.textContent=cornerPosition?.teamName||'';
            if(cornerPositionNode)cornerPositionNode.textContent=String(displayOptions.cornerPosition);
            cornerDisplay.style.backgroundColor=displayOptions.fillCornerDisplay?cornerColour:${JSON.stringify(displayBackground)};
            if(displayOptions.fillCornerDisplay){
              const rgb=cornerColour.match(/[0-9a-f]{2}/gi).map(part=>parseInt(part,16));
              cornerDisplay.style.color=(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])/255>.58?'#111111':'#ffffff';
            }else{
              cornerDisplay.style.color=${JSON.stringify(darkTheme ? '#edf3f4' : '#17242b')};
            }
            if(countdownOverlay){
              countdownOverlay.style.backgroundColor=displayOptions.fillCornerDisplay?cornerColour:${JSON.stringify(displayBackground)};
              countdownOverlay.style.color=cornerDisplay.style.color;
            }
          }
          if(matchNode)matchNode.textContent=currentMatch&&currentMatch.match_number
            ?'Match '+currentMatch.match_number+(displayOptions.showArena?' · '+currentMatch.arena_name:'')
            :'No upcoming match';
          if(stateNode)stateNode.textContent=currentMatch?String(currentMatch.state).replaceAll('_',' ').toUpperCase():'';
          if(warningNode)warningNode.textContent=currentMatch&&Number(currentMatch.team_count)<4
            ?'UNDERFILLED MATCH · '+currentMatch.team_count+'/4 POSITIONS':'';
          renderArena(currentMatch&&currentMatch.positions);
          if(connectionNode){connectionNode.textContent='Live · synchronized '+new Date(payload.updatedAt).toLocaleTimeString();connectionNode.style.color='';}
          renderClock();
        }catch(error){
          if(connectionNode){connectionNode.textContent='Live connection lost · retrying';connectionNode.style.color='#b33';}
          console.error(error);
        }finally{
          syncing=false;
        }
      };
      void syncDisplay();
      setInterval(()=>{void syncDisplay();},1000);
      const renderClockFrame=()=>{renderClock();requestAnimationFrame(renderClockFrame);};
      requestAnimationFrame(renderClockFrame);
    </script>` : ''}
    ${['schedule', 'sr-staging', 'sr-shepherding'].includes(display.type) && options.enableTeamFilter ? `<script>
      const scheduleFilter=document.getElementById('schedule-team-filter');
      const scheduleStorageKey=${JSON.stringify(`schedule-team-filter:${display.slug}`)};
      if(scheduleFilter){
        scheduleFilter.value=sessionStorage.getItem(scheduleStorageKey)||'';
        const applyScheduleFilter=()=>{
          const selected=scheduleFilter.value;
          for(const row of document.querySelectorAll('tbody tr[data-team-codes]')){
            row.hidden=Boolean(selected)&&!row.dataset.teamCodes.split(',').includes(selected);
          }
          sessionStorage.setItem(scheduleStorageKey,selected);
        };
        scheduleFilter.addEventListener('change',applyScheduleFilter);
        applyScheduleFilter();
      }
    </script>` : ''}
    ${['schedule', 'sr-staging', 'sr-shepherding'].includes(display.type) && options.relativeTime ? `<script>
      const relativeScheduleTimes=document.querySelectorAll('[data-relative-time]');
      const renderRelativeScheduleTimes=()=>{
        for(const node of relativeScheduleTimes){
          const delta=Number(node.dataset.relativeTime)-Date.now();
          const seconds=Math.floor(Math.abs(delta)/1000);
          let duration;
          if(seconds<60)duration=seconds<=1?'1 second':seconds+' seconds';
          else if(seconds<3600){const minutes=Math.floor(seconds/60);duration=minutes+' minute'+(minutes===1?'':'s');}
          else if(seconds<86400){const hours=Math.floor(seconds/3600);const minutes=Math.floor(seconds%3600/60);duration=hours+' hour'+(hours===1?'':'s')+(minutes?' '+minutes+' minute'+(minutes===1?'':'s'):'');}
          else{const days=Math.floor(seconds/86400);const hours=Math.floor(seconds%86400/3600);duration=days+' day'+(days===1?'':'s')+(hours?' '+hours+' hour'+(hours===1?'':'s'):'');}
          node.textContent=delta>=0?'in '+duration:duration+' ago';
        }
      };
      renderRelativeScheduleTimes();
      setInterval(renderRelativeScheduleTimes,1000);
    </script>` : ''}</body></html>`);
});

app.get('/api/admin/competitions/:slug/auto-run', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await pool.query<{ auto_run_enabled: boolean }>(
    'SELECT auto_run_enabled FROM competition_settings WHERE competition_id = $1',
    [competition.id]
  );
  return { enabled: result.rows[0]?.auto_run_enabled ?? false };
});

app.put('/api/admin/competitions/:slug/auto-run', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO competition_settings (competition_id, auto_run_enabled)
       VALUES ($1, $2)
       ON CONFLICT (competition_id) DO UPDATE
       SET auto_run_enabled = EXCLUDED.auto_run_enabled, updated_at = now()`,
      [competition.id, enabled]
    );
    await audit(client, adminEmail(request), enabled ? 'competition.auto_run_enabled' : 'competition.auto_run_disabled',
      'competition', competition.id, { enabled });
  });
  return { enabled };
});

app.post('/api/admin/competitions/:slug/publish', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  if (competition.status !== 'draft') {
    return reply.code(409).send({ error: `Cannot publish a competition in ${competition.status} state` });
  }
  await transaction(async (client) => {
    await client.query(`UPDATE competitions SET status = 'published' WHERE id = $1`, [competition.id]);
    await audit(client, adminEmail(request), 'competition.published', 'competition', competition.id);
  });
  return { ok: true, status: 'published' };
});

app.get('/api/admin/competitions/:slug/teams', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await pool.query(
    `SELECT id, code, name, active FROM teams WHERE competition_id = $1 ORDER BY code`,
    [competition.id]
  );
  return result.rows;
});

app.get('/api/admin/competitions/:slug/league', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const standings = (await fetchStandings(pool, competition.id)).map(({ id: _id, ...team }) => team);
  return { competition: competition.name, standings };
});

app.post('/api/admin/competitions/:slug/teams', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    name: z.string().trim().min(1).max(160)
  }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const duplicate = await pool.query(
    'SELECT 1 FROM teams WHERE competition_id = $1 AND code = $2',
    [competition.id, body.code]
  );
  if (duplicate.rowCount) return reply.code(409).send({ error: `Team code ${body.code} already exists in this competition` });
  const id = randomUUID();
  await transaction(async (client) => {
    await client.query(
      'INSERT INTO teams (id, competition_id, code, name) VALUES ($1, $2, $3, $4)',
      [id, competition.id, body.code, body.name]
    );
    await audit(client, adminEmail(request), 'team.created', 'team', id, body);
    await refreshUnstartedPlayoffSeeds(client, competition.id, adminEmail(request));
  });
  return reply.code(201).send({ id, ...body, active: true });
});

app.patch('/api/admin/teams/:teamId', { preHandler: requireAdmin }, async (request, reply) => {
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    name: z.string().trim().min(1).max(160).optional(),
    active: z.boolean().optional()
  }).refine((value) => Object.keys(value).length > 0).parse(request.body);
  const updated = await transaction(async (client) => {
    const teamResult = await client.query<{ id: string; competition_id: string; name: string; active: boolean }>(
      'SELECT id, competition_id, name, active FROM teams WHERE id = $1 FOR UPDATE',
      [teamId]
    );
    const team = teamResult.rows[0];
    if (!team) return { status: 404 as const, error: 'Team not found' };
    if (body.active !== undefined && body.active !== team.active) {
      const assigned = await client.query(
        `SELECT 1 FROM match_positions WHERE team_id = $1
         UNION ALL SELECT 1 FROM playoff_matches
           WHERE team_one_id = $1 OR team_two_id = $1 OR team_three_id = $1 OR team_four_id = $1
         LIMIT 1`,
        [teamId]
      );
      if (assigned.rowCount) {
        return { status: 409 as const, error: 'A team assigned to a match cannot be deactivated or reactivated' };
      }
    }
    const result = await client.query(
      `UPDATE teams SET name = coalesce($2, name), active = coalesce($3, active)
       WHERE id = $1 RETURNING id, code, name, active`,
      [teamId, body.name ?? null, body.active ?? null]
    );
    await audit(client, adminEmail(request), 'team.updated', 'team', teamId, body);
    return { status: 200 as const, team: result.rows[0] };
  });
  if (updated.status !== 200) return reply.code(updated.status).send({ error: updated.error });
  return updated.team;
});

app.delete('/api/admin/teams/:teamId', { preHandler: requireAdmin }, async (request, reply) => {
  const { teamId } = z.object({ teamId: z.string().uuid() }).parse(request.params);
  const body = z.object({ confirmation: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/) }).parse(request.body);
  const result = await transaction(async (client) => {
    const teamResult = await client.query<{ id: string; competition_id: string; code: string; name: string }>(
      'SELECT id, competition_id, code, name FROM teams WHERE id = $1 FOR UPDATE',
      [teamId]
    );
    const team = teamResult.rows[0];
    if (!team) return { status: 404 as const, error: 'Team not found' };
    if (body.confirmation !== team.code) {
      return { status: 400 as const, error: 'Team code confirmation does not match' };
    }
    const references = await client.query(
      `SELECT 1 FROM match_positions WHERE team_id = $1
       UNION ALL SELECT 1 FROM match_scores WHERE team_id = $1
       UNION ALL SELECT 1 FROM challenge_completions WHERE team_id = $1
       UNION ALL SELECT 1 FROM playoff_match_scores WHERE team_id = $1
       UNION ALL SELECT 1 FROM playoff_matches
         WHERE team_one_id = $1 OR team_two_id = $1 OR team_three_id = $1
           OR team_four_id = $1 OR winner_team_id = $1
       LIMIT 1`,
      [teamId]
    );
    if (references.rowCount) {
      return { status: 409 as const, error: 'This team has match, score, challenge or playoff history. Deactivate it to preserve those records.' };
    }
    await client.query(
      `DELETE FROM audit_events WHERE entity_type = 'team' AND entity_id = $1`,
      [teamId]
    );
    await client.query('DELETE FROM teams WHERE id = $1', [teamId]);
    await audit(client, adminEmail(request), 'team.deleted', 'team', teamId, {
      code: team.code,
      name: team.name
    });
    return { status: 204 as const };
  });
  if (result.status !== 204) return reply.code(result.status).send({ error: result.error });
  return reply.code(204).send();
});

app.get('/api/admin/competitions/:slug/challenges', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await pool.query(
    `SELECT challenge.id, challenge.name, challenge.description, challenge.points, challenge.created_at,
            jsonb_agg(jsonb_build_object(
              'teamId', team.id, 'code', team.code, 'name', team.name,
              'completedAt', completion.completed_at
            ) ORDER BY team.code) FILTER (WHERE team.id IS NOT NULL) AS teams
     FROM challenges challenge
     LEFT JOIN challenge_completions completion ON completion.challenge_id = challenge.id
     LEFT JOIN teams team ON team.id = completion.team_id
     WHERE challenge.competition_id = $1
     GROUP BY challenge.id ORDER BY challenge.created_at, challenge.name`,
    [competition.id]
  );
  return result.rows;
});

app.post('/api/admin/competitions/:slug/challenges', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    points: z.number().finite().min(0).max(1_000_000)
  }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const id = randomUUID();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO challenges (id, competition_id, name, description, points, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, competition.id, body.name, body.description, body.points, adminEmail(request)]
    );
    await audit(client, adminEmail(request), 'challenge.created', 'challenge', id, body);
  });
  return reply.code(201).send({ id, ...body, teams: [] });
});

app.post('/api/admin/challenges/:challengeId/completions', { preHandler: requireAdmin }, async (request, reply) => {
  const { challengeId } = z.object({ challengeId: z.string().uuid() }).parse(request.params);
  const body = z.object({ teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/) }).parse(request.body);
  const result = await transaction(async (client) => {
    const challengeResult = await client.query<{ competition_id: string; name: string; points: string }>(
      'SELECT competition_id, name, points FROM challenges WHERE id = $1 FOR UPDATE',
      [challengeId]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) return { status: 404 as const, error: 'Challenge not found' };
    const teamResult = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM teams WHERE competition_id = $1 AND code = $2 AND active = true',
      [challenge.competition_id, body.teamCode]
    );
    const team = teamResult.rows[0];
    if (!team) return { status: 404 as const, error: 'Active team not found in this competition' };
    const inserted = await client.query(
      `INSERT INTO challenge_completions (challenge_id, team_id, completed_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING challenge_id`,
      [challengeId, team.id, adminEmail(request)]
    );
    if (!inserted.rowCount) return { status: 409 as const, error: 'This team has already completed this challenge' };
    await audit(client, adminEmail(request), 'challenge.completed', 'challenge', challengeId, {
      challengeName: challenge.name,
      teamCode: body.teamCode,
      points: challenge.points
    });
    await refreshUnstartedPlayoffSeeds(client, challenge.competition_id, adminEmail(request));
    return { status: 201 as const, ok: true, teamCode: body.teamCode, points: challenge.points };
  });
  return reply.code(result.status).send(result);
});

app.delete('/api/admin/challenges/:challengeId/completions/:teamCode', { preHandler: requireAdmin }, async (request, reply) => {
  const params = z.object({
    challengeId: z.string().uuid(),
    teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
  }).parse(request.params);
  const result = await transaction(async (client) => {
    const challengeResult = await client.query<{ competition_id: string; name: string; points: string }>(
      'SELECT competition_id, name, points FROM challenges WHERE id = $1 FOR UPDATE',
      [params.challengeId]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) return { status: 404 as const, error: 'Challenge not found' };
    const completion = await client.query<{ team_id: string; name: string; points: string }>(
      `SELECT completion.team_id, $4::text AS name, $5::numeric AS points
       FROM challenge_completions completion
       JOIN teams team ON team.id = completion.team_id
       WHERE completion.challenge_id = $1 AND team.code = $2 AND team.competition_id = $3
       FOR UPDATE OF completion`,
      [params.challengeId, params.teamCode, challenge.competition_id, challenge.name, challenge.points]
    );
    const row = completion.rows[0];
    if (!row) return { status: 404 as const, error: 'Challenge completion not found' };
    await client.query(
      'DELETE FROM challenge_completions WHERE challenge_id = $1 AND team_id = $2',
      [params.challengeId, row.team_id]
    );
    await audit(client, adminEmail(request), 'challenge.completion_undone', 'challenge', params.challengeId, {
      challengeName: row.name,
      teamCode: params.teamCode,
      points: challenge.points
    });
    await refreshUnstartedPlayoffSeeds(client, challenge.competition_id, adminEmail(request));
    return { status: 200 as const, ok: true, teamCode: params.teamCode, points: challenge.points };
  });
  return reply.code(result.status).send(result);
});

app.get('/api/admin/competitions/:slug/events', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await pool.query(
    `SELECT id, title, description, location, starts_at, duration_minutes, created_at
     FROM competition_events WHERE competition_id = $1 ORDER BY starts_at, title`,
    [competition.id]
  );
  return result.rows;
});

app.post('/api/admin/competitions/:slug/events', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    location: z.string().trim().max(120).default(''),
    startsAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(1).max(1440)
  }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const id = randomUUID();
  const shiftedMatchIds = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    await client.query(
      `INSERT INTO competition_events
       (id, competition_id, title, description, location, starts_at, duration_minutes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, competition.id, body.title, body.description, body.location, body.startsAt, body.durationMinutes, adminEmail(request)]
    );
    await audit(client, adminEmail(request), 'competition_event.created', 'competition_event', id, body);
    return shiftScheduledMatchesAroundEvents(client, competition.id, adminEmail(request), `event "${body.title}" added`);
  });
  return reply.code(201).send({ id, ...body, shiftedMatchIds });
});

app.patch('/api/admin/events/:eventId', { preHandler: requireAdmin }, async (request, reply) => {
  const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    location: z.string().trim().max(120).default(''),
    startsAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(1).max(1440)
  }).parse(request.body);
  const result = await transaction(async (client) => {
    const existing = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM competition_events WHERE id = $1',
      [eventId]
    );
    const event = existing.rows[0];
    if (!event) return { status: 404 as const, error: 'Scheduled event not found' };
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [event.competition_id]);
    const updated = await client.query(
      `UPDATE competition_events SET title = $2, description = $3, location = $4,
         starts_at = $5, duration_minutes = $6 WHERE id = $1
       RETURNING id, title, description, location, starts_at, duration_minutes`,
      [eventId, body.title, body.description, body.location, body.startsAt, body.durationMinutes]
    );
    const shiftedMatchIds = await shiftScheduledMatchesAroundEvents(
      client, event.competition_id, adminEmail(request), `event "${body.title}" updated`
    );
    await audit(client, adminEmail(request), 'competition_event.updated', 'competition_event', eventId, {
      ...body,
      shiftedMatchIds
    });
    return { status: 200 as const, event: updated.rows[0], shiftedMatchIds };
  });
  return reply.code(result.status).send(result);
});

app.delete('/api/admin/events/:eventId', { preHandler: requireAdmin }, async (request, reply) => {
  const { eventId } = z.object({ eventId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const deleted = await client.query<{ id: string; title: string }>(
      'DELETE FROM competition_events WHERE id = $1 RETURNING id, title',
      [eventId]
    );
    if (!deleted.rows[0]) return undefined;
    await audit(client, adminEmail(request), 'competition_event.deleted', 'competition_event', eventId, {
      title: deleted.rows[0].title
    });
    return deleted.rows[0];
  });
  if (!result) return reply.code(404).send({ error: 'Scheduled event not found' });
  return reply.code(204).send();
});

app.post('/api/admin/competitions/:slug/clear-schedule', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({ confirmation: z.literal('CLEAR SCHEDULE') }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    const active = await client.query(
      `SELECT 1 FROM matches
       WHERE competition_id = $1
         AND (state IN ('running', 'paused', 'awaiting_score') OR countdown_started_at IS NOT NULL)
       LIMIT 1`,
      [competition.id]
    );
    if (active.rowCount) {
      return { status: 409 as const, error: 'Stop or finish active matches and cancel start countdowns before clearing the schedule' };
    }
    const counts = await client.query<{
      matches: number; playoff_matches: number; events: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM matches WHERE competition_id = $1) AS matches,
         (SELECT count(*)::int FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1) AS playoff_matches,
         (SELECT count(*)::int FROM competition_events WHERE competition_id = $1) AS events`,
      [competition.id]
    );
    await client.query(
      `DELETE FROM score_revisions WHERE match_id IN (
         SELECT id FROM matches WHERE competition_id = $1
       )`,
      [competition.id]
    );
    await client.query(
      `DELETE FROM playoff_score_revisions WHERE playoff_match_id IN (
         SELECT pm.id FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1
       )`,
      [competition.id]
    );
    await client.query('DELETE FROM matches WHERE competition_id = $1', [competition.id]);
    await client.query('DELETE FROM playoff_brackets WHERE competition_id = $1', [competition.id]);
    await client.query('DELETE FROM competition_events WHERE competition_id = $1', [competition.id]);
    const deletedCounts = counts.rows[0]!;
    await audit(client, adminEmail(request), 'competition.schedule_cleared', 'competition', competition.id, {
      ...deletedCounts,
      confirmation: body.confirmation
    });
    return { status: 200 as const, ...deletedCounts };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/competitions/:slug/clear-matches', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({ confirmation: z.literal('CLEAR MATCHES') }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    const active = await client.query(
      `SELECT 1 FROM matches
       WHERE competition_id = $1
         AND (state IN ('running', 'paused', 'awaiting_score') OR countdown_started_at IS NOT NULL)
       UNION ALL
       SELECT 1 FROM playoff_matches pm
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pb.competition_id = $1
         AND (pm.timer_state IN ('running', 'paused', 'awaiting_score')
              OR pm.countdown_started_at IS NOT NULL)
       LIMIT 1`,
      [competition.id]
    );
    if (active.rowCount) {
      return { status: 409 as const, error: 'Stop or finish active matches and cancel start countdowns before clearing matches' };
    }
    const counts = await client.query<{
      matches: number; playoff_matches: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM matches WHERE competition_id = $1) AS matches,
         (SELECT count(*)::int FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
           WHERE pb.competition_id = $1) AS playoff_matches`,
      [competition.id]
    );
    await client.query(
      `DELETE FROM score_revisions WHERE match_id IN (
         SELECT id FROM matches WHERE competition_id = $1
       )`,
      [competition.id]
    );
    await client.query(
      `DELETE FROM playoff_score_revisions WHERE playoff_match_id IN (
         SELECT pm.id FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1
       )`,
      [competition.id]
    );
    await client.query('DELETE FROM matches WHERE competition_id = $1', [competition.id]);
    await client.query('DELETE FROM playoff_brackets WHERE competition_id = $1', [competition.id]);
    const deletedCounts = counts.rows[0]!;
    await audit(client, adminEmail(request), 'competition.matches_cleared', 'competition', competition.id, {
      ...deletedCounts,
      eventsRetained: true,
      confirmation: body.confirmation
    });
    return { status: 200 as const, ...deletedCounts };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/competitions/:slug/generate-schedule', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    matchCount: z.number().int().min(1).max(400),
    firstStart: z.string().datetime({ offset: true }),
    intervalSeconds: z.number().int().min(60).max(86400),
    arenas: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
    durationSeconds: z.number().int().positive().max(7200).optional(),
    seed: z.number().int().nonnegative().max(0xffffffff).optional(),
    positions: z.array(z.object({
      label: z.string().trim().min(1).max(80)
    })).length(4)
  }).parse(request.body);
  if (new Set(body.arenas).size !== body.arenas.length) {
    return reply.code(400).send({ error: 'Arena names must be unique' });
  }
  if (new Set(body.positions.map((position) => position.label)).size !== 4) {
    return reply.code(400).send({ error: 'Corner labels must be unique' });
  }
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const durationSeconds = body.durationSeconds ?? competition.match_duration_seconds;
  if (body.intervalSeconds < durationSeconds) {
    return reply.code(400).send({ error: 'Start-to-start interval must be at least as long as the match duration' });
  }
  const roster = await pool.query<{ id: string; code: string }>(
    'SELECT id, code FROM teams WHERE competition_id = $1 AND active = true ORDER BY code',
    [competition.id]
  );
  const teamCodes = roster.rows.map((team) => team.code);
  if (teamCodes.length < 4) {
    return reply.code(422).send({ error: 'At least four active teams are required for a balanced full-match schedule' });
  }
  if ((body.matchCount * 4) % teamCodes.length !== 0) {
    const step = teamCodes.length / greatestCommonDivisor(teamCodes.length, 4);
    const suggestedMatchCount = Math.ceil(body.matchCount / step) * step;
    return reply.code(422).send({
      error: `Equal appearances are impossible with ${body.matchCount} matches and ${teamCodes.length} teams`,
      suggestedMatchCount
    });
  }
  const seed = body.seed ?? randomBytes(4).readUInt32BE(0);
  const schedule = generateBalancedMatches(teamCodes, body.matchCount, seed);
  const waveAssignments = assignMatchesToWaves(schedule.matches, body.arenas.length);
  const waveCount = Math.max(...waveAssignments.map((assignment) => assignment.wave)) + 1;
  const result = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    const currentMatches = await client.query(
      'SELECT 1 FROM matches WHERE competition_id = $1 LIMIT 1',
      [competition.id]
    );
    if (currentMatches.rowCount) {
      return { status: 409 as const, error: 'Matches already exist; generating a second schedule is not supported yet' };
    }
    const currentTeams = await client.query<{ id: string; code: string }>(
      'SELECT id, code FROM teams WHERE competition_id = $1 AND active = true ORDER BY code',
      [competition.id]
    );
    if (currentTeams.rows.map((team) => team.code).join(',') !== teamCodes.join(',')) {
      return { status: 409 as const, error: 'Team roster changed during generation; retry with the current roster' };
    }
    const teamIds = new Map(currentTeams.rows.map((team) => [team.code, team.id]));
    const cornerColours = await getCornerColours(client, competition.id);
    const firstStart = new Date(body.firstStart);
    for (let index = 0; index < waveAssignments.length; index += 1) {
      const match = waveAssignments[index]!;
      const matchId = randomUUID();
      const arenaName = body.arenas[match.arenaIndex]!;
      const start = new Date(calculateWaveStartTime(
        firstStart.getTime(), match.wave, body.intervalSeconds, durationSeconds
      ));
      await client.query(
        `INSERT INTO matches
         (id, competition_id, match_number, arena_name, scheduled_start, effective_start,
          duration_seconds, planned_gap_seconds, start_mode, state)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'manual', 'scheduled')`,
        [
          matchId, competition.id, index + 1, arenaName, start, durationSeconds,
          body.intervalSeconds - durationSeconds
        ]
      );
      for (let position = 0; position < 4; position += 1) {
        await client.query(
          `INSERT INTO match_positions (match_id, position_number, position_label, colour, team_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [matchId, position + 1, body.positions[position]!.label, cornerColours[position]!,
            teamIds.get(match.positions[position]!)]
        );
      }
    }
    const shiftedMatchIds = await shiftScheduledMatchesAroundEvents(
      client, competition.id, adminEmail(request), 'balanced schedule generated'
    );
    await audit(client, adminEmail(request), 'schedule.generated', 'competition', competition.id, {
      matchCount: body.matchCount,
      teamCount: teamCodes.length,
      appearancesPerTeam: schedule.appearancesPerTeam,
      waveCount,
      restAfterMatchSeconds: body.intervalSeconds,
      seed,
      pairCountRange: schedule.pairRange,
      cornerCountRange: schedule.positionRange,
      arenas: body.arenas,
      shiftedMatchIds
    });
    return { status: 201 as const, ok: true, seed, waveCount, shiftedMatchIds, ...schedule };
  });
  return reply.code(result.status).send(result);
});

app.get('/api/admin/competitions/:slug/matches', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const result = await pool.query(
    `SELECT m.id, m.match_number, m.arena_name, m.scheduled_start, m.effective_start, m.underfilled_reason,
            m.duration_seconds, m.state, m.actual_start, m.actual_end,
            m.paused_at, m.paused_seconds, m.countdown_started_at,
            count(mp.team_id)::int AS team_count,
            EXISTS (SELECT 1 FROM match_scores ms WHERE ms.match_id = m.id) AS has_scores,
            (SELECT count(*)::int FROM match_delays d WHERE d.match_id = m.id) AS delay_count,
            greatest(0, ceil(extract(epoch FROM (m.effective_start - m.scheduled_start))))::int
              AS delay_seconds,
            (SELECT jsonb_agg(jsonb_build_object(
              'reason', d.reason, 'seconds', d.delay_seconds, 'createdAt', d.created_at
            ) ORDER BY d.created_at) FROM match_delays d WHERE d.match_id = m.id) AS delays,
            jsonb_agg(jsonb_build_object(
              'position', mp.position_number, 'spot', mp.position_number - 1,
              'label', mp.position_label, 'colour', mp.colour,
              'teamCode', t.code, 'teamName', t.name
            ) ORDER BY mp.position_number) AS positions
     FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
     LEFT JOIN teams t ON t.id = mp.team_id
     WHERE m.competition_id = $1
     GROUP BY m.id ORDER BY m.scheduled_start, m.match_number`,
    [competition.id]
  );
  const cornerColours = await getCornerColours(pool, competition.id);
  const playoffs = await pool.query(
    `SELECT pm.id, pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start,
            pm.duration_seconds, pm.planned_gap_seconds, pm.status, pm.bracket_side, pm.round_number,
            pm.schedule_state, pm.timer_state, pm.countdown_started_at, pm.actual_start, pm.actual_end,
            pm.paused_at, pm.paused_seconds,
            ((pm.source_one <> 'bye')::int + (pm.source_two <> 'bye')::int +
             (pm.source_three <> 'bye')::int + (pm.source_four <> 'bye')::int) AS entrant_count,
            (SELECT count(*)::int FROM playoff_match_scores pms WHERE pms.playoff_match_id = pm.id) AS score_count,
            (SELECT jsonb_agg(jsonb_build_object('teamCode', t.code, 'points', pms.points)
               ORDER BY pms.points DESC, (pb.seed_ranks ->> t.id::text)::integer)
             FROM playoff_match_scores pms JOIN teams t ON t.id = pms.team_id
             WHERE pms.playoff_match_id = pm.id) AS scores,
            jsonb_build_array(
              jsonb_build_object('position',1,'spot',0,'colour',$2::text,'teamCode',t1.code,'teamName',t1.name),
              jsonb_build_object('position',2,'spot',1,'colour',$3::text,'teamCode',t2.code,'teamName',t2.name),
              jsonb_build_object('position',3,'spot',2,'colour',$4::text,'teamCode',t3.code,'teamName',t3.name),
              jsonb_build_object('position',4,'spot',3,'colour',$5::text,'teamCode',t4.code,'teamName',t4.name)
            ) AS positions
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     LEFT JOIN teams t1 ON t1.id = pm.team_one_id
     LEFT JOIN teams t2 ON t2.id = pm.team_two_id
     LEFT JOIN teams t3 ON t3.id = pm.team_three_id
     LEFT JOIN teams t4 ON t4.id = pm.team_four_id
     WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
     ORDER BY pm.effective_start, pm.match_number`,
    [competition.id, ...cornerColours]
  );
  const leagueMatches = result.rows.map((match) => ({ ...match, underfilled: Number(match.team_count) < 4 }));
  const playoffMatches = playoffs.rows.map((match) => ({
    ...match,
    state: match.schedule_state === 'complete' ? 'complete'
      : match.timer_state === 'awaiting_score' ? 'awaiting_score'
        : match.timer_state === 'running' || match.timer_state === 'paused' ? match.timer_state
          : match.status === 'ready' ? 'ready' : 'scheduled',
    team_count: (match.positions as { teamCode: string | null }[]).filter((position) => position.teamCode).length,
    entrant_count: Number(match.entrant_count),
    underfilled: false,
    has_scores: Number(match.score_count) > 0,
    isPlayoff: true
  }));
  return [...leagueMatches, ...playoffMatches].sort((left, right) =>
    new Date(left.effective_start).getTime() - new Date(right.effective_start).getTime() ||
    left.match_number - right.match_number
  );
});

app.post('/api/admin/competitions/:slug/matches', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const body = z.object({
    matchNumber: z.number().int().positive(),
    arenaName: z.string().trim().min(1).max(80).default('Arena 1'),
    scheduledStart: z.string().datetime({ offset: true }),
    durationSeconds: z.number().int().positive().max(7200).optional(),
    underfilledReason: z.string().trim().min(1).max(500).optional(),
    positions: z.array(z.object({
      number: z.number().int().min(1).max(4),
      label: z.string().trim().min(1).max(80),
      teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional()
    })).length(4),
  }).parse(request.body);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });
  const numbers = new Set(body.positions.map((position) => position.number));
  if (numbers.size !== 4) return reply.code(400).send({ error: 'Each arena position 1–4 must appear exactly once' });
  const assigned = body.positions.filter((position) => position.teamCode);
  if (assigned.length < 4 && !body.underfilledReason) {
    return reply.code(400).send({ error: 'Matches with fewer than four teams require an underfilled reason' });
  }

  const matchId = randomUUID();
  const shiftedMatchIds = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    const cornerColours = await getCornerColours(client, competition.id);
    await client.query(
      `INSERT INTO matches
       (id, competition_id, match_number, arena_name, scheduled_start, effective_start,
        duration_seconds, start_mode, state, underfilled_acknowledged_by, underfilled_reason)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 'manual', 'scheduled', $7, $8)`,
      [matchId, competition.id, body.matchNumber, body.arenaName, body.scheduledStart,
        body.durationSeconds ?? competition.match_duration_seconds,
        assigned.length < 4 ? adminEmail(request) : null, body.underfilledReason ?? null]
    );
    for (const position of body.positions) {
      let teamId: string | null = null;
      if (position.teamCode) {
        const team = await client.query<{ id: string }>(
          'SELECT id FROM teams WHERE competition_id = $1 AND code = $2 AND active = true',
          [competition.id, position.teamCode]
        );
        if (!team.rows[0]) throw new Error(`Unknown or inactive team code: ${position.teamCode}`);
        teamId = team.rows[0].id;
      }
      await client.query(
        `INSERT INTO match_positions (match_id, position_number, position_label, colour, team_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [matchId, position.number, position.label, cornerColours[position.number - 1]!, teamId]
      );
    }
    const shifted = await shiftScheduledMatchesAroundEvents(
      client, competition.id, adminEmail(request), `match #${body.matchNumber} added`
    );
    await audit(client, adminEmail(request), 'match.created', 'match', matchId, {
      matchNumber: body.matchNumber,
      assignedTeams: assigned.length,
      underfilledReason: body.underfilledReason ?? null,
      shiftedMatchIds: shifted
    });
    return shifted;
  });
  return reply.code(201).send({
    id: matchId, matchNumber: body.matchNumber, teamCount: assigned.length,
    underfilled: assigned.length < 4, shiftedMatchIds
  });
});

app.patch('/api/admin/matches/:matchId/schedule', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    arenaName: z.string().trim().min(1).max(80),
    scheduledStart: z.string().datetime({ offset: true }),
    underfilledReason: z.string().trim().min(1).max(500).optional(),
    positions: z.array(z.object({
      number: z.number().int().min(1).max(4),
      label: z.string().trim().min(1).max(80),
      teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional()
    })).length(4)
  }).parse(request.body);
  if (new Set(body.positions.map((position) => position.number)).size !== 4) {
    return reply.code(400).send({ error: 'Each arena position must appear exactly once' });
  }
  const assigned = body.positions.filter((position) => position.teamCode);
  if (assigned.length === 0) return reply.code(400).send({ error: 'A match must have at least one team' });
  if (assigned.length < 4 && !body.underfilledReason) {
    return reply.code(400).send({ error: 'Matches with fewer than four teams require an underfilled reason' });
  }
  const outcome = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
    const competitionId = initial.rows[0].competition_id;
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
    const locked = await client.query<{
      state: string; match_number: number; duration_seconds: number; planned_gap_seconds: number;
    }>(
      'SELECT state, match_number, duration_seconds, planned_gap_seconds FROM matches WHERE id = $1 FOR UPDATE',
      [matchId]
    );
    const match = locked.rows[0];
    if (!match) return { status: 404, error: 'Match not found' };
    if (!['scheduled', 'ready', 'delayed'].includes(match.state)) {
      return { status: 409, error: `Cannot edit a ${match.state} match` };
    }
    const teamIds = new Map<string, string>();
    const cornerColours = await getCornerColours(client, competitionId);
    for (const position of assigned) {
      const team = await client.query<{ id: string }>(
        'SELECT id FROM teams WHERE competition_id = $1 AND code = $2 AND active = true',
        [competitionId, position.teamCode]
      );
      if (!team.rows[0]) return { status: 400, error: `Unknown or inactive team code: ${position.teamCode}` };
      if ([...teamIds.values()].includes(team.rows[0].id)) {
        return { status: 400, error: `Team ${position.teamCode} is assigned more than once` };
      }
      teamIds.set(position.teamCode!, team.rows[0].id);
    }
    const delayTotal = await client.query<{ seconds: number }>(
      `SELECT greatest(0, ceil(extract(epoch FROM (effective_start - scheduled_start))))::int AS seconds
       FROM matches WHERE id = $1`,
      [matchId]
    );
    const scheduledStart = new Date(body.scheduledStart);
    const effectiveStart = new Date(scheduledStart.getTime() + delayTotal.rows[0]!.seconds * 1000);
    await client.query(
      `UPDATE matches SET arena_name = $2, scheduled_start = $3, effective_start = $4,
         start_mode = 'manual', countdown_started_at = NULL,
         state = CASE WHEN $5::int > 0 THEN 'delayed' ELSE 'scheduled' END,
         underfilled_acknowledged_by = CASE WHEN $6::int < 4 THEN $7 ELSE NULL END,
         underfilled_reason = $8, revision = revision + 1
       WHERE id = $1`,
      [matchId, body.arenaName, scheduledStart, effectiveStart,
        delayTotal.rows[0]!.seconds, assigned.length, adminEmail(request),
        assigned.length < 4 ? body.underfilledReason : null]
    );
    await client.query('DELETE FROM match_positions WHERE match_id = $1', [matchId]);
    for (const position of body.positions) {
      await client.query(
        `INSERT INTO match_positions (match_id, position_number, position_label, colour, team_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [matchId, position.number, position.label, cornerColours[position.number - 1]!,
          position.teamCode ? teamIds.get(position.teamCode) : null]
      );
    }
    const later = await client.query<{
      id: string; effective_start: Date; duration_seconds: number; planned_gap_seconds: number;
    }>(
      `SELECT id, effective_start, duration_seconds, planned_gap_seconds FROM matches
       WHERE competition_id = $1 AND arena_name = $2 AND id <> $3
         AND (scheduled_start, match_number) > ($4, $5)
         AND state IN ('scheduled', 'ready', 'delayed')
       ORDER BY scheduled_start, match_number FOR UPDATE`,
      [competitionId, body.arenaName, matchId, scheduledStart, match.match_number]
    );
    let projectedStart = new Date(
      effectiveStart.getTime() + (match.duration_seconds + match.planned_gap_seconds) * 1000
    );
    const shiftedIds: string[] = [];
    for (const next of later.rows) {
      const priorStart = new Date(next.effective_start);
      const newStart = priorStart.getTime() < projectedStart.getTime() ? projectedStart : priorStart;
      if (newStart.getTime() > priorStart.getTime()) {
        await client.query(
          `UPDATE matches SET effective_start = $2, state = 'delayed', revision = revision + 1 WHERE id = $1`,
          [next.id, newStart]
        );
        shiftedIds.push(next.id);
        await audit(client, adminEmail(request), 'match.schedule_cascaded', 'match', next.id, {
          causedByMatchId: matchId,
          effectiveStart: newStart.toISOString()
        });
      }
      projectedStart = new Date(
        newStart.getTime() + (next.duration_seconds + next.planned_gap_seconds) * 1000
      );
    }
    const eventShiftedIds = await shiftScheduledMatchesAroundEvents(
      client, competitionId, adminEmail(request), `match #${match.match_number} edited`
    );
    const allShiftedIds = [...new Set([...shiftedIds, ...eventShiftedIds])];
    await audit(client, adminEmail(request), 'match.schedule_updated', 'match', matchId, {
      ...body,
      shiftedMatchIds: allShiftedIds
    });
    return { status: 200, ok: true, shiftedMatchIds: allShiftedIds };
  });
  return reply.code(outcome.status).send(outcome);
});

app.delete('/api/admin/matches/:matchId', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const { confirmation } = z.object({ confirmation: z.string().trim().regex(/^\d+$/) }).parse(request.body);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404 as const, error: 'Match not found' };
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
    const matchResult = await client.query<{ match_number: number; state: string; arena_name: string }>(
      'SELECT match_number, state, arena_name FROM matches WHERE id = $1 FOR UPDATE',
      [matchId]
    );
    const match = matchResult.rows[0];
    if (!match) return { status: 404 as const, error: 'Match not found' };
    if (String(match.match_number) !== confirmation) {
      return { status: 400 as const, error: 'Match number confirmation does not match' };
    }
    if (match.state === 'running' || match.state === 'paused') {
      return { status: 409 as const, error: 'Finish or reset the active match before deleting it' };
    }
    await client.query('DELETE FROM score_revisions WHERE match_id = $1', [matchId]);
    await audit(client, adminEmail(request), 'match.deleted', 'match', matchId, {
      matchNumber: match.match_number,
      arenaName: match.arena_name,
      priorState: match.state,
      scoresDeleted: true
    });
    await client.query('DELETE FROM matches WHERE id = $1', [matchId]);
    return { status: 204 as const };
  });
  if (result.status !== 204) return reply.code(result.status).send({ error: result.error });
  return reply.code(204).send();
});

app.post('/api/admin/matches/:matchId/delay', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    delaySeconds: z.number().int().positive().max(86400),
    reason: z.string().trim().min(1).max(500)
  }).parse(request.body);
  await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) {
      const error = new Error('Match not found');
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
    const current = await client.query<{
      arena_name: string;
      state: string;
      match_number: number;
      effective_start: Date;
      duration_seconds: number;
      planned_gap_seconds: number;
    }>(
      `SELECT arena_name, state, match_number, effective_start, duration_seconds, planned_gap_seconds
       FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = current.rows[0];
    if (!match) {
      const error = new Error('Match not found');
      Object.assign(error, { statusCode: 404 });
      throw error;
    }
    if (match.state === 'running' || match.state === 'paused' || match.state === 'complete' || match.state === 'cancelled') {
      const error = new Error(`Cannot delay a ${match.state} match`);
      Object.assign(error, { statusCode: 409 });
      throw error;
    }
    const moved = await client.query<{ effective_start: Date }>(
      `UPDATE matches
       SET effective_start = effective_start + ($2 * interval '1 second'),
           countdown_started_at = NULL,
           state = 'delayed', revision = revision + 1
       WHERE id = $1 RETURNING effective_start`,
      [matchId, body.delaySeconds]
    );
    await client.query(
      `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), matchId, adminEmail(request), body.reason, body.delaySeconds]
    );
    const shifted = await delayNextMatchesAfterManualStart(
      client,
      initial.rows[0].competition_id,
      match.arena_name,
      matchId,
      match.match_number,
      new Date(match.effective_start),
      new Date(moved.rows[0]!.effective_start),
      match.duration_seconds,
      adminEmail(request),
      `manual delay: ${body.reason}`
    );
    await audit(client, adminEmail(request), 'match.delayed', 'match', matchId, {
      ...body,
      shiftedMatchIds: shifted
    });
  });
  return reply.code(200).send({ ok: true });
});

app.post('/api/admin/matches/:matchId/undelay', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    delaySeconds: z.number().int().positive().max(86400).optional(),
    restoreScheduled: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500)
  }).refine((value) => value.restoreScheduled
    ? value.delaySeconds === undefined
    : value.delaySeconds !== undefined, {
    message: 'Choose either a delay reduction or restoration to the scheduled time'
  }).parse(request.body);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404 as const, error: 'Match not found' };
    const competitionId = initial.rows[0].competition_id;
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competitionId]);
    const locked = await client.query<{
      arena_name: string;
      match_number: number;
      state: string;
      scheduled_start: Date;
      effective_start: Date;
      duration_seconds: number;
      planned_gap_seconds: number;
      countdown_started_at: Date | null;
    }>(
      `SELECT arena_name, match_number, state, scheduled_start, effective_start,
              duration_seconds, planned_gap_seconds, countdown_started_at
       FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = locked.rows[0];
    if (!match) return { status: 404 as const, error: 'Match not found' };
    if (!['scheduled', 'ready', 'delayed'].includes(match.state) ||
        match.countdown_started_at !== null) {
      return { status: 409 as const, error: 'Only an upcoming match without an active countdown can be undelayed' };
    }
    const scheduledStart = new Date(match.scheduled_start);
    const currentStart = new Date(match.effective_start);
    let reduction: ReturnType<typeof calculateDelayReduction>;
    try {
      reduction = calculateDelayReduction(
        scheduledStart.getTime(),
        currentStart.getTime(),
        body.delaySeconds,
        body.restoreScheduled
      );
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { status: 409 as const, error: error.message };
    }
    const { reductionSeconds, remainingDelaySeconds } = reduction;
    const nextStart = new Date(reduction.effectiveStart);
    const conflicts = await client.query<{ match_number: number; starts_at: Date }>(
      `SELECT match_number, starts_at FROM (
         SELECT m.match_number,
                CASE WHEN m.state IN ('running', 'paused')
                     THEN coalesce(m.actual_start, m.effective_start)
                     ELSE m.effective_start END AS starts_at,
                m.duration_seconds, m.state
         FROM matches m
         WHERE m.competition_id = $1 AND m.arena_name = $2 AND m.id <> $3
           AND m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
         UNION ALL
         SELECT pm.match_number, pm.effective_start AS starts_at,
                pm.duration_seconds, pm.timer_state AS state
         FROM playoff_matches pm
         JOIN playoff_brackets pb ON pb.id = pm.bracket_id
         WHERE pb.competition_id = $1 AND pb.status = 'active' AND pm.arena_name = $2
           AND pm.schedule_state = 'scheduled'
       ) arena_matches
       WHERE (state = 'paused' AND starts_at < $4::timestamptz +
                 make_interval(secs => $5::int))
          OR (state <> 'paused'
              AND starts_at < $4::timestamptz + make_interval(secs => $5::int)
              AND starts_at + make_interval(secs => duration_seconds) > $4)
       ORDER BY starts_at`,
      [competitionId, match.arena_name, matchId, nextStart, match.duration_seconds]
    );
    if (conflicts.rows.length > 0) {
      const conflict = conflicts.rows[0]!;
      return {
        status: 409 as const,
        error: `Cannot move match #${match.match_number} earlier; it would conflict with match #${conflict.match_number} in ${match.arena_name}`
      };
    }
    const eventConflict = await client.query<{ title: string }>(
      `SELECT title FROM competition_events
       WHERE competition_id = $1
         AND starts_at < $2::timestamptz + make_interval(secs => $3::int)
         AND starts_at + make_interval(mins => duration_minutes) > $2
       ORDER BY starts_at LIMIT 1`,
      [competitionId, nextStart, match.duration_seconds]
    );
    if (eventConflict.rows[0]) {
      return {
        status: 409 as const,
        error: `Cannot move match #${match.match_number} earlier; it would overlap the scheduled event "${eventConflict.rows[0].title}"`
      };
    }
    await client.query(
      `UPDATE matches SET effective_start = $2,
         state = CASE WHEN $2 > scheduled_start THEN 'delayed' ELSE 'scheduled' END,
         revision = revision + 1
       WHERE id = $1`,
      [matchId, nextStart]
    );
    await audit(client, adminEmail(request), 'match.delay_reduced', 'match', matchId, {
      reason: body.reason,
      reductionSeconds,
      previousDelaySeconds: remainingDelaySeconds + reductionSeconds,
      remainingDelaySeconds,
      restoredToScheduledTime: body.restoreScheduled,
      effectiveStart: nextStart.toISOString()
    });
    return {
      status: 200 as const,
      ok: true,
      reductionSeconds,
      remainingDelaySeconds,
      effectiveStart: nextStart.toISOString()
    };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/competitions/:slug/undelay-all', { preHandler: requireAdmin }, async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition) return reply.code(404).send({ error: 'Competition not found' });

  const result = await transaction(async (client) => {
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
    const leagueTargets = await client.query<{
      id: string;
      match_number: number;
      arena_name: string;
      scheduled_start: Date;
      effective_start: Date;
      duration_seconds: number;
    }>(
      `SELECT id, match_number, arena_name, scheduled_start, effective_start, duration_seconds
       FROM matches
       WHERE competition_id = $1
         AND state IN ('scheduled', 'ready', 'delayed')
         AND countdown_started_at IS NULL
         AND effective_start > scheduled_start
         AND scheduled_start > now()
       ORDER BY scheduled_start, match_number
       FOR UPDATE`,
      [competition.id]
    );
    const playoffTargets = await client.query<{
      id: string;
      match_number: number;
      arena_name: string;
      scheduled_start: Date;
      effective_start: Date;
      duration_seconds: number;
    }>(
      `SELECT pm.id, pm.match_number, pm.arena_name, pm.scheduled_start,
              pm.effective_start, pm.duration_seconds
       FROM playoff_matches pm
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pb.competition_id = $1 AND pb.status = 'active'
         AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
         AND pm.countdown_started_at IS NULL
         AND pm.effective_start > pm.scheduled_start
         AND pm.scheduled_start > now()
       ORDER BY pm.scheduled_start, pm.match_number
       FOR UPDATE OF pm`,
      [competition.id]
    );
    type Target = {
      id: string;
      kind: 'league' | 'playoff';
      matchNumber: number;
      arenaName: string;
      scheduledStart: Date;
      previousStart: Date;
      durationSeconds: number;
    };
    const targets: Target[] = [
      ...leagueTargets.rows.map((match) => ({
        id: match.id,
        kind: 'league' as const,
        matchNumber: match.match_number,
        arenaName: match.arena_name,
        scheduledStart: new Date(match.scheduled_start),
        previousStart: new Date(match.effective_start),
        durationSeconds: match.duration_seconds
      })),
      ...playoffTargets.rows.map((match) => ({
        id: match.id,
        kind: 'playoff' as const,
        matchNumber: match.match_number,
        arenaName: match.arena_name,
        scheduledStart: new Date(match.scheduled_start),
        previousStart: new Date(match.effective_start),
        durationSeconds: match.duration_seconds
      }))
    ].sort((left, right) =>
      left.scheduledStart.getTime() - right.scheduledStart.getTime() ||
      left.arenaName.localeCompare(right.arenaName) ||
      left.matchNumber - right.matchNumber
    );
    if (targets.length === 0) {
      const past = await client.query<{ count: number }>(
        `SELECT (
           (SELECT count(*) FROM matches
            WHERE competition_id = $1 AND state IN ('scheduled', 'ready', 'delayed')
              AND countdown_started_at IS NULL
              AND effective_start > scheduled_start AND scheduled_start <= now())
           +
           (SELECT count(*) FROM playoff_matches pm
            JOIN playoff_brackets pb ON pb.id = pm.bracket_id
            WHERE pb.competition_id = $1 AND pb.status = 'active'
              AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
              AND pm.countdown_started_at IS NULL
              AND pm.effective_start > pm.scheduled_start AND pm.scheduled_start <= now())
         )::int AS count`,
        [competition.id]
      );
      return { status: 200 as const, restored: 0, skipped: [], skippedPast: past.rows[0]?.count ?? 0 };
    }

    const leagueTargetIds = leagueTargets.rows.map((match) => match.id);
    const playoffTargetIds = playoffTargets.rows.map((match) => match.id);
    const fixed = await client.query<{
      kind: 'league' | 'playoff';
      id: string;
      match_number: number;
      arena_name: string;
      starts_at: Date;
      duration_seconds: number;
      state: string;
    }>(
      `SELECT 'league'::text AS kind, m.id, m.match_number, m.arena_name,
              CASE WHEN m.state IN ('running', 'paused')
                   THEN coalesce(m.actual_start, m.effective_start)
                   ELSE m.effective_start END AS starts_at,
              m.duration_seconds, m.state
       FROM matches m
       WHERE m.competition_id = $1
         AND m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused')
         AND NOT (m.id = ANY($2::uuid[]))
       UNION ALL
       SELECT 'playoff'::text AS kind, pm.id, pm.match_number, pm.arena_name,
              CASE WHEN pm.timer_state IN ('running', 'paused')
                   THEN coalesce(pm.actual_start, pm.effective_start)
                   ELSE pm.effective_start END AS starts_at,
              pm.duration_seconds, pm.timer_state AS state
       FROM playoff_matches pm
       JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       WHERE pb.competition_id = $1 AND pb.status = 'active'
         AND pm.schedule_state = 'scheduled'
         AND NOT (pm.id = ANY($3::uuid[]))`,
      [competition.id, leagueTargetIds, playoffTargetIds]
    );
    const events = await client.query<{ title: string; starts_at: Date; duration_minutes: number }>(
      'SELECT title, starts_at, duration_minutes FROM competition_events WHERE competition_id = $1',
      [competition.id]
    );
    const overlaps = (leftStart: number, leftDuration: number, rightStart: number, rightDuration: number) =>
      leftStart < rightStart + rightDuration && rightStart < leftStart + leftDuration;
    const skipped: Array<{ kind: Target['kind']; matchNumber: number; reason: string }> = [];
    const restored: Target[] = [];
    const retained: Array<{ target: Target; start: number }> = [];
    const skip = (target: Target, reason: string) => {
      skipped.push({ kind: target.kind, matchNumber: target.matchNumber, reason });
      retained.push({ target, start: target.previousStart.getTime() });
    };
    for (const target of targets) {
      const proposedStart = target.scheduledStart.getTime();
      const activeConflict = fixed.rows.find((match) => {
        if (match.arena_name !== target.arenaName || !['running', 'paused'].includes(match.state)) {
          return false;
        }
        if (match.state === 'paused') return proposedStart + target.durationSeconds * 1000 > new Date(match.starts_at).getTime();
        return overlaps(
          proposedStart,
          target.durationSeconds * 1000,
          new Date(match.starts_at).getTime(),
          match.duration_seconds * 1000
        );
      });
      if (activeConflict) {
        skip(target, `Arena ${target.arenaName} has an active match`);
        continue;
      }
      const matchConflict = fixed.rows.find((match) =>
        match.arena_name === target.arenaName &&
        overlaps(
          proposedStart,
          target.durationSeconds * 1000,
          new Date(match.starts_at).getTime(),
          match.duration_seconds * 1000
        )
      );
      if (matchConflict) {
        skip(target, `Would overlap ${matchConflict.kind} match #${matchConflict.match_number} in ${target.arenaName}`);
        continue;
      }
      const restoredConflict = restored.find((match) =>
        match.arenaName === target.arenaName &&
        overlaps(
          proposedStart,
          target.durationSeconds * 1000,
          match.scheduledStart.getTime(),
          match.durationSeconds * 1000
        )
      );
      const retainedConflict = retained.find(({ target: match, start }) =>
        match.arenaName === target.arenaName &&
        overlaps(proposedStart, target.durationSeconds * 1000, start, match.durationSeconds * 1000)
      );
      if (restoredConflict || retainedConflict) {
        const conflict = restoredConflict
          ? { kind: restoredConflict.kind, matchNumber: restoredConflict.matchNumber }
          : { kind: retainedConflict!.target.kind, matchNumber: retainedConflict!.target.matchNumber };
        skip(target, `Would overlap ${conflict.kind} match #${conflict.matchNumber} in ${target.arenaName}`);
        continue;
      }
      const eventConflict = events.rows.find((event) =>
        overlaps(
          proposedStart,
          target.durationSeconds * 1000,
          new Date(event.starts_at).getTime(),
          event.duration_minutes * 60_000
        )
      );
      if (eventConflict) {
        skip(target, `Would overlap scheduled event "${eventConflict.title}"`);
        continue;
      }
      restored.push(target);
    }

    for (const target of restored) {
      if (target.kind === 'league') {
        await client.query(
          `UPDATE matches SET effective_start = scheduled_start, state = 'scheduled',
             revision = revision + 1 WHERE id = $1`,
          [target.id]
        );
      } else {
        await client.query(
          'UPDATE playoff_matches SET effective_start = scheduled_start WHERE id = $1',
          [target.id]
        );
      }
      await audit(client, adminEmail(request), 'match.delay_restored', target.kind === 'league' ? 'match' : 'playoff_match', target.id, {
        matchNumber: target.matchNumber,
        previousEffectiveStart: target.previousStart.toISOString(),
        restoredStart: target.scheduledStart.toISOString(),
        reason: 'Bulk restore to original scheduled time'
      });
    }
    const past = await client.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM matches
          WHERE competition_id = $1 AND state IN ('scheduled', 'ready', 'delayed')
            AND countdown_started_at IS NULL
            AND effective_start > scheduled_start AND scheduled_start <= now())
         +
         (SELECT count(*) FROM playoff_matches pm
          JOIN playoff_brackets pb ON pb.id = pm.bracket_id
          WHERE pb.competition_id = $1 AND pb.status = 'active'
            AND pm.schedule_state = 'scheduled' AND pm.timer_state = 'scheduled'
            AND pm.countdown_started_at IS NULL
            AND pm.effective_start > pm.scheduled_start AND pm.scheduled_start <= now())
       )::int AS count`,
      [competition.id]
    );
    await audit(client, adminEmail(request), 'competition.delays_restored', 'competition', competition.id, {
      restoredCount: restored.length,
      skippedCount: skipped.length,
      skippedPastCount: past.rows[0]?.count ?? 0
    });
    return {
      status: 200 as const,
      restored: restored.length,
      skipped,
      skippedPast: past.rows[0]?.count ?? 0
    };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/matches/:matchId/start', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
    const matchResult = await client.query<{
      competition_id: string;
      arena_name: string;
      state: string;
      countdown_started_at: Date | null;
    }>(
      `SELECT competition_id, arena_name, state, countdown_started_at
       FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = matchResult.rows[0];
    if (!match) return { status: 404, error: 'Match not found' };
    if (!['scheduled', 'ready', 'delayed'].includes(match.state)) {
      return { status: 409, error: `Cannot start a ${match.state} match` };
    }
    if (match.countdown_started_at) {
      return { status: 409, error: 'This match is already counting down' };
    }
    const populated = await client.query<{ team_count: number }>(
      'SELECT count(team_id)::int AS team_count FROM match_positions WHERE match_id = $1',
      [matchId]
    );
    if ((populated.rows[0]?.team_count ?? 0) === 0) {
      return { status: 409, error: 'Cannot start a match with no assigned teams' };
    }
    const active = await client.query(
      `SELECT 1 FROM matches WHERE competition_id = $1 AND arena_name = $2
       AND id <> $3 AND (
         state IN ('running', 'paused')
         OR (countdown_started_at > now() - ($4 * interval '1 second')
             AND state IN ('scheduled', 'ready', 'delayed'))
       ) LIMIT 1`,
      [match.competition_id, match.arena_name, matchId, MATCH_COUNTDOWN_TOTAL_SECONDS + 2]
    );
    if (active.rowCount) return { status: 409, error: 'Another match is already active in this arena' };
    if (await hasTeamInActiveMatch(client, match.competition_id, matchId)) {
      return { status: 409, error: 'A team in this match is already active in another arena' };
    }
    const countdown = await client.query<{ countdown_started_at: Date }>(
      `UPDATE matches SET countdown_started_at = now(), revision = revision + 1
       WHERE id = $1 RETURNING countdown_started_at`,
      [matchId]
    );
    await audit(client, adminEmail(request), 'match.countdown_started', 'match', matchId, {
      countdownStartedAt: new Date(countdown.rows[0]!.countdown_started_at).toISOString(),
      durationSeconds: MATCH_COUNTDOWN_TOTAL_SECONDS
    });
    return {
      status: 200,
      ok: true,
      countdownStartedAt: new Date(countdown.rows[0]!.countdown_started_at).toISOString()
    };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/matches/:matchId/cancel-countdown', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
    const cancelled = await client.query<{ state: string }>(
      `UPDATE matches SET countdown_started_at = NULL, revision = revision + 1
       WHERE id = $1 AND countdown_started_at IS NOT NULL
         AND state IN ('scheduled', 'ready', 'delayed')
       RETURNING state`,
      [matchId]
    );
    if (!cancelled.rows[0]) return { status: 409, error: 'There is no active countdown to cancel' };
    await audit(client, adminEmail(request), 'match.countdown_cancelled', 'match', matchId);
    return { status: 200, ok: true };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/matches/:matchId/finish', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const match = await client.query<{ state: string }>(
      'SELECT state FROM matches WHERE id = $1 FOR UPDATE',
      [matchId]
    );
    const row = match.rows[0];
    if (!row) return { status: 404, error: 'Match not found' };
    if (row.state !== 'running' && row.state !== 'paused') {
      return { status: 409, error: `Cannot finish a ${row.state} match` };
    }
    await client.query(
      `UPDATE matches SET state = 'awaiting_score', actual_end = now(), revision = revision + 1 WHERE id = $1`,
      [matchId]
    );
    await audit(client, adminEmail(request), 'match.finished', 'match', matchId);
    return { status: 200, ok: true };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/matches/:matchId/pause', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const match = await client.query<{ state: string }>(
      'SELECT state FROM matches WHERE id = $1 FOR UPDATE',
      [matchId]
    );
    const row = match.rows[0];
    if (!row) return { status: 404, error: 'Match not found' };
    if (row.state !== 'running') return { status: 409, error: `Cannot pause a ${row.state} match` };
    await client.query(
      `UPDATE matches SET state = 'paused', paused_at = now(), revision = revision + 1 WHERE id = $1`,
      [matchId]
    );
    await audit(client, adminEmail(request), 'match.paused', 'match', matchId);
    return { status: 200, ok: true };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/matches/:matchId/resume', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404, error: 'Match not found' };
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
    const match = await client.query<{
      state: string;
      arena_name: string;
      match_number: number;
      effective_start: Date;
      actual_start: Date;
      duration_seconds: number;
      planned_gap_seconds: number;
      paused_seconds: number;
      paused_at: Date;
    }>(
      `SELECT state, arena_name, match_number, effective_start, actual_start,
              duration_seconds, planned_gap_seconds, paused_seconds, paused_at
       FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );
    const row = match.rows[0];
    if (!row) return { status: 404, error: 'Match not found' };
    if (row.state !== 'paused') return { status: 409, error: `Cannot resume a ${row.state} match` };
    const resumed = await client.query<{ paused_seconds: number }>(
      `UPDATE matches
       SET state = 'running', paused_seconds = paused_seconds + floor(extract(epoch FROM (now() - paused_at)))::int,
           paused_at = NULL, revision = revision + 1
       WHERE id = $1 RETURNING paused_seconds`,
      [matchId]
    );
    const actualActiveStart = new Date(new Date(row.actual_start).getTime() + resumed.rows[0]!.paused_seconds * 1000);
    const shiftedMatchIds = await delayNextMatchesAfterManualStart(
      client, initial.rows[0].competition_id, row.arena_name, matchId, row.match_number,
      new Date(row.effective_start), actualActiveStart, row.duration_seconds,
      adminEmail(request), 'resume'
    );
    await audit(client, adminEmail(request), 'match.resumed', 'match', matchId, { shiftedMatchIds });
    return { status: 200, ok: true, shiftedMatchIds };
  });
  return reply.code(result.status).send(result);
});

app.post('/api/admin/matches/:matchId/reset', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const result = await transaction(async (client) => {
    const initial = await client.query<{ competition_id: string }>(
      'SELECT competition_id FROM matches WHERE id = $1',
      [matchId]
    );
    if (!initial.rows[0]) return { status: 404 as const, error: 'Match not found' };
    await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [initial.rows[0].competition_id]);
    const matchResult = await client.query<{
      match_number: number;
      arena_name: string;
      state: string;
      scheduled_start: Date;
      effective_start: Date;
      duration_seconds: number;
    }>(
      `SELECT match_number, arena_name, state, scheduled_start, effective_start, duration_seconds
       FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );
    const match = matchResult.rows[0];
    if (!match) return { status: 404 as const, error: 'Match not found' };
    if (!['running', 'paused', 'awaiting_score'].includes(match.state)) {
      return { status: 409 as const, error: `Cannot reset a ${match.state} match` };
    }
    const scores = await client.query('SELECT 1 FROM match_scores WHERE match_id = $1 LIMIT 1', [matchId]);
    if (scores.rowCount) return { status: 409 as const, error: 'A match with saved scores cannot be reset' };
    const resetAt = new Date(calculateTimerResetStart(
      new Date(match.scheduled_start).getTime(),
      new Date(match.effective_start).getTime(),
      Date.now()
    ));
    const nextState = resetAt.getTime() > new Date(match.scheduled_start).getTime()
      ? 'delayed' : 'scheduled';
    const reset = await client.query<{ effective_start: Date }>(
      `UPDATE matches
       SET state = $2,
           effective_start = $3,
           actual_start = NULL, actual_end = NULL, paused_at = NULL, paused_seconds = 0,
           countdown_started_at = NULL,
           revision = revision + 1
       WHERE id = $1
       RETURNING effective_start`,
      [matchId, nextState, resetAt]
    );
    const effectiveStart = new Date(reset.rows[0]!.effective_start);
    const delaySeconds = Math.max(0, Math.ceil(
      (effectiveStart.getTime() - new Date(match.effective_start).getTime()) / 1000
    ));
    if (delaySeconds > 0) {
      await client.query(
        `INSERT INTO match_delays (id, match_id, actor_email, reason, delay_seconds)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), matchId, adminEmail(request), 'Timer reset; match rescheduled only as needed', delaySeconds]
      );
    }
    const shiftedMatchIds = await delayNextMatchesAfterManualStart(
      client, initial.rows[0].competition_id, match.arena_name, matchId, match.match_number,
      new Date(match.effective_start), effectiveStart, match.duration_seconds,
      adminEmail(request), 'timer reset'
    );
    await audit(client, adminEmail(request), 'match.timer_reset', 'match', matchId, {
      matchNumber: match.match_number,
      resetAt: effectiveStart.toISOString(),
      preservedExistingSlot: effectiveStart.getTime() === new Date(match.effective_start).getTime(),
      shiftedMatchIds
    });
    return {
      status: 200 as const,
      ok: true,
      effectiveStart: effectiveStart.toISOString(),
      preservedExistingSlot: effectiveStart.getTime() === new Date(match.effective_start).getTime(),
      shiftedMatchIds
    };
  });
  return reply.code(result.status).send(result);
});

app.get('/api/admin/matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const match = await pool.query('SELECT id FROM matches WHERE id = $1', [matchId]);
  if (!match.rowCount) return reply.code(404).send({ error: 'Match not found' });
  const scores = await pool.query(
    `SELECT t.code AS team_code, ms.result, ms.league_points, ms.revision, ms.updated_at, ms.updated_by
     FROM match_scores ms JOIN teams t ON t.id = ms.team_id
     WHERE ms.match_id = $1 ORDER BY t.code`,
    [matchId]
  );
  return scores.rows;
});

app.post('/api/admin/matches/:matchId/scores', { preHandler: requireAdmin }, async (request, reply) => {
  const { matchId } = z.object({ matchId: z.string().uuid() }).parse(request.params);
  const body = z.object({
    reason: z.string().trim().min(1).max(500).optional(),
    scores: z.array(z.object({
      teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
      result: z.record(z.unknown()).optional(),
      leaguePoints: z.number().finite()
    })).min(1).max(4)
  }).parse(request.body);
  const result = await transaction(async (client) => {
    const match = await client.query<{ competition_id: string; state: string }>(
      `SELECT competition_id, state FROM matches WHERE id = $1 FOR UPDATE`,
      [matchId]
    );
    const row = match.rows[0];
    if (!row) return { status: 404, error: 'Match not found' };
    if (row.state !== 'awaiting_score' && row.state !== 'complete') {
      return { status: 409, error: 'Finish the match before entering scores' };
    }
    const seen = new Set<string>();
    const assignments = await client.query<{ id: string; code: string }>(
      `SELECT t.id, t.code FROM match_positions mp JOIN teams t ON t.id = mp.team_id
       WHERE mp.match_id = $1`,
      [matchId]
    );
    const teamByCode = new Map(assignments.rows.map((team) => [team.code, team.id]));
    if (body.scores.length !== assignments.rowCount) {
      return { status: 400, error: 'Enter exactly one score for every team assigned to the match' };
    }
    const existingScores = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM match_scores WHERE match_id = $1',
      [matchId]
    );
    if ((existingScores.rows[0]?.count ?? 0) > 0 && !body.reason) {
      return { status: 400, error: 'A reason is required when correcting existing scores' };
    }
    for (const score of body.scores) {
      if (seen.has(score.teamCode)) return { status: 400, error: `Duplicate score for ${score.teamCode}` };
      if (!teamByCode.has(score.teamCode)) {
        return { status: 400, error: `${score.teamCode} is not assigned to this match` };
      }
      seen.add(score.teamCode);
    }
    for (const score of body.scores) {
      const teamId = teamByCode.get(score.teamCode);
      if (!teamId) throw new Error(`Validated match team ${score.teamCode} disappeared`);
      const prior = await client.query<{ result: unknown; league_points: string }>(
        'SELECT result, league_points FROM match_scores WHERE match_id = $1 AND team_id = $2',
        [matchId, teamId]
      );
      if (prior.rows[0]) {
        await client.query(
          `INSERT INTO score_revisions (id, match_id, team_id, result, league_points, reason, actor_email)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [randomUUID(), matchId, teamId, JSON.stringify(prior.rows[0].result), prior.rows[0].league_points, body.reason ?? 'Score correction', adminEmail(request)]
        );
      }
      await client.query(
        `INSERT INTO match_scores (match_id, team_id, result, league_points, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (match_id, team_id) DO UPDATE
         SET result = EXCLUDED.result, league_points = EXCLUDED.league_points,
             updated_by = EXCLUDED.updated_by, updated_at = now(),
             revision = match_scores.revision + 1`,
        [matchId, teamId, JSON.stringify(score.result ?? prior.rows[0]?.result ?? {}), score.leaguePoints, adminEmail(request)]
      );
    }
    await client.query(
      `UPDATE matches SET state = 'complete', revision = revision + 1 WHERE id = $1`,
      [matchId]
    );
    await audit(client, adminEmail(request), 'match.scored', 'match', matchId, { entries: body.scores.length });
    await refreshUnstartedPlayoffSeeds(client, row.competition_id, adminEmail(request));
    return { status: 200, ok: true };
  });
  return reply.code(result.status).send(result);
});

app.get('/public/v1/:slug/league', async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return reply.code(404).send({ error: 'Competition not found' });
  }
  const result = { rows: await fetchStandings(pool, competition.id) };
  reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=10');
  return { competition: competition.name, updatedAt: new Date().toISOString(), standings: result.rows };
});

app.get('/embed/:slug/league', async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return reply.code(404).send('Competition not found');
  }
  const result = { rows: await fetchStandings(pool, competition.id) };
  const rows = result.rows.map((team, index) =>
    `<tr><td>${index + 1}</td><th scope="row"><span class="code">${escapeHtml(team.code)}</span> ${escapeHtml(team.name)}</th><td>${escapeHtml(team.league_points)}</td></tr>`
  ).join('');
  reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=10');
  reply.header('x-content-type-options', 'nosniff');
  return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(competition.name)} — league table</title>
<style>
  :root{color-scheme:light;font:15px/1.45 Inter,"Helvetica Neue",Arial,sans-serif;color:#17242b;background:#fffefa}
  *{box-sizing:border-box}body{margin:0;padding:12px}header{border-bottom:2px solid #d94f2b;padding:4px 8px 10px;margin-bottom:8px}
  h1{font-size:1rem;margin:0;font-weight:700}table{border-collapse:collapse;width:100%;text-align:left}
  th,td{padding:8px;border-bottom:1px solid #d8dcd7}thead{background:#e8ebe6;color:#42525a;font:700 .7rem/1.3 monospace;text-transform:uppercase;letter-spacing:.04em}
  .code{display:inline-block;min-width:3ch;font:700 .8rem/1.4 monospace;color:#a9361d}
  td:last-child{text-align:right;font-variant-numeric:tabular-nums}tbody tr:nth-child(even){background:#f4f4ef}
</style></head><body><header><h1>${escapeHtml(competition.name)} — League table</h1></header>
<table><thead><tr><th scope="col">Rank</th><th scope="col">Team</th><th scope="col">Points</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
});

app.get('/public/v1/:slug/schedule', async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return reply.code(404).send({ error: 'Competition not found' });
  }
  const result = await pool.query(
    `SELECT m.id, m.match_number, m.arena_name, m.scheduled_start, m.effective_start,
            m.duration_seconds, m.state, m.countdown_started_at, count(mp.team_id)::int AS team_count,
            (SELECT count(*)::int FROM match_delays d WHERE d.match_id = m.id) AS delay_count,
            (SELECT jsonb_agg(jsonb_build_object(
              'reason', d.reason, 'seconds', d.delay_seconds, 'createdAt', d.created_at
            ) ORDER BY d.created_at) FROM match_delays d WHERE d.match_id = m.id) AS delays,
            jsonb_agg(jsonb_build_object(
              'position', mp.position_number, 'spot', mp.position_number - 1,
              'label', mp.position_label, 'colour', mp.colour,
              'teamCode', t.code, 'teamName', t.name
            ) ORDER BY mp.position_number) AS positions
     FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
     LEFT JOIN teams t ON t.id = mp.team_id
     WHERE m.competition_id = $1
     GROUP BY m.id ORDER BY m.scheduled_start, m.match_number`,
    [competition.id]
  );
  const events = await pool.query(
    `SELECT id, title, description, location, starts_at, duration_minutes
     FROM competition_events WHERE competition_id = $1 ORDER BY starts_at, title`,
    [competition.id]
  );
  const playoffs = await pool.query(
    `SELECT pm.id, pm.match_number, pm.arena_name, pm.scheduled_start, pm.effective_start,
            pm.duration_seconds, pm.status, pm.bracket_side, pm.round_number, pm.schedule_state,
            ((pm.source_one <> 'bye')::int + (pm.source_two <> 'bye')::int +
             (pm.source_three <> 'bye')::int + (pm.source_four <> 'bye')::int) AS entrant_count,
            jsonb_build_array(
              jsonb_build_object('position',1,'spot',0,'teamCode',t1.code,'teamName',t1.name),
              jsonb_build_object('position',2,'spot',1,'teamCode',t2.code,'teamName',t2.name),
              jsonb_build_object('position',3,'spot',2,'teamCode',t3.code,'teamName',t3.name),
              jsonb_build_object('position',4,'spot',3,'teamCode',t4.code,'teamName',t4.name)
            ) AS positions
     FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     LEFT JOIN teams t1 ON t1.id = pm.team_one_id
     LEFT JOIN teams t2 ON t2.id = pm.team_two_id
     LEFT JOIN teams t3 ON t3.id = pm.team_three_id
     LEFT JOIN teams t4 ON t4.id = pm.team_four_id
     WHERE pb.competition_id = $1 AND pb.status IN ('active', 'complete')
     ORDER BY pm.effective_start, pm.match_number`,
    [competition.id]
  );
  const matchItems = result.rows.map((match) => ({
    ...match,
    type: 'match' as const,
    underfilled: Number(match.team_count) < 4,
    warning: Number(match.team_count) < 4 ? `UNDERFILLED (${match.team_count}/4)` : null,
    positions: match.positions.map((position: { teamCode: string | null }) => ({
      ...position,
      vacant: position.teamCode === null
    }))
  }));
  const eventItems = events.rows.map((event) => ({ ...event, type: 'event' as const }));
  const playoffItems = playoffs.rows.map((match) => ({
    ...match,
    type: 'playoff' as const,
    state: match.schedule_state === 'complete' ? 'complete' : match.status,
    team_count: (match.positions as { teamCode: string | null }[]).filter((position) => position.teamCode).length,
    entrant_count: Number(match.entrant_count),
    underfilled: Number(match.entrant_count) < 4,
    warning: Number(match.entrant_count) < 4 ? `${match.entrant_count}/4 TEAM HEAT` : null
  }));
  reply.header('cache-control', 'public, max-age=2');
  return {
    competition: competition.name,
    updatedAt: new Date().toISOString(),
    matches: [...matchItems, ...playoffItems],
    events: eventItems,
    items: [...matchItems, ...playoffItems, ...eventItems].sort((a, b) => {
      const aStart = new Date('effective_start' in a ? a.effective_start : a.starts_at).getTime();
      const bStart = new Date('effective_start' in b ? b.effective_start : b.starts_at).getTime();
      return aStart - bStart || Number(a.match_number ?? 0) - Number(b.match_number ?? 0);
    })
  };
});

app.get('/public/v1/:slug/arena/:matchId', async (request, reply) => {
  const { slug, matchId } = z.object({ slug: z.string(), matchId: z.string().uuid() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return reply.code(404).send({ error: 'Competition not found' });
  }
  const result = await pool.query(
    `SELECT m.id, m.match_number, m.arena_name, m.state, m.scheduled_start, m.effective_start,
            count(mp.team_id)::int AS team_count,
            jsonb_agg(jsonb_build_object(
              'position', mp.position_number, 'spot', mp.position_number - 1,
              'label', mp.position_label, 'colour', mp.colour,
              'teamCode', t.code, 'teamName', t.name,
              'vacant', (mp.team_id IS NULL)
            ) ORDER BY mp.position_number) AS positions
     FROM matches m LEFT JOIN match_positions mp ON mp.match_id = m.id
     LEFT JOIN teams t ON t.id = mp.team_id
     WHERE m.competition_id = $1 AND m.id = $2
     GROUP BY m.id`,
    [competition.id, matchId]
  );
  const match = result.rows[0];
  if (!match) return reply.code(404).send({ error: 'Match not found' });
  const count = Number(match.team_count);
  reply.header('cache-control', 'public, max-age=2');
  return { ...match, underfilled: count < 4, warning: count < 4 ? `UNDERFILLED (${count}/4)` : null };
});

app.get('/public/v1/:slug/timer', async (request, reply) => {
  const { slug } = z.object({ slug: z.string() }).parse(request.params);
  const competition = await findCompetition(pool, slug);
  if (!competition || !['published', 'live', 'complete'].includes(competition.status)) {
    return reply.code(404).send({ error: 'Competition not found' });
  }
  const result = await pool.query(
    `WITH timer_matches AS (
       SELECT m.id, m.match_number, m.arena_name, m.state, m.effective_start,
              m.actual_start, m.countdown_started_at, m.duration_seconds, m.paused_at, m.paused_seconds,
              CASE
                WHEN m.state = 'running' THEN greatest(
                  m.duration_seconds - floor(extract(epoch FROM (now() - m.actual_start)))::int + m.paused_seconds, 0
                )
                WHEN m.state = 'paused' THEN greatest(
                  m.duration_seconds - floor(extract(epoch FROM (m.paused_at - m.actual_start)))::int + m.paused_seconds, 0
                )
                WHEN m.countdown_started_at IS NOT NULL THEN greatest(
                  ceil(extract(epoch FROM (m.countdown_started_at + ($2 * interval '1 second') - now())))::int, 0
                )
                WHEN m.state IN ('scheduled', 'ready', 'delayed') THEN greatest(
                  floor(extract(epoch FROM (m.effective_start - now())))::int, 0
                )
                ELSE 0
              END AS seconds_remaining,
              count(mp.team_id)::int AS team_count,
              jsonb_agg(jsonb_build_object(
                'position', mp.position_number, 'spot', mp.position_number - 1,
                'label', mp.position_label, 'colour', mp.colour,
                'teamCode', t.code, 'teamName', t.name, 'vacant', mp.team_id IS NULL
              ) ORDER BY mp.position_number) AS positions
       FROM matches m
       LEFT JOIN match_positions mp ON mp.match_id = m.id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE m.competition_id = $1
         AND m.state IN ('scheduled', 'ready', 'delayed', 'running', 'paused', 'awaiting_score')
       GROUP BY m.id
       UNION ALL
       SELECT pm.id, pm.match_number, pm.arena_name,
              CASE WHEN pm.schedule_state = 'complete' THEN 'complete'
                   WHEN pm.timer_state = 'awaiting_score' THEN 'awaiting_score'
                   WHEN pm.timer_state IN ('running', 'paused') THEN pm.timer_state
                   ELSE pm.status END AS state,
              pm.effective_start, pm.actual_start, pm.countdown_started_at,
              pm.duration_seconds, pm.paused_at, pm.paused_seconds,
              CASE
                WHEN pm.timer_state = 'running' THEN greatest(
                  pm.duration_seconds - floor(extract(epoch FROM (now() - pm.actual_start)))::int + pm.paused_seconds, 0
                )
                WHEN pm.timer_state = 'paused' THEN greatest(
                  pm.duration_seconds - floor(extract(epoch FROM (pm.paused_at - pm.actual_start)))::int + pm.paused_seconds, 0
                )
                WHEN pm.countdown_started_at IS NOT NULL THEN greatest(
                  ceil(extract(epoch FROM (pm.countdown_started_at + ($2 * interval '1 second') - now())))::int, 0
                )
                WHEN pm.timer_state = 'scheduled' THEN greatest(
                  floor(extract(epoch FROM (pm.effective_start - now())))::int, 0
                )
                ELSE 0
              END AS seconds_remaining,
              (pm.team_one_id IS NOT NULL)::int + (pm.team_two_id IS NOT NULL)::int +
                (pm.team_three_id IS NOT NULL)::int + (pm.team_four_id IS NOT NULL)::int AS team_count,
              jsonb_build_array(
                jsonb_build_object('position',1,'spot',0,'label','Position 0','colour',coalesce(settings.corner_colours ->> 0,'#d1495b'),'teamCode',t1.code,'teamName',t1.name,'vacant',pm.team_one_id IS NULL),
                jsonb_build_object('position',2,'spot',1,'label','Position 1','colour',coalesce(settings.corner_colours ->> 1,'#00798c'),'teamCode',t2.code,'teamName',t2.name,'vacant',pm.team_two_id IS NULL),
                jsonb_build_object('position',3,'spot',2,'label','Position 2','colour',coalesce(settings.corner_colours ->> 2,'#edae49'),'teamCode',t3.code,'teamName',t3.name,'vacant',pm.team_three_id IS NULL),
                jsonb_build_object('position',4,'spot',3,'label','Position 3','colour',coalesce(settings.corner_colours ->> 3,'#30638e'),'teamCode',t4.code,'teamName',t4.name,'vacant',pm.team_four_id IS NULL)
              ) AS positions
       FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
       LEFT JOIN competition_settings settings ON settings.competition_id = pb.competition_id
       LEFT JOIN teams t1 ON t1.id = pm.team_one_id
       LEFT JOIN teams t2 ON t2.id = pm.team_two_id
       LEFT JOIN teams t3 ON t3.id = pm.team_three_id
       LEFT JOIN teams t4 ON t4.id = pm.team_four_id
       WHERE pb.competition_id = $1 AND pb.status = 'active'
         AND pm.schedule_state = 'scheduled'
         AND (pm.status = 'ready' OR pm.timer_state IN ('running', 'paused', 'awaiting_score'))
     )
     SELECT * FROM timer_matches
     ORDER BY CASE WHEN countdown_started_at IS NOT NULL THEN 0
                   WHEN state = 'running' THEN 1
                   WHEN state = 'paused' THEN 2
                   WHEN state = 'awaiting_score' THEN 3 ELSE 4 END,
              CASE WHEN countdown_started_at IS NOT NULL THEN countdown_started_at
                   WHEN state IN ('running', 'paused', 'awaiting_score') THEN actual_start
                   ELSE effective_start END,
              match_number LIMIT 1`,
    [competition.id, MATCH_COUNTDOWN_TOTAL_SECONDS]
  );
  reply.header('cache-control', 'no-store');
  const timer = result.rows[0];
  return {
    competition: competition.name,
    updatedAt: new Date().toISOString(),
    timer: timer ? {
      ...timer,
      underfilled: Number(timer.team_count) < 4,
      warning: Number(timer.team_count) < 4 ? `UNDERFILLED (${timer.team_count}/4)` : null
    } : null
  };
});
app.get('/api/admin/audit', { preHandler: requireAdmin }, async () => {
  const result = await pool.query(
    `SELECT id, actor_email, action, entity_type, entity_id, details, created_at
     FROM audit_events ORDER BY created_at DESC LIMIT 200`
  );
  return result.rows;
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const sqlState = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  const status = error instanceof z.ZodError
    ? 400
    : sqlState === '23505'
      ? 409
      : typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
  const errorMessage = error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    : sqlState === '23505'
      ? 'A record with this identifier already exists'
      : error instanceof Error
        ? error.message
        : 'Request failed';
  const message = status >= 500 ? 'The request could not be completed' : errorMessage;
  return reply.code(status).send({ error: message });
});

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('x-server-time', new Date().toISOString());
  return payload;
});

app.addHook('onClose', async () => {
  clearInterval(clockInterval);
  await pool.end();
});

let matchClockProcessing = false;
const clockInterval = setInterval(() => {
  if (matchClockProcessing) return;
  matchClockProcessing = true;
  void processMatchClocks().catch((error: unknown) => {
    app.log.error(error, 'Match clock processing failed');
  }).finally(() => {
    matchClockProcessing = false;
  });
}, 1000);

try {
  await app.listen({ host: '0.0.0.0', port: env.PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
