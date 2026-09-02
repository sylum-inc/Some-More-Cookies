/**
 * Tuning the camp radio.
 *
 * This is not a settings panel with a frequency slider. It is the set's own
 * face, brought close enough to read: the printed scale, the lamp behind it,
 * the needle, and the hiss between stations. You drag it, or you hold the
 * arrow keys, and what you hear changes because the receiver's selectivity
 * curve says so — there is no station list to pick from, because a radio does
 * not have one.
 *
 * What it shows: the frequency, what is coming through, and how cleanly.
 * What it never shows: how many stations exist, which ones you have found, or
 * anything that would turn a dial into a checklist (spec §8).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  describeReception,
  setRadioBand,
  setRadioDial,
  setRadioVolume,
  toggleRadio,
  turnRadioDial,
  type RadioBand,
  type RitualState,
} from '@somemore/sim';
import { FONT_STACK, TOKENS } from './styles.js';
import { useDialog } from './useDialog.js';

/** Dial units travelled per pixel of drag, before the fine-tune gearing. */
const DRAG_GEARING = 0.0022;

export interface RadioDialProps {
  ritual: RitualState;
  textScale: number;
  onChange: () => void;
  onClose: () => void;
}

export function RadioDial({ ritual, textScale, onChange, onClose }: RadioDialProps): React.ReactElement {
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();
  const radio = ritual.radio;
  const plan = radio.bands[radio.band];
  const span = Math.max(1e-6, plan.max - plan.min);
  const position = clampUnit((radio.dial + radio.drift - plan.min) / span);
  const px = (n: number) => `${n * textScale}px`;

  const dragging = useRef(false);
  const lastX = useRef(0);

  const bands = availableBandsOf(radio.profile.stations.map((s) => s.band));

  const nudge = useCallback(
    (amount: number) => {
      turnRadioDial(ritual, amount * span);
      onChange();
    },
    [ritual, span, onChange],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      // Shift is the fine-tune: the same gesture a real set gives you by
      // turning the knob slowly.
      const step = event.shiftKey ? 0.0015 : 0.008;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        nudge(-step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        nudge(step);
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggleRadio(ritual);
        onChange();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ritual, nudge, onChange, onClose]);

  const reception = radio.reception;
  const hissOpacity = radio.on ? 0.12 + reception.hiss * 0.5 : 0;

  return (
    <div
      role="dialog"
      aria-label="Camp radio"
      {...dialog.props}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        background: 'rgba(6,8,12,0.55)',
        padding: px(18),
        zIndex: 40,
      }}
    >
      <div
        style={{
          width: 'min(560px, 96vw)',
          background: 'linear-gradient(#20222a, #14161c)',
          border: `${px(2)} solid #3a3d47`,
          borderRadius: px(10),
          padding: px(16),
          boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
          fontFamily: FONT_STACK.mono,
          color: TOKENS.paper,
        }}
      >
        {/* The lit scale */}
        <div
          onPointerDown={(event) => {
            dragging.current = true;
            lastX.current = event.clientX;
            (event.target as Element).setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return;
            const dx = event.clientX - lastX.current;
            lastX.current = event.clientX;
            turnRadioDial(ritual, -dx * DRAG_GEARING * span);
            onChange();
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          style={{
            position: 'relative',
            height: px(96),
            borderRadius: px(4),
            background: radio.on
              ? 'linear-gradient(#f6e2ac, #e2c887)'
              : 'linear-gradient(#4a463c, #35322b)',
            border: `${px(2)} inset #0c0d11`,
            overflow: 'hidden',
            cursor: 'ew-resize',
            touchAction: 'none',
            transition: 'background 220ms',
          }}
        >
          {/* Printed ticks */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-start' }}>
            {Array.from({ length: 23 }, (_, i) => {
              const major = i % 5 === 0;
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${(i / 22) * 100}%`,
                    top: px(major ? 26 : 30),
                    width: px(1),
                    height: px(major ? 16 : 9),
                    background: radio.on ? '#3a2a16' : '#6b6659',
                  }}
                />
              );
            })}
          </div>

          {/* Printed frequencies */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <div
              key={t}
              style={{
                position: 'absolute',
                left: `${t * 100}%`,
                top: px(8),
                // The end labels are pulled inboard so the scale's own
                // extremes are readable rather than half off the glass.
                transform: `translateX(${t === 0 ? '2px' : t === 1 ? '-100%' : '-50%'})`,
                fontSize: px(11),
                color: radio.on ? '#3a2a16' : '#6b6659',
              }}
            >
              {(plan.min + span * t).toFixed(radio.band === 'fm' ? 1 : 0)}
            </div>
          ))}

          {/* Station names, printed only where a set would have marked them.
              Long names are shortened to the leading token — a dial face has
              room for KHOL, not for "KHOL 88.7 Community Radio" — and the
              printer alternates rows so two nearby stations do not overprint
              each other into an unreadable smear. */}
          {printedStations(radio, plan.min, span).map((printed) => (
            <div
              key={printed.id}
              style={{
                position: 'absolute',
                left: `${printed.position * 100}%`,
                bottom: px(printed.row === 0 ? 4 : 15),
                transform: `translateX(${printed.position > 0.9 ? '-100%' : printed.position < 0.1 ? '0%' : '-50%'})`,
                fontSize: px(9),
                letterSpacing: '0.08em',
                color: radio.on ? '#7a2318' : '#5d5850',
                whiteSpace: 'nowrap',
              }}
            >
              {printed.label}
            </div>
          ))}

          {/* Hiss, drawn as the noise it is */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              opacity: hissOpacity,
              backgroundImage:
                'repeating-linear-gradient(90deg, rgba(0,0,0,0.5) 0 1px, transparent 1px 2px), repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0 1px, transparent 1px 3px)',
              pointerEvents: 'none',
            }}
          />

          {/* The needle */}
          <div
            style={{
              position: 'absolute',
              left: `${position * 100}%`,
              top: 0,
              bottom: 0,
              width: px(2),
              marginLeft: px(-1),
              background: '#ff5a3c',
              boxShadow: radio.on ? '0 0 6px rgba(255,90,60,0.8)' : 'none',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Readout */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: px(12), marginTop: px(12) }}>
          <div style={{ fontSize: px(22), letterSpacing: '0.04em' }}>
            {(radio.dial + radio.drift).toFixed(radio.band === 'fm' ? 1 : 0)}
            <span style={{ fontSize: px(11), marginLeft: px(4), color: TOKENS.inkSoft }}>
              {radio.band === 'fm' ? 'MHz' : 'kHz'}
            </span>
          </div>
          <div style={{ fontSize: px(13), color: radio.on ? TOKENS.amber : TOKENS.inkSoft }}>
            {radio.on ? describeReception(radio) : 'off'}
          </div>
        </div>

        {/* Controls: power, band, volume, fine tune. Nothing else. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: px(8), marginTop: px(14) }}>
          <button
            className="sm-focus"
            onClick={() => {
              toggleRadio(ritual);
              onChange();
            }}
            style={buttonStyle(px, radio.on)}
          >
            {radio.on ? 'ON' : 'OFF'}
          </button>

          {bands.map((band) => (
            <button
              key={band}
              className="sm-focus"
              onClick={() => {
                setRadioBand(ritual, band);
                onChange();
              }}
              style={buttonStyle(px, radio.band === band)}
              aria-pressed={radio.band === band}
            >
              {band.toUpperCase()}
            </button>
          ))}

          <button className="sm-focus" onClick={() => nudge(-0.0015)} style={buttonStyle(px, false)}>
            ◀ fine
          </button>
          <button className="sm-focus" onClick={() => nudge(0.0015)} style={buttonStyle(px, false)}>
            fine ▶
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: px(6), fontSize: px(12) }}>
            vol
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={radio.volume}
              aria-label="Radio volume"
              onChange={(event) => {
                setRadioVolume(ritual, Number(event.target.value));
                onChange();
              }}
            />
          </label>

          <button
            className="sm-focus"
            onClick={onClose}
            style={{ ...buttonStyle(px, false), marginLeft: 'auto' }}
          >
            put it down
          </button>
        </div>

        <div style={{ marginTop: px(10), fontSize: px(11), color: TOKENS.inkSoft }}>
          drag the scale · arrow keys to tune · hold shift for fine tuning
        </div>
      </div>
    </div>
  );
}

/**
 * Jumps the dial to a frequency. Used only by tests and the keyboard path —
 * there is deliberately no seek button in the interface.
 */
export function tuneExactly(ritual: RitualState, dial: number, onChange: () => void): void {
  setRadioDial(ritual, dial);
  onChange();
}

function buttonStyle(px: (n: number) => string, active: boolean): React.CSSProperties {
  return {
    background: active ? TOKENS.amber : '#2a2d36',
    color: active ? '#1a1206' : TOKENS.paper,
    border: `${px(1)} solid #454955`,
    borderRadius: px(4),
    padding: `${px(6)} ${px(11)}`,
    fontFamily: FONT_STACK.mono,
    fontSize: px(12),
    letterSpacing: '0.05em',
    cursor: 'pointer',
  };
}

export interface PrintedStation {
  id: string;
  label: string;
  /** 0..1 along the scale. */
  position: number;
  /** Which of the two printed rows this one sits on. */
  row: 0 | 1;
}

/** How much of the scale a printed name occupies, roughly. */
const LABEL_WIDTH = 0.13;

/**
 * Decides what a dial face actually has printed on it.
 *
 * Exported so the smear this fixes stays fixed: three Pine Hollow stations
 * printed their full names centred on the same few millimetres of glass and
 * came out as `NIGHDKEERVIDEF REPEATER`.
 */
export function printedStations(
  radio: RitualState['radio'],
  min: number,
  span: number,
): PrintedStation[] {
  const candidates = radio.profile.stations
    .filter((station) => station.band === radio.band && station.reception >= 0.45)
    .map((station) => ({
      id: station.id,
      // The leading token, which is what a set is actually silk-screened with.
      label: (station.name.split(/[\s·—-]+/)[0] ?? station.name).slice(0, 9).toUpperCase(),
      position: clampUnit((station.dial - min) / span),
    }))
    .sort((a, b) => a.position - b.position);

  const printed: PrintedStation[] = [];
  const lastOnRow: [number, number] = [-1, -1];
  for (const candidate of candidates) {
    if (candidate.label === '') continue;
    // Row 0 unless something is already printed too close to it.
    const row: 0 | 1 = candidate.position - lastOnRow[0] >= LABEL_WIDTH ? 0 : 1;
    // Both rows crowded: this station simply was not printed, which is what a
    // real dial face does too.
    if (row === 1 && candidate.position - lastOnRow[1] < LABEL_WIDTH) continue;
    lastOnRow[row] = candidate.position;
    printed.push({ ...candidate, row });
  }
  return printed;
}

function availableBandsOf(bands: readonly RadioBand[]): RadioBand[] {
  const order: RadioBand[] = ['fm', 'am', 'shortwave'];
  return order.filter((band) => bands.includes(band));
}

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
