/**
 * 22.10 ARC-2 S4b: the page applies the renderer's reports (RendererReports.ts) to its own singletons after a frame:
 * the limiter times into the frame-budget sensor's open period, the GPU timer events into the benchmark observer,
 * the failed image URLs into the patch-chain check. Called before the next frame starts, so a period closes with
 * the renderer's share in it. In the page the lists are empty: the renderer writes these singletons itself.
 */

import { frameBudgetProbe } from "../FrameBudgetProbe.js";
import { suspectPatchChainChange } from "../PatchChainChanged.js";
import { renderBenchmarkGpuObserver } from "../RenderBenchmarkRuntime.js";
import { drainPatchChainSuspects, mergeRendererBudget, replayGpuEvents } from "../RendererReports.js";
import type { RenderResults } from "../RenderResults.js";

export function acceptRendererReports(results: RenderResults | undefined): void {
  if (results === undefined) return;
  mergeRendererBudget(results, frameBudgetProbe);
  replayGpuEvents(results, renderBenchmarkGpuObserver);
  drainPatchChainSuspects(results, suspectPatchChainChange);
}
