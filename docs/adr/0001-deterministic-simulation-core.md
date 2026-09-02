# ADR-0001 — Deterministic simulation core, separate from presentation

**Status:** accepted

## Context
Roasting, fire, assembly and the SM-01 are the product. They must be testable, tunable, reproducible across devices, reconcilable in multiplayer, and verifiable server-side (a sandwich record can grant a real-world reward). Simulation logic embedded in React components or Three.js objects is none of those things.

## Decision
All gameplay-meaningful state lives in `packages/sim`: pure TypeScript, no DOM, no Three.js, no clock of its own, advanced explicitly at a fixed 60 Hz timestep by the caller, with all randomness from a seeded splittable PRNG.

## Consequences
- Every system is unit-testable headlessly, and outcomes are assertable rather than eyeballed.
- Multiplayer can replicate inputs instead of state (ADR-0006).
- A sandwich can be re-derived server-side from its seed and input timeline, which is what makes reward validation possible.
- Cost: the renderer must read simulation state each frame rather than owning it, and interpolation for sub-frame smoothness becomes the renderer's responsibility.
