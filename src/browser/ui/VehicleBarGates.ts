import { isVehicleActionBar, type PetSpells } from "../../world/PetProtocol.js";
import type { VehicleCatalog } from "../../world/VehicleDbc.js";
import { canExitVehicle, canSwitchVehicleSeats } from "../../world/VehicleSeatModel.js";
import { canEjectPassenger } from "../../world/VehicleUi.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { frameXmlPossessLive } from "../framexml/FrameXmlPossess.js";
import { frameXmlVehicleLive } from "../framexml/FrameXmlVehicle.js";
import { vehicleCatalog } from "../VehicleClient.js";

/**
 * 11.02-F2: the native vehicle row (ui/PetBar.ts) under Wow.exe's gates, and when the stock UI owns
 * that row instead.
 *
 * With the vehicle tables the row's buttons do what the stock C functions allow (world/VehicleSeatModel.ts):
 * «Покинуть» only from a seat with CAN_ENTER_OR_EXIT (CanExitVehicle 0x005fb9c0; VehicleExit 0x005fb660
 * refuses otherwise), «◀ место»/«место ▶» only from a seat with CAN_SWITCH (VehiclePrevSeat/NextSeat
 * 0x005fb6d0/0x005fb720), «Высадить» only a passenger whose seat is EJECTABLE (CanEjectPassengerFromSeat
 * 0x00613d20). Without the tables (`/dbc/vehicles` not landed, an older gateway) nothing is known about
 * a seat and every button works as before this slice.
 *
 * The stock UI owns the row (`stockOwnsVehicleRow`) while an attached stock seam's vehicle model has the
 * tables and either no vehicle bar is open or the possess model put it on the main bar
 * (VehicleMenuBarActionButton1–6 on slots 121–126): leave and seat buttons are VehicleMenuBar's,
 * MainMenuBarVehicleLeaveButton's and VehicleSeatIndicator's. A vehicle bar Wow.exe keeps off the main
 * bar (VehicleAbilityDisplay ≠ 1) has no stock owner here — the stock pet bar takes only a pet's — so the
 * native row stays for it.
 */

/** The world the gates read; `WorldClient` satisfies it structurally. */
export interface VehicleGateWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly petSpells?: PetSpells | undefined;
}

export interface NativeVehicleGates {
  readonly canExit: boolean;
  readonly canSwitch: boolean;
  canEject(passengerGuid: bigint): boolean;
}

/** The gates for the character's seat now; undefined without the vehicle tables (no gate at all). */
export function nativeVehicleGates(world: VehicleGateWorld | undefined,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): NativeVehicleGates | undefined {
  if (!world || !catalog) return undefined;
  const objects = world.state.objects;
  const self = world.state.selfGuid;
  return {
    canExit: canExitVehicle(catalog, objects, self),
    canSwitch: canSwitchVehicleSeats(catalog, objects, self),
    canEject: (passengerGuid) => canEjectPassenger(catalog, objects, self, passengerGuid),
  };
}

/** Whether the stock UI draws the vehicle row now (see the head); false with no stock seam attached. */
export function stockOwnsVehicleRow(world: VehicleGateWorld | undefined): boolean {
  if (!world || frameXmlVehicleLive()?.active !== true) return false;
  const bar = world.petSpells;
  if (!bar || bar.closed || bar.guid === 0n || !isVehicleActionBar(bar.bar)) return true;
  return frameXmlPossessLive()?.onMainBar() === true;
}
