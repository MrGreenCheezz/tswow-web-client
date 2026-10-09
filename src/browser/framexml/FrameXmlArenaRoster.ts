/**
 * The arena team roster and team commands of the stock PVPFrame: `ArenaTeamRoster`,
 * `GetNumArenaTeamMembers`, `GetArenaTeamRosterInfo`, `Set/GetArenaTeamRosterSelection`,
 * `SortArenaTeamRoster`, `CloseArenaTeamRoster`, `IsArenaTeamCaptain`, the ARENA_TEAM_ROSTER_UPDATE
 * event, and the five commands the StaticPopup confirmations call: `ArenaTeamInviteByName`,
 * `ArenaTeamLeave`, `ArenaTeamUninviteByName`, `ArenaTeamSetLeaderByName`, `ArenaTeamDisband`.
 *
 * Every stock caller names a team by its slot 1..3 — the player's 2v2/3v3/5v5 slot in
 * PLAYER_FIELD_ARENA_TEAM_INFO_1_1, seven words a slot (ID, TYPE, MEMBER, …; Player.h
 * ArenaTeamInfoType) — never by team id: PVPFrame.lua:47/:480 (`ArenaTeamRoster`), :262
 * (`GetNumArenaTeamMembers(id, 1)`), :311 (ten values, then `played - win` unguarded), :398/:433
 * (selection), :257 (`CloseArenaTeamRoster` on hide), :448 and UnitPopup.lua:617/:623/:1011
 * (`IsArenaTeamCaptain`), StaticPopup.lua:711/:723/:735/:1883/:1894/:2716 (the commands).
 * PVPFrame_OnEvent (:44-52) asks for the roster again on ARENA_TEAM_ROSTER_UPDATE with an argument
 * and redraws on one without.
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra; Lua C functions found through
 * their registration entries in .data), described in this file's words:
 * * `ArenaTeamRoster(slot)` (0x5a3cf0 → 0x5a3600) sends CMSG_ARENA_TEAM_ROSTER for the slot's team
 *   id from the player's own fields, at most once every 10000 ms per slot, and never for an empty
 *   slot.
 * * SMSG_ARENA_TEAM_ROSTER (0x5a3e10) is kept only for a team in one of the player's slots, sorted,
 *   and answered with ARENA_TEAM_ROSTER_UPDATE without arguments. SMSG_ARENA_TEAM_EVENT (0x6cc980)
 *   prints its message and then, for each of the three slots, clears the roster request's spacing
 *   and fires ARENA_TEAM_ROSTER_UPDATE with the argument 1 (0x5a28e0) — which is what makes stock ask
 *   for the roster again.
 * * `GetNumArenaTeamMembers(slot, showOffline)` (0x5a2930) answers the whole roster while the
 *   client's show-offline switch is on, as it is from the start (0x5a40e0) and stock never turns it
 *   off (`SetArenaTeamRosterShowOffline` has no caller in the corpus); only with the switch off would
 *   a false second argument count the online members. With the switch on the sort does not group
 *   online members first either (0x5a2bd0).
 * * `GetArenaTeamRosterInfo(slot, i)` (0x5a2fc0): name, the roster's captain word as the rank (0 is
 *   the captain), level, the class's name (nil for a class the client does not know), 1 or nil for
 *   online, the week's games and wins, the season's games and wins, the personal rating. Out of
 *   range: nil, 0, 0, nil, nil and five zeros.
 * * The sort (0x5a2bd0, 0x5a2e80) walks seven keys: name and class name small first; week games,
 *   week wins, season games, season wins and rating large first. `SortArenaTeamRoster(type)` moves
 *   "name", "class", "played", "won", "seasonplayed", "seasonwon" or "rating" to the front, or flips it
 *   when it already is; any other word means "name". Then every roster is redrawn with
 *   ARENA_TEAM_ROSTER_UPDATE.
 * * The selection (0x5a2b80, 0x5a2f40) is one member's guid for all three slots; `Get` answers its row
 *   in the slot's roster, 0 when it is not there.
 * * `CloseArenaTeamRoster` is registered on the client's empty function (0x8e5250): it does nothing.
 * * `IsArenaTeamCaptain(slot)` (0x60dc70) answers 1 when the slot's MEMBER word is 0 — TrinityCore
 *   writes 0 for the captain (ArenaTeam.cpp SetCaptain) — and nil otherwise; with no player, nil.
 * * The commands (0x515cc0, 0x515dd0, 0x515eb0, 0x515ff0, 0x516130) take the slot's team id and send
 *   CMSG_ARENA_TEAM_INVITE/LEAVE/REMOVE/LEADER/DISBAND; a name of 49 bytes or more is refused
 *   («Name too long») and an invitation needs a non-empty name. Captain rights are the server's.
 */
import type { ArenaTeamMember, ArenaTeamRoster } from "../../world/ArenaProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { className, classFileName } from "../ui/UnitSnapshot.js";
import { frameXmlLuaNumber, frameXmlRoundToInt } from "./FrameXmlPvpFlag.js";

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlArenaRosterWorld {
  readonly arenaTeamRosters?: ReadonlyMap<number, ArenaTeamRoster> | undefined;
  readonly arenaTeamInvite?: unknown;
  readonly events?: {
    on(name: "ARENA_TEAM_CHANGED", listener: (change: { readonly teamId: number | undefined }) => void): () => void;
  } | undefined;
  requestArenaTeamRoster?(teamId: number): void;
  inviteToArenaTeam?(teamId: number, name: string): void;
  leaveArenaTeam?(teamId: number): void;
  removeFromArenaTeam?(teamId: number, name: string): void;
  promoteArenaTeamCaptain?(teamId: number, name: string): void;
  disbandArenaTeam?(teamId: number): void;
}

export interface FrameXmlArenaRosterContext {
  world(): FrameXmlArenaRosterWorld | undefined;
  /** The player's own object, whose private fields hold the three slots. */
  self(): Pick<WorldObjectState, "fields"> | undefined;
  /** A millisecond clock that keeps running. */
  now(): number;
}

interface FrameXmlArenaRosterPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export const FRAMEXML_ARENA_ROSTER_EVENT = "ARENA_TEAM_ROSTER_UPDATE";
/** 0x5a3600: the client's spacing between two roster requests for one slot. */
export const FRAMEXML_ARENA_ROSTER_REQUEST_INTERVAL_MS = 10_000;
const SLOTS = 3;
/** Player.h `ARENA_TEAM_END` words a slot; `ARENA_TEAM_MEMBER` is word 2. */
const SLOT_WORDS = 7;
const WORD_MEMBER = 2;
/** The client's name buffer: 48 bytes and the terminator (0x515cc0 refuses 0x31 and longer). */
const MAX_NAME_BYTES = 48;
const KEY_NAME = 0;
const KEY_CLASS = 1;
const KEY_WEEK_GAMES = 2;
const KEY_WEEK_WINS = 3;
const KEY_SEASON_GAMES = 4;
const KEY_SEASON_WINS = 5;
const KEY_RATING = 6;
const SORT_WORDS: Readonly<Record<string, number>> = Object.freeze({
  name: KEY_NAME, class: KEY_CLASS, played: KEY_WEEK_GAMES, won: KEY_WEEK_WINS,
  seasonplayed: KEY_SEASON_GAMES, seasonwon: KEY_SEASON_WINS, rating: KEY_RATING,
});

/** `GetArenaTeamRosterInfo`'s ten values, in the client's order (PVPFrame.lua:311). */
export type FrameXmlArenaRosterInfo = readonly [
  name: string | undefined, rank: number, level: number, className: string | undefined, online: 1 | undefined,
  played: number, win: number, seasonPlayed: number, seasonWin: number, rating: number,
];

const EMPTY_INFO: FrameXmlArenaRosterInfo = Object.freeze([
  undefined, 0, 0, undefined, undefined, 0, 0, 0, 0, 0,
] as const);

interface SortKey {
  readonly key: number;
  reversed: boolean;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A Lua slot/index argument as the client converts it: rounded, then made 0-based. */
function zeroBased(value: unknown): number {
  const number = frameXmlLuaNumber(value);
  return number === undefined || !Number.isFinite(number) ? -1 : frameXmlRoundToInt(number) - 1;
}

export class FrameXmlArenaRosterModel {
  readonly #context: FrameXmlArenaRosterContext;
  #pump: FrameXmlArenaRosterPump | undefined;
  #unsubscribe: (() => void) | undefined;
  /** When each slot may ask for its roster again; undefined: at once. */
  readonly #nextRequest: (number | undefined)[] = [undefined, undefined, undefined];
  readonly #keys: SortKey[] = Array.from({ length: 7 }, (_, key) => ({ key, reversed: false }));
  /** The selected member (one for all slots); 0n: none. */
  #selected = 0n;
  /** The rosters and the invitation last seen, to tell a roster from an event on ARENA_TEAM_CHANGED. */
  readonly #seenRosters = new Map<number, ArenaTeamRoster>();
  #seenInvite: unknown;

  constructor(context: FrameXmlArenaRosterContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlArenaRosterPump): void {
    this.detach();
    this.#pump = pump;
    const world = this.#context.world();
    this.#seenInvite = world?.arenaTeamInvite;
    for (const [teamId, roster] of world?.arenaTeamRosters ?? []) this.#seenRosters.set(teamId, roster);
    if (world?.events && typeof world.events.on === "function") {
      this.#unsubscribe = world.events.on("ARENA_TEAM_CHANGED", ({ teamId }) => { this.#changed(teamId); });
    }
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#seenRosters.clear();
    this.#seenInvite = undefined;
    this.#nextRequest.fill(undefined);
    this.#selected = 0n;
  }

  #changed(teamId: number | undefined): void {
    const world = this.#context.world();
    if (teamId !== undefined) {
      const roster = world?.arenaTeamRosters?.get(teamId);
      if (!roster || this.#seenRosters.get(teamId) === roster) return;
      this.#seenRosters.set(teamId, roster);
      // 0x5a3e10 keeps a roster only for a team the player holds a slot in.
      if (this.#slotOf(teamId) < 0) return;
      this.#pump?.fire(FRAMEXML_ARENA_ROSTER_EVENT);
      return;
    }
    // A new invitation object is SMSG_ARENA_TEAM_INVITE. One that went away was answered locally
    // (`answerArenaTeamInvite` clears it without an event), so the packet now is a team event.
    const invite = world?.arenaTeamInvite;
    const invited = invite !== undefined && invite !== this.#seenInvite;
    this.#seenInvite = invite;
    if (invited) return;
    // SMSG_ARENA_TEAM_EVENT (0x6cc980 → 0x5a28e0 for each slot).
    for (let slot = 0; slot < SLOTS; slot++) {
      this.#nextRequest[slot] = undefined;
      this.#pump?.fire(FRAMEXML_ARENA_ROSTER_EVENT, 1);
    }
  }

  /** The word of a 0-based slot in the player's fields; undefined without a player or out of range. */
  #word(slot: number, word: number): number | undefined {
    const self = this.#context.self();
    if (!self || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return undefined;
    return self.fields.get(UPDATE_FIELDS.PLAYER_FIELD_ARENA_TEAM_INFO_1_1.offset + slot * SLOT_WORDS + word) ?? 0;
  }

  /** The team id in a 0-based slot; 0 for an empty or unknown slot. */
  teamId(slot: number): number {
    return this.#word(slot, 0) ?? 0;
  }

  #slotOf(teamId: number): number {
    for (let slot = 0; slot < SLOTS; slot++) if (teamId !== 0 && this.teamId(slot) === teamId) return slot;
    return -1;
  }

  /** The slot's roster in the client's current order. */
  members(slot: number): readonly ArenaTeamMember[] {
    const teamId = this.teamId(slot);
    const roster = teamId === 0 ? undefined : this.#context.world()?.arenaTeamRosters?.get(teamId);
    if (!roster) return [];
    return [...roster.members].sort((a, b) => this.#compare(a, b));
  }

  #compare(a: ArenaTeamMember, b: ArenaTeamMember): number {
    const larger = (x: number, y: number): number => (x === y ? 0 : x > y ? -1 : 1);
    const smaller = (x: string, y: string): number => (x === y ? 0 : x < y ? -1 : 1);
    for (const { key, reversed } of this.#keys) {
      let order = 0;
      switch (key) {
        case KEY_NAME: order = smaller(a.name, b.name); break;
        case KEY_CLASS: {
          const classA = classFileName(a.classId) === undefined ? undefined : className(a.classId);
          const classB = classFileName(b.classId) === undefined ? undefined : className(b.classId);
          if (classA !== undefined && classB !== undefined) order = smaller(classA, classB);
          break;
        }
        case KEY_WEEK_GAMES: order = larger(a.weekGames, b.weekGames); break;
        case KEY_WEEK_WINS: order = larger(a.weekWins, b.weekWins); break;
        case KEY_SEASON_GAMES: order = larger(a.seasonGames, b.seasonGames); break;
        case KEY_SEASON_WINS: order = larger(a.seasonWins, b.seasonWins); break;
        case KEY_RATING: order = larger(a.personalRating, b.personalRating); break;
        default: break;
      }
      if (order !== 0) return reversed ? -order : order;
    }
    return 0;
  }

  /** `ArenaTeamRoster(slot)`. */
  requestRoster(slotArgument: unknown): void {
    const slot = zeroBased(slotArgument);
    const teamId = this.teamId(slot);
    if (teamId === 0) return;
    const now = this.#context.now();
    const next = this.#nextRequest[slot];
    if (next !== undefined && now - next < 0) return;
    this.#nextRequest[slot] = now + FRAMEXML_ARENA_ROSTER_REQUEST_INTERVAL_MS;
    this.#context.world()?.requestArenaTeamRoster?.(teamId);
  }

  /** `GetNumArenaTeamMembers(slot, showOffline)`: the whole roster (the client's switch is on). */
  count(slotArgument: unknown): number {
    return this.members(zeroBased(slotArgument)).length;
  }

  /** `GetArenaTeamRosterInfo(slot, index)`. */
  info(slotArgument: unknown, indexArgument: unknown): FrameXmlArenaRosterInfo {
    const member = this.members(zeroBased(slotArgument))[zeroBased(indexArgument)];
    if (!member) return EMPTY_INFO;
    return [
      member.name, member.captain ? 0 : 1, member.level,
      classFileName(member.classId) === undefined ? undefined : className(member.classId),
      member.online ? 1 : undefined, member.weekGames, member.weekWins, member.seasonGames,
      member.seasonWins, member.personalRating,
    ];
  }

  /** `SetArenaTeamRosterSelection(slot, index)`: a row out of range clears the selection. */
  select(slotArgument: unknown, indexArgument: unknown): void {
    const member = this.members(zeroBased(slotArgument))[zeroBased(indexArgument)];
    this.#selected = member?.guid ?? 0n;
  }

  /** `GetArenaTeamRosterSelection(slot)`: the selected member's row, 0 when it is not in the slot. */
  selection(slotArgument: unknown): number {
    const slot = zeroBased(slotArgument);
    if (slot < 0 || slot >= SLOTS || this.#selected === 0n) return 0;
    return this.members(slot).findIndex((member) => member.guid === this.#selected) + 1;
  }

  /** `SortArenaTeamRoster(type)`. */
  sort(type: string): void {
    const key = SORT_WORDS[type.toLowerCase()] ?? KEY_NAME;
    const at = this.#keys.findIndex((entry) => entry.key === key);
    if (at === 0) this.#keys[0]!.reversed = !this.#keys[0]!.reversed;
    else if (at > 0) this.#keys.splice(0, 0, ...this.#keys.splice(at, 1));
    for (let slot = 0; slot < SLOTS; slot++) {
      if (this.members(slot).length > 0) this.#pump?.fire(FRAMEXML_ARENA_ROSTER_EVENT);
    }
  }

  /** `IsArenaTeamCaptain(slot)`. */
  captain(slotArgument: unknown): boolean {
    return this.#word(zeroBased(slotArgument), WORD_MEMBER) === 0;
  }

  /** `ArenaTeamInviteByName(slot, name)`. */
  invite(slotArgument: unknown, name: unknown): void {
    if (typeof name !== "string" && typeof name !== "number") return;
    const text = String(name);
    if (text.length === 0 || byteLength(text) > MAX_NAME_BYTES) return;
    this.#context.world()?.inviteToArenaTeam?.(this.teamId(zeroBased(slotArgument)), text);
  }

  /** `ArenaTeamLeave(slot)`. */
  leave(slotArgument: unknown): void {
    this.#context.world()?.leaveArenaTeam?.(this.teamId(zeroBased(slotArgument)));
  }

  /** `ArenaTeamUninviteByName(slot, name)`. */
  uninvite(slotArgument: unknown, name: unknown): void {
    const text = typeof name === "string" || typeof name === "number" ? String(name) : "";
    if (byteLength(text) > MAX_NAME_BYTES) return;
    this.#context.world()?.removeFromArenaTeam?.(this.teamId(zeroBased(slotArgument)), text);
  }

  /** `ArenaTeamSetLeaderByName(slot, name)`. */
  promote(slotArgument: unknown, name: unknown): void {
    const text = typeof name === "string" || typeof name === "number" ? String(name) : "";
    if (byteLength(text) > MAX_NAME_BYTES) return;
    this.#context.world()?.promoteArenaTeamCaptain?.(this.teamId(zeroBased(slotArgument)), text);
  }

  /** `ArenaTeamDisband(slot)`. */
  disband(slotArgument: unknown): void {
    this.#context.world()?.disbandArenaTeam?.(this.teamId(zeroBased(slotArgument)));
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlArenaRosterHost {
  readonly arenaRoster?: FrameXmlArenaRosterModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const NIL: readonly unknown[] = Object.freeze([undefined]);

export const FRAMEXML_ARENA_ROSTER_BINDINGS: Readonly<Record<string,
  (host: FrameXmlArenaRosterHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  ArenaTeamRoster: (host, args) => {
    host.arenaRoster?.requestRoster(args[0]);
    return NOTHING;
  },
  GetNumArenaTeamMembers: (host, args) => [host.arenaRoster?.count(args[0]) ?? 0],
  GetArenaTeamRosterInfo: (host, args) => [...(host.arenaRoster?.info(args[0], args[1]) ?? EMPTY_INFO)],
  SetArenaTeamRosterSelection: (host, args) => {
    host.arenaRoster?.select(args[0], args[1]);
    return NOTHING;
  },
  GetArenaTeamRosterSelection: (host, args) => [host.arenaRoster?.selection(args[0]) ?? 0],
  SortArenaTeamRoster: (host, args) => {
    if (typeof args[0] === "string" || typeof args[0] === "number") host.arenaRoster?.sort(String(args[0]));
    return NOTHING;
  },
  CloseArenaTeamRoster: () => NOTHING,
  IsArenaTeamCaptain: (host, args) => (host.arenaRoster?.captain(args[0]) ? [1] : NIL),
  ArenaTeamInviteByName: (host, args) => {
    host.arenaRoster?.invite(args[0], args[1]);
    return NOTHING;
  },
  ArenaTeamLeave: (host, args) => {
    host.arenaRoster?.leave(args[0]);
    return NOTHING;
  },
  ArenaTeamUninviteByName: (host, args) => {
    host.arenaRoster?.uninvite(args[0], args[1]);
    return NOTHING;
  },
  ArenaTeamSetLeaderByName: (host, args) => {
    host.arenaRoster?.promote(args[0], args[1]);
    return NOTHING;
  },
  ArenaTeamDisband: (host, args) => {
    host.arenaRoster?.disband(args[0]);
    return NOTHING;
  },
});
