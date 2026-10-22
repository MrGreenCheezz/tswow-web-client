/**
 * 22.10 ARC-2 S6b: whether the client draws its world in a worker (`?renderworker=1`, off by default) and the start of
 * one: the canvas's control goes to the worker (RenderWorker.worker.ts) with the page's host values, and the page gets
 * the proxy (RenderWorkerClient.ts). A worker that cannot start — its script fails to load, or its renderer throws
 * on `init` — hands the page back: `fallback` is told once, and the page draws in-page on a fresh canvas
 * (app/RenderWorkerMount.ts). Nothing here reads the page itself, so the test drives it with fakes.
 */

import type { GatewayGenerationPush } from "./GatewayGeneration.js";
import { RenderWorkerClient, type RenderWorkerClientOptions, type RenderWorkerPort } from "./RenderWorkerClient.js";
import type { ClientRenderDriver } from "./RenderWorkerClientProtocol.js";
import type { RenderWorkerHostValues, RenderWorkerInit } from "./RenderWorkerProtocol.js";

/** The page's flag: only `renderworker=1` turns it on. */
export function renderWorkerRequested(search: string): boolean {
  return new URLSearchParams(search).get("renderworker") === "1";
}

/**
 * 22.10 (12.14): the setting «Где рисуется мир» (ui/SettingsModel.ts `renderWorker`): 0 — by the device, 1 — in a
 * worker, 2 — in the page.
 */
export const RENDER_WORKER_AUTO = 0;
export const RENDER_WORKER_ON = 1;
export const RENDER_WORKER_OFF = 2;

/**
 * 22.10 (12.14): the desktop app — the development shell and the packed one (`tswow-webclient-desktop`) and the
 * player app (`wow-webclient-player`): Electron names itself and the app in the user agent. It pins the whole process to
 * the P-cores (electron/main.cjs), where the worker draws as fast as the page (PERF_STATUS, step 25: 55.5 against
 * 54.7 FPS); Chrome lets the worker fall to the E-cores (50.6 against 55.4), so a browser keeps the page.
 */
export function desktopAppUserAgent(userAgent: string): boolean {
  return /\bElectron\/|tswow-webclient-desktop|wow-webclient-player/.test(userAgent);
}

/**
 * 22.10 (12.14): whether the world is drawn in a worker: `?renderworker=1`/`0` first, then the setting, and by default
 * the desktop app does and a browser does not. A worker that cannot start or fails still hands the page back
 * (app/RenderWorkerMount.ts).
 */
export function renderWorkerChosen(search: string, setting: number | undefined, userAgent: string): boolean {
  const flag = new URLSearchParams(search).get("renderworker");
  if (flag === "1") return true;
  if (flag === "0") return false;
  if (setting === RENDER_WORKER_ON) return true;
  if (setting === RENDER_WORKER_OFF) return false;
  return desktopAppUserAgent(userAgent);
}

interface WorkerCapabilityScope {
  readonly OffscreenCanvas?: unknown;
  readonly HTMLCanvasElement?: { readonly prototype: object };
  readonly Worker?: new (url: string | URL, options?: WorkerOptions) => { terminate(): void };
}

/**
 * What a worker renderer needs of the browser: OffscreenCanvas, a canvas that can hand its control over, and module
 * workers (the renderer worker is an ES module and starts the pose and decode workers itself). A `type` the
 * constructor reads is the one way to ask for module workers without starting a module.
 */
export function renderWorkerSupported(scope: WorkerCapabilityScope = globalThis as WorkerCapabilityScope): boolean {
  if (typeof scope.OffscreenCanvas !== "function" || typeof scope.Worker !== "function") return false;
  if (typeof (scope.HTMLCanvasElement?.prototype as { transferControlToOffscreen?: unknown } | undefined)
    ?.transferControlToOffscreen !== "function") return false;
  let modules = false;
  const probe = { get type(): WorkerType { modules = true; return "module"; } };
  try {
    new scope.Worker("data:text/javascript,", probe as WorkerOptions).terminate();
  } catch {
    // A refused URL still read the option first.
  }
  return modules;
}

/** The worker as the page holds it (a Worker, or a fake). */
export interface RenderWorkerHandle extends RenderWorkerPort {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error" | "messageerror", listener: (event: Event) => void): void;
  terminate(): void;
}

export interface RenderWorkerStartOptions {
  readonly canvas: { transferControlToOffscreen(): OffscreenCanvas };
  readonly createWorker: () => RenderWorkerHandle;
  readonly host: () => RenderWorkerHostValues;
  readonly baseUrl: string;
  readonly gatewayGeneration: GatewayGenerationPush;
  readonly mainTimeOrigin: number;
  readonly client: RenderWorkerClientOptions;
  /** The worker failed after the start returned: told once; the proxy is closed and replays onto what replaces it. */
  readonly fallback: (reason: string, client: RenderWorkerClient) => void;
}

/**
 * The proxy of a started worker, or undefined when it could not even be started (no worker, the canvas refused the
 * transfer): then nothing was posted, `fallback` is not called, and the caller draws in-page on a fresh canvas.
 */
export function startRenderWorker(options: RenderWorkerStartOptions): RenderWorkerClient | undefined {
  let worker: RenderWorkerHandle;
  let offscreen: OffscreenCanvas;
  try {
    worker = options.createWorker();
  } catch (error) {
    console.warn("[render worker] not started", error);
    return undefined;
  }
  try {
    offscreen = options.canvas.transferControlToOffscreen();
  } catch (error) {
    worker.terminate();
    console.warn("[render worker] the canvas refused the transfer", error);
    return undefined;
  }
  const client = new RenderWorkerClient(worker, options.client);
  let failed = false;
  const fail = (reason: string): void => {
    if (failed) return;
    failed = true;
    client.close();
    try { worker.terminate(); } catch { /* already gone */ }
    options.fallback(reason, client);
  };
  client.onFailure = fail;
  worker.addEventListener("message", (event) => client.accept(event.data));
  worker.addEventListener("error", (event) => fail((event as ErrorEvent).message || "the render worker failed to start"));
  worker.addEventListener("messageerror", () => console.warn("[render worker] a message could not be read"));
  const init: RenderWorkerInit<ClientRenderDriver> = {
    type: "init", canvas: offscreen, host: options.host(), baseUrl: options.baseUrl,
    gatewayGeneration: options.gatewayGeneration, mainTimeOrigin: options.mainTimeOrigin, driver: { client: true },
  };
  worker.postMessage(init, [offscreen]);
  return client;
}
