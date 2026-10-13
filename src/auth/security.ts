import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { publicOrigin } from '../config.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Pages and feeds that are meant to be embedded on other sites (they set their own CSP). */
function isEmbeddable(url: string): boolean {
  return url.startsWith('/display/') || url.startsWith('/embed/') || url.startsWith('/srcomp/') ||
    url.startsWith('/srcomp-api/') || url.startsWith('/srcomp-stream/') || url.startsWith('/public/') ||
    url.startsWith('/api/public/');
}

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

/**
 * Cross-site request forgery guard for state-changing admin and auth requests.
 * Browsers always send Origin on cross-origin writes; when present it must be
 * this site. (Session cookies are also SameSite=Lax.)
 */
export function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin ?? (() => {
    const referer = request.headers.referer;
    if (!referer) return undefined;
    try {
      return new URL(referer).origin;
    } catch {
      return 'invalid';
    }
  })();
  if (!origin) return true;
  return origin === publicOrigin() || origin === requestOrigin(request);
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Fixed-window limiter for sign-in endpoints. Returns true when the request may proceed. */
export function takeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  if (buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export async function rateLimitSignIn(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!takeRateLimit(`signin:${request.ip}`, 30, 5 * 60_000)) {
    await reply.code(429).header('retry-after', '300').send({ error: 'Too many sign-in attempts. Wait a few minutes and try again.' });
  }
}

export function registerSecurity(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!isEmbeddable(request.url)) {
      reply.header('x-frame-options', 'DENY');
      // The admin page may capture a microphone, line-in or tab for live audio to the screens.
      reply.header('permissions-policy', 'camera=(), microphone=(self), display-capture=(self), geolocation=()');
      reply.header('content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    }
    if (UNSAFE_METHODS.has(request.method) &&
        (request.url.startsWith('/api/admin/') || request.url.startsWith('/auth/')) &&
        !originAllowed(request)) {
      await reply.code(403).send({ error: 'Cross-site request blocked' });
    }
  });
}
