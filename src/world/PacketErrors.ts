import { OPCODE_NAMES } from "../generated/opcodes.js";

const MAX_ENTRIES = 128;
const MAX_MESSAGE_LENGTH = 300;
const MAX_PAYLOAD_SIZES = 4;

export type PacketErrorCategory = "dispatch" | "custom-transport" | "custom-decode" | "custom-handler" | "custom-direction";

export interface PacketErrorSummary {
  opcode: string;
  name: string;
  category: PacketErrorCategory;
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** Sizes only: packet bodies can contain chat or session data and must not enter the report. */
  payloadSizes: number[];
}

interface PacketErrorEntry {
  opcode: number;
  name: string;
  category: PacketErrorCategory;
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  payloadSizes: number[];
}

/** Parser and custom-transport failures, kept separate from opcodes with no handler. */
export class PacketErrorLog {
  readonly #entries = new Map<string, PacketErrorEntry>();
  count = 0;
  omitted = 0;

  record(opcode: number, error: Error, payloadBytes?: number, category: PacketErrorCategory = "dispatch"): void {
    this.count++;
    const message = error.message.slice(0, MAX_MESSAGE_LENGTH);
    const key = `${category}:${opcode}:${message}`;
    const existing = this.#entries.get(key);
    if (!existing && this.#entries.size >= MAX_ENTRIES) {
      this.omitted++;
      return;
    }
    const now = Date.now();
    const entry = existing ?? {
      opcode,
      name: OPCODE_NAMES.get(opcode) ?? `UNKNOWN_0x${opcode.toString(16).toUpperCase()}`,
      category,
      message,
      count: 0,
      firstSeen: now,
      lastSeen: now,
      payloadSizes: [],
    };
    entry.count++;
    entry.lastSeen = now;
    if (payloadBytes !== undefined && entry.payloadSizes.length < MAX_PAYLOAD_SIZES) {
      entry.payloadSizes.push(payloadBytes);
    }
    if (!existing) this.#entries.set(key, entry);
  }

  summary(): PacketErrorSummary[] {
    return [...this.#entries.values()]
      .sort((left, right) => right.count - left.count || right.lastSeen - left.lastSeen)
      .map((entry) => ({
        opcode: `0x${entry.opcode.toString(16).toUpperCase().padStart(3, "0")}`,
        name: entry.name,
        category: entry.category,
        message: entry.message,
        count: entry.count,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        payloadSizes: [...entry.payloadSizes],
      }));
  }
}
