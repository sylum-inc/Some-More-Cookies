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
 */

import { useEffect, useRef, useState } from 'react';
import type { Gesture } from '@somemore/protocol';
import type { Campfire } from '../net/campfire.js';
import { MARSHMALLOW_OBJECT_ID } from '../net/authority.js';
import { FONT_STACK, TOKENS } from './styles.js';
import { useDialog } from './useDialog.js';

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

export interface CampfirePanelProps {
  fire: Campfire;
  textScale: number;
  highContrast: boolean;
  onClose: () => void;
}

export function CampfirePanel({ fire, textScale, highContrast, onClose }: CampfirePanelProps): React.ReactElement {
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const people = fire.roster.everyone;
  const holder = fire.authority.holderOf(MARSHMALLOW_OBJECT_ID);
  const notes = fire.notes;

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [fire.chat.length]);

  const font = (size: number): number => size * textScale;
  const ink = highContrast ? '#1a1712' : TOKENS.ink;
  const soft = highContrast ? '#3a352c' : TOKENS.inkSoft;

  return (
    <div
      className="sm-overlay"
      role="dialog"
      aria-label="At the fire"
      onPointerDown={(event) => event.stopPropagation()}
      {...dialog.props}
    >
      <div className="sm-panel" style={{ width: 'min(560px, 94vw)', padding: `${font(18)}px ${font(20)}px` }}>
        <button
          className="sm-focus"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            background: 'transparent',
            border: 'none',
            color: soft,
            fontSize: font(18),
          }}
        >
          ×
        </button>

        <h2 style={{ fontFamily: FONT_STACK.serif, fontSize: font(19), margin: 0, color: ink, letterSpacing: '0.06em' }}>
          At the fire
        </h2>
        <p style={{ fontFamily: FONT_STACK.mono, fontSize: font(10.5), color: soft, margin: `${font(4)}px 0 ${font(12)}px` }}>
          {statusLine(fire)}
        </p>

        {notes.length > 0 && (
          <div
            role="status"
            style={{
              border: `1px solid ${TOKENS.stamp}`,
              padding: font(8),
              marginBottom: font(12),
              fontFamily: FONT_STACK.hand,
              fontSize: font(12.5),
              color: TOKENS.stamp,
            }}
          >
            {notes.map((note) => (
              <div key={note}>{note}</div>
            ))}
          </div>
        )}

        {/* --- Who is here ------------------------------------------------ */}
        <Section label="Around the fire" font={font} ink={ink}>
          {people.length === 0 && (
            <p style={{ fontFamily: FONT_STACK.hand, fontSize: font(13), color: soft, margin: 0 }}>
              Just you, for the moment.
            </p>
          )}
          {people.map((person) => (
            <div
              key={person.accountId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: font(8),
                padding: `${font(5)}px 0`,
                borderBottom: `1px solid ${TOKENS.paperEdge}`,
                opacity: person.blocked ? 0.45 : 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: FONT_STACK.serif, fontSize: font(14), color: ink }}>{person.name}</div>
                <div style={{ fontFamily: FONT_STACK.mono, fontSize: font(10), color: soft }}>
                  {describePerson(person.phase, person.activity, person.micMuted, holder === person.accountId)}
                </div>
              </div>

              {/* Per-player volume. A slider, labelled, not a mystery icon. */}
              <input
                className="sm-focus"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={person.volume}
                aria-label={`Volume for ${person.name}`}
                title={fire.voice.status === 'ready' ? `How loud ${person.name} is, for you` : 'No voice here'}
                disabled={fire.voice.status !== 'ready'}
                onChange={(event) =>
                  fire.requestVoice('set_volume', { accountId: person.accountId, volume: Number(event.target.value) })
                }
                style={{ width: font(64) }}
              />

              <SmallButton
                font={font}
                label="Hand it over"
                title={`Hold the roasting stick out to ${person.name}`}
                disabled={holder !== fire.accountId || person.phase !== 'here'}
                onClick={() => fire.offer(MARSHMALLOW_OBJECT_ID, 'marshmallow', person.accountId)}
              />
              <SmallButton
                font={font}
                label={person.blocked ? 'Unblock' : 'Block'}
                title={
                  person.blocked
                    ? `Hear ${person.name} again`
                    : `Stop seeing and hearing ${person.name}. Nothing they do will reach your fire.`
                }
                onClick={() => fire.block(person.accountId, !person.blocked)}
              />
            </div>
          ))}
        </Section>

        {/* --- Voice ------------------------------------------------------ */}
        <Section label="Voice" font={font} ink={ink}>
          <p style={{ fontFamily: FONT_STACK.mono, fontSize: font(10.5), color: soft, margin: `0 0 ${font(6)}px` }}>
            {fire.voice.status === 'ready'
              ? `Spatial voice through ${fire.voice.provider ?? 'the room'}. Never recorded.`
              : `No voice here — ${fire.voice.reason ?? 'nothing is configured'}. Text and gesture carry the fire, and always can.`}
          </p>
          <div style={{ display: 'flex', gap: font(6), flexWrap: 'wrap' }}>
            {(['open_mic', 'push_to_talk', 'off'] as const).map((mode) => (
              <SmallButton
                key={mode}
                font={font}
                label={mode === 'open_mic' ? 'Open mic' : mode === 'push_to_talk' ? 'Push to talk' : 'Mic off'}
                pressed={fire.voice.mode === mode}
                disabled={fire.voice.status !== 'ready'}
                onClick={() => fire.requestVoice('set_mode', { mode })}
              />
            ))}
            <SmallButton
              font={font}
              label={fire.voice.muted ? 'Unmute' : 'Mute'}
              disabled={fire.voice.status !== 'ready'}
              onClick={() => fire.requestVoice('set_muted', { muted: !fire.voice.muted })}
            />
          </div>
        </Section>

        {/* --- Saying something ------------------------------------------- */}
        <Section label="Say something" font={font} ink={ink}>
          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label="What has been said at the fire"
            style={{
              maxHeight: font(120),
              overflowY: 'auto',
              border: `1px solid ${TOKENS.paperEdge}`,
              padding: font(7),
              marginBottom: font(7),
              fontFamily: FONT_STACK.hand,
              fontSize: font(13),
              color: ink,
              background: 'rgba(255,255,255,0.35)',
            }}
          >
            {fire.chat.length === 0 && <span style={{ color: soft }}>Nothing said yet.</span>}
            {fire.chat.map((line) => (
              <div key={`${line.at}-${line.from}-${line.text}`}>
                <span style={{ color: soft }}>{line.name}: </span>
                {line.text}
              </div>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (fire.say(draft)) setDraft('');
            }}
            style={{ display: 'flex', gap: font(6) }}
          >
            <input
              className="sm-focus"
              value={draft}
              maxLength={280}
              aria-label="Say something at the fire"
              placeholder={fire.joined ? 'say something' : 'nobody else is here'}
              disabled={!fire.joined}
              onChange={(event) => setDraft(event.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: FONT_STACK.mono,
                fontSize: font(12),
                padding: font(6),
                border: `1px solid ${TOKENS.paperEdge}`,
                background: 'rgba(255,255,255,0.5)',
                color: ink,
              }}
            />
            <SmallButton font={font} label="Say" disabled={!fire.joined} type="submit" />
          </form>
        </Section>

        {/* --- Gestures ---------------------------------------------------- */}
        <Section label="Without saying anything" font={font} ink={ink}>
          <div style={{ display: 'flex', gap: font(6), flexWrap: 'wrap' }}>
            {GESTURES.map((gesture) => (
              <SmallButton
                key={gesture.id}
                font={font}
                label={gesture.label}
                disabled={!fire.joined}
                onClick={() => fire.gesture(gesture.id)}
              />
            ))}
          </div>
        </Section>

        {/* --- Leaving ------------------------------------------------------ */}
        <Section label="Leaving" font={font} ink={ink}>
          <p style={{ fontFamily: FONT_STACK.mono, fontSize: font(10), color: soft, margin: `0 0 ${font(6)}px` }}>
            Walking off keeps you on the trail for a few seconds, so the others see you go.
          </p>
          <div style={{ display: 'flex', gap: font(6) }}>
            <SmallButton font={font} label="Walk off down the trail" disabled={!fire.joined} onClick={() => fire.depart('walk_off')} />
            <SmallButton font={font} label="Leave now" disabled={!fire.joined} onClick={() => fire.depart('immediate')} />
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  label,
  font,
  ink,
  children,
}: {
  label: string;
  font: (size: number) => number;
  ink: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: font(14) }}>
      <h3
        style={{
          fontFamily: FONT_STACK.mono,
          fontSize: font(9.5),
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: ink,
          opacity: 0.6,
          margin: `0 0 ${font(6)}px`,
        }}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

function SmallButton({
  font,
  label,
  title,
  onClick,
  disabled,
  pressed,
  type = 'button',
}: {
  font: (size: number) => number;
  label: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  type?: 'button' | 'submit';
}): React.ReactElement {
  return (
    <button
      className="sm-focus"
      type={type}
      title={title ?? label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled === true}
      onClick={onClick}
      style={{
        background: pressed === true ? TOKENS.ink : 'transparent',
        color: pressed === true ? TOKENS.paper : TOKENS.ink,
        border: `1px solid ${TOKENS.paperEdge}`,
        padding: `${font(5)}px ${font(9)}px`,
        fontFamily: FONT_STACK.mono,
        fontSize: font(10),
        letterSpacing: '0.08em',
        borderRadius: 2,
        opacity: disabled === true ? 0.4 : 1,
        cursor: disabled === true ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
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
