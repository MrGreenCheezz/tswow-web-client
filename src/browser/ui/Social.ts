import { formatMoney, unknownLabel } from "./Format.js";
import { itemTooltipFor } from "./ItemTooltip.js";
import {
  AUCTION_SORT_PRICE_ASC, AuctionEntry, clampAuctionPage, isLeadingBid, nextBid, sortAuctionEntries,
} from "../../world/AuctionProtocol.js";
import { player } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import {
  LFG_ROLE_DAMAGE, LFG_ROLE_HEALER, LFG_ROLE_LEADER, LFG_ROLE_TANK, lockReasonText, rolesText,
  splitDungeonEntry, type LfgReward,
} from "../../world/LfgProtocol.js";
import {
  LfgDungeonClient, filterLfgDungeons, groupLfgDungeons, isSpecificLfgDungeon, lfgDungeonBackgroundPath, lfgDungeonEntry,
  lfgDungeonHeroic, lfgEntriesForSelection, parseManualDungeonIds, setVisibleLfgSelection,
  type LfgDungeon, type LfgDungeonCatalog, type LfgDungeonFilter,
} from "../LfgDungeons.js";
import { WorldClient } from "../../world/WorldClient.js";
import { firstFreeTradeSlot } from "../../world/TradeProtocol.js";
import { game } from "../game/Context.js";
import { showUnitFrames } from "./UnitFrames.js";
import { ITEM_DRAG_FORMAT, readItemDrag } from "./ItemSlots.js";
import { clickTradeEnchantSlot } from "./ItemTargetClick.js";
import { setTip, attachTooltip, confirmPanel } from "./Widgets.js";
import { nativeString } from "./Strings.js";
import { formatLfgAverage, formatLfgQueued, formatLfgWait } from "./LfgWait.js";
import { LfgQueueClock } from "./LfgQueueClock.js"; // L7 4.14
import { registerInteractionPromptNames } from "./InteractionPrompts.js";

import { systemLine } from "./Chat.js";
import {
  auctionList, auctionMessage, auctionWindow, duelText, duelWindow, groupAccept, groupInviteText,
  groupInviteWindow,
  lfgCatalogStatus, lfgClearSelection, lfgDamage, lfgDamageIcon, lfgDungeons, lfgDungeonList,
  lfgDungeonSearch, lfgDungeonSort, lfgExpansion, lfgHealer, lfgHealerIcon, lfgHeroicOnly, lfgJoin,
  lfgLeader, lfgLeaderIcon, lfgLeave, lfgLevelOnly, lfgMessage, lfgProposalBanner, lfgProposalBox,
  lfgProposalText, lfgQueue, lfgRandomBanner, lfgRandomDescription, lfgRandomList, lfgRandomName,
  lfgRandomPane,
  lfgRefresh, lfgRewardNote, lfgRewards, lfgSelectVisible, lfgSpecificPane, lfgTank, lfgTankIcon,
  lfgTeleport, lfgType, lfgWindow,
  status, tradeAccept, tradeMessage, tradeMine, tradeOfferFields, tradeTheirTitle,
  tradeTheirs, tradeTitle, tradeWindow,
} from "./Dom.js";
import { loadNativeTexture } from "./NativeUiSkin.js";
import { playUiSound } from "../game/GameSounds.js";
import { frameXmlLfdPublished, toggleFrameXmlLfd } from "../framexml/FrameXmlLfdController.js";
import { frameXmlPopupsPublished } from "../framexml/FrameXmlPopupsController.js";
import { frameXmlTradePublished } from "../framexml/FrameXmlTradeController.js";
import { frameXmlAuctionOwnsWindow } from "../framexml/FrameXmlAuctionController.js";

/** Group, mail, trade, auction, dungeon finder and duels. The guild has its own module now. */

// Unlike the event-driven panels below, LFG has a real micro-button owner: the player can open
// the empty queue window before joining anything.  Keep that intent separate from server state so
// showLfg() does not immediately close the window on its next world tick.
let lfgWindowRequested = false;
/**
 * The proposal the chime already rang for. Identity, like the loot chime's: a fresh proposal
 * object is a new invitation, and every repaint of the one on screen is not.
 */
let chimedLfgProposal: object | undefined;

export function showGroup(): void {
  const world = game.world;
  const invite = world?.groupInvite;

  // The stock PARTY_INVITE dialog asks while the popup owner is published (FrameXmlPopups.ts).
  groupInviteWindow.hidden = !invite || frameXmlPopupsPublished();
  if (invite) {
    groupInviteText.textContent = invite.canAccept
      ? `${invite.inviterName} приглашает вас в группу.`
      : `${invite.inviterName} приглашает вас в группу, но принять сейчас нельзя.`;
    groupAccept.disabled = !invite.canAccept;
  }

  if (world?.groupMessage) systemLine(world.groupMessage.text);
  if (world) world.groupMessage = undefined;

  // The frames themselves belong to slice I2 and are painted by `showUnitFrames`: a party frame
  // and a raid slot are the same widget as the boss, focus and arena frames, and drawing one of
  // them here by hand was how this file ended up with its own idea of what a health bar is.
  showUnitFrames();
}

/** `TRADE_SLOT_NONTRADED`: the seventh row, whose item stays with its owner and takes enchants. */
const TRADE_ENCHANT_SLOT_INDEX = 6;

export function tradeItemList(
  target: HTMLElement,
  offer: { money: number; spellId?: number; items: Array<{ slot: number; itemId: number; count: number }> } | undefined,
  options?: {
    onClearSlot?: (slot: number) => void;
    /** The trader's «will not be traded» row (slot 6) takes a spell waiting for an item (2.05). */
    onEnchantSlot?: (row: HTMLElement) => boolean;
  },
): void {
  if (!offer) {
    target.replaceChildren();
    return;
  }
  const rows: HTMLElement[] = offer.items.map((item) => {
    const row = document.createElement("div");
    // A trade offer never ordered a row of its own, so what the other side is offering read as
    // «Предмет 4306» unless the player happened to own one already.
    const template = item.itemId === 0 ? undefined : game.world?.itemTemplate(item.itemId);
    const metadata = item.itemId === 0 ? undefined : game.itemMetadata?.get(item.itemId);
    row.className = `trade-item quality-${template?.quality ?? metadata?.quality ?? 0}`;
    const name = item.itemId === 0 ? "Предмет из сумки"
      : template?.name || metadata?.name || unknownLabel("предмет", item.itemId);
    row.textContent = item.count > 1 ? `${name} ×${item.count}` : name;
    if (item.itemId !== 0) attachTooltip(row, () => itemTooltipFor(item.itemId, { count: item.count, footer: ["В обмене"] }));
    const onEnchantSlot = options?.onEnchantSlot;
    if (onEnchantSlot !== undefined && item.slot === TRADE_ENCHANT_SLOT_INDEX) {
      row.addEventListener("click", (event) => {
        if (onEnchantSlot(row)) event.stopPropagation();
      });
    }
    if (options?.onClearSlot !== undefined) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "trade-clear";
      clear.textContent = "×";
      setTip(clear, "Снять с обмена");
      clear.setAttribute("aria-label", `Снять ${name} с обмена`);
      clear.addEventListener("click", () => options.onClearSlot?.(item.slot));
      row.append(clear);
    }
    return row;
  });
  if ((offer.spellId ?? 0) !== 0) {
    const spell = document.createElement("div");
    spell.className = "trade-item trade-spell";
    const metadata = game.spells.get(offer.spellId!);
    spell.textContent = `Чары: ${metadata?.name ?? `заклинание ${offer.spellId}`}`;
    rows.push(spell);
  }
  if (offer.money > 0) {
    const money = document.createElement("div");
    money.className = "trade-item";
    money.textContent = formatMoney(offer.money);
    rows.push(money);
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Пусто";
    rows.push(empty);
  }
  target.replaceChildren(...rows);
}

export function selectedLfgRoles(): number {
  return (lfgLeader.checked ? LFG_ROLE_LEADER : 0) | (lfgTank.checked ? LFG_ROLE_TANK : 0)
    | (lfgHealer.checked ? LFG_ROLE_HEALER : 0) | (lfgDamage.checked ? LFG_ROLE_DAMAGE : 0);
}

function updateLfgJoinAvailability(): void {
  const hasCombatRole = (selectedLfgRoles() & (LFG_ROLE_TANK | LFG_ROLE_HEALER | LFG_ROLE_DAMAGE)) !== 0;
  lfgJoin.disabled = !hasCombatRole;
  setTip(lfgJoin, hasCombatRole ? "Начать поиск группы" : "Выберите роль: танк, лекарь или урон");
}

/**
 * Stock role art, resolved from the client's own FrameXML rather than guessed.
 *
 * Roles: `Interface\LFGFrame\UI-LFG-ICON-ROLES` (256x256, 67x67 cells, `GetTexCoordsForRole`
 * in LFGFrame.lua: guide 1,1 / tank 1,2 / healer 2,1 / damager 2,2). Backgrounds:
 * `Interface\LFGFrame\UI-LFG-ICONS-ROLEBACKGROUNDS` (256x128, 75x75 cells,
 * `GetBackgroundTexCoordsForRole`: healer 1,1 / tank 2,1 / damager 3,1, guide has none).
 * The checkbox is the stock `UI-CheckBox-Up/Check` pair anchored bottom-left, like
 * `LFGRoleButtonTemplate` (48px art, 24px box at -5,-5). Heroic badge:
 * `Interface\LFGFrame\UI-LFG-ICON-HEROIC` cropped to (0-0.5, 0-0.625), 16x20.
 * Reward ring: `Interface\LFGFrame\UI-LFG-ICON-REWARDRING` at (0-0.675)^2 over a 30px icon.
 */
const LFG_ROLE_ICON_PATH = "Interface\\LFGFrame\\UI-LFG-ICON-ROLES.blp";
const LFG_ROLE_BACKGROUND_PATH = "Interface\\LFGFrame\\UI-LFG-ICONS-ROLEBACKGROUNDS.blp";
const LFG_HEROIC_ICON_PATH = "Interface\\LFGFrame\\UI-LFG-ICON-HEROIC.blp";
const LFG_REWARD_RING_PATH = "Interface\\LFGFrame\\UI-LFG-ICON-REWARDRING.blp";
const LFG_LOCK_ICON_PATH = "Interface\\LFGFrame\\UI-LFG-ICON-LOCK.blp";
const LFG_RANDOM_BANNER_PATH = "Interface\\LFGFrame\\UI-LFG-BACKGROUND-RANDOMDUNGEON.blp";
const LFG_FALLBACK_BANNER_PATH = "Interface\\LFGFrame\\UI-LFG-BACKGROUND-Deadmines.blp";
const LFG_CHECKBOX_PATH = "Interface\\Buttons\\UI-CheckBox-Up.blp";
const LFG_CHECKBOX_CHECK_PATH = "Interface\\Buttons\\UI-CheckBox-Check.blp";
/** Grid cell (column, row), 1-based, matching `GetTexCoordsByGrid(col, row, w, h, cell, cell)`. */
const LFG_ROLE_ICON_CELLS: Readonly<Record<string, readonly [number, number]>> = {
  leader: [1, 1],
  tank: [1, 2],
  healer: [2, 1],
  damage: [2, 2],
};
/** Background cells; the guide/leader button has no background in the stock template. */
const LFG_ROLE_BACKGROUND_CELLS: Readonly<Record<string, readonly [number, number] | undefined>> = {
  leader: undefined,
  tank: [2, 1],
  healer: [1, 1],
  damage: [3, 1],
};
const ROLE_ATLAS_SIZE = 256;
const ROLE_CELL = 67;
const ROLE_BACKGROUND_WIDTH = 256;
const ROLE_BACKGROUND_HEIGHT = 128;
const ROLE_BACKGROUND_CELL = 75;

function texCoordsToBackground(column: number, row: number, atlas: number, cell: number): {
  size: string; position: string;
} {
  const scale = atlas / cell;
  const size = `${(scale * 100).toFixed(2)}% ${(scale * 100).toFixed(2)}%`;
  const max = scale - 1;
  const x = max <= 0 ? "50%" : `${(((column - 1) / max) * 100).toFixed(2)}%`;
  const y = max <= 0 ? "50%" : `${(((row - 1) / max) * 100).toFixed(2)}%`;
  return { size, position: `${x} ${y}` };
}

function texRectToBackground(left: number, right: number, top: number, bottom: number): {
  size: string; position: string;
} {
  const width = Math.max(1e-6, right - left);
  const height = Math.max(1e-6, bottom - top);
  return {
    size: `${(100 / width).toFixed(2)}% ${(100 / height).toFixed(2)}%`,
    position: `${((left / (1 - width)) * 100).toFixed(2)}% ${((top / (1 - height)) * 100).toFixed(2)}%`,
  };
}

function setCssVar(name: string, value: string): void {
  try {
    const style = document.documentElement?.style as CSSStyleDeclaration | undefined;
    style?.setProperty?.(name, value);
  } catch {
    // Test doubles without a CSSOM: the var is enhancement-only.
  }
}
/** The stock LFG corpus as blob object URLs, loaded once per gateway origin. */
interface LfgArt {
  roleIcon?: string;
  roleBackground?: string;
  heroic?: string;
  rewardRing?: string;
  checkbox?: string;
  checkboxCheck?: string;
  lock?: string;
}

const lfgArt: LfgArt = {};
let lfgArtOrigin = "";
let lfgArtAttempted = false;
let lfgRolePaintKey = "";

const LFG_ART_PATHS: ReadonlyArray<readonly [keyof LfgArt, string]> = [
  ["roleIcon", LFG_ROLE_ICON_PATH],
  ["roleBackground", LFG_ROLE_BACKGROUND_PATH],
  ["heroic", LFG_HEROIC_ICON_PATH],
  ["rewardRing", LFG_REWARD_RING_PATH],
  ["checkbox", LFG_CHECKBOX_PATH],
  ["checkboxCheck", LFG_CHECKBOX_CHECK_PATH],
  ["lock", LFG_LOCK_ICON_PATH],
];

/**
 * Fetches the stock LFG art once per origin, then repaints the window with it.
 *
 * A CSS background cannot use `nativeUiTextureUrl` directly: the request carries no `Origin`, a
 * cross-origin gateway refuses it, and the window silently falls back to flat colours — which is
 * exactly what "no icons" looks like. The blob loader gives every layer a same-document URL.
 */
function ensureLfgArt(): void {
  const origin = game.gatewayOrigin;
  if (!origin) return;
  if (lfgArtOrigin !== origin) {
    lfgArtOrigin = origin;
    lfgArtAttempted = false;
    for (const key of Object.keys(lfgArt)) delete lfgArt[key as keyof LfgArt];
  }
  if (lfgArtAttempted) return;
  lfgArtAttempted = true;
  void Promise.all(LFG_ART_PATHS.map(async ([key, path]) => {
    const url = await loadNativeTexture(origin, path);
    if (url && lfgArtOrigin === origin) lfgArt[key] = url;
  })).then(() => {
    if (lfgArtOrigin !== game.gatewayOrigin) return;
    paintLfgRoleIcons();
    if (!lfgWindow.hidden) showLfg();
  });
}

function setLayerBackground(layer: HTMLElement | null, url: string, size: string, position: string): void {
  if (!layer) return;
  if (!url) {
    layer.style.backgroundImage = "";
    return;
  }
  layer.style.backgroundImage = `url(${JSON.stringify(url)})`;
  layer.style.backgroundSize = size;
  layer.style.backgroundPosition = position;
  layer.style.backgroundRepeat = "no-repeat";
}

/** One stock role-atlas cell, cropped and painted on an element. */
function paintLfgRoleCell(element: HTMLElement, role: string): void {
  const [column, row] = LFG_ROLE_ICON_CELLS[role] ?? [2, 2];
  const crop = texCoordsToBackground(column, row, ROLE_ATLAS_SIZE, ROLE_CELL);
  element.dataset["lfgCrop"] = `${crop.size} ${crop.position}`;
  setLayerBackground(element, lfgArt.roleIcon ?? "", crop.size, crop.position);
}

function paintLfgRoleIcons(): void {
  ensureLfgArt();
  const key = [lfgArt.roleIcon, lfgArt.roleBackground, lfgArt.checkbox, lfgArt.checkboxCheck].join("|");
  if (key === lfgRolePaintKey) return;
  lfgRolePaintKey = key;
  setCssVar("--lfg-role-check-on", lfgArt.checkboxCheck ? `url(${JSON.stringify(lfgArt.checkboxCheck)})` : "none");
  const boxes: Array<[HTMLElement, string]> = [
    [lfgTankIcon, "tank"], [lfgHealerIcon, "healer"], [lfgDamageIcon, "damage"], [lfgLeaderIcon, "leader"],
  ];
  for (const [box, role] of boxes) {
    const foreground = box.querySelector<HTMLElement>(".lfg-role-fg");
    const background = box.querySelector<HTMLElement>(".lfg-role-bg");
    const check = box.querySelector<HTMLElement>(".lfg-role-check");
    const [column, row] = LFG_ROLE_ICON_CELLS[role] ?? [1, 1];
    const crop = texCoordsToBackground(column, row, ROLE_ATLAS_SIZE, ROLE_CELL);
    setLayerBackground(foreground, lfgArt.roleIcon ?? "", crop.size, crop.position);
    const backCell = LFG_ROLE_BACKGROUND_CELLS[role];
    if (backCell && lfgArt.roleBackground && background) {
      // 75x75 cells in a 256x128 atlas: rect math, not square-atlas grid math.
      const left = ((backCell[0] - 1) * ROLE_BACKGROUND_CELL) / ROLE_BACKGROUND_WIDTH;
      const right = (backCell[0] * ROLE_BACKGROUND_CELL) / ROLE_BACKGROUND_WIDTH;
      const top = 0;
      const bottom = ROLE_BACKGROUND_CELL / ROLE_BACKGROUND_HEIGHT;
      const back = texRectToBackground(left, right, top, bottom);
      setLayerBackground(background, lfgArt.roleBackground, back.size, back.position);
      background.hidden = false;
    } else if (background) {
      background.style.backgroundImage = "";
      background.hidden = true;
    }
    if (check) {
      check.style.backgroundImage = lfgArt.checkbox ? `url(${JSON.stringify(lfgArt.checkbox)})` : "";
      check.style.backgroundSize = "100% 100%";
      check.dataset["check"] = lfgArt.checkboxCheck ?? "";
    }
    // Observable without a CSSOM: tests assert the stock cell, not the painted pixels.
    box.dataset["lfgRole"] = role;
    box.dataset["lfgCrop"] = `${crop.size} ${crop.position}`;
  }
  paintLfgStaticIcons();
}

function paintLfgStaticIcons(): void {
  setCssVar("--lfg-heroic-icon", lfgArt.heroic ? `url(${JSON.stringify(lfgArt.heroic)})` : "none");
  setCssVar("--lfg-reward-ring", lfgArt.rewardRing ? `url(${JSON.stringify(lfgArt.rewardRing)})` : "none");
  setCssVar("--lfg-lock-icon", lfgArt.lock ? `url(${JSON.stringify(lfgArt.lock)})` : "none");
}

/** Quest-difficulty tint for the `(min-max)` level label, mirroring `GetQuestDifficultyColor`. */
export function lfgLevelColour(level: number | undefined, minLevel: number, maxLevel: number): string {
  if (level === undefined) return "";
  if (minLevel > 0 && level < minLevel) return "#ff2020";
  if (maxLevel > 0 && level > maxLevel) return "#808080";
  if (minLevel > 0 && maxLevel > 0 && maxLevel >= minLevel) {
    const span = Math.max(1, maxLevel - minLevel);
    const position = (level - minLevel) / span;
    if (position < 0.34) return "#ffd100";
    if (position < 0.67) return "#ffff00";
    return "#40c040";
  }
  return "#ffd100";
}

function paintLfgBanner(box: HTMLElement, texture: string | undefined, heroic: boolean): void {
  const origin = game.gatewayOrigin;
  const specific = lfgDungeonBackgroundPath(texture);
  // Stock `LFDFrame.lua` chain: the dungeon's own art, then the heroic art, then the random-dungeon
  // art, then Deadmines. The old version only ever asked for the first name and left the box empty
  // when a dungeon's BLP was absent; this walks the chain until one actually loads.
  const candidates = specific ? [specific] : [];
  if (heroic) candidates.push("Interface\\LFGFrame\\UI-LFG-BACKGROUND-HEROIC.blp");
  candidates.push(LFG_RANDOM_BANNER_PATH, LFG_FALLBACK_BANNER_PATH);
  const generation = String(Number(box.dataset["bannerGeneration"] ?? "0") + 1);
  box.dataset["bannerGeneration"] = generation;
  box.dataset["banner"] = candidates[0] ?? "";
  const stale = (): boolean =>
    box.dataset["bannerGeneration"] !== generation || game.gatewayOrigin !== origin;
  if (!origin) {
    box.hidden = true;
    box.style.backgroundImage = "";
    return;
  }
  void (async () => {
    for (const path of candidates) {
      const url = await loadNativeTexture(origin, path);
      if (stale()) return;
      if (url) {
        box.hidden = false;
        box.style.backgroundImage = `url(${JSON.stringify(url)})`;
        box.dataset["banner"] = path;
        return;
      }
    }
    if (stale()) return;
    // Nothing in the chain exists: the colour fallback is more honest than an invisible box.
    box.hidden = true;
    box.style.backgroundImage = "";
    box.dataset["banner"] = "";
  })();
}

let lfgDungeonClient: LfgDungeonClient | undefined;
let lfgDungeonClientOrigin = "";
let lfgDungeonStatus = "";
const lfgDungeonSelection = new Set<number>();
/** The rows the pane currently shows, so "select visible" acts on exactly that list. */
let lfgVisibleDungeons: readonly LfgDungeon[] = [];
/** How many rows passed the filters before the DOM cap; the status line reports both. */
let lfgFilteredCount = 0;
/** Bounds the DOM: the catalog holds every LFG row, the window only needs the matches. */
const LFG_DUNGEON_ROW_LIMIT = 120;

function nativeLfgDungeonClient(): LfgDungeonClient | undefined {
  const origin = game.gatewayOrigin;
  if (!origin) return undefined;
  if (!lfgDungeonClient || lfgDungeonClientOrigin !== origin) {
    const client = new LfgDungeonClient(origin);
    lfgDungeonClient = client;
    lfgDungeonClientOrigin = origin;
    // A superseded client's late answer must not redraw the current view: its failure would
    // wipe a catalog another origin already painted, and its catalog belongs to another
    // dataset. The same session-identity guard the metadata loaders use.
    lfgDungeonClient.onStatus = (message) => {
      if (lfgDungeonClient !== client) return;
      lfgDungeonStatus = message;
      renderLfgDungeons(undefined);
    };
    lfgDungeonClient.onLoaded = () => {
      if (lfgDungeonClient !== client) return;
      lfgDungeonStatus = "";
      renderLfgDungeons(client.catalog);
    };
  }
  return lfgDungeonClient;
}

function playerLevel(world: WorldClient): number | undefined {
  const self = world.state.objects.get(world.state.selfGuid ?? 0n);
  const level = self?.fields.get(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset);
  return typeof level === "number" && Number.isInteger(level) && level > 0 ? level : undefined;
}

function lfgDungeonLabel(name: string, minLevel: number, maxLevel: number): string {
  // Stock `LFD_LEVEL_FORMAT_RANGE/SINGLE`: `(15 - 25)`, appended after the heroic prefix.
  if (minLevel > 0 && maxLevel > 0 && maxLevel > minLevel) return `${name} (${minLevel} - ${maxLevel})`;
  if (minLevel > 0 && maxLevel > 0) return `${name} (${minLevel})`;
  if (minLevel > 0) return `${name} (${minLevel})`;
  return name || "Подземелье";
}

function lfgHeroicPrefix(name: string, heroic: boolean): string {
  // Stock `HEROIC_PREFIX`: `«Героик: %s»`.
  return heroic ? `Героик: ${name}` : name;
}

/** Wire entries for the checked catalog rows, in catalog order. Empty when nothing is checked. */
export function selectedCatalogDungeonEntries(catalog: LfgDungeonCatalog | undefined): number[] {
  if (!catalog) return [];
  return lfgEntriesForSelection(catalog, lfgDungeonSelection);
}

/**
 * Dungeons for `CMSG_LFG_JOIN`.
 *
 * Random mode sends only the chosen server entry: the realm refuses a queue that mixes random
 * and specific dungeons. Specific mode sends checked catalog rows as `id + (type << 24)` entries
 * first, then the legacy manual ids. The server masks the type before the DBC lookup, so both
 * forms select the same dungeon; the catalog form keeps the queue type explicit.
 */
export function selectedLfgDungeons(): number[] {
  if (lfgSearchMode() === "random") {
    return lfgRandomEntry === undefined ? [] : [lfgRandomEntry];
  }
  const catalog = lfgDungeonClient?.catalog;
  const entries = selectedCatalogDungeonEntries(catalog);
  for (const id of parseManualDungeonIds(lfgDungeons.value)) {
    if (!entries.includes(id)) entries.push(id);
  }
  return entries;
}

/** The filter the pane reads from its own controls; "all" is the untouched default. */
function currentLfgFilter(): LfgDungeonFilter {
  // An untouched `<select>` in a test double reads "" rather than its first option; both mean all.
  const expansion = lfgExpansion.value === "" ? NaN : Number(lfgExpansion.value);
  const sort = lfgDungeonSort.value === "level" ? "level" as const : "name" as const;
  return {
    query: lfgDungeonSearch.value,
    expansion: Number.isInteger(expansion) ? expansion : "all",
    heroicOnly: lfgHeroicOnly.checked,
    levelOnly: lfgLevelOnly.checked,
    playerLevel: game.world ? playerLevel(game.world) : undefined,
    sort,
  };
}

/** `12 из 258 · выбрано 3`: what the filters keep, what the DOM cap shows, what is checked. */
function lfgCatalogStatusText(total: number): string {
  const shown = lfgVisibleDungeons.length;
  const capped = lfgFilteredCount > shown ? " (показаны первые)" : "";
  const selected = lfgDungeonSelection.size > 0 ? ` · выбрано ${lfgDungeonSelection.size}` : "";
  return `${shown} из ${total}${capped}${selected}`;
}

function lfgDungeonRow(world: WorldClient, dungeon: LfgDungeon, level: number | undefined): HTMLElement {
  const heroic = lfgDungeonHeroic(dungeon);
  const baseName = dungeon.name || `Подземелье ${dungeon.id}`;
  const label = lfgDungeonLabel(lfgHeroicPrefix(baseName, heroic), dungeon.minLevel, dungeon.maxLevel);
  const wrapper = document.createElement("label");
  wrapper.className = lfgDungeonSelection.has(dungeon.id) ? "lfg-dungeon-row is-selected" : "lfg-dungeon-row";
  if (heroic) wrapper.dataset["heroic"] = "1";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = lfgDungeonSelection.has(dungeon.id);
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => {
    if (input.checked) lfgDungeonSelection.add(dungeon.id);
    else lfgDungeonSelection.delete(dungeon.id);
    wrapper.classList.toggle("is-selected", input.checked);
    lfgCatalogStatus.textContent = lfgCatalogStatusText(lfgDungeonClient?.catalog?.filter(isSpecificLfgDungeon).length ?? 0);
  });
  wrapper.append(input);
  if (heroic) {
    // Stock `heroicIcon`: 16x20 crop of UI-LFG-ICON-HEROIC at (0-0.5, 0-0.625), left of the name.
    const badge = document.createElement("span");
    badge.className = "lfg-heroic-icon";
    badge.setAttribute("aria-hidden", "true");
    setTip(badge, "Героический режим");
    wrapper.append(badge);
  }
  const text = document.createElement("span");
  text.className = "lfg-dungeon-name";
  text.textContent = lfgHeroicPrefix(baseName, heroic);
  const lock = lockReasonFor(world, lfgDungeonEntry(dungeon));
  if (lock) {
    // Stock `lockedIcon`: the 12x14 lock art left of the row, with the reason still spoken.
    const icon = document.createElement("span");
    icon.className = "lfg-lock-icon";
    icon.setAttribute("aria-hidden", "true");
    setTip(icon, lock);
    wrapper.append(icon);
    input.setAttribute("aria-label", `${label} — ${lock}`);
  } else if (level !== undefined
    && ((dungeon.minLevel > 0 && level < dungeon.minLevel)
      || (dungeon.maxLevel > 0 && level > dungeon.maxLevel))) {
    setTip(text, `Ваш уровень ${level}: сервер может отклонить запрос`);
  } else if (dungeon.description) {
    setTip(text, dungeon.description);
  }
  wrapper.append(text);
  if (dungeon.minLevel > 0 && dungeon.maxLevel > 0) {
    // Stock `LFD_LEVEL_FORMAT_RANGE/SINGLE`, coloured by `GetQuestDifficultyColor`.
    const levels = document.createElement("span");
    levels.className = "lfg-dungeon-level";
    levels.textContent = dungeon.maxLevel > dungeon.minLevel
      ? `(${dungeon.minLevel} - ${dungeon.maxLevel})` : `(${dungeon.minLevel})`;
    const colour = lfgLevelColour(level, dungeon.minLevel, dungeon.maxLevel);
    if (colour) levels.style.color = colour;
    wrapper.append(levels);
  }
  if (lock) {
    const reason = document.createElement("span");
    reason.className = "muted lfg-dungeon-lock";
    reason.textContent = lock;
    wrapper.append(reason);
  }
  return wrapper;
}

export function renderLfgDungeons(catalog: LfgDungeonCatalog | undefined): void {
  const world = game.world;
  if (!world || lfgWindow.hidden) return;
  if (!catalog) {
    lfgVisibleDungeons = [];
    lfgFilteredCount = 0;
    lfgCatalogStatus.textContent = "";
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = lfgDungeonStatus || "Загружаем каталог подземелий…";
    lfgDungeonList.replaceChildren(note);
    return;
  }
  // Drop selections for dungeons that disappeared with a gateway/dataset change.
  const specific = catalog.filter(isSpecificLfgDungeon);
  const known = new Set(specific.map((dungeon) => dungeon.id));
  for (const id of [...lfgDungeonSelection]) {
    if (!known.has(id)) lfgDungeonSelection.delete(id);
  }
  paintLfgStaticIcons();
  const filtered = filterLfgDungeons(specific, currentLfgFilter());
  lfgFilteredCount = filtered.length;
  lfgVisibleDungeons = filtered.slice(0, LFG_DUNGEON_ROW_LIMIT);
  const level = playerLevel(world);
  const rows: HTMLElement[] = [];
  const groups = groupLfgDungeons(lfgVisibleDungeons);
  for (const group of groups) {
    // One era is a plain list; two or three earn their headings, in expansion order.
    if (groups.length > 1) {
      const header = document.createElement("h4");
      header.className = "lfg-group";
      header.textContent = group.name;
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = ` · ${group.dungeons.length}`;
      header.append(count);
      rows.push(header);
    }
    for (const dungeon of group.dungeons) rows.push(lfgDungeonRow(world, dungeon, level));
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Ничего не найдено. Ослабьте фильтры, проверьте название или введите ID вручную.";
    rows.push(empty);
  }
  lfgDungeonList.replaceChildren(...rows);
  lfgCatalogStatus.textContent = lfgCatalogStatusText(specific.length);
}

/** One listener set for the filter controls; the list redraws from the catalog it already has. */
function wireLfgFilters(): void {
  if (lfgDungeonSearch.dataset.wired === "1") return;
  lfgDungeonSearch.dataset.wired = "1";
  const rerender = (): void => renderLfgDungeons(lfgDungeonClient?.catalog);
  lfgDungeonSearch.addEventListener("input", rerender);
  for (const control of [lfgExpansion, lfgDungeonSort, lfgHeroicOnly, lfgLevelOnly]) {
    control.addEventListener("change", rerender);
  }
  lfgSelectVisible.addEventListener("click", () => {
    setVisibleLfgSelection(lfgDungeonSelection, lfgVisibleDungeons, true);
    rerender();
  });
  lfgClearSelection.addEventListener("click", () => {
    lfgDungeonSelection.clear();
    rerender();
  });
}

/** Which half of the classic window is showing: the checkbox catalog or the random list. */
export function lfgSearchMode(): "specific" | "random" {
  return lfgType.value === "random" ? "random" : "specific";
}

/** The server-side random entry (`id + (type << 24)`) the radio list currently holds. */
let lfgRandomEntry: number | undefined;

function lockReasonFor(world: WorldClient, entry: number): string | undefined {
  const lock = world.lfgPlayerInfo?.locks.find((row) => row.dungeonId === entry);
  return lock === undefined ? undefined : lockReasonText(lock.reason);
}

function randomDungeonName(world: WorldClient, entry: number): string {
  const { dungeonId } = splitDungeonEntry(entry);
  const catalog = lfgDungeonClient?.catalog?.find((row) => row.id === dungeonId);
  if (catalog?.name) {
    const levels = catalog.minLevel > 0 && catalog.maxLevel > 0 && catalog.maxLevel >= catalog.minLevel
      ? ` (${catalog.minLevel} - ${catalog.maxLevel})` : "";
    return `${lfgHeroicPrefix(catalog.name, lfgDungeonHeroic(catalog))}${levels}`;
  }
  return `Подземелье ${dungeonId}`;
}

function renderLfgRewardItems(world: WorldClient, reward: LfgReward): void {
  const rows: HTMLElement[] = [];
  const missing: number[] = [];
  paintLfgStaticIcons();
  for (const item of reward.items) {
    if (item.itemId <= 0) continue;
    const meta = game.itemMetadata?.get(item.itemId);
    if (!meta) missing.push(item.itemId);
    const name = world.itemTemplate(item.itemId)?.name ?? meta?.name ?? unknownLabel("предмет", item.itemId);
    const box = document.createElement("div");
    box.className = "lfg-reward";
    if ((meta && game.itemMetadata) || (game.itemMetadata && item.displayId > 0)) {
      // Stock `LFDDungeonReadyRewardTemplate`: 30px portrait icon with the full-size
      // `UI-LFG-ICON-REWARDRING` overlay (0-0.675)^2.
      const portrait = document.createElement("span");
      portrait.className = "lfg-reward-icon";
      const image = document.createElement("img");
      image.alt = "";
      image.src = meta && game.itemMetadata
        ? game.itemMetadata.iconUrl(meta)
        : game.itemMetadata.displayIconUrl(item.displayId);
      image.addEventListener("error", () => image.remove(), { once: true });
      portrait.append(image);
      const ring = document.createElement("span");
      ring.className = "lfg-reward-ring";
      ring.setAttribute("aria-hidden", "true");
      portrait.append(ring);
      box.append(portrait);
    }
    const label = document.createElement("span");
    label.textContent = item.count > 1 ? `${name} ×${item.count}` : name;
    box.append(label);
    attachTooltip(box, () => itemTooltipFor(item.itemId, { count: item.count, footer: ["Награда подземелий"] }));
    rows.push(box);
  }
  if (reward.money > 0) {
    const money = document.createElement("div");
    money.className = "lfg-reward";
    money.textContent = formatMoney(reward.money);
    rows.push(money);
  }
  if (reward.experience > 0) {
    // Parsed since the reward packet existed and never drawn: the random-dungeon bonus is mostly
    // experience for a levelling character, and the window showed only the coin.
    const experience = document.createElement("div");
    experience.className = "lfg-reward lfg-reward-xp";
    const label = document.createElement("span");
    label.textContent = `+${reward.experience} опыта`;
    experience.append(label);
    rows.push(experience);
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Без награды за это подземелье.";
    rows.push(empty);
  }
  lfgRewards.replaceChildren(...rows);
  if (missing.length > 0 && game.itemMetadata) {
    const client = game.itemMetadata;
    void client.load(missing).then(() => {
      if (game.world === world && !lfgWindow.hidden && lfgSearchMode() === "random") showLfg();
    });
  }
}

function renderLfgRandomPane(world: WorldClient): void {
  const randoms = world.lfgPlayerInfo?.dungeons ?? [];
  if (lfgRandomEntry !== undefined && !randoms.some((row) => row.entry === lfgRandomEntry)) {
    lfgRandomEntry = undefined;
  }
  if (lfgRandomEntry === undefined && randoms.length > 0) {
    lfgRandomEntry = randoms.find((row) => lockReasonFor(world, row.entry) === undefined)?.entry
      ?? randoms[0]?.entry;
  }
  const list: HTMLElement[] = [];
  if (randoms.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Нет данных о случайных подземельях. Нажмите «Обновить».";
    list.push(empty);
  }
  for (const row of randoms) {
    const lock = lockReasonFor(world, row.entry);
    const label = document.createElement("label");
    label.className = "lfg-random-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "lfg-random";
    input.checked = lfgRandomEntry === row.entry;
    input.addEventListener("change", () => {
      if (!input.checked || game.world !== world) return;
      lfgRandomEntry = row.entry;
      showLfg();
    });
    if (lock) {
      const icon = document.createElement("span");
      icon.className = "lfg-lock-icon";
      icon.setAttribute("aria-hidden", "true");
      setTip(icon, lock);
      label.append(icon);
    }
    const text = document.createElement("span");
    text.textContent = randomDungeonName(world, row.entry);
    label.append(input, text);
    if (lock) {
      const badge = document.createElement("span");
      badge.className = "muted";
      badge.textContent = lock;
      label.append(badge);
    }
    list.push(label);
  }
  lfgRandomList.replaceChildren(...list);
  const selected = randoms.find((row) => row.entry === lfgRandomEntry);
  if (!selected) {
    lfgRandomName.textContent = "";
    lfgRandomDescription.textContent = "";
    lfgRewardNote.textContent = "";
    lfgRewards.replaceChildren();
    return;
  }
  const { dungeonId } = splitDungeonEntry(selected.entry);
  const catalog: LfgDungeon | undefined = lfgDungeonClient?.catalog?.find((row) => row.id === dungeonId);
  const heroicSelected = catalog ? lfgDungeonHeroic(catalog) : false;
  paintLfgBanner(lfgRandomBanner, catalog?.texture, heroicSelected);
  lfgRandomName.textContent = lfgHeroicPrefix(catalog?.name || `Подземелье ${dungeonId}`, heroicSelected);
  lfgRandomDescription.textContent = catalog?.description
    || "Случайное подземелье подходящего уровня: состав подберёт сервер, награда — за прохождение.";
  lfgRewardNote.textContent = selected.reward.done
    ? "Награда за сегодня уже получена."
    : "Дополнительная награда за случайное подземелье.";
  renderLfgRewardItems(world, selected.reward);
}

/** A catalog name for a plain dungeon id: entry form, level range and heroic prefix included. */
export function lfgDungeonNameById(dungeonId: number): string {
  const catalog = lfgDungeonClient?.catalog?.find((row) => row.id === dungeonId);
  if (!catalog) return `Подземелье ${dungeonId}`;
  const heroic = lfgDungeonHeroic(catalog);
  const levels = catalog.minLevel > 0 && catalog.maxLevel > 0
    ? ` (${catalog.minLevel}${catalog.maxLevel > catalog.minLevel ? ` - ${catalog.maxLevel}` : ""})`
    : "";
  return `${lfgHeroicPrefix(catalog.name, heroic)}${levels}`;
}

/**
 * The live queue as a panel rather than one crammed sentence.
 *
 * `SMSG_LFG_QUEUE_STATUS` carries the average wait, the player's own wait and a wait plus a
 * missing-player count per role; the old single line flattened five numbers into prose. Each role
 * now gets its stock atlas icon and its own wait/needed pair, which is what the player actually
 * watches while queued.
 */
/**
 * L7 4.14: the «time in queue» line moves between status packets, as stock LFDSearchStatus_OnUpdate
 * moves it (LFDFrame.lua:1149-1151): once a second while the window is up and the queue is the one
 * drawn; the timer stops itself on the first tick after either goes.
 */
const lfgQueueClock = new LfgQueueClock();
let lfgQueueLine: HTMLElement | undefined;
let lfgQueueTimer: ReturnType<typeof setInterval> | undefined;

function stopLfgQueueTicker(): void {
  if (lfgQueueTimer !== undefined) clearInterval(lfgQueueTimer);
  lfgQueueTimer = undefined;
  lfgQueueLine = undefined;
}

function tickLfgQueueLine(): void {
  const queue = game.world?.lfgQueue;
  const line = lfgQueueLine;
  if (!queue || !line || lfgWindow.hidden) {
    stopLfgQueueTicker();
    return;
  }
  const text = formatLfgQueued(lfgQueueClock.elapsed(queue, performance.now()));
  if (line.textContent !== text) line.textContent = text;
}

function renderLfgQueue(world: WorldClient): void {
  const queue = world.lfgQueue;
  if (!queue) {
    stopLfgQueueTicker(); // L7 4.14
    if (world.lfgStatus?.joined) {
      const line = document.createElement("span");
      line.className = "lfg-queue-state";
      line.textContent = "В очереди";
      lfgQueue.replaceChildren(line);
    } else {
      lfgQueue.replaceChildren();
    }
    return;
  }
  ensureLfgArt();
  const rows: HTMLElement[] = [];
  const state = document.createElement("span");
  state.className = "lfg-queue-state";
  // 4.14: every wait on the wire is seconds (LFGHandler.cpp:464-474); stock words (ui/LfgWait.ts).
  // L7 4.14: the packet's count plus the time since it came, and a once-a-second tick after it.
  state.textContent = formatLfgQueued(lfgQueueClock.elapsed(queue, performance.now()));
  // Re-armed on every draw: one timer, in step with the line it moves, never a stale one.
  stopLfgQueueTicker();
  lfgQueueLine = state;
  lfgQueueTimer = setInterval(tickLfgQueueLine, 1000);
  rows.push(state);
  if (queue.dungeonId > 0) {
    const dungeon = document.createElement("span");
    dungeon.className = "lfg-queue-dungeon";
    dungeon.textContent = lfgDungeonNameById(queue.dungeonId);
    rows.push(dungeon);
  }
  // Stock's statistic is `myWait` — the wire's wait for the player's own roles (LFGQueue.cpp:597-624),
  // not the dungeon's average — and is hidden while unknown (LFDFrame.lua:1137-1143).
  if (queue.waitTime >= 0) {
    const average = document.createElement("span");
    average.className = "lfg-queue-average";
    average.textContent = formatLfgAverage(queue.waitTime);
    rows.push(average);
  }
  const roles: ReadonlyArray<readonly [string, number, number, number]> = [
    ["tank", LFG_ROLE_TANK, queue.waitTimeTank, queue.tanksNeeded],
    ["healer", LFG_ROLE_HEALER, queue.waitTimeHealer, queue.healersNeeded],
    ["damage", LFG_ROLE_DAMAGE, queue.waitTimeDamage, queue.damageNeeded],
  ];
  for (const [role, mask, wait, needed] of roles) {
    const slot = document.createElement("span");
    slot.className = "lfg-queue-role";
    slot.dataset["lfgRole"] = role;
    setTip(slot, `${rolesText(mask)}: ${formatLfgWait(wait)}, нужно ${needed}`);
    const icon = document.createElement("span");
    icon.className = "lfg-queue-role-icon";
    icon.setAttribute("aria-hidden", "true");
    paintLfgRoleCell(icon, role);
    const label = document.createElement("span");
    label.className = "lfg-queue-role-label";
    label.textContent = `${wait < 0 ? "?" : formatLfgWait(wait)} · нужно ${needed}`;
    slot.append(icon, label);
    rows.push(slot);
  }
  lfgQueue.replaceChildren(...rows);
}

/**
 * Stock `LFDDungeonReadyStatus` portraits: one 55px role icon per member out of
 * `UI-LFG-ICON-ROLES`, with the ready-check overlay handled by text here.
 */
function renderLfgProposalRoles(players: ReadonlyArray<{ roles: number; answered: boolean; accepted: boolean }>): void {
  let strip = lfgProposalBox.querySelector<HTMLElement>("[data-lfg-proposal-roles]");
  // Test doubles answer every querySelector with a fresh node: only reuse a strip that is
  // actually parented to the proposal box.
  if (!strip || strip.parentNode !== lfgProposalBox) {
    strip = document.createElement("div");
    strip.className = "lfg-proposal-roles";
    strip.dataset["lfgProposalRoles"] = "1";
    if (typeof lfgProposalBox.insertBefore === "function") {
      lfgProposalBox.insertBefore(strip, lfgProposalText.nextSibling);
    } else {
      lfgProposalBox.append(strip);
    }
  }
  ensureLfgArt();
  const iconUrl = lfgArt.roleIcon ?? "";
  strip.replaceChildren(...players.map((member) => {
    const role = (member.roles & LFG_ROLE_TANK) !== 0 ? "tank"
      : (member.roles & LFG_ROLE_HEALER) !== 0 ? "healer"
      : (member.roles & LFG_ROLE_DAMAGE) !== 0 ? "damage"
      : (member.roles & LFG_ROLE_LEADER) !== 0 ? "leader" : "damage";
    const [column, row] = LFG_ROLE_ICON_CELLS[role] ?? [2, 2];
    const crop = texCoordsToBackground(column, row, ROLE_ATLAS_SIZE, ROLE_CELL);
    const icon = document.createElement("span");
    icon.className = "lfg-proposal-role";
    setTip(icon, rolesText(member.roles));
    if (iconUrl) {
      icon.style.backgroundImage = `url(${JSON.stringify(iconUrl)})`;
      icon.style.backgroundSize = crop.size;
      icon.style.backgroundPosition = crop.position;
      icon.style.backgroundRepeat = "no-repeat";
    }
    if (!member.answered) icon.dataset["pending"] = "1";
    else if (!member.accepted) icon.dataset["declined"] = "1";
    return icon;
  }));
}

function wireLfgControls(): void {
  if (lfgType.dataset.wired === "1") return;
  lfgType.dataset.wired = "1";
  lfgType.addEventListener("change", () => showLfg());
  for (const role of [lfgLeader, lfgTank, lfgHealer, lfgDamage]) {
    role.addEventListener("change", updateLfgJoinAvailability);
  }
  lfgRefresh.addEventListener("click", () => {
    const world = game.world;
    if (!world) return;
    world.requestDungeonLocks();
    showLfg();
  });
}

export function auctionEntryBox(
  entry: AuctionEntry, own: boolean, world: WorldClient, badge?: string,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "auction-entry";
  const name = document.createElement("strong");
  const template = world.itemTemplate(entry.itemId);
  const metadata = game.itemMetadata?.get(entry.itemId);
  const label = template?.name || metadata?.name || unknownLabel("предмет", entry.itemId);
  name.textContent = entry.count > 1 ? `${label} ×${entry.count}` : label;
  attachTooltip(name, () => itemTooltipFor(entry.itemId, { count: entry.count, footer: ["Лот аукциона"] }));
  box.append(name);
  if (badge) {
    const mark = document.createElement("span");
    mark.className = `auction-badge ${badge === "Ведете" ? "auction-leading" : "auction-outbid"}`;
    mark.textContent = badge;
    box.append(mark);
  }

  const meta = document.createElement("span");
  meta.className = "auction-meta";
  const price = entry.bid > 0 ? `ставка ${formatMoney(entry.bid)}` : `старт ${formatMoney(entry.startBid)}`;
  const buyout = entry.buyout > 0 ? ` · выкуп ${formatMoney(entry.buyout)}` : "";
  // The server sends the remaining time in milliseconds.
  meta.textContent = `${price}${buyout} · осталось ${Math.max(0, Math.round(entry.timeLeft / 60000))} мин.`;
  box.append(meta);

  if (own) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Снять с продажи";
    cancel.addEventListener("click", () => confirmPanel(cancel, {
      title: "Снять лот с продажи?",
      lines: ["Депозит не возвращается, а предмет придёт почтой."],
      confirm: "Снять",
      danger: true,
      onConfirm: () => world.cancelAuction(entry.auctionId),
    }));
    box.append(cancel);
    return box;
  }

  const next = nextBid(entry);
  const bidButton = document.createElement("button");
  bidButton.type = "button";
  bidButton.textContent = `Ставка ${formatMoney(next)}`;
  // 4.07: stock asks before money leaves (Blizzard_AuctionUI.lua:192-222, the browse tab's
  // StaticPopup_Show("BID_AUCTION"/"BUYOUT_AUCTION"), Blizzard_AuctionUI.xml:841, 859); the bids
  // tab's «Ставка» raises a bid without asking (:1238), its «Выкуп» asks (:1220). The lot and the
  // sum stay in the closure: the list is rebuilt whole while the question is up.
  const auctionId = entry.auctionId;
  bidButton.addEventListener("click", () => {
    if (auctionTab === "bids") {
      world.bidOnAuction(auctionId, next);
      return;
    }
    confirmPanel(bidButton, {
      title: nativeString("BID_AUCTION_CONFIRMATION", "Ставка на аукционе:"),
      lines: [formatMoney(next)],
      confirm: "Принять",
      onConfirm: () => world.bidOnAuction(auctionId, next),
    });
  });
  box.append(bidButton);
  if (entry.buyout > 0) {
    const buyoutButton = document.createElement("button");
    buyoutButton.type = "button";
    buyoutButton.textContent = `Выкуп ${formatMoney(entry.buyout)}`;
    const buyout = entry.buyout;
    buyoutButton.addEventListener("click", () => confirmPanel(buyoutButton, {
      title: nativeString("BUYOUT_AUCTION_CONFIRMATION", "Выкупить товар за:"),
      lines: [formatMoney(buyout)],
      confirm: "Принять",
      onConfirm: () => world.bidOnAuction(auctionId, buyout),
    }));
    box.append(buyoutButton);
  }
  return box;
}

/** Which auction list the window shows. Explicit since the bids tab: `own ?? auctions` used
 * to pin the window to whichever list arrived last, so «Искать» went dead after «Мои лоты». */
export type AuctionTab = "search" | "own" | "bids";
let auctionTab: AuctionTab = "search";
let auctionOwnerPage = 0;

export function setAuctionTab(tab: AuctionTab): void {
  auctionTab = tab;
}

/** The selected core ignores owner-list `listfrom` and returns every lot in one response. */
export function setAuctionOwnerPage(page: number): void {
  auctionOwnerPage = page;
  showAuctions();
}

export function changeAuctionOwnerPage(delta: number): void {
  setAuctionOwnerPage(auctionOwnerPage + delta);
}

export function showAuctions(): void {
  const world = game.world;
  if (!world || world.auctioneerGuid === 0n) {
    auctionWindow.hidden = true;
    return;
  }
  // Stock AuctionFrame (Blizzard_AuctionUI, loaded on the first auctioneer) owns the house once its
  // tree has passed the gate; until then — the add-on still loading, or a failed gate — this window does.
  if (frameXmlAuctionOwnsWindow()) {
    auctionWindow.hidden = true;
    return;
  }
  auctionWindow.hidden = false;
  const message = world.auctionMessage;
  auctionMessage.className = message ? (message.error ? "error" : "success") : "muted";
  auctionMessage.textContent = message?.text ?? "";

  const list = auctionTab === "own" ? world.ownAuctions
    : auctionTab === "bids" ? world.bidAuctions : world.auctions;
  const isOwn = auctionTab === "own";
  if (isOwn) {
    auctionOwnerPage = clampAuctionPage(list?.entries.length ?? 0, auctionOwnerPage);
    const pageLabel = document.getElementById("auction-page");
    if (pageLabel) pageLabel.textContent = `Стр. ${auctionOwnerPage}`;
  }
  // Client-side ordering of the page the server sent; the select lives in static markup and is
  // read by id like the other auction filters, so no Dom.ts handle is needed for it.
  const sortSelect = document.getElementById("auction-sort") as HTMLSelectElement | null;
  if (sortSelect && sortSelect.dataset["wired"] !== "1") {
    sortSelect.dataset["wired"] = "1";
    sortSelect.addEventListener("change", () => showAuctions());
  }
  const sort = sortSelect?.value || AUCTION_SORT_PRICE_ASC;
  const entries = sortAuctionEntries(list?.entries ?? [], sort, isOwn ? auctionOwnerPage : undefined);
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    // The window opens before anything has been asked for, and «Ничего не найдено» over an empty
    // list the player has not searched yet reads as an answer to a question nobody put.
    empty.textContent = list ? "Ничего не найдено"
      : auctionTab === "own" ? "Нажмите «Мои лоты»."
        : auctionTab === "bids" ? "Нажмите «Мои ставки»." : "Задайте условия и нажмите «Искать».";
    auctionList.replaceChildren(empty);
    return;
  }
  const self = world.controlledGuid ?? world.state.selfGuid ?? 0n;
  auctionList.replaceChildren(...entries.map((entry) => auctionEntryBox(entry, isOwn, world,
    auctionTab === "bids" && !isOwn
      ? (isLeadingBid(entry, self) ? "Ведете" : "Перебита") : undefined)));
}

export function showLfg(): void {
  const world = game.world;
  const proposal = world?.lfgProposal;
  const status = world?.lfgStatus;
  // While stock LFDParentFrame owns the finder, every LFG packet still arrives here through
  // `onLfgChanged`; the native window must not open beside the stock one on a queue or proposal.
  if (!world || frameXmlLfdPublished()) {
    lfgWindowRequested = false;
    lfgWindow.hidden = true;
    return;
  }
  // An explicit micro-button/open command owns an empty window; otherwise the event-driven panel
  // only earns its place once something LFG related has actually happened. Optional chaining:
  // tests drive this with partial world fakes that predate the newer LFG fields.
  if (!lfgWindowRequested && (!proposal && !status && !world.lfgQueue && !world.lfgMessage
    && !world.lfgSearching && (world.lfgRolesChosen?.size ?? 0) === 0)) {
    lfgWindow.hidden = true;
    return;
  }
  lfgWindow.hidden = false;
  lfgMessage.textContent = world.lfgMessage ?? (world.lfgSearching ? "Поиск группы…" : "");

  renderLfgQueue(world);

  lfgProposalBox.hidden = !proposal;
  if (proposal) {
    // The invitation the original client announces with the ready-check sound: once per proposal,
    // never per repaint, and never for the prompt going away.
    if (chimedLfgProposal !== proposal) {
      chimedLfgProposal = proposal;
      playUiSound("readyCheck");
    }
    const answered = proposal.players.filter((player) => player.answered).length;
    const mine = proposal.players.find((player) => player.self)?.roles ?? 0;
    lfgProposalText.textContent = `Найдена группа: ${proposal.players.length} чел., согласились ${answered}. Ваша роль: ${rolesText(mine)}.`;
    // Stock `LFDDungeonReadyDialog`: the banner is `UI-LFG-BACKGROUND-<TextureFilename>`,
    // falling back to Deadmines and then to the random-dungeon art.
    const { dungeonId: proposalDungeon } = splitDungeonEntry(proposal.dungeonEntry);
    const proposalCatalog: LfgDungeon | undefined = lfgDungeonClient?.catalog?.find(
      (row) => row.id === proposalDungeon,
    );
    paintLfgBanner(
      lfgProposalBanner,
      proposalCatalog?.texture,
      proposalCatalog ? lfgDungeonHeroic(proposalCatalog) : false,
    );
    renderLfgProposalRoles(proposal.players);
  } else {
    chimedLfgProposal = undefined;
    lfgProposalBanner.hidden = true;
    lfgProposalBanner.style.backgroundImage = "";
  }

  wireLfgFilters();
  wireLfgControls();
  paintLfgRoleIcons();
  // Leave and teleport only mean something while the player is searching or invited.
  const queued = world.lfgQueue !== undefined || status?.joined === true || status?.queued === true;
  lfgLeave.disabled = !queued;
  lfgTeleport.disabled = !queued && world.lfgProposal === undefined;
  updateLfgJoinAvailability();
  const random = lfgSearchMode() === "random";
  lfgRandomPane.hidden = !random;
  lfgSpecificPane.hidden = random;
  if (random) renderLfgRandomPane(world);
  else {
    const dungeons = nativeLfgDungeonClient();
    renderLfgDungeons(dungeons?.catalog);
    // A superseded client's late answer must not redraw the current view: a failed load
    // resolves `undefined`, and painting that would wipe a catalog another origin painted.
    if (dungeons && !dungeons.ready) {
      const owner = dungeons;
      void dungeons.load().then((catalog) => {
        if (lfgDungeonClient !== owner) return;
        renderLfgDungeons(catalog);
      });
    }
    return;
  }
  const dungeons = nativeLfgDungeonClient();
  if (dungeons && !dungeons.ready) {
    void dungeons.load().then(() => {
      if (game.world === world && !lfgWindow.hidden && lfgSearchMode() === "random") showLfg();
    });
  }
}

/** Whether the real native LFG window is currently visible. */
export function lfgWindowOpen(): boolean {
  return !lfgWindow.hidden;
}

/** Close the native LFG owner and clear the explicit-open intent. */
export function closeLfgWindow(): void {
  lfgWindowRequested = false;
  lfgWindow.hidden = true;
  stopLfgQueueTicker(); // L7 4.14
}

/**
 * The one dungeon-finder toggle: the micro button, `I`, the HUD button, `/lfg`, the native menu
 * entry and stock ToggleLFDParentFrame all call it. The stock LFDParentFrame answers first once the
 * FrameXML mount has published it; this native window is the fallback.
 */
export function toggleLfgWindow(): void {
  if (toggleFrameXmlLfd()) return;
  const world = game.world;
  if (!world) return;
  lfgWindowRequested = lfgWindow.hidden;
  // Fresh locks and rewards every time the window opens: eligibility changes with level,
  // gear and lockouts, and yesterday's rows would offer today's heroics.
  if (lfgWindowRequested) world.requestDungeonLocks();
  if (lfgWindowRequested) showLfg();
  else lfgWindow.hidden = true;
}

export { showMail } from "./Mail.js";

/** The trade window accepts a dragged bag item once; `showTrade` repaints, it does not rewire. */
let tradeDropWired = false;

function wireTradeDrop(): void {
  if (tradeDropWired) return;
  tradeDropWired = true;
  tradeMine.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes(ITEM_DRAG_FORMAT)) {
      event.preventDefault();
      tradeMine.classList.add("is-drop-target");
    }
  });
  tradeMine.addEventListener("dragleave", () => tradeMine.classList.remove("is-drop-target"));
  tradeMine.addEventListener("drop", (event) => {
    tradeMine.classList.remove("is-drop-target");
    const world = game.world;
    const drag = readItemDrag(event.dataTransfer);
    if (!drag || !world?.tradeOpen) return;
    event.preventDefault();
    // Equipped and banked items are offered from their own menu entries; the server is the
    // authority that refuses them, and a silent refusal here would eat the gesture.
    const free = firstFreeTradeSlot(world.ownTradeOffer().items.map((item) => item.slot));
    if (free === undefined) {
      systemLine("Свободных слотов обмена нет");
      return;
    }
    world.offerTradeItem(free, drag.bag, drag.slot);
  });
}

export function showTrade(): void {
  const world = game.world;
  // A request not yet opened is the stock TRADE dialog's while the popup owner is published.
  if (!world || (!world.tradeOpen && !world.tradePending) || (!world.tradeOpen && frameXmlPopupsPublished())) {
    tradeWindow.hidden = true;
    return;
  }
  // An open trade is stock TradeFrame's once published (FrameXmlTradeController); it shows on TRADE_SHOW.
  if (world.tradeOpen && frameXmlTradePublished()) {
    tradeWindow.hidden = true;
    return;
  }
  tradeWindow.hidden = false;
  tradeOfferFields.hidden = world.tradePending;
  tradeAccept.textContent = world.tradePending ? "Начать обмен" : "Принять обмен";
  tradeAccept.disabled = world.tradePending && world.tradeBeginRequested;
  const partner = world.tradePartnerGuid === 0n ? "" : world.displayName(world.tradePartnerGuid);
  tradeTitle.textContent = partner ? `Обмен · ${partner}` : "Обмен";
  tradeMessage.textContent = world.tradePending
    ? world.tradeBeginRequested ? "Ожидаем открытия обмена" : `${partner || "Игрок"} предлагает обмен`
    : world.tradeMessage ?? "";
  if (world.tradePending) return;
  wireTradeDrop();
  tradeTheirTitle.textContent = world.tradePartnerAccepted ? "Вам предлагают · партнёр согласен" : "Вам предлагают";
  tradeTheirTitle.className = world.tradePartnerAccepted ? "trade-accepted" : "";
  tradeItemList(tradeMine, world.ownTradeOffer(), { onClearSlot: (slot) => world.clearTradeItem(slot) });
  tradeItemList(tradeTheirs, world.theirOffer, { onEnchantSlot: (row) => clickTradeEnchantSlot(row) });
}

export function showDuel(): void {
  const world = game.world;
  // Bounds transitions during a running duel own no prompt: say them once in chat. Consumed
  // here rather than printed by the packet path so a transition says so exactly once.
  const bounds = world?.takeDuelBoundsMessage();
  // While the popup owner is published the stock DUEL_REQUESTED and DUEL_OUTOFBOUNDS dialogs ask
  // and count instead; the queued line is still consumed so it cannot surface later.
  const stock = frameXmlPopupsPublished();
  if (bounds && !stock) systemLine(bounds);
  const request = world?.duelRequest;
  duelWindow.hidden = !request || stock;
  if (!world || !request) return;
  const countdown = world.duelCountdown;
  const timer = countdown !== undefined && countdown > 0 ? ` · начало через ${countdown} с` : "";
  duelText.textContent = `${world.displayName(request.challengerGuid)} вызывает вас на дуэль${timer}.`;
}

/** Refreshes the duel countdown text once a second while the prompt is up. */
let lastDuelTick = 0;
export function updateDuel(now: number): void {
  if (duelWindow.hidden || now - lastDuelTick < 1000) return;
  lastDuelTick = now;
  showDuel();
}

// 4.14: the prompts panel names a proposal's or a finished dungeon's row from this catalog (asked
// for on first use) and leaves the proposal to this window while it is up.
registerInteractionPromptNames({
  dungeon: (dungeonId) => {
    const client = nativeLfgDungeonClient();
    if (client && !client.ready) void client.load();
    return client?.catalog?.some((row) => row.id === dungeonId) ? lfgDungeonNameById(dungeonId) : undefined;
  },
  lfgWindowOpen,
});
