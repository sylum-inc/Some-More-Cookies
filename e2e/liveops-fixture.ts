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
import { readdirSync, statSync } from 'node:fs';

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
    ['--import', './runtime/ts-resolve.mjs', 'src/main.ts'],
    {
      cwd: resolve(process.cwd(), 'services/api'),
      env,
      /*
       * stdout is discarded rather than piped.
       *
       * A piped stream nobody reads fills its 64KB kernel buffer and then the
       * child *blocks on write* — so the service stops answering partway
       * through a run, which is exactly what happened: a redeem mid-spec died
       * with ECONNREFUSED after the service had been serving happily for
       * thirty seconds. The service logs structured JSON to stdout on every
       * request, so it does not take long. stderr is piped because it is
       * drained below.
       */
      stdio: ['ignore', 'ignore', 'pipe'],
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
 * Refuse to test a build older than the source it was built from.
 *
 * `vite preview` serves `dist` and never rebuilds it, so a console change with
 * no rebuild is tested as the *previous* version — silently, and with every
 * assertion still green if it happens not to touch what changed. That is
 * exactly what happened once: a banner's wording changed, the old wording was
 * served, and the suite passed because the assertion was loose enough to match
 * a different line entirely. CI builds the console before running this project,
 * so this only ever fires locally — which is precisely where it is needed.
 */
function assertConsoleBuildIsCurrent(): void {
  const root = resolve(process.cwd(), 'apps/console');
  const dist = resolve(root, 'dist/index.html');
  let builtAt: number;
  try {
    builtAt = statSync(dist).mtimeMs;
  } catch {
    throw new Error('apps/console/dist is missing. Run: npm run build --workspace @somemore/console');
  }

  const newest = (dir: string): number => {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
    }
    return latest;
  };
  const sourceAt = Math.max(newest(resolve(root, 'src')), statSync(resolve(root, 'index.html')).mtimeMs);

  if (sourceAt > builtAt) {
    throw new Error(
      'apps/console/dist is older than apps/console/src, so these tests would run against the ' +
        'previous build. Run: npm run build --workspace @somemore/console',
    );
  }
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
  assertConsoleBuildIsCurrent();
  const port = await freePort();
  /*
   * Its own process group, killed as a group.
   *
   * `npx` forks the real `vite`, and a `SIGTERM` to `npx` does not reach it —
   * which leaves a preview server bound to a port after the run has finished.
   * Found by listing processes after a run and seeing one still there.
   */
  const child = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: resolve(process.cwd(), 'apps/console'),
    env: process.env,
    // Same reason as the API: an undrained pipe eventually stops the child.
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
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
  return {
    baseUrl,
    stop: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    },
  };
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
  const body = (await response.json()) as { auth?: { token?: string }; account?: { id?: string } };
  const token = body.auth?.token;
  if (response.status !== 201 || token === undefined) {
    throw new Error(`bootstrap failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return token;
}

/**
 * One appointed operator per service, made once and reused.
 *
 * The shared token appoints the *first* operator on a deployment and then
 * refuses, which is the whole difference between a bootstrap and a standing
 * permission (README, Blocker 9). So this caches: signing in as a brand new
 * anonymous person for every mint and expecting to still be an administrator
 * only ever worked while the shared secret *was* the permission.
 */
const appointed = new Map<string, string>();

export async function operatorToken(baseUrl: string): Promise<string> {
  const cached = appointed.get(baseUrl);
  if (cached !== undefined) return cached;

  const account = await fetch(`${baseUrl}/v1/auth/anonymous`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device: { deviceId: key('device'), platform: 'web', appVersion: '0.3.0' },
      displayName: 'Live Ops',
    }),
  });
  const body = (await account.json()) as { auth?: { token?: string }; account?: { id?: string } };
  const token = body.auth?.token;
  const accountId = body.account?.id;
  if (account.status !== 201 || token === undefined || accountId === undefined) {
    throw new Error(`bootstrap failed: ${account.status} ${JSON.stringify(body)}`);
  }

  const granted = await fetch(`${baseUrl}/v1/operators/grants`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-somemore-ops-token': OPS_TOKEN,
    },
    body: JSON.stringify({ idempotencyKey: key('grant'), accountId, role: 'admin' }),
  });
  if (granted.status !== 201) {
    throw new Error(`appointing an operator failed: ${granted.status} ${await granted.text()}`);
  }

  appointed.set(baseUrl, token);
  return token;
}

/** Open a print run and mint from it, exactly as the console does. */
export async function mintCodes(
  baseUrl: string,
  count = 1,
  overrides: Record<string, unknown> = {},
): Promise<{ batchId: string; codes: { ref: string; token: string; uri: string }[] }> {
  // An appointed operator, not a shared string: minting needs `codes:mint`.
  const bearer = await operatorToken(baseUrl);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer}`,
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
