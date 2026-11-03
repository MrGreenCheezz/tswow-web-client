/**
 * 03.11 (6.37): the mark over a quest giver's head, as Wow.exe shows it: a model of its own (Interface\Buttons\TalkToMe*), hung on
 * the giver's PlayerName point and scaled with the giver (0x00719310, seen on a creature at twice the size). Which model is two
 * tables: the status picks a row (0x00a34f5c), the row names the model (0x00adac98, 12-byte rows). The trivial statuses need low
 * level quests tracked (0x00745dd7 → 0x0057bf30), as on the minimap.
 */
import {
  QUEST_STATUS_LOW_LEVEL_AVAILABLE, QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP,
} from "../../world/QuestProtocol.js";

export const QUEST_MARK_ATTACHMENT = 18;
/** 0x007155bb: the mark plays 190, which in these models is half a yard above their 0, bobbing. */
export const QUEST_MARK_SEQUENCE = 190;

const MARK_DIR = "Interface\\Buttons\\";
const YELLOW_BANG = `${MARK_DIR}TalkToMe.m2`;
const BLUE_BANG = `${MARK_DIR}TalkToMeBlue.m2`;
const GREY_BANG = `${MARK_DIR}TalkToMeGrey.m2`;
const YELLOW_QUESTION = `${MARK_DIR}TalkToMeQuestionMark.m2`;
const BLUE_QUESTION = `${MARK_DIR}TalkToMeQuestion_LTBlue.m2`;
const GREY_QUESTION = `${MARK_DIR}TalkToMeQuestion_Grey.m2`;

/** By QuestGiverStatus: nothing, unavailable, three low level, incomplete, reward (rep), available (rep), available, two rewards. */
const MARK_BY_STATUS: readonly (string | undefined)[] = [
  undefined, GREY_BANG, YELLOW_BANG, BLUE_QUESTION, BLUE_BANG, GREY_QUESTION, BLUE_QUESTION, BLUE_BANG, YELLOW_BANG, YELLOW_QUESTION, YELLOW_QUESTION,
];

/** The model a status puts over a head, or nothing. */
export function questMarkModel(status: number, trivialTracked: boolean): string | undefined {
  if (!trivialTracked && status >= QUEST_STATUS_LOW_LEVEL_AVAILABLE && status <= QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP) return undefined;
  return MARK_BY_STATUS[status];
}

/** The marks now, by unit: only what is a unit here (a game object's mark has no attachment to hang on in this renderer). */
export function questMarksByUnit(
  statuses: ReadonlyMap<bigint, number>,
  isUnit: (guid: bigint) => boolean,
  trivialTracked: boolean,
): Map<bigint, string> {
  const marks = new Map<bigint, string>();
  for (const [guid, status] of statuses) {
    const model = questMarkModel(status, trivialTracked);
    if (model !== undefined && isUnit(guid)) marks.set(guid, model);
  }
  return marks;
}

/** Whether two sets of marks say the same: they change on packets, and are compared a frame at a time. */
export function sameQuestMarks(left: ReadonlyMap<bigint, string>, right: ReadonlyMap<bigint, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [guid, model] of left) if (right.get(guid) !== model) return false;
  return true;
}
