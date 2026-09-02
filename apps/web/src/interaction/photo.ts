/**
 * Photo mode (spec §10).
 *
 * Captures the actual rendered frame and applies a disposable-camera
 * treatment: date stamp, grain, light leak, slight misalignment. The frame is
 * already low-resolution and dithered, so the result reads as a photograph of
 * a PS1 world rather than a screenshot with a filter over it.
 */

import type { RitualStage } from '@somemore/sim';
import type { PassportPhoto } from '../state/store.js';

export interface PhotoOptions {
  environmentId: string;
  stage: RitualStage;
  caption: string;
  /** Output width; height follows the source aspect. */
  width?: number;
  /** Disposable-camera treatment strength, 0..1. */
  treatment?: number;
  /** Injected for deterministic tests. */
  now?: Date;
  random?: () => number;
}

/**
 * Renders the treated photo. Returns null when there is no canvas to read
 * (server-side, or a lost WebGL context).
 */
export function capturePhoto(source: HTMLCanvasElement, options: PhotoOptions): PassportPhoto | null {
  if (typeof document === 'undefined') return null;

  const width = options.width ?? 480;
  const aspect = source.height > 0 ? source.height / source.width : 0.75;
  const height = Math.round(width * aspect);
  const treatment = options.treatment ?? 1;
  const random = options.random ?? Math.random;
  const now = options.now ?? new Date();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  // Slight misalignment — a disposable camera never framed exactly true.
  const skew = (random() - 0.5) * 0.012 * treatment;
  const offsetX = (random() - 0.5) * width * 0.012 * treatment;
  const offsetY = (random() - 0.5) * height * 0.012 * treatment;

  ctx.save();
  ctx.translate(width / 2 + offsetX, height / 2 + offsetY);
  ctx.rotate(skew);
  ctx.imageSmoothingEnabled = false;
  try {
    ctx.drawImage(source, -width / 2 - 4, -height / 2 - 4, width + 8, height + 8);
  } catch {
    // A tainted or lost context must not break the ritual.
    ctx.restore();
    return null;
  }
  ctx.restore();

  if (treatment > 0) {
    applyGrain(ctx, width, height, treatment, random);
    applyLightLeak(ctx, width, height, treatment, random);
    applyVignette(ctx, width, height, treatment);
    applyDateStamp(ctx, width, height, now, treatment);
  }

  return {
    id: `photo-${now.getTime().toString(36)}-${Math.floor(random() * 1e6).toString(36)}`,
    dataUrl: canvas.toDataURL('image/jpeg', 0.82),
    caption: options.caption,
    takenAt: now.getTime(),
    environmentId: options.environmentId,
    stage: options.stage,
  };
}

function applyGrain(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strength: number,
  random: () => number,
): void {
  const count = Math.floor(width * height * 0.035 * strength);
  for (let i = 0; i < count; i++) {
    const bright = random() > 0.5;
    ctx.fillStyle = bright ? `rgba(255,250,235,${(random() * 0.16).toFixed(3)})` : `rgba(10,8,6,${(random() * 0.18).toFixed(3)})`;
    ctx.fillRect(Math.floor(random() * width), Math.floor(random() * height), 1, 1);
  }
}

function applyLightLeak(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strength: number,
  random: () => number,
): void {
  // Leaks come in from an edge, warm and soft.
  if (random() > 0.65) return;
  const fromLeft = random() > 0.5;
  const gradient = ctx.createLinearGradient(fromLeft ? 0 : width, 0, fromLeft ? width * 0.45 : width * 0.55, height);
  gradient.addColorStop(0, `rgba(255,150,60,${(0.3 * strength).toFixed(3)})`);
  gradient.addColorStop(0.4, `rgba(255,90,40,${(0.09 * strength).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(255,60,20,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function applyVignette(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
  const gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.28,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, `rgba(0,0,0,${(0.5 * strength).toFixed(3)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function applyDateStamp(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  now: Date,
  strength: number,
): void {
  const stamp = formatDateStamp(now);
  const size = Math.max(11, Math.round(width * 0.032));
  ctx.font = `${size}px "Courier New", monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  // The classic orange LED date imprint, which bleeds slightly into the frame.
  ctx.shadowColor = `rgba(255,120,20,${(0.85 * strength).toFixed(3)})`;
  ctx.shadowBlur = size * 0.5;
  ctx.fillStyle = `rgba(255,168,60,${(0.92 * strength).toFixed(3)})`;
  ctx.fillText(stamp, width - size * 0.7, height - size * 0.6);
  ctx.shadowBlur = 0;
}

/** `'24 08 12` — the format those cameras actually printed. */
export function formatDateStamp(date: Date): string {
  const year = String(date.getFullYear()).slice(2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `'${year} ${month} ${day}`;
}
