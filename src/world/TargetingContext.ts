import type { WorldClient } from "./WorldClient.js";
import type { WorldObjectState, WorldPosition } from "./WorldState.js";

/**
 * Who the player acts through.
 *
 * `WorldClient.controlledGuid` is the unit the server lets this client move: its own
 * character, or whatever it is possessing/charming/boarding (`SMSG_CLIENT_CONTROL_UPDATE`).
 * The interface historically read `state.selfGuid` directly, so a possessed character kept
 * targeting, tabbing and casting from its own body while the server moved another.
 */
export function casterGuid(world: WorldClient): bigint | undefined {
  return world.controlledGuid ?? world.state.selfGuid;
}

export function casterObject(world: WorldClient): WorldObjectState | undefined {
  const guid = casterGuid(world);
  return guid === undefined ? undefined : world.state.objects.get(guid);
}

export function casterPosition(world: WorldClient): WorldPosition | undefined {
  return casterObject(world)?.position;
}

/**
 * The transport the caster rides, if any.
 *
 * `WorldState` keeps it per object because boats move passengers with no network output.
 * SpellCastTargets writes a packed transport GUID before each location. A nonzero GUID means
 * its coordinates are transport-local offsets; world positions must use zero instead.
 */
export function casterTransportGuid(world: WorldClient): bigint {
  const caster = casterObject(world);
  const seat = caster?.transport;
  if (!seat) return 0n;
  // `TransportSeat` carries the carrier guid; fall back to zero when the shape is unknown.
  const guid = (seat as { guid?: bigint; transportGuid?: bigint }).guid
    ?? (seat as { transportGuid?: bigint }).transportGuid;
  return typeof guid === "bigint" ? guid : 0n;
}

export interface TargetingContext {
  readonly casterGuid: bigint | undefined;
  readonly caster: WorldObjectState | undefined;
  readonly position: WorldPosition | undefined;
  readonly transportGuid: bigint;
  readonly selectedGuid: bigint | undefined;
  readonly selected: WorldObjectState | undefined;
}

export function targetingContext(world: WorldClient): TargetingContext {
  const guid = casterGuid(world);
  const caster = guid === undefined ? undefined : world.state.objects.get(guid);
  const selected = world.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid);
  return {
    casterGuid: guid,
    caster,
    position: caster?.position,
    transportGuid: casterTransportGuid(world),
    selectedGuid: world.targetGuid,
    selected,
  };
}
