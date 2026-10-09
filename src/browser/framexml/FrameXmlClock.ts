/**
 * 3.27 (03.10, L5): the clock behind FrameXML's `GetTime()`, the frame step's `pump.now()` and the
 * renderer's cooldown sweep — one function, so a cooldown that started "now" is drawn as started.
 *
 * Wow.exe 3.3.5a (12340) `GetTime` (0x006081f0; notes .runtime/re-2026-10-03/l5-runtime/g1.c, g3.c)
 * answers the OS millisecond counter (0x0086ae20 → 0x0086adc0: QueryPerformanceCounter or
 * GetTickCount, so time since the machine started) times 0.001 (0x009e56b0): whole milliseconds,
 * read on every call, never earlier than the call before. Here it was `Date.now() / 1000`, which a
 * change of the system time moves backwards or forwards. Now it is the page's monotonic clock —
 * `performance.timeOrigin + performance.now()` — in whole milliseconds, held so that it never goes
 * back. The size stays Date.now()'s (seconds since 1970), as before: add-ons keep `GetTime()` values
 * only relative to other `GetTime()` values, and host code turns world times into these units
 * through `pump.now()`.
 */

/** Milliseconds, as `performance.timeOrigin + performance.now()` counts them. */
export type FrameXmlClockSource = () => number;

function pageMilliseconds(): number {
  if (typeof performance === "object" && typeof performance.now === "function"
    && typeof performance.timeOrigin === "number") {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

/** A `GetTime()` clock: seconds in whole milliseconds that never go back. */
export function createFrameXmlClock(source: FrameXmlClockSource = pageMilliseconds): () => number {
  let last = Number.NEGATIVE_INFINITY;
  return (): number => {
    const milliseconds = Math.floor(source());
    if (milliseconds > last) last = milliseconds;
    return last === Number.NEGATIVE_INFINITY ? 0 : last / 1000;
  };
}
