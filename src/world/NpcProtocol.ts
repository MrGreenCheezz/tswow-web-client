import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/** Generic, ammo, food, poison and reagent vendor bits in WotLK `NPCFlags`. */
export const NPC_FLAGS_VENDOR_MASK = 0x00000f80;
/** NPC flags for every service the native interact dispatcher can currently open. */
export const NPC_FLAGS_INTERACTION_MASK = 0x00000001 | 0x00000002 | 0x00000070
  | NPC_FLAGS_VENDOR_MASK | 0x00002000 | 0x00020000 | 0x00040000 | 0x00080000 | 0x00100000
  | 0x00200000 | 0x00400000 | 0x04000000;
/** `UNIT_NPC_FLAG_PETITIONER`: charter vendor for guilds and arena teams. */
export const NPC_FLAG_PETITIONER = 0x00040000;

export interface GossipOption {
  id: number;
  icon: number;
  coded: boolean;
  money: number;
  text: string;
  boxText: string;
}

export interface QuestMenuEntry {
  id: number;
  icon: number;
  level: number;
  flags: number;
  repeatable: boolean;
  title: string;
}

export interface GossipMessage {
  guid: bigint;
  menuId: number;
  textId: number;
  options: GossipOption[];
  quests: QuestMenuEntry[];
}

export interface NpcTextOption {
  probability: number;
  male: string;
  female: string;
  language: number;
}

export interface NpcText {
  id: number;
  options: NpcTextOption[];
}

export interface QuestList {
  guid: bigint;
  greeting: string;
  emoteDelay: number;
  emote: number;
  quests: QuestMenuEntry[];
}

export interface QuestRewardItem {
  id: number;
  count: number;
  displayId: number;
}

export interface QuestRewards {
  choices: QuestRewardItem[];
  items: QuestRewardItem[];
  /** Positive signed RewOrReqMoney; zero when the quest charges money. */
  money: number;
  /** Cost represented by a negative signed RewOrReqMoney; never a reward. */
  requiredMoney: number;
  xpDifficulty: number;
  honor: number;
  displaySpell: number;
  spell: number;
  titleId: number;
  talents: number;
  arenaPoints: number;
}

export interface QuestDetails {
  kind: "details";
  guid: bigint;
  informGuid: bigint;
  questId: number;
  title: string;
  details: string;
  objectives: string;
  autoLaunched: boolean;
  flags: number;
  suggestedPlayers: number;
  rewards: QuestRewards;
}

export interface QuestRequestItems {
  kind: "request-items";
  guid: bigint;
  questId: number;
  title: string;
  text: string;
  flags: number;
  suggestedPlayers: number;
  requiredMoney: number;
  items: QuestRewardItem[];
  canComplete: boolean;
}

export interface QuestOfferReward {
  kind: "reward";
  guid: bigint;
  questId: number;
  title: string;
  text: string;
  autoLaunched: boolean;
  flags: number;
  suggestedPlayers: number;
  rewards: QuestRewards;
}

export type QuestDialog = QuestDetails | QuestRequestItems | QuestOfferReward;

export function buildGossipHello(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function buildGossipSelect(guid: bigint, menuId: number, optionId: number, code?: string): Uint8Array {
  const writer = new PacketWriter().u64(guid).u32(menuId).u32(optionId);
  if (code !== undefined) writer.cString(code);
  return writer.toUint8Array();
}

export function buildNpcTextQuery(textId: number, guid: bigint): Uint8Array {
  return new PacketWriter().u32(textId).u64(guid).toUint8Array();
}

export function buildQuestGiverHello(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function buildQuestQuery(guid: bigint, questId: number): Uint8Array {
  return new PacketWriter().u64(guid).u32(questId).u8(0).toUint8Array();
}

export function buildQuestAccept(guid: bigint, questId: number): Uint8Array {
  return new PacketWriter().u64(guid).u32(questId).u32(0).toUint8Array();
}

export function buildQuestAction(guid: bigint, questId: number): Uint8Array {
  return new PacketWriter().u64(guid).u32(questId).toUint8Array();
}

export function buildQuestChooseReward(guid: bigint, questId: number, choice: number): Uint8Array {
  if (!Number.isInteger(choice) || choice < 0 || choice >= 6) throw new RangeError("Quest reward choice is outside 0..5");
  return new PacketWriter().u64(guid).u32(questId).u32(choice).toUint8Array();
}

export function parseGossipMessage(payload: Uint8Array): GossipMessage {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const menuId = reader.u32();
  const textId = reader.u32();
  const optionCount = reader.u32();
  if (optionCount > 16) throw new RangeError(`Gossip option count ${optionCount} exceeds the client limit`);
  const options: GossipOption[] = [];
  for (let index = 0; index < optionCount; index++) {
    options.push({
      id: reader.u32(),
      icon: reader.u8(),
      coded: reader.u8() !== 0,
      money: reader.u32(),
      text: reader.cString(),
      boxText: reader.cString(),
    });
  }
  const questCount = reader.u32();
  if (questCount > 32) throw new RangeError(`Gossip quest count ${questCount} exceeds the client limit`);
  const quests = readQuestMenuEntries(reader, questCount);
  reader.assertFinished();
  return { guid, menuId, textId, options, quests };
}

export function parseNpcText(payload: Uint8Array): NpcText {
  const reader = new PacketReader(payload);
  const id = reader.u32();
  const options: NpcTextOption[] = [];
  for (let index = 0; index < 8; index++) {
    const option = { probability: reader.f32(), male: reader.cString(), female: reader.cString(), language: reader.u32() };
    for (let emote = 0; emote < 3; emote++) {
      reader.u32();
      reader.u32();
    }
    options.push(option);
  }
  reader.assertFinished();
  return { id, options };
}

export function parseQuestList(payload: Uint8Array): QuestList {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const greeting = reader.cString();
  const emoteDelay = reader.u32();
  const emote = reader.u32();
  const count = reader.u8();
  if (count > 32) throw new RangeError(`Quest list count ${count} exceeds the client limit`);
  const quests = readQuestMenuEntries(reader, count);
  reader.assertFinished();
  return { guid, greeting, emoteDelay, emote, quests };
}

export function parseQuestDetails(payload: Uint8Array): QuestDetails {
  const reader = new PacketReader(payload);
  const result: QuestDetails = {
    kind: "details",
    guid: reader.u64(),
    informGuid: reader.u64(),
    questId: reader.u32(),
    title: reader.cString(),
    details: reader.cString(),
    objectives: reader.cString(),
    autoLaunched: reader.u8() !== 0,
    flags: reader.u32(),
    suggestedPlayers: reader.u32(),
    rewards: emptyRewards(),
  };
  reader.u8();
  result.rewards = readQuestRewards(reader, false);
  const emoteCount = reader.i32();
  if (emoteCount < 0 || emoteCount > 4) throw new RangeError(`Quest detail emote count ${emoteCount} is invalid`);
  for (let index = 0; index < emoteCount; index++) {
    reader.u32();
    reader.u32();
  }
  reader.assertFinished();
  return result;
}

export function parseQuestRequestItems(payload: Uint8Array): QuestRequestItems {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const questId = reader.u32();
  const title = reader.cString();
  const text = reader.cString();
  reader.u32();
  reader.u32();
  reader.u32();
  const flags = reader.u32();
  const suggestedPlayers = reader.u32();
  const requiredMoney = reader.u32();
  const count = reader.u32();
  if (count > 6) throw new RangeError(`Required quest item count ${count} exceeds the client limit`);
  const items = readRewardItems(reader, count);
  const canComplete = reader.u32() !== 0;
  reader.u32();
  reader.u32();
  reader.u32();
  reader.assertFinished();
  return { kind: "request-items", guid, questId, title, text, flags, suggestedPlayers, requiredMoney, items, canComplete };
}

export function parseQuestOfferReward(payload: Uint8Array): QuestOfferReward {
  const reader = new PacketReader(payload);
  const result: QuestOfferReward = {
    kind: "reward",
    guid: reader.u64(),
    questId: reader.u32(),
    title: reader.cString(),
    text: reader.cString(),
    autoLaunched: reader.u8() !== 0,
    flags: reader.u32(),
    suggestedPlayers: reader.u32(),
    rewards: emptyRewards(),
  };
  const emoteCount = reader.u32();
  if (emoteCount > 4) throw new RangeError(`Quest reward emote count ${emoteCount} exceeds the client limit`);
  for (let index = 0; index < emoteCount; index++) {
    reader.u32();
    reader.u32();
  }
  result.rewards = readQuestRewards(reader, true);
  reader.assertFinished();
  return result;
}

function readQuestMenuEntries(reader: PacketReader, count: number): QuestMenuEntry[] {
  const quests = [];
  for (let index = 0; index < count; index++) quests.push({
    id: reader.u32(),
    icon: reader.u32(),
    level: reader.i32(),
    flags: reader.u32(),
    repeatable: reader.u8() !== 0,
    title: reader.cString(),
  });
  return quests;
}

function readRewardItems(reader: PacketReader, count: number): QuestRewardItem[] {
  const items = [];
  for (let index = 0; index < count; index++) items.push({ id: reader.u32(), count: reader.u32(), displayId: reader.u32() });
  return items;
}

function readQuestRewards(reader: PacketReader, offer: boolean): QuestRewards {
  const choiceCount = reader.u32();
  if (choiceCount > 6) throw new RangeError(`Quest reward choice count ${choiceCount} exceeds the client limit`);
  const choices = readRewardItems(reader, choiceCount);
  const itemCount = reader.u32();
  if (itemCount > 4) throw new RangeError(`Quest reward item count ${itemCount} exceeds the client limit`);
  const items = readRewardItems(reader, itemCount);
  // Quest::BuildQuestRewards writes signed RewOrReqMoney through a uint32 packet word.
  // Preserve its signed meaning before presenting it in the NPC window.
  const signedMoney = reader.i32();
  const money = Math.max(0, signedMoney);
  const requiredMoney = Math.max(0, -signedMoney);
  const xpDifficulty = reader.u32();
  const honor = reader.u32();
  reader.f32();
  if (offer) reader.u32();
  const displaySpell = reader.u32();
  const spell = reader.i32();
  const titleId = reader.u32();
  const talents = reader.u32();
  const arenaPoints = reader.u32();
  reader.u32();
  for (let index = 0; index < 5; index++) reader.u32();
  for (let index = 0; index < 5; index++) reader.i32();
  for (let index = 0; index < 5; index++) reader.i32();
  return { choices, items, money, requiredMoney, xpDifficulty, honor, displaySpell, spell, titleId, talents, arenaPoints };
}

function emptyRewards(): QuestRewards {
  return { choices: [], items: [], money: 0, requiredMoney: 0, xpDifficulty: 0, honor: 0, displaySpell: 0, spell: 0, titleId: 0, talents: 0, arenaPoints: 0 };
}
