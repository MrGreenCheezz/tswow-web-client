/**
 * 12.10 7.33: a game object of type 31, GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY — the instance portals of
 * Northrend and of the Outland dungeons — is drawn only in the difficulty it stands for.
 *
 * The realm spawns one per difficulty on the same spot: Gundrak's two entrances carry
 * `Doodad_InstanceNewPortal_Purple01` (data1 = 0, normal) and `…_Purple_Skull01` (data1 = 1, heroic),
 * and so on for every Northrend dungeon (`gameobject_template.Data0` the map, `Data1` the difficulty,
 * TrinityCore GameObjectData.h `dungeonDifficulty`). Wow.exe decides which one shows, in the type's
 * update (0x00710a50, reached from the object's vtable at 0x00a344b0): the property ids 0x57 and 0x58
 * name data0 and data1 (0x00746190, 0x007109d0, 0x00710a10); unless data0 is a raid map (Map.dbc
 * InstanceType 2) the model is shown only when data1 equals the dungeon difficulty 0x005138d0 answers —
 * the group's (0x00bd1978) while the player is in one, the player's own (0x00bd0898) otherwise — and
 * hidden otherwise (0x0077f2f0 sets bit 4 of the model's render flags). The renderer drew both, the
 * heroic skull portal over the normal one.
 *
 * A raid map's rule reads Map.dbc's flags (0x100: the difficulty 0x00519680 composes from the raid
 * size and the heroic flag) and MapDifficulty.dbc (a heroic raid difficulty with no heroic row shows
 * the normal portal of the same size, 0x00634950); neither table reaches the browser, so a raid's
 * portals stay drawn as they were rather than risk hiding the only one there is. Until the object's
 * template has arrived nothing is known and it is drawn.
 */
import type { GameObjectTemplate } from "./GameObjectProtocol.js";

export const GO_TYPE_DUNGEON_DIFFICULTY = 31;
/** Map.InstanceType of a raid. */
const MAP_INSTANCE_RAID = 2;

/**
 * Whether a game object of `type` is drawn: always unless it is a dungeon-difficulty object whose
 * template is known, whose map is not a raid, and whose difficulty is not `dungeonDifficulty`.
 */
export function dungeonDifficultyObjectShown(
  type: number,
  template: Pick<GameObjectTemplate, "type" | "data"> | undefined,
  mapInstanceType: (mapId: number) => number | undefined,
  dungeonDifficulty: number,
): boolean {
  if (type !== GO_TYPE_DUNGEON_DIFFICULTY || !template || template.type !== GO_TYPE_DUNGEON_DIFFICULTY) return true;
  const mapId = template.data[0] ?? 0;
  const difficulty = template.data[1] ?? 0;
  if (mapInstanceType(mapId) === MAP_INSTANCE_RAID) return true;
  return difficulty === dungeonDifficulty;
}
