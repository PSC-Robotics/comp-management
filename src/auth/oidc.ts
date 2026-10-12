import type { FastifyBaseLogger } from 'fastify';
import * as oidc from 'openid-client';
import { env } from '../config.js';

let client: oidc.Configuration | undefined;
let discovering: Promise<oidc.Configuration | undefined> | undefined;
let lastError: string | undefined;
let retryTimer: NodeJS.Timeout | undefined;

export function oidcConfigured(): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_REDIRECT_URI);
}

export function oidcState(): { configured: boolean; available: boolean; lastError?: string } {
  return { configured: oidcConfigured(), available: Boolean(client), ...(lastError ? { lastError } : {}) };
}

async function discover(): Promise<oidc.Configuration | undefined> {
  if (!oidcConfigured()) return undefined;
  if (client) return client;
  discovering ??= oidc.discovery(
    new URL(env.OIDC_ISSUER!), env.OIDC_CLIENT_ID!, env.OIDC_CLIENT_SECRET!, undefined, { timeout: 8 }
  ).then((configuration) => {
    client = configuration;
    lastError = undefined;
    return configuration;
  }).catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error);
    return undefined;
  }).finally(() => {
    discovering = undefined;
  });
  return discovering;
}

/** The OIDC client, discovering it now if the identity provider was unreachable earlier. */
export async function getOidcClient(): Promise<oidc.Configuration | undefined> {
  return client ?? discover();
}

/**
 * Discovers the identity provider in the background and keeps retrying with
 * backoff if it is down, so the application starts (and passkeys work) either way.
 */
export function startOidcDiscovery(log: FastifyBaseLogger): void {
  if (!oidcConfigured()) {
    log.warn('OIDC is not configured; only passkey sign-in is available');
    return;
  }
  let delayMs = 5_000;
  const attempt = async () => {
    const configuration = await discover();
    if (configuration) {
      log.info('Identity provider discovered');
      return;
    }
    log.warn({ error: lastError, retryInSeconds: delayMs / 1000 }, 'Identity provider unavailable; passkey sign-in still works');
    retryTimer = setTimeout(() => void attempt(), delayMs);
    retryTimer.unref();
    delayMs = Math.min(delayMs * 2, 5 * 60_000);
  };
  void attempt();
}

export function stopOidcDiscovery(): void {
  if (retryTimer) clearTimeout(retryTimer);
}
