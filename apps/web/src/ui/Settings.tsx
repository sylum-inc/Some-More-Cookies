/**
 * Settings.
 *
 * Accessibility is part of the architecture, not a bolted-on screen
 * (spec §12). The same knobs serve art direction and access: "reduce
 * dithering" is both.
 */

import { FONT_STACK, TOKENS } from './styles.js';
import type { AccessibilitySettings, AudioSettings } from '../state/store.js';
import type { RenderSettings } from '../render/ps1.js';
import { useDialog } from './useDialog.js';

export interface SettingsProps {
  render: RenderSettings;
  accessibility: AccessibilitySettings;
  audio: AudioSettings;
  onRender: (partial: Partial<RenderSettings>) => void;
  onAccessibility: (partial: Partial<AccessibilitySettings>) => void;
  onAudio: (partial: Partial<AudioSettings>) => void;
  onClose: () => void;
}

export function Settings({
  render,
  accessibility,
  audio,
  onRender,
  onAccessibility,
  onAudio,
  onClose,
}: SettingsProps): React.ReactElement {
  const scale = accessibility.textScale;
  const px = (n: number) => `${n * scale}px`;
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();

  return (
    <div
      className="sm-overlay"
      role="dialog"
      aria-label="Settings"
      onClick={onClose}
      {...dialog.props}
    >
      <div
        className="sm-panel"
        onClick={(event) => event.stopPropagation()}
        style={{ padding: px(26), width: 'min(680px, 94vw)' }}
      >
        <button
          className="sm-focus"
          onClick={onClose}
          aria-label="Close settings"
          style={{ position: 'absolute', top: px(10), right: px(12), background: 'transparent', border: 'none', fontSize: px(22), color: TOKENS.inkSoft }}
        >
          ×
        </button>

        <h1 style={{ fontFamily: FONT_STACK.serif, fontSize: px(24), margin: `0 0 ${px(18)}`, color: TOKENS.ink }}>
          Settings
        </h1>

        <Group title="Comfort" scale={scale}>
          <Toggle
            label="Reduced motion"
            hint="Damps camera movement and shake."
            checked={render.reducedMotion}
            onChange={(v) => onRender({ reducedMotion: v })}
            scale={scale}
          />
          <Slider
            label="Flicker"
            hint="How much the fire and lamps pulse."
            value={render.flicker}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onRender({ flicker: v })}
            scale={scale}
          />
          <Slider
            label="Fire brightness"
            hint="Tames the fire without removing it."
            value={render.fireBrightness}
            min={0.35}
            max={1.5}
            step={0.05}
            onChange={(v) => onRender({ fireBrightness: v })}
            scale={scale}
          />
          <Slider
            label="Text size"
            value={accessibility.textScale}
            min={0.85}
            max={1.8}
            step={0.05}
            onChange={(v) => onAccessibility({ textScale: v })}
            scale={scale}
          />
          <Toggle
            label="High contrast"
            checked={accessibility.highContrast}
            onChange={(v) => onAccessibility({ highContrast: v })}
            scale={scale}
          />
          <Toggle
            label="Subtitles"
            hint="Describes sounds that carry information."
            checked={accessibility.subtitles}
            onChange={(v) => onAccessibility({ subtitles: v })}
            scale={scale}
          />
        </Group>

        <Group title="Picture" scale={scale}>
          <Slider
            label="Dithering"
            hint="The ordered pattern in the shading."
            value={render.dither}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onRender({ dither: v })}
            scale={scale}
          />
          <Slider
            label="Vertex wobble"
            hint="The period-accurate shake in the geometry."
            value={render.jitter}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onRender({ jitter: v })}
            scale={scale}
          />
          <Slider
            label="Texture swim"
            hint="Affine texture instability."
            value={render.affine}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onRender({ affine: v })}
            scale={scale}
          />
          <Slider
            label="Colour depth"
            hint="Bits per channel. Higher is smoother."
            value={render.colorDepth}
            min={3}
            max={8}
            step={1}
            onChange={(v) => onRender({ colorDepth: v })}
            scale={scale}
            format={(v) => `${v}-bit`}
          />
          <Slider
            label="Resolution"
            value={render.resolutionScale}
            min={0.5}
            max={2}
            step={0.1}
            onChange={(v) => onRender({ resolutionScale: v })}
            scale={scale}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Group>

        <Group title="Assists" scale={scale}>
          <p style={{ fontSize: px(12), color: TOKENS.inkSoft, margin: `0 0 ${px(10)}`, lineHeight: 1.5 }}>
            Assists change how much dexterity a thing takes. They never change what you can make.
          </p>
          <Slider
            label="Automatic turning"
            hint="Turns the marshmallow for you."
            value={accessibility.autoRotate}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => onAccessibility({ autoRotate: v })}
            scale={scale}
            format={(v) => (v === 0 ? 'off' : `${v.toFixed(1)} rad/s`)}
          />
          <Slider
            label="Assembly snapping"
            hint="How strongly pieces settle into place."
            value={accessibility.assemblyAssist}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onAccessibility({ assemblyAssist: v })}
            scale={scale}
          />
          <Toggle
            label="Haptics"
            checked={accessibility.haptics}
            onChange={(v) => onAccessibility({ haptics: v })}
            scale={scale}
          />
          {/*
            Two assists that were implemented, persisted and honoured by the
            input layer, and had no control here — so the only way to turn them
            on was to write them into `localStorage` by hand, which is what the
            offline suite was doing. An assist a player cannot reach is not an
            assist (spec §12).
          */}
          <Toggle
            label="Simplified gestures"
            hint="Buttons for tending the fire, instead of reaching for it."
            checked={accessibility.simplifiedGestures}
            onChange={(v) => onAccessibility({ simplifiedGestures: v })}
            scale={scale}
          />
          <Toggle
            label="Walk with a joystick"
            hint="A thumb pad instead of tapping where you want to go."
            checked={accessibility.virtualJoystick}
            onChange={(v) => onAccessibility({ virtualJoystick: v })}
            scale={scale}
          />
        </Group>

        {/*
          The keys, written down.

          Every interaction in this world has a keyboard path (spec §12) and
          none of them was written anywhere a player could read it, which makes
          an alternate control scheme that exists and cannot be found. It sits
          under Assists because that is where somebody looking for one would
          look, and it is a list rather than a rebinding screen because
          rebinding is a bigger thing than this and nobody has asked for it.
        */}
        <Group title="Keys" scale={scale}>
          <KeyList
            scale={scale}
            rows={[
              ['Walk', 'W A S D'],
              ['Look around', 'Arrow keys'],
              ['Reach for what is in front of you', 'E, Enter or Space'],
              ['Roast: nearer, further, turn', 'Arrow keys'],
              ['Blow it out', 'B'],
              ['Assemble: pick up, set down', 'Enter or Space'],
              ['Assemble: shift the piece, turn it', 'Arrow keys, then [ and ]'],
              ['SM-01: load, door, latch', 'L, D, X'],
              ['SM-01: program, confirm, lever', '1 2 3, Enter, P'],
              ['Torch on and off, and its beam', 'F, then G'],
              ['Lie back, raise the binoculars', 'C, V'],
              ['Stone: wind up, spin, throw', 'Arrow keys, [ and ], T'],
              ['— while a stone is in your hand, the arrows wind it up', ''],
              ['The rod: cast, strike, put it back', 'R'],
              ['What is around you', 'Q'],
              ['Who is at the fire', 'K'],
              ['Close anything that is open', 'Escape'],
            ]}
          />
        </Group>

        <Group title="Sound" scale={scale}>
          <Toggle label="Mute everything" checked={audio.muted} onChange={(v) => onAudio({ muted: v })} scale={scale} />
          <Toggle
            label="Soften sudden sounds"
            hint="Tames loud transients like the latch and compressor."
            checked={audio.reducedIntensity}
            onChange={(v) => onAudio({ reducedIntensity: v })}
            scale={scale}
          />
          {(['master', 'ambience', 'fire', 'machine', 'foley', 'ui'] as const).map((bus) => (
            <Slider
              key={bus}
              label={bus === 'master' ? 'Overall' : bus[0]!.toUpperCase() + bus.slice(1)}
              value={audio[bus]}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => onAudio({ [bus]: v } as Partial<AudioSettings>)}
              scale={scale}
            />
          ))}
        </Group>
      </div>
    </div>
  );
}

function KeyList({ rows, scale }: { rows: readonly (readonly [string, string])[]; scale: number }): React.ReactElement {
  return (
    <dl style={{ margin: 0, fontSize: `${12 * scale}px`, color: TOKENS.ink, lineHeight: 1.7 }}>
      {rows.map(([what, keys]) => (
        <div key={what} style={{ display: 'flex', justifyContent: 'space-between', gap: `${12 * scale}px` }}>
          <dt style={{ margin: 0 }}>{what}</dt>
          <dd style={{ margin: 0, fontFamily: FONT_STACK.mono, color: TOKENS.inkSoft, textAlign: 'right' }}>
            {keys}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Group({ title, children, scale }: { title: string; children: React.ReactNode; scale: number }): React.ReactElement {
  return (
    <section style={{ marginBottom: `${22 * scale}px` }}>
      <h2
        style={{
          fontFamily: FONT_STACK.mono,
          fontSize: `${10 * scale}px`,
          letterSpacing: '0.26em',
          textTransform: 'uppercase',
          color: TOKENS.inkSoft,
          margin: `0 0 ${10 * scale}px`,
          borderBottom: `1px solid ${TOKENS.paperEdge}`,
          paddingBottom: `${6 * scale}px`,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  scale,
  format,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  scale: number;
  format?: (value: number) => string;
}): React.ReactElement {
  /*
   * The value, not the position on the track.
   *
   * This used to read `(value - min) / (max - min)`, which is where the knob
   * sits — and for a dial that runs 0..1 that is the same number, so five of
   * the seven sliders looked right and hid the two that did not. Text size
   * runs 0.85..1.8, so at its default of 1.0 the panel said **"Text size
   * 16%"**: a figure that is not a text size, and an alarming one to show
   * somebody who came to this panel because the type was too small. Fire
   * brightness runs 0.35..1.5 and read "57%" with the fire at exactly the
   * brightness its author chose.
   *
   * Read as a value, both say 100% at their default, which is what a player
   * means by "normal", and every 0..1 dial is unchanged. Fixing the default
   * rather than passing a `format` to the two offenders also means the next
   * slider with a non-zero minimum does not arrive with the same bug.
   */
  const display = format ? format(value) : `${Math.round(value * 100)}%`;
  return (
    <label style={{ display: 'block', marginBottom: `${12 * scale}px`, color: TOKENS.ink }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: `${13 * scale}px` }}>
        <span>{label}</span>
        <span style={{ fontFamily: FONT_STACK.mono, color: TOKENS.inkSoft }}>{display}</span>
      </div>
      {hint && <div style={{ fontSize: `${11 * scale}px`, color: TOKENS.inkSoft, marginTop: 2 }}>{hint}</div>}
      <input
        className="sm-focus"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: '100%', marginTop: `${4 * scale}px`, accentColor: TOKENS.stamp }}
      />
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  scale,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  scale: number;
}): React.ReactElement {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: `${10 * scale}px`,
        marginBottom: `${12 * scale}px`,
        color: TOKENS.ink,
        cursor: 'pointer',
      }}
    >
      <input
        className="sm-focus"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={{ marginTop: 3, accentColor: TOKENS.stamp, width: `${16 * scale}px`, height: `${16 * scale}px` }}
      />
      <span>
        <span style={{ fontSize: `${13 * scale}px` }}>{label}</span>
        {hint && <div style={{ fontSize: `${11 * scale}px`, color: TOKENS.inkSoft }}>{hint}</div>}
      </span>
    </label>
  );
}
