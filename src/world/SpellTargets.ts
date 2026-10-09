import { PacketWriter } from "../protocol/PacketWriter.js";
import {
  TARGET_FLAG_DEST_LOCATION, TARGET_FLAG_GAMEOBJECT, TARGET_FLAG_ITEM, TARGET_FLAG_NONE,
  TARGET_FLAG_TRADE_ITEM, TARGET_FLAG_UNIT,
  TARGET_FLAG_SOURCE_LOCATION, // 11.02-E
} from "./SpellProtocol.js";

/**
 * The explicit-target tail of `CMSG_CAST_SPELL` and `CMSG_USE_ITEM` (plan item 2.05, mechanism M3),
 * written in one place.
 *
 * TrinityCore reads it in `SpellCastTargets::Read` (Spell.cpp:144-195): the `u32` mask; one packed
 * object guid for UNIT | UNIT_MINIPET | GAMEOBJECT | CORPSE_*; one packed item guid for
 * ITEM | TRADE_ITEM; then the source and destination locations (packed transport guid + three
 * floats); then a string. For TRADE_ITEM the "guid" is not a guid but the trade slot, and only
 * `TRADE_SLOT_NONTRADED` (6) is honoured (`SpellCastTargets::Update`, Spell.cpp:455-468;
 * `Spell::CheckCast`, Spell.cpp:6404-6419). The original client writes the same: the trade-slot
 * click sets mask 0x1000 with item target `{low 6, high 0}` (Wow.exe 0x0080c5f0).
 */

/** `TRADE_SLOT_NONTRADED` (TradeData.h:27): the «will not be traded» slot, the stock seventh. */
export const TRADE_SLOT_NONTRADED = 6;

export interface SpellTargetSpec {
  /** A unit (creature or player). Exclusive with `gameObject`. */
  readonly unit?: bigint | undefined;
  /** A game object (chest, node). Exclusive with `unit`. */
  readonly gameObject?: bigint | undefined;
  /** An item the caster carries (bag or equipped: `Player::GetItemByGuid` finds both). */
  readonly item?: bigint | undefined;
  /** The trader's slot; only {@link TRADE_SLOT_NONTRADED} is accepted. Exclusive with `item`. */
  readonly tradeSlot?: number | undefined;
  /** A world point (transport guid zero: world coordinates). */
  readonly destination?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  /**
   * 11.02-E: the source point (transport guid zero: world coordinates) — a missile trajectory's fire point
   * (TARGET_DEST_TRAJ asks for it, SpellInfo.cpp:136-145). Written before the destination (Spell.cpp:157, 174).
   */
  readonly source?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}

const present = (guid: bigint | undefined): guid is bigint => guid !== undefined && guid !== 0n;

/**
 * The mask a spec writes, or `undefined` when the spec cannot be written: two object targets, two
 * item targets, a trade slot other than 6, or a non-finite point. A caller never sends then.
 */
export function spellTargetMask(spec: SpellTargetSpec): number | undefined {
  let mask = TARGET_FLAG_NONE;
  if (present(spec.unit)) mask |= TARGET_FLAG_UNIT;
  if (present(spec.gameObject)) {
    if (mask !== TARGET_FLAG_NONE) return undefined;
    mask |= TARGET_FLAG_GAMEOBJECT;
  }
  if (present(spec.item)) mask |= TARGET_FLAG_ITEM;
  if (spec.tradeSlot !== undefined) {
    if (spec.tradeSlot !== TRADE_SLOT_NONTRADED || (mask & TARGET_FLAG_ITEM) !== 0) return undefined;
    mask |= TARGET_FLAG_TRADE_ITEM;
  }
  const source = spec.source; // 11.02-E
  if (source !== undefined) { // 11.02-E
    if (!Number.isFinite(source.x) || !Number.isFinite(source.y) || !Number.isFinite(source.z)) return undefined; // 11.02-E
    mask |= TARGET_FLAG_SOURCE_LOCATION; // 11.02-E
  } // 11.02-E
  const point = spec.destination;
  if (point !== undefined) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return undefined;
    mask |= TARGET_FLAG_DEST_LOCATION;
  }
  return mask;
}

/** Appends the targets block; false (nothing written) for a spec {@link spellTargetMask} refuses. */
export function writeSpellTargets(writer: PacketWriter, spec: SpellTargetSpec): boolean {
  const mask = spellTargetMask(spec);
  if (mask === undefined) return false;
  writer.u32(mask);
  if (present(spec.unit)) writer.packedGuid(spec.unit);
  else if (present(spec.gameObject)) writer.packedGuid(spec.gameObject);
  if (present(spec.item)) writer.packedGuid(spec.item);
  else if (spec.tradeSlot !== undefined) writer.packedGuid(BigInt(spec.tradeSlot));
  const source = spec.source; // 11.02-E: SOURCE_LOCATION before DEST_LOCATION (SpellCastTargets::Read)
  if (source !== undefined) writer.packedGuid(0n).f32(source.x).f32(source.y).f32(source.z); // 11.02-E
  const point = spec.destination;
  if (point !== undefined) writer.packedGuid(0n).f32(point.x).f32(point.y).f32(point.z);
  return true;
}

/**
 * `CMSG_USE_ITEM` with an explicit target: `u8 bag, u8 slot, u8 castCount, u32 spellId, u64 item,
 * u32 glyphIndex, u8 castFlags`, then the targets (`HandleUseItemOpcode`, SpellHandler.cpp:75-86,
 * :169-177). The core casts the item's own spells (`Player::CastItemUseSpell`); `spellId` is only
 * logged there. Undefined for a spec that cannot be written.
 */
export function buildUseItemTargeted(bag: number, slot: number, castCount: number, spellId: number,
  itemGuid: bigint, spec: SpellTargetSpec, glyphIndex = 0): Uint8Array | undefined {
  const writer = new PacketWriter().u8(bag).u8(slot).u8(castCount).u32(spellId >>> 0)
    .u64(itemGuid).u32(glyphIndex >>> 0).u8(0);
  return writeSpellTargets(writer, spec) ? writer.toUint8Array() : undefined;
}

/**
 * `CMSG_CAST_SPELL` with an explicit target: `u8 castCount, u32 spellId, u8 castFlags`, then the
 * targets (`HandleCastSpellOpcode`, SpellHandler.cpp:336). Undefined for a spec that cannot be written.
 */
export function buildCastSpellTargeted(spellId: number, castCount: number, spec: SpellTargetSpec): Uint8Array | undefined {
  const writer = new PacketWriter().u8(castCount).u32(spellId >>> 0).u8(0);
  return writeSpellTargets(writer, spec) ? writer.toUint8Array() : undefined;
}
