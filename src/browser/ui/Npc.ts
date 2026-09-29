import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { isLootSlotTakeable, lootErrorText } from "../../world/LootProtocol.js";
import { TRAINER_SPELL_AVAILABLE, trainerSpellStateText } from "../../world/TrainerProtocol.js";
import { WorldClient } from "../../world/WorldClient.js";
import { fieldFloat, isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { isPlayerGhost } from "../../world/Fields.js";
import { NPC_FLAGS_VENDOR_MASK, type QuestOfferReward } from "../../world/NpcProtocol.js";
import { BATTLEGROUND_AA, type BattlefieldList } from "../../world/PvpProtocol.js";
import type { TaxiMenu } from "../../world/TaxiProtocol.js";
import {
  reachableTaxiRoutes, TaxiMetadataClient, type TaxiCatalog,
} from "../TaxiMetadata.js";
import { game } from "../game/Context.js";
import { gameObjectAction, gameObjectLockHint } from "../game/Interaction.js";
import { notice } from "./Notices.js";
import { BattlegroundClient, type BattlegroundCatalog } from "../BattlegroundMetadata.js";
import { attachTooltip, confirmPanel } from "./Widgets.js";

import {
  buybackItems, buybackTitle, deathReclaim, deathRelease, deathSpirit, deathStatus, deathWindow,
  element, gossipOptions, gossipQuests, gossipText,
  gossipTitle, gossipWindow, lootAll, lootError, lootItems, lootMoney, lootWindow, merchantMessage, playerHudName,
  questActions, questBody, questObjectives, questRequired, questRewards, questStatus, questTitle,
  questWindow, resurrectRequest, resurrectText, targetName, trainerGreeting, trainerMessage,
  trainerSpells, trainerWindow, vendorItems, vendorWindow,
} from "./Dom.js";
import { settingOn } from "./Settings.js";
import { playerInventory } from "../Inventory.js";
import { setIconSource } from "./IconImage.js";
import { formatNpcText as formatText, type NpcTextSubject } from "./NpcText.js";
import { playUiSound } from "../game/GameSounds.js";
import { className, raceName } from "./UnitSnapshot.js";
import { unit } from "../../world/Fields.js";
// The stock GossipFrame/TaxiFrame owners (NPC lane): while published, the native window steps aside.
import { closeFrameXmlGossip, frameXmlGossipPublished, notifyFrameXmlGossip } from "../framexml/FrameXmlGossipController.js";
import { frameXmlTaxiPublished, notifyFrameXmlTaxi } from "../framexml/FrameXmlTaxiController.js";
import { frameXmlCharterPublished, notifyFrameXmlCharters } from "../framexml/FrameXmlPetitionController.js";
import { notifyFrameXmlStable } from "../framexml/FrameXmlStableController.js";
import { frameXmlLootPublished } from "../framexml/FrameXmlLootController.js";
import { frameXmlPopupsPublished } from "../framexml/FrameXmlPopupsController.js";

/** Everything an NPC or a corpse opens: gossip, quests, vendors, trainers, loot, death. */

const NPC_FLAG_GOSSIP = 0x01;
const NPC_FLAG_QUESTGIVER = 0x02;
const NPC_FLAG_TRAINER = 0x70;
const NPC_FLAG_FLIGHTMASTER = 0x2000;
const NPC_FLAG_BANKER = 0x20000;
const NPC_FLAG_PETITIONER = 0x40000;
const NPC_FLAG_TABARD_DESIGNER = 0x80000;
const NPC_FLAG_BATTLEMASTER = 0x100000;
const NPC_FLAG_AUCTIONEER = 0x200000;
const NPC_FLAG_STABLEMASTER = 0x400000;
const NPC_FLAG_MAILBOX = 0x04000000;

interface PendingGameObjectInteraction {
  world: WorldClient;
  entry: number;
  /** The concrete spawn generation: a recycled guid must not inherit an older click. */
  object: WorldObjectState;
}

/** A quick double-click before one template response still means one server interaction. */
const pendingGameObjectInteractions = new Map<bigint, PendingGameObjectInteraction>();

/** A choice is local UI state until the player explicitly completes the quest. */
let selectedQuestReward: { world: WorldClient; dialog: QuestOfferReward; choice: number | undefined } | undefined;

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
  interactWithGuid(world.targetGuid);
}

/**
 * Interacts with the object under the pointer, whether or not it can legally be a unit target.
 * Game objects never go through `CMSG_SET_SELECTION`; the picked guid belongs directly to the
 * object opcode. Units are selected by the input layer first, so the ordinary target frame still
 * follows a right click on a creature.
 */
export function interactWithGuid(guid: bigint): void {
  const world = game.world;
  if (!world) return;
  const target = world.state.objects.get(guid);
  if (!target) return;

  if (target.typeId === 5) {
    const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    const entry = target.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
    const pending = pendingGameObjectInteractions.get(guid);
    if (pending?.world === world && pending.entry === entry && pending.object === target) return;
    if (pending) pendingGameObjectInteractions.delete(guid);

    const action = self?.position ? gameObjectAction(world, target, self.position) : undefined;
    if (action) {
      performGameObjectAction(world, guid, action);
      return;
    }

    // `gameObjectAction` starts CMSG_GAMEOBJECT_QUERY only after the live object has passed its
    // type, selectable and range gates. If that query is still unknown, retain this click once and
    // repeat every gate after the answer; a miss, close, despawn or timeout resolves harmlessly.
    if (!self?.position || entry <= 0 || world.gameObjectTemplates.has(entry)) {
      // The template is in hand and still nothing is offered: a lock without a known opener, most
      // often a vein or a herb. Say which skill is missing instead of eating the click.
      if (self?.position && entry > 0 && world.gameObjectTemplates.has(entry)) {
        const hint = gameObjectLockHint(world, target, self.position);
        if (hint) notice(hint);
      }
      return;
    }
    const intent = { world, entry, object: target };
    pendingGameObjectInteractions.set(guid, intent);
    void world.waitForGameObjectTemplate(entry, guid).then((template) => {
      if (pendingGameObjectInteractions.get(guid) !== intent) return;
      pendingGameObjectInteractions.delete(guid);
      if (!template || game.world !== world) return;

      const current = world.state.objects.get(guid);
      const currentEntry = current?.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      if (current !== intent.object || current.typeId !== 5 || currentEntry !== entry) return;
      const currentSelf = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
      const deferredAction = currentSelf?.position ? gameObjectAction(world, current, currentSelf.position) : undefined;
      if (deferredAction) performGameObjectAction(world, guid, deferredAction);
      else if (currentSelf?.position) {
        const hint = gameObjectLockHint(world, current, currentSelf.position);
        if (hint) notice(hint);
      }
    });
    return;
  }

  // A corpse only. A game object's loot is never requested — the server refuses the packet for
  // anything that is not a creature, and a chest's loot arrives once a spell has opened it.
  if (target.typeId === 3 && isWorldObjectDead(target)) {
    world.openLoot(guid);
    return;
  }

  if (target.typeId !== 3) return;

  // The shared NPC lane belongs to the newly clicked creature from this point on. Closing its
  // previous service first also makes a delayed response from that older NPC stale.
  closeNpcServiceWindow();
  const npcFlags = target.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0;
  // Gossip remains first: when it exists, the server-authored menu is the authority that decides
  // which of several services this creature offers. Some neutral service NPCs have no gossip bit,
  // though, and used to be silent despite advertising their vendor/trainer/banker flag on the wire.
  if ((npcFlags & NPC_FLAG_GOSSIP) !== 0) {
    showPendingNpcDialog();
    world.openGossip(guid);
  } else if ((npcFlags & NPC_FLAG_QUESTGIVER) !== 0) {
    showPendingNpcDialog();
    world.openQuestList(guid);
  } else if ((npcFlags & NPC_FLAGS_VENDOR_MASK) !== 0) world.openVendor(guid);
  else if ((npcFlags & NPC_FLAG_TRAINER) !== 0) world.openTrainer(guid);
  else if ((npcFlags & NPC_FLAG_BANKER) !== 0) world.openBank(guid);
  else if ((npcFlags & NPC_FLAG_PETITIONER) !== 0) {
    showPendingNpcDialog("Хартии");
    world.requestPetitionVendor(guid);
  }
  else if ((npcFlags & NPC_FLAG_FLIGHTMASTER) !== 0) {
    showPendingNpcDialog("Распорядитель полётов");
    world.requestTaxiMenu(guid);
  }
  else if ((npcFlags & NPC_FLAG_AUCTIONEER) !== 0) world.openAuctionHouse(guid);
  else if ((npcFlags & NPC_FLAG_BATTLEMASTER) !== 0) {
    showPendingNpcDialog("Мастер поля боя");
    world.battlemasterHello(guid);
  } else if ((npcFlags & NPC_FLAG_TABARD_DESIGNER) !== 0) {
    showPendingNpcDialog("Дизайнер гербов");
    world.openTabardVendor(guid);
  }
  else if ((npcFlags & NPC_FLAG_STABLEMASTER) !== 0) world.requestStable(guid);
  else if ((npcFlags & NPC_FLAG_MAILBOX) !== 0) world.openMailbox(guid);
}

function performGameObjectAction(
  world: WorldClient,
  guid: bigint,
  action: NonNullable<ReturnType<typeof gameObjectAction>>,
): void {
  if (action.kind === "mail") world.openMailbox(guid);
  else if (action.kind === "guild-bank") world.openGuildBank(guid);
  else if (action.kind === "unlock") world.openLock(guid, action.spell);
  else world.useGameObject(guid);
}

function showPendingNpcDialog(title?: string): void {
  // Stock GossipFrame and TaxiFrame open on their own events, as the client does: no native
  // «waiting» placeholder beside them while they are published.
  if (title === undefined ? frameXmlGossipPublished()
    : title === "Распорядитель полётов" && frameXmlTaxiPublished()) return;
  // The same for TabardFrame and the charter vendors (FrameXmlPetitionController).
  if ((title === "Дизайнер гербов" && frameXmlCharterPublished("tabard"))
    || (title === "Хартии" && frameXmlCharterPublished("registrar"))) return;
  gossipWindow.hidden = false;
  gossipTitle.textContent = title || targetName.textContent || "Разговор";
  gossipText.className = "gossip-text";
  gossipText.textContent = "Ожидание ответа NPC…";
  gossipOptions.replaceChildren();
  gossipQuests.replaceChildren();
}

function serviceButton(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gossip-option";
  button.textContent = label;
  button.addEventListener("click", run);
  return button;
}

function showServiceDialog(title: string, text: string, controls: readonly Node[]): void {
  gossipTitle.textContent = title;
  gossipText.className = "gossip-text";
  gossipText.textContent = text;
  gossipOptions.replaceChildren(...controls);
  gossipQuests.replaceChildren();
  gossipWindow.hidden = false;
}

let taxiClient: TaxiMetadataClient | undefined;
let taxiClientOrigin = "";
let visibleTaxiMenu: TaxiMenu | undefined;

function nativeTaxiClient(): TaxiMetadataClient | undefined {
  const origin = game.gatewayOrigin;
  if (!origin) return undefined;
  if (!taxiClient || taxiClientOrigin !== origin) {
    taxiClient = new TaxiMetadataClient(origin);
    taxiClientOrigin = origin;
  }
  return taxiClient;
}

function drawTaxiMenu(world: WorldClient, menu: TaxiMenu, catalog: TaxiCatalog): void {
  if (game.world !== world || world.taxiMenu !== menu) return;
  visibleTaxiMenu = menu;
  const routes = reachableTaxiRoutes(catalog, menu.currentNode, menu.knownNodes);
  const controls: Node[] = routes.map((route) => serviceButton(
    `${route.destination.name}${route.cost > 0 ? ` · ${formatMoney(route.cost)}` : ""}`,
    () => {
      if (game.world !== world || world.taxiMenu !== menu || visibleTaxiMenu !== menu) return;
      gossipText.className = "gossip-text";
      gossipText.textContent = `Запрашиваем полёт: ${route.destination.name}…`;
      for (const control of gossipOptions.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
      world.takeTaxi(menu.guid, route.nodes);
    },
  ));
  if (controls.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Отсюда пока нет открытых достижимых маршрутов.";
    controls.push(empty);
  }
  showServiceDialog(
    "Распорядитель полётов",
    world.taxiMessage?.text ?? "Выберите открытое направление.",
    controls,
  );
  gossipText.className = world.taxiMessage?.error ? "gossip-text error" : "gossip-text";
}

/** Opens only authored, reachable TaxiPath routes and sends every hop selected by the planner. */
export function showTaxiMenu(): void {
  const world = game.world;
  const menu = world?.taxiMenu;
  // Stock TaxiFrame owns the route while published (it listens to TAXI_MENU/TAXI_CHANGED itself).
  if (frameXmlTaxiPublished()) {
    if (visibleTaxiMenu) gossipWindow.hidden = true;
    visibleTaxiMenu = undefined;
    return;
  }
  if (!world || !menu) {
    if (visibleTaxiMenu) gossipWindow.hidden = true;
    visibleTaxiMenu = undefined;
    return;
  }
  visibleTaxiMenu = menu;
  const client = nativeTaxiClient();
  const catalog = client?.catalog;
  if (catalog) {
    drawTaxiMenu(world, menu, catalog);
    return;
  }
  showServiceDialog("Распорядитель полётов", "Загружаем карту маршрутов…", []);
  if (!client) {
    gossipText.className = "gossip-text error";
    gossipText.textContent = "Карта маршрутов недоступна.";
    return;
  }
  void client.load().then((loaded) => {
    if (game.world !== world || world.taxiMenu !== menu || visibleTaxiMenu !== menu) return;
    if (loaded) drawTaxiMenu(world, menu, loaded);
    else {
      gossipText.className = "gossip-text error";
      gossipText.textContent = "Не удалось загрузить карту маршрутов.";
      gossipOptions.replaceChildren();
    }
  });
}

/** Called by the shared window close button; late taxi packets may no longer reopen it. */
export function closeNpcServiceWindow(): void {
  visibleTaxiMenu = undefined;
  tabardSelection = undefined;
  tabardSelectionGuid = 0n;
  game.world?.closeNpcServices();
  // closeNpcServices forgets the flight map without an event; the stock TaxiFrame closes with it.
  notifyFrameXmlTaxi();
  // …and the tabard designer; an open stock charter vendor closes for the next NPC's window.
  notifyFrameXmlCharters();
  // …and the stable master (closeNpcServices zeroes it): PetStableFrame closes.
  notifyFrameXmlStable();
  gossipWindow.hidden = true;
}

let battlegroundClient: BattlegroundClient | undefined;
let battlegroundClientOrigin = "";

function nativeBattlegroundClient(): BattlegroundClient | undefined {
  const origin = game.gatewayOrigin;
  if (!origin) return undefined;
  if (!battlegroundClient || battlegroundClientOrigin !== origin) {
    battlegroundClient = new BattlegroundClient(origin);
    battlegroundClientOrigin = origin;
  }
  return battlegroundClient;
}

function drawBattlegroundList(
  world: WorldClient,
  list: BattlefieldList,
  catalog: BattlegroundCatalog | undefined,
): void {
  if (game.world !== world || world.battlefieldList !== list) return;
  if (list.bgTypeId === BATTLEGROUND_AA) {
    const sizes = [2, 3, 5] as const;
    const inGroup = (world.group?.members.length ?? 0) > 0;
    const controls = sizes.map((size, arenaSlot) => serviceButton(`Арена ${size}×${size}`, () => {
      if (game.world !== world || world.battlefieldList !== list) return;
      // Group/rated are server-validated; solo unrated stays the default for a lone player.
      world.joinArena(list.battlemasterGuid, arenaSlot, inGroup, false);
      closeNpcServiceWindow();
      gossipWindow.hidden = true;
    }));
    const hint = inGroup
      ? "Группой, нерейтинговый бой. Рейтинговые бои — через хартии команд."
      : "Соло, нерейтинговый бой. Для группового встаньте в группу.";
    showServiceDialog("Арена", `Выберите размер нерейтингового боя. ${hint}`, controls);
    return;
  }

  const metadata = catalog?.find((row) => row.bgTypeId === list.bgTypeId);
  const name = metadata?.name || `Поле боя ${list.bgTypeId}`;
  const reward = list.winHonor > 0 || list.lossHonor > 0
    ? `Победа: ${list.winHonor} чести${list.lossHonor > 0 ? `, поражение: ${list.lossHonor}` : ""}.`
    : "Сервер подберёт доступный бой вашего уровня.";
  const inGroup = (world.group?.members.length ?? 0) > 0;
  const queueNote = inGroup ? "Встанете в очередь группой." : "Встанете в очередь соло.";
  const controls = [serviceButton(`Первое доступное сражение (${inGroup ? "группа" : "соло"})`, () => {
    if (game.world !== world || world.battlefieldList !== list) return;
    world.joinBattleground(list.battlemasterGuid, list.bgTypeId, 0, inGroup);
    closeNpcServiceWindow();
    gossipWindow.hidden = true;
  })];
  for (const instance of list.instances) {
    controls.push(serviceButton(`Сражение ${instance} (${inGroup ? "группа" : "соло"})`, () => {
      if (game.world !== world || world.battlefieldList !== list) return;
      world.joinBattleground(list.battlemasterGuid, list.bgTypeId, instance, inGroup);
      closeNpcServiceWindow();
      gossipWindow.hidden = true;
    }));
  }
  showServiceDialog(name, `${reward} ${queueNote}`, controls);
}

/** Opens a native battlemaster queue even when the optional FrameXML HUD is disabled. */
export function showBattlegroundList(): void {
  const world = game.world;
  const list = world?.battlefieldList;
  if (!world || !list || list.fromWhere !== 0 || list.battlemasterGuid === 0n) return;
  const client = nativeBattlegroundClient();
  drawBattlegroundList(world, list, client?.catalog);
  if (!client?.ready) void client?.load().then((catalog) => drawBattlegroundList(world, list, catalog));
}

interface TabardSelection {
  style: number;
  color: number;
  borderStyle: number;
  borderColor: number;
  background: number;
}

const TABARD_RANGES = {
  style: 169,
  color: 16,
  borderStyle: 9,
  borderColor: 16,
  background: 50,
} as const;
let tabardSelection: TabardSelection | undefined;
let tabardSelectionGuid = 0n;

function tabardBorderColorMaximum(style: number): number {
  // The stock archive has 17 colours for border styles 0..5 and four for the later 6..9 set.
  return style <= 5 ? TABARD_RANGES.borderColor : 3;
}

function tabardTextureUrl(path: string): string {
  const origin = game.gatewayOrigin;
  if (!origin) return "";
  const url = new URL("/texture", origin);
  url.searchParams.set("path", path);
  return url.href;
}

function tabardPart(path: string, className: string): HTMLImageElement {
  const image = document.createElement("img");
  image.alt = "";
  image.className = className;
  const source = tabardTextureUrl(path);
  if (source) image.src = source;
  else image.hidden = true;
  image.addEventListener("error", () => { image.hidden = true; }, { once: true });
  return image;
}

function tabardPreview(selection: TabardSelection): HTMLDivElement {
  const preview = document.createElement("div");
  preview.className = "tabard-preview";
  const code = (value: number) => String(value).padStart(2, "0");
  preview.append(
    tabardPart(`Textures\\GuildEmblems\\Background_${code(selection.background)}_TU_U.blp`, "tabard-background"),
    tabardPart(`Textures\\GuildEmblems\\Emblem_${code(selection.style)}_${code(selection.color)}_TU_U.blp`, "tabard-emblem"),
    tabardPart(`Textures\\GuildEmblems\\Border_${code(selection.borderStyle)}_${code(selection.borderColor)}_TU_U.blp`, "tabard-border"),
  );
  return preview;
}

function tabardStepper(
  label: string,
  value: number,
  maximum: number,
  update: (value: number) => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "tabard-stepper";
  const caption = document.createElement("span");
  caption.textContent = label;
  const controls = document.createElement("span");
  controls.className = "tabard-stepper-controls";
  const previous = serviceButton("‹", () => update(value <= 0 ? maximum : value - 1));
  previous.ariaLabel = `${label}: предыдущий вариант`;
  const counter = document.createElement("output");
  counter.textContent = `${value + 1} / ${maximum + 1}`;
  const next = serviceButton("›", () => update(value >= maximum ? 0 : value + 1));
  next.ariaLabel = `${label}: следующий вариант`;
  controls.append(previous, counter, next);
  row.append(caption, controls);
  return row;
}

/** Native layered preview backed by the original GuildEmblems textures. */
export function showTabardVendor(): void {
  const world = game.world;
  if (!world || world.tabardVendorGuid === 0n) return;
  // Stock TabardFrame owns the designer while published (OPEN_TABARD_FRAME from its own model).
  if (frameXmlCharterPublished("tabard")) return;
  const guild = world.guildQuery;
  if (!guild) {
    tabardSelection = undefined;
    tabardSelectionGuid = world.tabardVendorGuid;
    showServiceDialog(
      "Дизайнер гербов",
      "Загружаем текущий герб гильдии…",
      [],
    );
    return;
  }
  if (!tabardSelection || tabardSelectionGuid !== world.tabardVendorGuid) {
    tabardSelectionGuid = world.tabardVendorGuid;
    tabardSelection = {
      style: Math.min(TABARD_RANGES.style, guild.emblemStyle),
      color: Math.min(TABARD_RANGES.color, guild.emblemColor),
      borderStyle: Math.min(TABARD_RANGES.borderStyle, guild.borderStyle),
      borderColor: Math.min(tabardBorderColorMaximum(guild.borderStyle), guild.borderColor),
      background: Math.min(TABARD_RANGES.background, guild.backgroundColor),
    };
  }
  const selection = tabardSelection;
  const editor = document.createElement("div");
  editor.className = "tabard-editor";
  const controls = document.createElement("div");
  controls.className = "tabard-controls";
  const redraw = (): void => showTabardVendor();
  controls.append(
    tabardStepper("Рисунок", selection.style, TABARD_RANGES.style, (value) => { selection.style = value; redraw(); }),
    tabardStepper("Цвет рисунка", selection.color, TABARD_RANGES.color, (value) => { selection.color = value; redraw(); }),
    tabardStepper("Кайма", selection.borderStyle, TABARD_RANGES.borderStyle, (value) => {
      selection.borderStyle = value;
      selection.borderColor = Math.min(selection.borderColor, tabardBorderColorMaximum(value));
      redraw();
    }),
    tabardStepper("Цвет каймы", selection.borderColor, tabardBorderColorMaximum(selection.borderStyle), (value) => { selection.borderColor = value; redraw(); }),
    tabardStepper("Цвет фона", selection.background, TABARD_RANGES.background, (value) => { selection.background = value; redraw(); }),
  );
  const save = serviceButton("Сохранить герб · 10 золотых", () => {
    if (game.world !== world || world.tabardVendorGuid !== tabardSelectionGuid || tabardSelection !== selection) return;
    world.saveGuildEmblem(
      selection.style, selection.color, selection.borderStyle, selection.borderColor, selection.background,
    );
    gossipText.className = "gossip-text";
    gossipText.textContent = "Сервер проверяет права и выбранные элементы…";
    save.disabled = true;
  });
  controls.append(save);
  editor.append(tabardPreview(selection), controls);
  showServiceDialog(
    "Дизайнер гербов",
    world.tabardMessage?.text ?? "Настройте герб. Изменение стоит 10 золотых.",
    [editor],
  );
  gossipText.className = world.tabardMessage?.error ? "gossip-text error" : "gossip-text";
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
/**
 * The opening auto-loot already ran for. Identity, like `chimedFor`: `WorldClient` builds a
 * fresh `LootWindow` per `SMSG_LOOT_RESPONSE`, and repaints (`SMSG_LOOT_REMOVED`) must not
 * re-fire the take-all — the taken slots are simply gone from the takeable set.
 */
let autoLootedFor: object | undefined;

export function showLoot(): void {
  const world = game.world;
  const loot = world?.loot;
  // A published stock LootFrame owns every opening (FrameXmlLootController): its model raises
  // LOOT_OPENED…LOOT_CLOSED from this same state and runs auto-loot there. The native window stays
  // shut, and the opening it steps aside for counts as chimed and auto-looted, so handing an open
  // corpse back at the stock owner's teardown neither chimes nor takes everything a second time.
  if (frameXmlLootPublished()) {
    lootWindow.hidden = true;
    chimedFor = loot;
    autoLootedFor = loot;
    return;
  }
  if (!world || !loot) {
    lootWindow.hidden = true;
    // Not a guard — a fresh `LootWindow` never equals the last one anyway — but a closed window
    // has no reason to be held here until the next corpse.
    chimedFor = undefined;
    autoLootedFor = undefined;
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
  // «Забрать всё» is shown whenever there is anything to take with one pass: money or at
  // least one freely takeable slot. Locked / roll-ongoing slots never count.
  const takeableCount = loot.error === undefined
    ? loot.slots.filter((slot) => isLootSlotTakeable(slot)).length : 0;
  lootAll.hidden = loot.error !== undefined || (loot.gold <= 0 && takeableCount === 0);
  lootAll.disabled = loot.error !== undefined || (loot.gold <= 0 && takeableCount === 0);
  // Auto-loot runs once per opening, after the window is painted, and only for real loot —
  // never for a `LootError` refusal. The repaint that follows each taken slot sees the same
  // object and does nothing.
  if (loot.error === undefined && loot !== autoLootedFor) {
    autoLootedFor = loot;
    if (settingOn("autoLoot")) world.takeAllLoot();
  }

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
      button.addEventListener("click", (event) => {
        if (!takeable) return;
        // Shift+click takes the whole window, like the original client's shift-loot habit.
        if (event.shiftKey) world.takeAllLoot();
        else world.takeLootSlot(slot.index);
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
// MiscHandler.cpp::HandleReclaimCorpse uses CORPSE_RECLAIM_RADIUS=39 with the player's combat
// reach added by IsWithinDistInMap. Corpse inherits WorldObject's zero combat reach. An absent
// self reach field gives no local allowance; the server remains authoritative for the actual hit.
const CORPSE_RECLAIM_RADIUS = 39;

function corpseReclaimNearby(world: WorldClient | undefined): boolean {
  const corpse = world?.corpse;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!self?.position || !isPlayerGhost(self) || corpse?.found !== true) return false;
  // For an instance corpse MSG_CORPSE_QUERY may return the entrance coordinates while the body
  // remains on corpseMapId. Being beside that entrance does not satisfy the server's map check.
  if (world?.mapId !== corpse.mapId || world.mapId !== corpse.corpseMapId) return false;
  const encodedReach = fieldFloat(self, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset);
  const selfReach = encodedReach !== undefined && Number.isFinite(encodedReach) && encodedReach >= 0
    ? encodedReach : 0;
  return Math.hypot(
    corpse.x - self.position.x, corpse.y - self.position.y, corpse.z - self.position.z,
  ) <= CORPSE_RECLAIM_RADIUS + selfReach;
}

export function showDeath(): void {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const ghost = self !== undefined && isPlayerGhost(self);
  // A released ghost can have positive health. Its PLAYER_FLAGS_GHOST bit is the server's
  // authority for reclaim; an old corpse query must never enable reclaim on a fresh death.
  const dead = self !== undefined && (isWorldObjectDead(self) || ghost);
  const request = world?.resurrectRequest;
  // Every answer this window gives has a stock dialog while the popup owner is published: DEATH
  // (RepopMe, UseSoulstone), RECOVER_CORPSE (RetrieveCorpse), RESURRECT* (AcceptResurrect) and the
  // spirit healer's XP_LOSS (AcceptXPLoss, after its gossip); the corpse is the minimap's marker.
  if (!world || (!dead && !request) || frameXmlPopupsPublished()) {
    deathWindow.hidden = true;
    return;
  }
  deathWindow.hidden = false;

  const corpse = ghost ? world.corpse : undefined;
  // How far the ghost has to walk, when both ends are on the same map. The minimap carries
  // the same corpse as a red rim dot; the number here says whether that is a stroll or a hike.
  // An instance corpse is reported at its entrance map, so its coordinates are not walkable
  // yards even when that entrance happens to be on the player's map.
  const corpseDistance = corpse?.found && self?.position
    && world.mapId === corpse.mapId && corpse.corpseMapId === corpse.mapId
    ? Math.hypot(corpse.x - self.position.x, corpse.y - self.position.y) : undefined;
  const corpseLine = corpse?.found
    ? `Тело на карте ${corpse.mapId}: ${corpse.x.toFixed(1)}, ${corpse.y.toFixed(1)}, ${corpse.z.toFixed(1)}`
      + (corpseDistance === undefined ? "" : ` · ~${Math.round(corpseDistance)} ярдов`)
      + (corpse.corpseMapId !== corpse.mapId ? ` · тело в подземелье ${corpse.corpseMapId}` : "")
    : ghost
      ? "Местоположение тела пока неизвестно. Можно обратиться к хранителю душ."
      : "Вы мертвы. Освободите дух, чтобы возродиться на кладбище.";
  deathStatus.textContent = !dead ? "Предложено воскрешение." : corpseLine;
  deathRelease.hidden = !dead || ghost;
  deathReclaim.hidden = !ghost || corpse?.found !== true;
  updateDeathReclaimCountdown();

  // A spirit healer resurrects on the spot for durability and fifteen minutes of sickness. It is
  // reached by targeting the healer, which is the only thing that names the guid the opcode wants.
  const healer = world.targetGuid === undefined ? undefined : world.state.objects.get(world.targetGuid);
  const isHealer = healer !== undefined && ((healer.fields.get(UPDATE_FIELDS.UNIT_NPC_FLAGS.offset) ?? 0) & 0x4000) !== 0;
  deathSpirit.hidden = !ghost || !isHealer;

  resurrectRequest.hidden = !request;
  if (request) {
    // The selected core sends an empty caster name for player spells; the GUID is the source
    // of that player's name after CMSG_NAME_QUERY resolves.
    const casterName = request.casterName || world.displayName(request.casterGuid);
    resurrectText.textContent = request.sickness
      ? `${casterName} предлагает воскрешение. Будет наложена слабость.`
      : `${casterName} предлагает воскрешение.`;
  }
}

/** The server sends the initial delay once; its visible countdown must advance without packets. */
export function updateDeathReclaimCountdown(now = performance.now()): void {
  if (deathWindow.hidden || deathReclaim.hidden) return;
  const remaining = game.world?.corpseReclaimRemaining(now) ?? 0;
  const nearby = corpseReclaimNearby(game.world);
  const disabled = remaining > 0 || !nearby;
  if (deathReclaim.disabled !== disabled) deathReclaim.disabled = disabled;
  const label = remaining > 0 ? `Забрать тело (${Math.ceil(remaining / 1000)} с)`
    : nearby ? "Забрать тело" : "Подойдите к телу";
  if (deathReclaim.textContent !== label) deathReclaim.textContent = label;
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
      // Extended-cost rows are buyable: the server validates honor/arena/items/rating and
      // refuses with a vendor error when the price is not covered. Blocking them client-side
      // made every emblem/honor item unbuyable; the balance precheck stays server-side.
      const sellable = item.leftInStock !== 0;
      // Marked rather than `disabled`: the explanation lived on a control that cannot be hovered,
      // and «особая цена» on its own says nothing about what the price is.
      if (!sellable) button.setAttribute("aria-disabled", "true");
      attachTooltip(button, () => itemTooltipFor(item.itemId, {
        count: item.buyCount,
        footer: [sellable
          ? (item.extendedCost > 0
            ? `Нажмите, чтобы купить (особая цена #${item.extendedCost}; сервер проверит валюту и предметы)`
            : `Нажмите, чтобы купить за ${formatMoney(item.price)}`)
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
    ...trainer.spells.filter((spell) => {
      const metadata = game.spells.get(spell.spellId);
      return metadata !== undefined && metadata.hidden !== true;
    }).map((spell) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trainer-spell";
      const metadata = game.spells.get(spell.spellId);
      const name = metadata?.name;
      if (!name) return undefined;
      const state = trainerSpellStateText(spell.usable);
      const level = spell.requiredLevel > 0 ? ` · ур. ${spell.requiredLevel}` : "";
      button.textContent = `${name} · ${formatMoney(spell.moneyCost)}${level}${state ? " · " + state : ""}`;
      button.disabled = spell.usable !== TRAINER_SPELL_AVAILABLE;
      button.addEventListener("click", () => world.learnFromTrainer(spell.spellId));
      return button;
    }).filter((button): button is HTMLButtonElement => button !== undefined),
  );
  if (trainer.spells.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Этот тренер вас ничему не научит";
    trainerSpells.replaceChildren(empty);
  }
}

export function showGossip(): void {
  // Stock GossipFrame owns the page while published: it is told (GOSSIP_SHOW/GOSSIP_CLOSED through
  // the stock handlers) and the native window stays hidden, as it does with no page.
  if (notifyFrameXmlGossip()) {
    gossipWindow.hidden = true;
    return;
  }
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
    selectedQuestReward = undefined;
    questWindow.hidden = true;
    return;
  }
  if (world.questList) {
    selectedQuestReward = undefined;
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
  if (dialog?.kind === "reward") {
    if (selectedQuestReward?.world !== world || selectedQuestReward.dialog !== dialog)
      selectedQuestReward = { world, dialog, choice: undefined };
  } else selectedQuestReward = undefined;
  if (!dialog && !message) {
    questWindow.hidden = true;
    return;
  }
  gossipWindow.hidden = true;
  // The quest page takes the conversation's place, as QuestFrame does GossipFrame's in the client.
  if (dialog) closeFrameXmlGossip();
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
  let finishRewardButton: HTMLButtonElement | undefined;
  const choiceButtons: HTMLElement[] = [];
  questRequired.replaceChildren(...required.map((item) => questItem(item)));
  if (dialog.kind === "request-items" && dialog.requiredMoney > 0) {
    const money = document.createElement("p");
    money.textContent = `Требуется денег: ${formatMoney(dialog.requiredMoney)}`;
    questRequired.append(money);
  }
  if (rewards) {
    const choiceItems = rewards.choices.map((item, index) => {
      const selectable = dialog.kind === "reward";
      const button = questItem(item, selectable ? () => {
        if (game.world !== world || world.questDialog !== dialog || !selectedQuestReward) return;
        selectedQuestReward.choice = index;
        choiceButtons.forEach((choiceButton, choiceIndex) => {
          choiceButton.classList.toggle("is-selected", choiceIndex === index);
          choiceButton.setAttribute("aria-pressed", String(choiceIndex === index));
        });
        if (finishRewardButton) {
          finishRewardButton.disabled = false;
          finishRewardButton.textContent = "Завершить";
        }
      } : undefined);
      if (selectable) {
        const selected = selectedQuestReward?.choice === index;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
        choiceButtons.push(button);
      }
      return button;
    });
    questRewards.replaceChildren(
      ...rewards.items.map((item) => questItem(item)),
      ...choiceItems,
    );
    const summary = [
      rewards.money > 0 ? formatMoney(rewards.money) : "",
      rewards.requiredMoney > 0 ? `Требуется: ${formatMoney(rewards.requiredMoney)}` : "",
      rewards.honor > 0 ? `${rewards.honor} чести` : "",
      rewards.talents > 0 ? `${rewards.talents} талант` : "",
    ].filter(Boolean).join(" · ");
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
  else {
    const choices = dialog.rewards.choices.length;
    const needsChoice = choices > 0 && selectedQuestReward?.choice === undefined;
    finishRewardButton = questActionButton(needsChoice ? "Выберите награду выше" : "Завершить", () => {
      if (game.world !== world || world.questDialog !== dialog) return;
      const choice = selectedQuestReward?.choice;
      if (choices > 0 && (choice === undefined || choice >= choices)) return;
      const complete = () => {
        if (game.world === world && world.questDialog === dialog) world.chooseQuestReward(choice ?? 0);
      };
      if (dialog.rewards.requiredMoney > 0) {
        if (!finishRewardButton) return;
        confirmPanel(finishRewardButton, {
          title: "Подтвердить платное завершение задания",
          lines: [`Будет списано: ${formatMoney(dialog.rewards.requiredMoney)}`],
          confirm: "Завершить",
          onConfirm: complete,
        });
      } else complete();
    }, needsChoice);
    questActions.append(finishRewardButton, questActionButton("Закрыть", () => world.closeQuest()));
  }
}

export function questMenuButton(world: WorldClient, guid: bigint, quest: { id: number; icon: number; level: number; title: string }): HTMLButtonElement {
  // Player::PrepareQuestMenu uses menu icon 4 for involved quests; the dialog-status
  // values 5/6/9/10 belong to quest-giver head markers, not quest menu entries.
  const completion = quest.icon === 4;
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
