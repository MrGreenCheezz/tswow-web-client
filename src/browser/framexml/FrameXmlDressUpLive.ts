/**
 * The live world's answers for the dressing room (FrameXmlDressUp.ts FrameXmlDressUpHost).
 *
 * The look is read exactly as ui/Frames.ts unitModelFor reads the player's for the world model:
 * UNIT_FIELD_BYTES_0 race/gender, PLAYER_BYTES skin/face/hair style/hair colour, PLAYER_BYTES_2's
 * facial hair, and visibleEquipmentFor's nineteen PLAYER_VISIBLE_ITEM words. The body is
 * UNIT_FIELD_NATIVEDISPLAYID, not DISPLAYID: clothes go on the character, not on a cat form or a
 * polymorph (what the real DressUpModel shows for a shapeshifted player is not measured).
 *
 * Only "player" resolves: DressUpFrame and AuctionDressUpFrame never ask for another unit
 * (DressUpFrame.lua:8, Blizzard_AuctionDressUp.lua:11). Item rows come from the session's
 * ItemMetadataClient, which the bags and tooltips already fill; an unknown row is asked for once.
 */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { unit as unitFields } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { visibleEquipmentFor } from "../ui/Frames.js";
import type { FrameXmlDressUpHost, FrameXmlDressUpItem, FrameXmlDressUpLook } from "./FrameXmlDressUp.js";

export function createLiveFrameXmlDressUpHost(): FrameXmlDressUpHost {
  return {
    look(unit: string): FrameXmlDressUpLook | undefined {
      if (unit !== "player") return undefined;
      const world = game.world;
      const guid = world?.state.selfGuid;
      const object = guid === undefined ? undefined : world?.state.objects.get(guid);
      if (!object || object.typeId !== 4) return undefined;
      const displayId = unitFields.nativeDisplayId(object)
        ?? object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
      if (!(displayId > 0)) return undefined;
      const bytes = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
      const look = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
      const look2 = object.fields.get(UPDATE_FIELDS.PLAYER_BYTES_2.offset) ?? 0;
      return {
        displayId,
        race: bytes & 0xff,
        sex: (bytes >>> 16) & 0xff,
        skin: look & 0xff,
        face: (look >>> 8) & 0xff,
        hairStyle: (look >>> 16) & 0xff,
        hairColor: (look >>> 24) & 0xff,
        facialHair: look2 & 0xff,
        equipment: visibleEquipmentFor(object, game.itemMetadata),
      };
    },
    item(entry: number): FrameXmlDressUpItem | undefined {
      const metadata = game.itemMetadata;
      const row = metadata?.get(entry);
      if (!row) {
        void metadata?.load([entry]).catch(() => undefined);
        return undefined;
      }
      return { inventoryType: row.inventoryType, displayId: row.displayId, subClass: row.subClass };
    },
  };
}
