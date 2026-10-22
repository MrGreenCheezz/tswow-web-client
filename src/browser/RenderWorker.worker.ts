/**
 * 22.10 ARC-2 S6b: the client's world renderer worker (`?renderworker=1`, RenderWorkerStart.ts). `init` brings the
 * page's canvas as an OffscreenCanvas, the host values, the page's time origin and gateway generation; the renderer is
 * built on them (WorkerRenderHost.ts) and RenderWorkerSession.ts takes every later message. Errors the worker goes on
 * after are logged on the page; a failed start is the page's cue to draw in-page again.
 */

import { WorldRenderer3D } from "./WorldRenderer3D.js";
import { frameBudgetProbe } from "./FrameBudgetProbe.js";
import { applyGatewayGenerationPush } from "./GatewayGeneration.js";
import { setPatchChainSuspectSink } from "./PatchChainSuspect.js";
import { patchChainSuspectQueue } from "./RendererReports.js";
import { setRenderClockOffset } from "./RenderClock.js";
import { setPushedPageHidden } from "./PageVisibility.js";
import { WorkerRenderHost } from "./WorkerRenderHost.js";
import type { PageToRenderWorker, RenderWorkerInit, RenderWorkerToPage } from "./RenderWorkerProtocol.js";
import type { ClientRenderDriver, ClientRenderResults, RenderWorkerLog } from "./RenderWorkerClientProtocol.js";
import { RenderWorkerSession, type RenderWorkerMessage } from "./RenderWorkerSession.js";

interface WorkerScope {
  postMessage(message: RenderWorkerToPage | ClientRenderResults | RenderWorkerLog, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "unhandledrejection", listener: (event: PromiseRejectionEvent) => void): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  crossOriginIsolated?: boolean;
}

const scope = globalThis as unknown as WorkerScope;
const errorText = (error: unknown) => String((error as Error)?.stack ?? error);
let session: RenderWorkerSession | undefined;
let failed = false;

scope.addEventListener("message", (event) => {
  const data = event.data as PageToRenderWorker | RenderWorkerMessage;
  if (failed) return;
  if (data.type === "init") {
    try {
      session = start(data as RenderWorkerInit<ClientRenderDriver>);
      scope.postMessage({ type: "ready", crossOriginIsolated: scope.crossOriginIsolated === true });
    } catch (error) {
      failed = true;
      scope.postMessage({ type: "error", message: errorText(error) });
    }
    return;
  }
  if (session === undefined) {
    scope.postMessage({ type: "log", message: `${data.type} before init` });
    return;
  }
  try {
    session.handle(data as RenderWorkerMessage);
  } catch (error) {
    scope.postMessage({ type: "log", message: errorText(error) });
  }
});
// The page logs what the worker survives, as its console would have shown it in-page; nothing reaches the
// worker's `error` event on the page, which is kept for a worker that could not start at all.
scope.addEventListener("error", (event) => {
  event.preventDefault();
  scope.postMessage({ type: "log", message: String(event.message) });
});
scope.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  scope.postMessage({ type: "log", message: errorText(event.reason) });
});

function start(init: RenderWorkerInit<ClientRenderDriver>): RenderWorkerSession {
  // Render time minus main time for one instant (RenderClock.ts).
  setRenderClockOffset(init.mainTimeOrigin - performance.timeOrigin);
  applyGatewayGenerationPush(init.gatewayGeneration);
  setPushedPageHidden(init.host.pageHidden);
  const host = new WorkerRenderHost(init.host, frameBudgetProbe);
  const renderer = new WorldRenderer3D(init.canvas, host);
  setPatchChainSuspectSink(patchChainSuspectQueue(renderer.results));
  return new RenderWorkerSession({
    postMessage: (message, transfer) => scope.postMessage(message, transfer),
    requestAnimationFrame: (callback) => scope.requestAnimationFrame(callback),
  }, host, renderer);
}
