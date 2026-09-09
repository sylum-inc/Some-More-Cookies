/**
 * Settings.
 *
 * Accessibility is part of the architecture, not a bolted-on screen
 * (spec §12). The same knobs serve art direction and access: "reduce
 * dithering" is both.
 *
 * Drawn into the pixel buffer now rather than styled onto the page — see
 * `ui/PixelPanel.tsx` for the canvas-plus-DOM division and `ui/pixel/panel.ts`
 * for why the DOM half is not optional. Every control on this panel is still a
 * real `<input>` with a real role, a real name, a real value and a real tab
 * stop; what changed is that its *picture* is drawn in the game's own pixels
 * instead of being the browser's idea of a checkbox.
 *
 * What is left in this file is the panel's *content*: which knobs exist, what
 * they are called, what they read out, and what turning one does. There is no
 * styling in it at all.
 */

import { useMemo, useRef } from 'react';
import type { AccessibilitySettings, AudioSettings } from '../state/store.js';
import type { RenderSettings } from '../render/ps1.js';
import { PixelPanel, type SliderMirror } from './PixelPanel.js';
import type { PanelBlock, PanelControl } from './pixel/index.js';

export interface SettingsProps {
  render: RenderSettings;
  accessibility: AccessibilitySettings;
  audio: AudioSettings;
  onRender: (partial: Partial<RenderSettings>) => void;
  onAccessibility: (partial: Partial<AccessibilitySettings>) => void;
  onAudio: (partial: Partial<AudioSettings>) => void;
  onClose: () => void;
  /** The bezel's thickness, from `bezelInset`. */
  frameInset?: number;
}

/* -------------------------------------------------------------------------- */
/* The knobs                                                                  */
/* -------------------------------------------------------------------------- */

type Bus = 'master' | 'ambience' | 'fire' | 'machine' | 'foley' | 'ui';
const BUSES: readonly Bus[] = ['master', 'ambience', 'fire', 'machine', 'foley', 'ui'];

interface SliderSpec {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly format?: (value: number) => string;
  readonly apply: (value: number) => void;
}

interface ToggleSpec {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly apply: (value: boolean) => void;
}

/**
 * The keys, written down.
 *
 * Every interaction in this world has a keyboard path (spec §12) and none of
 * them was written anywhere a player could read it, which makes an alternate
 * control scheme that exists and cannot be found. It sits under Assists
 * because that is where somebody looking for one would look, and it is a list
 * rather than a rebinding screen because rebinding is a bigger thing than this
 * and nobody has asked for it.
 */
const KEYS: readonly (readonly [string, string])[] = [
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
];

export function Settings({
  render,
  accessibility,
  audio,
  onRender,
  onAccessibility,
  onAudio,
  onClose,
  frameInset,
}: SettingsProps): React.ReactElement {
  /*
   * The handlers are held in a ref, and the memo does not depend on them.
   *
   * `App` passes them as inline arrows, so they are a new identity on every
   * render of the app — and the app renders whenever the world does, which is
   * often, because the campsite is still running behind the scrim. Depending on
   * them would relay out and repaint the whole panel every frame the fire
   * flickers. The panel depends on the settings; the settings do not change
   * when the fire does.
   */
  const handlers = useRef({ onRender, onAccessibility, onAudio });
  handlers.current = { onRender, onAccessibility, onAudio };
  const page = useMemo(
    () =>
      settingsPage(render, accessibility, audio, {
        onRender: (partial) => handlers.current.onRender(partial),
        onAccessibility: (partial) => handlers.current.onAccessibility(partial),
        onAudio: (partial) => handlers.current.onAudio(partial),
      }),
    [render, accessibility, audio],
  );

  return (
    <PixelPanel
      label="Settings"
      closeLabel="Close settings"
      blocks={page.blocks}
      sliders={page.sliders}
      textScale={accessibility.textScale}
      highContrast={accessibility.highContrast}
      {...(frameInset === undefined ? {} : { frameInset })}
      onClose={onClose}
      onCheckbox={(id, checked) => page.toggles[id]?.(checked)}
      onSlider={(id, value) => page.knobs[id]?.(value)}
    />
  );
}

/**
 * The whole panel, as blocks — plus what each control does when it moves.
 *
 * Exported and pure so `settings-sliders.test.ts` can read the same numbers a
 * player sees without a browser. The rule this file exists to keep is stated
 * on `sliderReadout` below and it is checkable from here: the mark a row
 * prints and the position its handle sits at are the same fact.
 */
export function settingsPage(
  render: RenderSettings,
  accessibility: AccessibilitySettings,
  audio: AudioSettings,
  on: {
    onRender: (partial: Partial<RenderSettings>) => void;
    onAccessibility: (partial: Partial<AccessibilitySettings>) => void;
    onAudio: (partial: Partial<AudioSettings>) => void;
  },
): {
  blocks: PanelBlock[];
  sliders: Record<string, SliderMirror>;
  knobs: Record<string, (value: number) => void>;
  toggles: Record<string, (value: boolean) => void>;
} {
  const blocks: PanelBlock[] = [];
  const sliders: Record<string, SliderMirror> = {};
  const knobs: Record<string, (value: number) => void> = {};
  const toggles: Record<string, (value: boolean) => void> = {};

  const slider = (spec: SliderSpec): PanelControl => {
    sliders[spec.id] = {
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
      spoken: sliderSpoken(spec.value, spec.min, spec.max, spec.format),
    };
    knobs[spec.id] = spec.apply;
    return {
      kind: 'slider',
      id: spec.id,
      label: spec.label,
      ...(spec.hint === undefined ? {} : { hint: spec.hint }),
      readout: sliderReadout(spec.value, spec.min, spec.max, spec.format),
      fraction: sliderPosition(spec.value, spec.min, spec.max),
    };
  };

  const toggle = (spec: ToggleSpec): PanelControl => {
    toggles[spec.id] = spec.apply;
    return {
      kind: 'checkbox',
      id: spec.id,
      label: spec.label,
      ...(spec.hint === undefined ? {} : { hint: spec.hint }),
      checked: spec.checked,
    };
  };

  const group = (id: string, title: string, controls: PanelControl[]): void => {
    blocks.push({ kind: 'heading', id: `${id}-label`, level: 2, text: title });
    blocks.push({ kind: 'controls', id: `${id}-controls`, controls });
  };

  blocks.push({ kind: 'heading', id: 'title', level: 1, text: 'Settings' });

  group('comfort', 'Comfort', [
    toggle({
      id: 'reduced-motion',
      label: 'Reduced motion',
      hint: 'Damps camera movement and shake.',
      checked: render.reducedMotion,
      apply: (v) => on.onRender({ reducedMotion: v }),
    }),
    slider({
      id: 'flicker',
      label: 'Flicker',
      hint: 'How much the fire and lamps pulse.',
      value: render.flicker,
      min: 0,
      max: 1,
      step: 0.05,
      apply: (v) => on.onRender({ flicker: v }),
    }),
    slider({
      id: 'fire-brightness',
      label: 'Fire brightness',
      hint: 'Tames the fire without removing it.',
      value: render.fireBrightness,
      min: 0.35,
      max: 1.5,
      step: 0.05,
      apply: (v) => on.onRender({ fireBrightness: v }),
    }),
    slider({
      id: 'text-size',
      label: 'Text size',
      /*
       * The hint is the honest half of `panelTextMetrics`.
       *
       * A five-pixel bitmap face has 1x and 2x and nothing between them, so
       * eighteen of this dial's twenty stops cannot make a letter bigger. They
       * are not wasted — they buy line spacing and page margin inside a drawn
       * panel, and they still scale the rest of the interface continuously —
       * but a control whose label disagrees with what it does is the exact
       * defect `sliderReadout` below has a page of notes about. So it says so.
       */
      hint: 'Two sizes of type. The rest of this dial buys line spacing.',
      value: accessibility.textScale,
      min: 0.85,
      max: 1.8,
      step: 0.05,
      apply: (v) => on.onAccessibility({ textScale: v }),
    }),
    toggle({
      id: 'high-contrast',
      label: 'High contrast',
      checked: accessibility.highContrast,
      apply: (v) => on.onAccessibility({ highContrast: v }),
    }),
    toggle({
      id: 'subtitles',
      label: 'Subtitles',
      hint: 'Describes sounds that carry information.',
      checked: accessibility.subtitles,
      apply: (v) => on.onAccessibility({ subtitles: v }),
    }),
  ]);

  group('picture', 'Picture', [
    slider({
      id: 'dither',
      label: 'Dithering',
      hint: 'The ordered pattern in the shading.',
      value: render.dither,
      min: 0,
      max: 1,
      step: 0.05,
      apply: (v) => on.onRender({ dither: v }),
    }),
    slider({
      id: 'jitter',
      label: 'Vertex wobble',
      hint: 'The period-accurate shake in the geometry.',
      value: render.jitter,
      min: 0,
      max: 1,
      step: 0.05,
      apply: (v) => on.onRender({ jitter: v }),
    }),
    slider({
      id: 'affine',
      label: 'Texture swim',
      hint: 'Affine texture instability.',
      value: render.affine,
      min: 0,
      max: 1,
      step: 0.05,
      apply: (v) => on.onRender({ affine: v }),
    }),
    slider({
      id: 'colour-depth',
      label: 'Colour depth',
      hint: 'Bits per channel. Higher is smoother.',
      value: render.colorDepth,
      min: 3,
      max: 8,
      step: 1,
      format: (v) => `${v}-bit`,
      apply: (v) => on.onRender({ colorDepth: v }),
    }),
    // No `format` of its own: 0.5..2 is a multiplier around 1 like text size
    // and fire brightness, and its hand-rolled formatter was the third slider
    // printing a bare "100%" with its handle a third of the way along.
    slider({
      id: 'resolution',
      label: 'Resolution',
      value: render.resolutionScale,
      min: 0.5,
      max: 2,
      step: 0.1,
      apply: (v) => on.onRender({ resolutionScale: v }),
    }),
  ]);

  blocks.push({ kind: 'heading', id: 'assists-label', level: 2, text: 'Assists' });
  blocks.push({
    kind: 'body',
    id: 'assists-note',
    tone: 'soft',
    text: 'Assists change how much dexterity a thing takes. They never change what you can make.',
  });
  blocks.push({
    kind: 'controls',
    id: 'assists-controls',
    controls: [
      slider({
        id: 'auto-rotate',
        label: 'Automatic turning',
        hint: 'Turns the marshmallow for you.',
        value: accessibility.autoRotate,
        min: 0,
        max: 2,
        step: 0.1,
        format: (v) => (v === 0 ? 'off' : `${v.toFixed(1)} rad/s`),
        apply: (v) => on.onAccessibility({ autoRotate: v }),
      }),
      slider({
        id: 'assembly-assist',
        label: 'Assembly snapping',
        hint: 'How strongly pieces settle into place.',
        value: accessibility.assemblyAssist,
        min: 0,
        max: 1,
        step: 0.05,
        apply: (v) => on.onAccessibility({ assemblyAssist: v }),
      }),
      toggle({
        id: 'haptics',
        label: 'Haptics',
        checked: accessibility.haptics,
        apply: (v) => on.onAccessibility({ haptics: v }),
      }),
      /*
        Two assists that were implemented, persisted and honoured by the input
        layer, and had no control here — so the only way to turn them on was to
        write them into `localStorage` by hand, which is what the offline suite
        was doing. An assist a player cannot reach is not an assist (spec §12).
      */
      toggle({
        id: 'simplified-gestures',
        label: 'Simplified gestures',
        hint: 'Buttons for tending the fire, instead of reaching for it.',
        checked: accessibility.simplifiedGestures,
        apply: (v) => on.onAccessibility({ simplifiedGestures: v }),
      }),
      toggle({
        id: 'virtual-joystick',
        label: 'Walk with a joystick',
        hint: 'For a mouse or trackpad — a touchscreen already draws one.',
        checked: accessibility.virtualJoystick,
        apply: (v) => on.onAccessibility({ virtualJoystick: v }),
      }),
    ],
  });

  blocks.push({ kind: 'heading', id: 'keys-label', level: 2, text: 'Keys' });
  // A body block rather than a machine one: `machine` sets small capitals, and
  // seventeen rows of shouted key names is a wall. These are sentences.
  blocks.push({
    kind: 'body',
    id: 'keys-list',
    text: KEYS.map(([what, keys]) => (keys === '' ? what : `${what} — ${keys}`)).join('\n'),
  });

  group('sound', 'Sound', [
    toggle({
      id: 'muted',
      label: 'Mute everything',
      checked: audio.muted,
      apply: (v) => on.onAudio({ muted: v }),
    }),
    toggle({
      id: 'reduced-intensity',
      label: 'Soften sudden sounds',
      hint: 'Tames loud transients like the latch and compressor.',
      checked: audio.reducedIntensity,
      apply: (v) => on.onAudio({ reducedIntensity: v }),
    }),
    ...BUSES.map((bus) =>
      slider({
        id: `bus-${bus}`,
        label: bus === 'master' ? 'Overall' : bus[0]!.toUpperCase() + bus.slice(1),
        value: audio[bus],
        min: 0,
        max: 1,
        step: 0.05,
        apply: (v) => on.onAudio({ [bus]: v } as Partial<AudioSettings>),
      }),
    ),
  ]);

  return { blocks, sliders, knobs, toggles };
}

/* -------------------------------------------------------------------------- */
/* What a slider says                                                         */
/* -------------------------------------------------------------------------- */

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
 * The "×" survived the move into the pixel buffer, and it is the one place the
 * conversion changed something outside these files: `bitmapFont.ts` had no
 * U+00D7 and drew the hollow missing-glyph box, so the *font* grew the
 * character rather than this readout losing three rounds of argument to a
 * missing glyph. Transliterating it to an "x" was the alternative and it is
 * worse — "x1.00" is a letter and a number, and this is a multiplication sign.
 *
 * `sliderSpoken` carries the long form for anybody listening rather than
 * looking; see the note at the readout in `PixelPanel`.
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
 * Identical to `sliderReadout` for every other shape of slider, and the panel
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
