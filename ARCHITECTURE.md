# Some More — Architecture

**Status:** living document · v0.2
**Companions:** [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) (what) · [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (when)

---

## 1. Principles

1. **Simulation is pure; presentation is disposable.** Every gameplay-meaningful system is deterministic TypeScript with no DOM, no Three.js, and no time source of its own. Renderers, audio, and networking read from it, never the reverse.
2. **Determinism is a feature.** Same seed + same input timeline ⇒ same result, on every device. This is what makes roasting testable, multiplayer reconcilable, sandwiches reproducible, and rewards server-verifiable.
3. **Content is data.** Environments, weather, wildlife, radio, rewards and machine quirks are validated data. Adding content changes no engine code.
4. **Boundaries, not microservices.** One backend service, hard internal domain boundaries, repository interfaces at every storage edge.
5. **Degrade, never block.** Missing permission, missing network, missing credential ⇒ a graceful, high-quality fallback path. No feature is allowed to hard-fail the ritual.

---

## 2. Repository layout

```
some-more/
├── PRODUCT_SPEC.md ARCHITECTURE.md IMPLEMENTATION_PLAN.md
├── docs/adr/                  Architecture decision records
├── packages/
│   ├── sim/                   Deterministic simulation core (pure TS, no DOM)
│   ├── content/               Environment catalogue + content schemas
│   └── protocol/              Zod contracts shared by client and server
├── apps/
│   └── web/                   React + R3F + Three.js client
│       └── src/
│           ├── render/        PS1 pipeline, shaders, procedural materials
│           ├── audio/         Procedural WebAudio engine
│           ├── scene/         World composition, props, the SM-01
│           ├── interaction/   Input → simulation intent mapping
│           ├── ui/            Passport, terminal, settings, subtitles
│           └── state/         Client store, persistence, settings
├── services/api/              Node/TS backend + PostgreSQL schema
└── artifacts/screenshots/     Visual inspection captures
```

**Dependency direction is strictly one-way:**

```
protocol ─┬─► api
          └─► web
sim ──────┬─► content ─► web
          └─► web
```

`sim` depends on nothing. `content` depends only on `sim` types. Nothing depends on `web`.

---

## 3. Simulation core (`packages/sim`)

Pure, deterministic, framework-free. Fixed-timestep, explicitly advanced by the caller.

| Module | Responsibility |
| --- | --- |
| `rng` | Seeded, splittable PRNG (SplitMix64-derived) + derived streams so subsystems cannot desynchronise each other |
| `math` | Clamp, lerp, smoothstep, exponential approach, damping, angle helpers |
| `time` | Fixed-timestep accumulator, deterministic clock |
| `fire` | Fuel/ember/oxygen/wind model, produces a heat field and visual drive signals |
| `heatfield` | Spatial radiant + convective query used by roasting |
| `roasting` | Per-patch thermal marshmallow model (moisture → browning → char → ignition → melt/sag) |
| `assembly` | Freeform placement with magnetic assist, alignment/squish/crumb/smear record |
| `machine` | SM-01 state machine, serialization, wear, quirks, run telemetry |
| `sandwich` | Deterministic derivation of the finished sandwich from roast + assembly + machine |
| `eating` | Bite geometry state, crumbs, fracture |
| `weather` | Evolving weather state, transitions, rare events |
| `astronomy` | Sun/moon/star/meteor state from date + approximate latitude |
| `significance` | Invisible memory-importance model driving persistence and landmarks |
| `ritual` | The session state machine binding every stage together |

### 3.1 Fixed timestep

Simulation runs at **60 Hz fixed** (`SIM_DT = 1/60`), decoupled from render framerate via an accumulator with a max catch-up clamp (250 ms) to prevent spiral-of-death. Render interpolation is the renderer's problem.

### 3.2 The heat model

Two heat sources, deliberately separated because they behave differently and their difference is a gameplay discovery:

- **Flame** — hot, tall, unstable, wind-deflected, weak at close range low down.
- **Embers** — cooler peak but steady, low, wide, wind-*boosted*, and radiating upward.

A surface patch receives:

```
q_total = q_radiant(source, distance, orientation) + q_convective(column, height, wind) - q_loss(ambient, wind, moisture)
```

`q_radiant` uses an inverse-square falloff with a near-field softening term (prevents a singularity when the marshmallow touches the coals) and a Lambertian orientation factor. `q_convective` samples a wind-deflected rising column. Moisture must boil off (latent heat sink) before surface temperature can climb into the browning band — this is why a fresh marshmallow resists and then suddenly goes.

### 3.3 Roasting patch grid

The marshmallow surface is an **8 longitude × 4 latitude = 32 patch** grid (tier-scalable to 6×3 on low-end devices). Each patch holds: `temperature`, `moisture`, `brown`, `char`, `blister`, `melt`. Patches conduct heat to neighbours at a low rate (sugar is a poor conductor — this is why one-sided roasting stays one-sided, which is the whole reason rotation matters).

**Sides are tracked independently** and the summary exposes per-side statistics so "one-sided" is a real, detectable outcome.

Browning follows a temperature-gated sigmoid rate; char begins above a higher threshold; ignition requires sustained char plus surface temperature above the ignition point plus available oxygen.

---

## 4. Rendering (`apps/web/src/render`)

### 4.1 The PS1 pipeline

| Effect | Technique |
| --- | --- |
| Low internal resolution | Render to a `WebGLRenderTarget` at 320×240–640×480 depending on tier, upscaled with `NearestFilter` |
| Vertex jitter | Vertex shader snaps clip-space position to a virtual raster grid before perspective divide |
| Affine texture instability | UVs passed with `noperspective`-equivalent behaviour: multiply UV by `w` in the vertex shader, divide by an interpolated `w` in the fragment shader, blended by a per-material `affineness` factor |
| Pixelated textures | All procedural textures use `NearestFilter`, no mipmaps by default, small power-of-two sizes |
| Dithering | Ordered 4×4 / 8×8 Bayer matrix applied in screen space during the post pass, with quantisation to a reduced colour depth (5:5:5 by default) |
| Fog | Exponential vertex fog with a short, per-environment draw distance |
| Crunchy shadows | Low-resolution shadow maps with hard PCF-off comparison, plus baked-feel blob shadows for small props |
| Restrained animation | Animation sampled at a reduced rate (10–15 Hz) and held, rather than smoothly interpolated |

**The quantisation floor is an art-direction constraint, not a detail.** At
5 bits per channel the smallest expressible non-zero value is about 8/255, so
anything lit below that does not render as very dark — it renders as nothing.
This was found by measuring: the campsite at coals sat at roughly 3/255 and
the entire ground plane was pure black, and tripling the light levels changed
almost nothing until they cleared the floor. Every surface the player must be
able to see at night has to be lit above it, and `e2e/night.spec.ts` asserts
that the night stays inside a legible band rather than merely above zero.


### 4.2 The fidelity bump

Implemented as a **material tier** rather than a separate renderer, so the world stays cohesive:

| Tier | Used by | Behaviour |
| --- | --- | --- |
| `ps1` | everything | full jitter, full affine, 64–128px textures, quantised |
| `ps1Plus` | the SM-01 | reduced jitter, crisp decals, real specular |
| `hero` | the finished sandwich only | jitter off, affine off, 256–512px textures, sheen/frost/condensation, local light, higher-density geometry |

The post-process dither and low-res pass still apply to hero objects, which is what keeps them *of* the world rather than pasted onto it.

### 4.3 Procedural materials

No binary assets exist (see ADR-0002). Textures are generated at runtime into `OffscreenCanvas`/`canvas` and cached by key: graham crumb, chocolate, marshmallow, char, bark, foliage, dirt, gravel, water, enamel, brushed aluminium, smoked plastic, decals, serial plates, sticker sheets, frost. Every generator is seeded, so a campsite's machine wear is reproducible from its serial.

The generators are behind a `MaterialSource` interface; a glTF/texture-atlas source can replace any key without touching call sites.

---

## 5. Audio (`apps/web/src/audio`)

Fully synthesised WebAudio (ADR-0002). Buses: `ambience`, `fire`, `machine`, `foley`, `ui`, `voice`, each independently attenuable for accessibility. Fire and ambience are continuous synths driven by simulation state; machine and foley are event-triggered voices. Reverb uses procedurally generated impulse responses per space type. Spatialisation goes through `PannerNode`s so multiplayer voice can attach to the same path.

---

## 6. Multiplayer model

**Topology:** authoritative-ish server session with client prediction for local interaction. The server owns session membership, campsite state, and anything reward- or commerce-relevant.

**Object authority:** every interactable carries a `TemporaryOwnership { holder, grantedAt, expiresAt }`. Picking an object up requests authority; the server grants it if unheld or expired. The holder simulates and broadcasts; others interpolate. Hand-off (passing a roasting stick) is an explicit authority transfer with a short mutual-hold window so the object never visibly teleports.

**Why deterministic sim matters here:** because roasting is deterministic, the network only carries *inputs and authority*, not per-patch thermal state — 32 patches × several floats at 60 Hz would be unshippable. A late joiner receives the seed and input history and reconstructs the marshmallow exactly.

**Transport:** WebSocket for session/state, WebRTC (LiveKit-style abstraction) for spatial voice. Voice is never recorded by default.

**Anti-grief:** authority cannot be stolen from an active holder; destructive actions on another player's in-progress work are not expressible in the protocol; repeated interference is rate-limited.

---

## 7. Persistence

**Three tiers:**

| Tier | Store | Contents |
| --- | --- | --- |
| Session | memory | live simulation state |
| Device | IndexedDB / localStorage | anonymous Passport, settings, photos, offline campsite state |
| Account | PostgreSQL + object storage | Passport, campsites, sandwich records, orders, rewards |

**Local-first.** The ritual works offline. Device state syncs to the account when one exists; the anonymous → linked transition is a *merge*, never a reset (see `protocol` identity linking).

**Campsite traces** carry a `significance` value and a `decayRate`. A nightly job ages traces; those below a floor are removed, those above a ceiling are promoted to permanent landmarks. Significance is never exposed to the client as a number.

---

## 8. Backend (`services/api`)

Node 22 + TypeScript on `node:http` with a small typed router (ADR-0005). Domains: identity · passport · campsites · sessions · worldState · rewards · commerce · moderation · analytics. Every storage edge is a repository interface with an in-memory implementation for tests/dev and a PostgreSQL schema (`services/api/sql/schema.sql`) ready for the adapter.

**Commerce** uses a custom domain model with a `PaymentProvider` abstraction (Stripe first, fake provider for tests). Raw card data never enters our systems — only provider tokens and intent ids. Every mutating commerce operation requires an idempotency key: same key + same payload replays the original result; same key + different payload is a conflict.

**Security:** HMAC-signed tokens, authorization checked at every resource boundary, high-value rewards validated server-side with claim-once semantics and rate limiting, no secrets in the repository.

---

## 9. Content pipeline

**Now:** environments are validated TypeScript data objects in `packages/content`, driving procedural generation.

**Designed for:** Blender → glTF/GLB with modular kits, atlases, KTX2/Draco compression, LODs, and versioned metadata schemas. Because scene composition already reads from a manifest, swapping a procedural prop for an authored GLB is a manifest edit.

**Live ops** reads the same schemas, so scheduling, preview, rollback, and audit apply to identical content shapes.

Concretely (ADR-0007): live content is an **overlay**, never a replacement. The client boots from the catalogue compiled into it and fetches `GET /v1/content/manifest` afterwards, behind an ETag; a failed, slow or absent fetch leaves a fully working campsite. Documents move `draft → staged → published → retired` and are validated **at publish time by `packages/content`'s own validator** — the same one the compiled catalogue passes — so a malformed environment is an operator's 422 rather than a player's broken world. Every publish, retirement and rollback appends an immutable numbered release; a rollback republishes an earlier release's bodies as new versions rather than rewinding, so the audit trail never loses a step. Activation windows are evaluated server-side against the injected clock, never a client's.

**Physical ↔ digital** (ADR-0008): one signed code format serves package codes, event activations and the multiplayer QR join path. Codes are Ed25519-signed, offline-verifiable, and carry no identity, no capability and no value — the entitlement lives on the print run, server-side. Claim-once is a unique index rather than application logic, and one compromised run is retirable without invalidating every code ever printed.

---

## 10. Performance budgets

Per frame at the 60 FPS target tier (16.6 ms):

| Budget | Target |
| --- | --- |
| Simulation (all systems) | ≤ 1.5 ms |
| Scene graph + culling + draw submission | ≤ 3.0 ms |
| GPU main pass | ≤ 7.0 ms |
| GPU post (dither/upscale) | ≤ 1.5 ms |
| Audio scheduling (main thread) | ≤ 0.5 ms |
| Headroom | ≥ 3.0 ms |

Static budgets: ≤ 120 draw calls on the mid tier · ≤ 60k triangles visible · ≤ 24 MB texture memory · ≤ 6 dynamic lights (fire counts as one, with baked-feel falloff) · zero per-frame allocation in simulation hot paths.

**Adaptive quality tiers** (`low`, `mid`, `high`) scale internal resolution, shadow map size, particle counts, patch grid resolution, draw distance, post-processing, and environment density. Tier is chosen by a startup probe and adjusted by a rolling frame-time monitor — never by device string sniffing.

**Rule:** responsiveness during tactile interaction outranks fidelity. Input → visible response must stay under 50 ms even when frames are being dropped.

---

## 11. Accessibility architecture

Settings live in one observable store consumed by simulation (assists), rendering (dither, motion, contrast, fire brightness), audio (per-bus volume, transient taming), and UI (text scale, subtitles). Nothing reads device settings directly, so every knob is testable. Assists change dexterity requirements only, never outcomes.

---

## 12. Testing strategy

| Layer | Approach |
| --- | --- |
| Simulation | Deterministic unit tests + golden-timeline replay tests (same seed + inputs ⇒ identical outcome) |
| Content | Schema validation across the whole catalogue; invariants (every environment reachable, weights valid) |
| Protocol | Accept/reject tests on every schema; state-machine legality |
| Backend | HTTP integration tests against a real server on port 0, including authz failures and idempotency replay/conflict |
| Client logic | Unit tests for pure helpers (materials, input mapping, PS1 math, audio math) |
| E2E | Playwright drives the full ritual in Chromium and captures screenshots per stage |
| Visual | Screenshot capture at each ritual stage for human inspection |
| Performance | Frame-time instrumentation with a headless budget assertion |

---

## 13. Decision records

| ADR | Decision |
| --- | --- |
| [0001](./docs/adr/0001-deterministic-simulation-core.md) | Deterministic, pure simulation core separate from presentation |
| [0002](./docs/adr/0002-procedural-assets.md) | All assets procedurally generated at runtime |
| [0003](./docs/adr/0003-ps1-render-pipeline.md) | PS1 look via shader jitter/affine + low-res target + ordered dither |
| [0004](./docs/adr/0004-defer-rapier.md) | Defer Rapier behind a physics abstraction |
| [0005](./docs/adr/0005-node-http-backend.md) | `node:http` + typed router instead of a framework |
| [0006](./docs/adr/0006-input-authority-multiplayer.md) | Multiplayer replicates inputs + authority, not simulation state |
| [0007](./docs/adr/0007-live-ops-content-overlay.md) | Live content is a versioned overlay with append-only releases |
| [0008](./docs/adr/0008-signed-offline-verifiable-codes.md) | One signed, offline-verifiable code format for wrappers, events and campfires |
