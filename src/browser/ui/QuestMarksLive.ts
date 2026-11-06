/** 03.11 (6.37): the quest marks of this frame, handed to the persistent visuals when they change (QuestMarks.ts). */
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { UNIT_NPC_FLAG_FLIGHTMASTER } from "../../world/QuestGiverMarker.js";
import { game } from "../game/Context.js";
import { questMarksByUnit, sameQuestMarks } from "./QuestMarks.js";
import { trivialQuestsTracked } from "./TownTracking.js";

let shown: ReadonlyMap<bigint, string> = new Map();
const NPC_FLAGS = UPDATE_FIELDS.UNIT_NPC_FLAGS.offset;

export function syncQuestMarks(): void {
  const world = game.world;
  const objects = world?.state.objects;
  // 06.11 (5.28): an undiscovered flight master's green «!» (SMSG_TAXINODE_STATUS, kept by WorldClient).
  const marks = world && objects
    ? questMarksByUnit(world.questGiverStatus, (guid) => objects.get(guid)?.typeId === 3, trivialQuestsTracked(),
      world.taxiNodeStatus, (guid) => ((objects.get(guid)?.fields.get(NPC_FLAGS) ?? 0) & UNIT_NPC_FLAG_FLIGHTMASTER) !== 0)
    : new Map<bigint, string>();
  if (sameQuestMarks(marks, shown)) return;
  shown = marks;
  game.spellVisualCoordinator?.setQuestMarks(marks);
}
