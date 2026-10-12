/**
 * 3.24 (12.10): the canned seam's GM ticket world (FrameXmlHelp.ts) for `?help=` and the tests: the ticket requests
 * are recorded, never sent; `answerTicket`/`answerResponse`/`answerStatus` play the server's SMSG_GMTICKET_GETTICKET,
 * SMSG_GMRESPONSE_RECEIVED and SMSG_GMTICKET_SYSTEMSTATUS. The texts are this fixture's, in ruRU.
 */
import type { GmResponse, GmTicket, TicketRequest } from "../../world/TicketProtocol.js";
import type { FrameXmlHelpWorld } from "./FrameXmlHelp.js";

type Payload = { kind?: string; request?: string; status?: number };
type Listener = (payload: Payload) => void;

export type FrameXmlCannedHelpCall =
  | { readonly kind: "get" | "status" | "delete" | "resolve" }
  | { readonly kind: "create"; readonly request: TicketRequest }
  | { readonly kind: "update"; readonly message: string };

/** An open ticket a GM has not looked at yet: 2 hours old, the oldest open one 6 hours. */
export const FRAMEXML_CANNED_TICKET: GmTicket = Object.freeze({
  status: 6, ticketId: 41, message: "Застрял в текстурах у Златоземья, не могу выйти.", needMoreHelp: false,
  ageDays: 2 / 24, oldestTicketAgeDays: 6 / 24, lastUpdatedDays: 0.01, escalationStatus: 0, viewed: false,
});

export const FRAMEXML_CANNED_RESPONSE: GmResponse = Object.freeze({
  responseId: 1, ticketId: 41, message: FRAMEXML_CANNED_TICKET.message,
  response: "Здравствуйте! Мы переместили вашего персонажа в Златоземье. Приятной игры!",
});

export class FrameXmlCannedHelpWorld implements FrameXmlHelpWorld {
  readonly calls: FrameXmlCannedHelpCall[] = [];
  readonly #listeners = new Set<Listener>();
  readonly events = {
    on: (_event: "GM_TICKET_CHANGED", listener: Listener): (() => void) => {
      this.#listeners.add(listener);
      return () => { this.#listeners.delete(listener); };
    },
  };
  gmTicket: GmTicket | undefined;
  gmResponse: GmResponse | undefined;
  readonly mapId = 0;
  readonly state = {
    selfGuid: 0x11n as bigint | undefined,
    objects: new Map<bigint, { position?: { x: number; y: number; z: number } }>([[0x11n, { position: { x: -9460, y: 62, z: 56 } }]]),
  };
  readonly chatLog = [{ text: "[Игрок] говорит: Привет из canned seam", at: 0 }];

  #emit(payload: Payload): void {
    for (const listener of [...this.#listeners]) listener(payload);
  }

  requestTicket(): void { this.calls.push({ kind: "get" }); }
  requestTicketSystemStatus(): void { this.calls.push({ kind: "status" }); }
  async createTicket(request: TicketRequest): Promise<void> { this.calls.push({ kind: "create", request }); }
  updateTicket(message: string): void { this.calls.push({ kind: "update", message }); }
  abandonTicket(): void { this.calls.push({ kind: "delete" }); }
  resolveGmResponse(): void { this.calls.push({ kind: "resolve" }); }

  /** SMSG_GMTICKET_GETTICKET: the open ticket, or none (null). */
  answerTicket(ticket: GmTicket | null = FRAMEXML_CANNED_TICKET): void {
    this.gmTicket = ticket ?? undefined;
    this.#emit({ kind: "snapshot", status: ticket ? 6 : 10 });
  }

  /** SMSG_GMRESPONSE_RECEIVED. */
  answerResponse(response: GmResponse = FRAMEXML_CANNED_RESPONSE): void {
    this.gmResponse = response;
    this.#emit({ kind: "response" });
  }

  /** SMSG_GMTICKET_SYSTEMSTATUS: 1 the queue takes tickets, 0 it does not. */
  answerStatus(status: number): void {
    this.#emit({ kind: "system", status });
  }

  /** SMSG_GMTICKET_CREATE/UPDATETEXT/DELETETICKET with their word. */
  answerResult(request: "create" | "update" | "delete", status: number): void {
    if (request === "delete" && status === 9) this.gmTicket = undefined;
    this.#emit({ kind: "result", request, status });
  }

  reset(): void {
    this.calls.length = 0;
    this.gmTicket = undefined;
    this.gmResponse = undefined;
  }
}
