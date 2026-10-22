import { FrameCadenceClock } from "../RenderStats.js";
import { worldPanel } from "./Dom.js";
import { fpsCounterText } from "./FpsCounterText.js"; // 22.10 ARC-2 live fix

const UPDATE_INTERVAL_MS = 500;
const cadence = new FrameCadenceClock();
let counter: HTMLDivElement | undefined;
let enabled = false;
let shownAt = 0;

function reset(): void {
  cadence.reset();
  shownAt = 0;
  if (counter) counter.textContent = "FPS — · кадр — мс · макс. — мс";
}

/** Settings and key bindings share this switch; the game loop owns all sampling. */
export function setFpsCounterVisible(visible: boolean): void {
  if (enabled === visible) return;
  enabled = visible;
  if (visible && !counter) {
    counter = document.createElement("div");
    counter.id = "fps-counter";
    counter.className = "fps-counter";
    counter.setAttribute("aria-live", "off");
    worldPanel.append(counter);
    // A suspended tab may receive no RAF at all. Rebase at the visibility boundary so its
    // time away cannot appear as a multi-second game hitch after returning.
    document.addEventListener("visibilitychange", reset);
  }
  reset();
  if (counter) counter.hidden = !visible || worldPanel.hidden || document.hidden;
}

/**
 * Called by the existing RAF loop. Hidden/disabled counters collect no samples or DOM updates.
 * 22.10 ARC-2 live fix: `worldFps` is the world's own rate when a render worker draws it; the page's rate measured
 * here is then the HUD's alone, and read as the world's it showed 60 for a world drawn at 50.
 */
export function updateFpsCounter(now: number, active: boolean, worldFps?: number): void {
  if (!enabled || !counter) return;
  if (!active) {
    if (!counter.hidden) {
      counter.hidden = true;
      reset();
    }
    return;
  }
  if (counter.hidden) {
    reset();
    counter.hidden = false;
  }
  if (cadence.observe(now) === undefined || now - shownAt < UPDATE_INTERVAL_MS) return;
  shownAt = now;
  const frames = cadence.snapshot();
  if (frames.average <= 0) return;
  counter.textContent = fpsCounterText(cadence.fps, frames.average, frames.worst, worldFps);
}
