/**
 * Adding a code from a wrapper.
 *
 * Reached from the Passport, which is where rewards already live and where a
 * ticket stub belongs. Deliberately *not* on the HUD and deliberately not part
 * of the ritual: scanning a box is something you do between things, and putting
 * it in the campfire's line of sight would make the world advertise at you.
 *
 * Two shapes the interface has to hold:
 *
 *  1. **Typing it in is the primary path**, not a fallback. `BarcodeDetector`
 *     exists in Chromium and nowhere else, so a camera-first design would be
 *     broken on most phones — and adding a QR decoder would be a runtime
 *     dependency for a convenience. The field is always there and always works.
 *  2. **The camera is asked for only when somebody asks for it.** A permission
 *     prompt that appears because you sat down at a campfire is intrusive. The
 *     button says what it will do; denial is an ordinary answer and the field
 *     is still right there underneath.
 *
 * Everything the panel says about a code it says because either the phone
 * checked the signature (offline, no request) or the service answered. Nothing
 * on this screen is a guess.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cameraScanSupported, startCameraScan, type CameraFailure, type CameraScanner, type ScanFlow, type ScanState } from '../net/codes.js';
import { FONT_STACK, TOKENS } from './styles.js';
import { useDialog } from './useDialog.js';

export interface ScanProps {
  flow: ScanFlow;
  textScale: number;
  onClose: () => void;
  /**
   * A verified campfire invite. The seam: this component's job ends at handing
   * over the token, and the multiplayer client's begins.
   */
  onCampInvite?: (inviteToken: string) => void;
}

const CAMERA_MESSAGES: Readonly<Record<CameraFailure, string>> = {
  unsupported: 'This browser cannot read a QR code. Type it in instead — it works everywhere.',
  denied: 'No camera access, which is fine. Type the code in instead.',
  no_camera: 'No camera on this device. Type the code in instead.',
  failed: 'The camera would not start. Type the code in instead.',
};

export function Scan({ flow, textScale, onClose, onCampInvite }: ScanProps): React.ReactElement {
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();
  const px = (n: number): string => `${n * textScale}px`;
  const state = useSyncExternalStore<ScanState>(
    (listener) => flow.subscribe(() => listener()),
    () => flow.state,
    () => flow.state,
  );

  const [typed, setTyped] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<CameraScanner | null>(null);
  const cameraAvailable = cameraScanSupported();

  const stopCamera = useCallback(() => {
    scannerRef.current?.stop();
    scannerRef.current = null;
    setCameraOpen(false);
  }, []);

  // The camera is released on unmount, on close, and the moment a code is
  // read. A game that leaves the light on is a game people uninstall.
  useEffect(() => () => scannerRef.current?.stop(), []);

  const submit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      stopCamera();
      void flow.submit(trimmed);
    },
    [flow, stopCamera],
  );

  const openCamera = useCallback(async () => {
    setCameraNote(null);
    setCameraOpen(true);
    // The element has to exist before `getUserMedia`, so this runs after the
    // state flush that renders it.
    await Promise.resolve();
    const video = videoRef.current;
    if (!video) {
      setCameraOpen(false);
      return;
    }
    const scanner = await startCameraScan(video, {
      onCode: (value) => submit(value),
      onFailure: (reason) => {
        setCameraNote(CAMERA_MESSAGES[reason]);
        setCameraOpen(false);
      },
    });
    scannerRef.current = scanner;
  }, [submit]);

  useEffect(() => {
    if (state.stage === 'camp_invite' && state.inviteToken !== null) {
      onCampInvite?.(state.inviteToken);
    }
  }, [state.stage, state.inviteToken, onCampInvite]);

  const close = useCallback(() => {
    stopCamera();
    onClose();
  }, [onClose, stopCamera]);

  return (
    <div
      className="sm-overlay"
      role="dialog"
      aria-label="Add a code"
      onClick={close}
      {...dialog.props}
    >
      <div
        className="sm-panel"
        onClick={(event) => event.stopPropagation()}
        style={{
          background: `radial-gradient(ellipse at 25% 8%, rgba(255,252,240,0.9), transparent 62%), ${TOKENS.paper}`,
          padding: px(26),
          width: 'min(560px, 94vw)',
        }}
      >
        <button
          className="sm-focus"
          onClick={close}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: px(10),
            right: px(12),
            background: 'transparent',
            border: 'none',
            fontSize: px(22),
            color: TOKENS.inkSoft,
            lineHeight: 1,
          }}
        >
          ×
        </button>

        <header style={{ borderBottom: `2px solid ${TOKENS.ink}`, paddingBottom: px(10), marginBottom: px(14) }}>
          <div style={{ fontFamily: FONT_STACK.mono, fontSize: px(10), letterSpacing: '0.3em', color: TOKENS.inkSoft }}>
            SOME MORE · PACKAGE CODE
          </div>
          <h1
            style={{
              fontFamily: FONT_STACK.serif,
              fontSize: px(24),
              margin: `${px(6)} 0 0`,
              color: TOKENS.ink,
            }}
          >
            Add a code
          </h1>
          <p style={{ fontFamily: FONT_STACK.hand, fontSize: px(14), color: TOKENS.inkSoft, margin: `${px(4)} 0 0` }}>
            It is printed on the wrapper, under the QR. Starts with <code>SM1.</code>
          </p>
        </header>

        {/* The camera, only where the browser has one and only when asked. */}
        {cameraAvailable && !cameraOpen && (
          <button
            className="sm-focus"
            data-testid="scan-open-camera"
            onClick={() => void openCamera()}
            style={{
              background: 'transparent',
              border: `1px solid ${TOKENS.ink}`,
              color: TOKENS.ink,
              padding: `${px(8)} ${px(14)}`,
              fontSize: px(12),
              letterSpacing: '0.08em',
              borderRadius: 2,
              marginBottom: px(14),
            }}
          >
            Use the camera
          </button>
        )}

        {cameraOpen && (
          <div style={{ marginBottom: px(14) }}>
            <video
              ref={videoRef}
              muted
              playsInline
              style={{
                width: '100%',
                borderRadius: 2,
                background: TOKENS.night,
                aspectRatio: '4 / 3',
                objectFit: 'cover',
              }}
            />
            <button
              className="sm-focus"
              onClick={stopCamera}
              style={{
                background: 'transparent',
                border: `1px solid ${TOKENS.inkSoft}`,
                color: TOKENS.inkSoft,
                padding: `${px(6)} ${px(12)}`,
                fontSize: px(11),
                marginTop: px(8),
                borderRadius: 2,
              }}
            >
              Stop the camera
            </button>
          </div>
        )}

        {cameraNote !== null && (
          <p style={{ fontSize: px(12), color: TOKENS.inkSoft, margin: `0 0 ${px(12)}`, lineHeight: 1.5 }}>
            {cameraNote}
          </p>
        )}

        {/* The path that always works. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(typed);
          }}
        >
          <label
            htmlFor="sm-code-input"
            style={{
              display: 'block',
              fontFamily: FONT_STACK.mono,
              fontSize: px(10),
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              color: TOKENS.inkSoft,
              marginBottom: px(6),
            }}
          >
            Type it in
          </label>
          <textarea
            id="sm-code-input"
            data-testid="scan-input"
            className="sm-focus"
            value={typed}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setTyped(event.target.value)}
            rows={3}
            style={{
              width: '100%',
              fontFamily: FONT_STACK.mono,
              fontSize: px(12),
              lineHeight: 1.5,
              padding: px(10),
              color: TOKENS.ink,
              background: 'rgba(255,253,246,0.8)',
              border: `1px solid ${TOKENS.inkSoft}`,
              borderRadius: 2,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: px(10), alignItems: 'center', marginTop: px(10) }}>
            <button
              type="submit"
              className="sm-focus"
              data-testid="scan-submit"
              disabled={state.stage === 'checking' || state.stage === 'redeeming'}
              style={{
                background: TOKENS.ink,
                color: TOKENS.paper,
                border: 'none',
                padding: `${px(9)} ${px(18)}`,
                fontSize: px(12),
                letterSpacing: '0.1em',
                borderRadius: 2,
                opacity: state.stage === 'checking' || state.stage === 'redeeming' ? 0.6 : 1,
              }}
            >
              {state.stage === 'redeeming' ? 'Checking with the depot…' : 'Add it'}
            </button>
            {state.stage !== 'idle' && (
              <button
                type="button"
                className="sm-focus"
                onClick={() => {
                  flow.reset();
                  setTyped('');
                }}
                style={{
                  background: 'transparent',
                  border: `1px solid ${TOKENS.inkSoft}`,
                  color: TOKENS.inkSoft,
                  padding: `${px(8)} ${px(12)}`,
                  fontSize: px(11),
                  borderRadius: 2,
                }}
              >
                Another
              </button>
            )}
          </div>
        </form>

        {/* The verdict. */}
        {state.message !== null && (
          <div
            data-testid="scan-result"
            data-stage={state.stage}
            role="status"
            aria-live="polite"
            style={{
              marginTop: px(16),
              padding: px(12),
              borderLeft: `3px solid ${state.stage === 'redeemed' ? TOKENS.stamp : TOKENS.inkSoft}`,
              background: 'rgba(255,253,246,0.72)',
            }}
          >
            <p
              style={{
                fontFamily: state.stage === 'redeemed' ? FONT_STACK.hand : FONT_STACK.sans,
                fontSize: px(state.stage === 'redeemed' ? 16 : 13),
                color: TOKENS.ink,
                margin: 0,
                lineHeight: 1.55,
              }}
            >
              {state.message}
            </p>
            {/*
              Say where the answer came from. A refusal decided on the phone is
              a different fact from one the depot handed down — and on one bar
              of signal it is the difference between "this is not a code" and
              "we could not ask".
            */}
            {state.decidedOffline && state.stage === 'rejected' && (
              <p
                style={{
                  fontFamily: FONT_STACK.mono,
                  fontSize: px(10),
                  letterSpacing: '0.12em',
                  color: TOKENS.inkSoft,
                  margin: `${px(8)} 0 0`,
                }}
              >
                CHECKED ON THIS DEVICE · NO CONNECTION NEEDED
              </p>
            )}
            {state.stage === 'camp_invite' && (
              <p style={{ fontSize: px(12), color: TOKENS.inkSoft, margin: `${px(8)} 0 0`, lineHeight: 1.5 }}>
                The signature checks out, so the invitation is real. Joining somebody else’s fire is not
                something this screen does — it hands the invitation over and steps back.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
