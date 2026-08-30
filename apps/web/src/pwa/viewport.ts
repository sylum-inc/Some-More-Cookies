/**
 * The two mobile realities that are not the service worker's problem.
 *
 * **The viewport moves.** On a phone the address bar slides away as you scroll,
 * the keyboard opens, and the whole thing rotates. `window.innerHeight` is a
 * reading, not a constant. That matters here more than it would in a document,
 * because the internal render resolution is derived from it (ADR-0003): a
 * height read once at boot and never again means a phone turned on its side
 * renders at portrait's internal resolution, which is roughly twice the pixels
 * it should be — a frame rate defect that only ever shows up on a real device
 * being held by a real person.
 *
 * **The screen sleeps.** The SM-01 run is 45 seconds of watching a machine
 * work, with both hands off the glass. That is exactly the interval a phone
 * decides nobody is there.
 */

import { useEffect, useRef, useState } from 'react';

export interface ViewportSize {
  width: number;
  height: number;
  /** Landscape when wider than tall, which is the only definition that travels. */
  landscape: boolean;
}

function readViewport(): ViewportSize {
  if (typeof window === 'undefined') return { width: 1024, height: 768, landscape: true };
  // `visualViewport` is the one that shrinks for the keyboard and the address
  // bar; `innerHeight` is the layout viewport. The renderer wants what is
  // actually on screen.
  const visual = window.visualViewport;
  const width = Math.round(visual?.width ?? window.innerWidth);
  const height = Math.round(visual?.height ?? window.innerHeight);
  return { width, height, landscape: width >= height };
}

/**
 * The live viewport, coalesced to one update per frame.
 *
 * iOS fires a storm of resizes while the address bar animates, and each one
 * that reached React would reallocate the drawing buffer.
 */
export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(readViewport);
  const pending = useRef(0);

  useEffect(() => {
    const schedule = (): void => {
      if (pending.current) return;
      pending.current = requestAnimationFrame(() => {
        pending.current = 0;
        const next = readViewport();
        setSize((previous) =>
          previous.width === next.width && previous.height === next.height ? previous : next,
        );
      });
    };

    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      if (pending.current) cancelAnimationFrame(pending.current);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, []);

  return size;
}

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockCapableNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/**
 * Holds the screen awake while `active`.
 *
 * Deliberately narrow: this is asked for only while the machine is actually
 * running, and dropped the moment it is not. A wake lock held for a whole
 * session would be a battery cost taken without asking. It is also entirely
 * best-effort — Safari on iOS only added it in 16.4, and a browser that says
 * no simply means the phone sleeps the way it always did.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const api = (navigator as unknown as WakeLockCapableNavigator).wakeLock;
    if (!active || !api) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        const held = await api.request('screen');
        if (cancelled) {
          void held.release();
          return;
        }
        sentinel = held;
      } catch {
        // A denied wake lock is not an error worth surfacing; the screen
        // dimming is the behaviour every phone had before this API existed.
      }
    };

    // The system drops the lock whenever the tab is hidden, so coming back
    // has to take it again or the second half of a machine run is unprotected.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      const held = sentinel;
      sentinel = null;
      if (held && !held.released) void held.release().catch(() => undefined);
    };
  }, [active]);
}
