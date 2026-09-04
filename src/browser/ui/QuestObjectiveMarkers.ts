import { worldObject } from "../../world/Fields.js";
import {
  questObjectiveLabel,
  type QuestLogEntryView,
  type QuestLogObjectiveKind,
  type QuestLogObjectiveView,
  type QuestPoiBlob,
  type QuestPoint,
} from "../../world/QuestProtocol.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";

/** Resolve a typed quest target through whichever metadata caches the caller owns. */
export type QuestObjectiveNameResolver = (
  kind: QuestLogObjectiveKind,
  id: number,
) => string | undefined;

export type QuestObjectiveMarkerState = "active" | "complete" | "ready" | "failed";

/** Target/progress identity shared by map markers and live-world markers. */
export interface QuestObjectiveMarkerReference {
  readonly questId: number;
  readonly title: string;
  readonly objectiveIndex: number;
  readonly kind: QuestLogObjectiveKind | "quest";
  readonly id: number | undefined;
  readonly label: string;
  readonly have: number | undefined;
  readonly need: number | undefined;
  readonly done: boolean;
  readonly state: QuestObjectiveMarkerState;
}

/** A server-authored map blob joined to the objective it actually represents. */
export interface QuestMapObjectiveMarker extends QuestObjectiveMarkerReference {
  /** One-based stable order in the resolver output, suitable for a numbered map pin. */
  readonly ordinal: number;
  /** The server's blob/index identity. */
  readonly poiIndex: number;
  readonly blob: QuestPoiBlob;
  /** Authoritative server map id (`quest_poi.map`). */
  readonly map: number;
  readonly worldMapAreaId: number;
  readonly floor: number;
  /** Authoritative server points only. Empty means there is no drawable position. */
  readonly points: readonly QuestPoint[];
  /** The server polygon's arithmetic centre, never a guessed spawn position. */
  readonly centroid: QuestPoint | undefined;
}

/** One loaded world object that is an exact entry match for one or more active objectives. */
export interface QuestWorldObjectiveMarker {
  readonly guid: bigint;
  readonly kind: Exclude<QuestLogObjectiveKind, "item">;
  readonly id: number;
  readonly label: string;
  readonly objectives: readonly QuestObjectiveMarkerReference[];
}

function questTitle(entry: QuestLogEntryView): string {
  return entry.template?.title.trim() || `Задание #${entry.questId}`;
}

function markerState(
  entry: QuestLogEntryView,
  objective: QuestLogObjectiveView | undefined,
): QuestObjectiveMarkerState {
  if (entry.failed) return "failed";
  if (entry.complete) return "ready";
  return objective?.done ? "complete" : "active";
}

function markerReference(
  entry: QuestLogEntryView,
  objectiveIndex: number,
  nameOf?: QuestObjectiveNameResolver,
): QuestObjectiveMarkerReference {
  // WotLK's quest_poi contract reserves 0..3 for ReqCreatureOrGO and 4..9 for ReqItem.
  // `poiIndex` keeps that sparse wire identity after the UI compacts empty objective slots.
  const objective = entry.objectives.find((candidate) => candidate.poiIndex === objectiveIndex);
  if (!objective) {
    return {
      questId: entry.questId,
      title: questTitle(entry),
      objectiveIndex,
      kind: "quest",
      id: undefined,
      label: questTitle(entry),
      have: undefined,
      need: undefined,
      done: entry.complete,
      state: markerState(entry, undefined),
    };
  }
  const targetName = nameOf?.(objective.kind, objective.id)?.trim();
  return {
    questId: entry.questId,
    title: questTitle(entry),
    objectiveIndex,
    kind: objective.kind,
    id: objective.id,
    // Map/world markers identify the thing in front of the player. Prefer that target's resolved
    // game name; the quest log itself still keeps authored objective wording as its primary copy.
    label: targetName || questObjectiveLabel(objective),
    have: Number.isFinite(objective.have) ? objective.have : undefined,
    need: objective.need,
    done: objective.done || entry.complete,
    state: markerState(entry, objective),
  };
}

function authoritativePoints(blob: QuestPoiBlob): QuestPoint[] {
  return blob.points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: point.x, y: point.y }));
}

function centroidOf(points: readonly QuestPoint[]): QuestPoint | undefined {
  if (points.length === 0) return undefined;
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

/**
 * Join current quest progress to the server's POI blobs.
 *
 * A missing response yields no markers; an empty polygon yields a marker with no centroid so a
 * map can list/degrade it but cannot accidentally draw it at (0, 0). Unknown objective indexes
 * stay quest-level instead of borrowing a neighbouring objective.
 */
export function questMapObjectiveMarkers(
  entries: readonly QuestLogEntryView[],
  poiByQuest: ReadonlyMap<number, readonly QuestPoiBlob[]>,
  nameOf?: QuestObjectiveNameResolver,
): QuestMapObjectiveMarker[] {
  const markers: QuestMapObjectiveMarker[] = [];
  for (const entry of entries) {
    for (const blob of poiByQuest.get(entry.questId) ?? []) {
      const reference = markerReference(entry, blob.objectiveIndex, nameOf);
      const points = authoritativePoints(blob);
      markers.push({
        ...reference,
        ordinal: markers.length + 1,
        poiIndex: blob.index,
        blob,
        map: blob.map,
        worldMapAreaId: blob.worldMapAreaId,
        floor: blob.floor,
        points,
        centroid: centroidOf(points),
      });
    }
  }
  return markers;
}

/** Human-facing progress used by both the map legend and the small world badge. */
export function questMarkerProgress(marker: QuestObjectiveMarkerReference): string | undefined {
  if (marker.have === undefined || marker.need === undefined) return undefined;
  return `${marker.have} / ${marker.need}`;
}

/**
 * Match active objectives only to objects the server has actually streamed into this world.
 *
 * Item objectives deliberately have no 3D marker: an item id does not identify the creature or
 * object that drops it. Creature corpses and positionless objects are also not anchors. Multiple
 * quests for the same entry share one badge while retaining every progress row in `objectives`.
 */
export function questWorldObjectiveMarkers(
  entries: readonly QuestLogEntryView[],
  objects: Iterable<WorldObjectState>,
  nameOf?: QuestObjectiveNameResolver,
): QuestWorldObjectiveMarker[] {
  const targets = new Map<string, QuestObjectiveMarkerReference[]>();
  for (const entry of entries) {
    if (entry.complete || entry.failed) continue;
    for (const objective of entry.objectives) {
      if (objective.kind === "item" || objective.done || objective.id <= 0) continue;
      const reference = markerReference(entry, objective.poiIndex, nameOf);
      const key = `${objective.kind}:${objective.id}`;
      const list = targets.get(key) ?? [];
      list.push(reference);
      targets.set(key, list);
    }
  }

  const markers: QuestWorldObjectiveMarker[] = [];
  for (const object of objects) {
    if (!object.position) continue;
    const kind = object.typeId === 3 ? "creature" : object.typeId === 5 ? "gameObject" : undefined;
    if (!kind || (kind === "creature" && isWorldObjectDead(object))) continue;
    const id = worldObject.entry(object) ?? 0;
    const objectives = targets.get(`${kind}:${id}`);
    if (!objectives || objectives.length === 0) continue;
    markers.push({ guid: object.guid, kind, id, label: objectives[0]!.label, objectives });
  }
  return markers;
}
