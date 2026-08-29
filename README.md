# Some More

A cross-platform interactive campfire world for mobile and web.

> Arrive at a campsite. Tend the fire. Roast a real marshmallow. Physically
> assemble a hot s'more. Load it into the Some More **SM-01** transformation
> freezer. Watch the amber light turn blue. Open the latch, let the cold
> vapour fall out, and take out a roasted-marshmallow ice cream sandwich.

**graham cracker cookie → chocolate → roasted-marshmallow ice cream → chocolate → graham cracker cookie**

---

## Running it

```bash
npm install
npm run dev          # the world, at http://127.0.0.1:5173
```

```bash
npm test             # 700+ unit and integration tests
npm run typecheck    # project-wide TypeScript
npm run build        # build every package
npm run test:e2e     # drives the whole ritual in Chromium, capturing screenshots
npm run api          # the backend service
```

`?camp=<seed>` pins a campsite (and therefore its SM-01's serial number and
wear). `?env=<id>` pins an environment — see
[`packages/content/CONCEPTS.md`](./packages/content/CONCEPTS.md) for the
catalogue.

## What is here

| Path | What it is |
| --- | --- |
| [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) | The product, as a source of truth |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System boundaries, budgets, decisions |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Current state, priorities, risks, blockers |
| [`docs/adr/`](./docs/adr) | Architecture decision records |
| `packages/sim` | Deterministic simulation core — fire, heat, roasting, assembly, the SM-01, the sandwich, weather, astronomy, memory. Pure TypeScript, no DOM. |
| `packages/content` | 26 campsite concepts scored, 12 selected, encoded as validated data |
| `packages/protocol` | Zod contracts shared by client and server |
| `apps/web` | React + React Three Fiber + Three.js client |
| `services/api` | Node/TypeScript backend and PostgreSQL schema |
| `e2e/` | Playwright acceptance tests that drive the real ritual |
| `artifacts/screenshots/` | Stage-by-stage captures for visual inspection |

## Three things worth knowing

**Everything is generated at runtime.** There are no binary assets in this
repository — no textures, no models, no audio files. Geometry is authored in
code, textures are drawn into canvases from seeds, and every sound is
synthesised with WebAudio. This began as a constraint and turned out to suit
the art direction: a PS1 look wants 64-pixel textures. See
[ADR-0002](./docs/adr/0002-procedural-assets.md).

**The PS1 look is structural, not a filter.** Vertex jitter comes from snapping
clip-space positions to a virtual raster before the perspective divide; texture
swim comes from actually interpolating UVs affinely; the picture is rendered at
320×240 and upscaled with nearest-neighbour. Each effect is per-material and
per-tier, which is what lets the finished sandwich receive a fidelity bump and
lets a player turn any of it down. See
[ADR-0003](./docs/adr/0003-ps1-render-pipeline.md).

**The simulation is deterministic and separate.** No DOM, no Three.js, no wall
clock, no unseeded randomness, fixed 60 Hz timestep. That is what makes
roasting testable headlessly, multiplayer replicable from inputs alone, and a
sandwich re-derivable server-side to validate a real-world reward. See
[ADR-0001](./docs/adr/0001-deterministic-simulation-core.md) and
[ADR-0006](./docs/adr/0006-input-authority-multiplayer.md).

## Status

Priority 1 — the ritual — is playable end to end. Priorities 2 through 4 are
partly built and fully architected; the current state, and every external
credential the remaining work is blocked on, is tracked honestly in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).
