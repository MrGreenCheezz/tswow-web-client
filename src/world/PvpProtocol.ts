import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: BattlegroundMgr.cpp
// (`BuildBattlegroundStatusPacket`, `BuildBattlegroundListPacket`,
// `BuildGroupJoinedBattlegroundPacket`, `BuildPlayerJoinedBattlegroundPacket`,
// `BuildPlayerLeftBattlegroundPacket`), Battleground.cpp (`BuildPvPLogDataPacket`,
// `BattlegroundScore::AppendToPacket`), Arena.cpp (`ArenaScore::AppendToPacket`,
// `ArenaTeamScore::BuildRatingInfoBlock`, `BuildTeamInfoBlock`), Object.cpp `DestroyForPlayer`,
// Player.cpp `RewardHonor`, and BattleGroundHandler.cpp for every opcode a client drives.

/** `PLAYER_MAX_BATTLEGROUND_QUEUES` in SharedDefines.h: two at once, and the slot is on the wire. */
export const MAX_BATTLEFIELD_QUEUES = 2;

/** `BattlegroundStatus` in Battleground.h. */
export const STATUS_NONE = 0;
export const STATUS_WAIT_QUEUE = 1;
export const STATUS_WAIT_JOIN = 2;
export const STATUS_IN_PROGRESS = 3;
export const STATUS_WAIT_LEAVE = 4;

/** `BattlegroundTypeId` in SharedDefines.h — the two the list packet branches on. */
export const BATTLEGROUND_AA = 6;
export const BATTLEGROUND_RB = 32;

/** `PvPTeamId` in SharedDefines.h. Horde is zero, which is the reverse of the usual reading. */
export const PVP_TEAM_HORDE = 0;
export const PVP_TEAM_ALLIANCE = 1;
export const PVP_TEAM_NEUTRAL = 2;
/** `PVP_TEAMS_COUNT`: the scoreboard always carries both arena teams, horde first. */
export const PVP_TEAMS_COUNT = 2;

/** The one status packet that carries no status: `uint32` slot then a bare zero `uint64`. */
const CLEARED_STATUS_LENGTH = 12;
/** The marker byte `BuildBattlegroundStatusPacket` writes for an arena and nothing else. */
const ARENA_MARKER = 0x0e;

export interface BattlefieldStatus {
  /** Zero or one. Which of the player's two queue slots this packet is about. */
  queueSlot: number;
  /**
   * True when the slot emptied. The core says so by writing the slot and eight zero bytes and
   * stopping — there is no status code for "left the queue", so the shape *is* the message.
   */
  cleared: boolean;
  /** 2, 3 or 5 for an arena; zero for a battleground. */
  arenaType: number;
  isArena: boolean;
  bgTypeId: number;
  minLevel: number;
  maxLevel: number;
  /** The id `CMSG_BATTLEMASTER_JOIN` wants back, not the real instance id. */
  clientInstanceId: number;
  rated: boolean;
  /** A `STATUS_*` value. `STATUS_NONE` only ever appears on a cleared slot. */
  status: number;
  /** `STATUS_WAIT_QUEUE`: how long the queue is taking, and how long this player has waited. */
  averageWaitTime: number;
  timeInQueue: number;
  /** `STATUS_WAIT_JOIN` and `STATUS_IN_PROGRESS`. */
  mapId: number;
  /** `STATUS_WAIT_JOIN`: milliseconds before the invitation expires. */
  removeTime: number;
  /** `STATUS_IN_PROGRESS`: milliseconds until an ended match throws everyone out. */
  autoLeaveTime: number;
  /** `STATUS_IN_PROGRESS`: milliseconds since the match began. */
  elapsedTime: number;
  /** `STATUS_IN_PROGRESS`: which side the player is on, as `PVP_TEAM_*`. */
  team: number;
}

const emptyStatus = (queueSlot: number): BattlefieldStatus => ({
  queueSlot, cleared: true, arenaType: 0, isArena: false, bgTypeId: 0, minLevel: 0, maxLevel: 0,
  clientInstanceId: 0, rated: false, status: STATUS_NONE, averageWaitTime: 0, timeInQueue: 0,
  mapId: 0, removeTime: 0, autoLeaveTime: 0, elapsedTime: 0, team: PVP_TEAM_NEUTRAL,
});

/**
 * Where one of the two queue slots stands: waiting, invited, or playing.
 *
 * Two things about this packet do not announce themselves. The empty form — the one that means
 * "this slot is free again" — is a slot number and eight zero bytes with no status code, so it is
 * told from the full form by length alone: twelve bytes, against thirty-one at the shortest for
 * anything carrying a status. And the header the core's own comment calls "read as uint64 in
 * client" is really six fields, one of them the constant `0x1F90` that `CMSG_BATTLEFIELD_PORT` has
 * to echo back; decomposed here the way the core decomposes it, because the parts are what the
 * interface needs.
 */
export function parseBattlefieldStatus(payload: Uint8Array): BattlefieldStatus {
  const reader = new PacketReader(payload);
  const queueSlot = reader.u32();
  if (payload.byteLength === CLEARED_STATUS_LENGTH) {
    reader.u64();
    reader.assertFinished();
    return emptyStatus(queueSlot);
  }

  const status = emptyStatus(queueSlot);
  status.cleared = false;
  status.arenaType = reader.u8();
  status.isArena = reader.u8() === ARENA_MARKER;
  status.bgTypeId = reader.u32();
  reader.u16(); // 0x1F90, constant; echoed back by CMSG_BATTLEFIELD_PORT and CMSG_LEAVE_BATTLEFIELD.
  status.minLevel = reader.u8();
  status.maxLevel = reader.u8();
  status.clientInstanceId = reader.u32();
  status.rated = reader.u8() !== 0;
  status.status = reader.u32();
  if (status.status === STATUS_WAIT_QUEUE) {
    status.averageWaitTime = reader.u32();
    status.timeInQueue = reader.u32();
  } else if (status.status === STATUS_WAIT_JOIN) {
    status.mapId = reader.u32();
    reader.u64(); // 3.3.5 unknown, always zero.
    status.removeTime = reader.u32();
  } else if (status.status === STATUS_IN_PROGRESS) {
    status.mapId = reader.u32();
    reader.u64(); // 3.3.5 unknown, always zero.
    status.autoLeaveTime = reader.u32();
    status.elapsedTime = reader.u32();
    status.team = reader.u8() !== 0 ? PVP_TEAM_ALLIANCE : PVP_TEAM_HORDE;
  }
  reader.assertFinished();
  return status;
}

export interface BattlefieldList {
  /** Zero when the list came from the queue window rather than from talking to a battlemaster. */
  battlemasterGuid: bigint;
  /** 0 from a battlemaster, 1 from the queue window. */
  fromWhere: number;
  bgTypeId: number;
  /** Whether the daily first-win bonus has already been taken today. */
  hasWin: boolean;
  winHonor: number;
  winArena: number;
  lossHonor: number;
  /** True for the random-battleground entry, which carries a second set of rewards. */
  random: boolean;
  randomHasWin: boolean;
  randomWinHonor: number;
  randomWinArena: number;
  randomLossHonor: number;
  /** Client instance ids to offer as specific matches. Always empty for an arena. */
  instances: number[];
}

/**
 * What a battlemaster offers, with the honor a win and a loss are worth.
 *
 * The random-battleground entry is the only one that repeats its reward block, and nothing says so
 * except the flag in front of it — read the second block unconditionally and every ordinary
 * battleground's instance list comes out of the wrong four bytes.
 */
export function parseBattlefieldList(payload: Uint8Array): BattlefieldList {
  const reader = new PacketReader(payload);
  const list: BattlefieldList = {
    battlemasterGuid: reader.u64(),
    fromWhere: reader.u8(),
    bgTypeId: reader.u32(),
    hasWin: false, winHonor: 0, winArena: 0, lossHonor: 0,
    random: false, randomHasWin: false, randomWinHonor: 0, randomWinArena: 0, randomLossHonor: 0,
    instances: [],
  };
  reader.u8();
  reader.u8();
  list.hasWin = reader.u8() !== 0;
  list.winHonor = reader.u32();
  list.winArena = reader.u32();
  list.lossHonor = reader.u32();
  list.random = reader.u8() !== 0;
  if (list.random) {
    list.randomHasWin = reader.u8() !== 0;
    list.randomWinHonor = reader.u32();
    list.randomWinArena = reader.u32();
    list.randomLossHonor = reader.u32();
  }
  // The arena branch writes a literal zero where the battleground branch writes a count, so both
  // read the same way: an arena simply has no instances to choose between.
  const count = reader.u32();
  for (let index = 0; index < count; index++) list.instances.push(reader.u32());
  reader.assertFinished();
  return list;
}

/** `GroupJoinBattlegroundResult` in SharedDefines.h; the two that carry a guid. */
export const ERR_BATTLEGROUND_JOIN_TIMED_OUT = -11;
export const ERR_BATTLEGROUND_JOIN_FAILED = -12;

export interface GroupJoinedBattleground {
  /** Negative is an error from `GroupJoinBattlegroundResult`; positive is a `BattlemasterList` row. */
  result: number;
  /** Only the two join failures carry one, and the core writes it as zero anyway. */
  guid: bigint;
}

/**
 * Why a group could not queue — or, when positive, which battleground it queued for.
 *
 * Signed, and it has to be: every failure is negative, and reading the word unsigned turns
 * "everyone must be in the same level range" into four billion and something.
 */
export function parseGroupJoinedBattleground(payload: Uint8Array): GroupJoinedBattleground {
  const reader = new PacketReader(payload);
  const result = reader.i32();
  const guid = reader.remaining >= 8 ? reader.u64() : 0n;
  reader.assertFinished();
  return { result, guid };
}

const JOIN_RESULTS: Record<number, string> = {
  0: "Группа встала в очередь, но войти туда вы не можете",
  [-2]: "Кто-то в группе помечен как дезертир",
  [-3]: "Неверный размер группы для этой арены",
  [-4]: "Можно стоять не более чем в двух очередях",
  [-5]: "Нельзя вставать в рейтинговую очередь, стоя в другой",
  [-6]: "Нельзя вставать в очередь, стоя в очереди на рейтинговую арену",
  [-7]: "Ваша команда покинула очередь арены",
  [-8]: "На поле боя так делать нельзя",
  [-9]: "Опыт за это не начисляется",
  [-10]: "Все в группе должны попадать в один диапазон уровней",
  [-11]: "Игрок не смог встать в очередь",
  [-12]: "Не удалось встать в очередь группой",
  [-13]: "Нельзя вставать в очередь поля боя, пользуясь поиском подземелий",
  [-14]: "Так нельзя, стоя в очереди на случайное поле боя",
  [-15]: "Нельзя встать в очередь на случайное поле боя из другой очереди",
};

/** A positive result is not an error at all: it is the `BattlemasterList.dbc` row that was joined. */
export function battlegroundJoinResultText(result: number): string {
  if (result > 0) return `Группа встала в очередь на поле боя ${result}`;
  return JOIN_RESULTS[result] ?? `Очередь поля боя: код ${result}`;
}

/** Zero is a failure too: it is "queued, but you are not eligible", not "queued". */
export const isBattlegroundJoinFailure = (result: number): boolean => result <= 0;

/** Both "somebody joined" and "somebody left" are a bare guid on their own opcode. */
export function parseBattlegroundPlayer(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

export interface FlagCarrier {
  guid: bigint;
  x: number;
  y: number;
}

export interface BattlegroundPlayerPositions {
  /** The alliance and horde carriers, at most one each, in that order. */
  carriers: FlagCarrier[];
  /** Alterac Valley's own list. The core writes a literal zero here and never fills it. */
  players: FlagCarrier[];
}

/**
 * Where the flags are, answered on the same opcode the client asks with.
 *
 * Two counted blocks, and the first is always empty in this core: the loop that would fill it is
 * commented out. A reader that assumes one list and starts at the flag carriers reads the carrier
 * count as the low half of a guid. Both counts are read, and the empty block costs nothing.
 */
export function parseBattlegroundPlayerPositions(payload: Uint8Array): BattlegroundPlayerPositions {
  const reader = new PacketReader(payload);
  const read = (count: number): FlagCarrier[] => {
    const carriers: FlagCarrier[] = [];
    for (let index = 0; index < count; index++) {
      carriers.push({ guid: reader.u64(), x: reader.f32(), y: reader.f32() });
    }
    return carriers;
  };
  const players = read(reader.u32());
  const carriers = read(reader.u32());
  reader.assertFinished();
  return { carriers, players };
}

export interface ArenaTeamResult {
  /** Rating the team lost, as a positive number: the core splits one signed change into two words. */
  ratingLost: number;
  ratingWon: number;
  matchmakerRating: number;
  name: string;
}

export interface PvpScore {
  guid: bigint;
  killingBlows: number;
  /** Battleground only. An arena score carries a team id in place of these three. */
  honorableKills: number;
  deaths: number;
  bonusHonor: number;
  /** Arena only: `PVP_TEAM_HORDE` or `PVP_TEAM_ALLIANCE`. */
  teamId: number;
  damageDone: number;
  healingDone: number;
  /** Whatever this battleground counts — bases, towers, flags — in its own fixed order. */
  objectives: number[];
}

export interface PvpLogData {
  arena: boolean;
  /** Two entries for an arena, horde first; empty for a battleground. */
  teams: ArenaTeamResult[];
  ended: boolean;
  /** `PVP_TEAM_*`. Only meaningful once `ended` is set. */
  winner: number;
  scores: PvpScore[];
}

/**
 * The scoreboard. Two packets under one opcode, and the first byte is what tells them apart.
 *
 * An arena writes both teams' rating blocks *before* either team's name — three `uint32`s twice,
 * then two strings — rather than interleaving them, which is what a reader written from the field
 * list rather than from `BuildPvPLogDataPacket` gets wrong. And every arena score replaces the
 * battleground's honorable kills, deaths and bonus honor with a single team-id byte, so the two row
 * shapes differ by eleven bytes with nothing but that leading byte saying which is coming.
 *
 * The objective block is the one genuinely self-describing part: a count and that many words, whose
 * meaning belongs to the battleground, so they are kept as numbers for whoever knows which one this
 * is. Alterac Valley writes five, Warsong Gulch two, an arena none.
 */
export function parsePvpLogData(payload: Uint8Array): PvpLogData {
  const reader = new PacketReader(payload);
  const arena = reader.u8() !== 0;
  const teams: ArenaTeamResult[] = [];
  if (arena) {
    for (let index = 0; index < PVP_TEAMS_COUNT; index++) {
      teams.push({ ratingLost: reader.u32(), ratingWon: reader.u32(), matchmakerRating: reader.u32(), name: "" });
    }
    for (const team of teams) team.name = reader.cString();
  }

  const ended = reader.u8() !== 0;
  const winner = ended ? reader.u8() : PVP_TEAM_NEUTRAL;
  const count = reader.u32();
  const scores: PvpScore[] = [];
  for (let index = 0; index < count; index++) {
    const score: PvpScore = {
      guid: reader.u64(), killingBlows: reader.u32(), honorableKills: 0, deaths: 0, bonusHonor: 0,
      teamId: PVP_TEAM_NEUTRAL, damageDone: 0, healingDone: 0, objectives: [],
    };
    if (arena) {
      score.teamId = reader.u8();
    } else {
      score.honorableKills = reader.u32();
      score.deaths = reader.u32();
      score.bonusHonor = reader.u32();
    }
    score.damageDone = reader.u32();
    score.healingDone = reader.u32();
    const objectives = reader.u32();
    for (let objective = 0; objective < objectives; objective++) score.objectives.push(reader.u32());
    scores.push(score);
  }
  reader.assertFinished();
  return { arena, teams, ended, winner, scores };
}

export interface PvpCredit {
  /**
   * Already scaled by the realm's honor rate, and written through an explicit cast from `int32` —
   * so a script that hands `RewardHonor` a negative amount arrives here as a number near four
   * billion rather than as a loss. The core never does that itself.
   */
  honor: number;
  /**
   * Zero does not mean there was no victim. `RewardHonor` clears the guid whenever the victim has
   * no title to name a rank with, precisely so the client does not print the rank line — the honor
   * beside it is real either way.
   */
  victimGuid: bigint;
  /**
   * The victim's honor rank: 1 to 4 for a dishonorable kill, 5 to 19 for a ranked one, and 19 for
   * a racial leader. Zero and anything past twenty mean the kill was worth honor but names no rank.
   */
  victimRank: number;
}

/** Honor for a kill. */
export function parsePvpCredit(payload: Uint8Array): PvpCredit {
  const reader = new PacketReader(payload);
  const honor = reader.u32();
  const victimGuid = reader.u64();
  const victimRank = reader.u32();
  reader.assertFinished();
  return { honor, victimGuid, victimRank };
}

/**
 * A unit an arena may stop drawing.
 *
 * The core sends this immediately before `SMSG_DESTROY_OBJECT` for the same guid, and only inside
 * an arena. It is a hint about how the death is presented, not a second destroy: acting on it as
 * one would take the unit down a frame early and leave the real destroy with nothing to remove.
 */
export function parseArenaUnitDestroyed(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

/** Talking to a battlemaster. The answer is the battleground list for whatever it runs. */
export function buildBattlemasterHello(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/**
 * Queue for a battleground.
 *
 * A zero instance id means "first available", which is the normal case; anything else has to be a
 * `clientInstanceId` out of `SMSG_BATTLEFIELD_LIST` rather than a real instance id — the server
 * looks it up by the number it handed out, and a real one finds nothing.
 */
export function buildBattlemasterJoin(guid: bigint, bgTypeId: number, instanceId: number, asGroup: boolean): Uint8Array {
  return new PacketWriter().u64(guid).u32(bgTypeId).u32(instanceId).u8(asGroup ? 1 : 0).toUint8Array();
}

/**
 * Queue for an arena. The slot is 0, 1 or 2 for 2v2, 3v3 and 5v5 — not the team size.
 *
 * A rated match has to be queued as a group: the server drops a rated solo request without
 * answering it at all.
 */
export function buildBattlemasterJoinArena(guid: bigint, arenaSlot: number, asGroup: boolean, rated: boolean): Uint8Array {
  return new PacketWriter().u64(guid).u8(arenaSlot).u8(asGroup ? 1 : 0).u8(rated ? 1 : 0).toUint8Array();
}

/** Asking for the instance list. `fromWhere` is 0 from a battlemaster and 1 from the queue window. */
export function buildBattlefieldList(bgTypeId: number, fromWhere: number, canGainXp = true): Uint8Array {
  return new PacketWriter().u32(bgTypeId).u8(fromWhere).u8(canGainXp ? 1 : 0).toUint8Array();
}

/** Empty: the server answers with one `SMSG_BATTLEFIELD_STATUS` per occupied queue slot. */
export function buildBattlefieldStatusQuery(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** The constant the status packet carries and the port and leave packets have to carry back. */
export const BATTLEFIELD_PORT_CONSTANT = 0x1f90;

/**
 * Accepting an invitation, or dropping out of the queue: `action` is 1 to enter and 0 to leave.
 *
 * The header fields are the ones out of `SMSG_BATTLEFIELD_STATUS`, and they are not decoration —
 * the server finds the queue by arena type and battleground type together, so porting into a 3v3
 * with the arena type left at zero looks up a queue the player is not in and does nothing at all.
 *
 * The second byte is the one field nothing in the core reads: `HandleBattleFieldPortOpcode` logs it
 * and never branches on it. It is written as the action, which is what the original client appears
 * to do, and it costs nothing either way.
 */
export function buildBattlefieldPort(arenaType: number, bgTypeId: number, action: boolean): Uint8Array {
  return new PacketWriter()
    .u8(arenaType).u8(action ? 1 : 0).u32(bgTypeId).u16(BATTLEFIELD_PORT_CONSTANT).u8(action ? 1 : 0)
    .toUint8Array();
}

/**
 * Leaving a battleground. The body is read and thrown away — the server acts on where the player
 * actually is — but the four fields have to be there, or the read runs off the end of the packet.
 */
export function buildLeaveBattlefield(arenaType: number, bgTypeId: number): Uint8Array {
  return new PacketWriter().u8(arenaType).u8(0).u32(bgTypeId).u16(BATTLEFIELD_PORT_CONSTANT).toUint8Array();
}

/** Empty request; the answer is the scoreboard. Refused inside an arena until the match ends. */
export function buildPvpLogDataQuery(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** Empty request for where the flags are. Answered only while the player is in a battleground. */
export function buildBattlegroundPlayerPositionsQuery(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** Reporting somebody as away. The server counts reports; there is no answer to this one. */
export function buildReportPvpAfk(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/**
 * The PvP flag. An empty body toggles it; one byte sets it outright.
 *
 * `TogglePvP::HasPvPStatus` is `GetSize() == 1`, so the *length* is the mode selector — send a byte
 * and the server obeys it, send nothing and the server flips whatever is there.
 */
export function buildTogglePvp(enable?: boolean): Uint8Array {
  const writer = new PacketWriter();
  if (enable !== undefined) writer.u8(enable ? 1 : 0);
  return writer.toUint8Array();
}
