import type { TransportKeyframe, TransportPath } from "../gateway/TransportPaths.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { TransportKeyframe, TransportPath };

/**
 * How fast a keyframe pair may move before it is read as a cut rather than a journey.
 *
 * Four entries in this dataset — 193182 to 193185, the Icecrown gunships — end their cycle with a
 * two-frame segment that covers 1,309 to 1,346 units in 466 ms, which is 2,810 to 2,889 units a
 * second. That is not motion, it is the path returning to its start. Interpolated, the ship
 * crosses the zone in half a second every cycle. Against them, the 99th percentile of all 5,180
 * segments is 145 u/s and the fastest honest segment in the table is 168 (entry 183407, 11 units
 * in 66 ms), so a cut is anything an order of magnitude above what the rest of the table does.
 */
export const TRANSPORT_CUT_SPEED = 500;

/**
 * Where a lift stands at a moment in its cycle.
 *
 * Linear between keyframes, because the table is not dense enough to step through: the median gap
 * is 34 ms and one unit, but the ninetieth percentile is 45.9 units and the Deeprun Tram has a
 * single 315.9-unit gap. Sampling by nearest frame — which is what the core's own
 * `TransportAnimation::GetAnimNode` does with `lower_bound`, in code that never runs — would make
 * the tram jump the length of a station.
 *
 * The offset is in the object's own frame and always starts at the origin: all 82 entries have
 * their lowest-time frame at exactly (0,0,0), which is what makes it an offset from the spawn
 * point rather than a position.
 */
export function sampleTransportPath(path: TransportPath, timeMs: number): [number, number, number] {
  const frames = path.frames;
  if (frames.length === 0) return [0, 0, 0];
  if (frames.length === 1 || path.period <= 0) return frameOffset(frames[0]!);

  const time = ((timeMs % path.period) + path.period) % path.period;
  let index = 0;
  while (index + 1 < frames.length && frames[index + 1]!.time <= time) index++;
  const from = frames[index]!;
  const to = frames[index + 1];
  // Past the last keyframe: the cycle closes on the first one, which for 80 of the 82 entries is
  // the same point it started from.
  if (!to) return frameOffset(from);

  const span = to.time - from.time;
  if (span <= 0) return frameOffset(to);
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  // A cut: hold the frame the segment leaves from until the segment is over, then be at the next.
  if (distance / (span / 1000) > TRANSPORT_CUT_SPEED) return frameOffset(from);

  const fraction = (time - from.time) / span;
  return [
    from.x + (to.x - from.x) * fraction,
    from.y + (to.y - from.y) * fraction,
    from.z + (to.z - from.z) * fraction,
  ];
}

function frameOffset(frame: TransportKeyframe): [number, number, number] {
  return [frame.x, frame.y, frame.z];
}

/**
 * The world point an offset on the path lands on.
 *
 * Turn, then add — the composition the core spells out and never runs: `stationaryPosition +
 * Rz(spawn orientation) · (X, Y, Z)`. Adding first and turning after would swing every lift around
 * the map's origin instead of about its own shaft.
 */
export function placeOnTransportPath(
  base: { x: number; y: number; z: number; orientation: number },
  offset: readonly [number, number, number],
): { x: number; y: number; z: number } {
  const cos = Math.cos(base.orientation);
  const sin = Math.sin(base.orientation);
  return {
    x: base.x + offset[0] * cos - offset[1] * sin,
    y: base.y + offset[0] * sin + offset[1] * cos,
    z: base.z + offset[2],
  };
}

/** A transport's dynamic word carries no phase for anything that is not one, written as −1. */
const NO_PHASE = 0xffff;

/**
 * How far into its cycle a lift was when the client last heard about it.
 *
 * Two sources, and they are not interchangeable. The high half of `GAMEOBJECT_DYNAMIC` is the
 * phase as a fraction of the period — the core computes it as `uint16(timer / period * 65535)`
 * where `timer` is the path progress it keeps for itself — and is exactly what is wanted. The
 * create block's transport word is a fallback and means something different again: for a lift the
 * core writes `GameTime::GetGameTimeMS()` into it, the worldserver's uptime, because a type 11
 * object is not a `Transport` as far as `ToTransport()` is concerned. Taken modulo the period it
 * is still a shared phase, which is all that is needed for two clients to agree.
 *
 * The alternative — starting every lift from zero on the frame it comes into view — is what makes
 * one player watch a platform arrive while another watches it leave.
 */
export function transportPhaseMs(dynamic: number | undefined, transportTime: number | undefined, period: number): number {
  if (period <= 0) return 0;
  const phase = dynamic === undefined ? NO_PHASE : (dynamic >>> 16) & 0xffff;
  if (phase !== NO_PHASE) return (phase / 65535) * period;
  if (transportTime !== undefined) return transportTime % period;
  return 0;
}

/**
 * The paths of the lifts the player is standing near, by game object template entry.
 *
 * Asked for once per entry and cached either way: an entry the table does not know answers with an
 * empty path, which is the answer for every chest and door in the world and must not turn into a
 * request per frame.
 */
export class TransportPathClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #paths = new Map<number, TransportPath>();
  readonly #requested = new Set<number>();
  readonly #loading = new Set<number>();
  readonly #errors = new Set<number>();
  #revision = 0;
  #success = 0;
  #error = 0;

  /** Immutable exact request counters; the lifetime requested set is not active work. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      pending: this.#loading.size,
      success: this.#success,
      error: this.#errors.size,
      generation: this.#revision,
    });
  }

  get revision(): number {
    return this.#revision;
  }

  get generation(): number {
    return this.#revision;
  }

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** The path, or undefined until it lands. An entry that does not move answers with no frames. */
  path(entry: number): TransportPath | undefined {
    const known = this.#paths.get(entry);
    if (known) return known;
    if (entry > 0 && !this.#requested.has(entry)) {
      this.#requested.add(entry);
      this.#loading.add(entry);
      void this.#load(entry);
    }
    return undefined;
  }

  async #load(entry: number): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loading.delete(entry);
      this.#revision++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(`${this.#baseUrl}/dbc/transport-paths?entries=${entry}`);
      if (!response.ok) throw new Error(`Transport path gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error("Transport path gateway returned invalid data");
      for (const path of value) {
        if (!isPath(path)) throw new Error("Transport path gateway returned an invalid path");
        this.#paths.set(path.entry, path);
      }
      // An entry the gateway did not answer for still has to be remembered, or it is asked for
      // again on the next frame.
      if (!this.#paths.has(entry)) this.#paths.set(entry, { entry, period: 0, frames: [] });
      this.#errors.delete(entry);
      settle(true);
    } catch (error) {
      this.#paths.set(entry, { entry, period: 0, frames: [] });
      this.#errors.add(entry);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }
}

function isPath(value: unknown): value is TransportPath {
  if (!value || typeof value !== "object") return false;
  const path = value as Record<string, unknown>;
  if (typeof path.entry !== "number" || typeof path.period !== "number" || !Array.isArray(path.frames)) return false;
  return path.frames.every((frame: unknown) => {
    if (!frame || typeof frame !== "object") return false;
    const keyframe = frame as Record<string, unknown>;
    return ["time", "x", "y", "z"].every((key) => typeof keyframe[key] === "number" && Number.isFinite(keyframe[key]));
  });
}
