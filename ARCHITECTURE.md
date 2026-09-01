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
| `fire` | Fuel/ember/oxygen/wind/ash model. Fuel is positioned in the pit and its airflow, ignition heat and drying rate are derived from where it lies; produces a heat field and visual drive signals |
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

**The corollary, learned the hard way: input must be applied on the input's
clock, not the frame's.** Decoupling the simulation from the frame rate means a
slow frame runs many simulation steps, and anything sampled once per frame is
held constant across all of them. Continuous input (a drag) can afford that,
because its next sample is a few milliseconds away and differs by a few pixels.
A discrete input (a key press) cannot: under software rendering the roasting
close-up runs at about 1.5 frames a second, and twenty-four presses of the turn
key were applied as one. So a handler that receives a discrete input applies it
there and then — `applyRoastPose` is called from the key handler as well as from
the frame loop — and the frame loop's job is only to keep up with the things
that change on their own, such as the bearing a walking player holds the stick
from. See defect #25 in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

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

### 6.1 How the client stays in step

The client half (`apps/web/src/net/`) needs neither a jitter buffer nor
rollback, because the server hands it an exact safety rule for free. Every
message a session room emits — `input`, `ack`, `authority`, `presence`,
`arrival`, `departure`, `chat`, `snapshot` — is produced inside the room's
serialised queue and leaves on one socket in the order the inputs were stamped.
So **receiving any room message carrying tick T proves every input below T has
already been sent.** The shared timeline advances to that tick and no further,
which means an input can never arrive for a tick already stepped; the client
counts violations and says so rather than diverging quietly. (`pong` and
transport-level `error` are answered outside the queue and are deliberately not
trusted for this.)

Local input is applied on the tick the server *acked*, exactly like everybody
else's — the sender is acked rather than echoed, so the ack is where a player's
own intent enters the timeline. What is predicted is only the *picture*: after
the step, the marshmallow in your own hand is drawn where your pointer is,
which the next step overwrites. Input-to-visible stays under the §10 limit; the
thermal consequence lands one round trip later, which at a 45-second roast is
invisible.

**What does not converge, and is not pretended to.** The ritual core — fire,
marshmallow, assembly, machine — is exact. The world systems (wildlife,
discovery, radio reception, the sky) are driven by `PresenceInput`, each
client's own observation of its own player, which is deliberately not on the
input wire: a 60 Hz position stream per player is the bandwidth ADR-0006 exists
to avoid. Those are yours, not the campsite's. Blocking somebody is the other
honest divergence: the server stops relaying their inputs in both directions,
so the two of you are genuinely no longer watching the same fire, and the
client says so.

**Where proximity attenuation is applied.** `proximityGain` is a pure function
in the protocol so a client and an SFU-side mixer can agree exactly. The client
applies it per track, per frame, and turns the `PannerNode`'s own distance model
*off* while doing it: two distance curves multiplied together would attenuate a
voice at the treeline twice, and a panner's inverse curve cannot be made to
equal the shared one. The panner keeps the job only it can do — direction, and
the listener basis it shares with the fire and the wildlife.

---

## 7. Persistence

**Three tiers:**

| Tier | Store | Contents |
| --- | --- | --- |
| Session | memory | live simulation state |
| Device | IndexedDB / localStorage | anonymous Passport, settings, un-uploaded photos, offline campsite state |
| Account | PostgreSQL + object storage | Passport, campsites, campsite memory, photo bytes, sandwich records, orders, rewards |

**Local-first.** The ritual works offline. Device state syncs to the account when one exists; the anonymous → linked transition is a *merge*, never a reset (see `protocol` identity linking).

**Campsite traces** carry a `significance` value and a `decayRate`. A nightly job ages traces; those below a floor are removed, those above a ceiling are promoted to permanent landmarks. Significance is never exposed to the client as a number — and, since ADR-0010, is not expressible on the wire at all: a synced trace carries a disposition and a birth time, its lifetime is derived from the disposition, and the evidence the model weighed never leaves the device that produced it.

**Campsite memory syncs per device, not per account** (ADR-0010). Each device reports only the nights it was there and the service sums grow-only counters, which is the only rule that neither loses a night when two devices camp offline nor double-counts on every re-sync.

---

## 8. Backend (`services/api`)

Node 22 + TypeScript on `node:http` with a small typed router (ADR-0005). Domains: identity · passport · campsites · sessions · worldState · rewards · commerce · moderation · analytics. Every storage edge is a repository interface with two implementations — in-memory for tests and dev, PostgreSQL for everything else — chosen at boot by whether `DATABASE_URL` is set. The whole suite runs against both.

**Commerce** uses a custom domain model with a `PaymentProvider` abstraction (Stripe first, fake provider for tests). Raw card data never enters our systems — only provider tokens and intent ids. Every mutating commerce operation requires an idempotency key: same key + same payload replays the original result; same key + different payload is a conflict.

**Security:** HMAC-signed tokens, authorization checked at every resource boundary, high-value rewards validated server-side with claim-once semantics and rate limiting, no secrets in the repository. Staff actions are gated by named per-account capabilities rather than a shared secret (ADR-0011), and rate-limit windows are counted in the database so two instances share one allowance rather than getting one each.

---

## 9. Content pipeline

**Now:** environments are validated TypeScript data objects in `packages/content`, driving procedural generation.

### 9.1 Every field a manifest carries either reaches a player or is authoring metadata

A manifest field that is neither is prose in a file nobody opens. This project accumulated a lot of it: an audit found **46 of 131 fields unread by the client or the simulation**, including five-beat arrival sequences for all twelve environments, three or four described landmarks per campsite, every campsite's soundscape, its firewood, its own firelight colour, and what its SM-01 tends to be like. The catalogue described twelve distinct places and the game rendered one clearing with a machine in it.

**Twelve remain unread, and they are authoring and validation metadata, correctly unread by the runtime:** `inspiration`, `biomeTags`, `invariants`, `seedStreams`, `handcrafted`, and the `performance` block (`midTierDrawCalls`, `midTierTriangles`, `dynamicLights`, `performanceCost`, `lowTierCuts`). The performance block is now *checked* by `e2e/perf.spec.ts` against what the renderer actually produces, and the claim is printed beside the measurement — Pine Hollow claims 74 draw calls and measures about 107, which is the kind of drift that only gets worse in silence. `seedStreams` stays metadata but its *intent* is now implemented: every seeded variation draws from a stream named after itself, so one system's rolls cannot shift another's.

`rewardCodes` was miscounted in the first pass of this audit — it is read, by `services/api/src/domain/liveops.ts`, which validates every code on a seasonal event against the kit catalogue before the event may be published.

**The five that were real gaps are now wired.**

- **`character.treeCover`** decides the treeline (`treesForCover`, `apps/web/src/scene/layout.ts`). The renderer used to sum the density of every vegetation kit over 2.5 m, a rule that contradicted the axis wherever the two disagreed: the cedar switchback is authored `canopy` with sky openness 0.08 and was drawn with half the trees of a `moderate` lake shore, and a mesa graded `none` had two. Kits still decide where inside a cover band a campsite sits, so two dense woods are not the same wood.
- **`character.eeriness`** decides how often, and how unpredictably, a campsite is heard from a long way off (`packages/sim/src/place.ts`). It cannot do more than that: the schema's own calibration rule says the axis "never reaches *threatening*" and "nothing stalks, chases or endangers the player at any value", so a strange place is one that carries sound further and is less sure what it was — never one where something is out there.
- **`activities[].prominence`** decides what the survey says this campsite is *for* (`packages/sim/src/survey.ts`). Every environment marks exactly one activity `signature`; a player who can see the screen finds it by walking into it, and the survey exists for the player who cannot.
- **`procedural.variations`** — sixty authored per-visit differences, five per campsite, each with a range, a unit and a note written as an instruction to whoever implemented it ("Drives fog density, star visibility and how the point light reads"). Nothing had ever rolled one, so every visit to a campsite was the identical visit. `packages/sim/src/variation.ts` rolls each on its own named stream — from the campsite's seed **and which visit this is**, because `campsiteSeed` is stored on the device and reused, so rolling from it alone would have produced the same night every night and changed nothing at all; what stays fixed between visits is `invariants`, which is not rolled — and maps the ids onto eleven *roles*; `packages/sim/src/tonight.ts` applies a role by handing a system an adjusted copy of the content it was going to be built from anyway, so no system knows §5.4 exists. Forty-seven of the sixty turn a dial; the other thirteen are recorded in the same table as driving nothing, because the thing they describe — the shape of a restacked cairn, the candle stubs on the shelf — is not modelled. There is deliberately no readout: a variation reaches a player as the thing it changed, never as a line saying what was rolled.

**Two rules keep this from rotting back.**

Adding a field to `packages/content/src/schema.ts` means wiring it or marking it, in its own docstring, as authoring metadata. And `packages/content/test/catalogue.test.ts` holds the catalogue against the code that consumes it: that `VARIATION_ROLES` is exhaustive over the catalogue in both directions, that no campsite varies fewer than three things, that a campsite's cover and its sky openness agree, that no two campsites open on the same line, that no two soundscapes collapse together, that every landmark has something to say. A catalogue whose twelve campsites agree about everything is a catalogue with one campsite in it.

### 9.1a A HUD laid out by hand-computed offsets will eventually cover itself

Every channel in the heads-up display is absolutely positioned by percentage or by a pixel offset from an edge. That is a reasonable way to lay out a HUD over a 3-D scene, and it has one failure mode that no assertion about *content* can see: both elements render, both carry the right text, every test passes, and one is sitting on top of the other.

It happened twice. The notice sat at 19% and the reach prompt at 18% — one percent apart on a button five percent tall — so the sentence introducing a campsite's firewood covered the control for picking any of it, at exactly the moment both appear. And the guidance line sat at `46px × textScale` with a comment claiming it was clear of the corner controls, while overlapping them on all three phones in the mobile suite.

The second is the instructive one, because **no constant could have been correct**. The corner buttons are `7px × textScale` of padding around `12px × textScale` of type inside a container with a *fixed* 12px pad; their height and the guidance's offset scale at different rates, so any single number fails at some text size — and it failed worst for the players who most need large type. The fix is not a better number, it is not having one: the top band is a flex column, the corner row takes the height it takes, and the line flows beneath it.

**The rule:** where two HUD channels can be on screen together, either lay them out so the browser keeps them apart, or check the boxes. `hudBoxes`/`hudCollisions` in `e2e/helpers.ts` read the bounding boxes of every visible channel; `access.spec.ts` runs it at desktop width at the moment the notice and the reach prompt collide, and `mobile.spec.ts` runs it at all three device sizes, which is where a wrapped line makes a collision likeliest and where nobody is looking.

A visual baseline cannot stand in for this. It compares whole frames at a six-to-twelve per cent tolerance, measured from the fire's own flicker; one panel moving under another is a fraction of one per cent.

### 9.2 A manifest field can be written in two voices, and only one of them may reach a player

`ActivityEntry.note` turned out to hold both — and it turned out not to be alone. Most of it is prose about the place — "a cane pole, a cork float, and a lantern hung over the rail" — and twenty-two of the hundred and thirteen notes also carry a sentence addressed to the team that built it: "the most patient activity in the game and people love it", "the reference implementation", "this is the reason the audio engine has a canyon impulse response".

Those sentences are worth keeping. They are the clearest record anywhere of what each campsite is *for*, and a manifest is where that record belongs. What they cannot do is reach a player, and when the client started showing activity notes as notices, they did.

`packages/content/src/voice.ts` splits the two at presentation time, and `catalogue.test.ts` pins the result for all hundred and thirteen, so what a player is told is something a person has read. Fifteen of the leaks were a single sentence that was half description and half appraisal — "firelight on straight trunks is the most forgiving light in the catalogue" — and the filter, which works a sentence at a time, took the whole thing; splitting each into two sentences in the manifest kept both halves. Every authored string in the catalogue now has something a player may hear.

**The activity notes were where this was found; they were not where it lived.** The first pass filtered `activities[].note` and stopped there, and the end-to-end survey test promptly read a player two sentences of the cicada bottoms' own ambience prose — "that silence is the eeriest sound in the game", "which is why the environment feels sheltered". Nineteen more of the catalogue's **386 player-facing strings** carried the same kind of sentence: ground and elevation notes, weather character, ambience, distant sounds, arrival beats, landmark notes, how a wood is found, what an animal sounds like, the SM-01's own sticker.

The filter is now applied once, in `apps/web/src/state/worldContent.ts`, which is also the single builder for the world object handed to the simulation — it had been copied between the solo and shared paths, two copies that had to agree because a shared world is rebuilt from the same manifest on every client. The arrival sequence is filtered in `App.tsx`, since it never reaches the simulation. The test covers all 386, and fails equally on a string that leaks and on one the filter empties. The rule is deliberately blunt — a sentence naming the game, the catalogue, the product, an environment as an environment, or what people in general will do, is about the artefact rather than the place — because a false positive costs one sentence of flavour and a false negative breaks the fiction in front of somebody.

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

Static budgets: ≤ 120 draw calls on the mid tier · ≤ 60k triangles visible · ≤ 24 MB texture memory · zero per-frame allocation in simulation hot paths.

**Dynamic lights are budgeted per stage, not globally: ≤ 6 in the explorable
world, ≤ 10 in the anchored close-ups.** The original single figure was written
before the hero tier existed. In the world the camera sees a campsite and six
lights is the right ceiling; in the reveal it sees one small object against a
nearly empty scene, and the shading cost of ten lights over a hundred visible
triangles is not the cost of ten lights over a forest. The finished sandwich's
key/fill/rim rig is what fixed the "renders as an unlit silhouette" defect and
is not negotiable. The two cases cannot overlap: a lit torch would be an
eleventh light, so the simulation stows the torch on entering a stage that
needs both hands — you cannot hold a torch and a marshmallow — which makes the
constraint a product rule rather than a render trick.

Both figures are pinned in `tools/budgets.mjs` so neither can quietly drift.

**Adaptive quality tiers** (`low`, `mid`, `high`) scale internal resolution, shadow map size, particle counts, patch grid resolution, draw distance, post-processing, and environment density. Tier is chosen by a startup probe and adjusted by a rolling frame-time monitor — never by device string sniffing.

**Rule:** responsiveness during tactile interaction outranks fidelity. Input → visible response must stay under 50 ms even when frames are being dropped.

---

## 11. Accessibility architecture

Settings live in one observable store consumed by simulation (assists), rendering (dither, motion, contrast, fire brightness), audio (per-bus volume, transient taming), and UI (text scale, subtitles). Nothing reads device settings directly, so every knob is testable. Assists change dexterity requirements only, never outcomes.

### How the service runs

From TypeScript source, in production as in development and in every test —
`node --import ./runtime/ts-resolve.mjs src/main.ts`. Not a shortcut: the
compiled output could not run and never had, because the workspace packages
declare `"exports": "./src/index.ts"` and a compiled service resolving
`@somemore/protocol` lands on TypeScript. Pointing the packages at built
JavaScript instead would have meant tests resolving `src` while production
resolved `dist`, which is the shape of defect #18. One loading path is worth
more than a conventional artifact. `tsc -b` typechecks and emits declarations
for the project references, and no longer emits JavaScript.

`services/api/Dockerfile` builds from the **repository root**, because the
service imports its workspace packages — including `@somemore/sim`, which it
never names and reaches through `@somemore/content`. `docker-compose.yml`,
`fly.toml` and `render.yaml` all run migrations as a release step rather than at
boot, so two instances cannot race through the same migration. See
[`services/api/DEPLOY.md`](./services/api/DEPLOY.md), which is explicit that the
image has never been built here and lists what was verified instead.

### Where the app is served from

`BASE_PATH` (default `/`) is one value threaded through everything that writes a
path: Vite's `base`, the manifest's `id`, `start_url`, `scope` and icon `src`,
the service worker's registration scope, its precache list, its own script path,
and the API base the client falls back to. The client half reads
`import.meta.env.BASE_URL`, which Vite fills from the same `base`, so there is
no second place to keep in step.

It exists because a GitHub project page serves the app from a subdirectory, and
a build that assumes the origin root does not degrade there — it does not start.
The failures are also worse than a broken picture: a worker registered with a
scope of `/` from a subdirectory is refused outright, and a precache list of
root paths installs *another site on that origin* as this app's offline shell.
Both are invisible until somebody deploys, which is why `e2e/subpath.spec.ts`
builds under a base, serves it there, and asserts that no request is ever made
outside it.

The API base follows the app rather than the origin, for the same reason: an app
that has been moved should take its service with it. `VITE_API_URL` still
overrides, for a service somewhere else entirely.

Overlays share one `useDialog` hook (`apps/web/src/ui/useDialog.ts`) rather than
six copies of the same contract: `aria-modal`, focus moved in on open, Tab and
Shift+Tab cycling inside, focus restored to the opener on close. Anything the
product says that is *not* a transcript of a sound goes to the store's `notice`
channel rather than to subtitles, because subtitles sit behind a setting and a
failure report must not be optional. And anything whose only other channel is a
colour — the SM-01's amber and blue — is also narrated in words by a
visually-hidden live region, which names the colour so the two channels are
describing the same machine.

One thing in that store is deliberately **not** a setting: `controls`, which is
`'pointer'` or `'keyboard'` and follows whatever the player last touched. It has
exactly one consumer — the guidance line — and exists because an alternate
control scheme that is never named is one nobody finds. There is nothing to
switch on and nothing to discover in a menu; play with a key and the line starts
talking about keys. It is ephemeral and never persisted, because it is an
observation about this minute rather than a preference.

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
| Visual | Screenshot capture at each ritual stage for human inspection, plus frame-health metrics, plus the guidance line read back as **text** — a whole-frame pixel ratio cannot see a line of 13px type, so without that the words on the screen were unverified |
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
| [0009](./docs/adr/0009-media-storage-behind-an-interface.md) | Photo bytes behind a `MediaStorage` interface, with a real local-disk adapter |
| [0010](./docs/adr/0010-campsite-memory-sync.md) | Campsite memory syncs as per-device counters; the significance score has nowhere to ride |
| [0011](./docs/adr/0011-operator-capabilities.md) | Operators hold named capabilities; the shared ops secret becomes a spent bootstrap |
