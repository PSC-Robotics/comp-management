import type { FastifyRequest } from 'fastify';
import { env } from '../config.js';

export type RelyingParty = { id: string; name: string; origin: string };

/**
 * Where passkeys are valid. In production this comes from PUBLIC_BASE_URL (passkeys
 * need HTTPS and are bound to that host name). Without it, only localhost works,
 * which is what browsers allow for development.
 */
export function passkeyRelyingParty(request: FastifyRequest): RelyingParty | undefined {
  if (env.PUBLIC_BASE_URL) {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return undefined;
    return { id: env.PASSKEY_RP_ID ?? url.hostname, name: env.PASSKEY_RP_NAME, origin: url.origin };
  }
  const host = request.hostname;
  if (host !== 'localhost') return undefined;
  return { id: 'localhost', name: env.PASSKEY_RP_NAME, origin: `${request.protocol}://${request.host}` };
}
