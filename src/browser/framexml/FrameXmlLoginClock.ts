/** Wait for the realm clock before stock GameTime.lua runs its OnLoad arithmetic. */
export interface FrameXmlLoginClockWaitOptions<T> {
  /** Read only the clock belonging to the WorldClient being mounted. */
  readonly read: () => T | null | undefined;
  /** False when the mount epoch or WorldClient identity has changed. */
  readonly stillCurrent: () => boolean;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injected for deterministic tests; defaults to the monotonic browser clock. */
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export type FrameXmlLoginClockWaitResult<T> =
  | { readonly status: "ready"; readonly clock: T }
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" };

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => { globalThis.setTimeout(resolve, delayMs); });
}

/**
 * Login resolves on SMSG_LOGIN_VERIFY_WORLD, but the authoritative
 * SMSG_LOGIN_SET_TIME_SPEED arrives later. The stock GameTimeFrame's OnLoad
 * immediately multiplies GetGameTime's hour, so loading before that packet
 * would raise a Lua error. Do not synthesize a local time on timeout.
 */
export async function waitForFrameXmlLoginClock<T>(
  options: FrameXmlLoginClockWaitOptions<T>,
): Promise<FrameXmlLoginClockWaitResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0
    || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("FrameXML login clock wait requires a nonnegative timeout and positive poll interval");
  }
  const now = options.now ?? (() => performance.now());
  const wait = options.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  for (;;) {
    // Check before every read, including the first one: a stale world must never publish a VM.
    if (!options.stillCurrent()) return { status: "cancelled" };
    const clock = options.read();
    if (clock !== null && clock !== undefined) return { status: "ready", clock };
    const remaining = deadline - now();
    if (remaining <= 0) return { status: "timeout" };
    await wait(Math.min(pollIntervalMs, remaining));
  }
}
