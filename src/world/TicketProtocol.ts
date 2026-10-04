import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { deflate } from "./SessionProtocol.js";

// Layouts follow the active TrinityCore source: TicketMgr.cpp (`GmTicket::WritePacket`,
// `GmTicket::SendResponse`, `TicketMgr::SendTicket`) and TicketHandler.cpp — the create, update,
// delete, fetch, system-status and resolve handlers.

/** `GMTicketStatus` in TicketMgr.h. */
export const GMTICKET_STATUS_HASTEXT = 0x06;
export const GMTICKET_STATUS_DEFAULT = 0x0a;

/** `GMTicketResponse` in TicketMgr.h. */
export const GMTICKET_RESPONSE_ALREADY_EXIST = 1;
export const GMTICKET_RESPONSE_CREATE_SUCCESS = 2;
export const GMTICKET_RESPONSE_CREATE_ERROR = 3;
export const GMTICKET_RESPONSE_UPDATE_SUCCESS = 4;
export const GMTICKET_RESPONSE_UPDATE_ERROR = 5;
export const GMTICKET_RESPONSE_TICKET_DELETED = 9;

/** `GMTicketEscalationStatus`: the packet clamps this to at most `TICKET_IN_ESCALATION_QUEUE`. */
export const TICKET_UNASSIGNED = 0;
export const TICKET_ASSIGNED = 1;
export const TICKET_IN_ESCALATION_QUEUE = 2;

/** `GMTicketQueueStatus`: whether the realm accepts tickets at all. */
export const GMTICKET_QUEUE_STATUS_DISABLED = 0;
export const GMTICKET_QUEUE_STATUS_ENABLED = 1;

/** The four chunks `SendResponse` splits a GM's reply into. */
export const GM_RESPONSE_CHUNKS = 4;
/** Each chunk is at most this many bytes before the terminator. */
export const GM_RESPONSE_CHUNK_SIZE = 3999;

export interface GmTicket {
  /** `GMTICKET_STATUS_HASTEXT` when there is a ticket, `GMTICKET_STATUS_DEFAULT` when there is not. */
  status: number;
  /** Zero when there is no ticket: every field below is absent from the packet in that case. */
  ticketId: number;
  message: string;
  needMoreHelp: boolean;
  /** Days, as a float — `(now - lastModified) / DAY` — not seconds and not a timestamp. */
  ageDays: number;
  /** Age of the oldest open ticket on the realm, in days. Zero when there is none. */
  oldestTicketAgeDays: number;
  /** How long since anything in the ticket system changed, in days. */
  lastUpdatedDays: number;
  escalationStatus: number;
  /** Whether a GM has opened it. */
  viewed: boolean;
}

/**
 * The player's own open ticket, or the fact that there is none.
 *
 * The whole packet is one status word when there is no ticket — four bytes and nothing else — so
 * the presence of everything after it is decided by that word alone. And the three time fields are
 * floats measured in **days**, which is easy to read as seconds and get an answer off by 86400.
 */
export function parseGmTicket(payload: Uint8Array): GmTicket {
  const reader = new PacketReader(payload);
  const status = reader.u32();
  const ticket: GmTicket = {
    status, ticketId: 0, message: "", needMoreHelp: false, ageDays: 0, oldestTicketAgeDays: 0,
    lastUpdatedDays: 0, escalationStatus: TICKET_UNASSIGNED, viewed: false,
  };
  if (status !== GMTICKET_STATUS_HASTEXT) {
    reader.assertFinished();
    return ticket;
  }

  ticket.ticketId = reader.u32();
  ticket.message = reader.cString();
  ticket.needMoreHelp = reader.u8() !== 0;
  ticket.ageDays = reader.f32();
  ticket.oldestTicketAgeDays = reader.f32();
  ticket.lastUpdatedDays = reader.f32();
  ticket.escalationStatus = reader.u8();
  ticket.viewed = reader.u8() !== 0;
  reader.assertFinished();
  return ticket;
}

export interface GmResponse {
  /** Always 1 in this core. */
  responseId: number;
  ticketId: number;
  /** What the player originally wrote. */
  message: string;
  /** The GM's reply, rejoined from the four chunks the core splits it into. */
  response: string;
}

/**
 * A game master's answer.
 *
 * The reply is written as four separate null-terminated chunks of at most 3999 bytes each, because
 * the original client reads four fixed string slots — so a reply longer than 3999 characters is
 * split mid-word across two of them and has to be concatenated back. All four are always written,
 * even when the reply is short and three of them are empty, so a reader that stops at the first
 * empty string leaves the packet unfinished.
 */
export function parseGmResponse(payload: Uint8Array): GmResponse {
  const reader = new PacketReader(payload);
  const responseId = reader.u32();
  const ticketId = reader.u32();
  const message = reader.cString();
  let response = "";
  for (let chunk = 0; chunk < GM_RESPONSE_CHUNKS; chunk++) response += reader.cString();
  reader.assertFinished();
  return { responseId, ticketId, message, response };
}

/** Whether the player is being asked to fill in a survey after the ticket closed. */
export function parseGmResponseStatusUpdate(payload: Uint8Array): boolean {
  const reader = new PacketReader(payload);
  const survey = reader.u8() !== 0;
  reader.assertFinished();
  return survey;
}

/** Create, update and delete all answer with one `GMTicketResponse` word on their own opcode. */
export function parseTicketResponse(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const response = reader.u32();
  reader.assertFinished();
  return response;
}

/** Whether the realm is taking tickets. The core's own comment doubts the width; it is a word. */
export function parseTicketSystemStatus(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const status = reader.u32();
  reader.assertFinished();
  return status;
}

const TICKET_RESPONSES: Record<number, string> = {
  1: "У вас уже есть открытый запрос",
  2: "Запрос отправлен",
  3: "Не удалось отправить запрос",
  4: "Запрос изменён",
  5: "Не удалось изменить запрос",
  9: "Запрос закрыт",
};

export function ticketResponseText(response: number): string {
  return TICKET_RESPONSES[response] ?? `Запрос к ГМ: код ${response}`;
}

export const isTicketSuccess = (response: number): boolean =>
  response === GMTICKET_RESPONSE_CREATE_SUCCESS
  || response === GMTICKET_RESPONSE_UPDATE_SUCCESS
  || response === GMTICKET_RESPONSE_TICKET_DELETED;

export interface TicketRequest {
  mapId: number;
  x: number;
  y: number;
  z: number;
  message: string;
  needResponse: boolean;
  needMoreHelp: boolean;
  /** Unix seconds, one per chat-log line. The count of these gates whether the log is read at all. */
  chatTimes?: readonly number[];
  /** The recent chat window, sent so a GM can see the context. */
  chatLog?: string;
}

/**
 * Opening a ticket.
 *
 * The chat log is compressed and optional, and the condition to read it is not the size word but
 * `count && decompressedSize` — the number of *timestamps*. Send a log with no timestamps and the
 * server ignores it and leaves the compressed bytes unread in the buffer; send timestamps with no
 * log and it reads nothing either. The two travel together or not at all.
 */
export async function buildTicketCreate(request: TicketRequest): Promise<Uint8Array> {
  const times = request.chatTimes ?? [];
  const writer = new PacketWriter()
    .u32(request.mapId).f32(request.x).f32(request.y).f32(request.z)
    .cString(request.message)
    .u8(request.needResponse ? 1 : 0)
    .u8(request.needMoreHelp ? 1 : 0)
    .u32(times.length);
  for (const time of times) writer.u32(time);

  const log = request.chatLog ?? "";
  if (times.length === 0 || !log) return writer.u32(0).toUint8Array();

  // The server reads one std::string out of the inflated buffer, so the terminator is part of what
  // it inflates and part of the size it is told to expect.
  const plain = new PacketWriter().cString(log).toUint8Array();
  const compressed = await deflate(plain);
  return writer.u32(plain.byteLength).bytes(compressed).toUint8Array();
}

/** Rewriting an open ticket. The whole message is replaced; there is no append. */
export function buildTicketUpdate(message: string): Uint8Array {
  return new PacketWriter().cString(message).toUint8Array();
}

/** Abandoning the ticket. Empty, and answered with a delete response plus a fresh empty ticket. */
export function buildTicketDelete(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/**
 * Asking what ticket there is.
 *
 * The server answers this with `SMSG_QUERY_TIME_RESPONSE` first and the ticket second — the ticket
 * ages are relative to the server's clock, so it sends the clock along unasked.
 */
export function buildTicketGet(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** Asking whether the realm takes tickets at all. */
export function buildTicketSystemStatus(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/** Acknowledging a GM's answer, which closes the ticket. Empty. */
export function buildGmResponseResolve(): Uint8Array {
  return new PacketWriter().toUint8Array();
}

/**
 * `CMSG_GM_REPORT_LAG` (8.17): `u32 kind, u32 mapId, f32 x, y, z` (HandleReportLag, TicketHandler.cpp:248).
 * Wow.exe's GMReportLag (0x5ad020 → 0x5acf30) writes the Lua number minus one — STATIC_CONSTANTS
 * Loot = 1 … Spell = 6 (table 0x00acfac0) go out as 0 … 5 — the current map and the player's position.
 */
export function buildReportLag(wireKind: number, mapId: number, x: number, y: number, z: number): Uint8Array {
  return new PacketWriter().u32(wireKind >>> 0).u32(mapId >>> 0).f32(x).f32(y).f32(z).toUint8Array();
}

/**
 * `CMSG_COMPLAIN` about a letter (8.17): `u8 0` (mail), `u64 sender`, `u32 0, u32 mailId, u32 0`
 * (HandleComplainOpcode, MiscHandler.cpp:1190-1209; Wow.exe 0x56faf0 writes the same five fields).
 */
export function buildComplainMail(senderGuid: bigint, mailId: number): Uint8Array {
  return new PacketWriter().u8(0).u64(senderGuid).u32(0).u32(mailId >>> 0).u32(0).toUint8Array();
}
