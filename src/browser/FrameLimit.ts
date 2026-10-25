/**
 * 25.10: the frame limit («Ограничение кадров»), shared by the page's loop (game/Loop.ts), the stock
 * interface's step (framexml/FrameXmlWorldMount.ts) and the render worker (RenderWorkerSession.ts).
 *
 * Since ARC-2 the world and the interface run as separate animation-frame loops, and nothing held
 * either below the display's refresh: on a 144 Hz monitor both ran 144 times a second, two threads
 * and the GPU process busy whatever the frame cost — a cheaper frame only bought more of them. A
 * loop asks `due(time)` on each animation frame and skips its work when the answer is no; the
 * accepted frames stay on vsync, so 72 on a 144 Hz display is every other refresh.
 *
 * A hidden page (minimised window; Electron keeps rendering it, electron/main.cjs) runs at
 * `HIDDEN_FPS`, enough for packets, state and the interface to keep up.
 */

import { pageHidden } from "./PageVisibility.js";

/** The setting's default: half of 144 Hz, above 60 Hz displays. 0 means the display's own rate. */
export const DEFAULT_FRAME_LIMIT = 72;
export const HIDDEN_FPS = 10;
/**
 * A refresh lands within this of its slot (at most this share of the interval); the limiter must not
 * wait a whole extra vsync for jitter, nor take a refresh that is really a slot early.
 */
const SLOT_TOLERANCE_MS = 2;
const SLOT_TOLERANCE_SHARE = 0.15;

// Unlimited until the page's settings apply (ui/Settings.ts) or the page pushes it to the worker:
// the benches' pages and workers never set it.
let limitFps = 0;
const listeners = new Set<() => void>();

/** The page's settings apply and the worker's host push set it; listeners forward it to the worker. */
export function setFrameLimit(fps: number): void {
  const next = Number.isFinite(fps) && fps > 0 ? fps : 0;
  if (next === limitFps) return;
  limitFps = next;
  for (const listener of listeners) listener();
}

export function frameLimit(): number {
  return limitFps;
}

/** `?framelimit=N` wins over the setting (0 = the display's rate), for measurements. */
export function frameLimitOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("framelimit");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function onFrameLimitChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The rate a loop runs at now: the limit, or the hidden rate when that is lower; 0 is unlimited. */
export function effectiveFrameLimit(hidden: boolean = pageHidden(), limit: number = limitFps): number {
  if (!hidden) return limit;
  return limit > 0 ? Math.min(limit, HIDDEN_FPS) : HIDDEN_FPS;
}

/** One loop's pacing. Each loop has its own; fed the same timestamps, they agree. */
export class FrameLimiter {
  #slot = Number.NEGATIVE_INFINITY;
  readonly #rate: () => number;

  constructor(rate: () => number = effectiveFrameLimit) {
    this.#rate = rate;
  }

  /** Whether the loop works on the animation frame at `time` (ms). */
  due(time: number): boolean {
    const fps = this.#rate();
    if (!(fps > 0)) {
      this.#slot = time;
      return true;
    }
    const interval = 1000 / fps;
    if (time - this.#slot < interval - Math.min(SLOT_TOLERANCE_MS, interval * SLOT_TOLERANCE_SHARE)) return false;
    // Keep the phase so 60 on 144 Hz alternates 2 and 3 refreshes (60 on average), not 3 (48);
    // after a stall, start again from now rather than running a burst to catch up.
    this.#slot = time - this.#slot > interval * 2 ? time : this.#slot + interval;
    return true;
  }
}
