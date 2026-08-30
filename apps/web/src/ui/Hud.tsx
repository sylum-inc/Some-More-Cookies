/**
 * The heads-up layer.
 *
 * Deliberately sparse. There are no quest markers, no XP, no objectives list
 * (spec §5.3). What is here: a quiet line of guidance when a player would
 * otherwise be stuck, a non-numeric heat reading during roasting, subtitles,
 * and the two corner affordances (Passport, settings).
 */

import type { RitualStage, RitualState } from '@somemore/sim';
import { describeSeat, heatBand, isEmberBed, sampleHeat } from '@somemore/sim';
import { TOKENS, FONT_STACK } from './styles.js';

export interface HudProps {
  ritual: RitualState;
  /** What is within arm's reach right now, if anything. */
  reach: { id: string } | null;
  /** How the stone is being held, while there is one. */
  grip?: ThrowGrip;
  /** Whether the player is sitting down, so the log can offer the opposite. */
  seated?: boolean;
  onUse: () => void;
  exploring: boolean;
  stage: RitualStage;
  subtitle: string | null;
  /** Pointer or keyboard, so the guidance line names the right controls. */
  controls: 'pointer' | 'keyboard';
  /** A report that must reach the player whether or not subtitles are on. */
  notice: string | null;
  textScale: number;
  highContrast: boolean;
  subtitlesEnabled: boolean;
  onOpenPassport: () => void;
  onOpenSettings: () => void;
  onFinishRoasting: () => void;
  onTakeSandwich: () => void;
  onPhoto: () => void;
  onOpenTerminal: () => void;
}

/** A quiet, diegetic line. Never an objective, never a checklist. */
/** What a reachable thing offers, in plain words. */
const REACH_LABELS: Record<string, string> = {
  fire: 'Poke the coals',
  woodpile: 'Take a log',
  marshmallows: 'Take a marshmallow',
  machine: 'The SM-01',
  plate: 'The plate',
  'log-seat': 'Sit down',
  radio: 'The radio',
  torch: 'Take the torch',
  stones: 'Pick up a stone',
  'water-edge': 'The water',
  rod: 'Take the rod',
};

/**
 * What a reachable thing offers *right now*.
 *
 * Contextual, because the world offers rather than menus: the log says "stand
 * up" once you are on it, the torch says "switch it off" once it is in your
 * hand, and the water says "throw it" once there is a stone in the other one.
 */
export function reachLabel(id: string, ritual?: RitualState, seated = false): string {
  if (ritual) {
    if (id === 'log-seat') return seated ? 'Stand up' : 'Sit down';
    if (id === 'torch') return ritual.torch.held ? (ritual.torch.on ? 'Switch it off' : 'Switch it on') : 'Take the torch';
    if (id === 'water-edge') return ritual.skipping.held ? 'Throw it' : 'Pick up a stone';
    if (id === 'stones') return ritual.skipping.held ? 'Try another' : 'Pick up a stone';
    if (id === 'rod') {
      switch (ritual.fishing.phase) {
        case 'stowed':
          return 'Take the rod';
        case 'nibble':
          return 'Strike';
        case 'landed':
          return 'Put it back';
        case 'ready':
        case 'soaking':
          return 'Cast';
        default:
          return 'The rod';
      }
    }
  }
  return REACH_LABELS[id] ?? 'Use';
}

/**
 * How the stone is sitting in your hand, in words.
 *
 * Never a number and never a rating: these are descriptions of a grip, and a
 * grip that produces one skip is described exactly as plainly as one that
 * produces nine (spec §5.2, §5.3).
 */
export function describeGrip(power: number, tilt: number, spin: number): string {
  const wind = power < 0.3 ? 'loose' : power < 0.65 ? 'wound back' : 'wound right back';
  const face = tilt < 0.18 ? 'edge-on' : tilt < 0.45 ? 'face just open' : tilt < 0.72 ? 'face well open' : 'face flat to the sky';
  const wrist = spin < 0.2 ? 'no wrist in it' : spin < 0.6 ? 'some wrist' : 'a hard flick';
  return `${wind}, ${face}, ${wrist}`;
}

/**
 * The one line of guidance, in the language of whatever the player is using.
 *
 * Only the stages whose wording is genuinely about *how* change. The rest —
 * "Take it out", "Bite from whichever side you like" — say what to do rather
 * than how to do it and read the same either way, and every action they refer
 * to is a real focusable button rather than something in the canvas.
 *
 * Telling a keyboard player to "drag sideways" is not a small infelicity: the
 * non-gestural path is the whole of spec §12, and a path nobody is told about
 * is a path nobody takes.
 */
/**
 * The SM-01's line, which follows the machine rather than the stage.
 *
 * It used to be one sentence — "Load it, shut the door, and set the machine
 * running" — held for the whole twelve-step sequence, so the machine was still
 * asking to be loaded while it was three quarters of the way through freezing
 * something. That was found by printing what every stage actually said, which
 * no pixel comparison could see.
 *
 * The running stages say there is nothing to do, because there is not. A
 * machine that keeps issuing instructions while it works reads as a machine
 * that is waiting for you, and this one is the opposite: it is the part of the
 * ritual where you stand back and listen to it.
 */
function machineLine(machine: RitualState['machine'], keys: boolean): string {
  switch (machine.stage) {
    case 'idle':
      return keys ? 'L puts it in.' : 'Put it in.';
    case 'loaded':
    case 'door-closing':
      return keys ? 'D shuts the door.' : 'Shut the door.';
    case 'door-closed':
      return keys ? 'X throws the latch.' : 'Throw the latch.';
    case 'latched':
      if (!machine.confirmed) {
        return keys ? '1, 2 or 3 picks a program. Enter confirms it.' : 'Pick a program, then confirm it.';
      }
      return keys ? 'P pulls the lever.' : 'Pull the lever.';
    case 'armed':
      return keys ? 'P pulls the lever.' : 'Pull the lever.';
    case 'processing':
    case 'transforming':
    case 'freezing':
      return 'Nothing to do now but listen to it.';
    case 'complete':
      return keys ? 'X releases the latch.' : 'Release the latch.';
    case 'unlatched':
    case 'opening':
      return keys ? 'D opens the door.' : 'Open the door.';
    case 'revealed':
      return 'Take it out.';
    case 'fault':
      return 'Something has jammed. Release the latch and look inside.';
    default:
      return keys ? 'L puts it in.' : 'Put it in.';
  }
}

function guidanceFor(
  ritual: RitualState,
  stage: RitualStage,
  controls: 'pointer' | 'keyboard' = 'pointer',
): string {
  const keys = controls === 'keyboard';
  switch (stage) {
    case 'arriving':
      return 'Walk toward the fire.';
    case 'at-fire':
      if (isEmberBed(ritual.fire)) return 'The fire has burned down to coals.';
      return keys
        ? 'Look around. WASD walks, the arrow keys look.'
        : 'Look around. Tap to walk, drag to look.';
    case 'roasting':
      if (ritual.marshmallow.burning) {
        return keys
          ? 'It has caught. Press B to blow it out, or let it burn.'
          : 'It has caught. Shake it out, or let it burn.';
      }
      return keys
        ? 'Arrows move it in and out, and turn it.'
        : 'Drag to move it in and out. Drag sideways to turn it.';
    case 'assembling': {
      const next = ritual.assembly.heldKind;
      if (next) {
        return keys
          ? 'Arrows shift it, [ and ] turn it. Enter sets it down.'
          : 'Set it down where you want it.';
      }
      return keys ? 'Enter picks up the next piece.' : 'Pick up the next piece.';
    }
    case 'machine':
      return machineLine(ritual.machine, keys);
    case 'reveal':
      return 'Take it out.';
    case 'eating':
      return 'Bite from whichever side you like.';
    case 'after':
      return 'Sit a while, or make another.';
    default:
      return '';
  }
}

/**
 * A quiet line for whatever the player has picked up.
 *
 * Only ever shown while something is actually in hand, and it says what the
 * thing does rather than what to achieve with it. There is no objective here
 * and there is nothing to complete.
 */
function activityLine(ritual: RitualState, grip: ThrowGrip | undefined): string | null {
  if (ritual.skipping.phase === 'flying') return null;
  if (ritual.skipping.held && grip) return describeGrip(grip.power, grip.tilt, grip.spin);
  if (ritual.fishing.phase === 'nibble') return 'The float goes under.';
  if (ritual.fishing.phase === 'playing') return 'Something is on.';
  if (ritual.fishing.phase === 'soaking') return 'The line is out.';
  if (ritual.stargazing.binoculars) return 'Hold something in view and it will resolve.';
  if (ritual.stargazing.posture === 'reclined') return 'The sky, for tonight.';
  // Sitting is the quietest thing here and it still gets a line, because §12
  // says nothing may be delivered through one channel — and what sitting does
  // is otherwise entirely invisible.
  const seated = describeSeat(ritual.seat);
  if (seated) return seated.replace(/^\[|\]$/g, '');
  return null;
}

/** The three numbers the throwing gesture writes. Read-only here. */
export interface ThrowGrip {
  power: number;
  tilt: number;
  spin: number;
}

export function Hud(props: HudProps): React.ReactElement {
  const { ritual, stage, textScale, highContrast } = props;
  const scale = (n: number) => `${n * textScale}px`;

  // Non-numeric heat reading — heat must be legible without relying on colour
  // alone (spec §12).
  let heatLabel = '';
  let heatFill = 0;
  if (stage === 'roasting') {
    const sample = sampleHeat(ritual.fire, ritual.marshmallow.position);
    const total = sample.radiant + sample.convective;
    const band = heatBand(total);
    heatLabel = {
      cold: 'cold',
      warm: 'warm',
      toasting: 'toasting',
      browning: 'browning',
      scorching: 'scorching',
      burning: 'burning',
    }[band];
    heatFill = Math.min(1, total / 34);
  }

  const panelBg = highContrast ? 'rgba(0,0,0,0.85)' : 'rgba(8,10,14,0.55)';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 20,
        fontFamily: FONT_STACK.sans,
      }}
    >
      {/* Corner affordances */}
      <div
        style={{
          position: 'absolute',
          top: 'env(safe-area-inset-top, 0px)',
          right: 'env(safe-area-inset-right, 0px)',
          padding: 12,
          display: 'flex',
          gap: 8,
          pointerEvents: 'auto',
        }}
      >
        <CornerButton label="Passport" onClick={props.onOpenPassport} textScale={textScale} highContrast={highContrast} />
        <CornerButton label="Settings" onClick={props.onOpenSettings} textScale={textScale} highContrast={highContrast} />
      </div>

      {/* Photo, available once there is something worth photographing */}
      {(stage === 'reveal' || stage === 'eating' || stage === 'after' || stage === 'at-fire') && (
        <div
          style={{
            position: 'absolute',
            bottom: 'env(safe-area-inset-bottom, 0px)',
            right: 'env(safe-area-inset-right, 0px)',
            padding: 12,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            pointerEvents: 'auto',
          }}
        >
          {(stage === 'eating' || stage === 'after') && ritual.sandwich && (
            <CornerButton label="Make this real" onClick={props.onOpenTerminal} textScale={textScale} highContrast={highContrast} accent />
          )}
          <CornerButton label="Photo" onClick={props.onPhoto} textScale={textScale} highContrast={highContrast} />
        </div>
      )}

      {/* What is within reach. The world offers rather than presenting a menu
          (spec: contextual direct manipulation), so this appears only when
          the player has actually walked up to something. */}
      {props.exploring && props.reach && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '18%',
            transform: 'translateX(-50%)',
            pointerEvents: 'auto',
          }}
        >
          <button
            className="sm-focus"
            onClick={props.onUse}
            style={{
              background: 'rgba(8,10,14,0.66)',
              color: 'rgba(240,232,214,0.95)',
              border: `1px solid ${TOKENS.amber}`,
              padding: `${9 * textScale}px ${16 * textScale}px`,
              fontSize: scale(13),
              letterSpacing: '0.08em',
              borderRadius: 2,
            }}
          >
            {reachLabel(props.reach.id, ritual, props.seated ?? false)}
          </button>
        </div>
      )}

      {/* Roasting heat readout */}
      {stage === 'roasting' && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '13%',
            transform: 'translateX(-50%)',
            background: panelBg,
            padding: `${scale(8)} ${scale(14)}`,
            borderRadius: 2,
            textAlign: 'center',
            minWidth: 190,
          }}
        >
          <div style={{ fontSize: scale(11), letterSpacing: '0.16em', textTransform: 'uppercase', opacity: 0.75 }}>
            {heatLabel}
          </div>
          <div style={{ height: 4, background: 'rgba(255,255,255,0.16)', marginTop: 6, borderRadius: 2, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${heatFill * 100}%`,
                background: `linear-gradient(90deg, ${TOKENS.amber}, ${TOKENS.ember})`,
                transition: 'width 120ms linear',
              }}
            />
          </div>
          {ritual.marshmallow.burning && (
            <div style={{ fontSize: scale(11), marginTop: 6, color: TOKENS.ember, fontWeight: 600 }}>on fire</div>
          )}
        </div>
      )}

      {/* Taking the marshmallow to the plate — a physical act, not a button
          that skips the stage.

          The insets matter here more than anywhere else in the HUD: without
          them this sits fourteen pixels above the home indicator in portrait
          and under the notch in landscape. The other two corners already read
          them; this one did not. */}
      {stage === 'roasting' && (
        <div
          style={{
            position: 'absolute',
            left: 'env(safe-area-inset-left, 0px)',
            bottom: 'env(safe-area-inset-bottom, 0px)',
            padding: 14,
            pointerEvents: 'auto',
          }}
        >
          <CornerButton
            label={ritual.marshmallow.fallen ? 'Take another' : 'Take it to the plate'}
            onClick={props.onFinishRoasting}
            textScale={textScale}
            highContrast={highContrast}
          />
        </div>
      )}

      {stage === 'reveal' && ritual.sandwich && (
        <div style={{ position: 'absolute', left: '50%', bottom: '12%', transform: 'translateX(-50%)', pointerEvents: 'auto' }}>
          <CornerButton label="Take it" onClick={props.onTakeSandwich} textScale={textScale} highContrast={highContrast} accent />
        </div>
      )}

      {/* Guidance. Placed clear of the corner controls so it never collides
          with them on a narrow viewport. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: `calc(${scale(46)} + env(safe-area-inset-top, 0px))`,
          display: 'flex',
          justifyContent: 'center',
          padding: `0 ${scale(16)}`,
        }}
      >
        <span
          role="status"
          aria-live="polite"
          data-testid="guidance"
          style={{
            fontSize: scale(13),
            letterSpacing: '0.04em',
            color: highContrast ? '#fff' : 'rgba(240,233,216,0.94)',
            textShadow: '0 1px 3px rgba(0,0,0,0.9)',
            /*
              A scrim, because a shadow is not enough here.
            
              This line has to sit on whatever the world puts behind it, and at
              thirteen pixels a drop shadow only works when the background is
              dark. Over the SM-01's chamber — a pale grey wall filling the
              frame — "Take it out." was very nearly invisible in the reveal
              baseline, which is the one moment the whole ritual builds to. A
              heavier halo was worse, not better: five black offsets around a
              small glyph fill in its counters and the line reads as dark mush.
            
              So the same treatment the subtitle already uses, at about half
              its weight: enough to separate the text from anything, quiet
              enough that it is still a line in the world rather than a panel.
            */
            background: 'rgba(10,9,8,0.42)',
            padding: `${scale(3)} ${scale(9)}`,
            borderRadius: 3,
            textAlign: 'center',
            // `min`, not a bare `46ch`: at the largest text scale on the
            // narrowest phone 46ch is wider than the screen, and the line was
            // one word from running off the side of it.
            maxWidth: 'min(46ch, 100%)',
            overflowWrap: 'break-word',
          }}
        >
          {guidanceFor(ritual, stage, props.controls)}
        </span>
      </div>

      {/* What is in hand, and what it is doing. Placed where the roasting
          heat readout goes, because it is the same kind of thing: a
          non-numeric reading of a physical state, in both channels (§12). */}
      {props.exploring && activityLine(ritual, props.grip) && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '13%',
            transform: 'translateX(-50%)',
            background: panelBg,
            padding: `${scale(7)} ${scale(14)}`,
            borderRadius: 2,
            textAlign: 'center',
            maxWidth: '70vw',
          }}
        >
          <div style={{ fontSize: scale(11), letterSpacing: '0.1em', opacity: 0.82 }}>
            {activityLine(ritual, props.grip)}
          </div>
          {ritual.skipping.held && props.grip && (
            <div
              style={{
                height: 4,
                background: 'rgba(255,255,255,0.16)',
                marginTop: 6,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${props.grip.power * 100}%`,
                  background: `linear-gradient(90deg, ${TOKENS.amber}, ${TOKENS.ember})`,
                }}
              />
            </div>
          )}
          {ritual.fishing.phase === 'nibble' && (
            <div style={{ fontSize: scale(11), marginTop: 5, color: TOKENS.ember, fontWeight: 600 }}>now</div>
          )}
        </div>
      )}

      {/* Binoculars. A real optical frame rather than a zoom slider: the field
          narrows and everything outside it is simply not in the eyepieces. */}
      {ritual.stargazing.binoculars && (
        <div
          aria-hidden
          data-testid="binoculars"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            // One wide field rather than two circles: modern binoculars merge
            // into a single oval, and two stacked CSS gradients would simply
            // paint one eyepiece over the other.
            background:
              'radial-gradient(ellipse 41% 52% at 50% 50%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.99) 82%)',
          }}
        />
      )}

      {/*
        Subtitles.

        `role="status"` with `aria-live="polite"` because a subtitle *is* the
        text channel for something audible (spec §12): without it a screen
        reader never says the line, and the one accessibility feature whose
        whole job is to carry sound to somebody who cannot hear it reaches
        nobody who is not looking at that corner of the screen. `aria-atomic`
        so a changed line is read whole rather than as a diff.
      */}
      {props.subtitlesEnabled && props.subtitle && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="subtitle"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '5%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.72)',
            color: '#fff',
            padding: `${scale(6)} ${scale(12)}`,
            fontSize: scale(13),
            borderRadius: 2,
            maxWidth: '84vw',
            textAlign: 'center',
          }}
        >
          {props.subtitle}
        </div>
      )}

      {/*
        Reports that are not transcripts.

        Subtitles carry the text of something audible and sit behind a setting;
        this does not. "This campsite cannot sign you in yet" is not a
        transcript of a sound, and it used to go out as a subtitle, which meant
        it disappeared without trace for anybody who had subtitles switched off
        — the §12 rule about single channels, applied to the product's own
        error reporting.
      */}
      {props.notice !== null && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="notice"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '19%',
            transform: 'translateX(-50%)',
            background: 'rgba(28,18,10,0.88)',
            border: `1px solid ${TOKENS.amber}`,
            color: '#f3e9d8',
            padding: `${scale(7)} ${scale(14)}`,
            fontSize: scale(12),
            borderRadius: 3,
            maxWidth: '76vw',
            textAlign: 'center',
          }}
        >
          {props.notice}
        </div>
      )}

      {/*
        The SM-01, in words (spec §12, audit A5).

        §3.2 makes the machine's colour semantic — amber is working, blue is
        transforming, pulsing amber is a fault — and `indicatorColor()` was the
        only place that lived. `displayText()` exists, but it is drawn as a
        texture *inside the canvas*, so it is not a second channel for anybody
        who cannot see the first one.

        Visually hidden rather than shown, because the panel itself is the
        display for everyone who can see it, and a caption repeating what the
        machine already says would be noise on screen. It names the colour as
        well as the state, so the two channels describe the same machine rather
        than two different ones.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="machine-state"
        style={SR_ONLY}
      >
        {machineInWords(ritual.machine)}
      </div>
    </div>
  );
}

/**
 * Off screen, but read aloud.
 *
 * The `clip`/`clip-path` pair rather than `display: none` or `visibility:
 * hidden`, either of which takes the element out of the accessibility tree as
 * well as out of the picture, which is the opposite of what this is for.
 */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** What the SM-01's panel and its indicator say, as a sentence. */
function machineInWords(machine: RitualState['machine']): string {
  switch (machine.stage) {
    case 'idle':
      return machine.door > 0.5 ? 'The machine is open and empty.' : 'The machine is ready.';
    case 'loaded':
      return 'It is in. The door is still open.';
    case 'door-closing':
      return 'The door is closing.';
    case 'door-closed':
      return 'The door is shut and not yet latched.';
    case 'latched':
      return machine.confirmed
        ? 'Latched, program confirmed. The lever is up.'
        : 'Latched. No program chosen yet.';
    case 'armed':
      return 'Armed. The lever is up.';
    case 'processing':
      return 'Running. The chamber light is amber.';
    case 'transforming':
      return 'Transforming.';
    case 'freezing':
      return 'Freezing. The chamber light has turned blue.';
    case 'complete':
      return 'Finished. The light is steady.';
    case 'unlatched':
      return 'Unlatched. The door can be opened.';
    case 'opening':
      return 'The door is opening.';
    case 'revealed':
      return 'The door is open. There is a sandwich on the tray.';
    case 'fault':
      return 'Fault. The light is pulsing amber.';
    default:
      return '';
  }
}

function CornerButton({
  label,
  onClick,
  textScale,
  highContrast,
  accent,
}: {
  label: string;
  onClick: () => void;
  textScale: number;
  highContrast: boolean;
  accent?: boolean;
}): React.ReactElement {
  return (
    <button
      className="sm-focus"
      onClick={onClick}
      style={{
        background: accent ? TOKENS.amber : highContrast ? '#000' : 'rgba(8,10,14,0.6)',
        color: accent ? '#1a1508' : highContrast ? '#fff' : 'rgba(232,224,205,0.92)',
        border: highContrast ? '2px solid #fff' : '1px solid rgba(232,224,205,0.24)',
        padding: `${7 * textScale}px ${13 * textScale}px`,
        fontSize: `${12 * textScale}px`,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderRadius: 2,
        fontWeight: accent ? 700 : 500,
      }}
    >
      {label}
    </button>
  );
}
