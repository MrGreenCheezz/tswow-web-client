import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { isLootSlotTakeable, lootErrorText } from "../../world/LootProtocol.js";
import { TRAINER_SPELL_AVAILABLE, trainerSpellStateText } from "../../world/TrainerProtocol.js";
import { WorldClient } from "../../world/WorldClient.js";
import { isWorldObjectDead } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { gameObjectAction } from "../game/Interaction.js";
import { attachTooltip, confirmPanel } from "./Widgets.js";

import {
  buybackItems, buybackTitle, deathReclaim, deathRelease, deathSpirit, deathStatus, deathWindow,
  element, gossipOptions, gossipQuests, gossipText,
  gossipTitle, gossipWindow, lootError, lootItems, lootMoney, lootWindow, merchantMessage, playerHudName,
  questActions, questBody, questObjectives, questRequired, questRewards, questStatus, questTitle,
  questWindow, resurrectRequest, resurrectText, targetName, trainerGreeting, trainerMessage,
  trainerSpells, trainerWindow, vendorItems, vendorWindow,
} from "./Dom.js";
import { playerInventory } from "../Inventory.js";
import { setIconSource } from "./IconImage.js";
import { formatNpcText as formatText, type NpcTextSubject } from "./NpcText.js";
import { playUiSound } from "../game/GameSounds.js";
import { className, raceName } from "./UnitSnapshot.js";
import { unit } from "../../world/Fields.js";

/** Everything an NPC or a corpse opens: gossip, quests, vendors, trainers, loot, death. */

export function lootCurrentTarget(): void {
  const world = game.world;
  if (world?.targetGuid !== undefined) world.openLoot(world.targetGuid);
}

/**
 * The one thing right-clicking a unit does, whatever the unit turns out to be.
 *
 * The original client has a single interact verb and works out the rest from what is under the
 * cursor; this had three buttons and a key each, and no way to reach any of them without the
 * mouse. A door is used, a chest is unlocked by casting at it, a corpse is looted, and anything
 * that talks is talked to — and which of those it is, is decided here rather than by the player.
 */
export function interactWithTarget(): void {
  const world = game.world;
  if (!world || world.targetGuid === undefined) return;
  const target = world.state.objects.get(world.targetGuid);
  if (!target) return;

  if (target.typeId === 5) {
    // Nothing comes back either way, so the click is the whole interaction: the door swings, or
    // it does not because the server refused the packet.
    const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    const action = self?.position ? gameObjectAction(world, target, self.position) : undefined;
    if (action?.kind === "unlock") world.openLock(world.targetGuid, action.spell);
    else if (action) world.useGameObject(world.targetGuid);
    return;
  }

  // A corpse only. A game object's loot is never requested — the server refuses the packet for
  // anything that is not a creature, and a chest's loot arrives once a spell has opened it.
  if (target.typeId === 3 && isWorldObjectDead(target)) {
    world.openLoot(world.targetGuid);
    return;
  }

  gossipWindow.hidden = false;
  gossipTitle.textContent = targetName.textContent || "Разговор";
  gossipText.textContent = "Ожидание ответа NPC…";
  gossipOptions.replaceChildren();
  gossipQuests.replaceChildren();
  const npcFlags = target.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0;
  // UNIT_NPC_FLAG_GOSSIP is 0x01 and UNIT_NPC_FLAG_QUESTGIVER is 0x02. A creature with neither
  // has nothing to say, and asking anyway is a packet the server drops.
  if ((npcFlags & 0x01) !== 0) world.openGossip(world.targetGuid);
  else if ((npcFlags & 0x02) !== 0) world.openQuestList(world.targetGuid);
  else gossipWindow.hidden = true;
}

/**
 * The window whose opening was already announced.
 *
 * Identity rather than the corpse's guid: `WorldClient` builds a fresh `LootWindow` for every
 * `SMSG_LOOT_RESPONSE` (`:3842`) and mutates that same object when a slot is taken (`:3848`), so
 * the object *is* «this opening», and reopening the same corpse gives a different one. Reopening
 * is why the guid would not do.
 */
let chimedFor: object | undefined;

export function showLoot(): void {
  const world = game.world;
  const loot = world?.loot;
  if (!world || !loot) {
    lootWindow.hidden = true;
    // Not a guard — a fresh `LootWindow` never equals the last one anyway — but a closed window
    // has no reason to be held here until the next corpse.
    chimedFor = undefined;
    return;
  }
  lootWindow.hidden = false;
  lootError.hidden = loot.error === undefined;
  if (loot.error !== undefined) lootError.textContent = lootErrorText(loot.error);
  // The chest, the bag, the corpse: the one window the player opens most — but only when something
  // actually opened, and only once. This used to be the first line of the function, and the
  // function is called from three places that have nothing to do with looting: `EnterWorld.ts:635`
  // and `Login.ts:274,365` paint the empty window on the way into the world and on the way out, so
  // the player heard the loot chime for entering the game. A refused search (`LootError`) is the
  // second half: the server says «здесь нечего обыскивать» and the client answered with the sound
  // of a full bag. The third is a repaint — taking a slot already called this again, and slice Л2
  // added a fourth caller, the item query landing while the corpse is still open.
  else if (loot !== chimedFor) {
    chimedFor = loot;
    playUiSound("loot");
  }

  lootMoney.hidden = loot.gold <= 0;
  lootMoney.textContent = `Забрать деньги: ${formatMoney(loot.gold)}`;

  lootItems.replaceChildren(
    ...loot.slots.map((slot) => {
      const button = document.createElement("button");
      button.type = "button";
      // The loot window needs nothing from the gateway. One `itemTemplate` call per slot both
      // orders the row and returns it, and the icon is already in the loot packet — `displayId`
      // rides beside the entry (`LootProtocol.ts:30`), so `/item-icon/<displayId>` answers without
      // the dump's `iconId`, which 22,489 of its 38,609 rows have as zero anyway.
      const template = world.itemTemplate(slot.itemId);
      const metadata = game.itemMetadata?.get(slot.itemId);
      const quality = template?.quality ?? metadata?.quality ?? 0;
      button.className = `loot-slot quality-${quality}`;
      const name = template?.name || metadata?.name || unknownLabel("предмет", slot.itemId);
      if (slot.displayId > 0 && game.itemMetadata) {
        const image = document.createElement("img");
        image.alt = "";
        image.className = "loot-slot-icon";
        setIconSource(image, game.itemMetadata.displayIconUrl(slot.displayId));
        image.addEventListener("error", () => image.remove(), { once: true });
        button.append(image);
      }
      const caption = document.createElement("span");
      caption.textContent = slot.count > 1 ? `${name} ×${slot.count}` : name;
      const takeable = isLootSlotTakeable(slot);
      if (slot.taken) caption.textContent = `${caption.textContent} — забрано`;
      button.append(caption);
      // Marked rather than `disabled`. A disabled button takes no pointer events, so the one
      // sentence saying why the loot cannot be taken never reached the screen.
      if (!takeable) button.setAttribute("aria-disabled", "true");
      attachTooltip(button, () => itemTooltipFor(slot.itemId, {
        count: slot.count,
        footer: [takeable ? "Нажмите, чтобы забрать" : slot.taken ? "Уже забрано" : "Этот предмет сейчас нельзя взять"],
      }));
      button.addEventListener("click", () => {
        if (takeable) world.takeLootSlot(slot.index);
      });
      return button;
    }),
  );
  if (loot.slots.length === 0 && loot.gold <= 0 && loot.error === undefined) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Пусто";
    lootItems.replaceChildren(empty);
  }
}

// Shown whenever the character is dead. The server drives every step: release the spirit,
// ask where the corpse is, run back, reclaim. A resurrect offer can arrive at any point.
export function showDeath(): void {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const dead = self !== undefined && isWorldObjectDead(self);
  const request = world?.resurrectRequest;
  if (!world || (!dead && !request)) {
    deathWindow.hidden = true;
    return;
  }
  deathWindow.hidden = false;

  const remaining = world.corpseReclaimRemaining();
  const corpse = world.corpse;
  deathStatus.textContent = !dead
    ? "Предложено воскрешение."
    : corpse?.found
      ? `Тело на карте ${corpse.mapId}: ${corpse.x.toFixed(1)}, ${corpse.y.toFixed(1)}, ${corpse.z.toFixed(1)}`
      : "Вы мертвы. Освободите дух, чтобы возродиться на кладбище.";
  deathRelease.hidden = !dead || corpse?.found === true;
  deathReclaim.hidden = !dead || corpse?.found !== true;
  deathReclaim.disabled = remaining > 0;
  deathReclaim.textContent = remaining > 0
    ? `Забрать тело (${Math.ceil(remaining / 1000)} с)`
    : "Забрать тело";

  // A spirit healer resurrects on the spot for durability and fifteen minutes of sickness. It is
  // reached by targeting the healer, which is the only thing that names the guid the opcode wants.
  const healer = world.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid);
  const isHealer = healer !== undefined && ((healer.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0) & 0x4000) !== 0;
  deathSpirit.hidden = !dead || !isHealer;

  resurrectRequest.hidden = !request;
  if (request) {
    resurrectText.textContent = request.sickness
      ? `${request.casterName} предлагает воскрешение. Будет наложена слабость.`
      : `${request.casterName} предлагает воскрешение.`;
  }
}

export function showMerchantMessage(target: HTMLElement): void {
  const message = game.world?.merchantMessage;
  target.className = message ? (message.error ? "error" : "success") : "muted";
  target.textContent = message?.text ?? "";
}

export function showVendor(): void {
  const world = game.world;
  const vendor = world?.vendor;
  if (!world || !vendor) {
    vendorWindow.hidden = true;
    return;
  }
  vendorWindow.hidden = false;
  showMerchantMessage(merchantMessage);
  vendorItems.replaceChildren(
    ...vendor.items.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      // The same two sources as the loot window, and for the same reason: the shelf never asked
      // the gateway for anything, so «Предмет 4306» was the whole of what a vendor sold.
      const template = world.itemTemplate(item.itemId);
      const metadata = game.itemMetadata?.get(item.itemId);
      button.className = `vendor-item quality-${template?.quality ?? metadata?.quality ?? 0}`;
      const name = template?.name || metadata?.name || unknownLabel("предмет", item.itemId);
      const stock = item.leftInStock < 0 ? "" : ` · осталось ${item.leftInStock}`;
      const bundle = item.buyCount > 1 ? ` ×${item.buyCount}` : "";
      const cost = item.extendedCost > 0 ? " · особая цена" : ` · ${formatMoney(item.price)}`;
      if (item.displayId > 0 && game.itemMetadata) {
        const image = document.createElement("img");
        image.alt = "";
        image.className = "vendor-item-icon";
        setIconSource(image, game.itemMetadata.displayIconUrl(item.displayId));
        image.addEventListener("error", () => image.remove(), { once: true });
        button.append(image);
      }
      const caption = document.createElement("span");
      caption.textContent = `${name}${bundle}${cost}${stock}`;
      button.append(caption);
      const sellable = item.leftInStock !== 0 && item.extendedCost === 0;
      // Marked rather than `disabled`: the explanation lived on a control that cannot be hovered,
      // and «особая цена» on its own says nothing about what the price is.
      if (!sellable) button.setAttribute("aria-disabled", "true");
      attachTooltip(button, () => itemTooltipFor(item.itemId, {
        count: item.buyCount,
        footer: [sellable
          ? `Нажмите, чтобы купить за ${formatMoney(item.price)}`
          : item.extendedCost > 0
            ? "Требуется валюта или предметы, обмен пока не поддержан"
            : "Товар кончился"],
      }));
      button.addEventListener("click", () => {
        if (sellable) world.buyFromVendor(item.slot, 1);
      });
      return button;
    }),
  );
  if (vendor.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Торговцу нечего предложить";
    vendorItems.replaceChildren(empty);
  }
  showBuyback(world);
}

/**
 * The buyback shelf: the last twelve things sold, and what taking one back costs.
 *
 * None of it is a vendor packet. The shelf is slots 74 to 85 of the *player's* own inventory and
 * the prices are `PLAYER_FIELD_BUYBACK_PRICE_1`, both of them private update fields that have
 * always been arriving. The one trap is the slot number: `CMSG_BUYBACK_ITEM` wants the absolute
 * slot, 74 upwards, because the handler subtracts `BUYBACK_SLOT_START` from it to find the price —
 * sending a zero-based index buys back the wrong item, or nothing.
 */
function showBuyback(world: WorldClient): void {
  const inventory = playerInventory(world.state);
  const shelf = (inventory?.buyback ?? []).filter((slot) => slot.item !== undefined);
  buybackTitle.hidden = shelf.length === 0;
  buybackItems.replaceChildren(...shelf.map((slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vendor-item";
    const entry = slot.item?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
    const count = slot.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset) ?? 1;
    const name = world.itemTemplate(entry)?.name || game.itemMetadata?.get(entry)?.name || unknownLabel("предмет", entry);
    button.textContent = `${name}${count > 1 ? ` ×${count}` : ""} · ${formatMoney(slot.price)}`;
    attachTooltip(button, () => itemTooltipFor(entry, {
      count,
      durability: slot.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset),
      footer: [`Нажмите, чтобы выкупить за ${formatMoney(slot.price)}`],
    }));
    button.addEventListener("click", () => world.buybackFromVendor(slot.slot));
    return button;
  }));
}

export function showTrainer(): void {
  const world = game.world;
  const trainer = world?.trainer;
  if (!world || !trainer) {
    trainerWindow.hidden = true;
    return;
  }
  trainerWindow.hidden = false;
  trainerGreeting.textContent = trainer.greeting;
  showMerchantMessage(trainerMessage);
  trainerSpells.replaceChildren(
    ...trainer.spells.map((spell) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trainer-spell";
      const metadata = game.spells.get(spell.spellId);
      const name = metadata?.name ?? `Заклинание ${spell.spellId}`;
      const state = trainerSpellStateText(spell.usable);
      const level = spell.requiredLevel > 0 ? ` · ур. ${spell.requiredLevel}` : "";
      button.textContent = `${name} · ${formatMoney(spell.moneyCost)}${level}${state ? " · " + state : ""}`;
      button.disabled = spell.usable !== TRAINER_SPELL_AVAILABLE;
      button.addEventListener("click", () => world.learnFromTrainer(spell.spellId));
      return button;
    }),
  );
  if (trainer.spells.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Этот тренер вас ничему не научит";
    trainerSpells.replaceChildren(empty);
  }
}

export function showGossip(): void {
  const world = game.world;
  const gossip = world?.gossip;
  if (!world || !gossip) {
    gossipWindow.hidden = true;
    return;
  }
  const creature = world.state.objects.get(gossip.guid);
  const entry = creature?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  gossipTitle.textContent = game.creatureMetadata?.get(entry)?.name ?? `NPC ${entry}`;
  const npcText = world.npcTexts.get(gossip.textId)?.options
    .filter((option) => option.probability > 0 && (option.male || option.female))
    .sort((left, right) => right.probability - left.probability)[0];
  gossipText.textContent = formatNpcText(npcText?.male || npcText?.female || `Текст NPC #${gossip.textId}`);
  gossipOptions.replaceChildren(...gossip.options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gossip-option";
    // A gossip option is written for a reader just as the body above it is: 6 of them in the
    // base dump carry a `$b` and the class and race markers turn up here too.
    button.textContent = `◆ ${formatNpcText(option.text)}`;
    button.title = [option.boxText, option.money > 0 ? `Стоимость: ${formatMoney(option.money)}` : ""].filter(Boolean).join("\n");
    const choose = (): void => {
      const code = option.coded ? window.prompt(option.boxText || "Введите ответ:") : undefined;
      if (option.coded && code === null) return;
      world.selectGossipOption(option.id, code ?? undefined);
    };
    button.addEventListener("click", () => {
      // The price is in the packet and used to be shown only in a `title`, which nobody hovers.
      if (option.money > 0) {
        confirmPanel(button, {
          title: option.boxText || "Подтвердите оплату",
          lines: [`Будет списано: ${formatMoney(option.money)}`],
          confirm: "Заплатить",
          onConfirm: choose,
        });
        return;
      }
      choose();
    });
    return button;
  }));
  gossipQuests.replaceChildren(...gossip.quests.map((quest) => questMenuButton(world, gossip.guid, quest)));
  gossipWindow.hidden = false;
}

export function showQuestState(): void {
  const world = game.world;
  if (!world) {
    questWindow.hidden = true;
    return;
  }
  if (world.questList) {
    gossipTitle.textContent = targetName.textContent || "Задания";
    gossipText.textContent = formatNpcText(world.questList.greeting);
    gossipOptions.replaceChildren();
    gossipQuests.replaceChildren(...world.questList.quests.map((quest) => questMenuButton(world, world.questList!.guid, quest)));
    gossipWindow.hidden = false;
    questWindow.hidden = true;
    return;
  }
  const dialog = world.questDialog;
  const message = world.questMessage;
  if (!dialog && !message) {
    questWindow.hidden = true;
    return;
  }
  gossipWindow.hidden = true;
  questWindow.hidden = false;
  questRequired.replaceChildren();
  questRewards.replaceChildren();
  questActions.replaceChildren();
  questStatus.className = message?.error ? "error" : "success";
  questStatus.textContent = message?.text ?? "";
  if (!dialog) {
    questTitle.textContent = "Задание";
    questBody.textContent = message?.text ?? "";
    questObjectives.textContent = "";
    questActions.append(questActionButton("Закрыть", () => world.closeQuest()));
    return;
  }

  questTitle.textContent = formatNpcText(dialog.title);
  questBody.textContent = formatNpcText(dialog.kind === "details" ? dialog.details : dialog.text);
  questObjectives.textContent = dialog.kind === "details" ? formatNpcText(dialog.objectives) : "";
  const required = dialog.kind === "request-items" ? dialog.items : [];
  const rewards = dialog.kind === "request-items" ? undefined : dialog.rewards;
  questRequired.replaceChildren(...required.map((item) => questItem(item)));
  if (dialog.kind === "request-items" && dialog.requiredMoney > 0) {
    const money = document.createElement("p");
    money.textContent = `Требуется денег: ${formatMoney(dialog.requiredMoney)}`;
    questRequired.append(money);
  }
  if (rewards) {
    questRewards.replaceChildren(
      ...rewards.items.map((item) => questItem(item)),
      ...rewards.choices.map((item, index) => questItem(item, dialog.kind === "reward" ? () => world.chooseQuestReward(index) : undefined)),
    );
    const summary = [rewards.money > 0 ? formatMoney(rewards.money) : "", rewards.honor > 0 ? `${rewards.honor} чести` : "", rewards.talents > 0 ? `${rewards.talents} талант` : ""].filter(Boolean).join(" · ");
    if (summary) {
      const line = document.createElement("p");
      line.textContent = summary;
      questRewards.append(line);
    }
  }
  const itemIds = [...required, ...(rewards?.items ?? []), ...(rewards?.choices ?? [])].map((item) => item.id);
  void loadQuestItemMetadata(itemIds, world);

  if (dialog.kind === "details") questActions.append(
    questActionButton("Принять", () => world.acceptQuest()),
    questActionButton("Отказаться", () => world.closeQuest()),
  );
  else if (dialog.kind === "request-items") questActions.append(
    questActionButton(dialog.canComplete ? "Продолжить" : "Ещё не выполнено", () => world.requestQuestReward(), !dialog.canComplete),
    questActionButton("Закрыть", () => world.closeQuest()),
  );
  else if (dialog.rewards.choices.length === 0) questActions.append(
    questActionButton("Завершить", () => world.chooseQuestReward(0)),
    questActionButton("Закрыть", () => world.closeQuest()),
  );
  else questActions.append(questActionButton("Выберите награду выше", () => {}, true), questActionButton("Закрыть", () => world.closeQuest()));
}

export function questMenuButton(world: WorldClient, guid: bigint, quest: { id: number; icon: number; level: number; title: string }): HTMLButtonElement {
  const completion = [5, 6, 9, 10].includes(quest.icon);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gossip-quest";
  button.textContent = `${completion ? "?" : "!"} [${quest.level}] ${quest.title}`;
  button.addEventListener("click", () => world.openQuest(guid, quest.id, completion));
  return button;
}

export function questItem(item: { id: number; count: number; displayId: number }, select?: () => void): HTMLElement {
  const element = document.createElement(select ? "button" : "div");
  const template = game.world?.itemTemplate(item.id);
  const metadata = game.itemMetadata?.get(item.id);
  element.className = `quest-item quality-${template?.quality ?? metadata?.quality ?? 0}`;
  // A reward is the one item the player has to choose between without owning either, so the whole
  // tooltip matters here more than anywhere. It also had the last English label in the interface.
  const name = template?.name || metadata?.name || unknownLabel("предмет", item.id);
  attachTooltip(element, () => itemTooltipFor(item.id, {
    count: item.count,
    footer: select ? ["Нажмите, чтобы выбрать награду"] : [],
  }));
  if (select) {
    (element as HTMLButtonElement).type = "button";
    element.addEventListener("click", select);
  }
  const image = document.createElement("img");
  image.alt = "";
  setIconSource(image, game.itemMetadata?.displayIconUrl(item.displayId) ?? "");
  image.addEventListener("error", () => image.remove(), { once: true });
  const label = document.createElement("span");
  label.textContent = `${name} ×${item.count}`;
  element.append(image, label);
  return element;
}

export function questActionButton(text: string, action: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

export async function loadQuestItemMetadata(ids: number[], world: WorldClient): Promise<void> {
  const client = game.itemMetadata;
  if (!client || ids.length === 0) return;
  try {
    if (await client.load(ids) && game.world === world) showQuestState();
  } catch (error) {
    questStatus.className = "error";
    questStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

/**
 * The reader a `$`-marker is about: this character, as the packets describe them.
 *
 * Read at the moment the text is drawn rather than kept, because a gossip window can outlive a
 * form change — a druid in bear shape is a different `UNIT_FIELD_BYTES_0` — and because the name
 * query that fills the declensions lands whenever it lands.
 */
function selfSubject(): NpcTextSubject {
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state.objects.get(selfGuid);
  return {
    name: world?.selfName || playerHudName.textContent || "герой",
    className: self ? className(unit.classId(self)) : "",
    raceName: self ? raceName(unit.race(self)) : "",
    gender: (self ? unit.gender(self) : 0) ?? 0,
    declined: selfGuid === undefined ? undefined : world?.names.declined(selfGuid),
  };
}

export function formatNpcText(text: string): string {
  return formatText(text, selfSubject());
}
