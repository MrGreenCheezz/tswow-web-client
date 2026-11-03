import { queueFrameTask } from "../../transport/PacketPump.js";
import { player } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldStore } from "../../world/WorldStore.js";
import {
  QUEST_STATUS_AVAILABLE, QUEST_STATUS_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_REWARD_REP, QUEST_STATUS_REWARD,
  QUEST_STATUS_REWARD2, QUEST_STATUS_REWARD_REP, buildCarriedItemCounts, buildQuestLogView,
  type QuestCarriedItemStack, type QuestLogEntryView,
} from "../../world/QuestProtocol.js";
import { game } from "../game/Context.js";
import { entryOf, playerInventory, stackCount } from "../Inventory.js";
import { questLogWindows } from "./HtmlWindowHosts.js";

/**
 * The quest log as data: the character's own update fields say how far along, the template says what
 * of. The overlays over the world read it whatever interface is on screen, and the HTML log and
 * tracker redraw from it through `HtmlWindowHosts`.
 */
let stopStoreBinding: (() => void) | undefined;
let stopObjectiveMetadataBinding: (() => void) | undefined;

/**
 * Counts what the server has exposed in the carried inventory. This mirrors
 * Trinity's `HasItemCount(..., inBankAlso = false)`: equipment, backpack,
 * carried bag contents and keyring count; bank and buyback do not. A non-zero
 * slot GUID without its item object means the snapshot is incomplete, so no
 * map is returned and the quest view keeps item progress unknown.
 */
function carriedItemCounts(): ReadonlyMap<number, number> | undefined {
  const world = game.world;
  if (!world) return undefined;
  const inventory = playerInventory(world.state);
  if (!inventory) return undefined;
  const stacks: QuestCarriedItemStack[] = [];
  const slots = [
    ...inventory.equipment,
    ...inventory.backpack,
    ...inventory.keyring,
    ...inventory.bags.flatMap((bag) => bag.slots),
  ];
  for (const item of slots) {
    if (item.guid !== 0n && !item.item) return undefined;
    const entry = entryOf(item.item);
    if (item.item && entry <= 0) return undefined;
    if (entry <= 0) continue;
    stacks.push({ itemId: entry, count: stackCount(item) });
  }
  return buildCarriedItemCounts(stacks);
}

/** Current authoritative quest view, shared by native surfaces and non-owning overlays. */
export function currentQuestLogEntries(): QuestLogEntryView[] {
  const world = game.world;
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world?.state.objects.get(guid);
  if (!world || !self) return [];
  return buildQuestLogView(player.quests(self), world.questTemplates, carriedItemCounts());
}

/**
 * Binds the field-level quest log event for one world/store pair. WorldStore
 * already coalesces all changed words in a quest slot into one event per flush;
 * replacing the binding before each enter prevents an old character from
 * repainting the new one. `WorldStore.detach()` also invalidates the returned
 * listener on logout.
 */
export function bindQuestLogStore(store: WorldStore | undefined, world: WorldClient): void {
  stopStoreBinding?.();
  stopStoreBinding = undefined;
  stopObjectiveMetadataBinding?.();
  // Answers come a crowd's worth at a time — every visible piece of gear of every player in view is
  // asked of the server — and each one used to rebuild the tracker. The rows are redrawn once, on
  // the next frame, from whatever has arrived by then; every listener has absorbed its answer long
  // before that.
  const redrawAnsweredObjectives = (): void => {
    if (game.world === world) questLogWindows()?.objectivesChanged();
  };
  stopObjectiveMetadataBinding = world.events.on("QUERY_CACHE_CHANGED", ({ kind }) => {
    const cleared = kind === "cleared";
    if (!cleared && kind !== "creature" && kind !== "item" && kind !== "gameObject") return;
    if (!cleared) {
      queueFrameTask(redrawAnsweredObjectives);
      return;
    }
    // Metadata clients consume the same event. Defer until every listener has absorbed the answer,
    // then replace the numeric fallback in both quest surfaces from the now-current caches. A
    // client-cache reset also clears their asked-sets, so this same deferred boundary may safely
    // re-prime every current target exactly once.
    queueMicrotask(() => {
      if (game.world !== world) return;
      if (cleared) requestQuestObjectiveMetadata(currentQuestLogEntries());
      questLogWindows()?.objectivesChanged();
    });
  });
  if (!store) return;
  stopStoreBinding = store.events.on("PLAYER_QUEST_LOG_UPDATE", ({ guid }) => {
    if (game.world !== world || guid !== world.state.selfGuid) return;
    requestMissingQuestTemplates();
    requestQuestPoi();
    questLogWindows()?.changed();
  });
}

/** Asks the server for anything in the log this client cannot name yet. */
export function requestMissingQuestTemplates(): void {
  const world = game.world;
  if (!world) return;
  for (const entry of currentQuestLogEntries()) if (!entry.template) world.queryQuest(entry.questId);
}

/** The quest set the map markers were last asked for, so a kill counter does not re-ask. */
let poiAskedFor = "";

/**
 * Asks where the log's quests want the player to go.
 *
 * Only when the *set* of quests changes. `PLAYER_QUEST_LOG_UPDATE` fires on every counter the
 * server moves — every kill, every item picked up — and the markers do not move with them.
 */
export function requestQuestPoi(): void {
  const world = game.world;
  if (!world) return;
  const questIds = currentQuestLogEntries().map((entry) => entry.questId).sort((left, right) => left - right);
  const wanted = questIds.join(",");
  if (wanted === poiAskedFor) return;
  poiAskedFor = wanted;
  const missing = questIds.filter((questId) => !world.questPoi.has(questId));
  if (missing.length > 0) world.requestQuestPoi(missing);
}

/** Ask the existing metadata caches once per target; every client deduplicates its own ids. */
export function requestQuestObjectiveMetadata(list: readonly QuestLogEntryView[]): void {
  const objectives = list.flatMap((entry) => entry.objectives);
  const itemIds = objectives.filter((objective) => objective.kind === "item").map((objective) => objective.id);
  const creatureIds = objectives.filter((objective) => objective.kind === "creature").map((objective) => objective.id);
  const itemClient = game.itemMetadata;
  if (itemClient && itemIds.length > 0) {
    void itemClient.load(itemIds).then((changed) => {
      if (changed && game.itemMetadata === itemClient) questLogWindows()?.objectivesChanged();
    }).catch((error) => console.warn("Quest objective item metadata unavailable", error));
  }
  const creatureClient = game.creatureMetadata;
  if (creatureClient && creatureIds.length > 0) {
    void creatureClient.load(creatureIds).then((changed) => {
      if (changed && game.creatureMetadata === creatureClient) questLogWindows()?.objectivesChanged();
    }).catch((error) => console.warn("Quest objective creature metadata unavailable", error));
  }
  const world = game.world;
  if (world) {
    for (const objective of objectives) {
      if (objective.kind === "gameObject") world.gameObjectTemplate(objective.id, 0n);
    }
  }
}

/** Forgets what was tracked, for a character that is no longer the one being played. */
export function clearQuestLog(): void {
  stopStoreBinding?.();
  stopStoreBinding = undefined;
  stopObjectiveMetadataBinding?.();
  stopObjectiveMetadataBinding = undefined;
  poiAskedFor = "";
  questLogWindows()?.cleared();
}
