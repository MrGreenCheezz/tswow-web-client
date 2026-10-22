/**
 * 22.10 (12.14): the loading curtain's question to a render worker (ui/LoadingScreen.ts): how many frames in a row it
 * has drawn with its own terrain answered under the view subject, on this map and terrain tile
 * (RenderWorkerLoading.ts `RenderWorkerReadinessTracker`). Undefined while the world is drawn in the page.
 */

import { game } from "../game/Context.js";

export function workerCurtainFrames(map: number, x: number, y: number): number | undefined {
  return game.renderer?.renderWorker?.drawReadiness.framesReadyAt(map, x, y);
}
