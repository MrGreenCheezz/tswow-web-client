import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * END_BOUND_TRADEABLE (plan items 2.05 and 3.22, lane L1): the client's question before an action
 * that ends a soulbound item's two-hour trade window. Wow.exe 12340, read-only Ghidra
 * (`.runtime/re-2026-10-03/l1-item-cursor/`, earlier `.runtime/re-2026-09-30/m3/`, `gw-data/`):
 *
 * - The event is 0x28d (`END_BOUND_TRADEABLE`, event-name table 0x00C24EB0), raised with one string,
 *   the kind `EndBoundTradeable(kind)` (0x005233d0) answers with. Two places raise it:
 *   0x005210d0 — an enchanting spell over an item — with "itemenchant", and 0x0080c790 — a spell with
 *   SPELL_ATTR0_TARGET_MAINHAND_ITEM whose ENCHANT_ITEM_TEMPORARY picks the worn weapon itself — with
 *   "spellenchant". The third kind, "gem" (string at 0x00a02ba4), is raised by stock Lua alone
 *   (Blizzard_ItemSocketingUI.xml:410, `GetSocketItemBoundTradeable`).
 * - `EndBoundTradeable("itemenchant")` re-runs 0x005210d0 for the stored item with every question
 *   answered (param 3 = 1: BIND_ENCHANT, END_REFUND and this one skipped, REPLACE_ENCHANT still asked)
 *   — what `BindEnchant` (0x00522f70) and `EndRefund(1)` (0x00523370) do too. "gem" → 0x005c4ff0
 *   (AcceptSockets). "spellenchant" → 0x0080da40 with the stored spell and item, when one is stored.
 *
 * The item test, 0x005210d0 after the BIND_ENCHANT and END_REFUND questions, for the first enchanting
 * effect (53 ENCHANT_ITEM, 54 ENCHANT_ITEM_TEMPORARY, 156 ENCHANT_ITEM_PRISMATIC): the item is bound
 * (0x00708520) but not bound for good (!0x00709550 = !0x00708b40 && !0x007073e0), and a temporary
 * enchantment asks only when its own SpellItemEnchantment row carries ENCHANTMENT_CAN_SOULBOUND.
 * 0x00708b40 for a soulbound item: bound for good unless ITEM_FIELD_FLAG_BOP_TRADEABLE (0x100) is set,
 * the item's owner is the active player and `created − played > −7200` (ITEM_FIELD_CREATE_PLAYED_TIME
 * against the played seconds 0x006cf440, signed 32-bit).
 *
 * A fact this client can lack — played time, the enchantment table, an enchantment row on the item —
 * means no question: the action goes out as before and the realm binds the item.
 */

/** `ITEM_FIELD_FLAG_SOULBOUND` (ItemTemplate.h), ITEM_FIELD_FLAGS bit 0. */
export const ITEM_FIELD_FLAG_SOULBOUND = 0x01;
/** `ITEM_FIELD_FLAG_BOP_TRADEABLE` (ItemTemplate.h): soulbound, but still tradeable for two played hours. */
export const ITEM_FIELD_FLAG_BOP_TRADEABLE = 0x100;
/** Wow.exe 0x00708b40's window: 0x1c20 played seconds. */
export const BOP_TRADE_WINDOW_SECONDS = 7200;
/** `ENCHANTMENT_CAN_SOULBOUND` (DBCEnums.h), SpellItemEnchantment.Flags bit 0. */
const ENCHANTMENT_CAN_SOULBOUND = 0x01;
/** `MAX_ENCHANTMENT_SLOT`: the twelve ITEM_FIELD_ENCHANTMENT_n triples 0x007073e0 walks. */
const ENCHANTMENT_SLOTS = 12;
const EFFECT_ENCHANT_ITEM = 53;
const EFFECT_ENCHANT_ITEM_TEMPORARY = 54;
const EFFECT_ENCHANT_ITEM_PRISMATIC = 156;

/** The kinds END_BOUND_TRADEABLE carries and `EndBoundTradeable` answers (0x005233d0). */
export const END_BOUND_TRADEABLE_ITEM_ENCHANT = "itemenchant";
export const END_BOUND_TRADEABLE_GEM = "gem";
export const END_BOUND_TRADEABLE_SPELL_ENCHANT = "spellenchant";

/** SpellItemEnchantment.Flags by enchantment id; undefined when the row or the table is not known. */
export type BoundTradeableFlagsOf = (enchantId: number) => number | undefined;

function itemOwner(item: WorldObjectState): bigint {
  const low = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_OWNER.offset) ?? 0;
  const high = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_OWNER.offset + 1) ?? 0;
  return (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
}

/**
 * Wow.exe 0x007073e0 with this client's gaps: true when an enchantment on the item binds it, false
 * when none does, undefined when an enchantment is there whose flags are not known (no table yet,
 * or a gateway older than the Flags column).
 */
export function itemBoundByEnchantmentKnown(item: WorldObjectState, flagsOf: BoundTradeableFlagsOf): boolean | undefined {
  let unknown = false;
  for (let slot = 0; slot < ENCHANTMENT_SLOTS; slot++) {
    const enchant = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + slot * 3) ?? 0;
    if (enchant === 0) continue;
    const flags = flagsOf(enchant);
    if (flags === undefined) unknown = true;
    else if ((flags & ENCHANTMENT_CAN_SOULBOUND) !== 0) return true;
  }
  return unknown ? undefined : false;
}

/**
 * A soulbound item still inside its trade window (!0x00708b40): ITEM_FIELD_FLAG_SOULBOUND and
 * ITEM_FIELD_FLAG_BOP_TRADEABLE, owned by `selfGuid`, created less than 7200 played seconds ago.
 * False when the played time or the player is unknown.
 */
export function itemStillBopTradeable(
  item: WorldObjectState | undefined, playedSeconds: number | undefined, selfGuid: bigint | undefined,
): boolean {
  if (!item || playedSeconds === undefined || !Number.isFinite(playedSeconds) || selfGuid === undefined) return false;
  const flags = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_FLAGS.offset) ?? 0;
  if ((flags & ITEM_FIELD_FLAG_SOULBOUND) === 0 || (flags & ITEM_FIELD_FLAG_BOP_TRADEABLE) === 0) return false;
  if (itemOwner(item) !== selfGuid) return false;
  const created = item.fields.get(UPDATE_FIELDS.ITEM_FIELD_CREATE_PLAYED_TIME.offset) ?? 0;
  // The client subtracts two signed 32-bit words: bound for good once created − played ≤ −7200.
  return ((created - Math.trunc(playedSeconds)) | 0) > -BOP_TRADE_WINDOW_SECONDS;
}

/**
 * Whether 0x005210d0 raises END_BOUND_TRADEABLE("itemenchant") before this spell goes on this item
 * (its first enchanting effect decides): the item is soulbound, bound by no enchantment and still in
 * its trade window; for ENCHANT_ITEM_TEMPORARY only when the new enchantment itself binds. The
 * questions before it (BIND_ENCHANT, END_REFUND) are the caller's; an answered re-run never asks.
 */
export function enchantEndsBoundTrade(
  effects: readonly number[] | undefined, miscValues: readonly number[] | undefined,
  item: WorldObjectState | undefined, playedSeconds: number | undefined, selfGuid: bigint | undefined,
  flagsOf: BoundTradeableFlagsOf,
): boolean {
  if (!effects || !item) return false;
  const index = effects.findIndex((effect) =>
    effect === EFFECT_ENCHANT_ITEM || effect === EFFECT_ENCHANT_ITEM_TEMPORARY || effect === EFFECT_ENCHANT_ITEM_PRISMATIC);
  if (index < 0) return false;
  if (effects[index] === EFFECT_ENCHANT_ITEM_TEMPORARY) {
    const flags = flagsOf(miscValues?.[index] ?? 0);
    if (flags === undefined || (flags & ENCHANTMENT_CAN_SOULBOUND) === 0) return false;
  }
  if (itemBoundByEnchantmentKnown(item, flagsOf) !== false) return false;
  return itemStillBopTradeable(item, playedSeconds, selfGuid);
}
