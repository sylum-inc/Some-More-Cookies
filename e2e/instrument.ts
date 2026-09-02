import type { Page } from '@playwright/test';

/**
 * In-browser renderer instrumentation.
 *
 * Everything here is read from the live `THREE.WebGLRenderer` the client
 * exposes at `window.__someMore.three.gl` (wired in `App.tsx`'s `onCreated`).
 * Nothing is estimated from source: draw calls and triangles are the renderer's
 * own per-frame counters, and the scene graph is walked for lights, geometry
 * and textures.
 *
 * Why these numbers and not frame time: draw calls, triangle counts, light
 * counts and texture footprint are properties of *scene composition*. They are
 * identical on a phone and on this GPU-less runner, so asserting them here is
 * real evidence about a real device. Frame time is not — see
 * `tools/budgets.mjs`, `UNMEASURABLE_HERE`.
 */

export interface RenderSample {
  stage: string;
  /**
   * `renderer.info.render`, taken as the **peak over a burst of consecutive
   * frames** rather than one frame.
   *
   * The fire's particle count changes every frame, so a single-frame read of a
   * campfire stage undercounts by several draw calls at random. A budget is
   * about the worst frame, so the worst frame is what is recorded; the mean and
   * the frame count are kept alongside it so the spread is visible.
   */
  drawCalls: number;
  drawCallsMean: number;
  drawCallsMin: number;
  triangles: number;
  trianglesMean: number;
  framesSampled: number;
  lines: number;
  points: number;
  /** `renderer.info.memory` — live GPU resource counts. */
  geometries: number;
  textureCount: number;
  programs: number;
  /** Walked from the scene graph. */
  lights: number;
  dynamicLights: number;
  lightDetail: { type: string; intensity: number; castShadow: boolean }[];
  meshes: number;
  visibleMeshes: number;
  /** Estimated from texture dimensions; see `textureMegabytes` note in the report. */
  textureBytes: number;
  uniqueTextures: number;
  largestTexture: { key: string; width: number; height: number; bytes: number } | null;
  /** Drawing-buffer size — the PS1 pipeline's internal resolution (ADR-0003). */
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  pixelRatio: number;
}

/**
 * Waits for two animation frames, then reads the counters.
 *
 * Two frames rather than one: the first flushes whatever state change just
 * happened, the second is a steady-state frame whose counters are the ones
 * worth recording.
 */
export async function sampleRenderer(page: Page, stage: string, frames = 20): Promise<RenderSample> {
  return page.evaluate(async ([stageId, frameCount]: [string, number]) => {
    const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const handle = (window as any).__someMore;
    const gl = handle?.three?.gl;
    const scene = handle?.three?.scene;
    if (!gl || !scene) throw new Error('window.__someMore.three is not populated');

    const info = gl.info;

    // Let the state change settle, then take the burst.
    await nextFrame();
    await nextFrame();

    let peakCalls = 0;
    let peakTriangles = 0;
    let minCalls = Number.POSITIVE_INFINITY;
    let totalCalls = 0;
    let totalTriangles = 0;
    for (let i = 0; i < frameCount; i += 1) {
      await nextFrame();
      const calls = info.render.calls;
      const triangles = info.render.triangles;
      peakCalls = Math.max(peakCalls, calls);
      peakTriangles = Math.max(peakTriangles, triangles);
      minCalls = Math.min(minCalls, calls);
      totalCalls += calls;
      totalTriangles += triangles;
    }

    // --- scene walk -------------------------------------------------------
    const textures = new Map<string, { key: string; width: number; height: number; bytes: number }>();
    let lights = 0;
    let dynamicLights = 0;
    let meshes = 0;
    let visibleMeshes = 0;

    const isMipmapped = (texture: any): boolean => {
      // NearestFilter = 1003, LinearFilter = 1006. Everything else is a
      // mipmapped minification filter, which costs an extra third.
      const min = texture.minFilter;
      return Boolean(texture.generateMipmaps) && min !== 1003 && min !== 1006;
    };

    const noteTexture = (texture: any): void => {
      if (!texture || !texture.isTexture) return;
      const image = texture.image ?? texture.source?.data;
      const width = image?.width ?? 0;
      const height = image?.height ?? 0;
      if (!width || !height) return;
      const uuid = texture.uuid as string;
      if (textures.has(uuid)) return;
      // Every procedural texture in this project is RGBA8 (ADR-0002 —
      // canvases), so 4 bytes per texel is the honest figure, not a guess.
      let bytes = width * height * 4;
      if (isMipmapped(texture)) bytes = Math.round(bytes * (4 / 3));
      if (texture.isCubeTexture) bytes *= 6;
      textures.set(uuid, { key: texture.name || texture.constructor?.name || 'texture', width, height, bytes });
    };

    const scanMaterial = (material: any): void => {
      if (!material) return;
      for (const value of Object.values(material)) noteTexture(value);
      const uniforms = material.uniforms;
      if (uniforms) for (const uniform of Object.values<any>(uniforms)) noteTexture(uniform?.value);
    };

    // A light only costs anything if it is actually rendered: hidden under an
    // invisible parent, or dialled to zero intensity, and it never reaches a
    // shader. Counting the scene graph naively would charge the frame for
    // every stage's lighting at once.
    const rendered = (object: any): boolean => {
      for (let node = object; node; node = node.parent) if (!node.visible) return false;
      return true;
    };

    const lightDetail: { type: string; intensity: number; castShadow: boolean }[] = [];

    scene.traverse((object: any) => {
      if (object.isLight) {
        lights += 1;
        const live = rendered(object) && (object.intensity ?? 0) > 0.0001;
        if (live) {
          lightDetail.push({
            type: object.type ?? 'Light',
            intensity: Math.round((object.intensity ?? 0) * 1000) / 1000,
            castShadow: Boolean(object.castShadow),
          });
          // Ambient and hemisphere lights are constant terms in the shader,
          // not per-fragment lights; §10's "≤ 6 dynamic lights" is about the
          // ones that cost something per fragment.
          if (!object.isAmbientLight && !object.isHemisphereLight) dynamicLights += 1;
        }
      }
      if (object.isMesh || object.isPoints || object.isLine) {
        meshes += 1;
        if (object.visible) visibleMeshes += 1;
      }
      const material = object.material;
      if (Array.isArray(material)) material.forEach(scanMaterial);
      else scanMaterial(material);
    });

    if (scene.background) noteTexture(scene.background);
    if (scene.environment) noteTexture(scene.environment);

    let textureBytes = 0;
    let largest: { key: string; width: number; height: number; bytes: number } | null = null;
    for (const entry of textures.values()) {
      textureBytes += entry.bytes;
      if (!largest || entry.bytes > largest.bytes) largest = entry;
    }

    return {
      stage: stageId,
      drawCalls: peakCalls,
      drawCallsMean: Math.round((totalCalls / frameCount) * 10) / 10,
      drawCallsMin: minCalls,
      triangles: peakTriangles,
      trianglesMean: Math.round(totalTriangles / frameCount),
      framesSampled: frameCount,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textureCount: info.memory.textures,
      programs: info.programs?.length ?? 0,
      lights,
      dynamicLights,
      lightDetail,
      meshes,
      visibleMeshes,
      textureBytes,
      uniqueTextures: textures.size,
      largestTexture: largest,
      drawingBufferWidth: gl.getContext().drawingBufferWidth,
      drawingBufferHeight: gl.getContext().drawingBufferHeight,
      pixelRatio: gl.getPixelRatio(),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, [stage, frames] as [string, number]);
}

/**
 * Frame-health metrics, computed from the actual pixels of the WebGL canvas.
 *
 * This exists because three of the ten defects the last session found were
 * "the frame is wrong" rather than "the state is wrong": an unlit sandwich, an
 * entirely black assembly stage, and a reveal whiteout. None of those were
 * visible to a green test suite, and none need a baseline image to detect —
 * they are properties of the luminance distribution of a single frame.
 *
 * The canvas is re-rendered synchronously first, exactly as the in-game photo
 * capture does (`interaction/photo.ts`), because a WebGL drawing buffer is
 * cleared once composited.
 */
export interface FrameMetrics {
  stage: string;
  width: number;
  height: number;
  meanLuminance: number;
  /** Standard deviation of luminance — a flat frame has almost none. */
  luminanceStdDev: number;
  p01Luminance: number;
  p99Luminance: number;
  /** Fraction of pixels at the very bottom / top of the range. */
  blackFraction: number;
  whiteFraction: number;
  meanRgb: [number, number, number];
  /** Mean (R − B) / 255. Positive is a warm frame, negative a cold one. */
  warmth: number;
  /** Distinct quantised colours, as a fraction of the sampled pixels. */
  colourVariety: number;
  /** Mean luminance of a 4×4 grid, row-major — where the light actually is. */
  tiles: number[];
}

export async function sampleFrame(page: Page, stage: string, sampleWidth = 256): Promise<FrameMetrics> {
  return page.evaluate(
    async ([stageId, targetWidth]: [string, number]) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const handle = (window as any).__someMore;
      const three = handle?.three;
      if (!three) throw new Error('window.__someMore.three is not populated');

      // Re-render synchronously so the drawing buffer is populated at the
      // moment it is read (defect #7 in IMPLEMENTATION_PLAN's defect table).
      three.gl.render(three.scene, three.camera);
      const source: HTMLCanvasElement = three.gl.domElement;

      const width = Math.min(targetWidth, source.width);
      const height = Math.max(1, Math.round((source.height / source.width) * width));
      const target = document.createElement('canvas');
      target.width = width;
      target.height = height;
      const ctx = target.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(source, 0, 0, width, height);
      const { data } = ctx.getImageData(0, 0, width, height);

      const pixels = width * height;
      const luminance = new Float64Array(pixels);
      const colours = new Set<number>();
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let black = 0;
      let white = 0;

      const tileSums = new Float64Array(16);
      const tileCounts = new Float64Array(16);

      for (let i = 0; i < pixels; i += 1) {
        const r = data[i * 4]!;
        const g = data[i * 4 + 1]!;
        const b = data[i * 4 + 2]!;
        sumR += r;
        sumG += g;
        sumB += b;
        // Rec. 601 luma, 0..1.
        const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        luminance[i] = l;
        if (l <= 0.02) black += 1;
        if (l >= 0.98) white += 1;
        colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        const x = i % width;
        const y = (i / width) | 0;
        const tile = Math.min(3, ((y / height) * 4) | 0) * 4 + Math.min(3, ((x / width) * 4) | 0);
        tileSums[tile]! += l;
        tileCounts[tile]! += 1;
      }

      let mean = 0;
      for (let i = 0; i < pixels; i += 1) mean += luminance[i]!;
      mean /= pixels;
      let variance = 0;
      for (let i = 0; i < pixels; i += 1) variance += (luminance[i]! - mean) ** 2;
      variance /= pixels;

      const sorted = Array.from(luminance).sort((a, b) => a - b);
      const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;

      const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

      return {
        stage: stageId,
        width,
        height,
        meanLuminance: round(mean),
        luminanceStdDev: round(Math.sqrt(variance)),
        p01Luminance: round(at(0.01)),
        p99Luminance: round(at(0.99)),
        blackFraction: round(black / pixels),
        whiteFraction: round(white / pixels),
        meanRgb: [round(sumR / pixels, 2), round(sumG / pixels, 2), round(sumB / pixels, 2)] as [number, number, number],
        warmth: round((sumR - sumB) / pixels / 255),
        colourVariety: round(colours.size / pixels),
        tiles: Array.from({ length: 16 }, (_, i) => round(tileCounts[i]! > 0 ? tileSums[i]! / tileCounts[i]! : 0)),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    [stage, sampleWidth] as [string, number],
  );
}
