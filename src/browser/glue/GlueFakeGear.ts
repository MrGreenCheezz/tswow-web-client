/**
 * 15.11 (6.18, 6.14): `?fake=charselect-gear` — the canned select screen with two armed characters, to
 * look at the weapons in the hands, a ghost and the enchant glows without a server. The rows are this
 * dataset's own (read on 15.11 from Item.dbc and `/dbc/item-enchantments`):
 *  - item 1482 (class 2/7, INVTYPE_WEAPON 13, display 20089 → `Sword_1H_Long_B_02.m2`, which carries
 *    attachments 0–4, and no ItemVisual of its own), worn by a dead human warrior with SMSG_CHAR_ENUM's
 *    enchant visual 24 (ItemVisuals 24: `BlueGlow_High` in all five slots) — the blade glows blue and the
 *    figure is the ghost. (Item 1008 / display 1550, used first, is `Sword_1H_Long_A_02.m2` with no
 *    attachments at all, so no glow can hang on it — 0x00831630 — which is what the owner's look showed.)
 *  - item 870 (class 2/1, INVTYPE_2HWEAPON 17, display 33458, its own ItemVisual 25: `RedFlame_Low` x5),
 *    worn by a living orc warrior with enchant visual 24 as well — the display's own row wins on this
 *    screen (FigureGlow.ts), so the axe burns red, not blue.
 */
import type { CharacterEquipment, CharacterSummary } from "../../world/CharacterProtocol.js";

/** CHARACTER_FLAG_DECLINED (as GlueFakeSession's), and CHARACTER_FLAG_GHOST for the dead one. */
const DECLINED = 0x02000000;
const GHOST = 0x2000;

function equipment(mainHand: CharacterEquipment): CharacterEquipment[] {
  const slots = Array.from({ length: 23 }, () => ({ displayId: 0, inventoryType: 0, enchantVisual: 0 }));
  slots[15] = mainHand;
  return slots;
}

function armed(guid: number, name: string, race: number, flags: number, mainHand: CharacterEquipment): CharacterSummary {
  return {
    guid: BigInt(guid), name, race, classId: 1, gender: 0,
    skin: 1, face: 1, hairStyle: 2, hairColor: 1, facialHair: 1,
    level: 20, zone: 12, map: 0, x: 0, y: 0, z: 0, guildId: 0,
    flags: DECLINED | flags, customizeFlags: 0, firstLogin: false,
    petDisplayId: 0, petLevel: 0, petFamily: 0,
    equipment: equipment(mainHand),
  };
}

export const FAKE_GEAR_CHARACTERS: readonly CharacterSummary[] = [
  armed(0x1101, "Призрачник", 1, GHOST, { displayId: 20089, inventoryType: 13, enchantVisual: 24 }),
  armed(0x1102, "Секирщик", 2, 0, { displayId: 33458, inventoryType: 17, enchantVisual: 24 }),
];
