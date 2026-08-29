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

  return (
    <div className="sm-overlay" role="dialog" aria-label="Settings" onClick={onClose}>
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
  const display = format ? format(value) : `${Math.round(((value - min) / (max - min)) * 100)}%`;
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
