/**
 * The offline dungeon finder: a small real slice of this dataset's `LFGDungeons`/`LFGDungeonGroup`
 * tables and a scripted world that records every command, for `CannedWorldSeam` and its tests.
 *
 * Rows are copied from the dataset's DBCs (ruRU names, measured levels, Group_ID, TypeID, Flags 3)
 * for a level-60 character: the classic group's level-55+ dungeons, two Burning Crusade openers and
 * the two randoms, so `LFDList_DefaultFilterFunction` keeps a list and removes a header.
 */
import { EventBus, type LfgStateChange } from "../../world/EventBus.js";
import {
  LFG_ROLECHECK_INITIALITING,
  type LfgBootProposal,
  type LfgPlayerInfo,
  type LfgPlayerLocks,
  type LfgProposal,
  type LfgQueueStatus,
  type LfgRoleCheck,
  type LfgRoleChosen,
  type LfgUpdate,
} from "../../world/LfgProtocol.js";
import type { LfgDungeon, LfgDungeonGroupRow, LfgStockCatalog } from "../LfgDungeons.js";
import { FrameXmlLfdModel, type FrameXmlLfdContext, type FrameXmlLfdWorld } from "./FrameXmlLfd.js";

type Row = readonly [id: number, name: string, min: number, max: number, rec: number, recMin: number,
  recMax: number, type: number, group: number, expansion: number, faction: number, map: number, texture: string];

/** Measured from LFGDungeons.dbc (tswow dataset), Flags 3 and Difficulty 0 throughout. */
const ROWS: readonly Row[] = [
  [2, "Некроситет", 55, 65, 60, 0, 0, 1, 1, 0, -1, 289, "SCHOLOMANCE"],
  [4, "Огненная пропасть", 15, 21, 16, 15, 16, 1, 1, 0, 0, 389, "RAGEFIRECHASM"],
  [12, "Тюрьма Штормграда", 20, 30, 24, 22, 25, 1, 1, 0, 1, 34, "STORMWINDSTOCKADES"],
  [32, "Нижняя часть Черной горы", 55, 65, 58, 57, 58, 1, 1, 0, -1, 229, "BLACKROCKSPIRE"],
  [34, "Забытый Город - Восток", 53, 63, 57, 55, 58, 1, 1, 0, -1, 429, "DIREMAUL"],
  [40, "Стратхольм - Главные врата", 55, 65, 60, 0, 0, 1, 1, 0, -1, 329, "STRATHOLME"],
  [274, "Стратхольм - Черный ход", 55, 65, 60, 0, 0, 1, 1, 0, -1, 329, "STRATHOLME"],
  [276, "Глубины Черной горы - Верхний город", 51, 61, 55, 53, 56, 1, 1, 0, -1, 230, "BLACKROCKDEPTHS"],
  [136, "Бастионы Адского Пламени", 57, 67, 63, 59, 62, 1, 2, 1, -1, 543, "HELLFIRECITADEL"],
  [137, "Кузня Крови", 59, 68, 64, 61, 63, 1, 2, 1, -1, 542, "HELLFIRECITADEL"],
  [258, "Случайное подземелье классической игры", 15, 58, 55, 15, 58, 6, 1, 0, -1, 0, ""],
  [259, "Случайное подземелье Burning Crusade", 59, 68, 65, 59, 68, 6, 2, 1, -1, 0, ""],
];

/** Measured from LFGDungeonGroup.dbc: id, ruRU name, Order_index, TypeID. */
const GROUPS: readonly LfgDungeonGroupRow[] = Object.freeze([
  Object.freeze({ id: 2, name: "Burning Crusade (обычный режим)", orderIndex: 4, parentGroupId: 0, typeId: 1 }),
  Object.freeze({ id: 1, name: "Классические подземелья", orderIndex: 5, parentGroupId: 0, typeId: 1 }),
]);

export const FRAMEXML_CANNED_LFD_CATALOG: LfgStockCatalog = Object.freeze({
  dungeons: Object.freeze(ROWS.map(([id, name, minLevel, maxLevel, targetLevel, targetLevelMin, targetLevelMax,
    type, groupId, expansion, faction, mapId, texture]): LfgDungeon => Object.freeze({
    id, name, minLevel, maxLevel, type, difficulty: 0, expansion, description: "", texture, mapId,
    targetLevel, targetLevelMin, targetLevelMax, groupId, flags: 3, faction, orderIndex: 0, maxPlayers: 5,
  }))),
  groups: GROUPS,
});

/** A command the canned world received, in order; tests assert the wire-level intent. */
export type FrameXmlCannedLfdCall =
  | { readonly kind: "join"; readonly roles: number; readonly dungeons: readonly number[]; readonly comment: string }
  | { readonly kind: "leave" | "requestLocks" }
  | { readonly kind: "roles"; readonly roles: number }
  | { readonly kind: "proposal" | "boot"; readonly accept: boolean }
  | { readonly kind: "teleport"; readonly toDungeon: boolean }
  | { readonly kind: "continue"; readonly accept: boolean; readonly dungeons: readonly number[]; readonly roles: number };

/**
 * The canned world: `WorldClient`'s `lfg*` fields and commands, plus `emit` for scripted packets.
 * Commands only record; a test scripts the server's answer with the setters and `emit`.
 */
export class FrameXmlCannedLfdWorld implements FrameXmlLfdWorld {
  readonly events = new EventBus<{ LFG_STATE_CHANGED: LfgStateChange }>();
  readonly calls: FrameXmlCannedLfdCall[] = [];
  lfgPlayerInfo: LfgPlayerInfo | undefined = {
    // Both randoms the server lists at 60: the classic one (15-58, so not offered at this level) and
    // Burning Crusade's (59-68, 1234 copper and 5000 experience); one quest lock on Stratholme's back door.
    dungeons: [
      { entry: 258 | (6 << 24), reward: { done: true, money: 0, experience: 0, items: [] } },
      { entry: 259 | (6 << 24), reward: { done: false, money: 1234, experience: 5000, items: [] } },
    ],
    locks: [{ dungeonId: 274 | (1 << 24), reason: 1022 }],
  };
  lfgPartyInfo: LfgPlayerLocks[] | undefined;
  lfgStatus: LfgUpdate | undefined;
  lfgQueue: LfgQueueStatus | undefined;
  lfgProposal: LfgProposal | undefined;
  lfgRoleCheck: LfgRoleCheck | undefined;
  readonly lfgRolesChosen = new Map<bigint, LfgRoleChosen>();
  lfgBoot: LfgBootProposal | undefined;
  lfgBootExpiresAt = 0;
  lfgOfferContinue: number | undefined;
  group: { groupType: number } | undefined;
  readonly names = new Map<bigint, string>();

  displayName(guid: bigint): string { return this.names.get(guid) ?? `0x${guid.toString(16)}`; }

  joinLfg(roles: number, dungeons: number[], comment = ""): void {
    this.calls.push({ kind: "join", roles, dungeons: [...dungeons], comment });
  }
  leaveLfg(): void { this.calls.push({ kind: "leave" }); }
  setLfgRoles(roles: number): void { this.calls.push({ kind: "roles", roles }); }
  answerLfgProposal(accept: boolean): void {
    this.calls.push({ kind: "proposal", accept });
    // WorldClient clears its proposal locally on an answer; the server's next update restores it.
    this.lfgProposal = undefined;
  }
  /**
   * The canned server answers a lock request the way TrinityCore does, with SMSG_LFG_PLAYER_INFO —
   * a microtask later, as a packet would be, never inside the Lua OnShow that asked.
   */
  requestDungeonLocks(): void {
    this.calls.push({ kind: "requestLocks" });
    void Promise.resolve().then(() => this.emit({ kind: "playerInfo" }));
  }
  voteToRemove(agree: boolean): void { this.calls.push({ kind: "boot", accept: agree }); }
  teleportToDungeon(toDungeon = true): void { this.calls.push({ kind: "teleport", toDungeon }); }
  answerLfgContinue(accept: boolean, dungeons: number[] = [], roles = 0): void {
    this.calls.push({ kind: "continue", accept, dungeons: [...dungeons], roles });
  }

  emit(change: LfgStateChange): void { this.events.emit("LFG_STATE_CHANGED", change); }

  /** SMSG_LFG_UPDATE_PLAYER joined+queued for `entries`, then an SMSG_LFG_QUEUE_STATUS. */
  queue(entries: readonly number[], queuedSeconds = 30): void {
    this.lfgStatus = { updateType: 6, joined: true, queued: true, dungeons: [...entries], comment: "" };
    this.emit({ kind: "update" });
    this.lfgQueue = {
      dungeonId: entries[0] ?? 0, waitTimeAverage: 300, waitTime: 240, waitTimeTank: 60,
      waitTimeHealer: 120, waitTimeDamage: 600, tanksNeeded: 1, healersNeeded: 0, damageNeeded: 2,
      queuedSeconds,
    };
    this.emit({ kind: "queue" });
  }

  /** SMSG_LFG_UPDATE_PLAYER removed-from-queue (TrinityCore sends joined=0 with no tail). */
  unqueue(): void {
    this.lfgStatus = { updateType: 7, joined: false, queued: false, dungeons: [], comment: "" };
    this.lfgQueue = undefined;
    this.emit({ kind: "update" });
  }

  /** SMSG_LFG_PROPOSAL_UPDATE for `entry` with five members, this player the tank. */
  propose(entry: number, proposalId = 7, state = 0, selfAnswered = false): void {
    this.lfgProposal = {
      dungeonEntry: entry, state, proposalId, encounters: 0, showWindow: true,
      players: [
        { roles: 0x02, self: true, inDungeon: false, sameGroup: false, answered: selfAnswered, accepted: selfAnswered },
        { roles: 0x04, self: false, inDungeon: false, sameGroup: false, answered: true, accepted: true },
        { roles: 0x08, self: false, inDungeon: false, sameGroup: false, answered: false, accepted: false },
        { roles: 0x08, self: false, inDungeon: false, sameGroup: false, answered: false, accepted: false },
        { roles: 0x09, self: false, inDungeon: false, sameGroup: false, answered: false, accepted: false },
      ],
    };
    this.emit({ kind: "proposal" });
  }

  /** SMSG_LFG_ROLE_CHECK_UPDATE initializing for `entries`, the player not yet ready. */
  startRoleCheck(selfGuid: bigint, entries: readonly number[]): void {
    this.lfgRoleCheck = {
      state: LFG_ROLECHECK_INITIALITING, starting: true, dungeons: [...entries],
      members: [
        { guid: 0x99n, ready: true, roles: 0x09, level: 60 },
        { guid: selfGuid, ready: false, roles: 0, level: 60 },
      ],
    };
    this.emit({ kind: "roleCheck" });
  }

  /** A terminal SMSG_LFG_ROLE_CHECK_UPDATE (1 finished, 5 aborted …). */
  endRoleCheck(state = 1): void {
    if (this.lfgRoleCheck) this.lfgRoleCheck = { ...this.lfgRoleCheck, state };
    this.emit({ kind: "roleCheck" });
  }
}

/** The canned player's GUID in the finder's packets (role-check members, proposal self flag). */
export const FRAMEXML_CANNED_LFD_PLAYER_GUID = 0x42n;

/** ChrClasses file tokens of the ten stock classes; a TSWoW class (HERO) has no stock id here. */
const CLASS_IDS: Readonly<Record<string, number>> = {
  WARRIOR: 1, PALADIN: 2, HUNTER: 3, ROGUE: 4, PRIEST: 5, DEATHKNIGHT: 6, SHAMAN: 7, MAGE: 8,
  WARLOCK: 9, DRUID: 11,
};

export function frameXmlStockClassId(token: string | undefined): number | undefined {
  return token === undefined ? undefined : CLASS_IDS[token];
}

/** A canned model over its own scripted world; the seam supplies the player's facts. */
export function createCannedFrameXmlLfd(
  player: Pick<FrameXmlLfdContext, "playerLevel" | "playerClassId" | "playerName" | "playerGuid" | "playerFaction">
    & Partial<Pick<FrameXmlLfdContext, "partyMemberCount" | "raidMemberCount" | "isPartyLeader">>,
  world = new FrameXmlCannedLfdWorld(),
  catalog: LfgStockCatalog | undefined = FRAMEXML_CANNED_LFD_CATALOG,
): { readonly model: FrameXmlLfdModel; readonly world: FrameXmlCannedLfdWorld } {
  const model = new FrameXmlLfdModel({
    ...player,
    world: () => world,
    catalog: () => catalog,
    partyMemberCount: player.partyMemberCount ?? (() => 0),
    raidMemberCount: player.raidMemberCount ?? (() => 0),
    isPartyLeader: player.isPartyLeader ?? (() => false),
    inDungeonInstance: () => false,
    monotonic: () => 0,
  });
  return { model, world };
}
