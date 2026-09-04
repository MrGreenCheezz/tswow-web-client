import { game } from "../game/Context.js";
import { entryOf, isBankSlot, playerInventory, slotAt, stackCount, type ItemSlotState } from "../Inventory.js";
import { gemFitsSocket, itemEnchantmentIds, itemEnchantments, itemSocketColors, socketColorName } from "../ItemEnchantments.js";
import { equipErrorText } from "../../world/ItemProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { attachTooltip, Panel, refreshTooltip } from "./Widgets.js";
import { setIconSource } from "./IconImage.js";

interface SocketingSession {
  world: WorldClient;
  bag: number;
  slot: number;
  guid: bigint;
  selected: [bigint, bigint, bigint];
  active: number;
  pending: boolean;
  confirming: boolean;
  sentAt: number;
  message: string;
  signature: string;
  stackChoice: bigint | undefined;
  split: {
    sourceGuid: bigint; sourceCount: number; entry: number;
    bag: number; slot: number; socket: number; sentAt: number;
  } | undefined;
}

let panel: Panel | undefined;
let session: SocketingSession | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let subscriptions: Array<() => void> = [];

export function socketingOpen(): boolean { return panel?.visible ?? false; }

export function closeSocketing(): void {
  session = undefined;
  panel?.hide();
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
}

function currentItem(active: SocketingSession): ItemSlotState | undefined {
  if (game.world !== active.world) return undefined;
  const inventory = playerInventory(active.world.state);
  const item = inventory && slotAt(inventory, active.bag, active.slot);
  return item?.guid === active.guid && item.item ? item : undefined;
}

function carriedItems(active: SocketingSession): ItemSlotState[] {
  const inventory = playerInventory(active.world.state);
  return inventory ? [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots)].filter((slot) => !!slot.item) : [];
}

/** The source item stays identified by GUID as well as location; moving/replacing it cancels. */
export function openSocketing(slot: ItemSlotState): boolean {
  const world = game.world;
  if (!world || !slot.item || slot.guid === 0n || isBankSlot(slot.bag, slot.slot)) return false;
  closeSocketing();
  panel ??= new Panel({ id: "socketing-window", title: "Инкрустация", className: "socketing-window", onClose: closeSocketing });
  session = { world, bag: slot.bag, slot: slot.slot, guid: slot.guid, selected: [0n, 0n, 0n],
    active: 0, pending: false, confirming: false, sentAt: 0, message: "", signature: "", stackChoice: undefined, split: undefined };
  const opened = session;
  subscriptions = [
    world.events.on("SOCKET_GEMS_RESULT", (result) => {
      if (session !== opened || result.itemGuid !== opened.guid) return;
      const submitted = opened.pending;
      opened.pending = false;
      opened.confirming = false;
      opened.selected = [0n, 0n, 0n];
      opened.message = submitted ? "Камни установлены." : "Гнёзда обновлены.";
      renderSocketing();
      refreshTooltip();
    }),
    world.events.on("INVENTORY_CHANGE_FAILURE", (failure) => {
      if (session !== opened || !opened.pending && !opened.split || failure.result === 0) return;
      if (failure.itemGuid !== 0n && failure.itemGuid !== opened.guid
        && failure.itemGuid !== opened.split?.sourceGuid && !opened.selected.includes(failure.itemGuid)) return;
      opened.pending = false;
      opened.split = undefined;
      opened.confirming = false;
      opened.message = equipErrorText(failure);
      renderSocketing();
    }),
    world.events.on("QUERY_CACHE_CHANGED", () => { if (session === opened) renderSocketing(); }),
  ];
  panel.show();
  renderSocketing();
  timer = setInterval(() => {
    if (session !== opened) return;
    const item = currentItem(opened);
    if (!item?.item) { closeSocketing(); return; }
    if (opened.split) {
      const split = opened.split;
      const inventory = playerInventory(opened.world.state);
      const separated = inventory && slotAt(inventory, split.bag, split.slot);
      const sourceStack = carriedItems(opened).find((slot) => slot.guid === split.sourceGuid);
      if (separated?.item && separated.guid !== split.sourceGuid && entryOf(separated.item) === split.entry
        && stackCount(separated) === 1 && sourceStack && stackCount(sourceStack) === split.sourceCount - 1) {
        opened.selected[split.socket] = separated.guid;
        opened.stackChoice = undefined;
        opened.split = undefined;
        opened.confirming = false;
        opened.message = "Камень отделён. Подтвердите его установку в гнездо.";
      } else if (Date.now() - split.sentAt > 12_000) {
        opened.message = "Ответ сервера о разделении задерживается. Проверьте сумки перед повторной попыткой.";
      }
    }
    if (opened.pending && Date.now() - opened.sentAt > 12_000) {
      // Do not offer an automatic retry: a late response may still consume the selected gems.
      opened.message = "Ответ сервера задерживается. Закройте окно и проверьте предмет перед повторной установкой.";
    }
    const signature = [itemEnchantmentIds(item.item).join(","), opened.message,
      ...carriedItems(opened).map((slot) => `${slot.guid}:${entryOf(slot.item)}:${stackCount(slot)}`)].join("|");
    if (signature !== opened.signature) { opened.signature = signature; renderSocketing(); }
  }, 300);
  const origin = game.gatewayOrigin;
  if (origin) void itemEnchantments(origin).load(true).then(() => {
    if (session === opened) renderSocketing();
  }).catch((error: unknown) => {
    if (session !== opened) return;
    opened.message = error instanceof Error ? error.message : "Сведения о камнях недоступны";
    renderSocketing();
  });
  return true;
}

/** Native FrameXML addresses equipment and container slots using one-based indices. */
export function openSocketingFromLua(location: number, bag: number, slot: number): boolean {
  const inventory = game.world && playerInventory(game.world.state);
  if (!inventory) return false;
  const source = location === 0 ? slotAt(inventory, 255, slot - 1)
    : location === 1 ? slotAt(inventory, bag === 0 ? 255 : bag + 18, bag === 0 ? slot + 22 : slot - 1) : undefined;
  return source ? openSocketing(source) : false;
}

/** The extraction addon asks this before OP85, so staged replacements remain protected even if
 * its legacy /socket window is reopened while the native placement panel is still visible. */
export function newSocketInfoFromLua(location: number, bag: number, slot: number, index: number): string | undefined {
  const active = session;
  if (!active || index < 1 || index > 3 || !Number.isInteger(index)) return undefined;
  const nativeBag = location === 0 || bag === 0 ? 255 : bag + 18;
  const nativeSlot = location === 0 || bag !== 0 ? slot - 1 : slot + 22;
  if (active.bag !== nativeBag || active.slot !== nativeSlot) return undefined;
  return active.selected[index - 1] !== 0n || active.split?.socket === index - 1
    || active.stackChoice !== undefined && active.active === index - 1
    ? "Выбранный камень" : undefined;
}

function text(tag: string, value: string, className = ""): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener("click", action);
  return element;
}

function icon(entry: number): HTMLElement {
  const metadata = game.itemMetadata?.get(entry);
  const box = text("span", metadata ? "" : "?", "socketing-icon");
  if (metadata && game.itemMetadata) {
    const image = document.createElement("img");
    image.alt = "";
    setIconSource(image, game.itemMetadata.iconUrl(metadata));
    box.append(image);
  }
  return box;
}

function renderSocketing(): void {
  const active = session;
  if (!active || !panel) return;
  const source = currentItem(active);
  if (!source?.item) { closeSocketing(); return; }
  const world = active.world;
  const entry = entryOf(source.item);
  const template = world.itemTemplate(entry);
  const metadata = game.itemMetadata?.get(entry);
  const index = game.gatewayOrigin ? itemEnchantments(game.gatewayOrigin) : undefined;
  const enchantments = itemEnchantmentIds(source.item);
  const colors = itemSocketColors(template?.sockets ?? [], enchantments);
  if (!colors[active.active]) active.active = Math.max(0, colors.findIndex((color) => color > 0));
  const carried = carriedItems(active);
  const byGuid = new Map(carried.map((item) => [item.guid, item]));
  const busy = active.pending || active.split !== undefined;
  if (!active.pending) {
    for (let socket = 0; socket < 3; socket++) {
      const guid = active.selected[socket]!;
      if (guid !== 0n && !byGuid.has(guid)) {
        active.selected[socket] = 0n;
        active.confirming = false;
        active.message = "Выбранный камень больше не находится в сумках.";
      }
    }
  }
  const name = (itemEntry: number): string => world.itemTemplate(itemEntry)?.name
    || game.itemMetadata?.get(itemEntry)?.name || `Предмет ${itemEntry}`;
  const header = text("div", "", "socketing-item");
  header.append(icon(entry), text("strong", template?.name || metadata?.name || `Предмет ${entry}`));
  attachTooltip(header, () => itemTooltipFor(entry, { enchantments: itemEnchantmentIds(source.item!) }));
  const guidance = text("p", "Выберите гнездо и камень из сумок, затем подтвердите установку.", "socketing-guidance");
  const slots = text("div", "", "socketing-slots");
  for (const [socket, color] of colors.entries()) {
    if (!color) continue;
    const enchantment = index?.enchantments.get(enchantments[socket + 2] ?? 0);
    const selected = byGuid.get(active.selected[socket]!);
    const chosenEntry = selected ? entryOf(selected.item) : enchantment?.gemItemId ?? 0;
    const slot = button("", () => { active.active = socket; active.stackChoice = undefined; active.confirming = false; renderSocketing(); }, busy);
    slot.className = `socketing-socket${active.active === socket ? " selected" : ""}${selected ? " staged" : ""}`;
    slot.dataset.socket = String(socket);
    slot.dataset.color = String(color);
    slot.append(icon(chosenEntry), text("span", `${socket + 1}. ${socketColorName(color)}`, "socketing-color"),
      text("strong", chosenEntry ? name(chosenEntry) : enchantment ? enchantment.name : "Пустое гнездо"));
    if (selected) slot.append(text("small", "Будет установлен"));
    else if (enchantment?.name) slot.append(text("small", enchantment.name));
    if (chosenEntry) attachTooltip(slot, () => itemTooltipFor(chosenEntry));
    slots.append(slot);
  }
  const body: HTMLElement[] = [header, guidance, slots];
  if (!template) body.push(text("p", "Описание предмета загружается…"));
  else if (!colors.some(Boolean)) body.push(text("p", "В этом предмете нет гнёзд."));
  if (template?.socketBonus) {
    const activeBonus = enchantments[5] === template.socketBonus;
    body.push(text("p", `Бонус за гнёзда: ${index?.enchantments.get(template.socketBonus)?.name || "Описание загружается…"} (${activeBonus ? "активен" : "неактивен"})`,
      `socketing-bonus${activeBonus ? " active" : ""}`));
  }
  const gems = carried.filter((slot) => {
    const gem = world.itemTemplate(entryOf(slot.item));
    const property = index?.gems.get(gem?.gemProperties ?? 0);
    // A retained custom item can outlive the DBC row it references. Keep it visible, but do
    // not infer a replacement enchantment or colour from its name/subclass.
    return property ? gemFitsSocket(colors[active.active] ?? 0, property.color) : (gem?.gemProperties ?? 0) > 0;
  });
  const missingProperties = gems.some((slot) => !index?.gems.has(world.itemTemplate(entryOf(slot.item))?.gemProperties ?? 0));
  const pendingTemplates = carried.filter((slot) => !world.itemTemplate(entryOf(slot.item))).length;
  const gemList = text("div", "", "socketing-gems");
  const needed = [entry, ...gems.map((slot) => entryOf(slot.item)),
    ...enchantments.slice(2, 5).map((id) => index?.enchantments.get(id)?.gemItemId ?? 0)].filter((id) => id > 0);
  if (game.itemMetadata) void game.itemMetadata.load(needed).then((changed) => {
    if (changed && session === active) renderSocketing();
  }).catch(() => undefined);
  for (const gem of gems) {
    const gemEntry = entryOf(gem.item);
    const property = index?.gems.get(world.itemTemplate(gemEntry)!.gemProperties);
    const already = active.selected.indexOf(gem.guid);
    const choice = button("", () => {
      active.stackChoice = stackCount(gem) > 1 ? gem.guid : undefined;
      if (active.stackChoice === undefined) active.selected[active.active] = gem.guid;
      active.confirming = false;
      active.message = "";
      renderSocketing();
    }, busy || !index?.ready || !property || already >= 0 && already !== active.active);
    choice.className = "socketing-gem";
    choice.dataset.gem = String(gem.guid);
    choice.append(icon(gemEntry), text("span", name(gemEntry)),
      text("small", !property ? index?.ready ? "Свойств этого камня нет в активной сборке. Требуется восстановить данные предмета." : "Сведения о камне загружаются…"
        : stackCount(gem) > 1 ? `В стопке: ${stackCount(gem)}. Нажмите, чтобы отделить один камень`
        : index!.enchantments.get(property.enchantmentId)?.name || ""));
    attachTooltip(choice, () => itemTooltipFor(gemEntry));
    gemList.append(choice);
  }
  body.push(text("h4", "Камни в сумках"), gemList);
  if (!index?.ready) body.push(text("p", "Сведения о камнях загружаются…"));
  else if (pendingTemplates > 0) body.push(text("p", "Сведения о предметах в сумках загружаются…", "socketing-empty"));
  else if (!gems.length) body.push(text("p", "В сумках нет камней для выбранного гнезда.", "socketing-empty"));
  const actions = text("div", "", "socketing-actions");
  if (index && (!index.ready || missingProperties)) actions.append(button("Обновить сведения о камнях", () => {
    if (session !== active || busy) return;
    active.message = "Сведения о камнях загружаются…";
    void index.load(true).then(() => {
      if (session !== active) return;
      active.message = "Сведения о камнях обновлены.";
      renderSocketing(); refreshTooltip();
    }).catch((error: unknown) => {
      if (session !== active) return;
      active.message = error instanceof Error ? error.message : "Сведения о камнях недоступны";
      renderSocketing();
    });
    renderSocketing();
  }, busy));
  const selectedStack = active.stackChoice === undefined ? undefined : byGuid.get(active.stackChoice);
  if (selectedStack) {
    body.push(text("p", "Перед инкрустацией нужно отделить один камень в свободную ячейку сумки. Остальные камни сохранятся.", "socketing-guidance"));
    actions.append(button(active.split ? "Ожидание разделения…" : "Отделить 1 камень", () => {
      if (session !== active || busy) return;
      const stack = carriedItems(active).find((item) => item.guid === selectedStack.guid);
      const inventory = playerInventory(world.state);
      // A free herb/quiver slot cannot accept a gem. Unknown bag templates wait for their
      // query; ordinary bags and explicitly compatible gem bags are safe destinations.
      const gemTemplate = stack && world.itemTemplate(entryOf(stack.item));
      const destination = inventory && [...inventory.backpack, ...inventory.bags.flatMap((bag) => {
        const container = world.itemTemplate(entryOf(bag.bag));
        return container?.itemClass === 1 && (container.subClass === 0
          || container.subClass === 5 && ((gemTemplate?.bagFamily ?? 0) & 0x200) !== 0) ? bag.slots : [];
      })]
        .find((slot) => slot.guid === 0n);
      if (!stack || stackCount(stack) <= 1) {
        active.stackChoice = undefined; active.message = "Стопка изменилась. Выберите камень заново.";
      } else if (!destination) {
        active.message = "Освободите одну ячейку в сумках, чтобы отделить камень.";
      } else {
        active.split = { sourceGuid: stack.guid, sourceCount: stackCount(stack), entry: entryOf(stack.item),
          bag: destination.bag, slot: destination.slot, socket: active.active, sentAt: Date.now() };
        active.message = "Ожидание подтверждения разделения от сервера…";
        try { world.splitItem(stack.bag, stack.slot, destination.bag, destination.slot, 1); }
        catch (error) { active.split = undefined; active.message = error instanceof Error ? error.message : "Не удалось разделить стопку"; }
      }
      renderSocketing();
    }, busy));
  }
  const selectedAny = active.selected.some((guid) => guid !== 0n);
  const replacing = active.selected.some((guid, socket) => guid !== 0n && (enchantments[socket + 2] ?? 0) > 0);
  if (selectedAny) body.push(text("p", replacing
    ? "При установке новые камни расходуются, а заменяемые уничтожаются. Для сохранения камней сначала используйте «Извлечь камни» в /socket."
    : "При установке выбранные камни расходуются и закрепляются в предмете.", "socketing-warning"));
  actions.append(button("Сбросить выбор", () => {
    active.selected = [0n, 0n, 0n]; active.stackChoice = undefined; active.confirming = false; renderSocketing();
  }, busy || !selectedAny && !active.stackChoice));
  actions.append(button(active.pending ? "Ожидание сервера…" : active.confirming ? "Подтвердить установку" : "Установить камни", () => {
    if (session !== active || !currentItem(active) || active.pending || active.split || active.stackChoice) return;
    if (!active.confirming) { active.confirming = true; renderSocketing(); return; }
    // Recheck the current carried inventory immediately before any irreversible request.
    const available = new Map(carriedItems(active).map((item) => [item.guid, item]));
    for (const [socket, guid] of active.selected.entries()) {
      if (!guid) continue;
      const gem = available.get(guid);
      const property = gem && index?.gems.get(world.itemTemplate(entryOf(gem.item))?.gemProperties ?? 0);
      if (!gem || stackCount(gem) !== 1 || !property || !gemFitsSocket(colors[socket] ?? 0, property.color)) {
        active.confirming = false; active.message = "Предметы изменились. Выберите камни заново."; renderSocketing(); return;
      }
    }
    active.pending = true;
    active.sentAt = Date.now();
    active.message = "Ожидание подтверждения сервера…";
    try { world.socketGems(active.guid, [...active.selected]); }
    catch (error) { active.pending = false; active.message = error instanceof Error ? error.message : "Не удалось отправить запрос"; }
    renderSocketing();
  }, busy || !selectedAny || !index?.ready || active.stackChoice !== undefined));
  body.push(actions);
  if (active.message) body.push(text("p", active.message, "socketing-status"));
  panel.body.replaceChildren(...body);
}
