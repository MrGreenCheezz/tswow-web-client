import { game } from "../game/Context.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { frameXmlCharterPublished } from "../framexml/FrameXmlPetitionController.js";
import { formatMoney } from "./Format.js";
import { notice } from "./Notices.js";
import { Panel, confirmPanel } from "./Widgets.js";

interface Parts {
  panel: Panel;
  title: HTMLElement;
  status: HTMLElement;
  info: HTMLElement;
  signatures: HTMLElement;
  renameRow: HTMLElement;
  nameInput: HTMLInputElement;
  rename: HTMLButtonElement;
  sign: HTMLButtonElement;
  decline: HTMLButtonElement;
  turnIn: HTMLButtonElement;
  vendor: HTMLElement;
  buyName: HTMLInputElement;
  offers: HTMLElement;
}

let parts: Parts | undefined;
let owner: WorldClient | undefined;
let unsubscribe: (() => void) | undefined;

function button(id: string, label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.id = id; element.type = "button"; element.textContent = label;
  element.addEventListener("click", action);
  return element;
}

function build(): Parts {
  const panel = new Panel({ id: "petition-window", title: "Хартия" });
  panel.root.style.width = "min(440px, 90vw)";
  const title = document.createElement("strong");
  title.id = "petition-title";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.id = "petition-status";
  const info = document.createElement("p");
  info.id = "petition-info";
  const signatures = document.createElement("div");
  signatures.id = "petition-signatures";
  const renameRow = document.createElement("p");
  const nameInput = document.createElement("input");
  nameInput.id = "petition-name"; nameInput.maxLength = 24; nameInput.style.width = "100%";
  nameInput.setAttribute("aria-label", "Название");
  const rename = button("petition-rename", "Переименовать", () => {
    const world = owner;
    const guid = world?.petitionSignatures?.petitionGuid;
    const name = parts?.nameInput.value.trim() ?? "";
    if (!world || !guid || !name) return;
    world.renamePetition(guid, name);
  });
  renameRow.append(nameInput, rename);
  const sign = button("petition-sign", "Подписать", () => {
    const world = owner;
    const guid = world?.petitionSignatures?.petitionGuid;
    if (!world || !guid) return;
    world.signPetition(guid);
  });
  const decline = button("petition-decline", "Отклонить", () => {
    const world = owner;
    const guid = world?.petitionSignatures?.petitionGuid;
    if (!world || !guid) return;
    world.declinePetition(guid);
  });
  const turnIn = button("petition-turn-in", "Сдать хартию", () => {
    const world = owner;
    const guid = world?.petitionSignatures?.petitionGuid;
    if (!world || !guid) return;
    confirmPanel(turnIn, { title: "Сдать хартию?",
      lines: ["Сервер создаст гильдию или команду и заберёт хартию."],
      confirm: "Сдать", danger: true, onConfirm: () => {
        if (owner !== world) return;
        world.turnInPetition(guid);
      } });
  });
  const vendor = document.createElement("div");
  vendor.id = "petition-vendor";
  const buyName = document.createElement("input");
  buyName.id = "petition-buy-name"; buyName.maxLength = 24; buyName.style.width = "100%";
  buyName.placeholder = "Название гильдии или команды";
  buyName.setAttribute("aria-label", "Название для новой хартии");
  const offers = document.createElement("div");
  offers.id = "petition-offers";
  vendor.append(buyName, offers);
  panel.body.append(title, status, info, signatures, renameRow, sign, decline, turnIn, vendor);
  return { panel, title, status, info, signatures, renameRow, nameInput, rename, sign, decline, turnIn, vendor, buyName, offers };
}

/** One vendor row: what it is, what it costs, and the buy button spending it. */
function offerName(offer: { teamSize: number; requiredSignatures: number }): string {
  const kind = offer.teamSize >= 2 ? `Хартия арены ${offer.teamSize}×${offer.teamSize}` : "Хартия гильдии";
  return `${kind} · подписей: ${offer.requiredSignatures}`;
}

function render(): void {
  if (!parts) return;
  const world = owner;
  // Stock PetitionFrame owns the charter half and the stock registrar frames the vendor half while
  // each is published (FrameXmlPetitionController); the native window shows only what is left.
  const stockCharter = frameXmlCharterPublished("petition");
  const info = stockCharter ? undefined : world?.petition;
  const signatures = stockCharter ? undefined : world?.petitionSignatures;
  const vendor = frameXmlCharterPublished("registrar") ? undefined : world?.petitionVendor;
  if (!world || (!info && !signatures && !vendor)) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  const arena = info?.arena === true;
  parts.title.textContent = info ? (arena ? "Хартия арены" : "Хартия гильдии")
    : vendor ? "Продавец хартий" : "Хартия";
  const message = world.petitionMessage;
  parts.status.textContent = message?.text ?? "";
  parts.status.className = message?.error ? "error" : "muted";
  const needed = info?.minSignatures;
  parts.info.textContent = [
    info?.name ? `«${info.name}»` : "",
    `Владелец: ${world.displayName(signatures?.ownerGuid ?? info?.ownerGuid ?? 0n)}`,
    signatures && needed !== undefined ? `Подписей: ${signatures.signers.length} из ${needed}` : "",
  ].filter(Boolean).join(" · ");
  parts.signatures.replaceChildren(...(signatures?.signers ?? []).map((guid) => {
    const row = document.createElement("div");
    row.textContent = world.displayName(guid);
    return row;
  }));
  const guid = signatures?.petitionGuid;
  const self = world.state.selfGuid;
  const isOwner = self !== undefined && (signatures?.ownerGuid ?? info?.ownerGuid) === self;
  const hasGuid = guid !== undefined;
  // A vendor visit is not a charter: the sign/rename/turn-in rows belong to a charter in hand.
  const charter = info !== undefined || signatures !== undefined;
  parts.info.hidden = !charter;
  parts.signatures.hidden = !charter;
  parts.renameRow.hidden = !isOwner;
  parts.sign.hidden = !charter || isOwner;
  parts.decline.hidden = !charter || isOwner;
  parts.turnIn.hidden = !charter || !isOwner;
  parts.nameInput.value = info?.name ?? "";
  parts.nameInput.disabled = !hasGuid;
  parts.rename.disabled = !hasGuid;
  parts.sign.disabled = !hasGuid;
  parts.decline.disabled = !hasGuid;
  if (arena) {
    // An arena turn-in carries the team emblem after the guid, and the server destroys the
    // charter before reading it — sending without one loses the charter and then throws.
    // There is no emblem designer in this client yet, so the button stays off with the reason.
    parts.turnIn.disabled = true;
    parts.turnIn.title = "Сдача арены требует эмблему команды, которой здесь пока нет";
  } else {
    parts.turnIn.disabled = !hasGuid;
    parts.turnIn.title = "";
  }
  // Charter offers from a petitioner. Buying costs money and is confirmed like every other
  // destructive purchase; the name rides in the same packet, so it is asked here and not later.
  parts.vendor.hidden = !vendor;
  parts.buyName.hidden = !vendor;
  if (vendor && world) {
    const vendorGuid = vendor.vendorGuid;
    parts.offers.replaceChildren(...vendor.offers.map((offer) => {
      const row = document.createElement("div");
      row.className = "petition-offer";
      const label = document.createElement("span");
      label.textContent = `${offerName(offer)} · ${formatMoney(offer.cost)}`;
      const buy = document.createElement("button");
      buy.type = "button";
      buy.textContent = "Купить";
      buy.addEventListener("click", () => {
        if (owner !== world) return;
        const name = parts?.buyName.value.trim() ?? "";
        if (!name) {
          notice("Назовите гильдию или команду — имя едет в том же пакете");
          parts?.buyName.focus();
          return;
        }
        confirmPanel(buy, {
          title: `Купить: ${offerName(offer)}?`,
          lines: [`«${name}» · ${formatMoney(offer.cost)}. Деньги не возвращаются.`],
          confirm: "Купить", danger: true,
          onConfirm: () => {
            if (owner === world) world.buyPetition(vendorGuid, name, offer.index);
          },
        });
      });
      row.append(label, buy);
      return row;
    }));
  } else {
    parts.offers.replaceChildren();
  }
}

export function showPetition(): void {
  const world = game.world;
  if (!world) {
    resetPetition();
    return;
  }
  parts ??= build();
  if (owner !== world) {
    resetPetition(); owner = world;
    unsubscribe = world.events.on("PETITION_CHANGED", () => {
      if (game.world === world) render();
    });
  }
  render();
}

/** Whether the charter window is currently visible. */
export function petitionOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closePetition(): void {
  parts?.panel.hide();
}

export function togglePetition(): void {
  const world = game.world;
  if (!world) return;
  parts ??= build();
  if (owner !== world) {
    showPetition();
    return;
  }
  if (parts.panel.visible) parts.panel.hide();
  else showPetition();
}

export function resetPetition(): void {
  unsubscribe?.(); unsubscribe = undefined; owner = undefined;
  if (parts) {
    parts.panel.hide();
    parts.nameInput.value = "";
    parts.status.textContent = "";
  }
}
