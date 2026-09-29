import { MAX_PET_STABLES, STABLED_PET_ACTIVE, STABLED_PET_STABLED, type StableList } from "../../world/StableProtocol.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { frameXmlStablePublished } from "../framexml/FrameXmlStableController.js";
import { formatMoney } from "./Format.js";
import { confirmPanel, textLine } from "./Widgets.js";

const pending = new WeakMap<WorldClient, StableList>();

/** Stable roster embedded in the character's collection page. */
export function stablePetRows(world: WorldClient, redraw: () => void): HTMLElement[] {
  // Stock PetStableFrame is the stable while the FrameXML HUD publishes it (FrameXmlStableController).
  if (!world.stable || frameXmlStablePublished()) return [];
  const stable = world.stable;
  const operation = pending.get(world);
  if (operation && (operation !== stable || world.stableMessage?.error)) pending.delete(world);
  const currentService = () => game.world === world && world.stable === stable
    && world.stableMasterGuid !== 0n && world.stableMasterGuid === stable.npcGuid;
  const available = () => currentService() && !pending.has(world);
  const active = stable.pets.find((pet) => pet.flags === STABLED_PET_ACTIVE);
  const count = stable.pets.filter((pet) => pet.flags === STABLED_PET_STABLED).length;
  const rows: HTMLElement[] = [];
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.className = world.stableMessage?.error ? "error" : "muted";
  status.textContent = world.stableMessage?.text ?? (pending.has(world) ? "Ожидаем ответ стойл…" : `Занято мест: ${count}/${stable.stableSlots}`);
  rows.push(status);
  function send(action: () => void): void {
    if (!available()) return;
    world.stableMessage = { text: "Ожидаем ответ стойл… Если ответ задерживается, обновите список.", error: false };
    pending.set(world, stable);
    try {
      action();
    } catch (error) {
      pending.delete(world);
      world.stableMessage = { text: error instanceof Error ? error.message : "Не удалось отправить запрос стойлам.", error: true };
    }
    redraw();
  }
  function button(label: string, enabled: boolean, action: () => void): HTMLButtonElement {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.disabled = !enabled || !available();
    control.addEventListener("click", () => { if (enabled) send(action); });
    return control;
  }
  for (const pet of stable.pets) {
    const row = textLine(pet.name || "Безымянный питомец", `уровень ${pet.level}${pet.flags === STABLED_PET_ACTIVE ? " · активный" : " · в стойле"}`);
    row.className += " stable-pet-row";
    if (pet.flags === STABLED_PET_STABLED) {
      row.append(button(active ? "Заменить активного" : "Призвать", true, () => {
        if (active) world.swapStabledPet(pet.petNumber);
        else world.unstablePet(pet.petNumber);
      }));
    }
    rows.push(row);
  }
  const actions = document.createElement("div");
  actions.className = "stable-actions";
  actions.append(button("Отправить в стойло", active !== undefined && count < stable.stableSlots, () => world.stablePet()));
  if (stable.stableSlots < MAX_PET_STABLES) {
    const buy = document.createElement("button");
    buy.type = "button";
    const price = game.slotPrices?.stableSlotPrice(stable.stableSlots);
    buy.textContent = price === undefined
      ? `Купить место ${stable.stableSlots + 1}`
      : `Купить место ${stable.stableSlots + 1} · ${formatMoney(price)}`;
    buy.disabled = !available();
    buy.addEventListener("click", () => {
      if (!available()) return;
      confirmPanel(buy, {
        title: `Купить место ${stable.stableSlots + 1} в стойле?`,
        lines: [price === undefined
          ? "Сервер спишет золото по своему тарифу и откажет, если не хватает."
          : `Сервер спишет ${formatMoney(price)} и откажет, если не хватает.`],
        confirm: "Купить",
        onConfirm: () => { if (stable.stableSlots < MAX_PET_STABLES) send(() => world.buyStableSlot()); },
      });
    });
    actions.append(buy);
  }
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Обновить стойла";
  reload.disabled = !currentService();
  reload.addEventListener("click", () => { if (currentService()) world.requestStable(stable.npcGuid); });
  actions.append(reload);
  rows.push(actions);
  return rows;
}
