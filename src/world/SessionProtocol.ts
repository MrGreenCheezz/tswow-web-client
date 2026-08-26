import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: WorldSession.cpp (`SendAccountDataTimes`,
// `SendTutorialsData`, `SendNotification`, `ReadAddonsInfo`, `SendAddonsInfo`), MiscHandler.cpp
// (`HandleUpdateAccountData`, `HandleRequestAccountData`, `HandleRealmSplitOpcode`,
// `HandleReadyForAccountDataTimes`), QueryHandler.cpp `SendQueryTimeResponse`, AuthHandler.cpp
// `SendClientCacheVersion`, SystemPackets.cpp `FeatureSystemStatus::Write`, ChatPackets.cpp
// `ChatServerMessage::Write`, CharacterPackets.cpp `LogoutResponse::Write`, ServerMotd.cpp
// `Motd::SetMotd`, CharacterHandler.cpp `SendSetPlayerDeclinedNamesResult` and Warden.cpp.

/** `NUM_ACCOUNT_DATA_TYPES` in WorldSession.h. */
export const NUM_ACCOUNT_DATA_TYPES = 8;
/** `MAX_ACCOUNT_TUTORIAL_VALUES` in Common.h: eight words, 32 tutorial bits each. */
export const MAX_ACCOUNT_TUTORIAL_VALUES = 8;

/** `AccountDataType` in WorldSession.h. Which of the eight blobs the server is holding. */
export const GLOBAL_CONFIG_CACHE = 0;
export const PER_CHARACTER_CONFIG_CACHE = 1;
export const GLOBAL_BINDINGS_CACHE = 2;
export const PER_CHARACTER_BINDINGS_CACHE = 3;
export const GLOBAL_MACROS_CACHE = 4;
export const PER_CHARACTER_MACROS_CACHE = 5;
export const PER_CHARACTER_LAYOUT_CACHE = 6;
export const PER_CHARACTER_CHAT_CACHE = 7;

/**
 * `GLOBAL_CACHE_MASK` and `PER_CHARACTER_CACHE_MASK` in WorldSession.h.
 *
 * Which mask arrives says where in the session this packet is: the global one comes at
 * authentication, before there is a character, and the per-character one at world entry.
 */
export const GLOBAL_CACHE_MASK = 0x15;
export const PER_CHARACTER_CACHE_MASK = 0xea;

export interface AccountDataTimes {
  /** The server's clock in unix seconds at the moment the packet was built. */
  serverTime: number;
  mask: number;
  /** Last-modified stamp per data type, only for the types the mask names. */
  times: Map<number, number>;
}

/**
 * When each of the eight saved blobs last changed.
 *
 * The list is as long as the mask has bits and no longer — there is no count — so a reader that
 * expects eight words reads the packet after this one. The byte between the clock and the mask is
 * a literal 1 the core never varies.
 */
export function parseAccountDataTimes(payload: Uint8Array): AccountDataTimes {
  const reader = new PacketReader(payload);
  const serverTime = reader.u32();
  reader.u8();
  const mask = reader.u32();
  const times = new Map<number, number>();
  for (let type = 0; type < NUM_ACCOUNT_DATA_TYPES; type++) {
    if (mask & (1 << type)) times.set(type, reader.u32());
  }
  reader.assertFinished();
  return { serverTime, mask, times };
}

export interface AccountDataBlob {
  /** Zero when the packet answered a request made before a character was in the world. */
  guid: bigint;
  type: number;
  /** Unix seconds, as the client itself last stamped it. */
  time: number;
  /** What the blob expands to. Zero means the server holds nothing for this type. */
  decompressedSize: number;
  /** Still zlib-compressed: the caller inflates it, because inflating is asynchronous here. */
  compressed: Uint8Array;
}

/**
 * One of the eight blobs coming back: macros, bindings, the chat layout, the interface config.
 *
 * The size on the wire is the *decompressed* size and the rest of the packet is deflate, so
 * nothing here can be read without inflating it — which is why the bytes are handed on rather than
 * expanded in place. An empty blob still arrives, compressed: `compress()` of nothing is not
 * nothing, it is an eight-byte empty zlib stream.
 */
export function parseUpdateAccountData(payload: Uint8Array): AccountDataBlob {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const type = reader.u32();
  const time = reader.u32();
  const decompressedSize = reader.u32();
  const compressed = reader.bytes(reader.remaining);
  return { guid, type, time, decompressedSize, compressed };
}

/** The server stored what was sent. The second word is a literal zero, not a result code. */
export function parseUpdateAccountDataComplete(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const type = reader.u32();
  reader.u32();
  reader.assertFinished();
  return type;
}

/**
 * The eight tutorial words, 256 bits of "has this tip been shown".
 *
 * No count and no mask: the length is the definition, and it is fixed at eight.
 */
export function parseTutorialFlags(payload: Uint8Array): number[] {
  const reader = new PacketReader(payload);
  const flags: number[] = [];
  for (let index = 0; index < MAX_ACCOUNT_TUTORIAL_VALUES; index++) flags.push(reader.u32());
  reader.assertFinished();
  return flags;
}

/** Whether tutorial `index` (0 to 255) has been seen. Thirty-two per word, low bit first. */
export function isTutorialSeen(flags: readonly number[], index: number): boolean {
  const word = flags[index >>> 5] ?? 0;
  return (word & (1 << (index & 31))) !== 0;
}

export interface FeatureSystemStatus {
  /** `ComplaintStatus` in SharedDefines.h: whether the client offers a report button. */
  complaintStatus: number;
  voiceEnabled: boolean;
}

export function parseFeatureSystemStatus(payload: Uint8Array): FeatureSystemStatus {
  const reader = new PacketReader(payload);
  const status: FeatureSystemStatus = { complaintStatus: reader.u8(), voiceEnabled: reader.u8() !== 0 };
  reader.assertFinished();
  return status;
}

/**
 * The cache generation the realm wants.
 *
 * The original client throws away its whole `WDB` cache when this number changes, which is the
 * only reason it exists. This client has no `WDB` — every query is asked for and kept in memory
 * for the session — so the number is recorded and the caches are dropped when it moves.
 */
export function parseClientCacheVersion(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const version = reader.u32();
  reader.assertFinished();
  return version;
}

export interface RealmSplit {
  /** Echoed straight back from the request; the core does not even name it. */
  requestId: number;
  /** 0 normal, 1 split, 2 split pending. This core writes a literal 0. */
  state: number;
  /** A date string. This core writes the literal "01/01/01". */
  date: string;
}

export function parseRealmSplit(payload: Uint8Array): RealmSplit {
  const reader = new PacketReader(payload);
  const split: RealmSplit = { requestId: reader.u32(), state: reader.u32(), date: reader.cString() };
  reader.assertFinished();
  return split;
}

export interface ServerTime {
  /** Unix seconds on the server. */
  time: number;
  /** Seconds until daily quests reset — a duration, where the field beside it is a moment. */
  dailyResetIn: number;
}

/**
 * The server's clock and the daily reset.
 *
 * Two adjacent words that are not the same kind of number: the first is absolute unix time, the
 * second is `GetNextDailyQuestsResetTime() - GetGameTime()`, a remaining duration. Adding the
 * second to the first gives the reset moment; reading either as the other gives a date in 2038.
 */
export function parseQueryTimeResponse(payload: Uint8Array): ServerTime {
  const reader = new PacketReader(payload);
  const time: ServerTime = { time: reader.u32(), dailyResetIn: reader.u32() };
  reader.assertFinished();
  return time;
}

/**
 * The message of the day, one string per line.
 *
 * The core splits the configured string on `@` and writes a line count in front, so a one-line
 * motd is a count of one and not a bare string — and an empty motd is a count of zero with nothing
 * after it, which is a valid packet rather than a truncated one.
 */
export function parseMotd(payload: Uint8Array): string[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  const lines: string[] = [];
  for (let index = 0; index < count; index++) lines.push(reader.cString());
  reader.assertFinished();
  return lines;
}

/**
 * A line the server wants shown in the middle of the screen: "you are silenced", "that is too far
 * away", the whole `SendNotification` family. One string, already formatted and already localised
 * into the realm's language.
 */
export function parseNotification(payload: Uint8Array): string {
  const reader = new PacketReader(payload);
  const text = reader.cString();
  reader.assertFinished();
  return text;
}

/**
 * `ServerMessageType` in World.h — and it starts at **one**, not zero.
 *
 * Numbering it from zero shifts every wording by one: a shutdown announcement prints as a restart,
 * a restart as a free-form string, and both cancellations fall off the end of the table into an
 * unknown code. Nothing in the packet catches that, because every id in range is a valid id.
 */
export const SERVER_MSG_SHUTDOWN_TIME = 1;
export const SERVER_MSG_RESTART_TIME = 2;
export const SERVER_MSG_STRING = 3;
export const SERVER_MSG_SHUTDOWN_CANCELLED = 4;
export const SERVER_MSG_RESTART_CANCELLED = 5;

export interface ChatServerMessage {
  /** A `SERVER_MSG_*` value. */
  messageId: number;
  /**
   * The formatted time for the two countdowns and the whole message for `SERVER_MSG_STRING`.
   * Empty for the two cancellations: the core fills it only for ids up to `SERVER_MSG_STRING`.
   */
  param: string;
}

/** The shutdown and restart announcements. Signed, though this core only ever sends 0 to 3. */
export function parseChatServerMessage(payload: Uint8Array): ChatServerMessage {
  const reader = new PacketReader(payload);
  const message: ChatServerMessage = { messageId: reader.i32(), param: reader.cString() };
  reader.assertFinished();
  return message;
}

const SERVER_MESSAGES: Record<number, (param: string) => string> = {
  [SERVER_MSG_SHUTDOWN_TIME]: (param) => `Сервер выключается через ${param}`,
  [SERVER_MSG_RESTART_TIME]: (param) => `Сервер перезапускается через ${param}`,
  [SERVER_MSG_STRING]: (param) => param,
  [SERVER_MSG_SHUTDOWN_CANCELLED]: () => "Выключение сервера отменено",
  [SERVER_MSG_RESTART_CANCELLED]: () => "Перезапуск сервера отменён",
};

export function chatServerMessageText(message: ChatServerMessage): string {
  const worded = SERVER_MESSAGES[message.messageId];
  return worded ? worded(message.param) : `Сообщение сервера ${message.messageId} ${message.param}`.trim();
}

export interface LogoutResponse {
  /** Zero is permission granted; anything else is a refusal — in combat, falling, in an arena. */
  result: number;
  /** True when the twenty-second wait is waived: resting, or a game master. */
  instant: boolean;
}

/**
 * The answer to asking to leave.
 *
 * A refusal and a grant are the same shape, and the grant is not the end of it: the sit-down and
 * the countdown run on the server, which then sends `SMSG_LOGOUT_COMPLETE`. Treating a zero result
 * as "we are out" logs the interface out twenty seconds before the server does.
 */
export function parseLogoutResponse(payload: Uint8Array): LogoutResponse {
  const reader = new PacketReader(payload);
  const response: LogoutResponse = { result: reader.u32(), instant: reader.u8() !== 0 };
  reader.assertFinished();
  return response;
}

/** Both the completion and the cancel acknowledgement are empty. The opcode is the whole message. */
export function parseEmptySessionPacket(payload: Uint8Array): void {
  new PacketReader(payload).assertFinished();
}

export interface DeclinedNamesResult {
  /** 0 accepted, 1 rejected. */
  result: number;
  guid: bigint;
}

export function parseDeclinedNamesResult(payload: Uint8Array): DeclinedNamesResult {
  const reader = new PacketReader(payload);
  const result: DeclinedNamesResult = { result: reader.u32(), guid: reader.u64() };
  reader.assertFinished();
  return result;
}

/** `SecureAddonInfo::SecureAddonStatus` in WorldSession.h. */
export const ADDON_STATUS_BANNED = 0;
export const ADDON_STATUS_SECURE_VISIBLE = 1;
export const ADDON_STATUS_SECURE_HIDDEN = 2;

/** `Addons::MaxSecureAddons`: the server truncates the declared list to this many. */
export const MAX_SECURE_ADDONS = 25;

/** `STANDARD_ADDON_CRC` in AddonMgr.h — the CRC every stock addon reports. */
export const STANDARD_ADDON_CRC = 0x4c1c776d;

/** The public key the server appends for an addon whose CRC it did not recognise. */
export const ADDON_PUBLIC_KEY_LENGTH = 256;

export interface DeclaredAddon {
  name: string;
  /** Whether the client already has this addon's `.pub` key file. */
  hasKey: boolean;
  publicKeyCrc: number;
  urlCrc: number;
}

export interface AddonResponse {
  status: number;
  infoProvided: boolean;
  keyProvided: boolean;
  publicKey: Uint8Array | undefined;
  revision: number;
  urlProvided: boolean;
}

export interface BannedAddon {
  id: number;
  nameMd5: Uint8Array;
  versionMd5: Uint8Array;
  timestamp: number;
}

export interface AddonInfo {
  /** One entry per addon the client declared, in the order it declared them. */
  addons: AddonResponse[];
  banned: BannedAddon[];
}

/**
 * What the server thinks of the addons the client declared.
 *
 * The first list has **no count**. The server writes exactly as many entries as the client sent in
 * its authentication packet and expects the client to remember how many that was — which is why
 * this parser has to be told. Guess high and it reads the banned-addon count as an addon status;
 * guess low and the banned list starts inside the last addon.
 *
 * Each entry is also three nested conditionals with no lengths: the 256-byte public key appears
 * only when the client said it had no key file, and the URL string only when the server offers one,
 * which this core never does.
 */
export function parseAddonInfo(payload: Uint8Array, declaredCount: number): AddonInfo {
  const reader = new PacketReader(payload);
  const addons: AddonResponse[] = [];
  for (let index = 0; index < declaredCount; index++) {
    const status = reader.u8();
    const infoProvided = reader.u8() !== 0;
    const addon: AddonResponse = {
      status, infoProvided, keyProvided: false, publicKey: undefined, revision: 0, urlProvided: false,
    };
    if (infoProvided) {
      addon.keyProvided = reader.u8() !== 0;
      if (addon.keyProvided) addon.publicKey = reader.bytes(ADDON_PUBLIC_KEY_LENGTH);
      addon.revision = reader.u32();
    }
    addon.urlProvided = reader.u8() !== 0;
    if (addon.urlProvided) reader.cString();
    addons.push(addon);
  }

  const banned: BannedAddon[] = [];
  const count = reader.u32();
  for (let index = 0; index < count; index++) {
    const entry: BannedAddon = {
      id: reader.u32(),
      nameMd5: reader.bytes(16),
      versionMd5: reader.bytes(16),
      timestamp: reader.u32(),
    };
    // Always 1. The flag exists for a client that caches the list and would need to be told an
    // entry was lifted; this core only ever writes banned ones.
    reader.u32();
    banned.push(entry);
  }
  reader.assertFinished();
  return { addons, banned };
}

/**
 * The anti-cheat channel, RC4-encrypted with a key derived from the session key.
 *
 * Nothing here can be read without implementing Warden itself, and answering it wrongly is worse
 * than not answering: the server kicks on a bad response and merely waits on a missing one. The
 * bytes are kept as they arrived. This realm has `Warden.Enabled = 0`, so the packet has a sender
 * in the core — which is why the coverage report calls it live — and never actually arrives.
 */
export function parseWardenData(payload: Uint8Array): Uint8Array {
  return payload.slice();
}

/** Asking for one of the eight blobs back. */
export function buildRequestAccountData(type: number): Uint8Array {
  return new PacketWriter().u32(type).toUint8Array();
}

/**
 * Storing one of the eight blobs.
 *
 * The size is the decompressed one and the body must be deflate — the server inflates into a
 * buffer of exactly that size, so a wrong number is not a hint but a failure. A zero size is the
 * erase instruction and carries no body at all, which is the one case where nothing is compressed.
 */
export function buildUpdateAccountData(type: number, timestamp: number, decompressedSize: number, compressed: Uint8Array): Uint8Array {
  const writer = new PacketWriter().u32(type).u32(timestamp).u32(decompressedSize);
  if (decompressedSize > 0) writer.bytes(compressed);
  return writer.toUint8Array();
}

/** Empty. The server answers with the per-character mask once the character is in the world. */
export function buildReadyForAccountDataTimes(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** One tutorial index, 0 to 255. The server sets the bit and never answers. */
export function buildTutorialFlag(index: number): Uint8Array {
  return new PacketWriter().u32(index).toUint8Array();
}

/** Both are empty: one sets every tutorial bit, the other clears them all. */
export function buildTutorialClear(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

export function buildTutorialReset(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** The word is echoed straight back in the answer, so it can be anything the caller can match. */
export function buildRealmSplit(requestId: number): Uint8Array {
  return new PacketWriter().u32(requestId).toUint8Array();
}

/** Empty. Also sent by the ticket window, which is why the answer arrives unasked. */
export function buildQueryTime(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** Asking to leave. The answer is a grant or a refusal, and the grant is not the end of it. */
export function buildLogoutRequest(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** Changing one's mind. The server acknowledges and stands the character back up. */
export function buildLogoutCancel(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/**
 * Leaving now, skipping whatever is left of the countdown.
 *
 * The core treats this as "the client has finished its own logout animation" rather than as a
 * request, so it is only legal after a granted `CMSG_LOGOUT_REQUEST`.
 */
export function buildPlayerLogout(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/**
 * The addon block that goes at the end of `CMSG_AUTH_SESSION`.
 *
 * Everything past the length word is deflate, and the tail is read from the *end*: the server does
 * `rpos(size - 4)` and reads the last-banned-addon timestamp from there, whatever came before it.
 * So the block is `count`, then that many addons, then the timestamp — and the timestamp has to be
 * last, not merely present.
 *
 * A block of length zero is legal and means "no addons declared", which is what this client sent
 * before it could compress: the server returns early and the answer carries no addon entries. What
 * is *not* legal is leaving the block out entirely — `WorldSocket::HandleAuthSession` resizes its
 * buffer to whatever is left and calls `.contents()`, which throws on an empty one, and the core's
 * own comment beside it says that is deliberate. So the four length bytes are mandatory.
 *
 * More than `MAX_SECURE_ADDONS` declared addons are silently truncated by the server, and its
 * answer is that many entries long rather than as many as were sent.
 */
export async function buildAddonBlock(addons: readonly DeclaredAddon[], lastBannedTimestamp = 0): Promise<Uint8Array> {
  const body = new PacketWriter().u32(addons.length);
  for (const addon of addons) {
    body.cString(addon.name).u8(addon.hasKey ? 1 : 0).u32(addon.publicKeyCrc).u32(addon.urlCrc);
  }
  body.u32(lastBannedTimestamp);

  const plain = body.toUint8Array();
  const compressed = await deflate(plain);
  return new PacketWriter().u32(plain.byteLength).bytes(compressed).toUint8Array();
}

/**
 * zlib, not raw deflate: the server calls `uncompress()`, which wants the two-byte header and the
 * Adler checksum. The Compression Streams name for that is "deflate"; "deflate-raw" is the one
 * that would be rejected, and it is the one whose name reads as if it were right.
 */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The mirror of `deflate`, for a blob that came back from the account-data store. */
export async function inflate(bytes: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  const result = new Uint8Array(await new Response(stream).arrayBuffer());
  if (result.byteLength !== expectedSize) {
    throw new RangeError(`Account data expanded to ${result.byteLength} bytes, expected ${expectedSize}`);
  }
  return result;
}

/** `LANG_ADDON` in SharedDefines.h: `0xFFFFFFFF`, which reads as −1 in the signed field. */
export const LANG_ADDON = 0xffff_ffff;
/** `CHAT_MSG_ADDON` in SharedDefines.h: `0xFF`, the type an addon message comes back on. */
export const CHAT_MSG_ADDON = 0xff;

/**
 * The addon channel's message body: a prefix, a tab, and the payload.
 *
 * Nothing on the wire separates the two — the original client splits on the first tab and every
 * addon has agreed to that ever since. The server does not look inside at all; it only refuses the
 * message types that are not party, raid, guild, battleground or whisper, and only when
 * `Addon.Channel` is on.
 */
export function buildAddonMessageBody(prefix: string, message: string): string {
  return `${prefix}\t${message}`;
}

/** Splits what `buildAddonMessageBody` joined. A body with no tab is all payload and no prefix. */
export function parseAddonMessageBody(body: string): { prefix: string; message: string } {
  const tab = body.indexOf("\t");
  if (tab < 0) return { prefix: "", message: body };
  return { prefix: body.slice(0, tab), message: body.slice(tab + 1) };
}
