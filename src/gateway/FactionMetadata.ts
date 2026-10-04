// `FactionTemplate.dbc`, whole.
//
// 841 rows of twelve numbers. Sent in one piece for the same reason the lock tables are: the
// question — is this unit an enemy — is asked of every unit in view, several times a second, and
// a round trip per creature would be absurd for a table that fits in a few tens of kilobytes.

import { openDbcFile } from "./Dbc.js";
import { FACTION_RELATIONS, type FactionData, type FactionTemplate } from "../world/FactionRules.js";

/**
 * L18 5.05: a template row as `/dbc/factions?v=3` serves it — the masks plus `FactionTemplate.Flags`
 * (column 2, DBCStructure.h:694; tools/dbd/FactionTemplate.dbd 3.3.5.12340), which Wow.exe reads at row
 * +8 for CONTESTED_GUARD 0x1000 (0x007251c0, 0x0071f770) and HOSTILE_BY_DEFAULT 0x2000 (0x00715440).
 * A gateway before v=3 sends rows without it; the browser reads that as "unknown".
 */
export interface FactionTemplateRow extends FactionTemplate {
  readonly flags: number;
}

export async function loadFactionData(dbcDirectory: string): Promise<FactionData> {
  const table = await openDbcFile(dbcDirectory, "FactionTemplate");
  // And the names, which come from the other table and are keyed differently. `SMSG_INITIALIZE_FACTIONS`
  // and the reputation block of the character's own fields are indexed by `ReputationIndex` — a
  // slot number from 0 to 127 — and not by the faction's id, so this is keyed the way the wire is.
  // Rows with an index of −1 are the ones a player can never have standing with; they are dropped.
  const names: Record<number, string> = {};
  // Tolerated rather than required: without the reaction table the client cannot tell a guard from
  // a quest giver, and without the names it prints a number. Only one of those is worth a 500.
  const factions = await openDbcFile(dbcDirectory, "Faction").catch(() => undefined);
  for (const row of factions?.rows() ?? []) {
    const index = factions!.int(row, "ReputationIndex");
    if (index < 0) continue;
    // `locstring`, not `string`: the name is seventeen slots wide and reading it as one field
    // takes whichever locale happens to sit first, which on this dataset is the English one.
    const name = factions!.locstring(row, "Name_lang");
    if (name) names[index] = name;
  }
  const templates: Record<number, FactionTemplateRow> = {}; // L18 5.05: was FactionTemplate
  for (const row of table.rows()) {
    const id = table.id(row);
    if (id <= 0) continue;
    const enemies: number[] = [];
    const friends: number[] = [];
    for (let index = 0; index < FACTION_RELATIONS; index++) {
      // Zero is "no relation" rather than faction 0, so the empty slots are dropped here instead
      // of being compared against every unit that has no faction of its own.
      const enemy = table.int(row, "Enemies", index);
      if (enemy) enemies.push(enemy);
      const friend = table.int(row, "Friend", index);
      if (friend) friends.push(friend);
    }
    templates[id] = {
      faction: table.int(row, "Faction"),
      flags: table.int(row, "Flags"), // L18 5.05
      factionGroup: table.int(row, "FactionGroup"),
      friendGroup: table.int(row, "FriendGroup"),
      enemyGroup: table.int(row, "EnemyGroup"),
      enemies,
      friends,
    };
  }
  return { templates, names };
}
