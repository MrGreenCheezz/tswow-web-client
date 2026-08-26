import { MIRROR_TIMER_NAMES, mirrorTimerRemaining } from "../../world/MirrorTimerProtocol.js";
import { game } from "../game/Context.js";
import { Bar } from "./Widgets.js";

/**
 * Breath, fatigue and fire: the three bars the world runs against the character.
 *
 * They belong to the swimming work rather than to the interface slices, because a character that
 * can now dive can now drown, and the only warning the game gives is this bar. The server sends
 * one packet per timer and expects the bar to keep moving on its own, which is why the frame loop
 * runs them rather than the packet handler.
 */
let strip: HTMLElement | undefined;
const bars = new Map<number, { root: HTMLElement; bar: Bar }>();

function container(): HTMLElement {
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "mirror-timers";
    document.getElementById("world-viewport")?.append(strip);
  }
  return strip;
}

function barFor(timer: number): { root: HTMLElement; bar: Bar } {
  const known = bars.get(timer);
  if (known) return known;
  const root = document.createElement("div");
  root.className = "mirror-timer";
  const label = document.createElement("strong");
  label.textContent = MIRROR_TIMER_NAMES[timer] ?? `Таймер ${timer}`;
  const bar = new Bar({ kind: "mirror", text: true });
  root.append(label, bar.root);
  container().append(root);
  const created = { root, bar };
  bars.set(timer, created);
  return created;
}

/** Called once a frame: a timer the server started runs down here, not there. */
export function updateMirrorTimers(now: number): void {
  const timers = game.world?.mirrorTimers;
  if (!timers || timers.size === 0) {
    if (strip) strip.hidden = true;
    return;
  }
  container().hidden = false;
  for (const [type, held] of bars) {
    if (!timers.has(type)) {
      held.root.remove();
      bars.delete(type);
    }
  }
  for (const [type, held] of timers) {
    const remaining = mirrorTimerRemaining(held.timer, held.receivedAt, now);
    const { bar } = barFor(type);
    bar.set(remaining, held.timer.maxValue, `${Math.ceil(remaining / 1000)} с`);
  }
}
