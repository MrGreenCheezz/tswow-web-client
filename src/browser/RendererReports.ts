/**
 * 22.10 ARC-2 S4b: three page singletons the renderer used to write directly, now reported through RenderResults.ts
 * when the renderer runs in a realm of its own; the page applies each report to its singleton after the frame.
 *
 * * The frame-budget sensor (FrameBudgetProbe.ts): the renderer's limiters write their realm's sensor; a renderer
 *   with a sensor of its own (RenderHost `frameBudgetProbe`) moves what it spent into `budgetMs` at the end of each
 *   draw, and the page adds it into its open period before that period closes.
 * * The GPU timer's observer (RenderBenchmarkRuntime.ts `renderBenchmarkGpuObserver`): a renderer realm's host
 *   hands the timer `queuedGpuObserver`, and the page replays the events into the page's observer.
 * * The patch-chain suspicion of a failed image (PatchChainSuspect.ts): a renderer realm's sink queues the URL, and
 *   the page runs it through `suspectPatchChainChange`.
 *
 * In the page the renderer's host gives it the page's own objects, so these lists stay empty and nothing changes.
 * Plain data only (numbers, strings, a Float64Array), so the record can cross by `postMessage`.
 */

import type { FrameBudgetId, FrameBudgetProbe } from "./FrameBudgetProbe.js";
import type { GpuTimerDropReason, GpuTimerObserver, GpuTimerUnavailableReason } from "./GpuTimer.js";
import type { RenderResults } from "./RenderResults.js";

export type RenderGpuEvent =
  | { readonly kind: "sample"; readonly milliseconds: number }
  | { readonly kind: "unavailable"; readonly reason: GpuTimerUnavailableReason }
  | { readonly kind: "dropped"; readonly count: number; readonly reason: GpuTimerDropReason };

/** A page that stops draining (a hidden tab) must not grow these without end; the oldest are kept. */
export const RENDERER_REPORT_QUEUE_LIMIT = 1024;

// ---- the renderer's side ---------------------------------------------------------------------------------

/** End of a draw: what the renderer's own sensor spent since the last take, into the record. */
export function publishRendererBudget(probe: FrameBudgetProbe | undefined, results: RenderResults): void {
  if (probe !== undefined && probe.takeOpenPeriod(results.budgetMs)) results.budgetPending = true;
}

/** A GPU timer observer for a renderer realm: every event is queued for the page. */
export function queuedGpuObserver(results: RenderResults): GpuTimerObserver {
  const queue = (event: RenderGpuEvent): void => {
    if (results.gpuEvents.length < RENDERER_REPORT_QUEUE_LIMIT) results.gpuEvents.push(event);
  };
  return Object.freeze({
    onSample: (milliseconds: number) => queue({ kind: "sample", milliseconds }),
    onUnavailable: (reason: GpuTimerUnavailableReason) => queue({ kind: "unavailable", reason }),
    onDropped: (count: number, reason: GpuTimerDropReason) => queue({ kind: "dropped", count, reason }),
  });
}

/** A patch-chain sink for a renderer realm (PatchChainSuspect.ts `setPatchChainSuspectSink`). */
export function patchChainSuspectQueue(results: RenderResults): (url: string) => void {
  return (url) => {
    const queue = results.patchChainSuspects;
    if (queue.length < RENDERER_REPORT_QUEUE_LIMIT) queue.push(url);
  };
}

// ---- the page's side ---------------------------------------------------------------------------------------

/** Adds the renderer's waiting limiter times into the page's open period, once. */
export function mergeRendererBudget(results: RenderResults, probe: FrameBudgetProbe): void {
  if (!results.budgetPending) return;
  const spent = results.budgetMs;
  for (let id = 0; id < spent.length; id++) {
    const ms = spent[id]!;
    if (ms > 0) probe.addOutside(id as FrameBudgetId, ms);
  }
  spent.fill(0);
  results.budgetPending = false;
}

/** Replays the queued GPU events into `observer` in order, then empties the queue. */
export function replayGpuEvents(results: RenderResults, observer: Readonly<GpuTimerObserver>): void {
  const events = results.gpuEvents;
  if (events.length === 0) return;
  for (const event of events.splice(0)) {
    if (event.kind === "sample") observer.onSample?.(event.milliseconds);
    else if (event.kind === "unavailable") observer.onUnavailable?.(event.reason);
    else observer.onDropped?.(event.count, event.reason);
  }
}

/** Hands each queued URL to `suspect` in order, then empties the queue. */
export function drainPatchChainSuspects(results: RenderResults, suspect: (url: string) => void): void {
  const urls = results.patchChainSuspects;
  if (urls.length === 0) return;
  for (const url of urls.splice(0)) suspect(url);
}
