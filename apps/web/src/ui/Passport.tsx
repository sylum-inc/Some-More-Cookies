/**
 * The Campfire Passport (spec §6.2).
 *
 * A field journal, a campground registration booklet, a disposable photo
 * album, a scrapbook, and a PS1 memory card — explicitly *not* a card grid or
 * a dashboard. It is opened, never landed on.
 *
 * It is now drawn into the pixel buffer rather than styled onto the page. §6.2
 * is amended to say so: the *material* is unchanged — weathered paper, stamped
 * ink, small monospaced capitals, a die-struck mark for every stamp — and the
 * *medium* has moved, because a warm-paper field journal set in anti-aliased
 * Georgia at device resolution over a 426x240 nearest-neighbour world is two
 * products in one window. See `ui/PixelPanel.tsx` for the canvas-plus-DOM
 * division, and `ui/pixel/panel.ts` for why the DOM half is not optional.
 *
 * What this file is, therefore: the booklet's *content*, as blocks. There is
 * no styling in it at all.
 */

import { provenanceLines } from '@somemore/sim';
import type { PassportState } from '../state/store.js';
import { PixelPanel } from './PixelPanel.js';
import type { PanelBlock, PhotoPixels } from './pixel/index.js';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface PassportProps {
  passport: PassportState;
  onClose: () => void;
  onLink: (provider: 'apple' | 'google' | 'email') => void;
  textScale: number;
  /** The campsite this Passport is open at, if it is open at one. */
  campsiteSeed?: string;
  highContrast?: boolean;
  /** The bezel's thickness, from `bezelInset`. */
  frameInset?: number;
  /**
   * Opens the code panel.
   *
   * Here rather than on the HUD because this is where rewards already live and
   * because a wrapper is something you have in your hand between things — not
   * something the campfire should be asking you about.
   */
  onAddCode?: () => void;
}

/** How many entries and stubs a booklet prints. Unchanged by the move. */
const MAX_ENTRIES = 12;
const MAX_STUBS = 10;
const MAX_SIGHTINGS = 6;
const MAX_SECRETS = 6;

export function Passport({
  passport,
  onClose,
  onLink,
  textScale,
  campsiteSeed,
  highContrast,
  frameInset,
  onAddCode,
}: PassportProps): React.ReactElement {
  const here = campsiteSeed === undefined ? undefined : passport.campsites[campsiteSeed];
  const photos = usePhotographs(passport.photos);

  // Only whether the button exists, never the handler: `App` passes an inline
  // arrow, so depending on the function itself would relay out the whole
  // booklet on every render of the app. See the same note in `Settings.tsx`.
  const canAddCode = onAddCode !== undefined;
  // Stable, so the panel's draw effect does not fire on every render of the app.
  const photo = useCallback((id: string) => photos.get(id), [photos]);
  const { blocks, testIds } = useMemo(
    () => passportPage(passport, here, canAddCode),
    [passport, here, canAddCode],
  );

  return (
    <PixelPanel
      label="Campfire Passport"
      closeLabel="Close passport"
      blocks={blocks}
      testIds={testIds}
      textScale={textScale}
      {...(highContrast === undefined ? {} : { highContrast })}
      {...(frameInset === undefined ? {} : { frameInset })}
      onClose={onClose}
      photo={photo}
      onButton={(id) => {
        if (id === 'add-code') onAddCode?.();
        else if (id === 'link-apple') onLink('apple');
        else if (id === 'link-google') onLink('google');
        else if (id === 'link-email') onLink('email');
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The booklet                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every page of the booklet, in order, as blocks.
 *
 * Pure, exported and unit-tested. Everything about a Passport that could be
 * wrong — a section missing, a number where a sentence should be, an
 * identifier leaking into the prose — is decidable from this array without a
 * canvas, a DOM or a screenshot, which is the same bargain `layoutPanel` makes
 * one level down.
 */
export function passportPage(
  passport: PassportState,
  here: PassportState['campsites'][string] | undefined,
  canAddCode: boolean,
): { blocks: PanelBlock[]; testIds: Record<string, string> } {
  const blocks: PanelBlock[] = [];
  const testIds: Record<string, string> = {};

  // The cover, like a registration booklet.
  blocks.push({ kind: 'machine', id: 'kicker', text: 'Some More · Campground registration' });
  blocks.push({ kind: 'heading', id: 'title', level: 1, text: 'Campfire Passport' });
  blocks.push({
    kind: 'body',
    id: 'issued',
    tone: 'soft',
    text: `${passport.displayName} · issued ${formatDate(passport.createdAt)}`,
  });
  blocks.push({ kind: 'rule', id: 'cover-rule', style: 'solid' });

  // Stamps — a row of inked marks, not achievement tiles.
  blocks.push({ kind: 'heading', id: 'stamps-label', level: 2, text: 'Stamps' });
  if (passport.stamps.length === 0) {
    blocks.push({
      kind: 'body',
      id: 'stamps-empty',
      tone: 'soft',
      text: 'No stamps yet. The first one comes with the first sandwich.',
    });
  } else {
    blocks.push({
      kind: 'stamps',
      id: 'stamps',
      marks: passport.stamps.map((stamp) => ({ id: stamp, label: stamp.replace('stamp-', '').replace(/-/g, ' ') })),
    });
  }

  // Photographs.
  blocks.push({ kind: 'heading', id: 'photos-label', level: 2, text: 'Photographs' });
  if (passport.photos.length === 0) {
    blocks.push({ kind: 'body', id: 'photos-empty', tone: 'soft', text: 'Nothing developed yet.' });
  } else {
    blocks.push({
      kind: 'photos',
      id: 'photos',
      photos: passport.photos.map((photo) => ({ id: photo.id, caption: photo.caption })),
    });
  }

  /*
   * Ticket stubs.
   *
   * What came off a wrapper or an event card. The reward itself is the
   * account's and was server-validated when it was granted (spec §11); this is
   * the stub, so it still reads at a campsite with no signal.
   */
  blocks.push({ kind: 'heading', id: 'stubs-label', level: 2, text: 'Ticket stubs' });
  const stubs = passport.redeemedCodes ?? [];
  if (stubs.length === 0) {
    blocks.push({ kind: 'body', id: 'stubs-empty', tone: 'soft', text: 'Nothing scanned yet.' });
  } else {
    for (const stub of stubs.slice(0, MAX_STUBS)) {
      const id = `stub-${stub.id}`;
      testIds[id] = 'passport-stub';
      blocks.push({ kind: 'body', id, text: `${stub.awarded}\n${formatDate(stub.redeemedAt)}` });
    }
  }
  if (canAddCode) {
    testIds['add-code'] = 'passport-add-code';
    blocks.push({
      kind: 'controls',
      id: 'add-code-row',
      controls: [{ kind: 'button', id: 'add-code', label: 'Add a code from a wrapper' }],
    });
  }

  // Sandwich records — receipts, not a leaderboard.
  blocks.push({ kind: 'heading', id: 'record-label', level: 2, text: 'Record of sandwiches' });
  if (passport.entries.length === 0) {
    blocks.push({ kind: 'body', id: 'record-empty', tone: 'soft', text: 'None yet.' });
  } else {
    for (const entry of passport.entries.slice(0, MAX_ENTRIES)) {
      blocks.push({
        kind: 'machine',
        id: `entry-${entry.id}-head`,
        text: `${entry.sandwich.class} · ${formatDateTime(entry.savedAt)}`,
      });
      blocks.push({ kind: 'body', id: `entry-${entry.id}-caption`, text: entry.sandwich.caption });
      blocks.push({
        kind: 'machine',
        id: `entry-${entry.id}-provenance`,
        text: provenanceLines(entry.sandwich).join('\n'),
      });
    }
  }

  /*
   * This campsite.
   *
   * The one page that is *about a place* rather than about the player. It
   * counts visits, because an ordinal is not a score — "the fourth time" is a
   * fact about a night, not a rating of it. There is no denominator anywhere
   * on it: no animals-seen-of-total, no secrets-found-of-total, no completion.
   * The significance value that decided which of these things were worth
   * keeping is never stored and never shown (§6.4).
   */
  if (here !== undefined && here.visits > 1) {
    blocks.push({ kind: 'heading', id: 'site-label', level: 2, text: 'This campsite' });
    blocks.push({ kind: 'body', id: 'site-visits', text: visitLine(here.visits) });
    if (here.sightings.length > 0) {
      blocks.push({
        kind: 'body',
        id: 'site-sightings',
        tone: 'soft',
        text: `Seen here: ${here.sightings.slice(0, MAX_SIGHTINGS).join(', ')}.`,
      });
    }
    for (const record of here.secrets.slice(0, MAX_SECRETS)) {
      blocks.push({
        kind: 'body',
        id: `secret-${record.secretId}`,
        text: record.evidence ?? record.secretId.replace(/-/g, ' '),
      });
    }
    if (here.traces.filter((trace) => trace.disposition === 'landmark').length > 0) {
      blocks.push({ kind: 'body', id: 'site-traces', tone: 'soft', text: 'Some of it is still out there.' });
    }
  }

  // Account linking, offered without pressure.
  blocks.push({ kind: 'rule', id: 'keep-rule', style: 'dashed' });
  blocks.push({ kind: 'heading', id: 'keep-label', level: 2, text: 'Keep this passport' });
  if (passport.linkedProvider === 'none') {
    blocks.push({
      kind: 'body',
      id: 'keep-body',
      tone: 'soft',
      text:
        'This passport lives on this device. Linking an account keeps everything in it — nothing is lost, and nothing changes about how you play.',
    });
    blocks.push({
      kind: 'controls',
      id: 'link',
      controls: [
        { kind: 'button', id: 'link-apple', label: 'Apple' },
        { kind: 'button', id: 'link-google', label: 'Google' },
        { kind: 'button', id: 'link-email', label: 'Email' },
      ],
    });
  } else {
    blocks.push({
      kind: 'body',
      id: 'keep-linked',
      tone: 'soft',
      text: `Linked with ${passport.linkedProvider}.`,
    });
  }

  return { blocks, testIds };
}

/**
 * How many times you have been here, said the way a person would.
 *
 * Never a number in a box. "The fourth time" is a sentence; "Visits: 4" is a
 * statistic, and a statistic about a campsite turns it into a record card.
 */
export function visitLine(visits: number): string {
  if (visits <= 1) return 'The first night here.';
  if (visits === 2) return 'You have been here once before.';
  if (visits === 3) return 'The third time at this fire.';
  if (visits < 8) return `You keep coming back to this one.`;
  if (visits < 20) return 'This one is yours by now.';
  return 'You know this place with your eyes shut.';
}

/*
 * Dates, with the font's own character set in mind.
 *
 * `toLocaleDateString` will hand back a Japanese year marker or an Arabic
 * digit for a locale the font has no glyph for, and a missing glyph draws as a
 * hollow box — correct behaviour and a bad date. So the parts are asked for
 * individually in a locale the booklet is actually set in, which is the same
 * decision the rest of the printed copy makes by being written in English.
 * This is a real limitation and it is written down rather than hidden: the day
 * the game is localised, the font grows the glyphs first.
 */
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

function formatDate(at: number): string {
  return DATE.format(new Date(at));
}

function formatDateTime(at: number): string {
  return `${DATE.format(new Date(at))} ${TIME.format(new Date(at))}`;
}

/* -------------------------------------------------------------------------- */
/* Developing the photographs                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How large a photograph is decoded before it is printed.
 *
 * Small on purpose. `developPhoto` box-filters from this down to a print about
 * seventy pixels across, and the filter only needs enough source to average
 * away the world's own dither — decoding a 1024-pixel capture to average it
 * into 72 would be a megabyte of `ImageData` per photograph to throw away.
 */
const DECODE_WIDTH = 160;
const DECODE_HEIGHT = 120;

/**
 * The photographs, as pixels the panel can print.
 *
 * This is the honest answer to "a drawn panel has no obvious home for a
 * runtime data URL". The alternatives were both worse: an `<img>` floating
 * over the canvas puts the original defect back — a smooth, full-colour,
 * device-resolution rectangle in the middle of a page made of eleven colours —
 * and dropping the photographs from the booklet would delete a feature to make
 * a rendering job easier.
 *
 * So a photograph is *developed*: decoded once, box-filtered down, and
 * ordered-dithered onto the panel's own paper-to-ink ramp by `photo.ts`. What
 * comes out is a halftone print in the booklet's ink, which is what a
 * photograph in a campground scrapbook is.
 *
 * A photograph that cannot be decoded — a cross-origin URL that taints the
 * canvas, a data URL that has already been dropped because the bytes reached
 * object storage — is simply absent from the map, and the panel draws an
 * undeveloped frame in its place. It is still a photograph in the booklet,
 * with its caption, in the accessibility tree; it is just not printed yet.
 */
function usePhotographs(photos: PassportState['photos']): Map<string, PhotoPixels> {
  const [developed, setDeveloped] = useState<Map<string, PhotoPixels>>(new Map());
  // The sources, as one string, so the effect re-runs when a photograph is
  // taken or its bytes move — and not on every render of the booklet.
  const sources = photos.map((photo) => `${photo.id}:${photo.dataUrl || photo.url || ''}`).join('|');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let live = true;
    const canvas = document.createElement('canvas');
    canvas.width = DECODE_WIDTH;
    canvas.height = DECODE_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return;

    void (async () => {
      const next = new Map<string, PhotoPixels>();
      for (const photo of photos) {
        const src = photo.dataUrl || photo.url;
        if (!src) continue;
        try {
          const image = await loadImage(src);
          if (!live) return;
          ctx.clearRect(0, 0, DECODE_WIDTH, DECODE_HEIGHT);
          ctx.drawImage(image, 0, 0, DECODE_WIDTH, DECODE_HEIGHT);
          const data = ctx.getImageData(0, 0, DECODE_WIDTH, DECODE_HEIGHT);
          next.set(photo.id, { width: data.width, height: data.height, data: data.data });
        } catch {
          // An undeveloped frame, which is what the panel draws for a print it
          // has no bytes for. Never a thrown error inside an open booklet.
        }
      }
      if (live) setDeveloped(next);
    })();

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  return developed;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Only meaningful for the stored copy; a data URL is same-origin already.
    // Without it a photograph fetched from object storage taints the canvas
    // and `getImageData` throws rather than returning anything.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('photograph did not load'));
    image.src = src;
  });
}
