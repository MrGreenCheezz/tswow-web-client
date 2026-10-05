/**
 * 6.11б (line A7a, slice H, 05.10): a mirror image's model — its display record dressed in the look
 * SMSG_MIRRORIMAGE_DATA describes (`world/MirrorImages.ts`), through the same appearance route a
 * player's look takes (`CreatureModelClient.playerAppearance`). Called from `ui/Frames.ts
 * unitModelFor` for a creature carrying UNIT_FLAG2_MIRROR_IMAGE; its held weapons stay
 * UNIT_VIRTUAL_ITEM_SLOT_ID's (`NpcWeapons.withVirtualWeapons`, applied afterwards), which is where
 * `Creature::SetOutfit` (Creature.cpp:352-368) and the clone put them.
 *
 * Memoised per unit on (reply, record, appearance generation), so a dressed unit is one object from
 * frame to frame and the weapon memo after it holds.
 */
import type { CharacterAppearance, EquippedItem } from "../gateway/CharacterAppearance.js";
import type { MirrorImageData } from "../world/SpellLogProtocol.js";
import { mirrorImageEquipment } from "../world/MirrorImages.js";
import type { UnitModel } from "./CreatureModelClient.js";

interface AppearanceSource {
  readonly generation: number;
  playerAppearance(race: number, sex: number, skin: number, face: number, hairStyle: number,
    hairColor: number, facialHair: number, equipment?: readonly EquippedItem[],
    classId?: number): CharacterAppearance | undefined;
}

interface Dressed {
  data: MirrorImageData | undefined;
  metadata: UnitModel;
  generation: number;
  model: UnitModel;
}

const dressed = new WeakMap<object, Dressed>();

/**
 * `metadata` dressed by `data`; without a reply, `metadata` itself — or, while a question is still
 * out (`awaiting`), the same record marked `appearancePending`, so the renderer keeps what the unit
 * wears for its short wait rather than building it bare and dressing it a moment later.
 */
export function mirrorImageModelFor(unit: object, metadata: UnitModel, data: MirrorImageData | undefined,
  creatureModels: AppearanceSource, awaiting = false): UnitModel {
  if (!data && !awaiting) return metadata;
  // 05.10 review H: only a character display takes a look (the gateway bakes one into every
  // `Character\` record). An NPCBot keeps the flag in bear or cat form, hexed or polymorphed, and the
  // core's reply then names that display — dressing it painted a bear as a night elf, the mistake
  // `ui/Frames.ts` already avoids for a shapeshifted player. (Wow.exe's own test not traced.)
  if (metadata.appearance === undefined) return metadata;
  const known = dressed.get(unit);
  if (known && known.data === data && known.metadata === metadata
    && known.generation === creatureModels.generation) return known.model;
  let model: UnitModel;
  if (!data) {
    model = { ...metadata, appearancePending: true };
  } else {
    const appearance = creatureModels.playerAppearance(data.race, data.gender, data.skin, data.face, data.hair,
      data.hairColour, data.facialHair, mirrorImageEquipment(data.equipmentDisplayIds), data.classId);
    model = appearance ? { ...metadata, appearance } : { ...metadata, appearancePending: true };
    // A look still in flight is asked again next frame (the client's cache answers then), not memoised.
    if (!appearance) return model;
  }
  dressed.set(unit, { data, metadata, generation: creatureModels.generation, model });
  return model;
}
