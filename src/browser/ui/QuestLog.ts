import { player } from "../../world/Fields.js";
import {
  QUEST_STATUS_AVAILABLE, QUEST_STATUS_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_REWARD_REP, QUEST_STATUS_REWARD,
  QUEST_STATUS_REWARD2, QUEST_STATUS_REWARD_REP, buildQuestLogView, type QuestLogEntryView,
} from "../../world/QuestProtocol.js";
import { game } from "../game/Context.js";
import { rightRail } from "./Dom.js";
import { clearSlot, skinnable, slot } from "./Slots.js";
import { Panel, confirmPanel, textLine } from "./Widgets.js";
import { formatNpcText } from "./Npc.js";

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

/** Which quests the tracker shows. Empty means "everything in the log", as a fresh character sees. */
const tracked = new Set<number>();

function entries(): QuestLogEntryView[] {
  const world = game.world;
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world?.state.objects.get(guid);
  if (!world || !self) return [];
  return buildQuestLogView(player.quests(self), world.questTemplates);
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

function objectiveLines(entry: QuestLogEntryView): HTMLElement[] {
  if (entry.objectives.length === 0) {
    return [textLine(entry.template?.objectivesText ? "Задача" : "Цели", formatNpcText(entry.template?.objectivesText ?? "…"))];
  }
  return entry.objectives.map((objective) => {
    const line = textLine(objective.text, `${objective.have} / ${objective.need}`);
    if (objective.done) line.classList.add("quest-objective-done");
    return line;
  });
}

function build(): Panel {
  const built = new Panel({ id: "quest-log", title: "Журнал заданий", className: "quest-log" });
  skinnable("quest-log", built.root);
  return built;
}

export function showQuestLog(): void {
  const world = game.world;
  panel ??= build();
  const list = entries();
  panel.title = `Журнал заданий · ${list.length} / 25`;
  panel.body.replaceChildren();
  // Every card is thrown away and made again on every draw, and each one carries a slot of its own
  // — so the whole family is dropped first (М7). Without this a log redrawn on every kill would
  // grow one dead host per card per draw, each still holding a copy of a module's button.
  clearSlot("quest-log/entry-actions");
  if (list.length === 0) {
    panel.body.append(textLine("Пусто", world ? "Заданий нет" : "Нет соединения"));
    return;
  }

  for (const entry of list) {
    const card = document.createElement("article");
    card.className = "quest-entry";
    const title = document.createElement("strong");
    title.textContent = entry.template
      ? `${formatNpcText(entry.template.title)}${entry.template.level > 0 ? ` (${entry.template.level})` : ""}`
      : `Задание ${entry.questId}`;
    if (entry.complete) title.classList.add("quest-complete");
    if (entry.failed) title.classList.add("quest-failed");
    card.append(title);

    if (entry.template?.objectivesText) {
      const text = document.createElement("p");
      text.className = "muted";
      text.textContent = formatNpcText(entry.template.objectivesText);
      card.append(text);
    }
    card.append(...objectiveLines(entry));

    const actions = document.createElement("div");
    actions.className = "actions";
    const track = document.createElement("button");
    track.type = "button";
    track.textContent = tracked.has(entry.questId) ? "Не следить" : "Следить";
    track.addEventListener("click", () => {
      if (!tracked.delete(entry.questId)) tracked.add(entry.questId);
      showQuestLog();
      showQuestTracker();
    });
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
        },
      });
    });
    actions.append(track, abandon);
    // The quest this row is for rides along as `slot.questId`, so a patch's button can act on the
    // card it was drawn on — `{do: "command", name: "queryQuest", args: ["{slot.questId}"]}` — and
    // one file gives every row in the log its own button.
    slot("quest-log/entry-actions", actions, { questId: entry.questId });
    card.append(actions);
    panel.body.append(card);
  }
}

/** The objectives beside the world, which is what is actually read while playing. */
export function showQuestTracker(): void {
  if (!tracker) {
    tracker = document.createElement("div");
    tracker.id = "quest-tracker";
    tracker.setAttribute("aria-label", "Отслеживаемые задания");
    // The right-hand rail, which the minimap and the boss frames also live in: four boxes each
    // guessing their own `top` drew on top of one another the moment any of them had content.
    rightRail.append(tracker);
  }
  const list = entries().filter((entry) => tracked.size === 0 || tracked.has(entry.questId));
  tracker.replaceChildren();
  tracker.hidden = list.length === 0;
  // The list scrolls rather than being cut at ten: a full log silently lost quests 11 to 25, and
  // the overflow ran off the bottom of a viewport that clips.
  for (const entry of list) {
    const block = document.createElement("div");
    block.className = "quest-track";
    const title = document.createElement("strong");
    title.textContent = entry.template ? formatNpcText(entry.template.title) : `Задание ${entry.questId}`;
    if (entry.complete) title.classList.add("quest-complete");
    block.append(title, ...objectiveLines(entry));
    tracker.append(block);
  }
}

export function toggleQuestLog(): void {
  panel ??= build();
  panel.toggle();
  if (panel.visible) showQuestLog();
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
  tracked.clear();
  poiAskedFor = "";
  if (panel) panel.hide();
  if (tracker) tracker.hidden = true;
}
