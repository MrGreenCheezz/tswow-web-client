// Where a lift (`GAMEOBJECT_TYPE_TRANSPORT`, type 11) is in its cycle — one answer for everything
// that reads it: the renderer draws the platform there, the physics stands the character on it
// (plan item 11.01, slice B; game/GameObjectColliders.ts), and a passenger another client reports on
// it is put on the car rather than on the spawn (`liftCarrierPose`, WorldState.carrierPoseProvider).
//
// The server never moves a lift. `GameObject::Update` only counts `PathProgress += diff` while the
// object is `GO_STATE_READY`, and the relocation that would follow is commented out
// (GameObject.cpp:520-554); its collision model stays at the spawn point. What it sends is two
// clocks: the create block's transport word, which for a lift is `GameTime::GetGameTimeMS()` — the
// worldserver's uptime, because only an MO transport is a `Transport` (Object.cpp:442-454, with the
// core's own TODO saying so) — and the high half of `GAMEOBJECT_DYNAMIC`, `int16(PathProgress %
// period / period × 65535)` (GameObject.cpp:2866-2873), in the create block and every values update.
//
// 11.01: Wow.exe runs a lift on the first and never reads the second. The GO constructor keeps
// `GO+0x200` = the block's word − the moment it was read (0x00714250); the lift's frame update takes
// `now + GO+0x200` as its time (0x007139e0, set up by 0x00711f20) and, for a lift without a pause
// (GAMEOBJECT_LEVEL = `transport.pause` = 0), the path time is that modulo the last keyframe's time
// (0x00710640). The callback on the phase word (0x0070cb60) calls the type's handler vt+0x2c, which
// for a lift's vtable (0x00a34808) is the bare `ret` 0x005eeb70. So every Wow.exe on the realm draws a
// lift at the same point of its path (the uptime is shared), and the offset a stock client sends from
// the car is measured on that point. The phase word is kept only for a block without the word,
// which the core never sends for a lift.
//
// The clock is anchored when the create block was read (`WorldObjectState.transportTimeAt`), not at
// the first frame that draws the lift: a page hidden through a loading screen gets no frames, and
// a lift anchored late runs late by the whole wait. A new create block is a new `WorldObjectState`,
// so it starts its own clock.
//
// Open, recorded rather than guessed: a lift with a pause (GAMEOBJECT_LEVEL ≠ 0, scripted elevators
// toggled by state) runs Wow.exe's state-driven branch of 0x00710640 (the path held at its ends by
// the GO state, 0x00710820), and the path's rotation (TransportRotation.dbc, 0x0070dc10) turns the
// car; neither is done here, as before.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState, WorldPosition, WorldState } from "../world/WorldState.js";
import { anchorShipClock, shipClockPhase, type ShipClock } from "./TransportMotion.js";
import { sampleTransportPath, type TransportPath } from "./TransportPath.js";

const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
/** `GAMEOBJECT_TYPE_TRANSPORT`, byte 1 of `GAMEOBJECT_BYTES_1`. */
const GO_TYPE_TRANSPORT = 11;

/** A lift's clock and the period it was anchored for. */
interface LiftClockEntry extends ShipClock {
  period: number;
}

/**
 * One clock per create block: a re-CREATE is a new object and starts its own. Another period (the
 * object's entry changed, and its path with it) starts one too, on the same word and read.
 */
const clocks = new WeakMap<WorldObjectState, LiftClockEntry>();

/** The clock of a lift's create block, anchored on first use; exported for the tests. */
export function liftClock(object: WorldObjectState, period: number, now: number): ShipClock {
  let clock = clocks.get(object);
  if (clock === undefined || clock.period !== period) {
    // Anchored at the read of the create block when that is known and not ahead of this clock (a
    // benchmark replays on a clock of its own); otherwise now.
    const read = object.transportTime !== undefined ? object.transportTimeAt : undefined;
    const at = read !== undefined && read <= now ? read : now;
    clock = { ...anchorShipClock(object, object.transportTime, object.fields.get(DYNAMIC), period, at), period };
    clocks.set(object, clock);
  }
  return clock;
}

/** How far into its cycle the lift is at `now`, in [0, period). */
export function liftPhaseMs(object: WorldObjectState, period: number, now: number): number {
  if (!(period > 0)) return 0;
  return shipClockPhase(liftClock(object, period, now), now, period);
}

/** A lift's pose in the world: where it stands this frame and the spawn's facing (lifts do not turn). */
export interface LiftPose {
  x: number;
  y: number;
  z: number;
  orientation: number;
}

/**
 * Where the lift is at `now`, written into `out`: the spawn point plus the path offset turned by the
 * spawn's yaw (`placeOnTransportPath`; the core's commented-out relocation turns it the same way,
 * `Rz(o) · node + stationary`, GameObject.cpp:536-543 — the GO's tilt and parent rotation do not
 * enter it). A path with no frames is a lift that stands at its spawn. Undefined without a position.
 */
export function liftPoseAt(object: WorldObjectState, path: TransportPath, now: number, out: LiftPose): LiftPose | undefined {
  const base = object.position;
  if (!base) return undefined;
  out.orientation = base.orientation;
  if (!(path.period > 0) || path.frames.length === 0) {
    out.x = base.x;
    out.y = base.y;
    out.z = base.z;
    return out;
  }
  const offset = sampleTransportPath(path, liftPhaseMs(object, path.period, now));
  const cos = Math.cos(base.orientation);
  const sin = Math.sin(base.orientation);
  out.x = base.x + offset[0] * cos - offset[1] * sin;
  out.y = base.y + offset[0] * sin + offset[1] * cos;
  out.z = base.z + offset[2];
  return out;
}

/** The lifts' paths: `TransportPathClient` in the page (`/dbc/transport-paths`). */
export interface LiftPathSource {
  path(entry: number): TransportPath | undefined;
}

/**
 * 11.01: `WorldState.carrierPoseProvider` for lifts — a type 11 game object whose path has come is
 * placed on it (`liftPoseAt`); anything else, and a lift whose path is still on its way, is left to
 * its state position (undefined). Asking for a path starts its request, once per entry.
 */
export function liftCarrierPose(paths: LiftPathSource):
  (carrier: WorldObjectState, now: number, out: WorldPosition) => WorldPosition | undefined {
  return (carrier, now, out) => {
    if (carrier.typeId !== 5 || ((carrier.fields.get(BYTES_1) ?? 0) >>> 8 & 0xff) !== GO_TYPE_TRANSPORT) return undefined;
    const path = paths.path(carrier.fields.get(ENTRY) ?? 0);
    return path === undefined ? undefined : liftPoseAt(carrier, path, now, out);
  };
}

/** Every world mount (EnterWorld.ts): passengers on lifts are carried on the car. Returns the stop. */
export function startLiftCarriers(state: WorldState, paths: LiftPathSource | undefined): () => void {
  const provider = paths === undefined ? undefined : liftCarrierPose(paths);
  state.carrierPoseProvider = provider;
  return () => {
    if (state.carrierPoseProvider === provider) state.carrierPoseProvider = undefined;
  };
}
