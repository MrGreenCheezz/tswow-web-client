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
  PET_ACTION_BAR_SIZE, isVehicleActionBar, petActionOf, petActionTypeOf, petBarKind, petCommandText,
  petReactText, type PetActionButton,
} from "../../world/PetProtocol.js";
import { vehiclePassengers } from "../../world/VehicleProtocol.js";
import { game } from "../game/Context.js";
import { unknownLabel } from "./Format.js";
import { IconButton, attachTooltip, confirmPanel } from "./Widgets.js";
import { spellIconUrl } from "./IconImage.js";
import { beginIconDrag } from "./DragGhost.js";
import { PET_SPELL_DRAG_FORMAT, nativePetBook } from "./PetSpellbook.js";
import { notifyHudLayout } from "../GameWindows.js";
import { nativeVehicleGates, stockOwnsVehicleRow } from "./VehicleBarGates.js"; // 11.02-F2
import { vehicleCatalog } from "../VehicleClient.js"; // 11.02-F2

let container: HTMLElement | undefined;
const buttons: IconButton[] = [];
let actionRow: HTMLElement | undefined;
let exitRow: HTMLElement | undefined;
let observedWorld: typeof game.world;
let observedRevision = -1;
let observedVehicleKey = "";
let observedKind: string | undefined;

/**
 * `data-kind` names whose bar this is (PetProtocol.ts `petBarKind`): the stock HUD's pet bar takes
 * over a `pet` bar and hides this one by that attribute, leaving vehicles and possession here. A
 * control update can change the kind with no bar packet, so it is compared every frame — a few
 * field reads, and a DOM write only on change.
 */
function syncKind(box: HTMLElement): void {
  const world = game.world;
  // 11.02-F2: `data-stock-vehicle` while the stock UI draws the vehicle row (VehicleBarGates.ts); the world
  // mount hides the native bar by it.
  const stock = stockOwnsVehicleRow(world);
  if (stock !== observedStockVehicle) {
    observedStockVehicle = stock;
    if (stock) box.dataset.stockVehicle = "";
    else delete box.dataset.stockVehicle;
  }
  const kind = world ? petBarKind(world.petSpells, world.controlledGuid, world.state?.selfGuid) ?? "" : "";
  if (kind === observedKind) return;
  observedKind = kind;
  box.dataset.kind = kind;
}

/** 11.02-F2: the last `data-stock-vehicle` written. */
let observedStockVehicle = false;

function root(): HTMLElement | undefined {
  if (container?.isConnected) return container;
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  const mount = document.getElementById("bottom-hud-center") ?? viewport;
  container = document.createElement("div");
  container.id = "pet-bar";
  container.className = "pet-bar";
  container.hidden = true;
  mount.append(container);
  return container;
}

function build(): void {
  const box = root();
  if (!box || buttons.length > 0) return;
  const row = document.createElement("div");
  row.className = "pet-bar-row";
  actionRow = row;
  for (let slot = 0; slot < PET_ACTION_BAR_SIZE; slot++) {
    const button = new IconButton({ onClick: () => pressSlot(slot) });
    const index = slot;
    // Right-click toggles autocast on a pet spell, as in the original client. Commands and
    // reactions keep their left-click behaviour; passive spells have no autocast to toggle.
    button.root.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const world = game.world;
      const content = world?.petSpells?.bar[index];
      if (!world || !content) return;
      const type = petActionTypeOf(content.packed);
      if (type !== ACT_ENABLED && type !== ACT_DISABLED) return;
      world.togglePetAutocast(petActionOf(content.packed), type === ACT_DISABLED);
    });
    // Drag to reorder, as on the player's own bar. The server cross-checks both slots, so the
    // local bar moves itself optimistically in `swapPetActionSlots`.
    button.root.draggable = true;
    button.root.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/pet-slot", String(index));
      // 4.02: the slot's icon under the cursor, as on the player's own bars (DragGhost.ts).
      beginIconDrag(event, button.root);
    });
    button.root.addEventListener("dragover", (event) => event.preventDefault());
    button.root.addEventListener("drop", (event) => {
      event.preventDefault();
      // 4.03: a spell from the pet book's tab, placed as the stock PickupSpell(i, "pet") drop is.
      const petSpell = event.dataTransfer?.getData(PET_SPELL_DRAG_FORMAT);
      if (petSpell) {
        const spellId = Number(petSpell);
        if (Number.isSafeInteger(spellId) && spellId > 0) nativePetBook().placeSpell(index + 1, spellId);
        return;
      }
      // Only this bar's own slot drag: any other drop reads "" here, and `Number("")` is slot 0.
      const carried = event.dataTransfer?.getData("text/pet-slot") ?? "";
      if (!/^\d+$/.test(carried)) return;
      const from = Number(carried);
      if (from >= PET_ACTION_BAR_SIZE || from === index) return;
      game.world?.swapPetActionSlots(from, index);
    });
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
  actionRow = undefined;
  exitRow = undefined;
  observedWorld = undefined;
  observedRevision = -1;
  observedVehicleKey = "";
  observedKind = undefined;
  observedStockVehicle = false; // 11.02-F2
  if (container) delete container.dataset.stockVehicle; // 11.02-F2
}

/** Only state packet changes can alter a seat roster; ordinary rendered frames cannot. */
function vehicleControlKey(): string {
  const world = game.world;
  const selfGuid = world?.state.selfGuid;
  if (!world || selfGuid === undefined) return "";
  const seatGuid = world.state.objects.get(selfGuid)?.transport?.guid;
  const base = seatGuid === undefined ? undefined : world.state.objects.get(seatGuid);
  const riding = base?.typeId === 3 || base?.typeId === 4 ? seatGuid : undefined;
  const passengers = world.vehicleKits.has(selfGuid)
    ? vehiclePassengers(world.state, selfGuid).filter((guid) => guid !== selfGuid).map(String).sort()
    : [];
  // 11.02-F2: the seat byte and the vehicle tables' arrival move the gates (VehicleBarGates.ts) too.
  const gated = riding === undefined && passengers.length === 0 ? "" : `|${world.state.objects.get(selfGuid)?.transport?.seat ?? ""}|${vehicleCatalog() ? 1 : 0}`;
  return `${riding ?? ""}|${passengers.join(",")}${gated}`;
}

/**
 * `PetActionButtonDown(id)` from the keyboard (BONUSACTIONBUTTON1-10, 3.11): the button the click
 * presses, `id` 1–10. False when there is no pet bar or nothing in that button.
 */
export function pressPetButton(id: number): boolean {
  const button = game.world?.petSpells?.bar[id - 1];
  if (!button || game.world?.petSpells?.closed) return false;
  // An empty button is hidden on the bar (showPetBar); a key on it presses nothing either.
  if (petActionOf(button.packed) === 0 && petActionTypeOf(button.packed) !== ACT_COMMAND
    && petActionTypeOf(button.packed) !== ACT_REACTION) return false;
  pressSlot(id - 1);
  return true;
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
  if (!box) return;
  syncKind(box);
  const spells = world?.petSpells?.closed ? undefined : world?.petSpells;
  const selfGuid = world?.state?.selfGuid;
  const self = selfGuid === undefined ? undefined : world?.state?.objects.get(selfGuid);
  const seatBase = self?.transport === undefined ? undefined : world?.state?.objects.get(self.transport.guid);
  const ridingVehicle = seatBase?.typeId === 3 || seatBase?.typeId === 4;
  const vehicleBar = spells !== undefined && isVehicleActionBar(spells.bar);
  const ownedPassengers = world && selfGuid !== undefined && world.vehicleKits.has(selfGuid)
    ? vehiclePassengers(world.state, selfGuid).filter((guid) => guid !== selfGuid)
    : [];
  if (!world || (!spells && !ridingVehicle && ownedPassengers.length === 0)) {
    box.hidden = true;
    exitRow?.replaceChildren();
    document.documentElement.style.setProperty("--pet-bar-height", "0px");
    notifyHudLayout();
    return;
  }
  build();
  box.hidden = false;
  const vehicle = vehicleBar || ridingVehicle || ownedPassengers.length > 0;
  box.classList.toggle("is-vehicle", vehicle);
  if (actionRow) actionRow.hidden = spells === undefined;

  for (let slot = 0; slot < PET_ACTION_BAR_SIZE; slot++) {
    const button = buttons[slot];
    const content = spells?.bar[slot];
    if (!button) continue;
    // An empty slot is action 0 with a spell state, not a zero word: `CharmInfo::InitPetActionBar`
    // writes (0, ACT_PASSIVE) into the four spell slots and `VehicleSpellInitialize` (0, i + 8) into
    // a vehicle's unused ones. Only stay (command 0) and passive (reaction 0) are real zeros.
    if (!spells || !content || (petActionOf(content.packed) === 0
      && petActionTypeOf(content.packed) !== ACT_COMMAND && petActionTypeOf(content.packed) !== ACT_REACTION)) {
      button.root.hidden = true;
      continue;
    }
    button.root.hidden = false;
    button.setContent(slotLabel(content));
    // The active stance and command read off the packet's own states: a pet whose stance the
    // player cannot see is a pet whose behaviour surprises them.
    const type = petActionTypeOf(content.packed);
    const action = petActionOf(content.packed);
    const active = type === ACT_REACTION ? action === spells.reactState
      : type === ACT_COMMAND ? action === spells.commandState : false;
    button.root.classList.toggle("is-active", active);
    // Attached once per redraw: `setContent` keeps the element, so the listener would otherwise
    // pile up. The tooltip content is a thunk, so it reads whatever the slot holds now.
    attachTooltip(button.root, () => slotTooltip(spells.bar[slot] ?? content));
  }

  // Leaving is the one thing a vehicle bar must always offer: the server sends no button for it,
  // and without it a player in a siege engine has no way out but logging off.
  if (!exitRow) {
    document.documentElement.style.setProperty("--pet-bar-height", "46px");
    notifyHudLayout();
    return;
  }
  exitRow.replaceChildren();
  // 11.02-F2: with the vehicle tables, Wow.exe's gates (VehicleBarGates.ts) — drawn disabled and asked again
  // on the click; without them every button works as before.
  const gates = nativeVehicleGates(world);
  if (vehicleBar || ridingVehicle) {
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "◀ место";
    previous.disabled = gates !== undefined && !gates.canSwitch; // 11.02-F2
    previous.addEventListener("click", () => {
      if (nativeVehicleGates(world)?.canSwitch === false) return; // 11.02-F2
      world.changeVehicleSeat(false);
    });
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "место ▶";
    next.disabled = gates !== undefined && !gates.canSwitch; // 11.02-F2
    next.addEventListener("click", () => {
      if (nativeVehicleGates(world)?.canSwitch === false) return; // 11.02-F2
      world.changeVehicleSeat(true);
    });
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "danger";
    leave.textContent = "Покинуть";
    leave.disabled = gates !== undefined && !gates.canExit; // 11.02-F2
    leave.addEventListener("click", () => {
      if (nativeVehicleGates(world)?.canExit === false) return; // 11.02-F2
      world.leaveVehicle();
    });
    exitRow.append(previous, next, leave);
  }
  // The core's eject handler accepts only a player who owns the vehicle kit. A controller seated
  // in a creature vehicle has a vehicle spell bar, but does not have that authority.
  for (const passenger of ownedPassengers) {
    const eject = document.createElement("button");
    eject.type = "button";
    eject.className = "danger";
    eject.textContent = `Высадить: ${world.displayName(passenger)}`;
    eject.setAttribute("aria-label", `Высадить пассажира ${world.displayName(passenger)}`);
    eject.disabled = gates !== undefined && !gates.canEject(passenger); // 11.02-F2
    eject.addEventListener("click", () => {
      if (nativeVehicleGates(world)?.canEject(passenger) === false) return; // 11.02-F2
      confirmPanel(eject, {
        title: `Высадить ${world.displayName(passenger)}?`,
        confirm: "Высадить",
        danger: true,
        onConfirm: () => world.ejectPassenger(passenger),
      });
    });
    exitRow.append(eject);
  }
  document.documentElement.style.setProperty("--pet-bar-height", spells ? vehicle ? "72px" : "46px" : "30px");
  notifyHudLayout();
}

/** The cooldown sweeps, once a frame, exactly as the player's own bar does. */
export function updatePetBar(now: number): void {
  const world = game.world;
  const revision = world?.state.revision ?? -1;
  if (world !== observedWorld || revision !== observedRevision) {
    observedWorld = world;
    observedRevision = revision;
    const key = vehicleControlKey();
    if (key !== observedVehicleKey) {
      observedVehicleKey = key;
      showPetBar();
    }
  }
  if (container?.isConnected) syncKind(container);
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
