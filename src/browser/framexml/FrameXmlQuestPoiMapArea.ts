/**
 * Plan item 3.58 (24.10): `GetQuestWorldMapAreaID(questID)` — which map WorldMap_OpenToQuest opens for a quest
 * (the quest log's «Карта» button, the tracker's POI buttons and its «open map» menu line). Wow.exe 3.3.5a
 * 12340 Script_GetQuestWorldMapAreaID 0x005e56c0 over CGQuestLog::GetQuestWorldMapAreaID 0x005e2b60
 * (descriptions only):
 *
 * - No player or a quest id ≤ 0: 0, 0.
 * - The map is set to the player's zone first (SetMapToCurrentZone), which is the «current» WorldMapArea and
 *   floor (the DungeonMap row's FloorIndex on a dungeon floor, else 0).
 * - With the quest's POI response stored, its blobs that count for the objective mask (0x5e2950; -1 counts the
 *   turn-in blobs only) are searched in order: one on the current WorldMapArea and floor answers at once; else
 *   among blobs whose WorldMapArea lies on the current one's map, the nearest floor, then the nearest centroid
 *   to the player; else the first blob anywhere. The answer is the blob's WorldMapArea id (raw, as SetMapByID
 *   takes it) and its floor.
 * - Otherwise the quest log header above the quest (its ZoneOrSort): an AreaTable zone, walked up to its
 *   top-level parent, and the first WorldMapArea of that area; 0 for a QuestSort header or none.
 */

import type { QuestPoiBlob } from "../../world/QuestProtocol.js";
import { questPoiBlobCounts, questPoiCentroid, type FrameXmlQuestPoiQuest } from "./FrameXmlQuestPoi.js";

export interface FrameXmlQuestMapAreaContext {
  readonly quests: () => readonly FrameXmlQuestPoiQuest[];
  readonly blobs: (questId: number) => readonly QuestPoiBlob[] | undefined;
  readonly player: () => { readonly x: number; readonly y: number } | undefined;
  /** SetMapToCurrentZone, then the displayed WorldMapArea, its map and the current floor (0 off a dungeon floor). */
  readonly currentMapArea: () => { readonly id: number; readonly mapId: number; readonly floor: number } | undefined;
  /** A WorldMapArea's MapID; undefined for no such row. */
  readonly mapAreaMapId: (worldMapAreaId: number) => number | undefined;
  /** The fallback: the WorldMapArea of the quest's log header zone (its top-level AreaTable parent), else 0. */
  readonly headerMapArea: (questId: number) => number;
}

/** `GetQuestWorldMapAreaID(questID)`: the WorldMapArea id and floor, 0, 0 for none. */
export function frameXmlQuestWorldMapArea(context: FrameXmlQuestMapAreaContext, questId: number): readonly [number, number] {
  const player = context.player();
  if (!player || !Number.isInteger(questId) || questId <= 0) return [0, 0];
  const current = context.currentMapArea();
  const blobs = current ? context.blobs(questId) : undefined;
  const quest = blobs ? context.quests().find((entry) => entry.questId === questId) : undefined;
  if (current && blobs && quest) {
    let bestArea = 0;
    let bestFloor = 0;
    let bestFloorDelta = Number.MAX_SAFE_INTEGER;
    let bestDistance = Number.MAX_VALUE;
    for (const blob of blobs) {
      if (!questPoiBlobCounts(blob, quest.mask)) continue;
      if (blob.worldMapAreaId === current.id && blob.floor === current.floor) return [blob.worldMapAreaId, blob.floor];
      const mapId = context.mapAreaMapId(blob.worldMapAreaId);
      if (mapId === undefined) continue;
      if (mapId === current.mapId) {
        const centroid = questPoiCentroid(blob);
        const dx = player.x - centroid.x;
        const dy = player.y - centroid.y;
        const distance = Math.fround(dx * dx + dy * dy);
        const floorDelta = Math.abs(current.floor - blob.floor);
        if (floorDelta < bestFloorDelta || (floorDelta === bestFloorDelta && bestDistance > distance)) {
          bestDistance = distance;
          bestFloorDelta = floorDelta;
          bestArea = blob.worldMapAreaId;
          bestFloor = blob.floor;
        }
      } else if (!bestArea) {
        bestArea = blob.worldMapAreaId;
        bestFloor = blob.floor;
      }
    }
    if (bestArea) return [bestArea, bestFloor];
  }
  return [context.headerMapArea(questId), 0];
}
