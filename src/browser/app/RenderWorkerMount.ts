/**
 * 22.10 ARC-2 S6b: the page's half of `?renderworker=1` (main.ts): the world renderer started in a worker
 * (RenderWorkerStart.ts) with the page's canvas, the page's size, pixel ratio and visibility pushed as they change,
 * the after-draw work of game/Loop.ts run on each results message — and, if the worker cannot start or fails, the
 * in-page renderer on a fresh canvas (a canvas whose control was transferred can never draw on the page again), with
 * every setting the proxy was given replayed onto it.
 */

import { frameLimit, onFrameLimitChange } from "../FrameLimit.js"; // 25.10
import type { ClientRenderer } from "../ClientRenderer.js";
import { WorldRenderer3D } from "../WorldRenderer3D.js";
import { gatewayGenerationPush } from "../GatewayGeneration.js";
import { pageHostValues } from "../RenderHost.js";
import type { RenderWorkerHostValues } from "../RenderWorkerProtocol.js";
import { renderWorkerSupported, startRenderWorker, type RenderWorkerHandle } from "../RenderWorkerStart.js";
import { game } from "../game/Context.js";
import { renderWorkerResultSteps } from "../game/Loop.js";
import { attachPortraitOutputs } from "../ui/Portraits.js";
import { gatewayInput } from "../ui/Dom.js";

let worldCanvas: HTMLCanvasElement | undefined;

/** The world canvas in the page now (another element after a fallback). */
export function worldRendererCanvas(fallback: HTMLCanvasElement): HTMLCanvasElement {
  return worldCanvas ?? fallback;
}

/** The in-page renderer, as main.ts builds it without the flag. */
function inPageRenderer(canvas: HTMLCanvasElement): WorldRenderer3D {
  const renderer = new WorldRenderer3D(canvas);
  attachPortraitOutputs(renderer); // 22.10 ARC-2 S3b: the page paints the portrait canvases
  return renderer;
}

/** A canvas that can draw again: the same element's id, classes and attributes, in its place. */
function freshCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  for (const attribute of old.getAttributeNames()) canvas.setAttribute(attribute, old.getAttribute(attribute) ?? "");
  old.replaceWith(canvas);
  worldCanvas = canvas;
  return canvas;
}

function hostValues(canvas: HTMLCanvasElement): RenderWorkerHostValues {
  return { ...pageHostValues(canvas, window.devicePixelRatio, location.search), pageHidden: document.hidden,
    frameLimit: frameLimit() }; // 25.10
}

/**
 * The world renderer under `?renderworker=1`: the worker's proxy when the browser can run one, else (or when it
 * cannot start) the in-page renderer. Throws only as the in-page constructor throws (no WebGL).
 */
export function mountWorldRenderWorker(canvas: HTMLCanvasElement): ClientRenderer {
  worldCanvas = canvas;
  if (!renderWorkerSupported()) {
    console.warn("[render worker] OffscreenCanvas or module workers missing; drawing in the page");
    return inPageRenderer(canvas);
  }
  const unwatch: Array<() => void> = [];
  const client = startRenderWorker({
    canvas,
    createWorker: () => new Worker(new URL("../RenderWorker.worker.ts", import.meta.url), {
      type: "module", name: "world-renderer",
    }) as RenderWorkerHandle,
    host: () => hostValues(canvas),
    baseUrl: location.origin,
    gatewayGeneration: gatewayGenerationPush(),
    mainTimeOrigin: performance.timeOrigin,
    client: { clientsUrl: () => gatewayInput.value || undefined, steps: renderWorkerResultSteps() },
    fallback: (reason, failed) => {
      for (const stop of unwatch.splice(0)) stop();
      console.warn(`[render worker] ${reason}; drawing in the page again`);
      let renderer: WorldRenderer3D | undefined;
      const fresh = freshCanvas(canvas);
      try {
        renderer = inPageRenderer(fresh);
        failed.replayOnto(renderer);
      } catch (error) {
        fresh.hidden = true;
        console.warn("WebGL renderer unavailable", error);
      }
      if (game.renderer === failed) game.renderer = renderer;
    },
  });
  if (client === undefined) return inPageRenderer(freshCanvas(canvas));
  // The page's reads, pushed whenever they may have changed: a layout, a pixel ratio, the tab's visibility.
  const push = () => client.postHost(hostValues(canvas));
  const observer = new ResizeObserver(push);
  observer.observe(canvas);
  window.addEventListener("resize", push);
  document.addEventListener("visibilitychange", push);
  unwatch.push(onFrameLimitChange(push)); // 25.10
  unwatch.push(() => observer.disconnect(), () => window.removeEventListener("resize", push),
    () => document.removeEventListener("visibilitychange", push));
  return client;
}
