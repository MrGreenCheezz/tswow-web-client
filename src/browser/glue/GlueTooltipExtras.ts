/**
 * Plan item 3.12a–d: the GameTooltip setters the stock corpus calls that the widget layer lacked —
 * `SetBuybackItem`, `SetMerchantCostItem`, `SetTotem`, `SetEquipmentSet`, `SetLFGDungeonReward`,
 * `SetQuestLogRewardSpell`, `SetQuestRewardSpell`, `SetGlyph`, `SetTalent`, `SetQuestLogSpecialItem`,
 * `SetHyperlinkCompareItem` — and `SetHyperlink` for `quest:`, `talent:` and `glyph:` links.
 *
 * What each one draws is read from Wow.exe.clean (described in this file's words):
 *
 * * `SetBuybackItem(slot)` 0x0062ff60, `SetMerchantCostItem(index, currency)` 0x0062ee70 (the n-th
 *   non-zero cost item of the row's extended cost), `SetLFGDungeonReward(dungeon, index)` 0x00630a80:
 *   the item's own tooltip; nothing is answered. Here each goes through the link the stock C API
 *   already names (`GetBuybackItemLink`, `GetMerchantItemCostItem`'s third value,
 *   `GetLFGDungeonRewardLink`), as the other link-shaped setters do.
 * * `SetQuestLogRewardSpell()` 0x00626440 / `SetQuestRewardSpell()` 0x006263e0: the spell tooltip of
 *   the selected log quest's / the open quest dialog's reward spell (cache offset 0x3c).
 * * `SetTotem(slot)` 0x006205c0: for an active totem, its name, then the time left in the client's
 *   own words (SPELL_TIME_REMAINING_*).
 * * `SetEquipmentSet(name)` 0x00622dd0: the set's name with «N предметов» right of it (gold), then
 *   «N предметов экипировано» (gold), «N предметов в сумках» (white), «N ячеек пропущено» (grey), and
 *   «<slot> отсутствует» (red) for each piece the character no longer has.
 * * `SetGlyph(socket[, group])` 0x00625d00 → 0x00622ba0: the glyph's spell name (white) or, for an
 *   empty socket, GLYPH_INACTIVE (grey) / GLYPH_LOCKED (red); MAJOR_GLYPH or MINOR_GLYPH (#66bbff);
 *   the spell's description (gold, wrapped) and GLYPH_SLOT_REMOVE_TOOLTIP (grey), or for an empty
 *   socket GLYPH_EMPTY_DESC / GLYPH_SLOT_TOOLTIP<n> (gold, wrapped). A `glyph:` link draws the same
 *   without the remove hint.
 * * `SetTalent(tab, index[, inspect[, pet[, group[, preview]]]])` 0x0062f740 → 0x00626e20: the rank's
 *   spell name (white), TOOLTIP_TALENT_RANK «Уровень r/m», the unmet requirements, the current rank's
 *   description (gold, wrapped), and for a next rank a blank line, TOOLTIP_TALENT_NEXT_RANK and its
 *   description. A `talent:<id>[:<rank>]` link draws the same for that rank.
 * * `SetHyperlink("quest:<id>...")` 0x0062dae0 → 0x00622960: the title (gold), QUEST_TOOLTIP_ACTIVE
 *   (green) while the quest is in the log, a blank line, the objectives text (white, wrapped) and,
 *   when it has objectives, a blank line, QUEST_TOOLTIP_REQUIREMENTS and « - <objective>» rows.
 * * `SetHyperlinkCompareItem(link[, index[, shift[, anchor]]])` 0x00631b60 → 0x00631850: the
 *   index-th equipped item the linked item would compete with, marked as worn (CURRENTLY_EQUIPPED on
 *   top), answering 1; nil when there is none. 04.10, L4: with `anchor` (a GameTooltip showing an
 *   item) the stat difference follows (GlueTooltipStatDelta.ts); index 3 is the merchant's own case
 *   — an item with ScalingStatValue (record +0xbc) while a merchant is open (0x00bfa3e8) and `shift`
 *   false shows the linked item itself, no header and no difference (drawn for the merchant at
 *   level 1 by 0x0061e740 — heirloom scaling is not modelled, so its stats are the template's).
 * * 04.10, L4: `SetTalent` ends with TOOLTIP_TALENT_LEARN (green) when 0x00622800 would: the
 *   player's own active group, no unmet requirement, free points, not at the last rank.
 *
 * Colours are the client's (the table at 0x00ad2d2c): gold ffd200, white, red ff2020, grey 808080,
 * green 00ff00, glyph type 66bbff.
 */
import type { FrameXmlColor, FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { TooltipContent } from "../ui/Widgets.js";
import type { WidgetMethod } from "./GlueWidgets.js";
import {
  gameTooltipItemStats, gameTooltipStatDelta, gameTooltipStatDeltaRows, type GameTooltipStatSource,
} from "./GlueTooltipStatDelta.js"; // 3.12 (04.10, L4)
import { gameTooltipStatTableKnown } from "./GlueTooltipStatDelta.js"; // L4-review

/** One requirement of a talent the player does not meet yet. */
export type GameTooltipTalentRequirement =
  | { readonly kind: "tier"; readonly points: number; readonly tabName: string }
  | { readonly kind: "talent"; readonly rank: number; readonly name: string };

/** What SetTalent / a `talent:` link draws. */
export interface GameTooltipTalent {
  /** The spell of each rank, rank 1 first; its length is the maximum rank. */
  readonly ranks: readonly number[];
  /** The rank the tooltip describes as current (0 = not learned). */
  readonly rank: number;
  readonly requirements?: readonly GameTooltipTalentRequirement[];
  /** 3.12 (04.10, L4): TOOLTIP_TALENT_LEARN is written last (Wow.exe 0x00622800's conditions). */
  readonly learnable?: boolean;
}

/** What a `quest:` link draws. */
export interface GameTooltipQuest {
  readonly title: string;
  readonly objectivesText: string;
  readonly active: boolean;
  readonly requirements: readonly string[];
}

/** The world facts these setters need beyond the Lua C API; GameTooltipWidgetAdapter carries them. */
export interface GameTooltipExtrasAdapter {
  readonly talent?: (tab: number, index: number, inspect: boolean, pet: boolean, group: number | undefined) => GameTooltipTalent | undefined;
  readonly talentById?: (talentId: number, rank: number | undefined) => GameTooltipTalent | undefined;
  readonly quest?: (questId: number) => GameTooltipQuest | undefined;
  readonly questLogRewardSpell?: () => number | undefined;
  readonly questRewardSpell?: () => number | undefined;
  /** A GlyphProperties row: its spell and whether it is a major glyph (for a `glyph:` link). */
  readonly glyph?: (glyphId: number) => { readonly spellId: number; readonly major: boolean } | undefined;
  /**
   * 3.12 (04.10, L4): a cached item record's stats for the shopping tooltips' difference and its
   * ScalingStatValue for the merchant's third tooltip; undefined while the record is not cached
   * (the client asks nothing here either: 0x00630c70 reads the cache without a callback).
   */
  readonly itemStats?: (entry: number) => (GameTooltipStatSource & { readonly scalingStatValue: number }) | undefined;
  /** 3.12 (04.10, L4): a merchant window is open (the merchant guid at 0x00bfa3e8 is set). */
  readonly merchantOpen?: () => boolean;
}

export interface GameTooltipExtras {
  readonly methods: Record<string, WidgetMethod>;
  /** SetHyperlink for the link kinds GlueWidgets' own parser does not know; undefined when not one. */
  hyperlink(frame: FrameXmlFrame, link: string): boolean | undefined;
}

/** The binder's drawing primitives, handed in by GlueWidgets so the hot file keeps one line. */
export interface GameTooltipExtrasHost {
  adapter(): (GameTooltipExtrasAdapter & {
    readonly spell?: (id: number) => TooltipContent | undefined;
    readonly item?: (entry: number) => TooltipContent | undefined;
  }) | undefined;
  callGlobal(name: string, args: readonly unknown[], results: number): readonly unknown[];
  /** A global that answers a table: its values 1..count (undefined when it answered no table). */
  callTable(name: string, args: readonly unknown[], count: number): readonly unknown[] | undefined;
  globalString(key: string): string | undefined;
  /** setGameTooltipLink: an item/spell link's tooltip; false (and hidden) when nothing is known. */
  link(frame: FrameXmlFrame, link: unknown): boolean;
  /** setGameTooltipContent + OnTooltipSetSpell for a spell's own tooltip. */
  spell(frame: FrameXmlFrame, spellId: number): boolean;
  /** Clear, write these rows, size and show. */
  rows(frame: FrameXmlFrame, rows: readonly GameTooltipRow[]): boolean;
  hide(frame: FrameXmlFrame): void;
  /** «Осталось: …» for a positive number of seconds (the aura rows' own formatting). */
  timeRemaining(seconds: number): string | undefined;
  formatTemplate(template: string, ...values: readonly unknown[]): string;
  /** 3.12 (04.10, L4): the item link a GameTooltip passed as `anchor` shows; undefined for anything else. */
  itemLinkOf?(anchor: unknown): string | undefined;
}

export interface GameTooltipRow {
  readonly text: string;
  readonly color: FrameXmlColor;
  readonly wrap?: boolean;
  readonly right?: string;
  readonly rightColor?: FrameXmlColor;
}

const color = (hex: number): FrameXmlColor => ({ r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 });
export const TOOLTIP_EXTRA_COLORS = Object.freeze({
  gold: color(0xffd200), white: color(0xffffff), red: color(0xff2020), gray: color(0x808080),
  green: color(0x00ff00), glyph: color(0x66bbff), lockedRed: color(0xff0000),
});

const NOTHING: readonly unknown[] = Object.freeze([]);

function whole(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** The description rows of a spell's tooltip content (tone "description"), as text. */
function descriptionOf(content: TooltipContent | undefined): string[] {
  const out: string[] = [];
  for (const line of content?.lines ?? []) {
    if (typeof line !== "string" && line.tone === "description" && line.text.length > 0) out.push(line.text);
  }
  return out;
}

/** 0-based equipment slots an inventory type competes for, by the client's hand rules (0x00631850). */
function compareSlots(inventoryType: number): { readonly slots: readonly number[]; readonly hands: boolean } {
  switch (inventoryType) {
    case 1: return { slots: [0], hands: false };
    case 2: return { slots: [1], hands: false };
    case 3: return { slots: [2], hands: false };
    case 4: return { slots: [3], hands: false };
    case 5: case 20: return { slots: [4], hands: false };
    case 6: return { slots: [5], hands: false };
    case 7: return { slots: [6], hands: false };
    case 8: return { slots: [7], hands: false };
    case 9: return { slots: [8], hands: false };
    case 10: return { slots: [9], hands: false };
    case 11: return { slots: [10, 11], hands: false };
    case 12: return { slots: [12, 13], hands: false };
    case 16: return { slots: [14], hands: false };
    case 13: case 17: return { slots: [15, 16], hands: true };
    case 21: return { slots: [15], hands: true };
    case 14: case 22: case 23: return { slots: [16], hands: true };
    case 15: case 25: case 26: case 28: return { slots: [17], hands: false };
    case 19: return { slots: [18], hands: false };
    default: return { slots: [], hands: false };
  }
}

/** `INVTYPE_*` (GetItemInfo's ninth value) → the wire InventoryType. */
const EQUIP_LOCATIONS: Readonly<Record<string, number>> = Object.freeze({
  INVTYPE_HEAD: 1, INVTYPE_NECK: 2, INVTYPE_SHOULDER: 3, INVTYPE_BODY: 4, INVTYPE_CHEST: 5, INVTYPE_WAIST: 6,
  INVTYPE_LEGS: 7, INVTYPE_FEET: 8, INVTYPE_WRIST: 9, INVTYPE_HAND: 10, INVTYPE_FINGER: 11, INVTYPE_TRINKET: 12,
  INVTYPE_WEAPON: 13, INVTYPE_SHIELD: 14, INVTYPE_RANGED: 15, INVTYPE_CLOAK: 16, INVTYPE_2HWEAPON: 17,
  INVTYPE_TABARD: 19, INVTYPE_ROBE: 20, INVTYPE_WEAPONMAINHAND: 21, INVTYPE_WEAPONOFFHAND: 22,
  INVTYPE_HOLDABLE: 23, INVTYPE_THROWN: 25, INVTYPE_RANGEDRIGHT: 26, INVTYPE_RELIC: 28,
});

/** The item entry a link or item string names. */
function itemEntry(link: unknown): number | undefined {
  if (typeof link !== "string") return undefined;
  const match = /(?:^|\|H)item:(\d+)/.exec(link);
  const entry = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(entry) && entry > 0 ? entry : undefined;
}

/** `EQUIPMENT_SET_*` location values GetEquipmentSetLocations answers (EquipmentManager.lua). */
const LOCATION_IGNORED = 1;
const LOCATION_MISSING = -1;
/** INVSLOT name keys for ITEM_MISSING, 1-based slot order (the client's slot names, 0x005d9f00). */
const SLOT_NAMES: readonly string[] = [
  "HEADSLOT", "NECKSLOT", "SHOULDERSLOT", "SHIRTSLOT", "CHESTSLOT", "WAISTSLOT", "LEGSSLOT", "FEETSLOT",
  "WRISTSLOT", "HANDSSLOT", "FINGER0SLOT", "FINGER1SLOT", "TRINKET0SLOT", "TRINKET1SLOT", "BACKSLOT",
  "MAINHANDSLOT", "SECONDARYHANDSLOT", "RANGEDSLOT", "TABARDSLOT",
];

export function createGameTooltipExtras(host: GameTooltipExtrasHost): GameTooltipExtras {
  const C = TOOLTIP_EXTRA_COLORS;
  const g = (key: string): string | undefined => host.globalString(key);
  const format = (key: string, ...values: readonly unknown[]): string | undefined => {
    const template = g(key);
    return template === undefined ? undefined : host.formatTemplate(template, ...values);
  };
  const spellName = (id: number): string | undefined => host.adapter()?.spell?.(id)?.title;

  const drawTalent = (frame: FrameXmlFrame, talent: GameTooltipTalent | undefined, learnHint = true): boolean => {
    const max = talent?.ranks.length ?? 0;
    if (!talent || max === 0) { host.hide(frame); return false; }
    const rank = Math.max(0, Math.min(max, talent.rank));
    const current = rank > 0 ? talent.ranks[rank - 1] : undefined;
    const next = rank < max ? talent.ranks[rank] : undefined;
    const adapter = host.adapter();
    const currentContent = current === undefined ? undefined : adapter?.spell?.(current);
    const nextContent = next === undefined ? undefined : adapter?.spell?.(next);
    const title = currentContent?.title ?? nextContent?.title;
    if (!title) { host.hide(frame); return false; }
    const rows: GameTooltipRow[] = [{ text: title, color: C.white }];
    const rankLine = format("TOOLTIP_TALENT_RANK", rank, max);
    if (rankLine) rows.push({ text: rankLine, color: C.white });
    for (const requirement of talent.requirements ?? []) {
      const text = requirement.kind === "tier"
        ? format("TOOLTIP_TALENT_TIER_POINTS", requirement.points, requirement.tabName)
        : format("TOOLTIP_TALENT_PREREQ", requirement.rank, requirement.name);
      if (text) rows.push({ text, color: C.red });
    }
    const currentWords = descriptionOf(currentContent);
    for (const text of currentWords) rows.push({ text, color: C.gold, wrap: true });
    const nextWords = descriptionOf(nextContent);
    if (nextWords.length > 0) {
      if (currentWords.length > 0) {
        rows.push({ text: " ", color: C.gold });
        const label = g("TOOLTIP_TALENT_NEXT_RANK");
        if (label) rows.push({ text: label, color: C.white });
      }
      for (const text of nextWords) rows.push({ text, color: C.gold, wrap: true });
    }
    // 3.12 (04.10, L4): 0x00622800, last and green (0x00ad2d40).
    const learn = talent.learnable && learnHint ? g("TOOLTIP_TALENT_LEARN") : undefined;
    if (learn) rows.push({ text: learn, color: C.green });
    return host.rows(frame, rows);
  };

  const drawGlyph = (frame: FrameXmlFrame, socket: number, enabled: boolean, major: boolean,
    spellId: number | undefined, fromLink: boolean): boolean => {
    const rows: GameTooltipRow[] = [];
    const content = spellId !== undefined && spellId > 0 ? host.adapter()?.spell?.(spellId) : undefined;
    if (content) rows.push({ text: content.title, color: C.white });
    else {
      const text = g(enabled ? "GLYPH_INACTIVE" : "GLYPH_LOCKED");
      if (text) rows.push({ text, color: enabled ? C.gray : C.lockedRed });
    }
    const kind = g(major ? "MAJOR_GLYPH" : "MINOR_GLYPH");
    if (kind) rows.push({ text: kind, color: C.glyph });
    if (content) {
      for (const text of descriptionOf(content)) rows.push({ text, color: C.gold, wrap: true });
      const hint = fromLink ? undefined : g("GLYPH_SLOT_REMOVE_TOOLTIP");
      if (hint) rows.push({ text: hint, color: C.gray });
    } else {
      const text = g(enabled ? "GLYPH_EMPTY_DESC" : `GLYPH_SLOT_TOOLTIP${socket}`);
      if (text) rows.push({ text, color: C.gold, wrap: true });
    }
    if (rows.length === 0) { host.hide(frame); return false; }
    return host.rows(frame, rows);
  };

  const drawQuest = (frame: FrameXmlFrame, questId: number): boolean => {
    const quest = host.adapter()?.quest?.(questId);
    if (!quest || quest.title.length === 0) { host.hide(frame); return false; }
    const rows: GameTooltipRow[] = [{ text: quest.title, color: C.gold }];
    const active = quest.active ? g("QUEST_TOOLTIP_ACTIVE") : undefined;
    if (active) rows.push({ text: active, color: C.green });
    rows.push({ text: " ", color: C.gold });
    if (quest.objectivesText) rows.push({ text: quest.objectivesText, color: C.white, wrap: true });
    if (quest.requirements.length > 0) {
      rows.push({ text: " ", color: C.gold });
      const label = g("QUEST_TOOLTIP_REQUIREMENTS");
      if (label) rows.push({ text: label, color: C.gold });
      for (const requirement of quest.requirements) rows.push({ text: ` - ${requirement}`, color: C.white });
    }
    return host.rows(frame, rows);
  };

  /** Link kinds the binder's own item/spell parser does not know; true when this drew one. */
  const hyperlink = (frame: FrameXmlFrame, link: string): boolean | undefined => {
    const match = /(?:^|\|H)(quest|talent|glyph):(-?\d+)(?::(-?\d+))?/.exec(link);
    if (!match) return undefined;
    const id = Number(match[2]);
    const extra = match[3] === undefined ? undefined : Number(match[3]);
    if (match[1] === "quest") return drawQuest(frame, id);
    if (match[1] === "talent") {
      // talent:<id>:<rank index>, the index 0-based and -1 for an unlearned talent (GetTalentLink).
      const talent = host.adapter()?.talentById?.(id, extra === undefined || extra < 0 ? 0 : extra + 1);
      return drawTalent(frame, talent);
    }
    // glyph:<GlyphSlot id>:<GlyphProperties id> (GetGlyphLink); a filled glyph, no remove hint.
    const glyph = extra === undefined ? undefined : host.adapter()?.glyph?.(extra);
    if (!glyph) { host.hide(frame); return false; }
    return drawGlyph(frame, 0, true, glyph.major, glyph.spellId, true);
  };

  /**
   * An item tooltip's content as rows: the title, then each non-empty line (a pair keeps its right
   * half). 04.10, L4: not the sell price — 0x006277f0 hands it to the tooltip's OnTooltipAddMoney,
   * which ShoppingTooltipTemplate does not have, so a shopping tooltip shows none.
   */
  const itemRows = (content: TooltipContent, rows: GameTooltipRow[]): GameTooltipRow[] => {
    rows.push({ text: content.title, color: C.white });
    for (const line of content.lines ?? []) {
      const text = typeof line === "string" ? line : line.text;
      if (text.length === 0 || (typeof line !== "string" && line.money !== undefined)) continue;
      rows.push({ text, color: C.white, ...(typeof line !== "string" && line.right ? { right: line.right } : {}) });
    }
    return rows;
  };

  /**
   * 3.12 (04.10, L4), 0x00631850 with index 3: the merchant's own shopping tooltip — the linked item
   * itself when its record has a ScalingStatValue (+0xbc), a merchant is open and `shift` is false.
   */
  const merchantThird = (frame: FrameXmlFrame, link: unknown, shift: boolean): boolean => {
    const entry = itemEntry(link);
    const adapter = host.adapter();
    const stats = entry === undefined ? undefined : adapter?.itemStats?.(entry);
    if (!stats || stats.scalingStatValue === 0 || shift || adapter?.merchantOpen?.() !== true) return false;
    const content = adapter.item?.(entry!);
    return content !== undefined && host.rows(frame, itemRows(content, []));
  };

  /** 3.12 (04.10, L4): the difference rows under an equipped item, against the item `anchor` shows. */
  const deltaRows = (anchor: unknown, wornEntry: number, rows: GameTooltipRow[], wornLink?: string): void => { // L4-review: wornLink
    const hoveredLink = anchor === undefined || anchor === null ? undefined : host.itemLinkOf?.(anchor); // L4-review: kept
    const hoveredEntry = itemEntry(hoveredLink);
    if (hoveredEntry === undefined) return;
    const adapter = host.adapter();
    const hovered = adapter?.itemStats?.(hoveredEntry);
    const worn = hovered === undefined ? undefined : adapter?.itemStats?.(wornEntry);
    if (!hovered || !worn) return;
    // L4-review: a heirloom or a random property is built from data not served here — no difference.
    if (!gameTooltipStatTableKnown(hovered, hoveredLink) || !gameTooltipStatTableKnown(worn, wornLink)) return;
    for (const row of gameTooltipStatDeltaRows(gameTooltipStatDelta(gameTooltipItemStats(hovered), gameTooltipItemStats(worn)), g)) {
      rows.push(row);
    }
  };

  const compare = (frame: FrameXmlFrame, link: unknown, offset: number, shift = false, anchor?: unknown): boolean => {
    if (offset === 2) return merchantThird(frame, link, shift); // 3.12 (04.10, L4)
    const equipLoc = host.callGlobal("GetItemInfo", [link], 9)[8];
    const inventoryType = typeof equipLoc === "string" ? EQUIP_LOCATIONS[equipLoc] : undefined;
    if (inventoryType === undefined) return false;
    const { slots, hands } = compareSlots(inventoryType);
    const worn = (slot: number): string | undefined => {
      const value = host.callGlobal("GetInventoryItemLink", ["player", slot + 1], 1)[0];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    let chosen: string | undefined;
    if (!hands) {
      // The n-th equipped piece among the type's slots, in slot order.
      const equipped = slots.map(worn).filter((value): value is string => value !== undefined);
      chosen = equipped[offset];
    } else if (slots.length === 2) {
      // Both hands: with two weapons the first tooltip is the off hand and the second the main hand;
      // with one, only the first tooltip, showing whichever is worn. The client compares the item
      // objects, so two copies of one weapon (equal links) are still two.
      const main = worn(15);
      const off = worn(16);
      if (main && off) chosen = offset === 0 ? off : offset === 1 ? main : undefined;
      else if (offset === 0) chosen = main ?? off;
    } else if (offset === 0) {
      chosen = worn(slots[0]!);
      // An off-hand item against a two-hander in the main hand.
      if (!chosen && slots[0] === 16) {
        const main = worn(15);
        const mainLoc = main ? host.callGlobal("GetItemInfo", [main], 9)[8] : undefined;
        if (mainLoc === "INVTYPE_2HWEAPON") chosen = main;
      }
    }
    const entry = itemEntry(chosen);
    const content = entry === undefined ? undefined : host.adapter()?.item?.(entry);
    if (!content) return false;
    const header = g("CURRENTLY_EQUIPPED");
    const rows: GameTooltipRow[] = [];
    if (header) rows.push({ text: header, color: C.gray });
    itemRows(content, rows);
    deltaRows(anchor, entry!, rows, chosen); // 3.12 (04.10, L4); L4-review: the worn link
    return host.rows(frame, rows);
  };

  const methods: Record<string, WidgetMethod> = {
    SetBuybackItem: ({ frame, args }) => {
      host.link(frame, host.callGlobal("GetBuybackItemLink", [args[0]], 1)[0]);
      return NOTHING;
    },
    SetMerchantCostItem: ({ frame, args }) => {
      if (whole(args[0]) === undefined || whole(args[1]) === undefined) { host.hide(frame); return NOTHING; }
      host.link(frame, host.callGlobal("GetMerchantItemCostItem", [args[0], args[1]], 3)[2]);
      return NOTHING;
    },
    SetLFGDungeonReward: ({ frame, args }) => {
      host.link(frame, host.callGlobal("GetLFGDungeonRewardLink", [args[0], args[1]], 1)[0]);
      return NOTHING;
    },
    // L5c 3.25: `SetLFGCompletionReward(index)` 0x00630b90 — the completion reward's index-th item,
    // its own tooltip (DungeonCompletionAlertFrameReward_OnEnter, AlertFrames.lua:167); the link comes
    // from the LFD model (FrameXmlLfd.ts WebClientLFGCompletionRewardLink).
    SetLFGCompletionReward: ({ frame, args }) => {
      host.link(frame, host.callGlobal("WebClientLFGCompletionRewardLink", [args[0]], 1)[0]);
      return NOTHING;
    },
    SetQuestLogRewardSpell: ({ frame }) => {
      const id = host.adapter()?.questLogRewardSpell?.();
      if (id === undefined || !host.spell(frame, id)) host.hide(frame);
      return NOTHING;
    },
    SetQuestRewardSpell: ({ frame }) => {
      const id = host.adapter()?.questRewardSpell?.();
      if (id === undefined || !host.spell(frame, id)) host.hide(frame);
      return NOTHING;
    },
    SetTotem: ({ frame, args }) => {
      const [have, name, start, duration] = host.callGlobal("GetTotemInfo", [args[0]], 4);
      if (!truthy(have) || typeof name !== "string" || name.length === 0) { host.hide(frame); return NOTHING; }
      const rows: GameTooltipRow[] = [{ text: name, color: C.gold }];
      const now = host.callGlobal("GetTime", [], 1)[0];
      const left = typeof start === "number" && typeof duration === "number" && typeof now === "number"
        ? start + duration - now : 0;
      const time = left > 0 ? host.timeRemaining(left) : undefined;
      if (time) rows.push({ text: time, color: C.white });
      host.rows(frame, rows);
      return NOTHING;
    },
    SetEquipmentSet: ({ frame, args }) => {
      const name = args[0];
      if (typeof name !== "string" || name.length === 0) { host.hide(frame); return NOTHING; }
      // GetEquipmentSetLocations answers a table indexed by inventory slot 1..19 (EquipmentManager.lua).
      const locations = host.callTable("GetEquipmentSetLocations", [name], 19);
      if (!locations) { host.hide(frame); return NOTHING; }
      let equipped = 0;
      let bags = 0;
      let ignored = 0;
      const missing: number[] = [];
      locations.forEach((value, index) => {
        if (typeof value !== "number" || value === 0) return;
        if (value === LOCATION_IGNORED) { ignored++; return; }
        if (value === LOCATION_MISSING) { missing.push(index); return; }
        const [player, , inBags] = host.callGlobal("EquipmentManager_UnpackLocation", [value], 3);
        if (truthy(player) && !truthy(inBags)) equipped++;
        else bags++;
      });
      const total = format("ITEMS_VARIABLE_QUANTITY", equipped + bags + missing.length);
      const rows: GameTooltipRow[] = [{
        text: name, color: C.white,
        ...(total ? { right: total, rightColor: C.gold } : {}),
      }];
      const push = (key: string, count: number, tint: FrameXmlColor): void => {
        const text = count > 0 ? format(key, count) : undefined;
        if (text) rows.push({ text, color: tint });
      };
      push("ITEMS_EQUIPPED", equipped, C.gold);
      push("ITEMS_IN_INVENTORY", bags, C.white);
      push("ITEM_SLOTS_IGNORED", ignored, C.gray);
      for (const slot of [...missing].reverse()) {
        const slotName = g(SLOT_NAMES[slot] ?? "");
        const text = slotName ? format("ITEM_MISSING", slotName) : undefined;
        if (text) rows.push({ text, color: C.red });
      }
      host.rows(frame, rows);
      return NOTHING;
    },
    SetGlyph: ({ frame, args }) => {
      const socket = whole(args[0]);
      if (socket === undefined) { host.hide(frame); return NOTHING; }
      const [enabled, glyphType, spellId] = host.callGlobal("GetGlyphSocketInfo", [socket, args[1]], 3);
      if (enabled === undefined && glyphType === undefined) { host.hide(frame); return NOTHING; }
      drawGlyph(frame, socket, truthy(enabled), glyphType !== 2,
        typeof spellId === "number" ? spellId : undefined, false);
      return NOTHING;
    },
    SetTalent: ({ frame, args }) => {
      const tab = whole(args[0]);
      const index = whole(args[1]);
      if (tab === undefined || index === undefined) { host.hide(frame); return NOTHING; }
      const group = whole(args[4]);
      // 3.12 (04.10, L4): with `isPreview` 0x00622800 writes the preview hints, never TOOLTIP_TALENT_LEARN.
      drawTalent(frame, host.adapter()?.talent?.(tab, index, truthy(args[2]), truthy(args[3]), group), !truthy(args[5]));
      return NOTHING;
    },
    SetQuestLogSpecialItem: ({ frame, args }) => {
      host.link(frame, host.callGlobal("GetQuestLogSpecialItemInfo", [args[0]], 1)[0]);
      return NOTHING;
    },
    SetHyperlinkCompareItem: ({ frame, args }) => {
      const index = whole(args[1]);
      const offset = index === undefined ? 0 : index - 1;
      // 3.12 (04.10, L4): index 3 is the merchant's case; `shift` and the anchor tooltip pass on.
      if (offset < 0 || offset > 2 || !compare(frame, args[0], offset, truthy(args[2]), args[3])) {
        host.hide(frame);
        return [undefined];
      }
      return [1];
    },
  };
  return { methods, hyperlink };
}
