/**
 * Plan item 5.28 (04.10, L6): which mark the original client hangs over an NPC, folding in a flight master's
 * discovery (SMSG_TAXINODE_STATUS), as Wow.exe 3.3.5a 12340 does it (read 2026-10-04, descriptions only).
 *
 * - SMSG_TAXINODE_STATUS (u64 guid, u8 known; handler 0x6d5fc0) on a unit with UNIT_NPC_FLAG_FLIGHTMASTER
 *   (0x2000 in UNIT_NPC_FLAGS) sets the unit's taxi mark: 7 while the node is unknown, 0 once known.
 * - The mark shown (0x745dcd): the quest-giver status (SMSG_QUESTGIVER_STATUS) through the table at
 *   0xa34f5c when it is set — except statuses 2..4 (the low-level ones) while low-level quests are not
 *   tracked (0x57bf30), which fall to the taxi mark like status 0.
 * - The marks are the models of 0xadac98: 7 is Interface\Buttons\TalkToMeGreen.mdx — a green «!» over a
 *   flight master the character has not discovered.
 *
 * This file is the rule; the native plates and minimap draw marks from `questMarkFor` (ui/QuestLog.ts)
 * and `minimapQuestMark` (ui/Minimap.ts), which are not wired to it yet.
 */

/** 0xa34f5c: quest-giver status (DIALOG_STATUS_*, QuestDef.h:117) → mark. */
const STATUS_MARK: readonly number[] = Object.freeze([0, 6, 1, 2, 3, 5, 10, 11, 4, 9, 9]);
/** The taxi mark of an undiscovered flight master (0x6d6030). */
export const TAXI_UNKNOWN_MARK = 7;

/** 0xadac98's model paths by mark; 0 and 8 have none. */
export const QUEST_GIVER_MARK_MODELS: Readonly<Record<number, string>> = Object.freeze({
  1: "Interface\\Buttons\\TalkToMe.mdx",
  2: "Interface\\Buttons\\TalkToMeQuestion_LTBlue.mdx",
  3: "Interface\\Buttons\\TalkToMeBlue.mdx",
  4: "Interface\\Buttons\\TalkToMe.mdx",
  5: "Interface\\Buttons\\TalkToMeQuestion_Grey.mdx",
  6: "Interface\\Buttons\\TalkToMeGrey.mdx",
  7: "Interface\\Buttons\\TalkToMeGreen.mdx",
  9: "Interface\\Buttons\\TalkToMeQuestionMark.mdx",
  10: "Interface\\Buttons\\TalkToMeQuestion_LTBlue.mdx",
  11: "Interface\\Buttons\\TalkToMeBlue.mdx",
});

/**
 * The mark 0x745dcd shows: `status` is the quest-giver status (undefined: none), `taxiKnown` the flight
 * master's discovery (undefined: no answer yet, no mark), `lowLevelTracked` whether low-level quests are
 * tracked. 0 is no mark.
 */
export function questGiverMark(status: number | undefined, taxiKnown: boolean | undefined, lowLevelTracked: boolean): number {
  const taxi = taxiKnown === false ? TAXI_UNKNOWN_MARK : 0;
  const quest = status ?? 0;
  if (quest === 0) return taxi;
  if (quest >= 2 && quest <= 4 && !lowLevelTracked) return taxi;
  return STATUS_MARK[quest] ?? 0;
}
