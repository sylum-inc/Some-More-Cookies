/**
 * The dialog contract, in one place (spec §12, audit A4).
 *
 * Every overlay in the product had `role="dialog"`, an accessible name, a close
 * button with a name, and Escape to shut it — and none of them moved focus.
 * Nothing anywhere in `apps/web/src` called `.focus()`. In practice that meant
 * somebody opening the Passport on a keyboard was not taken to it and could Tab
 * straight back out into the campsite behind a panel that visually covered the
 * screen. `Scan` and `Terminal` are the sharp cases: a code entry form and a
 * checkout.
 *
 * What a dialog owes its user is small and well understood, so it is written
 * once here rather than six times:
 *
 *  - `aria-modal="true"`, so assistive technology stops reading the world
 *    behind it rather than presenting the two as one page.
 *  - Focus moves *into* the panel when it opens.
 *  - Tab and Shift+Tab cycle within it and cannot leave.
 *  - Focus returns to whatever opened it when it closes, so the player is put
 *    back where they were rather than at the top of the document.
 *
 * Deliberately not a focus *steal*: if something inside the panel has already
 * taken focus (an autofocused field) this leaves it alone.
 */

import { useEffect, useRef, type RefObject } from 'react';

/** Everything the browser will let a person Tab to, in document order. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // `offsetParent` is null for anything `display: none`, which is the cheap
    // test for "is actually on screen" without reading layout for every node.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export interface DialogHandle {
  /** Spread onto the dialog's root element. */
  readonly props: {
    ref: RefObject<HTMLDivElement | null>;
    'aria-modal': 'true';
    onKeyDown: (event: React.KeyboardEvent) => void;
  };
}

/**
 * Focus management for one overlay.
 *
 * Call it in a component that is only rendered while its overlay is open,
 * which is how every overlay here is mounted — so there is no `open` flag to
 * pass and no way for the two to disagree.
 */
export function useDialog(): DialogHandle {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const panel = ref.current;
    if (panel === null) return;
    // Remembered before anything moves, so closing puts the player back on the
    // control they opened this from.
    const opener = document.activeElement as HTMLElement | null;

    if (!panel.contains(document.activeElement)) {
      const first = focusableWithin(panel)[0];
      if (first !== undefined) first.focus();
      else {
        // A panel with nothing to operate is still a place the reader should
        // be taken to — the Passport with no entries in it, for instance.
        panel.tabIndex = -1;
        panel.focus();
      }
    }

    return () => {
      if (opener === null || !opener.isConnected) return;
      /*
       * By the time this runs React may already have detached the panel, so
       * `document.activeElement` is usually `<body>` rather than anything
       * inside it — checking for containment here never fires, which is how
       * the first version of this silently did nothing.
       *
       * The question that actually matters is whether the player has taken
       * focus somewhere else themselves. If they have, dragging them back
       * would be the rude thing; if focus has simply fallen to the document,
       * it belongs on the control they opened this from.
       */
      const active = document.activeElement;
      const elsewhere =
        active !== null &&
        active !== document.body &&
        active !== opener &&
        !panel.contains(active) &&
        active.isConnected;
      if (!elsewhere) opener.focus();
    };
  }, []);

  return {
    props: {
      ref,
      'aria-modal': 'true',
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key !== 'Tab') return;
        const panel = ref.current;
        if (panel === null) return;
        const focusable = focusableWithin(panel);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !panel.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      },
    },
  };
}
