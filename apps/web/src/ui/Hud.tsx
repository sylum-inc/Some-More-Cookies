/**
 * The heads-up layer.
 *
 * Deliberately sparse. There are no quest markers, no XP, no objectives list
 * (spec §5.3). What is here: a quiet line of guidance when a player would
 * otherwise be stuck, a non-numeric heat reading during roasting, subtitles,
 * and the two corner affordances (Passport, settings).
 */

import type { RitualStage, RitualState } from '@somemore/sim';
import { heatBand, isEmberBed, sampleHeat } from '@somemore/sim';
import { TOKENS, FONT_STACK } from './styles.js';

export interface HudProps {
  ritual: RitualState;
  stage: RitualStage;
  subtitle: string | null;
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
function guidanceFor(ritual: RitualState, stage: RitualStage): string {
  switch (stage) {
    case 'arriving':
      return 'Walk toward the fire.';
    case 'at-fire':
      return isEmberBed(ritual.fire)
        ? 'The fire has burned down to coals. Take a marshmallow when you are ready.'
        : 'Feed the fire, or take a marshmallow from the bag.';
    case 'roasting':
      return ritual.marshmallow.burning
        ? 'It has caught. Shake it out, or let it burn.'
        : 'Drag to move it in and out. Drag sideways to turn it.';
    case 'assembling': {
      const next = ritual.assembly.heldKind;
      if (next) return 'Set it down where you want it.';
      return 'Pick up the next piece.';
    }
    case 'machine':
      return 'Load it, shut the door, and set the machine running.';
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
          that skips the stage */}
      {stage === 'roasting' && (
        <div style={{ position: 'absolute', left: 0, bottom: 0, padding: 14, pointerEvents: 'auto' }}>
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
          style={{
            fontSize: scale(13),
            letterSpacing: '0.04em',
            color: highContrast ? '#fff' : 'rgba(232,224,205,0.82)',
            textShadow: '0 1px 4px rgba(0,0,0,0.95)',
            textAlign: 'center',
            maxWidth: '46ch',
          }}
        >
          {guidanceFor(ritual, stage)}
        </span>
      </div>

      {/* Subtitles */}
      {props.subtitlesEnabled && props.subtitle && (
        <div
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
    </div>
  );
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
