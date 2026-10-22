/**
 * 22.10 ARC-2 live fix: the FPS counter's line (FpsCounter.ts). With a render worker the world has a rate of its own
 * (`RenderResults.fps`, the worker's cadence) and the page's rate is the interface's; both are shown, the world first.
 */
export function fpsCounterText(pageFps: number, averageMs: number, worstMs: number, worldFps?: number): string {
  const page = `кадр ${averageMs.toFixed(1)} мс · макс. ${worstMs.toFixed(1)} мс`;
  if (worldFps === undefined) return `${Math.round(pageFps)} FPS · ${page}`;
  return `мир ${Math.round(worldFps)} FPS · интерфейс ${Math.round(pageFps)} FPS · ${page}`;
}
