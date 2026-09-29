import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import type { ChannelNotify } from "./ChannelProtocol.js";

// Layouts follow the active TrinityCore source: Chat.cpp `ChatHandler::BuildChatPacket` and
// ChatHandler.cpp `HandleMessagechatOpcode`.

/** `ChatMsg` in SharedDefines.h. Only the values this client acts on are named. */
export const CHAT_MSG_SYSTEM = 0x00;
export const CHAT_MSG_SAY = 0x01;
export const CHAT_MSG_PARTY = 0x02;
export const CHAT_MSG_RAID = 0x03;
export const CHAT_MSG_GUILD = 0x04;
export const CHAT_MSG_OFFICER = 0x05;
export const CHAT_MSG_YELL = 0x06;
export const CHAT_MSG_WHISPER = 0x07;
export const CHAT_MSG_WHISPER_FOREIGN = 0x08;
export const CHAT_MSG_WHISPER_INFORM = 0x09;
export const CHAT_MSG_EMOTE = 0x0a;
export const CHAT_MSG_TEXT_EMOTE = 0x0b;
export const CHAT_MSG_MONSTER_SAY = 0x0c;
export const CHAT_MSG_MONSTER_PARTY = 0x0d;
export const CHAT_MSG_MONSTER_YELL = 0x0e;
export const CHAT_MSG_MONSTER_WHISPER = 0x0f;
export const CHAT_MSG_MONSTER_EMOTE = 0x10;
export const CHAT_MSG_CHANNEL = 0x11;
/**
 * The auto-reply toggles. The only two types whose empty text means something: TrinityCore's
 * `HandleMessagechatOpcode` skips its empty-message return for them (ChatHandler.cpp:235-236) and
 * then toggles the flag off, or sets the default reply (ChatHandler.cpp:528-564).
 */
export const CHAT_MSG_AFK = 0x17;
export const CHAT_MSG_DND = 0x18;
export const CHAT_MSG_BG_SYSTEM_NEUTRAL = 0x24;
export const CHAT_MSG_BG_SYSTEM_ALLIANCE = 0x25;
export const CHAT_MSG_BG_SYSTEM_HORDE = 0x26;
export const CHAT_MSG_RAID_LEADER = 0x27;
export const CHAT_MSG_RAID_WARNING = 0x28;
export const CHAT_MSG_RAID_BOSS_EMOTE = 0x29;
export const CHAT_MSG_RAID_BOSS_WHISPER = 0x2a;
export const CHAT_MSG_BATTLEGROUND = 0x2c;
export const CHAT_MSG_BATTLENET = 0x2f;
export const CHAT_MSG_ACHIEVEMENT = 0x30;
export const CHAT_MSG_GUILD_ACHIEVEMENT = 0x31;
export const CHAT_MSG_PARTY_LEADER = 0x33;

/** Languages in SharedDefines.h. The server rejects `LANG_UNIVERSAL` from players as cheating. */
export const LANG_UNIVERSAL = 0;
export const LANG_ORCISH = 1;
export const LANG_COMMON = 7;

const ALLIANCE_RACES = new Set([1, 3, 4, 7, 11]);

/** Where the dataset's own `ChrRaces.BaseLanguage` is looked up, once the browser has learned it. */
let learnedRaceLanguage: ((race: number) => number | undefined) | undefined;

/**
 * Hands `languageForRace` the dataset's `ChrRaces.BaseLanguage` rows.
 *
 * The world layer does not fetch `/dbc/character-creation` itself; the browser learns it
 * (`UnitSnapshot.learnCreationNames`) and registers the lookup here. On this dataset all eleven
 * TSWoW races (12..21) say 7 (Common), which the compiled Alliance set below would have answered
 * as Orcish — a language those characters do not have, so the server refused their every line
 * with `LANG_NOT_LEARNED_LANGUAGE` (ChatHandler.cpp:95-112). `undefined` removes the lookup.
 */
export function useLearnedRaceLanguages(lookup: ((race: number) => number | undefined) | undefined): void {
  learnedRaceLanguage = lookup;
}

/**
 * The racial language the server expects for ordinary chat, chosen from the player's race: the
 * learned `ChrRaces.BaseLanguage` when there is one, else the stock ten races' compiled split.
 */
export function languageForRace(race: number): number {
  const learned = learnedRaceLanguage?.(race);
  if (learned !== undefined && Number.isInteger(learned) && learned > 0) return learned;
  return ALLIANCE_RACES.has(race) ? LANG_COMMON : LANG_ORCISH;
}

// These branches of BuildChatPacket write the sender name inline before the receiver GUID.
const NAMED_SENDER_TYPES = new Set([
  CHAT_MSG_MONSTER_SAY, CHAT_MSG_MONSTER_PARTY, CHAT_MSG_MONSTER_YELL, CHAT_MSG_MONSTER_WHISPER,
  CHAT_MSG_MONSTER_EMOTE, CHAT_MSG_RAID_BOSS_EMOTE, CHAT_MSG_RAID_BOSS_WHISPER, CHAT_MSG_BATTLENET,
]);
const BG_SYSTEM_TYPES = new Set([CHAT_MSG_BG_SYSTEM_NEUTRAL, CHAT_MSG_BG_SYSTEM_ALLIANCE, CHAT_MSG_BG_SYSTEM_HORDE]);
const ACHIEVEMENT_TYPES = new Set([CHAT_MSG_ACHIEVEMENT, CHAT_MSG_GUILD_ACHIEVEMENT]);

/** `HighGuid` in ObjectGuid.h lives in bits 48 to 63. */
const guidHigh = (guid: bigint): number => Number((guid >> 48n) & 0xffffn);
const isPlayerGuid = (guid: bigint): boolean => guid !== 0n && guidHigh(guid) === 0x0000;
const isPetGuid = (guid: bigint): boolean => guidHigh(guid) === 0xf140;

export interface ChatMessage {
  type: number;
  language: number;
  senderGuid: bigint;
  /** Only the monster and GM branches carry a name inline; otherwise it must be looked up. */
  senderName: string;
  receiverGuid: bigint;
  receiverName: string;
  channel: string;
  text: string;
  /** When the client saw it. Not on the wire — the server sends no timestamp with a chat line. */
  at?: number | undefined;
  /** `chatTag`: 1 AFK, 2 DND, 4 GM. */
  tag: number;
  achievementId: number;
  /**
   * Set only on the lines a text emote produced.
   *
   * The sentence is written from `EmotesText.dbc` and needs the emoter's name, which usually has
   * not been queried yet when the packet lands. Keeping the packet lets the line be written again
   * when the name arrives — the same redraw that already fixes every other line.
   */
  emote?: TextEmote | undefined;
  /**
   * Set only by `WorldClient.pushLocalMessage`: this client wrote the text itself (a slash-command
   * reply, a refusal, a «TSWoW Lua:» error line, a composed emote sentence), so a `|` in it is
   * prose rather than a WoW escape the server meant. Stock FrameXML parses every pipe, and
   * «/vehicle enter|leave|next» broke onto a new line at `|n`; the FrameXML seam doubles such pipes
   * before the line reaches Lua. Never set on a parsed packet, nor on a line pushed with
   * `{ markup: true }` (an add-on's `print`, whose markup is meant).
   */
  local?: true | undefined;
  /**
   * Set only on the line an `SMSG_CHANNEL_NOTIFY` wrote: the parsed notify, code and all. The text
   * is the native chat's sentence; stock FrameXML is told instead through its own
   * `CHAT_MSG_CHANNEL_NOTICE` / `_NOTICE_USER` / `_JOIN` / `_LEAVE` events, whose `YOU_LEFT` is the
   * only thing that takes a channel off stock ChatFrame's list (ChatFrame.lua:2714-2717).
   */
  channelNotice?: ChannelNotify | undefined;
}

export function parseChatMessage(payload: Uint8Array, gmMessage = false): ChatMessage {
  const reader = new PacketReader(payload);
  const type = reader.u8();
  const language = reader.i32();
  const senderGuid = reader.u64();
  reader.u32(); // unused flags
  let senderName = "";
  let receiverGuid = 0n;
  let receiverName = "";
  let channel = "";

  if (NAMED_SENDER_TYPES.has(type)) {
    reader.u32();
    senderName = reader.cString();
    receiverGuid = reader.u64();
    if (receiverGuid !== 0n && !isPlayerGuid(receiverGuid) && !isPetGuid(receiverGuid)) {
      reader.u32();
      receiverName = reader.cString();
    }
  } else if (type === CHAT_MSG_WHISPER_FOREIGN) {
    reader.u32();
    senderName = reader.cString();
    receiverGuid = reader.u64();
  } else if (BG_SYSTEM_TYPES.has(type)) {
    receiverGuid = reader.u64();
    if (receiverGuid !== 0n && !isPlayerGuid(receiverGuid)) {
      reader.u32();
      receiverName = reader.cString();
    }
  } else if (ACHIEVEMENT_TYPES.has(type)) {
    receiverGuid = reader.u64();
  } else {
    if (gmMessage) {
      reader.u32();
      senderName = reader.cString();
    }
    // The channel name is written bare here, without the usual length prefix.
    if (type === CHAT_MSG_CHANNEL) channel = reader.cString();
    receiverGuid = reader.u64();
  }

  reader.u32();
  const text = reader.cString();
  const tag = reader.u8();
  const achievementId = ACHIEVEMENT_TYPES.has(type) && reader.remaining >= 4 ? reader.u32() : 0;
  return { type, language, senderGuid, senderName, receiverGuid, receiverName, channel, text, tag, achievementId };
}

/** `SMSG_EMOTE`: an animation played by a unit, without any text. */
export function parseEmote(payload: Uint8Array): { emoteId: number; guid: bigint } {
  const reader = new PacketReader(payload);
  const emoteId = reader.u32();
  const guid = reader.u64();
  reader.assertFinished();
  return { emoteId, guid };
}

export interface TextEmote {
  guid: bigint;
  textEmoteId: number;
  emoteNumber: number;
  targetName: string;
}

/** `SMSG_TEXT_EMOTE`: the "/wave" style emotes that produce a sentence. */
export function parseTextEmote(payload: Uint8Array): TextEmote {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const textEmoteId = reader.u32();
  const emoteNumber = reader.u32();
  // A name length follows; the server writes a lone zero byte when there is no target.
  reader.u32();
  const targetName = reader.remaining > 0 ? reader.cString() : "";
  return { guid, textEmoteId, emoteNumber, targetName };
}

/**
 * `CMSG_MESSAGECHAT`. The extra name is only written for whispers and channel messages, exactly
 * as `HandleMessagechatOpcode` reads it.
 */
export function buildChatMessage(type: number, language: number, text: string, target = ""): Uint8Array {
  const writer = new PacketWriter().u32(type).u32(language);
  if (type === CHAT_MSG_WHISPER || type === CHAT_MSG_CHANNEL) writer.cString(target);
  return writer.cString(text).toUint8Array();
}

/**
 * `CMSG_TEXT_EMOTE`: the only way to say `/dance`.
 *
 * `CMSG_EMOTE` looks like the obvious opcode and is not: `HandleEmoteOpcode` accepts nothing but
 * `ONESHOT_NONE` and `ONESHOT_WAVE` and drops everything else. The guid here is raw, not packed —
 * `ChatHandler.cpp` reads it through `ObjectGuid::operator>>`, which is a plain `read<uint64>`.
 */
export function buildTextEmote(textEmoteId: number, emoteNumber: number, target: bigint): Uint8Array {
  return new PacketWriter().u32(textEmoteId).u32(emoteNumber).u64(target).toUint8Array();
}

export function buildJoinChannel(channelId: number, name: string, password = ""): Uint8Array {
  return new PacketWriter().u32(channelId).u8(0).u8(0).cString(name).cString(password).toUint8Array();
}

export function buildLeaveChannel(channelId: number, name: string): Uint8Array {
  return new PacketWriter().u32(channelId).cString(name).toUint8Array();
}

// Every type the parser can produce has a label. The gaps used to print «тип 41» in grey for boss
// emotes, battleground announcements and guild achievements — the loudest lines in the game.
const TYPE_LABELS: Record<number, string> = {
  [CHAT_MSG_SYSTEM]: "Система",
  [CHAT_MSG_SAY]: "говорит",
  [CHAT_MSG_PARTY]: "Группа",
  [CHAT_MSG_PARTY_LEADER]: "Лидер группы",
  [CHAT_MSG_MONSTER_PARTY]: "Группа",
  [CHAT_MSG_RAID]: "Рейд",
  [CHAT_MSG_RAID_LEADER]: "Лидер рейда",
  [CHAT_MSG_RAID_WARNING]: "Предупреждение рейда",
  [CHAT_MSG_GUILD]: "Гильдия",
  [CHAT_MSG_OFFICER]: "Офицеры",
  [CHAT_MSG_YELL]: "кричит",
  [CHAT_MSG_WHISPER]: "шепчет",
  [CHAT_MSG_WHISPER_FOREIGN]: "шепчет",
  [CHAT_MSG_WHISPER_INFORM]: "вы шепчете",
  [CHAT_MSG_EMOTE]: "",
  [CHAT_MSG_TEXT_EMOTE]: "",
  [CHAT_MSG_MONSTER_SAY]: "говорит",
  [CHAT_MSG_MONSTER_YELL]: "кричит",
  [CHAT_MSG_MONSTER_WHISPER]: "шепчет",
  [CHAT_MSG_MONSTER_EMOTE]: "",
  [CHAT_MSG_RAID_BOSS_EMOTE]: "",
  [CHAT_MSG_RAID_BOSS_WHISPER]: "шепчет",
  [CHAT_MSG_BG_SYSTEM_NEUTRAL]: "Поле боя",
  [CHAT_MSG_BG_SYSTEM_ALLIANCE]: "Поле боя",
  [CHAT_MSG_BG_SYSTEM_HORDE]: "Поле боя",
  [CHAT_MSG_BATTLEGROUND]: "Поле боя",
  [CHAT_MSG_BATTLENET]: "Battle.net",
  [CHAT_MSG_ACHIEVEMENT]: "Достижение",
  [CHAT_MSG_GUILD_ACHIEVEMENT]: "Достижение гильдии",
  [CHAT_MSG_CHANNEL]: "Канал",
};

export function chatTypeLabel(type: number): string {
  return TYPE_LABELS[type] ?? `тип ${type}`;
}
