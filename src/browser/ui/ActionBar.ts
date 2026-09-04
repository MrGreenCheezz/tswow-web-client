import {
  ACTION_BUTTONS_PER_PAGE, ACTION_BUTTON_EQUIPMENT_SET, ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO,
  ACTION_BUTTON_SPELL, EXTRA_ACTION_BARS, actionPage, actionSlot, type ExtraActionBar,
} from "../../world/ActionBarProtocol.js";
import { game } from "../game/Context.js";
import { playerInventory, stackCount } from "../Inventory.js";
import { macroAt, runMacro } from "./Macros.js";
import { macroLabel, macroLines } from "./MacroModel.js";
import { actionBar } from "./Dom.js";
import {
  IconButton, attachTooltip, cooldownDuration, cooldownLabel, cooldownView,
  type TooltipContent,
} from "./Widgets.js";
import { spellIconUrl } from "./IconImage.js";
import { castSpell, spellTooltip } from "./Spellbook.js";
import { spellButtonUsable } from "../SpellMetadata.js";
import { spellPowerAvailable } from "../SpellCastGuard.js";
import { ensureSpellNames } from "./SpellNames.js";
import { settingOn } from "./Settings.js";
import { worldObject } from "../../world/Fields.js";
import { MELEE_AUTO_ATTACK_SPELL_ID } from "../../world/WorldClient.js";
import { ACTION_BAR_SLOTS, bindingsOf, describeChord, EXTRA_ACTION_BAR_SLOTS } from "../input/Bindings.js";
import { unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { notifyHudLayout } from "../GameWindows.js";

/**
 * The action bar: twelve slots, driven by what the server says the player put there.
 *
 * `SMSG_ACTION_BUTTONS` was among the opcodes the world loop dropped, so the client had no bar at
 * all — every spell had to be cast from the book. The bar the server keeps is 144 slots, twelve
 * pages of twelve; this shows one page and switches with Shift and a number, which is what the
 * original client's paging keys do.
 */
const PAGES = 6;

/**
 * What key a slot wears in its corner, read from the binding table rather than written out here.
 * A slot the player has rebound says so, which is the difference between a label and a decoration.
 */
function slotKey(column: number, bar?: ExtraActionBar): string {
  const action = bar ? EXTRA_ACTION_BAR_SLOTS[bar]?.[column] : ACTION_BAR_SLOTS[column];
  if (action === undefined) return "";
  // Keep both slots from the settings table visible. A secondary binding is just as actionable as
  // the primary one, and hiding it made a rebound bar appear to ignore the player's settings.
  return bindingsOf(action).map(describeChord).filter((key) => key !== "—").join(" / ");
}

let page = 0;
const slots: IconButton[] = [];
/**
 * The four bars the original client stacks beside the main one.
 *
 * They are not pages of anything, and yet they address exactly like pages: the server's 144 slots
 * are twelve rows of twelve, the paging keys walk the first six, and the bottom-left bar simply
 * *is* row 6. So an extra bar is a row pinned to a fixed page, and every function here that took a
 * column and read the current page now takes the page too. Nothing else had to change.
 */
const extraRows = new Map<ExtraActionBar, { element: HTMLElement; buttons: IconButton[] }>();
/** Which setting shows each, in the order they are stacked. */
const EXTRA_BAR_SETTINGS: Readonly<Record<ExtraActionBar, string>> = {
  bottomLeft: "actionBarBottomLeft",
  bottomRight: "actionBarBottomRight",
  right: "actionBarRight",
  right2: "actionBarRight2",
};

/**
 * Which of the four stand across the bottom and which stand on end at the right edge.
 *
 * The original client's own arrangement, and the names say it: the two «bottom» bars are rows
 * above the main one, the two «right» bars are columns down the right-hand side. All four used to
 * be stacked as rows above the main bar, which is four rows of twelve buttons in the middle of the
 * screen — 500px wide and 176px tall before the world starts.
 */
const VERTICAL_BARS: ReadonlySet<ExtraActionBar> = new Set<ExtraActionBar>(["right", "right2"]);

/** What a drag carries: where it came from, so a slot-to-slot drag can move rather than copy. */
const DRAG_FORMAT = "application/x-webclient-action";

/** One button, wired to a fixed row. The main bar passes the live page; an extra bar its own. */
function buildButton(column: number, barPage: () => number, bar?: ExtraActionBar): IconButton {
  const button = new IconButton({ key: slotKey(column, bar), onClick: () => useSlot(column, barPage()) });
  button.root.classList.add("ui-action-button");
  attachTooltip(button.root, () => slotTooltip(column, barPage(), bar));
  button.root.draggable = true;
  button.root.addEventListener("dragstart", (event) => {
    const content = contentOf(column, barPage());
    if (!content) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData(DRAG_FORMAT, JSON.stringify({ ...content, from: actionSlot(barPage(), column) }));
  });
  button.root.addEventListener("dragover", (event) => event.preventDefault());
  button.root.addEventListener("drop", (event) => {
    event.preventDefault();
    const raw = event.dataTransfer?.getData(DRAG_FORMAT);
    if (!raw) return;
    dropSlot(column, JSON.parse(raw) as { action: number; type: number; from?: number }, barPage());
  });
  button.root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const slot = actionSlot(barPage(), column);
    if (contentOf(column, barPage())) game.world?.setActionButton(slot, 0, 0);
  });
  return button;
}

function buildExtraRows(): void {
  if (extraRows.size > 0) return;
  // Two containers, because the four bars stand in two different places. `#action-bar` positions
  // itself absolutely — `bottom: 14px; left: 50%` with a transform — so anything appended beside
  // it in normal flow has no position at all and lands in a corner behind the world; each
  // container repeats the anchor rather than inheriting it.
  //
  // The bottom stack is anchored by its *bottom* and has no height of its own, so switching a bar
  // on grows the stack upward and switching one off closes the gap without any row having to know
  // how many are below it. The side stack is anchored by its right edge and does the same
  // sideways, and publishes how wide it ended up so the minimap and the bags can move over.
  const bottom = document.createElement("div");
  bottom.id = "action-bar-extras";
  const side = document.createElement("div");
  side.id = "action-bar-side";
  side.dataset["windowReserveRight"] = "";
  for (const bar of EXTRA_ACTION_BARS) {
    const vertical = VERTICAL_BARS.has(bar.id);
    const element = document.createElement("div");
    element.className = vertical ? "action-bar action-bar-side-column" : "action-bar action-bar-extra";
    element.dataset["bar"] = bar.id;
    element.hidden = true;
    const buttons = Array.from({ length: ACTION_BUTTONS_PER_PAGE }, (_, slot) =>
      buildButton(slot, () => actionPage(bar.base), bar.id));
    element.append(...buttons.map((button) => button.root));
    (vertical ? side : bottom).append(element);
    extraRows.set(bar.id, { element, buttons });
  }
  actionBar.parentElement?.insertBefore(bottom, actionBar);
  // The horizontal rows belong to #bottom-hud-center, but the vertical rail must remain a viewport
  // edge sibling. Appending both through actionBar.parentElement would put the rail into the new
  // centre stack and make its right/top offsets relative to the bottom HUD.
  const viewport = actionBar.closest<HTMLElement>("#world-viewport");
  if (viewport) viewport.append(side);
  else actionBar.parentElement?.insertBefore(side, actionBar);
}

/**
 * How much of the right edge the vertical bars have taken, as a CSS custom property.
 *
 * The same arrangement the bottom edge already uses for the chat and the action bar: one number
 * published in one place, and everything standing on that edge starts where it ends. Without it
 * the minimap, the bag bar and the game buttons would each carry their own guess at whether a
 * twelve-button column is in front of them, and all three guesses would be wrong half the time.
 */
function publishSideWidth(): void {
  const shown = EXTRA_ACTION_BARS.filter((bar) =>
    VERTICAL_BARS.has(bar.id) && settingOn(EXTRA_BAR_SETTINGS[bar.id])).length;
  document.documentElement.style.setProperty("--side-bars", String(shown));
}

/** Publish enabled horizontal rows for neighbouring HUD surfaces such as chat. */
function publishBottomBars(): void {
  const shown = EXTRA_ACTION_BARS.filter((bar) =>
    !VERTICAL_BARS.has(bar.id) && settingOn(EXTRA_BAR_SETTINGS[bar.id])).length;
  document.documentElement.style.setProperty("--bottom-bars", String(shown));
  const stack = document.getElementById("action-bar-extras");
  if (stack) stack.hidden = shown === 0;
  notifyHudLayout();
}

function build(): void {
  buildExtraRows();
  if (slots.length > 0) return;
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    const button = new IconButton({ key: slotKey(column), onClick: () => useSlot(column) });
    button.root.classList.add("ui-action-button");
    // Attached once and reading the slot when it is shown: the contents change far more often
    // than the button does, and a `title` on a greyed-out slot is never displayed at all.
    attachTooltip(button.root, () => slotTooltip(column));
    button.root.draggable = true;
    button.root.addEventListener("dragstart", (event) => {
      const content = contentOf(column);
      if (!content) {
        event.preventDefault();
        return;
      }
      event.dataTransfer?.setData(DRAG_FORMAT, JSON.stringify({ ...content, from: actionSlot(page, column) }));
    });
    button.root.addEventListener("dragover", (event) => event.preventDefault());
    button.root.addEventListener("drop", (event) => {
      event.preventDefault();
      const raw = event.dataTransfer?.getData(DRAG_FORMAT);
      if (!raw) return;
      const dropped = JSON.parse(raw) as { action: number; type: number; from?: number };
      dropSlot(column, dropped);
    });
    // Right-click empties a slot, which is the only way to take something off a bar.
    button.root.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const slot = actionSlot(page, column);
      if (contentOf(column)) game.world?.setActionButton(slot, 0, 0);
    });
    slots.push(button);
    actionBar.append(button.root);
  }
}

/**
 * Puts what was dragged into a slot. A drag from another slot is a move: the server holds one
 * action per slot and nothing tells it the old one is gone unless the client says so.
 */
function dropSlot(column: number, dropped: { action: number; type: number; from?: number }, barPage = page): void {
  const world = game.world;
  if (!world || dropped.action <= 0) return;
  const target = actionSlot(barPage, column);
  if (dropped.from === target) return;
  const displaced = contentOf(column, barPage);
  world.setActionButton(target, dropped.action, dropped.type);
  if (dropped.from === undefined) return;
  // Swap rather than overwrite, so dragging onto an occupied slot does not lose what was there.
  world.setActionButton(dropped.from, displaced?.action ?? 0, displaced?.type ?? 0);
}

/** Called by the spell book: a spell dragged out of it can land on a bar. */
export function actionDragPayload(spellId: number): [string, string] {
  return [DRAG_FORMAT, JSON.stringify({ action: spellId, type: ACTION_BUTTON_SPELL })];
}

/**
 * Called by the bags: an item dragged out of one can land on a bar too. What the bar stores is the
 * item's entry, not the slot it came from, which is why a bar slot survives the item being moved.
 */
export function itemActionDragPayload(entry: number): [string, string] {
  return [DRAG_FORMAT, JSON.stringify({ action: entry, type: ACTION_BUTTON_ITEM })];
}

function spellIcon(spellId: number): string | undefined {
  return spellIconUrl(game.spells.get(spellId)?.iconId ?? 0, game.gatewayOrigin);
}

/** What sits in one column of the page on screen. */
/**
 * Asks for the names and icons of everything on the bar, and redraws when they land.
 *
 * The bar read `game.spells` and never filled it: it assumed somebody else had already loaded the
 * rows it needed. Nobody had. The core sends `SMSG_INITIAL_SPELLS` and `SMSG_ACTION_BUTTONS` back
 * to back, and the fetch that populates `game.spells` is started in the same tick without being
 * waited for — so at the moment the bar first draws, the map is empty, `spellIcon` returns
 * undefined, and an occupied slot is drawn exactly like an empty one: the key's letter on a dark
 * square. And when the rows did arrive nothing redrew the bar, because none of the four callers of
 * `showActionBar` is connected to metadata landing. That is the whole of "the icons are not there
 * until you drag a spell in": dragging is the one path that redraws.
 *
 * All twelve pages are asked for, not the visible one, or Shift and a number would pay the same
 * delay again.
 */
function requestSlotMetadata(): void {
  const buttons = game.world?.actionButtons ?? [];
  if (buttons.length === 0) return;
  const spells: number[] = [];
  const items: number[] = [];
  for (const button of buttons) {
    if (button.type === ACTION_BUTTON_SPELL) spells.push(button.action);
    else if (button.type === ACTION_BUTTON_ITEM) items.push(button.action);
  }
  // Both loaders deduplicate and batch, so calling them on every draw costs one set lookup a slot.
  if (spells.length > 0) ensureSpellNames(spells, showActionBar);
  if (items.length > 0 && game.itemMetadata) {
    const client = game.itemMetadata;
    void client.load(items).then((changed) => {
      if (changed && game.itemMetadata === client) showActionBar();
    });
  }
}

function contentOf(column: number, barPage = page): { action: number; type: number } | undefined {
  const slot = actionSlot(barPage, column);
  return game.world?.actionButtons.find((button) => button.slot === slot);
}

/** Why a slot cannot be pressed right now, or an empty string when it can. */
function slotBlockedBy(column: number, now = performance.now(), barPage = page): string {
  const world = game.world;
  const content = contentOf(column, barPage);
  if (!world || !content) return "";
  if (content.type === ACTION_BUTTON_MACRO) {
    return macroAt(content.action) ? "" : `Макроса ${content.action} больше нет`;
  }
  // The set and the packet to wear it both exist; putting one on a bar does not, and a slot that
  // looks pressable and does nothing is worse than one that says why.
  if (content.type === ACTION_BUTTON_EQUIPMENT_SET) return "Наборы экипировки с панели пока не надеваются";
  if (content.type !== ACTION_BUTTON_SPELL) return "";
  // 6603 is a client combat action and is therefore intentionally absent from both learned-spell
  // and Spell.dbc metadata gates. Spellbook.castSpell routes it to the melee swing protocol.
  if (content.action === MELEE_AUTO_ATTACK_SPELL_ID) return "";
  const metadata = game.spells.get(content.action);
  if (!metadata) return "Данные заклинания загружаются";
  if (!spellButtonUsable(metadata)) return "Пассивное заклинание нельзя применить";
  const togglingMount = world.isActiveMountSpell(content.action);
  // This press sends only CMSG_CANCEL_MOUNT_AURA. Recovery, GCD and the spell's power cost belong
  // to a new cast and must not make dismounting unavailable.
  if (togglingMount) return "";
  if (world.cooldownRemaining(content.action, now) > 0) return "Восстанавливается";
  if ((metadata?.startRecoveryTime ?? 0) > 0 && game.globalCooldownUntil > now) return "Восстанавливается";
  if (!spellPowerAvailable(world, metadata)) return "Не хватает ресурса";
  return "";
}

export function useSlot(column: number, barPage = page): void {
  const world = game.world;
  const content = contentOf(column, barPage);
  if (!world || !content) return;
  // The sweep and the grey already knew this; pressing the key did not, so a slot could be drawn
  // as unusable and still send the cast.
  if (slotBlockedBy(column, performance.now(), barPage)) return;
  if (content.type === ACTION_BUTTON_SPELL) {
    castSpell(content.action);
    return;
  }
  if (content.type === ACTION_BUTTON_MACRO) {
    runMacro(content.action);
    return;
  }
  if (content.type === ACTION_BUTTON_ITEM) {
    // The bar stores what to use, not where it is, so the item has to be found in the bags by its
    // entry — the same item can be in any slot, and moving it does not change the bar.
    const inventory = playerInventory(world.state);
    const held = [...(inventory?.backpack ?? []), ...(inventory?.bags ?? []).flatMap((bag) => bag.slots)]
      .find((slot) => slot.item !== undefined && worldObject.entry(slot.item) === content.action);
    if (held) world.useItem(held.bag, held.slot, held.guid);
  }
}

/** What one slot holds, the key that presses it, and how anything gets onto the bar at all. */
function slotTooltip(column: number, barPage = page, bar?: ExtraActionBar): TooltipContent {
  const key = slotKey(column, bar);
  const chord = key ? `Клавиша: ${key}` : "";
  const content = contentOf(column, barPage);
  if (!content) {
    return {
      title: `Слот ${column + 1}`,
      lines: [chord].filter(Boolean),
      footer: ["Пусто", "Перетащите сюда заклинание из книги или предмет из сумки"],
    };
  }
  if (content.type === ACTION_BUTTON_SPELL) {
    const spell = game.spells.has(content.action) ? spellTooltip(content.action) : {
      title: "Данные заклинания загружаются",
      footer: ["Название, иконка и описание пока недоступны"],
    };
    return { ...spell, lines: [...(spell.lines ?? []), chord].filter(Boolean) };
  }
  if (content.type === ACTION_BUTTON_ITEM) {
    return itemTooltipFor(content.action, {
      count: carriedItemCount(content.action),
      footer: [chord, "Использовать предмет из сумки"].filter(Boolean),
    });
  }
  if (content.type === ACTION_BUTTON_MACRO) {
    const macro = macroAt(content.action);
    return macro
      ? {
        title: macro.name,
        lines: [chord, ...macroLines(macro.body)].filter(Boolean),
        footer: [`Макрос, слот ${content.action}`],
      }
      : {
        title: `Макрос ${content.action}`,
        lines: [chord].filter(Boolean),
        footer: ["Этого макроса больше нет"],
      };
  }
  return {
    title: unknownLabel("предмет", content.action),
    lines: [chord].filter(Boolean),
    footer: ["Наборы экипировки с панели пока не надеваются"],
  };
}

/** Redraws the slots. Cheap enough to call whenever the bars or the spell book change. */
export function showActionBar(): void {
  build();
  requestSlotMetadata();
  drawRow(slots, page);
  for (const bar of EXTRA_ACTION_BARS) {
    const row = extraRows.get(bar.id);
    if (!row) continue;
    // Hidden rows are not drawn: a bar the player has switched off costs nothing.
    row.element.hidden = !settingOn(EXTRA_BAR_SETTINGS[bar.id]);
    if (!row.element.hidden) drawRow(row.buttons, actionPage(bar.base), bar.id);
  }
  publishSideWidth();
  publishBottomBars();
}

/** One row of twelve, whichever bar it belongs to. */
function drawRow(buttons: readonly IconButton[], barPage: number, bar?: ExtraActionBar): void {
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    const button = buttons[column]!;
    const content = contentOf(column, barPage);
    const key = slotKey(column, bar);
    if (!content) {
      button.root.dataset["empty"] = "";
      delete button.root.dataset["count"];
      button.setContent({ key, title: `Слот ${column + 1} пуст` });
      button.setCooldown(0);
      button.setUsable(true);
      continue;
    }
    delete button.root.dataset["empty"];
    if (content.type === ACTION_BUTTON_SPELL) {
      delete button.root.dataset["count"];
      const metadata = game.spells.get(content.action);
      // Titled even while unknown, so a slot that holds something is never mistaken for one that
      // does not — which is what made this defect look like an empty bar rather than a slow one.
      button.setContent({
        icon: spellIcon(content.action),
        key,
        title: metadata ? undefined : "Данные заклинания загружаются",
      });
    } else if (content.type === ACTION_BUTTON_ITEM) {
      // The icon comes from the item row, which is already loaded for the bags: before this a bar
      // slot holding an item was a letter on a dark square, indistinguishable from an empty one.
      const metadata = game.itemMetadata?.get(content.action);
      button.setContent({
        icon: metadata && game.itemMetadata ? game.itemMetadata.iconUrl(metadata) : undefined,
        key,
      });
      const count = carriedItemCount(content.action);
      if (count > 1) button.root.dataset["count"] = String(count);
      else delete button.root.dataset["count"];
    } else if (content.type === ACTION_BUTTON_MACRO) {
      delete button.root.dataset["count"];
      // A macro has no icon in this client, so it shows what the original client shows when a
      // macro has none: the first letters of its name. Before this it was indistinguishable from
      // an empty slot.
      button.setContent({ label: macroLabel(macroAt(content.action), content.action), key });
    } else {
      delete button.root.dataset["count"];
      button.setContent({ key });
    }
    if (content.type !== ACTION_BUTTON_SPELL) {
      button.setCooldown(0);
      button.setUsable(true);
    }
  }
}

/** Total stack carried in usable bags; moving a stack must not change the action button. */
function carriedItemCount(entry: number): number {
  const inventory = game.world ? playerInventory(game.world.state) : undefined;
  if (!inventory) return 0;
  return [...inventory.backpack, ...inventory.bags.flatMap((bag) => bag.slots), ...inventory.keyring]
    .filter((slot) => slot.item !== undefined && worldObject.entry(slot.item) === entry)
    .reduce((total, slot) => total + stackCount(slot), 0);
}

/** Called once a frame: the cooldown sweeps, and whether a slot can be pressed at all. */
export function updateActionBar(now: number): void {
  const world = game.world;
  if (slots.length === 0 || !world) return;
  updateRow(slots, page, now);
  for (const bar of EXTRA_ACTION_BARS) {
    const row = extraRows.get(bar.id);
    if (row && !row.element.hidden) updateRow(row.buttons, actionPage(bar.base), now);
  }
}

function updateRow(buttons: readonly IconButton[], barPage: number, now: number): void {
  const world = game.world;
  if (!world) return;
  const globalRemaining = Math.max(0, game.globalCooldownUntil - now);
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    const button = buttons[column]!;
    const content = contentOf(column, barPage);
    if (!content || content.type !== ACTION_BUTTON_SPELL) {
      button.setCooldown(0);
      continue;
    }
    const metadata = game.spells.get(content.action);
    const own = world.cooldownRemaining(content.action, now);
    const ownState = world.cooldownState(content.action);
    const gcdDuration = metadata?.startRecoveryTime ?? 0;
    // The old code used `own + 1` as the duration on every frame. That makes the sweep start over
    // at almost 100% every frame. Prefer the stable start/duration captured by WorldClient; the
    // authored total is only a fallback for cooldowns whose packet has not supplied a snapshot.
    const ownDuration = cooldownDuration(
      metadata?.recoveryTime, metadata?.categoryRecoveryTime,
    );
    // The longer of the two decides the sweep: a spell on its own cooldown is not freed by the
    // global one running out.
    const view = cooldownView(
      now, own, ownDuration, gcdDuration > 0 ? globalRemaining : 0, gcdDuration, ownState,
    );
    button.setCooldown(view.fraction, cooldownLabel(view.remaining));
    // The same rule the key press asks, so the grey and the refusal cannot disagree.
    button.setUsable(slotBlockedBy(column, now, barPage) === "");
  }
}

/** What the character has to spend, of whichever power it actually uses. */
/** Which page the bar shows. Shift and a number switch pages, as in the original client. */
export function turnActionPage(next: number): void {
  page = Math.max(0, Math.min(PAGES - 1, next));
  showActionBar();
}
