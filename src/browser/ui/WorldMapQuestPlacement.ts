import { worldMapPoint, type MapPoint, type WorldPoint } from "../MinimapGeometry.js";
import type { QuestMapObjectiveMarker } from "./QuestObjectiveMarkers.js";
import type {
  WorldMapHierarchy, WorldMapNode, WorldMapTarget,
} from "./WorldMapHierarchy.js";

export type WorldMapPlacementPrecision = "point" | "area";

export interface WorldMapPlacement {
  point: MapPoint;
  /** `point` is a server/world coordinate; `area` is an authored hierarchy hit region. */
  precision: WorldMapPlacementPrecision;
}

/** True when `candidate` is the node itself or belongs below it in the authored map graph. */
export function worldMapContains(
  hierarchy: WorldMapHierarchy,
  candidate: WorldMapNode,
  node: WorldMapNode,
): boolean {
  let cursor: WorldMapNode | undefined = node;
  for (let depth = 0; cursor && depth < 128; depth++) {
    if (cursor.key === candidate.key) return true;
    cursor = hierarchy.parent(cursor);
  }
  return false;
}

/** The immediate clickable branch that leads from `ancestor` towards `descendant`. */
export function worldMapBranchTarget(
  hierarchy: WorldMapHierarchy,
  ancestor: WorldMapNode,
  descendant: WorldMapNode,
): WorldMapTarget | undefined {
  if (ancestor.key === descendant.key) return undefined;
  let branch = descendant;
  for (let depth = 0; depth < 128; depth++) {
    const parent = hierarchy.parent(branch);
    if (!parent) return undefined;
    if (parent.key === ancestor.key) {
      return hierarchy.targets(ancestor).find((target) => target.node.key === branch.key);
    }
    branch = parent;
  }
  return undefined;
}

function inside(point: MapPoint): boolean {
  return Number.isFinite(point.u) && Number.isFinite(point.v)
    && point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1;
}

/**
 * Places an authored world coordinate on any visible ancestor map.
 *
 * Area maps keep the exact coordinate (including `WorldMapTransforms`); World/Cosmic can only
 * truthfully identify the authored child region, so they use that region's hit-frame centre.
 */
export function worldMapDescendantPlacement(
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
  target: WorldMapNode,
  mapId: number,
  position: WorldPoint | undefined,
): WorldMapPlacement | undefined {
  if (!worldMapContains(hierarchy, current, target)) return undefined;
  if (current.kind === "area" && position) {
    const projected = hierarchy.projectPoint(
      mapId, current.mapArea.mapId, position.x, position.y,
    );
    if (projected) {
      const point = worldMapPoint(current.mapArea, projected.x, projected.y);
      if (inside(point)) return { point, precision: "point" };
    }
  }
  const branch = worldMapBranchTarget(hierarchy, current, target);
  if (!branch) return undefined;
  return {
    point: {
      u: branch.rect.left + branch.rect.width / 2,
      v: branch.rect.top + branch.rect.height / 2,
    },
    precision: "area",
  };
}

/** A quest POI never gets a fabricated local coordinate when its server point list is empty. */
export function questMarkerPlacement(
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
  marker: QuestMapObjectiveMarker,
): WorldMapPlacement | undefined {
  const target = hierarchy.area(marker.worldMapAreaId);
  if (!target) return undefined;
  return worldMapDescendantPlacement(hierarchy, current, target, marker.map, marker.centroid);
}

/**
 * A positive POI floor is authoritative on a multi-floor map. Zero is kept as "not specified"
 * because outdoor/core POIs use it even when the map area's default floor is non-zero.
 */
export function questMarkerMatchesFloor(
  current: WorldMapNode,
  marker: QuestMapObjectiveMarker,
): boolean {
  if (current.kind !== "area") return true;
  const floor = current.mapArea.defaultDungeonFloor;
  return floor <= 0 || marker.floor <= 0 || marker.floor === floor;
}

/** Convenience guard used by the side list even when a marker has no drawable point. */
export function questMarkerBelongsToNode(
  hierarchy: WorldMapHierarchy,
  current: WorldMapNode,
  marker: QuestMapObjectiveMarker,
): boolean {
  const target = hierarchy.area(marker.worldMapAreaId);
  return target ? worldMapContains(hierarchy, current, target) : false;
}
