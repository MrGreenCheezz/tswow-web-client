/**
 * What the GM console (GmConsole.ts) sends: TrinityCore chat commands, built from a search row or a
 * button. No DOM here, so the strings are tested as they are (tests/gm-console.test.mjs).
 *
 * Every command is checked against this repository's core, `tswow/cores/TrinityCore/src/server/
 * scripts/Commands/cs_*.cpp`; the comment on each names the handler. The server is the judge of who
 * may run them — a player without the security level gets the core's own refusal back in chat, and
 * the console shows it.
 */

export type GmKind = "item" | "creature" | "spell" | "quest" | "tele" | "gameobject";

export interface GmAction {
  /** The button's word. */
  readonly label: string;
  /** The chat line, `.`-prefixed. */
  readonly command: string;
  /** Asked before sending: the commands that write to the world database. */
  readonly confirm?: string;
  /** The button's hint; the command itself when absent. */
  readonly hint?: string;
}

/** The fields of a `/data/gm-search` row the commands and the list read. */
export interface GmRow {
  readonly id: number;
  readonly name: string;
  readonly quality?: number;
  readonly iconId?: number;
  readonly displayId?: number;
  readonly stackable?: number;
  readonly subname?: string;
  readonly rank?: string | number;
  readonly passive?: boolean;
  readonly hidden?: boolean;
  readonly description?: string;
  readonly auraDescription?: string;
  readonly level?: number;
  readonly minLevel?: number;
  readonly map?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly type?: number;
}

export const GM_KINDS: readonly { readonly kind: GmKind; readonly title: string }[] = Object.freeze([
  { kind: "item", title: "Предметы" },
  { kind: "creature", title: "Существа" },
  { kind: "spell", title: "Заклинания" },
  { kind: "quest", title: "Задания" },
  { kind: "tele", title: "Телепорт" },
  { kind: "gameobject", title: "Объекты" },
]);

/** Yards to two places: `.go xyz` parses floats, and a centimetre is below anything a test needs. */
function coordinate(value: number | undefined): string {
  return Number.isFinite(value) ? (Math.round(value! * 100) / 100).toString() : "0";
}

/** How many to give: 1…10000, whole. A field left empty or nonsense gives one. */
export function itemCount(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 10_000) : 1;
}

/** `.go xyz x y z map` (cs_go.cpp HandleGoXYZCommand): works for any point, named or remembered. */
export function goToCommand(point: { map?: number; x?: number; y?: number; z?: number }): string {
  return `.go xyz ${coordinate(point.x)} ${coordinate(point.y)} ${coordinate(point.z)} ${Math.trunc(point.map ?? 0)}`;
}

/** The buttons of one search row, in the order they are drawn. */
export function gmRowActions(kind: GmKind, row: GmRow, options: { count?: number } = {}): GmAction[] {
  const id = Math.trunc(row.id);
  switch (kind) {
    case "item": {
      const count = itemCount(options.count);
      // cs_misc.cpp HandleAddItemCommand: `.additem <id> [count]`, to the selected player or self.
      return [{ label: count > 1 ? `Получить ×${count}` : "Получить", command: `.additem ${id} ${count}` }];
    }
    case "creature":
      return [
        // cs_npc.cpp HandleNpcAddTempSpawnCommand: a summon that despawns, never a world-DB row.
        // `loot` (TEMPSUMMON_CORPSE_TIMED_DESPAWN) so the corpse stays long enough to be looted.
        { label: "Призвать", command: `.npc add temp loot ${id}`, hint: "Временный призыв рядом с вами; труп можно обыскать" },
        // cs_go.cpp HandleGoCreatureCIdCommand: to the first spawn of this entry.
        { label: "К спавну", command: `.go creature id ${id}` },
        // cs_npc.cpp HandleNpcAddCommand: a permanent spawn, written to `creature` in the world DB.
        {
          label: "Спавн в БД", command: `.npc add ${id}`,
          confirm: `Записать постоянный спавн «${row.name}» (${id}) в world-БД?`,
        },
      ];
    case "spell":
      return [
        { label: "Выучить", command: `.learn ${id}` }, // cs_learn.cpp HandleLearnCommand
        { label: "Забыть", command: `.unlearn ${id}` }, // cs_learn.cpp HandleUnLearnCommand
        // cs_misc.cpp HandleAuraCommand / HandleUnAuraCommand: the selected unit, or yourself.
        { label: "Аура", command: `.aura ${id}`, hint: "На выбранную цель; без цели — на себя" },
        { label: "Снять", command: `.unaura ${id}`, hint: "С выбранной цели; без цели — с себя" },
        // cs_cast.cpp HandleCastCommand (at the selection) and HandleCastSelfCommand.
        { label: "Каст", command: `.cast ${id}`, hint: "Вы кастуете в выбранную цель" },
        { label: "На себя", command: `.cast self ${id}`, hint: "Цель кастует на себя" },
      ];
    case "quest":
      return [
        { label: "Взять", command: `.quest add ${id}` }, // cs_quest.cpp HandleQuestAdd
        { label: "Выполнить", command: `.quest complete ${id}` }, // HandleQuestComplete
        { label: "Сдать", command: `.quest reward ${id}` }, // HandleQuestReward
        { label: "Убрать", command: `.quest remove ${id}` }, // HandleQuestRemove
      ];
    case "tele":
      return [{ label: "Телепорт", command: goToCommand(row) }];
    case "gameobject":
      return [
        // cs_gobject.cpp HandleGameObjectAddTempCommand: despawns, never a world-DB row.
        { label: "Поставить", command: `.gobject add temp ${id}`, hint: "Временный объект рядом с вами" },
        { label: "К объекту", command: `.go gameobject id ${id}` }, // cs_go.cpp HandleGoGameObjectGOIdCommand
      ];
  }
}

/** A switch the server keeps and never reports: drawn as its name and two buttons. */
export interface GmToggle {
  readonly label: string;
  readonly on: string;
  readonly off: string;
  readonly hint?: string;
}

export interface GmQuickGroup {
  readonly title: string;
  readonly toggles?: readonly GmToggle[];
  readonly actions?: readonly GmAction[];
}

/** The «Быстрые» tab. Switches get both halves, because the server never says which state a cheat is in. */
export const GM_QUICK_GROUPS: readonly GmQuickGroup[] = Object.freeze([
  {
    title: "Режим ГМ",
    toggles: [
      // cs_gm.cpp: HandleGMOnCommand/OffCommand, HandleGMFlyCommand, HandleGMVisibleCommand (bool).
      { label: "ГМ-режим", on: ".gm on", off: ".gm off" },
      { label: "Полёт", on: ".gm fly on", off: ".gm fly off" },
      { label: "Невидимость", on: ".gm visible off", off: ".gm visible on" },
    ],
  },
  {
    title: "Читы",
    toggles: [
      // cs_cheat.cpp: each takes on/off.
      { label: "Бессмертие", on: ".cheat god on", off: ".cheat god off" },
      { label: "Без перезарядки", on: ".cheat cooldown on", off: ".cheat cooldown off" },
      { label: "Мгновенный каст", on: ".cheat casttime on", off: ".cheat casttime off" },
      { label: "Без затрат", on: ".cheat power on", off: ".cheat power off" },
      { label: "По воде", on: ".cheat waterwalk on", off: ".cheat waterwalk off" },
      { label: "Скорость ×3", on: ".modify speed 3", off: ".modify speed 1" }, // cs_modify.cpp HandleModifyASpeedCommand
    ],
    actions: [
      { label: "Все полёты", command: ".cheat taxi on" },
      { label: "Открыть карту", command: ".cheat explore 1" },
      { label: "Состояние читов", command: ".cheat status" },
    ],
  },
  {
    title: "Персонаж",
    actions: [
      { label: "+1 уровень", command: ".levelup 1" }, { label: "+10 уровней", command: ".levelup 10" }, // cs_character.cpp
      { label: "+1000 золота", command: ".modify money 10000000" }, // cs_modify.cpp, in copper
      { label: "Воскресить", command: ".revive" }, // cs_misc.cpp
      { label: "Починить", command: ".repairitems" },
      { label: "Макс. навыки", command: ".maxskill" },
      { label: "Сбросить КД", command: ".cooldown" },
      { label: "Снять все ауры", command: ".unaura all" },
      { label: "Заклинания класса", command: ".learn my trainer" }, // cs_learn.cpp
      { label: "Все таланты", command: ".learn all talents" },
      { label: "Сбросить таланты", command: ".reset talents" }, // cs_reset.cpp
      { label: "Сохранить", command: ".save" },
    ],
  },
  {
    title: "Место",
    actions: [
      { label: "Где я", command: ".gps" }, // cs_misc.cpp
      { label: "Вернуться", command: ".recall", hint: "Туда, откуда был последний телепорт" },
      { label: "Застрял", command: ".unstuck" },
      { label: "Банк", command: ".bank" }, { label: "Почта", command: ".mailbox" },
      { label: "NPC рядом", command: ".npc near" }, { label: "Объекты рядом", command: ".gobject near" },
      { label: "Респаун вокруг", command: ".respawn" },
    ],
  },
]);

/** The «Цель» tab's buttons: all act on the selected unit (yourself when nothing is selected). */
export const GM_TARGET_ACTIONS: readonly GmAction[] = Object.freeze([
  { label: "Инфо NPC", command: ".npc info" }, // cs_npc.cpp
  { label: "Убить", command: ".die" }, // cs_misc.cpp HandleDieCommand
  { label: "Урон 1000", command: ".damage 1000" },
  { label: "Воскресить", command: ".revive" },
  { label: "Сбросить КД", command: ".cooldown" },
  { label: "Снять все ауры", command: ".unaura all" },
  { label: "Выйти из боя", command: ".combatstop" },
  { label: "Ко мне", command: ".cometome" },
  { label: "Дистанция", command: ".distance" },
  {
    label: "Удалить спавн", command: ".npc delete",
    confirm: "Удалить спавн выбранного существа из world-БД?",
  },
]);

/**
 * What the command line sends for what was typed: trimmed, and `.`-prefixed when the prefix was left
 * off — the console only ever speaks to the command parser, never to the people around. A `/` line
 * is a client slash command and goes through as typed.
 */
export function normaliseCommand(text: string): string | undefined {
  const line = text.trim();
  if (!line || line === "." || line === "/") return undefined;
  if (line.startsWith(".") || line.startsWith("/")) return line;
  if (line.startsWith("!")) return `.${line.slice(1)}`;
  return `.${line}`;
}

/** The storage the two lists below write to; `localStorage` in the page, a fake in the tests. */
export interface GmStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(storage: GmStorage | undefined, key: string): unknown {
  try {
    const text = storage?.getItem(key);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function write(storage: GmStorage | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // A private window or a full quota: the lists live for this page only.
  }
}

/** The commands sent, newest last, without repeats in a row; ↑/↓ in the command line walk it. */
export class GmHistory {
  static readonly KEY = "webclient.gm.history.v1";
  static readonly LIMIT = 100;
  readonly #storage: GmStorage | undefined;
  #lines: string[];

  constructor(storage?: GmStorage) {
    this.#storage = storage;
    const saved = read(storage, GmHistory.KEY);
    this.#lines = Array.isArray(saved) ? saved.filter((line): line is string => typeof line === "string").slice(-GmHistory.LIMIT) : [];
  }

  get lines(): readonly string[] {
    return this.#lines;
  }

  add(line: string): void {
    if (this.#lines.at(-1) === line) return;
    this.#lines.push(line);
    if (this.#lines.length > GmHistory.LIMIT) this.#lines.splice(0, this.#lines.length - GmHistory.LIMIT);
    write(this.#storage, GmHistory.KEY, this.#lines);
  }
}

export interface GmFavorite {
  readonly kind: GmKind;
  readonly row: GmRow;
}

/**
 * Starred rows, per kind, kept as the row itself so the list shows without a search. A remembered
 * place (`rememberPlace`) is a `tele` row with a negative id, which no `game_tele` row has.
 */
export class GmFavorites {
  static readonly KEY = "webclient.gm.favorites.v1";
  readonly #storage: GmStorage | undefined;
  #entries: GmFavorite[];

  constructor(storage?: GmStorage) {
    this.#storage = storage;
    const saved = read(storage, GmFavorites.KEY);
    this.#entries = Array.isArray(saved)
      ? saved.filter((entry): entry is GmFavorite => !!entry && typeof entry === "object"
        && GM_KINDS.some(({ kind }) => kind === (entry as GmFavorite).kind)
        && typeof (entry as GmFavorite).row?.id === "number" && typeof (entry as GmFavorite).row?.name === "string")
      : [];
  }

  list(kind: GmKind): readonly GmRow[] {
    return this.#entries.filter((entry) => entry.kind === kind).map((entry) => entry.row);
  }

  has(kind: GmKind, id: number): boolean {
    return this.#entries.some((entry) => entry.kind === kind && entry.row.id === id);
  }

  /** Stars or unstars; answers whether the row is starred now. */
  toggle(kind: GmKind, row: GmRow): boolean {
    const index = this.#entries.findIndex((entry) => entry.kind === kind && entry.row.id === row.id);
    if (index >= 0) this.#entries.splice(index, 1);
    else this.#entries.push({ kind, row });
    write(this.#storage, GmFavorites.KEY, this.#entries);
    return index < 0;
  }

  /** Where the player stands now, as a starred teleport point. */
  rememberPlace(name: string, point: { map: number; x: number; y: number; z: number }, now = Date.now()): GmRow {
    const row: GmRow = { id: -now, name, map: point.map, x: point.x, y: point.y, z: point.z };
    this.#entries.push({ kind: "tele", row });
    write(this.#storage, GmFavorites.KEY, this.#entries);
    return row;
  }
}

/** Item quality → the stock ITEM_QUALITY_COLORS hex, for the row's name. */
export const GM_QUALITY_COLOURS: readonly string[] = Object.freeze([
  "#9d9d9d", "#ffffff", "#1eff00", "#0070dd", "#a335ee", "#ff8000", "#e6cc80", "#e6cc80",
]);
