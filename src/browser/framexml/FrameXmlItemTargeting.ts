/**
 * The stock UI's side of the item-target spell cursor (plan item 2.05, mechanism M3;
 * game/SpellCursor.ts holds the cursor).
 *
 * C functions, from Wow.exe 12340's registration table and bodies:
 * - `SpellCanTargetItem` (0x007fdd10): 1 while the pending spell's missing targets include ITEM or
 *   GAMEOBJECT_ITEM (mask & 0x4010), nil otherwise. The enchant of the stock TradeSkillFrame
 *   (FrameXmlTradeSkill.ts) answers after this cursor.
 * - `SpellTargetItem(itemID|"name"|"itemlink")` (0x008007e0): with that cursor up, the carried item
 *   the argument names becomes the target (0x005210d0); nothing otherwise.
 * - `SpellTargetUnit("unit")` (0x0080dc00 → 0x0080dbd0 → 0x0080bc80) and `SpellCanTargetUnit`
 *   (0x00804190): a unit fills only a pending unit, corpse or minipet target. Neither this cursor
 *   (items only) nor the ground reticle (a point) waits for one, so both answer nothing — which is
 *   what the client answers for them (0x0080bc80 returns false, no message).
 * - `ClickTargetTradeButton(index)` (0x00586c80): index 7 with a trade open puts the pending spell on
 *   the trader's «will not be traded» slot (0x005198a0 → 0x0080c5f0, TARGET_FLAG_TRADE_ITEM, slot 6)
 *   — the stock TradeSkillFrame's enchant first, else this cursor — after TRADE_REPLACE_ENCHANT when
 *   that item is already enchanted.
 * - `ReplaceEnchant` (0x005167a0) and `ReplaceTradeEnchant` (0x00510b80): the REPLACE_ENCHANT and
 *   TRADE_REPLACE_ENCHANT answers. `BindEnchant` is not bound: BIND_ENCHANT is never raised here.
 * - L1 (03.10): `EndBoundTradeable(kind)` (0x005233d0) answers END_BOUND_TRADEABLE
 *   (FrameXmlBoundTradeable.ts); `DropItemOnUnit("unit")` (0x0051bdd0) wears, trades or feeds the held
 *   bag item (FrameXmlDropItemOnUnit.ts); `SpellTargetItem`'s walk visits the currency tokens.
 *
 * `SpellIsTargeting`/`SpellStopTargeting` already reach this cursor through the native targeting
 * step (Controls.ts, FrameXmlGameMenuController.ts) at the end of the glyph → trade skill chain.
 */

import { globalString } from "../../generated/globalStrings.js";
import { readField, worldObject } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { cancelItemTarget, pendingItemTarget } from "../game/SpellCursor.js";
import { INVENTORY_SLOT_BAG_0, type ItemSlotState, type PlayerInventoryState } from "../Inventory.js";
import { runFrameXmlNativeEscape } from "./FrameXmlGameMenuController.js";
import { FRAMEXML_TRADESKILL_BINDINGS } from "./FrameXmlTradeSkill.js";
import type { FrameXmlSeamBinding, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { frameXmlEndBoundTradeable } from "./FrameXmlBoundTradeable.js"; // L1 (2.05/3.22)

const NOTHING: readonly unknown[] = Object.freeze([]);

/** The trade window's seventh slot (TradeFrame.lua: `TRADE_ENCHANT_SLOT = MAX_TRADE_ITEMS = 7`). */
export const FRAMEXML_TRADE_ENCHANT_SLOT = 7;

/** A GlobalStrings.lua name as UIErrorsFrame shows it; the name itself when the table lacks it. */
export function frameXmlItemTargetErrorText(error: string): string {
  return globalString(error) ?? error;
}

/**
 * `PickupContainerItem` on a bag item with nothing held drops whatever spell cursor is up before it
 * picks the item up (Wow.exe 0x005d7ff0 → 0x00809a60): the item cursor, the stock enchant and glyph
 * cursors, and the native reticle. True when something was dropped.
 */
export function frameXmlStopSpellTargeting(seam: Pick<FrameXmlWorldSeam, "tradeSkill" | "glyphs">): boolean {
  let stopped = cancelItemTarget();
  if (seam.tradeSkill?.cancelTargeting() === true) stopped = true;
  if (seam.glyphs?.cancelTargeting() === true) stopped = true;
  if (runFrameXmlNativeEscape("stopTargeting")) stopped = true;
  return stopped;
}

/** An item's entry out of `SpellTargetItem`'s argument: a number, or an `item:` hyperlink. */
function linkEntry(query: string): number | undefined {
  const match = /\|Hitem:(\d+)/.exec(query) ?? /^item:(\d+)/.exec(query);
  if (!match) return undefined;
  const entry = Number(match[1]);
  return Number.isSafeInteger(entry) && entry > 0 ? entry : undefined;
}

/** `ITEM_FIELD_FLAG_WRAPPED` and the unnamed 0x10 bit the client's walk skips items by (0x007546f0). */
const ITEM_FIELD_FLAG_WRAPPED = 0x08;
const ITEM_FIELD_FLAG_SKIPPED = 0x10;

/**
 * Whether the client's inventory walk passes an item over (Wow.exe 0x007546f0 without its 0x80
 * flag): a broken one (maximum durability set, durability 0) unless wrapped, or one with the 0x10
 * item flag.
 */
function skippedByWalk(item: WorldObjectState): boolean {
  const flags = readField(item, "ITEM_FIELD_FLAGS") ?? 0;
  if ((flags & ITEM_FIELD_FLAG_SKIPPED) !== 0) return true;
  const max = readField(item, "ITEM_FIELD_MAXDURABILITY") ?? 0;
  return (flags & ITEM_FIELD_FLAG_WRAPPED) === 0 && max !== 0 && (readField(item, "ITEM_FIELD_DURABILITY") ?? 0) === 0;
}

/**
 * The carried item `SpellTargetItem` names, found as Wow.exe 0x008007e0 finds it: a number by entry
 * (0x00754a20), a string holding `item:` by its link, anything else by name (0x00754af0 →
 * 0x00753b20) — case ignored and only as long as the argument: «льн» names «Льняная ткань»
 * (0x0076ea40 compares the argument's UTF-8 character count, 0x0076eea0). The first match in the
 * client's walk wins (0x007546f0 with flags 0x247, order table 0x00a37b10): the backpack, then each
 * bag — the bag itself, then what it holds — then the keyring, then the worn items. Broken items
 * are passed over ({@link skippedByWalk}). L1 (2.05): the currency-token slots 118–149 come between
 * the keyring and the worn items (`currency`, CarriedItems.ts: 0x00a37b14 sends 117 → 39,
 * the bank is filtered out, 73 → 118, 149 → 0).
 */
export function findSpellTargetItem(
  inventory: PlayerInventoryState | undefined,
  query: unknown,
  nameOf: (entry: number) => string | undefined,
  currency: readonly ItemSlotState[] = [], // L1 (2.05)
): ItemSlotState | undefined {
  if (!inventory) return undefined;
  let entry: number | undefined;
  let prefix: string | undefined;
  if (typeof query === "number" && Number.isSafeInteger(query) && query > 0) entry = query;
  else if (typeof query === "string" && query !== "") {
    // lua_isnumber takes a numeric string as the number it spells.
    const number = query.trim() === "" ? Number.NaN : Number(query);
    if (Number.isFinite(number)) {
      const whole = Math.trunc(number);
      if (whole > 0) entry = whole;
    } else if (query.includes("item:")) entry = linkEntry(query);
    else prefix = query.toLocaleLowerCase("ru-RU");
  }
  if (entry === undefined && prefix === undefined) return undefined;
  const places: ItemSlotState[] = [...inventory.backpack];
  for (const bag of inventory.bags) {
    places.push({ index: bag.bagSlot, item: bag.bag, guid: bag.guid, bag: INVENTORY_SLOT_BAG_0, slot: bag.bagSlot });
    places.push(...bag.slots);
  }
  places.push(...inventory.keyring, ...currency, ...inventory.equipment); // L1 (2.05): currency 118–149
  const wanted = prefix === undefined ? 0 : [...prefix].length;
  return places.find((place) => {
    if (!place.item || place.guid === 0n || skippedByWalk(place.item)) return false;
    const id = worldObject.entry(place.item) ?? 0;
    if (entry !== undefined) return id === entry;
    const name = nameOf(id)?.toLocaleLowerCase("ru-RU");
    return name !== undefined && [...name].slice(0, wanted).join("") === prefix;
  });
}

/**
 * Spread after FRAMEXML_TRADE_BINDINGS, FRAMEXML_TRADESKILL_BINDINGS and FRAMEXML_GLYPH_BINDINGS:
 * these names answer for the item cursor first and hand the rest back.
 */
export const FRAMEXML_ITEM_TARGETING_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  SpellCanTargetItem: (seam, args) => pendingItemTarget() !== undefined
    ? [1] : FRAMEXML_TRADESKILL_BINDINGS.SpellCanTargetItem!(seam, args),
  SpellTargetItem: (seam, args) => {
    seam.spellTargetItem?.(args[0]);
    return NOTHING;
  },
  SpellTargetUnit: () => NOTHING,
  SpellCanTargetUnit: () => NOTHING,
  ClickTargetTradeButton: (seam, args) => {
    const index = args[0];
    if (typeof index === "number" && Number.isInteger(index)) seam.clickTargetTradeButton?.(index);
    return NOTHING;
  },
  // The BIND_ENCHANT / REPLACE_ENCHANT / TRADE_REPLACE_ENCHANT answers (StaticPopup.lua:2330-2365).
  // BindEnchant (0x00522f70) re-runs 0x005210d0 for the named item with the bind question answered.
  BindEnchant: (seam) => {
    seam.bindEnchant?.();
    return NOTHING;
  },
  ReplaceEnchant: (seam) => {
    seam.replaceEnchant?.();
    return NOTHING;
  },
  ReplaceTradeEnchant: (seam) => {
    seam.replaceTradeEnchant?.();
    return NOTHING;
  },
  // L1 (1.10): wear, trade or feed the held bag item (Wow.exe 0x0051bdd0, FrameXmlDropItemOnUnit.ts).
  DropItemOnUnit: (seam, args) => {
    if (typeof args[0] === "string") seam.dropItemOnUnit?.(args[0].toLowerCase());
    seam.cursor?.sync();
    return NOTHING;
  },
  // L1 (2.05/3.22): END_BOUND_TRADEABLE's accept (Wow.exe 0x005233d0, FrameXmlBoundTradeable.ts).
  EndBoundTradeable: (seam, args) => {
    frameXmlEndBoundTradeable(seam, args[0]);
    return NOTHING;
  },
});
