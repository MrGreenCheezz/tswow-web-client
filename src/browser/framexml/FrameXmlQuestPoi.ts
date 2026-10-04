/**
 * Plan item 3.13c: the quest POI C API the stock WorldMapFrame and WatchFrame read, as Wow.exe 3.3.5a
 * 12340 answers it from SMSG_QUEST_POI_QUERY_RESPONSE (read 2026-10-02; descriptions only).
 *
 * - The response (0x5e7370) keeps per quest its blobs: index, objective, map, WorldMapArea, floor, the two
 *   words TrinityCore calls Unk3/Unk4 (kept as priority and flags), the points, and the points' centroid
 *   in whole yards (the sum divided by the count, C integer division) — the icon's place.
 * - A quest's objective mask (0x5e2950): -1 once its objectives are met (0x5e0ea0 with no «needs an
 *   objective» test: a quest with none counts too); else bit n for each creature/object slot n not yet
 *   counted up, bit 4 + n for each required item slot short, bit 10 + n for each ItemDrop slot (other
 *   than the start item) not carried, bit 16 for an exploration/event quest (Flags & 6) not completed; a
 *   failed quest has 0. A blob counts for the mask when the mask is -1 and the blob's objective is -1,
 *   or the blob's objective bit is set (0x5e5a50, 0x5e2eb0).
 * - A blob is on the displayed map (0x5e0110 / 0x5e0180 → 0x544140) when its map is the map's (and, on a
 *   dungeon floor, its floor the floor's), its centroid falls inside the map with |x·y| ≥ 0.001, and —
 *   with flags 0x4, off a dungeon floor — its WorldMapArea is the one displayed (FrameXmlMap.ts).
 * - `QuestMapUpdateAllQuests()` (0x5e63d0 → 0x5e5a50): with the `questPOI` CVar on, how many quests have
 *   a counting blob on the displayed map; it also marks them.
 * - `QuestPOIGetQuestIDByVisibleIndex(i)` (0x5e5750 → 0x5e3840): the i-th marked quest — first those
 *   whose objectives are met, then the watched ones in watch order, then the rest — and its quest-log
 *   row (0x5deeb0: the displayed row, headers counted). At most 25.
 * - `QuestPOIGetIconInfo(questId)` (0x5e0590): whether the mask is -1, then the icon's map x, y and its
 *   blob's objective. The icon blob (0x5e2eb0) is the counting blob on the map with the lowest priority,
 *   then the nearest centroid to the player. 3.13d (L6): `QuestPOIUpdateIcons` places the icons and
 *   pushes overlapping ones apart (FrameXmlQuestPoiLayout.ts); IconInfo reads that placement.
 * - `GetQuestPOILeaderBoard(poi, questLogIndex)` (0x5e6650 → 0x5e58c0): the objective line of POI index
 *   poi — 0..3 the creature/object slot, 4..9 the item slot, 10..15 the ItemDrop slot's item when it is
 *   also a required item — as text, type and finished; nothing for an index without a line.
 */

import type { QuestPoiBlob, QuestPoint } from "../../world/QuestProtocol.js";
// 3.13d (L6): the icon search with its priority limit and the spread of 0x5e2eb0.
import {
  QUEST_POI_SHIFT_COMPLETE_DEFAULT, questPoiIconBlob, questPoiSpreadIcons, type QuestPoiIconSeat,
} from "./FrameXmlQuestPoiLayout.js";
// 3.13e (L6): the smoothed outline and the merging of overlapping blobs.
import {
  questPoiDrawnBlob, questPoiMergeBlobs, questPoiOutline, type QuestPoiDrawnBlob,
} from "./FrameXmlQuestPoiOutline.js";

export const QUEST_POI_MAX_QUESTS = 25;
export const QUEST_POI_EVENT_BIT = 16;
/** 0x9e1134: the smallest |x·y| a map position may have. */
const ON_MAP_EPSILON = Math.fround(0.001);

/** One quest in the log as the POI code reads it. */
export interface FrameXmlQuestPoiQuest {
  readonly questId: number;
  /** The displayed quest-log row (GetQuestLogTitle's index). */
  readonly logIndex: number;
  /** Its objectives are met (the mask is -1). */
  readonly complete: boolean;
  readonly watched: boolean;
  /** 0x5e2950's mask: -1 when complete. */
  readonly mask: number;
  /**
   * 3.13d (L6): 0x5e0ea0(slot, 1) for the icon spread — met, and with at least one objective; a quest
   * with nothing to do is not «met» there. Absent: `complete`.
   */
  readonly spreadMet?: boolean;
}

export interface FrameXmlQuestPoiMapPoint {
  readonly u: number;
  readonly v: number;
}

export interface FrameXmlQuestPoiContext {
  /** The `questPOI` CVar. */
  readonly enabled: () => boolean;
  /** The log's quests in slot order. */
  readonly quests: () => readonly FrameXmlQuestPoiQuest[];
  readonly blobs: (questId: number) => readonly QuestPoiBlob[] | undefined;
  /** Where a world position of a blob falls on the displayed map, by FrameXmlMap's rules; undefined off it. */
  readonly point: (blob: QuestPoiBlob, x: number, y: number) => FrameXmlQuestPoiMapPoint | undefined;
  /** The player's world position, for the nearest icon blob. */
  readonly player: () => { readonly x: number; readonly y: number } | undefined;
  /**
   * Whether the displayed map can place a point (its area tables have landed). Before that a blob is
   * marked when its WorldMapArea is `fallbackArea` — the player's — and has no icon or shape.
   */
  readonly mapReady?: () => boolean;
  readonly fallbackArea?: () => number | undefined;
  /**
   * 3.13d (L6): the displayed WorldMapArea's |LocLeft − LocRight| in yards, which sizes the icon spread;
   * undefined on a dungeon floor or without an area map (no spread then).
   */
  readonly mapWidthYards?: () => number | undefined;
  /** 3.13d (L6): the POIShiftComplete CVar (FrameXmlQuestPoiLayout.ts); absent: its default 0.6. */
  readonly shiftComplete?: () => number;
}

/** The blob's centroid as 0x5e7370 stores it: whole yards, the sum truncated by the count. */
export function questPoiCentroid(blob: QuestPoiBlob): QuestPoint {
  let x = 0;
  let y = 0;
  for (const point of blob.points) { x += point.x; y += point.y; }
  const count = blob.points.length;
  return count > 1 ? { x: Math.trunc(x / count), y: Math.trunc(y / count) } : { x, y };
}

/** Whether a blob counts for a quest's objective mask. */
export function questPoiBlobCounts(blob: QuestPoiBlob, mask: number): boolean {
  if (mask === -1) return blob.objectiveIndex === -1;
  return blob.objectiveIndex !== -1 && (mask & (1 << (blob.objectiveIndex & 31))) !== 0;
}

/** The blob's centroid on the displayed map, with the client's |x·y| test. */
export function questPoiBlobPoint(blob: QuestPoiBlob, context: Pick<FrameXmlQuestPoiContext, "point">): FrameXmlQuestPoiMapPoint | undefined {
  const centroid = questPoiCentroid(blob);
  const point = context.point(blob, centroid.x, centroid.y);
  return point && Math.abs(point.u * point.v) >= ON_MAP_EPSILON ? point : undefined;
}

function onMap(quest: FrameXmlQuestPoiQuest, context: FrameXmlQuestPoiContext): boolean {
  if (quest.mask === 0) return false;
  const ready = context.mapReady?.() ?? true;
  const area = ready ? undefined : context.fallbackArea?.();
  for (const blob of context.blobs(quest.questId) ?? []) {
    if (!questPoiBlobCounts(blob, quest.mask)) continue;
    if (ready ? questPoiBlobPoint(blob, context) : area !== undefined && blob.worldMapAreaId === area) return true;
  }
  return false;
}

/** The quests `QuestMapUpdateAllQuests` marks, in `QuestPOIGetQuestIDByVisibleIndex`'s order. */
export function frameXmlQuestPoiVisible(context: FrameXmlQuestPoiContext): FrameXmlQuestPoiQuest[] {
  if (!context.enabled()) return [];
  const marked = context.quests().filter((quest) => onMap(quest, context));
  return [
    ...marked.filter((quest) => quest.complete),
    ...marked.filter((quest) => !quest.complete && quest.watched),
    ...marked.filter((quest) => !quest.complete && !quest.watched),
  ].slice(0, QUEST_POI_MAX_QUESTS);
}

/** `QuestPOIGetIconInfo(questId)`: complete, x, y, objective; undefined with no icon on the map. */
export function frameXmlQuestPoiIconInfo(
  context: FrameXmlQuestPoiContext, questId: number,
): readonly [boolean, number, number, number] | undefined {
  const quest = context.quests().find((entry) => entry.questId === questId);
  if (!quest || quest.mask === 0) return undefined;
  // 3.13d (L6): the search of 0x5e2eb0 itself, priority limit 10 included (FrameXmlQuestPoiLayout.ts).
  const best = questPoiIconBlob(context.blobs(questId),
    (blob) => questPoiBlobCounts(blob, quest.mask) && questPoiBlobPoint(blob, context) !== undefined,
    questPoiCentroid, context.player());
  const point = best && questPoiBlobPoint(best, context);
  return best && point ? [quest.mask === -1, point.u, point.v, best.objectiveIndex] : undefined;
}

/** 3.13d (L6): one quest's icon as `QuestPOIUpdateIcons` leaves it: its blob and whole-yard place. */
export interface FrameXmlQuestPoiIcon {
  readonly blob: QuestPoiBlob;
  readonly x: number;
  readonly y: number;
  /** The quest's mask was -1 at the update (QuestPOIGetIconInfo's first value). */
  readonly complete: boolean;
}

/** 3.13d (L6): `QuestPOIUpdateIcons` (0x5e2eb0) — every quest's icon blob, then the spread. */
export function frameXmlQuestPoiLayout(context: FrameXmlQuestPoiContext): Map<number, FrameXmlQuestPoiIcon> {
  const player = context.player();
  const placed: { questId: number; blob: QuestPoiBlob; complete: boolean; seat: QuestPoiIconSeat }[] = [];
  for (const quest of context.quests()) {
    if (quest.mask === 0) continue;
    const blob = questPoiIconBlob(context.blobs(quest.questId),
      (candidate) => questPoiBlobCounts(candidate, quest.mask) && questPoiBlobPoint(candidate, context) !== undefined,
      questPoiCentroid, player);
    if (!blob) continue;
    const centroid = questPoiCentroid(blob);
    placed.push({ questId: quest.questId, blob, complete: quest.mask === -1, seat: {
      x: centroid.x, y: centroid.y, movable: blob.points.length !== 1, met: quest.spreadMet ?? quest.complete,
    } });
  }
  questPoiSpreadIcons(placed.map((entry) => entry.seat), context.mapWidthYards?.(),
    context.shiftComplete?.() ?? QUEST_POI_SHIFT_COMPLETE_DEFAULT);
  return new Map(placed.map((entry) => [entry.questId,
    { blob: entry.blob, x: entry.seat.x, y: entry.seat.y, complete: entry.complete }]));
}

/** One blob as the blob frame draws and hit-tests it: its outline on the displayed map. */
export interface FrameXmlQuestPoiShape {
  readonly objectiveIndex: number;
  readonly points: readonly FrameXmlQuestPoiMapPoint[];
  /** 3.13e (L6): its objective and those of blobs merged into it (0x58e310); absent: just its own. */
  readonly objectives?: readonly number[];
}

/** 3.13e (L6): what a QuestPOIFrame builds its blobs with (its EnableSmoothing … SetMergeThreshold). */
export interface FrameXmlQuestPoiBuildStyle {
  readonly smoothing: boolean;
  readonly splinePoints: number;
  readonly merging: boolean;
  readonly mergeThreshold: number;
}

/**
 * 3.13e (L6): the blobs `DrawQuestBlob(questId, true)` builds (0x5900f0 → 0x58f1a0, 0x58e310): the
 * shapes of `frameXmlQuestPoiShapes` with the smoothed outline (every outline point on the map), the
 * quest's overlapping blobs merged when it is not met; merged-away blobs are left out
 * (FrameXmlQuestPoiOutline.ts).
 */
export function frameXmlQuestPoiDrawnShapes(context: FrameXmlQuestPoiContext, questId: number,
  style: FrameXmlQuestPoiBuildStyle): { readonly mask: number; readonly shapes: readonly FrameXmlQuestPoiShape[] } | undefined {
  const quest = context.quests().find((entry) => entry.questId === questId);
  if (!quest) return undefined;
  const drawn: QuestPoiDrawnBlob[] = [];
  for (const blob of context.blobs(questId) ?? []) {
    if (blob.points.length < 3) continue;
    if (quest.mask !== -1 && !questPoiBlobCounts(blob, quest.mask)) continue;
    if (!questPoiBlobPoint(blob, context)) continue;
    const points: FrameXmlQuestPoiMapPoint[] = [];
    let onMap = true;
    for (const corner of questPoiOutline(blob.points, style.smoothing, style.splinePoints)) {
      const point = context.point(blob, corner.x, corner.y);
      if (!point || Math.abs(point.u * point.v) < ON_MAP_EPSILON) { onMap = false; break; }
      points.push(point);
    }
    if (onMap && points.length > 0) drawn.push(questPoiDrawnBlob(blob.objectiveIndex, points));
  }
  if (style.merging && quest.mask !== -1) questPoiMergeBlobs(drawn, style.mergeThreshold);
  return { mask: quest.mask, shapes: drawn.filter((blob) => blob.active)
    .map((blob) => ({ objectiveIndex: blob.objectiveIndex, objectives: blob.objectives, points: blob.points })) };
}

/**
 * The shapes `DrawQuestBlob(questId, true)` paints (0x5900f0 → 0x58f1a0, 0x5901c0): blobs of three or
 * more points whose centroid is on the map, every point of which falls on it, counting for the mask
 * (every blob while it is -1).
 */
export function frameXmlQuestPoiShapes(context: FrameXmlQuestPoiContext, questId: number): {
  readonly mask: number; readonly shapes: readonly FrameXmlQuestPoiShape[];
} | undefined {
  const quest = context.quests().find((entry) => entry.questId === questId);
  if (!quest) return undefined;
  const shapes: FrameXmlQuestPoiShape[] = [];
  for (const blob of context.blobs(questId) ?? []) {
    if (blob.points.length < 3) continue;
    if (quest.mask !== -1 && !questPoiBlobCounts(blob, quest.mask)) continue;
    if (!questPoiBlobPoint(blob, context)) continue;
    const points: FrameXmlQuestPoiMapPoint[] = [];
    for (const corner of blob.points) {
      const point = context.point(blob, corner.x, corner.y);
      if (!point || Math.abs(point.u * point.v) < ON_MAP_EPSILON) { points.length = 0; break; }
      points.push(point);
    }
    if (points.length >= 3) shapes.push({ objectiveIndex: blob.objectiveIndex, points });
  }
  return { mask: quest.mask, shapes };
}

/** Whether a map point is inside a shape (even-odd rule). */
export function questPoiShapeContains(shape: FrameXmlQuestPoiShape, u: number, v: number): boolean {
  let inside = false;
  const points = shape.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if ((a.v > v) !== (b.v > v) && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

/** The objective mask's inputs for one quest (see the module comment). */
export interface FrameXmlQuestPoiObjectives {
  readonly failed: boolean;
  readonly serverComplete: boolean;
  /** Creature/object slots: slot index and whether counted up. */
  readonly creatures: readonly { readonly slot: number; readonly done: boolean }[];
  /** Required item slots: slot index and whether carried in full. */
  readonly items: readonly { readonly slot: number; readonly done: boolean }[];
  /** ItemDrop slots: slot index and whether one is carried; the start item already left out. */
  readonly sourceItems: readonly { readonly slot: number; readonly carried: boolean }[];
  /** Quest Flags & 6: an exploration or event objective. */
  readonly eventObjective: boolean;
}

/** 0x5e2950's mask. */
export function frameXmlQuestPoiMask(objectives: FrameXmlQuestPoiObjectives): number {
  if (objectives.failed) return 0;
  const met = objectives.creatures.every((entry) => entry.done) && objectives.items.every((entry) => entry.done)
    && !objectives.eventObjective;
  if (objectives.serverComplete || met) return -1;
  let mask = 0;
  for (const entry of objectives.creatures) if (!entry.done) mask |= 1 << entry.slot;
  for (const entry of objectives.items) if (!entry.done) mask |= 1 << (4 + entry.slot);
  for (const entry of objectives.sourceItems) if (!entry.carried) mask |= 1 << (10 + entry.slot);
  if (objectives.eventObjective) mask |= 1 << QUEST_POI_EVENT_BIT;
  return mask;
}

/** What the seam adds to the POI reads: the quest log's objective lines. */
export interface FrameXmlQuestPoiModelContext extends FrameXmlQuestPoiContext {
  /** `GetQuestLogLeaderBoard(line, questLogIndex)` for the quest at a displayed row; undefined without one. */
  readonly leaderBoardLine: (logIndex: number, poiIndex: number) => readonly [string, string, boolean] | undefined;
}

/**
 * The POI half of the quest log for one seam. `QuestMapUpdateAllQuests` marks the quests (0x5e5a50) and
 * `QuestPOIGetQuestIDByVisibleIndex` reads those marks, as the client's do; a read before any update
 * marks first.
 */
export class FrameXmlQuestPoiModel {
  readonly #context: FrameXmlQuestPoiModelContext;
  #marked: readonly FrameXmlQuestPoiQuest[] | undefined;

  constructor(context: FrameXmlQuestPoiModelContext) {
    this.#context = context;
  }

  /** `QuestMapUpdateAllQuests()`. */
  updateAllQuests(): number {
    this.#marked = frameXmlQuestPoiVisible(this.#context);
    return this.#marked.length;
  }

  /** `QuestPOIGetQuestIDByVisibleIndex(i)`: the quest id and its displayed log row. */
  questIdByVisibleIndex(index: number): readonly [number, number] | undefined {
    if (!Number.isInteger(index) || index < 1 || index > QUEST_POI_MAX_QUESTS) return undefined;
    const marked = this.#marked ?? (this.#marked = frameXmlQuestPoiVisible(this.#context));
    const quest = marked[index - 1];
    return quest ? [quest.questId, quest.logIndex] : undefined;
  }

  /** The marks go with the world or the log they were taken from. */
  reset(): void {
    this.#marked = undefined;
    this.#icons = undefined; // 3.13d (L6)
  }

  /** 3.13d (L6): the icons of the last `QuestPOIUpdateIcons`, by quest id. */
  #icons: Map<number, FrameXmlQuestPoiIcon> | undefined;

  /** 3.13d (L6): `QuestPOIUpdateIcons()` (0x5e5740 → 0x5e2eb0): place every quest's icon, spread apart. */
  updateIcons(): void {
    this.#icons = frameXmlQuestPoiLayout(this.#context);
  }

  /**
   * `QuestPOIGetIconInfo(questId)` (0x5e0590): the icon the last update placed, mapped onto the displayed
   * map now. 3.13d (L6): a read before any update places the icons first.
   */
  iconInfo(questId: number): readonly [boolean, number, number, number] | undefined {
    if (!Number.isInteger(questId) || questId <= 0) return undefined;
    const icon = (this.#icons ??= frameXmlQuestPoiLayout(this.#context)).get(questId);
    const point = icon && this.#context.point(icon.blob, icon.x, icon.y);
    return icon && point && Math.abs(point.u * point.v) >= ON_MAP_EPSILON
      ? [icon.complete, point.u, point.v, icon.blob.objectiveIndex] : undefined;
  }

  /**
   * The blobs `DrawQuestBlob` paints; none while the `questPOI` CVar is off (0x5901c0 tests it).
   * 3.13e (L6): with the frame's style, the smoothed and merged blobs it builds.
   */
  shapes(questId: number, style?: FrameXmlQuestPoiBuildStyle): ReturnType<typeof frameXmlQuestPoiDrawnShapes> {
    if (!Number.isInteger(questId) || questId <= 0 || !this.#context.enabled()) return undefined;
    return style ? frameXmlQuestPoiDrawnShapes(this.#context, questId, style) : frameXmlQuestPoiShapes(this.#context, questId);
  }

  /** The quest's displayed log row, for the blob tooltip (0x5deeb0); 0 when not in the log. */
  logIndex(questId: number): number {
    return this.#context.quests().find((quest) => quest.questId === questId)?.logIndex ?? 0;
  }

  /** `GetQuestPOILeaderBoard(poiIndex, questLogIndex)` (0x5e6650 → 0x5e58c0). */
  leaderBoard(poiIndex: number, logIndex: number): readonly [string, string, boolean] | undefined {
    if (!Number.isInteger(poiIndex) || poiIndex < 0 || poiIndex > 15 || !Number.isInteger(logIndex) || logIndex < 1) {
      return undefined;
    }
    return this.#context.leaderBoardLine(logIndex, poiIndex);
  }
}

export interface FrameXmlQuestPoiHost {
  readonly questPoi?: FrameXmlQuestPoiModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const NILS: readonly unknown[] = Object.freeze([undefined, undefined, undefined]);

function integer(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

/**
 * Spread after the seam's own QuestMapUpdateAllQuests/QuestPOIGetQuestIDByVisibleIndex: a seam with a
 * POI model answers through it, the canned seam keeps its own answers.
 */
export function frameXmlQuestPoiBindings<Host extends FrameXmlQuestPoiHost>(
  fallback: Readonly<Record<string, (host: Host, args: readonly unknown[]) => readonly unknown[]>>,
): Readonly<Record<string, (host: Host, args: readonly unknown[]) => readonly unknown[]>> {
  const or = (name: string, host: Host, args: readonly unknown[]): readonly unknown[] => fallback[name]?.(host, args) ?? NOTHING;
  return Object.freeze({
    QuestMapUpdateAllQuests: (host, args) => (host.questPoi ? [host.questPoi.updateAllQuests()] : or("QuestMapUpdateAllQuests", host, args)),
    QuestPOIGetQuestIDByVisibleIndex: (host, args) => {
      if (!host.questPoi) return or("QuestPOIGetQuestIDByVisibleIndex", host, args);
      const answer = host.questPoi.questIdByVisibleIndex(integer(args[0]));
      return answer ? [...answer] : NOTHING;
    },
    QuestPOIGetIconInfo: (host, args) => {
      const info = host.questPoi?.iconInfo(integer(args[0]));
      return info ? [...info] : NOTHING;
    },
    // 3.13d (L6): places and spreads the icons QuestPOIGetIconInfo then reads.
    QuestPOIUpdateIcons: (host) => { host.questPoi?.updateIcons(); return NOTHING; },
    GetQuestPOILeaderBoard: (host, args) => {
      const line = host.questPoi?.leaderBoard(integer(args[0]), integer(args[1]));
      return line ? [line[0], line[1], line[2] ? 1 : undefined] : NILS;
    },
  });
}
