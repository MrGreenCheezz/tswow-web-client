/**
 * 22.10 ARC-2 live fix: the FPS counter's line (FpsCounter.ts). With a render worker the world has a rate of its own
 * (`RenderResults.fps`, the worker's cadence) and the page's rate is the interface's; both are shown, the world first.
 *
 * 25.10 (12.14): and what one world frame cost the processor (`worldCpuMs`, the renderer's begin→end span averaged over
 * the line's half second, in the worker or in the page). When 1000 / FPS of the world is about that number, the frame
 * is processor-bound; when it is much longer, the frame waits for something else (the display, the video card).
 */
export function fpsCounterText(pageFps: number, averageMs: number, worstMs: number, worldFps?: number,
  worldCpuMs?: number): string {
  const page = `кадр ${averageMs.toFixed(1)} мс · макс. ${worstMs.toFixed(1)} мс`;
  const cpu = worldCpuMs === undefined ? "" : ` · ЦП мира ${worldCpuMs.toFixed(1)} мс`;
  if (worldFps === undefined) return `${Math.round(pageFps)} FPS${cpu} · ${page}`;
  return `мир ${Math.round(worldFps)} FPS${cpu} · интерфейс ${Math.round(pageFps)} FPS · ${page}`;
}

/** 25.10 (12.14): the renderer's CPU per world frame, summed between two lines of the counter. */
export class WorldCpuWindow {
  #sum = 0;
  #count = 0;

  note(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.#sum += milliseconds;
    this.#count++;
  }

  /** The mean since the last take (undefined when no world frame was drawn), and a fresh window. */
  take(): number | undefined {
    const mean = this.#count === 0 ? undefined : this.#sum / this.#count;
    this.reset();
    return mean;
  }

  reset(): void {
    this.#sum = 0;
    this.#count = 0;
  }
}
