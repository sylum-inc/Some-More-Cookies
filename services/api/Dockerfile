# syntax=docker/dockerfile:1
#
# The service, in a container. Build from the **repository root**:
#
#     docker build -f services/api/Dockerfile -t some-more-api .
#
# The context is the root and not this directory because the service imports
# `@somemore/protocol` and `@somemore/content` as workspace packages, and a
# build context of `services/api` cannot see them.
#
# It runs from TypeScript source rather than from compiled output. That is a
# considered choice with a long comment attached to it in
# `runtime/ts-resolve.mjs`; the short version is that the compiled output never
# ran, nothing consumed it, and running from source means production executes
# exactly what every test executes.

# ---------------------------------------------------------------- deps --
# Manifests only, so this layer is cached until a dependency actually changes.
# Every workspace manifest has to be here even though most are not needed at
# runtime: `npm ci` builds the whole workspace tree or none of it.
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/sim/package.json packages/sim/
COPY packages/content/package.json packages/content/
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
COPY apps/console/package.json apps/console/
COPY services/api/package.json services/api/

# `--omit=dev` leaves out vite, vitest, playwright and three.js — none of which
# the service has ever needed — and takes the image from hundreds of megabytes
# to tens. `--ignore-scripts` stops Playwright's postinstall trying to download
# a browser into a server image.
RUN npm ci --omit=dev --ignore-scripts

# ------------------------------------------------------------- runtime --
FROM node:22-alpine AS runtime

# `HOST` defaults to 127.0.0.1 in `config.ts`, which is right on a laptop and
# useless in a container: the process would bind to the container's own
# loopback and nothing outside it could ever connect. This is the single line
# whose absence looks exactly like a broken deployment.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# All three packages, not just the two the service names.
#
# `services/api` imports `@somemore/protocol` and `@somemore/content` — and
# `@somemore/content` imports `@somemore/sim`, and `protocol` imports both. The
# service does not mention `sim` anywhere, so an image built from the two
# obvious packages builds perfectly and then dies on its first line with
# "Cannot find package '@somemore/sim' imported from content/src/validate.ts".
# Found by assembling this stage on disk and booting it, which is the only way
# a missing COPY ever announces itself.
COPY packages/sim ./packages/sim
COPY packages/content ./packages/content
COPY packages/protocol ./packages/protocol
COPY services/api ./services/api

# `node` rather than root. The image writes nothing to disk — the campsite
# lives in Postgres and the media adapter is a boundary — so it needs no
# ownership of anything it has been given.
USER node
EXPOSE 8080

# The service's own honest answer: `{"ok":true,...}` with the database's
# reachability and pool inside it, so an unhealthy container is one that cannot
# reach its database rather than merely one that has not crashed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/services/api
CMD ["npm", "start"]
