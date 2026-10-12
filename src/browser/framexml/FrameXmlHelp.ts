/**
 * 3.24 (12.10): the GM ticket C API and events behind stock HelpFrame/KnowledgeBaseFrame (HelpFrame.lua,
 * KnowledgeBaseFrame.lua; TOC lines 115-116, FrameXmlCorpus.ts) and TicketStatusFrame, over the ticket opcodes
 * WorldClient already speaks (TicketProtocol.ts). Owner: FrameXmlHelpOwner.ts.
 *
 * Wow.exe (read-only Ghidra, `.runtime/re-2026-10-11/glue-1110/bf324-11..15.txt`):
 *   GetGMTicket (0x005ad070 → 0x005acbf0): CMSG_GMTICKET_GETTICKET. GetGMStatus (0x005ad1c0): CMSG_GMTICKET_SYSTEMSTATUS.
 *   NewGMTicket(text, needResponse) (0x005ad080 → 0x005ac8f0(text, needResponse, 0)): nothing while a ticket is
 *     open; the text is checked (0x005ac170: over 500 characters is ERR_TICKET_TEXT_TOO_LONG, nothing left once
 *     filtered is ERR_TICKET_NO_TEXT, both UI errors); then CMSG_GMTICKET_CREATE with the map, the position, the
 *     text, `needResponse ? 17 : 1`, the need-more-help byte and the chat history (seconds ago per line, the lines
 *     zlib-compressed).
 *   UpdateGMTicket(text) (0x005ad0f0 → 0x005acb50): with a ticket and no GM response, the same check, then
 *     CMSG_GMTICKET_UPDATETEXT. DeleteGMTicket (0x005acc60): with a ticket and no response, CMSG_GMTICKET_DELETETICKET.
 *   GMResponseNeedMoreHelp(text) (0x005ad150 → 0x005ac8f0(text, 1, 1)): with a GM response, a new ticket that
 *     wants a response and «needs more help». GMResponseResolve (0x005acce0): with a response, CMSG_GMRESPONSE_RESOLVE.
 *   The answers (0x005ad240): SMSG_GMTICKET_GETTICKET raises UPDATE_TICKET (0x181) — with a ticket "%d%s%f%f%f%d%d":
 *     the need-more-help byte (stock's «category»), the text, its age, the oldest ticket's age (both days, the age
 *     floored at 0), the last change, the escalation and the opened-by-GM byte; without one no arguments, after
 *     ERR_TICKET_DB_ERROR when the status word is 0. SMSG_GMTICKET_CREATE/UPDATETEXT: 1 ERR_TICKET_ALREADY_EXISTS,
 *     2 and 4 ask GetGMTicket, 3 ERR_TICKET_CREATE_ERROR, 5 ERR_TICKET_UPDATE_ERROR. SMSG_GMTICKET_DELETETICKET:
 *     9 forgets the ticket and raises UPDATE_TICKET(), anything else ERR_TICKET_DB_ERROR. SMSG_GMRESPONSE_RECEIVED:
 *     GMRESPONSE_RECEIVED(text, response). SMSG_GMRESPONSE_STATUS_UPDATE: forgets both, then GMSURVEY_DISPLAY when
 *     its byte asks a survey — out of the plan (owner, 8.17): UPDATE_TICKET() instead — else UPDATE_TICKET().
 *     SMSG_GMTICKET_SYSTEMSTATUS (0x006e2e90): UPDATE_GM_STATUS with the word as sent (1 enabled, 0 disabled).
 *   The knowledge base is Blizzard's web service (0x00550e10: getKBSetup.xml on support.wow-europe.com and its
 *     siblings, 0x00550940), never this realm's: KBSetup_BeginLoading answers as a load that failed
 *     (KNOWLEDGE_BASE_SETUP_LOAD_FAILURE; stock shows KBASE_ERROR_LOAD_FAILURE and keeps «Top issues» enabled),
 *     KBSetup_IsLoaded is false, the MOTD and server notice nil — no request leaves this client.
 */
import type { GmResponse, GmTicket, TicketRequest } from "../../world/TicketProtocol.js";

/** GMTicketResponse (TicketMgr.h). */
const RESPONSE_ALREADY_EXIST = 1;
const RESPONSE_CREATE_SUCCESS = 2;
const RESPONSE_CREATE_ERROR = 3;
const RESPONSE_UPDATE_SUCCESS = 4;
const RESPONSE_UPDATE_ERROR = 5;
const RESPONSE_TICKET_DELETED = 9;
/** Wow.exe 0x005ac170: a ticket's text is at most 500 characters. */
const TICKET_TEXT_LIMIT = 500;
/** Wow.exe 0x005ac8f0 walks the 60 lines of the chat history. */
const CHAT_HISTORY_LINES = 60;

type Listener = (payload: { kind?: string; request?: string; status?: number }) => void;

/** WorldClient's ticket fields and commands (structural). */
export interface FrameXmlHelpWorld {
  readonly events: { on(event: "GM_TICKET_CHANGED", listener: Listener): () => void };
  readonly gmTicket: GmTicket | undefined;
  readonly gmResponse: GmResponse | undefined;
  readonly ticketSurveyPending?: boolean;
  readonly mapId: number | undefined;
  readonly state: { readonly selfGuid?: bigint | undefined; readonly objects: ReadonlyMap<bigint, { readonly position?: { x: number; y: number; z: number } | undefined }> };
  readonly chatLog?: readonly { readonly text: string; readonly at?: number | undefined }[];
  requestTicket(): void;
  requestTicketSystemStatus(): void;
  createTicket(request: TicketRequest): Promise<void>;
  updateTicket(message: string): void;
  abandonTicket(): void;
  resolveGmResponse(): void;
}

export interface FrameXmlHelpPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export interface FrameXmlHelpContext {
  world(): FrameXmlHelpWorld | undefined;
  /** A UI error by its GlobalStrings key (UI_ERROR_MESSAGE). */
  uiError(key: string): void;
  /** Wall-clock milliseconds, for the chat history's «seconds ago». */
  now?(): number;
}

/** UTF-8 characters, as Wow.exe counts the text (0x0076eea0). */
function characters(text: string): number {
  return [...text].length;
}

/** The text with nothing to say — Wow.exe 0x0076f1e0 filters the escapes; blank is nothing. */
function blank(text: string): boolean {
  return text.replace(/\|c[0-9a-fA-F]{8}|\|r|\|H[^|]*\|h|\|h/g, "").trim().length === 0;
}

export class FrameXmlHelpModel {
  readonly #context: FrameXmlHelpContext;
  #pump: FrameXmlHelpPump | undefined;
  #unsubscribe: (() => void) | undefined;
  #world: FrameXmlHelpWorld | undefined;

  constructor(context: FrameXmlHelpContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlHelpPump): void {
    this.detach();
    this.#pump = pump;
    this.#follow();
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#world = undefined;
    this.#pump = undefined;
  }

  /** Follow a new world (login, reconnect) — the seam's tick calls this; the subscription is per world. */
  #follow(): void {
    const world = this.#context.world();
    if (world === this.#world) return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#world = world;
    if (world) this.#unsubscribe = world.events.on("GM_TICKET_CHANGED", (payload) => this.#answer(world, payload));
  }

  tick(): void {
    if (this.#pump) this.#follow();
  }

  /** One ticket packet's edge, as 0x005ad240 and 0x006e2e90 raise them. */
  #answer(world: FrameXmlHelpWorld, payload: { kind?: string; request?: string; status?: number }): void {
    const pump = this.#pump;
    if (!pump || this.#context.world() !== world) return;
    switch (payload.kind) {
      case "snapshot": {
        const ticket = world.gmTicket;
        if (ticket) {
          pump.fire("UPDATE_TICKET", ticket.needMoreHelp ? 1 : 0, ticket.message, Math.max(0, ticket.ageDays),
            ticket.oldestTicketAgeDays, ticket.lastUpdatedDays, ticket.escalationStatus, ticket.viewed ? 1 : 0);
          return;
        }
        if (payload.status === 0) this.#context.uiError("ERR_TICKET_DB_ERROR");
        pump.fire("UPDATE_TICKET");
        return;
      }
      case "result": {
        const status = payload.status;
        if (payload.request === "delete") {
          if (status === RESPONSE_TICKET_DELETED) pump.fire("UPDATE_TICKET");
          else this.#context.uiError("ERR_TICKET_DB_ERROR");
          return;
        }
        if (status === RESPONSE_ALREADY_EXIST) this.#context.uiError("ERR_TICKET_ALREADY_EXISTS");
        else if (status === RESPONSE_CREATE_SUCCESS || status === RESPONSE_UPDATE_SUCCESS) world.requestTicket();
        else if (status === RESPONSE_CREATE_ERROR) this.#context.uiError("ERR_TICKET_CREATE_ERROR");
        else if (status === RESPONSE_UPDATE_ERROR) this.#context.uiError("ERR_TICKET_UPDATE_ERROR");
        return;
      }
      case "system":
        pump.fire("UPDATE_GM_STATUS", payload.status ?? 0);
        return;
      case "response": {
        const response = world.gmResponse;
        if (response) pump.fire("GMRESPONSE_RECEIVED", response.message, response.response);
        return;
      }
      case "resolved":
        // GMSURVEY_DISPLAY is not raised: the GM survey is out of the plan (owner, 8.17).
        pump.fire("UPDATE_TICKET");
        return;
    }
  }

  getTicket(): void { this.#context.world()?.requestTicket(); }

  getStatus(): void { this.#context.world()?.requestTicketSystemStatus(); }

  /** 0x005ac170: false (and the UI error) for a text Wow.exe refuses. */
  #acceptable(text: string): boolean {
    if (characters(text) > TICKET_TEXT_LIMIT) { this.#context.uiError("ERR_TICKET_TEXT_TOO_LONG"); return false; }
    if (blank(text)) { this.#context.uiError("ERR_TICKET_NO_TEXT"); return false; }
    return true;
  }

  /** 0x005ac8f0: a new ticket, or with `moreHelp` the follow-up to a GM's response. */
  newTicket(text: string, needResponse: boolean, moreHelp = false): void {
    const world = this.#context.world();
    if (!world) return;
    if (moreHelp ? world.gmResponse === undefined : world.gmTicket !== undefined) return;
    if (!this.#acceptable(text)) return;
    const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
    const position = self?.position;
    if (!position || world.mapId === undefined) return;
    const now = this.#context.now?.() ?? Date.now();
    const lines = (world.chatLog ?? []).filter((line) => line.text !== "").slice(-CHAT_HISTORY_LINES);
    const chatLog = lines.map((line) => line.text).join("\n");
    const chatTimes = lines.map((line) => Math.max(0, Math.floor((now - (line.at ?? now)) / 1000)));
    void world.createTicket({
      mapId: world.mapId, x: position.x, y: position.y, z: position.z, message: text,
      needResponse, needMoreHelp: moreHelp,
      ...(chatTimes.length > 0 && chatLog ? { chatTimes, chatLog } : {}),
    }).catch(() => undefined);
  }

  /** 0x005acb50: with a ticket and no GM response. */
  updateTicket(text: string): void {
    const world = this.#context.world();
    if (!world?.gmTicket || world.gmResponse || !this.#acceptable(text)) return;
    world.updateTicket(text);
  }

  /** 0x005acc60: with a ticket and no GM response. */
  deleteTicket(): void {
    const world = this.#context.world();
    if (world?.gmTicket && !world.gmResponse) world.abandonTicket();
  }

  /** 0x005acce0: with a GM response. */
  resolveResponse(): void {
    const world = this.#context.world();
    if (world?.gmResponse) world.resolveGmResponse();
  }

  /** KBSetup_BeginLoading: Blizzard's knowledge base is never reached — the load fails, a frame later. */
  beginKnowledgeBase(): void {
    const pump = this.#pump;
    if (pump) queueMicrotask(() => { if (this.#pump === pump) pump.fire("KNOWLEDGE_BASE_SETUP_LOAD_FAILURE"); });
  }
}

export interface FrameXmlHelpHost {
  readonly help?: FrameXmlHelpModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/** 0x00815500: a number by its value, anything else by its Lua truth. */
function flag(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

export const FRAMEXML_HELP_BINDINGS: Readonly<Record<string,
  (host: FrameXmlHelpHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetGMTicket: (host) => { host.help?.getTicket(); return NOTHING; },
  GetGMStatus: (host) => { host.help?.getStatus(); return NOTHING; },
  NewGMTicket: (host, args) => {
    const message = text(args[0]);
    if (message !== undefined) host.help?.newTicket(message, flag(args[1]));
    return NOTHING;
  },
  UpdateGMTicket: (host, args) => {
    const message = text(args[0]);
    if (message !== undefined) host.help?.updateTicket(message);
    return NOTHING;
  },
  DeleteGMTicket: (host) => { host.help?.deleteTicket(); return NOTHING; },
  GMResponseNeedMoreHelp: (host, args) => {
    const message = text(args[0]);
    if (message !== undefined) host.help?.newTicket(message, true, true);
    return NOTHING;
  },
  GMResponseResolve: (host) => { host.help?.resolveResponse(); return NOTHING; },
  // The knowledge base (see the module doc): a load that fails, nothing loaded, no articles, no news.
  KBSetup_BeginLoading: (host) => { host.help?.beginKnowledgeBase(); return NOTHING; },
  KBSetup_IsLoaded: () => [false],
  KBSetup_GetArticleHeaderCount: () => [0],
  KBSetup_GetTotalArticleCount: () => [0],
  KBSetup_GetCategoryCount: () => [0],
  KBSetup_GetSubCategoryCount: () => [0],
  KBQuery_BeginLoading: () => NOTHING,
  KBQuery_GetArticleHeaderCount: () => [0],
  KBQuery_GetTotalArticleCount: () => [0],
  KBArticle_BeginLoading: () => NOTHING,
  KBSystem_GetMOTD: () => [undefined],
  KBSystem_GetServerNotice: () => [undefined],
});
