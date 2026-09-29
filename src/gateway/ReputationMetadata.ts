import { DbcError, openDbcFile } from "./Dbc.js";

export interface ReputationFaction {
  factionId: number;
  raceMasks: number[];
  classMasks: number[];
  bases: number[];
  flags: number[];
}

export interface ReputationCatalog {
  version: 1;
  factions: Record<string, ReputationFaction>;
}

/** Faction.dbc bases are signed; masks retain all 32 bits. Packet keys are list indexes, not IDs. */
export async function loadReputationMetadata(dbcDirectory: string): Promise<ReputationCatalog> {
  const table = await openDbcFile(dbcDirectory, "Faction");
  const factions: Record<string, ReputationFaction> = {};
  for (const row of table.rows()) {
    const listId = table.int(row, "ReputationIndex");
    if (listId < 0) continue;
    const factionId = table.id(row);
    if (listId >= 128 || factionId <= 0 || Object.hasOwn(factions, String(listId))) {
      throw new DbcError(`Faction: invalid or duplicate reputation list index ${listId}.`);
    }
    const raceMasks: number[] = [], classMasks: number[] = [], bases: number[] = [], flags: number[] = [];
    for (let index = 0; index < 4; index++) {
      raceMasks.push(table.int(row, "ReputationRaceMask", index) >>> 0);
      classMasks.push(table.int(row, "ReputationClassMask", index) >>> 0);
      bases.push(table.int(row, "ReputationBase", index));
      flags.push(table.int(row, "ReputationFlags", index) >>> 0);
    }
    factions[listId] = { factionId, raceMasks, classMasks, bases, flags };
  }
  return { version: 1, factions };
}
