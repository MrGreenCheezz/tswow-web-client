/**
 * Plan item 3.39 (12.10): what a cast of the player's own files into the spell history when it goes off — the
 * spell's recovery, its category and the category's recovery — and which spell an item use casts.
 *
 * Wow.exe 3.3.5a 12340 (read-only Ghidra, 2026-10-12):
 * - The entry layout (writer 0x00805230, reader 0x00807980): +0x08 spell, +0x0c item, +0x10 start, +0x14 recovery,
 *   +0x18 category, +0x1c category start, +0x20 category recovery, +0x24 held (byte), +0x28 global category,
 *   +0x2c global length. 0x00807980 holds an asked spell by the entry's own spell and item, by the category part
 *   when the entry's category is the asked spell's Category (record +0x4; the item's own category when asked for
 *   an item, 0x00809030), and by the global part (PredictedGlobalCooldown.ts); a held entry holds without an end.
 * - SMSG_SPELL_GO (0x0080e1b0) for a cast whose caster unit is the player writes one entry: no cast item
 *   (0x0080f8a0…0x0080fa35) — RecoveryTime, Category, CategoryRecoveryTime, started at the GO; an item cast
 *   (0x0080fa69…0x0080fc37, through the item cache: spell slots +0x100, cooldown +0x13c, category +0x150, category
 *   cooldown +0x164) — the item's numbers, the row's where the item's is negative (a category below 1). The global
 *   part stays 0: the request wrote that one. The entry is held (+0x24) when 0x00801220 says the cooldown starts on
 *   an event: the cast item's spell category with SpellCategory.Flags 4, else SPELL_ATTR0_DISABLED_WHILE_ACTIVE.
 * - SMSG_COOLDOWN_EVENT (0x00804010 → 0x00802ba0 → 0x00802970) lets go of the spell's held entries: start and
 *   category start become now, so the recovery and the category part run from the event. An entry not held is left
 *   alone; SMSG_CLEAR_COOLDOWN (the same path) removes every entry of the spell.
 * - SMSG_SPELL_COOLDOWN (0x00806dd0) files a category part only when the packet's duration is 0 (the row's).
 *
 * The spell modifiers Wow.exe applies to a spell cast's recovery (SPELLMOD_COOLDOWN, 0x007fd970 with 0xb) and its
 * category recovery (0x007fef60) are left out, as the bars' own durations leave them out: SMSG_SET_FLAT/PCT
 * name a family bit, not the spell (GlobalCooldownDuration.ts).
 */
import type { ItemSpell } from "./QueryCacheProtocol.js";

/**
 * `ItemSpelltriggerType` values that spend the item on use (0), as a soulstone (4), on use without delay (5) or
 * by teaching (6) — the same family the tooltip calls «при использовании». Equip (1) and proc (2) triggers never
 * pass through `CMSG_USE_ITEM`. (Moved here from browser/game/GroundTarget.ts, which re-exports it.)
 */
export const ITEM_USE_TRIGGERS: ReadonlySet<number> = new Set([0, 4, 5, 6]);

/** What using the item would cast: the first use-trigger spell, if any. */
export function itemUseSpellId(
  template: { spells?: ReadonlyArray<{ spellId: number; trigger: number }> } | undefined,
): number | undefined {
  const spells = template?.spells;
  if (!spells) return undefined;
  for (const spell of spells) {
    if (ITEM_USE_TRIGGERS.has(spell.trigger) && Number.isSafeInteger(spell.spellId) && spell.spellId > 0) {
      return spell.spellId;
    }
  }
  return undefined;
}

/**
 * 3.39 (12.10): the category an item's cooldown is asked under for `spellId` — Wow.exe 0x00807980 with an item
 * (GetItemCooldown 0x00809030, GetContainerItemCooldown and the use's check 0x008090c0) walks the item's five spell
 * slots and takes the category (+0x150) of the last slot naming the spell with one above 0; undefined leaves the
 * spell row's Category (WorldClient's `askedCategory`).
 */
export function itemUseSpellCategory(
  template: { spells?: ReadonlyArray<{ spellId: number; category?: number }> } | undefined,
  spellId: number,
): number | undefined {
  let category: number | undefined;
  for (const spell of template?.spells ?? []) {
    if (spell.spellId === spellId && spell.category !== undefined && spell.category > 0) category = spell.category;
  }
  return category;
}

/** The cooldown columns of a Spell.dbc row the page knows (`/dbc/spells`; `category` since v=19). */
export interface SpellCooldownRow {
  /** Spell.dbc Category; undefined from a gateway older than v=19. */
  readonly category?: number | undefined;
  readonly recoveryTime: number;
  readonly categoryRecoveryTime: number;
  /** SPELL_ATTR0_DISABLED_WHILE_ACTIVE, or a Category whose SpellCategory.Flags has 4 (gateway SpellMetadata.ts). */
  readonly cooldownStartedOnEvent: boolean;
}

/** One history entry's parts, as the GO files them (0x0080e1b0). */
export interface SpellCooldownParts {
  readonly recovery: number;
  /** 0: none. */
  readonly category: number;
  readonly categoryDuration: number;
  /** Held until SMSG_COOLDOWN_EVENT (0x00801220). */
  readonly onEvent: boolean;
}

/**
 * The parts of a GO of `row`'s spell, cast from an item whose spell slot is `itemSpell` when it is one. Nothing is
 * known without a row and an item slot. `knownCategory` stands in for a row older than v=19 (the category the
 * login's history named). The held rule reads the row's flag for an item cast too: the item's own category's
 * SpellCategory flags are not served, and on this dataset only category 4 (the potions) has flag 4, the
 * Category of every potion's spell as well.
 */
export function spellCooldownParts(
  row: SpellCooldownRow | undefined,
  itemSpell: Pick<ItemSpell, "cooldown" | "category" | "categoryCooldown"> | undefined,
  knownCategory = 0,
): SpellCooldownParts | undefined {
  if (row === undefined && itemSpell === undefined) return undefined;
  const rowCategory = row?.category ?? knownCategory;
  return {
    recovery: itemSpell !== undefined && itemSpell.cooldown >= 0 ? itemSpell.cooldown : Math.max(0, row?.recoveryTime ?? 0),
    category: itemSpell !== undefined && itemSpell.category >= 1 ? itemSpell.category : rowCategory,
    categoryDuration: itemSpell !== undefined && itemSpell.categoryCooldown >= 0
      ? itemSpell.categoryCooldown : Math.max(0, row?.categoryRecoveryTime ?? 0),
    onEvent: row?.cooldownStartedOnEvent === true,
  };
}
