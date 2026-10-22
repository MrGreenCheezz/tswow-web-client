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
