/**
 * The dialogs a group loot roll puts on screen, and the master looter's assign list.
 *
 * Both packets have been arriving since slice P5 and neither had anywhere to go: the only visible
 * trace of a roll was a line in the status field beside the bags. Without a dialog there is no way
 * to press need on anything, which makes group loot unusable in a client that otherwise handles
 * every one of its packets.
 *
 * A stack rather than one dialog: a boss drops several items at once and the server rolls them all
 * in the same second.
 */

import { game } from "../game/Context.js";
import { unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { activeRolls, masterLootRows, remainingSeconds, rollOptions, type ActiveRoll } from "./LootRollModel.js";
import { LOOT_SLOT_MASTER } from "../../world/LootProtocol.js";
import { attachTooltip } from "./Widgets.js";
import { frameXmlLootPublished } from "../framexml/FrameXmlLootController.js";

let container: HTMLElement | undefined;
let ticking = false;

function root(): HTMLElement | undefined {
  if (container?.isConnected) return container;
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  container = document.createElement("div");
  container.id = "loot-rolls";
  container.className = "loot-rolls";
  viewport.append(container);
  return container;
}

export function resetLootRolls(): void {
  container?.replaceChildren();
  dismissed.clear();
}

/** True while a dialog is up, so Escape closes it rather than opening the game menu. */
export function lootRollsOpen(): boolean {
  return (container?.childElementCount ?? 0) > 0;
}

/** Escape dismisses the dialogs without answering; the rolls themselves stay in the model. */
export function closeLootRolls(): void {
  dismissed = new Set([...(game.world?.lootRolls.keys() ?? [])]);
  showLootRolls();
}

/** Slots the player has waved away this session. A new roll in the same slot clears the mark. */
let dismissed = new Set<bigint>();

/** The wire's name first: a roll never ordered anything, so the dump was all it ever had. */
function itemName(itemId: number): string {
  return game.world?.itemTemplate(itemId)?.name
    || game.itemMetadata?.get(itemId)?.name
    || unknownLabel("предмет", itemId);
}

function rollCard(roll: ActiveRoll): HTMLElement {
  const world = game.world;
  const card = document.createElement("div");
  card.className = "loot-roll";

  const title = document.createElement("strong");
  title.textContent = roll.start.count > 1
    ? `${itemName(roll.start.itemId)} ×${roll.start.count}`
    : itemName(roll.start.itemId);
  attachTooltip(title, () => itemTooltipFor(roll.start.itemId, {
    count: roll.start.count,
    footer: ["Бросок группы"],
  }));

  const timer = document.createElement("span");
  timer.className = "loot-roll-timer";
  timer.textContent = `${remainingSeconds(roll.remainingMs)} с`;

  const buttons = document.createElement("div");
  buttons.className = "loot-roll-actions";
  for (const option of rollOptions(roll.start.voteMask)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.addEventListener("click", () => {
      world?.rollForLoot(roll.itemGuid, option.rollType);
      // The server does not echo the player's own vote back as a dialog change, so the card is
      // taken down here rather than waiting for a packet that only tells everyone else.
      dismissed.add(roll.itemGuid);
      showLootRolls();
    });
    buttons.append(button);
  }

  const header = document.createElement("div");
  header.className = "loot-roll-header";
  header.append(title, timer);
  card.append(header, buttons);

  // Who has answered so far, which is the only reason to keep watching a card you have answered.
  const answered = roll.votes.filter((vote) => !vote.autoPass).length;
  if (answered > 0) {
    const votes = document.createElement("p");
    votes.className = "loot-roll-votes";
    votes.textContent = `Ответили: ${answered}`;
    card.append(votes);
  }
  return card;
}

/**
 * The master looter's list, shown beside the loot window rather than as a dialog of its own.
 *
 * `SMSG_LOOT_MASTER_LIST` arrives once per lootable corpse and names everyone eligible; the slots
 * it applies to are the ones the loot window marks `LOOT_SLOT_MASTER`, which until now rendered as
 * a disabled button saying the item could not be taken.
 */
function masterCard(): HTMLElement | undefined {
  const world = game.world;
  const loot = world?.loot;
  if (!world || !loot || world.masterLootCandidates.length === 0) return undefined;
  const assignable = loot.slots.filter((slot) => !slot.taken && slot.slotType === LOOT_SLOT_MASTER);
  if (assignable.length === 0) return undefined;

  const card = document.createElement("div");
  card.className = "loot-roll loot-master";
  const title = document.createElement("strong");
  title.textContent = "Раздать добычу";
  card.append(title);

  for (const item of assignable) {
    const row = document.createElement("div");
    row.className = "loot-master-row";
    const name = document.createElement("span");
    name.textContent = item.count > 1 ? `${itemName(item.itemId)} ×${item.count}` : itemName(item.itemId);
    attachTooltip(name, () => itemTooltipFor(item.itemId, {
      count: item.count,
      footer: ["Выберите, кому отдать"],
    }));
    row.append(name);
    const picker = document.createElement("select");
    for (const candidate of masterLootRows(world.masterLootCandidates, (guid) => world.displayName(guid))) {
      const option = document.createElement("option");
      option.value = candidate.guid.toString();
      option.textContent = candidate.name;
      picker.append(option);
    }
    const give = document.createElement("button");
    give.type = "button";
    give.textContent = "Отдать";
    give.addEventListener("click", () => {
      const target = BigInt(picker.value || "0");
      if (target !== 0n) world.giveMasterLoot(item.index, target);
    });
    row.append(picker, give);
    card.append(row);
  }
  return card;
}

/**
 * Draws every dialog the model says is live.
 *
 * Called from the bus on every roll packet and once a second by the frame loop, because a
 * countdown that only moves when a packet arrives stops at whatever it said last.
 */
export function showLootRolls(): void {
  const box = root();
  const world = game.world;
  if (!box) return;
  // A published stock loot owner shows the rolls as GroupLootFrame1-4 and the master looter's
  // list as GroupLootDropDown (FrameXmlLootController); these cards step aside meanwhile, so Escape
  // no longer finds them open either (`lootRollsOpen`).
  if (frameXmlLootPublished()) {
    box.replaceChildren();
    box.hidden = true;
    ticking = false;
    return;
  }
  if (!world) {
    box.replaceChildren();
    return;
  }
  // A roll whose own vote came back (SMSG_LOOT_ROLL reaches the voter too, Group.cpp SendLootRoll)
  // is answered, wherever it was answered: here the click also dismisses it, but a vote cast on a
  // stock GroupLootFrame reaches this list only when the stock owner hands rolls back (teardown,
  // ReloadUI), and a second answer would be ignored by the server (Group.cpp:1687).
  const self = world.state?.selfGuid;
  const rolls = activeRolls(world.lootRolls, Date.now()).filter((roll) => !dismissed.has(roll.itemGuid)
    && (self === undefined || !roll.votes.some((vote) => vote.playerGuid === self)));
  const master = masterCard();
  box.replaceChildren(...rolls.map(rollCard), ...(master ? [master] : []));
  box.hidden = box.childElementCount === 0;
  ticking = rolls.length > 0;
}

/** Once a second is enough for a countdown measured in seconds. */
let lastTick = 0;
export function updateLootRolls(now: number): void {
  if (!ticking || now - lastTick < 1000) return;
  lastTick = now;
  showLootRolls();
}

/** A fresh roll in a slot the player dismissed earlier is a different roll. */
export function noticeLootRoll(newItemGuid: bigint | undefined): void {
  if (newItemGuid !== undefined) dismissed.delete(newItemGuid);
  showLootRolls();
}
