# Some More — Implementation Plan

**Status:** living document · updated continuously · last updated: session 1
**Companions:** [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## Current state

**Session 1 complete.** The repository was empty at session start (a README
containing one line). Everything below was built from zero.

| Area | State |
| --- | --- |
| Monorepo, TypeScript, Vite, Vitest, Playwright | ✅ |
| PRODUCT_SPEC / ARCHITECTURE / 6 ADRs / README | ✅ |
| `packages/sim` simulation core | ✅ 233 tests |
| PS1 render layer + procedural materials | ✅ 32 tests |
| Procedural audio engine | ✅ 102 tests |
| `packages/content` — 26 concepts scored, 12 encoded | ✅ 79 tests |
| `packages/protocol` + `services/api` | ✅ 230 tests |
| P1 playable ritual, end to end | ✅ driven by E2E in Chromium |
| Passport, photo mode, accessibility | ✅ built, E2E-verified |
| Multiplayer | ⬜ architected (ADR-0006), not built |
| Live ops / CMS | ⬜ schemas exist, tooling not built |

**704 unit and integration tests + 4 end-to-end acceptance tests.**

### What "playable" currently means

A person can load the page, walk in through the dark toward a lit fire, rake
the coals, wait for the fire to burn down, take a marshmallow, roast it with
one continuous drag that controls both distance and rotation, watch it brown
unevenly if they do not turn it, take it to the plate, stack four components
by hand with visible offsets, load the SM-01, close its heavy door, throw the
latch, choose a program, confirm, pull the lever, watch amber become blue and
frost spread, hear the compressor and the relays, release the latch, open the
door into falling vapour, take out a sandwich whose appearance is derived from
everything they just did, photograph it, save it into a scrapbook Passport,
bite it from a chosen side, and be offered — only now — the chance to order a
real one.

No step in that sentence is a placeholder button.

---

## What looking at the running product found

Ten defects that reading the code would not have surfaced, all fixed, most
with regression tests:

| # | Found | Cause |
| --- | --- | --- |
| 1 | The opening image had no fire in it | An established fire decayed to embers within seconds, because fuel could only ever be as lit as its surroundings — there was no self-sustaining term |
| 2 | Every roast charred, at every distance | Flame radiance was calibrated when flames were weak; once fires actually flamed it swamped the entire browning band |
| 3 | A naturally burned-down bed could not roast at all | Coal radiance scaled linearly with pile size, so a half-spent bed radiated half as hard rather than covering half the ground |
| 4 | Frost grew past its target and then visibly retreated mid-run | The freezing stage had no cap, and the transforming stage eased *down* toward one |
| 5 | The finished sandwich rendered as an unlit silhouette | Nothing lit it; it is small, dark-backed and away from the fire |
| 6 | The whole assembly stage rendered black | It happens away from the fire, and by then the fire has burned to coals. Fixed with a camp lantern on the stump, not an invisible fill light |
| 7 | Photographs saved as black frames | A WebGL drawing buffer is cleared once composited; the capture now re-renders synchronously first |
| 8 | The blow-out gesture was inert for the first 900 ms | Its cooldown initialised to `0` rather than `-Infinity` |
| 9 | The marshmallow read as a tiny blob | Roasting was framed from standing height rather than at arm's length |
| 10 | **The reveal showed solid enamel with the sandwich sealed inside the geometry** | The SM-01's body was a single `boxGeometry` — the cabinet had no opening. The door opened onto the machine's own front panel |

Numbers 5, 6 and 10 are the ones worth dwelling on. The most important object
in the product was invisible; an entire interaction stage rendered black; and
the machine at the centre of the whole fantasy had no hole in it. All three
were invisible to a fully green test suite, and none would have been found by
reading the code.

Number 10 also took three attempts. The first two "fixes" moved the camera,
because the symptom looked like a framing problem. It was only after querying
the actual scene graph — door bounds, camera position, sandwich world
position — that the real cause showed up: the sight line was not blocked by
anything, the sandwich was simply *inside solid geometry*. Measuring beat
reasoning.

---

## Priorities and acceptance criteria

### P1 — Prove the magic
> boot → approach campsite → fire → roast → assemble → SM-01 → transform → reveal

| # | Work | Acceptance criteria | State |
| --- | --- | --- | --- |
| 1.1 | Deterministic sim core | Same seed + input timeline ⇒ identical sandwich, asserted by replay test. Fire, heat, roasting, assembly, machine, sandwich, eating all unit tested. | ✅ |
| 1.2 | PS1 render pipeline | Jitter, affine swim, ordered dither, low-res target, short fog — per-material, per-tier, each individually disableable. | ✅ |
| 1.3 | Procedural materials | Every surface textured from seeded runtime generators. No untextured grey. | ✅ |
| 1.4 | Arrival | The player walks toward a lit fire through the dark. Not a cutscene, not a menu. | ✅ |
| 1.5 | Fire tending | Fuel and raking change the simulated fire visibly and audibly; the ember bed is a distinct, better roasting surface. | ✅ |
| 1.6 | Roasting | One continuous drag controls distance and rotation. Per-patch browning is visible. Ignition and blow-out work. No timer, no button. | ✅ |
| 1.7 | Assembly | Each component placed freeform with magnetic assist; offsets/squish/crumbs persist to the final sandwich. | ✅ |
| 1.8 | SM-01 ritual | All stages operable, amber→blue, frost growth, mechanical audio sequence, vapour on open. | ✅ |
| 1.9 | Reveal | In-world reveal first; the sandwich renders at hero tier with its own local lighting. | ✅ |
| 1.10 | Eating | Bites remove real geometry from a chosen side, with crumbs, fracture and cold cues. | ✅ |
| 1.11 | Run + inspect | The whole loop is driven in Chromium under Playwright with a screenshot at each stage. | ✅ |

**P1 is done when** a person can walk to a fire, roast a marshmallow badly, make a lopsided s'more, run the machine, and want to eat the result — with no placeholder buttons anywhere in that path.

### P2 — Make it a place
Exploration · 10–12 environments · weather · audio · wildlife · photography · Passport · persistent campsite memory · mystery/radio.

Acceptance: 20+ concepts generated and scored, 10–12 selected and encoded as validated data; each has its own systemic personality; weather evolves in-session and affects roasting; the Passport is a scrapbook, not a grid; a campsite visibly remembers a previous visit.

### P3 — Make it shared
Avatars · multiplayer join/leave · shared interactions · persistent group campsites · spatial voice.

Acceptance: two clients share a campsite; joining is diegetic with no lobby; a roasting stick can be handed off without teleporting; privacy defaults to private; voice is spatial and never recorded by default.

### P4 — Connect digital and physical
Ordering · loyalty/rewards · CMS/live ops · event and QR architecture · physical/digital bridges.

Acceptance: MAKE THIS REAL appears only after the reveal; the fiction holds through the terminal until checkout; orders are idempotent; high-value rewards are server-validated.

---

## Known shortfalls in the current build

Recorded plainly, because a plan that only lists wins is not a plan.

| # | Shortfall | Why it matters | What it needs |
| --- | --- | --- | --- |
| S1 | **Two affordances are still HUD buttons.** Taking the marshmallow to the plate and taking the sandwich off the tray are screen buttons. The woodpile and the ember bed are now touched directly, and which log you reach for decides what wood goes on the fire. | The remaining two are transitions rather than manipulations, so they read less wrongly — but the spec's spirit is that you carry the marshmallow, not press "take". | Drag the roasting stick to the plate; pick the sandwich off the tray. Both buttons stay as an accessibility fallback for anyone who cannot drag. |
| S2 | **Never run on a touch device.** | Roasting is a two-axis drag; risk R7 is unresolved without a thumb on real glass. | A device lab, or at minimum a phone. |
| S3 | **Never profiled on real hardware.** | The 60 FPS target is unverified; SwiftShader here cannot answer it. | Real device profiling against the budgets in ARCHITECTURE §10. |
| S4 | **Multiplayer is architected, not built.** | Priority 3 in full. | The WebSocket transport and the authority layer described in ADR-0006; the protocol and session domains already model it. |
| S5 | **Wildlife, radio, secrets and traces are data, not behaviour.** The catalogue defines all twelve environments' rosters, stations and discoveries; the client does not yet act on them. | Priority 2 is half-delivered: the world looks different per environment, but does not yet *behave* differently beyond weather and fuel. | Client systems reading the manifests that already exist. |
| S6 | **The significance model is not wired to storage.** The model and its tests exist; no traces are yet recorded from play. | Persistent campsite memory (spec §6.3) is unproven end to end. | Emit evidence at the points the ritual already knows about, and persist through the world-state domain. |
| S7 | **Audio is unheard.** 102 tests cover its maths and scheduling; no human has listened to it. | The SM-01's mechanical narrative is carried by sound. | Someone with speakers. |

---

## Workstreams and dependencies

```
sim core ──┬──► render layer ──┬──► P1 ritual ──► run/inspect/improve
           │                   │
           ├──► content ───────┘
           │
audio ─────┘        protocol ──► api ──► commerce/rewards (P4)
```

`sim` blocks everything gameplay. `protocol`/`api` and `audio` are independent and run in parallel. `content` needs `sim` types only.

---

## Highest-risk questions

| # | Risk | Mitigation | Status |
| --- | --- | --- | --- |
| R1 | **Roasting may not feel good.** A thermal model can be correct and still be unsatisfying — the single biggest product risk. | Tuned against measured outcomes across the whole distance band, three times. Coals now give a wide window between golden and charred; open flame gives almost none. Still unvalidated by a human hand on a real screen. | partly open |
| R2 | **The transformation may not feel rewarding.** If the machine reads as a loading screen, the product fantasy collapses. | Built as specified: twelve operable stages, a 50 s standard run, real amber→blue lighting, growing frost, and a mechanical audio sequence. Reads well in stills; the pacing needs a human. | partly open |
| R3 | **The sandwich may not look delicious** at PS1 fidelity. | Took five passes against screenshots: local key/fill/rim lighting, warmer ice cream at both ends of the browning range, thicker chocolate, a darker cookie for contrast, and framing that turns away from the fire. Now legibly an ice cream sandwich. Appetite is a human judgement and remains the weakest-evidenced claim in this build. | partly open |
| R4 | **PS1 authenticity vs. appetite.** Dithering and low resolution can make food look unappetising. | Affine/jitter are per-material and dialled *down* on food; the fidelity bump is earned; accessibility controls double as art-direction dials. | open |
| R5 | **No assets, no artist.** | ADR-0002: everything procedural, behind swap-in interfaces. Aesthetically correct for PS1. | mitigated |
| R6 | **Determinism is load-bearing** for multiplayer and reward validation; a careless `Math.random` or wall-clock read silently breaks it. | Seeded splittable PRNG only; fixed timestep; replay tests assert identical outcomes. | mitigated by tests |
| R7 | **Mobile input for a two-axis roasting control** could be fiddly. | One continuous drag mapped to distance/rotation, unit tested for range, clamping and no-jump-on-touch; keyboard alternative and auto-rotation assist both work. **Never tested on a real touch device** — the most important untested claim here. | open |
| R8 | **60 FPS on 4–5-year-old phones.** | Rendering at 320×240 buys most of it; adaptive tiers with hysteresis are implemented and unit tested against synthetic frame times. **Never profiled on real hardware** — the SwiftShader environment here cannot answer this. | open |

---

## Blockers (external dependencies unavailable in this environment)

| Blocker | Blocks | Workaround in place |
| --- | --- | --- |
| No Stripe credentials | Live payments | `PaymentProvider` abstraction + fake provider; Stripe implementation structured against the real API, reports "not configured" without keys |
| No PostgreSQL instance | Persistent account storage | Repository interfaces + complete in-memory implementations + a real `schema.sql` ready for the adapter |
| No object storage | Photo upload | Photo metadata modelled with storage keys; blobs held locally |
| No email provider | Magic-link login | `Mailer` interface with a console implementation |
| No WebRTC/LiveKit account | Spatial voice | Abstraction defined; panner path built so a `MediaStream` attaches later |
| No Apple/Google developer accounts | Native shells, native auth, Apple/Google Pay | Web-first; payment method types modelled in the domain |
| No art assets / no artist | Authored 3D content | ADR-0002 procedural generation behind swap-in interfaces |
| No real device lab | Touch validation, true device profiling | Touch input paths implemented and unit-tested; adaptive tiers implemented; real-device validation explicitly outstanding |

**None of these block the Priority 1 experience.**

---

## Working agreements

- No feature is "complete" because it compiles (spec §16).
- No placeholder button may stand in for a tactile interaction, even temporarily.
- Simulation stays pure — no DOM, no Three.js, no wall clock, no unseeded randomness.
- Every content addition is data, never engine code.
- Update this document when state changes, not at the end.
