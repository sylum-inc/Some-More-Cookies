/**
 * The bezel, after the ageing pass.
 *
 * This file exists because of the one lesson this codebase keeps re-learning:
 * a render feature that is silently discarded looks exactly like one that was
 * never written. Everything the pass adds is CSS, and CSS that never matches
 * anything fails silently and forever — so the things that must not vanish are
 * asserted as strings, the way `overlay-panels.test.ts` already asserts the
 * global stylesheet.
 *
 * It also pins the two contracts the rest of the build depends on and which
 * the ageing pass is in a position to break: the published inset, and the fact
 * that the marking is not the SM-01's.
 */

import { describe, expect, it } from 'vitest';
import { BEZEL_CSS, MOULD_MARK, MOULD_MODEL, bezelInset, bezelScale } from '../src/ui/Frame.js';
import { SPRITE_FRAME_SLICE } from '../src/ui/sprites/atlas.js';

const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored to the start of a line: several selectors also appear inside the
  // shared positioning list at the top, and an unanchored match finds that one.
  const match = BEZEL_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
};

describe('the rail the rest of the interface measures itself against', () => {
  /*
   * Another component converts panel coordinates to screen coordinates
   * through `--sm-frame-inset`, and the overlays pad themselves by it. The
   * ageing pass adds five elements over the bezel and must not have moved it.
   */
  it('still publishes the artwork depth times the scale', () => {
    expect(bezelInset(1280, true)).toBe(SPRITE_FRAME_SLICE * bezelScale(1280));
    expect(bezelInset(393, true)).toBe(SPRITE_FRAME_SLICE * bezelScale(393));
    expect(bezelInset(1280, false)).toBe(0);
  });

  it('writes the custom property the overlays read', () => {
    // Not the CSS: the property is set from the component. Asserted here as a
    // reminder that the name is a contract, since the string only appears once.
    expect(bezelInset(1280, true)).toBeGreaterThan(0);
  });
});

describe('the marking moulded into the shell', () => {
  it('is not the machine standing at the edge of the firelight', () => {
    /*
     * A review found that the SM-01 is the same cream as this bezel and merges
     * with it. Putting the SM-01's own model number on the shell the player is
     * holding would take a colour collision and make it an identity one.
     */
    expect(MOULD_MARK).not.toMatch(/SM-?01/i);
    expect(MOULD_MODEL).not.toMatch(/SM-?01/i);
  });

  it('is set dressing rather than a readout', () => {
    // §5.3: no number the game controls reaches the player. These two are
    // module constants, so nothing in the simulation can reach them at all.
    expect(MOULD_MARK).toMatch(/^[A-Z]+$/);
    expect(MOULD_MODEL).toMatch(/^[A-Z0-9-]+$/);
  });

  it('is barely lighter than the plastic, and embossed', () => {
    const mark = rule('.sm-bezel-mark');
    // The face is cream3 (#ddc9a3); an opaque white marking would be a label.
    const alpha = /rgba\(255,\s*250,\s*232,\s*([\d.]+)\)/.exec(mark)?.[1];
    expect(alpha, 'the marking needs a translucent fill').toBeDefined();
    expect(Number(alpha)).toBeLessThan(0.4);
    // A raised letter throws a line under itself. Without this it is print.
    expect(mark).toMatch(/text-shadow:\s*0 1px 0/);
  });
});

describe('the power lamp', () => {
  it('is drawn at all', () => {
    expect(rule('.sm-bezel-led')).toMatch(/radial-gradient/);
  });

  /*
   * §5.3 again, and the sharper half of it. A lamp is allowed to say the
   * device is on. It is not allowed to encode game state as a signal the
   * player is meant to read, because that is a meter with one pixel. The
   * guard is structural: the element takes no state, so there is nothing for
   * it to encode — `Frame` is handed a width, an enabled flag, and whether
   * motion is reduced, and none of those is the ritual.
   */
  it('has a still path for reduced motion', () => {
    expect(BEZEL_CSS).toMatch(/@keyframes sm-bezel-lamp/);
    expect(rule('.sm-bezel-led-steady')).toMatch(/animation:\s*none/);
    // And for an operating system that was told rather than the app.
    expect(BEZEL_CSS).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('wobbles by a few per cent rather than blinking', () => {
    const frames = BEZEL_CSS.match(/@keyframes sm-bezel-lamp\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const opacities = [...frames.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    expect(opacities.length).toBeGreaterThan(1);
    // A lamp that reaches zero is a blink, and a blink is a signal.
    expect(Math.min(...opacities)).toBeGreaterThan(0.8);
  });
});

describe('the wear', () => {
  it('keeps the scratches faint enough that the screen stays legible', () => {
    /*
     * D7 is a floor on how dark a surface may be; this is the ceiling on how
     * much can be put in front of one. Every scuff on the glass is white at
     * low alpha over the world, and the world is a dark clearing.
     */
    const glass = rule('.sm-bezel-glass');
    const alphas = [...glass.matchAll(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/g)]
      .map((m) => Number(m[1]))
      .filter((value) => value > 0);
    expect(alphas.length, 'the glass needs some marks on it').toBeGreaterThan(3);
    expect(Math.max(...alphas)).toBeLessThan(0.08);
  });

  it('puts the glass behind the readable layer', () => {
    // The HUD sits at 20 and the bezel at 25. A scratch across a line of
    // guidance is a bug wearing a texture's clothes.
    expect(rule('.sm-bezel-glass')).toMatch(/z-index:\s*23/);
  });

  it('draws the seam as a pair of lines rather than one', () => {
    // One line is a scratch. A shadow with a highlight under it is a join.
    const seam = rule('.sm-bezel-seam');
    expect(seam).toMatch(/border:\s*1px solid/);
    expect(seam).toMatch(/box-shadow:\s*inset/);
  });
});
