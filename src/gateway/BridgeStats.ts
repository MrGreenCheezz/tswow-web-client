/**
 * Flow control for one bridged WebSocket ⇄ TCP pair, and what it measured (10.14).
 *
 * The bridge used to drop a session the moment the browser's send queue passed 4 MiB ("Client is
 * too slow"). On loopback that never happens; for a player on a slow line a burst of world traffic
 * (entering the world, a large `SMSG_COMPRESSED_UPDATE_OBJECT`) could, and the player lost the
 * session for being slow rather than for being gone. The bridge now stops *reading* the side that
 * is ahead instead: above `highBytes` queued for the slow side, the fast side's socket is paused,
 * and below `lowBytes` it is resumed. The worldserver then holds what it has not sent yet, which is
 * the place a TCP stream is meant to queue.
 *
 * A pause is not allowed to last for ever — a peer that has stopped reading entirely would keep the
 * pair (and the worldserver's own queue) alive indefinitely — so the session is still dropped when a
 * pause outlives `pauseLimitMs`, or when a queue somehow passes `hardLimitBytes` despite the pause
 * (a stream that is paused can deliver at most the chunk already in flight, so this is a guard
 * against a bug rather than a threshold anyone should meet).
 *
 * The thresholds are a hypothesis (WORK_PLAN 10.14 is tagged [гип.]): nobody has measured the real
 * peak on a remote player's line. `GATEWAY_LOG_BACKPRESSURE=1` prints one line per closed bridge with
 * the peak and the pauses so the owner can take that measurement before tuning them.
 */

export interface BridgeFlowLimits {
  /** Bytes queued for the slow side above which the other side stops being read. */
  readonly highBytes: number;
  /** Bytes queued below which a paused side is read again. */
  readonly lowBytes: number;
  /** A queue this large ends the session whatever the pause state (a guard, not a threshold). */
  readonly hardLimitBytes: number;
  /** A single pause longer than this ends the session: the slow side has stopped reading. */
  readonly pauseLimitMs: number;
  /** How often a paused bridge looks at its queue and at the clock. */
  readonly checkMs: number;
}

export const BRIDGE_FLOW_DEFAULTS: BridgeFlowLimits = Object.freeze({
  highBytes: 1024 * 1024,
  lowBytes: 256 * 1024,
  hardLimitBytes: 16 * 1024 * 1024,
  pauseLimitMs: 30_000,
  checkMs: 250,
});

/**
 * Merges an override onto the defaults and refuses a combination that cannot work.
 *
 * `lowBytes >= highBytes` would resume a pause straight away and `hardLimitBytes <= highBytes` would
 * drop the session before it was ever paused — both silently undo the item, so they throw instead.
 */
export function bridgeFlowLimits(override: Partial<BridgeFlowLimits> = {}): BridgeFlowLimits {
  const limits = { ...BRIDGE_FLOW_DEFAULTS, ...override };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Bridge flow limit ${name} must be a positive number`);
  }
  if (limits.lowBytes >= limits.highBytes) throw new RangeError("Bridge flow lowBytes must be below highBytes");
  if (limits.hardLimitBytes <= limits.highBytes) throw new RangeError("Bridge flow hardLimitBytes must be above highBytes");
  return Object.freeze(limits);
}

/** Which side of the bridge was too slow: the browser (`client`) or the auth/world server (`backend`). */
export type BridgeSide = "client" | "backend";

/** Counters for one bridge. Plain numbers; nothing in here allocates per packet. */
export class BridgeStats {
  /** Largest number of bytes seen queued towards the browser. */
  peakClientBytes = 0;
  /** Largest number of bytes seen queued towards the server. */
  peakBackendBytes = 0;
  clientPauses = 0;
  backendPauses = 0;
  pausedMs = 0;
  #pausedSince: number | undefined;

  observe(side: BridgeSide, bytes: number): void {
    if (side === "client") {
      if (bytes > this.peakClientBytes) this.peakClientBytes = bytes;
    } else if (bytes > this.peakBackendBytes) this.peakBackendBytes = bytes;
  }

  /** One side began a pause at `now`. Overlapping pauses are counted once in `pausedMs`. */
  paused(side: BridgeSide, now: number): void {
    if (side === "client") this.clientPauses++;
    else this.backendPauses++;
    this.#pausedSince ??= now;
  }

  /** No side is paused any more as of `now`. */
  resumed(now: number): void {
    if (this.#pausedSince === undefined) return;
    this.pausedMs += Math.max(0, now - this.#pausedSince);
    this.#pausedSince = undefined;
  }

  /**
   * One log line. Numbers and the bridge's kind only: no address, no account, no packet bytes —
   * the line is meant to be pasted into a report.
   */
  describe(kind: string, reason: string | undefined, now: number): string {
    this.resumed(now);
    const kib = (bytes: number) => `${Math.round(bytes / 1024)} KiB`;
    return `Gateway bridge ${kind} closed${reason ? ` (${reason})` : ""}: `
      + `peak to client ${kib(this.peakClientBytes)}, to server ${kib(this.peakBackendBytes)}; `
      + `pauses ${this.clientPauses} client / ${this.backendPauses} server, paused ${this.pausedMs} ms`;
  }
}
