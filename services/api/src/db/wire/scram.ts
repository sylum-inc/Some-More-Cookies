import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * SCRAM-SHA-256 (RFC 5802 / RFC 7677) client, the mechanism a default
 * PostgreSQL 14+ install negotiates for password auth.
 *
 * Channel binding is deliberately not offered: we advertise `n,,` (client does
 * not support it). That is legal, and it is the honest thing to do — this
 * client does not terminate TLS, so there is no channel to bind to.
 */

export interface ScramSession {
  /** `n,,n=,r=<nonce>` — the client-first-message. */
  readonly clientFirst: string;
  /** Feed the server-first-message; returns the client-final-message. */
  continue(serverFirst: string): Promise<string>;
  /** Verify the server-final-message. Throws if the server proved nothing. */
  finish(serverFinal: string): void;
}

function parseAttributes(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of message.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

function hi(password: Buffer, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, 32, 'sha256', (error, key) =>
      error === null ? resolve(key) : reject(error),
    );
  });
}

const hmac = (key: Buffer, data: string | Buffer): Buffer => createHmac('sha256', key).update(data).digest();
const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/**
 * Full SASLprep (RFC 4013) is not implemented. We normalise to NFKC and refuse
 * passwords containing the control characters SASLprep prohibits, rather than
 * silently mangling them into something that will not authenticate. ASCII
 * passwords — every password a secret manager will hand this service — are
 * unaffected. See README "Wire protocol limitations".
 */
function normalisePassword(password: string): Buffer {
  const normalised = password.normalize('NFKC');
  if (/[\u0000-\u001f\u007f]/.test(normalised)) {
    throw new Error('postgres: password contains control characters SASLprep prohibits');
  }
  return Buffer.from(normalised, 'utf8');
}

export function createScramSession(password: string): ScramSession {
  const clientNonce = randomBytes(24).toString('base64');
  const gs2Header = 'n,,';
  const clientFirstBare = `n=,r=${clientNonce}`;
  let serverSignature: Buffer | null = null;

  return {
    clientFirst: `${gs2Header}${clientFirstBare}`,

    async continue(serverFirst) {
      const attributes = parseAttributes(serverFirst);
      const serverNonce = attributes.get('r');
      const saltB64 = attributes.get('s');
      const iterationsRaw = attributes.get('i');
      if (serverNonce === undefined || saltB64 === undefined || iterationsRaw === undefined) {
        throw new Error('postgres: malformed SCRAM server-first-message');
      }
      if (!serverNonce.startsWith(clientNonce)) {
        throw new Error('postgres: SCRAM server nonce does not extend the client nonce');
      }
      const iterations = Number.parseInt(iterationsRaw, 10);
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) {
        throw new Error(`postgres: refusing implausible SCRAM iteration count ${iterationsRaw}`);
      }

      const saltedPassword = await hi(normalisePassword(password), Buffer.from(saltB64, 'base64'), iterations);
      const clientKey = hmac(saltedPassword, 'Client Key');
      const storedKey = sha256(clientKey);
      const channelBinding = `c=${Buffer.from(gs2Header, 'utf8').toString('base64')}`;
      const clientFinalWithoutProof = `${channelBinding},r=${serverNonce}`;
      const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;

      const clientSignature = hmac(storedKey, authMessage);
      const proof = xor(clientKey, clientSignature);
      serverSignature = hmac(hmac(saltedPassword, 'Server Key'), authMessage);

      return `${clientFinalWithoutProof},p=${proof.toString('base64')}`;
    },

    finish(serverFinal) {
      const attributes = parseAttributes(serverFinal);
      const error = attributes.get('e');
      if (error !== undefined) throw new Error(`postgres: SCRAM authentication failed (${error})`);
      const verifier = attributes.get('v');
      if (verifier === undefined || serverSignature === null) {
        throw new Error('postgres: SCRAM server-final-message carried no verifier');
      }
      const provided = Buffer.from(verifier, 'base64');
      if (provided.length !== serverSignature.length || !timingSafeEqual(provided, serverSignature)) {
        throw new Error('postgres: SCRAM server signature mismatch — refusing to trust this server');
      }
    },
  };
}

/** MD5 password auth, still the default on some managed instances. */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(password).update(user).digest('hex');
  const outer = createHash('md5').update(Buffer.from(inner, 'utf8')).update(salt).digest('hex');
  return `md5${outer}`;
}
