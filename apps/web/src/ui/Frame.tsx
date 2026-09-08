/**
 * The device the game is being played on.
 *
 * Two pieces of furniture that sit over the whole viewport and belong to
 * neither the world nor the HUD's channels:
 *
 * - **The bezel.** A brushed-steel nine-slice around the edge of the frame.
 *   The reference here is a handheld from about 2003: the screen was never the
 *   whole object you were holding, and the moulded plastic around it did more
 *   for the picture than anyone admits. It gives the world an edge to stop at
 *   instead of bleeding into the browser, it gives the HUD's corners something
 *   to be in a corner *of*, and it is the single cheapest way to stop a canvas
 *   in a tab from looking like a canvas in a tab.
 *
 * - **The vignette.** How hard the frame is closing in, driven every frame by
 *   the camera's own motion — speed narrows it, an impulse squeezes it. This
 *   is the one element here that moves, so it is also the one that reduced
 *   motion turns off, and it does so at the source: `stepCameraMotion` reports
 *   zero and this draws nothing.
 *
 * The vignette arrives as a CSS custom property rather than as a prop, because
 * it changes sixty times a second and a React tree that re-renders sixty times
 * a second to move one gradient is a frame budget spent on nothing. `World`
 * writes `--motion-vignette` on the root element; the compositor does the rest
 * and no JavaScript runs at all.
 */

import { useEffect } from 'react';
import { SPRITE_FRAME, SPRITE_FRAME_SLICE } from './sprites/atlas.js';

/** How many screen pixels one atlas pixel becomes. Integers only — see `Sprite`. */
export function bezelScale(width: number): number {
  // A phone gets a thinner bezel in absolute terms, because 26 pixels a side
  // out of 393 is an eighth of the picture and the picture is the product.
  return width < 520 ? 1 : 2;
}

/**
 * How far in from the edge of the window the game's own furniture must start.
 *
 * The HUD has to know this. It anchors to `env(safe-area-inset-*)`, which
 * describes the phone's notch and knows nothing about a bezel this code drew —
 * so with the frame on and no allowance made, the guidance line ran under the
 * left rail and lost its first character. A screenshot of that is what caught
 * it; nothing in the layout could have.
 */
export function bezelInset(width: number, enabled: boolean): number {
  if (!enabled || SPRITE_FRAME === null) return 0;
  return SPRITE_FRAME_SLICE * bezelScale(width);
}

export interface FrameProps {
  /** Viewport width in CSS pixels, so the bezel can thin out on a phone. */
  readonly width: number;
  /**
   * Off entirely for the visual-regression suite and for anyone who has said
   * they want the plainest possible screen.
   */
  readonly enabled?: boolean;
}

export function Frame({ width, enabled = true }: FrameProps): React.ReactElement | null {
  const inset = bezelInset(width, enabled);
  /*
   * How thick the rail is, published to the stylesheet.
   *
   * `frameInset` reaches the HUD as a prop, which is fine because App renders
   * both. The overlays are not App's children in that sense — they are
   * `position: fixed` scrims that pin themselves to the viewport — and none of
   * them knew the rail existed. They padded themselves by `4vmin`, which
   * clears 18 pixels of bezel at 1280 wide and does not at 393, so a panel
   * that was already cutting its own content was also spending its margin on
   * a number that meant nothing.
   *
   * A custom property rather than a second prop threaded through five
   * components: the bezel is the only thing that knows this, and CSS is where
   * it is needed. Written on the root element so `.sm-overlay` can read it
   * wherever it happens to be mounted.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sm-frame-inset', `${inset}px`);
    return () => {
      root.style.removeProperty('--sm-frame-inset');
    };
  }, [inset]);
  if (!enabled || SPRITE_FRAME === null) return null;
  const step = bezelScale(width);
  return (
    <div
      aria-hidden
      data-testid="bezel"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 25,
        pointerEvents: 'none',
        borderStyle: 'solid',
        borderWidth: inset,
        // `fill` is deliberately absent: the middle of the nine-slice is the
        // game, and painting it would paint over the whole world.
        borderImage: `url(${SPRITE_FRAME}) ${SPRITE_FRAME_SLICE} repeat`,
        imageRendering: 'pixelated',
      }}
    />
  );
}

/**
 * The frame closing in with the body's own effort.
 *
 * Two stops rather than one: a wide soft fall-off that does the sense of
 * exertion, and a hard corner darkening that does the sense of a lens. Both
 * multiplied by the same custom property, so at rest the element is fully
 * transparent and the browser skips it.
 */
export function MotionVignette(): React.ReactElement {
  return (
    <div
      aria-hidden
      data-testid="motion-vignette"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 24,
        pointerEvents: 'none',
        opacity: 'var(--motion-vignette, 0)' as unknown as number,
        background:
          'radial-gradient(120% 90% at 50% 50%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.42) 74%, rgba(0,0,0,0.82) 100%)',
        // The property is written outside React, so the transition is what
        // keeps a dropped frame from showing as a flicker rather than what
        // animates it — short enough to stay coupled to the camera.
        transition: 'opacity 90ms linear',
      }}
    />
  );
}
