import type { Pool } from 'pg';


export const schema = `
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
    'league', 'schedule', 'arena', 'timer', 'corner', 'results', 'playoffs', 'knockout', 'custom',
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
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'double-elimination';
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS final_size integer NOT NULL DEFAULT 4;
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS final_byes integer NOT NULL DEFAULT 0;
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS playoff_brackets_format_check;
ALTER TABLE playoff_brackets ADD CONSTRAINT playoff_brackets_format_check
  CHECK (format IN ('double-elimination', 'single-elimination', 'direct-final')
    AND final_size BETWEEN 2 AND 4 AND final_byes >= 0 AND final_byes < final_size);
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS advancing_places integer;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS countdown_restore_start timestamptz;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS scored_at timestamptz;
ALTER TABLE playoff_matches ADD COLUMN IF NOT EXISTS tie_break jsonb;
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

/** Additions for administrator accounts and passkeys (WebAuthn). */
export const authSchema = `
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL DEFAULT '',
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  last_login_method text
);
CREATE TABLE IF NOT EXISTS passkeys (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL DEFAULT 'singleDevice',
  backed_up boolean NOT NULL DEFAULT false,
  name text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys (user_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id text PRIMARY KEY,
  challenge text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'enroll')),
  user_id uuid REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_enrollments (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES admin_users(id) ON DELETE CASCADE;
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'oidc';
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions (user_id);
ALTER TABLE competition_settings ADD COLUMN IF NOT EXISTS staging_close_minutes integer NOT NULL DEFAULT 5
  CHECK (staging_close_minutes BETWEEN 0 AND 60);
ALTER TABLE competition_settings ADD COLUMN IF NOT EXISTS staging_first_lead_minutes integer NOT NULL DEFAULT 10
  CHECK (staging_first_lead_minutes BETWEEN 0 AND 120);
-- Uploaded audio tracks and images (sponsor logos and the like) for displays.
CREATE TABLE IF NOT EXISTS media_files (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('audio', 'image')),
  name text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_files_competition ON media_files (competition_id, kind, created_at);
-- What every audio display should be playing. Positions are derived from started_at on each screen,
-- so all screens agree without the server sending a stream.
CREATE TABLE IF NOT EXISTS audio_playback (
  competition_id uuid PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'stopped' CHECK (mode IN ('stopped', 'playing', 'paused', 'live')),
  playlist uuid[] NOT NULL DEFAULT '{}',
  loop boolean NOT NULL DEFAULT true,
  started_at timestamptz,
  paused_position_ms bigint NOT NULL DEFAULT 0 CHECK (paused_position_ms >= 0),
  volume integer NOT NULL DEFAULT 80 CHECK (volume BETWEEN 0 AND 100),
  live_session text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/**
 * Creates and upgrades the schema. Safe to run on every start: every
 * statement is idempotent. Serialised with an advisory lock so two instances
 * starting together cannot race.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(schema);
    await client.query(authSchema);
    // Planned reflows used to be recorded as delays; remove those records.
    await client.query(
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
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}
