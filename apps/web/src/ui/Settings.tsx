/**
 * Settings.
 *
 * Accessibility is part of the architecture, not a bolted-on screen
 * (spec §12). The same knobs serve art direction and access: "reduce
 * dithering" is both.
 */

import { CUT_MARK_PX, FONT_STACK, SR_ONLY, TOKENS, px as uiPx, typePx, useScrollCut } from './styles.js';
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
  const px = (n: number) => uiPx(n, scale);
  const tp = (n: number) => typePx(n, scale);
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();
  // Whether anything is below the cut, so the mark at the bottom of the frame
  // is drawn only when it is telling the truth.
  const cut = useScrollCut<HTMLDivElement>();

  return (
    <div
      className="sm-overlay"
      role="dialog"
      aria-label="Settings"
      onClick={onClose}
      {...dialog.props}
    >
      <div
        className="sm-panel sm-panel-tall"
        data-more={cut.more}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(680px, 94vw)' }}
      >
        {/*
          Outside the scroll region, and first in the document.

          It used to be an absolutely positioned child of the scroller, so it
          slid off the top the moment anybody read past Comfort — and it is
          still the first thing in the document, which is what `useDialog`
          moves focus to when the panel opens.
        */}
        {/* No glyph inside it: the X is two 2px bars drawn by `.sm-close`. */}
        <button
          className="sm-focus sm-close"
          onClick={onClose}
          aria-label="Close settings"
          style={{ position: 'absolute', top: px(10), right: px(12), zIndex: 3, width: px(22), height: px(22), color: TOKENS.inkSoft }}
        />

        {/* The extra bottom padding is the cut mark's twenty fixed pixels, so
            the last slider can scroll clear of the dither rather than ending
            under it. Fixed, because the mark does not scale with the type. */}
        <div ref={cut.ref} className="sm-panel-scroll" style={{ padding: px(26), paddingBottom: `${Math.round(26 * scale) + CUT_MARK_PX}px` }}>
          <h1 className="sm-stamp" style={{ fontSize: tp(17), margin: `0 0 ${px(18)}` }}>
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
            {/* No `format` of its own any more: 0.5..2 is a multiplier around 1
                like text size and fire brightness, and its hand-rolled formatter
                was the third slider printing a bare "100%" with its handle a
                third of the way along. The default now covers that shape. */}
            <Slider
              label="Resolution"
              value={render.resolutionScale}
              min={0.5}
              max={2}
              step={0.1}
              onChange={(v) => onRender({ resolutionScale: v })}
              scale={scale}
            />
          </Group>

          <Group title="Assists" scale={scale}>
            <p style={{ fontSize: tp(12), color: TOKENS.inkSoft, margin: `0 0 ${px(10)}`, lineHeight: 1.5 }}>
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
              hint="For a mouse or trackpad — a touchscreen already draws one."
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
    </div>
  );
}

function KeyList({ rows, scale }: { rows: readonly (readonly [string, string])[]; scale: number }): React.ReactElement {
  return (
    <dl style={{ margin: 0, fontSize: typePx(12, scale), color: TOKENS.ink, lineHeight: 1.7 }}>
      {rows.map(([what, keys]) => (
        <div key={what} style={{ display: 'flex', justifyContent: 'space-between', gap: uiPx(12, scale) }}>
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
    <section style={{ marginBottom: uiPx(22, scale) }}>
      <h2
        style={{
          fontFamily: FONT_STACK.mono,
          fontSize: typePx(10, scale),
          letterSpacing: '0.26em',
          textTransform: 'uppercase',
          color: TOKENS.inkSoft,
          margin: `0 0 ${uiPx(10, scale)}`,
          borderBottom: `2px solid ${TOKENS.paperEdge}`,
          paddingBottom: uiPx(6, scale),
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
  const display = sliderReadout(value, min, max, format);
  const spoken = sliderSpoken(value, min, max, format);
  return (
    <label style={{ display: 'block', marginBottom: uiPx(12, scale), color: TOKENS.ink }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: uiPx(10, scale), fontSize: typePx(13, scale) }}>
        <span>{label}</span>
        {/*
          Two channels for one number, when the two need different words.

          "×1.00" is the right mark on a page: it is short, it is unambiguous,
          and it cannot be mistaken for the handle's position. It is not a
          thing a screen reader says — "times one point zero zero" is not how
          anybody describes a text size — so the glyph is hidden from the
          accessibility tree and the sentence is hidden from the page. Both are
          the same fact and neither is decoration.
        */}
        <span style={{ fontFamily: FONT_STACK.mono, color: TOKENS.inkSoft }}>
          {spoken === display ? (
            display
          ) : (
            <>
              <span aria-hidden="true">{display}</span>
              <span style={SR_ONLY}>{spoken}</span>
            </>
          )}
        </span>
      </div>
      {hint && <div style={{ fontSize: typePx(11, scale), color: TOKENS.inkSoft, marginTop: 2 }}>{hint}</div>}
      <input
        className="sm-focus sm-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        // The repainted track has no progress pseudo-element in WebKit, so the
        // stain behind the handle is driven from here. Same number as the
        // handle's own position, by construction.
        style={
          {
            width: '100%',
            marginTop: uiPx(4, scale),
            '--sm-fill': `${sliderPosition(value, min, max) * 100}%`,
          } as React.CSSProperties
        }
      />
    </label>
  );
}

/** Where the handle sits on its track, 0 at the left end and 1 at the right. */
export function sliderPosition(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * What one slider says it is set to.
 *
 * This has now been wrong in three ways, and the cause is the same every
 * time: a percentage is only meaningful when 0% and 100% are the ends of the
 * control, and half the knobs on this panel are not built that way.
 *
 * It first read `(value - min) / (max - min)` — the handle's position. For a
 * dial running 0..1 that is also the value, so five of the seven sliders
 * looked right and hid the two that did not: at its own default the panel said
 * **"Text size 16%"**, which is not a text size and is an alarming figure to
 * show somebody who opened this screen because the type was too small.
 *
 * It was then changed to read the raw value as "N% of normal". That is
 * *literally true* — fire brightness runs 0.35 to 1.5, its default is 1.0, and
 * 1.0 is a hundred per cent of normal — and it still failed, because a reader
 * seeing "100%" beside a handle sitting 56% of the way along its track has to
 * work out which of the two is lying before they can trust either. A setting
 * that needs working out is a broken setting however defensible its arithmetic
 * is.
 *
 * So the notation follows the shape of the range, and the two shapes now use
 * two different *kinds* of mark rather than the same mark with a qualifier:
 *
 *   0..max   a dial. 0 is off, the top is everything, and the percentage *is*
 *            the handle position, so a percentage is exactly right.
 *   min>0    a multiplier around a reference of 1. It reads "×1.00" — a
 *            number that never resembles a position on a track, cannot be
 *            compared against one, and is what the value actually is: the
 *            factor the type or the firelight is multiplied by.
 *
 * `sliderSpoken` carries the long form for anybody listening rather than
 * looking; see the note at the readout in `Slider`.
 */
export function sliderReadout(
  value: number,
  min: number,
  max: number,
  format?: (value: number) => string,
): string {
  if (format) return format(value);
  if (min === 0) return `${Math.round((value / max) * 100)}%`;
  // Two decimals because the step on both multiplier sliders is 0.05, and
  // "×1.1" for 1.15 is a readout that stops moving when the handle does not.
  return `×${value.toFixed(2)}`;
}

/**
 * The same setting, in words, for a screen reader.
 *
 * "×1.00" is a mark, not a phrase — read aloud it is "times one point zero
 * zero", which is not how anybody describes how large their text is. The
 * spoken form keeps the per-cent-of-normal wording, which was always the right
 * *sentence* and only ever the wrong *glyph*.
 *
 * Identical to `sliderReadout` for every other shape of slider, and `Slider`
 * renders one span rather than two when they agree.
 */
export function sliderSpoken(
  value: number,
  min: number,
  max: number,
  format?: (value: number) => string,
): string {
  if (format || min === 0) return sliderReadout(value, min, max, format);
  return `${Math.round(value * 100)}% of normal`;
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
        gap: uiPx(10, scale),
        marginBottom: uiPx(12, scale),
        color: TOKENS.ink,
        cursor: 'pointer',
      }}
    >
      <input
        className="sm-focus"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={{ marginTop: 3, accentColor: TOKENS.stamp, width: uiPx(16, scale), height: uiPx(16, scale) }}
      />
      <span>
        <span style={{ fontSize: typePx(13, scale) }}>{label}</span>
        {hint && <div style={{ fontSize: typePx(11, scale), color: TOKENS.inkSoft }}>{hint}</div>}
      </span>
    </label>
  );
}
