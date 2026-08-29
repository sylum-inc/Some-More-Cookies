# Some More — Implementation Plan

**Status:** living document · updated continuously · last updated: session 1
**Companions:** [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## Current state

**Session 1 in progress.** Repository was empty at session start (a README containing one line). Everything below is being built from zero.

| Area | State |
| --- | --- |
| Monorepo, TypeScript, Vite, Vitest | ✅ done |
| PRODUCT_SPEC / ARCHITECTURE / ADRs | ✅ done |
| `packages/sim` simulation core | 🔨 in progress |
| PS1 render layer + procedural materials | ⬜ next |
| Procedural audio engine | 🔨 in progress (parallel) |
| `packages/content` environment catalogue | ⬜ queued |
| `packages/protocol` + `services/api` | 🔨 in progress (parallel) |
| P1 playable ritual | ⬜ queued |
| Passport, photo mode, accessibility | ⬜ queued |
| Multiplayer | ⬜ architected, not built |

---

## Priorities and acceptance criteria

### P1 — Prove the magic
> boot → approach campsite → fire → roast → assemble → SM-01 → transform → reveal

| # | Work | Acceptance criteria | State |
| --- | --- | --- | --- |
| 1.1 | Deterministic sim core | Same seed + input timeline ⇒ identical sandwich, asserted by a replay test. Fire, heat, roasting, assembly, machine, sandwich, eating all covered by unit tests. | 🔨 |
| 1.2 | PS1 render pipeline | Vertex jitter, affine instability, ordered dither, low-res target, short fog, crunchy shadows — all per-material and tier-controllable, all individually disableable for accessibility. | ⬜ |
| 1.3 | Procedural materials | Every surface in the ritual textured from seeded runtime generators. No untextured grey. | ⬜ |
| 1.4 | Arrival | The player approaches a fire through the dark and arrives; not a cutscene, not a menu. | ⬜ |
| 1.5 | Fire tending | Fuel can be added and embers raked; the fire's simulated state visibly and audibly changes; ember bed is a distinct, better roasting surface. | ⬜ |
| 1.6 | Roasting | One continuous drag controls distance and rotation. Per-patch browning is visible on the mesh. Ignition and blow-out work. No timer, no button. | ⬜ |
| 1.7 | Assembly | Each component is placed freeform in 3D with magnetic assist; offsets/squish/crumbs are recorded and visibly persist to the final sandwich. | ⬜ |
| 1.8 | SM-01 ritual | All twelve stages operable (§3.2 of the spec), amber→blue, frost growth, mechanical audio sequence, vapour on open. | ⬜ |
| 1.9 | Reveal | In-world reveal first, hero view optional. Sandwich renders at hero tier and looks appetizing. | ⬜ |
| 1.10 | Eating | Bites remove real geometry from a chosen side, with crumbs, fracture and cold cues. | ⬜ |
| 1.11 | Run + inspect | The whole loop is driven end-to-end in Chromium under Playwright with a screenshot captured at each stage. | ⬜ |

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
| R1 | **Roasting may not feel good.** A thermal model can be correct and still be unsatisfying — this is the single biggest product risk, because roasting is the tactile heart. | Build it deterministic and headlessly testable so it can be tuned rapidly; expose tuning constants in one place; validate by driving real input timelines and inspecting outcome spreads, not by reading code. | open |
| R2 | **The transformation may not feel rewarding.** If the machine reads as a loading screen, the product fantasy collapses. | Every stage is operable and physical; the run is 45–75 s with something to watch or walk away from; amber→blue is a real lighting change, not a texture swap; audio carries the mechanical narrative. | open |
| R3 | **The sandwich may not look delicious** at PS1 fidelity. | The hero material tier exists precisely for this; it is the only object permitted the bump. Judge by screenshot, repeatedly. | open |
| R4 | **PS1 authenticity vs. appetite.** Dithering and low resolution can make food look unappetising. | Affine/jitter are per-material and dialled *down* on food; the fidelity bump is earned; accessibility controls double as art-direction dials. | open |
| R5 | **No assets, no artist.** | ADR-0002: everything procedural, behind swap-in interfaces. Aesthetically correct for PS1. | mitigated |
| R6 | **Determinism is load-bearing** for multiplayer and reward validation; a careless `Math.random` or wall-clock read silently breaks it. | Seeded splittable PRNG only; fixed timestep; replay tests assert identical outcomes. | mitigated by tests |
| R7 | **Mobile input for a two-axis roasting control** could be fiddly. | One continuous drag mapped to radial/tangential; assists (auto-rotation, stronger snapping) available; must be validated on a real touch device. | open |
| R8 | **60 FPS on 4–5-year-old phones.** | Rendering at 320×240 buys most of it; adaptive tiers scale the rest; simulation is budgeted at ≤1.5 ms; measure, never guess. | open |

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
