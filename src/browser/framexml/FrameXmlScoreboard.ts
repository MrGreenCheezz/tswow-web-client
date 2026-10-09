/**
 * The battleground/arena scoreboard's C API — WorldStateScoreFrame's `GetNumBattlefieldScores`,
 * `GetBattlefieldScore`, `SetBattlefieldScoreFaction`, `SortBattlefieldScoreData`,
 * `GetBattlefieldTeamInfo`, `GetNumBattlefieldStats`, `GetBattlefieldStatInfo`,
 * `GetBattlefieldStatData`, `RequestBattlefieldScoreData`, the UPDATE_BATTLEFIELD_SCORE event —
 * and `LeaveBattlefield`, over `MSG_PVP_LOG_DATA` (`WorldClient.pvpScores`).
 *
 * Stock callers: WorldStateFrame.lua:577-826 (WorldStateScoreFrame_Update: twelve values a row,
 * `GetBattlefieldTeamInfo(faction)` for every row, `GetBattlefieldStatData(index, j) > 0` unguarded,
 * the column icon concatenated with the row's faction), :924 (the faction tabs: nil, 1, 0),
 * WorldStateFrame.xml:127 (the column headers' `SortBattlefieldScoreData(sortType)`), :1480 (the
 * leave button's `LeaveBattlefield`) and :1567 (`RequestBattlefieldScoreData` as the frame's
 * OnUpdate — every frame while it is shown). BattlefieldFrame.lua:688 is the queue icon menu's
 * «leave».
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra; Lua C functions found through
 * their registration entries in .data), described in this file's words:
 * * The MSG_PVP_LOG_DATA handler (0x54d280) keeps every row it is sent, in packet order, and the
 *   arena teams' three rating words per team in packet order with the team names. It asks the name
 *   cache for every row; only once no name is outstanding does it rebuild the list (0x54aa30) —
 *   work out a battleground row's side from its race (ChrRaces.FactionID → FactionTemplate's faction
 *   group: Horde 0, Alliance 1, neither -1; an unknown name counts as 0), count the rows of the
 *   chosen side, sort, and fire UPDATE_BATTLEFIELD_SCORE. An arena row's side is the team byte of
 *   the packet.
 * * `GetBattlefieldScore(index)` (0x54be90) answers twelve values from the sorted list; a row whose
 *   name the cache does not hold, or an index past the end, answers nil, five zeros, 0, three nils
 *   and two zeros. Race and class are the name cache's (localised), the class token is
 *   ChrClasses.Filename; an unknown class answers nil for both. The rank is always 0.
 * * `GetNumBattlefieldScores` (0x549e80) is the chosen side's count; `SetBattlefieldScoreFaction`
 *   (0x54c120) takes nil (everyone), 0 or 1 — any other number is ignored — and rebuilds.
 * * The sort (0x54a740) puts the chosen side's rows first, then walks seventeen keys in order:
 *   killing blows, deaths, bonus honor, name, class, honorable kills, damage, healing, side,
 *   eight objective columns. Numbers sort large first, names and sides small first.
 *   `SortBattlefieldScoreData(type)` (0x54de00/0x54cee0) moves the named key to the front, or flips
 *   its direction when it already is; "kills", "deaths", "cp", "name", "class", "hk", "damage",
 *   "healing", "team" and "statN" (N up to 8) are its names, any other word means "kills".
 * * `GetNumBattlefieldStats`/`GetBattlefieldStatInfo(i)` (0x549f20/0x54c170): the WorldStateUI rows
 *   of type 2 for the running battlefield's map (or map -1), the first contiguous run in table order
 *   (set by SMSG_BATTLEFIELD_STATUS, 0x54ae40); text, icon and tooltip in that order, three nils past
 *   the end. `GetBattlefieldStatData(index, j)` (0x549f60) is objective j of the row, 0 when absent.
 * * `GetBattlefieldTeamInfo(i)` (0x54a180): for 0 and 1 the team name and the three words as sent —
 *   TrinityCore writes rating lost, rating won and matchmaker rating there (Arena.cpp:49-58), which
 *   stock subtracts as `newTeamRating - teamRating`; any other index nil and three zeros.
 * * `RequestBattlefieldScoreData` (0x54ce30) sends MSG_PVP_LOG_DATA the first time, then only while
 *   the match has not ended and is not an arena, and never within 5000 ms of the previous request.
 *   The stock OnUpdate calls it every frame; this gate is the whole rate limit.
 * * `LeaveBattlefield` (0x54c250) sends CMSG_LEAVE_BATTLEFIELD for the running battlefield
 *   (`WorldClient.leaveBattleground`).
 * * Leaving the match (0x54ca50) forgets the rows, the teams, the side filter and the request gate.
 */
import {
  PVP_TEAM_ALLIANCE, PVP_TEAM_HORDE, STATUS_IN_PROGRESS, type PvpLogData, type PvpScore,
} from "../../world/PvpProtocol.js";
import type { WorldStateUiRow } from "../../world/WorldStateUiData.js";
import { className, classFileName, raceName } from "../ui/UnitSnapshot.js";
import { frameXmlLuaNumber } from "./FrameXmlPvpFlag.js";

/** Name, race and class as the client's name cache holds them. */
export interface FrameXmlScoreboardNames {
  get(guid: bigint): string | undefined;
  /** A query for the guid is out and unanswered (an answer «unknown» leaves no name and no query). */
  isPending?(guid: bigint): boolean;
  details?(guid: bigint): {
    readonly race: number; readonly classId: number;
    /** L3 3.14: 0 male, 1 female, from the same answer (the cache entry's +0x144). */
    readonly gender?: number;
  } | undefined;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlScoreboardWorld {
  readonly pvpScores?: PvpLogData | undefined;
  readonly battlefieldQueues?: ReadonlyMap<number, {
    readonly status: number; readonly isArena: boolean; readonly mapId: number;
  }> | undefined;
  readonly names?: FrameXmlScoreboardNames | undefined;
  readonly events?: {
    on(name: "PVP_SCOREBOARD_CHANGED", listener: (change: { readonly ended: boolean }) => void): () => void;
    on(name: "BATTLEFIELD_QUEUE_CHANGED",
      listener: (change: { readonly queueSlot: number; readonly status: number; readonly cleared: boolean }) => void): () => void;
  } | undefined;
  requestName?(guid: bigint): void;
  requestPvpScores?(): void;
  leaveBattleground?(): void;
}

export interface FrameXmlScoreboardContext {
  world(): FrameXmlScoreboardWorld | undefined;
  /** A millisecond clock that keeps running. */
  now(): number;
  /** The WorldStateUI table in file order (the scoreboard columns are its type-2 rows). */
  worldStateUi?(): readonly Pick<WorldStateUiRow, "mapId" | "type" | "text" | "icon" | "tooltip">[] | undefined;
}

interface FrameXmlScoreboardPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const FRAMEXML_SCOREBOARD_EVENT = "UPDATE_BATTLEFIELD_SCORE";
/** 0x54ce30: the client's own spacing between two scoreboard requests. */
export const FRAMEXML_SCORE_REQUEST_INTERVAL_MS = 5000;
/** WorldStateUI.Type of a scoreboard column. */
const WORLD_STATE_UI_SCORE_COLUMN = 2;
/** The objective words a row keeps (0x54d280) and the columns `GetBattlefieldStatData` reads (0x549f60). */
const ROW_OBJECTIVES = 8;
const STAT_DATA_COLUMNS = 9;
/** The seventeen sort keys, in the client's default order (0x54e720). */
const SORT_KEYS = 17;
const KEY_KILLS = 0;
const KEY_DEATHS = 1;
const KEY_HONOR = 2;
const KEY_NAME = 3;
const KEY_CLASS = 4;
const KEY_HONORABLE_KILLS = 5;
const KEY_DAMAGE = 6;
const KEY_HEALING = 7;
const KEY_SIDE = 8;
const KEY_FIRST_STAT = 9;
/** SortBattlefieldScoreData's words (0x54de00). */
const SORT_WORDS: Readonly<Record<string, number>> = Object.freeze({
  kills: KEY_KILLS, deaths: KEY_DEATHS, cp: KEY_HONOR, name: KEY_NAME, class: KEY_CLASS,
  hk: KEY_HONORABLE_KILLS, damage: KEY_DAMAGE, healing: KEY_HEALING, team: KEY_SIDE,
});
/** The stock races by id, as LiveWorldSeam.unitFactionGroup answers them. */
const ALLIANCE_RACE_IDS = new Set([1, 3, 4, 7, 11]);
const HORDE_RACE_IDS = new Set([2, 5, 6, 8, 10]);
const NO_SIDE = -1;
const ALL_SIDES = -1;

/** A race's side the way the client's sort and filter read it: Horde 0, Alliance 1, neither -1. */
export function frameXmlRaceSide(race: number | undefined): number {
  if (race !== undefined && HORDE_RACE_IDS.has(race)) return PVP_TEAM_HORDE;
  if (race !== undefined && ALLIANCE_RACE_IDS.has(race)) return PVP_TEAM_ALLIANCE;
  return NO_SIDE;
}

/** `GetBattlefieldScore`'s twelve values, in the client's order (WorldStateFrame.lua:664). */
export type FrameXmlBattlefieldScore = readonly [
  name: string | undefined, killingBlows: number, honorableKills: number, deaths: number,
  honorGained: number, faction: number, rank: number, race: string | undefined,
  className: string | undefined, classToken: string | undefined, damageDone: number, healingDone: number,
];

const EMPTY_SCORE: FrameXmlBattlefieldScore = Object.freeze([
  undefined, 0, 0, 0, 0, 0, 0, undefined, undefined, undefined, 0, 0,
] as const);

interface Row {
  readonly score: PvpScore;
  /** The row's side: the packet's team byte in an arena, worked out from the race elsewhere. */
  side: number;
}

interface TeamRatings {
  readonly name: string;
  readonly first: number;
  readonly second: number;
  readonly third: number;
}

interface SortKey {
  readonly key: number;
  reversed: boolean;
}

function defaultKeys(): SortKey[] {
  return Array.from({ length: SORT_KEYS }, (_, key) => ({ key, reversed: false }));
}

export class FrameXmlBattlefieldScoreModel {
  readonly #context: FrameXmlScoreboardContext;
  #pump: FrameXmlScoreboardPump | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  #world: FrameXmlScoreboardWorld | undefined;
  /** The packet the rows came from; a new object is a new packet. */
  #log: PvpLogData | undefined;
  /** The rows in the list's current order. */
  #rows: Row[] = [];
  /** How many rows belong to the chosen side (all of them with no filter). */
  #count = 0;
  #filter = ALL_SIDES;
  #keys = defaultKeys();
  /** Rows whose name is still being asked for; the list waits for all of them. */
  #waiting = false;
  #teams: TeamRatings[] = [];
  #ended = false;
  /** When the next request may go; undefined before the first. */
  #nextRequest: number | undefined;
  /** The running battlefield the rows belong to (map and arena), undefined outside one. */
  #runningKey: string | undefined;

  constructor(context: FrameXmlScoreboardContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlScoreboardPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    this.#adopt(world);
    const events = world?.events;
    if (!events || typeof events.on !== "function") return;
    this.#unsubscribe.push(events.on("PVP_SCOREBOARD_CHANGED", () => { void this.#sync(); }));
    this.#unsubscribe.push(events.on("BATTLEFIELD_QUEUE_CHANGED", ({ status, cleared }) => {
      // The client forgets the match on the world change into or out of it (0x54ca50); the
      // running battlefield appearing, changing or going is that change here.
      const running = this.#running();
      const key = running === undefined ? undefined : `${running.mapId}:${running.isArena ? 1 : 0}`;
      if (key !== this.#runningKey) {
        this.#runningKey = key;
        this.#forget();
      }
      // 0x54ae40: every status of a running match resets the side filter and rebuilds the list.
      if (cleared || status !== STATUS_IN_PROGRESS) return;
      this.#filter = ALL_SIDES;
      if (!this.#sync()) this.#rebuild();
    }));
  }

  detach(): void {
    for (const stop of this.#unsubscribe.splice(0)) stop();
    this.#pump = undefined;
  }

  /** Called every frame by the seam: finishes a list that was waiting for names. */
  tick(): void {
    this.#sync();
    if (!this.#waiting) return;
    if (this.#namesOutstanding()) return;
    this.#waiting = false;
    this.#rebuild();
  }

  /** `GetNumBattlefieldScores()`. */
  count(): number {
    this.#adopt(this.#context.world());
    return this.#count;
  }

  /** `GetBattlefieldScore(index)`. */
  score(index: number): FrameXmlBattlefieldScore {
    this.#adopt(this.#context.world());
    const row = this.#rows[index - 1];
    const names = this.#world?.names;
    const name = row === undefined ? undefined : names?.get(row.score.guid);
    if (row === undefined || name === undefined) return EMPTY_SCORE;
    const details = names?.details?.(row.score.guid);
    const token = details === undefined ? undefined : classFileName(details.classId);
    // L3 3.14: Wow.exe 0x54be90 → 0x72aa70/0x72aab0 → 0x715970/0x7159e0 name both by the entry's sex.
    const female = details?.gender === 1 ? true : details?.gender === 0 ? false : undefined; // L3 3.14
    const { score } = row;
    return [
      name, score.killingBlows, score.honorableKills, score.deaths, score.bonusHonor, row.side, 0,
      details === undefined ? undefined : raceName(details.race, female), // L3 3.14: `, female`
      token === undefined ? undefined : className(details?.classId, female), token, // L3 3.14: `, female`
      score.damageDone, score.healingDone,
    ];
  }

  /** `GetBattlefieldStatData(index, column)`: always a number. */
  statData(index: number, column: number): number {
    this.#adopt(this.#context.world());
    const row = this.#rows[index - 1];
    if (row === undefined || column < 1 || column > STAT_DATA_COLUMNS || column > ROW_OBJECTIVES) return 0;
    return row.score.objectives[column - 1] ?? 0;
  }

  /** The running battlefield's scoreboard columns (WorldStateUI type 2). */
  #columns(): readonly Pick<WorldStateUiRow, "text" | "icon" | "tooltip">[] {
    const mapId = this.#running()?.mapId;
    const rows = this.#context.worldStateUi?.();
    if (mapId === undefined || !rows) return [];
    const columns: Pick<WorldStateUiRow, "text" | "icon" | "tooltip">[] = [];
    for (const row of rows) {
      if ((row.mapId === mapId || row.mapId === -1) && row.type === WORLD_STATE_UI_SCORE_COLUMN) {
        if (columns.length < ROW_OBJECTIVES) columns.push(row);
      } else if (columns.length > 0) {
        break;
      }
    }
    return columns;
  }

  /** `GetNumBattlefieldStats()`. */
  statCount(): number {
    this.#adopt(this.#context.world());
    return this.#columns().length;
  }

  /** `GetBattlefieldStatInfo(i)`: text, icon, tooltip; three nils past the end. */
  statInfo(index: number): readonly [string | undefined, string | undefined, string | undefined] {
    this.#adopt(this.#context.world());
    const column = this.#columns()[index - 1];
    return column === undefined ? [undefined, undefined, undefined] : [column.text, column.icon, column.tooltip];
  }

  /** `GetBattlefieldTeamInfo(index)`. */
  teamInfo(index: number): readonly [string | undefined, number, number, number] {
    this.#adopt(this.#context.world());
    if (index !== 0 && index !== 1) return [undefined, 0, 0, 0];
    const team = this.#teams[index];
    return team === undefined ? ["", 0, 0, 0] : [team.name, team.first, team.second, team.third];
  }

  /** `SetBattlefieldScoreFaction(faction)`: nil for everyone, 0 or 1; anything else is ignored. */
  setFilter(value: unknown): void {
    this.#adopt(this.#context.world());
    const number = frameXmlLuaNumber(value);
    let filter = ALL_SIDES;
    if (number !== undefined) {
      filter = Math.trunc(number);
      if (filter !== ALL_SIDES && (filter < 0 || filter > 1)) return;
    }
    this.#filter = filter;
    this.#rebuild();
  }

  /** `SortBattlefieldScoreData(type)`. */
  sort(type: string): void {
    this.#adopt(this.#context.world());
    // The client compares the words without regard to case; "statN" reads N as atoi does.
    const word = type.toLowerCase();
    let key: number = SORT_WORDS[word] ?? KEY_KILLS;
    if (SORT_WORDS[word] === undefined && word.startsWith("stat")) {
      const column = Number.parseInt(word.slice(4), 10);
      key = (Number.isFinite(column) ? column : 0) + KEY_FIRST_STAT - 1;
      if (key < 0 || key > SORT_KEYS - 1) return;
    }
    const at = this.#keys.findIndex((entry) => entry.key === key);
    if (at < 0) {
      this.#rebuild();
      return;
    }
    const entry = this.#keys[at]!;
    if (at === 0) entry.reversed = !entry.reversed;
    else this.#keys.splice(0, 0, ...this.#keys.splice(at, 1));
    this.#rebuild();
  }

  /** `RequestBattlefieldScoreData()`: the client's gate (0x54ce30), then MSG_PVP_LOG_DATA. */
  request(): boolean {
    this.#adopt(this.#context.world());
    const world = this.#world;
    if (!world?.requestPvpScores) return false;
    const now = this.#context.now();
    if (this.#nextRequest !== undefined) {
      if (this.#ended || this.#arena()) return false;
      if (now - this.#nextRequest < 0) return false;
    }
    this.#nextRequest = now + FRAMEXML_SCORE_REQUEST_INTERVAL_MS;
    world.requestPvpScores();
    return true;
  }

  /** `LeaveBattlefield()`. */
  leave(): void {
    this.#context.world()?.leaveBattleground?.();
  }

  #running(): { readonly isArena: boolean; readonly mapId: number } | undefined {
    for (const queued of this.#world?.battlefieldQueues?.values() ?? []) {
      if (queued.status === STATUS_IN_PROGRESS) return queued;
    }
    return undefined;
  }

  /** The running battlefield is an arena map (the client's Map.InstanceType 4 check). */
  #arena(): boolean {
    return this.#running()?.isArena ?? this.#log?.arena ?? false;
  }

  #adopt(world: FrameXmlScoreboardWorld | undefined): void {
    if (world === this.#world) return;
    this.#world = world;
    this.#runningKey = undefined;
    this.#forget();
  }

  /** 0x54ca50: out of the match, nothing of it is kept. */
  #forget(): void {
    this.#log = undefined;
    this.#rows = [];
    this.#count = 0;
    this.#filter = ALL_SIDES;
    this.#waiting = false;
    this.#teams = [];
    this.#ended = false;
    this.#nextRequest = undefined;
  }

  /** Takes a new packet in, the way 0x54d280 does. */
  /** True when a new packet was taken in (and, its names known, the list rebuilt). */
  #sync(): boolean {
    this.#adopt(this.#context.world());
    const log = this.#world?.pvpScores;
    if (log === this.#log) return false;
    if (log === undefined) {
      this.#forget();
      return false;
    }
    this.#log = log;
    this.#ended = log.ended;
    if (log.arena) {
      this.#teams = log.teams.map((team) => ({
        name: team.name, first: team.ratingLost, second: team.ratingWon, third: team.matchmakerRating,
      }));
    }
    // Rows are rewritten in packet order; a battleground row's side waits for the rebuild.
    this.#rows = log.scores.map((score) => ({ score, side: log.arena ? score.teamId : 0 }));
    this.#waiting = this.#askNames();
    if (!this.#waiting) this.#rebuild();
    return true;
  }

  /** Asks once per packet for every name the cache lacks; true when any was missing. */
  #askNames(): boolean {
    const world = this.#world;
    let missing = false;
    for (const row of this.#rows) {
      if (world?.names?.get(row.score.guid) !== undefined) continue;
      missing = true;
      world?.requestName?.(row.score.guid);
    }
    return missing;
  }

  /**
   * Whether the list still waits: a name is missing and its query is still out. Asked every frame,
   * so it never sends — a guid the server called unknown is not asked again each frame; its row
   * answers like any row without a name.
   */
  #namesOutstanding(): boolean {
    const names = this.#world?.names;
    for (const row of this.#rows) {
      if (names?.get(row.score.guid) !== undefined) continue;
      if (names?.isPending === undefined || names.isPending(row.score.guid)) return true;
    }
    return false;
  }

  /** 0x54aa30: sides, the chosen side's count, the sort, UPDATE_BATTLEFIELD_SCORE. */
  #rebuild(): void {
    if (this.#waiting) return;
    const names = this.#world?.names;
    const arena = this.#arena();
    this.#count = 0;
    for (const row of this.#rows) {
      if (!arena) {
        row.side = names?.get(row.score.guid) === undefined
          ? PVP_TEAM_HORDE
          : frameXmlRaceSide(names.details?.(row.score.guid)?.race);
      }
      if (this.#filter === ALL_SIDES || row.side === this.#filter) this.#count++;
    }
    const columns = this.#columns().length;
    this.#rows.sort((a, b) => this.#compare(a, b, columns));
    this.#pump?.fire(FRAMEXML_SCOREBOARD_EVENT);
  }

  /** 0x54a740. */
  #compare(a: Row, b: Row, columns: number): number {
    const names = this.#world?.names;
    const nameA = names?.get(a.score.guid);
    const nameB = names?.get(b.score.guid);
    if (nameA === undefined || nameB === undefined) return 0;
    if (this.#filter !== ALL_SIDES) {
      const sideA = frameXmlRaceSide(names?.details?.(a.score.guid)?.race);
      const sideB = frameXmlRaceSide(names?.details?.(b.score.guid)?.race);
      if (sideA !== sideB) return sideA !== this.#filter ? 1 : -1;
    }
    for (const { key, reversed } of this.#keys) {
      const order = this.#compareKey(key, a, b, nameA, nameB, columns);
      if (order !== 0) return reversed ? -order : order;
    }
    return 0;
  }

  #compareKey(key: number, a: Row, b: Row, nameA: string, nameB: string, columns: number): number {
    const larger = (x: number, y: number): number => (x === y ? 0 : x > y ? -1 : 1);
    switch (key) {
      case KEY_KILLS: return larger(a.score.killingBlows, b.score.killingBlows);
      case KEY_DEATHS: return larger(a.score.deaths, b.score.deaths);
      case KEY_HONOR: return larger(a.score.bonusHonor, b.score.bonusHonor);
      case KEY_NAME: return nameA === nameB ? 0 : nameA < nameB ? -1 : 1;
      case KEY_CLASS: {
        const names = this.#world?.names;
        return larger(names?.details?.(a.score.guid)?.classId ?? 0, names?.details?.(b.score.guid)?.classId ?? 0);
      }
      case KEY_HONORABLE_KILLS: return larger(a.score.honorableKills, b.score.honorableKills);
      case KEY_DAMAGE: return larger(a.score.damageDone, b.score.damageDone);
      case KEY_HEALING: return larger(a.score.healingDone, b.score.healingDone);
      case KEY_SIDE: return a.side === b.side ? 0 : a.side > b.side ? 1 : -1;
      default: {
        const column = key - KEY_FIRST_STAT;
        if (column < 0 || column >= columns) return 0;
        return larger(a.score.objectives[column] ?? 0, b.score.objectives[column] ?? 0);
      }
    }
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlScoreboardHost {
  readonly scoreboard?: FrameXmlBattlefieldScoreModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function whole(value: unknown): number {
  const number = frameXmlLuaNumber(value);
  return number === undefined ? 0 : Math.trunc(number);
}

export const FRAMEXML_SCOREBOARD_BINDINGS: Readonly<Record<string,
  (host: FrameXmlScoreboardHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetNumBattlefieldScores: (host) => [host.scoreboard?.count() ?? 0],
  GetBattlefieldScore: (host, args) => [...(host.scoreboard?.score(whole(args[0])) ?? EMPTY_SCORE)],
  SetBattlefieldScoreFaction: (host, args) => {
    host.scoreboard?.setFilter(args[0]);
    return NOTHING;
  },
  SortBattlefieldScoreData: (host, args) => {
    if (typeof args[0] === "string" || typeof args[0] === "number") host.scoreboard?.sort(String(args[0]));
    return NOTHING;
  },
  // Without a number the client raises its usage error; nothing of a team is answered here either.
  GetBattlefieldTeamInfo: (host, args) => (frameXmlLuaNumber(args[0]) === undefined
    ? [undefined, 0, 0, 0]
    : [...(host.scoreboard?.teamInfo(whole(args[0])) ?? [undefined, 0, 0, 0])]),
  GetNumBattlefieldStats: (host) => [host.scoreboard?.statCount() ?? 0],
  GetBattlefieldStatInfo: (host, args) => [...(host.scoreboard?.statInfo(whole(args[0])) ?? [undefined, undefined, undefined])],
  GetBattlefieldStatData: (host, args) => [host.scoreboard?.statData(whole(args[0]), whole(args[1])) ?? 0],
  RequestBattlefieldScoreData: (host) => {
    host.scoreboard?.request();
    return NOTHING;
  },
  LeaveBattlefield: (host) => {
    host.scoreboard?.leave();
    return NOTHING;
  },
});
