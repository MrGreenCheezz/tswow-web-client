import type { ReputationCatalog } from "../../gateway/ReputationMetadata.js";
import type { FrameXmlFactionInfo } from "./FrameXmlWorldSeam.js";

/** A current reputation row. Its list ID is the server's slot, not the DBC faction ID. */
export interface FrameXmlFactionSnapshotRow {
  readonly listId: number;
}

/**
 * Translate a `Faction.dbc` ID to the one-based index in the complete reputation snapshot.
 * The versioned gateway catalog supplies the only authoritative ID → list-slot relationship.
 * Missing, malformed or ambiguous relationships produce Lua nil rather than a guessed row.
 */
export function frameXmlFactionIndexById(
  factionId: unknown,
  catalog: ReputationCatalog | undefined,
  snapshot: readonly FrameXmlFactionSnapshotRow[],
): number | undefined {
  if (!Number.isSafeInteger(factionId) || (factionId as number) <= 0
    || catalog?.version !== 1 || !catalog.factions) return undefined;

  let listId: number | undefined;
  for (const [key, faction] of Object.entries(catalog.factions)) {
    if (faction?.factionId !== factionId) continue;
    const slot = Number(key);
    if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(slot) || slot >= 128
      || listId !== undefined) return undefined;
    listId = slot;
  }
  if (listId === undefined) return undefined;

  let index: number | undefined;
  for (let offset = 0; offset < snapshot.length; offset++) {
    if (snapshot[offset]?.listId !== listId) continue;
    if (index !== undefined) return undefined;
    index = offset + 1;
  }
  return index;
}

/**
 * The selected 3.3.5a `QuestInfo.lua` reads positions 1, 9 and 11 of this native tuple.
 * Read the corresponding full-snapshot row so collapsed children still resolve by DBC ID.
 * The caller supplies its current war/watch/collapse state in the returned tuple.
 * The callback and cached catalog must already be available; this lookup performs no I/O.
 */
export function frameXmlFactionInfoById(
  factionId: unknown,
  catalog: ReputationCatalog | undefined,
  snapshot: readonly FrameXmlFactionSnapshotRow[],
  factionInfoAt: (oneBasedIndex: number) => FrameXmlFactionInfo | undefined,
): FrameXmlFactionInfo | undefined {
  const index = frameXmlFactionIndexById(factionId, catalog, snapshot);
  return index === undefined ? undefined : factionInfoAt(index);
}
