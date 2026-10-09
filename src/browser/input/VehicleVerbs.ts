import { unitSeat } from "../../world/UnitSeat.js";
import type { VehicleCatalog } from "../../world/VehicleDbc.js";
import { canExitVehicle, canSwitchVehicleSeats } from "../../world/VehicleSeatModel.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { frameXmlVehicleLive } from "../framexml/FrameXmlVehicle.js";
import { vehicleAimInput, type VehicleAimInput } from "../game/VehicleAim.js";
import { vehicleCatalog } from "../VehicleClient.js";

/**
 * 11.02-input: the verbs of Bindings.xml's VEHICLE section for the native key table (StockActions.ts rows,
 * Actions.ts cases). Each calls what the stock binding body calls (Bindings.xml:1239-1273 of the dataset),
 * as Wow.exe 3.3.5a 12340 answers it (registration table; Ghidra read-only, .runtime/re-2026-10-03/
 * l1102bcd/r1.c, l1102e/notes.txt, l1102input/):
 *
 * - VEHICLEEXIT `VehicleExit()` 0x005fb660: from a seat with CAN_ENTER_OR_EXIT (0x005fb560(0x02000000)) the
 *   exit 0x0074c7f0 — `WorldClient.leaveVehicle` (DISMISS for the driver, REQUEST_VEHICLE_EXIT otherwise);
 *   from any other seat, or none, the UI error SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW (0x005216f0).
 * - VEHICLEPREVSEAT / VEHICLENEXTSEAT `VehiclePrevSeat()` / `VehicleNextSeat()` 0x005fb6d0 / 0x005fb720: only
 *   from a seat with CAN_SWITCH (0x005fb560(0x04000000)), then 0x0074c8b0 / 0x0074c9a0 —
 *   `WorldClient.changeVehicleSeat`; nothing otherwise, and no error.
 * - VEHICLEAIMUP / VEHICLEAIMDOWN (runOnUp) `VehicleAimUpStart/Stop`, `VehicleAimDownStart/Stop`: the
 *   registration of PitchUpStart/Stop, PitchDownStart/Stop themselves (0x005fc8e0, 0x005fc570, 0x005fc920,
 *   0x005fc5c0) — so the two rows are held keys of the pitch axis (Bindings.ts `heldMovementAction`).
 * - VEHICLEAIMINCREMENT / VEHICLEAIMDECREMENT `VehicleAimIncrement(0.1)` / `VehicleAimDecrement(0.1)`
 *   0x005fb770 / 0x005fb7d0: the active mover's pitch ± 0.1 through 0x005fb3a0 (game/VehicleAim.ts, the
 *   same entry the stock FrameXmlVehicleAim.ts takes).
 * - VEHICLECAMERAZOOMIN / VEHICLECAMERAZOOMOUT `VehicleCameraZoomIn(1.0)` / `VehicleCameraZoomOut(1.0)`
 *   0x006018a0 / 0x006018b0: CameraZoomIn/Out 0x006017e0 / 0x00601840 — one yard in or out
 *   (0x005ffa60: the distance glides by the number given, in yards), wherever the camera is; nothing while
 *   a seat's own zoom holds the camera (camera+0x9c bit 0x40) — `VehicleCamera.zoomBy`, Actions.ts.
 *
 * While an attached stock seam's vehicle model has the tables, VehicleExit is its own (`frameXmlVehicleLive`,
 * FrameXmlVehicle.ts) — the same rule, and the UI error goes to the stock UIErrorsFrame. Without the
 * vehicle tables nothing is known of a seat: exit and seat steps work from any unit seat (as the native
 * vehicle row does, ui/VehicleBarGates.ts); on foot the seat steps do nothing and the exit still refuses with
 * the UI error (11.02-input review: 0x005fb560 needs no table to answer 0 without a seat).
 */

/** Bindings.xml's own numbers: `VehicleAimIncrement(0.1)`, `VehicleCameraZoomIn(1.0)`. */
export const VEHICLE_AIM_KEY_STEP = 0.1;
export const VEHICLE_CAMERA_KEY_YARDS = 1;

/** The GlobalStrings name VehicleExit refuses with. */
export const VEHICLE_EXIT_REFUSAL = "SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW";

/** The parts of `WorldClient` the verbs read and drive. */
export interface VehicleVerbWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  leaveVehicle(): void;
  changeVehicleSeat(next: boolean): void;
}

/** The stock model's half the exit asks (FrameXmlVehicleModel). */
export interface VehicleVerbStock {
  readonly active: boolean;
  exit(): void;
}

function seatedInUnit(world: VehicleVerbWorld): boolean {
  const self = world.state.selfGuid;
  return self !== undefined && unitSeat(world.state.objects, world.state.objects.get(self)) !== undefined;
}

/** VEHICLEEXIT: the GlobalStrings name of the UI error to show, or undefined when there is none. */
export function vehicleExitKey(world: VehicleVerbWorld, catalog: VehicleCatalog | undefined = vehicleCatalog(),
  stock: VehicleVerbStock | undefined = frameXmlVehicleLive()): string | undefined {
  if (stock?.active === true) {
    stock.exit();
    return undefined;
  }
  if (catalog === undefined) {
    // 11.02-input review: no seat at all is known without the tables — 0x005fb560 answers 0 for a character
    // without a passenger record (+0xf60) before it reads a seat row, and 0x005fb660 shows the error.
    if (!seatedInUnit(world)) return VEHICLE_EXIT_REFUSAL;
    world.leaveVehicle();
    return undefined;
  }
  if (!canExitVehicle(catalog, world.state.objects, world.state.selfGuid)) return VEHICLE_EXIT_REFUSAL;
  world.leaveVehicle();
  return undefined;
}

/** VEHICLEPREVSEAT / VEHICLENEXTSEAT. */
export function vehicleSeatKey(world: VehicleVerbWorld, next: boolean,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): void {
  const allowed = catalog === undefined
    ? seatedInUnit(world)
    : canSwitchVehicleSeats(catalog, world.state.objects, world.state.selfGuid);
  if (allowed) world.changeVehicleSeat(next);
}

/** VEHICLEAIMINCREMENT (`sign` 1) / VEHICLEAIMDECREMENT (−1): false when nothing took the pitch. */
export function vehicleAimStepKey(sign: 1 | -1, input: VehicleAimInput | undefined = vehicleAimInput()): boolean {
  if (input === undefined) return false;
  return input.setMoverPitch(input.moverPitch() + sign * VEHICLE_AIM_KEY_STEP);
}
