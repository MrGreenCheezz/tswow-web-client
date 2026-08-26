import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: SocialMgr.cpp (`PlayerSocial::SendSocialList`,
// `SocialMgr::SendFriendStatus`), MiscHandler.cpp (`HandleWhoOpcode`, `HandleWhoIsOpcode`),
// SocialHandler.cpp for what the client sends, and MailPackets.cpp
// `MailQueryNextTimeResult::Write`.

/** `SocialFlag` in SocialMgr.h. The list the server sends is filtered against these. */
export const SOCIAL_FLAG_FRIEND = 0x01;
export const SOCIAL_FLAG_IGNORED = 0x02;
export const SOCIAL_FLAG_MUTED = 0x04;
export const SOCIAL_FLAG_ALL = 0x07;

/** `FriendStatus` in SocialMgr.h. Zero is offline, and only a non-zero status carries a tail. */
export const FRIEND_STATUS_OFFLINE = 0x00;
export const FRIEND_STATUS_ONLINE = 0x01;
export const FRIEND_STATUS_AFK = 0x02;
export const FRIEND_STATUS_DND = 0x04;
export const FRIEND_STATUS_RAF = 0x08;

/** `FriendsResult` in SocialMgr.h — the codes whose shape differs are the ones that matter. */
export const FRIEND_ONLINE = 0x02;
export const FRIEND_OFFLINE = 0x03;
export const FRIEND_NOT_FOUND = 0x04;
export const FRIEND_REMOVED = 0x05;
export const FRIEND_ADDED_ONLINE = 0x06;
export const FRIEND_ADDED_OFFLINE = 0x07;
export const FRIEND_IGNORE_ADDED = 0x0f;
export const FRIEND_IGNORE_REMOVED = 0x10;

export interface Contact {
  guid: bigint;
  /** Widened from the byte it is stored as. A contact can be a friend and ignored at once. */
  flags: number;
  note: string;
  /** Only friends carry one. A pure ignore stops after the note. */
  status: number;
  areaId: number;
  level: number;
  classId: number;
}

export interface ContactList {
  /** Echoed from the request, so it is whatever the client asked for and not always all three. */
  flags: number;
  contacts: Contact[];
}

/**
 * Three possible entry shapes, and which one is used is decided per entry rather than per packet:
 * every entry carries a guid, its flags and a note; only a friend adds a status byte; and only a
 * friend who is visibly online adds the zone, level and class after it. A friend the viewer may
 * not see across factions is online with status zero, so the tail is dropped and the entry is
 * short — the flags and the status together are the only guide through the list.
 */
export function parseContactList(payload: Uint8Array): ContactList {
  const reader = new PacketReader(payload);
  const flags = reader.u32();
  const count = reader.u32();
  if (count > 500) throw new RangeError(`Contact list declares ${count} entries`);
  const contacts: Contact[] = [];
  for (let index = 0; index < count; index++) {
    const guid = reader.u64();
    const contactFlags = reader.u32();
    const note = reader.cString();
    const contact: Contact = {
      guid, flags: contactFlags, note, status: FRIEND_STATUS_OFFLINE, areaId: 0, level: 0, classId: 0,
    };
    if (contactFlags & SOCIAL_FLAG_FRIEND) {
      contact.status = reader.u8();
      if (contact.status !== FRIEND_STATUS_OFFLINE) {
        contact.areaId = reader.u32();
        contact.level = reader.u32();
        contact.classId = reader.u32();
      }
    }
    contacts.push(contact);
  }
  reader.assertFinished();
  return { flags, contacts };
}

export interface FriendStatus {
  result: number;
  guid: bigint;
  note: string;
  status: number;
  areaId: number;
  level: number;
  classId: number;
}

/**
 * Two independent tests over the same code, in this order: the note is written for the two "added"
 * codes, and the online block for "added online" and "online". So adding an online friend carries
 * both, adding an offline one carries only the note, a friend coming online carries only the
 * block, and every other code is nine bytes.
 */
export function parseFriendStatus(payload: Uint8Array): FriendStatus {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  const guid = reader.u64();
  const status: FriendStatus = {
    result, guid, note: "", status: FRIEND_STATUS_OFFLINE, areaId: 0, level: 0, classId: 0,
  };
  if (result === FRIEND_ADDED_OFFLINE || result === FRIEND_ADDED_ONLINE) status.note = reader.cString();
  if (result === FRIEND_ADDED_ONLINE || result === FRIEND_ONLINE) {
    status.status = reader.u8();
    status.areaId = reader.u32();
    status.level = reader.u32();
    status.classId = reader.u32();
  }
  reader.assertFinished();
  return status;
}

export interface WhoEntry {
  name: string;
  guild: string;
  level: number;
  classId: number;
  race: number;
  /** The one narrow field in a row of widened ones. */
  gender: number;
  zoneId: number;
}

export interface WhoResult {
  /** How many rows follow. */
  displayed: number;
  /** How many passed the filters, including those the row cap dropped. */
  matched: number;
  entries: WhoEntry[];
}

/**
 * No guids at all: the client matches a row by name. The two counts are placeholders the server
 * overwrites, and it writes the displayed count into the first slot and the match count into the
 * second — the reverse of the order the two variables are written in, which is what makes
 * "showing 49 of 300" work.
 */
export function parseWho(payload: Uint8Array): WhoResult {
  const reader = new PacketReader(payload);
  const displayed = reader.u32();
  const matched = reader.u32();
  if (displayed > 1000) throw new RangeError(`Who result declares ${displayed} rows`);
  const entries: WhoEntry[] = [];
  for (let index = 0; index < displayed; index++) {
    entries.push({
      name: reader.cString(),
      guild: reader.cString(),
      level: reader.u32(),
      classId: reader.u32(),
      race: reader.u32(),
      gender: reader.u8(),
      zoneId: reader.u32(),
    });
  }
  reader.assertFinished();
  return { displayed, matched, entries };
}

/** One sentence the server has already formatted. There is no structure to read out of it. */
export function parseWhois(payload: Uint8Array): string {
  const reader = new PacketReader(payload);
  const text = reader.cString();
  reader.assertFinished();
  return text;
}

/** `MailMessageType` in Mail.h, as the pending-mail list reports it. */
export const MAIL_SENDER_PLAYER = 0;

export interface PendingMailSender {
  /** Set only for player mail; auctions and creatures leave it empty and use the id below. */
  senderGuid: bigint;
  /** The raw low id, for everything that is not a player. */
  altSenderId: number;
  altSenderType: number;
  stationeryId: number;
  /** Seconds until it lands, and negative once it has. */
  timeLeft: number;
}

export interface NextMailTime {
  /**
   * Zero when something unread is waiting, and minus one day when nothing is. The two are told
   * apart by this float and not by the length: the "waiting" answer can still list nobody, when
   * every unread letter is still in the post.
   */
  nextMailTime: number;
  senders: PendingMailSender[];
}

/** At most three senders: the core breaks out once the set of distinct senders passes two. */
export function parseNextMailTime(payload: Uint8Array): NextMailTime {
  const reader = new PacketReader(payload);
  const nextMailTime = reader.f32();
  const count = reader.i32();
  if (count < 0 || count > 16) throw new RangeError(`Mail time declares ${count} senders`);
  const senders: PendingMailSender[] = [];
  for (let index = 0; index < count; index++) {
    senders.push({
      senderGuid: reader.u64(),
      altSenderId: reader.i32(),
      altSenderType: reader.i32(),
      stationeryId: reader.i32(),
      // Written last even though the struct declares it second.
      timeLeft: reader.f32(),
    });
  }
  reader.assertFinished();
  return { nextMailTime, senders };
}

/** The client picks which lists it wants; the server echoes the mask back and filters by it. */
export function buildContactListQuery(flags = SOCIAL_FLAG_ALL): Uint8Array {
  return new PacketWriter().u32(flags).toUint8Array();
}

export function buildAddFriend(name: string, note = ""): Uint8Array {
  return new PacketWriter().cString(name).cString(note).toUint8Array();
}

export function buildDeleteFriend(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function buildAddIgnore(name: string): Uint8Array {
  return new PacketWriter().cString(name).toUint8Array();
}

export function buildDeleteIgnore(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export interface WhoRequest {
  levelMin?: number;
  levelMax?: number;
  name?: string;
  guild?: string;
  raceMask?: number;
  classMask?: number;
  /** The client is limited to ten zones and four free-text words; the server refuses more. */
  zones?: number[];
  words?: string[];
}

export function buildWhoQuery(request: WhoRequest = {}): Uint8Array {
  const zones = request.zones ?? [];
  const words = request.words ?? [];
  if (zones.length > 10) throw new RangeError("A /who query carries at most ten zones");
  if (words.length > 4) throw new RangeError("A /who query carries at most four words");
  const writer = new PacketWriter()
    .u32(request.levelMin ?? 1)
    .u32(request.levelMax ?? 80)
    .cString(request.name ?? "")
    .cString(request.guild ?? "")
    .u32(request.raceMask ?? 0xffffffff)
    .u32(request.classMask ?? 0xffffffff)
    .u32(zones.length);
  for (const zone of zones) writer.u32(zone);
  writer.u32(words.length);
  for (const word of words) writer.cString(word);
  return writer.toUint8Array();
}

export function buildWhoIs(name: string): Uint8Array {
  return new PacketWriter().cString(name).toUint8Array();
}

/** The mail-time question has no body at all; the answer is the server's own. */
export function buildNextMailTimeQuery(): Uint8Array {
  return new Uint8Array(0);
}

// `FriendsResult` in SocialMgr.h. Only the codes the client can provoke are worded.
const FRIEND_RESULTS: Record<number, string> = {
  0x00: "Ошибка базы данных",
  0x01: "Список друзей заполнен",
  0x04: "Игрок не найден",
  0x05: "Удалён из друзей",
  0x08: "Уже в списке друзей",
  0x09: "Нельзя добавить себя",
  0x0a: "Игрок из другой фракции",
  0x0b: "Список игнорируемых заполнен",
  0x0c: "Нельзя игнорировать себя",
  0x0d: "Игрок не найден",
  0x0e: "Уже в списке игнорируемых",
  0x0f: "Добавлен в игнорируемые",
  0x10: "Убран из игнорируемых",
  0x11: "Имя неоднозначно",
  0x18: "Имя неоднозначно",
};

export function friendResultText(result: number, name: string): string {
  const text = FRIEND_RESULTS[result];
  if (!text) {
    if (result === FRIEND_ONLINE) return name ? `${name} в сети` : "Друг в сети";
    if (result === FRIEND_OFFLINE) return name ? `${name} не в сети` : "Друг не в сети";
    if (result === FRIEND_ADDED_ONLINE || result === FRIEND_ADDED_OFFLINE) {
      return name ? `${name} добавлен в друзья` : "Добавлен в друзья";
    }
    return `Список друзей: код ${result}`;
  }
  return name ? `${name}: ${text}` : text;
}
