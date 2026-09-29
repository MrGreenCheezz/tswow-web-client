import { PacketReader } from "../protocol/PacketReader.js";
import type { TalentsInfo } from "./CharacterProgressProtocol.js";

/**
 * `SMSG_INSPECT_TALENT`, the answer to `CMSG_INSPECT` (MiscHandler.cpp HandleInspectOpcode).
 *
 * The inspected player's packed GUID, then `Player::BuildPlayerTalentsInfoData` — or, when the realm
 * does not let this player see talents (`CONFIG_TALENTS_INSPECTING`), the same three header fields
 * with no group at all — then `Player::BuildEnchantmentsInfoData`: a mask of the equipped slots and,
 * per slot, the entry, a mask of its enchantment slots with one id each, the random property, the
 * creator and the suffix factor. That second half is what an inspected item's link is built from:
 * the visible-item update fields carry only the entry and the permanent/temporary enchantments.
 */

/** `EQUIPMENT_SLOT_END` and `MAX_ENCHANTMENT_SLOT` in this core (ItemDefines.h). */
const EQUIPMENT_SLOTS = 19;
const ENCHANTMENT_SLOTS = 12;
/** `MAX_TALENT_SPECS` is 2; four bounds a malformed packet the way parseTalentsInfo does. */
const MAX_GROUPS = 4;

export interface InspectedItem {
  /** `EQUIPMENT_SLOT_*`, zero-based: head 0 … tabard 18. */
  slot: number;
  entry: number;
  /** Enchantment ids by `EnchantmentSlot`, 0 permanent … 11; absent slots are 0. */
  enchantments: number[];
  randomPropertyId: number;
  creator: bigint;
  suffixFactor: number;
}

export interface InspectResult {
  guid: bigint;
  /** The talent groups exactly as the player's own `SMSG_TALENTS_INFO` shape; no group when hidden. */
  talents: TalentsInfo;
  items: InspectedItem[];
}

export function parseInspectTalent(payload: Uint8Array): InspectResult {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const unspentPoints = reader.u32();
  const specCount = reader.u8();
  const activeSpec = reader.u8();
  if (specCount > MAX_GROUPS) throw new RangeError(`Inspection names ${specCount} talent groups`);
  const specs: TalentsInfo["specs"] = [];
  for (let index = 0; index < specCount; index++) {
    const talentCount = reader.u8();
    const talents = [];
    // The core writes the highest learned rank, zero-based; the UI's ranks are one-based.
    for (let talent = 0; talent < talentCount; talent++) talents.push({ talentId: reader.u32(), rank: reader.u8() + 1 });
    const glyphCount = reader.u8();
    const glyphs: number[] = [];
    for (let glyph = 0; glyph < glyphCount; glyph++) glyphs.push(reader.u16());
    specs.push({ talents, glyphs });
  }
  const slotMask = reader.u32();
  const items: InspectedItem[] = [];
  for (let slot = 0; slot < EQUIPMENT_SLOTS; slot++) {
    if ((slotMask & (1 << slot)) === 0) continue;
    const entry = reader.u32();
    const enchantmentMask = reader.u16();
    const enchantments = new Array<number>(ENCHANTMENT_SLOTS).fill(0);
    for (let index = 0; index < ENCHANTMENT_SLOTS; index++) {
      if ((enchantmentMask & (1 << index)) !== 0) enchantments[index] = reader.u16();
    }
    items.push({
      slot, entry, enchantments,
      randomPropertyId: reader.i16(),
      creator: reader.packedGuid(),
      suffixFactor: reader.u32(),
    });
  }
  reader.assertFinished();
  return { guid, talents: { pet: false, unspentPoints, activeSpec, specs }, items };
}
