/**
 * The pet bar, which is also the vehicle bar.
 *
 * `SMSG_PET_SPELLS` carries both: a pet writes command and reaction states into the high byte of
 * each word, and a vehicle writes the bar-slot index there instead — 8 through 15, a range no
 * state occupies, which is exactly how `isVehicleActionBar` tells them apart. So one widget serves
 * a hunter's pet, a death knight's ghoul, a siege engine and a flying machine.
 *
 * Neither had any interface at all. The packet has been parsed since slice P6, `usePetSlot`,
 * `commandPet` and `setPetReaction` have existed with no caller, and the only thing the client did
 * with a pet bar was notice that a pet existed and draw its portrait.
 */

import {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION, COMMAND_ABANDON,
  PET_ACTION_BAR_SIZE, isVehicleActionBar, petActionOf, petActionTypeOf, petCommandText,
  petReactText, type PetActionButton,
} from "../../world/PetProtocol.js";
import { game } from "../game/Context.js";
import { unknownLabel } from "./Format.js";
import { IconButton, attachTooltip, confirmPanel } from "./Widgets.js";
import { spellIconUrl } from "./IconImage.js";

let container: HTMLElement | undefined;
const buttons: IconButton[] = [];
let exitRow: HTMLElement | undefined;

function root(): HTMLElement | undefined {
  if (container?.isConnected) return container;
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  container = document.createElement("div");
  container.id = "pet-bar";
  container.className = "pet-bar";
  container.hidden = true;
  viewport.append(container);
  return container;
}

function build(): void {
  const box = root();
  if (!box || buttons.length > 0) return;
  const row = document.createElement("div");
  row.className = "pet-bar-row";
  for (let slot = 0; slot < PET_ACTION_BAR_SIZE; slot++) {
    const button = new IconButton({ onClick: () => pressSlot(slot) });
    buttons.push(button);
    row.append(button.root);
  }
  exitRow = document.createElement("div");
  exitRow.className = "pet-bar-exit";
  box.append(row, exitRow);
}

export function resetPetBar(): void {
  container?.replaceChildren();
  buttons.length = 0;
  exitRow = undefined;
}

/** Whether the bar on screen is a vehicle's rather than a pet's. */
function drivingVehicle(): boolean {
  const bar = game.world?.petSpells?.bar;
  return bar !== undefined && isVehicleActionBar(bar);
}

function pressSlot(slot: number): void {
  const world = game.world;
  const button = world?.petSpells?.bar[slot];
  if (!world || !button) return;
  const type = petActionTypeOf(button.packed);
  const action = petActionOf(button.packed);
  // Dismissing is the one command worth asking about: a hunter's pet has to be summoned again and
  // a temporary one does not come back at all.
  if (type === ACT_COMMAND && action === COMMAND_ABANDON) {
    const anchor = buttons[slot]?.root;
    if (anchor) {
      confirmPanel(anchor, {
        title: "Отпустить питомца?",
        confirm: "Отпустить",
        danger: true,
        onConfirm: () => world.usePetSlot(slot),
      });
      return;
    }
  }
  world.usePetSlot(slot);
}

function slotLabel(button: PetActionButton): { label?: string; icon?: string } {
  const type = petActionTypeOf(button.packed);
  const action = petActionOf(button.packed);
  if (type === ACT_COMMAND) return { label: petCommandText(action) };
  if (type === ACT_REACTION) return { label: petReactText(action) };
  const icon = spellIconUrl(game.spells.get(action)?.iconId ?? 0, game.gatewayOrigin);
  return icon ? { icon } : { label: String(action) };
}

function slotTooltip(button: PetActionButton) {
  const type = petActionTypeOf(button.packed);
  const action = petActionOf(button.packed);
  if (type === ACT_COMMAND) return { title: petCommandText(action), footer: ["Команда питомцу"] };
  if (type === ACT_REACTION) return { title: petReactText(action), footer: ["Поведение питомца"] };
  const spell = game.spells.get(action);
  return {
    title: spell?.name ?? unknownLabel("заклинание", action),
    lines: spell?.rank ? [spell.rank] : undefined,
    footer: [type === ACT_PASSIVE ? "Пассивное" : type === ACT_DISABLED ? "Автокаст выключен" : "Способность"],
  };
}

/**
 * Draws the bar, or takes it down.
 *
 * The server closes a pet bar by sending the same packet with a zero guid, which the parser
 * records as `closed` — there is no separate "no pet" opcode.
 */
export function showPetBar(): void {
  const box = root();
  const world = game.world;
  const spells = world?.petSpells;
  if (!box) return;
  if (!world || !spells || spells.closed) {
    box.hidden = true;
    return;
  }
  build();
  box.hidden = false;
  const vehicle = drivingVehicle();
  box.classList.toggle("is-vehicle", vehicle);

  for (let slot = 0; slot < PET_ACTION_BAR_SIZE; slot++) {
    const button = buttons[slot];
    const content = spells.bar[slot];
    if (!button) continue;
    if (!content || content.packed === 0) {
      button.root.hidden = true;
      continue;
    }
    button.root.hidden = false;
    button.setContent(slotLabel(content));
    // Attached once per redraw: `setContent` keeps the element, so the listener would otherwise
    // pile up. The tooltip content is a thunk, so it reads whatever the slot holds now.
    attachTooltip(button.root, () => slotTooltip(spells.bar[slot] ?? content));
  }

  // Leaving is the one thing a vehicle bar must always offer: the server sends no button for it,
  // and without it a player in a siege engine has no way out but logging off.
  if (!exitRow) return;
  exitRow.replaceChildren();
  if (!vehicle) return;
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "◀ место";
  previous.addEventListener("click", () => world.changeVehicleSeat(false));
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "место ▶";
  next.addEventListener("click", () => world.changeVehicleSeat(true));
  const leave = document.createElement("button");
  leave.type = "button";
  leave.className = "danger";
  leave.textContent = "Покинуть";
  leave.addEventListener("click", () => world.leaveVehicle());
  exitRow.append(previous, next, leave);
}

/** The cooldown sweeps, once a frame, exactly as the player's own bar does. */
export function updatePetBar(now: number): void {
  const world = game.world;
  const spells = world?.petSpells;
  if (!world || !spells || spells.closed || buttons.length === 0) return;
  for (let slot = 0; slot < PET_ACTION_BAR_SIZE; slot++) {
    const button = buttons[slot];
    const content = spells.bar[slot];
    if (!button || !content) continue;
    const type = petActionTypeOf(content.packed);
    if (type !== ACT_ENABLED && type !== ACT_DISABLED && type !== ACT_PASSIVE) {
      button.setCooldown(0);
      continue;
    }
    const action = petActionOf(content.packed);
    // The client is told when a pet cooldown ends and never how long it was, so the sweep is on
    // or off rather than a fraction — the same limitation the player's own bar has for an item.
    button.setCooldown(world.petCooldownRemaining(action, now) > 0 ? 1 : 0);
    button.setUsable(type !== ACT_DISABLED);
  }
}
