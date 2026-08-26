import { PacketReader } from "../protocol/PacketReader.js";

// Layouts follow the active TrinityCore source: Channel.cpp (`List`, `JoinNotify`, `LeaveNotify`),
// ChannelAppenders.h for every notify body, ChannelHandler.cpp (`HandleGetChannelMemberCount`, the
// invalid-name reply), ChannelMgr.cpp `MakeNotOnPacket`, ChatHandler.cpp for the four chat refusals
// and MiscHandler.cpp `HandleComplainOpcode`.
//
// Every guid in this family is a bare eight bytes; the packed form appears nowhere in it.

/** `ChannelFlags` in Channel.h — what kind of channel this is. */
export const CHANNEL_FLAG_CUSTOM = 0x01;
export const CHANNEL_FLAG_TRADE = 0x04;
export const CHANNEL_FLAG_NOT_LFG = 0x08;
export const CHANNEL_FLAG_GENERAL = 0x10;
export const CHANNEL_FLAG_CITY = 0x20;
export const CHANNEL_FLAG_LFG = 0x40;

/** `ChannelMemberFlags` in Channel.h — what one member is inside it. */
export const CHANNEL_MEMBER_OWNER = 0x01;
export const CHANNEL_MEMBER_MODERATOR = 0x02;
export const CHANNEL_MEMBER_VOICED = 0x04;
export const CHANNEL_MEMBER_MUTED = 0x08;

/** `ChatNotify` in Channel.h. Only the codes this build can actually emit are named. */
export const CHAT_JOINED_NOTICE = 0x00;
export const CHAT_LEFT_NOTICE = 0x01;
export const CHAT_YOU_JOINED_NOTICE = 0x02;
export const CHAT_YOU_LEFT_NOTICE = 0x03;
export const CHAT_WRONG_PASSWORD_NOTICE = 0x04;
export const CHAT_NOT_MEMBER_NOTICE = 0x05;
export const CHAT_NOT_MODERATOR_NOTICE = 0x06;
export const CHAT_PASSWORD_CHANGED_NOTICE = 0x07;
export const CHAT_OWNER_CHANGED_NOTICE = 0x08;
export const CHAT_PLAYER_NOT_FOUND_NOTICE = 0x09;
export const CHAT_NOT_OWNER_NOTICE = 0x0a;
export const CHAT_CHANNEL_OWNER_NOTICE = 0x0b;
export const CHAT_MODE_CHANGE_NOTICE = 0x0c;
export const CHAT_ANNOUNCEMENTS_ON_NOTICE = 0x0d;
export const CHAT_ANNOUNCEMENTS_OFF_NOTICE = 0x0e;
export const CHAT_MUTED_NOTICE = 0x11;
export const CHAT_PLAYER_KICKED_NOTICE = 0x12;
export const CHAT_BANNED_NOTICE = 0x13;
export const CHAT_PLAYER_BANNED_NOTICE = 0x14;
export const CHAT_PLAYER_UNBANNED_NOTICE = 0x15;
export const CHAT_PLAYER_NOT_BANNED_NOTICE = 0x16;
export const CHAT_PLAYER_ALREADY_MEMBER_NOTICE = 0x17;
export const CHAT_INVITE_NOTICE = 0x18;
export const CHAT_INVITE_WRONG_FACTION_NOTICE = 0x19;
export const CHAT_WRONG_FACTION_NOTICE = 0x1a;
export const CHAT_INVALID_NAME_NOTICE = 0x1b;
export const CHAT_NOT_MODERATED_NOTICE = 0x1c;
export const CHAT_PLAYER_INVITED_NOTICE = 0x1d;
export const CHAT_PLAYER_INVITE_BANNED_NOTICE = 0x1e;
export const CHAT_THROTTLED_NOTICE = 0x1f;
export const CHAT_NOT_IN_AREA_NOTICE = 0x20;
export const CHAT_NOT_IN_LFG_NOTICE = 0x21;

/**
 * What each notify code appends after the shared code-and-name header. There is no length, no
 * count and no terminator: the code alone says how many bytes follow, which is why this table is
 * the packet's only structure.
 */
type NotifyShape = "none" | "guid" | "twoGuids" | "name" | "youJoined" | "youLeft" | "modeChange";

const NOTIFY_SHAPES = new Map<number, NotifyShape>([
  [CHAT_JOINED_NOTICE, "guid"],
  [CHAT_LEFT_NOTICE, "guid"],
  [CHAT_YOU_JOINED_NOTICE, "youJoined"],
  [CHAT_YOU_LEFT_NOTICE, "youLeft"],
  [CHAT_PASSWORD_CHANGED_NOTICE, "guid"],
  [CHAT_OWNER_CHANGED_NOTICE, "guid"],
  [CHAT_PLAYER_NOT_FOUND_NOTICE, "name"],
  [CHAT_CHANNEL_OWNER_NOTICE, "name"],
  [CHAT_MODE_CHANGE_NOTICE, "modeChange"],
  [CHAT_ANNOUNCEMENTS_ON_NOTICE, "guid"],
  [CHAT_ANNOUNCEMENTS_OFF_NOTICE, "guid"],
  [CHAT_PLAYER_KICKED_NOTICE, "twoGuids"],
  [CHAT_PLAYER_BANNED_NOTICE, "twoGuids"],
  [CHAT_PLAYER_UNBANNED_NOTICE, "twoGuids"],
  [CHAT_PLAYER_NOT_BANNED_NOTICE, "name"],
  [CHAT_PLAYER_ALREADY_MEMBER_NOTICE, "guid"],
  [CHAT_INVITE_NOTICE, "guid"],
  [CHAT_PLAYER_INVITED_NOTICE, "name"],
  [CHAT_PLAYER_INVITE_BANNED_NOTICE, "name"],
]);

export interface ChannelNotify {
  code: number;
  /** The channel this is about, already localised by the server for the receiving session. */
  channel: string;
  /** The subject: whoever joined, left, was kicked, was banned. Zero when the code carries none. */
  guid: bigint;
  /** The other party: the kicker, the moderator who banned. Zero otherwise. */
  actorGuid: bigint;
  /** A name typed rather than resolved, on the codes that answer with one. */
  name: string;
  channelFlags: number;
  channelId: number;
  /** Set by the "you left" code: whether the channel is one of the built-in ones. */
  constantChannel: boolean;
  oldMemberFlags: number;
  newMemberFlags: number;
}

/**
 * The two codes that describe the channel itself write their fields in opposite orders — joining
 * puts the flags first and leaving puts the id first — so neither can be read with the other's
 * layout.
 *
 * An unknown code is not an error: the enum runs 0x00 to 0x23 without gaps — thirty-six codes —
 * this build reaches far fewer, and a code with no body is the commonest shape of all.
 */
export function parseChannelNotify(payload: Uint8Array): ChannelNotify {
  const reader = new PacketReader(payload);
  const code = reader.u8();
  const channel = reader.cString();
  const notify: ChannelNotify = {
    code, channel, guid: 0n, actorGuid: 0n, name: "", channelFlags: 0, channelId: 0,
    constantChannel: false, oldMemberFlags: 0, newMemberFlags: 0,
  };
  switch (NOTIFY_SHAPES.get(code) ?? "none") {
    case "guid":
      notify.guid = reader.u64();
      break;
    case "twoGuids":
      // The subject comes first and the moderator second, the reverse of how the core builds them.
      notify.guid = reader.u64();
      notify.actorGuid = reader.u64();
      break;
    case "name":
      notify.name = reader.cString();
      break;
    case "youJoined":
      notify.channelFlags = reader.u8();
      notify.channelId = reader.u32();
      reader.u32();
      break;
    case "youLeft":
      notify.channelId = reader.u32();
      notify.constantChannel = reader.u8() !== 0;
      break;
    case "modeChange":
      notify.guid = reader.u64();
      notify.oldMemberFlags = reader.u8();
      notify.newMemberFlags = reader.u8();
      break;
    default:
      break;
  }
  return notify;
}

export interface ChannelMember {
  guid: bigint;
  flags: number;
}

export interface ChannelList {
  channel: string;
  channelFlags: number;
  members: ChannelMember[];
}

/**
 * The leading byte is a hardcoded one, not the flags and not an id; taking it for either shifts
 * the whole packet. The member count is what the server actually wrote, and it can be far smaller
 * than the channel's real population — anyone the asking player may not see is left out silently.
 */
export function parseChannelList(payload: Uint8Array): ChannelList {
  const reader = new PacketReader(payload);
  reader.u8();
  const channel = reader.cString();
  const channelFlags = reader.u8();
  const count = reader.u32();
  if (count > 20000) throw new RangeError(`Channel list declares ${count} members`);
  const members: ChannelMember[] = [];
  for (let index = 0; index < count; index++) members.push({ guid: reader.u64(), flags: reader.u8() });
  reader.assertFinished();
  return { channel, channelFlags, members };
}

export interface ChannelMemberCount {
  channel: string;
  channelFlags: number;
  /** Unfiltered, unlike the roster: this counts everyone in the channel. */
  count: number;
}

/** Name first here, with no leading byte at all — the opposite of the roster's header. */
export function parseChannelMemberCount(payload: Uint8Array): ChannelMemberCount {
  const reader = new PacketReader(payload);
  const channel = reader.cString();
  const channelFlags = reader.u8();
  const count = reader.u32();
  reader.assertFinished();
  return { channel, channelFlags, count };
}

export interface ChannelUserChange {
  guid: bigint;
  /** Zero on a join, because the server grants owner and moderator afterwards and says so later. */
  memberFlags: number;
  channelFlags: number;
  /** Includes the joiner on an add, and excludes the leaver on a remove. */
  count: number;
  channel: string;
}

/**
 * `SMSG_USERLIST_ADD` and `SMSG_USERLIST_UPDATE` share one builder — the opcode only says whether
 * the channel is built-in or custom. `SMSG_USERLIST_REMOVE` is a byte shorter: it has no member
 * flags, so reusing the add layout reads the channel flags as member flags and then loses the
 * count and the name.
 */
export function parseUserlistChange(payload: Uint8Array, removal: boolean): ChannelUserChange {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const memberFlags = removal ? 0 : reader.u8();
  const channelFlags = reader.u8();
  const count = reader.u32();
  const channel = reader.cString();
  reader.assertFinished();
  return { guid, memberFlags, channelFlags, count, channel };
}

/** `SMSG_CHAT_PLAYER_NOT_FOUND` and `SMSG_CHAT_PLAYER_AMBIGUOUS` are each one name and nothing else. */
export function parseChatPlayerName(payload: Uint8Array): string {
  const reader = new PacketReader(payload);
  const name = reader.cString();
  reader.assertFinished();
  return name;
}

/** `ChatRestrictionType` in WorldSession.h, narrowed to one byte on the wire. */
export const CHAT_RESTRICTED = 0;
export const CHAT_THROTTLED = 1;
export const CHAT_SQUELCHED = 2;
export const CHAT_YELL_RESTRICTED = 3;

export function parseChatRestricted(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const restriction = reader.u8();
  reader.assertFinished();
  return restriction;
}

/** The report acknowledgement is one byte and the core hardcodes it to zero. */
export function parseComplainResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  reader.assertFinished();
  return result;
}

const RESTRICTION_TEXT: Record<number, string> = {
  0: "Чат для вас ограничен",
  1: "Слишком часто — подождите",
  2: "Вам запрещено говорить",
  3: "Кричать здесь нельзя",
};

export function chatRestrictedText(restriction: number): string {
  return RESTRICTION_TEXT[restriction] ?? `Чат ограничен (код ${restriction})`;
}

const NOTIFY_TEXT: Record<number, string> = {
  [CHAT_YOU_JOINED_NOTICE]: "Вы вошли в канал",
  [CHAT_YOU_LEFT_NOTICE]: "Вы покинули канал",
  [CHAT_WRONG_PASSWORD_NOTICE]: "Неверный пароль",
  [CHAT_NOT_MEMBER_NOTICE]: "Вы не в этом канале",
  [CHAT_NOT_MODERATOR_NOTICE]: "Вы не модератор",
  [CHAT_PASSWORD_CHANGED_NOTICE]: "Пароль изменён",
  [CHAT_OWNER_CHANGED_NOTICE]: "Сменился владелец",
  [CHAT_NOT_OWNER_NOTICE]: "Вы не владелец канала",
  [CHAT_MUTED_NOTICE]: "Вам запрещено писать в этом канале",
  [CHAT_BANNED_NOTICE]: "Вы забанены в этом канале",
  [CHAT_INVITE_WRONG_FACTION_NOTICE]: "Игрок из другой фракции",
  [CHAT_WRONG_FACTION_NOTICE]: "Канал другой фракции",
  [CHAT_INVALID_NAME_NOTICE]: "Недопустимое название канала",
  [CHAT_NOT_MODERATED_NOTICE]: "Канал без модерации",
  [CHAT_THROTTLED_NOTICE]: "Слишком часто",
  [CHAT_NOT_IN_AREA_NOTICE]: "Вы не в той зоне для этого канала",
  [CHAT_NOT_IN_LFG_NOTICE]: "Вы не в поиске группы",
};

/** One line for the chat log. Codes that name somebody are worded by the caller, which has names. */
export function channelNotifyText(notify: ChannelNotify): string {
  const known = NOTIFY_TEXT[notify.code];
  if (known) return `[${notify.channel}] ${known}`;
  switch (notify.code) {
    case CHAT_JOINED_NOTICE: return `[${notify.channel}] вошёл в канал`;
    case CHAT_LEFT_NOTICE: return `[${notify.channel}] покинул канал`;
    case CHAT_CHANNEL_OWNER_NOTICE: return `[${notify.channel}] владелец: ${notify.name || "никто"}`;
    case CHAT_PLAYER_NOT_FOUND_NOTICE: return `[${notify.channel}] игрок ${notify.name} не найден`;
    case CHAT_PLAYER_INVITED_NOTICE: return `[${notify.channel}] приглашён ${notify.name}`;
    case CHAT_PLAYER_INVITE_BANNED_NOTICE: return `[${notify.channel}] ${notify.name} забанен`;
    case CHAT_PLAYER_NOT_BANNED_NOTICE: return `[${notify.channel}] ${notify.name} не забанен`;
    case CHAT_PLAYER_KICKED_NOTICE: return `[${notify.channel}] игрок исключён`;
    case CHAT_PLAYER_BANNED_NOTICE: return `[${notify.channel}] игрок забанен`;
    case CHAT_PLAYER_UNBANNED_NOTICE: return `[${notify.channel}] игрок разбанен`;
    case CHAT_PLAYER_ALREADY_MEMBER_NOTICE: return `[${notify.channel}] игрок уже в канале`;
    case CHAT_INVITE_NOTICE: return `[${notify.channel}] вас приглашают в канал`;
    case CHAT_MODE_CHANGE_NOTICE: return `[${notify.channel}] права участника изменены`;
    case CHAT_ANNOUNCEMENTS_ON_NOTICE: return `[${notify.channel}] объявления включены`;
    case CHAT_ANNOUNCEMENTS_OFF_NOTICE: return `[${notify.channel}] объявления выключены`;
    default: return `[${notify.channel}] сообщение канала (код ${notify.code})`;
  }
}
