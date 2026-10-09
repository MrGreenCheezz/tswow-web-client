import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/**
 * What a character has become: what it has learned, whom it has pleased, what it has achieved and
 * where it will wake up.
 *
 * None of this is in the update fields — reputation, achievements, talents and the bind point are
 * all their own packets — which is why a character sheet built only out of object state can show
 * health and nothing else. Every layout here mirrors the core's own sender, named in the comment.
 */

/** `MAX_POWERS` and `MAX_STATS` from the core's shared defines. */
export const POWER_COUNT = 7;
export const STAT_COUNT = 5;

export interface LevelUpInfo {
  level: number;
  healthDelta: number;
  powerDelta: number[];
  statDelta: number[];
}

/** Mirrors `WorldPackets::Misc::LevelUpInfo::Write`: what the level brought. */
export function parseLevelUpInfo(payload: Uint8Array): LevelUpInfo {
  const reader = new PacketReader(payload);
  const info: LevelUpInfo = { level: reader.u32(), healthDelta: reader.u32(), powerDelta: [], statDelta: [] };
  for (let index = 0; index < POWER_COUNT; index++) info.powerDelta.push(reader.i32());
  for (let index = 0; index < STAT_COUNT; index++) info.statDelta.push(reader.i32());
  reader.assertFinished();
  return info;
}

/** `SMSG_LEARNED_SPELL`. The trailing short is a "superceded" marker the client ignores. */
export function parseLearnedSpell(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  return reader.u32();
}

/** `SMSG_REMOVED_SPELL`: one spell id, unlearned. */
export function parseRemovedSpell(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const spellId = reader.u32();
  reader.assertFinished();
  return spellId;
}

/** `SMSG_SUPERCEDED_SPELL`: a rank replaced by a higher one. */
export function parseSupercededSpell(payload: Uint8Array): { oldSpell: number; newSpell: number } {
  const reader = new PacketReader(payload);
  const change = { oldSpell: reader.u32(), newSpell: reader.u32() };
  reader.assertFinished();
  return change;
}

/** `SMSG_SEND_UNLEARN_SPELLS`: what a trainer would take away again. */
export function parseUnlearnSpells(payload: Uint8Array): number[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 10_000) throw new RangeError(`Unlearn list names ${count} spells`);
  const spells: number[] = [];
  for (let index = 0; index < count; index++) spells.push(reader.u32());
  reader.assertFinished();
  return spells;
}

export interface BindPoint {
  x: number;
  y: number;
  z: number;
  mapId: number;
  areaId: number;
}

/** `SMSG_BIND_POINT_UPDATE`: where the hearthstone goes. Position first, then map and area. */
export function parseBindPoint(payload: Uint8Array): BindPoint {
  const reader = new PacketReader(payload);
  const point = { x: reader.f32(), y: reader.f32(), z: reader.f32(), mapId: reader.u32(), areaId: reader.u32() };
  reader.assertFinished();
  return point;
}

/** `SMSG_PLAYER_BOUND`: who bound the player, and where. */
export function parsePlayerBound(payload: Uint8Array): { binderGuid: bigint; areaId: number } {
  const reader = new PacketReader(payload);
  const bound = { binderGuid: reader.u64(), areaId: reader.u32() };
  reader.assertFinished();
  return bound;
}

/** A guid on its own: `SMSG_BINDER_CONFIRM`, `SMSG_SHOW_BANK`, `SMSG_INVALIDATE_PLAYER`. */
export function parseGuidOnly(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

/**
 * `CMSG_BINDER_ACTIVATE`: the innkeeper's guid, full (`HandleBinderActivateOpcode`, NPCHandler.cpp:287)
 * — the answer to `SMSG_BINDER_CONFIRM`, which carries that guid alone (`BinderConfirm::Write`,
 * MiscPackets.cpp:37). The home moves only on this packet: `SendBindPoint` casts 3286 then.
 */
export function buildBinderActivate(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** A trainer's quote for resetting the character's talents. */
export interface TalentWipeQuote {
  guid: bigint;
  /** Copper, `Player::ResetTalentsCost`. */
  cost: number;
}

/**
 * `MSG_TALENT_WIPE_CONFIRM` from the server: `u64 trainer, u32 cost` (`RespecWipeConfirm::Write`,
 * TalentPackets.cpp:22). The client answers on the same opcode with the guid alone
 * (`ConfirmRespecWipe::Read`, :30). A zero guid is not a question: `HandleTalentWipeConfirmOpcode`
 * sends it when `ResetTalents` found nothing to reset (SkillHandler.cpp:83-87).
 */
export function parseTalentWipeConfirm(payload: Uint8Array): TalentWipeQuote {
  const reader = new PacketReader(payload);
  const quote = { guid: reader.u64(), cost: reader.u32() };
  reader.assertFinished();
  return quote;
}

/**
 * `UnitStandStateType`, `UnitDefines.h`: byte 0 of `UNIT_FIELD_BYTES_1`.
 *
 * Copied from the core rather than from memory, which is what a first draft of this list did — and
 * got wrong in a way nothing catches: it had sleep and the three chair heights one place too early,
 * so a character on a low chair would have been drawn standing and a sleeping one sitting. Sitting
 * is a state the server owns; the client asks for the change and draws whatever comes back.
 */
export const UNIT_STAND_STATE_STAND = 0;
export const UNIT_STAND_STATE_SIT = 1;
export const UNIT_STAND_STATE_SIT_CHAIR = 2;
export const UNIT_STAND_STATE_SLEEP = 3;
export const UNIT_STAND_STATE_SIT_LOW_CHAIR = 4;
export const UNIT_STAND_STATE_SIT_MEDIUM_CHAIR = 5;
export const UNIT_STAND_STATE_SIT_HIGH_CHAIR = 6;
export const UNIT_STAND_STATE_DEAD = 7;
export const UNIT_STAND_STATE_KNEEL = 8;
/** No pose is named for this one, so none is guessed: a burrowed creature keeps what it had. */
export const UNIT_STAND_STATE_SUBMERGED = 9;

/** `SMSG_STANDSTATE_UPDATE`: sitting, standing, kneeling. */
export function parseStandState(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const state = reader.u8();
  reader.assertFinished();
  return state;
}

/** `SMSG_PLAYED_TIME`: seconds in the world, and seconds at this level. */
export function parsePlayedTime(payload: Uint8Array): { total: number; atLevel: number } {
  const reader = new PacketReader(payload);
  const played = { total: reader.u32(), atLevel: reader.u32() };
  reader.u8();
  reader.assertFinished();
  return played;
}

/** `SMSG_SET_PROFICIENCY`: which item classes the character may now use. */
export function parseProficiency(payload: Uint8Array): { itemClass: number; subclassMask: number } {
  const reader = new PacketReader(payload);
  const proficiency = { itemClass: reader.u8(), subclassMask: reader.u32() };
  reader.assertFinished();
  return proficiency;
}

/** `SMSG_TITLE_EARNED`: a title gained or lost, by its bit in the character's title mask. */
export function parseTitleEarned(payload: Uint8Array): { maskId: number; earned: boolean } {
  const reader = new PacketReader(payload);
  const title = { maskId: reader.u32(), earned: reader.u32() !== 0 };
  reader.assertFinished();
  return title;
}

/**
 * `CMSG_SET_TITLE`: the title's mask index as a signed word. -1 takes the title off; the core
 * clears the field on that and on any mask the character has not earned (HandleSetTitleOpcode).
 */
export function buildSetTitle(index: number): Uint8Array {
  return new PacketWriter().i32(index).toUint8Array();
}

/** `CMSG_UNLEARN_SKILL`: the SkillLine id; the core refuses anything but an unlearnable profession. */
export function buildUnlearnSkill(skillId: number): Uint8Array {
  return new PacketWriter().u32(skillId).toUint8Array();
}

/** `SMSG_EXPLORATION_EXPERIENCE`: a new area found, and what it was worth. */
export function parseExplorationExperience(payload: Uint8Array): { areaId: number; experience: number } {
  const reader = new PacketReader(payload);
  const exploration = { areaId: reader.u32(), experience: reader.u32() };
  reader.assertFinished();
  return exploration;
}

/**
 * Reputation as the server holds it: one entry per list id, 128 of them, whether or not the
 * character has ever met the faction. Mirrors `ReputationMgr::SendInitialReputations`.
 */
export interface FactionState {
  listId: number;
  flags: number;
  standing: number;
}

export function parseInitialFactions(payload: Uint8Array): FactionState[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Faction list names ${count} factions`);
  const factions: FactionState[] = [];
  for (let listId = 0; listId < count; listId++) {
    factions.push({ listId, flags: reader.u8(), standing: reader.i32() });
  }
  reader.assertFinished();
  return factions;
}

export interface FactionStandingUpdate {
  /** Set when the change was a gain, which is what the original client colours green. */
  increased: boolean;
  standings: Array<{ listId: number; standing: number }>;
}

/** Mirrors `ReputationMgr::SendState`. The leading float is written as zero and means nothing. */
export function parseFactionStanding(payload: Uint8Array): FactionStandingUpdate {
  const reader = new PacketReader(payload);
  reader.f32();
  const increased = reader.u8() !== 0;
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Faction standing names ${count} factions`);
  const standings: Array<{ listId: number; standing: number }> = [];
  for (let index = 0; index < count; index++) standings.push({ listId: reader.u32(), standing: reader.i32() });
  reader.assertFinished();
  return { increased, standings };
}

/** `SMSG_SET_FACTION_VISIBLE`: a faction the character has now met. */
export function parseFactionVisible(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const listId = reader.u32();
  reader.assertFinished();
  return listId;
}

/**
 * Declares war on a reputation list id, or makes peace (`CMSG_SET_FACTION_ATWAR`).
 *
 * The body is the handler's (`CharacterHandler.cpp:1055-1067`): a list id word and a flag byte.
 * The server answers nothing: `ReputationMgr::SendState` carries standings only, so the flag is
 * flipped on the client's own copy by the caller (`WorldClient.setFactionAtWar`).
 */
export function buildSetFactionAtWar(listId: number, atWar: boolean): Uint8Array {
  return new PacketWriter().u32(listId).u8(atWar ? 1 : 0).toUint8Array();
}

/** `PLAYER_FIELD_WATCHED_FACTION_INDEX`'s "no faction" (Player.cpp:561). */
export const NO_WATCHED_FACTION = 0xFFFF_FFFF;

/**
 * `CMSG_SET_WATCHED_FACTION`: one list id word the core copies into
 * `PLAYER_FIELD_WATCHED_FACTION_INDEX` (`CharacterHandler.cpp:1103-1109`); none is `0xFFFFFFFF`.
 */
export function buildSetWatchedFaction(listId: number | undefined): Uint8Array {
  return new PacketWriter().u32(listId ?? NO_WATCHED_FACTION).toUint8Array();
}

/** `CMSG_SET_FACTION_INACTIVE`: a list id word and a flag byte (`CharacterHandler.cpp:1111-1119`). */
export function buildSetFactionInactive(listId: number, inactive: boolean): Uint8Array {
  return new PacketWriter().u32(listId).u8(inactive ? 1 : 0).toUint8Array();
}

/** `SMSG_SET_FORCED_REACTIONS`: factions whose attitude is fixed regardless of standing. */
export function parseForcedReactions(payload: Uint8Array): Array<{ factionId: number; rank: number }> {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Forced reactions name ${count} factions`);
  const reactions: Array<{ factionId: number; rank: number }> = [];
  for (let index = 0; index < count; index++) reactions.push({ factionId: reader.u32(), rank: reader.u32() });
  reader.assertFinished();
  return reactions;
}

export interface AchievementEarned {
  playerGuid: bigint;
  achievementId: number;
  /** Packed server time, as the core writes it. */
  date: number;
}

/** Mirrors `AchievementMgr::SendAchievementEarned`. */
export function parseAchievementEarned(payload: Uint8Array): AchievementEarned {
  const reader = new PacketReader(payload);
  return { playerGuid: reader.packedGuid(), achievementId: reader.u32(), date: reader.u32() };
}

export interface CriteriaUpdate {
  criteriaId: number;
  counter: bigint;
  playerGuid: bigint;
  /** 0, or for a timed criterion 1 when it completed in time («keep the counter at 0 in client»). */
  flags: number;
  /** Packed server time (WowTime) of the progress. */
  date: number;
  /** Seconds a timed criterion has run. */
  timeElapsed: number;
}

/**
 * Mirrors `AchievementMgr::SendCriteriaUpdate`: id, the counter written with the packed-guid
 * encoding even though it is a number (the same reader either way), the player, then four words —
 * the timer flags, the date, the seconds elapsed and an unused zero.
 */
export function parseCriteriaUpdate(payload: Uint8Array): CriteriaUpdate {
  const reader = new PacketReader(payload);
  const criteriaId = reader.u32();
  const counter = reader.packedGuid();
  const playerGuid = reader.packedGuid();
  const flags = reader.u32();
  const date = reader.u32();
  const timeElapsed = reader.u32();
  return { criteriaId, counter, playerGuid, flags, date, timeElapsed };
}

/** `CMSG_QUERY_INSPECT_ACHIEVEMENTS` (WorldSession::HandleQueryInspectAchievements): a packed guid. */
export function buildQueryInspectAchievements(guid: bigint): Uint8Array {
  return new PacketWriter().packedGuid(guid).toUint8Array();
}

export interface AchievementData {
  /** Whose achievements these are; only the inspect form carries it. */
  playerGuid: bigint | undefined;
  completed: Array<{ achievementId: number; date: number }>;
  criteria: Array<{ criteriaId: number; counter: bigint }>;
}

/**
 * `SMSG_ALL_ACHIEVEMENT_DATA` and `SMSG_RESPOND_INSPECT_ACHIEVEMENTS` share one body, which is two
 * lists each ended by a written -1 rather than counted up front.
 */
export function parseAchievementData(payload: Uint8Array, withGuid: boolean): AchievementData {
  const reader = new PacketReader(payload);
  const playerGuid = withGuid ? reader.packedGuid() : undefined;
  const completed: Array<{ achievementId: number; date: number }> = [];
  for (;;) {
    const achievementId = reader.i32();
    if (achievementId === -1) break;
    completed.push({ achievementId, date: reader.u32() });
  }
  const criteria: Array<{ criteriaId: number; counter: bigint }> = [];
  for (;;) {
    const criteriaId = reader.i32();
    if (criteriaId === -1) break;
    const counter = reader.packedGuid();
    reader.packedGuid();
    reader.u32();
    reader.u32();
    reader.u32();
    reader.u32();
    criteria.push({ criteriaId, counter });
  }
  return { playerGuid, completed, criteria };
}

/** `SMSG_SERVER_FIRST_ACHIEVEMENT`: someone on this realm got there first. */
export function parseServerFirstAchievement(payload: Uint8Array): { name: string; guid: bigint; achievementId: number } {
  const reader = new PacketReader(payload);
  return { name: reader.cString(), guid: reader.u64(), achievementId: reader.u32() };
}

export interface TalentRank {
  talentId: number;
  /** How far the talent is trained, one-based for UI; the packet sends 0 to 4. */
  rank: number;
}

export interface TalentSpec {
  talents: TalentRank[];
  glyphs: number[];
}

export interface TalentsInfo {
  pet: boolean;
  unspentPoints: number;
  activeSpec: number;
  specs: TalentSpec[];
}

/** Mirrors `Player::BuildPlayerTalentsInfoData` and the shorter `BuildPetTalentsInfoData`. */
export function parseTalentsInfo(payload: Uint8Array): TalentsInfo {
  const reader = new PacketReader(payload);
  const pet = reader.u8() !== 0;
  const unspentPoints = reader.u32();
  if (pet) {
    // The pet packet has a single talent count directly after the points. It carries no
    // specialisation index/count and no glyphs; treat its one tree as the active spec for the UI.
    const talentCount = reader.u8();
    const talents: TalentRank[] = [];
    for (let talent = 0; talent < talentCount; talent++) {
      talents.push({ talentId: reader.u32(), rank: reader.u8() + 1 });
    }
    reader.assertFinished();
    return { pet, unspentPoints, activeSpec: 0, specs: [{ talents, glyphs: [] }] };
  }
  const specCount = reader.u8();
  const activeSpec = reader.u8();
  if (specCount > 4) throw new RangeError(`Talents name ${specCount} specialisations`);
  const specs: TalentSpec[] = [];
  for (let index = 0; index < specCount; index++) {
    const talentCount = reader.u8();
    const talents: TalentRank[] = [];
    for (let talent = 0; talent < talentCount; talent++) talents.push({ talentId: reader.u32(), rank: reader.u8() + 1 });
    const glyphCount = reader.u8();
    const glyphs: number[] = [];
    for (let glyph = 0; glyph < glyphCount; glyph++) glyphs.push(reader.u16());
    specs.push({ talents, glyphs });
  }
  return { pet, unspentPoints, activeSpec, specs };
}

export interface EquipmentSet {
  guid: bigint;
  setId: number;
  name: string;
  icon: string;
  /** Nineteen slots, by item guid; a zero means the slot is left as it is. */
  pieces: bigint[];
}

/** Mirrors `Player::SendEquipmentSetList`. */
export function parseEquipmentSetList(payload: Uint8Array): EquipmentSet[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 100) throw new RangeError(`Equipment set list names ${count} sets`);
  const sets: EquipmentSet[] = [];
  for (let index = 0; index < count; index++) {
    const set: EquipmentSet = {
      guid: reader.packedGuid(),
      setId: reader.u32(),
      name: reader.cString(),
      icon: reader.cString(),
      pieces: [],
    };
    for (let piece = 0; piece < 19; piece++) set.pieces.push(reader.packedGuid());
    sets.push(set);
  }
  reader.assertFinished();
  return sets;
}

/** `SMSG_EQUIPMENT_SET_SAVED`: the set now has a permanent id. */
export function parseEquipmentSetSaved(payload: Uint8Array): { setId: number; guid: bigint } {
  const reader = new PacketReader(payload);
  return { setId: reader.u32(), guid: reader.packedGuid() };
}

/** `MAX_EQUIPMENT_SET_INDEX` in EquipmentSet.h; the comment there says it is the client's limit. */
export const MAX_EQUIPMENT_SETS = 10;

/** `EQUIPMENT_SLOT_END`: the nineteen slots a set names, in `PLAYER_FIELD_INV_SLOT_HEAD` order. */
export const EQUIPMENT_SET_SLOTS = 19;

/**
 * A raw guid of one, which the protocol uses for "leave this slot alone".
 *
 * It is not a guid at all — `HandleEquipmentSetSave` turns it into a bit of `IgnoreMask` and
 * `HandleEquipmentSetUse` skips the slot. Zero means the opposite: empty the slot.
 */
export const EQUIPMENT_SET_IGNORED = 1n;

/**
 * `CMSG_EQUIPMENT_SET_SAVE`: packed set guid, index, name, icon, then nineteen packed item guids.
 *
 * A new set is saved with a guid of zero and gets its real one back in `SMSG_EQUIPMENT_SET_SAVED`.
 * The server checks every piece against what is actually worn — `GetItemByPos(INVENTORY_SLOT_BAG_0,
 * i)` — and silently drops any that disagree, so a set can only ever be saved from what the
 * character has on.
 */
export function buildEquipmentSetSave(
  setGuid: bigint,
  index: number,
  name: string,
  icon: string,
  pieces: ReadonlyArray<bigint>,
): Uint8Array {
  const writer = new PacketWriter().packedGuid(setGuid).u32(index).cString(name).cString(icon);
  for (let slot = 0; slot < EQUIPMENT_SET_SLOTS; slot++) writer.packedGuid(pieces[slot] ?? 0n);
  return writer.toUint8Array();
}

/** `CMSG_DELETEEQUIPMENT_SET`: the set's guid and nothing else. */
export function buildEquipmentSetDelete(setGuid: bigint): Uint8Array {
  return new PacketWriter().packedGuid(setGuid).toUint8Array();
}

/**
 * `CMSG_EQUIPMENT_SET_USE`: nineteen times `{packed item guid, source bag, source slot}`.
 *
 * The set's own id is never sent. The client resolves the set locally and tells the server where
 * each piece is right now, which is why using one needs the inventory as well as the set: a piece
 * the client cannot find is a slot the server will simply unequip.
 */
export function buildEquipmentSetUse(
  pieces: ReadonlyArray<{ guid: bigint; bag: number; slot: number }>,
): Uint8Array {
  const writer = new PacketWriter();
  for (let slot = 0; slot < EQUIPMENT_SET_SLOTS; slot++) {
    const piece = pieces[slot];
    writer.packedGuid(piece?.guid ?? 0n).u8(piece?.bag ?? 0).u8(piece?.slot ?? 0);
  }
  return writer.toUint8Array();
}

/** `SMSG_EQUIPMENT_SET_USE_RESULT`: one byte, and only 4 — "inventory full" — is ever sent. */
export function parseEquipmentSetUseResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  reader.assertFinished();
  return result;
}

/** `SMSG_ITEM_TIME_UPDATE`: how long a temporary item has left. */
export function parseItemTimeUpdate(payload: Uint8Array): { itemGuid: bigint; duration: number } {
  const reader = new PacketReader(payload);
  const update = { itemGuid: reader.u64(), duration: reader.u32() };
  reader.assertFinished();
  return update;
}

/** `SMSG_ITEM_ENCHANT_TIME_UPDATE`: how long a temporary enchantment has left. */
export function parseEnchantTimeUpdate(payload: Uint8Array): { itemGuid: bigint; slot: number; duration: number; playerGuid: bigint } {
  const reader = new PacketReader(payload);
  const update = { itemGuid: reader.u64(), slot: reader.u32(), duration: reader.u32(), playerGuid: reader.u64() };
  reader.assertFinished();
  return update;
}

/** `Item::SendUpdateSockets`: full item GUID, three socket enchantments and the socket bonus. */
export function parseSocketGems(payload: Uint8Array): { itemGuid: bigint; enchantments: number[] } {
  const reader = new PacketReader(payload);
  const itemGuid = reader.u64();
  const enchantments = [reader.u32(), reader.u32(), reader.u32(), reader.u32()];
  reader.assertFinished();
  return { itemGuid, enchantments };
}

/** `SMSG_CROSSED_INEBRIATION_THRESHOLD`: the character got another drink down. */
export function parseInebriation(payload: Uint8Array): { guid: bigint; threshold: number; itemId: number } {
  const reader = new PacketReader(payload);
  const drink = { guid: reader.u64(), threshold: reader.u32(), itemId: reader.u32() };
  reader.assertFinished();
  return drink;
}

/** `SMSG_REFER_A_FRIEND_FAILURE`: why a level grant was refused. */
export function parseReferAFriendFailure(payload: Uint8Array): { error: number; name: string } {
  const reader = new PacketReader(payload);
  return { error: reader.u32(), name: reader.remaining > 0 ? reader.cString() : "" };
}

/** `CMSG_PLAYED_TIME`: asks how long this character has been played. */
export function buildPlayedTimeQuery(): Uint8Array {
  return new PacketWriter().u8(1).toUint8Array();
}

/** `CMSG_STANDSTATECHANGE`: sit down, stand up. */
export function buildStandStateChange(state: number): Uint8Array {
  return new PacketWriter().u32(state).toUint8Array();
}

/** `CMSG_LEARN_TALENT`: spends a point. The rank is sent zero-based, as it arrives. */
export function buildLearnTalent(talentId: number, rank: number): Uint8Array {
  return new PacketWriter().u32(talentId).u32(Math.max(0, rank - 1)).toUint8Array();
}

/**
 * `CMSG_LEARN_PREVIEW_TALENTS` (plan item 3.33): `u32 count, (u32 id, u32 rank)…`, the rank
 * zero-based as in `buildLearnTalent`. Wow.exe 0x5c6a10 (Lua `LearnPreviewTalents`) writes one
 * pair per talent whose preview rank is above its learned rank; the core learns them in order
 * (`HandleLearnPreviewTalents`, SkillHandler.cpp:37-59, at most 150 read).
 */
export function buildLearnPreviewTalents(talents: ReadonlyArray<{ talentId: number; rank: number }>): Uint8Array {
  const writer = new PacketWriter().u32(talents.length);
  for (const talent of talents) writer.u32(talent.talentId).u32(Math.max(0, talent.rank - 1));
  return writer.toUint8Array();
}

/** `CMSG_INSPECT`: asks to see another character's talents and gear. */
export function buildInspect(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `CMSG_BUY_BANK_SLOT`: buys the next bag slot in the bank. */
export function buildBuyBankSlot(bankerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(bankerGuid).toUint8Array();
}

/** `MAX_GLYPH_SLOT_INDEX` in SharedDefines.h: six slots, three major and three minor. */
export const MAX_GLYPH_SLOTS = 6;

/**
 * `CMSG_REMOVE_GLYPH`: takes one out of its slot.
 *
 * There is no opcode for putting one in — a glyph is inserted by using the item, which is an
 * ordinary `CMSG_USE_ITEM`. So this is the whole of the glyph protocol from the client's side, and
 * the server answers it with a fresh `SMSG_TALENTS_INFO` rather than with anything about glyphs.
 */
export function buildRemoveGlyph(slot: number): Uint8Array {
  return new PacketWriter().u32(slot).toUint8Array();
}

/**
 * `CMSG_LEARN_PREVIEW_TALENTS_PET`: `u64 guid, u32 count, (u32 id, u32 rank)…`.
 *
 * A pet has no single-talent opcode at all — `CMSG_LEARN_TALENT` is the character's, and the pet's
 * only route in is this batch, which the original client uses for its preview panel. So a single
 * point is sent as a list of one. The rank here is the zero-based wire form, the same one
 * `buildLearnTalent` converts to, and the server caps the list at thirty.
 */
export function buildLearnPetTalents(
  petGuid: bigint,
  talents: ReadonlyArray<{ talentId: number; rank: number }>,
): Uint8Array {
  const writer = new PacketWriter().u64(petGuid).u32(talents.length);
  for (const talent of talents) writer.u32(talent.talentId).u32(Math.max(0, talent.rank - 1));
  return writer.toUint8Array();
}
