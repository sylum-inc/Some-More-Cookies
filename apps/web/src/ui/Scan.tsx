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
 *
 * ## Drawn now, and the one thing on it that is not
 *
 * The panel moved into the pixel buffer with the Passport and Settings (§6.2);
 * see `ui/PixelPanel.tsx` for the canvas-plus-DOM division. What is left in
 * this file is the panel's *content* — what it says, what it asks for, and what
 * pressing each thing does — and there is no styling in it at all.
 *
 * The camera is the exception, and it is a considered one. A live preview is
 * not printed matter: it is the outside world arriving through a lens, thirty
 * times a second. `developPhoto` is the kit's answer for a photograph and it is
 * the wrong answer here twice over — it is a treatment for a capture that has
 * *stopped moving*, box-filtered onto the paper ramp, and running it per frame
 * would put a shimmering ordered dither on a panel whose whole rule is that
 * nothing animates (§12). So the kit draws the *instrument* — a sunken aperture
 * with reticle corners, `ApertureBlock` — and the real `<video>` sits inside
 * it, clipped to the drawn window, at full opacity. The one honest pixel on a
 * drawn panel that is not ours: a lens shows what the lens sees.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  cameraScanSupported,
  startCameraScan,
  type CameraFailure,
  type CameraScanner,
  type ScanFlow,
  type ScanState,
} from '../net/codes.js';
import { PixelPanel } from './PixelPanel.js';
import type { PanelBlock, PanelControl } from './pixel/index.js';

export interface ScanProps {
  flow: ScanFlow;
  textScale: number;
  highContrast?: boolean;
  onClose: () => void;
  /** The bezel's thickness, from `bezelInset`. */
  frameInset?: number;
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

export function Scan({
  flow,
  textScale,
  highContrast,
  onClose,
  frameInset,
  onCampInvite,
}: ScanProps): React.ReactElement {
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

  const { blocks, testIds } = useMemo(
    () => scanPage(state, typed, { cameraAvailable, cameraOpen, cameraNote }),
    [state, typed, cameraAvailable, cameraOpen, cameraNote],
  );

  return (
    <PixelPanel
      label="Add a code"
      closeLabel="Close"
      blocks={blocks}
      testIds={testIds}
      textScale={textScale}
      {...(highContrast === undefined ? {} : { highContrast })}
      {...(frameInset === undefined ? {} : { frameInset })}
      onClose={close}
      onText={(_id, value) => setTyped(value)}
      onSubmit={() => submit(typed)}
      slot={(id) =>
        id === 'viewfinder' ? (
          /*
            Full opacity, on purpose, and the one element on any drawn panel
            that is. `object-fit: cover` rather than `contain`: the window is
            filled by the picture instead of the picture being letterboxed
            inside a drawn aperture, because a letterbox inside a viewfinder is
            two frames around one image.
          */
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : null
      }
      onButton={(id) => {
        if (id === 'use-camera') void openCamera();
        else if (id === 'stop-camera') stopCamera();
        else if (id === 'submit') submit(typed);
        else if (id === 'another') {
          flow.reset();
          setTyped('');
        }
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export interface ScanCamera {
  readonly cameraAvailable: boolean;
  readonly cameraOpen: boolean;
  readonly cameraNote: string | null;
}

/**
 * The whole panel, as blocks.
 *
 * Pure and exported, the same bargain `settingsPage` and `passportPage` make:
 * everything about this screen that could be wrong — a verdict that does not
 * say where it came from, an entry field that is not there, a stage the panel
 * offers no way out of — is decidable from this array without a browser.
 */
export function scanPage(
  state: ScanState,
  typed: string,
  camera: ScanCamera,
): { blocks: PanelBlock[]; testIds: Record<string, string> } {
  const blocks: PanelBlock[] = [];
  const testIds: Record<string, string> = {};

  blocks.push({ kind: 'machine', id: 'kicker', text: 'Some More · Package code' });
  blocks.push({ kind: 'heading', id: 'title', level: 1, text: 'Add a code' });
  blocks.push({
    kind: 'body',
    id: 'where',
    tone: 'soft',
    text: 'It is printed on the wrapper, under the QR. It starts with SM1.',
  });

  /*
   * The camera, only where the browser has one and only when asked.
   *
   * Absent rather than disabled where `BarcodeDetector` is missing, which is
   * the one place on these three panels that rule is inverted: everywhere else
   * a control that cannot be used yet stays put and says so, because a panel
   * whose buttons appear and vanish moves under the reader. A permanently
   * disabled "use the camera" on a browser that will never have one is not
   * that — it is an advertisement for a feature that is not coming.
   */
  if (camera.cameraAvailable && !camera.cameraOpen) {
    blocks.push({
      kind: 'controls',
      id: 'camera-controls',
      controls: [{ kind: 'button', id: 'use-camera', label: 'Use the camera' }],
    });
    testIds['use-camera'] = 'scan-open-camera';
  }
  if (camera.cameraOpen) {
    blocks.push({
      kind: 'aperture',
      id: 'viewfinder',
      label: 'The camera, looking for a QR code',
      aspect: 4 / 3,
    });
    blocks.push({
      kind: 'controls',
      id: 'camera-stop',
      controls: [{ kind: 'button', id: 'stop-camera', label: 'Stop the camera' }],
    });
  }
  if (camera.cameraNote !== null) {
    blocks.push({ kind: 'body', id: 'camera-note', tone: 'soft', text: camera.cameraNote });
  }

  // The path that always works.
  const busy = state.stage === 'checking' || state.stage === 'redeeming';
  blocks.push({
    kind: 'controls',
    id: 'entry',
    controls: [
      {
        kind: 'text',
        id: 'code',
        label: 'Type it in',
        value: typed,
        // No ellipsis. The first proof sheet set "SM1.…" and it drew as
        // "SM1...." — a full stop followed by three more, which reads as a
        // typo rather than as an invitation.
        placeholder: 'SM1.',
        /*
         * Three lines, because a signed code is about eighty-six characters
         * and wraps to five or six at this measure — a one-line well would
         * show a fifth of what somebody had just pasted, which is the field
         * this panel exists for showing the least of itself.
         */
        rows: 3,
      },
    ],
  });
  testIds['code'] = 'scan-input';

  const actions: PanelControl[] = [
    {
      kind: 'button',
      id: 'submit',
      label: state.stage === 'redeeming' ? 'Checking with the depot…' : 'Add it',
      disabled: busy,
    },
  ];
  if (state.stage !== 'idle') actions.push({ kind: 'button', id: 'another', label: 'Another' });
  blocks.push({ kind: 'controls', id: 'actions', controls: actions });
  testIds['submit'] = 'scan-submit';
  testIds['another'] = 'scan-another';

  /*
   * The verdict, as one block and therefore as one announcement.
   *
   * Where the answer came from is part of the answer rather than a footnote
   * beside it: a refusal the phone decided is a different fact from one the
   * depot handed down, and on one bar of signal that is the difference between
   * "this is not a code" and "we could not ask". It was a second paragraph in
   * the CSS panel and it is a second line of the same paragraph here, which is
   * what keeps it inside one live region — two regions announcing half a
   * verdict each is the failure §12 is about, pointing the other way.
   */
  if (state.message !== null) {
    blocks.push({ kind: 'rule', id: 'verdict-rule', style: 'hair' });
    const lines = [state.message];
    if (state.decidedOffline && state.stage === 'rejected') {
      lines.push('CHECKED ON THIS DEVICE · NO CONNECTION NEEDED');
    }
    if (state.stage === 'camp_invite') {
      lines.push(
        'The signature checks out, so the invitation is real. Joining somebody else’s fire is not something this screen does — it hands the invitation over and steps back.',
      );
    }
    blocks.push({
      kind: 'body',
      id: 'verdict',
      text: lines.join('\n'),
      role: 'status',
      // Asked for: somebody pressed a button and is waiting for the answer, so
      // interrupting whatever else was being read is correct rather than rude.
      live: 'assertive',
      label: 'What the code turned out to be',
      data: { stage: state.stage },
    });
    testIds['verdict'] = 'scan-result';
  }

  return { blocks, testIds };
}
