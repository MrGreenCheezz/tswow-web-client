/**
 * 15.11 (6.14): the enchant glow of a weapon on the character-select and creation figures.
 *
 * Both screens hang a hand slot through 0x004eacd0 with an ItemVisuals id as its last argument, and
 * 0x004eacd0 falls back to the display's own `ItemDisplayInfo.ItemVisual` (+0x5c) when that argument is
 * 0; 0x004eaa70 → 0x004ea8f0 then hangs the row's five effect models on the weapon (WeaponGlow.ts).
 *
 * - The select screen (0x004e3cd0) passes the enchant's ItemVisual that SMSG_CHAR_ENUM carries per slot
 *   (TrinityCore `Player::BuildEnumData`: the first of the permanent and temporary enchants with a row,
 *   its `SpellItemEnchantment.ItemVisual`) — but passes 0 instead when the display's own ItemVisual names
 *   a row of ItemVisuals (the store at 0x00ad3f8c, looked up through 0x0065c290 with the display's +0x5c):
 *   a weapon that glows by itself keeps its own glow and the enchant's is not drawn.
 * - The creation screen (0x004e0fd0 → 0x004ef900) passes 0: only a display's own glow.
 *
 * Only the three hand slots are hung by 0x004eacd0, so only they glow.
 */
import type { EnchantGlowTables } from "../ItemEnchantments.js";

const GLOW_SLOTS = new Set([15, 16, 17]);

/** The ItemVisuals id a figure's weapon is hung with (0 for none), by the rule above. */
export function figureGlowVisual(
  slot: number,
  enchantVisual: number,
  displayId: number | undefined,
  tables: Pick<EnchantGlowTables, "itemVisualSlots" | "displayVisuals">,
): number {
  if (!GLOW_SLOTS.has(slot)) return 0;
  const own = displayId !== undefined && displayId > 0 ? tables.displayVisuals.get(displayId) ?? 0 : 0;
  if (own > 0 && tables.itemVisualSlots.has(own)) return own;
  return enchantVisual > 0 ? enchantVisual : own;
}

/** The five ItemVisuals slots that visual hangs, or undefined for none. */
export function figureGlowSlots(
  slot: number,
  enchantVisual: number,
  displayId: number | undefined,
  tables: Pick<EnchantGlowTables, "itemVisualSlots" | "displayVisuals">,
): readonly (string | null)[] | undefined {
  const visual = figureGlowVisual(slot, enchantVisual, displayId, tables);
  return visual > 0 ? tables.itemVisualSlots.get(visual) : undefined;
}
