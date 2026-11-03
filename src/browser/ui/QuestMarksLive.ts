/** 03.11 (6.37): the quest marks of this frame, handed to the persistent visuals when they change (QuestMarks.ts). */
import { game } from "../game/Context.js";
import { questMarksByUnit, sameQuestMarks } from "./QuestMarks.js";
import { trivialQuestsTracked } from "./TownTracking.js";

let shown: ReadonlyMap<bigint, string> = new Map();

export function syncQuestMarks(): void {
  const world = game.world;
  const objects = world?.state.objects;
  const marks = world && objects
    ? questMarksByUnit(world.questGiverStatus, (guid) => objects.get(guid)?.typeId === 3, trivialQuestsTracked())
    : new Map<bigint, string>();
  if (sameQuestMarks(marks, shown)) return;
  shown = marks;
  game.spellVisualCoordinator?.setQuestMarks(marks);
}
