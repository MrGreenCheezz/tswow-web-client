/**
 * 3.24 (11.11): the three rules behind the PvP tab's battleground list and the battlemaster's window, as Wow.exe
 * 3.3.5a 12340 answers GetNumBattlegroundTypes/GetBattlegroundInfo (0x0054c870, 0x0054e010), GetBattlefieldInfo
 * (0x0054d770) and SortBGList (0x0054c9f0). Read-only Ghidra: `.runtime/re-2026-11-11/pvpui/r1.txt`, `r3.txt`,
 * `r4.txt`, `r5.lst`, `r6.txt`.
 *
 * - The type list (0x00bea728[0x00bea724]) is built when the battlefield handlers are installed (0x0054e720):
 *   every BattlemasterList record with InstanceType 3, then sorted by 0x0054a650; SortBGList sorts it again
 *   (stock PVPBattlegroundFrame_OnShow calls it). GetBattlegroundInfo(i) is the i-th id of that list.
 * - The order (0x0054a650): the random battleground (id 32) first; then a row whose holiday is on; then by
 *   BattlemasterList MinLevel (record +0x38), then by id.
 * - canEnter (0x0054ba00, given UNIT_FIELD_LEVEL): the random battleground at level 80 exactly; any other through
 *   PvpDifficulty.dbc for MapID[0] (PvpDifficultyClient.ts `bracket`).
 * - isHoliday (0x00548d10 with record +0x34, HolidayWorldState): the world state of that id as the server sent it
 *   (the table at 0x00be8f58, the same lookup WorldStateUI's `$w` token and AreaPOI use) is non-zero; an id the
 *   server never sent reads 0.
 */
import type { BattlegroundMetadata } from "../BattlegroundMetadata.js";
import type { PvpDifficultyTable } from "../PvpDifficultyClient.js";

/** BattlemasterList id of the random battleground (0x0054ba00 and 0x0054a650 compare with 0x20). */
const RANDOM_BATTLEGROUND = 32;
/** 0x0054ba00: the random battleground's one level (0x50). */
const RANDOM_BATTLEGROUND_LEVEL = 80;

export type FrameXmlWorldStates = ReadonlyMap<number, number> | undefined;

/** 0x00548d10: a world state's value, 0 when the server never sent it. */
export function frameXmlWorldStateValue(states: FrameXmlWorldStates, id: number): number {
  return states?.get(id) ?? 0;
}

/** isHoliday of GetBattlegroundInfo/GetBattlefieldInfo: the row's HolidayWorldState is on. */
export function frameXmlBattlegroundHoliday(row: BattlegroundMetadata, states: FrameXmlWorldStates): boolean {
  return frameXmlWorldStateValue(states, row.holidayWorldState) !== 0;
}

/**
 * canEnter (0x0054ba00). Without the bracket table (a gateway older than `/dbc/pvp-difficulty`) the answer falls
 * back to BattlemasterList's own MinLevel..MaxLevel, the rule this client used before the table was served.
 */
export function frameXmlBattlegroundCanEnter(
  row: BattlegroundMetadata,
  level: number,
  difficulty: PvpDifficultyTable | undefined,
): boolean {
  if (row.bgTypeId === RANDOM_BATTLEGROUND) return level === RANDOM_BATTLEGROUND_LEVEL;
  if (!difficulty) return level >= row.minLevel && level <= row.maxLevel;
  const mapId = row.mapIds[0];
  return mapId !== undefined && difficulty.bracket(mapId, level) !== undefined;
}

/**
 * 0x0054a650 as a sort: random first, holiday rows next, then MinLevel, then id. Two rows both on holiday compare
 * «first before second» in Wow.exe whichever way they are asked (its qsort leaves their order to the input); here
 * they keep the MinLevel/id order between them.
 */
export function frameXmlSortBattlegrounds<T extends BattlegroundMetadata>(rows: readonly T[], states: FrameXmlWorldStates): T[] {
  const rank = (row: T): number => (row.bgTypeId === RANDOM_BATTLEGROUND ? 0 : frameXmlBattlegroundHoliday(row, states) ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.minLevel - b.minLevel || a.bgTypeId - b.bgTypeId);
}

/**
 * The client's sorted type list (0x00bea728): ids in the order of the last sort. The first read sorts with the
 * states at hand, as the install (0x0054e720) does; `sort` is SortBGList; `reset` a new world.
 */
export class FrameXmlBattlegroundTypeList {
  #order: readonly number[] | undefined;

  /** The catalog's rows in the list's order; rows the last sort did not see go last, in catalog order. */
  rows<T extends BattlegroundMetadata>(catalog: readonly T[], states: FrameXmlWorldStates): readonly T[] {
    if (!this.#order) this.sort(catalog, states);
    const order = this.#order ?? [];
    const placed = order.map((id) => catalog.find((row) => row.bgTypeId === id)).filter((row): row is T => row !== undefined);
    return placed.length === catalog.length ? placed : [...placed, ...catalog.filter((row) => !order.includes(row.bgTypeId))];
  }

  sort(catalog: readonly BattlegroundMetadata[], states: FrameXmlWorldStates): void {
    this.#order = Object.freeze(frameXmlSortBattlegrounds(catalog, states).map((row) => row.bgTypeId));
  }

  reset(): void {
    this.#order = undefined;
  }
}
