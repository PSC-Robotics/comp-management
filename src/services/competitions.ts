import { defaultCornerColours } from '../domain/display.js';
import { Pool, type PoolClient } from 'pg';

export async function findCompetition(client: Pool | PoolClient, slug: string) {
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

export async function getCornerColours(client: Pool | PoolClient, competitionId: string): Promise<string[]> {
  const result = await client.query<{ corner_colours: string[] }>(
    'SELECT corner_colours FROM competition_settings WHERE competition_id = $1',
    [competitionId]
  );
  return result.rows[0]?.corner_colours ?? [...defaultCornerColours];
}
