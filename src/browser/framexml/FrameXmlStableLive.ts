/**
 * The stable model over the live world, built by FrameXmlGossipLive.ts: a pet's family is its
 * creature template's (`SMSG_CREATURE_QUERY_RESPONSE`, asked once), else the creature dump's row;
 * the family's icon is the gateway's `/creature-icon/<id>` (`CreatureFamily.IconFile`), its name and
 * talent tree the gateway's talent tables (CreatureFamily and TalentTab DBC); the next slot's price
 * is the gateway's `StableSlotPrices.dbc` (SlotPriceClient). Every unknown stays undefined.
 */
import { readField } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { creatureFamilyIconUrl } from "../ui/IconImage.js";
import { FrameXmlStableModel } from "./FrameXmlStable.js";

export function createLiveFrameXmlStable(host: { world(): WorldClient | undefined }): FrameXmlStableModel {
  return new FrameXmlStableModel({
    world: () => host.world(),
    creatureFamily: (entry) => {
      if (!Number.isInteger(entry) || entry <= 0) return undefined;
      const template = host.world()?.creatureTemplate(entry);
      if (template?.found) return template.creatureFamily;
      return game.creatureMetadata?.get(entry)?.family;
    },
    familyIcon: (family) => creatureFamilyIconUrl(family, game.gatewayOrigin),
    familyName: (family) => game.talentData?.petFamilyName(family),
    talentTree: (family) => {
      const talents = game.talentData;
      const mask = talents?.petTalentMask(family) ?? 0;
      return mask === 0 ? undefined : talents?.petTabs(mask)[0]?.name || undefined;
    },
    petEntry: () => {
      const world = host.world();
      const guid = world?.petSpells?.guid;
      const pet = guid === undefined || guid === 0n ? undefined : world?.state.objects.get(guid);
      return pet ? readField(pet, "OBJECT_FIELD_ENTRY") : undefined;
    },
    stableSlotPrice: (owned) => game.slotPrices?.stableSlotPrice(owned),
  });
}
