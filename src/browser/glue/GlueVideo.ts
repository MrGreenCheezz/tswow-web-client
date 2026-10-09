import type { GlueVideoCaps } from "./GlueApi.js";

/**
 * The browser's own answers to the glue video queries (10.19): the rate the page is painted at,
 * measured over ~30 animation frames, and WebGL2's `MAX_SAMPLES`, read once from a throwaway
 * context that is released straight after. Both are cached; before the measurement ends the rate
 * is 60, which is what the constant stub said.
 */
export function browserGlueVideo(scope: Window & typeof globalThis = window): GlueVideoCaps {
  let rate = 60;
  let samples: number | undefined;
  if (typeof scope.requestAnimationFrame === "function") {
    const stamps: number[] = [];
    const step = (time: number): void => {
      stamps.push(time);
      if (stamps.length < 31) {
        scope.requestAnimationFrame(step);
        return;
      }
      const span = stamps[stamps.length - 1]! - stamps[0]!;
      if (span > 0) rate = Math.round((stamps.length - 1) * 1000 / span);
    };
    scope.requestAnimationFrame(step);
  }
  return {
    refreshRate: () => rate,
    maxSamples: () => {
      if (samples !== undefined) return samples;
      samples = 1;
      try {
        const gl = scope.document.createElement("canvas").getContext("webgl2");
        if (gl) {
          samples = Number(gl.getParameter(gl.MAX_SAMPLES)) || 1;
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
      } catch {
        samples = 1;
      }
      return samples;
    },
  };
}
