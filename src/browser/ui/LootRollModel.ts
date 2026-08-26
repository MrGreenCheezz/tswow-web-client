/**
 * Which loot rolls are still worth a dialog, and what their buttons say.
 *
 * The client is on its own for all of this. The server announces a roll with a countdown and then
 * says nothing when it runs out: there is no "roll closed" packet, no timer anywhere in
 * `WorldClient`, and entries are never removed from `lootRolls`. So expiry, dismissal and the
 * button set are decided here — where they can be tested — and the view only draws the answer.
 */

import {
  ROLL_DISENCHANT, ROLL_FLAG_DISENCHANT, ROLL_FLAG_GREED, ROLL_FLAG_NEED, ROLL_FLAG_PASS,
  ROLL_GREED, ROLL_NEED, ROLL_PASS, lootRollText, rollTypeText,
  type LootRollStart, type LootRollVote, type LootRollWon,
} from "../../world/LootRollProtocol.js";

export interface LootRollEntry {
  start: LootRollStart;
  startedAt: number;
  votes: LootRollVote[];
  won?: LootRollWon | undefined;
  passed?: boolean | undefined;
}

export interface RollOption {
  rollType: number;
  label: string;
}

const ROLL_FLAGS: ReadonlyArray<readonly [number, number]> = [
  [ROLL_FLAG_NEED, ROLL_NEED],
  [ROLL_FLAG_GREED, ROLL_GREED],
  [ROLL_FLAG_DISENCHANT, ROLL_DISENCHANT],
  [ROLL_FLAG_PASS, ROLL_PASS],
];

/**
 * The buttons this roll offers.
 *
 * Need is stripped two independent ways — for the whole roll when the item may only be rolled
 * greed, and for one player when the dungeon finder says they cannot use it — so the mask is the
 * only correct source. Offering all four and letting the server refuse would show a button that
 * does nothing.
 */
export function rollOptions(voteMask: number): RollOption[] {
  return ROLL_FLAGS
    .filter(([flag]) => (voteMask & flag) !== 0)
    .map(([, rollType]) => ({ rollType, label: rollTypeText(rollType) }));
}

/** When the window closes, from the moment the start packet was seen. */
export function rollDeadline(entry: LootRollEntry): number {
  return entry.startedAt + entry.start.countdown;
}

export interface ActiveRoll extends LootRollEntry {
  itemSlot: number;
  remainingMs: number;
}

/**
 * The rolls a dialog should be showing.
 *
 * Won, all-passed and timed-out rolls drop out here rather than being deleted from `lootRolls`:
 * the map is the protocol layer's record of what happened and the chat log quotes it afterwards.
 */
export function activeRolls(
  rolls: ReadonlyMap<number, LootRollEntry>, now: number,
): ActiveRoll[] {
  const active: ActiveRoll[] = [];
  for (const [itemSlot, entry] of rolls) {
    if (entry.won || entry.passed) continue;
    const remainingMs = rollDeadline(entry) - now;
    if (remainingMs <= 0) continue;
    active.push({ ...entry, itemSlot, remainingMs });
  }
  return active.sort((left, right) => left.itemSlot - right.itemSlot);
}

/** Seconds left, rounded up so a dialog never shows a zero it is still accepting clicks on. */
export function remainingSeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** One vote, worded. A pass-through, kept so the delegation itself is pinned by a test. */
export function voteLine(vote: LootRollVote, name: string): string {
  return lootRollText(vote, name);
}

export interface MasterLootRow {
  guid: bigint;
  name: string;
}

export function masterLootRows(
  candidates: readonly bigint[], nameOf: (guid: bigint) => string,
): MasterLootRow[] {
  return candidates.map((guid) => ({ guid, name: nameOf(guid) }));
}
