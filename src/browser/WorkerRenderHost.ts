/**
 * 22.10 ARC-2 S6a: the RenderHost of a world renderer in a DedicatedWorker. The page's reads — the pixel ratio, the
 * canvas's CSS size, the query flags — arrive as pushed values (RenderWorkerProtocol.ts `init` and `host`), and a
 * size change reaches the renderer's observer as the page's ResizeObserver would have reported it. The texture path is
 * the page's own (fetch and `createImageBitmap` work here); the GPU timer's events and the frame-budget sensor are the
 * worker realm's, reported through RenderResults.ts (RendererReports.ts).
 */

import type { FrameBudgetProbe } from "./FrameBudgetProbe.js";
import { queuedGpuObserver } from "./RendererReports.js";
import { createRenderCanvas, type CanvasCssSize, type RenderHost } from "./RenderHost.js";
import type { RenderWorkerHostValues } from "./RenderWorkerProtocol.js";
import { loadImageTexture } from "./TextureLoad.js";

export class WorkerRenderHost implements RenderHost {
  #values: RenderWorkerHostValues;
  #size: CanvasCssSize;
  readonly #listeners = new Set<(size: CanvasCssSize) => void>();
  readonly createCanvas = createRenderCanvas;
  readonly loadTexture = loadImageTexture;
  readonly gpuTimerObserver = queuedGpuObserver;

  constructor(values: RenderWorkerHostValues, readonly frameBudgetProbe: FrameBudgetProbe | undefined) {
    this.#values = values;
    this.#size = { width: values.cssWidth, height: values.cssHeight };
  }

  devicePixelRatio(): number {
    return this.#values.devicePixelRatio;
  }

  canvasCssSize(): CanvasCssSize {
    return this.#size;
  }

  observeCanvasCssSize(listener: (size: CanvasCssSize) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  queryFlags(): URLSearchParams {
    return new URLSearchParams(this.#values.query);
  }

  /** The page's new values; the observers hear of a size that changed, as a ResizeObserver tells of a layout. */
  update(values: RenderWorkerHostValues): void {
    this.#values = values;
    if (values.cssWidth === this.#size.width && values.cssHeight === this.#size.height) return;
    const size = { width: values.cssWidth, height: values.cssHeight };
    this.#size = size;
    for (const listener of this.#listeners) listener(size);
  }
}

