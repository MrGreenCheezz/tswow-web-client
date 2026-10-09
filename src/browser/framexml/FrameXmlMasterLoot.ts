/**
 * Plan item 5.28 (04.10, L6): the table `GetMasterLootCandidate` reads, as Wow.exe 3.3.5a 12340 builds it
 * from SMSG_LOOT_MASTER_LIST (handler 0x6fa690; Lua 0x588920 → 0x6fa770; read 2026-10-04).
 *
 * - Forty guid slots (0x00ca0550), emptied by every list. Outside a raid (no raid roster, 0x00beb608)
 *   each guid takes the slot of its place in the packet. In a raid each guid is looked up on the raid
 *   roster (0x549670, the player included) and takes the first free slot of its subgroup's five
 *   (subgroup × 5 … subgroup × 5 + 4), in packet order; a guid not on the roster is dropped.
 * - `GetMasterLootCandidate(i)` reads slot i − 1 (none past 40) and answers the name from the name cache
 *   (0x67d770): nil while it is not there, the query sent, and UPDATE_MASTER_LOOT_LIST once it answers
 *   (the callback 0x588150).
 */

export const FRAMEXML_MASTER_LOOT_SLOTS = 40;
const SUBGROUP_SIZE = 5;

/** The raid roster a list is placed by; undefined outside a raid. */
export interface FrameXmlMasterLootRaid {
  readonly selfGuid: bigint | undefined;
  readonly ownSubGroup: number;
  readonly members: readonly { readonly guid: bigint; readonly subGroup: number }[];
}

/** The forty slots for one SMSG_LOOT_MASTER_LIST (0x6fa690). */
export function frameXmlMasterLootTable(candidates: readonly bigint[], raid: FrameXmlMasterLootRaid | undefined): (bigint | undefined)[] {
  const table: (bigint | undefined)[] = new Array<bigint | undefined>(FRAMEXML_MASTER_LOOT_SLOTS).fill(undefined);
  candidates.forEach((guid, index) => {
    if (!raid) {
      if (index < FRAMEXML_MASTER_LOOT_SLOTS) table[index] = guid;
      return;
    }
    const subGroup = guid === raid.selfGuid ? raid.ownSubGroup
      : raid.members.find((member) => member.guid === guid)?.subGroup;
    if (subGroup === undefined) return;
    for (let slot = subGroup * SUBGROUP_SIZE; slot < subGroup * SUBGROUP_SIZE + SUBGROUP_SIZE && slot < FRAMEXML_MASTER_LOOT_SLOTS; slot++) {
      if (table[slot] === undefined) {
        table[slot] = guid;
        return;
      }
    }
  });
  return table;
}
