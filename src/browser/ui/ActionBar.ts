import {
  ACTIONBAR_MAIN_PAGES, ACTION_BUTTONS_PER_PAGE, ACTION_BUTTON_EQUIPMENT_SET, ACTION_BUTTON_ITEM,
  ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL, EXTRA_ACTION_BARS, actionPage, actionSlot, bonusActionPage,
  type ExtraActionBar,
} from "../../world/ActionBarProtocol.js";
import { game } from "../game/Context.js";
import { bonusBarHooks, currentBonusBarOffset } from "../game/BonusBar.js";
import { playerInventory, stackCount } from "../Inventory.js";
import { macroAt, runMacro } from "./Macros.js";
import { wearEquipmentSetByIndex } from "./EquipmentSets.js";
import { macroLabel, macroLines } from "./MacroModel.js";
import { actionBar } from "./Dom.js";
import {
  IconButton, attachTooltip, cooldownDuration, cooldownLabel, cooldownView,
  type TooltipContent,
} from "./Widgets.js";
import { spellIconUrl } from "./IconImage.js";
import { castSpell, highestKnownRank, spellTooltip } from "./Spellbook.js";
import { itemUseSpellId, requestInventoryItemUse } from "../game/GroundTarget.js";
import { ITEM_EQUIP_COOLDOWN_MS } from "../../world/ItemProtocol.js";
import { spellButtonUsable } from "../SpellMetadata.js";
import { spellPowerAvailable } from "../SpellCastGuard.js";
import { globalCooldownEndFor } from "../game/PredictedGlobalCooldown.js"; // L13 5.30
import { globalCooldownSpanFor } from "../game/PredictedGlobalCooldown.js"; // L13-review 5.30
import { ensureSpellNames } from "./SpellNames.js";
import { mainPageViewable } from "./ActionBarStockLayout.js"; // L7 4.16b
// 11.02-IF-review: page 11 under possession is the possessed unit's bar (PossessActionBar.ts).
import {
  drawPossessSlot, possessKeyPage, possessMirrors, possessSlotTooltip, pressPossessSlot, updatePossessSlot,
} from "./PossessActionBar.js";
import { settingOn } from "./Settings.js";
import { worldObject } from "../../world/Fields.js";
import { MELEE_AUTO_ATTACK_SPELL_ID } from "../../world/WorldClient.js";
import { ACTION_BAR_SLOTS, bindingsOf, describeChord, EXTRA_ACTION_BAR_SLOTS } from "../input/Bindings.js";
import { unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import { notifyHudLayout } from "../GameWindows.js";
import { NATIVE_LANES_REPLACED, nativeHudReplaced } from "./NativeHudReplacement.js";
import { beginIconDrag } from "./DragGhost.js";
import {
  ACTION_DRAG_FORMAT, itemActionDragPayload as itemDrag, parseActionDrop, slotDragPayload, spellDragPayload,
} from "./ActionDrag.js";

/**
 * The action bar: twelve slots, driven by what the server says the player put there.
 *
 * `SMSG_ACTION_BUTTONS` was among the opcodes the world loop dropped, so the client had no bar at
 * all — every spell had to be cast from the book. The bar the server keeps is 144 slots, twelve
 * pages of twelve; this shows one page and switches with Shift and a number, which is what the
 * original client's paging keys do.
 */
const PAGES = ACTIONBAR_MAIN_PAGES;

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

/** A main-row column's page when the bonus rule answers `bonusPage`: the key-bar override where it answers. */
function mainColumnPage(column: number, bonusPage: number): number {
  // 11.02-IF-review: the possess bar's page 11 for every column (GetBonusBarOffset 5, GetActionBarPage 1).
  return possessKeyPage() ?? bonusBarHooks.keyBarOverride?.(column) ?? bonusPage;
}

/**
 * The page one main-row column shows and its key presses: the paging keys' page, except that on the
 * first one a stance, a form or stealth puts its bonus page there, as stock `ActionButton_CalculateAction`
 * does. `getActionBarPage` keeps answering the paging keys' page, as stock `GetActionBarPage` does.
 */
function mainBarPage(column: number): number {
  return mainColumnPage(column, bonusActionPage(page, currentBonusBarOffset()));
}

/**
 * The page each main-row column was drawn from. `refreshMainPages` brings it up to date in place and
 * says whether a column moved: that is how a frame notices a stance, a form, stealth or a key-bar
 * override coming or going, none of which has an event of its own here.
 */
const mainPages: number[] = Array.from({ length: ACTION_BUTTONS_PER_PAGE }, () => 0);
const mainPageOf = (column: number): number => mainPages[column]!;

function refreshMainPages(): boolean {
  const bonusPage = bonusActionPage(page, currentBonusBarOffset());
  let moved = false;
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    const next = mainColumnPage(column, bonusPage);
    if (next === mainPages[column]) continue;
    mainPages[column] = next;
    moved = true;
  }
  return moved;
}

const slots: IconButton[] = [];
/**
 * The four native extra rows, each a row of the server's 144 slots pinned to a fixed page.
 *
 * L7 4.16b: those are stock's multi-bar pages 6, 5, 3 and 4 (`ACTION_BAR_BASES`), so a row shows the
 * buttons the stock MultiBarBottomLeft, MultiBarBottomRight, MultiBarRight and MultiBarLeft show; until
 * 4.16b they stood on pages 7–10, the bonus bars of stances, forms and stealth, and what players had
 * placed there is copied over once (ActionBarAccountSync.ts). Every function here that takes a column
 * takes its page too, which is all an extra row needed.
 */
const extraRows = new Map<ExtraActionBar, { element: HTMLElement; buttons: IconButton[]; pageOf: () => number }>();
/** Which setting shows each, in the order they are stacked. */
export const EXTRA_BAR_SETTINGS: Readonly<Record<ExtraActionBar, string>> = { // L7 3.32: exported
  bottomLeft: "actionBarBottomLeft",
  bottomRight: "actionBarBottomRight",
  right: "actionBarRight",
  right2: "actionBarRight2",
};

/**
 * L7 3.32: once the character's toggles byte rules the rows (`PLAYER_FIELD_BYTES` byte 2, the bits
 * stock's GetActionBarToggles reads — Wow.exe 0x5a8790), it answers here; before that, and under the
 * stock interface, the settings do.
 */
let extraBarSource: (() => number | undefined) | undefined;

export function setExtraBarVisibility(source: (() => number | undefined) | undefined): void {
  extraBarSource = source;
}

/** Whether one extra row is shown. L7 3.32. */
export function extraBarShown(bar: ExtraActionBar): boolean {
  const bits = extraBarSource?.();
  if (bits === undefined) return settingOn(EXTRA_BAR_SETTINGS[bar]);
  const index = EXTRA_ACTION_BARS.findIndex((entry) => entry.id === bar);
  return index >= 0 && (bits & (1 << index)) !== 0;
}

/** L7 4.16b: a main page the paging keys may show — not one a shown extra row already shows. */
export function actionPageViewable(page0: number): boolean {
  return mainPageViewable(page0, extraBarShown);
}

/**
 * Which of the four stand across the bottom and which stand on end at the right edge.
 *
 * The original client's own arrangement, and the names say it: the two «bottom» bars are rows
 * above the main one, the two «right» bars are columns down the right-hand side. All four used to
 * be stacked as rows above the main bar, which is four rows of twelve buttons in the middle of the
 * screen — 500px wide and 176px tall before the world starts.
 */
const VERTICAL_BARS: ReadonlySet<ExtraActionBar> = new Set<ExtraActionBar>(["right", "right2"]);


/** One button, wired to a fixed row. The main bar passes the live page; an extra bar its own. */
function buildButton(column: number, barPage: () => number, bar?: ExtraActionBar): IconButton {
  const button = new IconButton({ key: slotKey(column, bar), onClick: () => useSlot(column, barPage()) });
  button.root.classList.add("ui-action-button");
  // Attached once and reading the slot when it is shown: the contents change far more often
  // than the button does, and a `title` on a greyed-out slot is never displayed at all.
  attachTooltip(button.root, () => slotTooltip(column, barPage(), bar));
  button.root.draggable = true;
  button.root.addEventListener("dragstart", (event) => {
    const content = contentOf(column, barPage());
    if (!content) {
      event.preventDefault();
      return;
    }
    // Where it came from, so a slot-to-slot drag can move rather than copy (ui/ActionDrag.ts).
    event.dataTransfer?.setData(...slotDragPayload(content, actionSlot(barPage(), column)));
    // 4.02: the icon on the cursor, not a snapshot of the button with its key and cooldown.
    beginIconDrag(event, button.root);
  });
  button.root.addEventListener("dragover", (event) => event.preventDefault());
  button.root.addEventListener("drop", (event) => {
    event.preventDefault();
    // 4.05: read strictly — a macro from its window, a spell, an item, another slot; anything else
    // (another page's text) is ignored instead of throwing out of the handler.
    const dropped = parseActionDrop(event.dataTransfer?.getData(ACTION_DRAG_FORMAT));
    if (dropped) dropSlot(column, dropped, barPage());
  });
  // Right-click empties a slot, which is the only way to take something off a bar.
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
    const pageOf = (): number => actionPage(bar.base);
    const buttons = Array.from({ length: ACTION_BUTTONS_PER_PAGE }, (_, slot) => buildButton(slot, pageOf, bar.id));
    element.append(...buttons.map((button) => button.root));
    (vertical ? side : bottom).append(element);
    extraRows.set(bar.id, { element, buttons, pageOf });
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
    VERTICAL_BARS.has(bar.id) && extraBarShown(bar.id)).length; // L7 3.32
  document.documentElement.style.setProperty("--side-bars", String(shown));
}

/** Publish enabled horizontal rows for neighbouring HUD surfaces such as chat. */
function publishBottomBars(): void {
  const shown = EXTRA_ACTION_BARS.filter((bar) =>
    !VERTICAL_BARS.has(bar.id) && extraBarShown(bar.id)).length; // L7 3.32
  document.documentElement.style.setProperty("--bottom-bars", String(shown));
  const stack = document.getElementById("action-bar-extras");
  if (stack) stack.hidden = shown === 0;
  notifyHudLayout();
}

function build(): void {
  buildExtraRows();
  if (slots.length > 0) return;
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    // Every press, drag, drop, right-click and tooltip of the main row asks for its page then: the
    // paging keys move it, and on the first page so do a stance, a form and stealth.
    const button = buildButton(column, () => mainBarPage(column));
    slots.push(button);
    actionBar.append(button.root);
  }
}

/**
 * Puts what was dragged into a slot. A drag from another slot is a move: the server holds one
 * action per slot and nothing tells it the old one is gone unless the client says so.
 */
function dropSlot(
  column: number, dropped: { action: number; type: number; from?: number }, barPage = mainBarPage(column),
): void {
  const world = game.world;
  if (!world || dropped.action <= 0) return;
  // 11.02-IF-review: nothing is dropped on the possess page (0x005abbc0 skips 0x78-0x83).
  if (possessMirrors(barPage)) return;
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
  return spellDragPayload(spellId);
}

/**
 * Called by the bags: an item dragged out of one can land on a bar too. What the bar stores is the
 * item's entry, not the slot it came from, which is why a bar slot survives the item being moved.
 */
export function itemActionDragPayload(entry: number): [string, string] {
  return itemDrag(entry);
}

function spellIcon(spellId: number): string | undefined {
  return spellIconUrl(game.spells.get(spellId)?.iconId ?? 0, game.gatewayOrigin);
}

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

/** What sits in one column of the page on screen. */
function contentOf(column: number, barPage = mainBarPage(column)): { action: number; type: number } | undefined {
  // 11.02-IF-review: the possess page holds the unit's words, never the character's slots 121-132.
  if (possessMirrors(barPage)) return undefined;
  const slot = actionSlot(barPage, column);
  return game.world?.actionButtons.find((button) => button.slot === slot);
}

/** Why a slot cannot be pressed right now, or an empty string when it can. */
function slotBlockedBy(column: number, now = performance.now(), barPage = mainBarPage(column)): string {
  const world = game.world;
  const content = contentOf(column, barPage);
  if (!world || !content) return "";
  if (content.type === ACTION_BUTTON_MACRO) {
    return macroAt(content.action) ? "" : `Макроса ${content.action} больше нет`;
  }
  if (content.type === ACTION_BUTTON_EQUIPMENT_SET) {
    return world.equipmentSets.some((set) => set.setId === content.action)
      ? "" : `Набора ${content.action + 1} больше нет`;
  }
  if (content.type === ACTION_BUTTON_ITEM) {
    const spellId = itemUseSpellId(world.itemTemplate(content.action));
    if (spellId !== undefined && Math.max(
      world.itemCooldownRemaining(spellId, now), world.cooldownRemaining(spellId, now),
    ) > 0) return "Восстанавливается";
    if (spellId !== undefined && world.isSpellOnHold?.(spellId)) return "Ещё не готово";
    return "";
  }
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
  // Held until its aura ends (Stealth after a stealthed login): the realm would answer NOT_READY.
  // Grey and refused, with nothing to sweep (WorldClient.isSpellOnHold).
  if (world.isSpellOnHold?.(content.action)) return "Ещё не готово";
  // L13 5.30: the guard's rule (SpellCastGuard.ts) — by StartRecoveryCategory; a row without it as before.
  if (globalCooldownEndFor(game, metadata) > now) return "Восстанавливается";
  if (!spellPowerAvailable(world, metadata)) return "Не хватает ресурса";
  return "";
}

/**
 * Presses one slot. Without a page it is the main row as shown — the bonus page under a stance, a
 * form or stealth — which is what keys 1 to = mean; the extra bars and stock `UseAction` pass theirs.
 */
export function useSlot(column: number, barPage = mainBarPage(column), button?: string): void {
  // 11.02-IF-review: under possession page 11 is the unit's bar (0x005abbc0 -> 0x005d4210).
  if (pressPossessSlot(column, barPage)) return;
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
    // The mouse button that pressed a stock action button (`UseAction`'s third argument), for `[btn:N]`.
    runMacro(content.action, button);
    return;
  }
  if (content.type === ACTION_BUTTON_EQUIPMENT_SET) {
    wearEquipmentSetByIndex(content.action);
    return;
  }
  if (content.type === ACTION_BUTTON_ITEM) {
    // The bar stores what to use, not where it is, so the item has to be found in the bags by its
    // entry — the same item can be in any slot, and moving it does not change the bar.
    const inventory = playerInventory(world.state);
    const held = [...(inventory?.equipment ?? []), ...(inventory?.backpack ?? []),
      ...(inventory?.keyring ?? []), ...(inventory?.bags ?? []).flatMap((bag) => bag.slots)]
      .find((slot) => slot.item !== undefined && worldObject.entry(slot.item) === content.action);
    if (held) requestInventoryItemUse(held, () => world.useItem(held.bag, held.slot, held.guid));
  }
}

/**
 * Replaces bar slots holding a lower rank with the highest known one.
 *
 * Runs when a spell is learned: the slot keeps pointing at the rank the player dragged there
 * while the book moved on. Only slots whose chain top is known and different move, and the
 * server validates the rewrite like any other `CMSG_SET_ACTION_BUTTON`.
 */
export function upgradeActionBarRanks(): void {
  const world = game.world;
  if (!world) return;
  for (const button of world.actionButtons) {
    if (button.type !== ACTION_BUTTON_SPELL) continue;
    const best = highestKnownRank(button.action);
    if (best !== button.action && world.knownSpells.some((spell) => spell.id === best)) {
      world.setActionButton(button.slot, best, button.type);
    }
  }
}

/** What one slot holds, the key that presses it, and how anything gets onto the bar at all. */
function slotTooltip(column: number, barPage = mainBarPage(column), bar?: ExtraActionBar): TooltipContent {
  const key = slotKey(column, bar);
  const chord = key ? `Клавиша: ${key}` : "";
  // 11.02-IF-review: the possessed unit's spell, command or stance on page 11.
  const possessed = possessSlotTooltip(column, barPage, chord);
  if (possessed) return possessed;
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
  refreshMainPages();
  drawRow(slots, mainPageOf);
  for (const bar of EXTRA_ACTION_BARS) {
    const row = extraRows.get(bar.id);
    if (!row) continue;
    // Hidden rows are not drawn: a bar the player has switched off costs nothing.
    row.element.hidden = !extraBarShown(bar.id); // L7 3.32: the toggles byte once known
    if (!row.element.hidden) drawRow(row.buttons, row.pageOf, bar.id);
  }
  publishSideWidth();
  publishBottomBars();
}

/** One row of twelve, whichever bar it belongs to; `pageOf` says which page each column shows. */
function drawRow(buttons: readonly IconButton[], pageOf: (column: number) => number, bar?: ExtraActionBar): void {
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    const button = buttons[column]!;
    const key = slotKey(column, bar);
    // 11.02-IF-review: the possess page draws the unit's bar.
    if (drawPossessSlot(button, column, pageOf(column), key)) continue;
    const content = contentOf(column, pageOf(column));
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
  // Under the stock MainMenuBar and MultiBars these rows are hidden, and a sweep moving on them —
  // a `--sweep` write per slot per frame of every global cooldown — is drawn for nobody. The rows
  // are redrawn from the world's state on the first frame after the stock owner lets them go.
  if (nativeHudReplaced(NATIVE_LANES_REPLACED)) return;
  // Taking a stance, a form or stealth — or leaving one — moves the main row to another page with
  // no event of its own here; twelve integers compared a frame notice it (the offset behind them is
  // cached). Only the main row is redrawn: nothing else moved, and the last `showActionBar` already
  // asked for every slot's row, the bonus pages' included.
  if (refreshMainPages()) drawRow(slots, mainPageOf);
  updateRow(slots, mainPageOf, now);
  for (const bar of EXTRA_ACTION_BARS) {
    const row = extraRows.get(bar.id);
    if (row && !row.element.hidden) updateRow(row.buttons, row.pageOf, now);
  }
}

function updateRow(buttons: readonly IconButton[], pageOf: (column: number) => number, now: number): void {
  const world = game.world;
  if (!world) return;
  // L13-review 5.30: the global part is asked per slot below (by StartRecoveryCategory), no longer the shared end here.
  for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
    const button = buttons[column]!;
    const barPage = pageOf(column);
    if (updatePossessSlot(button, column, barPage, now, slotKey)) continue; // 11.02-IF-review
    const content = contentOf(column, barPage);
    if (!content || (content.type !== ACTION_BUTTON_SPELL && content.type !== ACTION_BUTTON_ITEM)) {
      button.setCooldown(0);
      if (content && content.type !== ACTION_BUTTON_SPELL) {
        button.setUsable(slotBlockedBy(column, now, barPage) === "");
      }
      continue;
    }
    if (content.type === ACTION_BUTTON_ITEM) {
      const spellId = itemUseSpellId(world.itemTemplate(content.action));
      const equip = spellId === undefined ? 0 : world.itemCooldownRemaining(spellId, now);
      const spell = spellId === undefined ? 0 : world.cooldownRemaining(spellId, now);
      const metadata = spellId === undefined ? undefined : game.spells.get(spellId);
      const view = spellId === undefined ? { remaining: 0, fraction: 0 } : equip >= spell && equip > 0
        ? { remaining: equip, fraction: Math.min(1, equip / ITEM_EQUIP_COOLDOWN_MS) }
        : cooldownView(now, spell, cooldownDuration(metadata?.recoveryTime, metadata?.categoryRecoveryTime),
          0, 0, world.cooldownState(spellId));
      button.setCooldown(view.fraction, cooldownLabel(view.remaining));
      button.setUsable(slotBlockedBy(column, now, barPage) === "");
      continue;
    }
    const metadata = game.spells.get(content.action);
    const own = world.cooldownRemaining(content.action, now);
    const ownState = world.cooldownState(content.action);
    // L13-review 5.30: the press's rule (slotBlockedBy, SpellCastGuard.ts) — the global cooldown of the row's own
    // category and that entry's own length (0x00807980); unknown length: the row's StartRecoveryTime, as before.
    // Numbers only, the model's answer remembered between slots: nothing allocated per frame.
    const globalEnd = globalCooldownEndFor(game, metadata); // L13-review 5.30
    const globalRemaining = globalEnd > now ? globalEnd - now : 0; // L13-review 5.30
    const gcdDuration = globalRemaining > 0 ? globalCooldownSpanFor(game, metadata) || (metadata?.startRecoveryTime ?? 0) : 0; // L13-review 5.30
    // The old code used `own + 1` as the duration on every frame. That makes the sweep start over
    // at almost 100% every frame. Prefer the stable start/duration captured by WorldClient; the
    // authored total is only a fallback for cooldowns whose packet has not supplied a snapshot.
    const ownDuration = cooldownDuration(
      metadata?.recoveryTime, metadata?.categoryRecoveryTime,
    );
    // The longer of the two decides the sweep: a spell on its own cooldown is not freed by the
    // global one running out.
    const view = cooldownView(
      now, own, ownDuration, globalRemaining, gcdDuration, ownState, // L13-review 5.30: was `gcdDuration > 0 ? shared : 0`
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

/** Stock FrameXML uses 1-based pages; keep its displayed page aligned with keyboard actions. */
export function getActionBarPage(): number {
  return page + 1;
}
