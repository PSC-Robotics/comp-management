/** A minimal WebAuthn authenticator (ES256, "none" attestation) for end-to-end passkey tests. */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    const buffer = Buffer.alloc(3); buffer[0] = (major << 5) | 25; buffer.writeUInt16BE(length, 1); return buffer;
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  }
  throw new Error('unsupported CBOR value');
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

export class VirtualAuthenticator {
  private credentials = new Map<string, { privateKey: KeyObject; userHandle: string; counter: number }>();
  constructor(private readonly origin: string, private readonly rpId: string) {}

  /** Responds to navigator.credentials.create() options. */
  create(options: any) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialId = randomBytes(32);
    const coseKey = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLength, credentialId, cbor(coseKey)
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.credentials.set(b64url(credentialId), { privateKey, userHandle: options.user.id, counter: 0 });
    return {
      id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform'
    };
  }

  /** Responds to navigator.credentials.get() options with any credential it holds. */
  get(options: any, { tamper = false } = {}) {
    const [id, credential] = [...this.credentials][0]!;
    credential.counter += 1;
    const counter = Buffer.alloc(4); counter.writeUInt32BE(credential.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), counter]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([authData, sha256(clientDataJSON)]));
    const signature = signer.sign(credential.privateKey);
    if (tamper) signature[signature.length - 1] ^= 0xff;
    return {
      id, rawId: id, type: 'public-key',
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: credential.userHandle },
      clientExtensionResults: {}, authenticatorAttachment: 'platform'
    };
  }
}
