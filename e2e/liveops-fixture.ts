/**
 * The service (and the console) that the live-ops and code specs need.
 *
 * Started from inside the specs rather than from `playwright.config.ts`'s
 * `webServer`, for the same reason `campfire.spec.ts` does it: every other
 * project is written against exactly one deployment — a campsite with no
 * signal — and a globally-started API would quietly change what those tests are
 * measuring. It also means several Playwright runs can be in flight at once
 * without fighting over a fixed port, which a shared `webServer` entry does not.
 *
 * Two services, because the product has two states worth testing:
 *
 *  - a **configured** one, which can author content and mint Ed25519 codes;
 *  - a **bare** one, with no `LIVE_OPS_TOKEN` and no keys, so the console can
 *    be checked against the state that is easiest to get wrong: an
 *    unconfigured deployment must read as *unconfigured*, naming the variable,
 *    not as broken.
 *
 * The signing key is generated per run and written nowhere. There is no key in
 * this repository, nothing to leak, and nothing that could be mistaken for a
 * real one — which is the rule `services/api/src/codes/signing.ts` states on
 * the other side of the wire.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * A shared operator secret for the fixture.
 *
 * Not a secret in any meaningful sense: it exists for the length of one test
 * run against a throwaway in-memory service, and it is spelled out here
 * precisely so nobody is tempted to point these specs at something real.
 */
export const OPS_TOKEN = 'e2e-ops-token-not-a-secret';

/** An unused TCP port, asked for rather than assumed. */
export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? fail(new Error('no port')) : done(port)));
    });
  });
}

/** Base64 of the raw 32 bytes, which is what the service and a secret store take. */
function signingKey(): { keyId: string; privateKeyBase64: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // Strip the fixed RFC 8410 ASN.1 headers back off.
  return {
    keyId: 'e2e',
    privateKeyBase64: pkcs8.subarray(16).toString('base64'),
    publicKeyBase64: spki.subarray(12).toString('base64'),
  };
}

export interface RunningService {
  readonly baseUrl: string;
  stop(): void;
}

async function waitForHealth(baseUrl: string, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} never came up on ${baseUrl}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * The real `node:http` service, on its own port.
 *
 * `configured: false` boots the identical binary with nothing set, which is the
 * state a fresh deployment is actually in.
 */
export async function startApi(options: { configured: boolean; corsOrigin?: string }): Promise<
  RunningService & { keyId: string; publicKeyBase64: string }
> {
  const port = await freePort();
  const key = signingKey();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    AUTH_TOKEN_SECRET: 'e2e-token-secret-not-a-secret',
    IP_HASH_SALT: 'e2e-ip-salt',
    // In memory on purpose: a test run should not touch anybody's database.
    DATABASE_URL: '',
    ...(options.corsOrigin === undefined ? {} : { CORS_ALLOWED_ORIGINS: options.corsOrigin }),
  };
  delete env['DATABASE_URL'];
  if (options.configured) {
    env['LIVE_OPS_TOKEN'] = OPS_TOKEN;
    env['CODE_SIGNING_KEY_ID'] = key.keyId;
    env['CODE_SIGNING_PRIVATE_KEY'] = key.privateKeyBase64;
    env['CODE_VERIFY_PUBLIC_KEYS'] = `${key.keyId}:${key.publicKeyBase64}`;
  }

  const child: ChildProcess = spawn(
    process.execPath,
    ['--experimental-strip-types', '--import', './dev/ts-extensions.mjs', 'src/main.ts'],
    {
      cwd: resolve(process.cwd(), 'services/api'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    if (line.includes('level":"error')) process.stderr.write(`[api] ${line}`);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, options.configured ? 'the configured API' : 'the bare API');
  return {
    baseUrl,
    keyId: key.keyId,
    publicKeyBase64: key.publicKeyBase64,
    stop: () => void child.kill('SIGTERM'),
  };
}

/**
 * The console's own preview server.
 *
 * A separate build on a separate origin — which is the console's entire
 * security posture, so serving it any other way here would be testing something
 * this product does not ship. Talking to the API cross-origin also means these
 * specs exercise the CORS path a real deployment needs.
 */
export async function startConsole(): Promise<RunningService> {
  const port = await freePort();
  const child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: resolve(process.cwd(), 'apps/console'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(baseUrl);
      if (response.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`the console never came up on ${baseUrl}`);
    await new Promise((done) => setTimeout(done, 200));
  }
  return { baseUrl, stop: () => void child.kill('SIGTERM') };
}

/* -------------------------------------------------------------------------- */
/* Talking to the service                                                      */
/* -------------------------------------------------------------------------- */

export function key(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** A bearer token. Live-ops actions are attributed to a real account id. */
export async function bearerToken(baseUrl: string, displayName = 'Live Ops'): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device: { deviceId: key('device'), platform: 'web', appVersion: '0.3.0' },
      displayName,
    }),
  });
  const body = (await response.json()) as { auth?: { token?: string } };
  const token = body.auth?.token;
  if (response.status !== 201 || token === undefined) {
    throw new Error(`bootstrap failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return token;
}

/** Open a print run and mint from it, exactly as the console does. */
export async function mintCodes(
  baseUrl: string,
  count = 1,
  overrides: Record<string, unknown> = {},
): Promise<{ batchId: string; codes: { ref: string; token: string; uri: string }[] }> {
  const bearer = await bearerToken(baseUrl);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer}`,
    'x-somemore-ops-token': OPS_TOKEN,
  };

  const batch = await fetch(`${baseUrl}/v1/live-ops/code-batches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotencyKey: key('batch'),
      label: 'E2E wrapper run',
      kind: 'pkg',
      entitlement: { type: 'reward', rewardCode: 'free_kit' },
      plannedSize: 100,
      ...overrides,
    }),
  });
  const batchBody = (await batch.json()) as { id?: string };
  if (batch.status !== 201 || batchBody.id === undefined) {
    throw new Error(`batch failed: ${batch.status} ${JSON.stringify(batchBody)}`);
  }

  const minted = await fetch(`${baseUrl}/v1/live-ops/code-batches/${batchBody.id}/mint`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ idempotencyKey: key('mint'), count }),
  });
  const mintedBody = (await minted.json()) as {
    minted?: { ref: string; token: string; uri: string }[];
  };
  if (minted.status !== 201 || mintedBody.minted === undefined) {
    throw new Error(`mint failed: ${minted.status} ${JSON.stringify(mintedBody)}`);
  }
  return { batchId: batchBody.id, codes: mintedBody.minted };
}
