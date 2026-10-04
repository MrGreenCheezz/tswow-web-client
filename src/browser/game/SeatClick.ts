import { isPlayerGhost } from "../../world/Fields.js";
import { seatAllowsInteraction } from "../../world/SeatInteraction.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { vehicleCatalog } from "../VehicleClient.js";
import { canAttackUnit } from "./Targeting.js";

/** The parts of `WorldClient` the gate reads and drives. */
export interface SeatClickWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly targetGuid?: bigint | undefined;
  selectTarget(guid: bigint | undefined): void;
  startAttack(): void;
}

/**
 * 11.02-input: the right click on a unit from a vehicle seat without ALLOWS_INTERACTION (world/SeatInteraction.ts,
 * Wow.exe 0x006d7aa0 asked first by 0x00731260): no loot, no gathering, no service, no seat — only the
 * swing, when 0x00729a70 lets the character attack the unit (CanAttack 0x00729740, `canAttackUnit`; a
 * ghost never swings); otherwise nothing. True when the click is spent here; false — the ordinary click
 * goes on — for a game object (0x00731260 is the unit's), a character not seated in a vehicle, a seat
 * with the flag, or before the vehicle tables land.
 */
export function seatClickRefused(world: SeatClickWorld, target: WorldObjectState,
  catalog = vehicleCatalog()): boolean {
  if (target.typeId !== 3 && target.typeId !== 4) return false;
  if (seatAllowsInteraction(catalog, world.state.objects, world.state.selfGuid)) return false;
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (canAttackUnit(target) && !(self !== undefined && isPlayerGhost(self))) {
    if (world.targetGuid !== target.guid) world.selectTarget(target.guid);
    world.startAttack();
  }
  return true;
}
