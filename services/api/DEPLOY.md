# Running the service somewhere

Everything the campsite *is* runs on the device. The service exists for the
things a single device cannot do by itself: share a fire with somebody else,
carry a Passport between two phones, redeem a code once and only once, and take
an order. Without it the product is complete and quiet. With it, the campfire is
shared.

**What this document is honest about:** none of the container work below has
been executed. There is no Docker daemon in the environment this was written in,
so the image has never been built and no manifest has ever been applied. What
*has* been run, step by step, is everything the image does:

| Checked | How |
| --- | --- |
| `npm ci --omit=dev --ignore-scripts` resolves the workspace | Run in a clean tree containing only the manifests: 73 packages, 8 seconds |
| The service starts from source in production mode | `npm start` with `NODE_ENV=production`, answering `/health` with `200` |
| The `COPY` set is complete | The runtime stage assembled on disk exactly as the Dockerfile lays it out, and booted from there |
| Migrations apply to a real Postgres | `npm run migrate` against PostgreSQL 16: five migrations, now at version 5 |
| Health reports the database | `{"ok":true,"persistence":"postgres","database":{"reachable":true,"latencyMs":1,...}}` |
| CORS lets a hosted client in | `OPTIONS /v1/auth/anonymous` with a `github.io` origin: `204`, with the origin echoed |

That last-but-two row is worth its place. Assembling the runtime stage by hand
found a missing `COPY`: the service imports `@somemore/protocol` and
`@somemore/content`, and `@somemore/content` imports `@somemore/sim`, which the
service never mentions. An image built from the two obvious packages builds
perfectly and dies on its first line. A missing `COPY` only ever announces
itself by running the thing.

---

## The shortest path

```bash
AUTH_TOKEN_SECRET="$(openssl rand -base64 32)" docker compose up --build
```

Postgres, the migrations as a one-shot job, and the service on `:8080`. Check it:

```bash
curl -s localhost:8080/health
```

Then build a client that points at it and open two browsers on the same fire:

```bash
VITE_API_URL=http://localhost:8080 npm run build --workspace @somemore/web
npm run preview --workspace @somemore/web
```

## Somewhere permanent

`fly.toml` and `render.yaml` are both at the repository root, both build
`services/api/Dockerfile` from the **repository root as context** — the service
imports its workspace packages, and a context of `services/api` cannot see them
— and both run migrations as a release step rather than at boot. Two instances
racing through the same migration is a bad first minute, and it is the kind that
only happens in production.

The pairing that actually makes the campfire work is two variables in opposite
directions:

* the **client** is built with `VITE_API_URL=https://your-service`, which the
  Pages workflow takes as an input;
* the **service** is given `CORS_ALLOWED_ORIGINS=https://<account>.github.io`.

Miss the second and the browser refuses every call before the service sees it,
and the client reports an ordinary network failure — which looks exactly like
the service being down. It is the single most likely thing to go wrong here.

## What it needs

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_TOKEN_SECRET` | **yes, in production** | The service refuses to start rather than sign sessions with a known development key. Not a warning: a refusal |
| `DATABASE_URL` | no | Without it the service runs on in-memory repositories and says so in `/health`. Fine for a demo, and everything is lost on restart |
| `CORS_ALLOWED_ORIGINS` | for a hosted client | Comma-separated. See above |
| `HOST` | set by the image | Defaults to `127.0.0.1`, which inside a container means nothing outside it can connect |
| `PORT` | set by the image | 8080 |
| `LIVE_OPS_TOKEN` | no | Absent ⇒ the content service is read-only and every authoring route answers `503` naming this variable. That is the correct default for a deployment nobody is authoring against |

The rest — Stripe, LiveKit, object storage, email, Apple and Google issuer
credentials — are the boundaries listed in the README's Blockers. Each is unset
by default, each refuses with a structured report naming its variable, and none
of them fakes a success.

## Why it runs from TypeScript source

Because the compiled output does not run, and never did. `tsc -b` used to emit
JavaScript into `dist/`; the workspace packages declare
`"exports": "./src/index.ts"`, so the moment that JavaScript imported
`@somemore/protocol` Node resolved it to TypeScript source and died. Nothing
consumed it and nothing had ever executed it.

The service now runs from source in production exactly as it does in
development and in every test — one loading path, so what ships is what the
suite exercises. `tsc -b` still typechecks it and emits declarations for the
project references, and no longer emits JavaScript, so there is nothing in
`dist/` that can be mistaken for something to deploy. The long version of the
argument is in `runtime/ts-resolve.mjs`.

## What is still missing

* **Nobody has run the image.** See the top of this file.
* **No TLS and no backups** in `docker-compose.yml`. It is a development stack
  that happens to be the right shape, not a production one.
* **Set `LIVE_OPS_TOKEN` on a fresh database.** It no longer gates authoring —
  named capabilities do (Blocker 9, now closed) — but it is the only way to
  appoint the *first* operator, and it stops working the moment anybody holds
  `operators:grant`. Without it, a brand-new deployment has no path to its first
  administrator. It is safe to leave set afterwards.
