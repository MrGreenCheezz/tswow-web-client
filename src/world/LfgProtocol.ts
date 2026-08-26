import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: LFGHandler.cpp holds every LFG packet builder
// (LFGMgr.cpp writes none of them) and LFGPackets.cpp deserialises `CMSG_LFG_JOIN`.
//
// No packed GUIDs anywhere, all strings are null terminated without a length prefix, and several
// fields are widened on the wire: `roles` lives in a uint8 but is written as uint32.

/** `LfgRoles` in LFG.h. */
export const LFG_ROLE_NONE = 0x00;
export const LFG_ROLE_LEADER = 0x01;
export const LFG_ROLE_TANK = 0x02;
export const LFG_ROLE_HEALER = 0x04;
export const LFG_ROLE_DAMAGE = 0x08;

export interface LfgLockedDungeon {
  /**
   * The dungeon *entry*, `id + (type << 24)`, not the plain id the name suggests — that is what
   * the core writes everywhere in this family. `splitDungeonEntry` separates the two.
   */
  dungeonId: number;
  reason: number;
}

export interface LfgPlayerLocks {
  guid: bigint;
  dungeons: LfgLockedDungeon[];
}

/** The shared party lock block: a player count, then per player a GUID and a lock list. */
function readPartyLockBlock(reader: PacketReader): LfgPlayerLocks[] {
  const players: LfgPlayerLocks[] = [];
  const count = reader.u8();
  for (let index = 0; index < count; index++) {
    const guid = reader.u64();
    const lockCount = reader.u32();
    const dungeons: LfgLockedDungeon[] = [];
    for (let lock = 0; lock < lockCount; lock++) dungeons.push({ dungeonId: reader.u32(), reason: reader.u32() });
    players.push({ guid, dungeons });
  }
  return players;
}

export interface LfgJoinResult {
  result: number;
  state: number;
  lockedPlayers: LfgPlayerLocks[];
}

/**
 * When there are no locks the server appends nothing at all, not even the count byte, so the
 * packet is exactly eight bytes. Reading a count there would consume the next packet's data.
 */
export function parseLfgJoinResult(payload: Uint8Array): LfgJoinResult {
  const reader = new PacketReader(payload);
  const result = reader.u32();
  const state = reader.u32();
  const lockedPlayers = reader.remaining > 0 ? readPartyLockBlock(reader) : [];
  return { result, state, lockedPlayers };
}

export interface LfgQueueStatus {
  dungeonId: number;
  /** All five wait times are signed and use -1 for "unknown". */
  waitTimeAverage: number;
  waitTime: number;
  waitTimeTank: number;
  waitTimeHealer: number;
  waitTimeDamage: number;
  tanksNeeded: number;
  healersNeeded: number;
  damageNeeded: number;
  queuedSeconds: number;
}

/** The average wait is written before the player's own wait, the reverse of the struct order. */
export function parseLfgQueueStatus(payload: Uint8Array): LfgQueueStatus {
  const reader = new PacketReader(payload);
  return {
    dungeonId: reader.u32(),
    waitTimeAverage: reader.i32(),
    waitTime: reader.i32(),
    waitTimeTank: reader.i32(),
    waitTimeHealer: reader.i32(),
    waitTimeDamage: reader.i32(),
    tanksNeeded: reader.u8(),
    healersNeeded: reader.u8(),
    damageNeeded: reader.u8(),
    queuedSeconds: reader.u32(),
  };
}

export interface LfgUpdate {
  updateType: number;
  joined: boolean;
  queued: boolean;
  dungeons: number[];
  comment: string;
}

/**
 * `SMSG_LFG_UPDATE_PLAYER` and `SMSG_LFG_UPDATE_PARTY` share the two byte header and both hang
 * their tail off it, but the party version adds a `join` byte and a fixed three byte needs array,
 * so the conditional header is seven bytes instead of three. With no dungeons both are two bytes,
 * which the server sends routinely.
 */
export function parseLfgUpdate(payload: Uint8Array, party: boolean): LfgUpdate {
  const reader = new PacketReader(payload);
  const updateType = reader.u8();
  const joined = reader.u8() !== 0;
  if (!joined || reader.remaining === 0) return { updateType, joined, queued: false, dungeons: [], comment: "" };
  if (party) reader.u8(); // join
  const queued = reader.u8() !== 0;
  reader.u8(); // no partial clear
  reader.u8(); // achievements
  if (party) for (let index = 0; index < 3; index++) reader.u8(); // needs, fixed length
  const count = reader.u8();
  const dungeons: number[] = [];
  for (let index = 0; index < count; index++) dungeons.push(reader.u32());
  const comment = reader.remaining > 0 ? reader.cString() : "";
  return { updateType, joined, queued, dungeons, comment };
}

export interface LfgRoleChosen {
  guid: bigint;
  ready: boolean;
  roles: number;
}

export function parseLfgRoleChosen(payload: Uint8Array): LfgRoleChosen {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const ready = reader.u8() !== 0;
  const roles = reader.u32();
  return { guid, ready, roles };
}

export interface LfgProposalPlayer {
  roles: number;
  self: boolean;
  inDungeon: boolean;
  sameGroup: boolean;
  answered: boolean;
  accepted: boolean;
}

export interface LfgProposal {
  dungeonEntry: number;
  state: number;
  /** Echo this back in `CMSG_LFG_PROPOSAL_RESULT`. */
  proposalId: number;
  encounters: number;
  showWindow: boolean;
  players: LfgProposalPlayer[];
}

/** Both arms of the group check write two bytes, so a player block is a fixed nine bytes. */
export function parseLfgProposalUpdate(payload: Uint8Array): LfgProposal {
  const reader = new PacketReader(payload);
  const dungeonEntry = reader.u32();
  const state = reader.u8();
  const proposalId = reader.u32();
  const encounters = reader.u32();
  const showWindow = reader.u8() !== 0;
  const count = reader.u8();
  const players: LfgProposalPlayer[] = [];
  for (let index = 0; index < count; index++) {
    players.push({
      roles: reader.u32(),
      self: reader.u8() !== 0,
      inDungeon: reader.u8() !== 0,
      sameGroup: reader.u8() !== 0,
      answered: reader.u8() !== 0,
      accepted: reader.u8() !== 0,
    });
  }
  return { dungeonEntry, state, proposalId, encounters, showWindow, players };
}

/** `SMSG_LFG_TELEPORT_DENIED` widens an eight bit reason to a uint32. */
export function parseLfgTeleportDenied(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const reason = reader.u32();
  reader.assertFinished();
  return reason;
}

/**
 * `LFGJoin::Read` takes the roles, two flags, the dungeon list, a needs count it discards
 * followed by exactly three needs bytes, and finally the comment.
 */
export function buildLfgJoin(roles: number, dungeons: number[], comment = ""): Uint8Array {
  const writer = new PacketWriter().u32(roles).u8(0).u8(0).u8(dungeons.length);
  for (const dungeon of dungeons) writer.u32(dungeon);
  writer.u8(3);
  for (let index = 0; index < 3; index++) writer.u8(0);
  return writer.cString(comment).toUint8Array();
}

/** The server reads nothing from the leave packet. */
export function buildLfgLeave(): Uint8Array {
  return new Uint8Array(0);
}

export function buildLfgSetRoles(roles: number): Uint8Array {
  return new PacketWriter().u8(roles).toUint8Array();
}

export function buildLfgProposalResult(proposalId: number, accept: boolean): Uint8Array {
  return new PacketWriter().u32(proposalId).u8(accept ? 1 : 0).toUint8Array();
}

export function buildLfgTeleport(toDungeon: boolean): Uint8Array {
  return new PacketWriter().u8(toDungeon ? 1 : 0).toUint8Array();
}

// `LfgJoinResult` in LFGMgr.h. The list is sparse: 3 produces no client reaction at all.
const JOIN_RESULTS: Record<number, string> = {
  0: "Поиск начат",
  1: "Проверка ролей не пройдена",
  2: "Группа заполнена",
  4: "Внутренняя ошибка поиска",
  5: "Вы не подходите под выбранные подземелья",
  6: "Кто-то из группы не подходит",
  7: "Нельзя смешивать подземелья, рейды и случайный поиск",
  8: "Подземелье не поддерживает игроков с других миров",
  9: "Кто-то отключён или не ответил на приглашение",
  10: "Не удалось получить данные об участниках",
  11: "Одно из подземелий недопустимо",
  12: "На вас дезертирство",
  13: "На ком-то из группы дезертирство",
  14: "Случайное подземелье на откате",
  15: "У кого-то из группы откат случайного подземелья",
  16: "Нельзя входить группой больше пяти человек",
  17: "Нельзя пользоваться поиском на поле боя или арене",
};

export function lfgJoinResultText(result: number): string {
  return JOIN_RESULTS[result] ?? `Поиск не удался (код ${result})`;
}

export function rolesText(roles: number): string {
  const parts: string[] = [];
  if (roles & LFG_ROLE_LEADER) parts.push("лидер");
  if (roles & LFG_ROLE_TANK) parts.push("танк");
  if (roles & LFG_ROLE_HEALER) parts.push("лекарь");
  if (roles & LFG_ROLE_DAMAGE) parts.push("урон");
  return parts.join(", ") || "без роли";
}

// ---------------------------------------------------------------------------------------------
// Slice P5. The rest of the dungeon finder: what is locked and why, the role check, the reward and
// the vote to remove somebody. All of it is built in LFGHandler.cpp, every guid is a bare eight
// bytes, and a dungeon is always the entry form `id + (type << 24)` rather than a plain id.

/** `LfgLockStatusType` in LFG.h. The list is sparse and runs past a thousand, so it needs a word. */
export const LFG_LOCK_INSUFFICIENT_EXPANSION = 1;
export const LFG_LOCK_TOO_LOW_LEVEL = 2;
export const LFG_LOCK_TOO_HIGH_LEVEL = 3;
export const LFG_LOCK_TOO_LOW_GEAR_SCORE = 4;
export const LFG_LOCK_TOO_HIGH_GEAR_SCORE = 5;
export const LFG_LOCK_RAID_LOCKED = 6;
export const LFG_LOCK_QUEST_NOT_COMPLETED = 1022;
export const LFG_LOCK_MISSING_ITEM = 1025;
export const LFG_LOCK_NOT_IN_SEASON = 1031;
export const LFG_LOCK_MISSING_ACHIEVEMENT = 1034;

/** `LfgRoleCheckState` in LFGMgr.h — a plain enum, written as a full word. */
export const LFG_ROLECHECK_DEFAULT = 0;
export const LFG_ROLECHECK_FINISHED = 1;
export const LFG_ROLECHECK_INITIALITING = 2;
export const LFG_ROLECHECK_MISSING_ROLE = 3;
export const LFG_ROLECHECK_WRONG_ROLES = 4;
export const LFG_ROLECHECK_ABORTED = 5;
export const LFG_ROLECHECK_NO_ROLE = 6;

/** Splits a dungeon entry into the id the tables use and the queue type in its top byte. */
export function splitDungeonEntry(entry: number): { dungeonId: number; type: number } {
  return { dungeonId: entry & 0x00ffffff, type: (entry >>> 24) & 0xff };
}

function readLockList(reader: PacketReader): LfgLockedDungeon[] {
  const count = reader.u32();
  if (count > 4096) throw new RangeError(`Dungeon finder declares ${count} locks`);
  const locks: LfgLockedDungeon[] = [];
  for (let index = 0; index < count; index++) locks.push({ dungeonId: reader.u32(), reason: reader.u32() });
  return locks;
}

/**
 * Why each of the other party members cannot enter a dungeon. The outer count is a byte and the
 * inner one a word — two widths in one packet — and the outer counts only the members who were
 * online when the reply was built, which can be fewer than the party holds.
 */
export function parseLfgPartyInfo(payload: Uint8Array): LfgPlayerLocks[] {
  const reader = new PacketReader(payload);
  const count = reader.u8();
  const players: LfgPlayerLocks[] = [];
  for (let index = 0; index < count; index++) {
    players.push({ guid: reader.u64(), dungeons: readLockList(reader) });
  }
  reader.assertFinished();
  return players;
}

export interface LfgRewardItem {
  itemId: number;
  displayId: number;
  count: number;
}

export interface LfgReward {
  /** False is the first-time reward, true the repeat one. */
  done: boolean;
  money: number;
  experience: number;
  items: LfgRewardItem[];
}

/**
 * The reward block the dungeon list carries. Its fixed head is the same eighteen bytes whether or
 * not a reward quest was resolved: with none, every number is zero and no items follow — including
 * the "done" flag, so a dungeon already finished today can still describe itself as first-time.
 */
function readRewardBlock(reader: PacketReader): LfgReward {
  const done = reader.u8() !== 0;
  const money = reader.u32();
  const experience = reader.u32();
  reader.u32();
  reader.u32();
  const itemCount = reader.u8();
  const items: LfgRewardItem[] = [];
  for (let index = 0; index < itemCount; index++) {
    items.push({ itemId: reader.u32(), displayId: reader.u32(), count: reader.u32() });
  }
  return { done, money, experience, items };
}

export interface LfgRandomDungeon {
  entry: number;
  reward: LfgReward;
}

export interface LfgPlayerInfo {
  dungeons: LfgRandomDungeon[];
  locks: LfgLockedDungeon[];
}

/** Every random and seasonal dungeon with what it pays, then what this player cannot enter. */
export function parseLfgPlayerInfo(payload: Uint8Array): LfgPlayerInfo {
  const reader = new PacketReader(payload);
  const count = reader.u8();
  const dungeons: LfgRandomDungeon[] = [];
  for (let index = 0; index < count; index++) {
    dungeons.push({ entry: reader.u32(), reward: readRewardBlock(reader) });
  }
  const locks = readLockList(reader);
  reader.assertFinished();
  return { dungeons, locks };
}

export interface LfgPlayerReward {
  /** The random dungeon that was queued for. */
  randomEntry: number;
  /** The dungeon that was actually run. */
  dungeonEntry: number;
  reward: LfgReward;
}

/**
 * The completion popup. It is the reward block with one extra word in the middle — a literal one,
 * written between the "done" flag and the money — so the two blocks cannot share a reader.
 */
export function parseLfgPlayerReward(payload: Uint8Array): LfgPlayerReward {
  const reader = new PacketReader(payload);
  const randomEntry = reader.u32();
  const dungeonEntry = reader.u32();
  const done = reader.u8() !== 0;
  reader.u32();
  const money = reader.u32();
  const experience = reader.u32();
  reader.u32();
  reader.u32();
  const itemCount = reader.u8();
  const items: LfgRewardItem[] = [];
  for (let index = 0; index < itemCount; index++) {
    items.push({ itemId: reader.u32(), displayId: reader.u32(), count: reader.u32() });
  }
  reader.assertFinished();
  return { randomEntry, dungeonEntry, reward: { done, money, experience, items } };
}

export interface LfgRoleCheckMember {
  guid: bigint;
  /** False while the member has not chosen anything yet. */
  ready: boolean;
  roles: number;
  /** Zero when the member is not online to ask. */
  level: number;
}

export interface LfgRoleCheck {
  state: number;
  starting: boolean;
  dungeons: number[];
  /** The leader is always first, ahead of map order; the rest follow by guid. */
  members: LfgRoleCheckMember[];
}

export function parseLfgRoleCheckUpdate(payload: Uint8Array): LfgRoleCheck {
  const reader = new PacketReader(payload);
  const state = reader.u32();
  const starting = reader.u8() !== 0;
  const dungeonCount = reader.u8();
  const dungeons: number[] = [];
  for (let index = 0; index < dungeonCount; index++) dungeons.push(reader.u32());
  const memberCount = reader.u8();
  const members: LfgRoleCheckMember[] = [];
  for (let index = 0; index < memberCount; index++) {
    members.push({
      guid: reader.u64(),
      ready: reader.u8() !== 0,
      roles: reader.u32(),
      level: reader.u8(),
    });
  }
  reader.assertFinished();
  return { state, starting, dungeons, members };
}

export interface LfgBootProposal {
  inProgress: boolean;
  /** Whether this player has already answered, and what they answered. */
  voted: boolean;
  votedYes: boolean;
  victimGuid: bigint;
  votes: number;
  agree: number;
  /**
   * Always zero. The core divides a countdown already in seconds by a thousand, so the two minutes
   * a vote really lasts never reach the wire and the client has to run its own clock.
   */
  secondsLeft: number;
  votesNeeded: number;
  reason: string;
}

export function parseLfgBootProposal(payload: Uint8Array): LfgBootProposal {
  const reader = new PacketReader(payload);
  const proposal: LfgBootProposal = {
    inProgress: reader.u8() !== 0,
    voted: reader.u8() !== 0,
    votedYes: reader.u8() !== 0,
    victimGuid: reader.u64(),
    votes: reader.u32(),
    agree: reader.u32(),
    secondsLeft: reader.u32(),
    votesNeeded: reader.u32(),
    reason: reader.cString(),
  };
  reader.assertFinished();
  return proposal;
}

/** The dungeon a group abandoned and may go back to finish. */
export function parseLfgOfferContinue(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const entry = reader.u32();
  reader.assertFinished();
  return entry;
}

/** The raid browser's search state, one byte. Only ever zero in this build. */
export function parseLfgUpdateSearch(payload: Uint8Array): boolean {
  const reader = new PacketReader(payload);
  const searching = reader.u8() !== 0;
  reader.assertFinished();
  return searching;
}

export function buildLfgPlayerLockInfoRequest(): Uint8Array {
  return new Uint8Array(0);
}

export function buildLfgPartyLockInfoRequest(): Uint8Array {
  return new Uint8Array(0);
}

export function buildLfgBootVote(agree: boolean): Uint8Array {
  return new PacketWriter().u8(agree ? 1 : 0).toUint8Array();
}

const LOCK_REASONS: Record<number, string> = {
  1: "Нужно дополнение",
  2: "Слишком низкий уровень",
  3: "Слишком высокий уровень",
  4: "Слабое снаряжение",
  5: "Слишком сильное снаряжение",
  6: "Подземелье уже пройдено",
  1001: "Нет допуска",
  1002: "Нет допуска",
  1022: "Не выполнено задание",
  1025: "Нет нужного предмета",
  1031: "Не сезон",
  1034: "Нет достижения",
};

export function lockReasonText(reason: number): string {
  return LOCK_REASONS[reason] ?? `Недоступно (код ${reason})`;
}

const ROLE_CHECK_STATES: Record<number, string> = {
  0: "Проверка ролей",
  1: "Роли подтверждены",
  2: "Выберите роль",
  3: "Не хватает роли",
  4: "Неподходящие роли",
  5: "Проверка отменена",
  6: "Кто-то не выбрал роль",
};

export function roleCheckStateText(state: number): string {
  return ROLE_CHECK_STATES[state] ?? `Проверка ролей (код ${state})`;
}

// `LfgTeleportError` in LFGMgr.h. Five and seven are unused, and zero is never sent as an error.
const TELEPORT_ERRORS: Record<number, string> = {
  1: "Нельзя телепортироваться мёртвым",
  2: "Нельзя телепортироваться в падении",
  3: "Нельзя телепортироваться из транспорта",
  4: "Мешает усталость",
  6: "Отсюда нельзя телепортироваться",
  8: "Вы под контролем",
};

export function lfgTeleportDeniedText(reason: number): string {
  return TELEPORT_ERRORS[reason] ?? `Телепорт не удался (код ${reason})`;
}
