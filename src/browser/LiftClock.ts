// Where a lift (`GAMEOBJECT_TYPE_TRANSPORT`, type 11) is in its cycle — one answer for everything
// that reads it: the renderer draws the platform there, the physics stands the character on it
// (plan item 11.01, slice B; game/GameObjectColliders.ts).
//
// The server never moves a lift. `GameObject::Update` only counts `PathProgress += diff` while the
// object is `GO_STATE_READY`, and the relocation that would follow is commented out
// (GameObject.cpp:520-554); its collision model stays at the spawn point. What it sends is a phase:
// the high half of `GAMEOBJECT_DYNAMIC` is `int16(PathProgress % period / period × 65535)`
// (GameObject.cpp:2866-2873), carried by the create block and by every values update of the object
// (`_fieldNotifyFlags = UF_FLAG_DYNAMIC`, Object.cpp:85). The create block's transport word is
// `GameTime::GetGameTimeMS()` for a lift — the worldserver's uptime, not the lift's own timer,
// because only an MO transport is a `Transport` (Object.cpp:442-454, with the core's own TODO
// saying so). The dynamic word is preferred (`transportPhaseMs`); the uptime is the fallback.
// Which of the two Wow.exe reads is not settled — a live capture decides (spec 11.01, risk 4).
//
// The clock is anchored when the create block was read (`WorldObjectState.transportTimeAt`), not at
// the first frame that draws the lift: a page hidden through a loading screen gets no frames, and
// a lift anchored late runs late by the whole wait (the flaw A1 fixed for ships). A new create
// block is a new `WorldObjectState`, so it re-anchors by itself; a changed dynamic word in a values
// update corrects the running clock (`correctShipClock`, the same window rule as a ship's).
//
// Open, recorded rather than guessed: the core stops `PathProgress` while the lift is not READY
// (scripted elevators toggled by state); nothing here stops the drawn lift for that, as before.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { correctShipClock, dynamicPhaseWord, shipClockPhase, type ShipClock } from "./TransportMotion.js";
import { sampleTransportPath, transportPhaseMs, type TransportPath } from "./TransportPath.js";

const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;

/** A lift's clock and the period it was anchored for. */
interface LiftClockEntry extends ShipClock {
  period: number;
}

/**
 * One clock per create block: a re-CREATE is a new object and starts its own. Another period (the
 * object's entry changed, and its path with it) starts one too, as the renderer's own clock did.
 */
const clocks = new WeakMap<WorldObjectState, LiftClockEntry>();

/** The clock of a lift's create block, anchored on first use; exported for the tests. */
export function liftClock(object: WorldObjectState, period: number, now: number): ShipClock {
  let clock = clocks.get(object);
  const dynamic = object.fields.get(DYNAMIC);
  if (clock === undefined || clock.period !== period) {
    // Anchored at the read of the create block when that is known and not ahead of this clock (a
    // benchmark replays on a clock of its own); otherwise now, which is what the renderer did.
    // Review 11.01-B: only the first clock of a block counts from its read — a later one (another
    // period) takes the dynamic word as it stands now, which a values update may have written well
    // after the create block, so it counts from now.
    const read = clock === undefined ? object.transportTimeAt : undefined;
    const at = read !== undefined && read <= now ? read : now;
    clock = {
      object, progressMs: transportPhaseMs(dynamic, object.transportTime, period), at,
      dynamic: dynamicPhaseWord(dynamic), corrections: 0, period,
    };
    clocks.set(object, clock);
  } else correctShipClock(clock, dynamic, period, now);
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
