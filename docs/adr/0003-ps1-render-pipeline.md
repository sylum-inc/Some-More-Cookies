# ADR-0003 — PS1 look via shader jitter/affine, low-res target, ordered dither

**Status:** accepted

## Context
The PS1 aesthetic must be structural, not a post-process filter over modern rendering — the brief explicitly forbids a "retro-filter gimmick". The genuine PS1 artifacts come from hardware behaviour: no sub-pixel vertex precision, no perspective-correct texture interpolation, low framebuffer resolution, limited colour depth, no z-buffer on early titles.

## Decision
Reproduce the *causes*, not the appearance:
1. **Vertex jitter** — snap clip-space position to a virtual raster grid in the vertex shader, before perspective divide. This reproduces real vertex wobble, including its dependence on distance.
2. **Affine texture mapping** — multiply UV by `w` in the vertex shader and divide by interpolated `w` in the fragment shader, blended by a per-material `affineness` so it can be dialled per object.
3. **Low internal resolution** — render to a target at 320×240–640×480 and upscale with `NearestFilter`.
4. **Ordered dithering + colour quantisation** — Bayer matrix in screen space during the post pass, quantising to 5:5:5.
5. **Short exponential fog** — the draw-distance limit is diegetic (night, trees) rather than an obvious cull.

Selective modern rendering (fire, food, lighting, particles) sits *inside* this pipeline, so it is stylistically consistent rather than layered on top.

## Consequences
- Effects are per-material and per-tier controllable, which is what makes both the sandwich fidelity bump and the accessibility "reduce dithering/effects" setting possible.
- Rendering at 320×240 is a large performance win that funds better fire and lighting — the art direction and the performance target reinforce each other.
- Cost: custom shader material plumbing everywhere; standard Three.js materials must be patched via `onBeforeCompile` rather than used directly.
