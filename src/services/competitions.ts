import { defaultCornerColours } from '../domain/display.js';
import { defaultStagingSettings, type StagingSettings } from '../domain/staging.js';
import { Pool, type PoolClient } from 'pg';

export async function findCompetition(client: Pool | PoolClient, slug: string) {
  const result = await client.query(
    'SELECT id, name, slug, status, timezone, match_duration_seconds, match_size FROM competitions WHERE slug = $1',
    [slug]
  );
  return result.rows[0] as {
    id: string;
    name: string;
    slug: string;
    status: string;
    timezone: string;
    match_duration_seconds: number;
    match_size: number;
  } | undefined;
}

export async function getCornerColours(client: Pool | PoolClient, competitionId: string): Promise<string[]> {
  const result = await client.query<{ corner_colours: string[] }>(
    'SELECT corner_colours FROM competition_settings WHERE competition_id = $1',
    [competitionId]
  );
  return result.rows[0]?.corner_colours ?? [...defaultCornerColours];
}

/** Competition-wide staging rules (used by SR staging and shepherding screens). */
export async function getStagingSettings(client: Pool | PoolClient, competitionId: string): Promise<StagingSettings> {
  const result = await client.query<{ staging_close_minutes: number; staging_first_lead_minutes: number }>(
    'SELECT staging_close_minutes, staging_first_lead_minutes FROM competition_settings WHERE competition_id = $1',
    [competitionId]
  );
  const row = result.rows[0];
  return row
    ? { closeAfterPreviousStartMinutes: row.staging_close_minutes, firstMatchLeadMinutes: row.staging_first_lead_minutes }
    : { ...defaultStagingSettings };
}

/** Every arena that has a league match or playoff heat, in name order (the same order SR screens use). */
export async function listArenaNames(client: Pool | PoolClient, competitionId: string): Promise<string[]> {
  const result = await client.query<{ arena_name: string }>(
    `SELECT arena_name FROM matches WHERE competition_id = $1
     UNION
     SELECT pm.arena_name FROM playoff_matches pm JOIN playoff_brackets pb ON pb.id = pm.bracket_id
     WHERE pb.competition_id = $1`,
    [competitionId]
  );
  return result.rows.map((row) => row.arena_name).sort((left, right) => left.localeCompare(right));
}
