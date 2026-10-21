/**
 * 22.10 ARC-2 S4a: the one place an absolute time crosses between the main thread and the world renderer.
 *
 * Packet-timed plans (spell visual `startedAt`/`endsAt`/`at`, `retimeSpellVisual`'s end) are main-thread
 * `performance.now()` values; the renderer's own frame `now` is its own `performance.now()`. In the page the two
 * clocks are one, so the offset is 0 and every conversion is the identity. A DedicatedWorker has its own time
 * origin: the worker slice sets the offset once (main origin − worker origin) and nothing else changes.
 */

import type { SpellVisualPlan } from "./SpellVisuals.js";

/** Render time minus main time for the same instant; 0 in the page. */
let renderClockOffset = 0;

/** 22.10 ARC-2 S4a: for the worker host (and tests). */
export function setRenderClockOffset(offsetMs: number): void {
  renderClockOffset = Number.isFinite(offsetMs) ? offsetMs : 0;
}

/** A main-thread absolute time on the renderer's clock. Non-finite values (an open end) pass through. */
export function toRenderTime(mainTime: number): number {
  return mainTime + renderClockOffset;
}

/** A renderer absolute time on the main thread's clock (RenderResults.ts `swingNow`). */
export function toMainTime(renderTime: number): number {
  return renderTime - renderClockOffset;
}

/**
 * Every absolute time of a spell visual plan onto the renderer's clock, in place (the plan is the renderer's own
 * copy once it crosses by `postMessage`). The identity — and no walk — in the page.
 */
export function planToRenderTime(plan: SpellVisualPlan): SpellVisualPlan {
  if (renderClockOffset === 0) return plan;
  for (const instance of plan.instances) {
    instance.startedAt = toRenderTime(instance.startedAt);
    instance.endsAt = toRenderTime(instance.endsAt);
  }
  for (const animation of plan.animations) animation.at = toRenderTime(animation.at);
  // The sounds stay on the main thread (the renderer never plays them), so they keep the main clock.
  if (plan.beams) {
    for (const beam of plan.beams) {
      (beam as { startedAt: number }).startedAt = toRenderTime(beam.startedAt);
      beam.endsAt = toRenderTime(beam.endsAt);
    }
  }
  if (plan.shakes) for (const shake of plan.shakes) shake.at = toRenderTime(shake.at);
  return plan;
}
