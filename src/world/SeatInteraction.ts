import type { VehicleCatalog } from "./VehicleDbc.js";
import { VEHICLE_SEAT_FLAGS, isVehicleCarrierGuid } from "./VehicleSeatModel.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02-input: whether the character may loot or talk by a right click from where it sits — Wow.exe
 * 3.3.5a 12340 0x006d7aa0 (Ghidra, read-only; .runtime/re-2026-10-03/l1102input/r1.c), which the unit
 * right click 0x00731260 asks first (call at 0x007312df) and the hover cursor 0x004f7a50 too (0x004f7aa8):
 *
 * - the character's transport guid names no vehicle (0x0074b8b0: HighGuid::Vehicle or a player) → yes;
 * - that vehicle is not in view (0x004d4db0 finds no unit) → yes;
 * - it is in view: yes only when it has a vehicle kit (unit+0xf5c) whose seat in the character's slot
 *   (0x00756ec0 over the seat byte unit+0x7d2) has VehicleSeat Flags 0x80000000 ALLOWS_INTERACTION
 *   (DBCEnums.h:503) — a kit without that seat row, or no kit at all, is no.
 *
 * On a "no" 0x00731260 skips the corpse branch (loot, gathering) and the service branch (0x00729530 →
 * 0x006ddbb0: gossip, vendors, spell click, a player's vehicle) and goes straight to the swing (0x00729a70
 * and CanAttack 0x00729740), returning when that refuses. The mammoths' passenger seats (0xde00800b) have
 * the bit; the siege engine's driver (0x67108a0b) and 655 of the dataset's 720 seats do not.
 *
 * Without the vehicle tables (`/dbc/vehicles` not landed, an older gateway) the seat is unknown and the
 * answer is yes — the click as before this slice.
 */
export function seatAllowsInteraction(catalog: VehicleCatalog | undefined,
  objects: ReadonlyMap<bigint, WorldObjectState>, selfGuid: bigint | undefined): boolean {
  if (catalog === undefined || selfGuid === undefined) return true;
  const transport = objects.get(selfGuid)?.transport;
  if (transport === undefined || !isVehicleCarrierGuid(transport.guid)) return true;
  const carrier = objects.get(transport.guid);
  if (carrier === undefined) return true;
  const seat = catalog.seatInSlot(carrier.vehicleId, transport.seat);
  return seat !== undefined && (seat.flags & VEHICLE_SEAT_FLAGS.ALLOWS_INTERACTION) !== 0;
}
