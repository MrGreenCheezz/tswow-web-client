/**
 * 03.11 (6.37): the mark over a quest giver's head, as Wow.exe shows it: a model of its own (Interface\Buttons\TalkToMe*), hung on
 * the giver's PlayerName point and scaled with the giver (0x00719310, seen on a creature at twice the size). Which model is two
 * tables: the status picks a row (0x00a34f5c), the row names the model (0x00adac98, 12-byte rows). The trivial statuses need low
 * level quests tracked (0x00745dd7 → 0x0057bf30), as on the minimap.
 *
 * 06.11 (5.28): both tables, and the green «!» of a flight master not discovered yet (SMSG_TAXINODE_STATUS), are
 * the rule of world/QuestGiverMarker.ts; this file hangs its models, as .m2, on the units.
 */
import { QUEST_GIVER_MARK_MODELS, questGiverMark } from "../../world/QuestGiverMarker.js";

export const QUEST_MARK_ATTACHMENT = 18;
/** 0x007155bb: the mark plays 190, which in these models is half a yard above their 0, bobbing. */
export const QUEST_MARK_SEQUENCE = 190;

/** The mark's model as this client loads it: the table names the .mdx the original asks for. */
const MARK_MODELS: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(
  Object.entries(QUEST_GIVER_MARK_MODELS).map(([mark, path]) => [mark, path.replace(/\.mdx$/i, ".m2")]),
));

/**
 * The model a status puts over a head, or nothing. `taxiKnown` is a flight master's discovery (undefined: not
 * a flight master, or no answer yet): an undiscovered one shows the green «!» where no quest mark is up.
 */
export function questMarkModel(status: number, trivialTracked: boolean, taxiKnown?: boolean): string | undefined {
  return MARK_MODELS[questGiverMark(status, taxiKnown, trivialTracked)];
}

/**
 * The marks now, by unit: only what is a unit here (a game object's mark has no attachment to hang on in this
 * renderer). `taxi` is SMSG_TAXINODE_STATUS by guid, read for the units `isFlightMaster` names.
 */
export function questMarksByUnit(
  statuses: ReadonlyMap<bigint, number>,
  isUnit: (guid: bigint) => boolean,
  trivialTracked: boolean,
  taxi: ReadonlyMap<bigint, boolean> = new Map(),
  isFlightMaster: (guid: bigint) => boolean = () => false,
): Map<bigint, string> {
  const marks = new Map<bigint, string>();
  for (const [guid, status] of statuses) {
    const model = questMarkModel(status, trivialTracked, isFlightMaster(guid) ? taxi.get(guid) : undefined);
    if (model !== undefined && isUnit(guid)) marks.set(guid, model);
  }
  // A flight master with no quest-giver status at all.
  for (const [guid, known] of taxi) {
    if (known || statuses.has(guid) || !isFlightMaster(guid)) continue;
    const model = questMarkModel(0, trivialTracked, false);
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
