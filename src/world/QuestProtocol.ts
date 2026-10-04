import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/**
 * Quests: what they are, how far along they are, and which head to put a mark over.
 *
 * The quest log itself is not a packet — it lives in the character's own update fields, five words
 * per slot — so what arrives here is the description of a quest (`SMSG_QUEST_QUERY_RESPONSE`, sent
 * once and worth caching) and the small announcements that a counter moved.
 */

/** `QuestGiverStatus`, the mark drawn over a head. */
export const QUEST_STATUS_NONE = 0;
export const QUEST_STATUS_UNAVAILABLE = 1;
export const QUEST_STATUS_LOW_LEVEL_AVAILABLE = 2;
export const QUEST_STATUS_LOW_LEVEL_REWARD_REP = 3;
export const QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP = 4;
export const QUEST_STATUS_INCOMPLETE = 5;
export const QUEST_STATUS_REWARD_REP = 6;
export const QUEST_STATUS_AVAILABLE_REP = 7;
export const QUEST_STATUS_AVAILABLE = 8;
export const QUEST_STATUS_REWARD2 = 9;
export const QUEST_STATUS_REWARD = 10;

/** Five words per slot, and the counters are four shorts across two of them. */
export const QUEST_LOG_SLOT_WORDS = 5;
export const QUEST_OBJECTIVES = 4;
export const QUEST_ITEM_OBJECTIVES = 6;
export const QUEST_REWARDS = 4;
export const QUEST_REWARD_CHOICES = 6;
export const QUEST_REPUTATIONS = 5;

/** `QUEST_STATE_COMPLETE` and `QUEST_STATE_FAIL` in the slot's state word. */
export const QUEST_STATE_COMPLETE = 0x0001;
export const QUEST_STATE_FAIL = 0x0002;

export interface QuestObjective {
  /** Position in the core's fixed four-slot objective array and the player's counter fields. */
  slot: number;
  /** Creature entry, or a gameobject entry with the top bit set — the core sends `id | 0x80000000`. */
  entry: number;
  count: number;
  /** Set when the entry names a gameobject rather than a creature. */
  gameObject: boolean;
  itemDrop: number;
  text: string;
}

export interface QuestItemObjective {
  /** Position in the core's fixed six-slot required-item array. */
  slot: number;
  itemId: number;
  count: number;
}

/**
 * The query packet's `RewOrReqMoney` is one signed field: a positive value is a reward, while a
 * negative value is the money the quest requires. Keep the wire value intact and expose the two
 * display meanings without making each caller repeat (or accidentally reverse) the sign logic.
 */
export interface QuestMoney {
  /** The exact signed `RewOrReqMoney` value from the packet. */
  raw: number;
  /** Non-negative reward amount, or zero when this quest requires money. */
  reward: number;
  /** Non-negative required amount, or zero when this quest pays money. */
  required: number;
}

export function splitQuestMoney(rewOrReqMoney: number): QuestMoney {
  if (!Number.isInteger(rewOrReqMoney)) throw new TypeError("Quest money must be an integer");
  return rewOrReqMoney >= 0
    ? { raw: rewOrReqMoney, reward: rewOrReqMoney, required: 0 }
    : { raw: rewOrReqMoney, reward: 0, required: -rewOrReqMoney };
}

/** One authoritative carried stack, independent of the browser inventory model. */
export interface QuestCarriedItemStack {
  itemId: number;
  count: number;
}

/** Sums split stacks the way the server's carried-item count does. */
export function buildCarriedItemCounts(
  stacks: ReadonlyArray<QuestCarriedItemStack>,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const stack of stacks) {
    if (stack.itemId <= 0 || stack.count <= 0) continue;
    counts.set(stack.itemId, (counts.get(stack.itemId) ?? 0) + stack.count);
  }
  return counts;
}

export interface QuestTemplate {
  questId: number;
  level: number;
  minLevel: number;
  sortId: number;
  type: number;
  suggestedPlayers: number;
  nextQuest: number;
  /** Signed `RewOrReqMoney`: positive reward, negative required quest cost. */
  rewardMoney: number;
  /** Derived non-negative cost for a negative `rewardMoney` wire value. */
  requiredMoney: number;
  rewardBonusMoney: number;
  /** `RewSpell`: spell shown as the reward (typically the icon). */
  rewardDisplaySpell: number;
  /** `RewSpellCast`: spell cast when the quest reward is claimed. */
  rewardSpellCast: number;
  /** @deprecated Use `rewardSpellCast`; kept as a compatibility alias for existing callers. */
  rewardSpell: number;
  rewardHonor: number;
  startItem: number;
  flags: number;
  /**
   * The four `ItemDrop` (RequiredSourceItemId) slots as sent, holes included: `objectives` keeps only
   * the slots with a creature or object, but the client reads all four (quest cache 0x1c74) for the
   * tracker's special item. Optional for templates built by hand.
   */
  sourceItems?: number[];
  rewardTitleId: number;
  requiredPlayerKills: number;
  rewardTalents: number;
  rewardItems: Array<{ itemId: number; count: number }>;
  rewardChoiceItems: Array<{ itemId: number; count: number }>;
  poi: { map: number; x: number; y: number; priority: number };
  title: string;
  objectivesText: string;
  details: string;
  areaDescription: string;
  completedText: string;
  objectives: QuestObjective[];
  itemObjectives: QuestItemObjective[];
}

/** `CMSG_QUEST_QUERY`'s answer, mirroring `WorldPackets::Quest::QueryQuestInfoResponse::Write`. */
export function parseQuestQueryResponse(payload: Uint8Array): QuestTemplate {
  const reader = new PacketReader(payload);
  const questId = reader.u32();
  reader.u32();
  const level = reader.u32();
  const minLevel = reader.u32();
  const sortId = reader.u32();
  const type = reader.u32();
  const suggestedPlayers = reader.u32();
  // Two PvP teams, each with a faction and a standing.
  for (let team = 0; team < 2; team++) {
    reader.u32();
    reader.u32();
  }
  const nextQuest = reader.u32();
  reader.u32();
  const rewardMoney = reader.i32();
  const requiredMoney = splitQuestMoney(rewardMoney).required;
  const rewardBonusMoney = reader.u32();
  const rewardDisplaySpell = reader.u32();
  const rewardSpellCast = reader.i32();
  const rewardHonor = reader.u32();
  reader.f32();
  const startItem = reader.u32();
  const flags = reader.u32();
  const rewardTitleId = reader.u32();
  const requiredPlayerKills = reader.u32();
  const rewardTalents = reader.u32();
  reader.u32();
  reader.u32();

  const rewardItems: Array<{ itemId: number; count: number }> = [];
  for (let index = 0; index < QUEST_REWARDS; index++) {
    const itemId = reader.u32();
    const count = reader.u32();
    if (itemId > 0) rewardItems.push({ itemId, count });
  }
  const rewardChoiceItems: Array<{ itemId: number; count: number }> = [];
  for (let index = 0; index < QUEST_REWARD_CHOICES; index++) {
    const itemId = reader.u32();
    const count = reader.u32();
    if (itemId > 0) rewardChoiceItems.push({ itemId, count });
  }
  // Reputation rewards: ids, values, then overrides, five of each.
  for (let index = 0; index < QUEST_REPUTATIONS * 3; index++) reader.u32();

  const poi = { map: reader.u32(), x: reader.f32(), y: reader.f32(), priority: reader.u32() };
  const title = reader.cString();
  const objectivesText = reader.cString();
  const details = reader.cString();
  const areaDescription = reader.cString();
  const completedText = reader.cString();

  const objectives: QuestObjective[] = [];
  const sourceItems: number[] = [];
  for (let index = 0; index < QUEST_OBJECTIVES; index++) {
    const raw = reader.u32();
    const count = reader.u32();
    const itemDrop = reader.u32();
    sourceItems.push(itemDrop);
    reader.u32();
    // The client is told a gameobject by having the top bit set on the entry.
    objectives.push({ slot: index, entry: raw & 0x7fff_ffff, gameObject: (raw & 0x8000_0000) !== 0, count, itemDrop, text: "" });
  }
  const itemObjectives: QuestItemObjective[] = [];
  for (let index = 0; index < QUEST_ITEM_OBJECTIVES; index++) {
    const itemId = reader.u32();
    const count = reader.u32();
    if (itemId > 0) itemObjectives.push({ slot: index, itemId, count });
  }
  for (let index = 0; index < QUEST_OBJECTIVES; index++) {
    const text = reader.cString();
    const objective = objectives[index];
    if (objective) objective.text = text;
  }

  return {
    questId, level, minLevel, sortId, type, suggestedPlayers, nextQuest, rewardMoney, requiredMoney,
    rewardBonusMoney, rewardDisplaySpell, rewardSpellCast, rewardSpell: rewardSpellCast,
    rewardHonor, startItem, flags, sourceItems, rewardTitleId,
    requiredPlayerKills, rewardTalents, rewardItems, rewardChoiceItems, poi, title,
    objectivesText, details, areaDescription, completedText,
    objectives: objectives.filter((objective) => objective.entry > 0 && objective.count > 0),
    itemObjectives,
  };
}

export interface QuestGiverStatus {
  guid: bigint;
  status: number;
}

/** `SMSG_QUESTGIVER_STATUS`: one head. Mirrors `PlayerMenu::SendQuestGiverStatus`. */
export function parseQuestGiverStatus(payload: Uint8Array): QuestGiverStatus {
  const reader = new PacketReader(payload);
  const status = { guid: reader.u64(), status: reader.u8() };
  reader.assertFinished();
  return status;
}

/** `SMSG_QUESTGIVER_STATUS_MULTIPLE`: every head in range, sent when the player moves. */
export function parseQuestGiverStatusMultiple(payload: Uint8Array): QuestGiverStatus[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 1000) throw new RangeError(`Quest giver status names ${count} givers`);
  const statuses: QuestGiverStatus[] = [];
  for (let index = 0; index < count; index++) statuses.push({ guid: reader.u64(), status: reader.u8() });
  reader.assertFinished();
  return statuses;
}

/**
 * `Player::SendQuestFailed` writes the quest ID first and then an `InventoryResult` reason.
 * `SMSG_QUESTGIVER_QUEST_INVALID` has a different one-word layout.
 */
export function parseQuestGiverFailed(payload: Uint8Array): { questId: number; reason: number } {
  const reader = new PacketReader(payload);
  const questId = reader.u32();
  const reason = reader.u32();
  reader.assertFinished();
  return { questId, reason };
}

export interface QuestKillUpdate {
  questId: number;
  /** Creature or gameobject entry, as the objective names it. */
  entry: number;
  count: number;
  required: number;
  guid: bigint;
}

/** `SMSG_QUESTUPDATE_ADD_KILL`, from `Player::SendQuestUpdateAddCreatureOrGo`. */
export function parseQuestKillUpdate(payload: Uint8Array): QuestKillUpdate {
  const reader = new PacketReader(payload);
  const update = {
    questId: reader.u32(),
    entry: reader.u32(),
    count: reader.u32(),
    required: reader.u32(),
    guid: reader.u64(),
  };
  reader.assertFinished();
  return update;
}

/** `SMSG_QUESTUPDATE_COMPLETE` and `SMSG_QUESTUPDATE_FAILEDTIMER` are both one quest id. */
export function parseQuestIdUpdate(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const questId = reader.u32();
  reader.assertFinished();
  return questId;
}

export interface QuestConfirmAccept {
  questId: number;
  title: string;
  /** Who is asking the party to take the quest with them. */
  initiatorGuid: bigint;
}

/** `SMSG_QUEST_CONFIRM_ACCEPT`: a party member shared a quest. */
export function parseQuestConfirmAccept(payload: Uint8Array): QuestConfirmAccept {
  const reader = new PacketReader(payload);
  const confirm = { questId: reader.u32(), title: reader.cString(), initiatorGuid: reader.u64() };
  reader.assertFinished();
  return confirm;
}

/** `MSG_QUEST_PUSH_RESULT`: what happened when a quest was pushed to someone. */
export function parseQuestPushResult(payload: Uint8Array): { guid: bigint; result: number } {
  const reader = new PacketReader(payload);
  const result = { guid: reader.u64(), result: reader.u8() };
  reader.assertFinished();
  return result;
}

/** `SMSG_QUERY_QUESTS_COMPLETED_RESPONSE`: every quest this character has ever finished. */
export function parseCompletedQuests(payload: Uint8Array): number[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 100_000) throw new RangeError(`Completed quest list names ${count} quests`);
  const quests: number[] = [];
  for (let index = 0; index < count; index++) quests.push(reader.u32());
  reader.assertFinished();
  return quests;
}

export interface QuestPoint {
  x: number;
  y: number;
}

export interface QuestPoiBlob {
  index: number;
  objectiveIndex: number;
  map: number;
  worldMapAreaId: number;
  floor: number;
  /**
   * The two words after the floor (TrinityCore's `Unk3`, `Unk4`), as Wow.exe 0x5e7370 keeps them (blob
   * + 0x30, + 0x2c): the icon goes to the blob with the lowest `priority` (0x5e2eb0), and a blob whose
   * `flags` have 0x4 counts only on its own WorldMapArea. Optional for blobs built by hand.
   */
  priority?: number;
  flags?: number;
  points: QuestPoint[];
}

/** `SMSG_QUEST_POI_QUERY_RESPONSE`: where on the map a quest wants the player to go. */
export function parseQuestPoi(payload: Uint8Array): Map<number, QuestPoiBlob[]> {
  const reader = new PacketReader(payload);
  const questCount = reader.u32();
  if (questCount > 1000) throw new RangeError(`Quest POI response names ${questCount} quests`);
  const byQuest = new Map<number, QuestPoiBlob[]>();
  for (let index = 0; index < questCount; index++) {
    const questId = reader.u32();
    const blobCount = reader.u32();
    if (blobCount > 100) throw new RangeError(`Quest ${questId} has ${blobCount} points of interest`);
    const blobs: QuestPoiBlob[] = [];
    for (let blob = 0; blob < blobCount; blob++) {
      const entry: QuestPoiBlob = {
        index: reader.u32(),
        objectiveIndex: reader.i32(),
        map: reader.u32(),
        worldMapAreaId: reader.u32(),
        floor: reader.u32(),
        points: [],
      };
      entry.priority = reader.u32();
      entry.flags = reader.u32();
      const pointCount = reader.u32();
      if (pointCount > 1000) throw new RangeError(`Quest point of interest has ${pointCount} points`);
      for (let point = 0; point < pointCount; point++) entry.points.push({ x: reader.i32(), y: reader.i32() });
      blobs.push(entry);
    }
    byQuest.set(questId, blobs);
  }
  return byQuest;
}

export interface PointOfInterest {
  flags: number;
  x: number;
  y: number;
  icon: number;
  importance: number;
  name: string;
}

/** `SMSG_GOSSIP_POI`: a place a gossip option pointed at. */
export function parseGossipPoi(payload: Uint8Array): PointOfInterest {
  const reader = new PacketReader(payload);
  const poi = {
    flags: reader.i32(),
    x: reader.f32(),
    y: reader.f32(),
    icon: reader.i32(),
    importance: reader.i32(),
    name: reader.cString(),
  };
  reader.assertFinished();
  return poi;
}

/** `CMSG_QUEST_POI_QUERY`: asks where the quests in the log want the player to go. */
export function buildQuestPoiQuery(questIds: readonly number[]): Uint8Array {
  const writer = new PacketWriter().u32(questIds.length);
  for (const questId of questIds) writer.u32(questId);
  return writer.toUint8Array();
}

/** `CMSG_QUERY_QUESTS_COMPLETED`: asks for the list of everything already finished. */
export function buildCompletedQuestsQuery(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** `CMSG_PUSH_QUEST_TO_PARTY`: shares a quest from the log with the party. */
export function buildPushQuestToParty(questId: number): Uint8Array {
  return new PacketWriter().u32(questId).toUint8Array();
}

/** `CMSG_QUEST_CONFIRM_ACCEPT`: yes to a quest a party member shared. */
export function buildQuestConfirmAccept(questId: number): Uint8Array {
  return new PacketWriter().u32(questId).toUint8Array();
}

/** `CMSG_QUESTLOG_REMOVE_QUEST`: abandons whatever is in that slot of the log. */
export function buildAbandonQuest(slot: number): Uint8Array {
  return new PacketWriter().u8(slot).toUint8Array();
}

/** `QuestShareMessages` in the active core's QuestDef.h. */
export const QUEST_PARTY_MSG_DECLINE_QUEST = 3;

/** The client reply includes questId; the server notification on this same MSG opcode does not. */
export function buildQuestPushResult(guid: bigint, questId: number, result: number): Uint8Array {
  return new PacketWriter().u64(guid).u32(questId).u8(result).toUint8Array();
}

/**
 * `CMSG_QUEST_QUERY`: asks what a quest actually is. This is the plain query — the questgiver
 * flow has its own opcode that names the giver as well, and they are not interchangeable.
 */
export function buildQuestInfoQuery(questId: number): Uint8Array {
  return new PacketWriter().u32(questId).toUint8Array();
}

export interface QuestLogEntryView {
  slot: number;
  questId: number;
  template: QuestTemplate | undefined;
  complete: boolean;
  failed: boolean;
  /** Absolute expiry in the server's seconds, or 0 when the quest is not timed. */
  timer: number;
  /** `NaN` means the carried-item snapshot was not authoritative yet. */
  objectives: QuestLogObjectiveView[];
}

/** The cache family that can turn an objective's numeric wire id into an in-game name. */
export type QuestLogObjectiveKind = "creature" | "gameObject" | "item";

/** One objective with its target identity preserved for the browser metadata caches. */
export interface QuestLogObjectiveView {
  kind: QuestLogObjectiveKind;
  id: number;
  /** `quest_poi.ObjectiveIndex`: 0..3 are NPC/GO slots, 4..9 are required-item slots. */
  poiIndex: number;
  /** Authored quest text. Empty means the target metadata should supply the label. */
  text: string;
  have: number;
  need: number;
  done: boolean;
}

/**
 * Keep authored wording when the quest supplies it; otherwise prefer the resolved game name and
 * leave an explicit, stable id only as the final missing-metadata fallback.
 */
export function questObjectiveLabel(objective: QuestLogObjectiveView, resolvedName?: string): string {
  const authored = objective.text.trim();
  if (authored) return authored;
  const name = resolvedName?.trim();
  if (name) return name;
  if (objective.kind === "item") return `Предмет #${objective.id}`;
  if (objective.kind === "gameObject") return `Объект #${objective.id}`;
  return `Существо #${objective.id}`;
}

/**
 * Joins what the character's update fields say — quest id, state, four counters — to what the
 * quest itself is, which arrives separately and is cached. An entry whose template has not come
 * back yet is still shown: the log knows the quest is there before it knows its name.
 */
export function buildQuestLogView(
  slots: ReadonlyArray<{ slot: number; questId: number; state: number; counters: readonly number[]; timer: number }>,
  templates: ReadonlyMap<number, QuestTemplate>,
  /**
   * A complete carried-inventory snapshot. A missing item id is zero only when
   * this map is supplied; without it the count is `NaN` (unknown) rather than
   * guessed.
   */
  carriedItemCounts?: ReadonlyMap<number, number>,
): QuestLogEntryView[] {
  return slots.map((entry) => {
    const template = templates.get(entry.questId);
    const objectives: QuestLogEntryView["objectives"] = [];
    template?.objectives.forEach((objective, index) => {
      const slot = objective.slot ?? index;
      const have = entry.counters[slot] ?? 0;
      objectives.push({
        kind: objective.gameObject ? "gameObject" : "creature",
        id: objective.entry,
        poiIndex: slot,
        text: objective.text,
        have, need: objective.count, done: have >= objective.count,
      });
    });
    // Item objectives are not represented by the four creature counters. They
    // use the carried snapshot supplied by the UI; while that snapshot is not
    // authoritative, leave the count unknown instead of manufacturing zero.
    for (const [index, item] of (template?.itemObjectives ?? []).entries()) {
      const have = carriedItemCounts?.get(item.itemId);
      objectives.push({
        kind: "item",
        id: item.itemId,
        // The wire reserves four NPC/GO positions even when fewer are populated.
        poiIndex: QUEST_OBJECTIVES + (item.slot ?? index),
        text: "",
        have: carriedItemCounts ? have ?? 0 : Number.NaN,
        need: item.count,
        done: have !== undefined && have >= item.count,
      });
    }
    return {
      slot: entry.slot,
      questId: entry.questId,
      template,
      complete: (entry.state & QUEST_STATE_COMPLETE) !== 0,
      failed: (entry.state & QUEST_STATE_FAIL) !== 0,
      timer: entry.timer,
      objectives,
    };
  });
}
