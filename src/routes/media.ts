import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import {
  AUDIO_START_LEAD_MS, type AudioTrack, playlistDuration, playlistPosition, startedAtForTrack
} from '../domain/audio.js';
import {
  attachBroadcaster, attachListener, createLiveSession, endLiveSession, listenerCount,
  liveSessionCompetition, relayAudio
} from '../services/audio-live.js';
import { notifyChange } from '../services/changes.js';
import { findCompetition } from '../services/competitions.js';

const AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/wav',
  'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/flac', 'audio/x-flac'
]);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_COMPETITION_BYTES = 2 * 1024 * 1024 * 1024;
const PUBLIC_STATUSES = ['published', 'live', 'complete'];

type PlaybackRow = {
  mode: 'stopped' | 'playing' | 'paused' | 'live';
  playlist: string[];
  loop: boolean;
  started_at: Date | null;
  paused_position_ms: string | number;
  volume: number;
  live_session: string | null;
};

const defaultPlayback: PlaybackRow = {
  mode: 'stopped', playlist: [], loop: true, started_at: null, paused_position_ms: 0, volume: 80, live_session: null
};

async function playlistTracks(client: PoolClient | typeof pool, competitionId: string, playlist: string[]) {
  if (!playlist.length) return [];
  const result = await client.query<{ id: string; name: string; duration_ms: number }>(
    `SELECT id, name, duration_ms FROM media_files
     WHERE competition_id = $1 AND kind = 'audio' AND id = ANY($2::uuid[]) AND duration_ms IS NOT NULL`,
    [competitionId, playlist]
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return playlist.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({ id: row.id, name: row.name, durationMs: row.duration_ms }));
}

/** Everything a screen needs to play in sync (also the admin view of the player). */
async function audioState(competitionId: string) {
  const result = await pool.query<PlaybackRow>(
    `SELECT mode, playlist, loop, started_at, paused_position_ms, volume, live_session
     FROM audio_playback WHERE competition_id = $1`, [competitionId]
  );
  const row = result.rows[0] ?? defaultPlayback;
  const tracks = await playlistTracks(pool, competitionId, row.playlist);
  return {
    mode: row.mode,
    loop: row.loop,
    volume: row.volume,
    startedAt: row.started_at ? row.started_at.getTime() : null,
    pausedPositionMs: Number(row.paused_position_ms),
    tracks: tracks.map((track) => ({ ...track, url: `/media/${track.id}` })),
    live: row.mode === 'live' && row.live_session ? { session: row.live_session } : null,
    serverTime: Date.now()
  };
}

/** Sends stored media, honouring byte ranges so audio can seek without downloading everything. */
async function sendMedia(request: FastifyRequest, reply: FastifyReply, id: string, competitionGuard: string) {
  const meta = await pool.query<{ mime_type: string; byte_size: number; name: string }>(
    `SELECT f.mime_type, f.byte_size, f.name FROM media_files f JOIN competitions c ON c.id = f.competition_id
     WHERE f.id = $1 AND ${competitionGuard}`, [id]
  );
  const file = meta.rows[0];
  if (!file) return reply.code(404).send({ error: 'Media not found' });
  const size = file.byte_size;
  let start = 0;
  let end = size - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(match[2]));
      }
    }
    if (!match || start > end || start >= size) {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
  }
  const slice = await pool.query<{ chunk: Buffer }>(
    'SELECT substring(data FROM $2 FOR $3) AS chunk FROM media_files WHERE id = $1', [id, start + 1, end - start + 1]
  );
  reply
    .header('accept-ranges', 'bytes')
    .header('cache-control', 'public, max-age=31536000, immutable')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('content-disposition', `inline; filename="${encodeURIComponent(file.name)}"`)
    .type(file.mime_type);
  if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
  return reply.send(slice.rows[0]?.chunk ?? Buffer.alloc(0));
}

/** An event stream for signalling; returns a sender and runs `onClose` when the client goes. */
function openEventStream(request: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  response.write('retry: 2000\n\n');
  const send = (message: Record<string, unknown>) => {
    if (!response.writableEnded) response.write(`data: ${JSON.stringify(message)}\n\n`);
  };
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(': keep-alive\n\n');
  }, 15_000);
  const closers: (() => void)[] = [() => clearInterval(keepAlive)];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const closer of closers) closer();
  };
  request.raw.on('close', close);
  response.on('error', close);
  return { send, onClose: (closer: () => void) => closers.push(closer), end: () => { response.end(); close(); } };
}

const listenerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export function registerMediaRoutes(app: FastifyInstance): void {
  app.addContentTypeParser(/^(audio|image)\//, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body));

  app.get('/api/admin/competitions/:slug/media', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const result = await pool.query(
      `SELECT id, kind, name, mime_type, byte_size, duration_ms, created_at
       FROM media_files WHERE competition_id = $1 ORDER BY kind, created_at`, [competition.id]
    );
    return result.rows;
  });

  // Signed-in check before the body is read, so nobody else can push 50 MB uploads at the server.
  app.post('/api/admin/competitions/:slug/media', {
    onRequest: requireAdmin, bodyLimit: MAX_UPLOAD_BYTES
  }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const query = z.object({
      name: z.string().trim().min(1).max(200),
      durationMs: z.coerce.number().int().positive().max(24 * 3600_000).optional()
    }).parse(request.query);
    const mimeType = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const kind = AUDIO_TYPES.has(mimeType) ? 'audio' : IMAGE_TYPES.has(mimeType) ? 'image' : null;
    if (!kind) return reply.code(415).send({ error: 'Upload an MP3, M4A, AAC, OGG, WAV, WebM or FLAC audio file, or a PNG, JPEG, WebP or GIF image' });
    if (kind === 'audio' && !query.durationMs) return reply.code(400).send({ error: 'The track length could not be read; try another file' });
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'The file is empty' });
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const id = randomUUID();
    const created = await transaction(async (client) => {
      await client.query('SELECT id FROM competitions WHERE id = $1 FOR UPDATE', [competition.id]);
      const used = await client.query<{ total: string }>(
        'SELECT coalesce(sum(byte_size), 0) AS total FROM media_files WHERE competition_id = $1', [competition.id]
      );
      if (Number(used.rows[0]?.total ?? 0) + body.length > MAX_COMPETITION_BYTES) return false;
      await client.query(
        `INSERT INTO media_files (id, competition_id, kind, name, mime_type, byte_size, duration_ms, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, competition.id, kind, query.name, mimeType, body.length, kind === 'audio' ? query.durationMs : null, body]
      );
      if (kind === 'audio') {
        // New tracks join the end of the playlist so they are ready to play.
        await client.query(
          `INSERT INTO audio_playback (competition_id, playlist) VALUES ($1, ARRAY[$2::uuid])
           ON CONFLICT (competition_id) DO UPDATE SET playlist = audio_playback.playlist || $2::uuid, updated_at = now()`,
          [competition.id, id]
        );
      }
      await audit(client, adminEmail(request), 'media.uploaded', 'media_file', id, { kind, name: query.name, bytes: body.length });
      return true;
    });
    if (!created) return reply.code(413).send({ error: 'This competition has reached its 2 GB media limit; delete some files first' });
    return reply.code(201).send({ id, kind, name: query.name, mime_type: mimeType, byte_size: body.length, duration_ms: query.durationMs ?? null });
  });

  app.delete('/api/admin/media/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await transaction(async (client) => {
      const removed = await client.query<{ competition_id: string }>(
        'DELETE FROM media_files WHERE id = $1 RETURNING competition_id', [id]
      );
      const competitionId = removed.rows[0]?.competition_id;
      if (!competitionId) return false;
      // Removing a track shifts every later position, so a playing playlist stops.
      await client.query(
        `UPDATE audio_playback SET playlist = array_remove(playlist, $2::uuid),
           mode = CASE WHEN mode IN ('playing', 'paused') AND $2::uuid = ANY(playlist) THEN 'stopped' ELSE mode END,
           started_at = CASE WHEN mode IN ('playing', 'paused') AND $2::uuid = ANY(playlist) THEN NULL ELSE started_at END,
           paused_position_ms = CASE WHEN mode IN ('playing', 'paused') AND $2::uuid = ANY(playlist) THEN 0 ELSE paused_position_ms END,
           updated_at = now()
         WHERE competition_id = $1`, [competitionId, id]
      );
      await audit(client, adminEmail(request), 'media.deleted', 'media_file', id);
      return true;
    });
    if (!deleted) return reply.code(404).send({ error: 'Media not found' });
    return reply.code(204).send();
  });

  app.get('/api/admin/media/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return sendMedia(request, reply, id, 'true');
  });

  // Public screens load tracks and images from here once the competition is published.
  app.get('/media/:id', async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: 'Media not found' });
    return sendMedia(request, reply, parsed.data.id, `c.status IN ('published', 'live', 'complete')`);
  });

  app.get('/api/admin/competitions/:slug/audio', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const state = await audioState(competition.id);
    return { ...state, listeners: state.live ? listenerCount(state.live.session) : 0 };
  });

  app.get('/api/public/audio/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition || !PUBLIC_STATUSES.includes(competition.status)) return reply.code(404).send({ error: 'Competition not found' });
    reply.header('cache-control', 'no-store');
    return audioState(competition.id);
  });

  app.post('/api/admin/competitions/:slug/audio', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.discriminatedUnion('action', [
      z.object({ action: z.literal('play'), index: z.number().int().min(0).max(1000).optional() }),
      z.object({ action: z.enum(['pause', 'stop', 'next', 'previous', 'live-start', 'live-stop']) }),
      z.object({
        action: z.literal('settings'),
        playlist: z.array(z.string().uuid()).max(500).optional(),
        loop: z.boolean().optional(),
        volume: z.number().int().min(0).max(100).optional()
      })
    ]).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const ended: { session: string | null } = { session: null };
    const outcome = await transaction(async (client) => {
      await client.query(
        'INSERT INTO audio_playback (competition_id) VALUES ($1) ON CONFLICT (competition_id) DO NOTHING', [competition.id]
      );
      const current = (await client.query<PlaybackRow>(
        `SELECT mode, playlist, loop, started_at, paused_position_ms, volume, live_session
         FROM audio_playback WHERE competition_id = $1 FOR UPDATE`, [competition.id]
      )).rows[0]!;
      const now = Date.now();
      const tracks: AudioTrack[] = await playlistTracks(client, competition.id, current.playlist);
      const next = { ...current, paused_position_ms: Number(current.paused_position_ms) };
      const startedAtMs = current.started_at ? current.started_at.getTime() : null;
      // Where the playlist is now: from the clock while playing, from the stored position while paused.
      const position = current.mode === 'playing' && startedAtMs !== null
        ? playlistPosition(tracks, startedAtMs, now, current.loop)
        : current.mode === 'paused' ? playlistPosition(tracks, 0, next.paused_position_ms, current.loop) : null;
      const stop = () => { next.mode = 'stopped'; next.started_at = null; next.paused_position_ms = 0; };
      const playTrack = (index: number) => {
        next.mode = 'playing';
        next.started_at = new Date(startedAtForTrack(tracks, index, now + AUDIO_START_LEAD_MS));
        next.paused_position_ms = 0;
      };
      // Any player action (or stopping) ends a live broadcast; settings changes do not.
      if (current.live_session && body.action !== 'settings') {
        ended.session = current.live_session;
        next.live_session = null;
        if (current.mode === 'live') stop();
      }
      switch (body.action) {
        case 'play': {
          if (!tracks.length) return { error: 'Upload tracks or add them to the playlist first' } as const;
          if (body.index !== undefined) {
            if (body.index >= tracks.length) return { error: 'That track is not in the playlist' } as const;
            playTrack(body.index);
          } else if (current.mode === 'paused') {
            next.mode = 'playing';
            next.started_at = new Date(now + AUDIO_START_LEAD_MS - next.paused_position_ms);
            next.paused_position_ms = 0;
          } else if (current.mode !== 'playing' || !position) {
            playTrack(0);
          }
          break;
        }
        case 'pause': {
          if (current.mode !== 'playing' || startedAtMs === null) break;
          const total = playlistDuration(tracks);
          let elapsed = Math.max(0, now - startedAtMs);
          if (total > 0 && elapsed >= total) {
            if (!current.loop) { stop(); break; }
            elapsed %= total;
          }
          next.mode = 'paused';
          next.started_at = null;
          next.paused_position_ms = elapsed;
          break;
        }
        case 'stop':
          stop();
          break;
        case 'next':
        case 'previous': {
          if (!tracks.length) return { error: 'The playlist is empty' } as const;
          const index = position?.index ?? -1;
          let target = body.action === 'next' ? index + 1
            : position && position.offsetMs > 3000 ? index : index - 1;
          if (target >= tracks.length) {
            if (!current.loop) { stop(); break; }
            target = 0;
          }
          if (target < 0) target = current.loop ? tracks.length - 1 : 0;
          if (current.mode === 'paused') {
            next.paused_position_ms = playlistDuration(tracks.slice(0, target));
          } else {
            playTrack(target);
          }
          break;
        }
        case 'settings': {
          if (body.volume !== undefined) next.volume = body.volume;
          if (body.loop !== undefined) next.loop = body.loop;
          if (body.playlist) {
            next.playlist = body.playlist;
            // Keep the current track playing from the same point when it is still in the list.
            const newTracks = await playlistTracks(client, competition.id, body.playlist);
            const currentId = position && position.offsetMs >= 0 ? tracks[position.index]?.id : undefined;
            const newIndex = currentId ? newTracks.findIndex((track) => track.id === currentId) : -1;
            if (current.mode === 'playing') {
              if (newIndex >= 0) next.started_at = new Date(startedAtForTrack(newTracks, newIndex, now - position!.offsetMs));
              else if (newTracks.length) next.started_at = new Date(now + AUDIO_START_LEAD_MS);
              else stop();
            } else if (current.mode === 'paused') {
              next.paused_position_ms = newIndex >= 0
                ? playlistDuration(newTracks.slice(0, newIndex)) + position!.offsetMs : 0;
            }
          }
          break;
        }
        case 'live-start':
          next.mode = 'live';
          next.started_at = null;
          next.paused_position_ms = 0;
          next.live_session = createLiveSession(competition.id);
          break;
        case 'live-stop':
          break;
      }
      await client.query(
        `UPDATE audio_playback SET mode = $2, playlist = $3::uuid[], loop = $4, started_at = $5,
           paused_position_ms = $6, volume = $7, live_session = $8, updated_at = now()
         WHERE competition_id = $1`,
        [competition.id, next.mode, next.playlist, next.loop, next.started_at, Math.round(next.paused_position_ms),
          next.volume, next.mode === 'live' ? next.live_session : null]
      );
      await audit(client, adminEmail(request), `audio.${body.action}`, 'competition', competition.id,
        body.action === 'settings' ? { loop: body.loop, volume: body.volume, tracks: body.playlist?.length } : {});
      return { ok: true } as const;
    });
    if (ended.session) endLiveSession(ended.session);
    if ('error' in outcome) return reply.code(409).send({ error: outcome.error });
    const state = await audioState(competition.id);
    return { ...state, listeners: state.live ? listenerCount(state.live.session) : 0 };
  });

  // Live audio signalling. The broadcaster is an admin browser; listeners are audio screens.
  app.get('/api/admin/audio-live/:session/events', { preHandler: requireAdmin }, async (request, reply) => {
    const { session } = z.object({ session: z.string().max(100) }).parse(request.params);
    const competitionId = liveSessionCompetition(session);
    if (!competitionId) return reply.code(404).send({ error: 'This live broadcast has ended' });
    const stream = openEventStream(request, reply);
    const detach = attachBroadcaster(session, stream.send, () => {
      // The broadcasting tab went away: stop the broadcast so screens stop waiting for it.
      endLiveSession(session);
      void pool.query(
        `UPDATE audio_playback SET mode = 'stopped', live_session = NULL, updated_at = now()
         WHERE competition_id = $1 AND live_session = $2`, [competitionId, session]
      ).then(() => notifyChange()).catch(() => undefined);
    });
    if (!detach) { stream.send({ type: 'ended' }); stream.end(); return; }
    stream.onClose(detach);
  });

  // The broadcaster posts Opus chunks (stamped with their capture time on the server clock) a few
  // times a second; they go straight out to every listening screen.
  app.post('/api/admin/audio-live/:session/audio', { preHandler: requireAdmin, bodyLimit: 512 * 1024 }, async (request, reply) => {
    const { session } = z.object({ session: z.string().max(100) }).parse(request.params);
    const { chunks } = z.object({
      chunks: z.array(z.object({
        t: z.number().finite(),
        d: z.string().max(16_384).regex(/^[A-Za-z0-9+/]*={0,2}$/)
      })).min(1).max(100)
    }).parse(request.body);
    if (!relayAudio(session, chunks)) return reply.code(404).send({ error: 'This live broadcast has ended' });
    return reply.code(204).send();
  });

  app.get('/api/public/audio-live/:session/listen', async (request, reply) => {
    const { session } = z.object({ session: z.string().max(100) }).parse(request.params);
    const { listener } = z.object({ listener: listenerIdSchema }).parse(request.query);
    if (!liveSessionCompetition(session)) return reply.code(404).send({ error: 'This live broadcast has ended' });
    const stream = openEventStream(request, reply);
    const detach = attachListener(session, listener, stream.send);
    if (!detach) { stream.send({ type: 'ended' }); stream.end(); return; }
    stream.onClose(detach);
  });

}
