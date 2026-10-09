/**
 * The canned seam's PvP world: the facts and commands FrameXmlPvpFlag, FrameXmlScoreboard,
 * FrameXmlDifficulty, FrameXmlArenaRoster and FrameXmlMechanics read from `WorldClient`, held in
 * memory and recorded. Empty by default — no flag, no scoreboard, no arena team, normal
 * difficulties, an open-world map — so the canned vertical answers exactly what it answered before
 * these models; tests and `framexml.html?toc=vertical` fill it through the setters.
 */
import type { ArenaTeamInfo, ArenaTeamRoster, ArenaTeamStats } from "../../world/ArenaProtocol.js";
import type { PlayerNameDetails } from "../../world/NameQueryProtocol.js";
import { STATUS_IN_PROGRESS, type PvpLogData } from "../../world/PvpProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { WorldStateUiRow } from "../../world/WorldStateUiData.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";

type Listener = (payload: never) => void;

/** A tiny event bus with the `on` shape the models subscribe through. */
class CannedPvpEvents {
  readonly #listeners = new Map<string, Set<Listener>>();

  on(name: string, listener: (payload: never) => void): () => void {
    const listeners = this.#listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => { listeners.delete(listener); };
  }

  emit(name: string, payload: unknown): void {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) (listener as (value: unknown) => void)(payload);
  }
}

/** The canned player's guid (CannedWorldSeam's player). */
const CANNED_SELF = 0x42n;
/** Player.h `ARENA_TEAM_END`. */
const SLOT_WORDS = 7;

/**
 * Warsong Gulch's two WorldStateUI scoreboard columns (rows 42 and 44 of the 3.3.5a table, type 2),
 * in the ruRU client's words: what `GetBattlefieldStatInfo` shows for map 489.
 */
export const CANNED_SCOREBOARD_COLUMNS: readonly Pick<WorldStateUiRow, "mapId" | "type" | "text" | "icon" | "tooltip">[] = Object.freeze([
  { mapId: 489, type: 2, text: "Захваты флага", icon: "Interface\\WorldStateFrame\\ColumnIcon-FlagCapture",
    tooltip: "Количество флагов противника, захваченных вами." },
  { mapId: 489, type: 2, text: "Возвраты флага", icon: "Interface\\WorldStateFrame\\ColumnIcon-FlagReturn",
    tooltip: "Количество флагов, возвращенных вами на базу." },
]);

export class FrameXmlPvpCannedWorld {
  readonly events = new CannedPvpEvents();
  readonly state: { selfGuid: bigint; objects: Map<bigint, WorldObjectState> } = { selfGuid: CANNED_SELF, objects: new Map() };
  /** The player's own object: only its fields are read (PLAYER_FLAGS, the arena slots). */
  readonly self = { guid: CANNED_SELF, fields: new Map<number, number>() };

  // ---- PvP flag ----
  /** `togglePvp` calls in turn: undefined toggles, a boolean sets. */
  readonly pvpCalls: (boolean | undefined)[] = [];
  togglePvp(enable?: boolean): void { this.pvpCalls.push(enable); }

  // ---- scoreboard ----
  pvpScores: PvpLogData | undefined;
  readonly battlefieldQueues = new Map<number, { status: number; isArena: boolean; mapId: number }>();
  readonly #names = new Map<bigint, { name: string; details: PlayerNameDetails }>();
  readonly names = {
    get: (guid: bigint): string | undefined => this.#names.get(guid)?.name,
    details: (guid: bigint): PlayerNameDetails | undefined => this.#names.get(guid)?.details,
  };
  readonly nameRequests: bigint[] = [];
  scoreRequests = 0;
  /** `LeaveBattlefield` calls (the stock leave button and the queue icon menu). */
  leftBattlefield = 0;
  requestName(guid: bigint): void { this.nameRequests.push(guid); }
  requestPvpScores(): void { this.scoreRequests++; }
  leaveBattleground(): void { this.leftBattlefield++; }

  // ---- difficulty ----
  dungeonDifficulty = 0;
  raidDifficulty = 0;
  group: { leaderGuid: bigint; dungeonDifficulty: number } | undefined;
  /** Map.InstanceType of the canned map; 0 is the open world. */
  instanceType: number | undefined = 0;
  readonly difficultyCalls: { difficulty: number; raid: boolean }[] = [];
  setDifficulty(difficulty: number, raid: boolean): void { this.difficultyCalls.push({ difficulty, raid }); }

  // ---- arena teams ----
  readonly arenaTeams = new Map<number, ArenaTeamInfo>();
  readonly arenaTeamStats = new Map<number, ArenaTeamStats>();
  readonly arenaTeamRosters = new Map<number, ArenaTeamRoster>();
  arenaTeamInvite: unknown;
  readonly rosterRequests: number[] = [];
  readonly arenaCommands: { command: string; teamId: number; name?: string }[] = [];
  requestArenaTeam(): void {}
  requestArenaTeamRoster(teamId: number): void { this.rosterRequests.push(teamId); }
  inviteToArenaTeam(teamId: number, name: string): void { if (teamId !== 0 && name) this.arenaCommands.push({ command: "invite", teamId, name }); }
  leaveArenaTeam(teamId: number): void { if (teamId !== 0) this.arenaCommands.push({ command: "leave", teamId }); }
  removeFromArenaTeam(teamId: number, name: string): void { if (teamId !== 0 && name) this.arenaCommands.push({ command: "remove", teamId, name }); }
  promoteArenaTeamCaptain(teamId: number, name: string): void { if (teamId !== 0 && name) this.arenaCommands.push({ command: "promote", teamId, name }); }
  disbandArenaTeam(teamId: number): void { if (teamId !== 0) this.arenaCommands.push({ command: "disband", teamId }); }

  /** The player object as the models' `self()` wants it (only `fields` is read). */
  selfObject(): WorldObjectState {
    return this.self as unknown as WorldObjectState;
  }

  /** Sets PLAYER_FLAGS; the caller tells the model (`pvpFlag.flagsChanged()`) as the store would. */
  setPlayerFlags(flags: number): void {
    this.self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, flags);
  }

  playerFlags(): number {
    return this.self.fields.get(UPDATE_FIELDS.PLAYER_FLAGS.offset) ?? 0;
  }

  /** A player the name cache knows. */
  setName(guid: bigint, name: string, race: number, classId: number, gender = 0): void {
    this.#names.set(guid, { name, details: { race, classId, gender } });
  }

  /** A running battlefield (SMSG_BATTLEFIELD_STATUS status 3) in queue slot 0. */
  setRunningBattlefield(mapId: number, isArena: boolean): void {
    this.battlefieldQueues.set(0, { status: STATUS_IN_PROGRESS, isArena, mapId });
    this.events.emit("BATTLEFIELD_QUEUE_CHANGED", { queueSlot: 0, status: STATUS_IN_PROGRESS, cleared: false });
  }

  /** A scoreboard packet arrives (or `undefined`: the match was left). */
  setScoreboard(log: PvpLogData | undefined): void {
    this.pvpScores = log;
    this.events.emit("PVP_SCOREBOARD_CHANGED", { ended: log?.ended ?? false });
  }

  /** A team in the player's slot 1..3: the slot's words, and optionally its record and roster. */
  setArenaTeam(slot: number, team: {
    info: ArenaTeamInfo; stats: ArenaTeamStats; captain: boolean; roster?: ArenaTeamRoster;
  }): void {
    const base = UPDATE_FIELDS.PLAYER_FIELD_ARENA_TEAM_INFO_1_1.offset + (slot - 1) * SLOT_WORDS;
    this.self.fields.set(base, team.info.teamId);
    this.self.fields.set(base + 1, team.info.type);
    this.self.fields.set(base + 2, team.captain ? 0 : 1);
    this.arenaTeams.set(team.info.teamId, team.info);
    this.arenaTeamStats.set(team.info.teamId, team.stats);
    this.events.emit("ARENA_TEAM_CHANGED", { teamId: team.info.teamId });
    if (team.roster) this.setArenaRoster(team.roster);
  }

  /** SMSG_ARENA_TEAM_ROSTER. */
  setArenaRoster(roster: ArenaTeamRoster): void {
    this.arenaTeamRosters.set(roster.teamId, roster);
    this.events.emit("ARENA_TEAM_CHANGED", { teamId: roster.teamId });
  }

  /** SMSG_ARENA_TEAM_EVENT (the world forwards it without a team id). */
  arenaTeamEvent(): void {
    this.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
  }
}
