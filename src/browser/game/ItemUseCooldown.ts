/**
 * Plan item 3.39 (12.10): an item use whose spell is recovering or held is refused at home, before any reticle,
 * cursor or packet, with the words Wow.exe says.
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, 2026-10-12):
 * - UseContainerItem (0x005d8650) uses the item through 0x00708c20, which hands it (0x0080da40) to the request
 *   builder 0x0080cce0. Its check 0x00739650 asks the history for an item request — 0x008090c0 → 0x00807980 with
 *   the item's spell and entry, so under the item's own category for that spell when it names one — and a
 *   recovering or held answer is refused with SPELL_FAILED_ITEM_NOT_READY (45, `0x2d`) through 0x00808200, before
 *   the targeting of 0x0080c790 and without a packet. (A spell request asks 0x00809000 there and is refused
 *   NOT_READY, 67: SpellCastGuard.ts.)
 * - 0x00808200 shows the game error that 0x00807f10 picks for 45 by the spell row's Category (record +0x4): 4 and 9
 *   ERR_POTION_COOLDOWN, 10 and 11 ERR_FOOD_COOLDOWN, any other ERR_ITEM_COOLDOWN — rows 0x32, 0x33 and 0x31 of the
 *   message table at 0x00ac8af0, all of type 2, the error frame. Its repeat rule (`local_14`: the same spell and
 *   result again within 3 s) keeps the frame quiet; the combat log's SPELL_CAST_FAILED carries the result's own
 *   words (WorldClient.spellRefusedLocally).
 */
import { globalString } from "../../generated/globalStrings.js";
import { itemUseSpellCategory } from "../../world/SpellCooldownParts.js";
import type { WorldClient } from "../../world/WorldClient.js";

/** SpellCastResult SPELL_FAILED_ITEM_NOT_READY (SharedDefines.h; 0x00739650's `0x2d`). */
export const SPELL_FAILED_ITEM_NOT_READY = 45;

/** The world's answers the check reads; the page's doubles may lack any of them (nothing is then refused). */
export type ItemUseCooldownWorld = Partial<Pick<WorldClient,
  "cooldownRemaining" | "itemCooldownRemaining" | "isSpellOnHold" | "spellRefusedLocally">>;

/** The item template's spell slots, as the query cache keeps them. */
export type ItemUseCooldownTemplate = { spells?: ReadonlyArray<{ spellId: number; category?: number }> } | undefined;

/**
 * Why the use of an item casting `spellId` is refused at home (0x00739650): its spell's timer, its category's
 * (asked under the item's own category, `itemUseSpellCategory`) or the item's equip cooldown runs — "cooldown" — or
 * an entry holds it until its event — "hold". Undefined: nothing is in the way. `globalEnd`: the end of the global
 * cooldown that holds the spell's row (`globalCooldownEndFor`; 0x00807980's global branch moves the end it answers,
 * so a running global part refuses the use too); the default 0 leaves it out, as `IsUsableAction` does.
 */
export function itemUseCooldownBlock(
  world: ItemUseCooldownWorld, template: ItemUseCooldownTemplate, spellId: number, now = performance.now(), globalEnd = 0,
): "cooldown" | "hold" | undefined {
  const category = itemUseSpellCategory(template, spellId);
  const remaining = Math.max(world.itemCooldownRemaining?.(spellId, now) ?? 0,
    world.cooldownRemaining?.(spellId, now, category) ?? 0);
  if (remaining > 0 || globalEnd > now) return "cooldown";
  return world.isSpellOnHold?.(spellId, category) === true ? "hold" : undefined;
}

/** 0x00807f10, case 0x2d: the GlobalStrings name of the error frame's words, by the spell row's Category. */
export function itemCooldownErrorName(rowCategory: number | undefined): string {
  if (rowCategory === 4 || rowCategory === 9) return "ERR_POTION_COOLDOWN";
  if (rowCategory === 10 || rowCategory === 11) return "ERR_FOOD_COOLDOWN";
  return "ERR_ITEM_COOLDOWN";
}

/**
 * Refuses the use when `itemUseCooldownBlock` says so — 0x00808200's local half with the words above — and says
 * whether it did. `rowCategory`: the spell row's Category, undefined when the page has no row (ERR_ITEM_COOLDOWN).
 */
export function refuseItemUseOnCooldown(
  world: ItemUseCooldownWorld, template: ItemUseCooldownTemplate, spellId: number, rowCategory: number | undefined,
  globalEnd = 0, now = performance.now(),
): boolean {
  if (itemUseCooldownBlock(world, template, spellId, now, globalEnd) === undefined) return false;
  const name = itemCooldownErrorName(rowCategory);
  world.spellRefusedLocally?.(spellId, SPELL_FAILED_ITEM_NOT_READY, globalString(name) ?? name);
  return true;
}
