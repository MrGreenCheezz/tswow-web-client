import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { UNIT_NPC_FLAG_PLAYER_VEHICLE, UNIT_NPC_FLAG_SPELLCLICK } from "./VehicleProtocol.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02-B: what a right click on a unit does about vehicles, in Wow.exe's order.
 *
 * Wow.exe's unit interaction (0x006ddbb0) walks the NPC flags one by one and acts on the first that
 * applies: gossip (0x1); a quest giver with something to show (0x006d1de0: the cached quest-giver
 * status above `DIALOG_STATUS_UNAVAILABLE`); flight master (0x2000); vendor (0x80); trainer (0x10);
 * spirit healer and guide (0x4000, 0x8000); innkeeper (0x10000); banker (0x20000); petitioner
 * (0x40000); tabard designer (0x80000); battlemaster (0x100000); auctioneer (0x200000); stable master
 * (0x400000); guild banker (0x800000); then spell click (0x0071c570 → `CMSG_SPELLCLICK` 0x006d2740);
 * then another player's vehicle (0x00723050 → `CMSG_PLAYER_VEHICLE_ENTER` 0x006d27c0); then the
 * mailbox (0x4000000). So spell click is not first: a creature that also offers a service is served,
 * and only one with none of them is clicked into. The click decision here returns undefined whenever
 * one of the earlier services applies, so the caller can ask it before its own service chain.
 */

/** Every NPC flag 0x006ddbb0 tests before spell click, except the quest giver (status-dependent). */
export const NPC_FLAGS_BEFORE_SPELLCLICK = 0x1 | 0x10 | 0x80 | 0x2000 | 0x4000 | 0x8000 | 0x1_0000 | 0x2_0000
  | 0x4_0000 | 0x8_0000 | 0x10_0000 | 0x20_0000 | 0x40_0000 | 0x80_0000;
const NPC_FLAG_QUESTGIVER = 0x2;
/** `DIALOG_STATUS_UNAVAILABLE`: 0x006d1de0 sends the quest hello only above it. */
const DIALOG_STATUS_UNAVAILABLE = 1;
/** `UNIT_FLAG2_PREVENT_SPELL_CLICK` (UnitDefines.h:197): 0x0071c570 refuses the click on it. */
const UNIT_FLAG2_PREVENT_SPELL_CLICK = 0x2000;

/** One click per vehicle a second: a double click is one `CMSG_SPELLCLICK`, not a cast and a refusal. */
export const SPELL_CLICK_REPEAT_MS = 1000;

/**
 * The local repeat guard (the spec's; Wow.exe itself only skips the unit it is already interacting
 * with, 0x00bd07a8 in 0x006ddbb0). Old entries go once there are a few dozen.
 */
export class SpellClickRepeatGuard {
  readonly #last = new Map<bigint, number>();

  /** True (and remembered) when `guid` was not clicked in the last {@link SPELL_CLICK_REPEAT_MS}. */
  allow(guid: bigint, now: number): boolean {
    const last = this.#last.get(guid);
    if (last !== undefined && now - last < SPELL_CLICK_REPEAT_MS) return false;
    if (this.#last.size >= 32) {
      for (const [clicked, at] of this.#last) if (now - at >= SPELL_CLICK_REPEAT_MS) this.#last.delete(clicked);
    }
    this.#last.set(guid, now);
    return true;
  }
}

export type VehicleClick = "spellclick" | "player-vehicle";

/** What the decision reads of the world. */
export interface VehicleClickView {
  readonly selfGuid: bigint | undefined;
  /** The unit the character sits in, if any (its transport block names a unit). */
  readonly selfSeatGuid: bigint | undefined;
  questGiverStatus(guid: bigint): number | undefined;
  inGroup(guid: bigint): boolean;
}

/**
 * `spellclick` for a creature that offers no earlier service and carries the (personal) spell-click
 * flag without `UNIT_FLAG2_PREVENT_SPELL_CLICK`; `player-vehicle` for a group member's vehicle the
 * character is not already on (0x00723050; the core wants the same group and 5 yards,
 * VehicleHandler.cpp:136-146); undefined otherwise — the caller's own chain then runs.
 */
export function vehicleClickOf(target: WorldObjectState, view: VehicleClickView): VehicleClick | undefined {
  if (target.guid === view.selfGuid) return undefined;
  const npcFlags = target.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0;
  if (target.typeId === 4) {
    if ((npcFlags & UNIT_NPC_FLAG_PLAYER_VEHICLE) === 0 || view.selfSeatGuid === target.guid) return undefined;
    return view.inGroup(target.guid) ? "player-vehicle" : undefined;
  }
  if (target.typeId !== 3 || (npcFlags & UNIT_NPC_FLAG_SPELLCLICK) === 0) return undefined;
  if ((npcFlags & NPC_FLAGS_BEFORE_SPELLCLICK) !== 0) return undefined;
  if ((npcFlags & NPC_FLAG_QUESTGIVER) !== 0 && (view.questGiverStatus(target.guid) ?? 0) > DIALOG_STATUS_UNAVAILABLE) return undefined;
  const flags2 = target.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset) ?? 0;
  return (flags2 & UNIT_FLAG2_PREVENT_SPELL_CLICK) === 0 ? "spellclick" : undefined;
}

/** The world a click acts on; the live `WorldClient` has all of it. */
export interface VehicleClickWorld {
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly questGiverStatus: ReadonlyMap<bigint, number>;
  readonly group?: { readonly members: readonly { readonly guid: bigint }[] } | undefined;
  spellClick(guid: bigint): void;
  enterPlayerVehicle(guid: bigint): void;
}

/** Acts on {@link vehicleClickOf}; true when the click was a vehicle's and nothing else should run. */
export function clickVehicle(world: VehicleClickWorld, target: WorldObjectState): boolean {
  const selfGuid = world.state.selfGuid;
  const seat = selfGuid === undefined ? undefined : world.state.objects.get(selfGuid)?.transport?.guid;
  const verdict = vehicleClickOf(target, {
    selfGuid,
    selfSeatGuid: seat,
    questGiverStatus: (guid) => world.questGiverStatus.get(guid),
    inGroup: (guid) => world.group?.members.some((member) => member.guid === guid) ?? false,
  });
  if (verdict === "spellclick") world.spellClick(target.guid);
  else if (verdict === "player-vehicle") world.enterPlayerVehicle(target.guid);
  return verdict !== undefined;
}
