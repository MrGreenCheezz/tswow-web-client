import type { QuestDetails, QuestDialog } from "../../world/NpcProtocol.js";

export type FrameXmlQuestFlagValues = readonly [] | readonly [boolean];
type FrameXmlQuestFlagBinding = (dialog: QuestDialog | undefined) => FrameXmlQuestFlagValues;

const NOTHING: readonly [] = Object.freeze([]);

// Selected TrinityCore 3.3.5a QuestDef.h. SendQuestGiverQuestDetails copies GetFlags into
// SMSG_QUEST_GIVER_QUEST_DETAILS (and may mask AUTO_ACCEPT via server configuration).
const QUEST_FLAGS_FLAGS_PVP = 0x00002000;
const QUEST_FLAGS_AUTO_ACCEPT = 0x00080000;

function detailFlag(dialog: QuestDialog | undefined, mask: number): FrameXmlQuestFlagValues {
  const details: QuestDetails | undefined = dialog?.kind === "details" ? dialog : undefined;
  return details ? [(details.flags & mask) !== 0] : NOTHING;
}

/**
 * Flags read by the selected stock QuestFrame detail panel. A missing or different quest page
 * returns Lua nil; a detail packet with no relevant bit returns the real boolean false.
 * `autoLaunched` is an independent packet field and does not imply AUTO_ACCEPT.
 * LiveWorldSeam registers these packet-backed getters; the stock QuestFrame UI remains hidden
 * until its full structural and owner gate is ready.
 */
export const FRAMEXML_QUEST_FLAGS_DATA_BINDINGS: Readonly<Record<
  "QuestGetAutoAccept" | "QuestFlagsPVP", FrameXmlQuestFlagBinding
>> = Object.freeze({
  QuestGetAutoAccept: (dialog) => detailFlag(dialog, QUEST_FLAGS_AUTO_ACCEPT),
  QuestFlagsPVP: (dialog) => detailFlag(dialog, QUEST_FLAGS_FLAGS_PVP),
});
