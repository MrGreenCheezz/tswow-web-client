import type { ForcedSpeedName } from "./MovementAckProtocol.js";

/**
 * M7-0: what the server has forced on one mover, kept by the guid the server named.
 *
 * Every `SMSG_FORCE_*_SPEED_CHANGE` and `SMSG_MOVE_*` toggle names a unit, and TrinityCore takes
 * the acknowledgement for any unit this client is allowed to move (`GameClient::IsAllowedToMove`,
 * `MovementHandler.cpp:439-444`), not only for the active one: a buff that ends on the character
 * while a vehicle is driven is acknowledged by the character. So the state lives per guid, and the
 * character's own record is the very object `WorldClient.movementState` / `speeds` always were.
 */
export interface MoverMovementState {
  rooted: boolean;
  waterWalking: boolean;
  featherFall: boolean;
  hovering: boolean;
  canFly: boolean;
  gravityDisabled: boolean;
  /** From `SMSG_MOVE_SET_COLLISION_HGT`; 0 while the model's own height applies. */
  collisionHeight: number;
}

export interface MoverState {
  readonly speeds: Map<ForcedSpeedName, number>;
  readonly movement: MoverMovementState;
}

export function newMoverMovementState(): MoverMovementState {
  return {
    rooted: false, waterWalking: false, featherFall: false, hovering: false,
    canFly: false, gravityDisabled: false, collisionHeight: 0,
  };
}

/** One toggle, by the name `MOVEMENT_TOGGLES` gives it. Each pair is a state and its undoing. */
export function applyMovementToggle(state: MoverMovementState, name: string, value: number | undefined): void {
  if (name === "root") state.rooted = true;
  else if (name === "unroot") state.rooted = false;
  else if (name === "waterWalk") state.waterWalking = true;
  else if (name === "landWalk") state.waterWalking = false;
  else if (name === "featherFall") state.featherFall = true;
  else if (name === "normalFall") state.featherFall = false;
  else if (name === "hover") state.hovering = true;
  else if (name === "unsetHover") state.hovering = false;
  else if (name === "canFly") state.canFly = true;
  else if (name === "cannotFly") state.canFly = false;
  else if (name === "gravityOff") state.gravityDisabled = true;
  else if (name === "gravityOn") state.gravityDisabled = false;
  else if (name === "collisionHeight") state.collisionHeight = value ?? 0;
}

/**
 * The record for `guid`, created on first use. The character's own is the pair handed in, so code
 * and tests that read `WorldClient.movementState` and `speeds` keep seeing the same objects.
 */
export function moverStateOf(
  states: Map<bigint, MoverState>, guid: bigint, selfGuid: bigint | undefined,
  selfSpeeds: Map<ForcedSpeedName, number>, selfMovement: MoverMovementState,
): MoverState {
  if (guid === selfGuid) {
    const own = states.get(guid);
    if (own && own.speeds === selfSpeeds && own.movement === selfMovement) return own;
    const record = { speeds: selfSpeeds, movement: selfMovement };
    states.set(guid, record);
    return record;
  }
  let record = states.get(guid);
  if (!record || record.speeds === selfSpeeds) {
    // A record that was the character's under an earlier selfGuid is not this unit's.
    record = { speeds: new Map(), movement: newMoverMovementState() };
    states.set(guid, record);
  }
  return record;
}

/**
 * M7-0: whether `SMSG_CLIENT_CONTROL_UPDATE(refused, 0)` takes control away. Only from the unit it
 * names: a late refusal of a vehicle already left must not stop the character. Before any allowance
 * the implicit mover is the character claimed at login.
 */
export function refusalTakesControl(
  controlled: bigint | undefined, movementReady: boolean, selfGuid: bigint | undefined, refused: bigint,
): boolean {
  const current = controlled ?? (movementReady ? selfGuid : undefined);
  return current === undefined || refused === current;
}
