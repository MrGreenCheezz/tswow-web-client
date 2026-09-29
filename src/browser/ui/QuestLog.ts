import { queueFrameTask } from "../../transport/PacketPump.js";
import { player } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import type { WorldStore } from "../../world/WorldStore.js";
import {
  QUEST_STATUS_AVAILABLE, QUEST_STATUS_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_REWARD_REP, QUEST_STATUS_REWARD,
  QUEST_STATUS_REWARD2, QUEST_STATUS_REWARD_REP, buildCarriedItemCounts, buildQuestLogView,
  questObjectiveLabel, type QuestCarriedItemStack, type QuestLogEntryView,
  type QuestLogObjectiveView, type QuestTemplate,
} from "../../world/QuestProtocol.js";
import { creatureIconSource } from "../CreatureMetadata.js";
import { game } from "../game/Context.js";
import { entryOf, playerInventory, stackCount } from "../Inventory.js";
import { rightRail } from "./Dom.js";
import { clearSlot, skinnable, slot } from "./Slots.js";
import { Panel, attachTooltip, confirmPanel, stackLabel, textLine, type TooltipContent } from "./Widgets.js";
import { formatNpcText } from "./Npc.js";
import { formatMoney } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { ensureSpellNames } from "./SpellNames.js";
import { spellTooltip } from "./Spellbook.js";
import { questTimerDisplay } from "./QuestTimer.js";

/**
 * The quest log and the tracker beside the world.
 *
 * The log was invisible: the character's own update fields have carried five words per quest all
 * along, and nothing read them, while `SMSG_QUEST_QUERY_RESPONSE` — the packet that says what a
 * quest actually is — was among the ones the world loop dropped. Both are read now, and this joins
 * them: the fields say how far along, the template says what of.
 */
let panel: Panel | undefined;
let tracker: HTMLElement | undefined;
let stopStoreBinding: (() => void) | undefined;
let stopObjectiveMetadataBinding: (() => void) | undefined;
let nativeReplacementActive = false;
let nativeReplacementState: QuestLogNativeState | undefined;
let timedQuestWorld: WorldClient | undefined;
let timedQuestTick: ReturnType<typeof setInterval> | undefined;
const requestedQuestClocks = new WeakSet<WorldClient>();

function serverQuestTime(world: WorldClient): number | undefined {
  return world.currentQueryTime() ?? world.currentServerTime();
}

function stopTimedQuestTick(): void {
  if (timedQuestTick !== undefined) clearInterval(timedQuestTick);
  timedQuestTick = undefined;
  timedQuestWorld = undefined;
}

/** Update only the countdown labels, preserving search focus, scroll and quest selection. */
function refreshTimedQuestLabels(): void {
  const world = game.world;
  if (!world || world !== timedQuestWorld) {
    stopTimedQuestTick();
    return;
  }
  if (nativeReplacementActive) return;
  const now = serverQuestTime(world);
  if (panel?.visible) {
    for (const line of panel.body.querySelectorAll<HTMLElement>(".quest-timer-row")) {
      const expiry = Number(line.dataset["questTimerExpiry"]);
      const display = questTimerDisplay(expiry, now);
      const value = line.lastElementChild;
      if (value) value.textContent = display.text;
      line.dataset["urgent"] = String(display.urgent);
    }
  }
  if (tracker && !tracker.hidden) {
    for (const line of tracker.querySelectorAll<HTMLElement>(".quest-track-timer")) {
      const display = questTimerDisplay(Number(line.dataset["questTimerExpiry"]), now);
      line.textContent = display.text;
      line.dataset["urgent"] = String(display.urgent);
    }
  }
}

function watchTimedQuests(world: WorldClient | undefined, list: readonly QuestLogEntryView[]): void {
  if (!world || !list.some((entry) => entry.timer > 0 && !entry.failed)) {
    stopTimedQuestTick();
    return;
  }
  if (timedQuestWorld !== world) {
    stopTimedQuestTick();
    timedQuestWorld = world;
  }
  // The core writes a Unix expiry. Use an already synchronised server clock when present;
  // otherwise ask for CMSG_QUERY_TIME once for this world rather than trusting Date.now().
  if (serverQuestTime(world) === undefined && !requestedQuestClocks.has(world)) {
    requestedQuestClocks.add(world);
    world.requestServerTime();
  }
  timedQuestTick ??= setInterval(refreshTimedQuestLabels, 1_000);
}

/** The browser quest-log surface state borrowed while the stock QuestLogFrame owns the panel. */
export interface QuestLogNativeState {
  /** The exact fallback surface captured at publication, not merely a boolean snapshot. */
  readonly panel: Panel | undefined;
  readonly panelExists: boolean;
  readonly panelVisible: boolean;
  /** The exact fallback tracker captured at publication, when it had already been created. */
  readonly tracker: HTMLElement | undefined;
  readonly trackerExists: boolean;
  readonly trackerVisible: boolean;
  /** clearQuestLog() also vetoes restoring stale panel contents during world teardown. */
  restorePanel: boolean;
  /** clearQuestLog() vetoes restoring a stale tracker during world teardown. */
  restoreTracker: boolean;
}

/**
 * Borrow only the native quest-log panel at the stock publication boundary.
 *
 * The stock WatchFrame is the owner of the tracker while this replacement is active.  Both native
 * fallback surfaces are hidden before publication, and their object identities are retained so a
 * late cleanup cannot alter a newer fallback surface.
 */
export function beginQuestLogNativeReplacement(): QuestLogNativeState {
  if (nativeReplacementState) return nativeReplacementState;
  const state: QuestLogNativeState = {
    panel,
    panelExists: panel !== undefined,
    panelVisible: panel?.visible ?? false,
    tracker,
    trackerExists: tracker !== undefined,
    trackerVisible: tracker !== undefined && !tracker.hidden,
    restorePanel: true,
    restoreTracker: true,
  };
  nativeReplacementState = state;
  nativeReplacementActive = true;
  stopTimedQuestTick();
  panel?.hide();
  if (tracker) tracker.hidden = true;
  return state;
}

/** End the stock borrowing boundary and restore the exact native panel visibility. */
export function restoreQuestLogNativeReplacement(state?: QuestLogNativeState): void {
  // A late cleanup from an older mount must not restore its panel snapshot over a newer owner.
  // The state object is the mount identity; an omitted state is reserved for the active teardown.
  if (state !== undefined && nativeReplacementState !== state) return;
  const previous = nativeReplacementState;
  if (!previous) return;
  nativeReplacementState = undefined;
  nativeReplacementActive = false;

  // Restore only the object captured by this owner.  If no panel existed at publication, a
  // concurrent fallback-created one remains closed; if a newer panel replaced the captured one,
  // leave that newer owner alone.
  if (previous.panelExists && previous.panel && panel === previous.panel) {
    if (previous.panelVisible && previous.restorePanel) {
      // showQuestLog is blocked while stock owns the surface, so refresh before making a previously
      // visible fallback panel available again.  This prevents a stale character's title/cards
      // from surviving a demotion or a normal handoff.
      showQuestLog();
      previous.panel.show();
    }
    else previous.panel.hide();
  } else if (!previous.panelExists && panel) {
    panel.hide();
  }

  // The tracker needs a redraw before it becomes visible again: quest templates and tracked IDs
  // may have changed while the stock WatchFrame owned the world.  A tracker that was not present
  // at publication is never made visible by teardown, even if a fallback call raced the mount.
  if (previous.trackerExists && previous.tracker && tracker === previous.tracker) {
    renderQuestTracker();
    if (!previous.trackerVisible || !previous.restoreTracker) tracker.hidden = true;
  } else if (!previous.trackerExists && tracker) {
    tracker.hidden = true;
  }
  // A world teardown can restore the old DOM owner for cleanup without restoring either surface.
  // Its redraw above must not re-arm a countdown that clearQuestLog just stopped.
  if (!previous.restorePanel && !previous.restoreTracker) stopTimedQuestTick();
}

/** Which quests the tracker shows. Until the first explicit choice, current quests are all shown. */
const tracked = new Set<number>();
let trackingExplicit = false;
let trackerCollapsed = false;
let questQuery = "";
let selectedQuestId: number | undefined;

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

/** Keep the compact local spelling throughout the native quest-log implementation. */
function entries(): QuestLogEntryView[] {
  return currentQuestLogEntries();
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
    if (game.world === world) redrawQuestObjectives();
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
      if (cleared) requestQuestObjectiveMetadata(entries());
      redrawQuestObjectives();
    });
  });
  if (!store) return;
  stopStoreBinding = store.events.on("PLAYER_QUEST_LOG_UPDATE", ({ guid }) => {
    if (game.world !== world || guid !== world.state.selfGuid) return;
    requestMissingQuestTemplates();
    requestQuestPoi();
    showQuestLog();
    showQuestTracker();
  });
}

/** Asks the server for anything in the log this client cannot name yet. */
export function requestMissingQuestTemplates(): void {
  const world = game.world;
  if (!world) return;
  for (const entry of entries()) if (!entry.template) world.queryQuest(entry.questId);
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
  const questIds = entries().map((entry) => entry.questId).sort((left, right) => left - right);
  const wanted = questIds.join(",");
  if (wanted === poiAskedFor) return;
  poiAskedFor = wanted;
  const missing = questIds.filter((questId) => !world.questPoi.has(questId));
  if (missing.length > 0) world.requestQuestPoi(missing);
}

function objectiveName(objective: QuestLogObjectiveView): string | undefined {
  const world = game.world;
  if (objective.kind === "item") {
    return game.itemMetadata?.get(objective.id)?.name
      ?? world?.itemTemplates.get(objective.id)?.name;
  }
  if (objective.kind === "gameObject") return world?.gameObjectTemplates.get(objective.id)?.name;
  return game.creatureMetadata?.get(objective.id)?.name
    ?? world?.creatureTemplates.get(objective.id)?.name;
}

function objectiveItemTooltip(itemId: number, count: number): TooltipContent {
  const metadata = game.itemMetadata?.get(itemId);
  const template = game.world?.itemTemplates.get(itemId);
  if (metadata || template?.found) return itemTooltipFor(itemId, { count });
  return {
    title: `Предмет #${itemId}`,
    footer: [template ? "Сервер не предоставил описание предмета" : "Название и иконка загружаются…"],
  };
}

function objectiveItemSlot(objective: QuestLogObjectiveView, name: string): HTMLElement {
  const metadataClient = game.itemMetadata;
  const metadata = metadataClient?.get(objective.id);
  const template = game.world?.itemTemplates.get(objective.id);
  const knownTemplate = template?.found ? template : undefined;
  const iconUrl = metadata && metadataClient ? metadataClient.iconUrl(metadata)
    : knownTemplate && metadataClient ? metadataClient.displayIconUrl(knownTemplate.displayInfoId) : undefined;
  const itemSlot = document.createElement("div");
  itemSlot.className = "ui-slot quest-objective-item";
  itemSlot.tabIndex = 0;
  itemSlot.setAttribute("role", "img");
  itemSlot.setAttribute("aria-label", `${name}, ${Number.isNaN(objective.have) ? "количество неизвестно" : objective.have} из ${objective.need}`);
  if (metadata?.quality !== undefined) itemSlot.dataset["quality"] = String(metadata.quality);
  else if (knownTemplate) itemSlot.dataset["quality"] = String(knownTemplate.quality);
  if (!iconUrl) itemSlot.dataset["metadataState"] = "unresolved";
  attachTooltip(itemSlot, () => objectiveItemTooltip(objective.id, objective.need));
  if (iconUrl) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, iconUrl);
    itemSlot.append(icon);
  }
  const required = stackLabel(objective.need);
  if (required) {
    const count = document.createElement("em");
    count.className = "ui-slot-count";
    count.textContent = required;
    itemSlot.append(count);
  }
  return itemSlot;
}

function objectiveVisual(objective: QuestLogObjectiveView, name: string): HTMLElement {
  if (objective.kind === "item") return objectiveItemSlot(objective, name);
  if (objective.kind === "creature") {
    const icon = document.createElement("img");
    icon.className = "quest-objective-icon";
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, creatureIconSource(game.creatureMetadata?.get(objective.id), game.gatewayOrigin));
    return icon;
  }
  const marker = document.createElement("span");
  marker.className = "quest-objective-marker";
  marker.setAttribute("aria-hidden", "true");
  return marker;
}

export function questObjectiveRows(entry: QuestLogEntryView): HTMLElement[] {
  if (entry.objectives.length === 0) {
    return [textLine(entry.template?.objectivesText ? "Задача" : "Цели", formatNpcText(entry.template?.objectivesText ?? "…"))];
  }
  return entry.objectives.map((objective) => {
    const have = Number.isNaN(objective.have) ? "?" : String(objective.have);
    const name = questObjectiveLabel(objective, objectiveName(objective));
    const line = textLine(name, `${have} / ${objective.need}`);
    const row = document.createElement("div");
    row.className = "quest-objective-row";
    row.dataset["kind"] = objective.kind;
    row.append(objectiveVisual(objective, name), line);
    if (objective.done) row.classList.add("quest-objective-done");
    return row;
  });
}

function redrawQuestObjectives(): void {
  if (panel?.visible) showQuestLog();
  if (tracker && !tracker.hidden) renderQuestTracker();
}

/** Ask the existing metadata caches once per target; every client deduplicates its own ids. */
function requestQuestObjectiveMetadata(list: readonly QuestLogEntryView[]): void {
  const objectives = list.flatMap((entry) => entry.objectives);
  const itemIds = objectives.filter((objective) => objective.kind === "item").map((objective) => objective.id);
  const creatureIds = objectives.filter((objective) => objective.kind === "creature").map((objective) => objective.id);
  const itemClient = game.itemMetadata;
  if (itemClient && itemIds.length > 0) {
    void itemClient.load(itemIds).then((changed) => {
      if (changed && game.itemMetadata === itemClient) redrawQuestObjectives();
    }).catch((error) => console.warn("Quest objective item metadata unavailable", error));
  }
  const creatureClient = game.creatureMetadata;
  if (creatureClient && creatureIds.length > 0) {
    void creatureClient.load(creatureIds).then((changed) => {
      if (changed && game.creatureMetadata === creatureClient) redrawQuestObjectives();
    }).catch((error) => console.warn("Quest objective creature metadata unavailable", error));
  }
  const world = game.world;
  if (world) {
    for (const objective of objectives) {
      if (objective.kind === "gameObject") world.gameObjectTemplate(objective.id, 0n);
    }
  }
}

function questTitle(entry: QuestLogEntryView): string {
  return entry.template
    ? `${formatNpcText(entry.template.title)}${entry.template.level > 0 ? ` (${entry.template.level})` : ""}`
    : `Задание ${entry.questId}`;
}

function questMatches(entry: QuestLogEntryView, query: string): boolean {
  if (!query) return true;
  const searchable = [
    questTitle(entry), entry.template?.details ?? "", entry.template?.objectivesText ?? "",
    ...entry.objectives.map((objective) => questObjectiveLabel(objective, objectiveName(objective))),
  ].join(" ").toLocaleLowerCase();
  return searchable.includes(query);
}

function questStatus(entry: QuestLogEntryView): string {
  if (entry.failed) return "Провалено";
  if (entry.complete) return "Выполнено — доступна награда";
  return "В процессе";
}

type QuestItemReward = { itemId: number; count: number };

/** Fetch names and pictures even when a reward item is not already present in the player's bags. */
function requestQuestRewardMetadata(template: QuestTemplate): void {
  const itemMetadata = game.itemMetadata;
  const itemIds = [...template.rewardItems, ...template.rewardChoiceItems].map((reward) => reward.itemId);
  if (itemMetadata && itemIds.length > 0) {
    void itemMetadata.load(itemIds).then((requested) => {
      if (requested && game.itemMetadata === itemMetadata && panel?.visible) showQuestLog();
    }).catch((error) => console.warn("Quest reward metadata unavailable", error));
  }
  if (template.rewardDisplaySpell > 0) {
    ensureSpellNames([template.rewardDisplaySpell], () => {
      if (panel?.visible) showQuestLog();
    });
  }
}

/** A reward is not a carried slot yet, but its description is the same authoritative item row. */
function questRewardItemTooltip(itemId: number, count: number): TooltipContent {
  const metadata = game.itemMetadata?.get(itemId);
  const template = game.world?.itemTemplate(itemId);
  if (!metadata && !template?.found) {
    return {
      title: template ? "Недоступная предметная награда" : "Предметная награда",
      footer: [template ? "Сервер не предоставил описание предмета" : "Описание предмета загружается…"],
    };
  }
  return itemTooltipFor(itemId, { count });
}

function questRewardItem(reward: QuestItemReward, choice: boolean): HTMLElement {
  const itemMetadata = game.itemMetadata;
  const metadata = itemMetadata?.get(reward.itemId);
  const template = game.world?.itemTemplate(reward.itemId);
  const knownTemplate = template?.found ? template : undefined;
  const name = metadata?.name || knownTemplate?.name;
  const iconUrl = metadata && itemMetadata ? itemMetadata.iconUrl(metadata)
    : knownTemplate && itemMetadata ? itemMetadata.displayIconUrl(knownTemplate.displayInfoId) : undefined;
  const slot = document.createElement("div");
  slot.className = "ui-slot quest-reward-item";
  slot.tabIndex = 0;
  slot.setAttribute("role", "img");
  slot.dataset["rewardKind"] = choice ? "choice" : "guaranteed";
  if (metadata?.quality !== undefined) slot.dataset["quality"] = String(metadata.quality);
  else if (knownTemplate) slot.dataset["quality"] = String(knownTemplate.quality);
  if (!name) slot.dataset["metadataState"] = "unresolved";
  slot.setAttribute("aria-label", [name ?? "Предметная награда — описание загружается", stackLabel(reward.count)]
    .filter(Boolean).join(", "));
  attachTooltip(slot, () => questRewardItemTooltip(reward.itemId, reward.count));
  if (iconUrl) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, iconUrl);
    slot.append(icon);
  }
  const count = stackLabel(reward.count);
  if (count) {
    const badge = document.createElement("em");
    badge.className = "ui-slot-count";
    badge.textContent = count;
    slot.append(badge);
  }
  return slot;
}

function questRewardGroup(labelText: string, rewards: readonly QuestItemReward[], choice: boolean): HTMLElement {
  const group = document.createElement("div");
  group.className = "quest-reward-group";
  const label = document.createElement("span");
  label.className = "quest-reward-label";
  label.textContent = labelText;
  const slots = document.createElement("div");
  slots.className = "ui-slots quest-reward-slots";
  slots.append(...rewards.map((reward) => questRewardItem(reward, choice)));
  group.append(label, slots);
  return group;
}

function questRewardSpell(spellId: number): HTMLElement {
  const metadata = game.spells.get(spellId);
  const slot = document.createElement("div");
  slot.className = "ui-slot quest-reward-spell";
  slot.tabIndex = 0;
  slot.setAttribute("role", "img");
  if (!metadata) slot.dataset["metadataState"] = "unresolved";
  slot.setAttribute("aria-label", metadata?.name ?? "Заклинание-награда — описание загружается");
  attachTooltip(slot, () => metadata ? spellTooltip(spellId) : {
    title: "Заклинание-награда",
    footer: ["Название, иконка и описание заклинания загружаются…"],
  });
  const iconUrl = spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin);
  if (iconUrl) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.addEventListener("error", () => icon.remove(), { once: true });
    setIconSource(icon, iconUrl);
    slot.append(icon);
  }
  return rewardSpellGroup(slot);
}

function rewardSpellGroup(slot: HTMLElement): HTMLElement {
  const group = document.createElement("div");
  group.className = "quest-reward-group quest-reward-spell-group";
  const label = document.createElement("span");
  label.className = "quest-reward-label";
  label.textContent = "Заклинание";
  const slots = document.createElement("div");
  slots.className = "ui-slots quest-reward-slots";
  slots.append(slot);
  group.append(label, slots);
  return group;
}

function questRewards(entry: QuestLogEntryView): HTMLElement[] {
  const template = entry.template;
  if (!template) return [];
  requestQuestRewardMetadata(template);
  const lines: HTMLElement[] = [];
  if (template.rewardMoney > 0) lines.push(textLine("Деньги", formatMoney(template.rewardMoney)));
  if (template.requiredMoney > 0) lines.push(textLine("Стоимость", formatMoney(template.requiredMoney)));
  if (template.rewardBonusMoney > 0) lines.push(textLine("Бонус", formatMoney(template.rewardBonusMoney)));
  if (template.rewardHonor > 0) lines.push(textLine("Честь", String(template.rewardHonor)));
  if (template.rewardTalents > 0) lines.push(textLine("Таланты", String(template.rewardTalents)));
  if (template.rewardItems.length > 0) {
    lines.push(questRewardGroup("Награда", template.rewardItems, false));
  }
  if (template.rewardChoiceItems.length > 0) {
    lines.push(questRewardGroup("На выбор", template.rewardChoiceItems, true));
  }
  if (template.rewardDisplaySpell > 0) lines.push(questRewardSpell(template.rewardDisplaySpell));
  return lines;
}

function buildQuestActions(entry: QuestLogEntryView, world: WorldClient | undefined): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "quest-actions quest-log-entry-actions";
  const track = document.createElement("button");
  track.type = "button";
  track.textContent = tracked.has(entry.questId) ? "Не следить" : "Следить";
  track.setAttribute("aria-pressed", String(tracked.has(entry.questId)));
  track.addEventListener("click", () => {
    trackingExplicit = true;
    if (!tracked.delete(entry.questId)) tracked.add(entry.questId);
    showQuestLog();
    showQuestTracker();
  });
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Обновить описание";
  refresh.addEventListener("click", () => {
    if (entry.template) return;
    world?.queryQuest(entry.questId);
  });
  refresh.hidden = entry.template !== undefined;
  const abandon = document.createElement("button");
  abandon.type = "button";
  abandon.className = "danger";
  abandon.textContent = "Отказаться";
  abandon.addEventListener("click", () => {
    confirmPanel(abandon, {
      title: `Отказаться от задания «${entry.template?.title ?? `Задание ${entry.questId}`}»?`,
      lines: ["Прогресс будет потерян; задание можно взять заново у того же НИП."],
      confirm: "Отказаться",
      danger: true,
      onConfirm: () => {
        world?.abandonQuest(entry.slot);
        tracked.delete(entry.questId);
        showQuestLog();
        showQuestTracker();
      },
    });
  });
  const share = document.createElement("button");
  share.type = "button";
  share.textContent = "Поделиться";
  // The server refuses a share with nobody to share to, so say so upfront instead of
  // answering the click with silence. `group` is undefined outside a party/raid
  // (`SMSG_GROUP_DESTROYED` clears it), and its member list excludes the player
  // (`GroupProtocol.ts:59`), so one entry already means somebody to share with.
  const shareable = (world?.group?.members.length ?? 0) > 0;
  share.disabled = !shareable;
  share.title = shareable ? "Поделиться заданием с группой" : "Вне группы делиться не с кем";
  share.addEventListener("click", () => {
    world?.shareQuest(entry.questId);
  });
  actions.append(track, refresh, share, abandon);
  return actions;
}

function build(): Panel {
  const built = new Panel({ id: "quest-log", title: "Журнал заданий", className: "quest-log" });
  skinnable("quest-log", built.root);
  return built;
}

export function showQuestLog(): void {
  if (nativeReplacementActive) return;
  const world = game.world;
  panel ??= build();
  const list = entries();
  watchTimedQuests(world, list);
  requestQuestObjectiveMetadata(list);
  panel.title = `Журнал заданий · ${list.length} / 25`;
  panel.body.replaceChildren();
  clearSlot("quest-log/entry-actions");
  const shell = document.createElement("div");
  shell.className = "quest-log-shell";
  const toolbar = document.createElement("div");
  toolbar.className = "quest-log-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.value = questQuery;
  search.placeholder = "Поиск заданий";
  search.setAttribute("aria-label", "Поиск заданий");
  search.addEventListener("input", () => {
    const caretStart = search.selectionStart;
    const caretEnd = search.selectionEnd;
    questQuery = search.value.trim().toLocaleLowerCase();
    showQuestLog();
    // Redrawing the two panes is intentionally still a full render, but the search field is a
    // keyboard control rather than a disposable label. Restore the replacement input's focus and
    // selection so a second character continues the same query instead of going to the world.
    const nextSearch = panel?.body.querySelector<HTMLInputElement>(
      ".quest-log-toolbar input[type=\"search\"]",
    );
    if (!nextSearch) return;
    nextSearch.focus();
    if (typeof nextSearch.setSelectionRange !== "function") return;
    const start = Math.min(caretStart ?? nextSearch.value.length, nextSearch.value.length);
    const end = Math.min(caretEnd ?? start, nextSearch.value.length);
    nextSearch.setSelectionRange(start, end);
  });
  const count = document.createElement("span");
  count.className = "muted quest-log-count";
  count.textContent = list.length > 0 ? `${list.length} в журнале` : world ? "Журнал пуст" : "Нет соединения";
  toolbar.append(search, count);

  const filtered = list.filter((entry) => questMatches(entry, questQuery));
  if (!filtered.some((entry) => entry.questId === selectedQuestId)) selectedQuestId = filtered[0]?.questId;
  const panes = document.createElement("div");
  panes.className = "quest-log-panes";
  const listPane = document.createElement("nav");
  listPane.className = "quest-log-list";
  listPane.setAttribute("aria-label", "Список заданий");
  const detailPane = document.createElement("article");
  detailPane.className = "quest-log-details";
  const groups: Array<[string, QuestLogEntryView[]]> = [
    ["В процессе", filtered.filter((entry) => !entry.complete && !entry.failed)],
    ["Выполнено", filtered.filter((entry) => entry.complete)],
    ["Провалено", filtered.filter((entry) => entry.failed)],
  ];
  for (const [headingText, group] of groups) {
    if (group.length === 0) continue;
    const heading = document.createElement("h4");
    heading.textContent = headingText;
    listPane.append(heading);
    for (const entry of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quest-log-list-entry";
      if (entry.questId === selectedQuestId) button.classList.add("is-selected");
      button.setAttribute("aria-pressed", String(entry.questId === selectedQuestId));
      button.textContent = questTitle(entry);
      const state = document.createElement("small");
      state.textContent = entry.complete ? "Готово" : entry.failed ? "Провалено" : "В процессе";
      button.append(state);
      button.addEventListener("click", () => {
        selectedQuestId = entry.questId;
        showQuestLog();
      });
      listPane.append(button);
    }
  }
  if (filtered.length === 0) {
    listPane.append(textLine("Пусто", list.length > 0 ? "Поиск ничего не нашёл" : "Заданий нет"));
    detailPane.append(textLine("Статус", list.length > 0 ? "Измените запрос поиска" : "Журнал пуст"));
  } else {
    const selected = filtered.find((entry) => entry.questId === selectedQuestId) ?? filtered[0]!;
    const title = document.createElement("h3");
    title.textContent = questTitle(selected);
    if (selected.complete) title.classList.add("quest-complete");
    if (selected.failed) title.classList.add("quest-failed");
    detailPane.append(title, textLine("Статус", questStatus(selected)));
    if (selected.timer > 0 && !selected.failed && world) {
      const display = questTimerDisplay(selected.timer, serverQuestTime(world));
      const line = textLine("Время", display.text);
      line.classList.add("quest-timer-row");
      line.dataset["questTimerExpiry"] = String(selected.timer);
      line.dataset["urgent"] = String(display.urgent);
      detailPane.append(line);
    }
    if (!selected.template) {
      detailPane.append(textLine("Описание", "Загрузка…"));
    } else {
      const template = selected.template;
      for (const [label, value] of [["Описание", template.details], ["Цель", template.objectivesText], ["Место", template.areaDescription]] as const) {
        if (!value) continue;
        const text = document.createElement("p");
        text.className = `quest-detail-text quest-detail-${label === "Описание" ? "body" : "objective"}`;
        text.textContent = formatNpcText(value);
        detailPane.append(text);
      }
      const objectives = document.createElement("section");
      objectives.className = "quest-detail-section quest-detail-objectives";
      const objectivesHeading = document.createElement("h4");
      objectivesHeading.textContent = "Цели";
      objectives.append(objectivesHeading, ...questObjectiveRows(selected));
      detailPane.append(objectives);
      const rewards = questRewards(selected);
      if (rewards.length > 0) {
        const rewardSection = document.createElement("section");
        rewardSection.className = "quest-detail-section quest-detail-rewards";
        const rewardHeading = document.createElement("h4");
        rewardHeading.textContent = "Награды";
        rewardSection.append(rewardHeading, ...rewards);
        detailPane.append(rewardSection);
      }
      if (selected.complete && template.completedText) {
        const completed = document.createElement("p");
        completed.className = "quest-completed-text";
        completed.textContent = formatNpcText(template.completedText);
        detailPane.append(completed);
      }
    }
    const actions = buildQuestActions(selected, world);
    slot("quest-log/entry-actions", actions, { questId: selected.questId });
    detailPane.append(actions);
  }
  panes.append(listPane, detailPane);
  shell.append(toolbar, panes);
  panel.body.append(shell);
}

/** Draw the native fallback tracker from current world data. */
function renderQuestTracker(): void {
  if (!tracker) {
    tracker = document.createElement("div");
    tracker.id = "quest-tracker";
    tracker.setAttribute("aria-label", "Отслеживаемые задания");
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "quest-tracker-toggle";
    heading.setAttribute("aria-expanded", "true");
    heading.textContent = "Отслеживаемые задания";
    heading.addEventListener("click", () => {
      trackerCollapsed = !trackerCollapsed;
      renderQuestTracker();
    });
    const body = document.createElement("div");
    body.className = "quest-tracker-body";
    tracker.append(heading, body);
    // The right-hand rail, which the minimap and the boss frames also live in: four boxes each
    // guessing their own `top` drew on top of one another the moment any of them had content.
    rightRail.append(tracker);
  }
  const allEntries = entries();
  watchTimedQuests(game.world, allEntries);
  requestQuestObjectiveMetadata(allEntries);
  // Match the original client's fresh-log behaviour: current quests are watched until the player
  // makes an explicit tracking choice. After that first choice, an empty set truthfully means none.
  const list = allEntries.filter((entry) => !trackingExplicit || tracked.has(entry.questId));
  const body = tracker.querySelector<HTMLElement>(".quest-tracker-body");
  const heading = tracker.querySelector<HTMLButtonElement>(".quest-tracker-toggle");
  if (!body || !heading) return;
  body.replaceChildren();
  tracker.hidden = list.length === 0;
  body.hidden = trackerCollapsed;
  heading.setAttribute("aria-expanded", String(!trackerCollapsed));
  // The list scrolls rather than being cut at ten: a full log silently lost quests 11 to 25, and
  // the overflow ran off the bottom of a viewport that clips.
  for (const entry of list) {
    const block = document.createElement("div");
    block.className = "quest-track";
    const title = document.createElement("strong");
    title.textContent = entry.template ? formatNpcText(entry.template.title) : `Задание ${entry.questId}`;
    if (entry.complete) title.classList.add("quest-complete");
    block.append(title);
    if (entry.timer > 0 && !entry.failed && game.world) {
      const display = questTimerDisplay(entry.timer, serverQuestTime(game.world));
      const time = document.createElement("span");
      time.className = "quest-track-timer";
      time.dataset["questTimerExpiry"] = String(entry.timer);
      time.dataset["urgent"] = String(display.urgent);
      time.textContent = display.text;
      block.append(time);
    }
    block.append(...questObjectiveRows(entry));
    body.append(block);
  }
}

/** The objectives beside the world, which is what is actually read while playing. */
export function showQuestTracker(): void {
  if (nativeReplacementActive) {
    // Publication owns this surface now.  Do not let a queued native refresh create or reveal it;
    // also fail closed if an external fallback path made it visible while the stock owner ran.
    if (tracker) tracker.hidden = true;
    return;
  }
  renderQuestTracker();
}

export function toggleQuestLog(): void {
  if (nativeReplacementActive) return;
  panel ??= build();
  panel.toggle();
  if (panel.visible) showQuestLog();
}

export function questLogOpen(): boolean {
  return !nativeReplacementActive && (panel?.visible ?? false);
}

export function closeQuestLog(): void {
  panel?.hide();
}

/**
 * The mark over a head. The core sends a status per guid; these are the ones that mean "there is
 * something here for you", and the rest draw nothing.
 */
export function questMarkFor(guid: bigint): string | undefined {
  const status = game.world?.questGiverStatus.get(guid);
  if (status === undefined) return undefined;
  if (status === QUEST_STATUS_REWARD || status === QUEST_STATUS_REWARD2 || status === QUEST_STATUS_REWARD_REP
    || status === QUEST_STATUS_LOW_LEVEL_REWARD_REP) return "?";
  if (status === QUEST_STATUS_AVAILABLE || status === QUEST_STATUS_AVAILABLE_REP
    || status === QUEST_STATUS_LOW_LEVEL_AVAILABLE || status === QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP) return "!";
  return undefined;
}

/** Forgets what was tracked, for a character that is no longer the one being played. */
export function clearQuestLog(): void {
  stopTimedQuestTick();
  stopStoreBinding?.();
  stopStoreBinding = undefined;
  stopObjectiveMetadataBinding?.();
  stopObjectiveMetadataBinding = undefined;
  tracked.clear();
  trackingExplicit = false;
  trackerCollapsed = false;
  questQuery = "";
  selectedQuestId = undefined;
  poiAskedFor = "";
  if (!nativeReplacementActive && panel) panel.hide();
  if (nativeReplacementActive && nativeReplacementState) {
    nativeReplacementState.restorePanel = false;
    nativeReplacementState.restoreTracker = false;
  }
  // Logout/character teardown must clear the native fallback while the stock WatchFrame happens
  // to own the browser tracker.  The replacement snapshot remembers that it must not resurrect
  // this stale content during cleanup.
  if (tracker) tracker.hidden = true;
}
