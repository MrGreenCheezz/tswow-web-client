/**
 * 5.32: the world client's answers to what Wow.exe 0x00735f60 reads beyond a unit's own fields (UnitFacing.ts):
 * the spell a unit is casting (+0xa60), the unit the player's interaction window is open on (0x00bd07a8) and a
 * creature's CreatureMovementInfo id. Registered by the page for the world it entered (app/EnterWorld.ts).
 */

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { UnitFacingSources } from "./UnitFacing.js";
import type { WorldClient } from "./WorldClient.js";

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

/** What these answers read of the world client. */
export type FacingWorld = Pick<WorldClient, "casts" | "creatureTemplates" | "gossip" | "questDialog" | "questList"
  | "vendor" | "trainer" | "taxiMenu" | "bankerGuid" | "auctioneerGuid" | "tabardVendorGuid" | "petitionVendor"
  | "stable" | "stableMasterGuid">;

/**
 * The NPC an interaction window is open on — Wow.exe's 0x00bd07a8, which every NPC frame sets through 0x0051fce0
 * (QuestFrame.cpp, the gossip, merchant, trainer, taxi, bank, auction, tabard, charter and stable frames) and
 * 0x00512e60 clears — or undefined.
 */
export function interactionNpcGuid(world: FacingWorld | undefined): bigint | undefined {
  if (world === undefined) return undefined;
  const guid = world.gossip?.guid ?? world.questDialog?.guid ?? world.questList?.guid ?? world.vendor?.guid
    ?? world.trainer?.guid ?? world.taxiMenu?.guid ?? world.bankerGuid
    ?? (world.auctioneerGuid !== 0n ? world.auctioneerGuid : undefined)
    ?? (world.tabardVendorGuid !== 0n ? world.tabardVendorGuid : undefined)
    ?? world.petitionVendor?.vendorGuid
    ?? (world.stable !== undefined && world.stableMasterGuid !== 0n ? world.stableMasterGuid : undefined);
  return guid === undefined || guid === 0n ? undefined : guid;
}

/** The three answers over the world `current` returns (undefined: no world, every answer «nothing»). */
export function unitFacingSourcesOf(current: () => FacingWorld | undefined): UnitFacingSources {
  return {
    casting: (guid) => {
      const cast = current()?.casts.get(guid);
      if (cast === undefined || cast.channel) return undefined;
      return performance.now() <= cast.startedAt + cast.duration ? cast.spellId : undefined;
    },
    interactionNpc: () => interactionNpcGuid(current()),
    movementId: (object) => {
      const entry = object.fields.get(ENTRY) ?? 0;
      return entry === 0 ? undefined : current()?.creatureTemplates.get(entry)?.movementId;
    },
  };
}
