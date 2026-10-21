// 21.10 ARC-2 S1: what the world renderer needs from wherever it runs.
//
// `WorldRenderer3D` used to read the page directly — `window.devicePixelRatio`, the canvas's
// `clientWidth`/`clientHeight`, a `ResizeObserver` on it, `location.search`, an `<img>` per weather
// sprite — and none of those exist in a DedicatedWorker drawing into an OffscreenCanvas. The
// renderer now asks a host; `pageRenderHost` is the page answering exactly as those reads did, and a
// later slice gives the worker a host fed by messages from the page.

import type * as THREE from "three";
import { loadImageTexture } from "./TextureLoad.js";

/** A canvas's size in CSS pixels, rounded the way `clientWidth` rounds. */
export interface CanvasCssSize {
  readonly width: number;
  readonly height: number;
}

export interface RenderHost {
  /** The display's device pixel ratio as reported, unclamped; callers keep their own guards. */
  devicePixelRatio(): number;
  /** The world canvas's CSS size now. On the page a layout read (`clientWidth`/`clientHeight`). */
  canvasCssSize(): CanvasCssSize;
  /**
   * Tells `listener` the canvas's CSS size after each layout that changed it. Returns the
   * unsubscribe, or undefined when the host cannot observe (no `ResizeObserver`), in which case the
   * caller keeps reading {@link canvasCssSize} and may ask again later.
   */
  observeCanvasCssSize(listener: (size: CanvasCssSize) => void): (() => void) | undefined;
  /** A scratch canvas for 2D work or a texture: an OffscreenCanvas where there is one. */
  createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
  /** The page's query flags (`?poseworker=0` and the like). */
  queryFlags(): URLSearchParams;
  /** `TextureLoad.loadImageTexture`: fetch and `createImageBitmap`, never an `<img>`. */
  loadTexture(
    url: string,
    options: { readonly flipY: boolean },
    onLoad: (texture: THREE.Texture) => void,
    onError: (error: unknown) => void,
  ): THREE.Texture;
}

/**
 * A canvas that needs no document where `OffscreenCanvas` exists (a worker, every current browser),
 * else a DOM canvas. Both are a `CanvasImageSource` three's `CanvasTexture` uploads, and both give a
 * `"2d"` context with the same API.
 */
export function createRenderCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** The page: every answer is the read the renderer made itself before ARC-2 S1. */
export function pageRenderHost(canvas: HTMLCanvasElement): RenderHost {
  return {
    devicePixelRatio: () => window.devicePixelRatio,
    canvasCssSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
    observeCanvasCssSize(listener) {
      if (typeof ResizeObserver !== "function") return undefined;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        // Rounded the way `clientWidth` rounds, so the drawing buffer and the camera aspect stay
        // what a layout read would have made them.
        if (entry) {
          listener({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
        }
      });
      observer.observe(canvas);
      return () => observer.disconnect();
    },
    createCanvas: createRenderCanvas,
    queryFlags: () => new URLSearchParams(location.search),
    loadTexture: loadImageTexture,
  };
}
