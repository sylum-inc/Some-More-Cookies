# ADR-0006 — Replicate inputs and authority, not simulation state

**Status:** accepted

## Context
A roasting marshmallow holds 32 surface patches × 6 floats. Replicating that at 60 Hz per player is not shippable on mobile networks, and interpolating it would destroy the crisp per-patch browning that makes roasting legible.

## Decision
Because the simulation is deterministic (ADR-0001), replicate only:
1. **Inputs** — the small stream of player intents (distance, rotation, place, pull lever)
2. **Authority** — `TemporaryOwnership { holder, grantedAt, expiresAt }` per interactable

Each client reconstructs identical simulation state. Hand-off is an explicit authority transfer with a brief mutual-hold window so passed objects never teleport. A late joiner receives the seed plus input history and replays it.

## Consequences
- Bandwidth scales with player *actions*, not simulation complexity, so the roasting model can get richer at no network cost.
- The same replay mechanism gives server-side verification of sandwich records for free, which is what protects high-value real-world rewards.
- Cost: determinism becomes a correctness requirement rather than a nicety. Floating-point consistency, fixed timestep discipline, and seeded RNG discipline must be enforced by tests, and any non-deterministic shortcut in `packages/sim` is a networking bug waiting to happen.
