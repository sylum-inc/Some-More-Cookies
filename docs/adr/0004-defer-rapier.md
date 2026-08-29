# ADR-0004 — Defer Rapier behind a physics abstraction

**Status:** accepted

## Context
The brief prefers Rapier for general world/object physics, and separately requires custom deterministic systems for roasting, heat, assisted assembly, food deformation, and important multiplayer interaction.

Auditing the Priority 1 loop, *every* interaction falls in the second category:
- roasting — a thermal model, not rigid-body dynamics
- assembly — assisted placement with deliberate magnetic bias, which fights a physics solver rather than using one
- the SM-01 — a state machine with animated mechanisms
- eating — geometry removal

Rapier's genuine value is Priority 2+ secondary props: tossed sticks, skipped stones, scattered crumbs, moved chairs.

## Decision
Ship P1 with purpose-built deterministic solvers. Define a `PhysicsWorld` interface for rigid-body needs, with a lightweight built-in integrator for simple props. Adopt Rapier behind that interface when secondary props justify it.

## Consequences
- No WASM payload or startup cost during the phase that most needs a fast boot and a stable 60 FPS.
- P1 interactions stay deterministic and network-friendly, which general rigid-body physics would have complicated.
- Cost: the built-in integrator is not a substitute for a real solver; complex prop physics must wait for the Rapier adapter rather than being attempted in-house.
