import type { SpellMetadata } from "../SpellMetadata.js";
import type { SkillEntry } from "./Skills.js";
import type { SkillLineInfo, SpellSkillAbilityInfo } from "../../gateway/TalentMetadata.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";

export interface ProfessionData {
  skillLine(id: number): SkillLineInfo | undefined;
  skillOfSpell(id: number): number | undefined;
  spellAbilitiesOf?(id: number): readonly SpellSkillAbilityInfo[] | undefined;
}

/** SharedDefines.h: opening a trade window and contributing the character's skill. */
export const SPELL_EFFECT_TRADE_SKILL = 47;
const SPELL_EFFECT_SKILL = 118;
const ITEM_CREATION_EFFECTS = [24, 157];
const ITEM_ENCHANT_EFFECTS = [53, 54, 156];

export function professionSpellSkill(spell: SpellMetadata, data: ProfessionData | undefined): number | undefined {
  const index = spell.effects?.indexOf(SPELL_EFFECT_SKILL) ?? -1;
  return index >= 0 && (spell.effectMiscValue[index] ?? 0) > 0
    ? spell.effectMiscValue[index] : data?.skillOfSpell(spell.id);
}

export function professionOpener(spell: SpellMetadata | undefined): boolean {
  return spell?.effects?.includes(SPELL_EFFECT_TRADE_SKILL) ?? false;
}

/** Includes custom craft rows whose authors omitted TRADESPELL but supplied a craft effect. */
export function professionRecipe(spell: SpellMetadata | undefined): boolean {
  return !!spell && !spell.hidden && !spell.passive && !professionOpener(spell)
    && (spell.tradeSkill === true || (spell.effects ?? []).some((effect) =>
      ITEM_CREATION_EFFECTS.includes(effect) || ITEM_ENCHANT_EFFECTS.includes(effect)));
}

export function learnedProfessions(
  skills: readonly SkillEntry[], spells: readonly SpellMetadata[], data: ProfessionData | undefined,
): SkillEntry[] {
  return skills.filter((skill) => {
    const category = data?.skillLine(skill.skillId)?.categoryId;
    if (category === 11) return true;
    // Secondary skills also contain racials and riding. A visible skill-bearing ability is what
    // distinguishes fishing/first aid/cooking; names and a stock-only id allowlist do not.
    //
    // Custom TSWoW lines live outside the stock categories entirely. Any other line that owns
    // opener, recipe or skill-effect spells is a profession the craft windows can actually open —
    // without this its recipes would leave the book for a window that never lists them.
    if (category === 9 || category === undefined
      || ![5, 6, 7, 8, 10, 12].includes(category)) {
      return spells.some((spell) => !spell.hidden && !spell.passive
        && professionSpellSkill(spell, data) === skill.skillId
        && (professionOpener(spell) || professionRecipe(spell)
          || (spell.effects ?? []).includes(SPELL_EFFECT_SKILL)));
    }
    return false;
  });
}

export function professionRecipes(
  skillId: number, known: readonly SpellMetadata[], data: ProfessionData | undefined,
): SpellMetadata[] {
  return known.filter((spell) => professionRecipe(spell)
    && (data?.spellAbilitiesOf?.(spell.id)?.some((ability) => ability.skillLine === skillId)
      ?? professionSpellSkill(spell, data) === skillId));
}

export function craftableCount(spell: SpellMetadata, owned: ReadonlyMap<number, number>): number | undefined {
  if (spell.reagents === undefined) return undefined;
  if (spell.reagents.length === 0) return Infinity;
  return Math.min(...spell.reagents.map(({ itemId, count }) => Math.floor((owned.get(itemId) ?? 0) / count)));
}

export function recipeRequiresItem(spell: SpellMetadata): boolean {
  return (spell.effects ?? []).some((effect) => ITEM_ENCHANT_EFFECTS.includes(effect));
}

export function recipeAcceptsItem(
  spell: SpellMetadata, item: Pick<ItemTemplate, "itemClass" | "subClass" | "inventoryType">,
): boolean {
  if (!recipeRequiresItem(spell)) return false;
  if ((spell.equippedItemClass ?? -1) >= 0 && item.itemClass !== spell.equippedItemClass) return false;
  if (spell.equippedItemSubclass && (spell.equippedItemSubclass & (1 << item.subClass)) === 0) return false;
  if (spell.equippedItemInvTypes && (spell.equippedItemInvTypes & (1 << item.inventoryType)) === 0) return false;
  return true;
}

export function recipeDifficulty(skill: SkillEntry, ability: SpellSkillAbilityInfo | undefined): string {
  if (!ability || ability.trivialSkillLineRankHigh <= 0) return "";
  if (skill.value >= ability.trivialSkillLineRankHigh) return "gray";
  if (skill.value >= Math.floor((ability.trivialSkillLineRankHigh + ability.trivialSkillLineRankLow) / 2)) return "green";
  return skill.value >= ability.trivialSkillLineRankLow ? "yellow" : "orange";
}

export type CraftSort = "name" | "level" | "difficulty";

const CRAFT_DIFFICULTY_ORDER: Record<string, number> = {
  orange: 0, yellow: 1, green: 2, gray: 3,
};

export interface CraftRecipeRow {
  readonly spell: SpellMetadata;
  readonly difficulty: string;
}

/** Hardest first; unknown difficulty sinks below gray, never above orange. */
export function sortCraftRecipes(rows: readonly CraftRecipeRow[], sort: CraftSort): CraftRecipeRow[] {
  const ranked = (difficulty: string): number => CRAFT_DIFFICULTY_ORDER[difficulty] ?? 4;
  return [...rows].sort((left, right) => {
    if (sort === "level") {
      return left.spell.spellLevel - right.spell.spellLevel || left.spell.name.localeCompare(right.spell.name);
    }
    if (sort === "difficulty") {
      return ranked(left.difficulty) - ranked(right.difficulty) || left.spell.name.localeCompare(right.spell.name);
    }
    return left.spell.name.localeCompare(right.spell.name);
  });
}

/**
 * Recipes whose reagents allow at least one craft. Anything without a countable cost (no
 * reagents entry, or the unlimited kind) always passes: the filter hides what cannot be made,
 * never what costs nothing to try.
 */
export function filterCraftable(
  rows: readonly CraftRecipeRow[],
  owned: ReadonlyMap<number, number>,
  craftableOnly: boolean,
): CraftRecipeRow[] {
  if (!craftableOnly) return [...rows];
  return rows.filter(({ spell }) => {
    const available = craftableCount(spell, owned);
    return available === undefined || available === Infinity || available > 0;
  });
}
