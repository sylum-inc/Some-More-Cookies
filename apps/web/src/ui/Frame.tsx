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

/**
 * What is moulded into the plastic, bottom right.
 *
 * Deliberately **not** SM-01. That is the machine standing at the edge of the
 * firelight, and a review has already complained that it is the same cream as
 * this bezel and merges with it — stamping its model number on the thing the
 * player is holding would turn a colour collision into an identity one. The
 * handheld is its own object, from its own fictional maker, and the marking
 * says so.
 *
 * Set dressing, not a readout (§5.3): it is the same three characters at the
 * start of the night and at the end of it, and nothing in the game can change
 * them.
 */
export const MOULD_MARK = 'NIGHTJAR';
export const MOULD_MODEL = 'NJ-9C';

/** Below this the rail is too thin to carry the marking legibly. */
const MARK_MIN_STEP = 2;

export interface FrameProps {
  /** Viewport width in CSS pixels, so the bezel can thin out on a phone. */
  readonly width: number;
  /**
   * Off entirely for the visual-regression suite and for anyone who has said
   * they want the plainest possible screen.
   */
  readonly enabled?: boolean;
  /**
   * Stills the one thing on the bezel that moves.
   *
   * The power lamp carries a slow, shallow mains wobble — three per cent over
   * four seconds — because a lamp that is exactly one value is a printed dot.
   * That is the only animation on the whole object, so it is the only thing
   * reduced motion has to switch off, and it does (spec §12). The stylesheet's
   * global `prefers-reduced-motion` rule already catches an operating system
   * that has been told; this catches the in-app setting, which the OS has not
   * heard about.
   */
  readonly reducedMotion?: boolean;
}

export function Frame({ width, enabled = true, reducedMotion = false }: FrameProps): React.ReactElement | null {
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
  /*
   * Where the two halves of the shell meet, measured in from the outer edge.
   *
   * The nine-slice already carries a one-pixel highlight at depth four of its
   * cross-section, which is the seam catching the light. What it cannot carry
   * is the dark line the highlight sits on, because the tile above it is the
   * panel face and a second value there would read as banding at 1x. Drawn
   * here instead, as a rectangle inset by the same four pixels: one element,
   * mitred at the corners for nothing, and the pair finally reads as a join
   * between two mouldings rather than as a scratch.
   */
  const seam = Math.max(1, SEAM_DEPTH * step - 1);
  const grime = inset * 5;
  const rail = { position: 'absolute' as const, pointerEvents: 'none' as const };
  return (
    <>
      <style>{BEZEL_CSS}</style>
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

      {/*
        The screen, as an object with a front surface.

        Under the bezel and under the vignette rather than over them, because
        the glass is behind the moulding that overlaps it — and, more usefully,
        under the readable layer, so a scratch can never sit across a line of
        text. Four hairlines and one broad wipe, all of them barely there: a
        scuffed screen is a legibility problem the moment it is more than a
        suggestion, and D7 is not negotiable for the sake of a texture.
      */}
      <div aria-hidden data-testid="bezel-glass" className="sm-bezel-glass" style={{ inset }} />

      {/*
        The wear.

        Four strips rather than one clipped element, because the ageing is not
        the same on all four sides and that is the entire point: a handheld
        yellows from the bottom up and grimes at the two bottom corners, where
        thumbs sit for years. The nine-slice cannot carry any of this — its
        edge tiles repeat along their run, so anything painted into them
        repeats into wallpaper, which is exactly why the artwork is clean and
        the dirt lives here.
      */}
      <div aria-hidden data-testid="bezel-wear" className="sm-bezel-wear">
        <div
          style={{
            ...rail,
            left: 0,
            right: 0,
            top: 0,
            height: inset,
            // The top of a case stays cleanest: nothing rests on it and
            // nobody holds it there.
            background: `linear-gradient(to bottom, rgba(198,158,86,0.05), rgba(178,140,72,0.12))`,
          }}
        />
        <div
          style={{
            ...rail,
            left: 0,
            right: 0,
            bottom: 0,
            height: inset,
            background: [
              `radial-gradient(${grime}px 140% at 0% 100%, rgba(78,58,32,0.28), rgba(78,58,32,0) 72%)`,
              `radial-gradient(${grime}px 140% at 100% 100%, rgba(78,58,32,0.28), rgba(78,58,32,0) 72%)`,
              `linear-gradient(to top, rgba(166,124,58,0.20), rgba(178,140,72,0.06))`,
            ].join(','),
          }}
        />
        <div
          style={{
            ...rail,
            left: 0,
            top: inset,
            bottom: inset,
            width: inset,
            background: `linear-gradient(to bottom, rgba(198,158,86,0.04), rgba(166,124,58,0.24))`,
          }}
        />
        <div
          style={{
            ...rail,
            right: 0,
            top: inset,
            bottom: inset,
            width: inset,
            background: `linear-gradient(to bottom, rgba(198,158,86,0.04), rgba(166,124,58,0.24))`,
          }}
        />
      </div>

      {/* The moulding seam, all the way round. */}
      <div aria-hidden data-testid="bezel-seam" className="sm-bezel-seam" style={{ inset: seam }} />

      {/*
        The sprue mark: where the plastic was fed into the tool and snapped
        off. Off-centre, because a mark in the middle of the bottom edge reads
        as a button.
      */}
      <div
        aria-hidden
        className="sm-bezel-sprue"
        style={{
          width: step * 3,
          height: step * 3,
          left: `38%`,
          bottom: (inset - step * 3) / 2,
        }}
      />

      {/*
        The power lamp. Dumb on purpose.

        It says the device is on, and that is the whole of what it says: it
        does not brighten with the fire, count anything, warn about anything or
        change with the stage. §5.3 forbids the game putting a readout in front
        of the player, and a lamp that encoded state would be a meter with one
        pixel. So it is lit, and it stays lit.
      */}
      <div
        aria-hidden
        data-testid="bezel-led"
        className={reducedMotion ? 'sm-bezel-led sm-bezel-led-steady' : 'sm-bezel-led'}
        style={{
          width: step * 2.5,
          height: step * 2.5,
          left: inset + step * 6,
          bottom: (inset - step * 2.5) / 2,
        }}
      />

      {/* Moulded into the shell, in a colour a shade off the plastic. */}
      {step >= MARK_MIN_STEP && (
        <div
          aria-hidden
          data-testid="bezel-mark"
          className="sm-bezel-mark"
          style={{
            right: inset + step * 3,
            bottom: (inset - step * 5) / 2,
            fontSize: step * 3.5,
            lineHeight: `${step * 5}px`,
          }}
        >
          <span className="sm-bezel-mark-name">{MOULD_MARK}</span>
          <span className="sm-bezel-mark-model">{MOULD_MODEL}</span>
        </div>
      )}
    </>
  );
}

/** Where the shell's two halves meet, in artwork pixels from the outer edge. */
const SEAM_DEPTH = 4;

/**
 * The ageing pass, as a stylesheet.
 *
 * A review's verdict on the bezel was that "the concept is right and the
 * execution is thin — it reads as a picture frame around the game rather than
 * as a plastic object the player is holding", and listed what was missing: no
 * wear, no yellowing, no scuff, no moulding seam, no sprue mark, no logo, no
 * model number, no power lamp. All of it is here and none of it touches the
 * artwork, the proportions or the screw layout, because the same review listed
 * those among the things that already work.
 *
 * It is a stylesheet rather than inline style objects for the two things
 * inline styles cannot do: keyframes, and `::before`/`::after`, which is how
 * the lamp gets a recess and a bloom out of one element.
 */
export const BEZEL_CSS = `
.sm-bezel-wear, .sm-bezel-seam, .sm-bezel-sprue, .sm-bezel-led, .sm-bezel-mark {
  position: fixed; pointer-events: none; z-index: 26;
}
.sm-bezel-wear { inset: 0; }
/* Two hairlines: the shadow in the joint and the highlight on the lip below
   it. Either one alone is a scratch; the pair is a moulding seam. */
.sm-bezel-seam {
  border: 1px solid rgba(58,42,22,0.40);
  box-shadow: inset 0 0 0 1px rgba(255,248,226,0.10);
}
.sm-bezel-sprue {
  border-radius: 50%;
  background:
    radial-gradient(circle at 34% 32%,
      rgba(255,250,232,0.42) 0%,
      rgba(120,94,54,0.42) 58%,
      rgba(196,168,120,0.20) 100%);
}
/*
 * A lamp behind a moulded window: a dark recess, a coloured core, and a bloom
 * on the plastic around it. Green rather than amber because the bezel is warm
 * cream and an amber lamp on warm cream is not a lamp, it is a smudge — and
 * because the gasket is already olive, so the two agree.
 */
.sm-bezel-led {
  border-radius: 50%;
  background: radial-gradient(circle, #b6f7bd 0%, #56c96a 46%, #1c4f2a 78%, rgba(20,32,22,0.85) 100%);
  box-shadow:
    0 0 0 1px rgba(28,38,26,0.55),
    0 0 6px 2px rgba(86,201,106,0.30);
  animation: sm-bezel-lamp 4.1s ease-in-out infinite;
}
.sm-bezel-led-steady { animation: none; }
@keyframes sm-bezel-lamp {
  0%, 100% { opacity: 1; }
  47% { opacity: 0.93; }
}
@media (prefers-reduced-motion: reduce) { .sm-bezel-led { animation: none; } }
/*
 * Embossed: a fill a shade lighter than the plastic with a dark line under it,
 * which is what a raised letter does to light coming from above. Barely legible
 * is the target — a marking you can read across the room is a label.
 */
.sm-bezel-mark {
  display: flex; align-items: baseline; gap: 0.9em;
  font-family: "Helvetica Neue", Arial, sans-serif;
  text-transform: uppercase;
  color: rgba(255,250,232,0.30);
  text-shadow: 0 1px 0 rgba(72,54,28,0.55);
  white-space: nowrap;
}
.sm-bezel-mark-name { font-weight: 700; letter-spacing: 0.24em; }
.sm-bezel-mark-model { font-weight: 400; letter-spacing: 0.16em; opacity: 0.72; }
/*
 * The front surface of the screen. Under the bezel and under the readable
 * layer; see the note at the element.
 */
.sm-bezel-glass {
  position: fixed; pointer-events: none; z-index: 23;
  background-repeat: no-repeat;
  background-image:
    linear-gradient(101deg, rgba(255,255,255,0) 49.5%, rgba(255,255,255,0.055) 49.9%, rgba(255,255,255,0.012) 50.2%, rgba(255,255,255,0) 50.6%),
    linear-gradient(97deg, rgba(255,255,255,0) 49.6%, rgba(255,255,255,0.04) 50%, rgba(255,255,255,0) 50.4%),
    linear-gradient(84deg, rgba(255,255,255,0) 49.6%, rgba(255,255,255,0.045) 50%, rgba(255,255,255,0) 50.4%),
    linear-gradient(112deg, rgba(255,255,255,0) 49.7%, rgba(255,255,255,0.03) 50%, rgba(255,255,255,0) 50.3%),
    radial-gradient(72% 46% at 22% 84%, rgba(255,255,255,0.028), rgba(255,255,255,0) 70%);
  background-size: 34% 52%, 26% 78%, 44% 36%, 18% 62%, 100% 100%;
  background-position: 12% 8%, 74% 22%, 30% 76%, 88% 66%, 0 0;
}
`;

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
