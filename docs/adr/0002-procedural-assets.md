# ADR-0002 — All assets are procedurally generated at runtime

**Status:** accepted · supersedes the Blender→glTF pipeline *for now*

## Context
`PRODUCT_SPEC.md` specifies a Blender → glTF/GLB pipeline. No art assets exist, no artist is available, and no assets can be downloaded in this environment. The alternatives were: ship placeholder cubes and untextured grey, or generate everything in code.

Placeholder grey would violate the spec's own non-negotiables — "static images for interactive environments" and placeholder-driven development are exactly what the brief forbids.

## Decision
Generate everything at runtime:
- **Textures** — canvas 2D generators, seeded, `NearestFilter`, small power-of-two sizes. A PS1 look wants 64–128px textures, so procedural generation is *aesthetically correct here*, not merely expedient.
- **Geometry** — code-authored low-poly meshes. PS1 geometry is low enough in complexity that code authoring is practical.
- **Audio** — WebAudio synthesis (oscillators, noise, filters, procedural impulse responses).

All three sit behind interfaces (`MaterialSource`, prop factories, the audio engine) so authored content can replace any single item without changing call sites.

## Consequences
- The product is genuinely complete and playable now, with zero binary assets in the repository and a tiny download.
- Machine wear, decals and serials derive from a campsite seed, so serialization (a spec requirement) comes almost free.
- Cost: procedural generation costs startup CPU time (mitigated by caching and by generating at low resolution), and hand-authored art will eventually beat procedural art for hero objects. The interfaces exist so that swap is incremental.
