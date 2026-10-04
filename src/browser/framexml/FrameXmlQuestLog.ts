/**
 * Plan item 3.13a/b: the stock quest log's zone headers, collapsing, tags and the quest-log extras
 * (`GetQuestLink`, `GetQuestSortIndex`, the special item, the daily and completed counts).
 *
 * The browser keeps the log as the 25 PLAYER_QUEST_LOG slots; the stock `QuestLogFrame`/`WatchFrame`
 * index a *displayed* list instead, the way the original client builds it. Read from Wow.exe.clean
 * (descriptions in this file's words, nothing copied):
 *
 * * Building (0x005e6940): the slots are walked in field order; a quest whose cache record is not
 *   there yet is left out (and asked for); each listed quest adds a row, and its `ZoneOrSort` (cache
 *   offset 0x10) adds a header row the first time that key is met. The key is signed; the realm
 *   writes it as a u32 (QuestPackets.cpp `uint32(Info.QuestSortID)`), so a QuestSort key reaches the
 *   parser as 2^32 − id and is read back as negative here. The header keys are then ordered
 *   by name (0x005dfdc0: key 0 first, then the name compare below; a positive key is named by
 *   AreaTable, a negative one by QuestSort, key 0 is "Missing header! (quest designers)").
 * * The name compare (0x0076ec80, headers and titles): code point by code point, each folded as
 *   0x0076e7a0 folds (a–z, U+00E0–U+00FE and а–я to upper case, œ → Œ, ё → Ё) and then stripped as
 *   0x0076eab0 strips (À–Æ → A, Ç → C, È–Ë → E, Ì–Ï → I, Ñ → N, Ò–Ö → O, Ù–Ü → U, ß → S, Œ → O,
 *   Ё → Е); the first stripped difference decides, and strings equal after stripping are ordered by
 *   the first raw code point difference. The ligature matches of 0x0076eb80 (Æ = "AE", ß = "SS",
 *   Œ = "OE") are not modelled.
 * * Collapsing is kept per header: the client keeps it as the `questLogCollapseFilter` CVar, one bit
 *   per header position, carried over by key from the *previous* header list only when the log is
 *   rebuilt; a header not in that list — seen for the first time, or back after leaving the log — is
 *   expanded. The first build after login has no previous list, so every header starts expanded and
 *   the CVar restores nothing across sessions. Here it is kept by key and dropped with the header.
 * * Ordering (0x005e08f0): rows under a collapsed header go after every other row; the rest follow
 *   their header's position, the header first, then its quests by level (a level of -1 is the
 *   player's) and by title. The first value of `GetNumQuestLogEntries` (0x005df010) counts the rows
 *   before the collapsed tail; the second counts every quest row. Every index the C API takes is a
 *   1-based position in this whole list, the collapsed tail included.
 * * `ExpandQuestHeader`/`CollapseQuestHeader` (0x005e5150/0x005e5100 → 0x005e0c00): on a header
 *   row they change that header; on anything else (0, a quest row, out of range) they expand or
 *   collapse every header. Either way the log is rebuilt and QUEST_LOG_UPDATE fires.
 * * `GetQuestLogTitle` (0x005e5cc0): the questTag is QuestInfo's name for the quest's Type (0x005e0070),
 *   isDaily is Flags & 0x1000 (0x005decc0), a header answers level 0, isHeader 1 and isCollapsed.
 * * `GetQuestSortIndex(questIndex)` (0x005dfa10): 1 + the position of the row's header key in the
 *   *header list* (0 when there is none) — not a log index, although WatchFrame.lua:123 passes it to
 *   ExpandQuestHeader as one.
 * * `GetQuestLink(index)` (0x005e51d0 → 0x0061e5c0): `<colour>|Hquest:<id>:<level>|h[<title>]|h|r` for
 *   a quest row, with the record's own level (-1 stays -1) and the colour of 0x0061e540: the level
 *   less the player's above 4 red, above 2 orange, above -3 yellow, otherwise grey when the player is
 *   more than GetQuestGreenRange above it and green if not; nil for a header or no row.
 * * `GetQuestLogSpecialItemInfo`/`UseQuestLogSpecialItem` (0x005e52d0/0x005e5640 → 0x005e0da0): a quest
 *   with a SourceItemId (cache 0x4c) or the flag QUEST_FLAGS_DISPLAY_ITEM_IN_TRACKER (0x20000,
 *   QuestDef.h:153) has a special item when the player carries its source item, or with the flag one of
 *   its four RequiredSourceItemIds (cache 0x1c74, all four, a slot without a creature included —
 *   `sourceItems` from QuestProtocol.ts), and that item has a use spell. Info answers
 *   link, icon path and the item's spell charges.
 * * `GetDailyQuestsCompleted` (0x0058db30): the non-zero words of PLAYER_FIELD_DAILY_QUESTS_1 (25);
 *   `GetMaxDailyQuests` (0x0058c470) answers 25.
 * * `GetQuestsCompleted([t])` (0x005b5290): the table passed, or a new one, gets `t[questId] = true`
 *   for every quest of the last SMSG_QUERY_QUESTS_COMPLETED_RESPONSE; `QueryQuestsCompleted`
 *   (0x005b1bb0) sends CMSG_QUERY_QUESTS_COMPLETED. The response's handler (0x005b5190) empties the
 *   list, reads the count and the ids, then signals event 0x296, QUEST_QUERY_COMPLETE, without
 *   arguments — after every answer (TrinityCore QuestHandler.cpp HandleQueryQuestsCompleted).
 */
import type { QuestLogEntry } from "../../world/Fields.js";
import type { FrameXmlQuestLogTitle } from "./FrameXmlWorldSeam.js";
import { frameXmlLuaNumber, frameXmlRoundToInt } from "./FrameXmlPvpFlag.js";

export const QUEST_FLAG_DAILY = 0x1000;
export const QUEST_FLAG_DISPLAY_ITEM_IN_TRACKER = 0x20000;
/** Wow.exe 0x0058c470 (the double at 0x00a13578). */
export const FRAMEXML_MAX_DAILY_QUESTS = 25;
export const FRAMEXML_DAILY_QUEST_WORDS = 25;
export const QUEST_LOG_MISSING_HEADER = "Missing header! (quest designers)";
/** Item spell trigger «on use» (ItemTemplate.h ITEM_SPELLTRIGGER_ON_USE). */
const ITEM_SPELL_TRIGGER_ON_USE = 0;

/** The difficulty colours of 0x0061e540 (the string table at 0x00ad2a68). */
export const QUEST_LINK_COLORS = Object.freeze({
  red: "|cffff2020", orange: "|cffff8040", yellow: "|cffffff00", green: "|cff40c040", gray: "|cff808080",
});

/** The quest cache fields this model reads (world/QuestProtocol.ts QuestTemplate). */
export interface FrameXmlQuestLogTemplate {
  readonly level: number;
  readonly title: string;
  readonly sortId: number;
  readonly type: number;
  readonly flags: number;
  readonly startItem?: number;
  /** The four ItemDrop (RequiredSourceItemId) slots as sent; preferred over `objectives`. */
  readonly sourceItems?: readonly number[];
  readonly objectives?: readonly { readonly itemDrop?: number }[];
}

/** One carried item the special-item search found. */
export interface FrameXmlQuestSpecialItem {
  readonly bag: number;
  readonly slot: number;
  readonly link: string;
  readonly texture: string;
  readonly charges: number;
}

/** Header and tag names: the areas catalog and `/dbc/quest-log-names` (QuestLogNameClient.ts). */
export interface FrameXmlQuestLogNames {
  sortName(id: number): string | undefined;
  infoName(type: number): string | undefined;
  /** Called when the names arrive, so an open log redraws; answers the unsubscribe. */
  subscribe?(listener: () => void): () => void;
}

export interface FrameXmlQuestLogContext {
  /** The PLAYER_QUEST_LOG slots in field order. */
  rows(): readonly QuestLogEntry[];
  template(questId: number): FrameXmlQuestLogTemplate | undefined;
  /** Ask the realm for a quest's record (the client asks while building). */
  requestTemplate?(questId: number): void;
  playerLevel(): number | undefined;
  /** GetQuestGreenRange for the player (0x005e2860). */
  greenRange(): number;
  areaName(areaId: number): string | undefined;
  readonly names?: FrameXmlQuestLogNames | undefined;
  /** PLAYER_FIELD_DAILY_QUESTS_1..25; undefined without a player. */
  dailyQuests?(): readonly number[] | undefined;
  completedQuests?(): Iterable<number> | undefined;
  requestCompletedQuests?(): void;
  /** Called after each SMSG_QUERY_QUESTS_COMPLETED_RESPONSE has replaced the list; answers the unsubscribe. */
  onCompletedQuests?(listener: () => void): (() => void) | undefined;
  /** The first carried item of these entries that has a use spell, in the order given. */
  findItem?(entries: readonly number[]): FrameXmlQuestSpecialItem | undefined;
  itemCooldown?(item: FrameXmlQuestSpecialItem): readonly [start: number, duration: number, enable: number];
  useItem?(item: FrameXmlQuestSpecialItem): void;
}

interface FrameXmlQuestLogPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export type FrameXmlQuestLogRow =
  | { readonly header: true; readonly key: number; readonly title: string | undefined; readonly collapsed: boolean }
  | {
    readonly header: false; readonly entry: QuestLogEntry; readonly template: FrameXmlQuestLogTemplate;
    /** The record's level with -1 read as the player's. */
    readonly level: number; readonly hidden: boolean;
  };

export interface FrameXmlQuestLogList {
  readonly rows: readonly FrameXmlQuestLogRow[];
  /** Rows before the collapsed tail: `GetNumQuestLogEntries`' first value. */
  readonly visible: number;
  readonly quests: number;
  /** Header keys in header-list order (GetQuestSortIndex positions). */
  readonly headers: readonly number[];
}

/** A quest's header key, its signed ZoneOrSort (the wire's u32 read back); none is key 0. */
function sortKeyOf(template: FrameXmlQuestLogTemplate): number {
  return Number.isSafeInteger(template.sortId) ? template.sortId | 0 : 0;
}

/** A u32 level of 0xffffffff is the record's -1 («the player's level»). */
function recordLevel(level: number): number {
  return level === 0xffff_ffff ? -1 : level;
}

/** 0x0076e7a0's fold: a–z, U+00E0–U+00FE and а–я to upper case, œ → Œ, ё → Ё; nothing else. */
function foldCase(code: number): number {
  if ((code >= 0x61 && code <= 0x7a) || (code >= 0xe0 && code <= 0xfe) || (code >= 0x430 && code <= 0x44f)) {
    return code - 0x20;
  }
  if (code === 0x153) return 0x152;
  if (code === 0x451) return 0x401;
  return code;
}

/** 0x0076eab0's strip of a folded code point: Latin-1 accents to their letter, Œ → O, Ё → Е. */
function stripAccent(code: number): number {
  if (code >= 0xc0 && code <= 0xdf) {
    if (code <= 0xc6) return 0x41;
    if (code === 0xc7) return 0x43;
    if (code <= 0xcb) return 0x45;
    if (code <= 0xcf) return 0x49;
    if (code === 0xd1) return 0x4e;
    if (code >= 0xd2 && code <= 0xd6) return 0x4f;
    if (code >= 0xd9 && code <= 0xdc) return 0x55;
    if (code === 0xdf) return 0x53;
    return code;
  }
  if (code === 0x152) return 0x4f;
  if (code === 0x401) return 0x415;
  return code;
}

/**
 * The client's name compare for headers and titles (0x0076ec80, see the file comment): the first
 * difference after folding and stripping decides; otherwise the first raw difference; an ended
 * string reads as code point 0.
 */
export function frameXmlQuestLogCompare(left: string, right: string): number {
  let tie = 0;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const x = i < left.length ? left.codePointAt(i)! : 0;
    const y = j < right.length ? right.codePointAt(j)! : 0;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
    // 0x0076e7a0 decodes to 16 bits: anything above is U+FFFD.
    const rawX = x > 0xffff ? 0xfffd : x;
    const rawY = y > 0xffff ? 0xfffd : y;
    const sx = stripAccent(foldCase(rawX));
    const sy = stripAccent(foldCase(rawY));
    if (sx !== sy) return sx - sy;
    if (tie === 0) tie = rawX - rawY;
  }
  return tie;
}

/** A Lua index argument as the client converts it; undefined when it is not a number. */
function luaIndex(value: unknown): number | undefined {
  const number = frameXmlLuaNumber(value);
  return number === undefined || !Number.isFinite(number) ? undefined : frameXmlRoundToInt(number);
}

export class FrameXmlQuestLogModel {
  readonly #context: FrameXmlQuestLogContext;
  /** Header key → collapsed; a key not here is expanded. */
  readonly #collapsed = new Map<number, boolean>();
  #collapseRevision = 0;
  /**
   * The last list and every input it was built from. Stock Lua reads the log through dozens of C
   * calls per redraw (WatchFrame: ~9 per watched quest), each resolving an index; a rebuild sorts
   * with the name compare (~20 µs for 25 quests, bench), so the list is rebuilt only when an input
   * changed: a slot's contents, a cache record (by identity), the player's level, a header name or
   * the collapse state.
   */
  #cache: { readonly key: readonly unknown[]; readonly list: FrameXmlQuestLogList } | undefined;
  #pump: FrameXmlQuestLogPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeCompleted: (() => void) | undefined;

  constructor(context: FrameXmlQuestLogContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlQuestLogPump): void {
    this.#pump = pump;
    this.#unsubscribe?.();
    this.#unsubscribeCompleted?.();
    this.#unsubscribe = this.#context.names?.subscribe?.(() => this.#publish());
    // 0x005b5190: every answer replaces the list, then QUEST_QUERY_COMPLETE, no arguments.
    this.#unsubscribeCompleted = this.#context.onCompletedQuests?.(() => { this.#pump?.fire("QUEST_QUERY_COMPLETE"); });
  }

  detach(): void {
    this.#pump = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeCompleted?.();
    this.#unsubscribeCompleted = undefined;
  }

  #publish(): void {
    this.#pump?.fire("QUEST_LOG_UPDATE");
  }

  #headerName(key: number): string | undefined {
    if (key === 0) return QUEST_LOG_MISSING_HEADER;
    return key > 0 ? this.#context.areaName(key) : this.#context.names?.sortName(-key);
  }

  /** The displayed list, built from the slots as the client builds it. */
  list(): FrameXmlQuestLogList {
    const playerLevel = this.#context.playerLevel();
    const quests: { entry: QuestLogEntry; template: FrameXmlQuestLogTemplate; level: number }[] = [];
    const keys: number[] = [];
    const inputs: unknown[] = [playerLevel, this.#collapseRevision];
    for (const entry of this.#context.rows()) {
      if (!(entry.questId > 0)) continue;
      const template = this.#context.template(entry.questId);
      if (!template) {
        this.#context.requestTemplate?.(entry.questId);
        continue;
      }
      inputs.push(entry.slot, entry.questId, entry.state, entry.timer, template, entry.counters.length, ...entry.counters);
      const raw = recordLevel(Number.isSafeInteger(template.level) ? template.level : 0);
      quests.push({ entry, template, level: raw === -1 && playerLevel !== undefined ? playerLevel : raw });
      if (!keys.includes(sortKeyOf(template))) keys.push(sortKeyOf(template));
    }
    const names = new Map(keys.map((key) => [key, this.#headerName(key)]));
    for (const [key, name] of names) inputs.push(key, name);
    const cached = this.#cache;
    if (cached && cached.key.length === inputs.length && cached.key.every((value, index) => Object.is(value, inputs[index]))) {
      return cached.list;
    }
    // A header gone from the log loses its collapse, as the client's rebuild drops its bit.
    for (const key of [...this.#collapsed.keys()]) if (!names.has(key)) this.#collapsed.delete(key);
    const headers = [...keys].sort((a, b) => {
      if (a === b) return 0;
      if (a === 0) return -1;
      if (b === 0) return 1;
      return frameXmlQuestLogCompare(names.get(a) ?? "", names.get(b) ?? "");
    });
    const position = new Map(headers.map((key, index) => [key, index]));
    const collapsed = (key: number): boolean => this.#collapsed.get(key) === true;
    // Quests before headers: the order below is the comparator's alone, not the input's.
    const rows: FrameXmlQuestLogRow[] = [
      ...quests.map((quest): FrameXmlQuestLogRow => ({ header: false, ...quest, hidden: collapsed(sortKeyOf(quest.template)) })),
      ...headers.map((key): FrameXmlQuestLogRow => ({ header: true, key, title: names.get(key), collapsed: collapsed(key) })),
    ];
    const keyOf = (row: FrameXmlQuestLogRow): number => row.header ? row.key : sortKeyOf(row.template);
    rows.sort((a, b) => {
      const hiddenA = !a.header && a.hidden;
      const hiddenB = !b.header && b.hidden;
      if (hiddenA !== hiddenB) return hiddenA ? 1 : -1;
      const byHeader = position.get(keyOf(a))! - position.get(keyOf(b))!;
      if (byHeader !== 0) return byHeader;
      if (a.header) return -1;
      if (b.header) return 1;
      if (a.level !== b.level) return a.level - b.level;
      return frameXmlQuestLogCompare(a.template.title ?? "", b.template.title ?? "");
    });
    const hidden = rows.filter((row) => !row.header && row.hidden).length;
    const list = { rows, visible: rows.length - hidden, quests: quests.length, headers };
    this.#cache = { key: inputs, list };
    return list;
  }

  /** The row at a 1-based log index, the collapsed tail included. */
  rowAt(index: number, list = this.list()): FrameXmlQuestLogRow | undefined {
    return Number.isInteger(index) && index >= 1 ? list.rows[index - 1] : undefined;
  }

  /** The slot entry of the quest row at a 1-based index; undefined for a header or no row. */
  entryAt(index: number): QuestLogEntry | undefined {
    const row = this.rowAt(index);
    return row && !row.header ? row.entry : undefined;
  }

  /** The 1-based log index of a quest's row. */
  indexOfQuest(questId: number): number | undefined {
    const index = this.list().rows.findIndex((row) => !row.header && row.entry.questId === questId);
    return index < 0 ? undefined : index + 1;
  }

  counts(): readonly [number, number] {
    const list = this.list();
    return [list.visible, list.quests];
  }

  /**
   * `GetQuestLogTitle(index)`: a header's row, or a quest's with the questTag, the level and isDaily;
   * `complete` answers isComplete for a quest row (the seam's own reading of the slot state).
   */
  title(index: number, complete: (entry: QuestLogEntry) => number | undefined): FrameXmlQuestLogTitle {
    const row = this.rowAt(index);
    if (!row) return ["", 0, undefined, 0, false, false, undefined, false, 0, false];
    if (row.header) return [row.title ?? "", 0, undefined, 0, true, row.collapsed, undefined, false, 0, false];
    const template = row.template as FrameXmlQuestLogTemplate & { readonly suggestedPlayers?: number };
    return [
      template.title ?? "", row.level, this.#context.names?.infoName(template.type), template.suggestedPlayers ?? 0,
      false, false, complete(row.entry), (template.flags & QUEST_FLAG_DAILY) !== 0, row.entry.questId, false,
    ];
  }

  /** `ExpandQuestHeader(index)` (collapse false) and `CollapseQuestHeader(index)` (collapse true). */
  setCollapsed(value: unknown, collapse: boolean): void {
    const index = luaIndex(value);
    if (index === undefined) return;
    const list = this.list();
    const row = this.rowAt(index, list);
    if (row?.header) {
      if (collapse) this.#collapsed.set(row.key, true);
      else this.#collapsed.delete(row.key);
    } else if (collapse) {
      for (const key of list.headers) this.#collapsed.set(key, true);
    } else {
      this.#collapsed.clear();
    }
    this.#collapseRevision++;
    this.#publish();
  }

  /** `GetQuestSortIndex(questIndex)`: 1 + the row's header position, 0 for none. */
  sortIndex(value: unknown): number {
    const index = luaIndex(value);
    if (index === undefined) return 0;
    const list = this.list();
    const row = this.rowAt(index, list);
    if (!row) return 0;
    return list.headers.indexOf(row.header ? row.key : sortKeyOf(row.template)) + 1;
  }

  /** `GetQuestLink(index)`; undefined for a header or no row. */
  link(value: unknown): string | undefined {
    const index = luaIndex(value);
    const row = index === undefined ? undefined : this.rowAt(index);
    if (!row || row.header) return undefined;
    const raw = recordLevel(row.template.level);
    return `${this.#linkColor(row.level)}|Hquest:${row.entry.questId}:${raw}|h[${row.template.title ?? ""}]|h|r`;
  }

  #linkColor(level: number): string {
    const playerLevel = this.#context.playerLevel();
    if (playerLevel === undefined) return QUEST_LINK_COLORS.yellow;
    const difference = level - playerLevel;
    if (difference > 4) return QUEST_LINK_COLORS.red;
    if (difference > 2) return QUEST_LINK_COLORS.orange;
    if (difference > -3) return QUEST_LINK_COLORS.yellow;
    const green = this.#context.greenRange();
    return -difference !== green && green <= -difference ? QUEST_LINK_COLORS.gray : QUEST_LINK_COLORS.green;
  }

  #specialItem(value: unknown): FrameXmlQuestSpecialItem | undefined {
    const index = luaIndex(value);
    const row = index === undefined ? undefined : this.rowAt(index);
    if (!row || row.header) return undefined;
    const { startItem = 0, flags, objectives = [], sourceItems } = row.template;
    const flagged = (flags & QUEST_FLAG_DISPLAY_ITEM_IN_TRACKER) !== 0;
    if (startItem <= 0 && !flagged) return undefined;
    const entries = startItem > 0 ? [startItem] : [];
    if (flagged) {
      for (const drop of sourceItems ?? objectives.map((objective) => objective.itemDrop ?? 0)) {
        if (drop > 0) entries.push(drop);
      }
    }
    return entries.length > 0 ? this.#context.findItem?.(entries) : undefined;
  }

  /** `GetQuestLogSpecialItemInfo(index)`: link, texture, charges; undefined for none. */
  specialItemInfo(value: unknown): readonly [link: string, texture: string, charges: number] | undefined {
    const item = this.#specialItem(value);
    return item ? [item.link, item.texture, item.charges] : undefined;
  }

  /** `GetQuestLogSpecialItemCooldown(index)`; undefined for none. */
  specialItemCooldown(value: unknown): readonly [number, number, number] | undefined {
    const item = this.#specialItem(value);
    return item ? this.#context.itemCooldown?.(item) ?? [0, 0, 1] : undefined;
  }

  /** `UseQuestLogSpecialItem(index)`. */
  useSpecialItem(value: unknown): void {
    const item = this.#specialItem(value);
    if (item) this.#context.useItem?.(item);
  }

  /** `GetDailyQuestsCompleted()`. */
  dailyQuestsCompleted(): number {
    const words = this.#context.dailyQuests?.();
    if (!words) return 0;
    let count = 0;
    for (let index = 0; index < FRAMEXML_DAILY_QUEST_WORDS; index++) if ((words[index] ?? 0) !== 0) count++;
    return count;
  }

  /** The quest ids `GetQuestsCompleted` writes into its table. */
  completedQuests(): number[] {
    const ids = this.#context.completedQuests?.();
    return ids ? [...ids] : [];
  }

  queryCompletedQuests(): void {
    this.#context.requestCompletedQuests?.();
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlQuestLogHost {
  readonly questLog?: FrameXmlQuestLogModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_QUEST_LOG_BINDINGS: Readonly<Record<string,
  (host: FrameXmlQuestLogHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  ExpandQuestHeader: (host, args) => { host.questLog?.setCollapsed(args[0], false); return NOTHING; },
  CollapseQuestHeader: (host, args) => { host.questLog?.setCollapsed(args[0], true); return NOTHING; },
  GetQuestSortIndex: (host, args) => [host.questLog?.sortIndex(args[0]) ?? 0],
  GetQuestLink: (host, args) => {
    const link = host.questLog?.link(args[0]);
    return link === undefined ? [undefined] : [link];
  },
  GetQuestLogSpecialItemInfo: (host, args) => {
    const info = host.questLog?.specialItemInfo(args[0]);
    return info === undefined ? NOTHING : [...info];
  },
  GetQuestLogSpecialItemCooldown: (host, args) => {
    const cooldown = host.questLog?.specialItemCooldown(args[0]);
    return cooldown === undefined ? NOTHING : [...cooldown];
  },
  UseQuestLogSpecialItem: (host, args) => { host.questLog?.useSpecialItem(args[0]); return NOTHING; },
  GetDailyQuestsCompleted: (host) => [host.questLog?.dailyQuestsCompleted() ?? 0],
  GetMaxDailyQuests: () => [FRAMEXML_MAX_DAILY_QUESTS],
  QueryQuestsCompleted: (host) => { host.questLog?.queryCompletedQuests(); return NOTHING; },
  // The Lua half (FRAMEXML_QUEST_LOG_PRELUDE) writes these ids into the table the caller passes.
  GetQuestsCompleted: (host) => host.questLog?.completedQuests() ?? NOTHING,
});

/** `GetQuestsCompleted([t])`: the host's ids become `t[id] = true`; the table itself is answered. */
export const FRAMEXML_QUEST_LOG_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local ids = rawget(_G, "__fxSeam_GetQuestsCompleted")
  if impl ~= nil and ids ~= nil then
    impl.GetQuestsCompleted = function(t)
      if type(t) ~= "table" then t = {} end
      local list = { ids() }
      for index = 1, #list do t[list[index]] = true end
      return t
    end
  end
end
`;
