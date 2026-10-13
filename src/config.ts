import { z } from 'zod';

const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional());
const optionalText = z.preprocess((value) => value === '' ? undefined : value, z.string().optional());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  PUBLIC_BASE_URL: optionalUrl,
  OIDC_ISSUER: optionalUrl,
  OIDC_CLIENT_ID: optionalText,
  OIDC_CLIENT_SECRET: optionalText,
  OIDC_REDIRECT_URI: optionalUrl,
  /** "true" refuses accounts whose provider does not mark the email verified (off: Authentik reports false by default). */
  OIDC_REQUIRE_VERIFIED_EMAIL: z.enum(['true', 'false']).default('false'),
  /** Comma-separated emails allowed to sign in with OIDC. Empty: any account the identity provider accepts. */
  ADMIN_EMAILS: z.string().default(''),
  /** Proxy trust for client IPs: "true", "false", or comma-separated addresses/CIDRs. */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  /** WebAuthn relying party ID; defaults to the PUBLIC_BASE_URL host name. */
  PASSKEY_RP_ID: optionalText,
  PASSKEY_RP_NAME: z.string().default('Competition Control'),
  LOG_LEVEL: z.string().default('info'),
  /**
   * JSON list of WebRTC ICE servers for live audio, e.g. [{"urls":"stun:stun.example.org:3478"}].
   * Empty works on one LAN; add STUN/TURN when screens are on other networks.
   */
  WEBRTC_ICE_SERVERS: z.string().default('')
});

export type Config = z.infer<typeof schema>;

export const env: Config = schema.parse(process.env);

export const adminEmailAllowlist = new Set(
  env.ADMIN_EMAILS.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean)
);

export function trustProxySetting(value = env.TRUST_PROXY): boolean | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** Origins allowed to make state-changing admin requests (besides the request's own host). */
export function publicOrigin(): string | undefined {
  return env.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).origin : undefined;
}

/** ICE servers handed to live-audio broadcasters and listeners (invalid JSON is ignored). */
export function iceServers(value = env.WEBRTC_ICE_SERVERS): unknown[] {
  if (!value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
