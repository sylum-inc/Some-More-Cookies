/**
 * Two quiet cards in the corner: "there is a newer campsite" and "you can
 * keep this one".
 *
 * Neither is a growth surface. The rules they obey:
 *
 *  - **Never during the ritual.** The install offer is not shown before the
 *    reveal at all, and not while the machine is running or a marshmallow is
 *    on a stick. Spec §11's rule is about tone, and an install banner over a
 *    roasting marshmallow breaks it exactly the way a store prompt would.
 *  - **Never over something else.** If an overlay is open, neither appears.
 *  - **Dismissible, and the dismissal is remembered.** "Not now" means not for
 *    a month, not until the next reload.
 *  - **Visible rather than magic.** A new build never takes over under
 *    somebody's hands; it says it is there and waits to be asked.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RitualStage } from '@somemore/sim';
import { FONT_STACK, TOKENS } from '../ui/styles.js';
import { pwa } from './register.js';

/**
 * Stages during which nothing may appear at all.
 *
 * Everything from the stick going out over the coals to the sandwich coming
 * out of the machine is one continuous thing, and it is the thing the whole
 * product exists for.
 */
const SACRED: readonly RitualStage[] = ['roasting', 'assembling', 'machine', 'reveal'];

/**
 * Stages during which the install offer is allowed.
 *
 * Strictly after the reveal: the sandwich is out, it is in hand, and the
 * question "would you like to keep this?" finally means something other than
 * an interruption.
 */
const AFTER_THE_REVEAL: readonly RitualStage[] = ['eating', 'after'];

/** How long to let the moment be, once an allowed stage is reached. */
const DWELL_MS = 6000;

export interface PwaNoticesProps {
  stage: RitualStage;
  /** Whether any overlay is open. Nothing is shown over one. */
  overlayOpen: boolean;
  textScale: number;
  highContrast: boolean;
}

export function PwaNotices({
  stage,
  overlayOpen,
  textScale,
  highContrast,
}: PwaNoticesProps): React.ReactElement | null {
  const state = useSyncExternalStore(pwa.subscribe, pwa.getSnapshot, pwa.getSnapshot);
  const [dwelled, setDwelled] = useState(false);
  const [inviteRefused, setInviteRefused] = useState(false);
  const [updateRefused, setUpdateRefused] = useState(false);
  const enteredAt = useRef(0);

  const eligible = AFTER_THE_REVEAL.includes(stage);
  useEffect(() => {
    if (!eligible) {
      enteredAt.current = 0;
      setDwelled(false);
      return;
    }
    if (enteredAt.current === 0) enteredAt.current = Date.now();
    const remaining = Math.max(0, DWELL_MS - (Date.now() - enteredAt.current));
    const timer = setTimeout(() => setDwelled(true), remaining);
    return () => clearTimeout(timer);
  }, [eligible]);

  if (overlayOpen) return null;
  if (SACRED.includes(stage)) return null;

  const showUpdate = state.updateReady && !updateRefused;
  const showInvite = !showUpdate && dwelled && !inviteRefused && pwa.inviteAllowed;
  if (!showUpdate && !showInvite) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: `calc(14px + env(safe-area-inset-left, 0px))`,
        // Above whatever else the bottom-left corner holds — the campfire
        // roster button lives there during a shared session, and a card
        // dropped on top of it would take a control away rather than add one.
        bottom: `calc(64px + env(safe-area-inset-bottom, 0px))`,
        zIndex: 30,
        maxWidth: `min(${320 * textScale}px, calc(100vw - 28px))`,
      }}
    >
      {showUpdate ? (
        <Card
          textScale={textScale}
          highContrast={highContrast}
          title="A newer campsite"
          body="An update finished downloading. It will be used the next time you reload."
          confirmLabel="Reload now"
          onConfirm={() => pwa.applyUpdate()}
          onDismiss={() => setUpdateRefused(true)}
          dismissLabel="Later"
        />
      ) : (
        <Card
          textScale={textScale}
          highContrast={highContrast}
          title="Keep the campsite"
          body="Some More can be added to your home screen. It works with no signal at all."
          confirmLabel="Add it"
          onConfirm={() => {
            void pwa.promptInstall();
          }}
          onDismiss={() => {
            pwa.dismissInstall();
            setInviteRefused(true);
          }}
          dismissLabel="Not now"
        />
      )}
    </div>
  );
}

function Card({
  title,
  body,
  confirmLabel,
  dismissLabel,
  onConfirm,
  onDismiss,
  textScale,
  highContrast,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  dismissLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
  textScale: number;
  highContrast: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid="pwa-notice"
      style={{
        background: highContrast ? '#000' : 'rgba(8, 10, 14, 0.86)',
        border: `1px solid ${highContrast ? TOKENS.paper : 'rgba(232,224,205,0.24)'}`,
        borderRadius: 2,
        padding: `${10 * textScale}px ${12 * textScale}px`,
        color: TOKENS.paper,
        boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
      }}
    >
      <div
        style={{
          fontFamily: FONT_STACK.mono,
          fontSize: `${10 * textScale}px`,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: highContrast ? TOKENS.paper : TOKENS.amber,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: FONT_STACK.sans,
          fontSize: `${12 * textScale}px`,
          lineHeight: 1.5,
          marginTop: `${5 * textScale}px`,
          color: highContrast ? TOKENS.paper : 'rgba(232,224,205,0.82)',
        }}
      >
        {body}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: `${9 * textScale}px` }}>
        <button
          className="sm-focus"
          data-testid="pwa-notice-confirm"
          onClick={onConfirm}
          style={{
            background: 'transparent',
            border: `1px solid ${highContrast ? TOKENS.paper : 'rgba(255,164,44,0.6)'}`,
            color: highContrast ? TOKENS.paper : TOKENS.amber,
            padding: `${6 * textScale}px ${11 * textScale}px`,
            fontSize: `${11 * textScale}px`,
            letterSpacing: '0.09em',
            textTransform: 'uppercase',
            borderRadius: 2,
            // A tap target that is comfortable with a thumb, in the dark.
            minHeight: `${Math.max(36, 30 * textScale)}px`,
          }}
        >
          {confirmLabel}
        </button>
        <button
          className="sm-focus"
          data-testid="pwa-notice-dismiss"
          onClick={onDismiss}
          style={{
            background: 'transparent',
            border: '1px solid transparent',
            color: highContrast ? TOKENS.paper : 'rgba(232,224,205,0.55)',
            padding: `${6 * textScale}px ${8 * textScale}px`,
            fontSize: `${11 * textScale}px`,
            letterSpacing: '0.09em',
            textTransform: 'uppercase',
            minHeight: `${Math.max(36, 30 * textScale)}px`,
          }}
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}
