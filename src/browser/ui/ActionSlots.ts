/**
 * The action slots behind whatever draws them: the page the paging keys hold, what a column holds, why
 * it cannot be pressed, and the press. The server's 144 slots are `world.actionButtons`; no page here.
 * The stock MainMenuBar's `UseAction`, the keys 1 to = and the HTML rows (ActionBar.ts) all come here.
 */

import {
  ACTIONBAR_MAIN_PAGES, ACTION_BUTTON_EQUIPMENT_SET, ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL,
  EXTRA_ACTION_BARS, actionSlot, bonusActionPage, type ExtraActionBar,
} from "../../world/ActionBarProtocol.js";
import { worldObject } from "../../world/Fields.js";
import { MELEE_AUTO_ATTACK_SPELL_ID } from "../../world/WorldClient.js";
import { bonusBarHooks, currentBonusBarOffset } from "../game/BonusBar.js";
import { game } from "../game/Context.js";
import { itemUseSpellId, requestInventoryItemUse } from "../game/GroundTarget.js";
import { itemUseCooldownBlock } from "../game/ItemUseCooldown.js"; // 3.47 (12.10)
import { globalCooldownEndFor } from "../game/PredictedGlobalCooldown.js"; // L13 5.30
import { playerInventory } from "../Inventory.js";
import { refuseSpellOnCooldown, spellPowerAvailable } from "../SpellCastGuard.js"; // 3.47: + the refusal
import { spellButtonUsable } from "../SpellMetadata.js";
import { redrawActionBar } from "./HtmlWindowHosts.js";
import { mainPageViewable } from "./ActionBarStockLayout.js"; // L7 4.16b
import { wearEquipmentSetByIndex } from "./EquipmentSetUse.js";
import { runMacro } from "./MacroRun.js";
import { macroAt } from "./MacroStore.js";
// 11.02-IF-review: page 11 under possession is the possessed unit's bar (PossessActionBar.ts).
import { possessKeyPage, possessMirrors, pressPossessSlot } from "./PossessActionBar.js";
import { settingOn } from "./Settings.js";
import { castSpell } from "./SpellCast.js";
import { highestKnownRank } from "./SpellData.js";
import { ensureSpellNames } from "./SpellNames.js";

const PAGES = ACTIONBAR_MAIN_PAGES;

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
export function mainBarPage(column: number): number {
  return mainColumnPage(column, bonusActionPage(page, currentBonusBarOffset()));
}

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
  if (spells.length > 0) ensureSpellNames(spells, refreshActionSlots);
  if (items.length > 0 && game.itemMetadata) {
    const client = game.itemMetadata;
    void client.load(items).then((changed) => {
      if (changed && game.itemMetadata === client) refreshActionSlots();
    });
  }
}

/**
 * The slots or what is known about them changed: asks for the rows they now need, whatever draws
 * them, and has the HTML rows redrawn if they exist. The request lives here and not in the painter
 * because nothing else asks for it: the stock bars read `game.spells` and `game.itemMetadata` too.
 */
export function refreshActionSlots(): void {
  requestSlotMetadata();
  redrawActionBar();
}

/** What sits in one column of the page on screen. */
export function contentOf(column: number, barPage = mainBarPage(column)): { action: number; type: number } | undefined {
  // 11.02-IF-review: the possess page holds the unit's words, never the character's slots 121-132.
  if (possessMirrors(barPage)) return undefined;
  const slot = actionSlot(barPage, column);
  return game.world?.actionButtons.find((button) => button.slot === slot);
}

/** `slotBlockedBy`'s two cooldown reasons: recovering (its timer, its category's, the global cooldown) and held. */
const SLOT_RECOVERING = "Восстанавливается";
const SLOT_HELD = "Ещё не готово";

/** Why a slot cannot be pressed right now, or an empty string when it can. */
export function slotBlockedBy(column: number, now = performance.now(), barPage = mainBarPage(column)): string {
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
    // 3.47 (12.10): the item's use refusal's own question (0x00739650 asks under the item's category for its spell).
    const template = world.itemTemplate(content.action);
    const spellId = itemUseSpellId(template);
    const block = spellId === undefined ? undefined : itemUseCooldownBlock(world, template, spellId, now);
    return block === "cooldown" ? SLOT_RECOVERING : block === "hold" ? SLOT_HELD : "";
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
  if (world.cooldownRemaining(content.action, now) > 0) return SLOT_RECOVERING;
  // Held until its aura ends (Stealth after a stealthed login): the realm would answer NOT_READY.
  // Grey and refused, with nothing to sweep (WorldClient.isSpellOnHold).
  if (world.isSpellOnHold?.(content.action)) return SLOT_HELD;
  // L13 5.30: the guard's rule (SpellCastGuard.ts) — by StartRecoveryCategory; a row without it as before.
  if (globalCooldownEndFor(game, metadata) > now) return SLOT_RECOVERING;
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
  // 3.47 (12.10): but a press on a recovering or held slot is no silent one. Wow.exe's UseAction (0x005abbc0) casts
  // the slot's spell or uses its item through the request builder 0x0080cce0, whose check 0x00739650 refuses it
  // NOT_READY or ITEM_NOT_READY with the error frame's words, UNIT_SPELLCAST_FAILED and the combat log's line. A spell
  // says so here (SpellCastGuard.ts `refuseSpellOnCooldown`); an item goes on to its use, which refuses it with its
  // words before any packet (GroundTarget.requestItemUse → ItemUseCooldown.ts) — an item not carried says nothing.
  const blocked = slotBlockedBy(column, performance.now(), barPage);
  const cooling = blocked === SLOT_RECOVERING || blocked === SLOT_HELD;
  if (blocked && !(cooling && content.type === ACTION_BUTTON_ITEM)) {
    if (cooling && content.type === ACTION_BUTTON_SPELL) refuseSpellOnCooldown(world, content.action);
    return;
  }
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

/** Which page the bar shows. Shift and a number switch pages, as in the original client. */
export function turnActionPage(next: number): void {
  page = Math.max(0, Math.min(PAGES - 1, next));
  refreshActionSlots();
}

/** Stock FrameXML uses 1-based pages; keep its displayed page aligned with keyboard actions. */
export function getActionBarPage(): number {
  return page + 1;
}
