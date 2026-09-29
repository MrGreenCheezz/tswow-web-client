import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCharacterStatCatalog, parseCharacterStatTable, parseCharacterRatingScalar, type CharacterStatCatalog } from "../world/CharacterStatData.js";

/** Read the configured dataset, just like the other `/dbc/` metadata owners. */
export async function loadCharacterStatData(directory: string): Promise<CharacterStatCatalog> {
  const [base, ratio, ratings, scalar] = await Promise.all([
    readFile(join(directory, "gtChanceToSpellCritBase.dbc")),
    readFile(join(directory, "gtChanceToSpellCrit.dbc")),
    readFile(join(directory, "gtCombatRatings.dbc")),
    readFile(join(directory, "gtOCTClassCombatRatingScalar.dbc")),
  ]);
  const catalog = {
    spellCritBase: parseCharacterStatTable(base),
    spellCritPerIntellect: parseCharacterStatTable(ratio),
    combatRatingPerLevel: parseCharacterStatTable(ratings),
    combatRatingScalar: parseCharacterRatingScalar(scalar),
  };
  if (!isCharacterStatCatalog(catalog)) throw new Error("Character stat table class/level rows disagree");
  return catalog;
}
