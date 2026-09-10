/**
 * The fireside panel: who is here, what to say, and how to leave.
 *
 * Almost everything a shared campfire needs is diegetic — you walk over, you
 * hold something out, you wave. This panel is the *other* path, and spec §12 is
 * unambiguous that it cannot be a second-class one: every social act at this
 * fire has a control here, reachable by keyboard, labelled in text, and
 * carrying the same weight as the gesture. Voice in particular has a text
 * route that works whether or not there is an SFU, because most of the time
 * there will not be.
 *
 * It is a slip of camp-office paper rather than a chat client. There is no
 * roster count, no ping graph, no "players online" — the numbers that do appear
 * (a round trip, a note about accuracy) are there because hiding them would be
 * dishonest, not because anyone wants a dashboard.
 *
 * ## Drawn now, and this is the one it matters most on
 *
 * The medium moved into the pixel buffer with the Passport and Settings
 * (§6.2); see `ui/PixelPanel.tsx`. Of the panels in this product this is the
 * one a player actually has open *during* the ritual, with the fire still
 * burning behind it — so it is the one where the scrim, the bezel inset and
 * the legibility floor are load-bearing rather than tidy. All three come from
 * `PixelPanel` by construction: the scrim is an ordered screen that stops at
 * the rail (you are still at the fire while you read), the page is inset by the
 * bezel before its rectangle is chosen, and the paper is `paper` over `night`
 * rather than a wash the compositor invents.
 *
 * ## The roster
 *
 * Everyone at the fire is a name, a line about what they are doing, and three
 * controls — how loud they are for you, the stick, and blocking. The CSS panel
 * laid that out as a flex row with a 64-pixel slider wedged into it; at this
 * measure that row does not exist, and squeezing it in would have produced
 * exactly the "control mirrored somewhere else" that `pixel/panel.ts` forbids.
 * So a person is a small stack instead: name, what they are doing, then their
 * controls underneath. It is longer and it is the shape a camp-office list
 * actually has.
 *
 * The controls stay *present* when they cannot be used — the stick when you
 * are not holding it, everything when nobody else is here — rather than
 * appearing and disappearing. A panel whose buttons come and go as people walk
 * up is a panel that moves under the reader's finger, which is the same defect
 * the scroll-reveal bug in `PixelPanel` was.
 */

import { useMemo, useState } from 'react';
import type { Gesture } from '@somemore/protocol';
import type { Campfire } from '../net/campfire.js';
import { MARSHMALLOW_OBJECT_ID } from '../net/authority.js';
import { PixelPanel, type SliderMirror } from './PixelPanel.js';
import { sliderPosition, sliderReadout, sliderSpoken } from './Settings.js';
import type { PanelBlock, PanelControl } from './pixel/index.js';

/** The gestures worth a button. The rest are reachable from the world itself. */
const GESTURES: readonly { id: Gesture; label: string }[] = [
  { id: 'wave', label: 'Wave' },
  { id: 'high_five', label: 'High five' },
  { id: 'fist_bump', label: 'Fist bump' },
  { id: 'applaud', label: 'Applaud' },
  { id: 'point', label: 'Point' },
  { id: 'offer_food', label: 'Offer food' },
  { id: 'toss_stick', label: 'Toss a stick' },
];

const VOICE_MODES: readonly { id: 'open_mic' | 'push_to_talk' | 'off'; label: string }[] = [
  { id: 'open_mic', label: 'Open mic' },
  { id: 'push_to_talk', label: 'Push to talk' },
  { id: 'off', label: 'Mic off' },
];

export interface CampfirePanelProps {
  fire: Campfire;
  textScale: number;
  highContrast: boolean;
  /** The bezel's thickness, from `bezelInset`. */
  frameInset?: number;
  onClose: () => void;
}

export function CampfirePanel({
  fire,
  textScale,
  highContrast,
  frameInset,
  onClose,
}: CampfirePanelProps): React.ReactElement {
  const [draft, setDraft] = useState('');

  /*
   * Rebuilt when the fire has changed, and not when the flames have.
   *
   * `App` renders several times a second while this is open — the campsite is
   * still running behind the scrim — and `Campfire` is a mutable object rather
   * than a value, so there is nothing for a memo to compare. Everything this
   * page reads off it, reduced to one string: the roster, what has been said,
   * the connection, the voice, the notes. Rebuilding the blocks on every frame
   * would relay out and repaint the whole panel as the fire flickered, and
   * `Settings.tsx` has the same note for the same reason.
   */
  const stamp = [
    fire.status,
    fire.statusDetail ?? '',
    String(fire.joined),
    String(Math.round(fire.latencyMs)),
    String(fire.catchingUp),
    fire.notes.join('|'),
    fire.voice.status,
    fire.voice.mode,
    String(fire.voice.muted),
    fire.voice.reason ?? '',
    String(fire.chat.length),
    fire.roster.everyone
      .map((p) => `${p.accountId}:${p.phase}:${p.activity}:${String(p.blocked)}:${p.volume}:${String(p.micMuted)}`)
      .join(','),
    fire.authority.holderOf(MARSHMALLOW_OBJECT_ID) ?? '',
  ].join('·');
  const page = useMemo(() => campfirePage(fire, draft), [fire, draft, stamp]);

  const say = (): void => {
    if (fire.say(draft)) setDraft('');
  };

  return (
    <PixelPanel
      label="At the fire"
      closeLabel="Close"
      blocks={page.blocks}
      sliders={page.sliders}
      textScale={textScale}
      highContrast={highContrast}
      {...(frameInset === undefined ? {} : { frameInset })}
      onClose={onClose}
      onText={(_id, value) => setDraft(value)}
      onSubmit={say}
      onSlider={(id, value) => page.knobs[id]?.(value)}
      onButton={(id) => {
        if (id === 'say') say();
        else page.presses[id]?.();
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The whole panel, as blocks, plus what each control does.
 *
 * Pure in everything that matters and exported for the same reason
 * `settingsPage` is: what this panel *says* about a fire — who is here, what
 * they are doing, whether voice exists, what leaving costs — is decidable from
 * the array without a browser, and it is the half of this screen §12 is about.
 */
export function campfirePage(
  fire: Campfire,
  draft: string,
): {
  blocks: PanelBlock[];
  sliders: Record<string, SliderMirror>;
  knobs: Record<string, (value: number) => void>;
  presses: Record<string, () => void>;
} {
  const blocks: PanelBlock[] = [];
  const sliders: Record<string, SliderMirror> = {};
  const knobs: Record<string, (value: number) => void> = {};
  const presses: Record<string, () => void> = {};

  const people = fire.roster.everyone;
  const holder = fire.authority.holderOf(MARSHMALLOW_OBJECT_ID);
  const voiceReady = fire.voice.status === 'ready';

  blocks.push({ kind: 'heading', id: 'title', level: 1, text: 'At the fire' });
  blocks.push({ kind: 'machine', id: 'status', text: statusLine(fire) });

  /*
   * Whatever the fire is trying to tell you — a handover, a moderation notice.
   *
   * A live region, because it arrives without anybody having moved focus, and
   * `polite` rather than `assertive`: it is the fire volunteering something,
   * not an answer somebody asked for.
   */
  if (fire.notes.length > 0) {
    blocks.push({ kind: 'rule', id: 'notes-rule', style: 'solid' });
    blocks.push({
      kind: 'body',
      id: 'notes',
      text: fire.notes.join('\n'),
      role: 'status',
      live: 'polite',
      label: 'What the fire is telling you',
    });
  }

  /* --- Who is here ------------------------------------------------------ */
  blocks.push({ kind: 'heading', id: 'roster-label', level: 2, text: 'Around the fire' });
  if (people.length === 0) {
    blocks.push({ kind: 'body', id: 'roster-empty', tone: 'soft', text: 'Just you, for the moment.' });
  }
  for (const person of people) {
    /*
     * The name on its own line and in its own block.
     *
     * `campfire.spec.ts` asks for it by exact text — which is the right thing
     * for it to ask, because "the panel says who is here in words" is the
     * whole claim §12 makes about this list. A name concatenated into a
     * sentence would still be drawn and would no longer be findable.
     */
    blocks.push({ kind: 'body', id: `who-${person.accountId}`, text: person.name });
    blocks.push({
      kind: 'body',
      id: `doing-${person.accountId}`,
      tone: 'soft',
      text: describePerson(person.phase, person.activity, person.micMuted, holder === person.accountId),
    });

    const volumeId = `volume-${person.accountId}`;
    sliders[volumeId] = {
      min: 0,
      max: 1,
      step: 0.05,
      value: person.volume,
      spoken: sliderSpoken(person.volume, 0, 1),
    };
    knobs[volumeId] = (value) =>
      fire.requestVoice('set_volume', { accountId: person.accountId, volume: value });

    const offerId = `offer-${person.accountId}`;
    presses[offerId] = () => fire.offer(MARSHMALLOW_OBJECT_ID, 'marshmallow', person.accountId);
    const blockId = `block-${person.accountId}`;
    presses[blockId] = () => fire.block(person.accountId, !person.blocked);

    blocks.push({
      kind: 'controls',
      id: `person-${person.accountId}`,
      controls: [
        {
          kind: 'slider',
          id: volumeId,
          // Named per person rather than "Volume": a page with four sliders
          // all called the same thing is four sliders a screen reader cannot
          // tell apart.
          label: `How loud ${person.name} is`,
          readout: sliderReadout(person.volume, 0, 1),
          fraction: sliderPosition(person.volume, 0, 1),
          disabled: !voiceReady,
        },
        {
          kind: 'button',
          id: offerId,
          label: `Hand the stick to ${person.name}`,
          disabled: holder !== fire.accountId || person.phase !== 'here',
        },
        {
          kind: 'button',
          id: blockId,
          label: person.blocked ? `Unblock ${person.name}` : `Block ${person.name}`,
        },
      ],
    });
  }

  /* --- Voice ------------------------------------------------------------ */
  blocks.push({ kind: 'heading', id: 'voice-label', level: 2, text: 'Voice' });
  blocks.push({
    kind: 'body',
    id: 'voice-note',
    tone: 'soft',
    text: voiceReady
      ? `Spatial voice through ${fire.voice.provider ?? 'the room'}. Never recorded.`
      : `No voice here — ${fire.voice.reason ?? 'nothing is configured'}. Text and gesture carry the fire, and always can.`,
  });
  const voiceControls: PanelControl[] = VOICE_MODES.map((mode) => {
    presses[`voice-${mode.id}`] = () => fire.requestVoice('set_mode', { mode: mode.id });
    return {
      kind: 'button',
      id: `voice-${mode.id}`,
      label: mode.label,
      // One of three, so `aria-pressed` rather than a checkbox: "open mic" is
      // a choice among modes, not a thing that is on or off by itself.
      pressed: fire.voice.mode === mode.id,
      disabled: !voiceReady,
    };
  });
  presses['voice-mute'] = () => fire.requestVoice('set_muted', { muted: !fire.voice.muted });
  voiceControls.push({
    kind: 'button',
    id: 'voice-mute',
    label: fire.voice.muted ? 'Unmute' : 'Mute',
    disabled: !voiceReady,
  });
  blocks.push({ kind: 'controls', id: 'voice-controls', controls: voiceControls });

  /* --- Saying something -------------------------------------------------- */
  blocks.push({ kind: 'heading', id: 'say-label', level: 2, text: 'Say something' });
  blocks.push({
    kind: 'body',
    id: 'log',
    text:
      fire.chat.length === 0
        ? 'Nothing said yet.'
        : fire.chat.map((line) => `${line.name}: ${line.text}`).join('\n'),
    role: 'log',
    live: 'polite',
    label: 'What has been said at the fire',
  });
  blocks.push({
    kind: 'controls',
    id: 'say-controls',
    controls: [
      {
        kind: 'text',
        id: 'draft',
        label: 'Say something at the fire',
        value: draft,
        placeholder: fire.joined ? 'say something' : 'nobody else is here',
        maxLength: 280,
        disabled: !fire.joined,
      },
      { kind: 'button', id: 'say', label: 'Say', disabled: !fire.joined },
    ],
  });

  /* --- Gestures ---------------------------------------------------------- */
  blocks.push({ kind: 'heading', id: 'gesture-label', level: 2, text: 'Without saying anything' });
  blocks.push({
    kind: 'controls',
    id: 'gesture-controls',
    controls: GESTURES.map((gesture): PanelControl => {
      presses[`gesture-${gesture.id}`] = () => fire.gesture(gesture.id);
      return { kind: 'button', id: `gesture-${gesture.id}`, label: gesture.label, disabled: !fire.joined };
    }),
  });

  /* --- Leaving ----------------------------------------------------------- */
  blocks.push({ kind: 'heading', id: 'leave-label', level: 2, text: 'Leaving' });
  blocks.push({
    kind: 'body',
    id: 'leave-note',
    tone: 'soft',
    text: 'Walking off keeps you on the trail for a few seconds, so the others see you go.',
  });
  presses['walk-off'] = () => fire.depart('walk_off');
  presses['leave-now'] = () => fire.depart('immediate');
  blocks.push({
    kind: 'controls',
    id: 'leave-controls',
    controls: [
      { kind: 'button', id: 'walk-off', label: 'Walk off down the trail', disabled: !fire.joined },
      { kind: 'button', id: 'leave-now', label: 'Leave now', disabled: !fire.joined },
    ],
  });

  return { blocks, sliders, knobs, presses };
}

function statusLine(fire: Campfire): string {
  switch (fire.status) {
    case 'joined':
      // A round trip, because a slow one is worth knowing about. Not a tick
      // count: this is a campsite, and nobody wants a telemetry readout.
      return fire.catchingUp ? 'catching up with the fire…' : `at the fire · ${Math.round(fire.latencyMs)} ms`;
    case 'joining':
      return 'walking in…';
    case 'connecting':
      return 'finding the trail…';
    case 'reconnecting':
      return `the trail went quiet — ${fire.statusDetail ?? 'trying again'}`;
    case 'alone':
      return fire.statusDetail ?? 'your own fire';
    default:
      return 'your own fire';
  }
}

function describePerson(
  phase: string,
  activity: string,
  micMuted: boolean,
  holdingStick: boolean,
): string {
  if (phase === 'approaching') return 'coming down the trail';
  if (phase === 'leaving') return 'heading off';
  if (phase === 'gone') return 'gone';
  const doing =
    activity === 'roasting'
      ? 'roasting'
      : activity === 'assembling'
        ? 'building a s’more'
        : activity === 'machine'
          ? 'at the SM-01'
          : activity === 'eating'
            ? 'eating'
            : 'by the fire';
  return `${doing}${holdingStick ? ' · holding the stick' : ''}${micMuted ? '' : ' · mic open'}`;
}
