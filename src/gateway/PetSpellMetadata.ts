// 4.04 (11.11): a creature family's pet spells for the browser, `GET /dbc/pet-spells?v=1` — a row of CatalogRoutes.ts
// (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Why: beast lore's PET_SPELLS_TEMPLATE line. Wow.exe 3.3.5a 12340 writes it in 0x00620950 (Ghidra,
// .runtime/re-2026-10-11/glue-1110/t1013-a.txt) for a tameable creature: for the family's SkillLine[0] and then
// SkillLine[1] (CreatureFamily record +0x14, +0x18), every SkillLineAbility row in table order on that skill line
// with SupercededBySpell 0 (+0x20) and AcquireMethod 2 (+0x24) whose Spell row exists and has neither PASSIVE (0x40)
// nor HIDDEN_CLIENTSIDE (0x80) in its first attribute byte gives its Spell name (+0x220), joined by ", ".
//
// Layouts: CreatureFamily "nfifiiiiixss…" (PetFoodMetadata.ts; SkillLine is fields 5 and 6), SkillLineAbility and
// Spell by the generated layouts.
//
//   { version: 1, families: [[familyId, [spellName, …]], …] } — families with at least one name, names in that order.

import { DEFAULT_LOCALE, openDbcFile } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { CREATURE_FAMILY_LAYOUT } from "./CreatureTypeMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const PET_SPELLS_VERSION = 1;

const FAMILY_SKILL_LINE_FIELDS = [5, 6] as const;
const SPELL_ATTR0_PASSIVE_OR_HIDDEN = 0xc0;
const ACQUIRE_ON_SKILL_LEARN = 2;

export interface PetSpellCatalog {
  version: number;
  families: [id: number, spells: string[]][];
}

/** One SkillLineAbility row as 0x00620950 reads it. */
export interface PetSpellAbility {
  readonly skillLine: number;
  readonly spell: number;
  readonly supercededBy: number;
  readonly acquireMethod: number;
}

/** The catalog out of already-read rows; pure, so a test can feed it synthetic tables. */
export function petSpellCatalog(
  families: readonly { readonly id: number; readonly skillLines: readonly number[] }[],
  abilities: readonly PetSpellAbility[],
  spell: (id: number) => { readonly attributes: number; readonly name: string } | undefined,
): PetSpellCatalog {
  const result: [number, string[]][] = [];
  for (const family of families) {
    const names: string[] = [];
    for (const skillLine of family.skillLines) {
      if (skillLine === 0) continue;
      for (const ability of abilities) {
        if (ability.skillLine !== skillLine || ability.supercededBy !== 0 || ability.acquireMethod !== ACQUIRE_ON_SKILL_LEARN) continue;
        const row = spell(ability.spell);
        if (!row || (row.attributes & SPELL_ATTR0_PASSIVE_OR_HIDDEN) !== 0) continue;
        names.push(row.name);
      }
    }
    if (names.length > 0) result.push([family.id, names]);
  }
  return { version: PET_SPELLS_VERSION, families: result };
}

export async function loadPetSpells(dbcDirectory: string, locale: DbcLocale = DEFAULT_LOCALE): Promise<PetSpellCatalog> {
  const [familyRows, abilityTable, spellTable] = await Promise.all([
    readFixed(dbcDirectory, "CreatureFamily", CREATURE_FAMILY_LAYOUT),
    openDbcFile(dbcDirectory, "SkillLineAbility"),
    openDbcFile(dbcDirectory, "Spell"),
  ]);
  const families = familyFields(familyRows);
  const abilities: PetSpellAbility[] = [];
  for (const row of abilityTable.rows()) {
    abilities.push({
      skillLine: abilityTable.int(row, "SkillLine"), spell: abilityTable.int(row, "Spell"),
      supercededBy: abilityTable.int(row, "SupercededBySpell"), acquireMethod: abilityTable.int(row, "AcquireMethod"),
    });
  }
  return petSpellCatalog(families, abilities, (id) => {
    const row = spellTable.rowOf(id);
    return row === undefined ? undefined
      : { attributes: spellTable.int(row, "Attributes") >>> 0, name: spellTable.locstring(row, "Name_lang", locale) };
  });
}

function familyFields(rows: FixedRows): { id: number; skillLines: number[] }[] {
  const families: { id: number; skillLines: number[] }[] = [];
  for (let row = 0; row < rows.records; row++) {
    families.push({ id: rows.int(row, 0), skillLines: FAMILY_SKILL_LINE_FIELDS.map((field) => rows.int(row, field)) });
  }
  return families;
}
