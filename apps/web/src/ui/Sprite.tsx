/**
 * One sprite out of the atlas.
 *
 * Background-position on a single shared image rather than one `<img>` per
 * icon: the atlas is one request and one decode, and a HUD that swaps icons as
 * the world changes does it by moving a background offset rather than by
 * fetching anything. That is how this was done on the hardware being imitated
 * and it is still the reason it feels instant.
 *
 * `image-rendering: pixelated` and integer scaling are not decoration. These
 * are 32-pixel drawings; at a fractional scale with smoothing on, the outline
 * that makes them legible turns to grey mush, which is precisely the failure
 * the outline exists to prevent.
 */

import type { CSSProperties } from 'react';
import { SPRITES, SPRITE_CELL, SPRITE_SHEET, SPRITE_SHEET_SIZE, type SpriteName } from './sprites/atlas.js';

export type { SpriteName };

export interface SpriteProps {
  name: SpriteName;
  /** Whole-number multiplier on the 32-pixel cell. Fractions are rounded. */
  scale?: number;
  /** Decorative by default — the button around it carries the label. */
  title?: string;
  style?: CSSProperties;
  className?: string;
}

/** Where the atlas lives, honouring a subpath deploy. */
function sheetUrl(): string {
  const base = (import.meta.env?.BASE_URL ?? '/') as string;
  return `${base.endsWith('/') ? base : `${base}/`}${SPRITE_SHEET}`;
}

export function Sprite({ name, scale = 2, title, style, className }: SpriteProps): React.ReactElement {
  const frame = SPRITES[name];
  // A whole number, always: see the note above about what smoothing does to a
  // one-pixel outline.
  const step = Math.max(1, Math.round(scale));
  const size = SPRITE_CELL * step;
  return (
    <span
      className={className}
      role={title ? 'img' : 'presentation'}
      {...(title ? { 'aria-label': title } : { 'aria-hidden': true })}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flex: '0 0 auto',
        backgroundImage: `url(${sheetUrl()})`,
        backgroundPosition: `-${frame.x * step}px -${frame.y * step}px`,
        backgroundSize: `${SPRITE_SHEET_SIZE.width * step}px ${SPRITE_SHEET_SIZE.height * step}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  );
}

/** Whether a name is in the atlas, for code mapping world ids onto sprites. */
export function hasSprite(name: string): name is SpriteName {
  return name in SPRITES;
}
