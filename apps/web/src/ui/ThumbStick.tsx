import React, { useCallback, useEffect, useRef, useState } from 'react';
import { STICK_RADIUS_PX, readStick } from '../interaction/thumbStick.js';
import { TOKENS } from './styles.js';

/**
 * The pad you walk with, drawn in the corner where a left thumb already is.
 *
 * The product had a virtual joystick before this and no player would ever have
 * found it: invisible, floating wherever the finger first landed on the canvas,
 * behind an accessibility toggle called "Walk with a joystick" that defaults
 * off. What arrives on a phone instead is tap-to-move, which is a fine way to
 * cross a room and a poor way to stand still at the edge of a fire and turn
 * around, which is most of what there is to do here.
 *
 * So it is drawn, it is in the same place every time, and it owns its own
 * pointer events — dragging anywhere else on the screen still looks around,
 * which is the split every phone game of this shape uses: left thumb walks,
 * right thumb looks.
 *
 * Not in the accessibility tree. Every verb in this product has a keyboard path
 * (§12) and walking is the arrow keys; a drag pad is not something a screen
 * reader can operate, and announcing it as though it were would be worse than
 * silence.
 */
export function ThumbStick({
  onMove,
  textScale,
}: {
  /** Called with forward/strafe in -1..1 whenever the thumb moves, and with zeroes on release. */
  onMove: (forward: number, strafe: number) => void;
  textScale: number;
}): React.ReactElement {
  const centre = useRef({ x: 0, y: 0 });
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [held, setHeld] = useState(false);

  // The pad grows with the text scale like everything else: a player who has
  // asked for larger type is usually asking for larger targets too.
  const radius = STICK_RADIUS_PX * Math.min(1.35, textScale);
  const size = radius * 2;

  const down = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    centre.current = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    event.currentTarget.setPointerCapture(event.pointerId);
    setHeld(true);
    // Read on the press as well as on the move: a thumb that lands off centre
    // and never travels is still asking to walk.
    const reading = readStick(event.clientX - centre.current.x, event.clientY - centre.current.y, radius);
    setKnob({ x: reading.knobX, y: reading.knobY });
    onMove(reading.forward, reading.strafe);
  }, [onMove, radius]);

  const move = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!held) return;
      const reading = readStick(event.clientX - centre.current.x, event.clientY - centre.current.y, radius);
      setKnob({ x: reading.knobX, y: reading.knobY });
      onMove(reading.forward, reading.strafe);
    },
    [held, onMove, radius],
  );

  const release = useCallback(() => {
    setHeld(false);
    setKnob({ x: 0, y: 0 });
    onMove(0, 0);
  }, [onMove]);

  const up = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      release();
    },
    [release],
  );

  /*
   * A thumb that stops touching the screen stops the player, however it stopped.
   *
   * The element's own `onPointerUp` is not enough on its own, and the failure
   * when it misses is the worst one this control has: the player keeps walking
   * at full speed, on their own, until they reach the fence. A release can go
   * missing for reasons that have nothing to do with this code — the capture
   * being broken by the browser, a call arriving, the tab losing focus mid-drag,
   * a gesture the OS decides to take for itself. So the window is asked too, and
   * only while the pad is actually held, which is when those cost anything.
   */
  /*
   * And a pad that goes away while it is held stops the player too.
   *
   * The window listeners below are removed when this unmounts, so a pad that
   * disappears mid-drag — an overlay opening, the stage changing, the player
   * sitting down — would take the last thing it wrote to the movement intent
   * with it and leave that standing: full speed, no input, until the fence.
   * The cleanup runs once, on unmount, and reads `onMove` through a ref so it
   * cannot matter whether that is stable.
   */
  const latest = useRef(onMove);
  latest.current = onMove;
  useEffect(() => () => latest.current(0, 0), []);

  useEffect(() => {
    if (!held) return undefined;
    const stop = (): void => release();
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }, [held, release]);

  return (
    <div
      aria-hidden
      data-testid="stick"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `1px solid ${held ? TOKENS.amber : 'rgba(240,232,214,0.28)'}`,
        background: 'rgba(8,10,14,0.34)',
        // Nothing about the pad may start a text selection or a browser
        // gesture: a thumb dragging on it for a minute at a time is exactly
        // the input a long-press menu or a pull-to-refresh is listening for.
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        pointerEvents: 'auto',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: radius * 0.72,
          height: radius * 0.72,
          marginLeft: -radius * 0.36,
          marginTop: -radius * 0.36,
          borderRadius: '50%',
          border: `1px solid ${held ? TOKENS.amber : 'rgba(240,232,214,0.4)'}`,
          background: held ? 'rgba(58,38,16,0.8)' : 'rgba(20,22,26,0.6)',
          transform: `translate(${knob.x}px, ${knob.y}px)`,
          // No easing while it is held: a knob that lags the thumb reads as
          // input lag even when the walking is instant. It springs back only
          // on release, which is the one moment a person is not watching it.
          transition: held ? 'none' : 'transform 110ms ease-out',
        }}
      />
    </div>
  );
}
